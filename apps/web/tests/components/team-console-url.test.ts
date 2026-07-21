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

  // "Upgrade" must land ON the plan-change dialog, not on a billing page where
  // the user has to hunt for it. B opens that dialog from `billing=checkout`
  // (vela routes/workspace-settings.tsx and routes/team-dashboard.tsx).
  it('deep-links upgrade straight into the plan-change dialog', () => {
    expect(teamConsoleUrl(base, 'upgrade')).toBe(
      'https://web.example/settings?workspaceId=ws-1&billing=checkout',
    );
  });

  // Creating a workspace is a console flow whose dialog hangs off B's sidebar;
  // `workspace=create` (vela components/layout/sidebar-actions.tsx) opens it on
  // arrival so the entry lands on the dialog rather than a page.
  it('deep-links create-team straight into the create dialog', () => {
    expect(teamConsoleUrl(base, 'create-team')).toBe(
      'https://web.example/dashboard?workspaceId=ws-1&workspace=create',
    );
  });

  it('falls back to the raw URL when it cannot be parsed', () => {
    expect(teamConsoleUrl('not-a-url', 'members')).toBe('not-a-url');
  });
});
