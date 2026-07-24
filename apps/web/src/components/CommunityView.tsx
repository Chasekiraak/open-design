import { Icon, type IconName } from './Icon';
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import type { InstalledPluginRecord } from '@open-design/contracts';
import { useI18n, useT } from '../i18n';
import type { Dict, Locale } from '../i18n/types';
import { listPlugins } from '../state/projects';
import { MediaSurface } from './plugins-home/cards/MediaSurface';
import {
  buildCategoryCatalog,
  buildSubcategoryCatalog,
  extractCategories,
  extractSubcategories,
} from './plugins-home/facets';
import { localizePluginTitle } from './plugins-home/localization';
import { examplePresetSeedPrompt } from './plugins-home/presetSeedPrompt';
import { inferPluginPreview, type MediaPreviewSpec } from './plugins-home/preview';
import { pluginSubfacetLabel } from './plugins-home/subfacetLabel';
import { useInView } from './plugins-home/useInView';

type TemplateType = 'Prototype' | 'Live Artifact' | 'Slides' | 'Image' | 'Video' | 'HyperFrames' | 'Audio';

type TemplateDemo = {
  id: string;
  title: string;
  tags: string[];
  accent: string;
  meta: string;
  type: TemplateType;
  subtype: string;
  /** The WHOLE media spec the gallery tile renders — poster plus, for plugins
   *  the daemon has baked, the looping clip (`videoUrl`) and the in-place span
   *  it loops while idle (`loopHoldMs`). Flattening this to a poster string is
   *  what turned every tile into a still image. Null when the plugin resolves
   *  to no media at all (html/design/text), in which case the stylized paper
   *  thumb renders instead. */
  cardMedia: MediaPreviewSpec | null;
  /** Card thumbnail. Null when the plugin ships no poster at all, in which case
   *  the stylized paper thumb renders instead. */
  posterSrc: string | null;
  /** Daemon-served live preview for the detail modal (html-preview plugins). */
  previewSrc: string | null;
  /** Playable clip for the detail modal when the plugin is a media template. */
  previewVideo: string | null;
  /** Composer seed carried by the card's Remix / Copy prompt action. */
  prompt: string;
};

const TEMPLATE_TYPE_ORDER: TemplateType[] = ['Slides', 'Prototype', 'Live Artifact', 'Image', 'Video', 'HyperFrames', 'Audio'];

/** The Community grid is the plugin catalogue seen through the artifact a user
 *  wants to make. Membership comes from the shared facet derivation in
 *  `plugins-home/facets.ts` — the same taxonomy the Home starter rail uses — so
 *  a plugin lands in exactly one tab here and in the same tab there. Do not
 *  re-derive categories locally. */
const FACET_CATEGORY_TYPE: Record<string, TemplateType> = {
  'deck': 'Slides',
  'prototype': 'Prototype',
  'live-artifact': 'Live Artifact',
  'image': 'Image',
  'video': 'Video',
  'hyperframes': 'HyperFrames',
  'audio': 'Audio',
};

/** Count the catalogue by type so a facet tab can never advertise a number the
 *  grid will not render. The badge and the cards must resolve from the same
 *  array: any tab showing `n` renders exactly `n` cards once its subtype filter
 *  is "All". Do not replace this with a hand-maintained lookup table. */
// The type tabs are rendered from the catalogue's `type` field, which is
// a data value rather than copy. Map it onto a translated label so the tab row
// is not the one English strip on an otherwise localized page.
const TEMPLATE_TYPE_LABEL_KEY: Record<TemplateType, keyof Dict> = {
  'Prototype': 'community.typePrototype',
  'Live Artifact': 'community.typeLiveArtifact',
  'Slides': 'community.typeSlides',
  'Image': 'community.typeImage',
  'Video': 'community.typeVideo',
  'HyperFrames': 'community.typeHyperFrames',
  'Audio': 'community.typeAudio',
};

