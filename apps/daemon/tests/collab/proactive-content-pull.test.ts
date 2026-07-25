import { describe, expect, it, vi } from 'vitest';
import {
  createProactiveContentPull,
  type ProactiveContentPull,
  type ProactiveContentPullDeps,
} from '../../src/collab/proactive-content-pull.js';

// Hub push-channel consumer for 'project-content-changed' (recvqmKQRiIlYf):
// when a teammate publishes a new version of a shared project, the member's
// daemon pulls the content proactively — no open tab required — instead of
// leaving freshness to the member web's ~5s status polling. These tests pin
// the guard boundary: the pull must NEVER touch a project this daemon owns
// (the owner's local copy is the single writer), may bootstrap a teammate's
// newly-shared project from a workspace-scoped event before a local binding
// exists, must dedupe repeated/racing events, and must degrade silently on
// failure so the web polling fallback stays authoritative.

type Deps = ProactiveContentPullDeps;

function makeDeps(overrides: Partial<Deps> = {}): Deps & {
  pullCalls: string[];
} {
  const pullCalls: string[] = [];
  const deps: Deps & { pullCalls: string[] } = {
    pullCalls,
    getLocalBinding: () => ({ workspaceId: 'ws-1', visibility: 'team' }),
    getWorkspaceIdentity: async () => ({
      workspaceId: 'ws-1',
      resourceTeamId: 'team-1',
      workspaceMemberId: 'wm-member',
    }),
    resolveSharedProjectOwner: async () => 'wm-owner',
    pullSharedProject: async (target) => {
      pullCalls.push(target.projectId);
      return { status: 'pulled', version: 3 };
    },
    ...overrides,
  };
  return deps;
}

const baseEvent = { projectId: 'proj-1', workspaceId: 'ws-1', version: 3 };

function makeRetryScheduler() {
  type Task = {
    callback: () => void | Promise<void>;
    delayMs: number;
    handle: { id: number; unref: ReturnType<typeof vi.fn> };
  };
  let nextId = 1;
  const tasks = new Map<number, Task>();
  const delays: number[] = [];
  const cleared: number[] = [];
  const scheduler = {
    setTimeout(callback: () => void | Promise<void>, delayMs: number) {
      const handle = { id: nextId, unref: vi.fn() };
      nextId += 1;
      tasks.set(handle.id, { callback, delayMs, handle });
      delays.push(delayMs);
      return handle;
    },
    clearTimeout(handle: { id: number }) {
      cleared.push(handle.id);
      tasks.delete(handle.id);
    },
  };
  return {
    scheduler,
    delays,
    cleared,
    tasks,
    async runNext() {
      const task = [...tasks.values()].sort((a, b) => a.handle.id - b.handle.id)[0];
      if (!task) throw new Error('expected a scheduled retry');
      tasks.delete(task.handle.id);
      await task.callback();
    },
  };
}

