// Hub push-channel consumer for 'project-content-changed' (recvqmKQRiIlYf):
// a teammate published a new version of a shared project, so THIS daemon
// pulls the content proactively — no open tab required — instead of leaving
// freshness to the member web's ~5s status polling. That polling stays
// running untouched as the fallback (and as the ONLY mechanism while the hub
// channel is down); everything here degrades to it: a guard skip, a failed
// pull, or a revoked project simply leaves freshness to the poll loop.
//
// Guard boundary (all fail CLOSED — an uncertain answer skips the pull):
//   - An existing local binding must be a team binding. A newly-shared project
//     with no local binding may bootstrap from the event only when the event
//     carries the same workspace as this daemon's active team identity. This
//     closes the first-publication gap: the catalog can expose the card before
//     the member has ever opened/materialized it, and waiting for an open tab
//     leaves its files/details absent for tens of seconds.
//   - The pull NEVER runs when this daemon's member owns the project. The
//     owner's local copy is the single writer (see useProjectCollab.ts's
//     member auto-pull gate, which holds the same rule on the web side);
//     pulling over it could clobber unpublished edits. The owner's daemon
//     receives its own publish echo over the SSE channel, so this guard is
//     load-bearing, not defensive.
//   - Event workspace, local binding workspace, and the active identity's
//     workspace must all agree; a mismatch means the event belongs to a scope
//     this daemon must not address with its current principal.
//
// Dedup model: a per-project cursor records the version the last successful
// pull materialized, so repeated/out-of-order events for an already-landed
// head are no-ops; an event racing an in-flight pull waits it out and re-runs
// AT MOST once when the cursor is still behind (a newer head arrived while
// pulling). The cursor only advances on a successful pull — failures keep it
// behind so the same-version retry stays possible.

export interface ProactiveContentPullEvent {
  projectId?: string | undefined;
  workspaceId?: string | undefined;
  version?: number | undefined;
}

/** Outcome contract of the injected pull — structurally the same shape
 *  `CollabSyncRoutesHandle.pullSharedProject` (routes/collab-sync.ts)
 *  resolves with, redeclared here so this module stays free of the routes
 *  layer. */
export type ProactiveContentPullOutcome =
  | { status: 'pulled'; version: number | null }
  | { status: 'revoked' }
  | { status: 'register_failed' };

/** Exact team scope proved by the hub event + active identity + owner lookup. */
export interface ProactiveContentPullTarget {
  projectId: string;
  workspaceId: string;
  resourceTeamId: string;
  viewerMemberId: string;
  ownerMemberId: string;
}

export interface ProactiveContentPullDeps {
  /** This daemon's own `workspace_projects` row for the project, or null when
   *  it was never bound locally. */
  getLocalBinding: (
    projectId: string,
  ) => { workspaceId: string; visibility: 'personal' | 'team' } | null;
  /** The active TEAM workspace identity (active membership only), or null
   *  when signed out / personal-only. */
  getWorkspaceIdentity: () => Promise<{
    workspaceId: string;
    resourceTeamId: string;
    workspaceMemberId: string;
  } | null>;
  /** Server-authoritative owner lookup (the team hub catalog). */
  resolveSharedProjectOwner: (projectId: string) => Promise<string | null>;
  /** The shared pull flow (revocation gate → pull → register → signals) —
   *  `CollabSyncRoutesHandle.pullSharedProject` in production wiring. */
  pullSharedProject: (target: ProactiveContentPullTarget) => Promise<ProactiveContentPullOutcome>;
  /** Called after a successful, versioned pull has materialized bytes. Used
   *  to invalidate list-level cover reads that do not subscribe to the
   *  project's own SSE stream. */
  onPulled?: (target: ProactiveContentPullTarget, version: number) => void | Promise<void>;
  onError?: (error: unknown) => void;
}

export interface ProactiveContentPull {
  /**
   * React to one hub 'project-content-changed' event. Never rejects: every
   * failure lands on `onError` and leaves freshness to the polling fallback.
   */
  handleContentChanged(event: ProactiveContentPullEvent): Promise<void>;
}