/** Each tab carries the same icon the home composer's creation-type radial
 *  uses for that artifact kind (see home-hero/chips.ts), so the two surfaces
 *  read as one taxonomy. */
const TEMPLATE_TYPE_ICON: Record<TemplateType, IconName> = {
  'Slides': 'present',
  'Prototype': 'artboard',
  'Live Artifact': 'bar-chart-box',
  'Image': 'image',
  'Video': 'video-ai',
  'HyperFrames': 'orbit',
  'Audio': 'mic',
};

// Card accents tint the thumbnail plate and the fallback preview page. The
// palette is the designer's; picking from it by a stable hash of the plugin id
// keeps a card's colour fixed across reloads without hand-maintaining a table.
const TEMPLATE_ACCENTS = [
  '#4164f4', '#d46342', '#111827', '#0f9f6e', '#353535', '#ea580c', '#0284c7',
  '#4f46e5', '#db2777', '#16a34a', '#475569', '#f59e0b', '#0f172a', '#1A74FF',
  '#be123c', '#0d9488', '#0891b2', '#ec4899', '#64748b', '#8b5cf6', '#334155',
];

function hashString(value: string): number {
  let h = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

function templateAccent(id: string): string {
  return TEMPLATE_ACCENTS[hashString(id) % TEMPLATE_ACCENTS.length]!;
}

/** Project the installed plugin catalogue onto the Community grid's card shape.
 *  Every field the grid reads — badge counts, subtype pills, thumbnails, the
 *  modal preview, and the composer seed — is derived here from the record, so
 *  the page has exactly one data source: `GET /api/plugins`. */
function buildCommunityTemplates(
  plugins: InstalledPluginRecord[],
  locale: Locale,
  t: ReturnType<typeof useT>,
): TemplateDemo[] {
  const categoryOrder = buildCategoryCatalog(plugins).map((option) => option.slug);
  const subcategoryCatalog = buildSubcategoryCatalog(plugins);
  const subcategoryRank = new Map<string, number>();
  const subcategoryLabel = new Map<string, string>();
  for (const [parent, options] of Object.entries(subcategoryCatalog)) {
    options.forEach((option, index) => {
      subcategoryRank.set(`${parent}:${option.slug}`, index);
      subcategoryLabel.set(`${parent}:${option.slug}`, option.label);
    });
  }

  const entries = plugins.flatMap((record, index) => {
    const categorySlug = extractCategories(record)[0];
    if (!categorySlug) return [];
    const type = FACET_CATEGORY_TYPE[categorySlug];
    if (!type) return [];
    const subSlug = extractSubcategories(record, categorySlug)[0] ?? null;
    return [{ record, index, categorySlug, subSlug, type }];
  });

  // Group the grid the way the pills read: category order, then the sub-facet
  // display order, then catalogue order. The subtype pill row is derived from
  // this array, so sorting here is what puts the pills in taxonomy order.
  entries.sort((a, b) => {
    const byCategory = categoryOrder.indexOf(a.categorySlug) - categoryOrder.indexOf(b.categorySlug);
    if (byCategory !== 0) return byCategory;
    const rank = (categorySlug: string, subSlug: string | null) => (
      subSlug === null
        ? Number.MAX_SAFE_INTEGER
        : subcategoryRank.get(`${categorySlug}:${subSlug}`) ?? Number.MAX_SAFE_INTEGER - 1
    );
    const bySub = rank(a.categorySlug, a.subSlug) - rank(b.categorySlug, b.subSlug);
    if (bySub !== 0) return bySub;
    return a.index - b.index;
  });

  return entries.map(({ record, categorySlug, subSlug, type }) => {
    const title = localizePluginTitle(locale, record);
    const typeLabel = t(TEMPLATE_TYPE_LABEL_KEY[type]);
    const subtype = subSlug
      ? pluginSubfacetLabel(subSlug, subcategoryLabel.get(`${categorySlug}:${subSlug}`) ?? subSlug, t)
      : '';
    // Gallery tiles prefer the pre-baked poster; the modal keeps the real
    // `od.preview` so opening a card shows the live page, not the baked frame.
    const card = inferPluginPreview(record, { preferBaked: true });
    const detail = inferPluginPreview(record);
    // Carry the whole spec, not just its poster: a baked preview's `videoUrl`
    // and `loopHoldMs` are what let the tile play its short screen recording
    // instead of sitting on the first frame.
    const cardMedia = card.kind === 'media' ? card : null;
    return {
      id: record.id,
      title,
      tags: record.manifest?.tags ?? [],
      accent: templateAccent(record.id),
      meta: subtype ? `${typeLabel} · ${subtype}` : typeLabel,
      type,
      subtype,
      cardMedia,
      posterSrc: cardMedia ? cardMedia.poster : detail.kind === 'media' ? detail.poster : null,
      previewSrc: detail.kind === 'html' ? detail.src : null,
      previewVideo: detail.kind === 'media' ? detail.videoUrl : null,
      prompt: examplePresetSeedPrompt(record, locale, () => title).text,
    };
  });
}

interface CommunityViewProps {
  /** Hand the user into Home with a starting prompt derived from the chosen
   *  template. The `templateId` is threaded through so the destination knows
   *  which card was remixed. */
  onRemixTemplate?: (remix: { templateId: string; prompt: string }) => void;
  /** Send this template's prompt to the home composer input, without
   *  remixing straight into a project. */
  onUsePrompt?: (prompt: string) => void;
}

export function CommunityView({ onRemixTemplate, onUsePrompt }: CommunityViewProps) {
  const { locale, t } = useI18n();
  const [plugins, setPlugins] = useState<InstalledPluginRecord[]>([]);
  const [previewTemplate, setPreviewTemplate] = useState<TemplateDemo | null>(null);
  const [activeType, setActiveType] = useState<TemplateType>('Slides');
  const [activeSubtype, setActiveSubtype] = useState('All');
  // Remix (and the prompt-artifact copy path it shares) hands off to a
  // fire-and-forget parent callback (`onRemixTemplate`/`onUsePrompt` return
  // void) that kicks off a real POST /api/projects — nothing here observes
  // when it settles. Without a guard, N rapid clicks before the resulting
  // navigation actually leaves this view fired N separate creates,
  // duplicating the project N times ("Community 的模板 remix 点击多次会复制
  // 多次").
  //
  // `remixingId` (state) drives the visible disabled/loading affordance, but
  // state writes are NOT synchronous — `handleTemplateAction` closes over
  // whatever `remixingId` was at the last render, and a burst of clicks that
  // lands before React re-renders (real rapid clicking, or several native
  // click events dispatched inside one tick) all read the same stale
  // (pre-update) value and all pass the `if (remixingId) return` check. A
  // second confirmed-live PR (0b8e31a3e) shipped exactly that state-only
  // guard and rapid-click verification still produced 5 POST /api/projects
  // from 5 clicks. `remixingIdRef` is the actual gate: a plain mutable ref
  // is written synchronously the instant the first click is accepted, so
  // every click in the same burst — including ones whose handler closure
  // predates the next render — sees the lock immediately. Cleared on the
  // success path (navigation away unmounts this view) or by the timeout
  // fallback below, so a card can never get stuck disabled forever.
  const remixingIdRef = useRef<string | null>(null);
  const [remixingId, setRemixingId] = useState<string | null>(null);
  useEffect(() => {
    if (!remixingId) return;
    const timer = window.setTimeout(() => {
      remixingIdRef.current = null;
      setRemixingId(null);
    }, 8000);
    return () => window.clearTimeout(timer);
  }, [remixingId]);
  useEffect(() => {
    let cancelled = false;
    // `listPlugins` resolves to [] on a failed/aborted fetch, so a daemon that
    // is not up yet simply leaves the grid empty instead of throwing.
    void listPlugins().then((rows) => {
      if (!cancelled) setPlugins(rows);
    });
    return () => { cancelled = true; };
  }, []);
  const templates = useMemo(
    () => buildCommunityTemplates(plugins, locale, t),
    [plugins, locale, t],
  );
  const typeOptions = TEMPLATE_TYPE_ORDER.filter((type) =>
    templates.some((template) => template.type === type),
  );
  const subtypeOptions = Array.from(new Set(
    templates
      .filter((template) => template.type === activeType && template.subtype)
      .map((template) => template.subtype),
  ));
  const filteredTemplates = templates.filter((template) => {
    const typeMatches = template.type === activeType;
    const subtypeMatches = activeSubtype === 'All' || template.subtype === activeSubtype;
    return typeMatches && subtypeMatches;
  });
  const handleTemplateAction = (template: TemplateDemo) => {
    if (isPromptArtifact(template)) {
      void copyTemplatePrompt(template);
      return;
    }
    // Synchronous check-and-set on the ref: this is what actually decides
    // whether a request goes out. See the remixingIdRef comment above for
    // why the state flag alone cannot gate this.
    if (remixingIdRef.current) return;
    remixingIdRef.current = template.id;
    setRemixingId(template.id);
    onRemixTemplate?.({ templateId: template.id, prompt: template.prompt });
  };

  return (
    <section className="community-template-view" aria-labelledby="community-template-title">
      {/* Header (title + search + filter rows) scrolls away with the grid. */}
      <div className="community-template-view__header">
      <header className="community-template-view__hero">
        <div>
          <h1 id="community-template-title" className="entry-section__title">{t('community.title')}</h1>
        </div>
        <div className="community-template-view__search" role="search">
          <Icon name="search" size={16} />
          <input type="search" placeholder={t('community.searchPlaceholder')} aria-label={t('community.searchAria')} readOnly />
        </div>
      </header>

      <div className="community-template-view__filters" aria-label={t('community.filtersAria')}>
        <div className="community-template-view__filter-main">
          <div className="community-template-view__type-tabs">
            {typeOptions.map((type) => (
              <button
                key={type}
                type="button"
                className={activeType === type ? 'is-active' : ''}
                onClick={() => {
                  setActiveType(type);
                  setActiveSubtype('All');
                }}
              >
                <Icon name={TEMPLATE_TYPE_ICON[type]} size={16} aria-hidden />
                <span>{t(TEMPLATE_TYPE_LABEL_KEY[type])}</span>
              </button>
            ))}
          </div>
        </div>
        {subtypeOptions.length > 0 ? (
          <div className="community-template-view__subtabs">
            <button
              type="button"
              className={activeSubtype === 'All' ? 'is-active' : ''}
              onClick={() => setActiveSubtype('All')}
            >
              {t('common.all')}
            </button>
            {subtypeOptions.map((subtype) => (
              <button
                key={subtype}
                type="button"
                className={activeSubtype === subtype ? 'is-active' : ''}
                onClick={() => setActiveSubtype(subtype)}
              >
                {subtype}
              </button>
            ))}
          </div>
        ) : null}
      </div>
      </div>

      <div className="community-template-grid">
        {filteredTemplates.map((template) => (
          <article
            key={template.id}
            className="community-template-card is-clickable"
            onClick={() => setPreviewTemplate(template)}
          >
            <div
              className="community-template-card__preview"
              style={{ '--template-accent': template.accent } as CSSProperties}
              aria-hidden
            >
              <TemplateThumb template={template} />
            </div>
            <footer className="community-template-card__foot">
              <span>{template.meta}</span>
              <div className="community-template-card__actions">
                <button
                  type="button"
                  disabled={remixingId === template.id}
                  onClick={(event) => {
                    event.stopPropagation();
                    handleTemplateAction(template);
                  }}
                >
                  {remixingId === template.id ? t('common.loading') : templateActionLabel(template)}
                </button>
                <button
                  type="button"
                  className="community-template-card__prompt-btn"
                  onClick={(event) => {
                    event.stopPropagation();
                    onUsePrompt?.(template.prompt);
                  }}
                >
                  {t('community.usePrompt')}
                </button>
              </div>
            </footer>
          </article>
        ))}
      </div>
      {previewTemplate ? (
        <TemplatePreviewModal
          template={previewTemplate}
          onClose={() => setPreviewTemplate(null)}
          onUse={() => handleTemplateAction(previewTemplate)}
          busy={remixingId === previewTemplate.id}
        />
      ) : null}
    </section>
  );
}

function TemplatePreviewModal({
  template,
  onClose,
  onUse,
  busy,
}: {
  template: TemplateDemo;
  onClose: () => void;
  onUse: () => void;
  busy?: boolean;
}) {
  const t = useT();
  return (
    <div className="community-template-preview" role="presentation" onMouseDown={onClose}>
      <section
        className="community-template-preview__panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="community-template-preview-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="community-template-preview__head">
          <div>
            <h2 id="community-template-preview-title">{template.title}</h2>
            <p>{template.meta}</p>
          </div>
          <button type="button" aria-label={t('community.closePreview')} onClick={onClose}>
            <Icon name="close" size={17} />
          </button>
        </header>
        <iframe
          title={`${template.title} preview`}
          className="community-template-preview__frame"
          // Html-preview plugins load their real daemon-served page; media
          // templates have no page to load, so the same frame carries their
          // poster/clip instead.
          {...(template.previewSrc
            ? { src: template.previewSrc }
            : { srcDoc: templatePreviewHtml(template) })}
        />
        <footer className="community-template-preview__foot">
          <span>{template.meta}</span>
          <button type="button" disabled={busy} onClick={onUse}>
            {busy ? t('common.loading') : templateActionLabel(template)}
          </button>
        </footer>
      </section>
    </div>
  );
}

function isPromptArtifact(template: TemplateDemo): boolean {
  return template.type === 'Image' || template.type === 'Video' || template.type === 'Audio';
}

function templateActionLabel(template: TemplateDemo): string {
  return isPromptArtifact(template) ? 'Copy prompt' : 'Remix';
}

async function copyTemplatePrompt(template: TemplateDemo): Promise<void> {
  if (typeof navigator === 'undefined' || !navigator.clipboard?.writeText) return;
  await navigator.clipboard.writeText(template.prompt);
}

function TemplateThumb({ template }: { template: TemplateDemo }) {
  // Same visibility contract the plugins-home gallery hands MediaSurface (see
  // PreviewSurface.tsx): the wide margin MOUNTS the clip so its first frame is
  // ready before the tile scrolls in and scrolling back never remounts it,
  // while the zero-margin observer gates decode/playback so an idle gallery
  // does not spin up every clip at once.
  const { ref: keepRef, inView: keep } = useInView<HTMLDivElement>({
    rootMargin: '1500px',
    once: false,
  });
  const { ref: visibleRef, inView: visible } = useInView<HTMLDivElement>({
    rootMargin: '0px',
    once: false,
  });
  const setRef = useCallback(
    (node: HTMLDivElement | null) => {
      keepRef.current = node;
      visibleRef.current = node;
    },
    [keepRef, visibleRef],
  );

  const media = template.cardMedia;
  if (media?.poster) {
    // MediaSurface positions itself against its container, so the thumb owns
    // the positioned box; it also handles poster-load failure on its own.
    return (
      <div className="community-template-thumb__media" ref={setRef}>
        <MediaSurface
          preview={media}
          pluginTitle={template.title}
          inView={keep}
          visible={visible}
        />
      </div>
    );
  }

  return (
    <div className={`community-template-thumb community-template-thumb--${template.type.toLowerCase().replace(/\s+/g, '-')}`}>
      <div className="community-template-thumb__paper">
        <span className="community-template-thumb__line is-primary" />
        <strong>{template.title.split(' ')[0]}</strong>
        <span className="community-template-thumb__line is-short" />
        <div className="community-template-thumb__grid">
          <span />
          <span />
          <span />
          <span />
        </div>
      </div>
    </div>
  );
}

function escapeHtmlAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Document rendered inside the detail frame when the plugin has no daemon
 *  html preview: media templates show their real poster/clip, and the handful
 *  of plugins that ship neither fall back to the stylized template page. */
function templatePreviewHtml(template: TemplateDemo): string {
  if (template.previewVideo || template.posterSrc) {
    const poster = template.posterSrc ? escapeHtmlAttribute(template.posterSrc) : '';
    const body = template.previewVideo
      ? `<video src="${escapeHtmlAttribute(template.previewVideo)}"${poster ? ` poster="${poster}"` : ''} controls autoplay muted loop playsinline></video>`
      : `<img src="${poster}" alt="" />`;
    return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>
    html, body { margin: 0; height: 100%; }
    body { display: grid; place-items: center; background: #0b1020; }
    img, video { display: block; max-width: 100%; max-height: 100%; object-fit: contain; }
  </style>
</head>
<body>${body}</body>
</html>`;
  }
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; font-family: var(--sans); color: #111827; background: #f8fafc; }
    .shell { min-height: 100vh; padding: 56px; background: linear-gradient(135deg, ${template.accent}1f, #ffffff 42%, #f8fafc); }
    nav { display: flex; justify-content: space-between; align-items: center; margin-bottom: 72px; font-size: 14px; color: #64748b; }
    .logo { display: flex; align-items: center; gap: 10px; color: #111827; font-weight: 800; }
    .mark { width: 28px; height: 28px; border-radius: var(--radius-large, 8px); background: ${template.accent}; box-shadow: 0 12px 30px ${template.accent}45; }
    .hero { display: grid; grid-template-columns: minmax(0, 1fr) 360px; gap: 56px; align-items: center; }
    h1 { margin: 0; max-width: 740px; font-size: 64px; line-height: .94; letter-spacing: -.04em; }
    p { color: #64748b; line-height: 1.7; font-size: 18px; }
    .cta { display: inline-flex; margin-top: 24px; padding: 14px 20px; border-radius: 999px; background: #111827; color: #fff; font-weight: 750; }
    .card { min-height: 360px; padding: 28px; border: 1px solid #e5e7eb; border-radius: 28px; background: rgba(255,255,255,.82); box-shadow: 0 30px 80px rgba(15,23,42,.12); }
    .stripe { height: 8px; border-radius: 999px; background: ${template.accent}; margin-bottom: 28px; }
    .metric { display: grid; gap: 8px; padding: 18px 0; border-bottom: 1px solid #e5e7eb; }
    .metric strong { font-size: 28px; }
    .sections { display: grid; grid-template-columns: repeat(3, 1fr); gap: 18px; margin-top: 56px; }
    .section { padding: 22px; border-radius: 20px; background: #fff; border: 1px solid #e5e7eb; }
    .section b { display: block; margin-bottom: 10px; }
  </style>
</head>
<body>
  <main class="shell">
    <nav><span class="logo"><span class="mark"></span>${template.title}</span><span>${template.tags.join(' · ')}</span></nav>
    <section class="hero">
      <div>
        <h1>${template.title} template for polished product storytelling.</h1>
        <p>${template.meta}</p>
        <span class="cta">Preview template</span>
      </div>
      <aside class="card">
        <div class="stripe"></div>
        <div class="metric"><span>Primary outcome</span><strong>Clearer launch story</strong></div>
        <div class="metric"><span>Format</span><strong>${template.meta}</strong></div>
        <div class="metric"><span>Style</span><strong>Modern editorial</strong></div>
      </aside>
    </section>
    <section class="sections">
      <div class="section"><b>Structure</b><span>Ready-made sections and hierarchy.</span></div>
      <div class="section"><b>Visual System</b><span>Color, type, rhythm, and reusable blocks.</span></div>
      <div class="section"><b>Editable</b><span>Remix into a real Open Design project.</span></div>
    </section>
  </main>
</body>
</html>`;
}
