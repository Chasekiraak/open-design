import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import http from 'node:http';
import { buildWorkspacePermissions, buildWorkspaceSeatSummary } from '@open-design/contracts';
import type {
  WorkspaceCollabContext,
  WorkspaceDirectoryItem,
} from '@open-design/contracts';
import {
  registerCollabContextRoutes,
  type RegisterCollabContextRoutesDeps,
} from '../../src/routes/collab-context.js';
import {
  createCachedWorkspaceDirectoryFetcher,
  createVelaWorkspaceContextProvider,
  fetchVelaWorkspaceDirectory,
} from '../../src/collab/vela-workspace-context.js';

// Every workspace-scoped cache in the daemon keys on the active workspace, so a
// switch leaves all of them cold and the FIRST consumer in the new workspace
// pays the refill inline on its own request path. `onWorkspaceSwitched` is the
// seam that lets the owner of those caches warm them during the idle beat right
// after the user switches.
//
// The contract this file pins is deliberately narrow, because getting it wrong
// is worse than not warming at all: the announcement must fire for a CONFIRMED
// switch and for nothing else. Warming on a rejected or rolled-back switch would
// refill the caches against the workspace the daemon just refused to move to.

let server: http.Server | null = null;

afterEach(async () => {
  if (server) {
    const toClose = server;
    server = null;
    await new Promise<void>((resolve) => toClose.close(() => resolve()));
  }
});

const PERSONAL = 'ws-personal';
const TEAM = 'ws-team';

function directoryItem(workspaceId: string): WorkspaceDirectoryItem {
  return {
    workspaceId,
    workspaceName: workspaceId === TEAM ? 'Acme' : "Ma Shu's workspace",
    workspaceType: workspaceId === TEAM ? 'team' : 'personal',
    workspaceMemberId: `wm-${workspaceId}`,
    role: 'owner',
    memberStatus: 'active',
    lifecycleState: 'active',
  };
}

function contextFor(workspaceId: string): WorkspaceCollabContext {
  return {
    workspaceId,
    workspaceType: workspaceId === TEAM ? 'team' : 'personal',
    workspaceMemberId: `wm-${workspaceId}`,
    role: 'owner',
    memberStatus: 'active',
    lifecycleState: 'active',
    billingState: 'active',
    planId: null,
    providerMode: 'platform_credits',
    seatSummary: buildWorkspaceSeatSummary({ seatLimit: 5, usedSeats: 1 }),
    permissions: buildWorkspacePermissions({ role: 'owner', lifecycleState: 'active' }),
  };
}

/**
 * A switch harness with an in-memory active-workspace pin, so the route is
 * exercised through the same store it mutates rather than a stub that cannot
 * disagree with itself. There is deliberately no backend-selection seam: the
 * pin is the only thing a switch moves.
 */
async function startSwitchServer(options: {
  /** What the follow-up context read answers. Default: agrees with the pin. */
  currentContext?: (pinned: string | null) => WorkspaceCollabContext | null;
  initial?: string;
  /** What the membership directory lists. Default: both workspaces, live. */
  directory?: WorkspaceDirectoryItem[];
}) {
  let pinned: string | null = options.initial ?? PERSONAL;
  const onWorkspaceSwitched = vi.fn<(workspaceId: string) => void>();

  const activeWorkspace: NonNullable<RegisterCollabContextRoutesDeps['activeWorkspace']> = {
    get: () => pinned,
    set: async (workspaceId: string) => {
      pinned = workspaceId;
    },
    clear: async () => {
      pinned = null;
    },
  };

  const app = express();
  app.use(express.json());
  const workspaceContext = {
    current: async () =>
      options.currentContext
        ? options.currentContext(pinned)
        : pinned
          ? contextFor(pinned)
          : null,
  };
  registerCollabContextRoutes(app, {
    workspaceContext:
      workspaceContext as unknown as RegisterCollabContextRoutesDeps['workspaceContext'],
    activeWorkspace,
    listWorkspaceDirectory: async () =>
      options.directory ?? [directoryItem(PERSONAL), directoryItem(TEAM)],
    onWorkspaceSwitched,
  });

  server = http.createServer(app);
  await new Promise<void>((resolve) => server!.listen(0, resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server did not bind');
  const base = `http://127.0.0.1:${address.port}`;

  return {
    onWorkspaceSwitched,
    pinnedWorkspace: () => pinned,
    /** Proof the route has no backend-selection seam left to call. */
    hasBackendSelectionSeam: () => 'selectWorkspace' in workspaceContext,
    async switchTo(workspaceId: string) {
      const response = await fetch(`${base}/api/workspace/active`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspaceId }),
      });
      return { status: response.status, body: (await response.json()) as Record<string, unknown> };
    },
  };
}

