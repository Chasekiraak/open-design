import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import http from 'node:http';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  buildWorkspacePermissions,
  buildWorkspaceSeatSummary,
  type WorkspaceCollabContext,
} from '@open-design/contracts';
import { runVelaResourceCommand } from '../src/collab/vela-cli-resource-adapter.js';
import {
  createCollabRuntime,
  type CollabRuntime,
  type CreateCollabRuntimeOptions,
} from '../src/collab/runtime.js';
import type { WorkspaceContextProvider } from '../src/collab/workspace-context.js';
import {
  createProactiveContentPull,
  type ProactiveContentPullTarget,
  type ProactivePullAuthorizationWitness,
} from '../src/collab/proactive-content-pull.js';
import { resolveAuthorizedActiveTeamWorkspaceSnapshot } from '../src/collab/active-workspace-selection.js';
import { promoteAuthorizedTeamProjectStage } from '../src/collab/team-mirror-promotion.js';
import {
  getTeamProjectMaterialization,
  materializePulledTeamMirror,
} from '../src/collab/team-mirror-materializer.js';
import { withLastKnownWorkspaceContext } from '../src/collab/workspace-context.js';
import { closeDatabase, getProject, openDatabase } from '../src/db.js';
import { readVelaControlApiContext } from '../src/integrations/vela.js';
import { projectResourceIdFor } from '../src/integrations/vela-team-projects.js';
import {
  registerCollabSyncRoutes,
  type CollabSyncRoutesHandle,
  type PulledProjectStore,
  type RegisterCollabSyncRoutesDeps,
  type RegisterPulledProjectInput,
  type TeamMirrorPullScope,
} from '../src/routes/collab-sync.js';
import { writeProjectManifest } from '../src/project-locations.js';
import type { AuthorizedTeamProjectPullReceipt } from '../src/collab/authorized-team-project-pull.js';

vi.mock('../src/collab/vela-cli-resource-adapter.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/collab/vela-cli-resource-adapter.js')>();
  return {
    ...actual,
    runVelaResourceCommand: vi.fn(),
  };
});

vi.mock('../src/integrations/vela.js', () => ({
  readVelaControlApiContext: vi.fn(() => null),
}));

/** In-memory project store standing in for the daemon's SQLite-backed store, so
 *  a route test can assert register-on-pull without a real database. */
function fakeProjectStore(): PulledProjectStore & {
  projects: Map<string, RegisterPulledProjectInput>;
  bindings: Map<string, TeamMirrorPullScope>;
  registerCalls: number;
} {
  const projects = new Map<string, RegisterPulledProjectInput>();
  const bindings = new Map<string, TeamMirrorPullScope>();
  const store = {
    projects,
    bindings,
    registerCalls: 0,
    get: (projectId: string) => projects.get(projectId) ?? null,
    has: (projectId: string) => projects.has(projectId),
    register(input: RegisterPulledProjectInput) {
      store.registerCalls += 1;
      projects.set(input.id, input);
    },
    update(input: RegisterPulledProjectInput) {
      projects.set(input.id, input);
    },
    materializeTeamMirror(input: RegisterPulledProjectInput, scope: TeamMirrorPullScope) {
      const existing = projects.get(input.id);
      const localRecordChanged = !existing || existing.name === '共享项目';
      if (localRecordChanged) projects.set(input.id, input);
      bindings.set(input.id, scope);
      return { localRecordChanged };
    },
    materializeAuthorizedTeamMirror(
      input: RegisterPulledProjectInput,
      scope: TeamMirrorPullScope,
      _receipt: AuthorizedTeamProjectPullReceipt,
    ) {
      return store.materializeTeamMirror(input, scope);
    },
  };
  return store;
}

/** A personal (non-team) workspace context — the default a fresh account lands
 *  on. Non-null and fully populated, but with no `teamId`: the resource hub is
 *  addressed by its `workspaceId` instead, as a partition of one. */
function personalContextProvider(): WorkspaceContextProvider {
  const context: WorkspaceCollabContext = {
    workspaceId: 'ws-personal-1',
    workspaceType: 'personal',
    workspaceMemberId: 'wm-personal-1',
    role: 'owner',
    memberStatus: 'active',
    lifecycleState: 'active',
    billingState: 'active',
    planId: null,
    providerMode: 'platform_credits',
    seatSummary: buildWorkspaceSeatSummary({ seatLimit: 1, usedSeats: 1 }),
    permissions: buildWorkspacePermissions({ role: 'owner', lifecycleState: 'active' }),
  };
  return { current: async () => context };
}

/** A fixed team context whose `canShareProjects` bit is forced to the tested
 *  value, served by a minimal provider (no `set` seam). */
function fixedShareContextProvider(canShareProjects: boolean): WorkspaceContextProvider {
  const context: WorkspaceCollabContext = {
    workspaceId: 'ws-1',
    workspaceType: 'team',
    teamId: 'team-1',
    workspaceMemberId: 'wm-1',
    role: 'member',
    memberStatus: 'active',
    lifecycleState: 'active',
    billingState: 'active',
    planId: null,
    providerMode: 'platform_credits',
    seatSummary: buildWorkspaceSeatSummary({ seatLimit: 5, usedSeats: 1 }),
    permissions: {
      ...buildWorkspacePermissions({ role: 'member', lifecycleState: 'active' }),
      canShareProjects,
    },
  };
  return { current: async () => context };
}

async function mintProactivePullWitness(
  projectId: string,
  scope: TeamMirrorPullScope,
  version: number,
): Promise<ProactivePullAuthorizationWitness> {
  return (await mintProactivePullTarget(projectId, scope, version))
    .authorizationWitness!;
}

async function mintProactivePullTarget(
  projectId: string,
  scope: TeamMirrorPullScope,
  version: number,
): Promise<ProactiveContentPullTarget> {
  const targets: ProactiveContentPullTarget[] = [];
  const pull = createProactiveContentPull({
    getLocalBinding: () => ({
      workspaceId: scope.workspaceId,
      visibility: 'team',
    }),
    getWorkspaceIdentity: async () => ({
      workspaceId: scope.workspaceId,
      resourceTeamId: scope.resourceTeamId,
      workspaceMemberId: scope.viewerMemberId,
    }),
    resolveSharedProjectOwner: async () => scope.ownerMemberId,
    pullSharedProject: async (input) => {
      targets.push(input);
      return { status: 'pulled', version };
    },
  });
  try {
    await pull.handleContentChanged({
      projectId,
      workspaceId: scope.workspaceId,
      version,
    });
  } finally {
    pull.dispose();
  }
  const target = targets[0];
  if (!target?.authorizationWitness) {
    throw new Error('expected proactive guard to issue a witness');
  }
  return target;
}

async function invokeThroughProactivePull(
  handle: CollabSyncRoutesHandle,
  projectId: string,
  scope: TeamMirrorPullScope,
  version: number,
) {
  let outcome: Awaited<ReturnType<CollabSyncRoutesHandle['pullSharedProject']>>
    | undefined;
  const pull = createProactiveContentPull({
    getLocalBinding: () => ({
      workspaceId: scope.workspaceId,
      visibility: 'team',
    }),
    getWorkspaceIdentity: async () => ({
      workspaceId: scope.workspaceId,
      resourceTeamId: scope.resourceTeamId,
      workspaceMemberId: scope.viewerMemberId,
    }),
    resolveSharedProjectOwner: async () => scope.ownerMemberId,
    pullSharedProject: async (target, expectedVersion) => {
      outcome = await handle.pullSharedProject(
        target.projectId,
        scope,
        target.authorizationWitness,
        expectedVersion,
        target.authorizedStageInvocation,
      );
      return outcome;
    },
  });
  await pull.handleContentChanged({
    projectId,
    workspaceId: scope.workspaceId,
    version,
  });
  if (!outcome) throw new Error('proactive pull did not invoke the route handle');
  return outcome;
}

let server: http.Server | null = null;
let runtime: CollabRuntime | null = null;
const tempDirs: string[] = [];

