// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { WorkspaceCollabContext } from '@open-design/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';

const workspaceState = vi.hoisted(() => ({
  context: null as WorkspaceCollabContext | null,
}));

vi.mock('../../src/collab/useTeamMembers', () => ({
  useTeamMembers: () => ({ resolve: () => null }),
}));

vi.mock('../../src/collab/useWorkspaceContext', () => ({
  notifyTeamProjectsChanged: vi.fn(),
  useWorkspaceBilling: () => null,
  useWorkspaceContext: () => ({ context: workspaceState.context }),
}));

vi.mock('../../src/collab/workspace-events', () => ({
  useWorkspaceInvalidation: vi.fn(),
}));

vi.mock('../../src/providers/registry', () => ({
  fetchProjectFiles: vi.fn(async () => []),
  fetchProjectFileText: vi.fn(async () => null),
  projectFileUrl: (projectId: string, fileName: string) =>
    `/api/projects/${projectId}/files/${fileName}`,
}));

import { RecentProjectsStrip } from '../../src/components/RecentProjectsStrip';

function teamContext(availableSeats: number): WorkspaceCollabContext {
  return {
    workspaceId: 'ws-team',
    workspaceType: 'team',
    workspaceMemberId: 'wm-owner',
    role: 'owner',
    memberStatus: 'active',
    lifecycleState: 'active',
    billingState: 'active',
    planId: 'team_plus',
    seatSummary: {
      seatLimit: 5,
      usedSeats: 5 - availableSeats,
      availableSeats,
      isSeatFull: availableSeats <= 0,
    },
    permissions: {
      canInviteMembers: true,
      canShareProjects: true,
      canManageSharedResources: true,
    },
    teamId: 'team-1',
    workspaceSettingsUrl: 'https://web.example.com/console/settings?workspaceId=ws-team',
  } as unknown as WorkspaceCollabContext;
}

function teamContextWithUnknownSeats(): WorkspaceCollabContext {
  const context = teamContext(3);
  return { ...context, seatSummary: undefined } as unknown as WorkspaceCollabContext;
}

function renderTeamProjects() {
  return render(
    <RecentProjectsStrip
      projects={[]}
      heading="All projects"
      onOpen={() => {}}
      space="team"
    />,
  );
}

afterEach(() => {
  cleanup();
  workspaceState.context = null;
  vi.restoreAllMocks();
});

describe('RecentProjectsStrip invite target (recvqgbyLNk4eE)', () => {
  it('routes a full team directly to Vela seat expansion', () => {
    workspaceState.context = teamContext(0);
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(null);
    renderTeamProjects();

    fireEvent.click(screen.getByRole('button', { name: /Invite teammates|邀请同事/ }));

    expect(openSpy).toHaveBeenCalledTimes(1);
    const [url] = openSpy.mock.calls[0]!;
    expect(String(url)).toContain('/console/dashboard');
    expect(String(url)).toContain('workspaceId=ws-team');
    expect(String(url)).toContain('invite=auto');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('keeps the local invite dialog for a team with available seats', () => {
    workspaceState.context = teamContext(3);
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(null);
    renderTeamProjects();

    fireEvent.click(screen.getByRole('button', { name: /Invite teammates|邀请同事/ }));

    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(openSpy).not.toHaveBeenCalled();
  });

  it('routes an unknown team seat state to Vela instead of a permissive local form', () => {
    workspaceState.context = teamContextWithUnknownSeats();
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(null);
    renderTeamProjects();

    fireEvent.click(screen.getByRole('button', { name: /Invite teammates|邀请同事/ }));

    expect(openSpy).toHaveBeenCalledTimes(1);
    expect(String(openSpy.mock.calls[0]![0])).toContain('invite=auto');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('hides the invite entry when neither local capacity nor a safe Vela URL exists', () => {
    workspaceState.context = {
      ...teamContext(0),
      workspaceSettingsUrl: null,
    } as unknown as WorkspaceCollabContext;
    renderTeamProjects();

    expect(
      screen.queryByRole('button', { name: /Invite teammates|邀请同事/ }),
    ).toBeNull();
  });

  it.each(['owner', 'admin'] as const)(
    'routes a Team %s without direct invite capability through Vela',
    (role) => {
      const context = teamContext(3);
      workspaceState.context = {
        ...context,
        role,
        permissions: { ...context.permissions, canInviteMembers: false },
      } as WorkspaceCollabContext;
      const openSpy = vi.spyOn(window, 'open').mockReturnValue(null);
      renderTeamProjects();

      fireEvent.click(screen.getByRole('button', { name: /Invite teammates|邀请同事/ }));

      expect(openSpy).toHaveBeenCalledTimes(1);
      expect(String(openSpy.mock.calls[0]![0])).toContain('invite=auto');
      expect(screen.queryByRole('dialog')).toBeNull();
    },
  );

  it('does not expose the invite entry to a Team member', () => {
    const context = teamContext(3);
    workspaceState.context = {
      ...context,
      role: 'member',
      permissions: { ...context.permissions, canInviteMembers: false },
    } as WorkspaceCollabContext;
    renderTeamProjects();

    expect(
      screen.queryByRole('button', { name: /Invite teammates|邀请同事/ }),
    ).toBeNull();
  });
});
