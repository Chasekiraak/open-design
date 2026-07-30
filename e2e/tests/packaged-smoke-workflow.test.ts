import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile as fsReadFile, readdir, rm, writeFile } from "node:fs/promises";
import { expect } from "vitest";

declare module "vitest" {
  interface Assertion<T = any> {
    toContainNormalized(expected: string): void;
  }
}

expect.extend({
  toContainNormalized(received, expected) {
    const normReceived = typeof received === "string" ? received.replace(/\r\n/g, "\n") : received;
    const normExpected = typeof expected === "string" ? expected.replace(/\r\n/g, "\n") : expected;
    const pass = typeof normReceived === "string" ? normReceived.includes(normExpected) : false;
    return {
      pass,
      message: () => `expected received string to contain expected string (ignoring CRLF)
Received:
${String(normReceived).substring(0, 500)}...
Expected to contain:
${String(normExpected).substring(0, 500)}...`
    };
  }
});

async function readFile(path: string | Buffer | URL, options?: any): Promise<any> {
  const content = await fsReadFile(path, options);
  if (typeof content === "string") {
    return content.replace(/\r\n/g, "\n");
  }
  return content;
}
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { uiP0CiMatrix, uiP0Groups } from "../lib/playwright/suites.ts";

const execFileAsync = promisify(execFile);
const e2eRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const workspaceRoot = dirname(e2eRoot);
const ciWorkflowPath = join(workspaceRoot, ".github", "workflows", "ci.yml");
const uiExtendedMainWorkflowPath = join(workspaceRoot, ".github", "workflows", "ui-extended-main.yml");
const playwrightConfigPath = join(e2eRoot, "playwright.config.ts");
const commentWorkflowPath = join(workspaceRoot, ".github", "workflows", "comment.atom.yml");
const autofixWorkflowPath = join(workspaceRoot, ".github", "workflows", "autofix.atom.yml");
const reportWorkflowPath = join(workspaceRoot, ".github", "workflows", "report.atom.yml");
const bakePluginPreviewsWorkflowPath = join(workspaceRoot, ".github", "workflows", "bake-plugin-previews.yml");
const bakePluginPreviewsPrWorkflowPath = join(workspaceRoot, ".github", "workflows", "bake-plugin-previews-pr.yml");
const dockerImageWorkflowPath = join(workspaceRoot, ".github", "workflows", "docker-image.yml");
const flakePath = join(workspaceRoot, "flake.nix");
const backportAutomergeWorkflowPath = join(workspaceRoot, ".github", "workflows", "backport-automerge.yml");
const bakePreviewsAutomergeWorkflowPath = join(
  workspaceRoot,
  ".github",
  "workflows",
  "bake-plugin-previews-automerge.yml",
);
const bakePreviewsWorkflowPath = join(workspaceRoot, ".github", "workflows", "bake-plugin-previews.yml");
const bakePreviewsReleaseWorkflowPath = join(
  workspaceRoot,
  ".github",
  "workflows",
  "bake-plugin-previews-release.yml",
);
const finalizeReleaseWorkflowPath = join(workspaceRoot, ".github", "workflows", "finalize-release.yml");
const handoffScriptPath = join(workspaceRoot, ".github", "scripts", "handoff.py");
const releaseBetaWorkflowPath = join(workspaceRoot, ".github", "workflows", "release-beta.yml");
const releaseBetaSelfHostedWorkflowPath = join(workspaceRoot, ".github", "workflows", "release-beta-s.yml");
const releasePreviewWorkflowPath = join(workspaceRoot, ".github", "workflows", "release-preview.yml");
const releasePrereleaseWorkflowPath = join(workspaceRoot, ".github", "workflows", "release-prerelease.yml");
const releaseStableWorkflowPath = join(workspaceRoot, ".github", "workflows", "release-stable.yml");
const releaseStableNotesScriptPath = join(workspaceRoot, ".github", "scripts", "release", "github", "stable-notes.sh");
const releasePreviewScriptPath = join(workspaceRoot, "tools", "release", "src", "metadata", "prepare-preview.ts");
const releaseStableScriptPath = join(workspaceRoot, "tools", "release", "src", "metadata", "prepare-stable.ts");
const releaseBetaScriptPath = join(workspaceRoot, "tools", "release", "src", "metadata", "prepare-beta.ts");
const packagedPackageJsonPath = join(workspaceRoot, "apps", "packaged", "package.json");
const scopesScriptPath = join(workspaceRoot, "scripts", "scopes.ts");
const runnersScriptPath = join(workspaceRoot, ".github", "scripts", "runners.py");
const notifyDailyFeishuWorkflowPath = join(workspaceRoot, ".github", "workflows", "notify-daily-feishu.yml");
const cutReleaseWorkflowPath = join(workspaceRoot, ".github", "workflows", "cut-release.yml");
const cutPatchReleaseWorkflowPath = join(workspaceRoot, ".github", "workflows", "cut-patch-release.yml");
const feishuNoticeScriptPath = join(workspaceRoot, "tools", "release", "src", "notifications", "feishu-notice.ts");
const landingPageDailyFeishuWorkflowPath = join(workspaceRoot, ".github", "workflows", "landing-page-daily-feishu.yml");
const landingPageCiWorkflowPath = join(workspaceRoot, ".github", "workflows", "landing-page-ci.yml");
const landingPageStagingWorkflowPath = join(workspaceRoot, ".github", "workflows", "landing-page-staging.yml");
const landingPageProductionWorkflowPath = join(workspaceRoot, ".github", "workflows", "landing-page-production.yml");
const landingPageDailyFeishuScriptPath = join(workspaceRoot, ".github", "scripts", "landing-page-daily-feishu.ts");
const releasePublishMetadataScriptPath = join(
  workspaceRoot,
  "tools",
  "release",
  "src",
  "storage",
  "publish-metadata.ts",
);
const releaseBetaPosixBuildScriptPath = join(workspaceRoot, "tools", "release", "scripts", "build-platform.sh");
const releaseBetaWindowsBuildScriptPath = join(workspaceRoot, "tools", "release", "scripts", "build-platform.ps1");
const releaseBetaPlatformPublishScriptPath = join(
  workspaceRoot,
  "tools",
  "release",
  "src",
  "storage",
  "publish-platform.ts",
);

function sectionBetween(content: string, start: string, end: string): string {
  const startIndex = content.indexOf(start);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  const endIndex = content.indexOf(end, startIndex + start.length);
  expect(endIndex).toBeGreaterThan(startIndex);
  return content.slice(startIndex, endIndex);
}

function extractWorkflowRunScript(workflow: string, stepName: string): string {
  const marker = `      - name: ${stepName}`;
  const start = workflow.indexOf(marker);
  expect(start).toBeGreaterThanOrEqual(0);
  const next = workflow.indexOf("\n      - ", start + marker.length);
  const step = workflow.slice(start, next === -1 ? workflow.length : next);
  const runStart = step.indexOf("        run: |\n");
  expect(runStart).toBeGreaterThanOrEqual(0);
  return step
    .slice(runStart + "        run: |\n".length)
    .split("\n")
    .map((line) => line.replace(/^          /, ""))
    .join("\n")
    .trimEnd();
}

function parseGithubOutput(raw: string): Record<string, string> {
  return Object.fromEntries(
    raw
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const sep = line.indexOf("=");
        expect(sep).toBeGreaterThan(0);
        return [line.slice(0, sep), line.slice(sep + 1)];
      }),
  );
}

async function gitPatchId(mode: "--stable" | "--verbatim", diff: string): Promise<string> {
  return await new Promise((resolve, reject) => {
    const child = execFile("git", ["patch-id", mode], { cwd: workspaceRoot, encoding: "utf8" }, (error, stdout, stderr) => {
      if (error) {
        reject(Object.assign(error, { stdout, stderr }));
        return;
      }
      resolve(stdout.trim().split(/\s+/)[0] ?? "");
    });
    child.stdin?.end(diff);
  });
}

// Pull the two jq programs that the `validate` job's "Check workspace validation jobs" step runs
// (the blanket failure scan and the required-jobs scan) straight out of ci.yml, so the gate logic
// under test stays the real workflow source rather than a reimplementation. Both are invoked as
// `jq -r '<program>'` and contain no single quotes, so the program is the text between the opening
// and the next `'`.
function extractValidateGateJqPrograms(workflow: string): { failures: string; requiredMisses: string } {
  const validate = sectionBetween(workflow, "  validate:", "  runtime_summary:");
  // Only the "Check workspace validation jobs" step — later validate steps also use jq.
  const needsCheck = sectionBetween(
    validate,
    "      - name: Check workspace validation jobs",
    "      - name: Block merge while the needs-validation label is present",
  );
  const programs = [...needsCheck.matchAll(/jq -r '([\s\S]*?)'/g)].map((match) => match[1] ?? "");
  expect(programs).toHaveLength(2);
  return { failures: programs[0] ?? "", requiredMisses: programs[1] ?? "" };
}

function runValidateGateJq(program: string, needs: unknown): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile("jq", ["-r", program], { encoding: "utf8" }, (error, stdout, stderr) => {
      if (error) {
        reject(Object.assign(error, { stdout, stderr }));
        return;
      }
      resolve(stdout.trim());
    });
    child.stdin?.end(JSON.stringify(needs));
  });
}

// Mirrors the bash gate decision: the step exits non-zero when either jq program emits any line.
async function validateGatePasses(workflow: string, needs: unknown): Promise<boolean> {
  const { failures, requiredMisses } = extractValidateGateJqPrograms(workflow);
  const [failureLines, missLines] = await Promise.all([
    runValidateGateJq(failures, needs),
    runValidateGateJq(requiredMisses, needs),
  ]);
  return failureLines === "" && missLines === "";
}

async function runReleaseStableForFailure(env: Record<string, string>): Promise<string> {
  try {
    await execFileAsync(process.execPath, ["--experimental-strip-types", releaseStableScriptPath], {
      cwd: workspaceRoot,
      env: {
        ...process.env,
        GITHUB_REPOSITORY: "nexu-io/open-design",
        GITHUB_SHA: "0123456789abcdef0123456789abcdef01234567",
        OPEN_DESIGN_RELEASE_CHANNEL: "stable",
        ...env,
      },
    });
  } catch (error) {
    const failed = error as { stderr?: string; stdout?: string };
    return `${failed.stdout ?? ""}${failed.stderr ?? ""}`;
  }

  throw new Error("release-stable script unexpectedly succeeded");
}

async function readPackagedVersion(): Promise<string> {
  const packageJson = JSON.parse(await readFile(packagedPackageJsonPath, "utf8")) as { version?: unknown };
  if (typeof packageJson.version !== "string" || packageJson.version.length === 0) {
    throw new Error("apps/packaged/package.json must define a version");
  }
  return packageJson.version;
}

