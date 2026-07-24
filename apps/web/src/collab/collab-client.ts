// Team collaboration client integration. Ties the daemon collab capabilities
// together for a shared-project session: heartbeat presence, poll the published
// head version (so a member knows when to pull), and report author-side changes
// / request a publish. It is the glue the read-only collab view consumes.
//
// Polling-based by design (live cursors were cut; content is polled — the spec).

import type { CollabMemberRole, CollabPresenceMember, ProjectSyncState } from '@open-design/contracts';

// Presence identity is the shared contract DTO; re-export so collab consumers
// keep importing it from the client module.
export type { CollabPresenceMember };

export interface CollabSnapshot {
  present: CollabPresenceMember[];
  publishedVersion: number | null;
  /**  project sync state; null until the first status poll lands. */
  syncState: ProjectSyncState | null;
  /** The member who shared this project (its single writer); null if unshared. */
  ownerMemberId: string | null;
  /**
   * The owner's display name, resolved server-side from the collab-cloud member
   * directory, so the read-only banner can read "这是 麻薯 创建的共享项目" instead
   * of an opaque id. Null when unshared or the owner is not in the directory.
   */
  ownerDisplayName: string | null;
  /** The owner's team role (owner/admin/member), from the same directory entry. */
  ownerRole: CollabMemberRole | null;
}

export interface CollabClientOptions {
  projectId: string;
  /**
   * The presence identity. Nullable because status polling (below) does not
   * need one — a caller can start the client before the identity resolves and
   * supply it later via {@link CollabClient.setMember}. Presence (heartbeat +
   * leave) stays a no-op the whole time `member` is null.
   */
  member: CollabPresenceMember | null;
  /** Injectable for tests; defaults to the global fetch. */
  fetch?: typeof fetch;
  /** Daemon API base; default '' (same origin). */
  baseUrl?: string;
  heartbeatMs?: number;
  statusPollMs?: number;
  onUpdate?: (snapshot: CollabSnapshot) => void;
  onError?: (error: unknown) => void;
}

const DEFAULT_HEARTBEAT_MS = 10_000;
const DEFAULT_STATUS_POLL_MS = 5_000;

export class CollabClient {
  private readonly projectId: string;
  // Mutable — see setMember(). Status polling below never reads this; only
  // heartbeat/leave/leaveBeacon do, and all three no-op while it is null.
  private member: CollabPresenceMember | null;
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;
  private readonly heartbeatMs: number;
  private readonly statusPollMs: number;
  private readonly onUpdate?: CollabClientOptions['onUpdate'];
  private readonly onError?: CollabClientOptions['onError'];
  private readonly timers: ReturnType<typeof setInterval>[] = [];
  private snapshot: CollabSnapshot = {
    present: [],
    publishedVersion: null,
    syncState: null,
    ownerMemberId: null,
    ownerDisplayName: null,
    ownerRole: null,
  };
  private running = false;
  private onVisibilityChange: (() => void) | null = null;

  constructor(options: CollabClientOptions) {
    this.projectId = options.projectId;
    this.member = options.member;
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.baseUrl = options.baseUrl ?? '';
    this.heartbeatMs = Math.max(1_000, options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS);
    this.statusPollMs = Math.max(1_000, options.statusPollMs ?? DEFAULT_STATUS_POLL_MS);
    this.onUpdate = options.onUpdate;
    this.onError = options.onError;
  }

  getSnapshot(): CollabSnapshot {
    return this.snapshot;
  }

