import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";

import { CERTAIN_EXEMPT_EXACT, CERTAIN_EXEMPT_PREFIXES } from "./scopes.ts";

// Guard for the certain-tier exempt core in `scripts/scopes.ts` (rule
// `certain-exempt-surface`; methodology in `specs/current/ci.md`).
//
// Boundary invariant: no source that a *skippable* merge-gate lane executes may
// consume a certain-exempt file. If that held false, a docs-only change could
// invalidate a lane the promoted rule tells the merge queue to skip.
//
// What "consumption" means here, at two precision levels:
// - a dot-relative literal (`../../docs/...`) that resolves from the file's
//   repo location into the certain-exempt surface: flagged everywhere — it can
//   only mean the repository surface.
// - a bare repo-relative literal (`docs/CHANGELOG`): flagged everywhere unless
//   it is an argument to a known sandbox-fixture writer. Test files can also
//   contain repo-root helpers, so exempting them wholesale would hide real
//   consumption.
// Template literals with substitutions are not statically resolvable and are
// out of scope.
//
// Deliberately outside the checked surface:
// - root `scripts/` — floor-owned code. Preflight and workspace unit tests are
//   unconditionally armed on every plan, so floor checks may read the exempt
//   surface (product neutrality validates docs/ prose on every run).
// - `apps/landing-page/` — it IS the exempt surface; landing-page CI owns it.

const repoRoot = path.resolve(import.meta.dirname, "..");

const checkedRoots = ["apps", "packages", "tools", "e2e"] as const;

const skippedDirectoryNames = new Set([
  ".astro",
  ".next",
  ".od-data",
  "dist",
  "node_modules",
  "out",
  "reports",
  "test-results",
  "vendor",
]);

const skippedRepositoryPrefixes = ["apps/landing-page/"];

const checkedExtensions = new Set([".ts", ".tsx"]);

// These helpers interpret their path argument inside a temporary project
// workspace. Keep this list narrow: repo-root readers used by tests must remain
// visible to the guard.
const sandboxFixtureWriterNames = new Set(["writeProjectFile"]);

// File-level exceptions. Every entry must explain why the reference is not
// gate-lane consumption of exempt-file *content*; revisit the entry if the
// file's relationship to the exempt surface changes.
const allowedConsumers = new Map<string, string>([
  [
    "apps/daemon/tests/claude-design-import.test.ts",
    "archive-entry and extracted-project fixture paths; every docs/ literal names data inside a temporary project",
  ],
  [
    "apps/daemon/tests/design-systems/file-score.test.ts",
    "path-classification fixture strings; the test does not open the editor configuration files",
  ],
  [
    "apps/daemon/tests/project-classifiers.test.ts",
    "file-kind classifier input; the LICENSE literal is never resolved or opened",
  ],
  [
    "apps/daemon/tests/runtimes/trae-cli.test.ts",
    "reads docs/agent-adapters.md from the repository, but this test file is not selected by any ci.yml daemon-test lane",
  ],
  [
    "apps/web/tests/components/ChatPane.imported-folder-artifacts.test.tsx",
    "imported-project artifact fixture paths rendered from in-memory test data",
  ],
  [
    "apps/web/tests/components/file-viewer-markdown-copy.test.tsx",
    "project-relative markdown path inputs used to test URL construction, not repository reads",
  ],
  [
    "apps/web/tests/utils/inlineMentions.test.ts",
    "in-memory mention parser fixture paths; no filesystem access occurs",
  ],
  [
    "tools/release/src/release-note/prepare.ts",
    "docs/CHANGELOG feeds release-note preparation, which runs only in release workflows; @open-design/tools-release tests run in no ci.yml lane",
  ],
  [
    "e2e/tests/packaged-smoke-workflow.test.ts",
    "scope-planner and workflow-text assertion fixtures; certain-exempt literals are passed as data and never opened",
  ],
  [
    "e2e/tests/scripts/product-neutrality.test.ts",
    "virtual source path passed to the product-neutrality collector; it does not access the repository file",
  ],
  [
    "e2e/tests/scripts/scopes.test.ts",
    "behavior fixtures for this very check: source snippets passed to the collector as data, never resolved or opened",
  ],
]);

