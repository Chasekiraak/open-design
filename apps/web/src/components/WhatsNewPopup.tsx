import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { Button, Dialog } from '@open-design/components';
import { useI18n } from '../i18n';
import { fetchWhatsNew, openExternalUrl } from '../providers/registry';
import {
  localizedWhatsNewContent,
  markWhatsNewSeen,
  readLastSeenWhatsNewId,
  resolveWhatsNewPrompt,
} from '../lib/whats-new';
import { useAnalytics } from '../analytics/provider';
import { trackWhatsNewPopupClick, trackWhatsNewPopupSurfaceView } from '../analytics/events';
// The release-dialog visual language (cover card / title / dotted notes /
// pill footer) is shared with UpdateReminderDialog — one style source, two
// content sources. Copy/image/link here stay REAL: the hand-curated
// highlights document served by /api/whats-new.
import styles from './UpdateReminderDialog.module.css';

// Post-update highlights dialog, shown once per highlight on the home surface
// after the app comes back on a new version (desktop update or web reload).
// Copy/image/link come from a hand-curated highlights document via
// /api/whats-new; the dialog shows only when that document has content, and at
// most once per its `id` (see ../lib/whats-new).

// Fallback for the CTA when the highlight document omits an explicit link.
const RELEASES_INDEX_URL = 'https://github.com/nexu-io/open-design/releases';

type CardModel = {
  /** Highlight identity — recorded as "seen" so the card shows once per id. */
  id: string;
  /** Running app version, shown as the "Open Design x.y.z" eyebrow. */
  appVersion: string;
  /** The release headline, rendered as the dialog title. */
  title: string;
  /** Highlight body, one entry per non-empty line — multi-line bodies render
   *  as the dotted notes list, a single line as a plain paragraph. */
  bodyLines: string[];
  imageUrl: string | null;
  linkUrl: string;
};

// `active` reports whether Home is the active entry view. EntryShell keeps
// every entry view mounted, so the card gates its fetch/show decision and its
// `page_name: 'home'` analytics on this flag instead of on mount alone.
export function WhatsNewPopup({ active }: { active: boolean }) {
  const { t, locale } = useI18n();
  const analytics = useAnalytics();
  const [card, setCard] = useState<CardModel | null>(null);
  const surfaceTrackedRef = useRef(false);
  // Flips only once a decision is actually REACHED, never merely when a fetch
  // starts. A fetch torn down before it resolves — React StrictMode's
  // double-invoke, or the user leaving Home mid-flight — therefore leaves the
  // guard down so the next Home activation retries, instead of the teardown
  // re-arming a start-time guard and permanently swallowing the card.
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
        appVersion: info.version,
        title: localized.title,
        bodyLines: localized.body
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean),
        imageUrl: info.content.imageUrl ?? null,
        linkUrl: localized.linkUrl ?? RELEASES_INDEX_URL,
      });
    });
    return () => {
      cancelled = true;
    };
    // The card resolves once per Home activation; live locale switches keep
    // the copy it resolved with rather than refetching mid-display.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  useEffect(() => {
    if (!active || card == null || surfaceTrackedRef.current) return;
    surfaceTrackedRef.current = true;
    trackWhatsNewPopupSurfaceView(analytics.track, {
      page_name: 'home',
      area: 'whats_new_popup',
      app_version: card.appVersion,
      has_release_notes: true,
    });
  }, [active, analytics.track, card]);

  const dismiss = useCallback(() => {
    if (card == null) return;
    markWhatsNewSeen(card.id);
    trackWhatsNewPopupClick(analytics.track, {
      page_name: 'home',
      area: 'whats_new_popup',
      element: 'dismiss',
      action: 'dismiss',
      app_version: card.appVersion,
    });
    setCard(null);
  }, [analytics.track, card]);

  // Escape hides the card without recording the highlight as seen and without
  // the dismiss analytics event: the card is a non-modal toast, so a stray
  // Escape aimed at other UI must not permanently spend the once-per-highlight
  // card. Mark-seen stays reserved for the explicit ✕ button and the CTA.
  useEffect(() => {
    if (!active || card == null) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      setCard(null);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [active, card]);

  const openLink = useCallback(() => {
    if (card == null) return;
    markWhatsNewSeen(card.id);
    trackWhatsNewPopupClick(analytics.track, {
      page_name: 'home',
      area: 'whats_new_popup',
      element: 'see_whats_new',
      action: 'open_link',
      app_version: card.appVersion,
    });
    void openExternalUrl(card.linkUrl);
    setCard(null);
  }, [analytics.track, card]);

  if (!active || card == null) return null;

  const dialog = (
    <Dialog
      ariaLabelledBy="whats-new-popup-title"
      // Backdrop / Escape are soft hides: the card is once-per-highlight, so a
      // stray dismissal must not spend it — mark-seen stays reserved for the
      // explicit buttons (matching the old toast's Escape semantics).
      onClose={() => setCard(null)}
      closeOnEscape
      className={styles.panel}
      backdropClassName={styles.backdrop}
      data-testid="whats-new-popup"
    >
      {card.imageUrl != null ? (
        <img className={styles.cover} src={card.imageUrl} alt="" />
      ) : null}
      <div className={styles.content}>
        <span className={styles.eyebrow}>Open Design {card.appVersion}</span>
        <h2 className={styles.title} id="whats-new-popup-title">
          {card.title}
        </h2>
        {card.bodyLines.length > 1 ? (
          <ul className={styles.notes}>
            {card.bodyLines.map((line) => (
              <li key={line} className={styles.note}>
                <span className={styles.noteDot} aria-hidden />
                {line}
              </li>
            ))}
          </ul>
        ) : card.bodyLines.length === 1 ? (
          <p className={styles.bodyText}>{card.bodyLines[0]}</p>
        ) : null}
      </div>
      <div className={styles.footer}>
        <Button
          className={styles.cancel}
          onClick={dismiss}
          data-testid="whats-new-dismiss"
          aria-label={t('whatsNew.dismissAria')}
        >
          {t('common.cancel')}
        </Button>
        <Button
          variant="primary"
          className={styles.confirm}
          onClick={openLink}
          data-testid="whats-new-cta"
        >
          {t('whatsNew.cta')}
        </Button>
      </div>
    </Dialog>
  );
  if (typeof document === 'undefined') return dialog;
  return createPortal(dialog, document.body);
}
