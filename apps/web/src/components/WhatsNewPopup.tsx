import { createPortal } from 'react-dom';
import { useCallback, useEffect, useRef, useState } from 'react';

import { Button, Dialog } from '@open-design/components';
import { useI18n } from '../i18n';
import { fetchWhatsNew, openExternalUrl } from '../providers/registry';
import {
  localizedWhatsNewContent,
  markWhatsNewSeen,
  readLastSeenWhatsNewId,
  resolveWhatsNewPrompt,
  whatsNewNotesFromBody,
} from '../lib/whats-new';
import { useAnalytics, useAppVersion } from '../analytics/provider';
import { trackWhatsNewPopupClick, trackWhatsNewPopupSurfaceView } from '../analytics/events';
import styles from './WhatsNewPopup.module.css';

// Post-update highlights dialog, shown once per highlight on the home surface
// after the app comes back on a new version (desktop update or web reload).
//
// Every field is real: cover art, release headline, bullets and link come from
// the hand-curated highlights document via /api/whats-new, and the title states
// the RUNNING app version from /api/version (`useAppVersion`) — never a literal.
// The dialog shows only when that document has content, and at most once per its
// `id` (see ../lib/whats-new).
//
// It reports what already happened, so its only actions are "close" and "open
// the release notes". Applying an update belongs to the real updater indicator
// (see ./UpdaterPopup.tsx) — this surface must never claim to install anything.

// Fallback for the CTA when the highlight document omits an explicit link.
const RELEASES_INDEX_URL = 'https://github.com/nexu-io/open-design/releases';

type CardModel = {
  /** Highlight identity — recorded as "seen" so the dialog shows once per id. */
  id: string;
  /** The release headline from the highlights document; labels the bullets. */
  headline: string;
  /** Release highlights, one row per line of the document's body. */
  notes: string[];
  imageUrl: string | null;
  linkUrl: string;
};

// `active` reports whether Home is the active entry view. EntryShell keeps
// every entry view mounted, so the dialog gates its fetch/show decision and its
// `page_name: 'home'` analytics on this flag instead of on mount alone.
export function WhatsNewPopup({ active }: { active: boolean }) {
  const { t, locale } = useI18n();
  const analytics = useAnalytics();
  const appVersion = useAppVersion();
  const [card, setCard] = useState<CardModel | null>(null);
  const surfaceTrackedRef = useRef(false);
  // Flips only once a decision is actually REACHED, never merely when a fetch
  // starts. A fetch torn down before it resolves — React StrictMode's
  // double-invoke, or the user leaving Home mid-flight — therefore leaves the
  // guard down so the next Home activation retries, instead of the teardown
  // re-arming a start-time guard and permanently swallowing the dialog.
  const decisionMadeRef = useRef(false);

  useEffect(() => {
    if (!active || decisionMadeRef.current) return;
    let cancelled = false;
    void fetchWhatsNew().then((info) => {
      // `cancelled` guards state updates after this effect invocation is torn
      // down; it does NOT re-arm the fetch, so a superseded fetch simply drops
      // and the surviving one records the decision.
      if (cancelled || info == null) return;
      decisionMadeRef.current = true;
      const decision = resolveWhatsNewPrompt(info, readLastSeenWhatsNewId());
      if (decision !== 'show' || info.id == null || info.content == null) return;
      const localized = localizedWhatsNewContent(info.content, locale);
      setCard({
        id: info.id,
        headline: localized.title,
        notes: whatsNewNotesFromBody(localized.body),
        imageUrl: info.content.imageUrl ?? null,
        linkUrl: localized.linkUrl ?? RELEASES_INDEX_URL,
      });
    });
    return () => {
      cancelled = true;
    };
    // The dialog resolves once per Home activation; live locale switches keep
    // the copy it resolved with rather than refetching mid-display.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  useEffect(() => {
    if (!active || card == null || surfaceTrackedRef.current) return;
    surfaceTrackedRef.current = true;
    trackWhatsNewPopupSurfaceView(analytics.track, {
      page_name: 'home',
      area: 'whats_new_popup',
      app_version: appVersion,
      has_release_notes: true,
    });
  }, [active, analytics.track, appVersion, card]);

  // Every close path — the Close button, the backdrop, Escape — spends the
  // once-per-highlight dialog. Unlike the non-modal toast this replaced, a
  // focus-trapping modal cannot receive a stray Escape aimed at other UI, so
  // dismissal is always deliberate here.
  const dismiss = useCallback(() => {
    if (card == null) return;
    markWhatsNewSeen(card.id);
    trackWhatsNewPopupClick(analytics.track, {
      page_name: 'home',
      area: 'whats_new_popup',
      element: 'dismiss',
      action: 'dismiss',
      app_version: appVersion,
    });
    setCard(null);
  }, [analytics.track, appVersion, card]);

  const openLink = useCallback(() => {
    if (card == null) return;
    markWhatsNewSeen(card.id);
    trackWhatsNewPopupClick(analytics.track, {
      page_name: 'home',
      area: 'whats_new_popup',
      element: 'see_whats_new',
      action: 'open_link',
      app_version: appVersion,
    });
    void openExternalUrl(card.linkUrl);
    setCard(null);
  }, [analytics.track, appVersion, card]);

  if (!active || card == null) return null;

  const dialog = (
    <Dialog
      ariaLabelledBy="whats-new-popup-title"
      backdropClassName={styles.backdrop}
      className={styles.panel}
      closeOnEscape
      data-testid="whats-new-popup"
      onClose={dismiss}
    >
      {card.imageUrl != null ? (
        <img alt="" className={styles.cover} data-testid="whats-new-cover" src={card.imageUrl} />
      ) : null}
      <div className={styles.content}>
        <h2 className={styles.title} id="whats-new-popup-title">
          {t('whatsNew.updatedTitle', { version: appVersion })}
        </h2>
        <p className={styles.headline}>{card.headline}</p>
        <ul className={styles.notes}>
          {card.notes.map((note) => (
            <li className={styles.note} data-testid="whats-new-note" key={note}>
              <span aria-hidden className={styles.noteDot} />
              {note}
            </li>
          ))}
        </ul>
      </div>
      <div className={styles.footer}>
        <Button className={styles.close} data-testid="whats-new-dismiss" onClick={dismiss}>
          {t('common.close')}
        </Button>
        <Button
          className={styles.cta}
          data-testid="whats-new-cta"
          variant="primary"
          onClick={openLink}
        >
          {t('whatsNew.cta')}
        </Button>
      </div>
    </Dialog>
  );
  if (typeof document === 'undefined') return dialog;
  return createPortal(dialog, document.body);
}
