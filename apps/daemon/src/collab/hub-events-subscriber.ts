// Hop-1 realtime: cloud hub → daemon thin-event subscriber.
//
// Subscribes to B's `GET /api/v1/collab/events` SSE channel (one connection
// per daemon, authenticated with the same vela control-key session everything
// else uses) and surfaces thin invalidation events. This replaces "poll every
// 5-15s and diff" as the PRIMARY freshness mechanism; the pollers stay alive
// as a lower-frequency safety net and as the sole mechanism while this
// channel is down — the channel's health is exposed through `onStateChange`
// so the caller can switch poll cadences.
//
// Reliability model (mirrors the daemon→web thin-event contract):
//   - Events are signals, not payloads; a missed event is closed by the
//     reconnect catch-up (`onReconnect` → caller re-runs its pollers once).
//   - Exponential backoff 1s→30s, forever; `resolveEndpoint` returning null
//     (signed out / no workspace) idles at the max backoff instead of
//     hammering.
//   - A heartbeat watchdog kills half-dead connections: the server sends a
//     frame at least every 15s, so 45s of silence means the TCP stream is
//     zombied and we abort + reconnect.

export type HubResourceStatus = 'shared' | 'retracted';

export interface HubWorkspaceEvent {
  type:
    | 'team-projects-changed'
    | 'comment-changed'
    | 'presence-changed'
    | 'workspace-context-changed'
    | 'billing-changed'
    | 'billing-subscription-changed'
    | 'wallet-balance-changed'
    | 'project-metadata-changed'
    | 'project-content-changed'
    | 'team-resources-changed';
  workspaceId?: string;
  workspaceMemberId?: string;
  revision?: string;
  projectId?: string;
  resourceId?: string;
  /** Set on 'team-resources-changed': `resource_hub.resources.kind` at emit
   *  time — 'design_system' | 'plugin' | 'skill' | 'project' | any future
   *  kind. Opaque here by design (mirrors vela's own `WorkspaceEvent.
   *  resourceKind`); this daemon's `onEvent` handler owns the kind→reconciler
   *  routing. */
  resourceKind?: string;
  /** Set on 'team-resources-changed' alongside resourceKind: whether the hub
   *  write was a publish (moved the 'published' ref) or a retraction (the
   *  resource's soft-delete). */
  resourceStatus?: HubResourceStatus;
  seq?: number;
  version?: number;
  at?: string;
}

const HUB_EVENT_TYPES = new Set<HubWorkspaceEvent['type']>([
  'team-projects-changed',
  'comment-changed',
  'presence-changed',
  'workspace-context-changed',
  'billing-changed',
  'billing-subscription-changed',
  'wallet-balance-changed',
  'project-metadata-changed',
  'project-content-changed',
  'team-resources-changed',
]);

const HUB_RESOURCE_STATUSES = new Set<HubResourceStatus>(['shared', 'retracted']);

export function parseHubWorkspaceEvent(data: string): HubWorkspaceEvent | null {
  try {
    const parsed = JSON.parse(data) as Record<string, unknown>;
    if (typeof parsed.type !== 'string' || !HUB_EVENT_TYPES.has(parsed.type as HubWorkspaceEvent['type'])) {
      return null;
    }
    const event: HubWorkspaceEvent = { type: parsed.type as HubWorkspaceEvent['type'] };
    if (typeof parsed.workspaceId === 'string') event.workspaceId = parsed.workspaceId;
    if (typeof parsed.workspaceMemberId === 'string') {
      event.workspaceMemberId = parsed.workspaceMemberId;
    }
    if (typeof parsed.revision === 'string') event.revision = parsed.revision;
    if (typeof parsed.projectId === 'string') event.projectId = parsed.projectId;
    if (typeof parsed.resourceId === 'string') event.resourceId = parsed.resourceId;
    if (typeof parsed.resourceKind === 'string') event.resourceKind = parsed.resourceKind;
    if (
      typeof parsed.resourceStatus === 'string' &&
      HUB_RESOURCE_STATUSES.has(parsed.resourceStatus as HubResourceStatus)
    ) {
      event.resourceStatus = parsed.resourceStatus as HubResourceStatus;
    }
    if (typeof parsed.seq === 'number') event.seq = parsed.seq;
    if (typeof parsed.version === 'number') event.version = parsed.version;
    if (typeof parsed.at === 'string') event.at = parsed.at;
    return event;
  } catch {
    return null;
  }
}