afterEach(async () => {
  vi.mocked(runVelaResourceCommand).mockReset();
  vi.mocked(readVelaControlApiContext).mockReturnValue(null);
  runtime?.dispose(); // cancel any pending debounce timers
  runtime = null;
  if (server) {
    const toClose = server;
    server = null;
    await new Promise<void>((resolve) => toClose.close(() => resolve()));
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

async function startSyncServer(
  workspaceContext?: WorkspaceContextProvider,
  extraDeps?: Omit<RegisterCollabSyncRoutesDeps, 'collab'>,
  runtimeOptions?: Omit<CreateCollabRuntimeOptions, 'workspaceContext'>,
) {
  const app = express();
  app.use(express.json());
  runtime = createCollabRuntime({
    ...(runtimeOptions ?? {}),
    ...(workspaceContext ? { workspaceContext } : {}),
  });
  const handle: CollabSyncRoutesHandle = registerCollabSyncRoutes(app, { collab: runtime, ...extraDeps });
  server = http.createServer(app);
  await new Promise<void>((resolve) => server!.listen(0, resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server did not bind to a TCP port');
  const base = `http://127.0.0.1:${address.port}`;
  return {
    handle,
    async json(
      route: string,
      options: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
    ) {
      const init: RequestInit = { method: options.method ?? 'GET' };
      if (options.body !== undefined) {
        init.headers = { 'content-type': 'application/json', ...options.headers };
        init.body = JSON.stringify(options.body);
      } else if (options.headers) {
        init.headers = options.headers;
      }
      const response = await fetch(`${base}${route}`, init);
      return { status: response.status, body: (await response.json()) as Record<string, any> };
    },
    // Publishing is async (flush → adapter → onPublished); poll until it lands.
    async awaitPublishedVersion(route: string, notEqualTo: number | null): Promise<number | null> {
      let version = notEqualTo;
      for (let i = 0; i < 40 && version === notEqualTo; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        version = (await this.json(route)).body.publishedVersion;
      }
      return version;
    },
  };
}

describe('collab sync routes', () => {
  it('keeps publish callbacks scoped to every workspace sharing the same project', async () => {
    const onPublished = vi.fn();
    const publish = vi.fn(async (input: { principal?: { memberId?: string } }) => ({
      version: input.principal?.memberId === 'member-a' ? 11 : 22,
    }));
    runtime = createCollabRuntime({
      adapter: { publish },
      onPublished,
    });
    const projectId = 'shared-project';
    const workspaceA = {
      memberId: 'member-a',
      teamId: 'workspace-a',
      role: 'admin' as const,
      lifecycleState: 'active' as const,
    };
    const workspaceB = {
      memberId: 'member-b',
      teamId: 'workspace-b',
      role: 'admin' as const,
      lifecycleState: 'active' as const,
    };

    runtime.requestTeamShare(projectId, workspaceA);
    runtime.requestTeamShare(projectId, workspaceB);

    for (let i = 0; i < 40 && (publish.mock.calls.length < 2 || onPublished.mock.calls.length < 2); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect((publish.mock.calls as unknown as Array<[Record<string, unknown>]>).map((call) => call[0])).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ projectId, principal: workspaceA }),
        expect.objectContaining({ projectId, principal: workspaceB }),
      ]),
    );
    expect(onPublished.mock.calls.map((call) => call[0]?.principal)).toEqual(
      expect.arrayContaining([workspaceA, workspaceB]),
    );
    expect(runtime.publishedVersion(projectId, workspaceA)).toBe(11);
    expect(runtime.publishedVersion(projectId, workspaceB)).toBe(22);
    expect(runtime.projectOwnerMemberId(projectId, workspaceA)).toBe('member-a');
    expect(runtime.projectOwnerMemberId(projectId, workspaceB)).toBe('member-b');

    publish.mockClear();
    onPublished.mockClear();
    runtime.scheduler.notifyChanged(projectId, 'save');
    runtime.scheduler.runBoundary(projectId);

    for (
      let i = 0;
      i < 40 &&
      (publish.mock.calls.length < 2 ||
        runtime.publishedVersion(projectId, workspaceA) === null ||
        runtime.publishedVersion(projectId, workspaceB) === null);
      i += 1
    ) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect((publish.mock.calls as unknown as Array<[Record<string, unknown>]>).map((call) => call[0])).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ projectId, reason: 'save', principal: workspaceA }),
        expect.objectContaining({ projectId, reason: 'save', principal: workspaceB }),
      ]),
    );
    expect(onPublished.mock.calls.map((call) => call[0]?.principal)).toEqual(
      expect.arrayContaining([workspaceA, workspaceB]),
    );
    expect(runtime.publishedVersion(projectId, workspaceA)).toBe(11);
    expect(runtime.publishedVersion(projectId, workspaceB)).toBe(22);
  });

  it('unshares only the requested workspace and keeps other workspace state live', async () => {
    const publish = vi.fn(async (input: { principal?: { memberId?: string } }) => ({
      version: input.principal?.memberId === 'member-a' ? 11 : 22,
    }));
    const unpublish = vi.fn(async () => undefined);
    const teamProjectCatalog = {
      upsert: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined),
    };
    runtime = createCollabRuntime({
      adapter: { publish, unpublish },
      teamProjectCatalog,
    });
    const projectId = 'shared-project';
    const workspaceA = {
      memberId: 'member-a',
      teamId: 'workspace-a',
      role: 'admin' as const,
      lifecycleState: 'active' as const,
    };
    const workspaceB = {
      memberId: 'member-b',
      teamId: 'workspace-b',
      role: 'admin' as const,
      lifecycleState: 'active' as const,
    };

    await runtime.requestTeamShare(projectId, workspaceA);
    await runtime.requestTeamShare(projectId, workspaceB);
    await runtime.requestTeamUnshare(projectId, workspaceA);

    expect(unpublish).toHaveBeenCalledWith({ projectId, principal: workspaceA });
    expect(teamProjectCatalog.remove).toHaveBeenCalledWith(projectId, workspaceA);
    expect(runtime.publishedVersion(projectId, workspaceA)).toBeNull();
    expect(runtime.projectSyncState(projectId, workspaceA)).toBe('local_only');
    expect(runtime.projectOwnerMemberId(projectId, workspaceA)).toBeNull();
    expect(runtime.publishedVersion(projectId, workspaceB)).toBe(22);
    expect(runtime.projectSyncState(projectId, workspaceB)).toBe('synced');
    expect(runtime.projectOwnerMemberId(projectId, workspaceB)).toBe('member-b');
    expect(runtime.publishedVersion(projectId)).toBe(22);
    expect(runtime.projectSyncState(projectId)).toBe('synced');

    publish.mockClear();
    runtime.scheduler.notifyChanged(projectId, 'save');
    runtime.scheduler.runBoundary(projectId);
    for (let i = 0; i < 40 && publish.mock.calls.length < 1; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith({
      projectId,
      reason: 'save',
      principal: workspaceB,
    });
  });

  it('reports ordinary publish failures to every workspace sharing the same project', async () => {
    let failPublish = false;
    const onError = vi.fn();
    const publish = vi.fn(async (input: { principal?: { memberId?: string } }) => {
      if (failPublish) throw new Error('resource hub unavailable');
      return { version: input.principal?.memberId === 'member-a' ? 11 : 22 };
    });
    runtime = createCollabRuntime({
      adapter: { publish },
      onError,
    });
    const projectId = 'shared-project';
    const workspaceA = {
      memberId: 'member-a',
      teamId: 'workspace-a',
      role: 'admin' as const,
      lifecycleState: 'active' as const,
    };
    const workspaceB = {
      memberId: 'member-b',
      teamId: 'workspace-b',
      role: 'admin' as const,
      lifecycleState: 'active' as const,
    };

    runtime.requestTeamShare(projectId, workspaceA);
    runtime.requestTeamShare(projectId, workspaceB);

    for (
      let i = 0;
      i < 40 &&
      (publish.mock.calls.length < 2 ||
        runtime.publishedVersion(projectId, workspaceA) === null ||
        runtime.publishedVersion(projectId, workspaceB) === null);
      i += 1
    ) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    publish.mockClear();
    onError.mockClear();

    failPublish = true;
    runtime.scheduler.notifyChanged(projectId, 'change');
    runtime.scheduler.runBoundary(projectId);

    for (
      let i = 0;
      i < 40 &&
      (onError.mock.calls.length < 2 ||
        runtime.projectSyncState(projectId, workspaceA) !== 'sync_failed' ||
        runtime.projectSyncState(projectId, workspaceB) !== 'sync_failed');
      i += 1
    ) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(onError.mock.calls.map((call) => call[0]?.principal)).toEqual(
      expect.arrayContaining([workspaceA, workspaceB]),
    );
    expect(runtime.projectSyncState(projectId, workspaceA)).toBe('sync_failed');
    expect(runtime.projectSyncState(projectId, workspaceB)).toBe('sync_failed');
  });

  it('does not recreate a failed catalog row when a publish error arrives after unshare', async () => {
    let publishCalls = 0;
    const teamProjectCatalog = {
      upsert: vi.fn(async () => null),
      remove: vi.fn(async () => null),
    };
    const workspace = {
      memberId: 'wm-1',
      teamId: 'ws-1',
      role: 'member' as const,
      lifecycleState: 'active' as const,
    };
    runtime = createCollabRuntime({
      adapter: {
        publish: async () => {
          publishCalls += 1;
          if (publishCalls === 1) return { version: 1 };
          throw new Error('project directory removed after unshare');
        },
        unpublish: async () => {},
      },
      workspaceContext: fixedShareContextProvider(true),
      teamProjectCatalog,
    });

    await runtime.requestTeamShare('landing', workspace);
    for (let i = 0; i < 40 && teamProjectCatalog.upsert.mock.calls.length < 1; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    teamProjectCatalog.upsert.mockClear();

    await runtime.requestTeamUnshare('landing', workspace);
    runtime.scheduler.notifyChanged('landing', 'save');
    runtime.scheduler.runBoundary('landing');
    for (let i = 0; i < 40 && teamProjectCatalog.upsert.mock.calls.length < 1; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(runtime.projectSyncState('landing', workspace)).toBe('local_only');
    expect(teamProjectCatalog.upsert).not.toHaveBeenCalled();
  });

  it('never re-publishes a fully-unshared project when a stale file-watcher notification arrives after unshare', async () => {
    // Regression for "unshare silently reverts to shared" (recvpTXk3liiya):
    // the project's chokidar subscription in collab-publish-watcher.ts is
    // only torn down when the project is deleted locally, never when it is
    // merely unshared. A file touched after the unshare (autosave, thumbnail
    // regen, or any write under the project dir) still fires
    // `scheduler.notifyChanged`. Before the fix, the scheduler adapter found
    // no remaining principal for the project and fell through to publishing
    // it anyway under an unscoped resource id — durably re-sharing it for
    // the window before `onPublished`'s `unshared` guard noticed and issued
    // a compensating unpublish. A status read landing in that window saw the
    // project as shared again.
    const publish = vi.fn(async () => ({ version: 1 }));
    const unpublish = vi.fn(async () => undefined);
    runtime = createCollabRuntime({
      adapter: { publish, unpublish },
    });
    const projectId = 'stale-watcher-project';
    const workspace = {
      memberId: 'wm-1',
      teamId: 'ws-1',
      role: 'member' as const,
      lifecycleState: 'active' as const,
    };

    await runtime.requestTeamShare(projectId, workspace);
    expect(publish).toHaveBeenCalledTimes(1);

    await runtime.requestTeamUnshare(projectId, workspace);
    publish.mockClear();

    // Simulate the stale file-watcher subscription firing after unshare —
    // exactly what collab-publish-watcher.ts's leftover `subs` entry does.
    runtime.scheduler.notifyChanged(projectId, 'file-change');
    runtime.scheduler.runBoundary(projectId);
    for (let i = 0; i < 30; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(publish).not.toHaveBeenCalled();
    expect(runtime.projectOwnerMemberId(projectId, workspace)).toBeNull();
    expect(runtime.projectSyncState(projectId, workspace)).toBe('local_only');
  });

  it('preserves existing sync state when rememberTeamShare only seeds ownership', () => {
    runtime = createCollabRuntime();
    const workspace = {
      memberId: 'member-a',
      teamId: 'workspace-a',
      role: 'admin' as const,
      lifecycleState: 'active' as const,
    };
    runtime.rememberTeamShare('p1', workspace, 'sync_failed');
    runtime.rememberTeamShare('p1', workspace);
    expect(runtime.projectSyncState('p1', workspace)).toBe('sync_failed');
  });

  it('keeps team-project catalog resource ids scoped per workspace principal', async () => {
    const teamProjectCatalog = {
      list: vi.fn(),
      upsert: vi.fn(async () => null),
    };
    runtime = createCollabRuntime({
      teamProjectCatalog,
    });
    const projectId = 'landing';
    const workspaceA = {
      memberId: 'member-a',
      teamId: 'workspace-a',
      role: 'admin' as const,
      lifecycleState: 'active' as const,
    };
    const workspaceB = {
      memberId: 'member-b',
      teamId: 'workspace-b',
      role: 'admin' as const,
      lifecycleState: 'active' as const,
    };

    runtime.requestTeamShare(projectId, workspaceA);
    runtime.requestTeamShare(projectId, workspaceB);

    for (let i = 0; i < 40 && teamProjectCatalog.upsert.mock.calls.length < 2; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const resourceIds = (
      teamProjectCatalog.upsert.mock.calls as unknown as Array<[{
        resourceId?: string;
      }]>
    ).map((call) => call[0]?.resourceId);
    expect(resourceIds).toEqual(
      expect.arrayContaining([
        projectResourceIdFor(projectId, workspaceA),
        projectResourceIdFor(projectId, workspaceB),
      ]),
    );
    expect(projectResourceIdFor(projectId, workspaceA)).not.toBe(projectResourceIdFor(projectId, workspaceB));
  });

  it('writes project discovery metadata when publishing a team share through the runtime', async () => {
    const descriptor = {
      name: 'Electric Studio 2',
      skillId: 'deck-builder',
      designSystemId: 'ds-emerald',
      createdAt: 1719820800000,
      updatedAt: 1719907200000,
      metadata: { kind: 'deck', entryFile: 'index.html' },
    };
    const teamProjectCatalog = {
      upsert: vi.fn(async () => null),
    };
    const workspace = {
      memberId: 'member-owner',
      teamId: 'workspace-team',
      role: 'owner' as const,
      lifecycleState: 'active' as const,
    };
    runtime = createCollabRuntime({
      adapter: { publish: async () => ({ version: 1 }) },
      describeProject: () => descriptor,
      teamProjectCatalog,
    });

    await runtime.requestTeamShare('landing', workspace);
    for (let i = 0; i < 40 && teamProjectCatalog.upsert.mock.calls.length < 1; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(teamProjectCatalog.upsert).toHaveBeenCalledWith(
      {
        projectId: 'landing',
        resourceId: projectResourceIdFor('landing', workspace),
        displayName: 'Electric Studio 2',
        syncState: 'synced',
        metadata: descriptor,
      },
      workspace,
    );
  });

  it('restores persisted team-share principals after runtime restart', async () => {
    const projectId = 'shared-after-restart';
    const workspace = {
      memberId: 'member-owner',
      teamId: 'workspace-restart',
      role: 'member' as const,
      lifecycleState: 'active' as const,
    };
    const initialPublish = vi.fn(async () => ({ version: 1 }));
    runtime = createCollabRuntime({
      adapter: { publish: initialPublish },
    });
    runtime.requestTeamShare(projectId, workspace);
    for (let i = 0; i < 40 && initialPublish.mock.calls.length < 1; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    runtime.dispose();

    const publish = vi.fn(async () => ({ version: 2 }));
    runtime = createCollabRuntime({
      adapter: { publish },
    });
    runtime.rememberTeamShare(projectId, workspace, 'synced');

    expect(runtime.projectOwnerMemberId(projectId, workspace)).toBe('member-owner');
    runtime.scheduler.notifyChanged(projectId, 'change');
    runtime.scheduler.runBoundary(projectId);

    for (let i = 0; i < 40 && publish.mock.calls.length < 1; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({
      projectId,
      principal: workspace,
    }));
  });

  it('publishes on request and advances the published version monotonically', async () => {
    const api = await startSyncServer();
    expect((await api.json('/api/projects/p1/collab/status')).body.publishedVersion).toBeNull();

    const pub = await api.json('/api/projects/p1/collab/publish', { method: 'POST' });
    expect(pub.status).toBe(200);
    expect(pub.body.ok).toBe(true);

    const v1 = await api.awaitPublishedVersion('/api/projects/p1/collab/status', null);
    expect(v1).toBe(1);

    await api.json('/api/projects/p1/collab/publish', { method: 'POST' });
    const v2 = await api.awaitPublishedVersion('/api/projects/p1/collab/status', v1);
    expect(v2).toBe(2);
  });

  it('accepts a coalesced change notification', async () => {
    const api = await startSyncServer();
    const res = await api.json('/api/projects/p1/collab/changed', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('keeps published versions independent per project', async () => {
    const api = await startSyncServer();
    await api.json('/api/projects/a/collab/publish', { method: 'POST' });
    await api.awaitPublishedVersion('/api/projects/a/collab/status', null);
    expect((await api.json('/api/projects/b/collab/status')).body.publishedVersion).toBeNull();
  });

  it('reports local_only sync state before any share', async () => {
    const api = await startSyncServer();
    expect((await api.json('/api/projects/p1/collab/status')).body.syncState).toBe('local_only');
  });

  it('registers a local placeholder when a member opens a not-yet-pulled shared project', async () => {
    const projectStore = fakeProjectStore();
    const api = await startSyncServer(undefined, {
      projectStore,
      resolveSharedProjectOwner: async () => 'other-owner',
    });
    expect(projectStore.has('shared-p')).toBe(false);
    // The first status poll a member fires on opening the shared project must
    // register the placeholder so the other project routes stop 404ing while
    // the pull runs.
    const res = await api.json('/api/projects/shared-p/collab/status');
    expect(res.status).toBe(200);
    expect(projectStore.registerCalls).toBe(1);
    expect(projectStore.projects.get('shared-p')?.name).toBe('共享项目');
    // Idempotent: subsequent polls do not re-register the now-known project.
    await api.json('/api/projects/shared-p/collab/status');
    expect(projectStore.registerCalls).toBe(1);
  });

  it('reports the durable owner-scoped materialized version for a shared project', async () => {
    const readMaterializedVersion = vi.fn(() => 6);
    const api = await startSyncServer(
      fixedShareContextProvider(true),
      {
        resolveSharedProjectOwner: async () => 'wm-owner',
        readMaterializedVersion,
      },
      {
        adapter: {
          publish: async () => ({ version: 7 }),
          syncLatest: async () => ({ version: 7 }),
        },
      },
    );

    const res = await api.json('/api/projects/shared-p/collab/status');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      publishedVersion: 7,
      materializedVersion: 6,
      ownerMemberId: 'wm-owner',
    });
    expect(readMaterializedVersion).toHaveBeenCalledWith('shared-p', {
      workspaceId: 'ws-1',
      resourceTeamId: 'team-1',
      viewerMemberId: 'wm-1',
      ownerMemberId: 'wm-owner',
    });
  });

  it('fails closed to a null materialized version when the durable cursor cannot be read', async () => {
    const api = await startSyncServer(
      fixedShareContextProvider(true),
      {
        resolveSharedProjectOwner: async () => 'wm-owner',
        readMaterializedVersion: () => {
          throw new Error('cursor unavailable');
        },
      },
      {
        adapter: {
          publish: async () => ({ version: 7 }),
          syncLatest: async () => ({ version: 7 }),
        },
      },
    );

    const res = await api.json('/api/projects/shared-p/collab/status');

    expect(res.status).toBe(200);
    expect(res.body.materializedVersion).toBeNull();
  });

  it('registers a local placeholder when the OWNER opens their own shared project not materialized on this machine', async () => {
    const projectStore = fakeProjectStore();
    const api = await startSyncServer(undefined, {
      projectStore,
      // The hub reports the caller themselves as the owner.
      resolveSharedProjectOwner: async () => 'owner-self',
    });
    expect(projectStore.has('shared-owned')).toBe(false);
    // An owner can hit a shared project that is NOT in this daemon's local DB —
    // it was created/shared on another machine (or a smoke-test attributed it to
    // them in the hub). Opening it must still register the placeholder, or
    // conversations/events/tabs 404 and the left pane hangs for a minute. The
    // owner never auto-pulls, so nothing else registers it. callerIsOwner=true
    // here (owner member id === caller's own member id via the workspace header).
    const ownerHeaders = {
      'x-od-workspace-id': 'ws-1',
      'x-od-workspace-member-id': 'owner-self',
    };
    const res = await api.json('/api/projects/shared-owned/collab/status', {
      headers: ownerHeaders,
    });
    expect(res.status).toBe(200);
    expect(projectStore.registerCalls).toBe(1);
    expect(projectStore.projects.get('shared-owned')?.name).toBe('共享项目');
    // Idempotent: the now-known project is not re-registered on the next poll.
    await api.json('/api/projects/shared-owned/collab/status', { headers: ownerHeaders });
    expect(projectStore.registerCalls).toBe(1);
  });

  it('drives the visibility-to-sync team-share intent through to synced', async () => {
    const api = await startSyncServer(fixedShareContextProvider(true));
    const intent = await api.json('/api/projects/p1/collab/sync-intent', {
      method: 'POST',
      body: { event: 'project_team_share_requested', projectId: 'p1' },
    });
    expect(intent.status).toBe(200);
    // Team-share is user-facing: the route waits for a durable resource version
    // before reporting success, so teammates never see a catalog-only shell.
    expect(intent.body.syncState).toBe('synced');
    expect(intent.body.publishedVersion).toBe(1);
    expect((await api.json('/api/projects/p1/collab/status')).body.publishedVersion).toBe(1);
  });

  it('moves a team-shared project back to local_only on unshare intent', async () => {
    const api = await startSyncServer(fixedShareContextProvider(true));
    await api.json('/api/projects/p1/collab/sync-intent', {
      method: 'POST',
      body: { event: 'project_team_share_requested', projectId: 'p1' },
    });
    await api.awaitPublishedVersion('/api/projects/p1/collab/status', null);

    const unshare = await api.json('/api/projects/p1/collab/sync-intent', {
      method: 'POST',
      body: { event: 'project_team_unshare_requested', projectId: 'p1' },
    });

    expect(unshare.status).toBe(200);
    expect(unshare.body.syncState).toBe('local_only');
    const status = await api.json('/api/projects/p1/collab/status');
    expect(status.body.syncState).toBe('local_only');
    expect(status.body.publishedVersion).toBeNull();
  });

  it('accepts a visibility-changed intent as a no-op signal', async () => {
    const api = await startSyncServer();
    const res = await api.json('/api/projects/p1/collab/sync-intent', {
      method: 'POST',
      body: { event: 'project_visibility_changed', projectId: 'p1' },
    });
    expect(res.status).toBe(200);
    expect(res.body.syncState).toBe('local_only'); // visibility change alone doesn't publish
  });

  it('rejects an unknown sync intent event', async () => {
    const api = await startSyncServer();
    const res = await api.json('/api/projects/p1/collab/sync-intent', {
      method: 'POST',
      body: { event: 'nonsense', projectId: 'p1' },
    });
    expect(res.status).toBe(400);
  });

  it('refuses a team-share intent from a member without canShareProjects (server-side gate)', async () => {
    // The client hides the share affordance, but the daemon must not trust the
    // client — a member whose context lacks canShareProjects is refused (403),
    // and the project stays local_only (no publish is triggered).
    const api = await startSyncServer(fixedShareContextProvider(false));
    const res = await api.json('/api/projects/p1/collab/sync-intent', {
      method: 'POST',
      body: { event: 'project_team_share_requested', projectId: 'p1' },
    });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('WORKSPACE_PROJECT_SHARE_DENIED');
    expect((await api.json('/api/projects/p1/collab/status')).body.syncState).toBe('local_only');
  });

  it('refuses a team-share intent when no workspace context is available', async () => {
    const api = await startSyncServer({ current: async () => null });
    const res = await api.json('/api/projects/p1/collab/sync-intent', {
      method: 'POST',
      body: { event: 'project_team_share_requested', projectId: 'p1' },
    });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('WORKSPACE_PROJECT_SHARE_DENIED');
    expect((await api.json('/api/projects/p1/collab/status')).body.syncState).toBe('local_only');
  });

  it('honors a team-share intent from a member with canShareProjects', async () => {
    const api = await startSyncServer(fixedShareContextProvider(true));
    const res = await api.json('/api/projects/p1/collab/sync-intent', {
      method: 'POST',
      body: { event: 'project_team_share_requested', projectId: 'p1' },
    });
    expect(res.status).toBe(200);
    expect(res.body.syncState).toBe('synced');
    expect(res.body.publishedVersion).toBe(1);
  });

  it('treats an already shared project owned by another member as shared instead of republishing it', async () => {
    let publishCalls = 0;
    const api = await startSyncServer(
      fixedShareContextProvider(true),
      {
        resolveSharedProject: async () => ({
          projectId: 'p1',
          ownerMemberId: 'wm-owner',
          sharedAt: new Date(1).toISOString(),
          name: 'Owner Project',
        }),
      },
      {
        adapter: {
          publish: async () => {
            publishCalls += 1;
            throw new Error('resource hub should not be called');
          },
          syncLatest: async () => null,
          pull: async () => null,
          unpublish: async () => {},
        },
      },
    );

    const res = await api.json('/api/projects/p1/collab/sync-intent', {
      method: 'POST',
      body: { event: 'project_team_share_requested', projectId: 'p1' },
    });

    expect(res.status).toBe(200);
    expect(res.body.syncState).toBe('synced');
    expect(publishCalls).toBe(0);
  });

  it('refuses to unshare a project owned by another member', async () => {
    const api = await startSyncServer(fixedShareContextProvider(true), {
      resolveSharedProject: async () => ({
        projectId: 'p1',
        ownerMemberId: 'wm-owner',
        sharedAt: new Date(1).toISOString(),
        name: 'Owner Project',
      }),
    });

    const res = await api.json('/api/projects/p1/collab/sync-intent', {
      method: 'POST',
      body: { event: 'project_team_unshare_requested', projectId: 'p1' },
    });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('WORKSPACE_PROJECT_UNSHARE_DENIED');
  });

  it('publishes a public file from a personal workspace, scoped by its workspace id', async () => {
    // The public-file routes require A workspace, not a TEAM workspace.
    //
    // They were briefly team-only, on the premise that a hub snapshot is keyed
    // by teamId and a personal session had nothing to publish under. B's
    // control-key auth path stopped refusing non-team callers: it mints a
    // principal whose teamId IS the workspace id, and its access check only
    // compares that id against the resource's own — a partition of one. So a
    // personal workspace must get through, and must be scoped by its OWN id.
    const dir = await mkdtemp(path.join(tmpdir(), 'od-public-file-'));
    tempDirs.push(dir);
    await writeFile(path.join(dir, 'index.html'), '<h1>Published</h1>');
    vi.mocked(readVelaControlApiContext).mockReturnValue({
      profile: 'test',
      apiUrl: 'https://hub.example.test',
      controlKey: 'ctrl-test',
      user: null,
      configMtimeMs: null,
    });
    vi.mocked(runVelaResourceCommand).mockImplementation(async (args) => {
      if (args[0] === 'snapshot') {
        return JSON.stringify({
          slug: 'personal-slug',
          name: 'index.html',
          kind: 'project',
          versionId: 'v1',
          createdAt: new Date(1).toISOString(),
        });
      }
      return JSON.stringify({ version: 1 });
    });
    const api = await startSyncServer(personalContextProvider(), {
      resolveProjectDir: () => dir,
      resolveSharedProject: async () => null,
    });

    const publish = await api.json('/api/projects/p1/files/index.html/publish-public', {
      method: 'POST',
    });

    expect(publish.status).toBe(200);
    expect(publish.body).toEqual({
      url: 'https://hub.example.test/api/v1/public/snapshots/personal-slug/files/index.html',
      slug: 'personal-slug',
      fileName: 'index.html',
    });
    // Every hub call carries the personal workspace's own id as the scope —
    // there is no teamId on this context, and nothing may invent one.
    expect(runVelaResourceCommand).toHaveBeenCalled();
    for (const call of vi.mocked(runVelaResourceCommand).mock.calls) {
      expect(call[1]).toBe('ws-personal-1');
    }

    // The published link then reads back and clears like any other.
    const current = await api.json('/api/projects/p1/files/index.html/publish-public');
    expect(current.body.publication?.slug).toBe('personal-slug');
    const unpublish = await api.json('/api/projects/p1/files/index.html/publish-public', {
      method: 'DELETE',
      body: { slug: 'personal-slug' },
    });
    expect(unpublish.status).toBe(200);
  });

  it('explains, rather than bare-codes, a public file publish with no workspace at all', async () => {
    // The gate was widened, not removed. A signed-out caller (or a context read
    // that came back empty) has no id to publish under and no member id to own
    // the resource with, so all three handlers still refuse it — and must ship a
    // human-readable reason alongside the code, since the `od` CLI and embedding
    // agents surface the body verbatim. The sentence now says SIGN IN; telling a
    // personal user to "switch to a team workspace" is no longer true.
    const resolveProjectDir = vi.fn(() => {
      throw new Error('project dir should not be read');
    });
    const api = await startSyncServer(
      { current: async () => null },
      { resolveProjectDir, resolveSharedProject: async () => null },
    );

    const publish = await api.json('/api/projects/p1/files/index.html/publish-public', {
      method: 'POST',
    });
    const read = await api.json('/api/projects/p1/files/index.html/publish-public');
    const unpublish = await api.json('/api/projects/p1/files/index.html/publish-public', {
      method: 'DELETE',
      body: { slug: 'public-slug' },
    });

    for (const res of [publish, read, unpublish]) {
      expect(res.status).toBe(409);
      expect(res.body.error).toBe('WORKSPACE_IDENTITY_REQUIRED');
      // The load-bearing assertion: a human-readable reason ships with the code.
      expect(typeof res.body.message).toBe('string');
      expect(res.body.message).toMatch(/sign in/i);
      expect(res.body.message).not.toMatch(/team workspace/i);
    }
    // The gate must short-circuit before any project read or hub call.
    expect(resolveProjectDir).not.toHaveBeenCalled();
    expect(runVelaResourceCommand).not.toHaveBeenCalled();
  });

  it('refuses public file publishing for a shared project owned by another member', async () => {
    const resolveProjectDir = vi.fn(() => {
      throw new Error('project dir should not be read');
    });
    vi.mocked(readVelaControlApiContext).mockReturnValue({
      profile: 'test',
      apiUrl: 'https://hub.example.test',
      controlKey: 'ctrl-test',
      user: null,
      configMtimeMs: null,
    });
    const api = await startSyncServer(fixedShareContextProvider(true), {
      resolveProjectDir,
      resolveSharedProject: async () => ({
        projectId: 'p1',
        ownerMemberId: 'wm-owner',
        sharedAt: new Date(1).toISOString(),
        name: 'Owner Project',
      }),
    });

    const res = await api.json('/api/projects/p1/files/index.html/publish-public', {
      method: 'POST',
    });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('WORKSPACE_PROJECT_PUBLISH_DENIED');
    expect(resolveProjectDir).not.toHaveBeenCalled();
  });

  it('fails public file publish and unpublish when ownership lookup fails', async () => {
    const resolveProjectDir = vi.fn(() => {
      throw new Error('project dir should not be read');
    });
    vi.mocked(readVelaControlApiContext).mockReturnValue({
      profile: 'test',
      apiUrl: 'https://hub.example.test',
      controlKey: 'ctrl-test',
      user: null,
      configMtimeMs: null,
    });
    const api = await startSyncServer(fixedShareContextProvider(true), {
      resolveProjectDir,
      resolveSharedProject: async () => {
        throw new Error('catalog unavailable');
      },
    });

    const publish = await api.json('/api/projects/p1/files/index.html/publish-public', {
      method: 'POST',
    });
    const unpublish = await api.json('/api/projects/p1/files/index.html/publish-public', {
      method: 'DELETE',
      body: { slug: 'public-slug' },
    });

    expect(publish.status).toBe(503);
    expect(publish.body.error).toBe('WORKSPACE_PROJECT_OWNERSHIP_UNAVAILABLE');
    expect(unpublish.status).toBe(503);
    expect(unpublish.body.error).toBe('WORKSPACE_PROJECT_OWNERSHIP_UNAVAILABLE');
    expect(resolveProjectDir).not.toHaveBeenCalled();
    expect(runVelaResourceCommand).not.toHaveBeenCalled();
  });

  it('does not create a public snapshot when no public base URL is configured', async () => {
    const resolveProjectDir = vi.fn(() => {
      throw new Error('project dir should not be read');
    });
    const api = await startSyncServer(fixedShareContextProvider(true), {
      resolveProjectDir,
      resolveSharedProject: async () => null,
    });

    const res = await api.json('/api/projects/p1/files/index.html/publish-public', {
      method: 'POST',
    });

    expect(res.status).toBe(502);
    expect(res.body.error).toBe('PUBLIC_FILE_URL_UNAVAILABLE');
    expect(resolveProjectDir).not.toHaveBeenCalled();
    expect(runVelaResourceCommand).not.toHaveBeenCalled();
  });

  it('hydrates and clears public file publication state', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'od-public-file-'));
    tempDirs.push(dir);
    await writeFile(path.join(dir, 'index.html'), '<h1>Published</h1>');
    vi.mocked(readVelaControlApiContext).mockReturnValue({
      profile: 'test',
      apiUrl: 'https://hub.example.test',
      controlKey: 'ctrl-test',
      user: null,
      configMtimeMs: null,
    });
    vi.mocked(runVelaResourceCommand).mockImplementation(async (args) => {
      if (args[0] === 'snapshot') {
        return JSON.stringify({
          slug: 'public-slug',
          name: 'index.html',
          kind: 'project',
          versionId: 'v1',
          createdAt: new Date(1).toISOString(),
        });
      }
      return JSON.stringify({ version: 1 });
    });
    const api = await startSyncServer(fixedShareContextProvider(true), {
      resolveProjectDir: () => dir,
      resolveSharedProject: async () => null,
    });

    const publish = await api.json('/api/projects/p1/files/index.html/publish-public', { method: 'POST' });
    const current = await api.json('/api/projects/p1/files/index.html/publish-public');
    const unpublish = await api.json('/api/projects/p1/files/index.html/publish-public', {
      method: 'DELETE',
      body: { slug: 'public-slug' },
    });
    const afterUnpublish = await api.json('/api/projects/p1/files/index.html/publish-public');

    const publication = {
      url: 'https://hub.example.test/api/v1/public/snapshots/public-slug/files/index.html',
      slug: 'public-slug',
      fileName: 'index.html',
    };
    expect(publish.status).toBe(200);
    expect(publish.body).toEqual(publication);
    expect(current.body.publication).toEqual(publication);
    expect(unpublish.status).toBe(200);
    expect(afterUnpublish.body.publication).toBeNull();
  });

  it('publishes a public file when the project-dir resolver is async (production wiring)', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'od-public-file-'));
    tempDirs.push(dir);
    await writeFile(path.join(dir, 'index.html'), '<h1>Published</h1>');
    vi.mocked(readVelaControlApiContext).mockReturnValue({
      profile: 'test',
      apiUrl: 'https://hub.example.test',
      controlKey: 'ctrl-test',
      user: null,
      configMtimeMs: null,
    });
    vi.mocked(runVelaResourceCommand).mockImplementation(async (args) => {
      if (args[0] === 'snapshot') {
        return JSON.stringify({
          slug: 'public-slug',
          name: 'index.html',
          kind: 'project',
          versionId: 'v1',
          createdAt: new Date(1).toISOString(),
        });
      }
      return JSON.stringify({ version: 1 });
    });
    // Production injects resolveProjectDir as an async resolver (it awaits
    // ensureProject before returning the share dir). The handler must await it;
    // otherwise the raw Promise reaches realpath and the owner gets a spurious
    // FILE_UNAVAILABLE even though the file is present and readable.
    const api = await startSyncServer(fixedShareContextProvider(true), {
      resolveProjectDir: async () => dir,
      resolveSharedProject: async () => null,
    });

    const publish = await api.json('/api/projects/p1/files/index.html/publish-public', { method: 'POST' });

    expect(publish.status).toBe(200);
    expect(publish.body).toEqual({
      url: 'https://hub.example.test/api/v1/public/snapshots/public-slug/files/index.html',
      slug: 'public-slug',
      fileName: 'index.html',
    });
  });

  it('rejects escaped and symlinked public file paths before publishing', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'od-public-file-'));
    const outsideDir = await mkdtemp(path.join(tmpdir(), 'od-public-outside-'));
    tempDirs.push(dir, outsideDir);
    await writeFile(path.join(outsideDir, 'secret.html'), '<h1>Secret</h1>');
    await symlink(path.join(outsideDir, 'secret.html'), path.join(dir, 'secret-link.html'));
    vi.mocked(readVelaControlApiContext).mockReturnValue({
      profile: 'test',
      apiUrl: 'https://hub.example.test',
      controlKey: 'ctrl-test',
      user: null,
      configMtimeMs: null,
    });
    const api = await startSyncServer(fixedShareContextProvider(true), {
      resolveProjectDir: () => dir,
      resolveSharedProject: async () => null,
    });

    const backslash = await api.json('/api/projects/p1/files/nested%5Csecret.html/publish-public', { method: 'POST' });
    const symlinked = await api.json('/api/projects/p1/files/secret-link.html/publish-public', { method: 'POST' });

    expect(backslash.status).toBe(400);
    expect(backslash.body.error).toBe('invalid_file_path');
    expect(symlinked.status).toBe(400);
    expect(symlinked.body.error).toBe('FILE_UNAVAILABLE');
    expect(runVelaResourceCommand).not.toHaveBeenCalled();
  });

  it('writes and removes the Vela team-project catalog around share intents', async () => {
    const writes: unknown[] = [];
    const removes: string[] = [];
    const api = await startSyncServer(
      fixedShareContextProvider(true),
      undefined,
      {
        adapter: {
          publish: async () => ({ version: 1, versionId: 'version-1' }),
          unpublish: async () => {},
        },
        describeProject: () => ({
          name: 'Electric Studio 2',
          skillId: null,
          designSystemId: null,
          createdAt: 1,
          updatedAt: 2,
        }),
        teamProjectCatalog: {
          upsert: async (input) => {
            writes.push(input);
          },
          remove: async (projectId) => {
            removes.push(projectId);
          },
        },
      },
    );

    const share = await api.json('/api/projects/p1/collab/sync-intent', {
      method: 'POST',
      body: { event: 'project_team_share_requested', projectId: 'p1' },
    });
    expect(share.status).toBe(200);
    expect(writes).toEqual([
      {
        projectId: 'p1',
        resourceId: projectResourceIdFor('p1', {
          teamId: 'team-1',
          memberId: 'wm-1',
          role: 'member',
          lifecycleState: 'active',
        }),
        displayName: 'Electric Studio 2',
        syncState: 'synced',
        lastSyncedVersionId: 'version-1',
        metadata: {
          name: 'Electric Studio 2',
          skillId: null,
          designSystemId: null,
          createdAt: 1,
          updatedAt: 2,
        },
      },
    ]);

    const unshare = await api.json('/api/projects/p1/collab/sync-intent', {
      method: 'POST',
      body: { event: 'project_team_unshare_requested', projectId: 'p1' },
    });
    expect(unshare.status).toBe(200);
    expect(removes).toEqual(['p1']);
  });

  it('does not pretend a project is shared when the Vela catalog write fails', async () => {
    const unpublish = vi.fn(async () => undefined);
    const api = await startSyncServer(
      fixedShareContextProvider(true),
      undefined,
      {
        adapter: {
          publish: async () => ({ version: 1, versionId: 'version-1' }),
          unpublish,
        },
        teamProjectCatalog: {
          upsert: async () => {
            throw new Error('catalog unavailable');
          },
          remove: async () => {},
        },
      },
    );

    const res = await api.json('/api/projects/p1/collab/sync-intent', {
      method: 'POST',
      body: { event: 'project_team_share_requested', projectId: 'p1' },
    });
    expect(res.status).toBe(502);
    expect(res.body.error).toBe('TEAM_PROJECT_PUBLISH_UNAVAILABLE');
    expect(unpublish).toHaveBeenCalledTimes(1);
    expect((await api.json('/api/projects/p1/collab/status')).body.syncState).toBe('sync_failed');
  });

  it('does not write the team catalog when resource publishing fails', async () => {
    const writes: unknown[] = [];
    const api = await startSyncServer(
      fixedShareContextProvider(true),
      undefined,
      {
        teamProjectCatalog: {
          upsert: async (input) => {
            writes.push(input);
          },
          remove: async () => {},
        },
        adapter: {
          publish: async () => {
            throw new Error('resource hub unavailable');
          },
          syncLatest: async () => null,
          pull: async () => null,
          unpublish: async () => {},
        },
      },
    );

    const res = await api.json('/api/projects/p1/collab/sync-intent', {
      method: 'POST',
      body: { event: 'project_team_share_requested', projectId: 'p1' },
    });

    expect(res.status).toBe(502);
    expect(res.body.error).toBe('TEAM_PROJECT_PUBLISH_UNAVAILABLE');
    expect(writes).toEqual([]);
    expect((await api.json('/api/projects/p1/collab/status')).body.syncState).toBe('sync_failed');
  });

  it('uses header-only workspace identity for sync intent, status, and pull', async () => {
    const api = await startSyncServer({ current: async () => null });
    const headers = {
      'x-od-workspace-id': 'ws-header',
      'x-od-workspace-member-id': 'member-header',
      'x-od-workspace-role': 'admin',
    };

    const intent = await api.json('/api/projects/p1/collab/sync-intent', {
      method: 'POST',
      headers,
      body: { event: 'project_team_share_requested', projectId: 'p1' },
    });
    expect(intent.status).toBe(200);
    expect(['pending_upload', 'synced']).toContain(intent.body.syncState);

    let status = await api.json('/api/projects/p1/collab/status', { headers });
    for (let i = 0; i < 40 && status.body.syncState !== 'synced'; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      status = await api.json('/api/projects/p1/collab/status', { headers });
    }
    expect(status.body).toMatchObject({
      syncState: 'synced',
      ownerMemberId: 'member-header',
      publishedVersion: 1,
    });

    const pull = await api.json('/api/projects/p1/collab/pull', { method: 'POST', headers });
    expect(pull.status).toBe(200);
    expect(pull.body.version).toBe(1);
  });

  it('pulls the published head for a member (null before any publish)', async () => {
    const api = await startSyncServer();
    const before = await api.json('/api/projects/p1/collab/pull', { method: 'POST' });
    expect(before.status).toBe(200);
    expect(before.body.version).toBeNull();

    await api.json('/api/projects/p1/collab/publish', { method: 'POST' });
    await api.awaitPublishedVersion('/api/projects/p1/collab/status', null);
    const after = await api.json('/api/projects/p1/collab/pull', { method: 'POST' });
    expect(after.body.version).toBe(1);
  });

  it('refuses to pull a project that is no longer team-shared (revocation)', async () => {
    // The team catalog no longer lists this project (the owner moved it out of
    // the team). A stale local copy on a former member's daemon must not be able
    // to keep pulling fresh content, and the mirror is flagged revoked so its
    // files stop being served.
    const revoked: Array<{ projectId: string; revoked: boolean }> = [];
    const api = await startSyncServer(fixedShareContextProvider(true), {
      resolveSharedProject: async () => null,
      markTeamProjectRevoked: (projectId, value) => revoked.push({ projectId, revoked: value }),
    });

    const pull = await api.json('/api/projects/moved-out-project/collab/pull', { method: 'POST' });

    expect(pull.status).toBe(403);
    expect(pull.body.error).toBe('WORKSPACE_PROJECT_PULL_DENIED');
    expect(revoked).toContainEqual({ projectId: 'moved-out-project', revoked: true });
  });

  it('does not register a placeholder project when there is no published version to pull', async () => {
    const store = fakeProjectStore();
    const api = await startSyncServer(undefined, { projectStore: store });

    const pull = await api.json('/api/projects/unpublished-shared/collab/pull', { method: 'POST' });
    expect(pull.status).toBe(200);
    expect(pull.body.version).toBeNull();
    expect(store.has('unpublished-shared')).toBe(false);
  });

  it('fails the pull route when a pulled shared project cannot be registered locally', async () => {
    const api = await startSyncServer(undefined, {
      projectStore: {
        get: () => null,
        has: () => false,
        register: () => {
          throw new Error('project store unavailable');
        },
      },
      resolvePullDir: (projectId) => `/does/not/exist/${projectId}`,
    });

    await api.json('/api/projects/shared-register-fail/collab/publish', { method: 'POST' });
    await api.awaitPublishedVersion('/api/projects/shared-register-fail/collab/status', null);
    const pull = await api.json('/api/projects/shared-register-fail/collab/pull', { method: 'POST' });
    expect(pull.status).toBe(502);
    expect(pull.body.error).toBe('TEAM_PROJECT_PULL_REGISTER_UNAVAILABLE');
  });

  it('registers a pulled shared project locally so it appears in the project store', async () => {
    const store = fakeProjectStore();
    const api = await startSyncServer(undefined, {
      projectStore: store,
      resolvePullDir: (projectId) => `/does/not/exist/${projectId}`,
    });

    expect(store.has('shared-1')).toBe(false);
    await api.json('/api/projects/shared-1/collab/publish', { method: 'POST' });
    await api.awaitPublishedVersion('/api/projects/shared-1/collab/status', null);
    const pull = await api.json('/api/projects/shared-1/collab/pull', { method: 'POST' });
    expect(pull.status).toBe(200);

    // The pull registered a local project record. With no manifest under the
    // (non-existent) pull dir, it falls back to the placeholder name.
    expect(store.has('shared-1')).toBe(true);
    expect(store.projects.get('shared-1')?.name).toBe('共享项目');
  });

  it('notifies notifyFilesChanged after a successful pull, so an open FileViewer refreshes without depending on chokidar surviving the pull\'s directory-replace (recvq6CIesNvWZ)', async () => {
    const store = fakeProjectStore();
    const notifyFilesChanged = vi.fn();
    const api = await startSyncServer(undefined, {
      projectStore: store,
      resolvePullDir: (projectId) => `/does/not/exist/${projectId}`,
      notifyFilesChanged,
    });

    await api.json('/api/projects/shared-notify/collab/publish', { method: 'POST' });
    await api.awaitPublishedVersion('/api/projects/shared-notify/collab/status', null);
    expect(notifyFilesChanged).not.toHaveBeenCalled();
    const pull = await api.json('/api/projects/shared-notify/collab/pull', { method: 'POST' });
    expect(pull.status).toBe(200);
    expect(notifyFilesChanged).toHaveBeenCalledTimes(1);
    expect(notifyFilesChanged).toHaveBeenCalledWith('shared-notify');
  });

  it('does not call notifyFilesChanged when the pulled project fails to register locally', async () => {
    const notifyFilesChanged = vi.fn();
    const api = await startSyncServer(undefined, {
      projectStore: {
        get: () => null,
        has: () => false,
        register: () => {
          throw new Error('project store unavailable');
        },
      },
      resolvePullDir: (projectId) => `/does/not/exist/${projectId}`,
      notifyFilesChanged,
    });

    await api.json('/api/projects/shared-notify-fail/collab/publish', { method: 'POST' });
    await api.awaitPublishedVersion('/api/projects/shared-notify-fail/collab/status', null);
    const pull = await api.json('/api/projects/shared-notify-fail/collab/pull', { method: 'POST' });
    expect(pull.status).toBe(502);
    expect(notifyFilesChanged).not.toHaveBeenCalled();
  });

  // recvqhwv6RPU1j: replacing the "共享项目" placeholder record with the real
  // project name happens only in the daemon DB (registerPulledProject). The
  // only post-pull signal used to be `file-changed`, which makes the web
  // refresh the FILE LIST but never re-read the project record — so a member's
  // sidebar/tab title stayed on the placeholder until a manual page reload.
  // A pull that registered or updated the local record must also emit the
  // existing `project-metadata-changed` thin signal (notifyProjectMetadataChanged)
  // so the open project view re-fetches the record and the title follows.
  it('notifies notifyProjectMetadataChanged when a pull replaces the placeholder record with the real name (recvqhwv6RPU1j)', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'od-pull-'));
    tempDirs.push(dir);
    await writeProjectManifest(dir, {
      schemaVersion: 1,
      id: 'shared-title-notify',
      name: 'Q3 Marketing Site',
      createdAt: 111,
      updatedAt: 222,
    });

    const store = fakeProjectStore();
    store.register({
      id: 'shared-title-notify',
      name: '共享项目',
      skillId: null,
      designSystemId: null,
      createdAt: 1,
      updatedAt: 1,
    });

    const notifyProjectMetadataChanged = vi.fn();
    const api = await startSyncServer(undefined, {
      projectStore: store,
      resolvePullDir: () => dir,
      notifyProjectMetadataChanged,
    });

    await api.json('/api/projects/shared-title-notify/collab/publish', { method: 'POST' });
    await api.awaitPublishedVersion('/api/projects/shared-title-notify/collab/status', null);
    expect(notifyProjectMetadataChanged).not.toHaveBeenCalled();
    const pull = await api.json('/api/projects/shared-title-notify/collab/pull', { method: 'POST' });
    expect(pull.status).toBe(200);
    expect(store.projects.get('shared-title-notify')?.name).toBe('Q3 Marketing Site');
    expect(notifyProjectMetadataChanged).toHaveBeenCalledTimes(1);
    expect(notifyProjectMetadataChanged).toHaveBeenCalledWith('shared-title-notify');
  });

  it('does not notify notifyProjectMetadataChanged when the pulled project already has its real name locally', async () => {
    const store = fakeProjectStore();
    store.register({
      id: 'shared-title-steady',
      name: 'Already Local',
      skillId: null,
      designSystemId: null,
      createdAt: 1,
      updatedAt: 1,
    });

    const notifyProjectMetadataChanged = vi.fn();
    const api = await startSyncServer(undefined, {
      projectStore: store,
      resolvePullDir: (projectId) => `/does/not/exist/${projectId}`,
      notifyProjectMetadataChanged,
    });

    await api.json('/api/projects/shared-title-steady/collab/publish', { method: 'POST' });
    await api.awaitPublishedVersion('/api/projects/shared-title-steady/collab/status', null);
    const pull = await api.json('/api/projects/shared-title-steady/collab/pull', { method: 'POST' });
    expect(pull.status).toBe(200);
    // A content-only pull of an already-named local project changes no
    // metadata the web renders; no spurious refetch signal.
    expect(notifyProjectMetadataChanged).not.toHaveBeenCalled();
  });

  it('prefers the hub project name and metadata when registering a pulled project', async () => {
    const store = fakeProjectStore();
    const api = await startSyncServer(undefined, {
      projectStore: store,
      resolvePullDir: (projectId) => `/does/not/exist/${projectId}`,
      resolveSharedProject: async (projectId) => ({
        projectId,
        ownerMemberId: 'wm-owner',
        sharedAt: '2026-07-09T00:00:00.000Z',
        name: 'Emerald Editorial',
        skillId: 'deck-builder',
        designSystemId: 'ds-emerald',
        createdAt: 123,
        updatedAt: 456,
        metadata: { kind: 'deck', entryFile: 'index.html' },
      }),
    });

    await api.json('/api/projects/shared-from-hub/collab/publish', { method: 'POST' });
    await api.awaitPublishedVersion('/api/projects/shared-from-hub/collab/status', null);
    const pull = await api.json('/api/projects/shared-from-hub/collab/pull', { method: 'POST' });
    expect(pull.status).toBe(200);

    const registered = store.projects.get('shared-from-hub');
    expect(registered?.name).toBe('Emerald Editorial');
    expect(registered?.skillId).toBe('deck-builder');
    expect(registered?.designSystemId).toBe('ds-emerald');
    expect(registered?.createdAt).toBe(123);
    expect(registered?.updatedAt).toBe(456);
    expect(registered?.metadata).toEqual({ kind: 'deck', entryFile: 'index.html' });
  });

  it('registers a pulled shared project under its real name from the manifest', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'od-pull-'));
    tempDirs.push(dir);
    // The shared tree carries the owner's project manifest; register-on-pull
    // reads it so the local record shows the real name after opening.
    await writeProjectManifest(dir, {
      schemaVersion: 1,
      id: 'shared-2',
      name: 'Team Roadmap',
      createdAt: 111,
      updatedAt: 222,
      skillId: 'live-artifact',
      designSystemId: 'ds-9',
    });

    const store = fakeProjectStore();
    const api = await startSyncServer(undefined, {
      projectStore: store,
      resolvePullDir: () => dir,
    });

    await api.json('/api/projects/shared-2/collab/publish', { method: 'POST' });
    await api.awaitPublishedVersion('/api/projects/shared-2/collab/status', null);
    await api.json('/api/projects/shared-2/collab/pull', { method: 'POST' });
    const registered = store.projects.get('shared-2');
    expect(registered?.name).toBe('Team Roadmap');
    expect(registered?.skillId).toBe('live-artifact');
    expect(registered?.designSystemId).toBe('ds-9');
    expect(registered?.createdAt).toBe(111);
    expect(registered?.updatedAt).toBe(222);
  });

  it('infers a pulled shared project name from the bundled skill manifest when no project manifest exists', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'od-pull-'));
    tempDirs.push(dir);
    await mkdir(path.join(dir, '.od-skills', 'fs-emerald'), { recursive: true });
    await writeFile(
      path.join(dir, '.od-skills', 'fs-emerald', 'open-design.json'),
      JSON.stringify({ title: 'Emerald Editorial', name: 'example-fs-emerald-editorial' }),
    );

    const store = fakeProjectStore();
    const api = await startSyncServer(undefined, {
      projectStore: store,
      resolvePullDir: () => dir,
    });

    await api.json('/api/projects/shared-skill/collab/publish', { method: 'POST' });
    await api.awaitPublishedVersion('/api/projects/shared-skill/collab/status', null);
    await api.json('/api/projects/shared-skill/collab/pull', { method: 'POST' });
    expect(store.projects.get('shared-skill')?.name).toBe('Emerald Editorial');
  });

  it('repairs an existing placeholder pulled project name once pulled files expose a title', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'od-pull-'));
    tempDirs.push(dir);
    await mkdir(path.join(dir, '.od-skills', 'fs-emerald'), { recursive: true });
    await writeFile(
      path.join(dir, '.od-skills', 'fs-emerald', 'open-design.json'),
      JSON.stringify({ title: 'Emerald Editorial' }),
    );

    const store = fakeProjectStore();
    store.register({
      id: 'shared-placeholder',
      name: '共享项目',
      skillId: null,
      designSystemId: null,
      createdAt: 1,
      updatedAt: 1,
    });

    const api = await startSyncServer(undefined, {
      projectStore: store,
      resolvePullDir: () => dir,
    });

    await api.json('/api/projects/shared-placeholder/collab/publish', { method: 'POST' });
    await api.awaitPublishedVersion('/api/projects/shared-placeholder/collab/status', null);
    await api.json('/api/projects/shared-placeholder/collab/pull', { method: 'POST' });
    expect(store.registerCalls).toBe(1);
    expect(store.projects.get('shared-placeholder')?.name).toBe('Emerald Editorial');
  });

  it('is idempotent — a pull for an already-local project does not re-register it', async () => {
    const store = fakeProjectStore();
    store.register({
      id: 'shared-3',
      name: 'Already Local',
      skillId: null,
      designSystemId: null,
      createdAt: 1,
      updatedAt: 1,
    });
    expect(store.registerCalls).toBe(1);

    const api = await startSyncServer(undefined, {
      projectStore: store,
      resolvePullDir: (projectId) => `/does/not/exist/${projectId}`,
    });

    await api.json('/api/projects/shared-3/collab/pull', { method: 'POST' });
    // Still exactly one registration; the existing record is left untouched.
    expect(store.registerCalls).toBe(1);
    expect(store.projects.get('shared-3')?.name).toBe('Already Local');
  });

  it('derives read-only from the hub at status time — no pull or in-memory record needed', async () => {
    const api = await startSyncServer(undefined, {
      resolveSharedProjectOwner: async (projectId) =>
        projectId === 'shared-ro' ? 'wm-owner' : null,
    });

    // Straight to status: no pull, no in-memory share record. A project the hub
    // lists as shared by wm-owner reports synced + that owner, so a non-owner
    // member's client (`shared && !isOwner`) renders it single-writer read-only.
    // Deriving every read is what makes read-only survive a daemon restart (which
    // clears the in-memory maps) and an already-pulled project opened without a
    // re-pull — the bug was the pull never recording this at all.
    const status = await api.json('/api/projects/shared-ro/collab/status');
    expect(status.body.syncState).toBe('synced');
    expect(status.body.ownerMemberId).toBe('wm-owner');
  });

  it('leaves a project the hub does not list editable (local_only)', async () => {
    const api = await startSyncServer(undefined, {
      resolveSharedProjectOwner: async () => null,
    });
    const status = await api.json('/api/projects/not-shared/collab/status');
    // Not team-shared → no read-only: the member keeps full edit on their own
    // local project. Read-only never fires just because a status probe ran.
    expect(status.body.syncState).toBe('local_only');
    expect(status.body.ownerMemberId).toBeNull();
  });
});

