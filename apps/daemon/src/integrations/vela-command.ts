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
  /** Reject and terminate the child when it exceeds this wall-clock budget. */
  timeoutMs?: number;
  /** Optional caller cancellation, forwarded to Node's child-process API. */
  signal?: AbortSignal;
  /** Signal used for deadline/cancellation termination. Defaults to SIGTERM. */
  killSignal?: NodeJS.Signals;
}

export function velaWorkspaceCommandOptions(
  workspaceId: string | null | undefined,
): VelaCommandOptions {
  const requestedWorkspaceId = workspaceId?.trim();
  return {
    configuredEnv: {
      VELA_INVOCATION_SOURCE: 'open-design',
      ...(requestedWorkspaceId
        ? { VELA_WORKSPACE_ID: requestedWorkspaceId }
        : {}),
    },
  };
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
  const timeoutMs =
    typeof options.timeoutMs === 'number' &&
    Number.isFinite(options.timeoutMs) &&
    options.timeoutMs > 0
      ? Math.floor(options.timeoutMs)
      : undefined;
  return new Promise<string>((resolve, reject) => {
    execFile(
      invocation.command,
      invocation.args,
      {
        env: childEnv,
        encoding: 'utf8',
        maxBuffer: options.maxBuffer ?? 16 * 1024 * 1024,
        windowsVerbatimArguments: invocation.windowsVerbatimArguments,
        ...(timeoutMs !== undefined ? { timeout: timeoutMs } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
        killSignal: options.killSignal ?? 'SIGTERM',
      },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout);
      },
    );
  });
}
