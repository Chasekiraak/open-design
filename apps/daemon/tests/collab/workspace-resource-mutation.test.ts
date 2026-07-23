import { describe, expect, it } from 'vitest';
import {
  enforceWorkspaceResourceMutation,
  type WorkspaceResourceAccessInput,
} from '../../src/collab/workspace-resource-mutation.js';

// Cheapest layer that can see the symptom: exercise the shared gate directly
// against fake req/res/db seams, without spinning up an Express server or a
// real SQLite file. `enforceWorkspaceProjectMutation` in
// routes/project/index.ts is now a one-line delegation to this function, and
// `tests/routes/workspace-projects.test.ts` covers the end-to-end HTTP
// behavior for project; this file covers the shared decision logic itself so
// a future resource type (plugin today) can trust it without re-deriving
// project's full HTTP suite.

function fakeReq(headers: Record<string, string> = {}): any {
  return {
    get(name: string) {
      return headers[name] ?? undefined;
    },
  };
}

function fakeRes(): any {
  return {};
}

function spySendApiError() {
  const calls: Array<{ status: number; code: string; message: string }> = [];
  const sendApiError = (_res: unknown, status: number, code: string, message: string) => {
    calls.push({ status, code, message });
  };
  return { calls, sendApiError };
}

function workspaceHeaders(opts: {
  workspaceId?: string;
  memberId?: string;
  role?: string;
  lifecycleState?: string;
  canWriteSyncedFiles?: string;
} = {}): Record<string, string> {
  const headers: Record<string, string> = {};
  if (opts.workspaceId) headers['x-od-workspace-id'] = opts.workspaceId;
  if (opts.memberId) headers['x-od-workspace-member-id'] = opts.memberId;
  if (opts.role) headers['x-od-workspace-role'] = opts.role;
  if (opts.lifecycleState) headers['x-od-workspace-lifecycle-state'] = opts.lifecycleState;
  if (opts.canWriteSyncedFiles) headers['x-od-workspace-can-write-synced-files'] = opts.canWriteSyncedFiles;
  return headers;
}

function makeLookups(rowsByResourceId: Record<string, WorkspaceResourceAccessInput & { workspaceId: string }>) {
  const getWorkspaceResource = (_db: unknown, workspaceId: string, resourceId: string) => {
    const row = rowsByResourceId[resourceId];
    if (!row || row.workspaceId !== workspaceId) return undefined;
    return row;
  };
  const getWorkspaceResourceByResourceId = (_db: unknown, resourceId: string) => rowsByResourceId[resourceId];
  return { getWorkspaceResource, getWorkspaceResourceByResourceId };
}

