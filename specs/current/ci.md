# CI scope confidence methodology

This is the current authority for CI scope confidence rules in
`scripts/scopes.ts`, their guard requirements, and their evidence recipes.
Workflow topology and the capability/handoff architecture stay owned by
`.github/AGENTS.md`; do not restate them here.

This document records current state only. State active rules, boundaries,
invariants, evidence, and unresolved questions directly; do not add dated or
numbered rollout stages, before/after narratives, or a history of how the
current design was reached. Git history, pull requests, and task records own
that change history.

## The model in three paragraphs

Every changed file is classified by the additive rule table in
`scripts/scopes.ts`: effects union across matched rules, confidence is the
minimum across matched rules. Each evaluation context brings a trust threshold:
PR and manual-hot runs believe `medium`, the merge queue believes only
`certain`, manual-full runs believe nothing. A file below threshold — or
matching no rule — escalates fail-closed to the full radius.

The policy floor never moves: `run_preflight` is true in every plan, and its
workspace setup, `pnpm guard`, and i18n structure check always execute. Broad
app declaration builds, workspace typecheck, and `run_workspace_unit_tests`
may skip only for a merge-queue plan whose certain-tier evaluation claims zero
validation effects. PR, manual-hot, forced-full, and escalated queue plans keep
all broad workspace validation.

The error cost is asymmetric by tier. A wrong `medium` rule under-arms a PR
run and gets caught by the merge queue's stricter threshold — cost: one queue
bounce. A wrong `certain` rule lets an invalid change reach `main` with no
automatic detection behind it. That asymmetry is why the two tiers have
different iteration rules below.

## Medium-tier requirements

Adding or refining a `medium` rule needs: the rule-table diff, updated goldens
in `e2e/tests/scripts/scopes.test.ts`, and a tonnage estimate from the replay
recipe. The queue backstops mistakes. Do not add speculative rules for
surfaces nobody touches; candidates come from measurement, not from reading
the rule table for imperfections (measured imperfection lists and
frequency-weighted tonnage lists barely intersect).

## Certain-tier requirements

A PR that makes a rule `certain` must be statable in three sentences: which
rule, what guard, how much tonnage. Anything that cannot fit that statement is
riding along and must be split out.

Requirements:

1. **A defensible core.** Promote the subset of the surface whose boundary
   invariant is local and checkable. Split the rule if needed. Example: the
   global `*.md` regex is permanently medium because its safety depends on
   *other* rules covering every runtime-markdown directory — a cross-rule
   invariant no local guard can keep.
2. **A guard that resolves.** The rule's `guard` field must name a live
   `scripts/guard.ts` check (`pnpm --silent guard --list-checks` is the
   registry; the rule-table invariant test enforces resolution). Guards for
   certain rules must run in the policy floor — `pnpm guard` in preflight
   qualifies — so the check that justifies skipping always itself runs.
3. **Evidence proportional to the guard's strength.** Guard invariants come in
   three strengths: *definitional* (the surface cannot enter build or runtime
   by construction — e.g. docs), *structural* (an import-graph boundary), and
   *behavioral* (a topology test). Definitional rules may rely on replay
   evidence alone. Structural and behavioral rules additionally require shadow
   evidence from real queue runs (the `ifTrustAll` column in the scope decision
   trace). The required window is unspecified and must be resolved before any
   such rule becomes `certain`.
4. **Goldens updated, divergence pinned.** The golden that changes is the
   proof of the behavior change; the goldens that do not change are the proof
   of its containment.
