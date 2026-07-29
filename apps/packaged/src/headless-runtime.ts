import { mkdir } from "node:fs/promises";

import {
  APP_KEYS,
  OPEN_DESIGN_SIDECAR_CONTRACT,
  SIDECAR_MESSAGES,
  SIDECAR_MODES,
  SIDECAR_SOURCES,
  normalizeDesktopSidecarMessage,
  type SidecarStamp,
} from "@open-design/sidecar-proto";
import { bootstrapSidecarRuntime, createJsonIpcServer, resolveAppIpcPath } from "@open-design/sidecar";

import type { PackagedConfig } from "./config.js";
import { writePackagedDesktopIdentity, writePackagedWebIdentity } from "./identity.js";
import { confirmPackagedLauncherRuntime, resolvePackagedLauncherRuntime } from "./launcher-runtime.js";
import { resolvePackagedNamespacePaths } from "./paths.js";
import { startPackagedSidecars } from "./sidecars.js";

function createHeadlessStamp(namespace: string): SidecarStamp {
  return {
    app: APP_KEYS.DESKTOP,
    ipc: resolveAppIpcPath({
      app: APP_KEYS.DESKTOP,
      contract: OPEN_DESIGN_SIDECAR_CONTRACT,
      namespace,
    }),
    mode: SIDECAR_MODES.RUNTIME,
    namespace,
    source: SIDECAR_SOURCES.PACKAGED,
  };
}

function colorize(text: string): string {
  if (process.stdout.isTTY !== true || process.env.NO_COLOR != null) return text;
  return `\x1b[36m\x1b[4m${text}\x1b[0m`;
}

export interface PackagedMcpBootstrapLaunch {
  args: string[];
  command: string;
}

export interface PackagedHeadlessRequest {
  headless: boolean;
  mcpInstallAgent: "codex" | null;
}

export interface RunPackagedHeadlessOptions {
  mcpBootstrapLaunch?: PackagedMcpBootstrapLaunch;
}

export function parsePackagedHeadlessRequest(
  argv: readonly string[],
): PackagedHeadlessRequest {
  const headless = argv.includes("--headless");
  const installIndex = argv.indexOf("--mcp-install");
  if (installIndex === -1) return { headless, mcpInstallAgent: null };
  if (!headless) {
    throw new Error("--mcp-install requires --headless");
  }
  const agent = argv[installIndex + 1];
  if (agent !== "codex") {
    throw new Error(
      "Packaged headless MCP installation currently only supports codex.",
    );
  }
  return { headless: true, mcpInstallAgent: agent };
}

export function resolvePackagedMcpBootstrapLaunch(options: {
  currentExecutablePath?: string;
  installedLaunchPath: string | null;
  platform?: NodeJS.Platform;
}): PackagedMcpBootstrapLaunch {
  const platform = options.platform ?? process.platform;
  const currentExecutablePath =
    options.currentExecutablePath ?? process.execPath;
  if (
    platform === "darwin"
    && options.installedLaunchPath?.endsWith(".app")
  ) {
    return {
      command: "/usr/bin/open",
      args: [
        "-g",
        "-j",
        options.installedLaunchPath,
        "--args",
        "--headless",
      ],
    };
  }
  return {
    command: options.installedLaunchPath ?? currentExecutablePath,
    args: ["--headless"],
  };
}