describe('enforceWorkspaceResourceMutation', () => {
  it('allows a headerless caller against a resource with no team binding', () => {
    const { getWorkspaceResource, getWorkspaceResourceByResourceId } = makeLookups({});
    const { calls, sendApiError } = spySendApiError();
    const allowed = enforceWorkspaceResourceMutation(
      'plugin',
      fakeReq(),
      fakeRes(),
      sendApiError,
      getWorkspaceResource,
      getWorkspaceResourceByResourceId,
      {},
      'plugin-a',
      'delete',
    );
    expect(allowed).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('rejects a headerless caller against a team-visibility resource', () => {
    const { getWorkspaceResource, getWorkspaceResourceByResourceId } = makeLookups({
      'plugin-a': { workspaceId: 'ws-1', visibility: 'team', resourceState: 'active', createdByWorkspaceMemberId: 'member-owner' },
    });
    const { calls, sendApiError } = spySendApiError();
    const allowed = enforceWorkspaceResourceMutation(
      'plugin',
      fakeReq(),
      fakeRes(),
      sendApiError,
      getWorkspaceResource,
      getWorkspaceResourceByResourceId,
      {},
      'plugin-a',
      'delete',
    );
    expect(allowed).toBe(false);
    expect(calls).toEqual([{ status: 401, code: 'WORKSPACE_CONTEXT_REQUIRED', message: 'workspace context is required' }]);
  });

  it('rejects a caller carrying only a partial workspace header pair', () => {
    const { getWorkspaceResource, getWorkspaceResourceByResourceId } = makeLookups({});
    const { calls, sendApiError } = spySendApiError();
    const allowed = enforceWorkspaceResourceMutation(
      'plugin',
      fakeReq({ 'x-od-workspace-id': 'ws-1' }), // no member id
      fakeRes(),
      sendApiError,
      getWorkspaceResource,
      getWorkspaceResourceByResourceId,
      {},
      'plugin-a',
      'delete',
    );
    expect(allowed).toBe(false);
    expect(calls).toEqual([{ status: 401, code: 'WORKSPACE_CONTEXT_REQUIRED', message: 'workspace context is required' }]);
  });

  it('allows the member who created the resource to mutate it', () => {
    const { getWorkspaceResource, getWorkspaceResourceByResourceId } = makeLookups({
      'plugin-a': { workspaceId: 'ws-1', visibility: 'personal', resourceState: 'active', createdByWorkspaceMemberId: 'member-a' },
    });
    const { calls, sendApiError } = spySendApiError();
    const allowed = enforceWorkspaceResourceMutation(
      'plugin',
      fakeReq(workspaceHeaders({ workspaceId: 'ws-1', memberId: 'member-a', role: 'member' })),
      fakeRes(),
      sendApiError,
      getWorkspaceResource,
      getWorkspaceResourceByResourceId,
      {},
      'plugin-a',
      'delete',
    );
    expect(allowed).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('rejects a different, non-privileged member from mutating someone else\'s resource', () => {
    const { getWorkspaceResource, getWorkspaceResourceByResourceId } = makeLookups({
      'plugin-a': { workspaceId: 'ws-1', visibility: 'personal', resourceState: 'active', createdByWorkspaceMemberId: 'member-a' },
    });
    const { calls, sendApiError } = spySendApiError();
    const allowed = enforceWorkspaceResourceMutation(
      'plugin',
      fakeReq(workspaceHeaders({ workspaceId: 'ws-1', memberId: 'member-b', role: 'member' })),
      fakeRes(),
      sendApiError,
      getWorkspaceResource,
      getWorkspaceResourceByResourceId,
      {},
      'plugin-a',
      'delete',
    );
    expect(allowed).toBe(false);
    expect(calls).toEqual([{
      status: 403,
      code: 'WORKSPACE_PLUGIN_PERMISSION_DENIED',
      message: 'workspace plugin mutation is not allowed',
    }]);
  });

  it('allows a privileged owner/admin to mutate a resource they did not create', () => {
    const { getWorkspaceResource, getWorkspaceResourceByResourceId } = makeLookups({
      'plugin-a': { workspaceId: 'ws-1', visibility: 'personal', resourceState: 'active', createdByWorkspaceMemberId: 'member-a' },
    });
    const { calls, sendApiError } = spySendApiError();
    const allowed = enforceWorkspaceResourceMutation(
      'plugin',
      fakeReq(workspaceHeaders({ workspaceId: 'ws-1', memberId: 'member-owner', role: 'owner' })),
      fakeRes(),
      sendApiError,
      getWorkspaceResource,
      getWorkspaceResourceByResourceId,
      {},
      'plugin-a',
      'delete',
    );
    expect(allowed).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('rejects mutation of a resource bound to a different workspace than the caller\'s', () => {
    const { getWorkspaceResource, getWorkspaceResourceByResourceId } = makeLookups({
      'plugin-a': { workspaceId: 'ws-other', visibility: 'personal', resourceState: 'active', createdByWorkspaceMemberId: 'member-a' },
    });
    const { calls, sendApiError } = spySendApiError();
    const allowed = enforceWorkspaceResourceMutation(
      'plugin',
      fakeReq(workspaceHeaders({ workspaceId: 'ws-1', memberId: 'member-a', role: 'owner' })),
      fakeRes(),
      sendApiError,
      getWorkspaceResource,
      getWorkspaceResourceByResourceId,
      {},
      'plugin-a',
      'delete',
    );
    expect(allowed).toBe(false);
    expect(calls).toEqual([{
      status: 403,
      code: 'WORKSPACE_PLUGIN_PERMISSION_DENIED',
      message: 'workspace plugin mutation is not allowed',
    }]);
  });

  it('rejects mutation of a frozen resource even for a privileged caller', () => {
    const { getWorkspaceResource, getWorkspaceResourceByResourceId } = makeLookups({
      'plugin-a': { workspaceId: 'ws-1', visibility: 'team', resourceState: 'frozen', createdByWorkspaceMemberId: 'member-owner' },
    });
    const { calls, sendApiError } = spySendApiError();
    const allowed = enforceWorkspaceResourceMutation(
      'plugin',
      fakeReq(workspaceHeaders({ workspaceId: 'ws-1', memberId: 'member-owner', role: 'owner' })),
      fakeRes(),
      sendApiError,
      getWorkspaceResource,
      getWorkspaceResourceByResourceId,
      {},
      'plugin-a',
      'delete',
    );
    expect(allowed).toBe(false);
    expect(calls).toEqual([{
      status: 403,
      code: 'WORKSPACE_PLUGIN_PERMISSION_DENIED',
      message: 'workspace plugin mutation is not allowed',
    }]);
  });

  // recvqbbQ4yljNC / recvqbeDjAsejl: a member removed from the workspace keeps
  // sending stale "active" workspace headers (its own client hasn't re-polled
  // /api/workspace/context yet) until the daemon cross-checks them against its
  // own last-verified membership state.
  describe('membership cross-check against the daemon\'s own last-known context', () => {
    it('BUG: allows a removed member\'s write when only client headers are consulted', () => {
      // This test pins the CURRENT (vulnerable) behavior: no
      // `getLastKnownMembership` is wired up, so the gate has only the
      // client's own claim to go on — exactly the pre-fix code path.
      const { getWorkspaceResource, getWorkspaceResourceByResourceId } = makeLookups({
        'plugin-a': { workspaceId: 'ws-1', visibility: 'personal', resourceState: 'active', createdByWorkspaceMemberId: 'member-a' },
      });
      const { calls, sendApiError } = spySendApiError();
      const allowed = enforceWorkspaceResourceMutation(
        'plugin',
        fakeReq(workspaceHeaders({ workspaceId: 'ws-1', memberId: 'member-a', role: 'member' })),
        fakeRes(),
        sendApiError,
        getWorkspaceResource,
        getWorkspaceResourceByResourceId,
        {},
        'plugin-a',
        'delete',
      );
      expect(allowed).toBe(true);
      expect(calls).toHaveLength(0);
    });

    it('rejects the write once the daemon\'s own last-known context says the caller was removed', () => {
      const { getWorkspaceResource, getWorkspaceResourceByResourceId } = makeLookups({
        'plugin-a': { workspaceId: 'ws-1', visibility: 'personal', resourceState: 'active', createdByWorkspaceMemberId: 'member-a' },
      });
      const { calls, sendApiError } = spySendApiError();
      // Client headers still say "active" (stale) — the daemon's own cache
      // says this same workspace's caller has been removed.
      const getLastKnownMembership = () => ({ workspaceId: 'ws-1', memberStatus: 'removed' as const });
      const allowed = enforceWorkspaceResourceMutation(
        'plugin',
        fakeReq(workspaceHeaders({ workspaceId: 'ws-1', memberId: 'member-a', role: 'member' })),
        fakeRes(),
        sendApiError,
        getWorkspaceResource,
        getWorkspaceResourceByResourceId,
        {},
        'plugin-a',
        'delete',
        getLastKnownMembership,
      );
      expect(allowed).toBe(false);
      expect(calls).toEqual([{
        status: 403,
        code: 'WORKSPACE_PLUGIN_PERMISSION_DENIED',
        message: 'workspace plugin mutation is not allowed',
      }]);
    });

    it('does not override an already-removed header (redundant agreement)', () => {
      const { getWorkspaceResource, getWorkspaceResourceByResourceId } = makeLookups({
        'plugin-a': { workspaceId: 'ws-1', visibility: 'team', resourceState: 'active', createdByWorkspaceMemberId: 'member-owner' },
      });
      const { calls, sendApiError } = spySendApiError();
      const getLastKnownMembership = () => ({ workspaceId: 'ws-1', memberStatus: 'removed' as const });
      const allowed = enforceWorkspaceResourceMutation(
        'plugin',
        fakeReq({
          ...workspaceHeaders({ workspaceId: 'ws-1', memberId: 'member-owner', role: 'owner' }),
          'x-od-workspace-member-status': 'removed',
        }),
        fakeRes(),
        sendApiError,
        getWorkspaceResource,
        getWorkspaceResourceByResourceId,
        {},
        'plugin-a',
        'delete',
        getLastKnownMembership,
      );
      expect(allowed).toBe(false);
      expect(calls).toEqual([{
        status: 403,
        code: 'WORKSPACE_PLUGIN_PERMISSION_DENIED',
        message: 'workspace plugin mutation is not allowed',
      }]);
    });

    it('trusts the header when the cache has no opinion for this workspace (never queried it)', () => {
      const { getWorkspaceResource, getWorkspaceResourceByResourceId } = makeLookups({
        'plugin-a': { workspaceId: 'ws-1', visibility: 'personal', resourceState: 'active', createdByWorkspaceMemberId: 'member-a' },
      });
      const { calls, sendApiError } = spySendApiError();
      const getLastKnownMembership = () => null;
      const allowed = enforceWorkspaceResourceMutation(
        'plugin',
        fakeReq(workspaceHeaders({ workspaceId: 'ws-1', memberId: 'member-a', role: 'member' })),
        fakeRes(),
        sendApiError,
        getWorkspaceResource,
        getWorkspaceResourceByResourceId,
        {},
        'plugin-a',
        'delete',
        getLastKnownMembership,
      );
      expect(allowed).toBe(true);
      expect(calls).toHaveLength(0);
    });

    it('trusts the header when the cache last resolved a DIFFERENT workspace', () => {
      const { getWorkspaceResource, getWorkspaceResourceByResourceId } = makeLookups({
        'plugin-a': { workspaceId: 'ws-1', visibility: 'personal', resourceState: 'active', createdByWorkspaceMemberId: 'member-a' },
      });
      const { calls, sendApiError } = spySendApiError();
      // Cache holds a real "removed" fact, but for a DIFFERENT workspace than
      // the one this request is scoped to — must not leak across workspaces.
      const getLastKnownMembership = () => ({ workspaceId: 'ws-other', memberStatus: 'removed' as const });
      const allowed = enforceWorkspaceResourceMutation(
        'plugin',
        fakeReq(workspaceHeaders({ workspaceId: 'ws-1', memberId: 'member-a', role: 'member' })),
        fakeRes(),
        sendApiError,
        getWorkspaceResource,
        getWorkspaceResourceByResourceId,
        {},
        'plugin-a',
        'delete',
        getLastKnownMembership,
      );
      expect(allowed).toBe(true);
      expect(calls).toHaveLength(0);
    });
  });

  it('reports WORKSPACE_LOCKED instead of a permission denial when the workspace itself is locked', () => {
    const { getWorkspaceResource, getWorkspaceResourceByResourceId } = makeLookups({
      'plugin-a': { workspaceId: 'ws-1', visibility: 'personal', resourceState: 'active', createdByWorkspaceMemberId: 'member-a' },
    });
    const { calls, sendApiError } = spySendApiError();
    const allowed = enforceWorkspaceResourceMutation(
      'plugin',
      fakeReq(workspaceHeaders({ workspaceId: 'ws-1', memberId: 'member-a', role: 'owner', lifecycleState: 'locked' })),
      fakeRes(),
      sendApiError,
      getWorkspaceResource,
      getWorkspaceResourceByResourceId,
      {},
      'plugin-a',
      'delete',
    );
    expect(allowed).toBe(false);
    expect(calls).toEqual([{
      status: 403,
      code: 'WORKSPACE_LOCKED',
      message: 'workspace plugin mutation is not allowed',
    }]);
  });
});
