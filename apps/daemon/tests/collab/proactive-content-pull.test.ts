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
// (the owner's local copy is the single writer), must skip projects never
// materialized locally, must dedupe repeated/racing events, and must degrade
// silently on failure so the web polling fallback stays authoritative.

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
      workspaceMemberId: 'wm-member',
    }),
    resolveSharedProjectOwner: async () => 'wm-owner',
    pullSharedProject: async (projectId: string) => {
      pullCalls.push(projectId);
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

  it('skips a project this daemon never bound locally (no workspace_projects row)', async () => {
    const deps = makeDeps({ getLocalBinding: () => null });
    const pull = createProactiveContentPull(deps);
    await pull.handleContentChanged(baseEvent);
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
    deps.pullSharedProject = async (projectId: string) => {
      deps.pullCalls.push(projectId);
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
      pullSharedProject: async (projectId: string) => {
        deps.pullCalls.push(projectId);
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
      pullSharedProject: async (projectId: string) => {
        deps.pullCalls.push(projectId);
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
      pullSharedProject: async (projectId: string) => {
        deps.pullCalls.push(projectId);
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
    let revoked = true;
    const deps = makeDeps({
      pullSharedProject: async (projectId: string) => {
        deps.pullCalls.push(projectId);
        return revoked ? { status: 'revoked' } : { status: 'pulled', version: 3 };
      },
    });
    const pull = createProactiveContentPull(deps);

    await pull.handleContentChanged(baseEvent);
    // A later re-share of the same head must be able to pull again.
    revoked = false;
    await pull.handleContentChanged(baseEvent);
    expect(deps.pullCalls).toEqual(['proj-1', 'proj-1']);
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
});
