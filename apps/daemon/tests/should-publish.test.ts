import { describe, expect, it, vi } from 'vitest';
import { createShouldPublish } from '../src/collab/should-publish.js';
import type { ResourceHubPrincipal } from '../src/collab/resource-principal.js';
import type { WorkspaceContextProvider } from '../src/collab/workspace-context.js';

function providerReturning(
  context: Record<string, unknown> | null,
): WorkspaceContextProvider {
  return { current: () => Promise.resolve(context as never) };
}

const ACTIVE_OWNER_CONTEXT = {
  workspaceType: 'team',
  workspaceId: 't1',
  workspaceMemberId: 'owner-1',
  memberStatus: 'active',
};

describe('createShouldPublish', () => {
  it('watches an owned, team-shared project when the owner is an active member', async () => {
    const rememberTeamShare = vi.fn();
    const shouldPublish = createShouldPublish({
      resolveSharedProjectOwner: async () => 'owner-1',
      workspaceContext: providerReturning(ACTIVE_OWNER_CONTEXT),
      rememberTeamShare,
    });

    expect(await shouldPublish('p1')).toBe(true);
    expect(rememberTeamShare).toHaveBeenCalledTimes(1);
    const [projectId, principal] = rememberTeamShare.mock.calls[0] as [string, ResourceHubPrincipal];
    expect(projectId).toBe('p1');
    expect(principal.memberId).toBe('owner-1');
  });

  it('refuses to watch once the owner has been removed from the team, even though identity fields still resolve', async () => {
    // Mirrors what B actually returns for a removed member: workspaceType /
    // workspaceId / workspaceMemberId all keep resolving to the SAME team and
    // the SAME member id — only memberStatus flips to 'removed'. Without the
    // explicit check this predicate would still find the owner match and
    // return true.
    const rememberTeamShare = vi.fn();
    const shouldPublish = createShouldPublish({
      resolveSharedProjectOwner: async () => 'owner-1',
      workspaceContext: providerReturning({ ...ACTIVE_OWNER_CONTEXT, memberStatus: 'removed' }),
      rememberTeamShare,
    });

    expect(await shouldPublish('p1')).toBe(false);
    expect(rememberTeamShare).not.toHaveBeenCalled();
  });

  it('refuses when the project has no shared-project owner at all', async () => {
    const shouldPublish = createShouldPublish({
      resolveSharedProjectOwner: async () => null,
      workspaceContext: providerReturning(ACTIVE_OWNER_CONTEXT),
      rememberTeamShare: vi.fn(),
    });

    expect(await shouldPublish('p1')).toBe(false);
  });

  it('refuses when this daemon is not the project owner (a member’s read-only pull)', async () => {
    const rememberTeamShare = vi.fn();
    const shouldPublish = createShouldPublish({
      resolveSharedProjectOwner: async () => 'someone-else',
      workspaceContext: providerReturning(ACTIVE_OWNER_CONTEXT),
      rememberTeamShare,
    });

    expect(await shouldPublish('p1')).toBe(false);
    expect(rememberTeamShare).not.toHaveBeenCalled();
  });

  it('refuses when the workspace context cannot be resolved at all (signed out)', async () => {
    const shouldPublish = createShouldPublish({
      resolveSharedProjectOwner: async () => 'owner-1',
      workspaceContext: providerReturning(null),
      rememberTeamShare: vi.fn(),
    });

    expect(await shouldPublish('p1')).toBe(false);
  });
});
