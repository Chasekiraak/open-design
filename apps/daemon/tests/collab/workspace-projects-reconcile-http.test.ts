// Real-HTTP-layer coverage for `reconcileWorkspaceProjectsWithRemote`
// (collab/workspace-projects-reconciler.ts), wired to the REAL sqlite
// `workspace_projects` CRUD (db.ts) and asserted through the REAL
// `GET /api/workspaces/:workspaceId/projects` endpoint
// (routes/project/index.ts) — not a shallow "the function was called" check.
//
// The concrete, repeatedly-reported scenario this closes: a member's local
// `workspace_projects` row keeps claiming `visibility: 'team'` forever after
// the owner unshares (or deletes) the project, because neither the hub-push
// nor the 15s poller ever re-examined the row — they only refreshed the
// DISPLAY cache. See that file's header comment for the full design.
import express from 'express';
import type http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { registerProjectRoutes } from '../../src/routes/project/index.js';
import {
  closeDatabase,
  ensureWorkspaceProject,
  getProject,
  getWorkspaceProject,
  getWorkspaceProjectByProjectId,
  insertProject,
  listWorkspaceProjectBindings,
  listWorkspaceProjects,
  openDatabase,
  rebindWorkspaceProject,
  updateWorkspaceProject,
} from '../../src/db.js';
import {
  reconcileWorkspaceProjectsWithRemote,
  type LocalTeamProjectBinding,
  type RemoteTeamProjectRef,
} from '../../src/collab/workspace-projects-reconciler.js';

const TEAM_WORKSPACE_ID = 'ws-team-1';
const OWNER_MEMBER_ID = 'member-owner';
const READER_MEMBER_ID = 'member-reader';

function readerTeamHeaders(extra: Record<string, string> = {}) {
  return {
    'content-type': 'application/json',
    'x-od-workspace-id': TEAM_WORKSPACE_ID,
    'x-od-workspace-member-id': READER_MEMBER_ID,
    'x-od-workspace-role': 'member',
    'x-od-workspace-type': 'team',
    'x-od-workspace-member-status': 'active',
    'x-od-workspace-lifecycle-state': 'active',
    'x-od-workspace-can-share-projects': 'true',
    'x-od-workspace-can-write-synced-files': 'true',
    ...extra,
  };
}

