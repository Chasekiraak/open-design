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
  /** Injectable retry clock for deterministic tests. */
  scheduler?: {
    setTimeout: (
      callback: () => void | Promise<void>,
      delayMs: number,
    ) => unknown;
    clearTimeout: (handle: unknown) => void;
  };
  /** Injectable entropy for equal-jitter retry delays. */
  random?: () => number;
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
  /** Stop background recovery and release every pending retry timer. */
  dispose(): void;
}

type CatchUpMode = 'full' | 'missing-only';

interface CatchUpLane {
  inFlight: Promise<void> | null;
  requestedGeneration: number;
  completedGeneration: number;
  requestedSweep: { expectedWorkspaceId?: string } | null;
}

type SuccessfulPullOutcome = Extract<
  ProactiveContentPullOutcome,
  { status: 'pulled' | 'revoked' }
>;

interface ProjectPullCompletion {
  scopeKey: string;
  outcome: ProactiveContentPullOutcome | null;
}

interface PullIntent {
  key: string;
  event: ProactiveContentPullEvent;
  force: boolean;
  desiredVersion?: number;
  expectedScopeKey?: string;
  guardedTarget?: ProactiveContentPullTarget;
  skipNextForceProbe?: boolean;
  failures: number;
  revision: number;
  timer: unknown | null;
  driving: Promise<boolean> | null;
}

type PullAttempt =
  | { kind: 'satisfied' }
  | { kind: 'stopped'; staleGuard?: boolean }
  | { kind: 'revoked' }
  | { kind: 'failed'; staleGuard?: boolean }
  | { kind: 'retry-now' }
  | { kind: 'merged'; intent: PullIntent };

type PullDecision =
  | { kind: 'target'; target: ProactiveContentPullTarget }
  | {
      kind: 'skip';
      retryable: boolean;
      reason:
        | 'invalid'
        | 'personal'
        | 'scope-mismatch'
        | 'identity-missing'
        | 'identity-error'
        | 'owner-missing'
        | 'owner-error'
        | 'self-owner';
    };

