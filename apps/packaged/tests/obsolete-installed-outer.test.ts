import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ProcessSnapshot, StopProcessesResult } from "@open-design/platform";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createObsoleteInstalledOuterRetirement } from "../src/obsolete-installed-outer.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

type InspectInstalledOuterPath = (path: string) => Promise<{
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
} | null>;

function inspectedEntry(options: { directory?: boolean; symbolicLink?: boolean } = {}) {
  return {
    isDirectory: () => options.directory ?? false,
    isFile: () => !(options.directory ?? false),
    isSymbolicLink: () => options.symbolicLink ?? false,
  };
}

function macInspectMock(
  launchPath: string,
  executablePath: string,
  executableSymbolicLink = false,
): InspectInstalledOuterPath {
  return vi.fn(async (path) => {
    if (path === launchPath) return inspectedEntry({ directory: true });
    if (path === executablePath) return inspectedEntry({ symbolicLink: executableSymbolicLink });
    return null;
  });
}

async function createMacInstalledOuter(): Promise<{
  executablePath: string;
  inspectInstalledOuterPath?: InspectInstalledOuterPath;
  launchPath: string;
}> {
  if (process.platform === "win32") {
    const launchPath = "/Applications/Open Design.app";
    const executablePath = `${launchPath}/Contents/MacOS/Open Design`;
    return {
      executablePath,
      inspectInstalledOuterPath: macInspectMock(launchPath, executablePath),
      launchPath,
    };
  }
  const root = await mkdtemp(join(tmpdir(), "od-obsolete-outer-"));
  roots.push(root);
  const launchPath = join(root, "Open Design.app");
  const executablePath = join(launchPath, "Contents", "MacOS", "Open Design");
  await mkdir(join(launchPath, "Contents", "MacOS"), { recursive: true });
  await writeFile(executablePath, "legacy outer", "utf8");
  return { executablePath, launchPath };
}

function fileInspectMock(symbolicLink = false): InspectInstalledOuterPath {
  return vi.fn(async () => inspectedEntry({ symbolicLink }));
}

function snapshot(pid: number, ppid: number, command: string): ProcessSnapshot {
  return { command, pid, ppid };
}

function stopped(pids: number[]): StopProcessesResult {
  return {
    alreadyStopped: pids.length === 0,
    forcedPids: [],
    matchedPids: pids,
    remainingPids: [],
    stoppedPids: pids,
  };
}

function stopMock() {
  return vi.fn(async (pids: Array<number | null | undefined>) => stopped(
    pids.filter((pid): pid is number => pid != null),
  ));
}

