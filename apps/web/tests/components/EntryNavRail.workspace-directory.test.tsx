// @vitest-environment jsdom
//
// The workspace switcher re-fetched its list on every open. `coalescedGet`
// only collapses CONCURRENT reads, so each open started from an empty array and
// showed a loading row before the same names reappeared — visible as a flash
// even though nothing had changed.

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { WorkspaceCollabContext } from '@open-design/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EntryNavRail, resetWorkspaceDirectoryCache } from '../../src/components/EntryNavRail';
import { I18nProvider } from '../../src/i18n';

const DIRECTORY = [
  { workspaceId: 'ws-team', workspaceName: 'OD Feature Team', workspaceType: 'team', role: 'owner' },
  { workspaceId: 'ws-personal', workspaceName: 'My Workspace2', workspaceType: 'personal', role: 'owner' },
];

function teamContext(): WorkspaceCollabContext {
  return {
    workspaceId: 'ws-team',
    workspaceType: 'team',
    workspaceMemberId: 'wm-1',
    teamName: 'OD Feature Team',
    role: 'owner',
    memberStatus: 'active',
    lifecycleState: 'active',
    permissions: { canInviteMembers: true, canViewWorkspaceSettings: true },
  } as unknown as WorkspaceCollabContext;
}

const originalFetch = globalThis.fetch;

/** Directory reads resolve only when released, so "before the network answers" is observable. */
function installGatedFetch() {
  const releases: Array<() => void> = [];
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/api/workspace/directory')) {
      await new Promise<void>((resolve) => releases.push(resolve));
      return new Response(JSON.stringify({ items: DIRECTORY }), { status: 200 });
    }
    return new Response(JSON.stringify({}), { status: 200 });
  }) as typeof fetch;
  return {
    releaseAll: () => {
      for (const r of releases.splice(0)) r();
    },
    calls: () => (globalThis.fetch as unknown as { mock: { calls: unknown[] } }).mock.calls.length,
  };
}


/** Scope to the open switcher menu — the active team's name also shows on the trigger. */
function menu() {
  const el = document.querySelector('.entry-nav-rail__team-menu');
  if (!el) throw new Error('switcher menu is not open');
  return within(el as HTMLElement);
}

function renderRail() {
  return render(
    <I18nProvider initial="en">
      <EntryNavRail
        view="home"
        onViewChange={() => {}}
        onNewProject={() => {}}
        open
        onClose={() => {}}
        context={teamContext()}
      />
    </I18nProvider>,
  );
}

beforeEach(() => {
  resetWorkspaceDirectoryCache();
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  resetWorkspaceDirectoryCache();
  vi.restoreAllMocks();
});

describe('workspace switcher directory', () => {
  it('shows the last known list immediately on a later open, with no loading row', async () => {
    const gate = installGatedFetch();
    const view = renderRail();

    // First open: nothing cached, so the loading row is correct.
    fireEvent.click(screen.getByTestId('workspace-switcher'));
    gate.releaseAll();
    await waitFor(() => {
      expect(menu().getByText('OD Feature Team')).toBeTruthy();
    });

    // Close, remount the rail (returning from a project does exactly this),
    // and reopen — the names must be there before the network answers.
    view.unmount();
    renderRail();
    fireEvent.click(screen.getByTestId('workspace-switcher'));

    expect(menu().getByText('My Workspace2')).toBeTruthy();
    expect(menu().queryByRole('status')).toBeNull();

    gate.releaseAll();
  });

  it('keeps the cached names when a revalidation fails', async () => {
    const gate = installGatedFetch();
    renderRail();
    fireEvent.click(screen.getByTestId('workspace-switcher'));
    gate.releaseAll();
    await waitFor(() => {
      expect(menu().getByText('OD Feature Team')).toBeTruthy();
    });

    // A failing revalidation must not blank a list the user is looking at.
    globalThis.fetch = vi.fn(async () => {
      throw new Error('offline');
    }) as typeof fetch;
    cleanup();
    renderRail();
    fireEvent.click(screen.getByTestId('workspace-switcher'));

    await waitFor(() => {
      expect(menu().getByText('OD Feature Team')).toBeTruthy();
    });
  });
});
