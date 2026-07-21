import { Icon } from './Icon';
import { useState, type CSSProperties } from 'react';
import { useT } from '../i18n';
import type { Dict } from '../i18n/types';

type TemplateDemo = {
  id: string;
  title: string;
  tags: string[];
  accent: string;
  meta: string;
  type: 'Prototype' | 'Live Artifact' | 'Slides' | 'Image' | 'Video' | 'HyperFrames' | 'Audio';
  subtype: string;
};

const COMMUNITY_TEMPLATES: TemplateDemo[] = [
  {
    id: 'electric-studio',
    title: 'Open Design Landing',
    tags: ['Landing', 'Brand'],
    accent: '#4164f4',
    meta: 'Live Artifact · Landing',
    type: 'Live Artifact',
    subtype: 'Landing',
  },
  {
    id: 'launch-landing',
    title: 'Kanban Board',
    tags: ['Prototype', 'Board'],
    accent: '#d46342',
    meta: 'Prototype · Product',
    type: 'Prototype',
    subtype: 'Product',
  },
  {
    id: 'founder-memo',
    title: 'Social Carousel',
    tags: ['Image', 'Social'],
    accent: '#111827',
    meta: 'Image · Carousel',
    type: 'Image',
    subtype: 'Social',
  },
  {
    id: 'growth-dashboard',
    title: 'Blog Post',
    tags: ['Live Artifact', 'Editorial'],
    accent: '#0f9f6e',
    meta: 'Live Artifact · Article',
    type: 'Live Artifact',
    subtype: 'Editorial',
  },
  { id: 'ai-product-site', title: 'Wireframe Sketch', tags: ['Prototype', 'Wireframe'], accent: '#353535', meta: 'Prototype · Wireframe', type: 'Prototype', subtype: 'Wireframe' },
  { id: 'commerce-home', title: 'Wireframe Greybox', tags: ['Prototype', 'Wireframe'], accent: '#ea580c', meta: 'Prototype · Greybox', type: 'Prototype', subtype: 'Wireframe' },
  { id: 'mobile-app-launch', title: 'Mobile Flow', tags: ['Prototype', 'Mobile'], accent: '#0284c7', meta: 'Prototype · Mobile', type: 'Prototype', subtype: 'Mobile' },
  { id: 'portfolio-case-study', title: 'Pitch Deck', tags: ['Slides', 'Pitch'], accent: '#111827', meta: 'Slides · Pitch deck', type: 'Slides', subtype: 'Pitch deck' },
  { id: 'design-system-docs', title: 'Design System Slides', tags: ['Slides', 'Design system'], accent: '#4f46e5', meta: 'Slides · System', type: 'Slides', subtype: 'Design system' },
  { id: 'event-microsite', title: 'Product Demo Video', tags: ['Video', 'Demo'], accent: '#db2777', meta: 'Video · Demo', type: 'Video', subtype: 'Demo' },
  { id: 'agency-services', title: 'Launch Motion', tags: ['Video', 'Launch'], accent: '#d46a3c', meta: 'Video · Launch', type: 'Video', subtype: 'Launch' },
  { id: 'fintech-dashboard', title: 'Analytics Console', tags: ['Live Artifact', 'Dashboard'], accent: '#16a34a', meta: 'Live Artifact · Dashboard', type: 'Live Artifact', subtype: 'Dashboard' },
  { id: 'healthcare-intake', title: 'Intake Prototype', tags: ['Prototype', 'Healthcare'], accent: '#0f9f6e', meta: 'Prototype · Healthcare', type: 'Prototype', subtype: 'Healthcare' },
  { id: 'developer-docs', title: 'API Docs', tags: ['Live Artifact', 'Docs'], accent: '#475569', meta: 'Live Artifact · Docs', type: 'Live Artifact', subtype: 'Docs' },
  { id: 'pricing-test', title: 'Pricing Experiment', tags: ['Live Artifact', 'Growth'], accent: '#f59e0b', meta: 'Live Artifact · Pricing', type: 'Live Artifact', subtype: 'Growth' },
  { id: 'admin-console', title: 'Admin Console', tags: ['Prototype', 'Admin'], accent: '#0f172a', meta: 'Prototype · Admin', type: 'Prototype', subtype: 'Admin' },
  { id: 'education-course', title: 'Course Landing', tags: ['Live Artifact', 'Education'], accent: '#1A74FF', meta: 'Live Artifact · Course', type: 'Live Artifact', subtype: 'Education' },
  { id: 'restaurant-booking', title: 'Booking Flow', tags: ['Prototype', 'Booking'], accent: '#be123c', meta: 'Prototype · Booking', type: 'Prototype', subtype: 'Booking' },
  { id: 'real-estate-listing', title: 'Listing Page', tags: ['Live Artifact', 'Real estate'], accent: '#0d9488', meta: 'Live Artifact · Listing', type: 'Live Artifact', subtype: 'Real estate' },
  { id: 'support-center', title: 'Support Center', tags: ['Live Artifact', 'Support'], accent: '#0891b2', meta: 'Live Artifact · Support', type: 'Live Artifact', subtype: 'Support' },
  { id: 'social-campaign', title: 'Campaign Pack', tags: ['Image', 'Campaign'], accent: '#ec4899', meta: 'Image · Campaign', type: 'Image', subtype: 'Campaign' },
  { id: 'newsletter-brief', title: 'Voice Brief', tags: ['Audio', 'Brief'], accent: '#64748b', meta: 'Audio · Brief', type: 'Audio', subtype: 'Brief' },
  { id: 'roadmap-board', title: 'Scene Timeline', tags: ['HyperFrames', 'Timeline'], accent: '#8b5cf6', meta: 'HyperFrames · Timeline', type: 'HyperFrames', subtype: 'Timeline' },
  { id: 'app-settings', title: 'Interactive Story', tags: ['HyperFrames', 'Story'], accent: '#334155', meta: 'HyperFrames · Story', type: 'HyperFrames', subtype: 'Story' },
];

