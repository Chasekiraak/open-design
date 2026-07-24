// P0: `resolveDesignSystemWorkspaceScope` (server.ts) used to memoize the
// resolved workspace id for 10s, independent of pin/session state — on top of
// (not instead of) the `designSystemVisibleFromWorkspace` filter that
// `design-systems/workspace-scope.test.ts` already covers.
//
// Reported bug: a user creates a design system in workspace-1, then creates a
// brand-new workspace-2 on Vela Web and comes back to OD. Workspace-2 still
// showed workspace-1's design system. Root cause: workspace CREATION lives
// entirely on Vela Web, not this daemon (`routes/collab-context.ts`: "Vela Web
// lists/creates workspaces but does not choose which workspace this local OD
// daemon is operating in"), so a switch that originates there never calls
// `PUT /api/workspace/active` — the only route that writes the local pin file.
// The daemon only learns the new workspace through the next
// `collab.workspaceContext.current()` read, and that read used to land in a
// 10s cache local to `resolveDesignSystemWorkspaceScope`, independent of the
// pin. GET /api/design-systems kept resolving the OLD workspace's scope for up
// to 10s after the switch, and (more seriously, since it does not self-heal)
// `POST /api/design-systems` created in that window was PERMANENTLY stamped
// with the stale workspace, because `createWorkspaceOwnedDesignSystem` shares
// this exact resolver.
//
// Live repro against a real daemon (dev workspace-context provider,
// `PUT /api/workspace/context` simulating the Vela-Web-driven switch with no
// local pin write — see `createDevWorkspaceContextProvider`'s `set` seam):
// pre-fix, GET /api/design-systems kept leaking workspace-1's system into
// workspace-2 for ~10.1s after the switch, and a POST issued ~560ms after the
// switch was mis-attributed to workspace-1. Post-fix, both were correct at
// the harness's own request latency (~1.5s of fetch/import overhead, not
// caching) — i.e. no cache-shaped delay at all.
//
// The fix removes `resolveDesignSystemWorkspaceScope`'s own TTL cache
// entirely rather than shortening it: every other `collab.workspaceContext
// .current()` caller in server.ts (mutation gates, brand routes,
// resource-hub principal checks) already awaits it uncached per call, and
// none of this resolver's callers are hot/polled paths (design-system
// list/create and brand create/finalize are user-triggered, not polled).

import type http from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServer } from '../../src/server.js';

type StartedServer = {
  url: string;
  server: http.Server;
  shutdown?: () => Promise<void> | void;
};

const CONTEXT_WS1 = {
  workspaceMemberId: 'member-switch',
  workspaceId: 'ws-switch-one',
  workspaceType: 'team',
  role: 'owner',
  memberStatus: 'active',
  lifecycleState: 'active',
};

const CONTEXT_WS2 = {
  workspaceMemberId: 'member-switch',
  workspaceId: 'ws-switch-two',
  workspaceType: 'personal',
  role: 'owner',
  memberStatus: 'active',
  lifecycleState: 'active',
};

// The dev/demo seam (`workspaceContext.set`), NOT `PUT /api/workspace/active`:
// this is deliberately the same shape as a Vela-Web-driven switch — the
// daemon's notion of "current" context changes, but no local pin is written.
async function setContext(baseUrl: string, context: unknown): Promise<void> {
  const resp = await fetch(`${baseUrl}/api/workspace/context`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(context),
  });
  expect(resp.ok).toBe(true);
}

describe('GET/POST /api/design-systems — a context switch with no local pin has zero caching delay', () => {
  let server: http.Server;
  let baseUrl: string;
  let shutdown: (() => Promise<void> | void) | undefined;

  beforeAll(async () => {
    const started = (await startServer({ port: 0, returnServer: true })) as StartedServer;
    baseUrl = started.url;
    server = started.server;
    shutdown = started.shutdown;
  });

  afterAll(async () => {
    await Promise.resolve(shutdown?.());
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('does not leak workspace-1 into workspace-2 immediately after the switch, and attributes an immediate create correctly', async () => {
    await setContext(baseUrl, CONTEXT_WS1);

    const createResp1 = await fetch(`${baseUrl}/api/design-systems`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: `ws1 system ${Date.now()}` }),
    });
    expect(createResp1.status).toBe(201);
    const createdInWs1 = (await createResp1.json()) as { id: string; workspaceId?: string };
    expect(createdInWs1.workspaceId).toBe('ws-switch-one');

    // Switch to workspace-2 the way a "created a new workspace on Vela Web"
    // return trip actually surfaces: `.current()` already answers ws-2 on the
    // very next read, but `PUT /api/workspace/active` is never called.
    await setContext(baseUrl, CONTEXT_WS2);

    // The daemon's own notion of "current" was never the broken half — confirm
    // it already reports ws-2 before checking the design-systems scope.
    const ctxResp = await fetch(`${baseUrl}/api/workspace/context`);
    const ctxBody = (await ctxResp.json()) as { context: { workspaceId: string } | null };
    expect(ctxBody.context?.workspaceId).toBe('ws-switch-two');

    // The actual reported bug: GET /api/design-systems immediately after the
    // switch must not still resolve workspace-1's scope.
    const listResp = await fetch(`${baseUrl}/api/design-systems`);
    const listBody = (await listResp.json()) as {
      designSystems: Array<{ id: string; workspaceId?: string }>;
    };
    expect(listBody.designSystems.some((d) => d.id === createdInWs1.id)).toBe(false);

    // The permanent-misattribution half: a system created immediately after
    // the switch must be stamped ws-2, not silently inherit the stale ws-1 —
    // `createWorkspaceOwnedDesignSystem` shares this same resolver, so this is
    // the one case that used to never self-heal even after the 10s cache
    // window passed.
    const createResp2 = await fetch(`${baseUrl}/api/design-systems`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: `ws2 system ${Date.now()}` }),
    });
    expect(createResp2.status).toBe(201);
    const createdInWs2 = (await createResp2.json()) as { id: string; workspaceId?: string };
    expect(createdInWs2.workspaceId).toBe('ws-switch-two');

    // Symmetric sanity check: workspace-1's own view must still show its own
    // system and must not have picked up workspace-2's — the fix removes a
    // stale-cache leak, it must not turn into a different leak the other way.
    await setContext(baseUrl, CONTEXT_WS1);
    const listWs1Resp = await fetch(`${baseUrl}/api/design-systems`);
    const listWs1Body = (await listWs1Resp.json()) as { designSystems: Array<{ id: string }> };
    expect(listWs1Body.designSystems.some((d) => d.id === createdInWs1.id)).toBe(true);
    expect(listWs1Body.designSystems.some((d) => d.id === createdInWs2.id)).toBe(false);
  });
});

