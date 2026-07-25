import { describe, expect, it, vi } from 'vitest';
import {
  createProactiveContentPull,
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

  it('runs one trailing pull when a newer head arrives while a pull is in flight', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let call = 0;
    const deps = makeDeps({
      pullSharedProject: async (target) => {
        deps.pullCalls.push(target.projectId);
        call += 1;
        if (call === 1) {
          await gate;
          return { status: 'pulled', version: 3 };
        }
        return { status: 'pulled', version: 4 };
      },
    });
    const pull = createProactiveContentPull(deps);

    const first = pull.handleContentChanged({ ...baseEvent, version: 3 });
    const second = pull.handleContentChanged({ ...baseEvent, version: 4 });
    release();
    await Promise.all([first, second]);

    // The v4 event waited out the v3 pull, saw the cursor still behind, and
    // pulled once more — exactly one trailing pull, not a loop.
    expect(deps.pullCalls).toEqual(['proj-1', 'proj-1']);
  });

  it('degrades silently on pull failure and leaves the cursor behind so a retry is allowed', async () => {
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
    const pull = createProactiveContentPull(deps);

    await expect(pull.handleContentChanged(baseEvent)).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledTimes(1);

    // Cursor did not advance on failure: the same-version event retries.
    fail = false;
    await pull.handleContentChanged(baseEvent);
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
