import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  formatSha256Sums,
  prepareServerReleaseFeed,
} from "../src/server/feed.js";

async function writeArchive(
  root: string,
  name: string,
  body: string,
): Promise<{ path: string; sha256: string }> {
  const path = join(root, name);
  await writeFile(path, body, "utf8");
  const sha256 = createHash("sha256").update(body, "utf8").digest("hex");
  await writeFile(join(root, `${name}.sha256`), `${sha256}  ${name}\n`, "utf8");
  return { path, sha256 };
}

describe("server release feed", () => {
  it("formats SHA256SUMS entries the bootstrap installers can parse", () => {
    expect(
      formatSha256Sums([
        {
          archiveName: "open-design-server-1.2.3-linux-x64.tar.gz",
          sha256: "a".repeat(64),
        },
        {
          archiveName: "open-design-server-1.2.3-darwin-arm64.tar.gz",
          sha256: "b".repeat(64),
        },
      ]),
    ).toBe(
      [
        `${"b".repeat(64)}  open-design-server-1.2.3-darwin-arm64.tar.gz`,
        `${"a".repeat(64)}  open-design-server-1.2.3-linux-x64.tar.gz`,
        "",
      ].join("\n"),
    );
  });

  it("materializes latest/VERSION and v<version>/SHA256SUMS for hosted bootstrap", async () => {
    const root = await mkdtemp(join(tmpdir(), "od-server-feed-"));
    const archivesDir = join(root, "archives");
    const feedDir = join(root, "feed");
    await mkdir(archivesDir, { recursive: true });

    const darwin = await writeArchive(
      archivesDir,
      "open-design-server-1.2.3-darwin-arm64.tar.gz",
      "darwin-bytes",
    );
    const linux = await writeArchive(
      archivesDir,
      "open-design-server-1.2.3-linux-x64.tar.gz",
      "linux-bytes",
    );
    const win = await writeArchive(
      archivesDir,
      "open-design-server-1.2.3-win32-x64.zip",
      "win-bytes",
    );

    const result = await prepareServerReleaseFeed({
      appVersion: "1.2.3",
      archives: [archivesDir],
      feedRoot: feedDir,
    });

    expect(result.appVersion).toBe("1.2.3");
    expect(result.versionPrefix).toBe("v1.2.3");
    expect(result.archiveEntries.map((entry) => entry.archiveName).sort()).toEqual([
      "open-design-server-1.2.3-darwin-arm64.tar.gz",
      "open-design-server-1.2.3-linux-x64.tar.gz",
      "open-design-server-1.2.3-win32-x64.zip",
    ]);

    expect(await readFile(result.latestVersionPath, "utf8")).toBe("1.2.3\n");
    expect(await readFile(result.sha256SumsPath, "utf8")).toBe(
      formatSha256Sums([
        {
          archiveName: "open-design-server-1.2.3-darwin-arm64.tar.gz",
          sha256: darwin.sha256,
        },
        {
          archiveName: "open-design-server-1.2.3-linux-x64.tar.gz",
          sha256: linux.sha256,
        },
        {
          archiveName: "open-design-server-1.2.3-win32-x64.zip",
          sha256: win.sha256,
        },
      ]),
    );
    expect(
      await readFile(
        join(result.versionRoot, "open-design-server-1.2.3-darwin-arm64.tar.gz"),
        "utf8",
      ),
    ).toBe("darwin-bytes");
    expect(
      await readFile(
        join(result.versionRoot, "open-design-server-1.2.3-win32-x64.zip"),
        "utf8",
      ),
    ).toBe("win-bytes");
  });

  it("rejects archives whose embedded version does not match the feed version", async () => {
    const root = await mkdtemp(join(tmpdir(), "od-server-feed-mismatch-"));
    await writeArchive(
      root,
      "open-design-server-9.9.9-darwin-arm64.tar.gz",
      "bytes",
    );

    await expect(
      prepareServerReleaseFeed({
        appVersion: "1.2.3",
        archives: [root],
        feedRoot: join(root, "feed"),
      }),
    ).rejects.toThrow(/does not match feed version 1\.2\.3/);
  });
});
