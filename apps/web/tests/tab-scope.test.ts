import { describe, expect, it } from 'vitest';

import {
  deriveTabIdentityScope,
  UNSET_ACCOUNT_BUCKET,
  type TabIdentityScopeInputs,
  type TabScopeLoginStatus,
} from '../src/collab/tab-scope';

function loggedOut(profile = 'default'): TabScopeLoginStatus {
  return { loggedIn: false, profile, user: null };
}

function loggedIn(userId: string, profile = 'default'): TabScopeLoginStatus {
  return { loggedIn: true, profile, user: { id: userId, email: `${userId}@example.com` } };
}

/** Thin wrapper defaulting the two "previous" ref fields for tests that don't
 *  care about latch behavior across calls. */
function derive(
  partial: Omit<TabIdentityScopeInputs, 'previousWorkspaceBucket' | 'previousAccountBucket'>
    & Partial<Pick<TabIdentityScopeInputs, 'previousWorkspaceBucket' | 'previousAccountBucket'>>,
) {
  return deriveTabIdentityScope({
    previousWorkspaceBucket: 'none',
    previousAccountBucket: UNSET_ACCOUNT_BUCKET,
    ...partial,
  });
}

describe('deriveTabIdentityScope', () => {
  it('reports scopeKey null while the login status has not resolved yet', () => {
    const result = derive({ amrLoginStatus: null, workspaceContext: null });
    expect(result.scopeKey).toBeNull();
  });

  it('buckets a signed-out session as anon::none regardless of a stale workspace bucket', () => {
    const result = derive({
      amrLoginStatus: loggedOut(),
      workspaceContext: null,
      previousWorkspaceBucket: 'ws-team-a',
    });
    expect(result.scopeKey).toBe('anon::none');
    expect(result.nextWorkspaceBucket).toBe('none');
  });

  it('keys a signed-in session by the account id, not the CLI profile', () => {
    const result = derive({
      amrLoginStatus: loggedIn('user-1', 'prod'),
      workspaceContext: { workspaceId: 'ws-personal-1' },
    });
    expect(result.scopeKey).toBe('user-1::ws-personal-1');
  });

  it('falls back to email, then to a profile-scoped bucket, when no user id is present', () => {
    const byEmail = derive({
      amrLoginStatus: { loggedIn: true, profile: 'default', user: { email: 'a@b.com' } },
      workspaceContext: null,
    });
    expect(byEmail.scopeKey).toBe('a@b.com::none');

    const byProfile = derive({
      // The env-injected runtime-key session: loggedIn with no user object at
      // all (see readVelaLoginStatus's `user: null` branch in the daemon).
      amrLoginStatus: { loggedIn: true, profile: 'prod', user: null },
      workspaceContext: null,
    });
    expect(byProfile.scopeKey).toBe('profile:prod::none');
  });

  it('changes scope when switching from one workspace to another (same account)', () => {
    const teamA = derive({
      amrLoginStatus: loggedIn('user-1'),
      workspaceContext: { workspaceId: 'ws-team-a' },
    });
    expect(teamA.scopeKey).toBe('user-1::ws-team-a');

    const teamB = derive({
      amrLoginStatus: loggedIn('user-1'),
      workspaceContext: { workspaceId: 'ws-team-b' },
      previousWorkspaceBucket: teamA.nextWorkspaceBucket,
      previousAccountBucket: teamA.nextAccountBucket,
    });
    expect(teamB.scopeKey).toBe('user-1::ws-team-b');
  });

  it('latches the last confident workspace id across a null workspaceContext read, same account', () => {
    // Signed in and on team-a, then a transient B/network hiccup reads
    // workspaceContext back as null even though nothing actually changed —
    // see the module doc for why this must NOT collapse to 'none'.
    const settled = derive({
      amrLoginStatus: loggedIn('user-1'),
      workspaceContext: { workspaceId: 'ws-team-a' },
    });
    const duringHiccup = derive({
      amrLoginStatus: loggedIn('user-1'),
      workspaceContext: null,
      previousWorkspaceBucket: settled.nextWorkspaceBucket,
      previousAccountBucket: settled.nextAccountBucket,
    });
    expect(duringHiccup.scopeKey).toBe('user-1::ws-team-a');
    expect(duringHiccup.nextWorkspaceBucket).toBe('ws-team-a');
  });

  it('resets the workspace bucket to none on sign-out even if a workspace was latched', () => {
    const signedOut = derive({
      amrLoginStatus: loggedOut(),
      workspaceContext: null,
      previousWorkspaceBucket: 'ws-team-a',
    });
    expect(signedOut.scopeKey).toBe('anon::none');
    expect(signedOut.nextWorkspaceBucket).toBe('none');
  });

  // recvq-tabscope-e2e: caught live while exercising a direct account swap in
  // manual Playwright verification, not from a design walkthrough alone — see
  // deriveTabIdentityScope's doc for the full story.
  it('drops the workspace latch on a direct account swap (no intervening sign-out)', () => {
    const userTwoOnTeamA = derive({
      amrLoginStatus: loggedIn('user-2'),
      workspaceContext: { workspaceId: 'ws-team-a' },
    });
    expect(userTwoOnTeamA.scopeKey).toBe('user-2::ws-team-a');

    // A different account, still nominally "logged in" the whole time (no
    // 'anon' step in between), whose OWN workspaceContext has not resolved
    // yet. Must NOT inherit user-2's ws-team-a.
    const userThreeFirstRead = derive({
      amrLoginStatus: loggedIn('user-3'),
      workspaceContext: null,
      previousWorkspaceBucket: userTwoOnTeamA.nextWorkspaceBucket,
      previousAccountBucket: userTwoOnTeamA.nextAccountBucket,
    });
    expect(userThreeFirstRead.scopeKey).toBe('user-3::none');
    expect(userThreeFirstRead.nextWorkspaceBucket).toBe('none');
  });

  it('still latches normally once the account is unchanged again after a swap', () => {
    const userThreeFirstRead = derive({
      amrLoginStatus: loggedIn('user-3'),
      workspaceContext: null,
      previousWorkspaceBucket: 'ws-team-a',
      previousAccountBucket: 'user-2',
    });
    const userThreeSettled = derive({
      amrLoginStatus: loggedIn('user-3'),
      workspaceContext: { workspaceId: 'ws-personal-user-3' },
      previousWorkspaceBucket: userThreeFirstRead.nextWorkspaceBucket,
      previousAccountBucket: userThreeFirstRead.nextAccountBucket,
    });
    const userThreeHiccup = derive({
      amrLoginStatus: loggedIn('user-3'),
      workspaceContext: null,
      previousWorkspaceBucket: userThreeSettled.nextWorkspaceBucket,
      previousAccountBucket: userThreeSettled.nextAccountBucket,
    });
    expect(userThreeHiccup.scopeKey).toBe('user-3::ws-personal-user-3');
  });
});
