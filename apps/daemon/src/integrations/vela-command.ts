import { execFile } from 'node:child_process';

import { createCommandInvocation } from '@open-design/platform';

import {
  agentCliEnvForAgent,
  readAppConfigSync,
} from '../app-config.js';
import { spawnEnvForAgent } from '../runtimes/env.js';
import {
  applyAgentLaunchEnv,
  resolveAgentLaunch,
} from '../runtimes/launch.js';
import { getAgentDef } from '../runtimes/registry.js';

export interface VelaCommandOptions {
  env?: NodeJS.ProcessEnv;
  configuredEnv?: Record<string, string>;
  maxBuffer?: number;
}

export function velaWorkspaceCommandOptions(
  _workspaceId?: string | null | undefined,
): VelaCommandOptions {
  return { configuredEnv: { VELA_INVOCATION_SOURCE: 'open-design' } };
}

/**
 * Append the explicit `--workspace-id` every workspace-scoped Vela command must
 * carry, and REFUSE to build the command without one.
 *
 * The workspace used to travel as a `VELA_WORKSPACE_ID` environment variable.
 * Nothing on the other side ever read it — the name has zero references in the
 * vela repository — so every collab call silently fell through to a
 * server-side "current workspace" that the client has no way to set. A user who
 * switched workspaces in the client kept talking to whichever workspace the
 * server still had selected, which surfaced as `403 missing_principal` on the
 * whole collab plane once that happened to be a personal workspace.
 *
 * Two properties matter here and neither survives in an env var:
 *  - it is per-CALL, not ambient process state, so two projects in two
 *    workspaces cannot be conflated;
 *  - a missing workspace throws HERE, at the call site, instead of producing a
 *    command that looks correct and quietly asks about the wrong workspace.
 *    That silence is what made this bug expensive to find: the failing command
 *    printed as a bare `vela collab presence list <id>` with no workspace in
 *    sight.
 *
 * `vela billing` already took an explicit required `--workspace-id`; this is
 * the rest of the surface catching up to it.
 */
export function withWorkspaceIdFlag(
  args: string[],
  workspaceId: string | null | undefined,
): string[] {
  const resolved = workspaceId?.trim();
  if (!resolved) {
    throw new Error(
      `vela ${args[0] ?? 'command'}: a workspace id is required; refusing to run a workspace-scoped command without --workspace-id`,
    );
  }
  return [...args, '--workspace-id', resolved];
}

function configuredAmrEnv(
  env: NodeJS.ProcessEnv,
  explicit: Record<string, string> = {},
): Record<string, string> {
  let stored: Record<string, string> = {};
  const dataDir = env.OD_DATA_DIR?.trim();
  if (dataDir) {
    try {
      stored = agentCliEnvForAgent(readAppConfigSync(dataDir).agentCliEnv, 'amr');
    } catch {
      // An unreadable app config must not hide a valid inherited or packaged
      // Vela installation; the command will use the normal resolver fallback.
    }
  }
  const inheritedVelaBin = env.VELA_BIN?.trim();
  return {
    ...(inheritedVelaBin ? { VELA_BIN: inheritedVelaBin } : {}),
    // Settings-backed agent CLI configuration follows the same precedence as
    // login and AMR launches: it overrides the inherited shell environment.
    ...stored,
    ...explicit,
  };
}

/**
 * Run the same resolved Vela binary and environment used by Open Design login
 * and AMR agent launches. Resource/team/collab adapters must use this instead
 * of spawning a PATH-only `vela` process, otherwise a packaged login can
 * succeed while the collaboration command uses a different or missing CLI.
 */
export function runVelaCommand(
  args: string[],
  options: VelaCommandOptions = {},
): Promise<string> {
  const env = options.env ?? process.env;
  const configuredEnv = configuredAmrEnv(env, options.configuredEnv);
  const def = getAgentDef('amr');
  if (!def) {
    return Promise.reject(new Error('AMR runtime definition is missing'));
  }
  const launch = resolveAgentLaunch(def, configuredEnv);
  const bin = launch.launchPath ?? launch.selectedPath;
  if (!bin) {
    return Promise.reject(
      new Error('vela binary not found; install vela or configure VELA_BIN'),
    );
  }
  const childEnv = applyAgentLaunchEnv(
    spawnEnvForAgent('amr', env, configuredEnv),
    launch,
  );
  const invocation = createCommandInvocation({ command: bin, args, env: childEnv });
  return new Promise<string>((resolve, reject) => {
    execFile(
      invocation.command,
      invocation.args,
      {
        env: childEnv,
        encoding: 'utf8',
        maxBuffer: options.maxBuffer ?? 16 * 1024 * 1024,
        windowsVerbatimArguments: invocation.windowsVerbatimArguments,
      },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout);
      },
    );
  });
}
