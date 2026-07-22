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
      'https://web.example/dashboard?workspaceId=ws-1&billing=checkout',
    );
  });

  // recvq725Kx0rM4: this used to assert a `workspace=create` deep-link param
  // on the premise that B's dashboard honors it — checked against B's real
  // route source and it does not; the dialog only opens from a sidebar button
  // click (pure client state, no URL hook). The stale param made the entry
  // look broken (dashboard loads, nothing opens) rather than just "you land
  // on the dashboard, not the dialog". No dead param until B exposes a real
  // deep-link to replace this with.
  it('lands create-team on the plain dashboard, with no dead deep-link param', () => {
    expect(teamConsoleUrl(base, 'create-team')).toBe(
      'https://web.example/dashboard?workspaceId=ws-1',
    );
  });

  it('falls back to the raw URL when it cannot be parsed', () => {
    expect(teamConsoleUrl('not-a-url', 'members')).toBe('not-a-url');
  });
});
