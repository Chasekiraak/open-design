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
 * A switch harness with an in-memory active-workspace pin, so the route is
 * exercised through the same store it mutates rather than a stub that cannot
 * disagree with itself. There is deliberately no backend-selection seam: the
 * pin is the only thing a switch moves.
 */
async function startSwitchServer(options: {
  /** What the follow-up context read answers. Default: agrees with the pin. */
  currentContext?: (pinned: string | null) => WorkspaceCollabContext | null;
  initial?: string;
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