type ConsumptionViolation = {
  filePath: string;
  lineNumber: number;
  literal: string;
};

function toRepositoryPath(filePath: string): string {
  return path.relative(repoRoot, filePath).split(path.sep).join("/");
}

function landsInCertainExemptSurface(repositoryPath: string): boolean {
  return (
    CERTAIN_EXEMPT_PREFIXES.some((prefix) => repositoryPath.startsWith(prefix)) ||
    (CERTAIN_EXEMPT_EXACT as readonly string[]).includes(repositoryPath)
  );
}

function literalConsumesCertainExemptSurface(fromRepositoryPath: string, literal: string): boolean {
  if (literal.startsWith("./") || literal.startsWith("../")) {
    const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(fromRepositoryPath), literal));
    return landsInCertainExemptSurface(resolved);
  }
  return landsInCertainExemptSurface(literal);
}

function isSandboxFixtureWriterArgument(node: ts.StringLiteral | ts.NoSubstitutionTemplateLiteral): boolean {
  const call = node.parent;
  if (!ts.isCallExpression(call) || !call.arguments.includes(node)) return false;

  const callee = call.expression;
  const name = ts.isIdentifier(callee)
    ? callee.text
    : ts.isPropertyAccessExpression(callee)
      ? callee.name.text
      : undefined;
  return name !== undefined && sandboxFixtureWriterNames.has(name);
}

export function collectCertainExemptConsumptionFromSource(
  repositoryPath: string,
  source: string,
): ConsumptionViolation[] {
  const sourceFile = ts.createSourceFile(
    repositoryPath,
    source,
    ts.ScriptTarget.Latest,
    true,
    repositoryPath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const violations: ConsumptionViolation[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      if (
        !isSandboxFixtureWriterArgument(node) &&
        literalConsumesCertainExemptSurface(repositoryPath, node.text)
      ) {
        violations.push({
          filePath: repositoryPath,
          lineNumber: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
          literal: node.text,
        });
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return violations;
}

async function collectCheckedFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    const repositoryPath = toRepositoryPath(fullPath);

    if (entry.isDirectory()) {
      if (
        skippedDirectoryNames.has(entry.name) ||
        entry.name.startsWith(".next-") ||
        skippedRepositoryPrefixes.some((prefix) => `${repositoryPath}/`.startsWith(prefix))
      ) {
        continue;
      }
      files.push(...(await collectCheckedFiles(fullPath)));
      continue;
    }

    if (entry.isFile() && checkedExtensions.has(path.extname(entry.name))) {
      files.push(repositoryPath);
    }
  }

  return files;
}

export async function checkCertainExemptConsumption(): Promise<boolean> {
  const violations: ConsumptionViolation[] = [];

  for (const root of checkedRoots) {
    for (const repositoryPath of await collectCheckedFiles(path.join(repoRoot, root))) {
      if (allowedConsumers.has(repositoryPath)) continue;
      const source = await readFile(path.join(repoRoot, repositoryPath), "utf8");
      violations.push(...collectCertainExemptConsumptionFromSource(repositoryPath, source));
    }
  }

  if (violations.length > 0) {
    console.error("Certain-exempt surface consumption found in gate-lane sources:");
    for (const violation of violations) {
      console.error(`- ${violation.filePath}:${violation.lineNumber} \`${violation.literal}\``);
    }
    console.error(
      "Certain-tier exempt files must stay unconsumed by skippable merge-gate lanes (see specs/current/ci.md). Move the dependency, or add a justified allowlist entry in scripts/check-certain-exempt-consumption.ts.",
    );
    return false;
  }

  console.log("Certain-exempt consumption check passed: gate-lane sources do not read the certain-exempt surface.");
  return true;
}