// recvqmKQRiIlYf: the hub push channel needs a daemon-internal way to run the
// SAME pull flow POST /collab/pull runs (revocation gate → pull → register →
// file/metadata signals) without an HTTP request, and racing pulls for one
// project (proactive pull vs the member web's poll-triggered POST) must
// coalesce onto one materialization instead of two full-tree pulls.
describe('collab sync pull handle (daemon-internal proactive pull)', () => {
  const pullScope: TeamMirrorPullScope = {
    workspaceId: 'ws-1',
    resourceTeamId: 'team-1',
    viewerMemberId: 'wm-1',
    ownerMemberId: 'wm-owner',
  };
  const resolvePulledSharedProject = async (projectId: string) => ({
    projectId,
    ownerMemberId: pullScope.ownerMemberId,
    sharedAt: '2026-07-25T00:00:00.000Z',
  });
  const authorizedReceipt = (
    projectId: string,
    version: number,
  ): AuthorizedTeamProjectPullReceipt => ({
    schemaVersion: 1,
    ...pullScope,
    projectId,
    resourceId: projectResourceIdFor(projectId, {
      teamId: pullScope.resourceTeamId,
      memberId: pullScope.ownerMemberId,
      role: 'member',
      lifecycleState: 'active',
      workspaceType: 'team',
    }),
    ref: 'published',
    version,
    versionId: `version-${version}`,
    manifestDigest: `sha256:${'a'.repeat(64)}`,
    lifecycleState: 'active',
    // Exercise the allowed small positive server/local clock skew while
    // leaving enough wall-clock headroom for parallel test scheduling.
    authorizedAt: new Date(Date.now() + 500).toISOString(),
    expiresAt: new Date(Date.now() + 2_500).toISOString(),
  });

  it('materializes content and fires the same post-pull signals as POST /collab/pull', async () => {
    const store = fakeProjectStore();
    const notifyFilesChanged = vi.fn();
    const api = await startSyncServer(fixedShareContextProvider(true), {
      projectStore: store,
      resolvePullDir: (projectId) => `/does/not/exist/${projectId}`,
      resolveSharedProject: resolvePulledSharedProject,
      notifyFilesChanged,
    });

    await api.json('/api/projects/handle-pull/collab/publish', { method: 'POST' });
    await api.awaitPublishedVersion('/api/projects/handle-pull/collab/status', null);

    const outcome = await api.handle.pullSharedProject('handle-pull', pullScope);
    expect(outcome).toEqual({ status: 'pulled', version: 1 });
    expect(store.has('handle-pull')).toBe(true);
    expect(store.bindings.get('handle-pull')).toEqual(pullScope);
    expect(notifyFilesChanged).toHaveBeenCalledTimes(1);
    expect(notifyFilesChanged).toHaveBeenCalledWith('handle-pull');
  });

  it('fails both pull surfaces before notifications when the durable cursor cannot commit', async () => {
    const materializedVersion = 4;
    const notifyFilesChanged = vi.fn();
    const notifyProjectMetadataChanged = vi.fn();
    const writeMaterializedVersion = vi.fn(async () => {
      throw new Error('cursor disk unavailable');
    });
    const store = fakeProjectStore();
    const api = await startSyncServer(fixedShareContextProvider(true), {
      projectStore: store,
      resolvePullDir: (projectId) => `/does/not/exist/${projectId}`,
      resolveSharedProjectOwner: async () => pullScope.ownerMemberId,
      resolveSharedProject: resolvePulledSharedProject,
      readMaterializedVersion: () => materializedVersion,
      writeMaterializedVersion,
      notifyFilesChanged,
      notifyProjectMetadataChanged,
    }, {
      adapter: {
        publish: vi.fn(async () => ({ version: 5 })),
        pull: vi.fn(async () => ({ version: 5 })),
        syncLatest: vi.fn(async () => ({ version: 5 })),
      },
    });

    const before = await api.json('/api/projects/cursor-fail/collab/status');
    expect(before.body.materializedVersion).toBe(4);

    const viaHandle = await api.handle.pullSharedProject('cursor-fail', pullScope);
    expect(viaHandle).toEqual({ status: 'register_failed' });
    const viaRoute = await api.json('/api/projects/cursor-fail/collab/pull', {
      method: 'POST',
      headers: {
        'x-od-workspace-id': pullScope.workspaceId,
        'x-od-workspace-member-id': pullScope.viewerMemberId,
        'x-od-workspace-role': 'member',
      },
    });
    expect(viaRoute.status).toBe(502);
    expect(notifyFilesChanged).not.toHaveBeenCalled();
    expect(notifyProjectMetadataChanged).not.toHaveBeenCalled();

    // A failed disk commit never advances the value status exposes, so both
    // proactive events and the web floor remain free to retry version 5.
    const after = await api.json('/api/projects/cursor-fail/collab/status');
    expect(after.body.materializedVersion).toBe(4);
  });

  it('fails closed when a scoped pull cannot prove the team mirror binding', async () => {
    const notifyFilesChanged = vi.fn();
    const api = await startSyncServer(fixedShareContextProvider(true), {
      projectStore: {
        get: () => null,
        has: () => false,
        register: () => undefined,
      },
      resolvePullDir: (projectId) => `/does/not/exist/${projectId}`,
      resolveSharedProject: resolvePulledSharedProject,
      notifyFilesChanged,
    }, {
      adapter: {
        publish: vi.fn(async () => ({ version: 5 })),
        pull: vi.fn(async () => ({ version: 5 })),
        syncLatest: vi.fn(async () => ({ version: 5 })),
      },
    });

    const outcome = await api.handle.pullSharedProject('handle-unbound', pullScope);
    expect(outcome).toEqual({ status: 'register_failed' });
    expect(notifyFilesChanged).not.toHaveBeenCalled();
  });

  it('fails closed when the authoritative shared-project lookup throws for a scoped pull', async () => {
    const adapterPull = vi.fn(async () => ({ version: 5 }));
    const store = fakeProjectStore();
    const api = await startSyncServer(fixedShareContextProvider(true), {
      projectStore: store,
      resolvePullDir: (projectId) => `/does/not/exist/${projectId}`,
      resolveSharedProject: async () => {
        throw new Error('catalog unavailable');
      },
    }, {
      adapter: {
        publish: vi.fn(async () => ({ version: 5 })),
        pull: adapterPull,
        syncLatest: vi.fn(async () => ({ version: 5 })),
      },
    });

    const outcome = await api.handle.pullSharedProject('handle-catalog-error', pullScope);
    expect(outcome).toEqual({ status: 'register_failed' });
    expect(adapterPull).not.toHaveBeenCalled();
    expect(store.has('handle-catalog-error')).toBe(false);
  });

  it('starts the independent initial scope and catalog guards concurrently', async () => {
    const activeContext = await fixedShareContextProvider(true).current({});
    let releaseInitialScope!: () => void;
    let initialScopeStarted!: () => void;
    const initialScopeGate = new Promise<void>((resolve) => {
      releaseInitialScope = resolve;
    });
    const initialScopeStart = new Promise<void>((resolve) => {
      initialScopeStarted = resolve;
    });
    let contextCalls = 0;
    const current = vi.fn(async () => {
      contextCalls += 1;
      if (contextCalls === 1) {
        initialScopeStarted();
        await initialScopeGate;
      }
      return activeContext;
    });
    const resolveSharedProject = vi.fn(async (projectId: string) => ({
      projectId,
      ownerMemberId: pullScope.ownerMemberId,
      sharedAt: '2026-07-25T00:00:00.000Z',
    }));
    const api = await startSyncServer({ current }, {
      projectStore: fakeProjectStore(),
      resolvePullDir: (projectId) => `/does/not/exist/${projectId}`,
      resolveSharedProject,
    }, {
      adapter: {
        publish: vi.fn(async () => ({ version: 5 })),
        pull: vi.fn(async () => ({ version: 5 })),
        syncLatest: vi.fn(async () => ({ version: 5 })),
      },
    });

    const outcomePromise = api.handle.pullSharedProject(
      'handle-parallel-guards',
      pullScope,
    );
    await initialScopeStart;
    await Promise.resolve();
    const catalogStartedBeforeInitialScopeFinished =
      resolveSharedProject.mock.calls.length;
    releaseInitialScope();

    await expect(outcomePromise).resolves.toEqual({
      status: 'pulled',
      version: 5,
    });
    expect(catalogStartedBeforeInitialScopeFinished).toBe(1);
  });

  it('reuses a fresh internal guard witness but keeps post-pull reauthorization', async () => {
    const activeContext = await fixedShareContextProvider(true).current({});
    const current = vi.fn(async () => activeContext);
    const resolveSharedProject = vi.fn(resolvePulledSharedProject);
    const onPullTiming = vi.fn();
    const api = await startSyncServer({ current }, {
      projectStore: fakeProjectStore(),
      resolvePullDir: (projectId) => `/does/not/exist/${projectId}`,
      resolveSharedProject,
      onPullTiming,
    }, {
      adapter: {
        publish: vi.fn(async () => ({ version: 5 })),
        pull: vi.fn(async () => ({ version: 5 })),
        syncLatest: vi.fn(async () => ({ version: 5 })),
      },
    });

    const projectId = 'handle-fresh-witness';
    const witness = await mintProactivePullWitness(projectId, pullScope, 5);
    const outcome = await api.handle.pullSharedProject(
      projectId,
      pullScope,
      witness,
      5,
    );

    expect(outcome).toEqual({ status: 'pulled', version: 5 });
    // The witness replaces only the duplicate PRE-transport checks. The final
    // uncached catalog + active-scope gates still run immediately before the
    // mirror transaction.
    expect(resolveSharedProject).toHaveBeenCalledTimes(1);
    expect(current).toHaveBeenCalledTimes(1);
    expect(onPullTiming).toHaveBeenCalledWith(expect.objectContaining({
      phase: 'initial-authorization-reused',
      projectId: 'handle-fresh-witness',
      version: 5,
    }));
  });

  it('falls back to all initial gates for a copied witness', async () => {
    const activeContext = await fixedShareContextProvider(true).current({});
    const current = vi.fn(async () => activeContext);
    const resolveSharedProject = vi.fn(resolvePulledSharedProject);
    const api = await startSyncServer({ current }, {
      projectStore: fakeProjectStore(),
      resolvePullDir: (projectId) => `/does/not/exist/${projectId}`,
      resolveSharedProject,
    }, {
      adapter: {
        publish: vi.fn(async () => ({ version: 5 })),
        pull: vi.fn(async () => ({ version: 5 })),
        syncLatest: vi.fn(async () => ({ version: 5 })),
      },
    });

    const projectId = 'handle-copied-witness';
    const witness = await mintProactivePullWitness(projectId, pullScope, 5);
    const outcome = await api.handle.pullSharedProject(
      projectId,
      pullScope,
      { ...witness },
      5,
    );

    expect(outcome).toEqual({ status: 'pulled', version: 5 });
    expect(resolveSharedProject).toHaveBeenCalledTimes(2);
    expect(current).toHaveBeenCalledTimes(3);
  });

  it('ignores an authorization-witness-shaped HTTP body', async () => {
    const resolveSharedProject = vi.fn(resolvePulledSharedProject);
    const onPullTiming = vi.fn();
    const api = await startSyncServer(fixedShareContextProvider(true), {
      projectStore: fakeProjectStore(),
      resolvePullDir: (projectId) => `/does/not/exist/${projectId}`,
      resolveSharedProjectOwner: async () => pullScope.ownerMemberId,
      resolveSharedProject,
      onPullTiming,
    }, {
      adapter: {
        publish: vi.fn(async () => ({ version: 5 })),
        pull: vi.fn(async () => ({ version: 5 })),
        syncLatest: vi.fn(async () => ({ version: 5 })),
      },
    });
    const projectId = 'http-witness-injection';
    const witness = await mintProactivePullWitness(projectId, pullScope, 5);

    const response = await api.json(
      `/api/projects/${projectId}/collab/pull`,
      {
        method: 'POST',
        headers: {
          'x-od-workspace-id': pullScope.workspaceId,
          'x-od-workspace-member-id': pullScope.viewerMemberId,
          'x-od-workspace-role': 'member',
        },
        body: {
          authorizationWitness: witness,
          expectedVersion: 5,
        },
      },
    );

    expect(response.status).toBe(200);
    expect(resolveSharedProject).toHaveBeenCalledTimes(2);
    expect(
      onPullTiming.mock.calls.some(
        ([event]) => event.phase === 'initial-authorization-reused',
      ),
    ).toBe(false);
  });

  it('uses the authorized staged transport only for a branded proactive invocation', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'od-authorized-route-'));
    tempDirs.push(root);
    const liveDir = path.join(root, 'project');
    const stageDir = path.join(root, '.project.od-pull-stage-test');
    await mkdir(stageDir);
    await writeFile(path.join(stageDir, 'index.html'), '<title>Staged project</title>');
    const receipt = authorizedReceipt('authorized-fast', 5);
    const stage = vi.fn(async () => ({
      stageDir,
      identity: { dev: '1', ino: '2' },
      receipt,
      cleanup: vi.fn(async () => undefined),
    }));
    const promote = vi.fn(async (input: {
      commit: () => { localRecordChanged: boolean };
      isExpectedVersion: () => boolean;
      validateReceipt: () => void;
    }) => {
      expect(input.isExpectedVersion()).toBe(true);
      input.validateReceipt();
      return input.commit();
    });
    const adapterPull = vi.fn(async () => ({ version: 5 }));
    const store = fakeProjectStore();
    const api = await startSyncServer(fixedShareContextProvider(true), {
      projectStore: store,
      resolvePullDir: () => liveDir,
      resolveSharedProject: resolvePulledSharedProject,
      authorizedTeamProjectPull: {
        journalDir: path.join(root, '.journals'),
        getActiveWorkspaceSnapshot: () => ({
          workspaceId: pullScope.workspaceId,
          generation: 7,
        }),
        stage,
        promote,
      },
    }, {
      adapter: {
        publish: vi.fn(async () => ({ version: 5 })),
        pull: adapterPull,
        syncLatest: vi.fn(async () => ({ version: 5 })),
      },
    });
    const outcome = await invokeThroughProactivePull(
      api.handle,
      'authorized-fast',
      pullScope,
      5,
    );

    expect(outcome).toEqual({ status: 'pulled', version: 5 });
    expect(stage).toHaveBeenCalledWith(expect.objectContaining({
      projectId: 'authorized-fast',
      liveDir,
      scope: pullScope,
      expectedVersion: 5,
    }));
    expect(promote).toHaveBeenCalledTimes(1);
    expect(adapterPull).not.toHaveBeenCalled();
    expect(store.projects.get('authorized-fast')?.name).toBe('Staged project');
  });

  it('commits a staged receipt through a transient A to null to A context gap', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'od-authorized-transient-route-'));
    tempDirs.push(root);
    const projectId = 'authorized-transient-route';
    const liveDir = path.join(root, projectId);
    const stageDir = path.join(root, `.${projectId}.od-pull-stage-test`);
    await mkdir(liveDir);
    await writeFile(path.join(liveDir, 'index.html'), '<title>Old project</title>');
    await mkdir(stageDir);
    await writeFile(path.join(stageDir, 'index.html'), '<title>Staged project</title>');

    const activeContext = await fixedShareContextProvider(true).current({});
    if (!activeContext) throw new Error('expected active team context');
    let currentContext: WorkspaceCollabContext | null = activeContext;
    const workspaceContext = withLastKnownWorkspaceContext({
      current: async () => currentContext,
    });
    await workspaceContext.current({});
    const capturedSnapshot = workspaceContext.lastKnownSnapshot!();
    const activeWorkspaceSelection = {
      workspaceId: pullScope.workspaceId,
      generation: 0,
    };
    const getActiveWorkspaceSnapshot = () =>
      resolveAuthorizedActiveTeamWorkspaceSnapshot(
        activeWorkspaceSelection,
        workspaceContext.lastKnownSnapshot!(),
      );

    const db = openDatabase(root, { dataDir: root });
    const projectStore: PulledProjectStore = {
      get: (id) => getProject(db, id),
      has: (id) => getProject(db, id) != null,
      register: () => {
        throw new Error('authorized route must use the transactional materializer');
      },
      materializeAuthorizedTeamMirror: (input, scope, pullReceipt) =>
        materializePulledTeamMirror(db, input, scope, pullReceipt),
    };
    const pullReceipt = authorizedReceipt(projectId, 5);
    const stage = vi.fn(async () => {
      // Reproduce the production failure window while the Vela child owns the
      // staged bytes: the same active identity briefly becomes unavailable,
      // then recovers before the atomic promotion boundary.
      currentContext = null;
      await workspaceContext.current({});
      currentContext = activeContext;
      await workspaceContext.current({});
      const stat = await lstat(stageDir);
      return {
        stageDir,
        identity: { dev: String(stat.dev), ino: String(stat.ino) },
        receipt: pullReceipt,
        cleanup: async () => {
          await rm(stageDir, { recursive: true, force: true });
        },
      };
    });
    const notifyFilesChanged = vi.fn();

    try {
      const api = await startSyncServer(workspaceContext, {
        projectStore,
        resolvePullDir: () => liveDir,
        resolveSharedProject: resolvePulledSharedProject,
        notifyFilesChanged,
        authorizedTeamProjectPull: {
          journalDir: path.join(root, '.journals'),
          getActiveWorkspaceSnapshot,
          stage,
          promote: promoteAuthorizedTeamProjectStage,
        },
      });

      await expect(invokeThroughProactivePull(
        api.handle,
        projectId,
        pullScope,
        5,
      )).resolves.toEqual({ status: 'pulled', version: 5 });

      expect(workspaceContext.lastKnownSnapshot!()).toEqual(capturedSnapshot);
      expect(await readFile(path.join(liveDir, 'index.html'), 'utf8'))
        .toContain('Staged project');
      expect(getProject(db, projectId)?.name).toBe('Staged project');
      expect(
        getTeamProjectMaterialization(db, pullScope.workspaceId, projectId),
      ).toEqual(pullReceipt);
      expect(notifyFilesChanged).toHaveBeenCalledOnce();
      expect(notifyFilesChanged).toHaveBeenCalledWith(projectId);
    } finally {
      closeDatabase();
    }
  });

  it('logs the project, version, and non-sensitive snapshot reason when promotion fails', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'od-authorized-log-'));
    tempDirs.push(root);
    const liveDir = path.join(root, 'project');
    const stageDir = path.join(root, '.project.od-pull-stage-test');
    await mkdir(stageDir);
    await writeFile(path.join(stageDir, 'index.html'), '<title>Staged project</title>');
    let snapshot = {
      workspaceId: pullScope.workspaceId as string | null,
      generation: 7,
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const api = await startSyncServer(fixedShareContextProvider(true), {
        projectStore: fakeProjectStore(),
        resolvePullDir: () => liveDir,
        resolveSharedProject: resolvePulledSharedProject,
        authorizedTeamProjectPull: {
          journalDir: path.join(root, '.journals'),
          getActiveWorkspaceSnapshot: () => snapshot,
          stage: vi.fn(async () => ({
            stageDir,
            identity: { dev: '1', ino: '2' },
            receipt: authorizedReceipt('authorized-log', 5),
            cleanup: vi.fn(async () => undefined),
          })),
          promote: vi.fn(async () => {
            snapshot = { workspaceId: null, generation: 7 };
            throw new Error('active workspace changed while the team mirror was staged');
          }),
        },
      });

      await expect(invokeThroughProactivePull(
        api.handle,
        'authorized-log',
        pullScope,
        5,
      )).resolves.toEqual({ status: 'register_failed' });

      expect(warn).toHaveBeenCalledWith(
        '[od] failed to promote authorized team project',
        {
          projectId: 'authorized-log',
          version: 5,
          reason: 'workspace-unavailable',
          snapshot: {
            workspaceAvailable: false,
            workspaceMatches: false,
            generationMatches: true,
          },
          errorName: 'Error',
        },
      );
    } finally {
      warn.mockRestore();
    }
  });

  it('never accepts an authorized-stage-shaped HTTP body', async () => {
    const stage = vi.fn();
    const adapterPull = vi.fn(async () => ({ version: 5 }));
    const api = await startSyncServer(fixedShareContextProvider(true), {
      projectStore: fakeProjectStore(),
      resolvePullDir: (projectId) => `/does/not/exist/${projectId}`,
      resolveSharedProjectOwner: async () => pullScope.ownerMemberId,
      resolveSharedProject: resolvePulledSharedProject,
      authorizedTeamProjectPull: {
        journalDir: '/unused',
        getActiveWorkspaceSnapshot: () => ({
          workspaceId: pullScope.workspaceId,
          generation: 1,
        }),
        stage,
        promote: vi.fn(),
      },
    }, {
      adapter: {
        publish: vi.fn(async () => ({ version: 5 })),
        pull: adapterPull,
        syncLatest: vi.fn(async () => ({ version: 5 })),
      },
    });

    const response = await api.json('/api/projects/http-stage-injection/collab/pull', {
      method: 'POST',
      headers: {
        'x-od-workspace-id': pullScope.workspaceId,
        'x-od-workspace-member-id': pullScope.viewerMemberId,
        'x-od-workspace-role': 'member',
      },
      body: {
        authorizedStageInvocation: {
          kind: 'authorized-proactive-stage',
          expectedVersion: 5,
          isStillExpected: true,
        },
      },
    });

    expect(response.status).toBe(200);
    expect(adapterPull).toHaveBeenCalledTimes(1);
    expect(stage).not.toHaveBeenCalled();
  });

  it('fails a real but already-stale authorized invocation without legacy fallback', async () => {
    const adapterPull = vi.fn(async () => ({ version: 5 }));
    const writeMaterializedVersion = vi.fn(async () => undefined);
    const stage = vi.fn();
    const api = await startSyncServer(fixedShareContextProvider(true), {
      projectStore: fakeProjectStore(),
      resolvePullDir: (projectId) => `/does/not/exist/${projectId}`,
      resolveSharedProject: resolvePulledSharedProject,
      writeMaterializedVersion,
      authorizedTeamProjectPull: {
        journalDir: '/unused',
        getActiveWorkspaceSnapshot: () => ({
          workspaceId: pullScope.workspaceId,
          generation: 1,
        }),
        stage,
        promote: vi.fn(),
      },
    }, {
      adapter: {
        publish: vi.fn(async () => ({ version: 5 })),
        pull: adapterPull,
        syncLatest: vi.fn(async () => ({ version: 5 })),
      },
    });
    // The helper's proactive intent has completed before it returns, so this
    // is a genuine WeakSet-issued invocation whose liveness closure is stale.
    const stale = await mintProactivePullTarget(
      'stale-before-route',
      pullScope,
      5,
    );

    await expect(api.handle.pullSharedProject(
      'stale-before-route',
      pullScope,
      stale.authorizationWitness,
      5,
      stale.authorizedStageInvocation,
    )).resolves.toEqual({ status: 'register_failed' });
    expect(stage).not.toHaveBeenCalled();
    expect(adapterPull).not.toHaveBeenCalled();
    expect(writeMaterializedVersion).not.toHaveBeenCalled();
  });

  it.each([
    ['scope mismatch', false],
    ['spread forgery', true],
  ])('fails a nonempty authorized invocation with %s without legacy fallback', async (
    _case,
    spreadInvocation,
  ) => {
    const adapterPull = vi.fn(async () => ({ version: 5 }));
    const writeMaterializedVersion = vi.fn(async () => undefined);
    const stage = vi.fn();
    const api = await startSyncServer(fixedShareContextProvider(true), {
      projectStore: fakeProjectStore(),
      resolvePullDir: (projectId) => `/does/not/exist/${projectId}`,
      resolveSharedProject: resolvePulledSharedProject,
      writeMaterializedVersion,
      authorizedTeamProjectPull: {
        journalDir: '/unused',
        getActiveWorkspaceSnapshot: () => ({
          workspaceId: pullScope.workspaceId,
          generation: 1,
        }),
        stage,
        promote: vi.fn(),
      },
    }, {
      adapter: {
        publish: vi.fn(async () => ({ version: 5 })),
        pull: adapterPull,
        syncLatest: vi.fn(async () => ({ version: 5 })),
      },
    });
    const issuedProjectId = spreadInvocation
      ? 'spread-forgery'
      : 'scope-mismatch-source';
    const routedProjectId = spreadInvocation
      ? issuedProjectId
      : 'scope-mismatch-target';
    const target = await mintProactivePullTarget(
      issuedProjectId,
      pullScope,
      5,
    );
    const invocation = spreadInvocation
      ? { ...target.authorizedStageInvocation! }
      : target.authorizedStageInvocation;

    await expect(api.handle.pullSharedProject(
      routedProjectId,
      pullScope,
      target.authorizationWitness,
      5,
      invocation,
    )).resolves.toEqual({ status: 'register_failed' });
    expect(stage).not.toHaveBeenCalled();
    expect(adapterPull).not.toHaveBeenCalled();
    expect(writeMaterializedVersion).not.toHaveBeenCalled();
  });

  it.each([
    ['unknown command "pull" for "team-projects"', true],
    ['HTTP 403 forbidden', false],
    ['HTTP 500 unavailable', false],
    ['network timeout', false],
    ['authorized pull response is not valid JSON', false],
  ])('falls back only for old-CLI capability absence: %s', async (
    message,
    shouldFallback,
  ) => {
    const adapterPull = vi.fn(async () => ({ version: 5 }));
    const api = await startSyncServer(fixedShareContextProvider(true), {
      projectStore: fakeProjectStore(),
      resolvePullDir: (projectId) => `/does/not/exist/${projectId}`,
      resolveSharedProject: resolvePulledSharedProject,
      authorizedTeamProjectPull: {
        journalDir: '/unused',
        getActiveWorkspaceSnapshot: () => ({
          workspaceId: pullScope.workspaceId,
          generation: 1,
        }),
        stage: vi.fn(async () => {
          throw new Error(message);
        }),
        promote: vi.fn(),
      },
    }, {
      adapter: {
        publish: vi.fn(async () => ({ version: 5 })),
        pull: adapterPull,
        syncLatest: vi.fn(async () => ({ version: 5 })),
      },
    });
    const outcome = await invokeThroughProactivePull(
      api.handle,
      `fallback-${shouldFallback}`,
      pullScope,
      5,
    );

    expect(adapterPull).toHaveBeenCalledTimes(shouldFallback ? 1 : 0);
    expect(outcome).toEqual(
      shouldFallback
        ? { status: 'pulled', version: 5 }
        : { status: 'register_failed' },
    );
  });

  it('uses the captured expected version as a legacy lower bound after capability fallback', async () => {
    const writeMaterializedVersion = vi.fn(async () => undefined);
    const adapterPull = vi.fn(async () => null);
    const api = await startSyncServer(fixedShareContextProvider(true), {
      projectStore: fakeProjectStore(),
      resolvePullDir: (projectId) => `/does/not/exist/${projectId}`,
      resolveSharedProject: resolvePulledSharedProject,
      writeMaterializedVersion,
      authorizedTeamProjectPull: {
        journalDir: '/unused',
        getActiveWorkspaceSnapshot: () => ({
          workspaceId: pullScope.workspaceId,
          generation: 1,
        }),
        stage: vi.fn(async () => {
          throw new Error('unknown command "pull" for "team-projects"');
        }),
        promote: vi.fn(),
      },
    }, {
      adapter: {
        publish: vi.fn(async () => ({ version: 5 })),
        pull: adapterPull,
        syncLatest: vi.fn(async () => ({ version: 5 })),
      },
    });

    await expect(invokeThroughProactivePull(
      api.handle,
      'legacy-null-version',
      pullScope,
      5,
    )).resolves.toEqual({ status: 'pulled', version: 5 });
    expect(writeMaterializedVersion).toHaveBeenCalledWith(
      'legacy-null-version',
      pullScope,
      5,
    );
    await expect(invokeThroughProactivePull(
      api.handle,
      'legacy-null-version',
      pullScope,
      6,
    )).resolves.toEqual({ status: 'pulled', version: 6 });
    expect(writeMaterializedVersion).toHaveBeenLastCalledWith(
      'legacy-null-version',
      pullScope,
      6,
    );
  });

  it('prefers a real legacy transport version over the fallback lower bound', async () => {
    const writeMaterializedVersion = vi.fn(async () => undefined);
    const api = await startSyncServer(fixedShareContextProvider(true), {
      projectStore: fakeProjectStore(),
      resolvePullDir: (projectId) => `/does/not/exist/${projectId}`,
      resolveSharedProject: resolvePulledSharedProject,
      writeMaterializedVersion,
      authorizedTeamProjectPull: {
        journalDir: '/unused',
        getActiveWorkspaceSnapshot: () => ({
          workspaceId: pullScope.workspaceId,
          generation: 1,
        }),
        stage: vi.fn(async () => {
          throw new Error('unknown flag: --expected-version');
        }),
        promote: vi.fn(),
      },
    }, {
      adapter: {
        publish: vi.fn(async () => ({ version: 8 })),
        pull: vi.fn(async () => ({ version: 8 })),
        syncLatest: vi.fn(async () => ({ version: 8 })),
      },
    });

    await expect(invokeThroughProactivePull(
      api.handle,
      'legacy-real-version',
      pullScope,
      5,
    )).resolves.toEqual({ status: 'pulled', version: 8 });
    expect(writeMaterializedVersion).toHaveBeenCalledWith(
      'legacy-real-version',
      pullScope,
      8,
    );
  });

  it('does not advance the fallback lower bound when post-pull authorization fails', async () => {
    const writeMaterializedVersion = vi.fn(async () => undefined);
    const api = await startSyncServer(fixedShareContextProvider(true), {
      projectStore: fakeProjectStore(),
      resolvePullDir: (projectId) => `/does/not/exist/${projectId}`,
      resolveSharedProject: async () => null,
      writeMaterializedVersion,
      authorizedTeamProjectPull: {
        journalDir: '/unused',
        getActiveWorkspaceSnapshot: () => ({
          workspaceId: pullScope.workspaceId,
          generation: 1,
        }),
        stage: vi.fn(async () => {
          throw new Error('unknown command "pull" for "team-projects"');
        }),
        promote: vi.fn(),
      },
    }, {
      adapter: {
        publish: vi.fn(async () => null),
        pull: vi.fn(async () => null),
        syncLatest: vi.fn(async () => null),
      },
    });

    await expect(invokeThroughProactivePull(
      api.handle,
      'legacy-post-auth-fail',
      pullScope,
      5,
    )).resolves.toEqual({ status: 'revoked' });
    expect(writeMaterializedVersion).not.toHaveBeenCalled();
  });

  it('preempts an old authorized stage and commits only the newer receipt', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'od-authorized-preempt-'));
    tempDirs.push(root);
    const liveDir = path.join(root, 'preempt');
    const stage4 = path.join(root, '.preempt.od-pull-stage-v4');
    await mkdir(stage4);
    await writeFile(path.join(stage4, 'index.html'), '<title>Version four</title>');
    let firstCleaned = false;
    const stage = vi.fn(async (input: {
      expectedVersion: number;
      signal?: AbortSignal;
    }) => {
      if (input.expectedVersion === 3) {
        await new Promise<void>((_resolve, reject) => {
          input.signal?.addEventListener('abort', () => {
            firstCleaned = true;
            reject(new DOMException('aborted', 'AbortError'));
          }, { once: true });
        });
      }
      return {
        stageDir: stage4,
        identity: { dev: '1', ino: '4' },
        receipt: authorizedReceipt('preempt', 4),
        cleanup: vi.fn(async () => undefined),
      };
    });
    const promote = vi.fn(async (input: {
      validateReceipt: () => void;
      isExpectedVersion: () => boolean;
      commit: () => { localRecordChanged: boolean };
    }) => {
      expect(input.isExpectedVersion()).toBe(true);
      input.validateReceipt();
      return input.commit();
    });
    const adapterPull = vi.fn(async () => ({ version: 99 }));
    const store = fakeProjectStore();
    const materializeAuthorized = vi.spyOn(
      store,
      'materializeAuthorizedTeamMirror',
    );
    const api = await startSyncServer(fixedShareContextProvider(true), {
      projectStore: store,
      resolvePullDir: () => liveDir,
      resolveSharedProject: resolvePulledSharedProject,
      authorizedTeamProjectPull: {
        journalDir: path.join(root, '.journals'),
        getActiveWorkspaceSnapshot: () => ({
          workspaceId: pullScope.workspaceId,
          generation: 1,
        }),
        stage,
        promote,
      },
    }, {
      adapter: {
        publish: vi.fn(async () => ({ version: 99 })),
        pull: adapterPull,
        syncLatest: vi.fn(async () => ({ version: 99 })),
      },
    });
    const proactive = createProactiveContentPull({
      getLocalBinding: () => ({
        workspaceId: pullScope.workspaceId,
        visibility: 'team',
      }),
      getWorkspaceIdentity: async () => ({
        workspaceId: pullScope.workspaceId,
        resourceTeamId: pullScope.resourceTeamId,
        workspaceMemberId: pullScope.viewerMemberId,
      }),
      resolveSharedProjectOwner: async () => pullScope.ownerMemberId,
      pullSharedProject: (target, version) =>
        api.handle.pullSharedProject(
          target.projectId,
          pullScope,
          target.authorizationWitness,
          version,
          target.authorizedStageInvocation,
        ),
    });

    try {
      const first = proactive.handleContentChanged({
        projectId: 'preempt',
        workspaceId: pullScope.workspaceId,
        version: 3,
      });
      await vi.waitFor(() => expect(stage).toHaveBeenCalledTimes(1));
      const second = proactive.handleContentChanged({
        projectId: 'preempt',
        workspaceId: pullScope.workspaceId,
        version: 4,
      });
      await Promise.all([first, second]);
    } finally {
      proactive.dispose();
    }

    expect(firstCleaned).toBe(true);
    expect(stage.mock.calls.map(([input]) => input.expectedVersion)).toEqual([
      3,
      4,
    ]);
    expect(promote).toHaveBeenCalledTimes(1);
    expect(materializeAuthorized).toHaveBeenCalledTimes(1);
    expect(materializeAuthorized.mock.calls[0]?.[2].version).toBe(4);
    expect(adapterPull).not.toHaveBeenCalled();
  });

  it('fails closed when active workspace identity drifts after the authoritative lookup', async () => {
    const activeContext = await fixedShareContextProvider(true).current({});
    const current = vi.fn()
      .mockResolvedValueOnce(activeContext)
      .mockResolvedValue({
        ...activeContext,
        workspaceId: 'ws-other',
        teamId: 'ws-other',
      });
    const adapterPull = vi.fn(async () => ({ version: 5 }));
    const store = fakeProjectStore();
    const api = await startSyncServer({ current }, {
      projectStore: store,
      resolvePullDir: (projectId) => `/does/not/exist/${projectId}`,
      resolveSharedProject: async (projectId) => ({
        projectId,
        ownerMemberId: pullScope.ownerMemberId,
        sharedAt: '2026-07-25T00:00:00.000Z',
      }),
    }, {
      adapter: {
        publish: vi.fn(async () => ({ version: 5 })),
        pull: adapterPull,
        syncLatest: vi.fn(async () => ({ version: 5 })),
      },
    });

    const outcome = await api.handle.pullSharedProject('handle-scope-drift', pullScope);
    expect(outcome).toEqual({ status: 'register_failed' });
    expect(adapterPull).not.toHaveBeenCalled();
    expect(store.has('handle-scope-drift')).toBe(false);
  });

  it('fails closed when the project is unshared while the scoped pull is in flight', async () => {
    let releasePull!: () => void;
    const pullGate = new Promise<void>((resolve) => {
      releasePull = resolve;
    });
    let shared = true;
    const resolveSharedProject = vi.fn(async (projectId: string) => shared
      ? {
          projectId,
          ownerMemberId: pullScope.ownerMemberId,
          sharedAt: '2026-07-25T00:00:00.000Z',
        }
      : null);
    const store = fakeProjectStore();
    const notifyFilesChanged = vi.fn();
    const revoked = vi.fn();
    const adapterPull = vi.fn(async () => {
      await pullGate;
      return { version: 5 };
    });
    const api = await startSyncServer(fixedShareContextProvider(true), {
      projectStore: store,
      resolvePullDir: (projectId) => `/does/not/exist/${projectId}`,
      resolveSharedProject,
      markTeamProjectRevoked: revoked,
      notifyFilesChanged,
    }, {
      adapter: {
        publish: vi.fn(async () => ({ version: 5 })),
        pull: adapterPull,
        syncLatest: vi.fn(async () => ({ version: 5 })),
      },
    });

    const projectId = 'handle-unshared-during-pull';
    const witness = await mintProactivePullWitness(projectId, pullScope, 5);
    const outcomePromise = api.handle.pullSharedProject(
      projectId,
      pullScope,
      witness,
      5,
    );
    await vi.waitFor(() => expect(adapterPull).toHaveBeenCalledTimes(1));
    shared = false;
    releasePull();

    await expect(outcomePromise).resolves.toEqual({ status: 'revoked' });
    expect(resolveSharedProject).toHaveBeenCalledTimes(1);
    expect(store.has(projectId)).toBe(false);
    expect(notifyFilesChanged).not.toHaveBeenCalled();
    expect(revoked).toHaveBeenCalledWith('handle-unshared-during-pull', true);
  });

  it('rechecks workspace identity after the post-pull authoritative lookup before materializing', async () => {
    const activeContext = (await fixedShareContextProvider(true).current({}))!;
    let drifted = false;
    const current = vi.fn(async () => drifted
      ? {
          ...activeContext,
          workspaceId: 'ws-other',
          teamId: 'team-other',
        }
      : activeContext);
    let releaseFinalCatalog!: () => void;
    const finalCatalogGate = new Promise<void>((resolve) => {
      releaseFinalCatalog = resolve;
    });
    let catalogCalls = 0;
    const resolveSharedProject = vi.fn(async (projectId: string) => {
      catalogCalls += 1;
      if (catalogCalls === 1) await finalCatalogGate;
      return {
        projectId,
        ownerMemberId: pullScope.ownerMemberId,
        sharedAt: '2026-07-25T00:00:00.000Z',
      };
    });
    const store = fakeProjectStore();
    const notifyFilesChanged = vi.fn();
    const onPullTiming = vi.fn();
    const api = await startSyncServer({ current }, {
      projectStore: store,
      resolvePullDir: (projectId) => `/does/not/exist/${projectId}`,
      resolveSharedProject,
      notifyFilesChanged,
      onPullTiming,
    }, {
      adapter: {
        publish: vi.fn(async () => ({ version: 5 })),
        pull: vi.fn(async () => ({ version: 5 })),
        syncLatest: vi.fn(async () => ({ version: 5 })),
      },
    });

    const projectId = 'handle-second-catalog-drift';
    const witness = await mintProactivePullWitness(projectId, pullScope, 5);
    const outcomePromise = api.handle.pullSharedProject(
      projectId,
      pullScope,
      witness,
      5,
    );
    await vi.waitFor(() => expect(resolveSharedProject).toHaveBeenCalledTimes(1));
    drifted = true;
    releaseFinalCatalog();

    await expect(outcomePromise).resolves.toEqual({ status: 'register_failed' });
    expect(store.has(projectId)).toBe(false);
    expect(notifyFilesChanged).not.toHaveBeenCalled();
    expect(onPullTiming).toHaveBeenLastCalledWith(expect.objectContaining({
      phase: 'route-completed',
      projectId: 'handle-second-catalog-drift',
      status: 'register_failed',
    }));
  });

  it('reports revoked (and flags the mirror) when the project is no longer team-shared', async () => {
    const revoked: Array<{ projectId: string; revoked: boolean }> = [];
    const onPullTiming = vi.fn();
    const api = await startSyncServer(fixedShareContextProvider(true), {
      resolveSharedProject: async () => null,
      markTeamProjectRevoked: (projectId, value) => revoked.push({ projectId, revoked: value }),
      onPullTiming,
    });

    const outcome = await api.handle.pullSharedProject('handle-revoked', pullScope);
    expect(outcome).toEqual({ status: 'revoked' });
    expect(revoked).toContainEqual({ projectId: 'handle-revoked', revoked: true });
    expect(onPullTiming).toHaveBeenLastCalledWith(expect.objectContaining({
      phase: 'route-completed',
      projectId: 'handle-revoked',
      status: 'revoked',
    }));
  });

  it('coalesces a racing POST /collab/pull and handle pull into one adapter pull', async () => {
    let releasePull!: () => void;
    const pullGate = new Promise<void>((resolve) => {
      releasePull = resolve;
    });
    const adapterPull = vi.fn(async () => {
      await pullGate;
      return { version: 5 };
    });
    const syncLatest = vi.fn(async () => ({ version: 5 }));
    const publish = vi.fn(async () => ({ version: 5 }));
    const store = fakeProjectStore();
    const writeMaterializedVersion = vi.fn(async () => undefined);
    const onPullTiming = vi.fn();
    const api = await startSyncServer(fixedShareContextProvider(true), {
      projectStore: store,
      resolvePullDir: (projectId) => `/does/not/exist/${projectId}`,
      resolveSharedProjectOwner: async () => pullScope.ownerMemberId,
      resolveSharedProject: resolvePulledSharedProject,
      writeMaterializedVersion,
      onPullTiming,
    }, {
      adapter: { publish, pull: adapterPull, syncLatest },
    });

    const viaHandle = api.handle.pullSharedProject('race-pull', pullScope);
    const viaRoute = api.json('/api/projects/race-pull/collab/pull', {
      method: 'POST',
      headers: {
        'x-od-workspace-id': pullScope.workspaceId,
        'x-od-workspace-member-id': pullScope.viewerMemberId,
        'x-od-workspace-role': 'member',
      },
    });
    // Let the POST reach the route (and the shared in-flight map) before the
    // gate opens; the coalescing must hold with both callers waiting.
    await new Promise((resolve) => setTimeout(resolve, 50));
    releasePull();

    const [handleOutcome, routeResponse] = await Promise.all([viaHandle, viaRoute]);
    expect(handleOutcome).toEqual({ status: 'pulled', version: 5 });
    expect(routeResponse.status).toBe(200);
    expect(routeResponse.body.version).toBe(5);
    expect(adapterPull).toHaveBeenCalledTimes(1);
    expect(writeMaterializedVersion).toHaveBeenCalledTimes(1);
    expect(writeMaterializedVersion).toHaveBeenCalledWith('race-pull', pullScope, 5);
    expect(onPullTiming.mock.calls.map(([event]) => event.phase)).toEqual([
      'route-started',
      'transport-invoke',
      'transport-done',
      'registration-prepared',
      'catalog-revalidated',
      'scope-revalidated',
      'mirror-materialized',
      'version-write-started',
      'persisted',
      'route-completed',
    ]);
  });

  it('does not coalesce the same project across different workspace scopes', async () => {
    let releasePull!: () => void;
    const pullGate = new Promise<void>((resolve) => {
      releasePull = resolve;
    });
    const adapterPull = vi.fn(async () => {
      await pullGate;
      return { version: 5 };
    });
    const api = await startSyncServer(fixedShareContextProvider(true), {
      projectStore: fakeProjectStore(),
      resolvePullDir: (projectId) => `/does/not/exist/${projectId}`,
      resolveSharedProject: resolvePulledSharedProject,
    }, {
      adapter: {
        publish: vi.fn(async () => ({ version: 5 })),
        pull: adapterPull,
        syncLatest: vi.fn(async () => ({ version: 5 })),
      },
    });
    const otherWorkspaceScope = {
      ...pullScope,
      workspaceId: 'ws-other',
    };

    const active = api.handle.pullSharedProject(
      'cross-workspace-pull',
      pullScope,
    );
    await vi.waitFor(() => expect(adapterPull).toHaveBeenCalledTimes(1));
    const mismatched = api.handle.pullSharedProject(
      'cross-workspace-pull',
      otherWorkspaceScope,
    );

    let mismatchedSettled = false;
    void mismatched.finally(() => {
      mismatchedSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(mismatchedSettled).toBe(false);
    expect(adapterPull).toHaveBeenCalledTimes(1);
    releasePull();
    await expect(mismatched).resolves.toEqual({
      status: 'register_failed',
    });
    await expect(active).resolves.toEqual({ status: 'pulled', version: 5 });
    expect(adapterPull).toHaveBeenCalledTimes(1);
  });

  it('allows different project ids to enter transport concurrently', async () => {
    let releasePull!: () => void;
    const pullGate = new Promise<void>((resolve) => {
      releasePull = resolve;
    });
    const adapterPull = vi.fn(async () => {
      await pullGate;
      return { version: 5 };
    });
    const api = await startSyncServer(fixedShareContextProvider(true), {
      projectStore: fakeProjectStore(),
      resolvePullDir: (projectId) => `/does/not/exist/${projectId}`,
      resolveSharedProject: resolvePulledSharedProject,
    }, {
      adapter: {
        publish: vi.fn(async () => ({ version: 5 })),
        pull: adapterPull,
        syncLatest: vi.fn(async () => ({ version: 5 })),
      },
    });

    const first = api.handle.pullSharedProject('parallel-a', pullScope);
    const second = api.handle.pullSharedProject('parallel-b', pullScope);
    await vi.waitFor(() => expect(adapterPull).toHaveBeenCalledTimes(2));
    releasePull();

    await expect(Promise.all([first, second])).resolves.toEqual([
      { status: 'pulled', version: 5 },
      { status: 'pulled', version: 5 },
    ]);
  });

  it('releases the per-project pull lock after a transport deadline rejects', async () => {
    const adapterPull = vi.fn()
      .mockRejectedValueOnce(new Error('vela resource pull timed out'))
      .mockResolvedValueOnce({ version: 5 });
    const store = fakeProjectStore();
    const onPullTiming = vi.fn();
    const api = await startSyncServer(fixedShareContextProvider(true), {
      projectStore: store,
      resolvePullDir: (projectId) => `/does/not/exist/${projectId}`,
      resolveSharedProjectOwner: async () => pullScope.ownerMemberId,
      resolveSharedProject: resolvePulledSharedProject,
      writeMaterializedVersion: async () => undefined,
      onPullTiming,
    }, {
      adapter: {
        publish: vi.fn(async () => ({ version: 5 })),
        pull: adapterPull,
        syncLatest: vi.fn(async () => ({ version: 5 })),
      },
    });

    await expect(
      api.handle.pullSharedProject('deadline-retry', pullScope),
    ).rejects.toThrow('timed out');
    expect(onPullTiming.mock.calls.map(([event]) => event)).toEqual([
      expect.objectContaining({ phase: 'route-started' }),
      expect.objectContaining({ phase: 'transport-invoke' }),
      expect.objectContaining({ phase: 'transport-done', status: 'threw' }),
      expect.objectContaining({ phase: 'route-completed', status: 'threw' }),
    ]);
    onPullTiming.mockClear();
    await expect(
      api.handle.pullSharedProject('deadline-retry', pullScope),
    ).resolves.toEqual({ status: 'pulled', version: 5 });

    expect(adapterPull).toHaveBeenCalledTimes(2);
  });
});