async function listen(app: express.Express): Promise<{ server: http.Server; url: string }> {
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

async function close(server: http.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

describe('reconcileWorkspaceProjectsWithRemote, verified through the real workspace projects HTTP endpoint', () => {
  let tempDir: string;
  let projectsRoot: string;
  let db: ReturnType<typeof openDatabase>;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), 'od-workspace-projects-reconcile-'));
    projectsRoot = path.join(tempDir, 'projects');
    db = openDatabase(projectsRoot, { dataDir: tempDir });
  });

  afterEach(async () => {
    closeDatabase();
    await rm(tempDir, { recursive: true, force: true });
  });

  // Real deps for `registerProjectRoutes`, wired to the SAME real sqlite db
  // the reconciler under test writes into — every `projectStore` function is
  // the genuine `db.ts` implementation, matching
  // `tests/routes/project-move-to-personal.test.ts`'s established pattern.
  function buildProjectRoutesDeps(teamProjectCatalog: { list: () => Promise<unknown[]> } | undefined) {
    const noop = vi.fn();
    return {
      db,
      design: {},
      http: {
        createSseResponse: noop,
        sendApiError: (res: any, status: number, code: string, message: string) =>
          res.status(status).json({ error: { code, message } }),
      },
      paths: {
        DESIGN_SYSTEMS_DIR: '',
        PROJECTS_DIR: projectsRoot,
        SKILLS_DIR: '',
        BRANDS_DIR: path.join(tempDir, 'brands'),
        USER_DESIGN_SYSTEMS_DIR: path.join(tempDir, 'user-design-systems'),
      },
      projectStore: {
        insertProject: (row: any) => insertProject(db, row),
        validateLinkedDirs: () => ({ dirs: [] }),
        getProject: (_db: unknown, id: string) => getProject(db, id),
        updateProject: noop,
        dbDeleteProject: noop,
        removeProjectDir: noop,
        stageProjectDirsForDelete: vi.fn(async () => ({ rollback: vi.fn(async () => {}), commit: vi.fn(async () => {}) })),
        deleteWorkspaceProject: noop,
        countWorkspaceProjectRefs: vi.fn(() => 1),
        ensureWorkspaceProject: (_db: unknown, input: any) => ensureWorkspaceProject(db, input),
        getWorkspaceProject: (_db: unknown, workspaceId: string, projectId: string) =>
          getWorkspaceProject(db, workspaceId, projectId),
        getWorkspaceProjectByProjectId: (_db: unknown, projectId: string) =>
          getWorkspaceProjectByProjectId(db, projectId),
        listWorkspaceProjectBindings: () => listWorkspaceProjectBindings(db),
        listWorkspaceProjects: (_db: unknown, workspaceId: string) => listWorkspaceProjects(db, workspaceId),
        updateWorkspaceProject: (_db: unknown, workspaceId: string, projectId: string, patch: any) =>
          updateWorkspaceProject(db, workspaceId, projectId, patch),
        rebindWorkspaceProject: (_db: unknown, projectId: string, patch: any) =>
          rebindWorkspaceProject(db, projectId, patch),
      },
      projectFiles: {
        writeProjectFile: noop,
        readProjectFile: noop,
        ensureProject: noop,
        listFiles: () => [],
        listTabs: () => [],
        setTabs: noop,
        resolveProjectDir: () => '',
      },
      conversations: { insertConversation: noop },
      templates: {
        getTemplate: noop,
        listTemplates: () => [],
        deleteTemplate: noop,
        insertTemplate: noop,
        findTemplateByNameAndProject: noop,
        updateTemplate: noop,
      },
      status: {
        listLatestProjectRunStatuses: () => new Map(),
        listProjectsAwaitingInput: () => new Set(),
        normalizeProjectDisplayStatus: (status: string) => status,
        composeProjectDisplayStatus: (status: unknown) => status,
        listProjects: () => [],
      },
      events: { subscribeFileEvents: noop, activeProjectEventSinks: new Map() },
      ids: { randomId: () => `id-${Math.random().toString(36).slice(2)}` },
      telemetry: { reportFinalizedMessage: noop },
      appConfig: { readAppConfig: vi.fn(async () => ({})), writeAppConfig: noop },
      agents: {},
      validation: {
        validateProjectDesignSystemId: async () => ({ ok: true, id: null }),
        validateProjectSkillId: async () => ({ ok: true, id: null }),
      },
      collabSync: { requestTeamShare: noop, requestTeamUnshare: noop, invalidateTeamProjectCatalog: noop },
      teamProjectCatalog,
    } as unknown as Parameters<typeof registerProjectRoutes>[1];
  }

  function seedProject(id: string, name: string) {
    return insertProject(db, {
      id,
      name,
      skillId: null,
      designSystemId: null,
      pendingPrompt: null,
      metadata: null,
      customInstructions: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  }

  // Real db.ts wiring for the reconciler under test — the same functions
  // `server.ts` itself calls, not a re-implementation. `getWorkspaceIdentity`
  // is fixed to the reader's identity for these tests; the identity-gating
  // behavior itself is covered by the fake-deps unit tests in
  // `workspace-projects-reconciler.test.ts`.
  function reconcileAsReader(remoteProjects: RemoteTeamProjectRef[]) {
    return reconcileWorkspaceProjectsWithRemote({
      getWorkspaceIdentity: async () => ({ workspaceId: TEAM_WORKSPACE_ID, workspaceMemberId: READER_MEMBER_ID }),
      listRemoteTeamProjects: async () => remoteProjects,
      listLocalTeamRows: (workspaceId): LocalTeamProjectBinding[] =>
        listWorkspaceProjects(db, workspaceId)
          .filter((row: any) => row.workspaceVisibility === 'team')
          .map((row: any) => ({
            projectId: row.id,
            workspaceId: row.workspaceId,
            visibility: row.workspaceVisibility,
            createdByWorkspaceMemberId: row.createdByWorkspaceMemberId ?? null,
            resourceHubResourceId: row.resourceHubResourceId ?? null,
          })),
      getLocalBinding: (projectId): LocalTeamProjectBinding | null => {
        const row = getWorkspaceProjectByProjectId(db, projectId) as any;
        if (!row) return null;
        return {
          projectId,
          workspaceId: row.workspaceId,
          visibility: row.visibility,
          createdByWorkspaceMemberId: row.createdByWorkspaceMemberId ?? null,
          resourceHubResourceId: row.resourceHubResourceId ?? null,
        };
      },
      applyBind: (projectId, patch) => {
        // Mirrors server.ts's real wiring: `rebindWorkspaceProject` only
        // corrects an existing row (see db.ts), so a project this daemon has
        // never locally bound needs `ensureWorkspaceProject` instead.
        if (rebindWorkspaceProject(db, projectId, patch)) return;
        ensureWorkspaceProject(db, { projectId, ...patch });
      },
      applyDemote: (workspaceId, projectId, patch) => updateWorkspaceProject(db, workspaceId, projectId, patch),
    });
  }

  it('collapses a member-bound team row back to personal once the owner has unshared it remotely (the recurring "收敛" bug)', async () => {
    const projectId = 'shared-then-unshared';
    seedProject(projectId, 'Shared then unshared');
    // Simulates the state right after this member pulled a project the owner
    // shared: a local `visibility: 'team'` row, read-only (not the creator).
    ensureWorkspaceProject(db, {
      projectId,
      workspaceId: TEAM_WORKSPACE_ID,
      visibility: 'team',
      resourceState: 'active',
      createdByWorkspaceMemberId: null,
      updatedByWorkspaceMemberId: OWNER_MEMBER_ID,
      resourceHubResourceId: `project-${projectId}`,
      syncState: 'synced',
    });
    expect(getWorkspaceProjectByProjectId(db, projectId)).toMatchObject({ visibility: 'team' });

    // The owner has since unshared (or deleted) the project: the hub's team
    // catalog no longer reports it at all.
    const result = await reconcileAsReader([]);
    expect(result).toEqual({ bound: 0, demoted: 1 });

    // 1. Direct table assertion: the local binding itself has converged.
    const row = getWorkspaceProjectByProjectId(db, projectId);
    expect(row).toMatchObject({
      visibility: 'personal',
      resourceHubResourceId: null,
      syncState: 'local_only',
    });

    // 2. Real HTTP assertion: the endpoint every client actually calls
    // (`GET /api/workspaces/:workspaceId/projects`) now agrees — the project
    // no longer shows up under the team view, and shows as personal overall.
    const app = express();
    app.use(express.json());
    registerProjectRoutes(app, buildProjectRoutesDeps({ list: async () => [] }));
    const routeServer = await listen(app);
    try {
      const teamResp = await fetch(
        `${routeServer.url}/api/workspaces/${TEAM_WORKSPACE_ID}/projects?view=team`,
        { headers: readerTeamHeaders() },
      );
      expect(teamResp.status).toBe(200);
      const teamBody = (await teamResp.json()) as { projects: Array<{ id: string }> };
      expect(teamBody.projects.some((p) => p.id === projectId)).toBe(false);

      const allResp = await fetch(
        `${routeServer.url}/api/workspaces/${TEAM_WORKSPACE_ID}/projects`,
        { headers: readerTeamHeaders() },
      );
      const allBody = (await allResp.json()) as { projects: Array<{ id: string; visibility: string }> };
      const found = allBody.projects.find((p) => p.id === projectId);
      expect(found, 'expected the demoted project to still be listed, now as personal').toBeTruthy();
      expect(found?.visibility).toBe('personal');
    } finally {
      await close(routeServer.server);
    }
  });

  it('binds a brand-new remote share this daemon has never locally bound, visible immediately over real HTTP', async () => {
    const projectId = 'freshly-shared';
    seedProject(projectId, 'Freshly shared');
    expect(getWorkspaceProjectByProjectId(db, projectId)).toBeUndefined();

    const result = await reconcileAsReader([{ projectId, ownerMemberId: OWNER_MEMBER_ID }]);
    expect(result).toEqual({ bound: 1, demoted: 0 });

    const row = getWorkspaceProjectByProjectId(db, projectId);
    expect(row).toMatchObject({ workspaceId: TEAM_WORKSPACE_ID, visibility: 'team', createdByWorkspaceMemberId: null });

    const app = express();
    app.use(express.json());
    registerProjectRoutes(app, buildProjectRoutesDeps({ list: async () => [] }));
    const routeServer = await listen(app);
    try {
      const resp = await fetch(
        `${routeServer.url}/api/workspaces/${TEAM_WORKSPACE_ID}/projects?view=team`,
        { headers: readerTeamHeaders() },
      );
      expect(resp.status).toBe(200);
      const body = (await resp.json()) as { projects: Array<{ id: string; visibility: string }> };
      const found = body.projects.find((p) => p.id === projectId);
      expect(found, 'expected the newly-bound project to show under the team view immediately').toBeTruthy();
      expect(found?.visibility).toBe('team');
    } finally {
      await close(routeServer.server);
    }
  });

  it('does not demote on a failed remote read, leaving the row (and the HTTP-visible list) untouched', async () => {
    const projectId = 'still-shared';
    seedProject(projectId, 'Still shared');
    ensureWorkspaceProject(db, {
      projectId,
      workspaceId: TEAM_WORKSPACE_ID,
      visibility: 'team',
      resourceState: 'active',
      createdByWorkspaceMemberId: null,
      updatedByWorkspaceMemberId: OWNER_MEMBER_ID,
      resourceHubResourceId: `project-${projectId}`,
      syncState: 'synced',
    });

    const result = await reconcileWorkspaceProjectsWithRemote({
      getWorkspaceIdentity: async () => ({ workspaceId: TEAM_WORKSPACE_ID, workspaceMemberId: READER_MEMBER_ID }),
      listRemoteTeamProjects: async () => {
        throw new Error('vela unreachable');
      },
      listLocalTeamRows: (workspaceId): LocalTeamProjectBinding[] =>
        listWorkspaceProjects(db, workspaceId)
          .filter((row: any) => row.workspaceVisibility === 'team')
          .map((row: any) => ({
            projectId: row.id,
            workspaceId: row.workspaceId,
            visibility: row.workspaceVisibility,
            createdByWorkspaceMemberId: row.createdByWorkspaceMemberId ?? null,
            resourceHubResourceId: row.resourceHubResourceId ?? null,
          })),
      getLocalBinding: () => null,
      applyBind: (projectId, patch) => rebindWorkspaceProject(db, projectId, patch),
      applyDemote: (workspaceId, projectId, patch) => updateWorkspaceProject(db, workspaceId, projectId, patch),
    });
    expect(result).toEqual({ bound: 0, demoted: 0 });
    expect(getWorkspaceProjectByProjectId(db, projectId)).toMatchObject({ visibility: 'team' });
  });
});
