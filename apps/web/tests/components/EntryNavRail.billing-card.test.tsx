// @vitest-environment jsdom
//
// Acceptance #146 / #112 — the account menu's billing card.
//
// #146: a workspace the user had just created, with nothing paid for, showed
// 团队版. The label was derived from `workspaceType === 'team'`, but EVERY
// user-created workspace in B is team-typed (only the auto-provisioned personal
// one is not), so the workspace kind says nothing about whether a subscription
// exists. B reports an unsubscribed workspace as `billingState: 'free'` with a
// null planId and an EMPTY membershipTier — the label has to follow that.
//
// #112: the 附加积分 row printed a hardcoded 0 because the summary shape carried
// no bucket for it, even though B splits the wallet into a subscription grant
// bucket and a top-up bucket.

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { WorkspaceBillingSummary, WorkspaceCollabContext } from '@open-design/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EntryNavRail, resetWorkspaceDirectoryCache } from '../../src/components/EntryNavRail';
import { I18nProvider } from '../../src/i18n';

const originalFetch = globalThis.fetch;

function context(overrides: Partial<WorkspaceCollabContext> = {}): WorkspaceCollabContext {
  return {
    workspaceId: 'ws-new',
    workspaceType: 'team',
    workspaceMemberId: 'wm-1',
    teamName: 'Untitled Workspace',
    role: 'owner',
    memberStatus: 'active',
    lifecycleState: 'active',
    // B's entitlement for a workspace nobody has paid for.
    billingState: 'free',
    planId: null,
    permissions: { canInviteMembers: true, canViewWorkspaceSettings: true },
    ...overrides,
  } as unknown as WorkspaceCollabContext;
}

function billing(overrides: Partial<WorkspaceBillingSummary> = {}): WorkspaceBillingSummary {
  return {
    workspaceId: 'ws-new',
    membershipTier: '',
    totalAvailableCredits: 0,
    subscriptionCredits: 0,
    rechargeCredits: 0,
    balanceUsd: '0',
    subscriptionStatus: '',
    availableActions: [],
    ...overrides,
  } as WorkspaceBillingSummary;
}

function renderRail(props: {
  context: WorkspaceCollabContext;
  billing: WorkspaceBillingSummary | null;
}) {
  return render(
    <I18nProvider initial="zh-CN">
      <EntryNavRail
        view="home"
        onViewChange={() => {}}
        onNewProject={() => {}}
        open
        onClose={() => {}}
        context={props.context}
        billing={props.billing}
      />
    </I18nProvider>,
  );
}

/** Open the account menu and scope queries to its billing card. */
function billingCard() {
  fireEvent.click(screen.getByTestId('entry-nav-account'));
  const el = document.querySelector('.entry-nav-rail__menu-credits');
  if (!el) throw new Error('billing card is not rendered');
  return within(el as HTMLElement);
}

beforeEach(() => {
  resetWorkspaceDirectoryCache();
  globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({}), { status: 200 })) as typeof fetch;
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  resetWorkspaceDirectoryCache();
  vi.restoreAllMocks();
});

describe('account menu billing card — plan label (#146)', () => {
  it('does NOT label an unsubscribed team-typed workspace as 团队版', () => {
    renderRail({ context: context(), billing: billing() });

    const card = billingCard();
    expect(card.queryByText('团队版')).toBeNull();
    // `entry.billingTierFree` reads 免费 in zh-CN.
    expect(card.getByText('免费')).toBeTruthy();
  });

  it('labels a workspace that really holds a team subscription as 团队版', () => {
    renderRail({
      context: context({ billingState: 'active', planId: 'team_plus' } as Partial<WorkspaceCollabContext>),
      billing: billing({ membershipTier: 'team_plus', subscriptionStatus: 'active' }),
    });

    expect(billingCard().getByText('团队版')).toBeTruthy();
  });

  // The label is a plan question, so an unknown tier must not be answered from
  // the workspace kind either way — but a paid MEMBER is a case B does not yet
  // report a per-workspace plan for (it sends planId only to owners), so the
  // legacy workspace-type hint is all that is left there. Guard that the
  // POSITIVE free entitlement is what flips the label, not the member case.
  it('keeps the legacy team hint when B has not reported any entitlement', () => {
    renderRail({
      context: context({ role: 'member', billingState: 'active', planId: null } as Partial<WorkspaceCollabContext>),
      billing: billing(),
    });

    expect(billingCard().getByText('团队版')).toBeTruthy();
  });
});

describe('account menu billing card — 附加积分 (#112)', () => {
  it('shows B’s real top-up bucket instead of a hardcoded 0', () => {
    renderRail({
      context: context({ billingState: 'active', planId: 'team_plus' } as Partial<WorkspaceCollabContext>),
      billing: billing({
        membershipTier: 'team_plus',
        totalAvailableCredits: 1_386_294,
        subscriptionCredits: 1_000_000,
        rechargeCredits: 386_294,
      }),
    });

    const card = billingCard();
    const bonusRow = card.getByText('附加积分').closest('.entry-nav-rail__menu-credits-row');
    expect(bonusRow).toBeTruthy();
    expect(within(bonusRow as HTMLElement).getByText('386,294')).toBeTruthy();
  });

  it('shows a real zero top-up bucket as 0', () => {
    renderRail({ context: context(), billing: billing() });

    const card = billingCard();
    const bonusRow = card.getByText('附加积分').closest('.entry-nav-rail__menu-credits-row');
    expect(within(bonusRow as HTMLElement).getByText('0')).toBeTruthy();
  });
});
