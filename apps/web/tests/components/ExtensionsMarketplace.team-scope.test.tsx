// @vitest-environment jsdom

// Regression for the workspace-team P0 (飞书 rec recvq3NXctqR6L): the 团队
// resource scope disappeared from the 扩展 marketplace for a genuine team
// workspace that happens to be on a free/unpaid tier.
//
// The 团队 pill had been gated on `hasTeamPlan` (a BILLING check). A team on a
// free tier reports `billingState: 'free'`, `planId: null`, and an empty
// `membershipTier`, so the plan gate hid the scope — even though the workspace
// is a real team with a shared resource plane the daemon serves and shares from
// regardless of plan. The gate now matches the daemon: team IDENTITY, via
// `workspaceContextHasTeamIdentity`.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/react';

import { ExtensionsMarketplace } from '../../src/components/PluginsView';
import { I18nProvider } from '../../src/i18n';

vi.mock('../../src/analytics/provider', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/analytics/provider')>();
  return { ...actual, useAnalytics: () => ({ track: vi.fn() }) };
});

// A real team workspace on a FREE tier: workspaceType 'team' with ids present,
// but billingState 'free' / planId null / empty membershipTier — the exact
// shape the daemon returns for the feature-test team.
const FREE_TEAM_CONTEXT = {
  workspaceId: 'ws-team',
  workspaceType: 'team',
  workspaceMemberId: 'mem-1',
  role: 'owner',
  memberStatus: 'active',
  lifecycleState: 'active',
  billingState: 'free',
  planId: null,
  teamId: 'ws-team',
};

const PERSONAL_CONTEXT = {
  workspaceId: 'ws-personal',
  workspaceType: 'personal',
  workspaceMemberId: 'mem-1',
  role: 'owner',
  memberStatus: 'active',
  lifecycleState: 'active',
  billingState: 'free',
  planId: null,
};

let workspaceContext: unknown = FREE_TEAM_CONTEXT;

vi.mock('../../src/collab/useWorkspaceContext', () => ({
  useWorkspaceContext: () => ({ context: workspaceContext, loading: false, refresh: vi.fn() }),
  // Deliberately reports no paid plan — the fix must NOT consult this to decide
  // whether the team scope is offered.
  useWorkspaceBilling: () => ({ membershipTier: '' }),
}));

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(() => {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url === '/api/skills') return jsonResponse({ skills: [] });
    if (url.startsWith('/api/plugins')) return jsonResponse({ plugins: [] });
    if (url.startsWith('/api/marketplaces')) return jsonResponse({ marketplaces: [] });
    if (url.includes('/api/workspace/')) return jsonResponse({ ids: [], resources: [] });
    return jsonResponse({});
  }) as typeof fetch;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  workspaceContext = FREE_TEAM_CONTEXT;
});

function renderMarketplace() {
  return render(
    <I18nProvider initial="en">
      <ExtensionsMarketplace onCreatePlugin={vi.fn()} onUsePlugin={vi.fn()} />
    </I18nProvider>,
  );
}

/** The scope pills (官方 / 团队 / 个人的) live in the source-filter row. */
function scopeLabels(container: HTMLElement): string[] {
  return [...container.querySelectorAll('.plugin-marketplace__filters button')].map(
    (button) => (button.textContent ?? '').trim(),
  );
}

describe('ExtensionsMarketplace 团队 scope visibility', () => {
  it('offers the Team scope for a real team workspace even on a free tier', async () => {
    const { container } = renderMarketplace();
    await waitFor(() => {
      expect(container.querySelector('.plugin-marketplace__filters')).toBeTruthy();
    });
    expect(scopeLabels(container)).toContain('Team');
  });

  it('does not offer the Team scope for a personal workspace', async () => {
    workspaceContext = PERSONAL_CONTEXT;
    const { container } = renderMarketplace();
    await waitFor(() => {
      expect(container.querySelector('.plugin-marketplace__filters')).toBeTruthy();
    });
    expect(scopeLabels(container)).not.toContain('Team');
  });

  it('does not offer the Team scope when signed out (no workspace context)', async () => {
    workspaceContext = null;
    const { container } = renderMarketplace();
    await waitFor(() => {
      expect(container.querySelector('.plugin-marketplace__filters')).toBeTruthy();
    });
    expect(scopeLabels(container)).not.toContain('Team');
  });
});
