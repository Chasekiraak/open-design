import { uiP0CiMatrix } from "../../../e2e/lib/playwright/suites.ts";
import {
  DAEMON_RUNTIME_DEFINITION_EXACT,
  DAEMON_RUNTIME_DEFINITION_PREFIXES,
  evaluateUiP0Shadow,
} from "../../scopes.ts";

const fullMatrixNames = [
  "entry-settings",
  "project-workspace",
  "project-runtime",
  "workspace-restoration",
] as const;
const candidateMatrixNames = [
  "entry-settings",
  "project-workspace",
  "project-runtime",
] as const;

function matrixNames(matrix: readonly { name: string }[]): string[] {
  return matrix.map((entry) => entry.name);
}

function sameValues(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && actual.every((value, index) => value === expected[index]);
}

export function uiP0ShadowContractErrors(): string[] {
  const errors: string[] = [];
  if (!sameValues(matrixNames(uiP0CiMatrix), fullMatrixNames)) {
    errors.push("the applied UI P0 matrix is no longer the guarded full four-domain matrix");
  }

  const sourceSample = `${DAEMON_RUNTIME_DEFINITION_PREFIXES[0]}example.ts`;
  const testSample = DAEMON_RUNTIME_DEFINITION_EXACT.find((file) => file.includes("/tests/"));
  const candidate = evaluateUiP0Shadow(testSample == null ? [sourceSample] : [sourceSample, testSample]);
  if (
    candidate.mode !== "candidate" ||
    candidate.capability !== "daemon-runtime-definition" ||
    !sameValues(matrixNames(candidate.matrix), candidateMatrixNames)
  ) {
    errors.push("the runtime-definition shadow no longer resolves to the guarded three-domain candidate");
  }

  for (const outsideFile of [
    "apps/daemon/src/server.ts",
    "apps/daemon/src/runtimes/detection.ts",
    "apps/web/src/App.tsx",
  ]) {
    const fallback = evaluateUiP0Shadow([sourceSample, outsideFile]);
    if (
      fallback.mode !== "full-fallback" ||
      fallback.reason !== "outside-capability" ||
      !sameValues(matrixNames(fallback.matrix), fullMatrixNames)
    ) {
      errors.push(`${outsideFile} no longer forces the runtime-definition shadow to the full matrix`);
    }
  }

  const unresolved = evaluateUiP0Shadow([], false);
  if (
    unresolved.mode !== "full-fallback" ||
    unresolved.reason !== "files-unresolved" ||
    !sameValues(matrixNames(unresolved.matrix), fullMatrixNames)
  ) {
    errors.push("unresolved changed files no longer force the UI P0 shadow to the full matrix");
  }
  return errors;
}

export async function checkUiP0ShadowContract(): Promise<boolean> {
  const errors = uiP0ShadowContractErrors();
  if (errors.length > 0) {
    console.error("UI P0 shadow-contract violations found:");
    for (const error of errors) console.error(`- ${error}`);
    return false;
  }
  console.log("UI P0 shadow contract check passed: applied coverage stays full and fallbacks stay closed.");
  return true;
}
