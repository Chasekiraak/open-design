import { getWorkspaceProjectByProjectId } from '../db.js';
import { resolveProjectWorkspaceScope } from '../collab/project-workspace-scope.js';
import type { WorkspaceDirectoryFetchResult } from '../collab/vela-workspace-context.js';
import { openDesignAmrTraceEnv } from './env.js';

type SqliteDb = Parameters<typeof getWorkspaceProjectByProjectId>[0];

/** Total directory read attempts, i.e. one initial try plus two retries. */
const DIRECTORY_READ_ATTEMPTS = 3;
/** Backoff before retry N, bounded so the AMR spawn path stays interactive. */
const DIRECTORY_RETRY_BACKOFF_MS = [120, 360] as const;

/**
 * Every way the AMR workspace-binding proof can end, as one closed union.
 *
 * This exists because the alternative cost three wrong root causes in a single
 * day: a full diagnostics export from an affected user could not say which
 * branch had decided, so each hypothesis had to be argued from source-reading
 * and then discarded. Two of these kinds used to be one error with one message.
 *
 * Keep it a closed union — it is a telemetry grouping key and a log token, so a
 * reader holding only a run record or only a log must be able to tell the
 * branches apart without opening this file.
 */
export type ProjectWorkspaceScopeOutcomeKind =
  /** SQLite holds no binding for the project at all. Refused. */
  | 'refused_no_binding'
  /** The directory answered and listed no active membership for it. Refused. */
  | 'refused_no_active_membership'
  /**
   * The directory answered with an EMPTY membership list. Vela's
   * `GET /api/v1/workspaces` runs `ensurePersonalWorkspace` before listing and
   * applies no type filter, so an authenticated caller structurally always has
   * at least their personal workspace — an empty list therefore means a
   * malformed or unexpected body, not a membership fact. Kept distinct from
   * `refused_no_active_membership` so it can never be read as "you were removed".
   */
  | 'refused_directory_empty'
  /** Every bounded directory read failed. Proceeded on the account wallet. */
  | 'proceeded_directory_unreadable'
  /** Proven team binding; the team wallet pays. */
  | 'resolved_team'
  /** Proven personal binding; the account wallet pays. */
  | 'resolved_personal';

/**
 * Machine-readable record of which branch decided, and on what evidence.
 * Deliberately carries ids and counts only — never member rows or credentials.
 */
export interface ProjectWorkspaceScopeOutcome {
  kind: ProjectWorkspaceScopeOutcomeKind;
  projectId: string;
  /** The workspace the project is pinned to, as persisted. */
  workspaceId: string | null;
  /** Whether the final directory read answered; null when none was needed. */
  directoryOk: boolean | null;
  /** Active membership entries returned; null when no read was needed. */
  directoryItemCount: number | null;
  /** Directory reads spent, including retries; 0 when none was needed. */
  directoryReadAttempts: number;
}

/**
 * The membership authority ANSWERED and the answer was no: the signed-in member
 * holds no active membership in the workspace this project is pinned to — or the
 * project carries no binding at all, which SQLite alone already proves.
 *
 * This is the one outcome that still fails closed. Spending another team's
 * wallet is worse than refusing the run, so do not widen this into a fallback.
 *
 * `code` and `outcome` are the machine-readable cause. They exist so a run
 * record alone — `state.json` / `events.jsonl`, the file a user can still hand
 * over after logs have rotated — identifies the branch without prose parsing.
 */
export class ProjectWorkspaceScopeRefusedError extends Error {
  readonly code = 'PROJECT_WORKSPACE_SCOPE_REFUSED';

  constructor(
    readonly projectId: string,
    readonly workspaceId: string | null,
    readonly outcome: Extract<
      ProjectWorkspaceScopeOutcomeKind,
      | 'refused_no_binding'
      | 'refused_no_active_membership'
      | 'refused_directory_empty'
    >,
  ) {
    super(
      `Cannot authorize project ${projectId}: the signed-in member holds no ` +
        `active membership in its persisted workspace ` +
        `${workspaceId ?? 'binding'} (${outcome})`,
    );
    this.name = 'ProjectWorkspaceScopeRefusedError';
  }
}

/**
 * Read the signed-in member's membership directory, retrying a FAILED read with
 * bounded backoff before any conclusion is drawn from it.
 *
 * The invariant: **this reports `ok: true` only when the authority actually
 * answered, and `ok: false` only after every bounded attempt failed.** That is
 * what lets the caller treat an absent membership in an `ok` directory as a
 * proven refusal instead of confusing it with an authority it never reached. One
 * slow or dropped response must not be able to move a charge.
 *
 * `fetchWorkspaceDirectory` may signal failure either way — the real
 * `fetchVelaWorkspaceDirectory` swallows missing sessions, non-2xx responses and
 * network errors into `{ ok: false }`, while an injected or future fetcher may
 * reject — so both a falsy `ok` and a thrown error count as one failed attempt.
 */
