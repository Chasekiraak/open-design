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

export interface ProactiveContentPullProjectRef {
  projectId: string;
  ownerMemberId: string;
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
  /**
   * One workspace-scoped catalog read used only on a verified hub connection
   * (first connect and reconnect). Optional so event-driven consumers remain
   * usable without a catch-up transport.
   */
  listSharedProjects?: (
    workspaceId: string,
  ) => Promise<readonly ProactiveContentPullProjectRef[]>;
  /** Local materialization probe used by the low-frequency catalog floor.
   *  A missing project is the only candidate that floor may pull; full head
   *  comparison remains limited to verified first-connect/reconnect hooks. */
  hasMaterializedProject?: (projectId: string) => boolean | Promise<boolean>;
  /** Read one authoritative published head after the single catalog sweep has
   *  selected a recently changed, non-owned project. Calls are sequential to
   *  avoid a reconnect request burst. */
  publishedHead?: (target: ProactiveContentPullTarget) => Promise<number | null>;
  /** Durable last materialized version, shared with other team-resource
   *  reconcilers. Seeds the in-memory event cursor after daemon restart. */
  materializedVersion?: (target: ProactiveContentPullTarget) => string | null;
  /** Called after a successful, versioned pull has materialized bytes. Used
   *  to invalidate list-level cover reads that do not subscribe to the
   *  project's own SSE stream. */
  onPulled?: (target: ProactiveContentPullTarget, version: number) => void | Promise<void>;
  /** Secret-free lifecycle diagnostics for the bounded catch-up sweep. */
  onCatchUp?: (event: {
    phase: 'started' | 'completed' | 'skipped';
    mode: 'full' | 'missing-only';
    workspaceId?: string;
    scanned?: number;
    candidates?: number;
    heads?: number;
    complete?: boolean;
    reason?: 'no-active-team' | 'scope-mismatch' | 'unavailable';
  }) => void;
  onError?: (error: unknown) => void;
}

export interface ProactiveContentPull {
  /**
   * React to one hub 'project-content-changed' event. Never rejects: every
   * failure lands on `onError` and leaves freshness to the polling fallback.
   */
  handleContentChanged(event: ProactiveContentPullEvent): Promise<void>;
  /**
   * Sweep published heads after a verified hub first-connect/reconnect.
   * Calls are single-flight with at most one trailing pass.
   */
  catchUpPublishedHeads(expectedWorkspaceId?: string): Promise<void>;
  /**
   * Low-frequency catalog safety floor for the healthy-stream/missed-event
   * case. Only remote projects with no local materialization are considered.
   */
  materializeMissingProjects(expectedWorkspaceId?: string): Promise<void>;
}

