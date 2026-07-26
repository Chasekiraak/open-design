// Coverage for the two seams that trigger `reconcileWorkspaceProjectsWithRemote`
// in server.ts: the hub's real-time `team-projects-changed` SSE push
// (`startHubEventsSubscriber`) and the ~15s `workspaceInvalidationPoller`'s
// own diff-and-signal cadence. Mirrors the existing precedent in
// `hub-workspace-context-changed-poll.test.ts` (same extracted-named-function
// + source-scan-boundary-guard style) for the sibling
// `workspace-context-changed` fix.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

import {
  handleHubTeamProjectsChanged,
  handlePolledWorkspaceInvalidation,
} from '../../src/collab/workspace-projects-reconciler.js';
import { parseHubWorkspaceEvent, startHubEventsSubscriber } from '../../src/collab/hub-events-subscriber.js';

function sseResponse(frames: string[]) {
  const encoder = new TextEncoder();
  let started = false;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!started) {
        started = true;
        for (const frame of frames) controller.enqueue(encoder.encode(frame));
        return;
      }
      // Never enqueue again — keeps the connection open so the subscriber
      // does not immediately loop into a reconnect after the one event.
      await new Promise(() => undefined);
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

describe('handleHubTeamProjectsChanged', () => {
  it('emits the thin display-cache signal AND kicks a reconciliation pass', async () => {
    const emit = vi.fn();
    const reconcile = vi.fn(async () => undefined);
    handleHubTeamProjectsChanged(emit, reconcile);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(reconcile).toHaveBeenCalledTimes(1);
  });

  it('never lets a reconciliation failure throw or reject out of the hub event handler', async () => {
    const emit = vi.fn();
    const reconcile = vi.fn(() => Promise.reject(new Error('vela unreachable')));
    const unhandled = vi.fn();
    process.once('unhandledRejection', unhandled);

    expect(() => handleHubTeamProjectsChanged(emit, reconcile)).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(unhandled).not.toHaveBeenCalled();
    process.removeListener('unhandledRejection', unhandled);
  });

  // End-to-end through the REAL SSE parser/dispatcher (`startHubEventsSubscriber`
  // + `parseHubWorkspaceEvent`), not a hand-called function — this is the
  // "real push" half of the verification: a genuine `team-projects-changed`
  // wire frame, parsed by real code, must reach the reconciler.
  it('fires from a genuine team-projects-changed SSE frame parsed by the real hub subscriber', async () => {
    const emit = vi.fn();
    const reconcile = vi.fn(async () => undefined);
    let resolveDone!: () => void;
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });

    const readyFrame = 'event: ready\ndata: {"workspaceId":"w1"}\n\n';
    const frame =
      'event: workspace-event\ndata: {"type":"team-projects-changed","workspaceId":"w1","at":123}\n\n';
    const subscriber = startHubEventsSubscriber({
      resolveEndpoint: async () => ({
        url: 'https://hub/api/v1/collab/events',
        headers: {},
        workspaceId: 'w1',
      }),
      onEvent: (event) => {
        expect(parseHubWorkspaceEvent(JSON.stringify(event))).toEqual(event);
        if (event.type === 'team-projects-changed') {
          handleHubTeamProjectsChanged(emit, reconcile);
          resolveDone();
        }
      },
      fetchImpl: async () => sseResponse([readyFrame, frame]),
    });

    try {
      await done;
      expect(emit).toHaveBeenCalledTimes(1);
      expect(reconcile).toHaveBeenCalledTimes(1);
    } finally {
      subscriber.stop();
    }
  });
});

describe('handlePolledWorkspaceInvalidation', () => {
  it('forwards every payload to emit unchanged', () => {
    const emit = vi.fn();
    const reconcile = vi.fn(async () => undefined);
    const payload = { type: 'members-changed' as const, at: 1 };
    handlePolledWorkspaceInvalidation(payload, emit, reconcile);
    expect(emit).toHaveBeenCalledWith(payload);
  });

  it('kicks reconciliation only for a team-projects-changed payload', () => {
    const emit = vi.fn();
    const reconcile = vi.fn(async () => undefined);

    handlePolledWorkspaceInvalidation({ type: 'workspace-context-changed', at: 1 }, emit, reconcile);
    handlePolledWorkspaceInvalidation({ type: 'members-changed', at: 1 }, emit, reconcile);
    handlePolledWorkspaceInvalidation({ type: 'billing-changed', at: 1 }, emit, reconcile);
    expect(reconcile).not.toHaveBeenCalled();

    handlePolledWorkspaceInvalidation({ type: 'team-projects-changed', at: 1 }, emit, reconcile);
    expect(reconcile).toHaveBeenCalledTimes(1);
  });

  it('never lets a reconciliation failure throw out of the poller emit path', async () => {
    const emit = vi.fn();
    const reconcile = vi.fn(() => Promise.reject(new Error('vela unreachable')));
    const unhandled = vi.fn();
    process.once('unhandledRejection', unhandled);

    expect(() =>
      handlePolledWorkspaceInvalidation({ type: 'team-projects-changed', at: 1 }, emit, reconcile),
    ).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(unhandled).not.toHaveBeenCalled();
    process.removeListener('unhandledRejection', unhandled);
  });
});

