import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  parseHubWorkspaceEvent,
  startHubEventsSubscriber,
  type HubEventsSubscriber,
} from '../../src/collab/hub-events-subscriber.js';

function sseResponse(frames: string[], opts: { holdOpen?: boolean } = {}) {
  const encoder = new TextEncoder();
  let started = false;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!started) {
        started = true;
        for (const frame of frames) controller.enqueue(encoder.encode(frame));
        if (!opts.holdOpen) controller.close();
        return;
      }
      if (!opts.holdOpen) controller.close();
      // holdOpen: never enqueue again — simulates a silent zombie stream.
      await new Promise(() => undefined);
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

const READY = 'event: ready\ndata: {"workspaceId":"w1"}\n\n';
const HEARTBEAT = 'event: heartbeat\ndata: {}\n\n';
const COMMENT_EVENT =
  'event: workspace-event\ndata: {"type":"comment-changed","workspaceId":"w1","projectId":"p1","seq":7}\n\n';

let subscriber: HubEventsSubscriber | null = null;

afterEach(() => {
  subscriber?.stop();
  subscriber = null;
  vi.useRealTimers();
});

describe('parseHubWorkspaceEvent', () => {
  it('parses a valid thin event and drops unknown types', () => {
    expect(parseHubWorkspaceEvent('{"type":"comment-changed","projectId":"p","seq":3}')).toEqual({
      type: 'comment-changed',
      projectId: 'p',
      seq: 3,
    });
    expect(parseHubWorkspaceEvent('{"type":"mystery"}')).toBeNull();
    expect(parseHubWorkspaceEvent('not json')).toBeNull();
  });

  // workspace-team continuous-sync priority 3: the resource-hub's
  // 'team-resources-changed' push (vela API PR: emits on a 'published' ref
  // move or a resource soft-delete) needs resourceKind + resourceStatus to
  // route to the right per-kind reconciler and to tell "just shared" from
  // "just retracted" apart.
  it('parses team-resources-changed with resourceKind and resourceStatus', () => {
    expect(
      parseHubWorkspaceEvent(
        '{"type":"team-resources-changed","workspaceId":"w1","resourceId":"my-skill","resourceKind":"skill","resourceStatus":"shared","version":2}',
      ),
    ).toEqual({
      type: 'team-resources-changed',
      workspaceId: 'w1',
      resourceId: 'my-skill',
      resourceKind: 'skill',
      resourceStatus: 'shared',
      version: 2,
    });
    expect(
      parseHubWorkspaceEvent(
        '{"type":"team-resources-changed","workspaceId":"w1","resourceId":"my-skill","resourceKind":"skill","resourceStatus":"retracted"}',
      ),
    ).toMatchObject({ resourceStatus: 'retracted' });
  });

  it('drops an unrecognized resourceStatus rather than passing it through', () => {
    const event = parseHubWorkspaceEvent(
      '{"type":"team-resources-changed","workspaceId":"w1","resourceId":"r1","resourceStatus":"mystery"}',
    );
    expect(event).toEqual({
      type: 'team-resources-changed',
      workspaceId: 'w1',
      resourceId: 'r1',
    });
    expect(event).not.toHaveProperty('resourceStatus');
  });
});

