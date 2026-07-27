import type {
  WorkspaceBillingRevisionClock,
  WorkspaceBillingRuntimeState,
  WorkspaceBillingSnapshot,
  WorkspaceWalletBalance,
} from '@open-design/contracts';
import type { VelaWorkspaceBillingProjection } from '../integrations/vela-billing.js';

const DEFAULT_POLL_INTERVAL_MS = 30_000;
const DEFAULT_RETRY_DELAYS_MS = [5_000, 15_000, 30_000] as const;

export interface WorkspaceBillingRuntimeKey {
  workspaceId: string;
  workspaceMemberId: string;
}

export interface WorkspaceBillingRuntimeReadOptions {
  reason?: string;
  clientId?: string;
  clientGeneration?: string;
}

export interface WorkspaceBillingRuntimeResult {
  projection: VelaWorkspaceBillingProjection;
  state: WorkspaceBillingRuntimeState;
}

export type WorkspaceBillingInvalidationDomain =
  | 'legacy'
  | 'subscription'
  | 'wallet';

export interface WorkspaceBillingRuntimeInvalidation {
  domain: WorkspaceBillingInvalidationDomain;
  workspaceId?: string;
  workspaceMemberId?: string;
  revision?: string;
  revisionClock?: WorkspaceBillingRevisionClock;
  reason?: string;
}

export interface WorkspaceBillingRuntimeScheduler {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>;
  clearTimeout(timer: ReturnType<typeof setTimeout>): void;
  setInterval(callback: () => void, delayMs: number): ReturnType<typeof setInterval>;
  clearInterval(timer: ReturnType<typeof setInterval>): void;
}

export interface WorkspaceBillingRuntimeCoordinatorOptions {
  fetchProjection(key: WorkspaceBillingRuntimeKey): Promise<VelaWorkspaceBillingProjection>;
  scheduler?: WorkspaceBillingRuntimeScheduler;
  pollIntervalMs?: number;
  retryDelaysMs?: readonly number[];
  onStateChange?: (state: WorkspaceBillingRuntimeState) => void;
}

interface ClientInterest {
  generation: bigint;
  key: string;
}

interface RuntimeEntry {
  key: WorkspaceBillingRuntimeKey;
  /** Headerless clients predate explicit interest generations and stay pinned. */
  legacyInterest: boolean;
  projection: VelaWorkspaceBillingProjection;
  status: WorkspaceBillingRuntimeState['status'];
  revision: bigint;
  observedAt: number | null;
  retryAt: number | null;
  errorCode: string | null;
  reason: string;
  sourceGapDetected: boolean;
  sourceRevisions: Partial<Record<WorkspaceBillingInvalidationDomain, string>>;
  sourceRevisionClocks: Partial<
    Record<WorkspaceBillingInvalidationDomain, WorkspaceBillingRevisionClock>
  >;
  retiredRevisionClockEpochs: {
    subscription: Set<string>;
    wallet: Set<string>;
  };
  inFlight: Promise<void> | null;
  pending: boolean;
  pendingReason: string | null;
  attempt: bigint;
  retryAttempt: number;
  retryTimer: ReturnType<typeof setTimeout> | null;
  waiters: Array<() => void>;
}

const EMPTY_PROJECTION: VelaWorkspaceBillingProjection = {
  snapshot: null,
  workspaceBalance: null,
};

export class WorkspaceBillingInterestError extends Error {
  constructor(
    readonly code: 'invalid_generation' | 'stale_generation' | 'generation_payload_mismatch',
    readonly acceptedGeneration?: string,
  ) {
    super(code);
    this.name = 'WorkspaceBillingInterestError';
  }
}

export class WorkspaceBillingAccessRevokedError extends Error {
  readonly code = 'workspace_not_authorized';

  constructor() {
    super('workspace billing access revoked');
    this.name = 'WorkspaceBillingAccessRevokedError';
  }
}

/**
 * Sole writer for exact workspace/member billing projections.
 *
 * Network reads, SSE events, reconnect hooks, and poll timers only submit
 * invalidations here. Per-key single-flight plus one trailing refresh prevents
 * event bursts from serializing unrelated work or allowing a late read for one
 * workspace/member to overwrite another.
 */