export interface HubEventsEndpoint {
  /** Absolute URL of the SSE endpoint. */
  url: string;
  /** Auth headers (Bearer control key + x-vela-workspace-id). */
  headers: Record<string, string>;
  /** Expected workspace carried by the server's `ready` frame. Catch-up and
   *  events stay gated until the stream proves this exact scope. */
  workspaceId?: string;
}

export interface HubEventsSubscriberOptions {
  /**
   * Resolve the endpoint from the CURRENT vela session + active workspace.
   * Returning null (signed out / personal-only) parks the subscriber at the
   * max backoff; it keeps re-resolving so a later sign-in picks up.
   */
  resolveEndpoint: () => Promise<HubEventsEndpoint | null>;
  onEvent: (event: HubWorkspaceEvent) => void;
  /** Channel health transitions — drives poll-cadence switching. */
  onStateChange?: (state: 'connected' | 'disconnected') => void;
  /** Fired after a `ready` frame verifies the stream workspace. Unlike
   *  `onReconnect`, this includes the first successful connection. */
  onConnect?: (connection: { reconnect: boolean; workspaceId?: string }) => void;
  /** Secret-free parser/scope diagnostics. Raw payloads are never exposed. */
  onDrop?: (drop: {
    reason: 'invalid-ready' | 'workspace-mismatch' | 'unverified-scope' | 'invalid-payload';
    eventName: string;
    expectedWorkspaceId?: string;
    actualWorkspaceId?: string;
  }) => void;
  /**
   * Fired on every successful (re)connect AFTER the first, i.e. whenever
   * events may have been missed. The caller should run one catch-up cycle
   * (its pollers' `pollOnce`).
   */
  onReconnect?: () => void;
  onError?: (error: unknown) => void;
  fetchImpl?: typeof fetch;
  /** Abort the stream when no frame (event OR heartbeat) arrives for this long. */
  heartbeatTimeoutMs?: number;
  backoffMinMs?: number;
  backoffMaxMs?: number;
}

export interface HubEventsSubscriber {
  stop(): void;
  connected(): boolean;
}