describe('startHubEventsSubscriber', () => {
  it('delivers workspace-events and reports connected state', async () => {
    const events: unknown[] = [];
    const states: string[] = [];
    let resolveDone!: () => void;
    const done = new Promise<void>((r) => {
      resolveDone = r;
    });

    subscriber = startHubEventsSubscriber({
      resolveEndpoint: async () => ({ url: 'https://hub/api/v1/collab/events', headers: {} }),
      onEvent: (event) => {
        events.push(event);
        resolveDone();
      },
      onStateChange: (state) => states.push(state),
      fetchImpl: async () => sseResponse([READY, HEARTBEAT, COMMENT_EVENT], { holdOpen: true }),
    });

    await done;
    expect(events).toEqual([
      { type: 'comment-changed', workspaceId: 'w1', projectId: 'p1', seq: 7 },
    ]);
    expect(states).toEqual(['connected']);
    expect(subscriber.connected()).toBe(true);
  });

  it('fires onReconnect only from the second successful connect on', async () => {
    let connects = 0;
    const reconnects: number[] = [];
    let resolveSecond!: () => void;
    const second = new Promise<void>((r) => {
      resolveSecond = r;
    });

    subscriber = startHubEventsSubscriber({
      resolveEndpoint: async () => ({ url: 'https://hub/events', headers: {} }),
      onEvent: () => undefined,
      onReconnect: () => {
        reconnects.push(connects);
        resolveSecond();
      },
      backoffMinMs: 1,
      backoffMaxMs: 2,
      fetchImpl: async () => {
        connects += 1;
        return sseResponse([READY]); // closes immediately → next loop reconnects
      },
    });

    await second;
    expect(reconnects[0]).toBeGreaterThanOrEqual(2);
  });

  it('fires the content catch-up hook on both the first connection and a reconnect', async () => {
    const connections: boolean[] = [];
    let fetches = 0;
    let resolveSecond!: () => void;
    const second = new Promise<void>((resolve) => {
      resolveSecond = resolve;
    });
    const options = {
      resolveEndpoint: async () => ({ url: 'https://hub/events', headers: {} }),
      onEvent: () => undefined,
      onConnect: ({ reconnect }: { reconnect: boolean }) => {
        connections.push(reconnect);
        if (connections.length === 2) resolveSecond();
      },
      backoffMinMs: 1,
      backoffMaxMs: 2,
      fetchImpl: async () => {
        fetches += 1;
        return sseResponse([READY]);
      },
    };

    // `onReconnect` deliberately skips the first successful connection. The
    // content catch-up hook must not: a published head may already exist when
    // this daemon establishes its very first stream.
    subscriber = startHubEventsSubscriber(options as Parameters<typeof startHubEventsSubscriber>[0]);

    await second;
    subscriber.stop();
    expect(fetches).toBeGreaterThanOrEqual(2);
    expect(connections).toEqual([false, true]);
  });

  it('does not verify or dispatch a workspace event before the ready frame', async () => {
    const events: unknown[] = [];
    const connections: boolean[] = [];
    const drops: string[] = [];
    let resolveReady!: () => void;
    const ready = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });
    subscriber = startHubEventsSubscriber({
      resolveEndpoint: async () => ({
        url: 'https://hub/events',
        headers: {},
        workspaceId: 'w1',
      }),
      onEvent: (event) => events.push(event),
      onConnect: ({ reconnect }) => {
        connections.push(reconnect);
        resolveReady();
      },
      onDrop: ({ reason }) => drops.push(reason),
      fetchImpl: async () => sseResponse([COMMENT_EVENT, READY, COMMENT_EVENT], { holdOpen: true }),
    });

    await ready;
    await vi.waitFor(() => expect(events).toHaveLength(1));
    expect(connections).toEqual([false]);
    expect(drops).toContain('unverified-scope');
  });

  it('reports a ready workspace mismatch and never runs connection catch-up', async () => {
    const onConnect = vi.fn();
    const onDrop = vi.fn();
    subscriber = startHubEventsSubscriber({
      resolveEndpoint: async () => ({
        url: 'https://hub/events',
        headers: {},
        workspaceId: 'w1',
      }),
      onEvent: () => undefined,
      onConnect,
      onDrop,
      backoffMinMs: 1_000_000,
      fetchImpl: async () =>
        sseResponse(['event: ready\ndata: {"workspaceId":"w2"}\n\n'], { holdOpen: true }),
    });

    await vi.waitFor(() => {
      expect(onDrop).toHaveBeenCalledWith({
        reason: 'workspace-mismatch',
        eventName: 'ready',
        expectedWorkspaceId: 'w1',
        actualWorkspaceId: 'w2',
      });
    });
    expect(onConnect).not.toHaveBeenCalled();
  });


  it('idles when the endpoint resolves null and stops cleanly', async () => {
    let resolved = 0;
    subscriber = startHubEventsSubscriber({
      resolveEndpoint: async () => {
        resolved += 1;
        return null;
      },
      onEvent: () => undefined,
      backoffMaxMs: 5,
      fetchImpl: async () => {
        throw new Error('must not fetch');
      },
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(resolved).toBeGreaterThanOrEqual(2);
    subscriber.stop();
    const after = resolved;
    await new Promise((r) => setTimeout(r, 20));
    expect(resolved).toBe(after);
  });

  it('aborts a silent stream once the heartbeat watchdog expires', async () => {
    let aborted = false;
    let resolveAborted!: () => void;
    const abortedOnce = new Promise<void>((r) => {
      resolveAborted = r;
    });

    subscriber = startHubEventsSubscriber({
      resolveEndpoint: async () => ({ url: 'https://hub/events', headers: {} }),
      onEvent: () => undefined,
      heartbeatTimeoutMs: 20,
      backoffMinMs: 1_000_000, // park after the abort so we observe exactly one cycle
      fetchImpl: async (_url, init) => {
        init?.signal?.addEventListener('abort', () => {
          if (!aborted) {
            aborted = true;
            resolveAborted();
          }
        });
        return sseResponse([READY], { holdOpen: true }); // then silence
      },
    });

    await abortedOnce;
    expect(aborted).toBe(true);
  });
});