describe('resolveDesignSystemWorkspaceScope — spec 04 §10: a leftover pin must not outrank "no confirmed session"', () => {
  // This function's session-liveness gate (`collab.workspaceContext.lastKnown()`)
  // is untouched by the TTL-cache fix above — this suite exists to prove
  // removing that cache did not also disturb the gate. A fresh server
  // instance is used (rather than reusing the suite above) so its
  // `activeWorkspace` pin-file reader starts with an empty in-memory cache and
  // performs its first disk read AFTER the stale pin below is written —
  // mirroring a real daemon restart finding a leftover pin file on disk.
  let server: http.Server;
  let baseUrl: string;
  let shutdown: (() => Promise<void> | void) | undefined;

  beforeAll(async () => {
    // A stale local pin exactly like a real leftover from a previous identity
    // — `velaLogout` never clears this file (only a CONFIRMED member-removal
    // does; see `resolvePinnedWorkspace` in vela-workspace-context.ts).
    const dataDir = process.env.OD_DATA_DIR!;
    writeFileSync(
      path.join(dataDir, 'workspace-selection.json'),
      `${JSON.stringify({ workspaceId: 'ws-stale-pin' }, null, 2)}\n`,
    );
    // A design system claimed by the pinned workspace, seeded directly on
    // disk so this suite is independent of the other describe block's state.
    const dsDir = path.join(dataDir, 'design-systems', 'pinned-claim');
    mkdirSync(dsDir, { recursive: true });
    writeFileSync(path.join(dsDir, 'DESIGN.md'), '# Pinned claim\n\nSeeded directly on disk.\n');
    writeFileSync(
      path.join(dsDir, 'metadata.json'),
      `${JSON.stringify({ title: 'Pinned claim', workspaceId: 'ws-stale-pin' }, null, 2)}\n`,
    );

    const started = (await startServer({ port: 0, returnServer: true })) as StartedServer;
    baseUrl = started.url;
    server = started.server;
    shutdown = started.shutdown;
  });

  afterAll(async () => {
    await Promise.resolve(shutdown?.());
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('ignores the pin before any workspace context has ever been confirmed', async () => {
    // No `PUT /api/workspace/context` has ever been sent to THIS server
    // instance — `lastKnown()` is null, matching "never signed in" and
    // "signed out, pin left behind" identically. The pinned-claim system must
    // stay hidden: §10 already established that "no scope" hides a claimed
    // system rather than trusting everything, and that must hold even though
    // a pin file happens to sit on disk.
    const resp = await fetch(`${baseUrl}/api/design-systems`);
    const body = (await resp.json()) as { designSystems: Array<{ id: string }> };
    expect(body.designSystems.some((d) => d.id === 'user:pinned-claim')).toBe(false);
  });

  it('honors the pin once a session is confirmed (the pin-priority branch itself still works)', async () => {
    // Confirm a session under a DIFFERENT workspace id — the pin still wins
    // over whatever id "current" reports, so this is a sanity check that
    // removing the TTL cache did not also disturb the pin-wins-when-present
    // branch itself.
    await setContext(baseUrl, {
      workspaceMemberId: 'member-other',
      workspaceId: 'ws-not-the-pin',
      workspaceType: 'team',
      role: 'owner',
      memberStatus: 'active',
      lifecycleState: 'active',
    });
    const resp = await fetch(`${baseUrl}/api/design-systems`);
    const body = (await resp.json()) as { designSystems: Array<{ id: string }> };
    expect(body.designSystems.some((d) => d.id === 'user:pinned-claim')).toBe(true);
  });
});
