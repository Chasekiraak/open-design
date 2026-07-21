import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Button,
  Dialog,
  DialogBody,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@open-design/components';
import type { DesignSystemSummary, SkillSummary } from '@open-design/contracts';
import { useI18n, useT } from '../i18n';
import { localizeSkillDescription, localizeSkillName } from '../i18n/content';
import {
  buildTemplateMatchDoc,
  filterBySearch,
  rankByRelevance,
  scoreTemplateDoc,
  swatchVividness,
  tokenizeQuery,
  tokenizeSearch,
  type TemplateMatchDoc,
} from './inspiration-match';
import {
  inspirationEntryForDesignSystem,
  inspirationEntryForTemplate,
  parseInspirationSelection,
  type InspirationSource,
} from '../artifacts/question-form';
import {
  fetchDesignSystems,
  fetchDesignTemplates,
  projectRawUrl,
} from '../providers/registry';
import {
  commercialCategoryLabel,
  isCommercialCategoryId,
} from './plugins-home/categoryLabel';
import { setPendingDesignSystemCreateEntry } from '../analytics/ds-create-entry';
import { requestInspirationBrowse } from '../runtime/inspiration-browse-intent';
import { navigate } from '../router';
import { Icon } from './Icon';

/**
 * Host-data-driven picker behind the `inspiration` question type: templates
 * by category, design systems with their swatch rows, and the user's own
 * reference images. The model only emits the small question marker — every
 * catalog entry rendered here comes from the local registry endpoints, and
 * the picked references are serialized back through the standard
 * question-form answer channel (see inspirationEntryForTemplate /
 * parseInspirationSelection in artifacts/question-form.ts).
 *
 * Cards embed real previews: template cards iframe the template's own seed
 * (`/api/design-templates/:id/preview`), design-system cards iframe the
 * compact brand card (`/api/design-systems/:id/card`). Both keep the
 * wireframe/swatch fallback underneath for catalogs without a preview.
 */

// One structural reference (template) keeps the grounding signal clean; the
// visual language may blend a primary design system with up to two
// additional inspirations (the daemon's `inspirationDesignSystemIds`
// metadata channel), and a few user images set the mood.
export const INSPIRATION_MAX_TEMPLATES = 1;
export const INSPIRATION_MAX_DESIGN_SYSTEMS = 3;
export const INSPIRATION_MAX_UPLOADS = 3;

const INLINE_GRID_SIZE = 4;
const ALL_SOURCES: readonly InspirationSource[] = [
  'templates',
  'design-systems',
  'upload',
];

// Module-level catalog cache: every inspiration form in the conversation
// shares one fetch per surface instead of refetching on each mount.
let templatesCache: Promise<SkillSummary[]> | null = null;
let designSystemsCache: Promise<DesignSystemSummary[]> | null = null;
// Availability of per-template preview documents. Templates without a real
// HTML document are not useful references, so the catalogue does not resolve
// until these probes complete and unavailable entries can be removed.
const templatePreviewAvailability = new Map<string, Promise<boolean>>();

function isVisualTemplate(skill: SkillSummary): boolean {
  return skill.mode !== 'design-system' && skill.mode !== 'audio';
}

function loadTemplates(): Promise<SkillSummary[]> {
  templatesCache ??= fetchDesignTemplates()
    .then(async (list) => {
      const candidates = list.filter(isVisualTemplate);
      const availability = await Promise.all(
        candidates.map(async (skill) => ({
          skill,
          available: await probeTemplatePreview(skill.id),
        })),
      );
      return availability
        .filter((entry) => entry.available)
        .map((entry) => entry.skill);
    })
    .catch(() => {
      templatesCache = null;
      return [];
    });
  return templatesCache;
}

function loadDesignSystems(): Promise<DesignSystemSummary[]> {
  designSystemsCache ??= fetchDesignSystems().catch(() => {
    designSystemsCache = null;
    return [];
  });
  return designSystemsCache;
}

function templatePreviewUrl(id: string): string {
  return `/api/design-templates/${encodeURIComponent(id)}/preview`;
}

function designSystemCardUrl(id: string): string {
  return `/api/design-systems/${encodeURIComponent(id)}/card`;
}

function probeTemplatePreview(id: string): Promise<boolean> {
  let probe = templatePreviewAvailability.get(id);
  if (!probe) {
    probe = fetch(templatePreviewUrl(id), { method: 'HEAD' })
      .then((res) => res.ok)
      .catch(() => false);
    templatePreviewAvailability.set(id, probe);
  }
  return probe;
}

/** Test-only: drop the module-level catalog cache between cases. */
export function resetInspirationCatalogCacheForTests() {
  templatesCache = null;
  designSystemsCache = null;
  templatePreviewAvailability.clear();
}

function isUserDesignSystem(system: DesignSystemSummary): boolean {
  return system.source === 'user' || system.isEditable === true;
}

// Reference-site shortcuts under the upload dropzone: copy an image on the
// site, come back, paste. Opened through the workspace's built-in Browser
// when a host listens (ProjectView), else a regular new tab.
const INSPIRATION_BROWSE_SITES: ReadonlyArray<{ id: string; label: string; url: string }> = [
  { id: 'dribbble', label: 'Dribbble', url: 'https://dribbble.com/shots/popular' },
  { id: 'mobbin', label: 'Mobbin', url: 'https://mobbin.com/discover/apps/web/latest' },
  { id: 'behance', label: 'Behance', url: 'https://www.behance.net/search/projects?field=ui%2Fux' },
  { id: 'awwwards', label: 'Awwwards', url: 'https://www.awwwards.com/websites/' },
];

export interface InspirationPickerProps {
  formId: string;
  questionId: string;
  /** Sections to offer; absent → all. */
  sources?: InspirationSource[];
  /** Short task summary shown as the picker's context line. */
  query?: string;
  /** Mixed answer entries: template/ds tokens plus uploaded file names. */
  value: string[];
  files: File[];
  disabled: boolean;
  onChange: (value: string[]) => void;
  onFilesChange: (files: File[]) => void;
  /** Form-language-aware translator from the owning QuestionFormView. */
  t: ReturnType<typeof useT>;
  onGalleryOpen?: () => void;
  /**
   * Owning project — lets the locked (answered) summary resolve an uploaded
   * image name back to its served file, since the live File objects are gone
   * once the form is submitted.
   */
  projectId?: string | null;
  /**
   * Original-upload-name → actual project path, recovered from the submitted
   * turn's `[uploaded design files]` block. Handles de-duplicated names; the
   * picker falls back to the raw name when a mapping is missing.
   */
  uploadPathByName?: Record<string, string>;
}