export function startHubEventsSubscriber(options: HubEventsSubscriberOptions): HubEventsSubscriber {
  const fetchImpl = options.fetchImpl ?? fetch;
  const heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? 45_000;
  const backoffMinMs = options.backoffMinMs ?? 1_000;
  const backoffMaxMs = options.backoffMaxMs ?? 30_000;

  let stopped = false;
  let isConnected = false;
  let everConnected = false;
  let backoffMs = backoffMinMs;
  let abortController: AbortController | null = null;
  let wakeSleep: (() => void) | null = null;

  const setConnected = (next: boolean) => {
    if (isConnected === next) return;
    isConnected = next;
    options.onStateChange?.(next ? 'connected' : 'disconnected');
  };

  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        wakeSleep = null;
        resolve();
      }, ms);
      timer.unref?.();
      wakeSleep = () => {
        clearTimeout(timer);
        wakeSleep = null;
        resolve();
      };
    });

  async function consumeStream(endpoint: HubEventsEndpoint): Promise<void> {
    abortController = new AbortController();
    let watchdog: NodeJS.Timeout | null = null;
    const armWatchdog = () => {
      if (watchdog) clearTimeout(watchdog);
      watchdog = setTimeout(() => abortController?.abort(), heartbeatTimeoutMs);
      watchdog.unref?.();
    };

    try {
      const response = await fetchImpl(endpoint.url, {
        headers: { ...endpoint.headers, accept: 'text/event-stream' },
        signal: abortController.signal,
      });
      if (!response.ok || !response.body) {
        throw new Error(`hub events stream ${response.status}`);
      }
      // Transport-connected. Content catch-up remains gated on the server's
      // `ready` frame proving the expected workspace below.
      backoffMs = backoffMinMs;
      setConnected(true);
      armWatchdog();

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let scopeVerified = false;
      let connectionNotified = false;
      const notifyVerifiedConnection = (workspaceId?: string) => {
        if (connectionNotified) return;
        connectionNotified = true;
        const reconnect = everConnected;
        everConnected = true;
        try {
          options.onConnect?.({ reconnect, ...(workspaceId ? { workspaceId } : {}) });
          if (reconnect) options.onReconnect?.();
        } catch (error) {
          options.onError?.(error);
        }
      };
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        armWatchdog();
        buffer += decoder.decode(value, { stream: true });
        // SSE permits CRLF as well as LF. Normalize only after appending so a
        // CR/LF pair split across transport chunks is still handled.
        buffer = buffer.replace(/\r\n/g, '\n');
        let sep: number;
        while ((sep = buffer.indexOf('\n\n')) !== -1) {
          const rawEvent = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          let eventName = 'message';
          const dataLines: string[] = [];
          for (const line of rawEvent.split('\n')) {
            if (line.startsWith('event:')) eventName = line.slice(6).trim();
            else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
          }
          const data = dataLines.join('\n');
          if (eventName === 'ready') {
            let actualWorkspaceId: string | undefined;
            try {
              const parsed = JSON.parse(data) as { workspaceId?: unknown };
              if (typeof parsed.workspaceId === 'string' && parsed.workspaceId.trim()) {
                actualWorkspaceId = parsed.workspaceId.trim();
              }
            } catch {
              // Reported through the common invalid-ready path below.
            }
            if (!actualWorkspaceId) {
              options.onDrop?.({
                reason: 'invalid-ready',
                eventName,
                ...(endpoint.workspaceId
                  ? { expectedWorkspaceId: endpoint.workspaceId }
                  : {}),
              });
              abortController?.abort();
              return;
            }
            if (endpoint.workspaceId && actualWorkspaceId !== endpoint.workspaceId) {
              options.onDrop?.({
                reason: 'workspace-mismatch',
                eventName,
                expectedWorkspaceId: endpoint.workspaceId,
                actualWorkspaceId,
              });
              abortController?.abort();
              return;
            }
            scopeVerified = true;
            notifyVerifiedConnection(actualWorkspaceId);
            continue;
          }
          if (eventName !== 'workspace-event') continue; // heartbeat feeds the watchdog only
          if (!scopeVerified) {
            options.onDrop?.({
              reason: 'unverified-scope',
              eventName,
              ...(endpoint.workspaceId
                ? { expectedWorkspaceId: endpoint.workspaceId }
                : {}),
            });
            continue;
          }
          const event = parseHubWorkspaceEvent(data);
          if (!event) {
            options.onDrop?.({ reason: 'invalid-payload', eventName });
            continue;
          }
          if (
            endpoint.workspaceId &&
            event.workspaceId &&
            event.workspaceId !== endpoint.workspaceId
          ) {
            options.onDrop?.({
              reason: 'workspace-mismatch',
              eventName,
              expectedWorkspaceId: endpoint.workspaceId,
              actualWorkspaceId: event.workspaceId,
            });
            continue;
          }
          options.onEvent(event);
        }
      }
    } finally {
      if (watchdog) clearTimeout(watchdog);
      abortController = null;
      setConnected(false);
    }
  }

  void (async () => {
    while (!stopped) {
      try {
        const endpoint = await options.resolveEndpoint();
        if (stopped) break;
        if (!endpoint) {
          // Signed out / no team workspace — idle at max backoff, keep probing.
          await sleep(backoffMaxMs);
          continue;
        }
        await consumeStream(endpoint);
        // Server closed cleanly (deploy/restart) — reconnect promptly.
        backoffMs = backoffMinMs;
      } catch (error) {
        if (!stopped) options.onError?.(error);
      }
      if (stopped) break;
      await sleep(backoffMs);
      backoffMs = Math.min(backoffMs * 2, backoffMaxMs);
    }
  })();

  return {
    stop() {
      stopped = true;
      abortController?.abort();
      wakeSleep?.();
    },
    connected: () => isConnected,
  };
}