describe('PUT /api/workspace/active announces a confirmed switch for cache warming', () => {
  it('announces the new workspace exactly once when the switch is confirmed', async () => {
    const api = await startSwitchServer({});

    const result = await api.switchTo(TEAM);

    expect(result.status).toBe(200);
    expect(api.pinnedWorkspace()).toBe(TEAM);
    // The announcement is what lets the daemon refill the `catalog` and
    // `members` digest faces during the idle beat after the switch, instead of
    // making the first project load or agent run in the new workspace pay for
    // it.
    expect(api.onWorkspaceSwitched).toHaveBeenCalledTimes(1);
    expect(api.onWorkspaceSwitched).toHaveBeenCalledWith(TEAM);
  });

  // Choosing a workspace is a local decision authorized by the membership
  // directory, so there is no backend selection to reject and nothing to roll
  // back. This replaces the old 502 `workspace_switch_rejected` contract: that
  // gate made a purely local action fail on an account-scoped backend write,
  // and that write could only ever name ONE workspace per account.
  it('does not depend on a backend workspace selection at all', async () => {
    const api = await startSwitchServer({});

    const result = await api.switchTo(TEAM);

    expect(result.status).toBe(200);
    expect(api.hasBackendSelectionSeam()).toBe(false);
  });

  it('keeps the switch when the context read cannot confirm it, answering from the directory', async () => {
    // An unreadable context is an unconfirmed READ, never evidence that the
    // user's choice was wrong. Reverting here used to undo a switch the
    // directory had already authorized, and the user saw their click do nothing.
    const api = await startSwitchServer({ currentContext: () => null });

    const result = await api.switchTo(TEAM);

    expect(result.status).toBe(200);
    expect(api.pinnedWorkspace()).toBe(TEAM);
    expect(result.body.activeWorkspaceId).toBe(TEAM);
    // Synthesized from the directory entry the route already validated, so the
    // response still describes the workspace the user picked.
    expect((result.body.context as { workspaceId?: string }).workspaceId).toBe(TEAM);
    expect(api.onWorkspaceSwitched).toHaveBeenCalledWith(TEAM);
  });

  it('keeps the switch when the context read still describes the old workspace', async () => {
    // A stale/lagging context read is likewise not a refusal. The pin is the
    // truth; the web closes the billing plane out on its next context poll.
    const api = await startSwitchServer({ currentContext: () => contextFor(PERSONAL) });

    const result = await api.switchTo(TEAM);

    expect(result.status).toBe(200);
    expect(api.pinnedWorkspace()).toBe(TEAM);
    expect((result.body.context as { workspaceId?: string }).workspaceId).toBe(TEAM);
    expect(api.onWorkspaceSwitched).toHaveBeenCalledWith(TEAM);
  });

  it('stays silent for a workspace the directory does not show', async () => {
    const api = await startSwitchServer({});

    const result = await api.switchTo('ws-not-mine');

    expect(result.status).toBe(404);
    expect(api.onWorkspaceSwitched).not.toHaveBeenCalled();
  });
});

