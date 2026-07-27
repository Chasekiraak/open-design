import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import http from 'node:http';
import {
  buildWorkspacePermissions,
  buildWorkspaceSeatSummary,
  type TeamProject,
  type WorkspaceCollabContext,
} from '@open-design/contracts';
import { createTeamProjectsLister } from '../src/collab/team-projects.js';
import type { WorkspaceContextProvider } from '../src/collab/workspace-context.js';
import { registerCollabContextRoutes } from '../src/routes/collab-context.js';

const PROJECTS: TeamProject[] = [
  {
    projectId: 'p1',
    ownerMemberId: 'wm-owner',
    sharedAt: '2026-07-01T00:00:00.000Z',
    name: 'Launch Deck',
  },
];

function teamContextProvider(): WorkspaceContextProvider {
  const context: WorkspaceCollabContext = {
    workspaceId: 'ws-1',
    workspaceType: 'team',
    workspaceMemberId: 'wm-1',
    role: 'member',
    memberStatus: 'active',
    lifecycleState: 'active',
    billingState: 'active',
    planId: null,
    providerMode: 'platform_credits',
    seatSummary: buildWorkspaceSeatSummary({ seatLimit: 5, usedSeats: 1 }),
    permissions: buildWorkspacePermissions({
      role: 'member',
      lifecycleState: 'active',
    }),
    teamId: 't1',
  };
  return { current: async () => context };
}

function personalContextProvider(): WorkspaceContextProvider {
  return { current: async () => null };
}

let server: http.Server | null = null;

afterEach(async () => {
  if (!server) return;
  const toClose = server;
  server = null;
  await new Promise<void>((resolve) => toClose.close(() => resolve()));
});

async function startServer(deps: {
  workspaceContext: WorkspaceContextProvider;
  listTeamProjects: () => Promise<TeamProject[]>;
}) {
  const app = express();
  app.use(express.json());
  registerCollabContextRoutes(app, deps);
  server = http.createServer(app);
  await new Promise<void>((resolve) => server!.listen(0, resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('server did not bind to a TCP port');
  }
  return async () => {
    const response = await fetch(
      `http://127.0.0.1:${address.port}/api/workspace/projects/team`,
    );
    return {
      status: response.status,
      body: (await response.json()) as Record<string, unknown>,
    };
  };
}

describe('GET /api/workspace/projects/team', () => {
  it('lists projects through the injected Vela team-project catalog', async () => {
    const workspaceContext = teamContextProvider();
    const calls: string[] = [];
    const listTeamProjects = createTeamProjectsLister({
      workspaceContext,
      env: { OD_WORKSPACE_CONTEXT_SOURCE: 'vela' },
      teamProjectCatalog: {
        list: async () => {
          calls.push('list');
          return PROJECTS;
        },
        get: async () => null,
        upsert: async () => {},
        remove: async () => {},
      },
    });
    const get = await startServer({ workspaceContext, listTeamProjects });

    const response = await get();
    expect(response.status).toBe(200);
    expect(calls).toEqual(['list']);
    expect(response.body).toEqual({ projects: PROJECTS });
  });

  it('returns an empty list off-team without invoking Vela', async () => {
    const workspaceContext = personalContextProvider();
    const listTeamProjects = createTeamProjectsLister({
      workspaceContext,
      env: { OD_WORKSPACE_CONTEXT_SOURCE: 'vela' },
      teamProjectCatalog: {
        list: async () => {
          throw new Error('catalog should not be read off-team');
        },
        get: async () => null,
        upsert: async () => {},
        remove: async () => {},
      },
    });
    const get = await startServer({ workspaceContext, listTeamProjects });

    const response = await get();
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ projects: [] });
  });
});