async function readWorkspaceDirectoryWithBoundedRetry(deps: {
  fetchWorkspaceDirectory: () => Promise<WorkspaceDirectoryFetchResult>;
  sleep?: (ms: number) => Promise<void>;
  attempts?: number;
}): Promise<{ result: WorkspaceDirectoryFetchResult; attempts: number }> {
  const maxAttempts = Math.max(1, deps.attempts ?? DIRECTORY_READ_ATTEMPTS);
  const sleep =
    deps.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let last: WorkspaceDirectoryFetchResult = { ok: false, items: [] };
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      last = await deps.fetchWorkspaceDirectory();
    } catch {
      last = { ok: false, items: [] };
    }
    if (last.ok) return { result: last, attempts: attempt };
    if (attempt < maxAttempts) {
      const backoff =
        DIRECTORY_RETRY_BACKOFF_MS[attempt - 1] ??
        DIRECTORY_RETRY_BACKOFF_MS[DIRECTORY_RETRY_BACKOFF_MS.length - 1] ??
        0;
      await sleep(backoff);
    }
  }
  return { result: last, attempts: maxAttempts };
}

/**
 * Build the final AMR trace environment from the project's persisted SQLite
 * binding and the signed-in member's exact authoritative workspace directory.
 * No caller-provided or ambient workspace identity participates.
 *
 * `workspace_projects.visibility` is deliberately not used as a billing-kind
 * discriminator: a private draft can belong to a team workspace and must still
 * spend that team's wallet.
 *
 * **Proof refusal and proof failure are different events, and only refusal fails
 * closed.** The two used to share one error and one outcome, so a momentary
 * authority outage was indistinguishable from a member genuinely having no
 * membership — and killed the run either way:
 *
 * - **The authority answered and refused** (`ok` directory, no matching active
 *   membership; or no binding at all). Fail closed with
 *   {@link ProjectWorkspaceScopeRefusedError}. Charging a team's run to the
 *   account wallet, or an account's run to a team, is worse than refusing.
 *
 * - **The authority could not be asked** (every bounded attempt failed). The run
 *   PROCEEDS with no workspace, i.e. on the caller's own account wallet.
 *
 *   This branch is a deliberate product decision, not an oversight: failing the
 *   run outright arrived as a production P0, and a hard failure is worse than a
 *   mis-attributed personal charge. Note the asymmetry that makes it safe — the
 *   fallback can only ever bill the caller for the caller's own run. The reverse
 *   direction, charging a personal run to a team wallet, is a genuine breach and
 *   stays impossible, because no fallback here picks some other workspace. This
 *   is why the retry is bounded rather than absent: proceeding is the considered
 *   answer only after the authority has really failed, not after one slow
 *   response. Please do not "fix" this back to failing closed.
 *
 * Every branch reports a {@link ProjectWorkspaceScopeOutcome} through
 * `onWorkspaceScopeOutcome`, including the successful ones. That is not
 * bookkeeping for its own sake: this decision was previously invisible in the
 * daemon log, the run record, and telemetry alike, so a complete diagnostics
 * bundle could not say why a run had been refused.
 *
 * Two regimes, and the split between them is also the point:
 *
 * - **Workspace authority is live** (`isWorkspaceTeamConfigured()` true, i.e.
 *   `OD_WORKSPACE_CONTEXT_SOURCE === 'vela'` in production). Every AMR project
 *   must prove its binding, subject to the refusal/failure split above.
 *
 * - **Workspace authority is not configured.** There is no directory to prove a
 *   binding against and no team wallet to mischarge, so the account wallet is
 *   the only correct answer and the scope lookup is skipped entirely. This is
 *   not a loosening of the rule above; it is the pre-workspace-team behavior,
 *   preserved for the callers `resolveCreatedProjectWorkspace` explicitly
 *   sanctions: "a completely headerless request is a legal legacy/anonymous
 *   caller and intentionally leaves the new project unbound". Without this
 *   split, that contract and this one contradict each other and AMR refuses to
 *   run for precisely the projects the other module calls legitimate — which,
 *   with workspace transport off in production builds, is every local user.
 *
 * Skipping the lookup also keeps an unconfigured daemon off the network, the
 * same reason `fetchProjectCreationWorkspaceDirectory` is gated in `server.ts`.
 */