export function createProactiveContentPull(
  deps: ProactiveContentPullDeps,
): ProactiveContentPull {
  /** Last hub version a successful pull materialized, per project + scope. */
  const pulledVersions = new Map<string, number>();
  /** The filesystem is project-scoped, so transport serialization must be
   * project-scoped too. Different workspace/owner scopes may never write the
   * same project directory concurrently. */
  const projectPulls = new Map<string, Promise<ProjectPullCompletion>>();
  /** Retry state is isolated by the event's logical resource scope. */
  const intents = new Map<string, PullIntent>();
  const scheduler = deps.scheduler ?? {
    setTimeout: (
      callback: () => void | Promise<void>,
      delayMs: number,
    ): ReturnType<typeof setTimeout> =>
      setTimeout(() => {
        void callback();
      }, delayMs),
    clearTimeout: (handle: unknown): void =>
      clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
  const random = deps.random ?? Math.random;
  let disposed = false;
  /** Monotonic completion counter per project scope. A missing-only manifest
   *  probe captures this before awaiting I/O, then compares it afterwards so
   *  a successful full-sweep pull cannot disappear in the probe → inFlight
   *  gap merely because its promise has already been removed. */
  const completionGenerations = new Map<string, number>();
  const successfulCompletions = new Map<
    string,
    { generation: number; outcome: SuccessfulPullOutcome }
  >();
  /**
   * Full reconnect recovery may spend a long time walking historical heads.
   * Keep the missing-only safety floor on its own single-flight lane so a
   * newly-shared project can materialize immediately. Both lanes still share
   * `projectPulls` and `pulledVersions` above, preserving per-project dedupe.
   */
  const catchUpLanes: Record<CatchUpMode, CatchUpLane> = {
    full: {
      inFlight: null,
      requestedGeneration: 0,
      completedGeneration: 0,
      requestedSweep: null,
    },
    'missing-only': {
      inFlight: null,
      requestedGeneration: 0,
      completedGeneration: 0,
      requestedSweep: null,
    },
  };

  const pullScopeKey = (target: ProactiveContentPullTarget) =>
    JSON.stringify([
      target.projectId,
      target.workspaceId,
      target.resourceTeamId,
      target.viewerMemberId,
      target.ownerMemberId,
    ]);

  const outcomeCoversVersion = (
    outcome: ProactiveContentPullOutcome | null | undefined,
    version: number | undefined,
  ): outcome is SuccessfulPullOutcome => {
    if (outcome?.status === 'revoked') return true;
    if (outcome?.status !== 'pulled') return false;
    if (outcome.version == null) return false;
    if (version == null) return true;
    return outcome.version >= version;
  };

  async function shouldPull(
    event: ProactiveContentPullEvent,
    ownerHint?: string,
  ): Promise<PullDecision> {
    const projectId = event.projectId;
    if (!projectId) {
      return { kind: 'skip', retryable: false, reason: 'invalid' };
    }
    const binding = deps.getLocalBinding(projectId);
    if (binding?.visibility === 'personal') {
      return { kind: 'skip', retryable: false, reason: 'personal' };
    }
    const targetWorkspaceId = binding?.workspaceId ?? event.workspaceId;
    // An unbound project has no local scope witness, so the hub event must
    // carry one. Existing team bindings keep supporting legacy events that
    // omit workspaceId.
    if (!targetWorkspaceId) {
      return { kind: 'skip', retryable: false, reason: 'invalid' };
    }
    if (event.workspaceId && targetWorkspaceId !== event.workspaceId) {
      return { kind: 'skip', retryable: false, reason: 'scope-mismatch' };
    }
    // Identity and ownership are independent, read-only guards. Start both
    // cold reads together: in the Vela-backed runtime each may spawn its own
    // CLI/network round-trip, so serializing them adds their latencies before
    // a pull can even begin. Promise.allSettled keeps every decision
    // fail-closed while preserving the existing priority: identity validity
    // and workspace scope are established before an owner result is trusted.
    const startRead = <T>(read: () => Promise<T>): Promise<T> => {
      try {
        return Promise.resolve(read());
      } catch (error) {
        return Promise.reject(error);
      }
    };
    const identityRead = startRead(() => deps.getWorkspaceIdentity());
    const ownerRead = ownerHint?.trim()
      ? Promise.resolve(ownerHint.trim())
      : startRead(() => deps.resolveSharedProjectOwner(projectId));
    const [identityResult, ownerResult] = await Promise.allSettled([
      identityRead,
      ownerRead,
    ]);
    if (identityResult.status === 'rejected') {
      deps.onError?.(identityResult.reason);
      return { kind: 'skip', retryable: true, reason: 'identity-error' };
    }
    const identity = identityResult.value;
    if (!identity) {
      return { kind: 'skip', retryable: true, reason: 'identity-missing' };
    }
    if (identity.workspaceId !== targetWorkspaceId) {
      return { kind: 'skip', retryable: false, reason: 'scope-mismatch' };
    }
    // Fail-closed ownership: pulling over the single writer's working tree is
    // destructive, so an unresolvable owner refuses the pull rather than
    // guessing.
    if (ownerResult.status === 'rejected') {
      return { kind: 'skip', retryable: true, reason: 'owner-error' };
    }
    const owner = ownerResult.value;
    if (!owner) {
      return { kind: 'skip', retryable: false, reason: 'owner-missing' };
    }
    if (owner === identity.workspaceMemberId) {
      return { kind: 'skip', retryable: false, reason: 'self-owner' };
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
  ): Promise<ProjectPullCompletion> {
    const { projectId } = target;
    const scopeKey = pullScopeKey(target);
    const run = (async (): Promise<ProjectPullCompletion> => {
      let outcome: ProactiveContentPullOutcome | null = null;
      try {
        outcome = await deps.pullSharedProject(target);
        if (outcome?.status !== 'pulled') return { scopeKey, outcome };
        // Advance the cursor only with the version the pull itself reported
        // as materialized — trusting the event's number here could mark
        // content as landed that never reached disk.
        if (outcome.version == null) return { scopeKey, outcome };
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
        return { scopeKey, outcome };
      } catch (error) {
        // Silent degradation: the web's status polling keeps pulling as the
        // fallback, and the cursor stays behind so the next event retries.
        deps.onError?.(error);
        return { scopeKey, outcome: null };
      } finally {
        const generation = (completionGenerations.get(scopeKey) ?? 0) + 1;
        completionGenerations.set(scopeKey, generation);
        if (outcomeCoversVersion(outcome, undefined)) {
          successfulCompletions.set(scopeKey, { generation, outcome });
        }
      }
    })();
    projectPulls.set(projectId, run);
    try {
      return await run;
    } finally {
      if (projectPulls.get(projectId) === run) projectPulls.delete(projectId);
    }
  }

  function provisionalIntentKey(
    event: ProactiveContentPullEvent,
  ): string | null {
    if (!event.projectId) return null;
    const binding = deps.getLocalBinding(event.projectId);
    return JSON.stringify([
      'pending-guard',
      event.projectId,
      binding?.workspaceId ?? event.workspaceId ?? null,
    ]);
  }

  function cancelIntentTimer(intent: PullIntent): void {
    if (intent.timer == null) return;
    scheduler.clearTimeout(intent.timer);
    intent.timer = null;
  }

  function clearIntent(intent: PullIntent): void {
    cancelIntentTimer(intent);
    if (intents.get(intent.key) === intent) intents.delete(intent.key);
  }

  function createIntent(
    key: string,
    event: ProactiveContentPullEvent,
    force: boolean,
    target?: ProactiveContentPullTarget,
  ): PullIntent {
    return {
      key,
      event: { ...event },
      force,
      ...(event.version != null ? { desiredVersion: event.version } : {}),
      ...(target
        ? {
            expectedScopeKey: key,
            guardedTarget: target,
          }
        : {}),
      failures: 0,
      revision: 0,
      timer: null,
      driving: null,
    };
  }

  function mergeIntentUpdate(
    intent: PullIntent,
    event: ProactiveContentPullEvent,
    force: boolean,
  ): boolean {
    const incomingVersion = event.version;
    const higherVersion =
      incomingVersion != null &&
      (intent.desiredVersion == null || incomingVersion > intent.desiredVersion);
    const strongerForce = force && !intent.force;
    if (higherVersion) {
      intent.desiredVersion = incomingVersion;
      intent.event = { ...event };
    }
    if (strongerForce) intent.force = true;
    if (higherVersion || strongerForce) intent.revision += 1;
    return higherVersion || strongerForce;
  }

  function mergeIntentState(
    target: PullIntent,
    source: PullIntent,
  ): boolean {
    const changed = mergeIntentUpdate(target, source.event, source.force);
    target.failures = Math.max(target.failures, source.failures);
    return changed;
  }

  function retryDelay(failures: number): number {
    const ceiling = Math.min(30_000, 1_000 * (2 ** Math.max(0, failures - 1)));
    const jitter = Math.min(1, Math.max(0, random()));
    return Math.round((ceiling / 2) + ((ceiling / 2) * jitter));
  }

  function scheduleRetry(intent: PullIntent): void {
    if (disposed || intents.get(intent.key) !== intent || intent.timer != null) {
      return;
    }
    intent.failures += 1;
    const delayMs = retryDelay(intent.failures);
    let handle: unknown;
    handle = scheduler.setTimeout(async () => {
      if (intent.timer !== handle) return;
      intent.timer = null;
      await driveIntent(intent);
    }, delayMs);
    intent.timer = handle;
    (
      handle as { unref?: () => void } | null | undefined
    )?.unref?.();
  }

  async function attemptIntent(intent: PullIntent): Promise<PullAttempt> {
    try {
      let target = intent.guardedTarget;
      delete intent.guardedTarget;
      if (!target) {
        const decision = await shouldPull(intent.event);
        if (decision.kind === 'skip') {
          const establishedIdentityGone =
            intent.expectedScopeKey != null &&
            decision.reason === 'identity-missing';
          return {
            kind:
              !decision.retryable || establishedIdentityGone
                ? 'stopped'
                : 'failed',
            staleGuard: true,
          };
        }
        target = decision.target;
      }
      const { projectId } = target;
      const scopeKey = pullScopeKey(target);
      if (intent.expectedScopeKey && intent.expectedScopeKey !== scopeKey) {
        return { kind: 'stopped' };
      }
      if (!intent.expectedScopeKey) {
        const previousKey = intent.key;
        const existing = intents.get(scopeKey);
        if (existing && existing !== intent) {
          const wake = mergeIntentState(existing, intent);
          if (intents.get(previousKey) === intent) intents.delete(previousKey);
          cancelIntentTimer(intent);
          if (wake) {
            cancelIntentTimer(existing);
            existing.guardedTarget = target;
          }
          return { kind: 'merged', intent: existing };
        }
        if (intents.get(previousKey) === intent) intents.delete(previousKey);
        intent.key = scopeKey;
        intent.expectedScopeKey = scopeKey;
        intents.set(scopeKey, intent);
      }
      const completionGenerationBeforeProbe =
        completionGenerations.get(scopeKey) ?? 0;
      if (intent.force && deps.hasMaterializedProject) {
        try {
          // The missing-only sweep selected this project from an earlier
          // manifest probe. A concurrent full sweep may have materialized it
          // while owner/scope checks were in flight, so close that window
          // before forcing a download. This observes real bytes, unlike the
          // durable version cursor that missing-only intentionally ignores.
          if (intent.skipNextForceProbe) {
            delete intent.skipNextForceProbe;
          } else if (await deps.hasMaterializedProject(projectId)) {
            // The outer missing-only probe can go stale while owner/scope/head
            // checks run. Seeing bytes now only withdraws the forced-download
            // requirement; the version cursor still has to cover the head.
            intent.force = false;
          } else {
            const completedDuringProbe = successfulCompletions.get(scopeKey);
            if (
              completedDuringProbe &&
              completedDuringProbe.generation > completionGenerationBeforeProbe &&
              outcomeCoversVersion(
                completedDuringProbe.outcome,
                intent.desiredVersion,
              )
            ) {
              return { kind: 'satisfied' };
            }
          }
        } catch (error) {
          deps.onError?.(error);
          return { kind: 'failed' };
        }
      }
      const cursor = pulledVersions.get(scopeKey);
      if (
        !intent.force &&
        intent.desiredVersion != null &&
        cursor != null &&
        cursor >= intent.desiredVersion
      ) {
        return { kind: 'satisfied' };
      }
      const running = projectPulls.get(projectId);
      if (running) {
        const completion = await running;
        // A completion from another resource scope is never proof for this
        // intent. Loop through every guard again before deciding what to do.
        if (completion.scopeKey !== scopeKey) return { kind: 'retry-now' };
        if (completion.outcome?.status === 'revoked') {
          return { kind: 'revoked' };
        }
        if (
          outcomeCoversVersion(completion.outcome, intent.desiredVersion)
        ) {
          return { kind: 'satisfied' };
        }
        return { kind: 'retry-now' };
      }
      const completion = await runPull(target);
      if (completion.outcome?.status === 'revoked') {
        return { kind: 'revoked' };
      }
      return outcomeCoversVersion(
        completion.outcome,
        intent.desiredVersion,
      )
        ? { kind: 'satisfied' }
        : { kind: 'failed' };
    } catch (error) {
      deps.onError?.(error);
      return { kind: 'failed' };
    }
  }

  async function runIntent(intent: PullIntent): Promise<boolean> {
    while (!disposed && intents.get(intent.key) === intent) {
      const revision = intent.revision;
      const result = await attemptIntent(intent);
      // Revocation is authoritative even when a newer event arrived while the
      // pull was in flight.
      if (result.kind === 'revoked') {
        clearIntent(intent);
        return true;
      }
      if (result.kind === 'merged') {
        if (
          result.intent.timer == null &&
          result.intent.driving == null
        ) {
          return await driveIntent(result.intent);
        }
        return result.intent.driving
          ? await result.intent.driving
          : false;
      }
      // A freshly verified event can migrate this same provisional intent
      // while its old guard is still awaiting identity/owner I/O. Ignore only
      // that stale guard's terminal answer and loop into guardedTarget. A
      // completed pull that already covers the merged desired version remains
      // satisfied; treating every revision change as stale would duplicate the
      // full-sweep/missing-only shared pull.
      if (
        result.kind === 'stopped' &&
        result.staleGuard &&
        intent.revision !== revision
      ) {
        continue;
      }
      if (result.kind === 'satisfied' || result.kind === 'stopped') {
        clearIntent(intent);
        return true;
      }
      if (result.kind === 'retry-now' || intent.revision !== revision) {
        continue;
      }
      scheduleRetry(intent);
      return false;
    }
    return true;
  }

  function driveIntent(intent: PullIntent): Promise<boolean> {
    if (disposed || intents.get(intent.key) !== intent) {
      return Promise.resolve(true);
    }
    if (intent.driving) return intent.driving;
    const run = runIntent(intent);
    intent.driving = run;
    const clearDriving = () => {
      if (intent.driving === run) intent.driving = null;
    };
    // A `.finally()` call creates a second promise that mirrors rejection; if
    // nobody observes that derived promise it can surface as an unhandled
    // rejection even when the original `run` is awaited by its caller.
    void run.then(clearDriving, clearDriving);
    return run;
  }

  async function processContentChanged(
    event: ProactiveContentPullEvent,
    ownerHint?: string,
    force = false,
  ): Promise<boolean> {
    try {
      const provisionalKey = provisionalIntentKey(event);
      if (!provisionalKey) return true;
      const decision = await shouldPull(event, ownerHint);
      if (decision.kind === 'skip') {
        if (!decision.retryable) return true;
        let pending = intents.get(provisionalKey);
        if (!pending) {
          pending = createIntent(provisionalKey, event, force);
          intents.set(provisionalKey, pending);
          scheduleRetry(pending);
          return false;
        }
        const wake = mergeIntentUpdate(pending, event, force);
        if (wake) {
          cancelIntentTimer(pending);
          scheduleRetry(pending);
        }
        return pending.driving ? await pending.driving : false;
      }

      const { target } = decision;
      const key = pullScopeKey(target);
      let effectiveForce = force;
      let forceProbeAlreadyRan = false;
      if (force && deps.hasMaterializedProject) {
        const generationBeforeProbe =
          completionGenerations.get(key) ?? 0;
        try {
          forceProbeAlreadyRan = true;
          if (await deps.hasMaterializedProject(target.projectId)) {
            effectiveForce = false;
          } else {
            const completedDuringProbe = successfulCompletions.get(key);
            if (
              completedDuringProbe &&
              completedDuringProbe.generation > generationBeforeProbe &&
              outcomeCoversVersion(
                completedDuringProbe.outcome,
                event.version,
              )
            ) {
              return true;
            }
          }
        } catch (error) {
          deps.onError?.(error);
          return false;
        }
      }
      let intent = intents.get(key);
      const pending = intents.get(provisionalKey);
      let absorbedWake = false;
      let migrated = false;
      if (pending && pending !== intent) {
        if (intent) {
          absorbedWake = mergeIntentState(intent, pending);
          clearIntent(pending);
        } else {
          cancelIntentTimer(pending);
          if (intents.get(provisionalKey) === pending) {
            intents.delete(provisionalKey);
          }
          pending.key = key;
          pending.expectedScopeKey = key;
          pending.guardedTarget = target;
          // A timer callback may already be awaiting the provisional guard.
          // Keep that one drive, but make its eventual result stale so it loops
          // and consumes the freshly verified target instead of clearing or
          // backing off this migrated intent.
          if (pending.driving) pending.revision += 1;
          intent = pending;
          migrated = true;
          intents.set(key, intent);
        }
      }
      if (!intent) {
        intent = createIntent(key, event, effectiveForce, target);
        if (effectiveForce && forceProbeAlreadyRan) {
          intent.skipNextForceProbe = true;
        }
        intents.set(key, intent);
        return await driveIntent(intent);
      }
      if (force && !effectiveForce) {
        intent.force = false;
        delete intent.skipNextForceProbe;
        const cursor = pulledVersions.get(key);
        const desired = Math.max(
          intent.desiredVersion ?? Number.NEGATIVE_INFINITY,
          event.version ?? Number.NEGATIVE_INFINITY,
        );
        if (Number.isFinite(desired) && cursor != null && cursor >= desired) {
          clearIntent(intent);
          return true;
        }
      }
      const mergedWake = mergeIntentUpdate(intent, event, effectiveForce);
      const wake = migrated || mergedWake || absorbedWake;
      if (effectiveForce && forceProbeAlreadyRan) {
        intent.skipNextForceProbe = true;
      }
      if (!wake) {
        return intent.driving ? await intent.driving : false;
      }
      cancelIntentTimer(intent);
      intent.guardedTarget = target;
      return await driveIntent(intent);
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
    mode: CatchUpMode,
    expectedWorkspaceId?: string,
  ): Promise<void> {
    const lane = catchUpLanes[mode];
    lane.requestedGeneration += 1;
    // The newest verified scope supersedes pending work on this lane. The
    // other mode remains independent and may run concurrently.
    lane.requestedSweep = {
      ...(expectedWorkspaceId ? { expectedWorkspaceId } : {}),
    };
    if (lane.inFlight) {
      return lane.inFlight;
    }
    const run = (async () => {
      while (lane.completedGeneration < lane.requestedGeneration) {
        const generation = lane.requestedGeneration;
        const next = lane.requestedSweep ?? {};
        lane.requestedSweep = null;
        await runCatchUpSweep(mode, next.expectedWorkspaceId);
        lane.completedGeneration = generation;
      }
    })();
    lane.inFlight = run;
    try {
      await run;
    } finally {
      if (lane.inFlight === run) lane.inFlight = null;
    }
  }

  return {
    async handleContentChanged(event: ProactiveContentPullEvent): Promise<void> {
      await processContentChanged(event);
    },
    catchUpPublishedHeads: (workspaceId) => requestCatchUp('full', workspaceId),
    materializeMissingProjects: (workspaceId) =>
      requestCatchUp('missing-only', workspaceId),
    dispose(): void {
      if (disposed) return;
      disposed = true;
      for (const intent of intents.values()) clearIntent(intent);
      intents.clear();
    },
  };
}