describe('proactive content pull (hub project-content-changed consumer)', () => {
  it('pulls a locally-bound team project owned by a teammate', async () => {
    const deps = makeDeps();
    const pull = createProactiveContentPull(deps);
    await pull.handleContentChanged(baseEvent);
    expect(deps.pullCalls).toEqual(['proj-1']);
  });

  it('skips an event without a projectId', async () => {
    const deps = makeDeps();
    const pull = createProactiveContentPull(deps);
    await pull.handleContentChanged({ workspaceId: 'ws-1', version: 3 });
    expect(deps.pullCalls).toEqual([]);
  });

  it('pulls a newly-shared teammate project before this daemon has a local binding', async () => {
    const onPulled = vi.fn();
    const deps = makeDeps({ getLocalBinding: () => null, onPulled });
    const pull = createProactiveContentPull(deps);
    await pull.handleContentChanged(baseEvent);
    expect(deps.pullCalls).toEqual(['proj-1']);
    expect(onPulled).toHaveBeenCalledWith({
      projectId: 'proj-1',
      workspaceId: 'ws-1',
      resourceTeamId: 'team-1',
      viewerMemberId: 'wm-member',
      ownerMemberId: 'wm-owner',
    }, 3);
  });

  it('skips an unbound project when the event carries no workspace scope', async () => {
    const deps = makeDeps({ getLocalBinding: () => null });
    const pull = createProactiveContentPull(deps);
    await pull.handleContentChanged({ projectId: 'proj-1', version: 3 });
    expect(deps.pullCalls).toEqual([]);
  });

  it('skips an unbound project whose event workspace is not the active team', async () => {
    const deps = makeDeps({ getLocalBinding: () => null });
    const pull = createProactiveContentPull(deps);
    await pull.handleContentChanged({ ...baseEvent, workspaceId: 'ws-other' });
    expect(deps.pullCalls).toEqual([]);
  });

  it('skips a project whose local binding is personal, not team', async () => {
    const deps = makeDeps({
      getLocalBinding: () => ({ workspaceId: 'ws-1', visibility: 'personal' }),
    });
    const pull = createProactiveContentPull(deps);
    await pull.handleContentChanged(baseEvent);
    expect(deps.pullCalls).toEqual([]);
  });

  it('skips an event whose workspace does not match the local binding', async () => {
    const deps = makeDeps();
    const pull = createProactiveContentPull(deps);
    await pull.handleContentChanged({ ...baseEvent, workspaceId: 'ws-other' });
    expect(deps.pullCalls).toEqual([]);
  });

  it('skips when the active identity is in a different workspace than the binding', async () => {
    const deps = makeDeps({
      getWorkspaceIdentity: async () => ({
        workspaceId: 'ws-other',
        resourceTeamId: 'team-other',
        workspaceMemberId: 'wm-member',
      }),
    });
    const pull = createProactiveContentPull(deps);
    // Event carries no workspaceId: the binding/identity cross-check alone
    // must still refuse to pull under a foreign-workspace principal.
    await pull.handleContentChanged({ projectId: 'proj-1', version: 3 });
    expect(deps.pullCalls).toEqual([]);
  });

  it('skips when there is no team workspace identity (signed out / personal)', async () => {
    const deps = makeDeps({ getWorkspaceIdentity: async () => null });
    const pull = createProactiveContentPull(deps);
    await pull.handleContentChanged(baseEvent);
    expect(deps.pullCalls).toEqual([]);
  });

  it('fails closed when the owner cannot be resolved', async () => {
    const deps = makeDeps({ resolveSharedProjectOwner: async () => null });
    const pull = createProactiveContentPull(deps);
    await pull.handleContentChanged(baseEvent);
    expect(deps.pullCalls).toEqual([]);
  });

  it('fails closed when the owner lookup throws', async () => {
    const deps = makeDeps({
      resolveSharedProjectOwner: async () => {
        throw new Error('hub unavailable');
      },
    });
    const pull = createProactiveContentPull(deps);
    await pull.handleContentChanged(baseEvent);
    expect(deps.pullCalls).toEqual([]);
  });

  it('never pulls a project this daemon member owns (single-writer protection)', async () => {
    const deps = makeDeps({ resolveSharedProjectOwner: async () => 'wm-member' });
    const pull = createProactiveContentPull(deps);
    await pull.handleContentChanged(baseEvent);
    expect(deps.pullCalls).toEqual([]);
  });

  it('dedupes a repeated event for an already-pulled version, and pulls again for a newer one', async () => {
    const deps = makeDeps();
    const pull = createProactiveContentPull(deps);

    await pull.handleContentChanged({ ...baseEvent, version: 3 });
    expect(deps.pullCalls).toEqual(['proj-1']);

    // Duplicate (and older) events are no-ops once version 3 materialized.
    await pull.handleContentChanged({ ...baseEvent, version: 3 });
    await pull.handleContentChanged({ ...baseEvent, version: 2 });
    expect(deps.pullCalls).toEqual(['proj-1']);

    // A genuinely newer head pulls again.
    deps.pullSharedProject = async (target) => {
      deps.pullCalls.push(target.projectId);
      return { status: 'pulled', version: 4 };
    };
    await pull.handleContentChanged({ ...baseEvent, version: 4 });
    expect(deps.pullCalls).toEqual(['proj-1', 'proj-1']);
  });

  it('keeps the version cursor independent per project', async () => {
    const deps = makeDeps();
    const pull = createProactiveContentPull(deps);
    await pull.handleContentChanged({ ...baseEvent, version: 3 });
    await pull.handleContentChanged({ ...baseEvent, projectId: 'proj-2', version: 3 });
    expect(deps.pullCalls).toEqual(['proj-1', 'proj-2']);
  });

  it('coalesces events that race an in-flight pull for the same head', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const deps = makeDeps({
      pullSharedProject: async (target) => {
        deps.pullCalls.push(target.projectId);
        await gate;
        return { status: 'pulled', version: 3 };
      },
    });
    const pull = createProactiveContentPull(deps);

    const first = pull.handleContentChanged(baseEvent);
    const second = pull.handleContentChanged(baseEvent);
    release();
    await Promise.all([first, second]);

    expect(deps.pullCalls).toEqual(['proj-1']);
  });

  it('serializes v2 behind an in-flight v1 pull, then materializes v2', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let call = 0;
    let active = 0;
    let maxActive = 0;
    const deps = makeDeps({
      pullSharedProject: async (target) => {
        deps.pullCalls.push(target.projectId);
        call += 1;
        active += 1;
        maxActive = Math.max(maxActive, active);
        try {
          if (call === 1) {
            await gate;
            return { status: 'pulled', version: 1 };
          }
          return { status: 'pulled', version: 2 };
        } finally {
          active -= 1;
        }
      },
    });
    const pull = createProactiveContentPull(deps);

    const first = pull.handleContentChanged({ ...baseEvent, version: 1 });
    await vi.waitFor(() => expect(deps.pullCalls).toEqual(['proj-1']));
    const second = pull.handleContentChanged({ ...baseEvent, version: 2 });
    expect(maxActive).toBe(1);
    release();
    await Promise.all([first, second]);

    // The v2 event waited out the v1 pull, saw the cursor still behind, and
    // pulled once more — exactly one trailing pull, not a loop.
    expect(deps.pullCalls).toEqual(['proj-1', 'proj-1']);
    expect(maxActive).toBe(1);
  });

  it('degrades silently on pull failure and leaves the cursor behind so a retry is allowed', async () => {
    const retry = makeRetryScheduler();
    const onError = vi.fn();
    let fail = true;
    const deps = makeDeps({
      onError,
      pullSharedProject: async (target) => {
        deps.pullCalls.push(target.projectId);
        if (fail) throw new Error('vela transport down');
        return { status: 'pulled', version: 3 };
      },
    });
    Object.assign(deps, {
      scheduler: retry.scheduler,
      random: () => 1,
    });
    const pull = createProactiveContentPull(deps);

    await expect(pull.handleContentChanged(baseEvent)).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledTimes(1);

    // Cursor did not advance on failure: the scheduled same-version retry is
    // still allowed, without a duplicate event resetting its backoff.
    fail = false;
    await retry.runNext();
    expect(deps.pullCalls).toEqual(['proj-1', 'proj-1']);
  });

  it('lets a v2 catch-up retry after a failed v1 pull without advancing the cursor', async () => {
    const onError = vi.fn();
    let attempt = 0;
    const deps = makeDeps({
      onError,
      getLocalBinding: () => null,
      pullSharedProject: async (target) => {
        deps.pullCalls.push(target.projectId);
        attempt += 1;
        if (attempt === 1) throw new Error('v1 transport failed');
        return { status: 'pulled', version: 2 };
      },
      listSharedProjects: async () => [
        { projectId: 'proj-1', ownerMemberId: 'wm-owner' },
      ],
      publishedHead: async () => 2,
    });
    const pull = createProactiveContentPull(deps);

    await pull.handleContentChanged({ ...baseEvent, version: 1 });
    await pull.catchUpPublishedHeads('ws-1');
    await pull.handleContentChanged({ ...baseEvent, version: 2 });

    expect(onError).toHaveBeenCalledTimes(1);
    expect(deps.pullCalls).toEqual(['proj-1', 'proj-1']);
  });

  it('does not advance the cursor on a revoked outcome', async () => {
    const onPulled = vi.fn();
    let revoked = true;
    const deps = makeDeps({
      onPulled,
      pullSharedProject: async (target) => {
        deps.pullCalls.push(target.projectId);
        return revoked ? { status: 'revoked' } : { status: 'pulled', version: 3 };
      },
    });
    const pull = createProactiveContentPull(deps);

    await pull.handleContentChanged(baseEvent);
    // A later re-share of the same head must be able to pull again.
    revoked = false;
    await pull.handleContentChanged(baseEvent);
    expect(deps.pullCalls).toEqual(['proj-1', 'proj-1']);
    expect(onPulled).toHaveBeenCalledTimes(1);
  });

  it('never rejects, even when an identity read throws', async () => {
    const onError = vi.fn();
    const deps = makeDeps({
      onError,
      getWorkspaceIdentity: async () => {
        throw new Error('context provider crashed');
      },
    });
    const pull = createProactiveContentPull(deps);
    await expect(pull.handleContentChanged(baseEvent)).resolves.toBeUndefined();
    expect(deps.pullCalls).toEqual([]);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('catches up a published head that already existed before the first hub connection', async () => {
    const deps = makeDeps({ getLocalBinding: () => null });
    const listSharedProjects = vi.fn(async () => [
      { projectId: 'proj-1', ownerMemberId: 'wm-owner' },
    ]);
    const publishedHead = vi.fn(async () => 3);
    Object.assign(deps, { listSharedProjects, publishedHead });
    const pull = createProactiveContentPull(deps);

    await pull.catchUpPublishedHeads('ws-1');

    expect(listSharedProjects).toHaveBeenCalledTimes(1);
    expect(publishedHead).toHaveBeenCalledTimes(1);
    expect(deps.pullCalls).toEqual(['proj-1']);
  });

  it('dedupes an unchanged reconnect sweep, then pulls once when the missed head advanced', async () => {
    let head = 3;
    const deps = makeDeps();
    const listSharedProjects = vi.fn(async () => [
      { projectId: 'proj-1', ownerMemberId: 'wm-owner' },
    ]);
    const publishedHead = vi.fn(async () => head);
    Object.assign(deps, { listSharedProjects, publishedHead });
    const pull = createProactiveContentPull(deps);

    await pull.catchUpPublishedHeads('ws-1');
    await pull.catchUpPublishedHeads('ws-1');
    expect(deps.pullCalls).toEqual(['proj-1']);

    // The v4 signal was missed while disconnected. The reconnect sweep sees
    // the authoritative head and routes it through the same version cursor.
    head = 4;
    deps.pullSharedProject = async (target) => {
      deps.pullCalls.push(target.projectId);
      return { status: 'pulled', version: 4 };
    };
    await pull.catchUpPublishedHeads('ws-1');

    expect(deps.pullCalls).toEqual(['proj-1', 'proj-1']);
    expect(listSharedProjects).toHaveBeenCalledTimes(3);
  });

  it('materializes a placeholder row whose project content is still missing when the healthy-stream floor observes it', async () => {
    let materialized = false;
    const deps = makeDeps({
      getLocalBinding: () => null,
      pullSharedProject: async (target) => {
        deps.pullCalls.push(target.projectId);
        materialized = true;
        return { status: 'pulled', version: 3 };
      },
    });
    const listSharedProjects = vi.fn(async () => [
      { projectId: 'proj-1', ownerMemberId: 'wm-owner' },
    ]);
    const publishedHead = vi.fn(async () => 3);
    Object.assign(deps, {
      listSharedProjects,
      publishedHead,
      // getLocalBinding above proves the placeholder DB row/team binding
      // exists; the materialization probe must look through that shell.
      hasMaterializedProject: () => materialized,
    });
    const pull = createProactiveContentPull(deps);

    await pull.materializeMissingProjects('ws-1');
    await pull.materializeMissingProjects('ws-1');

    expect(listSharedProjects).toHaveBeenCalledTimes(2);
    expect(publishedHead).toHaveBeenCalledTimes(1);
    expect(deps.pullCalls).toEqual(['proj-1']);
  });

  it('does not read a head for a project owned by this daemon member', async () => {
    const deps = makeDeps();
    const publishedHead = vi.fn(async () => 3);
    Object.assign(deps, {
      listSharedProjects: async () => [
        { projectId: 'mine', ownerMemberId: 'wm-member' },
      ],
      publishedHead,
    });
    const pull = createProactiveContentPull(deps);

    await pull.catchUpPublishedHeads('ws-1');

    expect(publishedHead).not.toHaveBeenCalled();
    expect(deps.pullCalls).toEqual([]);
  });

  it('retries a catch-up after the active team identity was temporarily unavailable', async () => {
    let identityAvailable = false;
    const deps = makeDeps({
      getWorkspaceIdentity: async () => identityAvailable
        ? {
            workspaceId: 'ws-1',
            resourceTeamId: 'team-1',
            workspaceMemberId: 'wm-member',
          }
        : null,
    });
    const listSharedProjects = vi.fn(async () => [
      { projectId: 'proj-1', ownerMemberId: 'wm-owner' },
    ]);
    Object.assign(deps, {
      listSharedProjects,
      publishedHead: async () => 3,
    });
    const pull = createProactiveContentPull(deps);

    await pull.catchUpPublishedHeads('ws-1');
    identityAvailable = true;
    await pull.catchUpPublishedHeads('ws-1');

    expect(listSharedProjects).toHaveBeenCalledTimes(1);
    expect(deps.pullCalls).toEqual(['proj-1']);
  });

  it('isolates one published-head failure and continues the sequential sweep', async () => {
    const onError = vi.fn();
    let active = 0;
    let maxActive = 0;
    const deps = makeDeps({ onError });
    Object.assign(deps, {
      listSharedProjects: async () => [
        { projectId: 'broken', ownerMemberId: 'wm-owner' },
        { projectId: 'healthy', ownerMemberId: 'wm-owner' },
        { projectId: 'healthy-2', ownerMemberId: 'wm-owner' },
      ],
      publishedHead: async (target: { projectId: string }) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await Promise.resolve();
        active -= 1;
        if (target.projectId === 'broken') throw new Error('head unavailable');
        return 3;
      },
    });
    const pull = createProactiveContentPull(deps);

    await pull.catchUpPublishedHeads('ws-1');

    expect(onError).toHaveBeenCalledTimes(1);
    expect(maxActive).toBe(1);
    expect(deps.pullCalls).toEqual(['healthy', 'healthy-2']);
  });

  it('coalesces a live event with the same catch-up head onto one pull', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const deps = makeDeps({
      pullSharedProject: async (target) => {
        deps.pullCalls.push(target.projectId);
        await gate;
        return { status: 'pulled', version: 3 };
      },
    });
    Object.assign(deps, {
      listSharedProjects: async () => [
        { projectId: 'proj-1', ownerMemberId: 'wm-owner' },
      ],
      publishedHead: async () => 3,
    });
    const pull = createProactiveContentPull(deps);

    const catchUp = pull.catchUpPublishedHeads('ws-1');
    await vi.waitFor(() => expect(deps.pullCalls).toEqual(['proj-1']));
    const liveEvent = pull.handleContentChanged(baseEvent);
    release();
    await Promise.all([catchUp, liveEvent]);

    expect(deps.pullCalls).toEqual(['proj-1']);
  });

  it('lets a missing-project sweep overtake a full sweep blocked on historical work', async () => {
    let releaseHistoricalHead!: () => void;
    const historicalHeadGate = new Promise<void>((resolve) => {
      releaseHistoricalHead = resolve;
    });
    let catalogReads = 0;
    let signalNewProjectPulled!: () => void;
    const newProjectPulled = new Promise<void>((resolve) => {
      signalNewProjectPulled = resolve;
    });
    const publishedHead = vi.fn(async (target: { projectId: string }) => {
      if (target.projectId === 'historical') await historicalHeadGate;
      return 3;
    });
    const deps = makeDeps({
      getLocalBinding: () => null,
      pullSharedProject: async (target) => {
        deps.pullCalls.push(target.projectId);
        if (target.projectId === 'new-project') signalNewProjectPulled();
        return { status: 'pulled', version: 3 };
      },
      listSharedProjects: async () => {
        catalogReads += 1;
        return catalogReads === 1
          ? [{ projectId: 'historical', ownerMemberId: 'wm-owner' }]
          : [{ projectId: 'new-project', ownerMemberId: 'wm-owner' }];
      },
      hasMaterializedProject: (projectId) => projectId !== 'new-project',
      publishedHead,
    });
    const pull = createProactiveContentPull(deps);

    const full = pull.catchUpPublishedHeads('ws-1');
    await vi.waitFor(() => {
      expect(publishedHead).toHaveBeenCalledWith(
        expect.objectContaining({ projectId: 'historical' }),
      );
    });
    const missing = pull.materializeMissingProjects('ws-1');

    try {
      await newProjectPulled;
      expect(deps.pullCalls).toContain('new-project');
      expect(deps.pullCalls).not.toContain('historical');
    } finally {
      releaseHistoricalHead();
      await Promise.all([full, missing]);
    }
  });

  it('reuses a full-sweep pull when missing-only races the same project', async () => {
    let releasePull!: () => void;
    const pullGate = new Promise<void>((resolve) => {
      releasePull = resolve;
    });
    let materialized = false;
    let materializationProbes = 0;
    const deps = makeDeps({
      getLocalBinding: () => null,
      pullSharedProject: async (target) => {
        deps.pullCalls.push(target.projectId);
        await pullGate;
        materialized = true;
        return { status: 'pulled', version: 3 };
      },
      listSharedProjects: async () => [
        { projectId: 'proj-1', ownerMemberId: 'wm-owner' },
      ],
      hasMaterializedProject: () => {
        materializationProbes += 1;
        return materialized;
      },
      publishedHead: async () => 3,
    });
    const pull = createProactiveContentPull(deps);

    const full = pull.catchUpPublishedHeads('ws-1');
    await vi.waitFor(() => expect(deps.pullCalls).toEqual(['proj-1']));
    const missing = pull.materializeMissingProjects('ws-1');
    await vi.waitFor(() => expect(materializationProbes).toBeGreaterThan(0));
    releasePull();
    await Promise.all([full, missing]);

    expect(deps.pullCalls).toEqual(['proj-1']);
  });

  it('does not duplicate a full-sweep pull when the missing probe returns a stale false', async () => {
    let releaseFullPull!: () => void;
    const fullPullGate = new Promise<void>((resolve) => {
      releaseFullPull = resolve;
    });
    let releaseStaleProbe!: () => void;
    const staleProbeGate = new Promise<void>((resolve) => {
      releaseStaleProbe = resolve;
    });
    let signalStaleProbeStarted!: () => void;
    const staleProbeStarted = new Promise<void>((resolve) => {
      signalStaleProbeStarted = resolve;
    });
    let probeCalls = 0;
    const deps = makeDeps({
      getLocalBinding: () => null,
      pullSharedProject: async (target) => {
        deps.pullCalls.push(target.projectId);
        if (deps.pullCalls.length === 1) await fullPullGate;
        return { status: 'pulled', version: 3 };
      },
      listSharedProjects: async () => [
        { projectId: 'proj-1', ownerMemberId: 'wm-owner' },
      ],
      hasMaterializedProject: async () => {
        probeCalls += 1;
        if (probeCalls === 1) return false;
        const staleResult = false;
        signalStaleProbeStarted();
        await staleProbeGate;
        return staleResult;
      },
      publishedHead: async () => 3,
    });
    const pull = createProactiveContentPull(deps);

    const full = pull.catchUpPublishedHeads('ws-1');
    await vi.waitFor(() => expect(deps.pullCalls).toEqual(['proj-1']));
    const missing = pull.materializeMissingProjects('ws-1');
    await staleProbeStarted;

    releaseFullPull();
    await full;
    releaseStaleProbe();
    await missing;

    expect(deps.pullCalls).toEqual(['proj-1']);
  });

  it('coalesces repeated missing-only triggers into one trailing sweep', async () => {
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let catalogReads = 0;
    const deps = makeDeps({
      listSharedProjects: async () => {
        catalogReads += 1;
        if (catalogReads === 1) await firstGate;
        return [];
      },
      hasMaterializedProject: () => false,
      publishedHead: async () => null,
    });
    const pull = createProactiveContentPull(deps);

    const first = pull.materializeMissingProjects('ws-1');
    await vi.waitFor(() => expect(catalogReads).toBe(1));
    const second = pull.materializeMissingProjects('ws-1');
    const third = pull.materializeMissingProjects('ws-1');
    releaseFirst();
    await Promise.all([first, second, third]);

    expect(catalogReads).toBe(2);
  });

  it('does not drop a third sweep requested while the trailing sweep is running', async () => {
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const secondGate = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    let lists = 0;
    const deps = makeDeps();
    Object.assign(deps, {
      listSharedProjects: async () => {
        lists += 1;
        if (lists === 1) await firstGate;
        if (lists === 2) await secondGate;
        return [];
      },
      publishedHead: async () => null,
      hasMaterializedProject: () => false,
    });
    const pull = createProactiveContentPull(deps);

    const first = pull.catchUpPublishedHeads('ws-1');
    const second = pull.materializeMissingProjects('ws-1');
    releaseFirst();
    await vi.waitFor(() => expect(lists).toBe(2));
    const third = pull.catchUpPublishedHeads('ws-1');
    releaseSecond();
    await Promise.all([first, second, third]);

    expect(lists).toBe(3);
  });

  it('seeds the event cursor from the durable materialized version on cold start', async () => {
    const deps = makeDeps();
    const publishedHead = vi.fn(async () => 3);
    Object.assign(deps, {
      listSharedProjects: async () => [
        { projectId: 'proj-1', ownerMemberId: 'wm-owner' },
      ],
      publishedHead,
      materializedVersion: () => '3',
    });
    const pull = createProactiveContentPull(deps);

    await pull.catchUpPublishedHeads('ws-1');
    await pull.handleContentChanged(baseEvent);

    expect(publishedHead).toHaveBeenCalledTimes(1);
    expect(deps.pullCalls).toEqual([]);
  });

  it('does not reuse a durable cursor after the shared project owner changes', async () => {
    const deps = makeDeps();
    Object.assign(deps, {
      listSharedProjects: async () => [
        { projectId: 'proj-1', ownerMemberId: 'wm-new-owner' },
      ],
      publishedHead: async () => 1,
      // Version 10 belonged to the previous owner's resource scope.
      materializedVersion: (target: { ownerMemberId: string }) =>
        target.ownerMemberId === 'wm-old-owner' ? '10' : null,
    });
    const pull = createProactiveContentPull(deps);

    await pull.catchUpPublishedHeads('ws-1');

    expect(deps.pullCalls).toEqual(['proj-1']);
  });

  it('forces a missing-only pull when the manifest is absent even if the durable cursor equals head', async () => {
    const deps = makeDeps({ getLocalBinding: () => null });
    Object.assign(deps, {
      listSharedProjects: async () => [
        { projectId: 'proj-1', ownerMemberId: 'wm-owner' },
      ],
      hasMaterializedProject: async () => false,
      publishedHead: async () => 3,
      materializedVersion: () => '3',
    });
    const pull = createProactiveContentPull(deps);

    await pull.materializeMissingProjects('ws-1');

    expect(deps.pullCalls).toEqual(['proj-1']);
  });
});