const TEMPLATE_TYPE_ORDER: TemplateDemo['type'][] = ['Slides', 'Prototype', 'Live Artifact', 'Image', 'Video', 'HyperFrames', 'Audio'];

/** Count the catalogue by type so a facet tab can never advertise a number the
 *  grid will not render. The badge and the cards must resolve from the same
 *  array: any tab showing `n` renders exactly `n` cards once its subtype filter
 *  is "All". Do not replace this with a hand-maintained lookup table. */
// The type tabs are rendered from the demo catalogue's `type` field, which is
// a data value rather than copy. Map it onto a translated label so the tab row
// is not the one English strip on an otherwise localized page.
const TEMPLATE_TYPE_LABEL_KEY: Record<TemplateDemo['type'], keyof Dict> = {
  'Prototype': 'community.typePrototype',
  'Live Artifact': 'community.typeLiveArtifact',
  'Slides': 'community.typeSlides',
  'Image': 'community.typeImage',
  'Video': 'community.typeVideo',
  'HyperFrames': 'community.typeHyperFrames',
  'Audio': 'community.typeAudio',
};

function countTemplatesByType(templates: TemplateDemo[]): Record<TemplateDemo['type'], number> {
  const counts = Object.fromEntries(
    TEMPLATE_TYPE_ORDER.map((type) => [type, 0]),
  ) as Record<TemplateDemo['type'], number>;
  for (const template of templates) counts[template.type] += 1;
  return counts;
}

const TEMPLATE_TYPE_COUNTS: Record<TemplateDemo['type'], number> = countTemplatesByType(COMMUNITY_TEMPLATES);

const TEMPLATE_PREVIEW_SRC: Record<string, string> = {
  'electric-studio': '/community-templates/open-design-landing.webp',
  'launch-landing': '/community-templates/kanban-board.webp',
  'founder-memo': '/community-templates/social-carousel.jpg',
  'growth-dashboard': '/community-templates/blog-post.webp',
  'ai-product-site': '/community-templates/wireframe-sketch.webp',
  'commerce-home': '/community-templates/wireframe-greybox.webp',
  'mobile-app-launch': '/community-templates/mobile-flow.webp',
  'portfolio-case-study': '/community-templates/pitch-deck.webp',
  'design-system-docs': '/community-templates/workspace-cover.webp',
  'event-microsite': '/community-templates/hyperframes.webp',
  'agency-services': '/community-templates/live-artifact.webp',
  'fintech-dashboard': '/community-templates/dashboard.webp',
  'healthcare-intake': '/community-templates/wireframe-sketch.webp',
  'developer-docs': '/community-templates/blog-post.webp',
  'pricing-test': '/community-templates/open-design-landing.webp',
  'admin-console': '/community-templates/kanban-board.webp',
  'education-course': '/community-templates/workspace-cover.webp',
  'restaurant-booking': '/community-templates/wireframe-greybox.webp',
  'real-estate-listing': '/community-templates/live-artifact.webp',
  'support-center': '/community-templates/blog-post.webp',
  'social-campaign': '/community-templates/social-carousel.jpg',
  'newsletter-brief': '/community-templates/pitch-deck.webp',
  'roadmap-board': '/community-templates/hyperframes.webp',
  'app-settings': '/community-templates/dashboard.webp',
};