  /**
   * Supply (or clear) the presence identity after construction. Status
   * polling is already running by the time an identity typically resolves —
   * this lets the caller hand it in without tearing the client (and its
   * in-flight status poll) down and rebuilding it. Fires an immediate
   * heartbeat when a real member arrives while running, so presence
   * announces itself right away instead of waiting out the next interval
   * tick — the same immediacy `start()` gives a member known up front.
   */
  setMember(member: CollabPresenceMember | null): void {
    this.member = member;
    if (this.running && member) void this.heartbeat();
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.pollStatus();
    // Immediate first heartbeat: the presence roster comes from the heartbeat
    // RESPONSE, so without this the avatars only appear on the interval's
    // first tick — a 10s blank presence bar on every project open. This also
    // announces us to teammates right away.
    void this.heartbeat();
    // Hidden-tab gating: a backgrounded tab keeps its timers but skips the
    // network ticks (status head + presence heartbeat both fan out to the
    // hub), and one immediate catch-up pair fires on return to visible.
    // Presence naturally expires on the hub's TTL while hidden, which is the
    // honest signal — a tab nobody is looking at is not "viewing".
    const visible = () =>
      typeof document === 'undefined' || document.visibilityState !== 'hidden';
    this.timers.push(setInterval(() => {
      if (visible()) void this.pollStatus();
    }, this.statusPollMs));
    this.timers.push(setInterval(() => {
      if (visible()) void this.heartbeat();
    }, this.heartbeatMs));
    if (typeof document !== 'undefined') {
      this.onVisibilityChange = () => {
        if (!visible()) return;
        void this.pollStatus();
        void this.heartbeat();
      };
      document.addEventListener('visibilitychange', this.onVisibilityChange);
    }
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    for (const timer of this.timers) clearInterval(timer);
    this.timers.length = 0;
    if (this.onVisibilityChange && typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.onVisibilityChange);
      this.onVisibilityChange = null;
    }
    void this.leave();
  }

  /** The author edited a file — schedule a coalesced publish. */
  async reportChange(): Promise<void> {
    await this.post('/collab/changed');
  }

  /** Run boundary — flush the pending publish now. */
  async requestPublish(): Promise<void> {
    await this.post('/collab/publish');
  }

  /**
   * Member side — pull the resource-hub head into the local project directory.
   * The daemon materializes the new content and its file watcher then fires the
   * existing live-reload SSE, so the FileViewer refreshes on its own.
   */
  async pull(): Promise<void> {
    await this.post('/collab/pull');
  }

  async heartbeat(): Promise<void> {
    // No identity yet (status polling can be running well before `member`
    // resolves — see setMember) — presence has nothing to announce.
    if (!this.member) return;
    if (!this.isSharedProject()) {
      if (this.snapshot.present.length > 0) this.update({ present: [] });
      return;
    }
    try {
      const body = await this.post('/presence/heartbeat', this.member);
      if (Array.isArray(body?.present)) this.update({ present: body.present as CollabPresenceMember[] });
    } catch (error) {
      this.onError?.(error);
    }
  }

  async pollStatus(): Promise<void> {
    try {
      const wasShared = this.isSharedProject();
      const body = await this.get('/collab/status');
      const version = typeof body?.publishedVersion === 'number' ? body.publishedVersion : null;
      const syncState = (body?.syncState as ProjectSyncState | undefined) ?? null;
      const ownerMemberId = typeof body?.ownerMemberId === 'string' ? body.ownerMemberId : null;
      const ownerDisplayName = typeof body?.ownerDisplayName === 'string' ? body.ownerDisplayName : null;
      const ownerRole = isCollabMemberRole(body?.ownerRole) ? body.ownerRole : null;
      this.update({ publishedVersion: version, syncState, ownerMemberId, ownerDisplayName, ownerRole });
      if (!wasShared && this.isSharedProject()) void this.heartbeat();
    } catch (error) {
      this.onError?.(error);
    }
  }

  private async leave(): Promise<void> {
    if (!this.member) return;
    try {
      await this.post('/presence/leave', { memberId: this.member.memberId });
    } catch (error) {
      this.onError?.(error);
    }
  }

  /**
   * Best-effort leave that survives page unload. A normal fetch is aborted when
   * the tab closes, so a hard close would otherwise leave the member lingering
   * until the daemon's presence TTL sweeps it (~30s). sendBeacon (with a
   * keepalive-fetch fallback) hands the request to the browser to deliver after
   * the page is gone, so the present set drops promptly.
   */
  leaveBeacon(): void {
    if (!this.member) return;
    const url = this.url('/presence/leave');
    const body = JSON.stringify({ memberId: this.member.memberId });
    try {
      if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
        const blob = new Blob([body], { type: 'application/json' });
        if (navigator.sendBeacon(url, blob)) return;
      }
    } catch {
      // fall through to the keepalive fetch
    }
    void this.fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      keepalive: true,
    }).catch(() => {});
  }

  private update(patch: Partial<CollabSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    this.onUpdate?.(this.snapshot);
  }

  private isSharedProject(): boolean {
    return this.snapshot.syncState !== null && this.snapshot.syncState !== 'local_only';
  }

  private async get(path: string): Promise<Record<string, unknown> | null> {
    const response = await this.fetchImpl(this.url(path));
    if (!response.ok) throw new Error(`collab GET ${path} failed: ${response.status}`);
    return (await response.json()) as Record<string, unknown>;
  }

  private async post(path: string, body?: unknown): Promise<Record<string, unknown> | null> {
    const init: RequestInit = { method: 'POST' };
    if (body !== undefined) {
      init.headers = { 'content-type': 'application/json' };
      init.body = JSON.stringify(body);
    }
    const response = await this.fetchImpl(this.url(path), init);
    if (!response.ok) throw new Error(`collab POST ${path} failed: ${response.status}`);
    return (await response.json()) as Record<string, unknown>;
  }

  private url(path: string): string {
    return `${this.baseUrl}/api/projects/${encodeURIComponent(this.projectId)}${path}`;
  }
}

function isCollabMemberRole(value: unknown): value is CollabMemberRole {
  return value === 'owner' || value === 'admin' || value === 'member';
}
