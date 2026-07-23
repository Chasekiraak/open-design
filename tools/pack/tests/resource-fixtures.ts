import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const BUNDLED_ROOT_FILE_FIXTURES = [
  ["LICENSE", "test license\n"],
  ["LICENSES.md", "# Test third-party notices\n"],
  ["BRAND_NOTICE.md", "# Test brand notice\n"],
] as const;

export async function createBundledRootFileFixture(
  workspaceRoot: string,
): Promise<void> {
  await mkdir(workspaceRoot, { recursive: true });
  await Promise.all(
    BUNDLED_ROOT_FILE_FIXTURES.map(([fileName, content]) =>
      writeFile(join(workspaceRoot, fileName), content, "utf8"),
    ),
  );
}
