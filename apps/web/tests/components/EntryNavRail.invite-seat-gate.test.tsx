// @vitest-environment jsdom
//
// recvpZAfG5h8eC (P0, Feishu dogfood acceptance table): a Free-tier user could
// send a workspace invite with no seat/plan gate at all — the switcher's own
// 邀请同事 entry point never got the seat-gate props (#115) that
// RecentProjectsStrip's invite entry already had, so the dialog let a
// seat-exhausted workspace submit and fail per-row on B instead of blocking
// up-front with an upgrade path. Fixed by wiring `availableSeats` + `onUpgrade`
// into EntryNavRail's own <InviteDialog> (473728978). This locks the FULL
// path — open the workspace switcher, click 邀请同事, land on InviteDialog —
// rather than only the dialog in isolation (see InviteDialog.seat-gate.test.tsx).

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { WorkspaceCollabContext } from '@open-design/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EntryNavRail, resetWorkspaceDirectoryCache } from '../../src/components/EntryNavRail';
import { I18nProvider } from '../../src/i18n';

const originalFetch = globalThis.fetch;

// A personal ("Free") workspace: one seat, already occupied by its owner — the
// default shape both the dev context stub and B's real billing use for a
// never-upgraded account (see apps/daemon/src/collab/workspace-context.ts).
function freeContext(): WorkspaceCollabContext {
  return {
    workspaceId: 'ws-personal',
    workspaceType: 'personal',
    workspaceMemberId: 'wm-1',
    role: 'owner',
    memberStatus: 'active',
    lifecycleState: 'active',
    billingState: 'free',
    planId: null,
    seatSummary: { seatLimit: 1, usedSeats: 1, availableSeats: 0, isSeatFull: true },
    permissions: { canInviteMembers: true, canViewWorkspaceSettings: true },
    workspaceSettingsUrl: 'https://web.example.com/console/settings?workspaceId=ws-personal',
  } as unknown as WorkspaceCollabContext;
}

function renderRail(context: WorkspaceCollabContext) {
  return render(
    <I18nProvider initial="zh-CN">
      <EntryNavRail
        view="home"
        onViewChange={() => {}}
        onNewProject={() => {}}
        open
        context={context}
        billing={null}
      />
    </I18nProvider>,
  );
}

/** Scope to the open switcher menu (mirrors EntryNavRail.workspace-directory.test.tsx). */
function menu() {
  const el = document.querySelector('.entry-nav-rail__team-menu');
  if (!el) throw new Error('switcher menu is not open');
  return within(el as HTMLElement);
}

beforeEach(() => {
  resetWorkspaceDirectoryCache();
  globalThis.fetch = vi.fn(
    async () => new Response(JSON.stringify({ items: [] }), { status: 200 }),
  ) as typeof fetch;
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  resetWorkspaceDirectoryCache();
  vi.restoreAllMocks();
});

describe('EntryNavRail workspace-switcher invite — seat gate (#115 / recvpZAfG5h8eC)', () => {
  it('blocks a Free/seat-exhausted workspace from sending an invite and offers the upgrade path', () => {
    renderRail(freeContext());

    fireEvent.click(screen.getByTestId('workspace-switcher'));
    fireEvent.click(menu().getByRole('menuitem', { name: /邀请同事/ }));

    const dialog = screen.getByRole('dialog');
    const dialogScope = within(dialog);
    // The exhausted-seat copy replaces the generic body and names the reason.
    expect(
      dialogScope.getByText('当前工作空间的席位已用完，先增加席位后即可邀请同事。'),
    ).toBeTruthy();
    const confirm = dialogScope.getByRole('button', { name: /确认并邀请/ });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);

    // The upgrade CTA opens B's console (teamConsoleUrl(..., 'upgrade')), not a
    // dead end — the user cannot invite, but they always have a next step.
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(null);
    fireEvent.click(dialogScope.getByRole('button', { name: /查看席位与套餐/ }));
    expect(openSpy).toHaveBeenCalledTimes(1);
    const [url] = openSpy.mock.calls[0]!;
    expect(String(url)).toContain('/console/dashboard');
    expect(String(url)).toContain('billing=checkout');
  });
});
