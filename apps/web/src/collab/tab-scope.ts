import type { WorkspaceCollabContext } from '@open-design/contracts';

/**
 * The slice of `VelaLoginStatus` (see `providers/daemon.ts`) this module
 * actually reads. A narrow structural type instead of importing the real one
 * keeps this pure-derivation module decoupled from the web app's daemon HTTP
 * client — it only needs to agree on shape, not take a dependency on it.
 */
export interface TabScopeLoginStatus {
  loggedIn: boolean;
  /** vela CLI environment profile (e.g. "default", "prod") — NOT the signed-in
   *  account. Only used as a last-resort account bucket for a `loggedIn: true`
   *  session with no `user` object at all (see below). */
  profile: string;
  user: { id?: string; email?: string } | null;
}

/** Seed value for `previousAccountBucket` on the very first call — distinct
 *  from any real account bucket (`'anon'`, an account id, or `profile:...`)
 *  so the first resolution is never mistaken for an account change. */
export const UNSET_ACCOUNT_BUCKET = '__unset__';

export interface TabIdentityScopeInputs {
  /** App.tsx's merged AMR login status, or `null` before the first read
   *  completes. */
  amrLoginStatus: TabScopeLoginStatus | null;
  /** The shell's current workspace context, or `null` when signed out /
   *  offline / B unavailable (the three are indistinguishable at this read —
   *  see `nextWorkspaceBucket` below for how that ambiguity is handled). */
  workspaceContext: Pick<WorkspaceCollabContext, 'workspaceId'> | null;
  /** Whatever `nextWorkspaceBucket` a PRIOR call to this function returned —
   *  the caller is expected to hold it in a ref and feed it back in, turn by
   *  turn, so the "latch across a null read" behavior below works. Seed with
   *  `'none'` on first call. */
  previousWorkspaceBucket: string;
  /** Whatever `nextAccountBucket` a PRIOR call to this function returned.
   *  Seed with {@link UNSET_ACCOUNT_BUCKET} on first call — see
   *  `nextWorkspaceBucket`'s doc for why the workspace latch must not survive
   *  an account change. */
  previousAccountBucket: string;
}

export interface TabIdentityScopeResult {
  /**
   * Stable "account + active workspace" identity key for tab scoping, or
   * `null` while `amrLoginStatus` has not resolved yet (the caller should
   * treat `null` as "don't judge yet", not as its own scope).
   */
  scopeKey: string | null;
  /** Feed this back in as `previousWorkspaceBucket` on the next call. */
  nextWorkspaceBucket: string;
  /** Feed this back in as `previousAccountBucket` on the next call. */
  nextAccountBucket: string;
}

/**
 * Derive the tab-scope identity key described in WorkspaceTabsBar's
 * `identityScopeKey` prop doc: `${account}::${workspace}`.
 *
 * `account` is `'anon'` while signed out of AMR/vela, otherwise the account's
 * stable id (falling back to email, then to the CLI profile name for the rare
 * env-injected session that carries no `user` object at all — see
 * `readVelaLoginStatus`'s `user: null` branch in the daemon).
 *
 * `workspace` is `'none'` while signed out (a workspace scope never applies
 * then) or not yet resolved; otherwise the LAST CONFIDENTLY resolved
 * `workspaceId`, LATCHED across a null `workspaceContext` rather than reset by
 * it. `workspaceContext` reads back null on a transient B/network hiccup too
 * — its own doc says "null when signed out / offline / B unavailable",
 * bundling all three — so collapsing straight to `'none'` there would make a
 * passing network blip look exactly like a real workspace change and wipe the
 * user's open tabs for no reason. Latching means the bucket only ever moves
 * when a fresh, confident `workspaceContext` says so.
 *
 * The latch is dropped (forced back to `'none'` before applying the rule
 * above) whenever the ACCOUNT bucket itself just changed — on a sign-out
 * (nothing should carry over to signed-out) and equally on a direct account
 * swap (signing in as a different account while nominally still "logged in"
 * the whole time, so there is no intervening `'anon'` step to reset it). Without
 * this, a fresh account's very first read — while its own `workspaceContext`
 * has not resolved yet — could inherit the PREVIOUS account's latched
 * workspace id. That particular leak was still harmless for the tab reset
 * itself (the account half of the key already differs, so a reset fires
 * regardless), but it produced a nonsensical persisted key like
 * `new-user::old-users-workspace-id` — confusing to debug and a correctness
 * smell in the one string whose entire job is to be a legible identity
 * fingerprint. Caught live while exercising an account-swap scenario in
 * manual verification, not from a design walkthrough alone.
 */
export function deriveTabIdentityScope(
  inputs: TabIdentityScopeInputs,
): TabIdentityScopeResult {
  const { amrLoginStatus, workspaceContext, previousWorkspaceBucket, previousAccountBucket } = inputs;

  if (amrLoginStatus === null) {
    return {
      scopeKey: null,
      nextWorkspaceBucket: previousWorkspaceBucket,
      nextAccountBucket: previousAccountBucket,
    };
  }

  const accountBucket = amrLoginStatus.loggedIn
    ? amrLoginStatus.user?.id?.trim()
      || amrLoginStatus.user?.email?.trim()
      || `profile:${amrLoginStatus.profile}`
    : 'anon';
  const accountChanged = accountBucket !== previousAccountBucket;

  const nextWorkspaceBucket =
    !amrLoginStatus.loggedIn
      ? 'none'
      : workspaceContext
        ? workspaceContext.workspaceId
        : accountChanged
          ? 'none'
          : previousWorkspaceBucket;

  return {
    scopeKey: `${accountBucket}::${nextWorkspaceBucket}`,
    nextWorkspaceBucket,
    nextAccountBucket: accountBucket,
  };
}