interface CommunityViewProps {
  /** Hand the user into Home with a starting prompt derived from the chosen
   *  template. The `templateId` is threaded through so the destination knows
   *  which card was remixed. */
  onRemixTemplate?: (remix: { templateId: string; prompt: string }) => void;
}

/** Build the Home-composer starting prompt for a remixed template. */
function buildRemixPrompt(template: TemplateDemo): string {
  return `Remix the "${template.title}" community template into a new Open Design project (${template.meta}).`;
}

export function CommunityView({ onRemixTemplate }: CommunityViewProps) {
  const t = useT();
  const [previewTemplate, setPreviewTemplate] = useState<TemplateDemo | null>(null);
  const [activeType, setActiveType] = useState<TemplateDemo['type']>('Slides');
  const [activeSubtype, setActiveSubtype] = useState('All');
  const typeOptions = TEMPLATE_TYPE_ORDER.filter((type) =>
    COMMUNITY_TEMPLATES.some((template) => template.type === type),
  );
  const subtypeOptions = Array.from(new Set(
    COMMUNITY_TEMPLATES
      .filter((template) => template.type === activeType)
      .map((template) => template.subtype),
  ));
  const filteredTemplates = COMMUNITY_TEMPLATES.filter((template) => {
    const typeMatches = template.type === activeType;
    const subtypeMatches = activeSubtype === 'All' || template.subtype === activeSubtype;
    return typeMatches && subtypeMatches;
  });
  const typeCount = (type: TemplateDemo['type']) => TEMPLATE_TYPE_COUNTS[type];
  const handleTemplateAction = (template: TemplateDemo) => {
    if (isPromptArtifact(template)) {
      void copyTemplatePrompt(template);
      return;
    }
    onRemixTemplate?.({ templateId: template.id, prompt: buildRemixPrompt(template) });
  };

  return (
    <section className="community-template-view" aria-labelledby="community-template-title">
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
                <span>{t(TEMPLATE_TYPE_LABEL_KEY[type])}</span>
                <small>{typeCount(type)}</small>
              </button>
            ))}
          </div>
        </div>
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
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  handleTemplateAction(template);
                }}
              >
                {templateActionLabel(template)}
              </button>
            </footer>
          </article>
        ))}
      </div>
      {previewTemplate ? (
        <TemplatePreviewModal
          template={previewTemplate}
          onClose={() => setPreviewTemplate(null)}
          onUse={() => handleTemplateAction(previewTemplate)}
        />
      ) : null}
    </section>
  );
}

function TemplatePreviewModal({
  template,
  onClose,
  onUse,
}: {
  template: TemplateDemo;
  onClose: () => void;
  onUse: () => void;
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
          srcDoc={templatePreviewHtml(template)}
        />
        <footer className="community-template-preview__foot">
          <span>{template.meta}</span>
          <button type="button" onClick={onUse}>{templateActionLabel(template)}</button>
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
  await navigator.clipboard.writeText(
    `Create a ${template.meta.toLowerCase()} artifact titled "${template.title}" for Open Design. Use a polished composition, clear hierarchy, and production-ready visual direction.`,
  );
}

function TemplateThumb({ template }: { template: TemplateDemo }) {
  const previewSrc = TEMPLATE_PREVIEW_SRC[template.id];

  if (previewSrc) {
    return (
      <img
        className="community-template-thumb__image"
        src={previewSrc}
        alt=""
        loading="lazy"
        draggable={false}
      />
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

function templatePreviewHtml(template: TemplateDemo): string {
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