export async function runPackagedHeadless(
  config: PackagedConfig,
  request: PackagedHeadlessRequest = {
    headless: true,
    mcpInstallAgent: null,
  },
  options: RunPackagedHeadlessOptions = {},
): Promise<void> {
  const initialPaths = resolvePackagedNamespacePaths(
    config,
    config.namespace,
    process.env,
  );
  const launcherRuntime = await resolvePackagedLauncherRuntime(config, initialPaths);
  const activeConfig = launcherRuntime.config;
  const paths = launcherRuntime.paths;
  const stamp = createHeadlessStamp(config.namespace);
  const mcpBootstrap =
    options.mcpBootstrapLaunch
    ?? resolvePackagedMcpBootstrapLaunch({
      installedLaunchPath: launcherRuntime.installedLaunchPath,
    });

  await mkdir(paths.runtimeRoot, { recursive: true });

  const runtime = bootstrapSidecarRuntime(stamp, process.env, {
    app: APP_KEYS.DESKTOP,
    base: paths.runtimeRoot,
    contract: OPEN_DESIGN_SIDECAR_CONTRACT,
  });

  // Write a headless-specific identity marker so `tools-pack linux stop --headless`
  // can find this process without confusing it for a menu-launched
  // AppImage that owns desktop-root.json in the same namespace.
  const identity = await writePackagedDesktopIdentity({
    identityPath: paths.headlessIdentityPath,
    paths,
    stamp,
  });

  const sidecars = await startPackagedSidecars(runtime, paths, {
    appVersion: activeConfig.appVersion,
    amrProfile: activeConfig.amrProfile,
    daemonCliEntry: activeConfig.daemonCliEntry,
    daemonSidecarEntry: activeConfig.daemonSidecarEntry,
    electronNodeCommand: launcherRuntime.electronNodeCommand,
    mcpBootstrapArgs: mcpBootstrap.args,
    mcpBootstrapCommand: mcpBootstrap.command,
    nodeCommand: activeConfig.nodeCommand,
    telemetryRelayUrl: activeConfig.telemetryRelayUrl,
    posthogKey: activeConfig.posthogKey,
    posthogHost: activeConfig.posthogHost,
    // PR #974 round-5 (lefarcen P2): headless packaged mode uses the signed
    // Electron entry as a lifecycle owner, but creates no BrowserWindow and
    // exposes no privileged shell.openPath surface.
    // Pinning OD_REQUIRE_DESKTOP_AUTH here would arm a gate no client
    // can ever satisfy (no desktop window/main bridge to register a secret),
    // so folder import would permanently return DESKTOP_AUTH_PENDING.
    // The Electron entry counterpart in `apps/packaged/src/index.ts`
    // passes `true` because it does start that desktop bridge.
    requireDesktopAuth: false,
    webSidecarEntry: activeConfig.webSidecarEntry,
    webStandaloneRoot: activeConfig.webStandaloneRoot,
    webOutputMode: activeConfig.webOutputMode,
  });

  const webUrl = sidecars.web.url;
  if (!webUrl) {
    await sidecars.close().catch(() => undefined);
    await identity.close().catch(() => undefined);
    throw new Error("web sidecar failed to produce URL — check logs/desktop/latest.log");
  }
  if (request.mcpInstallAgent === "codex") {
    await installCodexMcp(sidecars.daemon.url);
  }

  const shutdown = async (): Promise<void> => {
    process.stdout.write("\n Shutting down Open Design...\n");
    await ipcServer.close().catch(() => undefined);
    await sidecars.close().catch(() => undefined);
    await identity.close().catch(() => undefined);
    process.exit(0);
  };

  const ipcServer = await createJsonIpcServer({
    socketPath: stamp.ipc,
    handler: async (message: unknown) => {
      const request = normalizeDesktopSidecarMessage(message);
      switch (request.type) {
        case SIDECAR_MESSAGES.STATUS:
          return {
            pid: process.pid,
            state: "running",
            updatedAt: new Date().toISOString(),
            url: webUrl,
            windowVisible: false,
          };
        case SIDECAR_MESSAGES.SHUTDOWN:
          setImmediate(() => {
            void shutdown().finally(() => process.exit(0));
          });
          return { accepted: true };
      }
    },
  });

  await writePackagedWebIdentity({
    paths,
    pid: process.pid,
    url: webUrl,
  });
  await confirmPackagedLauncherRuntime(launcherRuntime);

  process.stdout.write(`\n Open Design is running\n\n`);
  process.stdout.write(` ➜ ${colorize(webUrl)}\n\n`);
  process.stdout.write(` Press Ctrl+C to stop\n\n`);

  process.on("SIGINT", () => {
    void shutdown();
  });
  process.on("SIGTERM", () => {
    void shutdown();
  });
}

async function installCodexMcp(daemonUrl: string | null): Promise<void> {
  if (daemonUrl == null || daemonUrl.length === 0) {
    throw new Error("daemon sidecar failed to produce a URL for MCP install");
  }
  const url = `${daemonUrl.replace(/\/$/u, "")}/api/mcp/install/codex`;
  const response = await fetch(url, { method: "POST" });
  if (!response.ok) {
    const detail = await response.text().catch(() => response.statusText);
    throw new Error(
      `Codex MCP install failed (${response.status}): ${detail}`,
    );
  }
  process.stdout.write(" Open Design MCP installed for Codex\n");
}
