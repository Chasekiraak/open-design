// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useProjectWorkspaceScope } from '../src/collab/useProjectWorkspaceScope';
import { WORKSPACE_CONTEXT_REFRESH_EVENT } from '../src/collab/useWorkspaceContext';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function teamScope(projectId: string, workspaceId: string, memberId: string) {
  return {
    scope: {
      kind: 'team',
      projectId,
      workspaceId,
      visibility: 'personal',
      context: {
        workspaceId,
        workspaceType: 'team',
        workspaceMemberId: memberId,
        role: 'member',
        memberStatus: 'active',
        lifecycleState: 'active',
        billingState: 'active',
        planId: 'team_pro',
        providerMode: 'platform_credits',
        seatSummary: {
          seatLimit: 5,
          usedSeats: 2,
          availableSeats: 3,
          isSeatFull: false,
        },
        permissions: {
          canManageMembers: false,
          canManageBilling: false,
          canInviteMembers: false,
          canManageAutoRecharge: false,
          canShareProjects: true,
          canWriteSyncedFiles: true,
          canViewWorkspaceSettings: true,
          canManageSharedResources: false,
        },
        teamId: workspaceId,
        teamName: workspaceId,
      },
    },
  };
}

describe('useProjectWorkspaceScope', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('drops a late response from the previously open project', async () => {
    const projectA = deferred<Response>();
    const projectB = deferred<Response>();
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/project-a/')) return projectA.promise;
      if (url.includes('/project-b/')) return projectB.promise;
      throw new Error(`Unexpected fetch: ${url}`);
    }));

    const hook = renderHook(
      ({ projectId }) => useProjectWorkspaceScope(projectId),
      { initialProps: { projectId: 'project-a' } },
    );
    hook.rerender({ projectId: 'project-b' });

    await act(async () => {
      projectB.resolve(new Response(
        JSON.stringify(teamScope('project-b', 'workspace-b', 'member-b')),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ));
    });
    await waitFor(() => {
      expect(hook.result.current.scope).toMatchObject({
        projectId: 'project-b',
        workspaceId: 'workspace-b',
      });
    });

    await act(async () => {
      projectA.resolve(new Response(
        JSON.stringify(teamScope('project-a', 'workspace-a', 'member-a')),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ));
    });
    expect(hook.result.current.scope).toMatchObject({
      projectId: 'project-b',
      workspaceId: 'workspace-b',
    });
  });

  it('does not expose project A scope during the transition frame to project B', async () => {
    const projectB = deferred<Response>();
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/project-a/')) {
        return new Response(
          JSON.stringify(teamScope('project-a', 'workspace-a', 'member-a')),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url.includes('/project-b/')) return projectB.promise;
      throw new Error(`Unexpected fetch: ${url}`);
    }));

    const hook = renderHook(
      ({ projectId }) => useProjectWorkspaceScope(projectId),
      { initialProps: { projectId: 'project-a' } },
    );
    await waitFor(() => {
      expect(hook.result.current.scope).toMatchObject({
        projectId: 'project-a',
        workspaceId: 'workspace-a',
      });
    });

    hook.rerender({ projectId: 'project-b' });
    expect(hook.result.current).toEqual({ loading: true, scope: null });
  });

  it('revalidates the same project when the signed-in workspace member changes', async () => {
    const memberNew = deferred<Response>();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify(teamScope('project-a', 'workspace-a', 'member-old')),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      )
      .mockReturnValueOnce(memberNew.promise);
    vi.stubGlobal('fetch', fetchMock);

    const hook = renderHook(() => useProjectWorkspaceScope('project-a'));
    await waitFor(() => {
      expect(hook.result.current.scope).toMatchObject({
        context: { workspaceMemberId: 'member-old' },
      });
    });

    act(() => {
      window.dispatchEvent(new Event(WORKSPACE_CONTEXT_REFRESH_EVENT));
    });
    expect(hook.result.current).toEqual({ loading: true, scope: null });

    await act(async () => {
      memberNew.resolve(new Response(
        JSON.stringify(teamScope('project-a', 'workspace-a', 'member-new')),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ));
    });
    await waitFor(() => {
      expect(hook.result.current.scope).toMatchObject({
        context: { workspaceMemberId: 'member-new' },
      });
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
