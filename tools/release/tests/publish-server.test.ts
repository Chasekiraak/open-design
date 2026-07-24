import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFileCallback);
const require = createRequire(import.meta.url);
const testDir = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = resolve(testDir, "..", "..", "..");
const tsxCliPath = require.resolve("tsx/cli");

describe("publish-server feed plan", () => {
  it("plans the hosted bootstrap objects without storage side effects", async () => {
    const root = await mkdtemp(join(tmpdir(), "od-tools-release-publish-server-"));
    const feedRoot = join(root, "feed");
    const outputsPath = join(root, "outputs.json");
    const version = "1.2.3";
    const versionRoot = join(feedRoot, `v${version}`);

    try {
      await mkdir(join(feedRoot, "latest"), { recursive: true });
      await mkdir(versionRoot, { recursive: true });
      await writeFile(join(feedRoot, "latest", "VERSION"), `${version}\n`, "utf8");
      await writeFile(
        join(versionRoot, "SHA256SUMS"),
        `${"a".repeat(64)}  open-design-server-${version}-darwin-arm64.tar.gz\n`,
        "utf8",
      );
      await writeFile(
        join(versionRoot, `open-design-server-${version}-darwin-arm64.tar.gz`),
        "archive\n",
        "utf8",
      );

      await execFileAsync(
        process.execPath,
        [tsxCliPath, "tools/release/src/index.ts", "publish-server"],
        {
          cwd: workspaceRoot,
          env: {
            ...process.env,
            RELEASE_DRY_RUN_MODE: "plan",
            RELEASE_OUTPUTS_PATH: outputsPath,
            RELEASE_PUBLIC_ORIGIN: "https://releases.open-design.ai",
            RELEASE_PUBLISH_SIDE_EFFECTS: "false",
            RELEASE_SERVER_FEED_DIR: feedRoot,
            RELEASE_VERSION: version,
          },
        },
      );

      const outputs = JSON.parse(await readFile(outputsPath, "utf8")) as {
        objectPrefix: string;
        publishSideEffectsEnabled: boolean;
        urls: {
          latestVersion: string;
          sha256Sums: string;
          versionRoot: string;
        };
        uploaded: Array<{ objectKey: string; url: string }>;
      };

      expect(outputs.publishSideEffectsEnabled).toBe(false);
      expect(outputs.objectPrefix).toBe("server");
      expect(outputs.urls).toEqual({
        latestVersion: "https://releases.open-design.ai/server/latest/VERSION",
        sha256Sums: "https://releases.open-design.ai/server/v1.2.3/SHA256SUMS",
        versionRoot: "https://releases.open-design.ai/server/v1.2.3",
      });
      expect(outputs.uploaded.map((entry) => entry.objectKey).sort()).toEqual([
        "server/latest/VERSION",
        "server/v1.2.3/SHA256SUMS",
        "server/v1.2.3/open-design-server-1.2.3-darwin-arm64.tar.gz",
      ]);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