/** Scaled live-document thumb shared by template and design-system cards. */
function LiveDocThumb({
  src,
  available,
  fallback,
  className,
}: {
  src: string;
  available: boolean;
  fallback: React.ReactNode;
  className: string;
}) {
  if (!available) {
    return (
      <span className={className} aria-hidden>
        {fallback}
      </span>
    );
  }
  return (
    <span className={`${className} qf-insp-thumb-live`} aria-hidden>
      <iframe
        src={src}
        loading="lazy"
        sandbox="allow-scripts"
        tabIndex={-1}
        scrolling="no"
        title=""
      />
    </span>
  );
}

export function InspirationPicker({
  formId,
  questionId,
  sources,
  query,
  value,
  files,
  disabled,
  onChange,
  onFilesChange,
  t,
  onGalleryOpen,
  projectId,
  uploadPathByName,
}: InspirationPickerProps) {
  const { locale } = useI18n();
  const enabled = useMemo(() => {
    const requested = sources && sources.length > 0 ? sources : ALL_SOURCES;
    return ALL_SOURCES.filter((source) => requested.includes(source));
  }, [sources]);
  const [tab, setTab] = useState<InspirationSource>(enabled[0] ?? 'templates');
  const [templates, setTemplates] = useState<SkillSummary[] | null>(null);
  const [designSystems, setDesignSystems] = useState<DesignSystemSummary[] | null>(null);
  const [category, setCategory] = useState<string>('all');
  const [dsCategory, setDsCategory] = useState<string>('all');
  const [galleryOpen, setGalleryOpen] = useState(false);
  const [templateSearch, setTemplateSearch] = useState('');
  const [dsSearch, setDsSearch] = useState('');
  // The gallery's search is a header icon that expands into a field; it
  // collapses again on blur once emptied, so the chrome stays quiet by
  // default. Kept as state (not CSS :focus-within) because clearing must
  // keep the field open and focused. One control serves both gallery tabs,
  // writing to whichever catalogue is on screen.
  const [gallerySearchOpen, setGallerySearchOpen] = useState(false);
  const gallerySearchRef = useRef<HTMLInputElement | null>(null);
  const [dsMulti, setDsMulti] = useState(false);
  const [dsPreviewId, setDsPreviewId] = useState<string | null>(null);
  const [browseTipSite, setBrowseTipSite] = useState<string | null>(null);
  const [detail, setDetail] = useState<
    | { kind: 'template' | 'ds'; id: string; title: string }
    | { kind: 'image'; url: string; title: string }
    | null
  >(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [dragOver, setDragOver] = useState(false);

  useEffect(() => {
    if (!enabled.includes(tab)) setTab(enabled[0] ?? 'templates');
  }, [enabled, tab]);

  useEffect(() => {
    let alive = true;
    if (enabled.includes('templates')) {
      void loadTemplates().then((list) => {
        if (alive) setTemplates(list);
      });
    }
    if (enabled.includes('design-systems')) {
      void loadDesignSystems().then((list) => {
        if (alive) setDesignSystems(list);
      });
    }
    return () => {
      alive = false;
    };
  }, [enabled]);

  const selection = useMemo(() => parseInspirationSelection(value), [value]);
  // Upload entries in the answer are the non-token file names. In the live
  // form they mirror `files`; in the locked (answered) state File objects are
  // gone, so these names are the only record of what was attached.
  const uploadNames = useMemo(
    () =>
      value.filter((entry) => {
        const parsed = parseInspirationSelection([entry]);
        return parsed.templates.length === 0 && parsed.designSystems.length === 0;
      }),
    [value],
  );
  const selectedTemplateIds = useMemo(
    () => new Set(selection.templates.map((entry) => entry.id)),
    [selection],
  );
  const selectedDesignSystemIds = useMemo(
    () => new Set(selection.designSystems.map((entry) => entry.id)),
    [selection],
  );

  // `loadTemplates` has already removed non-visual entries and templates
  // whose HTML preview cannot be resolved. Keep this defensive mode filter so
  // a future caller cannot accidentally surface audio or design-system cards.
  const visualTemplates = useMemo(
    () => (templates ?? []).filter(isVisualTemplate),
    [templates],
  );

  // Every searchable attribute of a template, pre-lowercased once: localized
  // name and description, the `triggers` keyword list, category slug + label,
  // and scenario. Both relevance ranking and gallery search read these.
  const templateDocs = useMemo(() => {
    const docs = new Map<string, TemplateMatchDoc>();
    for (const skill of visualTemplates) {
      docs.set(
        skill.id,
        buildTemplateMatchDoc({
          id: skill.id,
          name: localizeSkillName(locale, skill),
          // Only ~half the catalog is translated, so keep every other locale's
          // name searchable too — otherwise a Chinese-UI user cannot reach an
          // English-only template by typing its English name.
          nameAliases: [skill.name, ...Object.values(skill.displayName ?? {})],
          triggers: skill.triggers,
          category: skill.category,
          categoryLabel: skill.category ? categoryLabel(skill.category) : '',
          scenario: skill.scenario,
          description: localizeSkillDescription(locale, skill),
          featured: skill.featured,
        }),
      );
    }
    return docs;
  }, [visualTemplates, locale, t]);

  // The question's task summary, tokenized. This is what turns the picker
  // from "the first four templates in the catalog" into "the four templates
  // that actually fit this request".
  const queryTokens = useMemo(() => tokenizeQuery(query ?? ''), [query]);

  const rankedTemplates = useMemo(
    () =>
      rankByRelevance(
        visualTemplates,
        queryTokens,
        (skill) => templateDocs.get(skill.id),
      ),
    [visualTemplates, queryTokens, templateDocs],
  );

  // Categories are ordered by how relevant they are to the request (summed
  // template score), so the chip the user most likely wants sits right after
  // "All"; ties and query-less forms fall back to catalogue size.
  const categories = useMemo(() => {
    const counts = new Map<string, number>();
    const scores = new Map<string, number>();
    for (const skill of visualTemplates) {
      const id = skill.category?.trim();
      if (!id) continue;
      counts.set(id, (counts.get(id) ?? 0) + 1);
      const doc = templateDocs.get(skill.id);
      const score = doc ? scoreTemplateDoc(doc, queryTokens) : 0;
      scores.set(id, (scores.get(id) ?? 0) + score);
    }
    return Array.from(counts.entries())
      .sort(
        (a, b) =>
          (scores.get(b[0]) ?? 0) - (scores.get(a[0]) ?? 0) || b[1] - a[1],
      )
      .map(([id]) => id);
  }, [visualTemplates, templateDocs, queryTokens]);

  const filteredTemplates = useMemo(
    () =>
      category === 'all'
        ? rankedTemplates
        : rankedTemplates.filter((skill) => skill.category === category),
    [category, rankedTemplates],
  );

  // Gallery text filter. Filtering uses plain per-word substring AND
  // (`tokenizeSearch`); ordering reuses the looser ranking tokenizer so the
  // best hit still floats up.
  const searchTokens = useMemo(() => tokenizeSearch(templateSearch), [templateSearch]);
  const searchRankTokens = useMemo(() => tokenizeQuery(templateSearch), [templateSearch]);
  const searchedTemplates = useMemo(
    () =>
      filterBySearch(
        filteredTemplates,
        searchTokens,
        searchRankTokens,
        (skill) => templateDocs.get(skill.id),
      ),
    [filteredTemplates, searchTokens, searchRankTokens, templateDocs],
  );

  // --- Design systems: the same pipeline, so both tabs behave identically ---

  // Design systems carry title / category / summary rather than triggers and
  // scenarios, but they feed the exact same doc shape and matcher.
  const designSystemDocs = useMemo(() => {
    const docs = new Map<string, TemplateMatchDoc>();
    for (const system of designSystems ?? []) {
      docs.set(
        system.id,
        buildTemplateMatchDoc({
          id: system.id,
          name: system.title,
          category: system.category,
          categoryLabel: system.category,
          description: system.summary,
        }),
      );
    }
    return docs;
  }, [designSystems]);

  // Every system ships four swatches, so vividness — not swatch count — is
  // what separates a striking palette from a beige one.
  const designSystemAppeal = useMemo(
    () => (system: DesignSystemSummary) => swatchVividness(system.swatches),
    [],
  );

  const rankedDesignSystems = useMemo(
    () =>
      rankByRelevance(
        designSystems ?? [],
        queryTokens,
        (system) => designSystemDocs.get(system.id),
        designSystemAppeal,
      ),
    [designSystems, queryTokens, designSystemDocs, designSystemAppeal],
  );

  const designSystemCategories = useMemo(() => {
    const counts = new Map<string, number>();
    const scores = new Map<string, number>();
    for (const system of designSystems ?? []) {
      const id = system.category?.trim();
      if (!id) continue;
      counts.set(id, (counts.get(id) ?? 0) + 1);
      const doc = designSystemDocs.get(system.id);
      scores.set(id, (scores.get(id) ?? 0) + (doc ? scoreTemplateDoc(doc, queryTokens) : 0));
    }
    return Array.from(counts.entries())
      .sort((a, b) => (scores.get(b[0]) ?? 0) - (scores.get(a[0]) ?? 0) || b[1] - a[1])
      .map(([id]) => id);
  }, [designSystems, designSystemDocs, queryTokens]);

  const filteredDesignSystems = useMemo(
    () =>
      dsCategory === 'all'
        ? rankedDesignSystems
        : rankedDesignSystems.filter((system) => system.category === dsCategory),
    [dsCategory, rankedDesignSystems],
  );

  /**
   * Seed the top-ranked template and design system as the default answer,
   * ONCE, the first time the catalogues are on screen with nothing picked.
   *
   * The guard is the whole point: `seededRef` latches on the first decision
   * either way, so re-ranking (a category chip, a search term) never moves
   * the user's selection, and clearing a pick is never undone on the next
   * render. Answered/locked forms and forms that arrive with a restored
   * value are latched without seeding, so history is never rewritten.
   */
  const seededRef = useRef(false);
  useEffect(() => {
    if (seededRef.current) return;
    if (disabled) return;
    if (value.length > 0 || files.length > 0) {
      seededRef.current = true;
      return;
    }
    const wantsTemplate = enabled.includes('templates');
    const wantsDesignSystem = enabled.includes('design-systems');
    // Wait for every catalogue this form offers, so the seed reflects the
    // full ranking rather than whichever fetch resolved first.
    if (wantsTemplate && templates === null) return;
    if (wantsDesignSystem && designSystems === null) return;
    const topTemplate = wantsTemplate ? rankedTemplates[0] : undefined;
    const topDesignSystem = wantsDesignSystem ? rankedDesignSystems[0] : undefined;
    if (!topTemplate && !topDesignSystem) return;
    seededRef.current = true;
    onChange([
      ...(topTemplate
        ? [inspirationEntryForTemplate(topTemplate.id, localizeSkillName(locale, topTemplate))]
        : []),
      ...(topDesignSystem
        ? [inspirationEntryForDesignSystem(topDesignSystem.id, topDesignSystem.title)]
        : []),
    ]);
  }, [
    disabled,
    enabled,
    templates,
    designSystems,
    rankedTemplates,
    rankedDesignSystems,
    value,
    files,
    locale,
    onChange,
  ]);

  const uploadUrls = useMemo(() => files.map((file) => URL.createObjectURL(file)), [files]);
  useEffect(
    () => () => {
      for (const url of uploadUrls) URL.revokeObjectURL(url);
    },
    [uploadUrls],
  );

  function categoryLabel(id: string): string {
    if (isCommercialCategoryId(id)) return commercialCategoryLabel(id, t);
    return id
      .split('-')
      .map((part) => (part ? part[0]!.toUpperCase() + part.slice(1) : part))
      .join(' ');
  }

  // Non-token entries in the answer are upload file names; template/ds picks
  // are the bracket-token entries. Clicking a selected card deselects it.
  function entriesWithout(kind: 'template' | 'ds'): string[] {
    return value.filter((entry) => {
      const parsed = parseInspirationSelection([entry]);
      if (kind === 'template') return parsed.templates.length === 0;
      return parsed.designSystems.length === 0;
    });
  }

  function toggleTemplate(skill: SkillSummary) {
    if (disabled) return;
    const rest = entriesWithout('template');
    if (selectedTemplateIds.has(skill.id)) {
      onChange(rest);
      return;
    }
    onChange([...rest, inspirationEntryForTemplate(skill.id, localizeSkillName(locale, skill))]);
  }

  // Single mode replaces the pick; multi mode (gallery "select multiple")
  // accumulates up to the cap — the first pick stays the primary system.
  function toggleDesignSystem(system: DesignSystemSummary, multi = dsMulti) {
    if (disabled) return;
    const rest = entriesWithout('ds');
    if (selectedDesignSystemIds.has(system.id)) {
      const kept = selection.designSystems.filter((entry) => entry.id !== system.id);
      onChange([...rest, ...kept.map((entry) => inspirationEntryForDesignSystem(entry.id, entry.label))]);
      return;
    }
    const current = multi ? selection.designSystems : [];
    if (multi && current.length >= INSPIRATION_MAX_DESIGN_SYSTEMS) return;
    onChange([
      ...rest,
      ...current.map((entry) => inspirationEntryForDesignSystem(entry.id, entry.label)),
      inspirationEntryForDesignSystem(system.id, system.title),
    ]);
  }

  function clearDesignSystems() {
    if (disabled) return;
    onChange(entriesWithout('ds'));
  }

  function removePick(kind: 'template' | 'ds', id: string) {
    if (disabled) return;
    onChange(
      value.filter((entry) => {
        const parsed = parseInspirationSelection([entry]);
        const match = kind === 'template' ? parsed.templates[0] : parsed.designSystems[0];
        return match?.id !== id;
      }),
    );
  }

  function applyFiles(next: File[]) {
    if (disabled) return;
    const capped = next.slice(0, INSPIRATION_MAX_UPLOADS);
    onFilesChange(capped);
    const tokens = value.filter((entry) => {
      const parsed = parseInspirationSelection([entry]);
      return parsed.templates.length > 0 || parsed.designSystems.length > 0;
    });
    onChange([...tokens, ...capped.map((file) => file.name)]);
  }

  function addFiles(added: FileList | File[]) {
    const images = Array.from(added).filter((file) => file.type.startsWith('image/'));
    if (images.length === 0) return false;
    const merged = [...files];
    for (const file of images) {
      if (merged.some((existing) => existing.name === file.name && existing.size === file.size)) {
        continue;
      }
      merged.push(file);
    }
    applyFiles(merged);
    return true;
  }

  function removeFile(index: number) {
    applyFiles(files.filter((_, i) => i !== index));
  }

  const selectionCount = (source: InspirationSource): number => {
    if (source === 'templates') return selection.templates.length;
    if (source === 'design-systems') return selection.designSystems.length;
    return files.length;
  };

  const tabLabel = (source: InspirationSource): string => {
    if (source === 'templates') return t('qf.inspTabTemplates');
    if (source === 'design-systems') return t('qf.inspTabDesignSystems');
    return t('qf.inspTabUpload');
  };

  const tabIcon = (source: InspirationSource) =>
    source === 'templates' ? 'slides' : source === 'design-systems' ? 'grid' : 'image';

  const inlineTemplates = filteredTemplates.slice(0, INLINE_GRID_SIZE);
  const inlineDesignSystems = filteredDesignSystems.slice(0, INLINE_GRID_SIZE);
  const remainingTemplates = Math.max(0, filteredTemplates.length - inlineTemplates.length);
  const remainingDesignSystems = Math.max(
    0,
    filteredDesignSystems.length - inlineDesignSystems.length,
  );

  // One search control, two catalogues: it reads and writes whichever tab
  // the gallery is currently showing.
  const galleryIsDs = tab === 'design-systems';
  const gallerySearch = galleryIsDs ? dsSearch : templateSearch;
  const setGallerySearch = galleryIsDs ? setDsSearch : setTemplateSearch;
  const gallerySearchLabel = galleryIsDs ? t('qf.inspSearchDs') : t('qf.inspSearchTpl');

  function openGallery() {
    setGalleryOpen(true);
    onGalleryOpen?.();
  }

  function closeGallery() {
    setGalleryOpen(false);
    setTemplateSearch('');
    setDsSearch('');
    setGallerySearchOpen(false);
  }

  // Expanding focuses the field; collapsing an already-empty field is the
  // "put it away" gesture. A field with text stays open on toggle so the
  // click cannot silently discard the query.
  function toggleGallerySearch() {
    if (gallerySearchOpen && gallerySearch.length === 0) {
      setGallerySearchOpen(false);
      return;
    }
    setGallerySearchOpen(true);
    window.setTimeout(() => gallerySearchRef.current?.focus(), 0);
  }

  function createDesignSystem() {
    setPendingDesignSystemCreateEntry('inspiration_picker');
    setGalleryOpen(false);
    navigate({ kind: 'design-system-create' });
  }

  const wireframeThumb = (mode: SkillSummary['mode']) =>
    mode === 'deck' ? (
      <span className="qf-preview-slide qf-preview-slide-hero">
        <span className="qf-preview-kicker" />
        <span className="qf-preview-title" />
        <span className="qf-preview-title qf-preview-title-short" />
        <span className="qf-preview-accent" />
      </span>
    ) : (
      <span className="qf-preview-app">
        <span className="qf-preview-appbar">
          <i />
          <i />
          <i />
        </span>
        <span className="qf-preview-app-body">
          <span className="qf-preview-content">
            <span className="qf-preview-content-head" />
            <span className="qf-preview-content-grid">
              <i />
              <i />
              <i />
            </span>
          </span>
        </span>
      </span>
    );

  const renderTemplateCard = (skill: SkillSummary, source: 'inline' | 'gallery') => {
    const selected = selectedTemplateIds.has(skill.id);
    const name = localizeSkillName(locale, skill);
    return (
      <label
        key={`${source}-${skill.id}`}
        className={`qf-insp-card${selected ? ' qf-insp-card-on' : ''}${disabled ? ' qf-insp-card-disabled' : ''}`}
        title={name}
      >
        <input
          type="checkbox"
          name={`${formId}-${questionId}-template`}
          checked={selected}
          disabled={disabled}
          aria-label={name}
          onChange={() => toggleTemplate(skill)}
        />
        <LiveDocThumb
          src={templatePreviewUrl(skill.id)}
          available
          fallback={wireframeThumb(skill.mode)}
          className="qf-insp-thumb"
        />
        {selected ? (
          <span className="qf-insp-card-check" aria-hidden>
            <Icon name="check" size={12} />
          </span>
        ) : null}
        {previewButton({ kind: 'template', id: skill.id, title: name })}
        <span className="qf-insp-card-name">{name}</span>
        {skill.category ? (
          <span className="qf-insp-card-meta">{categoryLabel(skill.category)}</span>
        ) : null}
      </label>
    );
  };

  const dsSwatchFallback = (system: DesignSystemSummary) => (
    <span className="qf-dsx-fallback">
      {(system.swatches && system.swatches.length > 0 ? system.swatches : ['transparent'])
        .slice(0, 6)
        .map((swatch, index) => (
          <span key={index} className="qf-card-swatch" style={{ background: swatch }} />
        ))}
    </span>
  );

  const renderDesignSystemCard = (
    system: DesignSystemSummary,
    source: 'inline' | 'gallery',
  ) => {
    const selected = selectedDesignSystemIds.has(system.id);
    return (
      <label
        key={`${source}-${system.id}`}
        className={`qf-insp-card qf-dsx-card${selected ? ' qf-insp-card-on' : ''}${disabled ? ' qf-insp-card-disabled' : ''}`}
        title={system.title}
        onMouseEnter={source === 'gallery' ? () => setDsPreviewId(system.id) : undefined}
      >
        <input
          type="checkbox"
          name={`${formId}-${questionId}-ds`}
          checked={selected}
          disabled={disabled}
          aria-label={system.title}
          onChange={() => toggleDesignSystem(system, source === 'gallery' ? dsMulti : false)}
        />
        <LiveDocThumb
          src={designSystemCardUrl(system.id)}
          available
          fallback={dsSwatchFallback(system)}
          className="qf-insp-thumb qf-dsx-thumb"
        />
        {selected ? (
          <span className="qf-insp-card-check" aria-hidden>
            <Icon name="check" size={12} />
          </span>
        ) : null}
        {previewButton({ kind: 'ds', id: system.id, title: system.title })}
        <span className="qf-insp-card-name">{system.title}</span>
      </label>
    );
  };

  // Selections made in the gallery may not be among the four inline cards,
  // so the picker always shows what is currently picked in a "Selected"
  // section at the bottom — rendered with the SAME card treatment as the
  // catalog (cover, title, category), plus a remove affordance.
  // Every card offers a detail preview — a dialog with the full document
  // (template seed / design-system showcase / image) so picking isn't blind.
  const previewButton = (
    target:
      | { kind: 'template' | 'ds'; id: string; title: string }
      | { kind: 'image'; url: string; title: string },
  ) => (
    <button
      type="button"
      className="qf-insp-card-eye"
      aria-label={`${t('qf.inspPreview')}: ${target.title}`}
      title={t('qf.inspPreview')}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        setDetail(target);
      }}
    >
      <Icon name="search" size={11} />
    </button>
  );

  const renderDetailDialog = () =>
    detail
      ? createPortal(
          <Dialog
            className="qf-visual-dialog qf-insp-detail-dialog"
            backdropClassName="qf-visual-dialog-backdrop"
            layout="sectioned"
            ariaLabel={detail.title}
            onClose={() => setDetail(null)}
            closeOnEscape
          >
            <DialogHeader className="qf-visual-dialog-head">
              <DialogTitle className="qf-visual-dialog-title">{detail.title}</DialogTitle>
              <Button
                type="button"
                variant="ghost"
                className="qf-visual-dialog-close"
                aria-label={t('common.close')}
                title={t('common.close')}
                onClick={() => setDetail(null)}
              >
                <Icon name="close" size={16} />
              </Button>
            </DialogHeader>
            <DialogBody className="qf-visual-dialog-body qf-insp-detail-body">
              {detail.kind === 'image' ? (
                <img className="qf-insp-detail-image" src={detail.url} alt={detail.title} />
              ) : (
                <iframe
                  className="qf-insp-detail-frame"
                  src={
                    detail.kind === 'template'
                      ? templatePreviewUrl(detail.id)
                      : designSystemCardUrl(detail.id)
                  }
                  sandbox="allow-scripts"
                  title={detail.title}
                />
              )}
            </DialogBody>
          </Dialog>,
          document.body,
        )
      : null;

  const removeButton = (label: string, onRemove: () => void) =>
    !disabled ? (
      <button
        type="button"
        className="qf-insp-card-remove"
        aria-label={`${t('qf.inspRemove')}: ${label}`}
        title={t('qf.inspRemove')}
        onClick={onRemove}
      >
        <Icon name="close" size={11} />
      </button>
    ) : null;

  const renderPickedSection = () => {
    const uploads: Array<{ name: string; url?: string; remove?: () => void }> = disabled
      ? // Locked summary: File objects are gone, but the image was uploaded
        // into the project, so resolve its served URL by its real path
        // (de-dup aware), falling back to the raw name.
        uploadNames.map((name) => ({
          name,
          url: projectId
            ? projectRawUrl(projectId, uploadPathByName?.[name] ?? name)
            : undefined,
        }))
      : files.map((file, index) => ({
          name: file.name,
          url: uploadUrls[index],
          remove: () => removeFile(index),
        }));
    const total = selection.templates.length + selection.designSystems.length + uploads.length;
    if (total === 0) return null;
    return (
      <div className="qf-insp-picked-section" data-testid="inspiration-picked">
        <div className="qf-insp-picked-label">{t('qf.inspPicked')}</div>
        <div className="qf-insp-grid qf-insp-picked-grid">
          {selection.templates.map((entry) => {
            const skill = (templates ?? []).find((item) => item.id === entry.id) ?? null;
            const label = skill ? localizeSkillName(locale, skill) : entry.label;
            return (
              <div key={`tpl-${entry.id}`} className="qf-insp-card qf-insp-card-picked" title={label}>
                <LiveDocThumb
                  src={templatePreviewUrl(entry.id)}
                  available={skill !== null}
                  fallback={wireframeThumb(skill?.mode ?? 'prototype')}
                  className="qf-insp-thumb"
                />
                {previewButton({ kind: 'template', id: entry.id, title: label })}
                {removeButton(label, () => removePick('template', entry.id))}
                <span className="qf-insp-card-name">{label}</span>
                {skill?.category ? (
                  <span className="qf-insp-card-meta">{categoryLabel(skill.category)}</span>
                ) : null}
              </div>
            );
          })}
          {selection.designSystems.map((entry) => {
            const system = (designSystems ?? []).find((item) => item.id === entry.id) ?? null;
            const label = system?.title ?? entry.label;
            return (
              <div key={`ds-${entry.id}`} className="qf-insp-card qf-insp-card-picked" title={label}>
                <LiveDocThumb
                  src={designSystemCardUrl(entry.id)}
                  available
                  fallback={
                    system ? (
                      dsSwatchFallback(system)
                    ) : (
                      <span className="qf-dsx-fallback" aria-hidden>
                        <span className="qf-card-swatch" />
                      </span>
                    )
                  }
                  className="qf-insp-thumb qf-dsx-thumb"
                />
                {previewButton({ kind: 'ds', id: entry.id, title: label })}
                {removeButton(label, () => removePick('ds', entry.id))}
                <span className="qf-insp-card-name">{label}</span>
                <span className="qf-insp-card-meta">{t('qf.inspTabDesignSystems')}</span>
              </div>
            );
          })}
          {uploads.map((upload, index) => (
            <div
              key={`img-${upload.name}-${index}`}
              className="qf-insp-card qf-insp-card-picked"
              title={upload.name}
            >
              <span className="qf-insp-thumb qf-insp-thumb-img" aria-hidden>
                {upload.url ? (
                  <img
                    src={upload.url}
                    alt=""
                    onError={(event) => {
                      // De-dup rename or deleted file: fall back to the icon.
                      const img = event.currentTarget;
                      img.style.display = 'none';
                      img.parentElement?.classList.add('qf-insp-thumb-img-broken');
                    }}
                  />
                ) : (
                  <Icon name="image" size={18} />
                )}
              </span>
              {upload.url
                ? previewButton({ kind: 'image', url: upload.url, title: upload.name })
                : null}
              {upload.remove ? removeButton(upload.name, upload.remove) : null}
              <span className="qf-insp-card-name">{upload.name}</span>
              <span className="qf-insp-card-meta">{t('qf.inspTabUpload')}</span>
            </div>
          ))}
        </div>
      </div>
    );
  };

  // One chip row serving both catalogues: templates use the commercial
  // category slugs (localized through `categoryLabel`), design systems use
  // their own already-human-readable category strings. Both are ordered by
  // relevance to the request upstream.
  const renderCategoryTabs = (idPrefix: string, kind: 'templates' | 'design-systems') => {
    const isDs = kind === 'design-systems';
    const ids = isDs ? designSystemCategories : categories;
    if (ids.length === 0) return null;
    const active = isDs ? dsCategory : category;
    const setActive = isDs ? setDsCategory : setCategory;
    const labelFor = (id: string) => (isDs ? id : categoryLabel(id));
    return (
      <div
        className="qf-insp-cats"
        role="tablist"
        aria-label={isDs ? t('qf.inspTabDesignSystems') : t('qf.inspTabTemplates')}
      >
        {['all', ...ids].map((id) => (
          <button
            key={`${idPrefix}-${id}`}
            type="button"
            role="tab"
            aria-selected={active === id}
            className={`qf-chip qf-insp-cat${active === id ? ' qf-chip-on' : ''}`}
            disabled={disabled}
            onClick={() => setActive(id)}
          >
            <span className="qf-chip-copy">
              <span>{id === 'all' ? t('qf.inspAll') : labelFor(id)}</span>
            </span>
          </button>
        ))}
      </div>
    );
  };

  const renderUploadSection = () => (
    <div className="qf-insp-upload">
      <button
        type="button"
        className={`qf-insp-dropzone${dragOver ? ' qf-insp-dropzone-over' : ''}`}
        disabled={disabled || files.length >= INSPIRATION_MAX_UPLOADS}
        onClick={() => fileInputRef.current?.click()}
        onDragOver={(event) => {
          event.preventDefault();
          event.stopPropagation();
          if (!disabled) setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setDragOver(false);
          if (!disabled) addFiles(event.dataTransfer.files);
        }}
      >
        <Icon name="image" size={16} />
        <span className="qf-insp-dropzone-cta">{t('qf.inspUploadCta')}</span>
        <span className="qf-insp-dropzone-limit">
          {t('qf.inspUploadLimit', { max: INSPIRATION_MAX_UPLOADS })}
        </span>
      </button>
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={(event) => {
          if (event.target.files) addFiles(event.target.files);
          event.target.value = '';
        }}
      />
      {files.length > 0 ? (
        <div className="qf-insp-upload-grid">
          {files.map((file, index) => (
            <figure key={`${file.name}-${index}`} className="qf-insp-upload-item">
              <img src={uploadUrls[index]} alt={file.name} />
              {!disabled ? (
                <button
                  type="button"
                  className="qf-insp-upload-remove"
                  aria-label={t('qf.inspRemove')}
                  title={t('qf.inspRemove')}
                  onClick={() => removeFile(index)}
                >
                  <Icon name="close" size={10} />
                </button>
              ) : null}
              <figcaption>{file.name}</figcaption>
            </figure>
          ))}
        </div>
      ) : null}
      <div className="qf-insp-sources">
        <span className="qf-insp-sources-label">{t('qf.inspSources')}</span>
        {INSPIRATION_BROWSE_SITES.map((site) => (
          <button
            key={site.id}
            type="button"
            className="qf-insp-source"
            disabled={disabled}
            onClick={() => {
              const handled = requestInspirationBrowse({ siteId: site.id, url: site.url });
              if (!handled && typeof window !== 'undefined') {
                window.open(site.url, '_blank', 'noopener');
              }
              setBrowseTipSite(site.label);
            }}
          >
            <span>{site.label}</span>
            <span aria-hidden>↗</span>
          </button>
        ))}
      </div>
      {browseTipSite ? (
        <div className="qf-insp-source-tip" role="status">
          <Icon name="image" size={12} />
          <span>{t('qf.inspSourceTip', { site: browseTipSite })}</span>
        </div>
      ) : null}
    </div>
  );

  const renderCatalogGrid = (
    items: Array<SkillSummary | DesignSystemSummary>,
    kind: 'templates' | 'design-systems',
    source: 'inline' | 'gallery',
    remaining: number,
  ) => {
    const loading = kind === 'templates' ? templates === null : designSystems === null;
    if (loading) {
      return <div className="qf-insp-status">{t('qf.inspLoading')}</div>;
    }
    if (items.length === 0) {
      return <div className="qf-insp-status">{t('qf.inspEmpty')}</div>;
    }
    return (
      <div className={source === 'inline' ? 'qf-insp-grid' : 'qf-insp-grid qf-insp-grid-gallery'}>
        {items.map((item) =>
          kind === 'templates'
            ? renderTemplateCard(item as SkillSummary, source)
            : renderDesignSystemCard(item as DesignSystemSummary, source),
        )}
        {source === 'inline' && remaining > 0 ? (
          <Button
            type="button"
            variant="ghost"
            className="qf-insp-more"
            disabled={disabled}
            aria-label={t('qf.inspBrowseAll')}
            title={t('qf.inspBrowseAll')}
            onClick={openGallery}
          >
            +{remaining}
          </Button>
        ) : null}
      </div>
    );
  };

  // --- Design-system gallery (the "+N" dialog) -----------------------------
  // Same search contract as the template gallery: multi-keyword AND across
  // title / category / summary, an OR fallback instead of an empty result,
  // and relevance + palette-vividness ordering. Run over the category-filtered
  // list so the chips and the search compose.
  const dsSearchTokens = tokenizeSearch(dsSearch);
  const dsSearchRankTokens = tokenizeQuery(dsSearch);
  const searchedDesignSystems = filterBySearch(
    filteredDesignSystems,
    dsSearchTokens,
    dsSearchRankTokens,
    (system) => designSystemDocs.get(system.id),
    designSystemAppeal,
  );
  const userSystems = searchedDesignSystems.filter(isUserDesignSystem);
  const includedSystems = searchedDesignSystems.filter(
    (system) => !isUserDesignSystem(system),
  );
  const previewSystem =
    (designSystems ?? []).find((system) => system.id === dsPreviewId)
    ?? (designSystems ?? []).find((system) => selectedDesignSystemIds.has(system.id))
    ?? (designSystems ?? [])[0]
    ?? null;

  const renderDesignSystemGallery = () => (
    <>
      {/* Search moved to the dialog header, shared with the template tab. */}
      <div className="qf-dsx-toolbar">
        <button
          type="button"
          className={`qf-dsx-tool${dsMulti ? ' qf-dsx-tool-on' : ''}`}
          aria-pressed={dsMulti}
          onClick={() => setDsMulti((prev) => !prev)}
        >
          <Icon name="check" size={12} />
          <span>{t('qf.inspSelectMultiple')}</span>
        </button>
        <button
          type="button"
          className="qf-dsx-tool"
          disabled={selection.designSystems.length === 0}
          onClick={clearDesignSystems}
        >
          <Icon name="close" size={12} />
          <span>{t('qf.inspClearSelection')}</span>
        </button>
        <span className="qf-dsx-toolbar-spacer" />
        <Button type="button" variant="ghost" onClick={createDesignSystem}>
          {t('qf.inspCreateDs')}
        </Button>
        <Button type="button" variant="primary" onClick={closeGallery}>
          {t('tool.done')}
        </Button>
      </div>
      <div className="qf-dsx-body">
        <div className="qf-dsx-list">
          {userSystems.length > 0 ? (
            <>
              <div className="qf-dsx-section">{t('qf.inspYourDs')}</div>
              <div className="qf-dsx-rows">
                {userSystems.map((system) => {
                  const selected = selectedDesignSystemIds.has(system.id);
                  return (
                    <button
                      key={`user-${system.id}`}
                      type="button"
                      className={`qf-dsx-row${selected ? ' qf-dsx-row-on' : ''}`}
                      onClick={() => toggleDesignSystem(system, dsMulti)}
                      onMouseEnter={() => setDsPreviewId(system.id)}
                    >
                      <span className="qf-dsx-row-avatar" aria-hidden>
                        {(system.swatches ?? []).slice(0, 3).map((swatch, index) => (
                          <i key={index} style={{ background: swatch }} />
                        ))}
                      </span>
                      <span className="qf-dsx-row-title">{system.title}</span>
                      {selected ? <Icon name="check" size={13} /> : null}
                    </button>
                  );
                })}
              </div>
            </>
          ) : null}
          <div className="qf-dsx-section">{t('qf.inspIncludedDs')}</div>
          {renderCatalogGrid(includedSystems, 'design-systems', 'gallery', 0)}
        </div>
        <div className="qf-dsx-preview">
          {previewSystem ? (
            <iframe
              key={previewSystem.id}
              className="qf-dsx-preview-frame"
              src={designSystemCardUrl(previewSystem.id)}
              title={previewSystem.title}
            />
          ) : null}
        </div>
      </div>
    </>
  );

  // Locked (answered) forms render as a compact read-only record of the
  // picks — the full catalog would be noise once the choice is made, but the
  // user must still see WHAT was chosen (template / systems / images).
  const lockedPickTotal =
    selection.templates.length + selection.designSystems.length + uploadNames.length;
  if (disabled && lockedPickTotal > 0) {
    return (
      <div className="qf-insp qf-insp-summary" data-testid="inspiration-picker">
        {query ? <div className="qf-insp-query">{query}</div> : null}
        {renderPickedSection()}
        {renderDetailDialog()}
      </div>
    );
  }

  return (
    <div
      className="qf-insp"
      data-testid="inspiration-picker"
      onPaste={(event) => {
        if (disabled || !enabled.includes('upload')) return;
        const pasted = Array.from(event.clipboardData?.files ?? []);
        if (pasted.length === 0) return;
        if (addFiles(pasted)) {
          event.preventDefault();
          setTab('upload');
        }
      }}
    >
      {query ? <div className="qf-insp-query">{query}</div> : null}
      {enabled.length > 1 ? (
        <div className="qf-insp-tabs" role="tablist">
          {enabled.map((source) => {
            const active = tab === source;
            const count = selectionCount(source);
            return (
              <button
                key={source}
                type="button"
                role="tab"
                aria-selected={active}
                className={`qf-insp-tab${active ? ' qf-insp-tab-active' : ''}`}
                onClick={() => setTab(source)}
              >
                <Icon name={tabIcon(source)} size={13} />
                <span>{tabLabel(source)}</span>
                {count > 0 ? <span className="qf-insp-tab-count">{count}</span> : null}
              </button>
            );
          })}
        </div>
      ) : null}
      {tab === 'templates' && enabled.includes('templates') ? (
        <>
          {renderCategoryTabs('inline', 'templates')}
          {renderCatalogGrid(inlineTemplates, 'templates', 'inline', remainingTemplates)}
        </>
      ) : null}
      {tab === 'design-systems' && enabled.includes('design-systems') ? (
        <>
          {renderCategoryTabs('inline-ds', 'design-systems')}
          {renderCatalogGrid(
            inlineDesignSystems,
            'design-systems',
            'inline',
            remainingDesignSystems,
          )}
        </>
      ) : null}
      {tab === 'upload' && enabled.includes('upload') ? renderUploadSection() : null}
      <div className="qf-insp-hint">
        <Icon name="image" size={12} />
        <span>{t('qf.inspUploadHint')}</span>
      </div>
      {renderPickedSection()}
      {galleryOpen
        ? createPortal(
            <Dialog
              className={`qf-visual-dialog qf-gal-dialog${tab === 'design-systems' ? ' qf-dsx-dialog' : ' qf-tplx-dialog'}`}
              backdropClassName="qf-visual-dialog-backdrop"
              layout="sectioned"
              ariaLabel={t('qf.inspBrowseAll')}
              onClose={closeGallery}
              closeOnEscape
            >
              <DialogHeader className="qf-visual-dialog-head">
                <DialogTitle className="qf-visual-dialog-title">
                  {tab === 'design-systems'
                    ? t('qf.inspTabDesignSystems')
                    : t('qf.inspTabTemplates')}
                </DialogTitle>
                <div className="qf-visual-dialog-head-tools">
                  <div
                    className={`qf-tplx-search${gallerySearchOpen ? ' is-open' : ''}`}
                    data-testid="inspiration-gallery-search"
                  >
                    <button
                      type="button"
                      className="qf-tplx-search-toggle"
                      aria-label={gallerySearchLabel}
                      title={gallerySearchLabel}
                      aria-expanded={gallerySearchOpen}
                      onClick={toggleGallerySearch}
                    >
                      <Icon name="search" size={14} />
                    </button>
                    <div className="qf-tplx-search-field">
                      <input
                        ref={gallerySearchRef}
                        type="text"
                        value={gallerySearch}
                        placeholder={gallerySearchLabel}
                        aria-label={gallerySearchLabel}
                        aria-hidden={!gallerySearchOpen}
                        tabIndex={gallerySearchOpen ? 0 : -1}
                        onChange={(event) => setGallerySearch(event.target.value)}
                        onBlur={() => {
                          if (gallerySearch.length === 0) setGallerySearchOpen(false);
                        }}
                        onKeyDown={(event) => {
                          if (event.key !== 'Escape') return;
                          // Escape empties the field before it closes the
                          // dialog, so a stray keypress never discards the
                          // whole browse session.
                          event.stopPropagation();
                          if (gallerySearch.length > 0) {
                            setGallerySearch('');
                            return;
                          }
                          setGallerySearchOpen(false);
                        }}
                      />
                    </div>
                    {gallerySearch.length > 0 ? (
                      <button
                        type="button"
                        className="qf-tplx-search-clear"
                        aria-label={t('common.clear')}
                        title={t('common.clear')}
                        // Clearing must not blur first, or the field would
                        // collapse before the user can type again.
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => {
                          setGallerySearch('');
                          gallerySearchRef.current?.focus();
                        }}
                      >
                        <Icon name="close" size={11} strokeWidth={2.2} />
                      </button>
                    ) : null}
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    className="qf-visual-dialog-close"
                    aria-label={t('common.close')}
                    title={t('common.close')}
                    onClick={closeGallery}
                  >
                    <Icon name="close" size={15} />
                  </Button>
                </div>
              </DialogHeader>
              <div className="qf-tplx-bar">
                {renderCategoryTabs('gallery', galleryIsDs ? 'design-systems' : 'templates')}
              </div>
              <DialogBody className="qf-visual-dialog-body">
                {galleryIsDs
                  ? renderDesignSystemGallery()
                  : renderCatalogGrid(searchedTemplates, 'templates', 'gallery', 0)}
              </DialogBody>
              {tab === 'design-systems' ? null : (
                <DialogFooter className="qf-visual-dialog-foot">
                  <Button type="button" variant="primary" onClick={closeGallery}>
                    {t('tool.done')}
                  </Button>
                </DialogFooter>
              )}
            </Dialog>,
            document.body,
          )
        : null}
      {renderDetailDialog()}
    </div>
  );
}