5. **Exceptions bind to checkable preconditions.** Every guard allowlist entry
   is a claim, and claims split by what justifies them. A *local, definitional*
   fact ("this string is passed as data to a pure function, never opened") may
   stay prose — it can only be falsified by editing the allowlisted file
   itself, which puts the entry in front of a reviewer. A *remote, mutable*
   fact ("that lane doesn't run this file", "that workflow is outside the
   gate") must not be trusted as prose: the guard verifies the fact and drops
   the exception the moment it stops holding, so the failure mode is a loud
   guard report at the change that broke the premise — not a rationale that
   rotted silently years earlier. Worked example: the consumption guard
   tolerates `apps/daemon/tests/runtimes/trae-cli.test.ts` reading
   `docs/agent-adapters.md` only while `ci.yml`'s daemon lane still runs
   nothing but `project-watchers.test.ts` — the exception is conditional on
   that exclusive invocation check (`workflowRunsOnlyAllowedDaemonTest` in
   `scripts/check-certain-exempt-consumption.ts`); widening the lane revives
   the violation and forces reclassification.

No general demotion policy is defined. One hard rule is active: if a guard
check is deleted or renamed, the rule-table invariant test fails CI — a
certain rule can never silently outlive its guard. Rule five is the same
principle one level down: an exception can never silently outlive its premise.

## Certain-exempt boundary

Rule `certain-exempt-surface`: prefixes `docs/`, `apps/landing-page/`,
`.vscode/`, `.idea/`, `.github/ISSUE_TEMPLATE/` plus exacts `LICENSE`,
`.github/CODEOWNERS`. Guard: `certain-exempt surface consumption`
(`scripts/check-certain-exempt-consumption.ts`) — no skippable-lane source may
reference a certain-exempt path; policy-floor code (root `scripts/`) is exempt
from the scan because preflight always runs and may validate docs content
(product neutrality does).

Current evidence and exceptions:

- A replay of 398 first-parent merges ending at `b99a9fdc3` produces 46
  certain, zero-effect plans (11.6%).
- Root markdown such as `README.md` remains medium because bare filename
  literals are widespread as project-fixture data and are not locally
  distinguishable from repository-root reads.
- Allowlisted true consumer:
  `tools/release/src/release-note/prepare.ts` reads `docs/CHANGELOG`, which
  executes only in release workflows; `@open-design/tools-release` tests run
  in no `ci.yml` lane.

## Zero-effect merge-queue policy floor

A merge-queue plan that trusts every changed file at `certain` and receives no
scope effects keeps preflight setup, `pnpm guard`, and the i18n structure check,
but skips preflight's app prebuild/typecheck steps and the workspace-unit job.
The predicate is queue-only: PR/manual-hot run broad validation even when the
medium-tier plan has no effects, and forced-full or escalated queue plans run
everything.

The certain-exempt consumption guard executes in preflight, and `pnpm guard`
sees every changed path (including a misleading executable such as
`docs/example.js`). The workspace-unit job does not own landing-page
validation, and the broad workspace typecheck excludes
`@open-design/landing-page`.

The 398-merge replay ending at `b99a9fdc3` contains 46 qualifying queue plans
(11.6%). A sample of 12 successful merge-group runs measures broad prebuild
and typecheck at about 1.95 runner-min and workspace unit at about 1.6
runner-min. The policy floor therefore avoids roughly 3.6 runner-min and 2.1
critical-path minutes per qualifying run (~166 runner-min across the replay
window).

## Evidence recipes

Design rule: shell only fetches file lists and extracts logs; every scope
judgment goes through `scripts/scopes.ts plan`. Never reimplement rule
semantics in a pipeline.

Replay recent merges through the evaluator (candidate tonnage):

```bash
git log --first-parent -400 --pretty=%H origin/main | while read -r sha; do
  git diff-tree -r --name-only --no-commit-id "$sha^" "$sha" |
    node --experimental-strip-types scripts/scopes.ts plan \
      --context merge-queue --files-from - |
    node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));
      console.log(d.trace.escalations.length === 0 ? "PURE" : "ESCALATED")'
done | sort | uniq -c
```

Classify one change set offline (PR-side view, prints `{ plan, trace }`):

```bash
node --experimental-strip-types scripts/scopes.ts plan --context pr \
  --files apps/web/src/App.tsx docs/architecture.md
```

Pull the shadow column from a real queue run (the certain-rule evidence stream
for structural/behavioral proposals; prefer job logs — do not rely on
artifacts):

```bash
gh run view <run-id> --log | sed -n '/scope decision trace:/,/^}/p'
```

Each recipe's sanity check: the replay loop must print only `PURE`/`ESCALATED`
counts; `plan` must print JSON with a `trace.threshold` matching the context.

## Evidence tooling policy

Keep these commands as recipes. Check in a script only when a certain-rule
evaluation needs evidence beyond the CI log retention window, or repeated
manual execution has produced copy errors. Evidence must justify additional
infrastructure.

## Open questions

- Required shadow-evidence window for structural or behavioral certain rules.
- Demotion policy beyond the guard-resolution hard rule.
- Whether medium-tier zero-effect PR plans should use the policy floor; this
  needs its own evidence and containment review.
- Queue batching discount: the 11.6% figure assumes single-PR queue groups; a
  mixed group loses the benefit file-by-file. Check real `merge_group` traces
  once a few have accumulated.
- Adjacent medium-tier gaps (each is its own small PR): `e2e/tests/**` arms no
  e2e Vitest lane (and atom-workflow edits therefore skip the topology tests
  on PR runs — the queue is currently their only pre-main execution);
  `mocks/**` is fallback-classified into Playwright lanes instead of the
  daemon tests that consume it; the dispatch-hot branch never re-derives
  workspace validation (pinned asymmetry in the goldens).