describe('proactive content pull retry coordinator', () => {
  it.each([
    ['missing identity', 'null'],
    ['throwing identity lookup', 'throw'],
  ] as const)(
    'does not let an in-flight provisional guard with %s erase a freshly guarded same-version event',
    async (_label, staleResult) => {
      const retry = makeRetryScheduler();
      let identityCalls = 0;
      let signalStaleGuardStarted!: () => void;
      const staleGuardStarted = new Promise<void>((resolve) => {
        signalStaleGuardStarted = resolve;
      });
      let resolveStaleGuard!: () => void;
      let rejectStaleGuard!: (error: Error) => void;
      const staleGuard = new Promise<void>((resolve, reject) => {
        resolveStaleGuard = resolve;
        rejectStaleGuard = reject;
      });
      const deps = makeDeps({
        getWorkspaceIdentity: async () => {
          identityCalls += 1;
          if (identityCalls === 1) return null;
          if (identityCalls === 2) {
            signalStaleGuardStarted();
            await staleGuard;
            if (staleResult === 'throw') {
              throw new Error('stale context read failed');
            }
            return null;
          }
          return {
            workspaceId: 'ws-1',
            resourceTeamId: 'team-1',
            workspaceMemberId: 'wm-member',
          };
        },
      });
      Object.assign(deps, {
        scheduler: retry.scheduler,
        random: () => 1,
      });
      const pull = createProactiveContentPull(deps);

      await pull.handleContentChanged(baseEvent);
      expect(retry.tasks.size).toBe(1);

      const staleRetry = retry.runNext();
      await staleGuardStarted;
      const freshEvent = pull.handleContentChanged(baseEvent);
      await vi.waitFor(() => expect(identityCalls).toBe(3));

      if (staleResult === 'throw') {
        rejectStaleGuard(new Error('release rejected stale guard'));
      } else {
        resolveStaleGuard();
      }
      await Promise.all([staleRetry, freshEvent]);

      expect(deps.pullCalls).toEqual(['proj-1']);
      expect(retry.tasks.size).toBe(0);
    },
  );

  it('wakes immediately when a same-version event resolves a provisional guard retry', async () => {
    const retry = makeRetryScheduler();
    let identityAvailable = false;
    const deps = makeDeps({
      getWorkspaceIdentity: async () => identityAvailable
        ? {
            workspaceId: 'ws-1',
            resourceTeamId: 'team-1',
            workspaceMemberId: 'wm-member',
          }
        : null,
    });
    Object.assign(deps, {
      scheduler: retry.scheduler,
      random: () => 1,
    });
    const pull = createProactiveContentPull(deps);

    await pull.handleContentChanged(baseEvent);
    expect(deps.pullCalls).toEqual([]);
    expect(retry.delays).toEqual([1_000]);
    expect(retry.tasks.size).toBe(1);

    identityAvailable = true;
    await pull.handleContentChanged(baseEvent);

    expect(retry.cleared).toHaveLength(1);
    expect(deps.pullCalls).toEqual(['proj-1']);
    expect(retry.tasks.size).toBe(0);
  });

  it('merges live and full-sweep failures after both guard to the same final scope', async () => {
    const retry = makeRetryScheduler();
    const deps = makeDeps({
      pullSharedProject: async (target) => {
        deps.pullCalls.push(target.projectId);
        throw new Error('transport down');
      },
      listSharedProjects: async () => [
        { projectId: 'proj-1', ownerMemberId: 'wm-owner' },
      ],
      publishedHead: async () => 3,
    });
    Object.assign(deps, {
      scheduler: retry.scheduler,
      random: () => 1,
    });
    const pull = createProactiveContentPull(deps);

    await pull.handleContentChanged(baseEvent);
    await pull.catchUpPublishedHeads('ws-1');

    expect(deps.pullCalls).toEqual(['proj-1']);
    expect(retry.delays).toEqual([1_000]);
    expect(retry.tasks.size).toBe(1);
  });

  it('treats an inner manifest hit as removing force, not as satisfying a newer head', async () => {
    let probes = 0;
    let pullAttempt = 0;
    const deps = makeDeps({
      pullSharedProject: async (target) => {
        deps.pullCalls.push(target.projectId);
        pullAttempt += 1;
        return { status: 'pulled', version: pullAttempt };
      },
      listSharedProjects: async () => [
        { projectId: 'proj-1', ownerMemberId: 'wm-owner' },
      ],
      hasMaterializedProject: () => {
        probes += 1;
        return probes === 2;
      },
      publishedHead: async () => 2,
    });
    const pull = createProactiveContentPull(deps);

    await pull.handleContentChanged({ ...baseEvent, version: 1 });
    await pull.materializeMissingProjects('ws-1');

    expect(probes).toBe(2);
    expect(deps.pullCalls).toEqual(['proj-1', 'proj-1']);
  });

  it('clears an established retry when the active team identity disappears', async () => {
    const retry = makeRetryScheduler();
    let identityAvailable = true;
    const deps = makeDeps({
      getWorkspaceIdentity: async () => identityAvailable
        ? {
            workspaceId: 'ws-1',
            resourceTeamId: 'team-1',
            workspaceMemberId: 'wm-member',
          }
        : null,
      pullSharedProject: async (target) => {
        deps.pullCalls.push(target.projectId);
        throw new Error('transport down');
      },
    });
    Object.assign(deps, {
      scheduler: retry.scheduler,
      random: () => 1,
    });
    const pull = createProactiveContentPull(deps);

    await pull.handleContentChanged(baseEvent);
    identityAvailable = false;
    await retry.runNext();

    expect(deps.pullCalls).toEqual(['proj-1']);
    expect(retry.tasks.size).toBe(0);
  });

  it('clears an established retry when owner resolution confirms the project is gone', async () => {
    const retry = makeRetryScheduler();
    let owner: string | null = 'wm-owner';
    const deps = makeDeps({
      resolveSharedProjectOwner: async () => owner,
      pullSharedProject: async (target) => {
        deps.pullCalls.push(target.projectId);
        throw new Error('transport down');
      },
    });
    Object.assign(deps, {
      scheduler: retry.scheduler,
      random: () => 1,
    });
    const pull = createProactiveContentPull(deps);

    await pull.handleContentChanged(baseEvent);
    owner = null;
    await retry.runNext();

    expect(deps.pullCalls).toEqual(['proj-1']);
    expect(retry.tasks.size).toBe(0);
  });

  it('keeps an established retry when owner resolution throws transiently', async () => {
    const retry = makeRetryScheduler();
    let ownerLookupThrows = false;
    const deps = makeDeps({
      resolveSharedProjectOwner: async () => {
        if (ownerLookupThrows) throw new Error('hub unavailable');
        return 'wm-owner';
      },
      pullSharedProject: async (target) => {
        deps.pullCalls.push(target.projectId);
        throw new Error('transport down');
      },
    });
    Object.assign(deps, {
      scheduler: retry.scheduler,
      random: () => 1,
    });
    const pull = createProactiveContentPull(deps);

    await pull.handleContentChanged(baseEvent);
    ownerLookupThrows = true;
    await retry.runNext();

    expect(deps.pullCalls).toEqual(['proj-1']);
    expect(retry.delays).toEqual([1_000, 2_000]);
    expect(retry.tasks.size).toBe(1);
  });

  it('retries an unknown-version event when pull reports an unknown version', async () => {
    const retry = makeRetryScheduler();
    const deps = makeDeps({
      pullSharedProject: async (target) => {
        deps.pullCalls.push(target.projectId);
        return { status: 'pulled', version: null };
      },
    });
    Object.assign(deps, {
      scheduler: retry.scheduler,
      random: () => 1,
    });
    const pull = createProactiveContentPull(deps);

    await pull.handleContentChanged({
      projectId: 'proj-1',
      workspaceId: 'ws-1',
    });

    expect(deps.pullCalls).toEqual(['proj-1']);
    expect(retry.delays).toEqual([1_000]);
    expect(retry.tasks.size).toBe(1);
  });

  it.each([
    ['thrown transport failure', 'throw'],
    ['null transport result', 'null'],
    ['register failure', 'register_failed'],
    ['unknown materialized version', 'version_null'],
    ['materialized version below the desired head', 'version_low'],
  ] as const)('retries after %s and eventually covers the desired version', async (_label, firstResult) => {
    const retry = makeRetryScheduler();
    let attempt = 0;
    const deps = makeDeps({
      pullSharedProject: async (target) => {
        deps.pullCalls.push(target.projectId);
        attempt += 1;
        if (attempt > 1) return { status: 'pulled', version: 3 };
        if (firstResult === 'throw') throw new Error('transport down');
        if (firstResult === 'null') return null as never;
        if (firstResult === 'register_failed') return { status: 'register_failed' };
        if (firstResult === 'version_null') return { status: 'pulled', version: null };
        return { status: 'pulled', version: 2 };
      },
    });
    Object.assign(deps, {
      scheduler: retry.scheduler,
      random: () => 1,
    });
    const pull = createProactiveContentPull(deps);

    await pull.handleContentChanged(baseEvent);

    expect(deps.pullCalls).toEqual(['proj-1']);
    expect(retry.delays).toEqual([1_000]);
    expect([...retry.tasks.values()][0]?.handle.unref).toHaveBeenCalledTimes(1);

    await retry.runNext();
    await vi.waitFor(() => expect(deps.pullCalls).toEqual(['proj-1', 'proj-1']));
    expect(retry.tasks.size).toBe(0);
  });

  it('keeps backoff for same/older events but wakes immediately for a higher version', async () => {
    const retry = makeRetryScheduler();
    let succeedAtVersion = 4;
    const deps = makeDeps({
      pullSharedProject: async (target) => {
        deps.pullCalls.push(target.projectId);
        if (deps.pullCalls.length < succeedAtVersion) throw new Error('still down');
        return { status: 'pulled', version: 2 };
      },
    });
    Object.assign(deps, {
      scheduler: retry.scheduler,
      random: () => 1,
    });
    const pull = createProactiveContentPull(deps);

    await pull.handleContentChanged({ ...baseEvent, version: 1 });
    await retry.runNext();
    expect(retry.delays).toEqual([1_000, 2_000]);
    expect(deps.pullCalls).toHaveLength(2);

    await pull.handleContentChanged({ ...baseEvent, version: 1 });
    await pull.handleContentChanged({ ...baseEvent, version: 0 });
    expect(deps.pullCalls).toHaveLength(2);
    expect(retry.delays).toEqual([1_000, 2_000]);

    succeedAtVersion = 3;
    await pull.handleContentChanged({ ...baseEvent, version: 2 });
    expect(deps.pullCalls).toHaveLength(3);
    expect(retry.cleared).toHaveLength(1);
    expect(retry.tasks.size).toBe(0);
  });

  it('caps equal-jitter retry backoff at 30 seconds', async () => {
    const retry = makeRetryScheduler();
    const deps = makeDeps({
      pullSharedProject: async (target) => {
        deps.pullCalls.push(target.projectId);
        throw new Error('still down');
      },
    });
    Object.assign(deps, {
      scheduler: retry.scheduler,
      random: () => 1,
    });
    const pull = createProactiveContentPull(deps);

    await pull.handleContentChanged(baseEvent);
    for (let index = 0; index < 7; index += 1) {
      await retry.runNext();
    }

    expect(retry.delays).toEqual([
      1_000,
      2_000,
      4_000,
      8_000,
      16_000,
      30_000,
      30_000,
      30_000,
    ]);
  });

  it('runs different projects independently while one transport is blocked', async () => {
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const deps = makeDeps({
      pullSharedProject: async (target) => {
        deps.pullCalls.push(target.projectId);
        if (target.projectId === 'proj-1') await firstGate;
        return { status: 'pulled', version: 3 };
      },
    });
    const pull = createProactiveContentPull(deps);

    const first = pull.handleContentChanged(baseEvent);
    await vi.waitFor(() => expect(deps.pullCalls).toEqual(['proj-1']));
    await pull.handleContentChanged({ ...baseEvent, projectId: 'proj-2' });

    expect(deps.pullCalls).toEqual(['proj-1', 'proj-2']);
    releaseFirst();
    await first;
  });

  it.each([
    ['workspace scope changes', 'scope'],
    ['binding becomes personal', 'personal'],
    ['viewer becomes the owner', 'self-owner'],
    ['resource owner changes', 'owner-drift'],
  ] as const)('stops retries when %s', async (_label, change) => {
    const retry = makeRetryScheduler();
    let workspaceId = 'ws-1';
    let visibility: 'personal' | 'team' = 'team';
    let owner = 'wm-owner';
    const deps = makeDeps({
      getLocalBinding: () => ({ workspaceId: 'ws-1', visibility }),
      getWorkspaceIdentity: async () => ({
        workspaceId,
        resourceTeamId: `team-${workspaceId}`,
        workspaceMemberId: 'wm-member',
      }),
      resolveSharedProjectOwner: async () => owner,
      pullSharedProject: async (target) => {
        deps.pullCalls.push(target.projectId);
        throw new Error('retry me');
      },
    });
    Object.assign(deps, {
      scheduler: retry.scheduler,
      random: () => 1,
    });
    const pull = createProactiveContentPull(deps);

    await pull.handleContentChanged(baseEvent);
    if (change === 'scope') workspaceId = 'ws-other';
    if (change === 'personal') visibility = 'personal';
    if (change === 'self-owner') owner = 'wm-member';
    if (change === 'owner-drift') owner = 'wm-new-owner';
    await retry.runNext();

    expect(deps.pullCalls).toEqual(['proj-1']);
    expect(retry.tasks.size).toBe(0);
  });

  it('stops retrying after the resource is revoked', async () => {
    const retry = makeRetryScheduler();
    let attempt = 0;
    const deps = makeDeps({
      pullSharedProject: async (target) => {
        deps.pullCalls.push(target.projectId);
        attempt += 1;
        if (attempt === 1) throw new Error('retry me');
        return { status: 'revoked' };
      },
    });
    Object.assign(deps, {
      scheduler: retry.scheduler,
      random: () => 1,
    });
    const pull = createProactiveContentPull(deps);

    await pull.handleContentChanged(baseEvent);
    await retry.runNext();

    expect(deps.pullCalls).toEqual(['proj-1', 'proj-1']);
    expect(retry.tasks.size).toBe(0);
  });

  it('dispose cancels pending retry timers', async () => {
    const retry = makeRetryScheduler();
    const deps = makeDeps({
      pullSharedProject: async (target) => {
        deps.pullCalls.push(target.projectId);
        throw new Error('retry me');
      },
    });
    Object.assign(deps, {
      scheduler: retry.scheduler,
      random: () => 1,
    });
    const pull = createProactiveContentPull(deps);

    await pull.handleContentChanged(baseEvent);
    (pull as ProactiveContentPull & { dispose(): void }).dispose();

    expect(retry.cleared).toHaveLength(1);
    expect(retry.tasks.size).toBe(0);
    expect(deps.pullCalls).toEqual(['proj-1']);
  });

  it('does not treat a manifest appearing before retry as proof of the desired version', async () => {
    const retry = makeRetryScheduler();
    let materialized = false;
    let attempt = 0;
    const deps = makeDeps({
      getLocalBinding: () => null,
      pullSharedProject: async (target) => {
        deps.pullCalls.push(target.projectId);
        attempt += 1;
        if (attempt === 1) throw new Error('retry me');
        return { status: 'pulled', version: 3 };
      },
      listSharedProjects: async () => [
        { projectId: 'proj-1', ownerMemberId: 'wm-owner' },
      ],
      hasMaterializedProject: () => materialized,
      publishedHead: async () => 3,
    });
    Object.assign(deps, {
      scheduler: retry.scheduler,
      random: () => 1,
    });
    const pull = createProactiveContentPull(deps);

    await pull.materializeMissingProjects('ws-1');
    materialized = true;
    await retry.runNext();

    expect(deps.pullCalls).toEqual(['proj-1', 'proj-1']);
    expect(retry.tasks.size).toBe(0);
  });

  it('serializes different scopes for one project and re-guards after waiting', async () => {
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let activeWorkspaceId = 'ws-1';
    let identityReads = 0;
    let active = 0;
    let maxActive = 0;
    const scopes: string[] = [];
    const deps = makeDeps({
      getLocalBinding: () => null,
      getWorkspaceIdentity: async () => {
        identityReads += 1;
        return {
          workspaceId: activeWorkspaceId,
          resourceTeamId: `team-${activeWorkspaceId}`,
          workspaceMemberId: 'wm-member',
        };
      },
      pullSharedProject: async (target) => {
        scopes.push(target.workspaceId);
        active += 1;
        maxActive = Math.max(maxActive, active);
        try {
          if (target.workspaceId === 'ws-1') await firstGate;
          return { status: 'pulled', version: 1 };
        } finally {
          active -= 1;
        }
      },
    });
    const pull = createProactiveContentPull(deps);

    const first = pull.handleContentChanged({
      projectId: 'proj-1',
      workspaceId: 'ws-1',
      version: 1,
    });
    await vi.waitFor(() => expect(scopes).toEqual(['ws-1']));
    activeWorkspaceId = 'ws-2';
    const second = pull.handleContentChanged({
      projectId: 'proj-1',
      workspaceId: 'ws-2',
      version: 1,
    });
    await vi.waitFor(() => expect(identityReads).toBe(2));

    expect(scopes).toEqual(['ws-1']);
    expect(maxActive).toBe(1);
    releaseFirst();
    await Promise.all([first, second]);

    expect(scopes).toEqual(['ws-1', 'ws-2']);
    expect(maxActive).toBe(1);
    // The second scope guarded once before waiting, then guarded again after
    // the foreign-scope completion instead of trusting that outcome.
    expect(identityReads).toBe(3);
  });
});