export function createProactiveContentPull(
  deps: ProactiveContentPullDeps,
): ProactiveContentPull {
  /** Last hub version a successful pull materialized, per project + scope. */
  const pulledVersions = new Map<string, number>();
  /** In-flight pull per project; racing events await it instead of stacking. */
  const inFlight = new Map<string, Promise<void>>();

  async function shouldPull(event: ProactiveContentPullEvent): Promise<ProactiveContentPullTarget | null> {
    const projectId = event.projectId;
    if (!projectId) return null;
    const binding = deps.getLocalBinding(projectId);
    if (binding?.visibility === 'personal') return null;
    const targetWorkspaceId = binding?.workspaceId ?? event.workspaceId;
    // An unbound project has no local scope witness, so the hub event must
    // carry one. Existing team bindings keep supporting legacy events that
    // omit workspaceId.
    if (!targetWorkspaceId) return null;
    if (event.workspaceId && targetWorkspaceId !== event.workspaceId) return null;
    const identity = await deps.getWorkspaceIdentity();
    if (!identity) return null;
    if (identity.workspaceId !== targetWorkspaceId) return null;
    // Fail-closed ownership: pulling over the single writer's working tree is
    // destructive, so an unresolvable owner refuses the pull rather than
    // guessing.
    let owner: string | null = null;
    try {
      owner = await deps.resolveSharedProjectOwner(projectId);
    } catch {
      owner = null;
    }
    if (!owner) return null;
    if (owner === identity.workspaceMemberId) return null;
    return {
      projectId,
      workspaceId: targetWorkspaceId,
      resourceTeamId: identity.resourceTeamId,
      viewerMemberId: identity.workspaceMemberId,
      ownerMemberId: owner,
    };
  }

  async function runPull(target: ProactiveContentPullTarget): Promise<void> {
    const { projectId } = target;
    const scopeKey = JSON.stringify([
      projectId,
      target.workspaceId,
      target.resourceTeamId,
      target.viewerMemberId,
      target.ownerMemberId,
    ]);
    const run = (async () => {
      try {
        const outcome = await deps.pullSharedProject(target);
        if (outcome.status !== 'pulled') return;
        // Advance the cursor only with the version the pull itself reported
        // as materialized — trusting the event's number here could mark
        // content as landed that never reached disk.
        if (outcome.version == null) return;
        const cursor = pulledVersions.get(scopeKey);
        if (cursor == null || outcome.version > cursor) {
          pulledVersions.set(scopeKey, outcome.version);
        }
        try {
          await deps.onPulled?.(target, outcome.version);
        } catch (error) {
          // Content is already durable and the cursor must stay advanced; a
          // failed list invalidation is recoverable via its polling floor.
          deps.onError?.(error);
        }
      } catch (error) {
        // Silent degradation: the web's status polling keeps pulling as the
        // fallback, and the cursor stays behind so the next event retries.
        deps.onError?.(error);
      }
    })();
    inFlight.set(scopeKey, run);
    try {
      await run;
    } finally {
      if (inFlight.get(scopeKey) === run) inFlight.delete(scopeKey);
    }
  }

  return {
    async handleContentChanged(event: ProactiveContentPullEvent): Promise<void> {
      try {
        const target = await shouldPull(event);
        if (!target) return;
        const { projectId } = target;
        const scopeKey = JSON.stringify([
          projectId,
          target.workspaceId,
          target.resourceTeamId,
          target.viewerMemberId,
          target.ownerMemberId,
        ]);
        // At most one wait-out + one own pull: attempt 0 may find another
        // pull in flight (coalesce), attempt 1 re-checks the cursor after it
        // lands and runs the trailing pull when the head is still ahead.
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const cursor = pulledVersions.get(scopeKey);
          if (event.version != null && cursor != null && cursor >= event.version) return;
          const running = inFlight.get(scopeKey);
          if (running) {
            await running;
            continue;
          }
          await runPull(target);
          return;
        }
      } catch (error) {
        deps.onError?.(error);
      }
    },
  };
}