export class WorkspaceBillingRuntimeCoordinator {
  private readonly entries = new Map<string, RuntimeEntry>();
  private readonly clients = new Map<string, ClientInterest>();
  private readonly scheduler: WorkspaceBillingRuntimeScheduler;
  private readonly pollIntervalMs: number;
  private readonly retryDelaysMs: readonly number[];
  private readonly pollTimer: ReturnType<typeof setInterval>;
  private disposed = false;

  constructor(private readonly options: WorkspaceBillingRuntimeCoordinatorOptions) {
    this.scheduler = options.scheduler ?? defaultScheduler();
    this.pollIntervalMs = Math.max(1, options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
    this.retryDelaysMs =
      options.retryDelaysMs?.map((delay) => Math.max(0, delay)) ??
      DEFAULT_RETRY_DELAYS_MS;
    this.pollTimer = this.scheduler.setInterval(() => {
      this.refreshAll('poll-floor');
    }, this.pollIntervalMs);
    this.pollTimer.unref?.();
  }

  async read(
    keyInput: WorkspaceBillingRuntimeKey,
    options: WorkspaceBillingRuntimeReadOptions = {},
  ): Promise<WorkspaceBillingRuntimeResult> {
    this.assertUsable();
    const key = normalizeKey(keyInput);
    const entry = this.entryFor(key);
    const forceForInterest = this.acceptClientInterest(entry, options);
    if (entry.retryTimer && !forceForInterest) {
      return this.result(entry);
    }
    if (
      entry.status !== 'fresh' ||
      entry.observedAt == null ||
      this.scheduler.now() - entry.observedAt >= this.pollIntervalMs ||
      forceForInterest
    ) {
      this.requestRefresh(entry, options.reason ?? 'explicit-read', forceForInterest);
      await this.waitForIdle(entry);
    }
    return this.result(entry);
  }

  invalidate(invalidation: WorkspaceBillingRuntimeInvalidation): void {
    if (this.disposed) return;
    const workspaceId = invalidation.workspaceId?.trim() ?? '';
    const workspaceMemberId = invalidation.workspaceMemberId?.trim() ?? '';
    for (const entry of this.entries.values()) {
      if (workspaceId && entry.key.workspaceId !== workspaceId) continue;
      if (!this.hasActiveInterest(entry)) continue;
      if (invalidation.domain === 'wallet') {
        if (!workspaceId || !workspaceMemberId) continue;
        if (entry.key.workspaceMemberId !== workspaceMemberId) continue;
      }
      if (entry.status === 'access-revoked') continue;
      const revisionClock = normalizeRevisionClock(invalidation.revisionClock);
      const clockDomain =
        invalidation.domain === 'wallet' ? 'wallet' : 'subscription';
      const previousClock = entry.sourceRevisionClocks[clockDomain];
      const revisionResult = revisionClock
        ? acceptFencedSourceRevisionClock(
            previousClock,
            revisionClock,
            entry.retiredRevisionClockEpochs[clockDomain],
          )
        : acceptSourceRevision(
            entry.sourceRevisions[invalidation.domain],
            invalidation.revision,
          );
      if (!revisionResult.accepted) continue;
      if (revisionClock) {
        if (clockDomain === 'subscription') {
          // Current producers emit one subscription write as both the v2
          // event and its legacy billing alias. A valid billing clock is the
          // shared identity across those aliases, independent of arrival
          // order, so the second frame must not schedule a trailing refresh.
          entry.sourceRevisionClocks.subscription = revisionClock;
          entry.sourceRevisionClocks.legacy = revisionClock;
        } else {
          entry.sourceRevisionClocks.wallet = revisionClock;
        }
      } else if (invalidation.revision) {
        entry.sourceRevisions[invalidation.domain] = invalidation.revision;
      }
      entry.sourceGapDetected = revisionResult.gap;
      const reason =
        revisionResult.gap
          ? 'revision-gap'
          : revisionResult.epochChanged
            ? 'revision-epoch-change'
            : invalidation.reason ?? `${invalidation.domain}-invalidation`;
      this.markStatus(entry, hasProjection(entry) ? 'stale' : 'loading', reason);
      this.requestRefresh(entry, reason, true);
    }
  }

  reconnect(workspaceId?: string): void {
    if (this.disposed) return;
    const requested = workspaceId?.trim() ?? '';
    for (const entry of this.entries.values()) {
      if (requested && entry.key.workspaceId !== requested) continue;
      if (!this.hasActiveInterest(entry)) continue;
      if (entry.status === 'access-revoked') continue;
      this.markStatus(entry, hasProjection(entry) ? 'stale' : 'loading', 'reconnect');
      this.requestRefresh(entry, 'reconnect', true);
    }
  }

  refreshAll(reason = 'catch-up'): void {
    if (this.disposed) return;
    for (const entry of this.entries.values()) {
      if (!this.hasActiveInterest(entry)) continue;
      if (entry.status === 'access-revoked') continue;
      if (reason === 'poll-floor' && entry.retryTimer) continue;
      this.markStatus(entry, hasProjection(entry) ? 'stale' : 'loading', reason);
      this.requestRefresh(entry, reason, true);
    }
  }

  markWorkspaceUnavailable(
    workspaceId: string,
    error = 'workspace_directory_unavailable',
  ): void {
    const requested = workspaceId.trim();
    if (!requested) return;
    for (const entry of this.entries.values()) {
      if (entry.key.workspaceId !== requested || entry.status === 'access-revoked') continue;
      if (
        entry.status === 'error' &&
        entry.errorCode === error &&
        entry.retryTimer
      ) {
        continue;
      }
      entry.status = 'error';
      entry.errorCode = error;
      entry.reason = error;
      entry.revision += 1n;
      this.scheduleRetry(entry);
      this.publish(entry);
    }
  }

  revokeWorkspace(workspaceId: string, reason = 'workspace-not-authorized'): void {
    const requested = workspaceId.trim();
    if (!requested) return;
    for (const entry of this.entries.values()) {
      if (entry.key.workspaceId !== requested) continue;
      this.revokeEntry(entry, reason);
    }
  }

  retainWorkspaceMember(workspaceId: string, workspaceMemberId: string): void {
    const requestedWorkspaceId = workspaceId.trim();
    const requestedMemberId = workspaceMemberId.trim();
    if (!requestedWorkspaceId || !requestedMemberId) return;
    for (const entry of this.entries.values()) {
      if (
        entry.key.workspaceId === requestedWorkspaceId &&
        entry.key.workspaceMemberId !== requestedMemberId
      ) {
        this.revokeEntry(entry, 'workspace-member-changed');
      }
    }
  }

  authorizeWorkspaceMember(keyInput: WorkspaceBillingRuntimeKey): void {
    const key = normalizeKey(keyInput);
    const entry = this.entries.get(runtimeKey(key));
    if (!entry || entry.status !== 'access-revoked') return;
    entry.status = 'loading';
    entry.errorCode = null;
    entry.reason = 'membership-reauthorized';
    entry.observedAt = null;
    entry.revision += 1n;
  }

  peek(keyInput: WorkspaceBillingRuntimeKey): WorkspaceBillingRuntimeResult | null {
    const key = normalizeKey(keyInput);
    const entry = this.entries.get(runtimeKey(key));
    return entry ? this.result(entry) : null;
  }

  peekForClient(clientId: string, workspaceId: string): WorkspaceBillingRuntimeResult | null {
    const interest = this.clients.get(clientId.trim());
    if (!interest) return null;
    const entry = this.entries.get(interest.key);
    if (!entry || entry.key.workspaceId !== workspaceId.trim()) return null;
    return this.result(entry);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.scheduler.clearInterval(this.pollTimer);
    for (const entry of this.entries.values()) {
      if (entry.retryTimer) this.scheduler.clearTimeout(entry.retryTimer);
      entry.retryTimer = null;
      entry.pending = false;
      this.resolveWaiters(entry);
    }
    this.entries.clear();
    this.clients.clear();
  }

  private acceptClientInterest(
    entry: RuntimeEntry,
    options: WorkspaceBillingRuntimeReadOptions,
  ): boolean {
    const clientId = options.clientId?.trim() ?? '';
    const generationText = options.clientGeneration?.trim() ?? '';
    if (!clientId && !generationText) {
      entry.legacyInterest = true;
      return false;
    }
    if (!clientId || !/^(?:0|[1-9]\d*)$/.test(generationText)) {
      throw new WorkspaceBillingInterestError('invalid_generation');
    }
    const generation = BigInt(generationText);
    const keyText = runtimeKey(entry.key);
    const current = this.clients.get(clientId);
    if (current) {
      if (generation < current.generation) {
        throw new WorkspaceBillingInterestError(
          'stale_generation',
          current.generation.toString(),
        );
      }
      if (generation === current.generation) {
        if (current.key !== keyText) {
          throw new WorkspaceBillingInterestError(
            'generation_payload_mismatch',
            current.generation.toString(),
          );
        }
        return false;
      }
    }
    this.clients.set(clientId, { generation, key: keyText });
    if (current && current.key !== keyText) {
      const previousEntry = this.entries.get(current.key);
      if (previousEntry) this.quietIfUninterested(previousEntry);
    }
    return current != null;
  }

  private entryFor(key: WorkspaceBillingRuntimeKey): RuntimeEntry {
    const keyText = runtimeKey(key);
    const existing = this.entries.get(keyText);
    if (existing) return existing;
    const entry: RuntimeEntry = {
      key,
      legacyInterest: false,
      projection: EMPTY_PROJECTION,
      status: 'loading',
      revision: 0n,
      observedAt: null,
      retryAt: null,
      errorCode: null,
      reason: 'first-interest',
      sourceGapDetected: false,
      sourceRevisions: {},
      sourceRevisionClocks: {},
      retiredRevisionClockEpochs: {
        subscription: new Set(),
        wallet: new Set(),
      },
      inFlight: null,
      pending: false,
      pendingReason: null,
      attempt: 0n,
      retryAttempt: 0,
      retryTimer: null,
      waiters: [],
    };
    this.entries.set(keyText, entry);
    return entry;
  }

  private hasActiveInterest(entry: RuntimeEntry): boolean {
    if (entry.legacyInterest) return true;
    const keyText = runtimeKey(entry.key);
    for (const interest of this.clients.values()) {
      if (interest.key === keyText) return true;
    }
    return false;
  }

  private quietIfUninterested(entry: RuntimeEntry): void {
    if (this.hasActiveInterest(entry)) return;
    if (entry.retryTimer) this.scheduler.clearTimeout(entry.retryTimer);
    entry.retryTimer = null;
    entry.retryAt = null;
    entry.pending = false;
    entry.pendingReason = null;
  }

  private requestRefresh(entry: RuntimeEntry, reason: string, force: boolean): void {
    if (entry.status === 'access-revoked') return;
    if (entry.inFlight) {
      if (force) {
        entry.pending = true;
        entry.pendingReason = strongerReason(entry.pendingReason, reason);
      }
      return;
    }
    this.startRefresh(entry, reason);
  }

  private startRefresh(entry: RuntimeEntry, reason: string): void {
    if (this.disposed) return;
    if (entry.retryTimer) {
      this.scheduler.clearTimeout(entry.retryTimer);
      entry.retryTimer = null;
      entry.retryAt = null;
    }
    const attempt = ++entry.attempt;
    this.markStatus(
      entry,
      hasProjection(entry) ? 'refreshing' : 'loading',
      reason,
    );
    entry.inFlight = this.options
      .fetchProjection(entry.key)
      .then((projection) => {
        if (entry.attempt !== attempt || this.disposed) return;
        validateProjectionScope(entry.key, projection);
        validateProjectionRevision(entry, projection);
        recordProjectionRevisions(entry, projection);
        entry.projection = cloneProjection(projection);
        entry.observedAt = this.scheduler.now();
        entry.retryAt = null;
        entry.errorCode = null;
        entry.retryAttempt = 0;
        entry.revision += 1n;
        entry.status = 'fresh';
        entry.reason = reason;
        this.publish(entry);
      })
      .catch((error: unknown) => {
        if (entry.attempt !== attempt || this.disposed) return;
        const code = errorCode(error);
        if (isAccessRevokedError(error)) {
          this.revokeEntry(entry, code);
          return;
        }
        entry.status = 'error';
        entry.errorCode = code;
        entry.reason = reason;
        entry.revision += 1n;
        this.scheduleRetry(entry);
        this.publish(entry);
      })
      .finally(() => {
        if (entry.attempt !== attempt) return;
        entry.inFlight = null;
        if (entry.pending && !this.disposed && entry.status !== 'access-revoked') {
          const trailingReason = entry.pendingReason ?? 'trailing-invalidation';
          entry.pending = false;
          entry.pendingReason = null;
          this.startRefresh(entry, trailingReason);
          return;
        }
        this.resolveWaiters(entry);
      });
  }

  private scheduleRetry(entry: RuntimeEntry): void {
    if (entry.retryTimer || this.retryDelaysMs.length === 0 || this.disposed) return;
    if (entry.retryAttempt >= this.retryDelaysMs.length) return;
    const delay = this.retryDelaysMs[entry.retryAttempt]!;
    entry.retryAttempt += 1;
    entry.retryAt = this.scheduler.now() + delay;
    entry.retryTimer = this.scheduler.setTimeout(() => {
      entry.retryTimer = null;
      entry.retryAt = null;
      if (entry.status === 'access-revoked' || this.disposed) return;
      this.requestRefresh(entry, 'bounded-retry', true);
    }, delay);
    entry.retryTimer.unref?.();
  }

  private revokeEntry(entry: RuntimeEntry, reason: string): void {
    entry.attempt += 1n;
    entry.inFlight = null;
    entry.pending = false;
    entry.pendingReason = null;
    if (entry.retryTimer) this.scheduler.clearTimeout(entry.retryTimer);
    entry.retryTimer = null;
    entry.retryAt = null;
    entry.projection = EMPTY_PROJECTION;
    entry.status = 'access-revoked';
    entry.errorCode = 'workspace_not_authorized';
    entry.reason = reason;
    entry.observedAt = this.scheduler.now();
    entry.revision += 1n;
    this.publish(entry);
    this.resolveWaiters(entry);
  }

  private markStatus(
    entry: RuntimeEntry,
    status: WorkspaceBillingRuntimeState['status'],
    reason: string,
  ): void {
    if (entry.status === status && entry.reason === reason) return;
    entry.status = status;
    entry.reason = reason;
    entry.revision += 1n;
  }

  private waitForIdle(entry: RuntimeEntry): Promise<void> {
    if (!entry.inFlight && !entry.pending) return Promise.resolve();
    return new Promise((resolve) => {
      entry.waiters.push(resolve);
    });
  }

  private resolveWaiters(entry: RuntimeEntry): void {
    const waiters = entry.waiters.splice(0);
    for (const resolve of waiters) resolve();
  }

  private result(entry: RuntimeEntry): WorkspaceBillingRuntimeResult {
    return {
      projection: cloneProjection(entry.projection),
      state: this.state(entry),
    };
  }

  private state(entry: RuntimeEntry): WorkspaceBillingRuntimeState {
    return {
      workspaceId: entry.key.workspaceId,
      workspaceMemberId: entry.key.workspaceMemberId,
      status: entry.status,
      revision: entry.revision.toString(),
      observedAt: timestamp(entry.observedAt),
      retryAt: timestamp(entry.retryAt),
      errorCode: entry.errorCode,
      reason: entry.reason,
      sourceGapDetected: entry.sourceGapDetected,
    };
  }

  private publish(entry: RuntimeEntry): void {
    this.options.onStateChange?.(this.state(entry));
  }

  private assertUsable(): void {
    if (this.disposed) throw new Error('workspace billing runtime is disposed');
  }
}

export function createWorkspaceBillingRuntimeCoordinator(
  options: WorkspaceBillingRuntimeCoordinatorOptions,
): WorkspaceBillingRuntimeCoordinator {
  return new WorkspaceBillingRuntimeCoordinator(options);
}

export function shouldEmitWorkspaceBillingRuntimeNudge(
  state: WorkspaceBillingRuntimeState,
): boolean {
  switch (state.reason) {
    case 'explicit-billing-read':
    case 'vela-billing-changed':
    case 'vela-billing-subscription-changed':
    case 'vela-wallet-balance-changed':
      return false;
    default:
      return true;
  }
}

function defaultScheduler(): WorkspaceBillingRuntimeScheduler {
  return {
    now: () => Date.now(),
    setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
    clearTimeout: (timer) => clearTimeout(timer),
    setInterval: (callback, delayMs) => setInterval(callback, delayMs),
    clearInterval: (timer) => clearInterval(timer),
  };
}

function normalizeKey(input: WorkspaceBillingRuntimeKey): WorkspaceBillingRuntimeKey {
  const workspaceId = input.workspaceId.trim();
  const workspaceMemberId = input.workspaceMemberId.trim();
  if (!workspaceId || !workspaceMemberId) {
    throw new Error('workspace billing runtime requires workspace and member identity');
  }
  return { workspaceId, workspaceMemberId };
}

function runtimeKey(key: WorkspaceBillingRuntimeKey): string {
  return `${key.workspaceId}\0${key.workspaceMemberId}`;
}

function hasProjection(entry: RuntimeEntry): boolean {
  return Boolean(entry.projection.snapshot || entry.projection.workspaceBalance);
}

function validateProjectionScope(
  key: WorkspaceBillingRuntimeKey,
  projection: VelaWorkspaceBillingProjection,
): void {
  const snapshot = projection.snapshot;
  const balance = projection.workspaceBalance;
  if (!snapshot && !balance) throw new Error('workspace_billing_unavailable');
  if (
    snapshot &&
    (
      snapshot.billingScopeVersion !== 2 ||
      snapshot.workspaceId !== key.workspaceId ||
      snapshot.workspaceMemberId !== key.workspaceMemberId
    )
  ) {
    throw new Error('workspace_billing_scope_mismatch');
  }
  if (
    balance &&
    (
      balance.billingScopeVersion !== 2 ||
      balance.workspaceId !== key.workspaceId ||
      balance.workspaceMemberId !== key.workspaceMemberId
    )
  ) {
    throw new Error('workspace_billing_scope_mismatch');
  }
}

function validateProjectionRevision(
  entry: RuntimeEntry,
  projection: VelaWorkspaceBillingProjection,
): void {
  const snapshot = projection.snapshot;
  if (!snapshot) return;
  const expectedBilling =
    entry.sourceRevisions.subscription ?? entry.sourceRevisions.legacy;
  const expectedWallet = entry.sourceRevisions.wallet;
  const expectedBillingClock =
    entry.sourceRevisionClocks.subscription ?? entry.sourceRevisionClocks.legacy;
  const expectedWalletClock = entry.sourceRevisionClocks.wallet;
  const actualBillingClock = normalizeRevisionClock(
    snapshot.revisionClocks?.billing,
  );
  const actualWalletClock = normalizeRevisionClock(
    snapshot.revisionClocks?.wallet,
  );
  const previousSnapshot = entry.projection.snapshot;
  const previousBillingClock = normalizeRevisionClock(
    previousSnapshot?.revisionClocks?.billing,
  );
  const previousWalletClock = normalizeRevisionClock(
    previousSnapshot?.revisionClocks?.wallet,
  );
  const billingClockComparable = Boolean(
    expectedBillingClock && actualBillingClock,
  );
  const walletClockComparable = Boolean(
    expectedWalletClock && actualWalletClock,
  );
  if (
    (expectedBillingClock &&
      actualBillingClock &&
      fencedRevisionClockIsBehind(
        actualBillingClock,
        expectedBillingClock,
        previousBillingClock,
        entry.retiredRevisionClockEpochs.subscription,
      )) ||
    (expectedWalletClock &&
      actualWalletClock &&
      fencedRevisionClockIsBehind(
        actualWalletClock,
        expectedWalletClock,
        previousWalletClock,
        entry.retiredRevisionClockEpochs.wallet,
      )) ||
    (!billingClockComparable &&
      revisionIsBehind(snapshot.revisions.billing, expectedBilling)) ||
    (!walletClockComparable &&
      revisionIsBehind(snapshot.revisions.wallet, expectedWallet))
  ) {
    throw Object.assign(new Error('workspace billing revision not caught up'), {
      code: 'workspace_billing_revision_not_caught_up',
    });
  }
}

function recordProjectionRevisions(
  entry: RuntimeEntry,
  projection: VelaWorkspaceBillingProjection,
): void {
  const snapshot = projection.snapshot;
  if (!snapshot) return;
  const billingClock = normalizeRevisionClock(snapshot.revisionClocks?.billing);
  const walletClock = normalizeRevisionClock(snapshot.revisionClocks?.wallet);
  const previousSnapshot = entry.projection.snapshot;
  const previousBillingClock = normalizeRevisionClock(
    previousSnapshot?.revisionClocks?.billing,
  );
  const previousWalletClock = normalizeRevisionClock(
    previousSnapshot?.revisionClocks?.wallet,
  );
  if (billingClock) {
    retireRevisionClockEpoch(
      entry.retiredRevisionClockEpochs.subscription,
      previousBillingClock,
      billingClock,
    );
    retireRevisionClockEpoch(
      entry.retiredRevisionClockEpochs.subscription,
      entry.sourceRevisionClocks.subscription ??
        entry.sourceRevisionClocks.legacy ??
        null,
      billingClock,
    );
    entry.sourceRevisionClocks.subscription = billingClock;
    entry.sourceRevisionClocks.legacy = billingClock;
  }
  if (walletClock) {
    retireRevisionClockEpoch(
      entry.retiredRevisionClockEpochs.wallet,
      previousWalletClock,
      walletClock,
    );
    retireRevisionClockEpoch(
      entry.retiredRevisionClockEpochs.wallet,
      entry.sourceRevisionClocks.wallet ?? null,
      walletClock,
    );
    entry.sourceRevisionClocks.wallet = walletClock;
  }
  if (revisionCanAdvance(entry.sourceRevisions.subscription, snapshot.revisions.billing)) {
    entry.sourceRevisions.subscription = snapshot.revisions.billing;
  }
  if (revisionCanAdvance(entry.sourceRevisions.legacy, snapshot.revisions.billing)) {
    entry.sourceRevisions.legacy = snapshot.revisions.billing;
  }
  if (revisionCanAdvance(entry.sourceRevisions.wallet, snapshot.revisions.wallet)) {
    entry.sourceRevisions.wallet = snapshot.revisions.wallet;
  }
}

function revisionIsBehind(actual: string, expected: string | undefined): boolean {
  if (!expected || !/^\d+$/.test(actual) || !/^\d+$/.test(expected)) return false;
  return BigInt(actual) < BigInt(expected);
}

function revisionCanAdvance(previous: string | undefined, next: string): boolean {
  if (!previous) return true;
  if (previous === next) return false;
  if (/^\d+$/.test(previous) && /^\d+$/.test(next)) {
    return BigInt(next) > BigInt(previous);
  }
  return true;
}

function normalizeRevisionClock(
  value: WorkspaceBillingRevisionClock | undefined,
): WorkspaceBillingRevisionClock | null {
  const epoch = value?.epoch?.trim() ?? '';
  const counter = value?.counter?.trim() ?? '';
  if (!epoch || !/^(?:0|[1-9]\d*)$/.test(counter)) return null;
  return { epoch, counter };
}

function fencedRevisionClockIsBehind(
  actual: WorkspaceBillingRevisionClock,
  expected: WorkspaceBillingRevisionClock,
  previousAuthoritative: WorkspaceBillingRevisionClock | null,
  retiredEpochs: ReadonlySet<string>,
): boolean {
  if (retiredEpochs.has(actual.epoch)) return true;
  if (actual.epoch === expected.epoch) {
    return BigInt(actual.counter) < BigInt(expected.counter);
  }
  // Snapshot reads are producer-fenced: an unseen epoch is the new
  // authoritative baseline even if it advanced again after the thin event.
  // Remaining on the last committed epoch, however, proves the read model has
  // not crossed the event's epoch fence and must fail closed.
  return previousAuthoritative?.epoch === actual.epoch;
}

function retireRevisionClockEpoch(
  retired: Set<string>,
  previous: WorkspaceBillingRevisionClock | null,
  authoritative: WorkspaceBillingRevisionClock,
): void {
  if (previous && previous.epoch !== authoritative.epoch) {
    retired.add(previous.epoch);
  }
}

function cloneProjection(
  projection: VelaWorkspaceBillingProjection,
): VelaWorkspaceBillingProjection {
  return {
    snapshot: cloneSnapshot(projection.snapshot),
    workspaceBalance: cloneBalance(projection.workspaceBalance),
  };
}

function cloneSnapshot(snapshot: WorkspaceBillingSnapshot | null): WorkspaceBillingSnapshot | null {
  if (!snapshot) return null;
  return {
    ...snapshot,
    billing: { ...snapshot.billing },
    wallet: { ...snapshot.wallet },
    revisions: { ...snapshot.revisions },
    ...(snapshot.revisionClocks
      ? {
          revisionClocks: {
            billing: { ...snapshot.revisionClocks.billing },
            wallet: { ...snapshot.revisionClocks.wallet },
          },
        }
      : {}),
  };
}

function cloneBalance(balance: WorkspaceWalletBalance | null): WorkspaceWalletBalance | null {
  return balance ? { ...balance } : null;
}

function timestamp(value: number | null): string | null {
  return value == null ? null : new Date(value).toISOString();
}

function errorCode(error: unknown): string {
  if (
    error &&
    typeof error === 'object' &&
    'code' in error &&
    typeof error.code === 'string' &&
    error.code.trim()
  ) {
    return error.code.trim();
  }
  if (error instanceof Error && error.message.trim()) {
    return error.message.trim().replace(/\s+/g, '_').toLowerCase();
  }
  return 'workspace_billing_refresh_failed';
}

function isAccessRevokedError(error: unknown): boolean {
  const code = errorCode(error);
  return (
    error instanceof WorkspaceBillingAccessRevokedError ||
    code === 'workspace_not_authorized' ||
    code === 'workspace_access_revoked' ||
    code === 'forbidden'
  );
}

function acceptSourceRevision(
  previous: string | undefined,
  next: string | undefined,
): { accepted: boolean; gap: boolean; epochChanged: boolean } {
  const normalized = next?.trim() ?? '';
  if (!normalized) return { accepted: true, gap: false, epochChanged: false };
  if (!previous) return { accepted: true, gap: false, epochChanged: false };
  if (previous === normalized) return { accepted: false, gap: false, epochChanged: false };
  if (/^\d+$/.test(previous) && /^\d+$/.test(normalized)) {
    const oldValue = BigInt(previous);
    const newValue = BigInt(normalized);
    if (newValue <= oldValue) {
      return { accepted: false, gap: false, epochChanged: false };
    }
    return {
      accepted: true,
      gap: newValue > oldValue + 1n,
      epochChanged: false,
    };
  }
  // Opaque tokens support equality dedupe only. A changed token is a safe
  // invalidation; the authoritative read decides the actual value.
  return { accepted: true, gap: false, epochChanged: false };
}

function acceptSourceRevisionClock(
  previous: WorkspaceBillingRevisionClock | undefined,
  next: WorkspaceBillingRevisionClock,
): { accepted: boolean; gap: boolean; epochChanged: boolean } {
  if (!previous) return { accepted: true, gap: false, epochChanged: false };
  if (previous.epoch !== next.epoch) {
    return { accepted: true, gap: false, epochChanged: true };
  }
  const oldValue = BigInt(previous.counter);
  const newValue = BigInt(next.counter);
  if (newValue <= oldValue) {
    return { accepted: false, gap: false, epochChanged: false };
  }
  return {
    accepted: true,
    gap: newValue > oldValue + 1n,
    epochChanged: false,
  };
}

function acceptFencedSourceRevisionClock(
  previous: WorkspaceBillingRevisionClock | undefined,
  next: WorkspaceBillingRevisionClock,
  retiredEpochs: ReadonlySet<string>,
): { accepted: boolean; gap: boolean; epochChanged: boolean } {
  if (retiredEpochs.has(next.epoch) && previous?.epoch !== next.epoch) {
    return { accepted: false, gap: false, epochChanged: false };
  }
  return acceptSourceRevisionClock(previous, next);
}

function strongerReason(current: string | null, next: string): string {
  if (!current) return next;
  const rank = (reason: string): number => {
    if (reason === 'revision-gap' || reason === 'reconnect') return 3;
    if (reason.includes('invalidation')) return 2;
    if (reason === 'poll-floor') return 0;
    return 1;
  };
  return rank(next) >= rank(current) ? next : current;
}
