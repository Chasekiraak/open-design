import { describe, expect, it } from 'vitest';
import type { WorkspaceBillingSummary, WorkspaceCollabContext } from '@open-design/contracts';

import { hasTeamPlan, isTeamPlanTier } from '../src/collab/team-plan';

function context(planId: string | null, workspaceType: 'team' | 'personal' = 'personal') {
  return { workspaceId: 'ws', workspaceType, planId } as unknown as WorkspaceCollabContext;
}

function billing(membershipTier: string) {
  return { membershipTier } as unknown as WorkspaceBillingSummary;
}

describe('isTeamPlanTier', () => {
  it('recognises B’s team-namespaced plan ids', () => {
    for (const id of ['team', 'team_basic', 'team_plus', 'team_pro', 'team_max', 'TEAM_PLUS']) {
      expect(isTeamPlanTier(id)).toBe(true);
    }
  });

  it('rejects personal tiers and empties', () => {
    for (const id of ['free', 'pro', 'plus', 'max', '', null, undefined]) {
      expect(isTeamPlanTier(id)).toBe(false);
    }
  });
});

describe('hasTeamPlan', () => {
  // The tab used to be gated on `workspaceContext.teamId`, which hid it from a
  // personal workspace — but a personal workspace is still a workspace and can
  // still have members. The plan is the axis that actually decides.
  it('offers team surfaces on a personal workspace that holds a team plan', () => {
    expect(hasTeamPlan(context('team_plus'), null)).toBe(true);
  });

  it('hides them when signed out', () => {
    expect(hasTeamPlan(null, billing('team_plus'))).toBe(false);
  });

  it('hides them on a personal or free plan', () => {
    expect(hasTeamPlan(context('free'), billing('free'))).toBe(false);
    expect(hasTeamPlan(context('pro'), billing('pro'))).toBe(false);
  });

  it('falls back to the context plan hint while billing is empty', () => {
    // Billing reports an empty tier for a workspace with no active subscription,
    // so the context's own id has to stand in rather than reading as "no team".
    expect(hasTeamPlan(context('team_max'), billing(''))).toBe(true);
  });

  it('prefers billing once it reports a team tier', () => {
    expect(hasTeamPlan(context(null), billing('team_pro'))).toBe(true);
  });
});