async function runScopesPrint(eventName: string, eventPayload: unknown, changedFiles: string[] = []): Promise<Record<string, unknown>> {
  const tempDir = await mkdtemp(join(tmpdir(), "od-scopes-"));
  const eventPath = join(tempDir, "event.json");
  const ghPath = join(tempDir, "gh");
  const ghCmdPath = join(tempDir, "gh.cmd");
  await writeFile(eventPath, JSON.stringify(eventPayload));
  const script = `#!/usr/bin/env node
process.stdout.write(${JSON.stringify(changedFiles.join("\n"))});
if (${JSON.stringify(changedFiles.length > 0)}) process.stdout.write("\\n");
`;
  await writeFile(ghPath, script);
  await chmod(ghPath, 0o755);
  await writeFile(ghCmdPath, `@echo off\r\n"${process.execPath}" "${ghPath}" %*\r\n`);

  try {
    const fakePath = `${tempDir}${delimiter}${process.env.PATH ?? ""}`;
    const { stdout } = await execFileAsync(process.execPath, ["--experimental-strip-types", scopesScriptPath, "print"], {
      cwd: workspaceRoot,
      env: {
        ...process.env,
        GITHUB_EVENT_NAME: eventName,
        GITHUB_EVENT_PATH: eventPath,
        GITHUB_REPOSITORY: "nexu-io/open-design",
        GITHUB_SHA: "0123456789abcdef0123456789abcdef01234567",
        OPEN_DESIGN_GH_NODE_SCRIPT: ghPath,
        Path: fakePath,
        PATH: fakePath,
      },
    });
    return JSON.parse(stdout) as Record<string, unknown>;
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function runRunners(mode?: string): Promise<Record<string, string>> {
  const env = { ...process.env };
  if (mode === undefined) {
    delete env.OD_CI_RUNNER_MODE;
  } else {
    env.OD_CI_RUNNER_MODE = mode;
  }
  delete env.GITHUB_OUTPUT;

  const { stdout } = await execFileAsync("python3", [runnersScriptPath], {
    cwd: workspaceRoot,
    env,
  });
  return Object.fromEntries(
    stdout
      .trim()
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => {
        const separatorIndex = line.indexOf("=");
        expect(separatorIndex).toBeGreaterThan(0);
        return [line.slice(0, separatorIndex), line.slice(separatorIndex + 1)];
      }),
  );
}

function runnerOutput(profiles: Record<string, string>, key: string): string {
  const value = profiles[key];
  if (value === undefined) {
    throw new Error(`Missing runner profile output: ${key}`);
  }
  return value;
}

function runnerDecision(profiles: Record<string, string>): { schema_version: number; mode: string } {
  return JSON.parse(runnerOutput(profiles, "decision")) as { schema_version: number; mode: string };
}

function runnerRunsOn(profiles: Record<string, string>): Record<string, string[]> {
  return JSON.parse(runnerOutput(profiles, "runs_on")) as Record<string, string[]>;
}

async function writeFakeGhBin(binDir: string, releases: unknown[]): Promise<void> {
  const ghPath = join(binDir, "gh");
  const ghCmdPath = join(binDir, "gh.cmd");
  await writeFile(
    ghPath,
    `#!/usr/bin/env node
if (process.argv[2] === "api" && /^repos\\/[^/]+\\/[^/]+\\/releases\\?/.test(process.argv[3] ?? "")) {
  const url = new URL(process.argv[3], "https://api.github.com/");
  const page = url.searchParams.get("page") ?? "1";
  process.stdout.write(JSON.stringify(page === "1" ? ${JSON.stringify(releases)} : []));
  process.exit(0);
}
console.error("unexpected gh invocation: " + process.argv.slice(2).join(" "));
process.exit(1);
`,
  );
  await chmod(ghPath, 0o755);
  await writeFile(ghCmdPath, `@echo off\r\n"${process.execPath}" "%~dp0gh" %*\r\n`);
}

describe("packaged smoke workflow", () => {
  const itSkipOnWindows = process.platform === "win32" ? it.skip : it;

  it("[P2] keeps packaged smoke outside the main CI gate", async () => {
    const workflow = await readFile(ciWorkflowPath, "utf8");
    expect(workflow).not.toContainNormalized("packaged_smoke_");
    expect(workflow).not.toContainNormalized("Build PR mac artifacts");
    expect(workflow).not.toContainNormalized("Build PR windows artifacts");
    expect(workflow).not.toContainNormalized("Build PR linux headless artifacts");
    expect(workflow).not.toContainNormalized("Smoke PR mac packaged runtime");
    expect(workflow).not.toContainNormalized("Smoke PR windows packaged runtime");
    expect(workflow).not.toContainNormalized("Smoke PR linux headless packaged runtime");
    expect(workflow).not.toContainNormalized("OD_PACKAGED_E2E_");
    expect(workflow).not.toContainNormalized("actions/cache/save");
  });

  it("[P2] runs Windows launcher payload archive validation when tools-pack is touched", async () => {
    const workflow = await readFile(ciWorkflowPath, "utf8");
    const job = sectionBetween(workflow, "  windows_tools_pack_payload_tests:", "  web_workspace_tests:");
    const validate = sectionBetween(workflow, "  validate:", "          if [ -n \"$failures\" ]; then");

    expect(job).toContainNormalized("fromJSON(needs.runners.outputs.runs_on).windows_tools");
    expect(job).toContainNormalized("toJSON(fromJSON(needs.runners.outputs.runs_on).windows_tools)");
    expect(job).toContainNormalized("needs.scopes.outputs.run_windows_tools_pack_payload_tests == 'true'");
    expect(job).toContainNormalized("pnpm --filter @open-design/tools-pack exec vitest run tests/launcher-payload.test.ts");
    expect(validate).toContainNormalized("windows_tools_pack_payload_tests");
  });

  it("[P2] limits manual blob guard checks to changed files against main", async () => {
    const workflow = await readFile(ciWorkflowPath, "utf8");
    const blobGuard = sectionBetween(workflow, "  static_gate:", "  preflight:");

    expect(blobGuard).toContainNormalized('${{ github.event_name }}" = "workflow_dispatch"');
    expect(blobGuard).toContainNormalized("repos/${{ github.repository }}/compare/main...${{ github.sha }}");
    expect(blobGuard).toContainNormalized("select(.status != \"removed\") | .filename");
  });

  it("[P2] keeps merge queue as the authoritative post-PR validation path", async () => {
    const [ciWorkflow, dockerWorkflow, commentWorkflow, autofixWorkflow, reportWorkflow] = await Promise.all([
      readFile(ciWorkflowPath, "utf8"),
      readFile(dockerImageWorkflowPath, "utf8"),
      readFile(commentWorkflowPath, "utf8"),
      readFile(autofixWorkflowPath, "utf8"),
      readFile(reportWorkflowPath, "utf8"),
    ]);

    const ciTrigger = sectionBetween(ciWorkflow, "on:", "\npermissions:");
    const ciBlobGuard = sectionBetween(ciWorkflow, "  static_gate:", "  preflight:");
    const dockerTrigger = sectionBetween(dockerWorkflow, "on:", "\njobs:");

    expect(ciTrigger).toContainNormalized("pull_request:");
    expect(ciTrigger).toContainNormalized("merge_group:");
    expect(ciTrigger).toContainNormalized("workflow_dispatch:");
    expect(ciTrigger).not.toContainNormalized("push:");
    expect(ciBlobGuard).not.toContainNormalized('${{ github.event_name }}" = "push"');
    expect(dockerTrigger).toContainNormalized("workflow_call:");
    expect(dockerTrigger).toContainNormalized("tags: ['v*.*.*']");
    expect(dockerTrigger).toContainNormalized("pull_request:");
    // Publish stays tag/call only — no continuous main-branch image push.
    expect(dockerTrigger).not.toContainNormalized("branches: [main]");
    expect(dockerTrigger).not.toMatch(/push:\s*\n\s*branches:/);
    // Publish mode must not key only on event_name == workflow_call (caller keeps
    // its own event name). Release calls pass release_version / publish_latest.
    const dockerMode = sectionBetween(dockerWorkflow, "Resolve publish mode", "Set up QEMU");
    expect(dockerMode).toContainNormalized("RELEASE_VERSION");
    expect(dockerMode).toContainNormalized("PUBLISH_LATEST");
    expect(dockerMode).toContainNormalized('[ "$EVENT_NAME" = "push" ]');
    expect(dockerMode).toContainNormalized('[ -n "${RELEASE_VERSION:-}" ]');
    // Shell condition must not treat literal workflow_call as the publish signal.
    expect(dockerMode).not.toMatch(/\[\s*"\$EVENT_NAME"\s*=\s*"workflow_call"\s*\]/);
    // Smoke-only sha tags must be disabled whenever publish mode is true (release
    // callers are workflow_dispatch with release_version, and would otherwise push
    // manual-sha-* alongside the real version tags).
    expect(dockerWorkflow).toContainNormalized("steps.mode.outputs.publish != 'true' && github.event_name == 'pull_request'");
    expect(dockerWorkflow).toContainNormalized("steps.mode.outputs.publish != 'true' && github.event_name == 'workflow_dispatch'");
    expect(commentWorkflow).toContainNormalized("workflows: [ci]");
    // comment.atom consumes merge_group runs too, so the needs-validation gate can surface a
    // queue-ejection notice on the PR; autofix/report stay pull_request-only trusted consumers.
    expect(commentWorkflow).toContainNormalized(
      "(github.event.workflow_run.event == 'pull_request' || github.event.workflow_run.event == 'merge_group')",
    );
    expect(autofixWorkflow).toContainNormalized("workflows: [ci]");
    expect(autofixWorkflow).toContainNormalized("github.event.workflow_run.event == 'pull_request'");
    expect(autofixWorkflow).not.toContainNormalized("merge_group");
    expect(autofixWorkflow).not.toContainNormalized("ci-nix");
    expect(reportWorkflow).toContainNormalized("workflows: [ci]");
    expect(reportWorkflow).toContainNormalized("github.event.workflow_run.event == 'pull_request'");
    expect(reportWorkflow).not.toContainNormalized("merge_group");
  });

  it("[P2] surfaces a merge-queue needs-validation ejection as a PR comment handoff", async () => {
    const [ciWorkflow, commentWorkflow] = await Promise.all([
      readFile(ciWorkflowPath, "utf8"),
      readFile(commentWorkflowPath, "utf8"),
    ]);

    // Producer: the merge_group gate emits a handoff/comment artifact for the labeled PR when
    // it blocks, and uploads it on the failure path (the gate exits 1 exactly when it produces).
    expect(ciWorkflow).toContainNormalized("<!-- merge-queue-needs-validation -->");
    expect(ciWorkflow).toContainNormalized("emit_ejection_notice");
    expect(ciWorkflow).toContainNormalized(
      "if: ${{ failure() && steps.needs_validation_gate.outputs.comment_created == 'true' }}",
    );

    // Consumer: a merge_group run's head_sha is the queue's synthetic merge commit, so the atom
    // binds merge_group artifacts to their producing run by run_id and skips the base-freshness
    // check (PRs ahead in the queue move the base while the run completes).
    expect(commentWorkflow).toContainNormalized('"$RUN_EVENT" = "merge_group"');
    expect(commentWorkflow).toContainNormalized('"$artifact_run_id" != "$RUN_ID"');
    expect(commentWorkflow).toContainNormalized('[ "$RUN_EVENT" != "merge_group" ] && [ "$current_base" != "$base_sha" ]');
  });

  it("[P2] gates the backport auto-merge follow-up as a trusted workflow_run consumer", async () => {
    const workflow = await readFile(backportAutomergeWorkflowPath, "utf8");

    // Triggered only by ci completing, and only for a pull_request run on a backport-* branch —
    // never a push / manual dispatch, so a non-PR run can't reach the App-token or merge steps.
    expect(workflow).toContainNormalized("workflows: [ci]");
    expect(workflow).toContainNormalized("github.event.workflow_run.event == 'pull_request'");
    expect(workflow).toContainNormalized("startsWith(github.event.workflow_run.head_branch, 'backport-')");

    // It mints the privileged release App token, hence the identity + SHA gates below.
    expect(workflow).toContainNormalized("actions/create-github-app-token");
    expect(workflow).toContainNormalized("secrets.RELEASE_BOT_APP_ID");

    // Only a non-draft, same-repo PR authored by the release bot, targeting release/v*, is merged.
    expect(workflow).toContainNormalized("steps.pr.outputs.author == 'app/open-design-release-bot'");
    expect(workflow).toContainNormalized("steps.pr.outputs.cross == 'false'");
    expect(workflow).toContainNormalized("steps.pr.outputs.draft == 'false'");
    expect(workflow).toContainNormalized('startswith("release/v")');

    // A human commit pushed on top of the cherry-pick (conflict resolution, CI fix) is never
    // reviewed, so auto-approve/merge require pristine == 'true': the backport cumulative diff
    // must be patch-equivalent to the source PR's reviewed merge commit on main. Author/committer
    // identity is a spoofable git header, so the gate must not trust github-actions[bot] metadata.
    expect(workflow).toContainNormalized("steps.pr.outputs.pristine == 'true'");
    expect(workflow).toContainNormalized("Checkout trusted repository history");
    expect(workflow).toContainNormalized("fetch-depth: 0");
    expect(workflow).toContainNormalized("Backport of #([0-9]+)");
    expect(workflow).toContainNormalized("source_patch_id");
    expect(workflow).toContainNormalized("backport_patch_id");
    expect(workflow).toContainNormalized("git patch-id --verbatim");
    expect(workflow).not.toContainNormalized("git patch-id --stable");
    expect(workflow).toContainNormalized("+refs/heads/$(printf '%s' \"$row\" | jq -r '.baseRefName')");
    expect(workflow).toContainNormalized("+refs/pull/$num/head:refs/remotes/pull/$num/head");
    expect(workflow).toContainNormalized('backport_base="$(git merge-base "$base_oid" "$head_oid" 2>/dev/null || true)"');
    expect(workflow).toContainNormalized('if [ -n "$backport_base" ]; then');
    expect(workflow).toContainNormalized("git diff --binary \"$source_merge^\" \"$source_merge\"");
    expect(workflow).toContainNormalized("git diff --binary \"$backport_base\" \"$head_oid\"");
    expect(workflow).toContainNormalized("source_base\" = \"main");
    expect(workflow).not.toContainNormalized('.[].committer.login // "none"');
    expect(workflow).not.toContainNormalized("grep -Fvxc 'github-actions[bot]'");

    // The PR is resolved from the run's authoritative workflow_run.pull_requests association
    // (filtered to the release/* base at exactly the run's SHA), not a branch-name guess, and the
    // merge is bound to that same SHA (no post-green commit merged untested).
    expect(workflow).toContainNormalized("github.event.workflow_run.pull_requests");
    expect(workflow).toContainNormalized("select(.head.sha == $sha)");
    expect(workflow).toContainNormalized("steps.pr.outputs.head_oid == github.event.workflow_run.head_sha");
    expect(workflow).toContainNormalized("--match-head-commit");
    expect(workflow).toContainNormalized("--squash");
    expect(workflow).toContainNormalized("--delete-branch");

    // To satisfy release/v*'s one-approval rule, the bot's own clean backport is auto-approved by
    // github-actions[bot] (pull-requests: write) — under the same author==bot gate as the merge.
    expect(workflow).toContainNormalized("pull-requests: write");
    expect(workflow).toContainNormalized("gh pr review");
    expect(workflow).toContainNormalized("--approve");
    const approveStep = sectionBetween(workflow, "Approve the clean backport", "gh pr review");
    expect(approveStep).toContainNormalized("steps.pr.outputs.author == 'app/open-design-release-bot'");
    expect(approveStep).toContainNormalized("steps.pr.outputs.pristine == 'true'");
    expect(approveStep).toContainNormalized("github.token");
    expect(approveStep).toContainNormalized("github.event.workflow_run.conclusion == 'success'");

    // The Feishu failure path carries the same identity + SHA gates, so a fork / non-bot
    // backport-* PR can't spam the release group and stale failed runs do not page after the PR
    // head advanced. Alert on failure and timed_out, but not routine cancelled runs.
    const feishuStep = sectionBetween(workflow, "Notify Feishu on failed backport CI", "python3");
    expect(feishuStep).toContainNormalized("steps.pr.outputs.author == 'app/open-design-release-bot'");
    expect(feishuStep).toContainNormalized("steps.pr.outputs.cross == 'false'");
    expect(feishuStep).toContainNormalized("steps.pr.outputs.head_oid == github.event.workflow_run.head_sha");
    expect(feishuStep).toContainNormalized(
      "(github.event.workflow_run.conclusion == 'failure' || github.event.workflow_run.conclusion == 'timed_out')",
    );
    expect(feishuStep).not.toContainNormalized("'cancelled'");
  });

  it("[P2] gates the finalize-release follow-up as a trusted workflow_run consumer", async () => {
    const workflow = await readFile(finalizeReleaseWorkflowPath, "utf8");

    // Reacts to release-stable completing (not release: published — release-stable promotes its
    // own draft with GITHUB_TOKEN, which cannot trigger workflows), plus a manual backfill.
    expect(workflow).toContainNormalized('workflows: ["release-stable"]');
    expect(workflow).toContainNormalized("types: [completed]");
    expect(workflow).toContainNormalized("workflow_dispatch:");
    expect(workflow).toContainNormalized("github.event_name == 'workflow_dispatch'");
    expect(workflow).toContainNormalized("github.event.workflow_run.conclusion == 'success'");
    expect(workflow).toContainNormalized("github.repository == 'nexu-io/open-design'");
    expect(workflow).not.toContainNormalized("github.event.workflow_run.conclusion != 'cancelled'");

    // It mints the privileged release App token for label deletion, branch push, PR + merge-queue.
    expect(workflow).toContainNormalized("actions/create-github-app-token");
    expect(workflow).toContainNormalized("secrets.RELEASE_BOT_APP_ID");

    // The shipped version is resolved from the LATEST published release (release-stable marks it
    // --latest) or the dispatch tag — NEVER from workflow_run.head_branch, which can be the
    // dispatch ref rather than the built release branch when release-stable runs with a `ref` input.
    expect(workflow).toContainNormalized("gh release view --repo nexu-io/open-design --json tagName,isDraft,isPrerelease");
    expect(workflow).not.toContainNormalized("github.event.workflow_run.head_branch");
    expect(workflow).not.toContainNormalized("HEAD_BRANCH");

    // Only a published (draft=false), non-prerelease, open-design-vX.Y.Z release finalizes; a
    // dry-run completion (latest stays the previous, already-finalized stable) must no-op.
    expect(workflow).toContainNormalized("isDraft");
    expect(workflow).toContainNormalized("isPrerelease");
    expect(workflow).toContainNormalized("^[0-9]+\\.[0-9]+\\.[0-9]+$");
    expect(workflow).toContainNormalized('echo "skip=true"');
    expect(workflow).toContainNormalized("steps.ver.outputs.skip != 'true'");

    // Idempotent forward-only bump of the synchronized manifests (patch, not the next minor that
    // cut-release owns); independently-versioned packages are skipped via npm pkg set version.
    expect(workflow).toContainNormalized("sort -V");
    expect(workflow).toContainNormalized("npm pkg set version");
    expect(workflow).toContainNormalized("changed=true");

    // The bump PR needs one core-maintainer approval (code-owned manifests + require_code_owner_review
    // on main), so finalize requests that review and arms the merge queue pinned to the pushed SHA.
    expect(workflow).toContainNormalized("--add-reviewer nexu-io/core-maintainers");
    expect(workflow).toContainNormalized("--squash --auto --match-head-commit");
    expect(workflow).toContainNormalized("head_sha=$(git rev-parse HEAD)");
    expect(workflow).toContainNormalized("git ls-remote --exit-code --heads origin \"$BRANCH\"");

    // The shipped release's backport label is cleaned up (tolerant of an already-deleted label).
    expect(workflow).toContainNormalized('label="backport release/v$VERSION"');
    expect(workflow).toContainNormalized("gh label delete");
  });

  itSkipOnWindows("[P2] resolves finalize-release shipped versions from the real workflow shell step", async () => {
    const workflow = await readFile(finalizeReleaseWorkflowPath, "utf8");
    const script = extractWorkflowRunScript(
      workflow,
      "Resolve the shipped version (latest published stable, or the dispatch tag)",
    );

    async function runResolve(args: {
      event: "workflow_dispatch" | "workflow_run";
      inputTag?: string;
      state?: string;
      ghExit?: boolean;
    }): Promise<{ output: Record<string, string>; ghArgs: string[] }> {
      const dir = await mkdtemp(join(tmpdir(), "od-finalize-resolve-"));
      const ghPath = join(dir, "gh");
      const jqPath = join(dir, "jq");
      const outputPath = join(dir, "github-output");
      const ghLogPath = join(dir, "gh-args.log");
      await writeFile(
        ghPath,
        `#!/usr/bin/env node
const fs = require("node:fs");
fs.appendFileSync(process.env.FAKE_GH_LOG, process.argv.slice(2).join(" ") + "\\n");
if (process.env.FAKE_GH_EXIT === "1") process.exit(1);
process.stdout.write(process.env.FAKE_GH_STATE || "");
`,
      );
      await chmod(ghPath, 0o755);
      await writeFile(
        jqPath,
        `#!/usr/bin/env node
const selector = process.argv[process.argv.length - 1];
let input = "";
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  const data = JSON.parse(input);
  const key = selector.startsWith(".") ? selector.slice(1) : selector;
  process.stdout.write(String(data[key]) + "\\n");
});
`,
      );
      await chmod(jqPath, 0o755);

      try {
        await execFileAsync("bash", ["-c", script], {
          cwd: dir,
          env: {
            ...process.env,
            EVENT: args.event,
            INPUT_TAG: args.inputTag ?? "",
            GITHUB_OUTPUT: outputPath,
            PATH: `${dir}${delimiter}${process.env.PATH ?? ""}`,
            FAKE_GH_LOG: ghLogPath,
            FAKE_GH_STATE: args.state ?? "",
            FAKE_GH_EXIT: args.ghExit ? "1" : "0",
          },
        });
        const [rawOutput, rawGhArgs] = await Promise.all([
          readFile(outputPath, "utf8").catch(() => ""),
          readFile(ghLogPath, "utf8").catch(() => ""),
        ]);
        return {
          output: parseGithubOutput(rawOutput),
          ghArgs: rawGhArgs.split(/\r?\n/).filter(Boolean),
        };
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }

    await expect(
      runResolve({
        event: "workflow_dispatch",
        inputTag: "0.12.0",
        state: JSON.stringify({ tagName: "open-design-v0.12.0", isDraft: false, isPrerelease: false }),
      }),
    ).resolves.toMatchObject({
      output: {
        skip: "false",
        version: "0.12.0",
        next: "0.12.1",
        branch: "release-bot/bump-main-v0.12.1",
      },
      ghArgs: [expect.stringContaining("release view open-design-v0.12.0")],
    });

    await expect(
      runResolve({
        event: "workflow_dispatch",
        inputTag: "open-design-v1.2.3",
        state: JSON.stringify({ tagName: "open-design-v1.2.3", isDraft: false, isPrerelease: false }),
      }),
    ).resolves.toMatchObject({
      output: { skip: "false", version: "1.2.3", next: "1.2.4" },
      ghArgs: [expect.stringContaining("release view open-design-v1.2.3")],
    });

    for (const state of [
      { tagName: "open-design-v0.12.0", isDraft: true, isPrerelease: false },
      { tagName: "open-design-v0.12.0", isDraft: false, isPrerelease: true },
      { tagName: "open-design-v0.12.0-beta.1", isDraft: false, isPrerelease: false },
    ]) {
      await expect(runResolve({ event: "workflow_run", state: JSON.stringify(state) })).resolves.toMatchObject({
        output: { skip: "true" },
      });
    }

    await expect(runResolve({ event: "workflow_run", ghExit: true })).resolves.toMatchObject({
      output: { skip: "true" },
    });
  });

  itSkipOnWindows("[P2] bumps only synchronized workspace manifests in finalize-release", async () => {
    const workflow = await readFile(finalizeReleaseWorkflowPath, "utf8");
    const script = extractWorkflowRunScript(workflow, "Bump main's synchronized workspace versions");
    const dir = await mkdtemp(join(tmpdir(), "od-finalize-bump-"));
    const outputPath = join(dir, "github-output");
    const writeJson = (relativePath: string, value: unknown) =>
      writeFile(join(dir, relativePath), `${JSON.stringify(value, null, 2)}\n`);

    try {
      await Promise.all([
        mkdir(join(dir, "apps", "web"), { recursive: true }),
        mkdir(join(dir, "packages", "platform"), { recursive: true }),
        mkdir(join(dir, "packages", "components"), { recursive: true }),
        mkdir(join(dir, "tools", "dev"), { recursive: true }),
        mkdir(join(dir, "e2e"), { recursive: true }),
      ]);
      await Promise.all([
        writeJson("package.json", { name: "root", version: "0.12.0", dependencies: { untouched: "0.12.0" } }),
        writeJson("apps/web/package.json", { name: "@open-design/web", version: "0.12.0" }),
        writeJson("packages/platform/package.json", { name: "@open-design/platform", version: "0.12.0" }),
        writeJson("packages/components/package.json", { name: "@open-design/components", version: "0.5.0" }),
        writeJson("tools/dev/package.json", { name: "@open-design/dev", version: "0.12.0" }),
        writeJson("e2e/package.json", { name: "@open-design/e2e", version: "0.12.0" }),
      ]);

      await execFileAsync("bash", ["-c", script], {
        cwd: dir,
        env: { ...process.env, NEXT: "0.12.1", GITHUB_OUTPUT: outputPath },
      });

      await expect(readFile(outputPath, "utf8")).resolves.toContainNormalized("changed=true");
      await expect(readFile(join(dir, "package.json"), "utf8").then(JSON.parse)).resolves.toMatchObject({
        version: "0.12.1",
        dependencies: { untouched: "0.12.0" },
      });
      await expect(readFile(join(dir, "apps", "web", "package.json"), "utf8").then(JSON.parse)).resolves.toMatchObject({
        version: "0.12.1",
      });
      await expect(readFile(join(dir, "packages", "platform", "package.json"), "utf8").then(JSON.parse)).resolves.toMatchObject({
        version: "0.12.1",
      });
      await expect(readFile(join(dir, "tools", "dev", "package.json"), "utf8").then(JSON.parse)).resolves.toMatchObject({
        version: "0.12.1",
      });
      await expect(readFile(join(dir, "e2e", "package.json"), "utf8").then(JSON.parse)).resolves.toMatchObject({
        version: "0.12.1",
      });
      await expect(readFile(join(dir, "packages", "components", "package.json"), "utf8").then(JSON.parse)).resolves.toMatchObject({
        version: "0.5.0",
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  itSkipOnWindows("[P2] keeps finalize-release version bumps forward-only", async () => {
    const workflow = await readFile(finalizeReleaseWorkflowPath, "utf8");
    const script = extractWorkflowRunScript(workflow, "Bump main's synchronized workspace versions");
    const dir = await mkdtemp(join(tmpdir(), "od-finalize-bump-noop-"));
    const outputPath = join(dir, "github-output");

    try {
      await writeFile(join(dir, "package.json"), `${JSON.stringify({ name: "root", version: "0.12.2" }, null, 2)}\n`);

      await execFileAsync("bash", ["-c", script], {
        cwd: dir,
        env: { ...process.env, NEXT: "0.12.1", GITHUB_OUTPUT: outputPath },
      });

      await expect(readFile(outputPath, "utf8")).resolves.toContainNormalized("changed=false");
      await expect(readFile(join(dir, "package.json"), "utf8").then(JSON.parse)).resolves.toMatchObject({
        version: "0.12.2",
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("[P2] keeps the backport patch-equivalence gate whitespace-sensitive", async () => {
    const compactDiff = [
      "diff --git a/script.py b/script.py",
      "--- a/script.py",
      "+++ b/script.py",
      "@@ -1 +1 @@",
      "-print(1)",
      "+print(2)",
      "",
    ].join("\n");
    const whitespaceDiff = [
      "diff --git a/script.py b/script.py",
      "--- a/script.py",
      "+++ b/script.py",
      "@@ -1 +1 @@",
      "-print(1)",
      "+ print(2)",
      "",
    ].join("\n");

    const compactStable = await gitPatchId("--stable", compactDiff);
    const whitespaceStable = await gitPatchId("--stable", whitespaceDiff);
    const compactVerbatim = await gitPatchId("--verbatim", compactDiff);
    const whitespaceVerbatim = await gitPatchId("--verbatim", whitespaceDiff);

    expect(compactStable).toBe(whitespaceStable);
    expect(compactVerbatim).not.toBe(whitespaceVerbatim);
  });

  it("[P2] gates the plugin-preview manifest auto-merge as a trusted workflow_run consumer", async () => {
    const workflow = await readFile(bakePreviewsAutomergeWorkflowPath, "utf8");

    // Triggered only by ci completing, and only for a pull_request run on the rolling
    // chore/plugin-previews branch — never a push / manual dispatch, so a non-PR run can't reach
    // the App-token or merge steps.
    expect(workflow).toContainNormalized("workflows: [ci]");
    expect(workflow).toContainNormalized("github.event.workflow_run.event == 'pull_request'");
    expect(workflow).toContainNormalized("github.event.workflow_run.head_branch == 'chore/plugin-previews'");

    // It mints the privileged release App token, hence the identity + SHA gates below.
    expect(workflow).toContainNormalized("actions/create-github-app-token");
    expect(workflow).toContainNormalized("secrets.RELEASE_BOT_APP_ID");

    // Only a non-draft, same-repo PR authored by the release bot, targeting main, is merged.
    expect(workflow).toContainNormalized("steps.pr.outputs.author == 'app/open-design-release-bot'");
    expect(workflow).toContainNormalized("steps.pr.outputs.cross == 'false'");
    expect(workflow).toContainNormalized("steps.pr.outputs.draft == 'false'");
    expect(workflow).toContainNormalized('select(.base.ref == "main")');

    // A human commit pushed onto the rolling branch is unreviewed, so auto-approve/merge require
    // pristine == 'true': the PR's changed files are EXACTLY data/plugin-previews/manifest.json. A
    // commit's author/committer identity is a spoofable git header and the Git Data API does not
    // sign commits, so neither identity nor signature can prove bot provenance; instead the diff is
    // bounded to manifest-only so a pushed code change can never auto-merge. Paginated across all
    // files; any non-manifest file fails the count.
    expect(workflow).toContainNormalized("steps.pr.outputs.pristine == 'true'");
    expect(workflow).toContainNormalized("/files?per_page=100");
    expect(workflow).toContainNormalized(".[].filename");
    expect(workflow).toContainNormalized("--paginate");
    expect(workflow).toContainNormalized("grep -Fvxc 'data/plugin-previews/manifest.json'");

    // The PR is resolved from the run's authoritative workflow_run.pull_requests association
    // (filtered to the main base at exactly the run's SHA), not a branch-name guess, and the merge
    // is bound to that same SHA (no post-green commit merged untested). main has a merge queue, so
    // the merge is GitHub-native --auto (enqueue), not a direct squash.
    expect(workflow).toContainNormalized("github.event.workflow_run.pull_requests");
    expect(workflow).toContainNormalized("select(.head.sha == $sha)");
    expect(workflow).toContainNormalized("steps.pr.outputs.head_oid == github.event.workflow_run.head_sha");
    expect(workflow).toContainNormalized("--match-head-commit");
    expect(workflow).toContainNormalized("--squash");
    expect(workflow).toContainNormalized("--auto");

    // To satisfy main's one-approval rule, the bot's own clean manifest PR is auto-approved by
    // github-actions[bot] (pull-requests: write) — a different identity than the App author.
    expect(workflow).toContainNormalized("pull-requests: write");
    expect(workflow).toContainNormalized("gh pr review");
    expect(workflow).toContainNormalized("--approve");
    const approveStep = sectionBetween(workflow, "Approve the clean manifest PR", "gh pr review");
    expect(approveStep).toContainNormalized("steps.pr.outputs.author == 'app/open-design-release-bot'");
    expect(approveStep).toContainNormalized("steps.pr.outputs.pristine == 'true'");
    expect(approveStep).toContainNormalized("github.token");
    // Approve only when the run CI actually succeeded — dropping this predicate would approve a
    // PR whose CI failed.
    expect(approveStep).toContainNormalized("github.event.workflow_run.conclusion == 'success'");

    // The enqueue step carries the same identity + SHA + pristine + success gates as the approve,
    // and merges via the native --auto path bound to the validated SHA. Dropping the success
    // predicate here would enqueue a PR whose CI failed.
    const enqueueStep = sectionBetween(workflow, "Enqueue the clean manifest PR", "gh pr merge");
    expect(enqueueStep).toContainNormalized("steps.pr.outputs.author == 'app/open-design-release-bot'");
    expect(enqueueStep).toContainNormalized("steps.pr.outputs.pristine == 'true'");
    expect(enqueueStep).toContainNormalized("steps.pr.outputs.head_oid == github.event.workflow_run.head_sha");
    expect(enqueueStep).toContainNormalized("github.event.workflow_run.conclusion == 'success'");
    // Base-freshness: main's merge queue does not require an up-to-date branch, so a bake rendered
    // against an older main must not be squashed in over a newer manifest. The enqueue requires the
    // rendered base (the PR head's first parent) to equal current main HEAD; a behind PR waits for
    // the next bake to refresh.
    expect(enqueueStep).toContainNormalized("steps.pr.outputs.base_fresh == 'true'");
    expect(workflow).toContainNormalized('.parents[0].sha // ""');
    expect(workflow).toContainNormalized("commits/heads/main");

    // The Feishu failure path carries the same identity gates, so a fork / non-bot PR can't spam
    // the release group, and fires only on a CI *failure* (not success).
    const feishuStep = sectionBetween(workflow, "Notify Feishu on failed manifest CI", "python3");
    expect(feishuStep).toContainNormalized("steps.pr.outputs.author == 'app/open-design-release-bot'");
    expect(feishuStep).toContainNormalized("steps.pr.outputs.cross == 'false'");
    // Page on every terminal RED state that strands the PR — failure AND timed_out (ci.yml has
    // timeout-minutes jobs) — but NOT cancelled, which a routine force-push of the rolling branch
    // produces and would otherwise page on every refresh.
    expect(feishuStep).toContainNormalized("github.event.workflow_run.conclusion == 'failure'");
    expect(feishuStep).toContainNormalized("github.event.workflow_run.conclusion == 'timed_out'");
    expect(feishuStep).not.toContainNormalized("'cancelled'");
    // Bind the alert to the exact SHA that failed: the rolling branch is force-pushed, so a stale
    // failed run that finishes after the head advanced must not page about a SHA that is no longer
    // the PR head.
    expect(feishuStep).toContainNormalized("steps.pr.outputs.head_oid == github.event.workflow_run.head_sha");
    // Sign the release webhook with the SAME secret the rest of the repo pairs with
    // FEISHU_RELEASE_WEBHOOK (notify-release-feishu / notify-daily-feishu / backport-automerge),
    // not a stray secret that resolves empty and sends an unsigned, rejected request.
    expect(feishuStep).toContainNormalized("secrets.FEISHU_RELEASE_WEBHOOK");
    expect(feishuStep).toContainNormalized("secrets.FEISHU_RELEASE_SIGN_SECRET");
  });

  it("[P2] keeps the bake producer wired so the auto-merge pristine path works", async () => {
    // The downstream pristine/auto-merge gates only hold if the producer keeps authoring the
    // rolling manifest PR the right way. Lock the three producer invariants this PR depends on, so
    // regressing any of them fails here instead of silently breaking auto-merge.
    const workflow = await readFile(bakePreviewsWorkflowPath, "utf8");

    // 1. The rolling PR is pushed with the release-bot App token, not GITHUB_TOKEN — a
    //    GITHUB_TOKEN-authored push triggers no CI, so the PR could never clear main's required
    //    `Validate workspace` check or the merge queue.
    expect(workflow).toContainNormalized("actions/create-github-app-token");
    expect(workflow).toContainNormalized("secrets.RELEASE_BOT_APP_ID");
    expect(workflow).toContainNormalized("x-access-token:${APP_TOKEN}");
    // 2. The manifest commit touches ONLY data/plugin-previews/manifest.json. The reactor's
    //    pristine gate trusts the PR file set (not a forgeable commit identity), so the producer
    //    must keep committing exactly that one file.
    expect(workflow).toContainNormalized("cp \"$NEW\" \"$OLD\"");
    expect(workflow).toContainNormalized('git add "$OLD"');
    // 3. The rolling branch is rebuilt from the checked-out HEAD (the revision the manifest was
    //    rendered against), NOT live main — the bake can run ~90min while main advances, and basing
    //    it on live main would publish a stale manifest on top of newer commits. Creating the branch
    //    with `git checkout -B` from HEAD parents the commit on the rendered revision; a regression
    //    to a live-main base (fetching refs/heads/main as the parent) fails here.
    expect(workflow).toContainNormalized('git checkout -B "$BRANCH"');
    expect(workflow).not.toContainNormalized("git/ref/heads/main");
  });

  it("[P2] keeps the release-cut bake pushing its manifest as a ruleset bypass bot", async () => {
    // release/** is guarded by the "Protected branches (preview/*, release/v*)" ruleset whose
    // pull_request rule rejects a direct push (GH013) unless the pusher is a bypass actor. The
    // release-cut bake writes the authoritative manifest straight onto the release branch, so it
    // must push as open-design-bot — a bypass actor on that ruleset — not github-actions[bot],
    // which is NOT and gets rejected (this stranded release/v0.14.2's manifest). These three auth
    // invariants only work together; a refactor that drops any one silently reintroduces the
    // GH013 regression, so lock them here rather than rely on YAML review.
    const workflow = await readFile(bakePreviewsReleaseWorkflowPath, "utf8");

    // 1. Checkout must NOT persist GITHUB_TOKEN: its http.extraheader would override the inline bot
    //    token on push and re-authenticate as github-actions[bot] (the same override fixed in the
    //    post-merge bake — #5357).
    expect(workflow).toContainNormalized("persist-credentials: false");
    // 2. The run mints an open-design-bot token via the BOT_APP_* creds — the App that IS a bypass
    //    actor on the release ruleset. RELEASE_BOT_APP_ID (used by the post-merge bake) is a
    //    different App and is NOT a bypass actor, so pin the correct credentials, not just the
    //    generic token action.
    expect(workflow).toContainNormalized("actions/create-github-app-token");
    expect(workflow).toContainNormalized("secrets.BOT_APP_CLIENT_ID");
    expect(workflow).toContainNormalized("secrets.BOT_APP_PRIVATE_KEY");
    // 3. The manifest push goes through the explicit tokenized URL with that bot token, so it
    //    authenticates as the bypass actor rather than the checkout's default credential.
    expect(workflow).toContainNormalized("x-access-token:${BOT_TOKEN}");
  });

  it("[P2] keeps PR and merge queue CI separated by hot/full validation mode", async () => {
    const workflow = await readFile(ciWorkflowPath, "utf8");
    const scopes = sectionBetween(workflow, "  scopes:", "  static_gate:");
    const validate = sectionBetween(workflow, "  validate:", "  runtime_summary:");

    expect(workflow).toContainNormalized("ci_mode:");
    expect(scopes).toContainNormalized("ci_mode: ${{ steps.detect.outputs.ci_mode }}");
    expect(scopes).toContainNormalized("ui_p0_validation_required: ${{ steps.detect.outputs.ui_p0_validation_required }}");
    expect(scopes).toContainNormalized("run_ui_p0: ${{ steps.detect.outputs.run_ui_p0 }}");
    expect(workflow).toContainNormalized("needs.scopes.outputs.run_ui_p0 == 'true'");
    expect(validate).toContainNormalized('when($out.run_ui_p0 == "true"; ["ui_p0"])');

    await expect(runScopesPrint("workflow_dispatch", { inputs: { ci_mode: "hot" } }, ["apps/web/src/app/page.tsx"])).resolves.toMatchObject({
      ci_mode: "hot",
      run_ui_p0: true,
      run_playwright_critical: false,
    });
    await expect(runScopesPrint("workflow_dispatch", { inputs: { ci_mode: "hot" } }, ["tools/dev/src/index.ts"])).resolves.toMatchObject({
      ci_mode: "hot",
      run_ui_p0: false,
      run_playwright_critical: true,
    });
    await expect(runScopesPrint("workflow_dispatch", { inputs: {} })).resolves.toMatchObject({
      ci_mode: "full",
      ui_p0_validation_required: true,
      run_playwright_critical: false,
      run_ui_p0: true,
      run_preflight: true,
    });
    await expect(runScopesPrint("merge_group", {})).resolves.toMatchObject({
      ci_mode: "full",
      ui_p0_validation_required: true,
      run_playwright_critical: false,
      run_ui_p0: true,
      run_preflight: true,
    });
    // Packaging (nix / docker) is no longer part of core scopes / Validate workspace.
    for (const plan of await Promise.all([
      runScopesPrint("merge_group", {}),
      runScopesPrint("workflow_dispatch", { inputs: {} }),
      runScopesPrint("pull_request", { pull_request: { number: 1 } }, ["apps/web/src/app/page.tsx"]),
    ])) {
      expect(plan).not.toHaveProperty("run_nix_validation");
      expect(plan).not.toHaveProperty("run_docker_build");
      expect(plan).not.toHaveProperty("nix_validation_required");
      expect(plan).not.toHaveProperty("docker_validation_required");
    }
  });

  it("[P2] closes packaged-leaf coverage without duplicating the broad E2E lane", async () => {
    const workflow = await readFile(ciWorkflowPath, "utf8");
    const workspaceUnit = sectionBetween(workflow, "  workspace_unit_tests:", "  windows_tools_pack_payload_tests:");

    expect(workspaceUnit).toContainNormalized(`if [ "\${{ needs.scopes.outputs.tools_pack_tests_required }}" = "true" ]; then
            pnpm --filter @open-design/desktop build
            pnpm --filter @open-design/desktop test
            pnpm --filter @open-design/packaged test
            pnpm --filter @open-design/tools-pack test
            if [ "\${{ needs.scopes.outputs.run_e2e_vitest }}" != "true" ]; then
              pnpm --filter @open-design/e2e test tests/packaged-launcher-update-loop.test.ts
            fi
          fi`);
  });

  it("[P2] skips the critical fallback for pure packaged-leaf changes and stays fail-closed elsewhere", async () => {
    const hot = { inputs: { ci_mode: "hot" } };

    // Playwright never starts the desktop, packaged, or tools-pack
    // entrypoints, so a change confined to those leaf roots keeps its
    // package tests but must not pay the two-job critical fallback.
    for (const file of [
      "apps/desktop/src/main.ts",
      "apps/packaged/src/index.ts",
      "tools/pack/src/win/installer.ts",
    ]) {
      await expect(runScopesPrint("workflow_dispatch", hot, [file])).resolves.toMatchObject({
        run_playwright_critical: false,
        run_ui_p0: false,
        tools_dev_tests_required: true,
        tools_pack_tests_required: true,
        ui_critical_validation_required: false,
        workspace_validation_required: true,
      });
    }

    const mergeGroup = {
      merge_group: {
        base_sha: "1111111111111111111111111111111111111111",
        head_sha: "2222222222222222222222222222222222222222",
      },
    };
    await expect(runScopesPrint("merge_group", mergeGroup, ["apps/desktop/src/main.ts"])).resolves.toMatchObject({
      run_e2e_vitest: false,
      run_playwright_critical: false,
      run_playwright_visual: false,
      run_ui_p0: false,
      run_web_workspace_tests: false,
      run_windows_tools_pack_payload_tests: true,
      tools_dev_tests_required: true,
      tools_pack_tests_required: true,
      workspace_validation_required: true,
    });

    await expect(runScopesPrint("merge_group", mergeGroup, ["apps/desktop/package.json"])).resolves.toMatchObject({
      run_e2e_vitest: true,
      run_playwright_visual: true,
      run_ui_p0: true,
      run_web_workspace_tests: true,
    });

    // Fail-closed: anything that can reach the Playwright runtime — tools-dev,
    // transitive packages (including the undeclared metatool edge), scripts,
    // runtime resources, or unknown roots — retains the fallback.
    for (const file of [
      "tools/dev/src/index.ts",
      "packages/metatool/src/index.ts",
      "packages/agui-adapter/src/adapter.ts",
      "packages/diagnostics/src/index.ts",
      "packages/plugin-runtime/src/index.ts",
      "packages/registry-protocol/src/index.ts",
      "scripts/guard.ts",
      "mocks/bin/opencode",
      "some-new-root/file.ts",
    ]) {
      await expect(runScopesPrint("workflow_dispatch", hot, [file])).resolves.toMatchObject({
        run_playwright_critical: true,
        ui_critical_validation_required: true,
      });
    }

    // A mixed leaf + runtime change retains the fallback.
    await expect(
      runScopesPrint("workflow_dispatch", hot, ["apps/desktop/src/main.ts", "tools/dev/src/index.ts"]),
    ).resolves.toMatchObject({
      run_playwright_critical: true,
      ui_critical_validation_required: true,
    });

    // Root manifest/lock/workspace files keep enabling P0, which retains the
    // existing critical/P0 mutual exclusion.
    for (const file of ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"]) {
      await expect(runScopesPrint("workflow_dispatch", hot, [file])).resolves.toMatchObject({
        run_ui_p0: true,
        run_playwright_critical: false,
      });
    }

    // Documentation-only changes stay exempt from both.
    await expect(runScopesPrint("workflow_dispatch", hot, ["docs/spec.md"])).resolves.toMatchObject({
      run_playwright_critical: false,
      ui_critical_validation_required: false,
      workspace_validation_required: false,
    });

    // merge_group/full behavior is unchanged: everything is required and the
    // matrix covers critical, so the fallback stays off.
    await expect(runScopesPrint("merge_group", {})).resolves.toMatchObject({
      ci_mode: "full",
      ui_critical_validation_required: true,
      run_playwright_critical: false,
      run_ui_p0: true,
    });
  });

  itSkipOnWindows("[P2] keeps packaging (nix/docker) off the core Validate workspace gate", async () => {
    const workflow = await readFile(ciWorkflowPath, "utf8");
    const validate = sectionBetween(workflow, "  validate:", "  runtime_summary:");

    expect(workflow).not.toContainNormalized("nix_validation:");
    expect(workflow).not.toContainNormalized("docker_pr:");
    expect(validate).not.toContainNormalized("nix_validation");
    expect(validate).not.toContainNormalized("docker_pr");
    expect(validate).not.toContainNormalized("run_nix_validation");
    expect(validate).not.toContainNormalized("run_docker_build");
    expect(validate).toContainNormalized("Check workspace validation jobs");

    const baseOutputs = {
      run_preflight: "false",
      run_workspace_unit_tests: "false",
      run_windows_tools_pack_payload_tests: "false",
      run_web_workspace_tests: "false",
      run_e2e_vitest: "false",
      run_playwright_critical: "false",
      run_ui_p0: "false",
      run_playwright_visual: "false",
    };
    // Core gate only cares about app jobs — unknown packaging keys are ignored.
    await expect(
      validateGatePasses(workflow, {
        scopes: { result: "success", outputs: baseOutputs },
        static_gate: { result: "success" },
      }),
    ).resolves.toBe(true);

    const needsWithFailedWeb = {
      scopes: { result: "success", outputs: { ...baseOutputs, run_web_workspace_tests: "true" } },
      static_gate: { result: "success" },
      web_workspace_tests: { result: "failure" },
    };
    await expect(validateGatePasses(workflow, needsWithFailedWeb)).resolves.toBe(false);
  });

  it("[P1] includes launcher protocol in the Nix daemon workspace build", async () => {
    const flake = await readFile(flakePath, "utf8");
    const daemonWorkspaces = sectionBetween(flake, "      daemonWorkspacePaths = [", "      ];");

    expect(daemonWorkspaces).toContainNormalized('"packages/launcher-proto"');
    expect(daemonWorkspaces.indexOf('"packages/launcher-proto"')).toBeLessThan(
      daemonWorkspaces.indexOf('"apps/daemon"'),
    );
  });

  it("[P2] routes default CI through cost-sensitive runner tiers", async () => {
    const workflow = await readFile(ciWorkflowPath, "utf8");
    const runners = sectionBetween(workflow, "  runners:", "  scopes:");
    const scopes = sectionBetween(workflow, "  scopes:", "  static_gate:");
    const staticGate = sectionBetween(workflow, "  static_gate:", "  preflight:");
    const workspaceUnitTests = sectionBetween(workflow, "  workspace_unit_tests:", "  windows_tools_pack_payload_tests:");
    const webWorkspaceTests = sectionBetween(workflow, "  web_workspace_tests:", "  e2e_vitest:");
    const e2eVitest = sectionBetween(workflow, "  e2e_vitest:", "  playwright_critical:");
    const preflight = sectionBetween(workflow, "  preflight:", "  workspace_unit_tests:");
    const uiP0 = sectionBetween(workflow, "  ui_p0:", "  playwright_visual:");
    const visual = sectionBetween(workflow, "  playwright_visual:", "  validate:");

    expect(runners).toContainNormalized("runs-on: ubuntu-24.04");
    expect(runners).toContainNormalized("runs_on: ${{ steps.runners.outputs.runs_on }}");
    expect(runners).toContainNormalized("decision: ${{ steps.runners.outputs.decision }}");
    expect(runners).toContainNormalized("python3 .github/scripts/runners.py");
    expect(scopes).toContainNormalized("needs: [runners]");
    expect(scopes).toContainNormalized("fromJSON(needs.runners.outputs.runs_on).control");
    expect(staticGate).toContainNormalized("needs: [runners]");
    expect(staticGate).toContainNormalized("fromJSON(needs.runners.outputs.runs_on).control");
    expect(workspaceUnitTests).toContainNormalized("fromJSON(needs.runners.outputs.runs_on).workspace_unit");
    expect(workspaceUnitTests).toContainNormalized("toJSON(fromJSON(needs.runners.outputs.runs_on).workspace_unit)");
    expect(webWorkspaceTests).toContainNormalized("fromJSON(needs.runners.outputs.runs_on).js_hot");
    expect(webWorkspaceTests).toContainNormalized("toJSON(fromJSON(needs.runners.outputs.runs_on).js_hot)");
    expect(webWorkspaceTests).not.toContainNormalized('"od-persistent-ci"');
    expect(e2eVitest).toContainNormalized("fromJSON(needs.runners.outputs.runs_on).js_hot");
    expect(e2eVitest).toContainNormalized("toJSON(fromJSON(needs.runners.outputs.runs_on).js_hot)");
    expect(e2eVitest).not.toContainNormalized('"od-persistent-ci"');
    expect(preflight).toContainNormalized("fromJSON(needs.runners.outputs.runs_on).general_medium");
    expect(preflight).toContainNormalized("toJSON(fromJSON(needs.runners.outputs.runs_on).general_medium)");
    expect(uiP0).toContainNormalized("fromJSON(needs.runners.outputs.runs_on).ui_hot");
    expect(uiP0).toContainNormalized("toJSON(fromJSON(needs.runners.outputs.runs_on).ui_hot)");
    expect(uiP0).toContainNormalized("include: ${{ fromJSON(needs.scopes.outputs.ui_p0_matrix) }}");
    expect(uiP0CiMatrix.map((entry) => entry.name)).toEqual([
      "entry-settings",
      "project-workspace",
      "project-runtime",
      "workspace-restoration",
    ]);
    expect(uiP0Groups["project-workspace"].files).toEqual([
      "ui/app.test.ts",
      "ui/app-design-files.test.ts",
      "ui/app-manual-edit.test.ts",
      "ui/project-management-flows.test.ts",
      "ui/workspace-keyboard-flows.test.ts",
    ]);
    expect(uiP0Groups["project-workspace"].workers).toBe(1);
    expect(uiP0Groups["critical-extras"]).toEqual({
      grep: "@merge-extra",
      workers: 1,
      files: ["ui/app.test.ts"],
    });
    expect(uiP0Groups["workspace-restoration"]).toEqual({
      fullyParallel: true,
      grep: String.raw`\[P0\]`,
      files: ["ui/app-restoration.test.ts", "ui/critical-smoke.test.ts"],
    });
    expect(workflow).not.toContainNormalized("  ui_p0_smoke:");
    expect(uiP0).toContainNormalized("run-ui-group critical-extras");
    expect(uiP0).toContainNormalized("Preserve project-runtime domain artifact");
    expect(visual).toContainNormalized("fromJSON(needs.runners.outputs.runs_on).visual_hot");
    expect(visual).toContainNormalized("toJSON(fromJSON(needs.runners.outputs.runs_on).visual_hot)");
    expect(workflow).not.toContainNormalized("needs.runners.outputs.contabo_control");
    expect(workflow).not.toContainNormalized("needs.runners.outputs.hosted_or_blacksmith");
    expect(workflow).not.toContainNormalized("needs.runners.outputs.blacksmith_default");
  });

  it("[P1] pins ShellCheck for actionlint across runner profiles", async () => {
    const workflow = await readFile(ciWorkflowPath, "utf8");
    const staticGate = sectionBetween(workflow, "  static_gate:", "  preflight:");

    expect(staticGate).toContainNormalized("SHELLCHECK_VERSION: 0.11.0");
    expect(staticGate).toContainNormalized("shellcheck_arch=x86_64");
    expect(staticGate).toContainNormalized("shellcheck_arch=aarch64");
    expect(staticGate).toContainNormalized(
      'koalaman/shellcheck/releases/download/v${SHELLCHECK_VERSION}/shellcheck-v${SHELLCHECK_VERSION}.linux.${shellcheck_arch}.tar.gz',
    );
    expect(staticGate).toContainNormalized("sudo install -m 0755 shellcheck /usr/local/bin/shellcheck");
    expect(staticGate).toContainNormalized("run: actionlint -color");
  });

  it("[P2] keeps visual ownership and generic full UI sharding explicit", async () => {
    const playwrightConfig = await readFile(playwrightConfigPath, "utf8");
    const benchmarkWorkflow = await readFile(uiExtendedMainWorkflowPath, "utf8");
    const fullUi = benchmarkWorkflow.slice(benchmarkWorkflow.indexOf("  ui_full:"));
    const fullUiFiles = [...fullUi.matchAll(/ui\/[a-z0-9-]+\.test\.ts/g)]
      .map(([file]) => file)
      .sort();

    expect(playwrightConfig).toContainNormalized("testIgnore: 'visual-*.test.ts'");
    expect(benchmarkWorkflow).not.toContainNormalized("\n  schedule:");
    expect(benchmarkWorkflow).not.toContainNormalized("layout:");
    expect(benchmarkWorkflow).toContainNormalized("run-ui-group critical-extras");
    expect(benchmarkWorkflow).toContainNormalized("Preserve project-runtime domain artifact");
    expect(benchmarkWorkflow).toContainNormalized("--grep-invert '@merge-extra'");
    expect(benchmarkWorkflow).toContainNormalized("name: project-workspace");
    expect(fullUi).toContainNormalized("fromJSON(needs.p0_runners.outputs.runs_on).ui_hot");
    expect(fullUi).toContainNormalized("shard: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]");
    expect(fullUi).toContainNormalized('OD_PLAYWRIGHT_FULLY_PARALLEL: "1"');
    expect(fullUi).not.toContainNormalized("OD_PLAYWRIGHT_WORKERS");
    expect(fullUi).toContainNormalized("name: Run full UI shard");
    expect(fullUi).toContainNormalized("playwright test -c playwright.config.ts ui --shard=${{ matrix.shard }}/12");
    expect(fullUi).toContainNormalized("name: ui-full-${{ github.run_id }}-shard-${{ matrix.shard }}-of-12");
    expect(fullUi).not.toContainNormalized("matrix.files");
    expect(fullUi).not.toContainNormalized("--grep");
    expect(fullUiFiles).toEqual([]);
  });

  itSkipOnWindows("[P2] resolves CI runner profiles by mode", async () => {
    const python = process.platform === "win32" ? "python" : "python3";
    const defaultProfiles = await runRunners();
    const defaultRunsOn = runnerRunsOn(defaultProfiles);
    expect(runnerDecision(defaultProfiles)).toEqual({ schema_version: 1, mode: "default" });
    expect(Object.keys(defaultRunsOn).sort()).toEqual([
      "control",
      "general_medium",
      "js_hot",
      "ui_hot",
      "visual_hot",
      "windows_tools",
      "workspace_unit",
    ]);
    expect(defaultRunsOn.control).toEqual([
      "self-hosted",
      "Linux",
      "X64",
      "od-persistent-ci",
      "od-ci-hot-poc",
    ]);
    expect(defaultRunsOn.general_medium).toEqual(["ubuntu-24.04"]);
    expect(defaultRunsOn.workspace_unit).toEqual(["ubuntu-24.04"]);
    expect(defaultRunsOn.windows_tools).toEqual(["windows-latest"]);
    expect(defaultRunsOn.js_hot).toEqual(["blacksmith-4vcpu-ubuntu-2404"]);
    expect(defaultRunsOn.ui_hot).toEqual(["blacksmith-4vcpu-ubuntu-2404"]);
    expect(defaultRunsOn.visual_hot).toEqual(["blacksmith-4vcpu-ubuntu-2404"]);
    expect(defaultProfiles).not.toHaveProperty("contabo_control");
    expect(defaultProfiles).not.toHaveProperty("hosted_or_blacksmith");
    expect(defaultProfiles).not.toHaveProperty("blacksmith_default");

    const performanceProfiles = await runRunners("performance");
    const performanceRunsOn = runnerRunsOn(performanceProfiles);
    expect(runnerDecision(performanceProfiles)).toEqual({ schema_version: 1, mode: "performance" });
    expect(performanceRunsOn.control).toEqual(["ubuntu-24.04"]);
    expect(performanceRunsOn.general_medium).toEqual(["blacksmith-4vcpu-ubuntu-2404"]);
    expect(performanceRunsOn.workspace_unit).toEqual(["ubuntu-24.04"]);
    expect(performanceRunsOn.windows_tools).toEqual(["windows-latest"]);
    expect(performanceRunsOn.js_hot).toEqual(["blacksmith-4vcpu-ubuntu-2404"]);
    expect(performanceRunsOn.ui_hot).toEqual(["blacksmith-4vcpu-ubuntu-2404"]);
    expect(performanceRunsOn.visual_hot).toEqual(["blacksmith-4vcpu-ubuntu-2404"]);

    const economicProfiles = await runRunners("economic");
    const economicRunsOn = runnerRunsOn(economicProfiles);
    expect(runnerDecision(economicProfiles)).toEqual({ schema_version: 1, mode: "economic" });
    expect(economicRunsOn.control).toEqual(["ubuntu-24.04"]);
    expect(economicRunsOn.general_medium).toEqual(["ubuntu-24.04"]);
    expect(economicRunsOn.workspace_unit).toEqual(["ubuntu-24.04"]);
    expect(economicRunsOn.windows_tools).toEqual(["windows-latest"]);
    expect(economicRunsOn.js_hot).toEqual(["ubuntu-24.04"]);
    expect(economicRunsOn.ui_hot).toEqual(["ubuntu-24.04"]);
    expect(economicRunsOn.visual_hot).toEqual(["ubuntu-24.04"]);
  });

  it("[P2] routes CI follow-ons through generic handoff workflows", async () => {
    const [ciWorkflow, commentWorkflow, autofixWorkflow, reportWorkflow, handoffScript] = await Promise.all([
      readFile(ciWorkflowPath, "utf8"),
      readFile(commentWorkflowPath, "utf8"),
      readFile(autofixWorkflowPath, "utf8"),
      readFile(reportWorkflowPath, "utf8"),
      readFile(handoffScriptPath, "utf8"),
    ]);

    // Core ci still produces comment + report handoffs (needs-validation, visual).
    // Packaging hash autofix left core ci with nix — no ci-produced autofix handoffs for now.
    expect(ciWorkflow).toContainNormalized("handoff.py dir comment");
    expect(ciWorkflow).toContainNormalized("handoff.py dir report");
    expect(ciWorkflow).toContainNormalized("handoff-comment-");
    expect(ciWorkflow).toContainNormalized("handoff-report-");
    expect(ciWorkflow).not.toContainNormalized("handoff.py dir autofix");
    expect(ciWorkflow).not.toContainNormalized("handoff-autofix-");
    expect(ciWorkflow).not.toContainNormalized("nix-hash-autofix");
    expect(ciWorkflow).not.toContainNormalized("visual-pr-comment");
    expect(commentWorkflow).toContainNormalized("artifact-pattern comment");
    expect(commentWorkflow).toContainNormalized("merge-multiple: false");
    expect(commentWorkflow).toContainNormalized("pull-requests: write");
    // Atom capability remains available for future producers; it is not required to be fed by ci.
    expect(autofixWorkflow).toContainNormalized("artifact-pattern autofix");
    expect(autofixWorkflow).toContainNormalized("allowed_paths");
    expect(reportWorkflow).toContainNormalized("artifact-pattern report");
    expect(reportWorkflow).toContainNormalized("scripts/visual-report.ts compare-pr");
    expect(reportWorkflow).toContainNormalized("R2_ACCESS_KEY_ID");
    expect(reportWorkflow).toContainNormalized("pull-requests: write");
    expect(reportWorkflow).toContainNormalized("Visual report comment creation failed");
    expect(reportWorkflow).toContainNormalized("jq -n --rawfile body");
    expect(reportWorkflow).toContainNormalized("--input");
    expect(reportWorkflow).not.toContainNormalized("handoff.py dir comment");
    expect(reportWorkflow).not.toContainNormalized("handoff-comment-");
    expect(handoffScript).toContainNormalized("def self_check()");
    expect(handoffScript).toContainNormalized('"report"');

    for (const workflow of [commentWorkflow, autofixWorkflow]) {
      expect(workflow).toContainNormalized("python3 .github/scripts/handoff.py self-check");
      expect(workflow).toContainNormalized("github.event.workflow_run.event == 'pull_request'");
      expect(workflow).not.toContainNormalized("nix/pnpm-deps.nix");
      expect(workflow).not.toContainNormalized("visual-report");
    }
    expect(reportWorkflow).toContainNormalized("python3 .github/scripts/handoff.py self-check");
    expect(reportWorkflow).toContainNormalized("github.event.workflow_run.event == 'pull_request'");

    expect(commentWorkflow).toContainNormalized("jq -n --rawfile body");
    expect(commentWorkflow).toContainNormalized("--input");
    for (const workflow of [commentWorkflow]) {
      expect(workflow).toContainNormalized("jq -n --rawfile body");
      expect(workflow).toContainNormalized("--input");
      expect(workflow).not.toContainNormalized("--field body=\"$(cat");
      expect(workflow).not.toContainNormalized("--field \"body=$(cat");
    }
  });

  it("[P2] keeps pull-request plugin preview baking secretless and read-only", async () => {
    const [prWorkflow, postMergeWorkflow] = await Promise.all([
      readFile(bakePluginPreviewsPrWorkflowPath, "utf8"),
      readFile(bakePluginPreviewsWorkflowPath, "utf8"),
    ]);

    expect(prWorkflow).toContainNormalized("permissions:\n  contents: read");
    expect(prWorkflow).toContainNormalized("Checkout PR head");
    expect(prWorkflow).toContainNormalized("ref: ${{ github.event.pull_request.head.sha }}");
    expect(prWorkflow).toContainNormalized("upload: 'false'");
    expect(prWorkflow).toContainNormalized("post-merge bake will publish clips and open the rolling manifest PR");
    expect(prWorkflow).not.toContainNormalized("contents: write");
    expect(prWorkflow).not.toContainNormalized("PREVIEW_BAKE_TOKEN");
    expect(prWorkflow).not.toContainNormalized("CLOUDFLARE_R2_REPOSITORY_ASSETS");
    expect(prWorkflow).not.toContainNormalized("git push");

    expect(postMergeWorkflow).toContainNormalized("permissions:\n  contents: write");
    expect(postMergeWorkflow).toContainNormalized("CLOUDFLARE_R2_REPOSITORY_ASSETS_AK");
    // The write-capable credential the PR path lacks lives here post-merge. The rolling manifest PR
    // is now authored with the release-bot App (so its push triggers CI and the auto-merge reactor
    // can act), replacing the never-configured PREVIEW_BAKE_TOKEN fallback.
    expect(postMergeWorkflow).toContainNormalized("secrets.RELEASE_BOT_APP_ID");
    expect(postMergeWorkflow).not.toContainNormalized("PREVIEW_BAKE_TOKEN");
  });

  it("[P2] preserves beta linux AppImage smoke reports for platform publication", async () => {
    const workflow = await readFile(releaseBetaWorkflowPath, "utf8");
    const linuxBuildStep = workflow.match(/- name: Build beta linux_x64\r?\n(?:.+\r?\n)+?(?=\r?\n      - name: Write linux_x64 release report)/m);
    expect(linuxBuildStep?.[0]).toBeDefined();
    expect(linuxBuildStep?.[0]).toContainNormalized("RELEASE_TARGET: linux_x64");
    expect(linuxBuildStep?.[0]).toContainNormalized("RELEASE_REPORT_DIR: ${{ runner.temp }}/release-report/linux_x64");
    expect(linuxBuildStep?.[0]).toContainNormalized("bash tools/release/scripts/build-platform.sh");
    expect(workflow).toContainNormalized("Write linux_x64 release report");
    expect(workflow).toContainNormalized("RELEASE_REPORT_JSON_PATH: ${{ runner.temp }}/release-report/linux_x64/report.json");
    expect(workflow).toContainNormalized("Prepare linux_x64 assets");
    expect(workflow).toContainNormalized("Publish linux_x64 platform");
    expect(workflow).toContainNormalized("Upload linux_x64 publish manifest");
    expect(workflow).toContainNormalized("open-design-beta-linux-x64-publish-manifest");
    expect(workflow).toContainNormalized("Download linux_x64 publish manifest");
    expect(workflow).not.toContainNormalized(".github/scripts/release/assets/linux.sh");
    expect(workflow).not.toContainNormalized(".github/scripts/release/r2/publish-platform.ts");
  });

  it("[P2] preserves stable linux AppImage smoke reports for release publication", async () => {
    const workflow = await readFile(releaseStableWorkflowPath, "utf8");
    const linuxBuildStep = workflow.match(
      /- name: Build release linux artifacts\r?\n(?:.+\r?\n)+?(?=\r?\n      - name: Smoke release linux AppImage runtime)/m,
    );
    expect(linuxBuildStep?.[0]).toBeDefined();
    expect(linuxBuildStep?.[0]).toContainNormalized(
      'node -e \'const fs = require("node:fs"); JSON.parse(fs.readFileSync(process.argv[1], "utf8"));\' "$build_json_path"',
    );
    expect(workflow).toContainNormalized("Smoke release linux AppImage runtime");
    expect(workflow).toContainNormalized("manifest.json");
    expect(workflow).toContainNormalized("tools-pack.json");
    expect(workflow).toContainNormalized("Upload linux e2e spec report");
    expect(workflow).toContainNormalized("open-design-release-linux-e2e-report");
    expect(workflow).toContainNormalized("Download linux e2e spec report");
    expectReleaseLinuxBuildPreservesEvidence(workflow, "Build release linux artifacts");
    expectReleaseLinuxSmokePreservesEvidenceBeforeApt(workflow, "Smoke release linux AppImage runtime");
  });

  it("[P2] keeps release namespaces aligned with release channels", async () => {
    const [releaseStableWorkflow, releaseStableScript, releasePreviewWorkflow, releasePrereleaseWorkflow, releaseBetaWorkflow] = await Promise.all([
      readFile(releaseStableWorkflowPath, "utf8"),
      readFile(releaseStableScriptPath, "utf8"),
      readFile(releasePreviewWorkflowPath, "utf8"),
      readFile(releasePrereleaseWorkflowPath, "utf8"),
      readFile(releaseBetaWorkflowPath, "utf8"),
    ]);

    expect(releaseStableScript).toContainNormalized('mac: releaseNamespace(channel, "mac"),');
    expect(releaseStableScript).toContainNormalized('setOutput("namespace", namespaces.mac);');
    expect(releaseStableScript).toContainNormalized('setOutput("mac_intel_namespace", namespaces.macIntel);');
    expect(releaseStableScript).toContainNormalized('setOutput("win_namespace", namespaces.win);');
    expect(releaseStableScript).toContainNormalized('setOutput("linux_namespace", namespaces.linux);');

    expect(releaseStableWorkflow).toContainNormalized("namespace: ${{ steps.stable.outputs.namespace }}");
    expect(releaseStableWorkflow).toContainNormalized("mac_intel_namespace: ${{ steps.stable.outputs.mac_intel_namespace }}");
    expect(releaseStableWorkflow).toContainNormalized("win_namespace: ${{ steps.stable.outputs.win_namespace }}");
    expect(releaseStableWorkflow).toContainNormalized("linux_namespace: ${{ steps.stable.outputs.linux_namespace }}");
    expect(releaseStableWorkflow).toContainNormalized('--namespace "${{ needs.metadata.outputs.namespace }}"');
    expect(releaseStableWorkflow).toContainNormalized("OD_PACKAGED_E2E_NAMESPACE: ${{ needs.metadata.outputs.namespace }}");
    expect(releaseStableWorkflow).toContainNormalized('"--namespace", "${{ needs.metadata.outputs.win_namespace }}",');
    expect(releaseStableWorkflow).toContainNormalized('OD_PACKAGED_E2E_NAMESPACE: ${{ needs.metadata.outputs.win_namespace }}');
    expect(releaseStableWorkflow).toContainNormalized('--namespace "${{ needs.metadata.outputs.linux_namespace }}"');
    expect(releaseStableWorkflow).toContainNormalized('"namespace": "${{ needs.metadata.outputs.linux_namespace }}",');
    expect(releaseStableWorkflow).not.toMatch(/--namespace release-stable(?:-intel|-win|-linux)?\b/);
    expect(releaseStableWorkflow).not.toMatch(/OD_PACKAGED_E2E_NAMESPACE: release-stable(?:-win|-linux)?\b/);
    expect(releaseStableWorkflow).not.toMatch(/namespaces\/release-stable(?:-intel|-win|-linux)?\b/);

    expectChannelWorkflowNamespaces(releasePreviewWorkflow, "preview", { hasLinuxSmoke: false });
    expectChannelWorkflowNamespaces(releasePrereleaseWorkflow, "prerelease", { hasLinuxSmoke: false });
    expect(releaseBetaWorkflow).toContainNormalized("RELEASE_NAMESPACE: release-beta");
    expect(releaseBetaWorkflow).toContainNormalized("RELEASE_NAMESPACE: release-beta-win");
    expect(releaseBetaWorkflow).toContainNormalized("RELEASE_NAMESPACE: release-beta-x64");
    expect(releaseBetaWorkflow).toContainNormalized("RELEASE_NAMESPACE: release-beta-linux");
    expect(releaseBetaWorkflow).toContainNormalized("RELEASE_TARGET: mac_arm64");
    expect(releaseBetaWorkflow).toContainNormalized("RELEASE_TARGET: win_x64");
    expect(releaseBetaWorkflow).toContainNormalized("RELEASE_TARGET: mac_x64");
    expect(releaseBetaWorkflow).toContainNormalized("RELEASE_TARGET: linux_x64");
    expect(releaseBetaWorkflow).toContainNormalized("OD_PACKAGED_E2E_MAC_UPDATE_FIXTURE: ${{ inputs.mac_arm64_smoke_mode == 'full' && inputs.mac_arm64_update_metadata_url == '' && inputs.mac_arm64_update_target_version == '' && 'tools-serve' || '' }}");
    const betaWinJob = sectionBetween(releaseBetaWorkflow, "  build_win_x64:", "  build_linux_x64:");
    expect(betaWinJob).not.toContainNormalized("tools\\release\\scripts\\build-platform.ps1");
    expect(betaWinJob).toContainNormalized("uses: actions/cache/restore@v5");
    expect(betaWinJob).toContainNormalized("uses: actions/cache/save@v5");
    expect(betaWinJob).toContainNormalized("tools-pack-win-v1-beta-$env:RUNNER_OS-");
    expect(betaWinJob).toContainNormalized('"tools-pack", "win", "build"');
    expect(betaWinJob).toContainNormalized("tools-pack win validate-payload");
    expect(betaWinJob).toContainNormalized("pnpm exec tsx scripts/release-smoke.ts win specs/win.spec.ts");
    const betaBuildScript = await readFile(releaseBetaPosixBuildScriptPath, "utf8");
    expect(betaBuildScript).toContainNormalized("required RELEASE_CHANNEL");
    expect(betaBuildScript).toContainNormalized('release_channel="$RELEASE_CHANNEL"');
    expect(betaBuildScript).not.toContainNormalized('RELEASE_CHANNEL:-beta');
    expect(betaBuildScript).toContainNormalized('OD_PACKAGED_E2E_RELEASE_CHANNEL="$release_channel"');
    expect(betaBuildScript).toContainNormalized('OD_PACKAGED_E2E_RELEASE_VERSION="$RELEASE_VERSION"');
    expect(betaBuildScript).toContainNormalized('OD_PACKAGED_E2E_MAC_UPDATE_FIXTURE="${update_build_json_path:+tools-serve}"');
    const betaWindowsBuildScript = await readFile(releaseBetaWindowsBuildScriptPath, "utf8");
    expect(betaWindowsBuildScript).toContainNormalized('throw "RELEASE_CHANNEL is required"');
    expect(betaWindowsBuildScript).not.toContainNormalized('"beta" } else { $env:RELEASE_CHANNEL }');
    expect(betaWindowsBuildScript).toContainNormalized('Test-JsonString $manifest.channel "channel" $ReleaseChannel');
    expect(betaWindowsBuildScript).toContainNormalized('channel = $ReleaseChannel');
    expect(betaWindowsBuildScript).toContainNormalized('$env:OD_PACKAGED_E2E_RELEASE_CHANNEL = $ReleaseChannel');
    expect(betaWindowsBuildScript).toContainNormalized('$env:OD_PACKAGED_E2E_WIN_UPDATE_FIXTURE = "tools-serve"');

    expectWindowsUpdaterSmokeContract(releaseBetaWorkflow, "beta");
    expectWindowsUpdaterSmokeContract(releasePreviewWorkflow, "preview");
    expectWindowsUpdaterSmokeContract(releasePrereleaseWorkflow, "prerelease");
    expectWindowsUpdaterSmokeContract(releaseStableWorkflow, "stable");
  });

  it("[P2] prerelease publishes github.commit so its changelog has a baseline", async () => {
    // The Feishu release card computes its changelog as `git log <previous>..<current>`,
    // where <previous> is read from prerelease/latest/metadata.json's `.github.commit`
    // (notify-release-feishu.yml). That field is written by githubInfo() from the
    // RELEASE_COMMIT env. release-beta sets RELEASE_COMMIT on every build + publish job,
    // but release-prerelease historically set it on none, so every prerelease published an
    // empty github.commit and the card could never diff against the prior prerelease
    // ("首个 Prerelease 包"). Require RELEASE_COMMIT on the prerelease build + publish jobs
    // so the per-platform manifests and the final metadata.json carry the built commit and
    // stay mutually consistent (publish-metadata rejects a manifest whose commit disagrees).
    const [prereleaseWorkflow, betaWorkflow] = await Promise.all([
      readFile(releasePrereleaseWorkflowPath, "utf8"),
      readFile(releaseBetaWorkflowPath, "utf8"),
    ]);

    const releaseCommitEnv = "RELEASE_COMMIT: ${{ needs.metadata.outputs.commit }}";
    // Beta is the working reference that already populates the commit.
    expect(betaWorkflow).toContainNormalized(releaseCommitEnv);

    const jobBounds: Array<[string, string]> = [
      ["  build_mac:", "  build_mac_intel:"],
      ["  build_mac_intel:", "  build_win:"],
      ["  build_win:", "  build_linux:"],
      ["  build_linux:", "  publish:"],
      ["  publish:", "  cleanup_partial_release_assets:"],
    ];
    for (const [start, end] of jobBounds) {
      expect(sectionBetween(prereleaseWorkflow, start, end)).toContainNormalized(releaseCommitEnv);
    }
  });

  it("[P2] keeps counted release workflow calls on a consistent ref and output contract", async () => {
    const [previewWorkflow, prereleaseWorkflow, previewScript] = await Promise.all([
      readFile(releasePreviewWorkflowPath, "utf8"),
      readFile(releasePrereleaseWorkflowPath, "utf8"),
      readFile(releasePreviewScriptPath, "utf8"),
    ]);

    expectCountedReleaseWorkflowCallContract(previewWorkflow, "preview");
    expectCountedReleaseWorkflowCallContract(prereleaseWorkflow, "prerelease");

    expect(previewWorkflow).toContainNormalized("OPEN_DESIGN_PREVIEW_VERSION: ${{ inputs.release_version }}");
    expect(previewWorkflow).toContainNormalized("Empty uses preview/vX.Y.Z when present, otherwise apps/packaged/package.json.");
    expect(previewScript).toContainNormalized("function resolvePreviewBaseVersion");
    expect(previewScript).toContainNormalized('source: "apps/packaged/package.json"');
    expect(previewScript).not.toContainNormalized("release-preview can only run from preview/vX.Y.Z branches");

    expect(prereleaseWorkflow).toContainNormalized("OPEN_DESIGN_STABLE_VERSION: ${{ inputs.release_version }}");
    expect(prereleaseWorkflow).toContainNormalized("Required when ref is not release/vX.Y.Z");
  });

  it("[P2] publishes release notes through one channel-neutral tools-release pipeline", async () => {
    const workflows = await Promise.all([
      readFile(releaseBetaWorkflowPath, "utf8"),
      readFile(releaseBetaSelfHostedWorkflowPath, "utf8"),
      readFile(releasePrereleaseWorkflowPath, "utf8"),
      readFile(releasePreviewWorkflowPath, "utf8"),
      readFile(releaseStableWorkflowPath, "utf8"),
    ]);

    for (const workflow of workflows) {
      expect(workflow).toContainNormalized("tools-release prepare-release-note");
      expect(workflow).toContainNormalized("tools-release publish-release-note");
      expect(workflow).toContainNormalized("tools-release verify-release-note");
      expect(workflow).toContainNormalized("RELEASE_NOTE_MANIFEST_PATH:");
      expect(workflow.indexOf("tools-release prepare-release-note")).toBeLessThan(
        workflow.indexOf("tools-release publish-release-note"),
      );
      expect(workflow.indexOf("tools-release publish-release-note")).toBeLessThan(
        workflow.indexOf("tools-release verify-release-note"),
      );
      expect(workflow.indexOf("tools-release verify-release-note")).toBeLessThan(
        workflow.indexOf("tools-release publish-metadata"),
      );
    }

    const stableWorkflow = workflows[4] ?? "";
    expect(stableWorkflow).toContainNormalized("Validate stable release note policy");
    expect(stableWorkflow).toContainNormalized(
      "RELEASE_PUBLISH_SIDE_EFFECTS: ${{ needs.metadata.outputs.publish_side_effects_enabled }}",
    );
  });

  it("[P2] requires stable release dispatch to use the release version branch", async () => {
    const [workflow, script] = await Promise.all([
      readFile(releaseStableWorkflowPath, "utf8"),
      readFile(releaseStableScriptPath, "utf8"),
    ]);

    expect(workflow).not.toContainNormalized("OPEN_DESIGN_STABLE_VERSION:");
    expect(workflow).not.toContainNormalized("inputs.release_version");
    expect(workflow).toContainNormalized("Stable release branch to build, for example release/v0.5.1.");

    expect(script).toContainNormalized("const stableReleaseBranchPattern = /^release\\/v(\\d+\\.\\d+\\.\\d+)$/;");
    expect(script).toContainNormalized("function resolveStableBaseVersion");
    expect(script).toContainNormalized("release-stable requires GITHUB_REF_NAME to be release/vX.Y.Z");
    expect(script).toContainNormalized("function resolvePrereleaseBaseVersion");
    expect(script).toContainNormalized(
      '${stableBaseVersion.source ?? "release base"} version ${stableBaseVersion.value} must match apps/packaged/package.json version',
    );
  });

  it("[P2] rejects stable release runs without the release version branch", async () => {
    const output = await runReleaseStableForFailure({
      GITHUB_REF_NAME: "main",
      OPEN_DESIGN_STABLE_VERSION: "",
    });

    expect(output).toContainNormalized("release-stable requires GITHUB_REF_NAME to be release/vX.Y.Z; got main");
  });

  it("[P2] ignores explicit stable version inputs in favor of the release branch gate", async () => {
    const output = await runReleaseStableForFailure({
      GITHUB_REF_NAME: "main",
      OPEN_DESIGN_STABLE_VERSION: "0.10.1",
    });

    expect(output).toContainNormalized("release-stable requires GITHUB_REF_NAME to be release/vX.Y.Z; got main");
  });

  it("[P2] reads beta metadata.json written with releaseVersion/releaseNumber field names", async () => {
    // The unified publisher refactor (.github/workflow/scripts/release/storage)
    // and the in-flight tools-release rewrite stamp beta/latest/metadata.json
    // with generic releaseVersion/releaseNumber fields instead of the legacy
    // betaVersion/betaNumber. tools-release's daily-beta reader must accept
    // those aliases or the scheduled build dies at metadata time.
    const packagedVersion = JSON.parse(
      await readFile(join(workspaceRoot, "apps", "packaged", "package.json"), "utf8"),
    ).version as string;

    const objects: Record<string, unknown> = {
      "stable/latest/metadata.json": { channel: "stable", stableVersion: "0.0.1" },
      "beta/latest/metadata.json": {
        baseVersion: packagedVersion,
        channel: "beta",
        releaseNumber: 4,
        releaseVersion: `${packagedVersion}-beta.4`,
      },
    };
    const fixture = await startStablePrereleaseMetadataServer(objects);
    const runnerTemp = await mkdtemp(join(tmpdir(), "od-release-beta-reader-"));
    const outputPath = join(runnerTemp, "outputs.txt");

    try {
      const result = await execFileAsync(process.execPath, ["--experimental-strip-types", releaseBetaScriptPath], {
        cwd: workspaceRoot,
        env: {
          ...process.env,
          GITHUB_OUTPUT: outputPath,
          GITHUB_REF_NAME: "main",
          GITHUB_SHA: "0123456789abcdef0123456789abcdef01234567",
          NODE_TLS_REJECT_UNAUTHORIZED: "0",
          OPEN_DESIGN_BETA_METADATA_URL: `${fixture.origin}/beta/latest/metadata.json`,
          OPEN_DESIGN_STABLE_METADATA_URL: `${fixture.origin}/stable/latest/metadata.json`,
        },
        maxBuffer: 1024 * 1024,
      });

      expect(result.stdout).toContainNormalized(`[release-beta] beta version: ${packagedVersion}-beta.5`);
      const outputs = await readFile(outputPath, "utf8");
      expect(outputs).toContainNormalized(`beta_version=${packagedVersion}-beta.5`);
    } finally {
      await fixture.close();
      await rm(runnerTemp, { force: true, recursive: true });
    }
  });

  it("[P2] daily beta resolve defaults to main and preserves the ref override", async () => {
    // Beta is the daily R&D channel and must track the development tip (main).
    // Selecting the highest-semver release/vX.Y.Z branch stalls the build: once
    // that branch ships stable, its base version equals the latest stable and
    // release-beta's strictly-greater-than-stable guard rejects every run until
    // someone hand-bumps the retired branch. main always leads stable, so it
    // never hits that trap.
    //
    // Scope every assertion to the resolve job so a refactor elsewhere in the
    // workflow cannot keep this green while changing the build-ref control flow,
    // and prove both branches of that control flow: the empty-input default
    // builds main, and the workflow_dispatch override is still propagated.
    const workflow = await readFile(notifyDailyFeishuWorkflowPath, "utf8");
    const resolveJob = sectionBetween(workflow, "  resolve:", "\n  build:");
    // Override path: workflow_dispatch ref is wired in and forwarded verbatim.
    expect(resolveJob).toContainNormalized("OVERRIDE_REF: ${{ inputs.ref }}");
    expect(resolveJob).toContainNormalized('echo "ref=$OVERRIDE_REF" >> "$GITHUB_OUTPUT"');
    // Default path: an empty input builds main, never a release branch.
    expect(resolveJob).toContainNormalized('echo "ref=main" >> "$GITHUB_OUTPUT"');
    expect(resolveJob).not.toContainNormalized("refs/heads/release/v*");
  });

  it("[P2] gates the Thursday patch cut on the Tuesday minor being published", async () => {
    // cut-patch-release is the Tuesday cut-release flow, one weekday later, with a
    // PATCH bump and a publish guard. Lock the three properties that make it safe:
    //   1. It fires Thursday and bumps patch (not minor) from the highest release branch.
    //   2. It only cuts when this line's minor base X.Y.0 is a PUBLISHED stable
    //      GitHub Release (non-draft, non-prerelease) — otherwise it must NOT create
    //      a branch or build; it posts a Feishu notice and stops.
    //   3. The happy path still cuts from main and pushes with the App token, so the
    //      existing notify-release-feishu push trigger produces the prerelease + card.
    const [workflow, notice] = await Promise.all([
      readFile(cutPatchReleaseWorkflowPath, "utf8").then((c) => c.replace(/\r\n/g, "\n")),
      readFile(feishuNoticeScriptPath, "utf8").then((c) => c.replace(/\r\n/g, "\n")),
    ]);

    // Thursday cron, and a patch (not minor) bump.
    const trigger = sectionBetween(workflow, "on:", "\npermissions:");
    expect(trigger).toContainNormalized("cron: '0 1 * * 4'");
    expect(workflow).toContainNormalized('V="${major}.${minor}.$((patch+1))"');
    expect(workflow).not.toContainNormalized("minor+1");

    // The guard target (MINOR_BASE) must derive from the FINAL version V, not from
    // the highest branch — otherwise a manual `version=` on another line is gated
    // against the wrong minor (e.g. version=0.15.1 while latest is 0.14.0 would
    // wrongly check open-design-v0.14.0). Assert V's own major/minor drive it.
    expect(workflow).toContainNormalized('vmajor=${V%%.*}; vrest=${V#*.}; vminor=${vrest%%.*}');
    expect(workflow).toContainNormalized('MINOR_BASE="${vmajor}.${vminor}.0"');
    expect(workflow).not.toContainNormalized('MINOR_BASE="${major}.${minor}.0"');

    // The guard reads the minor base's stable release and requires it published
    // (neither draft nor prerelease); a missing release falls back to not published.
    const guard = sectionBetween(workflow, "- name: Check the Tuesday minor is published", "# ---- Skip path");
    expect(guard).toContainNormalized('gh release view "$MINOR_TAG"');
    expect(guard).toContainNormalized("--jq '(.isDraft or .isPrerelease) | not'");
    expect(guard).toContainNormalized("|| published=false");
    expect(workflow).toContainNormalized('echo "minor_tag=open-design-v$MINOR_BASE"');

    // Skip path: no branch, no build — only the Feishu notice runs, gated on !published.
    const noticeStep = sectionBetween(workflow, "- name: Notify Feishu that the patch cut was skipped", "- name: Stop here when skipping");
    expect(noticeStep).toContainNormalized("if: steps.guard.outputs.published != 'true'");
    expect(noticeStep).toContainNormalized("tools/release/src/notifications/feishu-notice.ts");
    // Every branch-cutting step must be gated on the guard passing: assert the
    // guard `if:` is the line immediately after each step name.
    for (const step of ["Bail out if the branch already exists", "Create branch + bump version + push", "Create backport label"]) {
      expect(workflow).toContainNormalized(`- name: ${step}\n        if: steps.guard.outputs.published == 'true'`);
    }

    // Happy path keeps cut-release's mechanics: cut from main, App-token push.
    expect(workflow).toContainNormalized("ref: main");
    expect(workflow).toContainNormalized("token: ${{ steps.app.outputs.token }}");
    expect(workflow).toContainNormalized('git push origin "$BRANCH"');
    // The version bump is a no-op whenever main already leads stable by this exact
    // patch (apps/packaged == $VERSION), so the release commit MUST tolerate an empty
    // tree — otherwise `git commit` dies on "nothing to commit" and no branch is cut.
    expect(workflow).toContainNormalized('git commit --allow-empty -am "chore(release): v$VERSION"');

    // The notice card is a standalone poster with the same signed-webhook contract.
    expect(notice).toContainNormalized("msg_type: \"interactive\"");
    expect(notice).toContainNormalized('required("NOTICE_TITLE")');
    expect(notice).toContainNormalized('required("NOTICE_BODY")');
  });

  it("[P2] posts an immediate branch-cut Feishu card naming the backport label on both cut workflows", async () => {
    // Cutting a release branch triggers a ~20-40 min prerelease build before the
    // download card lands, so both cut workflows post an eager "branch cut" notice
    // the moment the branch exists. Each must: reuse feishu-notice.ts, run AFTER the
    // branch push + label creation, and name the exact backport label so the team
    // knows which label to apply for backports.
    const [minorCut, patchCut] = await Promise.all([
      readFile(cutReleaseWorkflowPath, "utf8"),
      readFile(cutPatchReleaseWorkflowPath, "utf8"),
    ]);

    for (const [label, workflow, kind] of [
      ["cut-release (minor)", minorCut, "大版本 minor"],
      ["cut-patch-release (patch)", patchCut, "小版本 patch"],
    ] as const) {
      const step = sectionBetween(workflow, "- name: Notify Feishu that the branch was cut", "\n        run:");
      // Same standalone notifier + the shared release webhook/secret.
      expect(workflow, label).toContainNormalized("run: node --experimental-strip-types tools/release/src/notifications/feishu-notice.ts");
      expect(step, label).toContainNormalized("FEISHU_WEBHOOK: ${{ secrets.FEISHU_RELEASE_WEBHOOK }}");
      // Names the version's backport label in the card body.
      expect(step, label).toContainNormalized("backport release/v${{ steps.ver.outputs.version }}");
      // Distinguishes major vs minor cut.
      expect(step, label).toContainNormalized(kind);
      // The eager card must come AFTER the branch is actually cut + pushed.
      expect(workflow.indexOf("- name: Notify Feishu that the branch was cut"), label)
        .toBeGreaterThan(workflow.indexOf('git push origin "$BRANCH"'));
    }
    // The patch workflow's eager card only fires on the happy (published) path.
    const patchNotice = sectionBetween(patchCut, "- name: Notify Feishu that the branch was cut", "\n        run:");
    expect(patchNotice).toContainNormalized("if: steps.guard.outputs.published == 'true'");
  });

  it("[P2] sends the daily landing PR summary to Feishu with staging deployment status", async () => {
    const [workflow, ciWorkflow, stagingWorkflow, productionWorkflow, script] = await Promise.all([
      readFile(landingPageDailyFeishuWorkflowPath, "utf8"),
      readFile(landingPageCiWorkflowPath, "utf8"),
      readFile(landingPageStagingWorkflowPath, "utf8"),
      readFile(landingPageProductionWorkflowPath, "utf8"),
      readFile(landingPageDailyFeishuScriptPath, "utf8"),
    ]);
    const trigger = sectionBetween(workflow, "on:", "\npermissions:");
    const productionCheckout = sectionBetween(productionWorkflow, "- name: Checkout", "- name: Setup pnpm");

    expect(trigger).toContainNormalized('cron: "0 1 * * *"');
    expect(trigger).not.toContainNormalized("lookback_hours:");
    expect(workflow).toContainNormalized("actions: read");
    expect(workflow).toContainNormalized("contents: read");
    expect(workflow).toContainNormalized("pull-requests: read");
    expect(workflow).toContainNormalized("github.ref == 'refs/heads/main'");
    expect(workflow).toContainNormalized("FEISHU_WEBHOOK: ${{ secrets.FEISHU_LANDING_WEBHOOK || secrets.FEISHU_RELEASE_WEBHOOK }}");
    expect(workflow).toContainNormalized("FEISHU_SIGN_SECRET: ${{ secrets.FEISHU_LANDING_SIGN_SECRET || secrets.FEISHU_RELEASE_SIGN_SECRET }}");
    expect(workflow).toContainNormalized("node --experimental-strip-types .github/scripts/landing-page-daily-feishu.ts self-check");
    expect(workflow).toContainNormalized("node --experimental-strip-types .github/scripts/landing-page-daily-feishu.ts");
    expect(workflow).toContainNormalized("ref: main");
    expect(workflow).toContainNormalized("fetch-depth: 0");
    expect(productionCheckout).toContainNormalized("ref: ${{ github.sha }}");
    expect(productionCheckout).not.toContainNormalized("ref: main");
    expect(productionCheckout).toContainNormalized("Verify production checkout commit");
    expect(productionCheckout).toContainNormalized('deployed_sha="$(git rev-parse HEAD)"');
    expect(productionCheckout).toContainNormalized('$deployed_sha" != "$GITHUB_SHA');
    expect(productionCheckout).toContainNormalized('main_sha="$(git ls-remote origin refs/heads/main');
    expect(productionCheckout).toContainNormalized('$GITHUB_SHA" != "$main_sha');
    expect(productionCheckout).toContainNormalized("refusing production deploy for stale workflow SHA");

    // Wrangler Pages ignores custom --config paths. Before every staging
    // migration/deploy, replace the default config with staging's isolated
    // bindings so preview/staging traffic can never touch production KV/D1.
    for (const stagingDeployWorkflow of [ciWorkflow, stagingWorkflow]) {
      expect(stagingDeployWorkflow).toContainNormalized("Prepare staging Pages configuration");
      expect(stagingDeployWorkflow).toContainNormalized("cp apps/landing-page/wrangler.staging.toml apps/landing-page/wrangler.toml");
      expect(stagingDeployWorkflow).toContainNormalized('wranglerVersion: "4.110.0"');
      expect(stagingDeployWorkflow).toContainNormalized("d1 migrations apply open-design-landing-staging-attribution --remote");
      expect(stagingDeployWorkflow).not.toContainNormalized("--config wrangler.staging.toml");
    }
    expect(productionWorkflow).toContainNormalized('wranglerVersion: "4.110.0"');
    expect(productionWorkflow).toContainNormalized("d1 migrations apply open-design-landing-attribution --remote");

    expect(script).toContainNormalized('const STAGING_URL = "https://staging.open-design.ai"');
    expect(script).toContainNormalized('const STAGING_WORKFLOW = "landing-page-staging.yml"');
    expect(script).toContainNormalized('const PRODUCTION_WORKFLOW = "landing-page-production.yml"');
    expect(script).toContainNormalized("type StagingSnapshot");
    expect(script).toContainNormalized("createStagingSnapshot");
    expect(script).toContainNormalized("run_started_at");
    expect(script).toContainNormalized("run_attempt");
    expect(script).toContainNormalized("runOperationalTime");
    expect(script).toContainNormalized("staging: StagingSnapshot");
    expect(script).toContainNormalized("historical staging success not to count as current staging deployment");
    expect(script).toContainNormalized("rerun historical staging success to become current staging deployment");
    expect(script).toContainNormalized("rerun staging header to use the rerun historical deployment");
    expect(script).toContainNormalized("No successful ${PRODUCTION_WORKFLOW} run found on main");
    expect(script).toContainNormalized("正式环境基线");
    expect(script).toContainNormalized("待 QA 验收");
    expect(script).toContainNormalized("git\", [\"merge-base\", \"--is-ancestor\"");
    expect(script).toContainNormalized("已自动部署到当前 staging.open-design.ai");
    expect(script).toContainNormalized("正在部署到 staging.open-design.ai");
    expect(script).toContainNormalized("apps/landing-page/");
    expect(script).toContainNormalized(".github/workflows/landing-page-staging.yml");
  });

  it("[P2] supports stable metadata, prepublish, and publish dispatch modes", async () => {
    const [workflow, script] = await Promise.all([
      readFile(releaseStableWorkflowPath, "utf8"),
      readFile(releaseStableScriptPath, "utf8"),
    ]);

    expect(workflow).toContainNormalized("dry_run:");
    expect(workflow).toContainNormalized(
      "Release mode. metadata stops after promotion metadata; prepublish runs build/smoke/report/plan without publishing; publish performs the stable release.",
    );
    expect(workflow).toContainNormalized("group: open-design-release-stable-${{ inputs.dry_run }}");
    expect(workflow).toContainNormalized("type: choice");
    expect(workflow).toContainNormalized("- metadata");
    expect(workflow).toContainNormalized("- prepublish");
    expect(workflow).toContainNormalized("- publish");
    expect(workflow).toContainNormalized("default: metadata");
    expect(workflow).not.toContainNormalized("inputs.channel");
    expect(workflow).toContainNormalized("OPEN_DESIGN_RELEASE_DRY_RUN: ${{ inputs.dry_run == 'publish' && 'false' || inputs.dry_run }}");
    expect(workflow).toContainNormalized("RELEASE_PUBLIC_ORIGIN: ${{ vars.CLOUDFLARE_R2_RELEASES_PUBLIC_ORIGIN }}");
    expect(workflow).toContainNormalized("run: bash .github/scripts/release/github/stable-notes.sh");
    expect(workflow).toContainNormalized("dry_run: ${{ steps.stable.outputs.dry_run }}");
    expect(workflow).toContainNormalized("dry_run_mode: ${{ steps.stable.outputs.dry_run_mode }}");
    expect(workflow).toContainNormalized("if: ${{ needs.metadata.outputs.run_prepublish_jobs == 'true' }}");
    expect(workflow).toContainNormalized("RELEASE_PUBLISH_SIDE_EFFECTS: ${{ needs.metadata.outputs.publish_side_effects_enabled }}");

    expect(script).toContainNormalized("function parseStableDryRunMode");
    expect(script).toContainNormalized("OPEN_DESIGN_RELEASE_DRY_RUN must be metadata, prepublish, true, or false");
    expect(script).toContainNormalized('setOutput("dry_run", dryRun ? "true" : "false");');
    expect(script).toContainNormalized('setOutput("dry_run_mode", stableDryRunMode);');
    expect(script).toContainNormalized('setOutput("run_prepublish_jobs", runPrepublishJobs ? "true" : "false");');
    expect(script).toContainNormalized('setOutput("publish_side_effects_enabled", publishSideEffectsEnabled ? "true" : "false");');
  });

  it.skipIf(process.platform === "win32")("[P2] writes stable release notes from the release public origin variable", async () => {
    for (const [envName, origin] of [
      ["RELEASE_PUBLIC_ORIGIN", "https://releases.open-design.ai/current/"],
      ["CLOUDFLARE_R2_RELEASES_PUBLIC_ORIGIN", "https://releases.open-design.ai/legacy/"],
    ] as const) {
      const runnerTemp = await mkdtemp(join(tmpdir(), "od-stable-notes-"));
      const outputPath = join(runnerTemp, "github-output.txt");

      try {
        await execFileAsync("bash", [releaseStableNotesScriptPath], {
          cwd: workspaceRoot,
          env: {
            ...process.env,
            BRANCH_NAME: "release/v0.13.0",
            CLOUDFLARE_R2_RELEASES_PUBLIC_ORIGIN: envName === "CLOUDFLARE_R2_RELEASES_PUBLIC_ORIGIN" ? origin : "",
            GITHUB_OUTPUT: outputPath,
            GITHUB_REPOSITORY: "nexu-io/open-design",
            GITHUB_SHA: "0123456789abcdef0123456789abcdef01234567",
            RELEASE_CHANNEL: "stable",
            RELEASE_PUBLIC_ORIGIN: envName === "RELEASE_PUBLIC_ORIGIN" ? origin : "",
            RELEASE_SIGNED: "true",
            RELEASE_VERSION: "0.13.0",
            RUNNER_TEMP: runnerTemp,
            VERSION_TAG: "open-design-v0.13.0",
          },
        });

        const outputs = parseGithubOutput(await readFile(outputPath, "utf8"));
        const notes = await readFile(outputs.notes_file ?? "", "utf8");
        expect(notes).toContainNormalized(`R2 metadata: ${origin.replace(/\/+$/, "")}/stable/latest/metadata.json`);
        expect(notes).toContainNormalized(`E2E report: ${origin.replace(/\/+$/, "")}/stable/versions/0.13.0/report.zip`);
      } finally {
        await rm(runnerTemp, { force: true, recursive: true });
      }
    }
  });

  it("[P2] validates stable dry-run prerelease metadata from a release branch", async () => {
    const baseVersion = await readPackagedVersion();
    const prereleaseVersion = `${baseVersion}-prerelease.12`;
    const objects: Record<string, unknown> = {};
    const fixture = await startStablePrereleaseMetadataServer(objects);
    objects[`prerelease/versions/${prereleaseVersion}/metadata.json`] = stablePrereleaseMetadataFixture(
      baseVersion,
      prereleaseVersion,
      fixture.origin,
    );
    const runnerTemp = await mkdtemp(join(tmpdir(), "od-release-stable-dry-run-"));

    try {
      await mkdir(join(runnerTemp, "bin"), { recursive: true });
      await writeFakeGhBin(join(runnerTemp, "bin"), []);
      const fakePath = `${join(runnerTemp, "bin")}${delimiter}${process.env.PATH ?? ""}`;

      const result = await execFileAsync(process.execPath, ["--experimental-strip-types", releaseStableScriptPath], {
        cwd: workspaceRoot,
        env: {
          ...process.env,
          GITHUB_REF_NAME: `release/v${baseVersion}`,
          GITHUB_REPOSITORY: "nexu-io/open-design",
          GITHUB_SHA: "0123456789abcdef0123456789abcdef01234567",
          NODE_TLS_REJECT_UNAUTHORIZED: "0",
          OPEN_DESIGN_RELEASE_CHANNEL: "stable",
          OPEN_DESIGN_RELEASE_DRY_RUN: "true",
          OPEN_DESIGN_RELEASES_PUBLIC_ORIGIN: fixture.origin,
          OPEN_DESIGN_GH_NODE_SCRIPT: join(runnerTemp, "bin", "gh"),
          OPEN_DESIGN_STABLE_PRERELEASE_VERSION: prereleaseVersion,
          Path: fakePath,
          PATH: fakePath,
        },
      });

      expect(result.stdout).toContainNormalized(`[release-stable] validated prerelease: ${prereleaseVersion}`);
      expect(result.stdout).toContainNormalized("[release-stable] channel: stable");
      expect(result.stdout).toContainNormalized("[release-stable] dry run: true");
      expect(result.stdout).toContainNormalized(`[release-stable] version tag: open-design-v${baseVersion}`);
    } finally {
      await fixture.close();
      await rm(runnerTemp, { force: true, recursive: true });
    }
  });

  it("[P2] rejects invalid release dry-run values before remote checks", async () => {
    const output = await runReleaseStableForFailure({
      GITHUB_REF_NAME: "release/v0.10.0",
      OPEN_DESIGN_RELEASE_DRY_RUN: "maybe",
      OPEN_DESIGN_STABLE_VERSION: "",
    });

    expect(output).toContainNormalized("OPEN_DESIGN_RELEASE_DRY_RUN must be metadata, prepublish, true, or false");
  });

  it("keeps both beta release lanes on the shared payload-aware metadata surface", async () => {
    const [releaseBetaWorkflow, releaseBetaSelfHostedWorkflow, platformPublishScript, publishMetadataScript] = await Promise.all([
      readFile(releaseBetaWorkflowPath, "utf8"),
      readFile(releaseBetaSelfHostedWorkflowPath, "utf8"),
      readFile(releaseBetaPlatformPublishScriptPath, "utf8"),
      readFile(releasePublishMetadataScriptPath, "utf8"),
    ]);

    for (const workflow of [releaseBetaWorkflow, releaseBetaSelfHostedWorkflow]) {
      expect(workflow).toContainNormalized("RELEASE_ARTIFACT_MODE: dmg-and-payload");
      expect(workflow).toContainNormalized("tools-release publish-platform");
      expect(workflow).toContainNormalized("tools-release publish-metadata");
      expect(workflow).toContainNormalized("RELEASE_MANIFEST_DIR:");
    }
    expect(releaseBetaWorkflow).toContainNormalized("RELEASE_ASSET_SUFFIX: ${{ needs.metadata.outputs.asset_version_suffix }}");
    expect(releaseBetaSelfHostedWorkflow).toContainNormalized("RELEASE_ASSET_SUFFIX: auto");
    expect(platformPublishScript).toContainNormalized("artifacts.payload");
    expect(platformPublishScript).toContainNormalized("open-design-${releaseVersion}${assetSuffix}-mac-${arch}-payload.zip");
    expect(platformPublishScript).toContainNormalized("open-design-${releaseVersion}${assetSuffix}-win-x64-payload.7z");
    expect(publishMetadataScript).toContainNormalized("for (const [artifactName, artifact] of Object.entries(manifest.artifacts ?? {}))");
    expect(publishMetadataScript).toContainNormalized("outputs[`${target}_${artifactName}_url`] = artifact.url");
  });

  it("publishes release-betas mac_x64 payloads while preserving the zip feed", async () => {
    const workflow = await readFile(releaseBetaWorkflowPath, "utf8");
    const macX64Job = sectionBetween(workflow, "  build_mac_x64:", "  build_win_x64:");
    const prepareStep = sectionBetween(macX64Job, "      - name: Prepare mac_x64 assets", "      - name: Publish mac_x64 platform");
    const publishStep = sectionBetween(macX64Job, "      - name: Publish mac_x64 platform", "      - name: Upload mac_x64 publish manifest");
    const artifactMode = "RELEASE_ARTIFACT_MODE: ${{ inputs.mac_x64_target == 'all' && 'all' || 'dmg-and-payload' }}";

    expect(prepareStep).toContainNormalized(artifactMode);
    expect(publishStep).toContainNormalized(artifactMode);
  });

  it("keeps the self-hosted beta lane metadata-driven with reusable platform publish scripts", async () => {
    const [workflow, posixBuildScript, windowsBuildScript, platformPublishScript, publishMetadataScript] = await Promise.all([
      readFile(releaseBetaSelfHostedWorkflowPath, "utf8"),
      readFile(releaseBetaPosixBuildScriptPath, "utf8"),
      readFile(releaseBetaWindowsBuildScriptPath, "utf8"),
      readFile(releaseBetaPlatformPublishScriptPath, "utf8"),
      readFile(releasePublishMetadataScriptPath, "utf8"),
    ]);

    expect(workflow).toContainNormalized("enable_win_x64:");
    expect(workflow).toContainNormalized("enable_mac_arm64:");
    expect(workflow).toContainNormalized("enable_mac_x64:");
    expect(workflow).toContainNormalized("enable_linux_x64:");
    expect(workflow).toMatch(/enable_win_x64:[\s\S]*?default: true/);
    expect(workflow).toMatch(/enable_mac_arm64:[\s\S]*?default: true/);
    expect(workflow).toMatch(/publish:[\s\S]*?default: true/);
    expect(workflow).toMatch(/release_public_origin:[\s\S]*?default: "https:\/\/s3\.nexu\.space\/od-releases"/);
    expect(workflow).toContainNormalized("win_x64_smoke_mode:");
    expect(workflow).toContainNormalized("win_x64_target:");
    expect(workflow).toContainNormalized("win_x64_update_metadata_url:");
    expect(workflow).toContainNormalized("win_x64_update_target_version:");
    expect(workflow).toContainNormalized("mac_arm64_sign_mode:");
    expect(workflow).toContainNormalized("mac_arm64_smoke_mode:");
    expect(workflow).toMatch(/win_x64_smoke_mode:[\s\S]*?options:[\s\S]*?- skip[\s\S]*?- core[\s\S]*?- full[\s\S]*?default: core/);
    expect(workflow).toMatch(/mac_arm64_smoke_mode:[\s\S]*?options:[\s\S]*?- skip[\s\S]*?- core[\s\S]*?- full[\s\S]*?default: core/);
    expect(workflow).toMatch(/win_x64_sign_mode:[\s\S]*?options:[\s\S]*?- "off"[\s\S]*?- "on"[\s\S]*?default: "off"/);
    expect(workflow).toMatch(/mac_arm64_sign_mode:[\s\S]*?options:[\s\S]*?- "no"[\s\S]*?- "sign-only"[\s\S]*?- "notarize"[\s\S]*?default: "sign-only"/);
    expect(workflow).not.toContainNormalized("win_enable:");
    expect(workflow).not.toContainNormalized("mac_enable:");
    expect(workflow).not.toMatch(/^      enable_win:/m);
    expect(workflow).not.toMatch(/^      enable_mac:/m);
    expect(workflow).not.toMatch(/^      sign_mode:/m);
    expect(workflow).not.toMatch(/^      smoke_mode:/m);
    expect(workflow).not.toMatch(/^      update_metadata_url:/m);
    expect(workflow).not.toMatch(/^      update_target_version:/m);
    expect(workflow).toContainNormalized("name: Prepare betas metadata");
    expect(workflow).toContainNormalized("OPEN_DESIGN_BETAS_METADATA_URL: ${{ inputs.release_public_origin }}/betas/latest/metadata.json");
    expect(workflow).toContainNormalized("OPEN_DESIGN_STABLE_METADATA_URL: https://releases.open-design.ai/stable/latest/metadata.json");
    expect(workflow).toContainNormalized('repo_dir="$PWD/_release-metadata"');
    expect(workflow).toContainNormalized("--filter=blob:none --depth=1");
    expect(workflow).toContainNormalized("for attempt in 1 2 3");
    expect(workflow).toContainNormalized("working-directory: _release-metadata");
    expect(workflow).toContainNormalized("Install metadata toolchain");
    expect(workflow).toContainNormalized("pnpm install --frozen-lockfile --prefer-offline");
    expect(workflow).toContainNormalized("tools-release prepare betas");
    expect(workflow).not.toContainNormalized('git fetch --force --depth=1 origin "+refs/tags/open-design-v*:refs/tags/open-design-v*"');
    expect(workflow).toContainNormalized("release-beta-s requires at least one target to be enabled");
    expect(workflow).toContainNormalized("release_version: ${{ inputs.publish && steps.reserve.outputs.release_version || inputs.release_version != '' && inputs.release_version || steps.betas.outputs.release_version }}");
    expect(workflow).toContainNormalized("if: ${{ inputs.publish }}");
    expect(workflow).toContainNormalized("Reject unsupported self-hosted mac_x64");
    expect(workflow).toContainNormalized("Reject unsupported self-hosted linux_x64");
    expect(workflow).toContainNormalized("name: Probe Windows signing capability");
    expect(workflow).toContainNormalized("probe-win-signing.ps1");
    expect(workflow).toContainNormalized("needs: metadata");
    expect(workflow).toContainNormalized('-ReleaseTarget win_x64');
    expect(workflow).toContainNormalized('-ReleaseVersion "${{ needs.metadata.outputs.release_version }}"');
    expect(workflow).toContainNormalized('OD_BETA_WINDOWS_SIGNING_ENABLED: ${{ steps.sign_probe.outputs.enabled }}');
    expect(workflow).toContainNormalized('OD_BETA_WINDOWS_SIGNING_PROBED: ${{ steps.sign_probe.outputs.probed }}');
    expect(workflow).toContainNormalized('OD_BETA_WINDOWS_SIGNTOOL_PATH: ${{ steps.sign_probe.outputs.signtool_path }}');
    expect(workflow).toContainNormalized("OD_PACKAGED_E2E_WIN_UPDATE_METADATA_URL: ${{ inputs.win_x64_update_metadata_url }}");
    expect(workflow).toContainNormalized("OD_PACKAGED_E2E_WIN_UPDATE_VERSION: ${{ inputs.win_x64_update_target_version }}");
    expect(windowsBuildScript).toContainNormalized('"pnpm.cmd", "exec", "tools-pack", "win", "build"');
    expect(windowsBuildScript).toContainNormalized('if ($SmokeMode -eq "full" -and -not $hasExternalUpdateMetadata -and -not $hasExternalUpdateArtifactPair)');
    expect(windowsBuildScript).not.toContainNormalized("fnm");
    expect(windowsBuildScript).not.toContainNormalized("RUNNER_TEMP");
    expect(windowsBuildScript).not.toContainNormalized("GITHUB_OUTPUT");
    expect(windowsBuildScript).not.toContainNormalized("GITHUB_STEP_SUMMARY");
    expect(posixBuildScript).toContainNormalized("RELEASE_TARGET");
    expect(posixBuildScript).toContainNormalized("REQUIRE_VELA_CLI");
    expect(posixBuildScript).toContainNormalized('--cache-dir "$TOOLS_PACK_CACHE_DIR"');
    expect(posixBuildScript).not.toContainNormalized("OPEN_DESIGN_RELEASE_PROFILE");
    expect(posixBuildScript).not.toContainNormalized("corepack prepare");
    expect(posixBuildScript).not.toContainNormalized("RUNNER_TEMP");
    expect(workflow).toContainNormalized("Publish win_x64 platform");
    expect(workflow).toContainNormalized("tools-release publish-platform");
    expect(workflow).toContainNormalized("Write win_x64 release report");
    expect(workflow).toContainNormalized("RELEASE_REPORT_DIR: C:\\.tmp\\runner\\od-beta\\win_x64\\release-report\\win_x64");
    expect(posixBuildScript).toContainNormalized('OD_PACKAGED_E2E_MAC_SMOKE_PROFILE="$RELEASE_SMOKE_MODE"');
    expect(workflow).toContainNormalized("runs-on: [self-hosted, macOS, ARM64, nexu-mac, release-beta]");
    expect(workflow).toContainNormalized("path: _release-build");
    expect(workflow).toContainNormalized("working-directory: _release-build");
    expect(workflow).toContainNormalized("fnm exec --using=24 -- bash tools/release/scripts/build-platform.sh");
    expect(workflow).toContainNormalized("MAC_TOOLS_PACK_CACHE_DIR: /Users/runner/.tmp/runner/od-beta/mac_arm64/tools-pack-cache");
    expect(workflow).toContainNormalized("MAC_TOOLS_PACK_DIR: /Users/runner/.tmp/runner/od-beta/mac_arm64/tools-pack");
    expect(workflow).toContainNormalized("TOOLS_PACK_CACHE_DIR: ${{ env.MAC_TOOLS_PACK_CACHE_DIR }}");
    expect(workflow).toContainNormalized("TOOLS_PACK_DIR: ${{ env.MAC_TOOLS_PACK_DIR }}");
    expect(workflow).toContainNormalized("Write mac_arm64 release report");
    expect(workflow).toContainNormalized("fnm exec --using=24 -- pnpm exec tools-release write-report");
    expect(workflow).toContainNormalized("fnm.exe\" exec --using=24 -- pnpm.cmd exec tools-release write-report");
    expect(workflow).toContainNormalized("fnm.exe\" exec --using=24 -- pnpm.cmd exec tools-release publish-platform");
    expect(workflow).toContainNormalized("Prepare mac_arm64 assets");
    expect(workflow).toContainNormalized("RELEASE_TARGET: mac_arm64");
    expect(workflow).toContainNormalized("RELEASE_SIGNED: ${{ (inputs.mac_arm64_delivery_mode == 'internal-updater' || inputs.mac_arm64_sign_mode != 'no') && 'true' || 'false' }}");
    expect(workflow).toContainNormalized("RELEASE_REPORT_ZIP_PATH: ${{ runner.temp }}/release-report/mac_arm64-report.zip");
    expect(workflow).toContainNormalized("name: Publish betas metadata to Nexu S3");
    expect(workflow).toContainNormalized("Upload mac_arm64 publish manifest fallback");
    expect(workflow).toContainNormalized("Upload win_x64 publish manifest fallback");
    expect(workflow).toContainNormalized("Download mac_arm64 publish manifest fallback");
    expect(workflow).toContainNormalized("Download win_x64 publish manifest fallback");
    expect(workflow).toContainNormalized("continue-on-error: true");
    expect(workflow).toContainNormalized("Download mac_arm64 platform manifest");
    expect(workflow).toContainNormalized("Download win_x64 platform manifest");
    expect(workflow).not.toContainNormalized('manifest_url="${RELEASE_PUBLIC_ORIGIN%/}/betas/versions/${RELEASE_VERSION}${RELEASE_ASSET_SUFFIX}/platforms/${RELEASE_TARGET}.json"');
    expect(workflow).not.toContainNormalized('curl -fsSL "$manifest_url" -o "$RELEASE_MANIFEST_DIR/$RELEASE_TARGET.json"');
    expect(workflow).not.toContainNormalized('fallback_manifest="$RELEASE_FALLBACK_MANIFEST_DIR/$RELEASE_TARGET.json"');
    expect(workflow).toContainNormalized("tools-release download-platform-manifest");
    expect(workflow).toContainNormalized("RELEASE_STORAGE_ENDPOINT: ${{ secrets.NEXU_S3_ENDPOINT }}");
    expect(workflow).toContainNormalized("tools-release publish-metadata");
    expect(workflow).toContainNormalized("RELEASE_ASSET_SUFFIX: auto");
    expect(workflow).toContainNormalized("RELEASE_MANIFEST_DIR: ${{ runner.temp }}/release-platform-manifests");
    expect(workflow).toContainNormalized("-IncludeZip $${{ inputs.win_x64_target == 'all' || inputs.win_x64_target == 'zip' }}");
    expect(workflow).toContainNormalized("release-beta-s publish requires win_x64_target=nsis or all");
    expect(workflow).toContainNormalized("open-design-betas-win-x64-publish-manifest");
    expect(workflow).toContainNormalized("open-design-betas-mac-arm64-publish-manifest");
    expect(workflow).toContainNormalized('STATE_SOURCE: ${{ needs.metadata.outputs.state_source }}');
    expect(workflow).not.toContainNormalized("Verify betas metadata");
    expect(workflow).not.toContainNormalized("tools-release verify-metadata");
    expect(workflow).not.toContainNormalized("tools-release summary-metadata");
    expect(workflow).toContainNormalized("release-beta-s publishes to an internal S3 namespace; public metadata fetch verification is intentionally skipped.");
    expect(publishMetadataScript).toContainNormalized("validateManifest");
    expect(publishMetadataScript).toContainNormalized("manifest.releaseVersion !== releaseVersion");
    expect(publishMetadataScript).toContainNormalized("manifest.github?.runId !== currentRunId");
    expect(publishMetadataScript).not.toContainNormalized("manifest.github?.runAttempt !== currentRunAttempt");
    expect(publishMetadataScript).toContainNormalized("manifest.github?.commit !== currentCommit");
    expect(publishMetadataScript).toContainNormalized("manifest.platformKey !== target");
    expect(publishMetadataScript).toContainNormalized("manifest.r2.versionPrefix.includes(`/versions/${releaseVersion}`)");
    expect(publishMetadataScript).toContainNormalized('if (assetVersionSuffix === "auto")');
    expect(publishMetadataScript).toContainNormalized('assetVersionSuffix = allReadyTargetsSigned ? ".signed" : ".unsigned";');
    expect(publishMetadataScript).toContainNormalized("const feedVersionPrefix = manifest.r2?.versionPrefix;");
    expect(publishMetadataScript).toContainNormalized("refusing stale ${def.target} platform manifest");
    expect(publishMetadataScript).toContainNormalized("publishLatestPlatformObjects");
    expect(platformPublishScript).not.toContainNormalized("await upload(join(releaseAssetsDir, name), `${latestPrefix}/${name}`");
    expect(platformPublishScript).not.toContainNormalized("await upload(manifestPath, `${latestPrefix}/platforms/${target}.json`");
    expect(platformPublishScript).toContainNormalized('const target = requiredTarget();');
    expect(platformPublishScript).toContainNormalized("legacyPlatformKey");
    expect(workflow).not.toContainNormalized("win_enable:");
    expect(workflow).not.toContainNormalized("mac_enable:");
    expect(workflow).not.toContainNormalized(".github/scripts/release/build-mac.sh");
    expect(workflow).not.toContainNormalized(".github/scripts/release/r2/publish-platform.ts");
    expect(workflow).not.toContainNormalized("publish-beta-metadata.ps1");
    expect(workflow).not.toContainNormalized("probe-beta-public-read.ps1");
    expect(workflow).not.toContainNormalized("publish-beta.ps1 -IndexPath");
  });

  it("rejects stale latest platform manifests from a previous beta version", async () => {
    const fixture = await startReleaseMetadataObjectStore({});
    const runnerTemp = await mkdtemp(join(tmpdir(), "od-release-betas-metadata-"));
    const platformManifestRoot = join(runnerTemp, "release-platform-manifests");

    try {
      await mkdir(platformManifestRoot, { recursive: true });
      await writeFile(
        join(platformManifestRoot, "mac_arm64.json"),
        `${JSON.stringify(
          {
        artifacts: {
          dmg: {
            url: "https://releases.open-design.ai/betas/versions/1.2.3-beta.3.unsigned/Open Design Beta.dmg",
          },
        },
        channel: "beta",
        github: {
          commit: "current-sha",
          runAttempt: 2,
          runId: 222222222,
        },
        legacyPlatformKey: "mac",
        platformKey: "mac_arm64",
        releaseTarget: "mac_arm64",
        r2: {
          versionPrefix: "beta/versions/1.2.3-beta.3.unsigned",
        },
        releaseVersion: "1.2.3-beta.3",
        signed: false,
        status: "published",
      },
          null,
          2,
        )}\n`,
      );
      const result = await execFileAsync(
        process.execPath,
        ["--experimental-strip-types", releasePublishMetadataScriptPath],
        {
          cwd: workspaceRoot,
          env: {
            ...process.env,
            BASE_VERSION: "1.2.3",
            ENABLE_LINUX_X64: "false",
            ENABLE_MAC_ARM64: "true",
            ENABLE_MAC_X64: "false",
            ENABLE_WIN_X64: "false",
            RELEASE_RUN_ATTEMPT: "2",
            RELEASE_RUN_ID: "222222222",
            RELEASE_COMMIT: "current-sha",
            MAC_ARM64_RESULT: "success",
            RELEASE_CHANNEL: "beta",
            RELEASE_MANIFEST_DIR: platformManifestRoot,
            RELEASE_METADATA_DIR: join(runnerTemp, "release-metadata"),
            RELEASE_OUTPUTS_PATH: join(runnerTemp, "release-metadata", "outputs.json"),
            RELEASE_PUBLIC_ORIGIN: "https://releases.open-design.ai",
            RELEASE_SIGNED: "false",
            RELEASE_STORAGE_ACCESS_KEY_ID: "test-access-key",
            RELEASE_STORAGE_BUCKET: fixture.bucket,
            RELEASE_STORAGE_ENDPOINT: fixture.endpointUrl,
            RELEASE_STORAGE_REGION: "auto",
            RELEASE_STORAGE_SECRET_ACCESS_KEY: "test-secret-key",
            RELEASE_VERSION: "1.2.3-beta.4",
            STATE_SOURCE: "test",
          },
          maxBuffer: 1024 * 1024,
        },
      ).then(
        (value) => ({ status: "fulfilled" as const, value }),
        (reason: unknown) => ({ reason, status: "rejected" as const }),
      );

      expect(result.status).toBe("rejected");
      expect(String(result.status === "rejected" ? result.reason : "")).toContainNormalized(
        "refusing stale mac_arm64 platform manifest for 1.2.3-beta.4: releaseVersion=1.2.3-beta.3",
      );
      expect(fixture.uploadedObjectKeys()).toEqual([]);
    } finally {
      await fixture.close();
      await rm(runnerTemp, { force: true, recursive: true });
    }
  });

  it("rejects stale latest platform manifests from a previous same-version beta workflow run", async () => {
    const fixture = await startReleaseMetadataObjectStore({});
    const runnerTemp = await mkdtemp(join(tmpdir(), "od-release-betas-metadata-"));
    const platformManifestRoot = join(runnerTemp, "release-platform-manifests");

    try {
      await mkdir(platformManifestRoot, { recursive: true });
      await writeFile(
        join(platformManifestRoot, "mac_arm64.json"),
        `${JSON.stringify(
          {
        artifacts: {
          dmg: {
            url: "https://releases.open-design.ai/betas/versions/1.2.3-beta.4.unsigned/Open Design Beta.dmg",
          },
        },
        channel: "beta",
        github: {
          commit: "previous-sha",
          runAttempt: 1,
          runId: 111111111,
        },
        legacyPlatformKey: "mac",
        platformKey: "mac_arm64",
        releaseTarget: "mac_arm64",
        r2: {
          versionPrefix: "beta/versions/1.2.3-beta.4.unsigned",
        },
        releaseVersion: "1.2.3-beta.4",
        signed: false,
        status: "published",
      },
          null,
          2,
        )}\n`,
      );
      const result = await execFileAsync(
        process.execPath,
        ["--experimental-strip-types", releasePublishMetadataScriptPath],
        {
          cwd: workspaceRoot,
          env: {
            ...process.env,
            BASE_VERSION: "1.2.3",
            ENABLE_LINUX_X64: "false",
            ENABLE_MAC_ARM64: "true",
            ENABLE_MAC_X64: "false",
            ENABLE_WIN_X64: "false",
            RELEASE_RUN_ATTEMPT: "2",
            RELEASE_RUN_ID: "222222222",
            RELEASE_COMMIT: "current-sha",
            MAC_ARM64_RESULT: "success",
            RELEASE_CHANNEL: "beta",
            RELEASE_MANIFEST_DIR: platformManifestRoot,
            RELEASE_METADATA_DIR: join(runnerTemp, "release-metadata"),
            RELEASE_OUTPUTS_PATH: join(runnerTemp, "release-metadata", "outputs.json"),
            RELEASE_PUBLIC_ORIGIN: "https://releases.open-design.ai",
            RELEASE_SIGNED: "false",
            RELEASE_STORAGE_ACCESS_KEY_ID: "test-access-key",
            RELEASE_STORAGE_BUCKET: fixture.bucket,
            RELEASE_STORAGE_ENDPOINT: fixture.endpointUrl,
            RELEASE_STORAGE_REGION: "auto",
            RELEASE_STORAGE_SECRET_ACCESS_KEY: "test-secret-key",
            RELEASE_VERSION: "1.2.3-beta.4",
            STATE_SOURCE: "test",
          },
          maxBuffer: 1024 * 1024,
        },
      ).then(
        (value) => ({ status: "fulfilled" as const, value }),
        (reason: unknown) => ({ reason, status: "rejected" as const }),
      );

      expect(result.status).toBe("rejected");
      expect(String(result.status === "rejected" ? result.reason : "")).toContainNormalized(
        "refusing stale mac_arm64 platform manifest for 1.2.3-beta.4: github.runId=111111111",
      );
      expect(fixture.uploadedObjectKeys()).toEqual([]);
    } finally {
      await fixture.close();
      await rm(runnerTemp, { force: true, recursive: true });
    }
  });

  it("accepts same-run latest platform manifests from an older workflow attempt", async () => {
    const fixture = await startReleaseMetadataObjectStore({});
    const runnerTemp = await mkdtemp(join(tmpdir(), "od-release-betas-metadata-"));
    const platformManifestRoot = join(runnerTemp, "release-platform-manifests");

    try {
      await mkdir(platformManifestRoot, { recursive: true });
      await writeFile(
        join(platformManifestRoot, "mac_arm64.json"),
        `${JSON.stringify(
          {
        artifacts: {
          dmg: {
            url: "https://releases.open-design.ai/betas/versions/1.2.3-beta.4.unsigned/Open Design Beta.dmg",
          },
        },
        channel: "beta",
        github: {
          commit: "current-sha",
          runAttempt: 1,
          runId: 222222222,
        },
        legacyPlatformKey: "mac",
        platformKey: "mac_arm64",
        releaseTarget: "mac_arm64",
        r2: {
          versionPrefix: "beta/versions/1.2.3-beta.4.unsigned",
        },
        releaseVersion: "1.2.3-beta.4",
        signed: false,
        status: "published",
      },
          null,
          2,
        )}\n`,
      );
      await execFileAsync(process.execPath, ["--experimental-strip-types", releasePublishMetadataScriptPath], {
        cwd: workspaceRoot,
        env: {
          ...process.env,
          BASE_VERSION: "1.2.3",
          ENABLE_LINUX_X64: "false",
          ENABLE_MAC_ARM64: "true",
          ENABLE_MAC_X64: "false",
          ENABLE_WIN_X64: "false",
          RELEASE_RUN_ATTEMPT: "2",
          RELEASE_RUN_ID: "222222222",
          RELEASE_COMMIT: "current-sha",
          MAC_ARM64_RESULT: "success",
          RELEASE_CHANNEL: "beta",
          RELEASE_MANIFEST_DIR: platformManifestRoot,
          RELEASE_METADATA_DIR: join(runnerTemp, "release-metadata"),
          RELEASE_OUTPUTS_PATH: join(runnerTemp, "release-metadata", "outputs.json"),
          RELEASE_PUBLIC_ORIGIN: "https://releases.open-design.ai",
          RELEASE_SIGNED: "false",
          RELEASE_STORAGE_ACCESS_KEY_ID: "test-access-key",
          RELEASE_STORAGE_BUCKET: fixture.bucket,
          RELEASE_STORAGE_ENDPOINT: fixture.endpointUrl,
          RELEASE_STORAGE_REGION: "auto",
          RELEASE_STORAGE_SECRET_ACCESS_KEY: "test-secret-key",
          RELEASE_VERSION: "1.2.3-beta.4",
          STATE_SOURCE: "test",
        },
        maxBuffer: 1024 * 1024,
      });

      expect(fixture.uploadedObjectKeys()).toEqual([
        "beta/versions/1.2.3-beta.4/metadata.json",
        "beta/latest/metadata.json",
        "beta/latest/platforms/mac_arm64.json",
      ]);
    } finally {
      await fixture.close();
      await rm(runnerTemp, { force: true, recursive: true });
    }
  });

  it("resolves auto asset suffix from target-first win_x64 platform manifests in beta metadata publish", async () => {
    const fixture = await startReleaseMetadataObjectStore({
      "beta/versions/1.2.3-beta.4.unsigned/latest.yml": "versioned updater feed",
    });
    const runnerTemp = await mkdtemp(join(tmpdir(), "od-release-betas-win-metadata-"));
    const platformManifestRoot = join(runnerTemp, "release-platform-manifests");

    try {
      await mkdir(platformManifestRoot, { recursive: true });
      await writeFile(
        join(platformManifestRoot, "win_x64.json"),
        `${JSON.stringify(
          {
            artifacts: {
              installer: {
                url: "https://releases.open-design.ai/betas/versions/1.2.3-beta.4.unsigned/open-design-1.2.3-beta.4.unsigned-win-x64-setup.exe",
              },
            },
            channel: "beta",
            github: {
              commit: "current-sha",
              runAttempt: 2,
              runId: 222222222,
            },
            legacyPlatformKey: "win",
            feed: {
              name: "latest.yml",
              url: "https://releases.open-design.ai/betas/versions/1.2.3-beta.4.unsigned/latest.yml",
            },
            platform: "win",
            platformKey: "win_x64",
            releaseTarget: "win_x64",
            releaseVersion: "1.2.3-beta.4",
            r2: {
              versionPrefix: "beta/versions/1.2.3-beta.4.unsigned",
            },
            signed: false,
            status: "published",
          },
          null,
          2,
        )}\n`,
      );

      await execFileAsync(process.execPath, ["--experimental-strip-types", releasePublishMetadataScriptPath], {
        cwd: workspaceRoot,
        env: {
          ...process.env,
          BASE_VERSION: "1.2.3",
          ENABLE_LINUX_X64: "false",
          ENABLE_MAC_ARM64: "false",
          ENABLE_MAC_X64: "false",
          ENABLE_WIN_X64: "true",
          RELEASE_RUN_ATTEMPT: "2",
          RELEASE_RUN_ID: "222222222",
          RELEASE_COMMIT: "current-sha",
          RELEASE_ASSET_SUFFIX: "auto",
          RELEASE_CHANNEL: "beta",
          RELEASE_MANIFEST_DIR: platformManifestRoot,
          RELEASE_METADATA_DIR: join(runnerTemp, "release-metadata"),
          RELEASE_OUTPUTS_PATH: join(runnerTemp, "release-metadata", "outputs.json"),
          RELEASE_PUBLIC_ORIGIN: "https://releases.open-design.ai",
          RELEASE_SIGNED: "false",
          RELEASE_STORAGE_ACCESS_KEY_ID: "test-access-key",
          RELEASE_STORAGE_BUCKET: fixture.bucket,
          RELEASE_STORAGE_ENDPOINT: fixture.endpointUrl,
          RELEASE_STORAGE_REGION: "auto",
          RELEASE_STORAGE_SECRET_ACCESS_KEY: "test-secret-key",
          RELEASE_VERSION: "1.2.3-beta.4",
          STATE_SOURCE: "test",
          WIN_X64_RESULT: "success",
        },
        maxBuffer: 1024 * 1024,
      });

      const metadata = JSON.parse(await readFile(join(runnerTemp, "release-metadata", "metadata.json"), "utf8"));
      expect(metadata.assetVersionSuffix).toBe(".unsigned");
      expect(metadata.readyTargets).toEqual(["win_x64"]);
      expect(metadata.platforms.win.r2.versionPrefix).toBe("beta/versions/1.2.3-beta.4.unsigned");
      expect(metadata.releaseTargets.win_x64.r2.versionPrefix).toBe("beta/versions/1.2.3-beta.4.unsigned");
      expect(fixture.uploadedObjectKeys()).toEqual([
        "beta/versions/1.2.3-beta.4.unsigned/metadata.json",
        "beta/latest/metadata.json",
        "beta/latest/platforms/win_x64.json",
        "beta/latest/latest.yml",
      ]);
    } finally {
      await fixture.close();
      await rm(runnerTemp, { force: true, recursive: true });
    }
  });

  it("preserves launcher payload artifacts in beta latest metadata and action outputs", async () => {
    const fixture = await startReleaseMetadataObjectStore({
      "beta/versions/1.2.3-beta.4.unsigned/latest.yml": "versioned updater feed",
    });
    const runnerTemp = await mkdtemp(join(tmpdir(), "od-release-betas-payload-metadata-"));
    const platformManifestRoot = join(runnerTemp, "release-platform-manifests");

    try {
      await mkdir(platformManifestRoot, { recursive: true });
      await writeFile(
        join(platformManifestRoot, "mac_arm64.json"),
        `${JSON.stringify(
          {
            artifacts: {
              dmg: {
                url: "https://releases.open-design.ai/betas/versions/1.2.3-beta.4.unsigned/open-design-1.2.3-beta.4.unsigned-mac-arm64.dmg",
              },
              payload: {
                sha256Url: "https://releases.open-design.ai/betas/versions/1.2.3-beta.4.unsigned/open-design-1.2.3-beta.4.unsigned-mac-arm64-payload.zip.sha256",
                url: "https://releases.open-design.ai/betas/versions/1.2.3-beta.4.unsigned/open-design-1.2.3-beta.4.unsigned-mac-arm64-payload.zip",
              },
            },
            channel: "beta",
            github: {
              commit: "current-sha",
              runAttempt: 2,
              runId: 222222222,
            },
            legacyPlatformKey: "mac",
            platform: "mac",
            platformKey: "mac_arm64",
            releaseTarget: "mac_arm64",
            releaseVersion: "1.2.3-beta.4",
            r2: {
              versionPrefix: "beta/versions/1.2.3-beta.4.unsigned",
            },
            signed: false,
            status: "published",
          },
          null,
          2,
        )}\n`,
      );
      await writeFile(
        join(platformManifestRoot, "win_x64.json"),
        `${JSON.stringify(
          {
            artifacts: {
              installer: {
                url: "https://releases.open-design.ai/betas/versions/1.2.3-beta.4.unsigned/open-design-1.2.3-beta.4.unsigned-win-x64-setup.exe",
              },
              payload: {
                sha256Url: "https://releases.open-design.ai/betas/versions/1.2.3-beta.4.unsigned/open-design-1.2.3-beta.4.unsigned-win-x64-payload.7z.sha256",
                url: "https://releases.open-design.ai/betas/versions/1.2.3-beta.4.unsigned/open-design-1.2.3-beta.4.unsigned-win-x64-payload.7z",
              },
            },
            channel: "beta",
            feed: {
              name: "latest.yml",
              url: "https://releases.open-design.ai/betas/versions/1.2.3-beta.4.unsigned/latest.yml",
            },
            github: {
              commit: "current-sha",
              runAttempt: 2,
              runId: 222222222,
            },
            legacyPlatformKey: "win",
            platform: "win",
            platformKey: "win_x64",
            releaseTarget: "win_x64",
            releaseVersion: "1.2.3-beta.4",
            r2: {
              versionPrefix: "beta/versions/1.2.3-beta.4.unsigned",
            },
            signed: false,
            status: "published",
          },
          null,
          2,
        )}\n`,
      );

      await execFileAsync(process.execPath, ["--experimental-strip-types", releasePublishMetadataScriptPath], {
        cwd: workspaceRoot,
        env: {
          ...process.env,
          BASE_VERSION: "1.2.3",
          ENABLE_LINUX_X64: "false",
          ENABLE_MAC_ARM64: "true",
          ENABLE_MAC_X64: "false",
          ENABLE_WIN_X64: "true",
          RELEASE_RUN_ATTEMPT: "2",
          RELEASE_RUN_ID: "222222222",
          RELEASE_COMMIT: "current-sha",
          RELEASE_ASSET_SUFFIX: "auto",
          RELEASE_CHANNEL: "beta",
          RELEASE_MANIFEST_DIR: platformManifestRoot,
          RELEASE_METADATA_DIR: join(runnerTemp, "release-metadata"),
          RELEASE_OUTPUTS_PATH: join(runnerTemp, "release-metadata", "outputs.json"),
          RELEASE_PUBLIC_ORIGIN: "https://releases.open-design.ai",
          RELEASE_SIGNED: "false",
          RELEASE_STORAGE_ACCESS_KEY_ID: "test-access-key",
          RELEASE_STORAGE_BUCKET: fixture.bucket,
          RELEASE_STORAGE_ENDPOINT: fixture.endpointUrl,
          RELEASE_STORAGE_REGION: "auto",
          RELEASE_STORAGE_SECRET_ACCESS_KEY: "test-secret-key",
          RELEASE_VERSION: "1.2.3-beta.4",
          STATE_SOURCE: "test",
          MAC_ARM64_RESULT: "success",
          WIN_X64_RESULT: "success",
        },
        maxBuffer: 1024 * 1024,
      });

      const metadata = JSON.parse(await readFile(join(runnerTemp, "release-metadata", "metadata.json"), "utf8")) as {
        platforms: {
          mac: { artifacts?: { payload?: { sha256Url?: string; url?: string } } };
          win: { artifacts?: { payload?: { sha256Url?: string; url?: string } } };
        };
        releaseTargets: {
          mac_arm64: { artifacts?: { payload?: { sha256Url?: string; url?: string } } };
          win_x64: { artifacts?: { payload?: { sha256Url?: string; url?: string } } };
        };
      };
      const outputs = JSON.parse(await readFile(join(runnerTemp, "release-metadata", "outputs.json"), "utf8")) as Record<string, string>;

      expect(metadata.platforms.mac.artifacts?.payload?.url).toContainNormalized("mac-arm64-payload.zip");
      expect(metadata.platforms.mac.artifacts?.payload?.sha256Url).toContainNormalized("mac-arm64-payload.zip.sha256");
      expect(metadata.platforms.win.artifacts?.payload?.url).toContainNormalized("win-x64-payload.7z");
      expect(metadata.platforms.win.artifacts?.payload?.sha256Url).toContainNormalized("win-x64-payload.7z.sha256");
      expect(metadata.releaseTargets.mac_arm64.artifacts?.payload?.url).toBe(metadata.platforms.mac.artifacts?.payload?.url);
      expect(metadata.releaseTargets.win_x64.artifacts?.payload?.url).toBe(metadata.platforms.win.artifacts?.payload?.url);
      expect(outputs.mac_arm64_payload_url).toBe(metadata.platforms.mac.artifacts?.payload?.url);
      expect(outputs.win_x64_payload_url).toBe(metadata.platforms.win.artifacts?.payload?.url);
      expect(fixture.uploadedObjectKeys()).toEqual([
        "beta/versions/1.2.3-beta.4.unsigned/metadata.json",
        "beta/latest/metadata.json",
        "beta/latest/platforms/mac_arm64.json",
        "beta/latest/platforms/win_x64.json",
        "beta/latest/latest.yml",
      ]);
    } finally {
      await fixture.close();
      await rm(runnerTemp, { force: true, recursive: true });
    }
  });

  it("keeps beta runner bootstrap in workflows instead of release scripts", async () => {
    const [workflow, posixBuildScript, winBuildScript] = await Promise.all([
      readFile(releaseBetaSelfHostedWorkflowPath, "utf8"),
      readFile(releaseBetaPosixBuildScriptPath, "utf8"),
      readFile(releaseBetaWindowsBuildScriptPath, "utf8"),
    ]);

    expect(workflow).toContainNormalized("fnm exec --using=24 -- bash tools/release/scripts/build-platform.sh");
    expect(workflow).toContainNormalized('& "C:\\Users\\runner\\.cargo\\bin\\fnm.exe" exec --using=24 -- pwsh -NoProfile -File tools\\release\\scripts\\build-platform.ps1');
    expect(workflow).toContainNormalized("corepack prepare pnpm@10.33.2 --activate");
    expect(workflow).toContainNormalized('pnpm.cmd install --frozen-lockfile --prefer-offline');
    expect(workflow).toContainNormalized("sudo -n \"$OPEN_DESIGN_MAC_SIGNING_HELPER\" \"$cert_path\" \"$password_path\"");
    expect(workflow).not.toContainNormalized("PATH: /usr/local/libexec/open-design/wrappers:${{ env.PATH }}");
    expect(posixBuildScript).not.toContainNormalized("fnm");
    expect(posixBuildScript).not.toContainNormalized("corepack");
    expect(posixBuildScript).not.toContainNormalized("pnpm install");
    expect(winBuildScript).not.toContainNormalized("fnm");
    expect(winBuildScript).not.toContainNormalized("corepack");
    expect(winBuildScript).not.toContainNormalized("pnpm install");
  });

  it("resolves the generated Windows update fixture outside the measured build child scope", async () => {
    const winBuildScript = await readFile(releaseBetaWindowsBuildScriptPath, "utf8");

    expect(winBuildScript).toMatch(
      /Measure-Step "tools-pack win build update fixture" \{[\s\S]*?\r?\n    \}\r?\n    \$updateBuild = Get-Content -LiteralPath \$fixtureJsonPath -Raw \| ConvertFrom-Json\r?\n    \$localUpdateArtifactPath = \[string\]\$updateBuild\.installerPath/,
    );
    expect(winBuildScript).toContainNormalized('$env:OD_PACKAGED_E2E_WIN_UPDATE_FIXTURE = "tools-serve"');
    expect(winBuildScript).toContainNormalized("$env:OD_PACKAGED_E2E_WIN_UPDATE_ARTIFACT_PATH = $localUpdateArtifactPath");
  });
});

function expectChannelWorkflowNamespaces(
  workflow: string,
  channel: "beta" | "preview" | "prerelease",
  options: { hasLinuxSmoke: boolean },
): void {
  const namespace = `release-${channel}`;
  expect(workflow).toContainNormalized(`--namespace ${namespace}`);
  expect(workflow).toContainNormalized(`OD_PACKAGED_E2E_NAMESPACE: ${namespace}`);
  expect(workflow).toContainNormalized(`--namespace ${namespace}-intel`);
  expect(workflow).toContainNormalized(`"--namespace", "${namespace}-win",`);
  expect(workflow).toContainNormalized(`OD_PACKAGED_E2E_NAMESPACE: ${namespace}-win`);
  expect(workflow).toContainNormalized(`--namespace ${namespace}-linux`);

  if (options.hasLinuxSmoke) {
    expect(workflow).toContainNormalized(`OD_PACKAGED_E2E_NAMESPACE: ${namespace}-linux`);
  }
}

function expectWindowsUpdaterSmokeContract(workflow: string, channel: "beta" | "preview" | "prerelease" | "stable"): void {
  expect(workflow).toContainNormalized("win_x64_smoke_mode:");
  expect(workflow).toContainNormalized("win_x64_update_metadata_url:");
  expect(workflow).toContainNormalized("win_x64_update_target_version:");
  expect(workflow).toMatch(/win_x64_smoke_mode:[\s\S]*?options:[\s\S]*?- skip[\s\S]*?- core[\s\S]*?- full[\s\S]*?default: core/);
  expect(workflow).toContainNormalized("OD_PACKAGED_E2E_WIN_SMOKE_PROFILE: ${{ inputs.win_x64_smoke_mode }}");
  expect(workflow).toContainNormalized("OD_PACKAGED_E2E_WIN_UPDATE_FIXTURE: ${{ inputs.win_x64_smoke_mode == 'full' && inputs.win_x64_update_metadata_url == '' && inputs.win_x64_update_target_version == '' && 'tools-serve' || '' }}");
  expect(workflow).toContainNormalized("OD_PACKAGED_E2E_WIN_UPDATE_METADATA_URL: ${{ inputs.win_x64_update_metadata_url }}");
  expect(workflow).toContainNormalized("OD_PACKAGED_E2E_WIN_UPDATE_VERSION: ${{ inputs.win_x64_update_target_version }}");
  if (channel === "stable") {
    expect(workflow).toContainNormalized("Build stable win_x64 update fixture");
    expect(workflow).toContainNormalized('full Windows stable smoke requires stable version x.y.z');
    expect(workflow).toContainNormalized('pnpm.cmd exec tools-pack win cleanup --dir $toolsPackDir --namespace "${{ needs.metadata.outputs.win_namespace }}" --json');
    expect(workflow).toContainNormalized("--cache-dir $cacheDir `");
    expect(workflow).toContainNormalized('pnpm.cmd exec tools-pack win validate-payload --namespace "${{ needs.metadata.outputs.win_namespace }}" --payload-path $build.payloadPath --expected-version "${{ needs.metadata.outputs.release_version }}" --json');
  } else {
    expect(workflow).toContainNormalized(`Build ${channel} win_x64 update fixture`);
    expect(workflow).toContainNormalized(`full Windows smoke requires a counted ${channel} version`);
  }
  expect(workflow).not.toContainNormalized("OD_PACKAGED_E2E_WIN_SMOKE_PROFILE: core");
}

function expectCountedReleaseWorkflowCallContract(workflow: string, channel: "preview" | "prerelease"): void {
  expect(workflow).toContainNormalized("workflow_dispatch:");
  expect(workflow).toContainNormalized("workflow_call:");
  expect(workflow).toContainNormalized("ref:");
  expect(workflow).toContainNormalized("release_version:");
  expect(workflow).toContainNormalized("description: \"Optional git ref to build.");
  expect(workflow).toContainNormalized("ref: ${{ inputs.ref != '' && inputs.ref || github.ref }}");
  expect(workflow).toContainNormalized("Resolve built commit");
  expect(workflow).toContainNormalized("GITHUB_SHA: ${{ env.BUILT_SHA }}");
  expect(workflow).toContainNormalized("GITHUB_REF_NAME: ${{ inputs.ref != '' && inputs.ref || github.ref_name }}");
  expect(workflow).toContainNormalized(`Capture previous ${channel} commit`);
  expect(workflow).toContainNormalized("previous_commit: ${{ steps.prev.outputs.previous_commit }}");
  expect(workflow).toContainNormalized("version_metadata_url:");
  expect(workflow).toContainNormalized("mac_arm64_url:");
  expect(workflow).toContainNormalized("mac_intel_url:");
  expect(workflow).toContainNormalized("win_url:");
  expect(workflow).toContainNormalized("linux_url:");
  expect(workflow).toContainNormalized("GITHUB_SHA: ${{ needs.metadata.outputs.commit }}");
  expect(workflow).toContainNormalized("version_metadata_url: ${{ steps.outputs.outputs.version_metadata_url }}");
  expect(workflow).toContainNormalized("mac_arm64_url: ${{ steps.outputs.outputs.mac_arm64_dmg_url }}");
  expect(workflow).toContainNormalized("mac_intel_url: ${{ steps.outputs.outputs.mac_x64_dmg_url }}");
  expect(workflow).toContainNormalized("win_url: ${{ steps.outputs.outputs.win_x64_installer_url }}");
  expect(workflow).toContainNormalized("linux_url: ${{ steps.outputs.outputs.linux_x64_appImage_url }}");
}

function expectReleaseLinuxBuildPreservesEvidence(workflow: string, stepName: string): void {
  const step = workflow.match(new RegExp(`- name: ${stepName}\\r?\\n(?:.+\\r?\\n)+?(?=\\r?\\n      - name: Smoke .+ linux AppImage runtime)`, "m"))?.[0];
  expect(step).toBeDefined();
  expect(step).toContainNormalized('report_dir="$RUNNER_TEMP/release-report/linux"');
  expect(step).toContainNormalized('mkdir -p "$report_dir"');
  expect(step).toContainNormalized('build_json_path="$report_dir/tools-pack.json"');
  expect(step).toContainNormalized('build_log_path="$report_dir/tools-pack.log"');
  expect(step).toContainNormalized('printf \'%s\\n\' "$build_output" | tee "$build_json_path"');
}

function expectReleaseLinuxSmokePreservesEvidenceBeforeApt(workflow: string, stepName: string): void {
  const step = workflow.match(new RegExp(`- name: ${stepName}\\r?\\n(?:.+\\r?\\n)+?(?=\\r?\\n      - name: Upload linux e2e spec report)`, "m"))?.[0];
  expect(step).toBeDefined();
  const aptIndex = step?.indexOf("sudo apt-get update") ?? -1;
  const reportDirIndex = step?.indexOf('report_dir="$RUNNER_TEMP/release-report/linux"') ?? -1;

  expect(aptIndex).toBeGreaterThan(-1);
  expect(reportDirIndex).toBeGreaterThan(-1);
  expect(reportDirIndex).toBeLessThan(aptIndex);
}

async function startStablePrereleaseMetadataServer(objects: Record<string, unknown>): Promise<{
  close: () => Promise<void>;
  origin: string;
}> {
  const server = createHttpsServer(
    {
      cert: stablePrereleaseMetadataCert,
      key: stablePrereleaseMetadataKey,
    },
    (request, response) => {
      const objectKey = decodeURIComponent(new URL(request.url ?? "/", "https://127.0.0.1").pathname.replace(/^\/+/, ""));
      if (request.method !== "GET" || !(objectKey in objects)) {
        response.statusCode = 404;
        response.end("not found");
        return;
      }

      response.setHeader("content-type", "application/json; charset=utf-8");
      response.end(JSON.stringify(objects[objectKey]));
    },
  );

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (address == null || typeof address === "string") {
    throw new Error("stable prerelease metadata server did not bind to a TCP port");
  }

  return {
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error == null ? resolve() : reject(error)));
      }),
    origin: `https://127.0.0.1:${address.port}`,
  };
}

function stablePrereleaseMetadataFixture(baseVersion: string, prereleaseVersion: string, publicOrigin: string): Record<string, unknown> {
  const versionPrefix = `prerelease/versions/${prereleaseVersion}`;
  const versionUrl = `${publicOrigin}/${versionPrefix}`;
  const artifact = (name: string) => ({
    sha256Url: `${versionUrl}/${name}.sha256`,
    url: `${versionUrl}/${name}`,
  });

  return {
    baseVersion,
    channel: "prerelease",
    github: {
      branch: `release/v${baseVersion}`,
      commit: "0123456789abcdef0123456789abcdef01234567",
      repository: "nexu-io/open-design",
      workflow: "release-prerelease",
    },
    prereleaseNumber: 12,
    prereleaseVersion,
    platforms: {
      mac: {
        arch: "arm64",
        artifacts: {
          dmg: artifact("Open Design.dmg"),
          zip: artifact("Open Design-mac-arm64.zip"),
        },
        enabled: true,
        signed: true,
      },
      macIntel: {
        arch: "x64",
        artifacts: {
          dmg: artifact("Open Design Intel.dmg"),
          zip: artifact("Open Design-mac-x64.zip"),
        },
        enabled: true,
        signed: true,
      },
      win: {
        arch: "x64",
        artifacts: {
          installer: artifact("Open Design Setup.exe"),
        },
        enabled: true,
      },
    },
    r2: {
      report: {
        type: "zip",
        url: `${versionUrl}/report.zip`,
      },
      reportZipUrl: `${versionUrl}/report.zip`,
      versionMetadataUrl: `${versionUrl}/metadata.json`,
      versionPrefix,
    },
    releaseVersion: prereleaseVersion,
    signed: true,
  };
}

async function startReleaseMetadataObjectStore(objects: Record<string, unknown>): Promise<{
  bucket: string;
  close: () => Promise<void>;
  endpointUrl: string;
  uploadedObjectKeys: () => string[];
}> {
  const bucket = "release-bucket";
  const uploadedObjectKeys: string[] = [];
  const server = createServer((request, response) => {
    void handleReleaseMetadataObjectStoreRequest(request, response, bucket, objects, uploadedObjectKeys);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (address == null || typeof address === "string") {
    throw new Error("release metadata object store did not bind to a TCP port");
  }

  return {
    bucket,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error == null ? resolve() : reject(error)));
      }),
    endpointUrl: `http://127.0.0.1:${address.port}`,
    uploadedObjectKeys: () => [...uploadedObjectKeys],
  };
}

async function handleReleaseMetadataObjectStoreRequest(
  request: IncomingMessage,
  response: ServerResponse,
  bucket: string,
  objects: Record<string, unknown>,
  uploadedObjectKeys: string[],
): Promise<void> {
  const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
  const bucketPrefix = `/${bucket}/`;
  if (!path.startsWith(bucketPrefix)) {
    response.statusCode = 404;
    response.end("not found");
    return;
  }

  const objectKey = decodeURIComponent(path.slice(bucketPrefix.length));
  if (request.method === "GET") {
    if (!(objectKey in objects)) {
      response.statusCode = 404;
      response.end("not found");
      return;
    }
    const body = JSON.stringify(objects[objectKey]);
    response.setHeader("content-type", "application/json; charset=utf-8");
    response.end(body);
    return;
  }

  if (request.method === "PUT") {
    uploadedObjectKeys.push(objectKey);
    for await (const _chunk of request) {
      // Drain the request body so the client can complete cleanly.
    }
    response.statusCode = 200;
    response.end("ok");
    return;
  }

  response.statusCode = 405;
  response.end("method not allowed");
}

const stablePrereleaseMetadataKey = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC1hoV1GwxqTYdO
Zs0pY5hnp8BtTwdF6dWsXoFWYw9IPpBTmyNeleRcLtrht/oc5oRS05tC97qmb5eL
RigyXUmwrpt/VjJ7ursDa3qGnljkqVxqBkRAUdXBMCVPkMogKWvJy/S61Vthvf7K
K5HhofwcuPPvRBdhdZgtw/7nZY49HYutd7wP/U7iqCYBMpWr0I29jSs1S2xY9fH8
ih/exDGe3PHm8yQao4pHUUFVXoAI5w6tYsmNep6b+5NYPHnHSaXd7h5gaF+nIJE4
78jgRQHKjQ2iNf/53/o/d5SAMb/9lZ7stNT8RIFOJUz1IP8Zsz3VKwAvXKXZDObr
0MS4JrPdAgMBAAECggEATcF0HD/8VvKjsU0ut3pud4QvVINEGcn6mY2XuFHRY4BN
IUr0YRkyytvVLVe5vrRtXO9Ac/Sakp19XA6uvDgijxiUCfz5ve80GVhqEQz2BeiX
6eCKTsTfG5QMf2MFebZUcgm36Gno7VrNr3rvT6erzv/YmZZgr4IIMB5i62qgfYOY
ABSg6b223RSVeZXNvWxovKycBUUa26lrzRu5jpuexjAccmgbiE86exhzW7FK2zjZ
XH8rOxSDJ49+ipPOGsJ+rZMdtvHq6BO/QU4O9IkBLNuHAIbr/WcjBgnAPskQTrOM
i3vWqPNVw3tPjBWCOtzy0UllG0L5Sxnx5cceFvL9HwKBgQDieIaM89In+VETI+x4
aUmQXxVcisZR0FWQytl+XbWe4T1zxEj4fFjd/phgv0M60599/mwCCGrImxKM8cnb
mjxv2FX+or9+2IFpaSOi+Qj6/IxcTTWoMU0t4AQjOgbRf3iBpVz6JysnKKpqqukT
GGOnzGWz0gFmDAqKm0zkGy7czwKBgQDNMb6hrSGobMRlCndgx//w/SdDq/IqAbIS
QyAvYgNuOXV3J4sD2Z1TwYxZM2Oq5rhOPfZr8SnqM7d+LknLPiGMKV7z6vL/BOu8
ZB5+EmMZwqNmSOMaFZM+77OC/zxDCznqTm4N5vDdg+6SByCtuyCm+Jraj0PtHtkD
krdWqBfHkwKBgDpTzluZJGQ1OyNR2kJ843xycL7/4uoJXTBIflGkcvVzj280e5K7
++tY+gfY2sjY3jgGAe1YG6CFB/cTAukzRSONNUC6y9Uwj8wFTy9XMm/qAYB4RjyG
Thllm8sy07S7Pt8tJtAqrFuOhq2oTRUk7+20n/D7Qm705PYj317UfXJTAoGABdYM
XfzWoDu3ukf57T7DAM+ydjJFyPwTXIGcQLzA7DmmJaVyRsHBv8gZfdAAXbQCOfd5
MsjBMHAYH/ahEq7JtXrXwIhGMQqqycjvNRbAytLGYvpfuzYx4fBfYrJvvFhtZUSl
zK9s2mAOQQkC3O4dl6IqhVzdybi+42Mg484UHxECgYEAht1ef0Gc6RKZpmqttlZJ
1G4lsR1Aws3dintACs8lza5aaufrY07gF8z3rkW6tPGEWfol3CYOT2U5UiUw+iKG
F/Pa3L5wCxuRKKWx0ip0PFhDPrpWfVCm2CLlUlZLEjpmF2iUZgmkaScjYqG8R16a
C8cywTs1ku5aYIaN8YcAigI=
-----END PRIVATE KEY-----`;

const stablePrereleaseMetadataCert = `-----BEGIN CERTIFICATE-----
MIIDCTCCAfGgAwIBAgIUbNGmwcWmZP5tw6gm8s2RXzWJv+IwDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJMTI3LjAuMC4xMB4XDTI2MDYwODA0MDczNVoXDTI2MDYw
OTA0MDczNVowFDESMBAGA1UEAwwJMTI3LjAuMC4xMIIBIjANBgkqhkiG9w0BAQEF
AAOCAQ8AMIIBCgKCAQEAtYaFdRsMak2HTmbNKWOYZ6fAbU8HRenVrF6BVmMPSD6Q
U5sjXpXkXC7a4bf6HOaEUtObQve6pm+Xi0YoMl1JsK6bf1Yye7q7A2t6hp5Y5Klc
agZEQFHVwTAlT5DKIClrycv0utVbYb3+yiuR4aH8HLjz70QXYXWYLcP+52WOPR2L
rXe8D/1O4qgmATKVq9CNvY0rNUtsWPXx/Iof3sQxntzx5vMkGqOKR1FBVV6ACOcO
rWLJjXqem/uTWDx5x0ml3e4eYGhfpyCROO/I4EUByo0NojX/+d/6P3eUgDG//ZWe
7LTU/ESBTiVM9SD/GbM91SsAL1yl2Qzm69DEuCaz3QIDAQABo1MwUTAdBgNVHQ4E
FgQU8Z0Oy/q8fAqp9005cn2sW4K6oB4wHwYDVR0jBBgwFoAU8Z0Oy/q8fAqp9005
cn2sW4K6oB4wDwYDVR0TAQH/BAUwAwEB/zANBgkqhkiG9w0BAQsFAAOCAQEAlJTb
7zi4FKJqYuXZ9YWmV96Ri+vBcNfO2dwKBxFtJXm0Ai2Q4ruutuFPYwY6UYGTN5gC
HJ0/WxuPK5ftAE6UU+Mghu0dJlH+gWmOq5cDyhYdnEi8R6z5AsPtPEYlkkIvhUO1
k1BtCP0h4Kh8fuaILGuXQNOaKizIWF2lEEHfCmvKhgOF6dKWs38zdetFQCLRIaHg
ZyGlUhPCUbKdTiBJuCGaDKzeEAlC8dsar2zjg9CVue7w3CaamQpjnV0d2IHJiVAH
QONQvdtLnZ6GeNPe06oBrq7R9SL5/tkqgSq8lCrDE6jFZnfXNMdDmZY3wTcFcdyG
yW/DsIUs5ZzcHza5rw==
-----END CERTIFICATE-----`;
