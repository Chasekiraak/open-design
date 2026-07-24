import { useEffect, useRef, useState } from 'react';
import { Icon } from './Icon';
import { useI18n } from '../i18n';
import {
  cancelVelaLogin,
  fetchVelaLoginStatus,
  startVelaLogin,
  type VelaLoginStatus,
} from '../providers/daemon';
import {
  AMR_LOGIN_POLL_INTERVAL_MS,
  amrLoginPollOutcome,
  notifyAmrLoginStatusChanged,
} from './amrLoginPolling';
import {
  notifyTeamProjectsChanged,
  notifyWorkspaceBillingRefresh,
  notifyWorkspaceContextRefresh,
} from '../collab/useWorkspaceContext';

const DISMISSED_KEY = 'od.entry.cloudSignInTip.dismissed';

function readDismissed(): boolean {
  try {
    return window.localStorage.getItem(DISMISSED_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * recvqbkcLqIFH7: a user who ever closed this card (while poking around
 * signed-out, or on a personal/local workspace) had that dismissal persist
 * in localStorage FOREVER — including through a later real sign-in and
 * sign-out. Since this card is the rail's only visible sign-in entry point
 * once `context` goes back to null, that stale flag silently deleted the
 * user's only way back in: the rail footer rendered empty, with no error
 * and no other affordance.
 *
 * A real, deliberate sign-out (the account menu's 退出登录) is exactly the
 * moment the card must be guaranteed to come back, so EntryNavRail calls
 * this right alongside its other post-sign-out notifications. It must NOT
 * be called on every workspace-context refresh — only on an explicit
 * sign-out — or a dismiss made while merely browsing signed-out would keep
 * getting undone by unrelated context polls.
 */
export function resetCloudSignInTipDismissal(): void {
  try {
    window.localStorage.removeItem(DISMISSED_KEY);
  } catch {
    // best-effort persistence
  }
}

type TipState = 'idle' | 'signing' | 'error';

/**
 * recvqgpXSYFNTq: the rail's bottom-left callout slot goes visibly blank
 * between "sign-in just succeeded" and "the workspace context resolved" —
 * `CloudSignInTip` unmounts the instant `finishSignedIn()` fires (see
 * `useWorkspaceContext`'s `markLoading`), but the account row above only
 * appears once `GET /api/workspace/context` answers, which is a real vela
 * round trip and not instantaneous. `EntryShell` renders THIS in the exact
 * same footer slot for that one window (`!workspaceContext && workspaceLoading`)
 * so the callout hands off to a loading state instead of disappearing into
 * nothing. Deliberately inert (no button semantics, no dismiss, no click
 * handler) — this is a status readout, not another affordance to interact
 * with while the real re-read is already in flight.
 */
export function RailAccountSyncTip() {
  const { t } = useI18n();
  return (
    <div
      className="entry-local-mode-tip is-signing"
      role="status"
      aria-live="polite"
      data-testid="entry-rail-account-sync-tip"
    >
      <div className="entry-local-mode-tip__head">
        <span className="entry-local-mode-tip__icon" aria-hidden>
          <Icon name="spinner" size={14} />
        </span>
        <strong>{t('entry.cloudCalloutTitle')}</strong>
      </div>
      <p>{t('common.loading')}</p>
    </div>
  );
}

/**
 * The signed-out rail's bottom callout (#5517 "Open Design Cloud 版" card).
 * The demo's card jumps to a mock sign-in; the product card IS the sign-in:
 * clicking it kicks off the same vela device-auth flow the onboarding/AMR
 * pill uses — pending state with a spinner + cancel + the manual activation
 * link fallback — and on success every workspace surface is nudged to
 * re-read, which swaps the rail to the signed-in form (unmounting the card).
 */
export function CloudSignInTip() {
  const { t } = useI18n();
  const [dismissed, setDismissed] = useState<boolean>(readDismissed);
  const [state, setState] = useState<TipState>('idle');
  const [status, setStatus] = useState<VelaLoginStatus | null>(null);
  const cancelledRef = useRef(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      cancelledRef.current = true;
    };
  }, []);

  async function begin() {
    if (state === 'signing') return;
    cancelledRef.current = false;
    setState('signing');
    setStatus(null);
    const current = await fetchVelaLoginStatus();
    if (cancelledRef.current || !mountedRef.current) return;
    if (current?.loggedIn) {
      finishSignedIn();
      return;
    }
    const result = await startVelaLogin();
    if (cancelledRef.current || !mountedRef.current) return;
    if (!result.ok && !result.alreadyRunning) {
      console.error('[amr-login] startVelaLogin failed', result);
      setState('error');
      return;
    }
    const startedAt = Date.now();
    while (!cancelledRef.current && mountedRef.current) {
      await new Promise((resolve) => window.setTimeout(resolve, AMR_LOGIN_POLL_INTERVAL_MS));
      if (cancelledRef.current || !mountedRef.current) return;
      const next = await fetchVelaLoginStatus();
      if (cancelledRef.current || !mountedRef.current) return;
      if (next) setStatus(next);
      const outcome = amrLoginPollOutcome(next, startedAt);
      if (outcome === 'signed-in') {
        finishSignedIn();
        return;
      }
      if (outcome === 'stopped' || outcome === 'timed-out') {
        // A timed-out attempt's `vela login` child is often still alive (the
        // daemon never self-reported loginInFlight: false) — release it, or
        // the daemon still sees a login in flight and a retry click 409s as
        // alreadyRunning instead of spawning a fresh one, so no new browser
        // tab ever opens. Mirrors AmrLoginPill / InlineModelSwitcher / EntryShell.
        if (outcome === 'timed-out') void cancelVelaLogin();
        console.error('[amr-login] poll did not reach a signed-in status', { outcome, next });
        setState('error');
        return;
      }
    }
  }

  function finishSignedIn() {
    notifyAmrLoginStatusChanged();
    notifyWorkspaceContextRefresh();
    notifyWorkspaceBillingRefresh();
    notifyTeamProjectsChanged();
    if (mountedRef.current) setState('idle');
  }

  async function cancel() {
    cancelledRef.current = true;
    setState('idle');
    setStatus(null);
    await cancelVelaLogin();
    notifyAmrLoginStatusChanged('login-canceled');
  }

  if (dismissed) return null;

  const signing = state === 'signing';

  return (
    <section
      role="button"
      tabIndex={signing ? -1 : 0}
      className={`entry-local-mode-tip${signing ? ' is-signing' : ''}`}
      onClick={() => {
        if (!signing) void begin();
      }}
      onKeyDown={(event) => {
        if (signing) return;
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        void begin();
      }}
      aria-label={t('entry.cloudCalloutTitle')}
      data-testid="entry-cloud-signin-tip"
    >
      <button
        type="button"
        className="entry-local-mode-tip__close"
        onClick={(event) => {
          event.stopPropagation();
          if (signing) void cancel();
          setDismissed(true);
          try {
            window.localStorage.setItem(DISMISSED_KEY, '1');
          } catch {
            // best-effort persistence
          }
        }}
        aria-label={t('entry.cloudCalloutDismissAria')}
      >
        <Icon name="close" size={14} />
      </button>
      <div className="entry-local-mode-tip__head">
        <span className="entry-local-mode-tip__icon" aria-hidden>
          {signing ? <Icon name="spinner" size={14} /> : <Icon name="terminal" size={14} />}
        </span>
        <strong>{t('entry.cloudCalloutTitle')}</strong>
      </div>
      {signing ? (
        <>
          <p>{t('settings.amrSigningIn')}</p>
          {status?.activationUrl ? (
            <div className="amr-login-activation" role="group">
              <span className="amr-login-activation__hint">
                {status.browserOpenFailed
                  ? t('settings.amrActivationBrowserFailed')
                  : t('settings.amrActivationHint')}
              </span>
              <div className="amr-login-activation__actions">
                <a
                  className="amr-login-activation__open"
                  href={status.activationUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(event) => event.stopPropagation()}
                >
                  {t('settings.amrActivationOpen')}
                </a>
              </div>
            </div>
          ) : null}
          <button
            type="button"
            className="entry-local-mode-tip__cancel"
            onClick={(event) => {
              event.stopPropagation();
              void cancel();
            }}
          >
            {t('settings.amrCancelSignIn')}
          </button>
        </>
      ) : state === 'error' ? (
        <p role="alert">{t('settings.amrLoginErrorCompact')}</p>
      ) : (
        <p>{t('entry.cloudCalloutBody')}</p>
      )}
    </section>
  );
}