// `workspaceContext.current()` is not a passive read, and that is the whole
// hazard here. The REAL vela provider's `resolvePinnedWorkspace` does its own
// FRESH directory lookup and, when that confirms the pinned workspace is gone,
// clears the pin and re-pins a recovery workspace (so a removed member is not
// locked out of everything). The route's own directory read can meanwhile be a
// 5-second cached success that still lists the workspace.
//
// These cases wire the production provider against the production cached
// directory fetcher, sharing ONE pin store exactly as `server.ts` does, so the
// two reads genuinely disagree instead of a stub pretending they do.
describe('PUT /api/workspace/active when the context read re-pins the workspace', () => {
  const B_PERSONAL_CONTEXT = {
    userId: 'auth-user-1',
    appUserId: 'app-user-1',
    workspaceId: PERSONAL,
    workspaceName: "Ma Shu's workspace",
    workspaceType: 'personal',
    workspaceMemberId: `wm-${PERSONAL}`,
    role: 'owner',
    memberStatus: 'active',
    lifecycleState: 'active',
    billingState: 'active',
    planId: 'personal-pro',
    providerMode: 'platform_credits',
    seatSummary: { seatLimit: 1, usedSeats: 1, availableSeats: 0, isSeatFull: true },
  };

  function velaDirectoryBody(items: WorkspaceDirectoryItem[]) {
    return { items };
  }

  async function startRealProviderServer() {
    let pinned: string | null = PERSONAL;
    let directoryCalls = 0;
    const onWorkspaceSwitched = vi.fn<(workspaceId: string) => void>();

    // Shared pin store — the route writes it, the provider may re-write it.
    const activeWorkspace: NonNullable<RegisterCollabContextRoutesDeps['activeWorkspace']> = {
      get: () => pinned,
      set: async (workspaceId: string) => {
        pinned = workspaceId;
      },
      clear: async () => {
        pinned = null;
      },
    };

    const jsonResponse = (status: number, body: unknown): Response =>
      ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response;

    // Call 1 (the route's read, which gets cached) still lists TEAM.
    // Call 2+ (the provider's fresh read) no longer does — membership is gone.
    const fetchImpl = (async (url: URL | string, init?: RequestInit) => {
      const u = String(url);
      const method = init?.method ?? 'GET';
      if (u.endsWith('/api/v1/workspaces') && method === 'GET') {
        directoryCalls += 1;
        return jsonResponse(
          200,
          velaDirectoryBody(
            directoryCalls === 1
              ? [directoryItem(PERSONAL), directoryItem(TEAM)]
              : [directoryItem(PERSONAL)],
          ),
        );
      }
      if (u.includes('/workspaces/current') && method === 'GET') {
        // TEAM is gone, so B refuses the explicitly scoped read. That is what
        // sends the provider down `resolvePinnedWorkspace`.
        const requested = (init?.headers as Record<string, string> | undefined)?.[
          'x-vela-workspace-id'
        ];
        if (requested === TEAM) return jsonResponse(404, { error: 'workspace_member_required' });
        return jsonResponse(200, B_PERSONAL_CONTEXT);
      }
      throw new Error(`unexpected fetch ${method} ${u}`);
    }) as unknown as typeof fetch;

    const session = {
      profile: 'prod',
      apiUrl: 'https://vela.example',
      controlKey: 'ck-1',
      user: null,
      configMtimeMs: null,
    };

    const workspaceContext = createVelaWorkspaceContextProvider({
      fetch: fetchImpl,
      readSession: () => session as never,
      getActiveWorkspaceId: () => activeWorkspace.get(),
      setLocalSelection: (workspaceId: string) => activeWorkspace.set(workspaceId),
      clearLocalSelection: () => activeWorkspace.clear(),
    });

    // The production cached fetcher: the route's read is served from cache for
    // 5s, which is precisely how it can disagree with the provider's fresh one.
    const cachedDirectory = createCachedWorkspaceDirectoryFetcher({
      fetchDirectory: () => fetchVelaWorkspaceDirectory({ fetch: fetchImpl, readSession: () => session as never }),
      identityKey: () => 'ck-1',
    });

    const app = express();
    app.use(express.json());
    registerCollabContextRoutes(app, {
      workspaceContext,
      activeWorkspace,
      listWorkspaceDirectory: async () => (await cachedDirectory()).items,
      onWorkspaceSwitched,
    } as unknown as RegisterCollabContextRoutesDeps);

    server = http.createServer(app);
    await new Promise<void>((resolve) => server!.listen(0, resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('server did not bind');
    const base = `http://127.0.0.1:${address.port}`;

    return {
      onWorkspaceSwitched,
      pinnedWorkspace: () => pinned,
      async switchTo(workspaceId: string) {
        const response = await fetch(`${base}/api/workspace/active`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ workspaceId }),
        });
        return {
          status: response.status,
          body: (await response.json()) as Record<string, unknown>,
        };
      },
    };
  }

  it('never claims a workspace the pin no longer holds', async () => {
    const api = await startRealProviderServer();

    const result = await api.switchTo(TEAM);

    // The provider confirmed TEAM is gone and recovered to PERSONAL. Answering
    // 200 for TEAM here would make the UI show the switch succeeding and then
    // snap back on the next context poll — the response must not outrank the pin.
    expect(api.pinnedWorkspace()).toBe(PERSONAL);
    expect(result.status).toBe(404);
    expect(result.body.error).toBe('workspace_no_longer_available');
    expect(JSON.stringify(result.body)).not.toContain(TEAM);
    // Nothing moved to TEAM, so warming its caches would be wrong.
    expect(api.onWorkspaceSwitched).not.toHaveBeenCalled();
  });

  it("leaves the provider's recovery pin in place rather than reverting it", async () => {
    const api = await startRealProviderServer();

    await api.switchTo(TEAM);

    // Restoring the pre-switch pin would undo the recovery that exists to stop a
    // removed member being signed out of every workspace.
    expect(api.pinnedWorkspace()).toBe(PERSONAL);
  });
});

describe('PUT /api/workspace/active authorizes on a live membership', () => {
  it('refuses a workspace the directory lists with a removed membership', async () => {
    const api = await startSwitchServer({
      directory: [directoryItem(PERSONAL), { ...directoryItem(TEAM), memberStatus: 'removed' }],
    });

    const result = await api.switchTo(TEAM);

    expect(result.status).toBe(404);
    expect(result.body.error).toBe('workspace_not_visible');
    expect(api.pinnedWorkspace()).toBe(PERSONAL);
    expect(api.onWorkspaceSwitched).not.toHaveBeenCalled();
  });

  it('refuses a workspace the directory lists as deleted', async () => {
    const api = await startSwitchServer({
      directory: [directoryItem(PERSONAL), { ...directoryItem(TEAM), lifecycleState: 'deleted' }],
    });

    const result = await api.switchTo(TEAM);

    expect(result.status).toBe(404);
    expect(result.body.error).toBe('workspace_not_visible');
    expect(api.onWorkspaceSwitched).not.toHaveBeenCalled();
  });
});