describe("createObsoleteInstalledOuterRetirement", () => {
  it("stops only the exact installed outer root and its descendants", async () => {
    const { executablePath, inspectInstalledOuterPath, launchPath } = await createMacInstalledOuter();
    const stopProcesses = stopMock();
    const logger = { info: vi.fn(), warn: vi.fn() };
    const retire = createObsoleteInstalledOuterRetirement({
      currentExecutablePath: "/payload/Open Design.app/Contents/MacOS/Open Design",
      currentPid: 900,
      installedLaunchPath: launchPath,
      logger,
      payloadDesktopProcess: true,
      payloadExecutablePath: "/payload/Open Design.app/Contents/MacOS/Open Design",
      platform: "darwin",
    }, {
      inspectInstalledOuterPath,
      listProcessSnapshots: async () => [
        snapshot(101, 1, executablePath),
        snapshot(102, 101, `${launchPath}/Contents/Frameworks/Open Design Helper.app/Contents/MacOS/Open Design Helper`),
        snapshot(103, 102, "helper-child"),
        snapshot(104, 1, `${executablePath} Helper`),
        snapshot(900, 1, "/payload/Open Design.app/Contents/MacOS/Open Design"),
      ],
      stopProcesses,
    });

    const result = await retire();

    expect(stopProcesses).toHaveBeenCalledExactlyOnceWith([103, 102, 101]);
    expect(result).toMatchObject({
      executablePath,
      rootPids: [101],
      status: "retired",
      treePids: [103, 102, 101],
    });
    expect(logger.info).toHaveBeenCalledWith(
      "retired obsolete installed outer",
      expect.objectContaining({ rootPids: [101], stoppedPids: [103, 102, 101] }),
    );
  });

  it("does nothing outside an exact payload desktop process", async () => {
    const { launchPath } = await createMacInstalledOuter();
    const listProcessSnapshots = vi.fn(async () => []);
    const stopProcesses = stopMock();
    const retire = createObsoleteInstalledOuterRetirement({
      currentExecutablePath: "/installed/Open Design",
      currentPid: 900,
      installedLaunchPath: launchPath,
      logger: { info: vi.fn(), warn: vi.fn() },
      payloadDesktopProcess: false,
      payloadExecutablePath: null,
      platform: "darwin",
    }, { listProcessSnapshots, stopProcesses });

    await expect(retire()).resolves.toMatchObject({ reason: "not-payload-desktop", status: "skipped" });
    expect(listProcessSnapshots).not.toHaveBeenCalled();
    expect(stopProcesses).not.toHaveBeenCalled();
  });

  it("rejects a symlinked install executable before enumerating processes", async () => {
    let inspectInstalledOuterPath: InspectInstalledOuterPath | undefined;
    let launchPath: string;
    if (process.platform === "win32") {
      launchPath = "/Applications/Open Design.app";
      inspectInstalledOuterPath = macInspectMock(
        launchPath,
        `${launchPath}/Contents/MacOS/Open Design`,
        true,
      );
    } else {
      const root = await mkdtemp(join(tmpdir(), "od-obsolete-outer-symlink-"));
      roots.push(root);
      launchPath = join(root, "Open Design.app");
      const executableDirectory = join(launchPath, "Contents", "MacOS");
      const target = join(root, "target");
      await mkdir(executableDirectory, { recursive: true });
      await writeFile(target, "not the installed executable", "utf8");
      await symlink(target, join(executableDirectory, "Open Design"));
    }
    const listProcessSnapshots = vi.fn(async () => []);
    const retire = createObsoleteInstalledOuterRetirement({
      currentExecutablePath: "/payload/Open Design",
      currentPid: 900,
      installedLaunchPath: launchPath,
      logger: { info: vi.fn(), warn: vi.fn() },
      payloadDesktopProcess: true,
      payloadExecutablePath: "/payload/Open Design",
      platform: "darwin",
    }, {
      inspectInstalledOuterPath,
      listProcessSnapshots,
      stopProcesses: stopMock(),
    });

    await expect(retire()).resolves.toMatchObject({ reason: "invalid-install-anchor", status: "skipped" });
    expect(listProcessSnapshots).not.toHaveBeenCalled();
  });

  it("refuses to stop an outer tree that contains the current payload", async () => {
    const { executablePath, inspectInstalledOuterPath, launchPath } = await createMacInstalledOuter();
    const stopProcesses = stopMock();
    const retire = createObsoleteInstalledOuterRetirement({
      currentExecutablePath: "/payload/Open Design",
      currentPid: 900,
      installedLaunchPath: launchPath,
      logger: { info: vi.fn(), warn: vi.fn() },
      payloadDesktopProcess: true,
      payloadExecutablePath: "/payload/Open Design",
      platform: "darwin",
    }, {
      inspectInstalledOuterPath,
      listProcessSnapshots: async () => [
        snapshot(101, 1, executablePath),
        snapshot(800, 101, "handoff daemon"),
        snapshot(900, 800, "/payload/Open Design"),
      ],
      stopProcesses,
    });

    await expect(retire()).resolves.toMatchObject({
      reason: "unsafe-current-descendant",
      status: "skipped",
    });
    expect(stopProcesses).not.toHaveBeenCalled();
  });
});

describe("Windows obsolete installed outer retirement", () => {
  it("revalidates the root pid before stopping descendants", async () => {
    const executablePath = "C:\\Program Files\\Open Design\\Open Design.exe";
    const firstSnapshots = [
      snapshot(201, 1, `"${executablePath.toUpperCase()}"`),
      snapshot(202, 201, "Open Design.exe --type=gpu-process"),
      snapshot(900, 1, "C:\\payload\\Open Design.exe"),
    ];
    const secondSnapshots = [
      snapshot(201, 1, `"${executablePath}"`),
      snapshot(206, 201, "Open Design.exe --type=renderer"),
      snapshot(900, 1, "C:\\payload\\Open Design.exe"),
    ];
    const listProcessSnapshots = vi.fn()
      .mockResolvedValueOnce(firstSnapshots)
      .mockResolvedValueOnce(secondSnapshots);
    const stopProcesses = stopMock();
    const retire = createObsoleteInstalledOuterRetirement({
      currentExecutablePath: "C:\\PAYLOAD\\OPEN DESIGN.EXE",
      currentPid: 900,
      installedLaunchPath: executablePath,
      logger: { info: vi.fn(), warn: vi.fn() },
      payloadDesktopProcess: true,
      payloadExecutablePath: "c:\\payload\\Open Design.exe",
      platform: "win32",
    }, {
      inspectInstalledOuterPath: fileInspectMock(),
      listProcessSnapshots,
      stopProcesses,
    });

    const result = await retire();

    expect(listProcessSnapshots).toHaveBeenCalledTimes(2);
    expect(stopProcesses).toHaveBeenCalledExactlyOnceWith([206, 201]);
    expect(result).toMatchObject({
      executablePath,
      rootPids: [201],
      status: "retired",
      treePids: [206, 201],
    });
  });
});
