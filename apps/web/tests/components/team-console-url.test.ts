import { describe, expect, it } from 'vitest';
import { teamConsoleUrl } from '../../src/components/EntryNavRail';

// The context's settings URL carries B's ?workspaceId deep-link param; section
// derivation must land on B's REAL console routes (members live at /team, the
// billing entry is the global wallet) and keep the pinned workspace param.
describe('teamConsoleUrl', () => {
  const base = 'https://web.example/settings?workspaceId=ws-1';

  it('maps sections onto the real console routes, keeping the deep-link param', () => {
    expect(teamConsoleUrl(base, 'members')).toBe('https://web.example/team?workspaceId=ws-1');
    expect(teamConsoleUrl(base, 'dashboard')).toBe(
      'https://web.example/dashboard?workspaceId=ws-1',
    );
    expect(teamConsoleUrl(base, 'settings')).toBe(
      'https://web.example/settings?workspaceId=ws-1',
    );
    expect(teamConsoleUrl(base, 'billing')).toBe('https://web.example/wallet?workspaceId=ws-1');
  });

  // "Upgrade" must land ON a subscription dialog, not on a billing page where
  // the user has to hunt for it. B gates the FIRST-checkout dialog and the
  // change-PLAN dialog on mutually exclusive subscription states
  // (team-dashboard.tsx: `canUpgradeTeam` needs billingState in
  // free/inactive/locked, `ownerBillingActionsAvailable` needs 'active') — so
  // the caller's `hasActivePlan` picks which one actually matches. Default
  // (no options / `hasActivePlan: false`) keeps the never-subscribed-yet
  // behavior so existing callers that have not been taught about the split
  // keep landing on the FIRST-checkout dialog, same as before this test grew
  // the `hasActivePlan` branch.
  it('deep-links upgrade straight into the first-checkout dialog when the team has never subscribed', () => {
    expect(teamConsoleUrl(base, 'upgrade')).toBe(
      'https://web.example/dashboard?workspaceId=ws-1&billing=checkout',
    );
    expect(teamConsoleUrl(base, 'upgrade', { hasActivePlan: false })).toBe(
      'https://web.example/dashboard?workspaceId=ws-1&billing=checkout',
    );
  });

  // recvpYEiH019cD / recvpSQKna0LwR: `billing=checkout` silently opens no
  // dialog for a team that already has an active plan (confirmed live —
  // an already-subscribed "Team Pro" workspace landed on the bare Overview
  // page). `billing=plan` is B's change-plan deep link for that state.
  it('deep-links upgrade into the change-plan dialog when the team already has an active plan', () => {
    expect(teamConsoleUrl(base, 'upgrade', { hasActivePlan: true })).toBe(
      'https://web.example/dashboard?workspaceId=ws-1&billing=plan',
    );
  });

  // recvq725Kx0rM4 / recvqfXzHtY5wg: B's create-workspace dialog opens from a
  // `?workspace=create` deep link (vela `sidebar-actions.tsx`, PR #905 /
  // commit 501c0069, live on the `feat/workspace-team` branch the
  // feature-test deployment serves). A prior fix removed this param on the
  // premise that B's route source had no handler for it — true of the repo
  // checkout that fix read at the time, but stale once B shipped the handler.
  it('deep-links create-team into the create-workspace dialog', () => {
    expect(teamConsoleUrl(base, 'create-team')).toBe(
      'https://web.example/dashboard?workspaceId=ws-1&workspace=create',
    );
  });

  it('falls back to the raw URL when it cannot be parsed', () => {
    expect(teamConsoleUrl('not-a-url', 'members')).toBe('not-a-url');
  });
});
