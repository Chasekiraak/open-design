import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const resourceRoot = join(import.meta.dirname, "../resources/server");

describe("server bootstrap resources", () => {
  it("keeps the POSIX bootstrap architecture-aware and atomically publishes private Node", async () => {
    const installer = await readFile(join(resourceRoot, "install.sh"), "utf8");

    expect(installer).toContain("node_is_compatible");
    expect(installer).toContain("process.platform");
    expect(installer).toContain("process.arch");
    expect(installer).toContain("verbatimSymlinks: true");
    expect(installer).toContain("fs.renameSync(stage, destination)");
    expect(installer).toContain("process.argv.slice(1)");
    expect(installer).toContain("installed launcher directory is not on PATH");
  });

  it("keeps the Windows PowerShell 5 bootstrap on a short owned extraction drive", async () => {
    const installer = await readFile(join(resourceRoot, "install.ps1"), "utf8");

    expect(installer).toContain("function Test-CompatibleNode");
    expect(installer).toContain('"24 win32-$Architecture"');
    expect(installer).toContain("verbatimSymlinks: true");
    expect(installer).toContain("fs.renameSync(stage, destination)");
    expect(installer).toContain("process.argv.slice(2)");
    expect(installer).toContain("System32\\subst.exe");
    expect(installer).toContain(".odsi-owner-$ownerToken");
    expect(installer).toContain("$destinationEntry.Length -gt 240");
    expect(installer).toContain("COM[1-9]");
    expect(installer).toContain("installed launcher directory is not on PATH");
    expect(installer).not.toContain("Expand-Archive");
  });
});
