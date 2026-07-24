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
    | 'project-metadata-changed'
    | 'project-content-changed'
    | 'team-resources-changed';
  workspaceId?: string;
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
      // Connected: the server sends `ready` immediately; treat a successful
      // 200-with-body as connected so catch-up runs even if `ready` is lost
      // in a proxy buffer.
      const isReconnect = everConnected;
      everConnected = true;
      backoffMs = backoffMinMs;
      setConnected(true);
      if (isReconnect) options.onReconnect?.();
      armWatchdog();

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        armWatchdog();
        buffer += decoder.decode(value, { stream: true });
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
          if (eventName !== 'workspace-event') continue; // ready/heartbeat feed the watchdog only
          const event = parseHubWorkspaceEvent(dataLines.join('\n'));
          if (event) options.onEvent(event);
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