export async function openDesignAmrTraceEnvForProject(
  db: SqliteDb,
  input: {
    agentId: string;
    runId: string;
    conversationId?: string | null;
    runAttempt: number;
    projectId?: string | null;
  },
  deps: {
    fetchWorkspaceDirectory: () => Promise<WorkspaceDirectoryFetchResult>;
    /**
     * Whether this daemon actually carries workspace authority — see the two
     * regimes on {@link openDesignAmrTraceEnvForProject}. Defaults to `true` so
     * a call site that forgets to pass it still holds team runs to the binding
     * requirement rather than silently skipping the proof.
     */
    isWorkspaceTeamConfigured?: () => boolean;
    /**
     * Receives the branch that decided, for the daemon log, the run record and
     * telemetry. Only ever called for AMR: the non-AMR short-circuit returns
     * before any of this, so this path stays silent for every other runtime.
     */
    onWorkspaceScopeOutcome?: (outcome: ProjectWorkspaceScopeOutcome) => void;
    /** Injectable for tests so bounded backoff costs no wall-clock time. */
    sleep?: (ms: number) => Promise<void>;
    /** Injectable for tests; total directory read attempts. */
    directoryReadAttempts?: number;
  },
): Promise<NodeJS.ProcessEnv> {
  const traceInput = {
    agentId: input.agentId,
    runId: input.runId,
    runAttempt: input.runAttempt,
    ...(input.conversationId !== undefined
      ? { conversationId: input.conversationId }
      : {}),
  };
  // Every runtime passes through the server launch env builder, but workspace
  // billing is an AMR-only concern. Non-AMR launches must neither depend on nor
  // pay latency for the Vela membership directory — nor emit its observability.
  if (input.agentId !== 'amr') return openDesignAmrTraceEnv(traceInput);

  const projectId = input.projectId?.trim();
  let workspaceId: string | null = null;
  if (projectId && (deps.isWorkspaceTeamConfigured?.() ?? true)) {
    const report = (
      outcome: Omit<ProjectWorkspaceScopeOutcome, 'projectId'>,
    ): void => {
      deps.onWorkspaceScopeOutcome?.({ projectId, ...outcome });
    };
    const binding = getWorkspaceProjectByProjectId(db, projectId);
    // No binding is a LOCAL, proven fact: SQLite is authoritative for it and no
    // directory read could change the answer. A refusal, not a failure.
    if (!binding) {
      report({
        kind: 'refused_no_binding',
        workspaceId: null,
        directoryOk: null,
        directoryItemCount: null,
        directoryReadAttempts: 0,
      });
      throw new ProjectWorkspaceScopeRefusedError(
        projectId,
        null,
        'refused_no_binding',
      );
    }
    const persistedWorkspaceId =
      typeof binding.workspaceId === 'string' && binding.workspaceId.trim()
        ? binding.workspaceId.trim()
        : null;
    const { result: directory, attempts } =
      await readWorkspaceDirectoryWithBoundedRetry({
        fetchWorkspaceDirectory: deps.fetchWorkspaceDirectory,
        ...(deps.sleep ? { sleep: deps.sleep } : {}),
        ...(deps.directoryReadAttempts !== undefined
          ? { attempts: deps.directoryReadAttempts }
          : {}),
      });
    const evidence = {
      workspaceId: persistedWorkspaceId,
      directoryOk: directory.ok,
      directoryItemCount: directory.items.length,
      directoryReadAttempts: attempts,
    };
    if (!directory.ok) {
      // Could not ask. Proceed on the caller's own account wallet — see the
      // product decision in the docblock — but make it countable.
      report({ kind: 'proceeded_directory_unreadable', ...evidence });
      return openDesignAmrTraceEnv(traceInput);
    }
    // An answer listing NOTHING is not an answer about membership: vela cannot
    // legitimately return an empty list to an authenticated caller. Refuse, but
    // under its own name so nobody reads it as "you were removed from the team".
    if (directory.items.length === 0) {
      report({ kind: 'refused_directory_empty', ...evidence });
      throw new ProjectWorkspaceScopeRefusedError(
        projectId,
        persistedWorkspaceId,
        'refused_directory_empty',
      );
    }
    // The directory answered, so from here an absent membership is a proven
    // refusal rather than an authority we never reached.
    const scope = resolveProjectWorkspaceScope({
      projectId,
      binding,
      directory,
    });
    if (scope.kind === 'unbound' || scope.kind === 'unavailable') {
      report({ kind: 'refused_no_active_membership', ...evidence });
      throw new ProjectWorkspaceScopeRefusedError(
        projectId,
        scope.workspaceId,
        'refused_no_active_membership',
      );
    }
    if (scope.kind === 'team') workspaceId = scope.workspaceId;
    report({
      kind: scope.kind === 'team' ? 'resolved_team' : 'resolved_personal',
      ...evidence,
    });
  }
  return openDesignAmrTraceEnv({
    ...traceInput,
    workspaceId,
  });
}