export function createProactiveContentPull(
  deps: ProactiveContentPullDeps,
): ProactiveContentPull {
  /** Last hub version a successful pull materialized, per project + scope. */
  const pulledVersions = new Map<string, number>();
  /** In-flight pull per project; racing events await it instead of stacking. */
  const inFlight = new Map<string, Promise<ProactiveContentPullOutcome | null>>();
  let catchUpInFlight: Promise<void> | null = null;
  let requestedGeneration = 0;
  let completedGeneration = 0;
  let requestedSweep: {
    mode: 'full' | 'missing-only';
    expectedWorkspaceId?: string;
  } | null = null;

  const pullScopeKey = (target: ProactiveContentPullTarget) =>
    JSON.stringify([
      target.projectId,
      target.workspaceId,
      target.resourceTeamId,
      target.viewerMemberId,
      target.ownerMemberId,
    ]);

  async function shouldPull(
    event: ProactiveContentPullEvent,
    ownerHint?: string,
  ): Promise<
    | { kind: 'target'; target: ProactiveContentPullTarget }
    | { kind: 'skip'; retryable: boolean }
  > {
    const projectId = event.projectId;
    if (!projectId) return { kind: 'skip', retryable: false };
    const binding = deps.getLocalBinding(projectId);
    if (binding?.visibility === 'personal') return { kind: 'skip', retryable: false };
    const targetWorkspaceId = binding?.workspaceId ?? event.workspaceId;
    // An unbound project has no local scope witness, so the hub event must
    // carry one. Existing team bindings keep supporting legacy events that
    // omit workspaceId.
    if (!targetWorkspaceId) return { kind: 'skip', retryable: false };
    if (event.workspaceId && targetWorkspaceId !== event.workspaceId) {
      return { kind: 'skip', retryable: false };
    }
    let identity: Awaited<ReturnType<typeof deps.getWorkspaceIdentity>>;
    try {
      identity = await deps.getWorkspaceIdentity();
    } catch (error) {
      deps.onError?.(error);
      return { kind: 'skip', retryable: true };
    }
    if (!identity) return { kind: 'skip', retryable: true };
    if (identity.workspaceId !== targetWorkspaceId) {
      return { kind: 'skip', retryable: true };
    }
    // Fail-closed ownership: pulling over the single writer's working tree is
    // destructive, so an unresolvable owner refuses the pull rather than
    // guessing.
    let owner: string | null = ownerHint?.trim() || null;
    if (!owner) {
      try {
        owner = await deps.resolveSharedProjectOwner(projectId);
      } catch {
        owner = null;
      }
    }
    if (!owner) return { kind: 'skip', retryable: true };
    if (owner === identity.workspaceMemberId) {
      return { kind: 'skip', retryable: false };
    }
    return {
      kind: 'target',
      target: {
        projectId,
        workspaceId: targetWorkspaceId,
        resourceTeamId: identity.resourceTeamId,
        viewerMemberId: identity.workspaceMemberId,
        ownerMemberId: owner,
      },
    };
  }

  async function runPull(
    target: ProactiveContentPullTarget,
  ): Promise<ProactiveContentPullOutcome | null> {
    const { projectId } = target;
    const scopeKey = pullScopeKey(target);
    const run = (async (): Promise<ProactiveContentPullOutcome | null> => {
      try {
        const outcome = await deps.pullSharedProject(target);
        if (outcome.status !== 'pulled') return outcome;
        // Advance the cursor only with the version the pull itself reported
        // as materialized — trusting the event's number here could mark
        // content as landed that never reached disk.
        if (outcome.version == null) return outcome;
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
        return outcome;
      } catch (error) {
        // Silent degradation: the web's status polling keeps pulling as the
        // fallback, and the cursor stays behind so the next event retries.
        deps.onError?.(error);
        return null;
      }
    })();
    inFlight.set(scopeKey, run);
    try {
      await run;
    } finally {
      if (inFlight.get(scopeKey) === run) inFlight.delete(scopeKey);
    }
    return run;
  }

  async function processContentChanged(
    event: ProactiveContentPullEvent,
    ownerHint?: string,
    force = false,
  ): Promise<boolean> {
    try {
      const decision = await shouldPull(event, ownerHint);
      if (decision.kind === 'skip') return !decision.retryable;
      const { target } = decision;
      const { projectId } = target;
      const scopeKey = pullScopeKey(target);
      // At most one wait-out + one own pull: attempt 0 may find another
      // pull in flight (coalesce), attempt 1 re-checks the cursor after it
      // lands and runs the trailing pull when the head is still ahead.
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const cursor = pulledVersions.get(scopeKey);
        if (!force && event.version != null && cursor != null && cursor >= event.version) {
          return true;
        }
        const running = inFlight.get(scopeKey);
        if (running) {
          await running;
          continue;
        }
        const outcome = await runPull(target);
        return outcome?.status === 'pulled'
          ? outcome.version != null
          : outcome?.status === 'revoked';
      }
      return true;
    } catch (error) {
      deps.onError?.(error);
      return false;
    }
  }

  async function runCatchUpSweep(
    mode: 'full' | 'missing-only',
    expectedWorkspaceId?: string,
  ): Promise<void> {
    if (
      !deps.listSharedProjects ||
      !deps.publishedHead ||
      (mode === 'missing-only' && !deps.hasMaterializedProject)
    ) {
      deps.onCatchUp?.({ phase: 'skipped', mode, reason: 'unavailable' });
      return;
    }
    const identity = await deps.getWorkspaceIdentity().catch((error) => {
      deps.onError?.(error);
      return null;
    });
    if (!identity) {
      deps.onCatchUp?.({ phase: 'skipped', mode, reason: 'no-active-team' });
      return;
    }
    if (expectedWorkspaceId && identity.workspaceId !== expectedWorkspaceId) {
      deps.onCatchUp?.({
        phase: 'skipped',
        mode,
        workspaceId: identity.workspaceId,
        reason: 'scope-mismatch',
      });
      return;
    }

    const { workspaceId } = identity;
    deps.onCatchUp?.({ phase: 'started', mode, workspaceId });

    let projects: readonly ProactiveContentPullProjectRef[];
    try {
      projects = await deps.listSharedProjects(workspaceId);
    } catch (error) {
      deps.onError?.(error);
      deps.onCatchUp?.({
        phase: 'completed',
        mode,
        workspaceId,
        scanned: 0,
        candidates: 0,
        heads: 0,
        complete: false,
      });
      return;
    }

    let complete = true;
    const candidates: Array<{
      project: ProactiveContentPullProjectRef;
      forcePull: boolean;
    }> = [];
    for (const project of projects) {
      if (project.ownerMemberId === identity.workspaceMemberId) continue;
      if (mode === 'missing-only') {
        let materialized: boolean;
        try {
          materialized = await deps.hasMaterializedProject!(project.projectId);
        } catch (error) {
          deps.onError?.(error);
          complete = false;
          continue;
        }
        if (materialized) continue;
      }
      candidates.push({ project, forcePull: mode === 'missing-only' });
    }
    let heads = 0;
    // Deliberately sequential: reconnect is a recovery path, not permission
    // to fan out one request per shared project at once.
    for (const candidate of candidates) {
      const { project, forcePull } = candidate;
      const binding = deps.getLocalBinding(project.projectId);
      if (binding?.visibility === 'personal') continue;
      if (binding && binding.workspaceId !== workspaceId) continue;
      const target: ProactiveContentPullTarget = {
        projectId: project.projectId,
        workspaceId,
        resourceTeamId: identity.resourceTeamId,
        viewerMemberId: identity.workspaceMemberId,
        ownerMemberId: project.ownerMemberId,
      };
      const persistedVersion = Number(
        deps.materializedVersion?.(target) ?? NaN,
      );
      if (!forcePull && Number.isFinite(persistedVersion)) {
        const scopeKey = pullScopeKey(target);
        const cursor = pulledVersions.get(scopeKey);
        if (cursor == null || persistedVersion > cursor) {
          pulledVersions.set(scopeKey, persistedVersion);
        }
      }
      let version: number | null;
      try {
        version = await deps.publishedHead(target);
      } catch (error) {
        deps.onError?.(error);
        complete = false;
        continue;
      }
      if (version == null) continue;
      heads += 1;
      if (!forcePull && Number.isFinite(persistedVersion) && persistedVersion >= version) {
        continue;
      }
      if (!await processContentChanged(
        { projectId: project.projectId, workspaceId, version },
        project.ownerMemberId,
        forcePull,
      )) {
        complete = false;
      }
    }
    deps.onCatchUp?.({
      phase: 'completed',
      mode,
      workspaceId,
      scanned: projects.length,
      candidates: candidates.length,
      heads,
      complete,
    });
  }

  async function requestCatchUp(
    mode: 'full' | 'missing-only',
    expectedWorkspaceId?: string,
  ): Promise<void> {
    requestedGeneration += 1;
    // A verified request for a new workspace supersedes pending work from the
    // old scope. Within one scope, full subsumes missing-only.
    if (
      requestedSweep === null ||
      requestedSweep.expectedWorkspaceId !== expectedWorkspaceId ||
      mode === 'full'
    ) {
      requestedSweep = {
        mode,
        ...(expectedWorkspaceId ? { expectedWorkspaceId } : {}),
      };
    }
    if (catchUpInFlight) {
      return catchUpInFlight;
    }
    const run = (async () => {
      while (completedGeneration < requestedGeneration) {
        const generation = requestedGeneration;
        const next = requestedSweep ?? { mode: 'missing-only' as const };
        requestedSweep = null;
        await runCatchUpSweep(next.mode, next.expectedWorkspaceId);
        completedGeneration = generation;
      }
    })();
    catchUpInFlight = run;
    try {
      await run;
    } finally {
      if (catchUpInFlight === run) catchUpInFlight = null;
    }
  }

  return {
    async handleContentChanged(event: ProactiveContentPullEvent): Promise<void> {
      await processContentChanged(event);
    },
    catchUpPublishedHeads: (workspaceId) => requestCatchUp('full', workspaceId),
    materializeMissingProjects: (workspaceId) =>
      requestCatchUp('missing-only', workspaceId),
  };
}
