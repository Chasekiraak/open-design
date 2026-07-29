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
 * A switch harness with an in-memory active-workspace pin, so the rollback path
 * is exercised through the same store the route mutates rather than a stub that
 * cannot disagree with itself.
 */
async function startSwitchServer(options: {
  /** What the backend `selectWorkspace` answers. Default: accepts. */
  selectWorkspace?: (workspaceId: string) => boolean;
  /** What the follow-up context read answers. Default: agrees with the pin. */
  currentContext?: (pinned: string | null) => WorkspaceCollabContext | null;
  initial?: string;
}) {
  let pinned: string | null = options.initial ?? PERSONAL;
  let backendWorkspace = options.initial ?? PERSONAL;
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
  registerCollabContextRoutes(app, {
    workspaceContext: {
      current: async () =>
        options.currentContext
          ? options.currentContext(pinned)
          : pinned
            ? contextFor(pinned)
            : null,
      selectWorkspace: async (workspaceId: string) => {
        const accepted = options.selectWorkspace ? options.selectWorkspace(workspaceId) : true;
        if (accepted) backendWorkspace = workspaceId;
        return accepted;
      },
    } as unknown as RegisterCollabContextRoutesDeps['workspaceContext'],
    activeWorkspace,
    listWorkspaceDirectory: async () => [directoryItem(PERSONAL), directoryItem(TEAM)],
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
    backendWorkspace: () => backendWorkspace,
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

  it('stays silent when the backend rejects the switch', async () => {
    const api = await startSwitchServer({ selectWorkspace: () => false });

    const result = await api.switchTo(TEAM);

    expect(result.status).toBe(502);
    // Nothing moved, so warming here would refill the caches for a workspace
    // this daemon is not operating in.
    expect(api.onWorkspaceSwitched).not.toHaveBeenCalled();
  });

  it('stays silent when the context read disagrees and the switch is rolled back', async () => {
    // The backend accepted the move but the follow-up context read still
    // answers for the old workspace, which is the route's rollback trigger.
    const api = await startSwitchServer({
      currentContext: () => contextFor(PERSONAL),
    });

    const result = await api.switchTo(TEAM);

    expect(result.status).toBe(404);
    expect(api.pinnedWorkspace()).toBe(PERSONAL);
    expect(api.onWorkspaceSwitched).not.toHaveBeenCalled();
  });

  it('stays silent for a workspace the directory does not show', async () => {
    const api = await startSwitchServer({});

    const result = await api.switchTo('ws-not-mine');

    expect(result.status).toBe(404);
    expect(api.onWorkspaceSwitched).not.toHaveBeenCalled();
  });
});