// Scope-boundary guard (real source, not a re-implementation) — the sibling of
// `hub-workspace-context-changed-poll.test.ts`'s own switch-boundary test.
// Confirms the wiring actually landed in server.ts: exactly the
// `team-projects-changed` case calls `handleHubTeamProjectsChanged`, and the
// poller's `emit` wiring calls `handlePolledWorkspaceInvalidation`.
describe('server.ts wiring (source boundary)', () => {
  const serverSourcePath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../src/server.ts',
  );
  const source = fs.readFileSync(serverSourcePath, 'utf8');

  function extractOnEventSwitchBody(): string {
    const anchor = 'onEvent: (event) => {';
    const start = source.indexOf(anchor);
    expect(start, 'expected to find the hub events onEvent handler in server.ts').toBeGreaterThan(-1);
    const switchStart = source.indexOf('switch (event.type) {', start);
    expect(switchStart, 'expected a switch(event.type) right after onEvent').toBeGreaterThan(-1);
    let depth = 0;
    let i = switchStart + 'switch (event.type) {'.length - 1;
    for (; i < source.length; i += 1) {
      if (source[i] === '{') depth += 1;
      else if (source[i] === '}') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    expect(depth, 'expected the switch braces to balance').toBe(0);
    return source.slice(switchStart, i + 1);
  }

  it('calls handleHubTeamProjectsChanged from exactly one case: team-projects-changed', () => {
    const switchBody = extractOnEventSwitchBody();
    const cases = switchBody.split(/(?=case '[a-z-]+':)/g).filter((chunk) => chunk.startsWith("case '"));
    expect(cases.length).toBeGreaterThanOrEqual(7);

    const casesCallingReconcile = cases.filter((chunk) => /handleHubTeamProjectsChanged\(/.test(chunk));
    const caseNames = casesCallingReconcile.map((chunk) => chunk.match(/^case '([a-z-]+)':/)?.[1]);
    expect(caseNames).toEqual(['team-projects-changed']);
  });

  it('passes the changed project id into first-share missing-project recovery', () => {
    const switchBody = extractOnEventSwitchBody();
    const teamProjectsCase = switchBody
      .split(/(?=case '[a-z-]+':)/g)
      .find((chunk) => chunk.startsWith("case 'team-projects-changed':"));

    expect(teamProjectsCase).toContain(
      'proactiveContentPull.materializeMissingProjects(\n' +
        '              event.workspaceId,\n' +
        '              event.projectId,\n' +
        '            );',
    );
  });

  it('wires poller invalidations through reconciliation and missing-project materialization', () => {
    const anchor = 'createWorkspaceInvalidationPoller({';
    const start = source.indexOf(anchor);
    expect(start, 'expected to find createWorkspaceInvalidationPoller(...) in server.ts').toBeGreaterThan(-1);
    // Brace-balance from the opening `{` (not a naive `indexOf('});')`, which
    // would stop at the first NESTED closing brace inside e.g.
    // `getWorkspaceContext: async () => { ... }`).
    let depth = 0;
    let i = start + anchor.length - 1; // position of the opening brace
    for (; i < source.length; i += 1) {
      if (source[i] === '{') depth += 1;
      else if (source[i] === '}') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    expect(depth, 'expected createWorkspaceInvalidationPoller({...}) braces to balance').toBe(0);
    const configBody = source.slice(start, i + 1);
    expect(configBody).toContain(
      'handlePolledWorkspaceInvalidation(payload, emitWorkspaceEvent, reconcileWorkspaceProjectsFromRemote);',
    );
    expect(configBody).toMatch(
      /if \(payload\.type === 'team-projects-changed'\) \{[\s\S]*?proactiveContentPull\.materializeMissingProjects\(workspaceId\)/,
    );
  });

  it('disposes proactive pull retry timers during daemon shutdown', () => {
    const anchor = 'const cleanupDaemonBackgroundWork = () => {';
    const start = source.indexOf(anchor);
    expect(start, 'expected daemon background cleanup in server.ts').toBeGreaterThan(-1);
    const end = source.indexOf('};', start);
    expect(end, 'expected daemon background cleanup to close').toBeGreaterThan(start);
    const cleanupBody = source.slice(start, end + 2);
    expect(cleanupBody).toContain('proactiveContentPull.dispose();');
  });
});
