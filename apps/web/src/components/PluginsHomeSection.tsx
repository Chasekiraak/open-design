// Plugins discovery section on Home.
//
// Renders an artifact-kind bar over the plugin catalog: Prototype ·
// Slides · Image · Video · HyperFrames · Audio. Prototype, Slides,
// Image, and Video can reveal scene buckets from the user-prompt
// taxonomy; HyperFrames and Audio stay flat. A small Saved chip
// sits orthogonal to the rows for quick access to user-saved picks.
//
// The category list is curated — finer metadata (surface, role tags,
// scenario domains) lives on each plugin card and detail surface.
//
// Derivation, catalog building and category-based filtering live in
// `./plugins-home/facets.ts`; selection state and the Saved
// override live in `./plugins-home/usePluginFacets.ts`. This file
// owns layout only.

import { Button, Input } from '@open-design/components';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { InstalledPluginRecord } from '@open-design/contracts';
import { useI18n, useT } from '../i18n';
import type { PluginShareAction } from '../state/projects';
import { Icon } from './Icon';
import { PluginCard } from './plugins-home/PluginCard';
import { isFeaturedPlugin, type FacetOption } from './plugins-home/facets';
import { localizePluginTitle } from './plugins-home/localization';
import { usePluginFacets } from './plugins-home/usePluginFacets';
import { pluginSubfacetLabel } from './plugins-home/subfacetLabel';
import { useSavedPluginIds } from './plugins-home/savedPlugins';
import { DEFAULT_PLUGIN_SORT_ORDER, type PluginSortOrder } from './plugins-home/sortOrder';
import { useScrollEdges } from './plugins-home/useScrollEdges';
import type { PluginUseAction } from './plugins-home/useActions';
import { Toast } from './Toast';
import { AnimatePresence, motion } from 'motion/react';
import { popoverIn } from '../motion';

const RICH_PLUGIN_RENDER_LIMIT = 60;
const RICH_PLUGIN_RENDER_BATCH_SIZE = 60;
const GALLERY_PLUGIN_RENDER_LIMIT = 12;
const GALLERY_PLUGIN_RENDER_BATCH_SIZE = 12;

interface Props {
  plugins: InstalledPluginRecord[];
  loading: boolean;
  activePluginId: string | null;
  pendingApplyId: string | null;
  pendingDuplicateId?: string | null;
  pendingShareAction?: { pluginId: string; action: PluginShareAction } | null;
  onUse: (record: InstalledPluginRecord, action: PluginUseAction) => void;
  onDuplicate?: (record: InstalledPluginRecord) => void;
  onOpenDetails: (record: InstalledPluginRecord) => void;
  onPluginShareAction?: (
    record: InstalledPluginRecord,
    action: PluginShareAction,
  ) => void;
  onBrowseRegistry?: () => void;
  preferDefaultFacet?: boolean;
  title?: string;
  subtitle?: string;
  emptyMessage?: string;
  // 'gallery' renders each card as a minimal live example.html preview
  // tile (Community); 'rich' keeps the hover-overlay metadata card.
  cardLayout?: 'rich' | 'gallery';
}

export function PluginsHomeSection({
  plugins,
  loading,
  activePluginId,
  pendingApplyId,
  pendingDuplicateId = null,
  pendingShareAction = null,
  onUse,
  onDuplicate,
  onOpenDetails,
  onPluginShareAction,
  onBrowseRegistry,
  preferDefaultFacet = true,
  title,
  subtitle,
  emptyMessage,
  cardLayout = 'rich',
}: Props) {
  const { locale, t } = useI18n();
  const { savedPluginIds, savePluginId } = useSavedPluginIds();
  const [saveToast, setSaveToast] = useState<string | null>(null);
  const initialRenderLimit =
    cardLayout === 'gallery' ? GALLERY_PLUGIN_RENDER_LIMIT : RICH_PLUGIN_RENDER_LIMIT;
  const renderBatchSize =
    cardLayout === 'gallery' ? GALLERY_PLUGIN_RENDER_BATCH_SIZE : RICH_PLUGIN_RENDER_BATCH_SIZE;
  const loadMoreRootMargin = cardLayout === 'gallery' ? '900px' : '640px';
  const [renderLimit, setRenderLimit] = useState(initialRenderLimit);
  const loadMoreRef = useRef<HTMLDivElement | null>(null);
  const {
    visiblePlugins,
    savedList,
    filtered,
    catalog,
    selection,
    pickCategory,
    pickSubcategory,
    clearFacets,
    mode,
    setMode,
    query,
    setQuery,
    sortOrder,
    setSortOrder,
    totalVisible,
  } = usePluginFacets({
    plugins,
    savedPluginIds,
    preferDefaultFacet: cardLayout === 'gallery' ? false : preferDefaultFacet,
    locale,
  });
  const renderedPlugins = useMemo(
    () => filtered.slice(0, renderLimit),
    [filtered, renderLimit],
  );
  const hasMorePlugins = renderLimit < filtered.length;
  const handlePickCategory = (slug: string | null): void => {
    pickCategory(slug);
  };

  useEffect(() => {
    setRenderLimit(initialRenderLimit);
  }, [filtered, initialRenderLimit]);

  useEffect(() => {
    if (!hasMorePlugins) return;
    const node = loadMoreRef.current;
    if (!node) return;
    if (typeof IntersectionObserver === 'undefined') {
      setRenderLimit(filtered.length);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        setRenderLimit((limit) =>
          Math.min(filtered.length, limit + renderBatchSize),
        );
      },
      { rootMargin: loadMoreRootMargin },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [filtered.length, hasMorePlugins, loadMoreRootMargin, renderBatchSize]);

  function handleSavePlugin(record: InstalledPluginRecord): void {
    const result = savePluginId(record.id);
    const title = localizePluginTitle(locale, record);
    if (result === 'saved') {
      setSaveToast(`Saved ${title}.`);
    } else if (result === 'already-saved') {
      setSaveToast(`${title} is already saved.`);
    } else {
      setSaveToast('Could not save this plugin in this browser.');
    }
  }

  return (
    <section className="plugins-home" data-testid="plugins-home-section">
      <header className="plugins-home__head">
        <div className="plugins-home__heading">
          <h2 className="plugins-home__title">{title ?? t('pluginsHome.title')}</h2>
          {subtitle ? (
            <p className="plugins-home__subtitle">{subtitle}</p>
          ) : null}
        </div>
        <div className="plugins-home__head-tools">
          {onBrowseRegistry ? (
            <button
              type="button"
              className="plugins-home__linkbtn"
              onClick={onBrowseRegistry}
              data-testid="plugins-home-browse-registry"
            >
              {t('pluginsHome.browseRegistry')}
            </button>
          ) : null}
        </div>
      </header>

      {loading ? (
        <div className="plugins-home__empty">{t('pluginsHome.loadingCatalog')}</div>
      ) : visiblePlugins.length === 0 ? (
        <div className="plugins-home__empty">
          {emptyMessage ?? t('pluginsHome.emptyCatalog')}
        </div>
      ) : (
        <>
          <div
            className="plugins-home__facets"
            role="group"
            aria-label="Plugin filters"
          >
            <CategoryRow
              options={catalog.category}
              selectedSlug={selection.category}
              totalVisible={totalVisible}
              // The Saved collection lives on the rich management surface
              // (PluginsView). The minimal Community gallery has no per-card
              // save affordance, so the orthogonal Saved chip is hidden there.
              showSaved={cardLayout === 'rich'}
              savedCount={savedList.length}
              savedActive={mode === 'saved'}
              onToggleSaved={() =>
                setMode(mode === 'saved' ? 'all' : 'saved')
              }
              showAll
              query={query}
              onQueryChange={setQuery}
              sortOrder={sortOrder}
              onSortOrderChange={setSortOrder}
              onPick={handlePickCategory}
            />
            {selection.category ? (
              <SubcategoryRow
                parent={catalog.category.find((opt) => opt.slug === selection.category)}
                options={catalog.subcategory[selection.category] ?? []}
                selectedSlug={selection.subcategory}
                onPick={pickSubcategory}
              />
            ) : null}
          </div>

          {filtered.length === 0 ? (
            <div className="plugins-home__empty plugins-home__empty--filtered">
              {t('pluginsHome.emptyFiltered')}{' '}
              <button
                type="button"
                className="plugins-home__linkbtn"
                onClick={clearFacets}
              >
                {t('pluginsHome.clearFilters')}
              </button>
            </div>
          ) : (
            <div
              className={`plugins-home__grid${cardLayout === 'gallery' ? ' plugins-home__grid--gallery' : ''}`}
              role="list"
            >
              {renderedPlugins.map((p) => (
                <PluginCard
                  key={p.id}
                  record={p}
                  isActive={activePluginId === p.id}
                  isPending={pendingApplyId === p.id}
                  pendingAny={pendingApplyId !== null}
                  isDuplicatePending={pendingDuplicateId === p.id}
                  pendingDuplicateAny={pendingDuplicateId !== null}
                  pendingShareAction={pendingShareAction}
                  isFeatured={isFeaturedPlugin(p)}
                  isSaved={savedPluginIds.has(p.id)}
                  onUse={onUse}
                  onDuplicate={onDuplicate}
                  onOpenDetails={onOpenDetails}
                  onSave={handleSavePlugin}
                  onShareAction={onPluginShareAction}
                  layout={cardLayout}
                />
              ))}
              {hasMorePlugins ? (
                <div
                  ref={loadMoreRef}
                  className="plugins-home__load-more-sentinel"
                  aria-hidden
                />
              ) : null}
            </div>
          )}
        </>
      )}
      <AnimatePresence>
        {saveToast ? (
          <Toast
            message={saveToast}
            ttlMs={2200}
            onDismiss={() => setSaveToast(null)}
          />
        ) : null}
      </AnimatePresence>
    </section>
  );
}

interface CategoryRowProps {
  options: FacetOption[];
  selectedSlug: string | null;
  totalVisible: number;
  onPick: (slug: string | null) => void;
  // The Saved override chip only renders on the rich management surface
  // (PluginsView); the minimal Community gallery hides it.
  showSaved: boolean;
  savedCount: number;
  savedActive: boolean;
  onToggleSaved: () => void;
  showAll: boolean;
  query: string;
  onQueryChange: (next: string) => void;
  sortOrder: PluginSortOrder;
  onSortOrderChange: (next: PluginSortOrder) => void;
}

// Single combined filter bar: an optional Saved override chip + category
// pills on the left, sort toggle + search field on the right. The "All"
// pill doubles as a clear-filters affordance, so a separate `X / Y`
// counter and `Clear` link would just repeat what the pill strip already
// shows.
function CategoryRow({
  options,
  selectedSlug,
  totalVisible,
  onPick,
  showSaved,
  savedCount,
  savedActive,
  onToggleSaved,
  showAll,
  query,
  onQueryChange,
  sortOrder,
  onSortOrderChange,
}: CategoryRowProps) {
  const t = useT();
  if (options.length === 0) return null;
  return (
    <div
      className="plugins-home__facet-row plugins-home__facet-row--inline"
      data-testid="plugins-home-row-category"
    >
      <FacetPills
        ariaLabel={t('pluginsHome.categoryFilterAria')}
        contentKey={`${options.length}:${showSaved}:${showAll}`}
      >
        {showSaved ? (
          <button
            type="button"
            className={[
              'plugins-home__chip',
              'plugins-home__chip--saved',
              savedActive ? 'is-active' : '',
            ]
              .filter(Boolean)
              .join(' ')}
            onClick={onToggleSaved}
            aria-pressed={savedActive}
            data-testid="plugins-home-chip-saved"
          >
            <Icon name="star" size={11} />
            <span>{t('pluginsHome.featured')}</span>
            <span className="plugins-home__chip-count">{savedCount}</span>
          </button>
        ) : null}
        {showAll ? (
          <CategoryPill
            slug={null}
            label={t('common.all')}
            count={totalVisible}
            active={selectedSlug === null}
            onPick={onPick}
            variant="all"
          />
        ) : null}
        {options.map((opt) => (
          <CategoryPill
            key={opt.slug}
            slug={opt.slug}
            label={opt.label}
            count={opt.count}
            active={selectedSlug === opt.slug}
            onPick={onPick}
          />
        ))}
      </FacetPills>
      <div className="plugins-home__facet-tools">
        <SortMenu value={sortOrder} onChange={onSortOrderChange} />
        <SearchField value={query} onChange={onQueryChange} />
      </div>
    </div>
  );
}

interface FacetPillsProps {
  ariaLabel: string;
  // Changes whenever the rendered pill set does, so the overflow fades
  // re-measure after a category swap replaces the strip's contents.
  contentKey: string;
  children: ReactNode;
}

// Single-line pill strip. Chips scroll horizontally instead of wrapping,
// so the filter bar keeps one fixed row no matter how many scenes a
// category exposes — the deck lane alone carries fourteen.
function FacetPills({ ariaLabel, contentKey, children }: FacetPillsProps) {
  const { ref, edges } = useScrollEdges<HTMLDivElement>(contentKey);
  return (
    <div
      ref={ref}
      className="plugins-home__facet-pills"
      role="tablist"
      aria-label={ariaLabel}
      data-overflow-start={edges.start ? 'true' : 'false'}
      data-overflow-end={edges.end ? 'true' : 'false'}
    >
      {children}
    </div>
  );
}

interface SubcategoryRowProps {
  parent: FacetOption | undefined;
  options: FacetOption[];
  selectedSlug: string | null;
  onPick: (slug: string | null) => void;
}

function SubcategoryRow({ parent, options, selectedSlug, onPick }: SubcategoryRowProps) {
  const t = useT();
  if (!parent || options.length === 0) return null;
  return (
    <div
      className="plugins-home__facet-row plugins-home__facet-row--inline plugins-home__facet-row--sub"
      data-testid={`plugins-home-row-subcategory-${parent.slug}`}
    >
      <FacetPills
        ariaLabel={t('pluginsHome.subcategoryFilterAria', { label: parent.label })}
        contentKey={`${parent.slug}:${options.length}`}
      >
        <CategoryPill
          slug={null}
          label={t('pluginsHome.allCategory', { label: pluginFacetLabel(parent.slug, parent.label, t) })}
          count={parent.count}
          active={selectedSlug === null}
          onPick={onPick}
          variant="sub-all"
          testId={`plugins-home-pill-subcategory-${parent.slug}-all`}
        />
        {options.map((opt) => (
          <CategoryPill
            key={opt.slug}
            slug={opt.slug}
            label={opt.label}
            count={opt.count}
            active={selectedSlug === opt.slug}
            onPick={onPick}
            testId={`plugins-home-pill-subcategory-${parent.slug}-${opt.slug}`}
          />
        ))}
      </FacetPills>
    </div>
  );
}

interface CategoryPillProps {
  slug: string | null;
  label: string;
  count: number;
  active: boolean;
  variant?: 'all' | 'sub-all';
  testId?: string;
  onPick: (slug: string | null) => void;
}

function CategoryPill({ slug, label, count, active, variant, testId, onPick }: CategoryPillProps) {
  const t = useT();
  const displayLabel = slug ? pluginFacetLabel(slug, label, t) : label;
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      className={[
        'plugins-home__pill',
        active ? 'is-active' : '',
        variant === 'all' ? 'plugins-home__pill--all' : '',
        variant === 'sub-all' ? 'plugins-home__pill--sub-all' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      onClick={() => onPick(slug)}
      // Planned child buckets stay visible even before the catalog
      // has examples for each scene. The `data-empty` flag gives
      // those zero-count buckets a lighter treatment without adding
      // placeholder cards to the starter grid.
      data-empty={count === 0 ? 'true' : 'false'}
      data-testid={testId ?? `plugins-home-pill-category-${slug ?? 'all'}`}
    >
      <span>{displayLabel}</span>
      <span className="plugins-home__pill-count">{count}</span>
    </button>
  );
}

function pluginFacetLabel(slug: string, fallback: string, t: ReturnType<typeof useT>): string {
  switch (slug) {
    case 'import': return t('pluginsHome.facet.import');
    case 'create': return t('pluginsHome.facet.create');
    case 'export': return t('pluginsHome.facet.export');
    case 'share': return t('pluginsHome.facet.share');
    case 'deploy': return t('pluginsHome.facet.deploy');
    case 'refine': return t('pluginsHome.facet.refine');
    case 'extend': return t('pluginsHome.facet.extend');
    case 'from-figma': return t('pluginsHome.facet.figma');
    case 'from-github': return t('pluginsHome.facet.github');
    case 'from-code': return t('pluginsHome.facet.codeFolder');
    case 'from-url': return t('pluginsHome.facet.url');
    case 'from-screenshot': return t('pluginsHome.facet.screenshot');
    case 'from-pdf': return t('pluginsHome.facet.pdf');
    case 'from-pptx': return t('pluginsHome.facet.pptx');
    case 'from-framer': return t('pluginsHome.facet.framer');
    case 'from-webflow': return t('pluginsHome.facet.webflow');
    case 'prototype': return t('homeHero.chip.prototype');
    case 'deck': return t('pluginsHome.facet.slides');
    case 'design-system': return t('entry.navDesignSystems');
    case 'hyperframes': return t('homeHero.chip.hyperframes');
    case 'image': return t('homeHero.chip.image');
    case 'video': return t('homeHero.chip.video');
    case 'audio': return t('homeHero.chip.audio');
    case 'public-link': return t('pluginsHome.facet.publicLink');
    case 'github-pr': return t('pluginsHome.facet.githubPr');
    case 'github-gist': return t('pluginsHome.facet.githubGist');
    // Subcategory pills render through the same CategoryPill, so unknown
    // top-level slugs fall through to the subfacet table before giving up.
    default: return pluginSubfacetLabel(slug, fallback, t);
  }
}

interface SortMenuProps {
  value: PluginSortOrder;
  onChange: (next: PluginSortOrder) => void;
}

// Hot / newest ordering, collapsed behind a filter icon. Both orders used
// to sit exposed as a two-segment pill, but paired with the search field
// they ate the width the category strip needs to stay on one line — and
// sort is a set-once preference (it persists per browser via
// `sortOrder.ts`), not something worth permanent chrome. The trigger
// carries a dot whenever the pick is off the default so the collapsed
// state still says an order is in force.
function SortMenu({ value, onChange }: SortMenuProps) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const segments: Array<{ order: PluginSortOrder; label: string }> = [
    { order: 'hot', label: t('pluginsHome.sortHot') },
    { order: 'newest', label: t('pluginsHome.sortNewest') },
  ];

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (!wrapRef.current) return;
      if (wrapRef.current.contains(e.target as Node)) return;
      setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="plugins-home__sort" ref={wrapRef} data-testid="plugins-home-sort">
      <button
        type="button"
        className="plugins-home__icon-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t('pluginsHome.sortAria')}
        title={t('pluginsHome.sortAria')}
        data-active={value !== DEFAULT_PLUGIN_SORT_ORDER ? 'true' : 'false'}
        onClick={() => setOpen((v) => !v)}
        data-testid="plugins-home-sort-trigger"
      >
        <Icon name="filter" size={14} />
      </button>
      <AnimatePresence>
        {open ? (
          <motion.div
            className="plugins-home__sort-menu"
            role="menu"
            aria-label={t('pluginsHome.sortAria')}
            variants={popoverIn}
            initial="hidden"
            animate="visible"
            exit="exit"
            data-testid="plugins-home-sort-menu"
          >
            {segments.map((segment) => (
              <button
                key={segment.order}
                type="button"
                role="menuitemradio"
                aria-checked={value === segment.order}
                className={`plugins-home__sort-item${value === segment.order ? ' is-active' : ''}`}
                onClick={() => {
                  onChange(segment.order);
                  setOpen(false);
                }}
                data-testid={`plugins-home-sort-${segment.order}`}
              >
                <span>{segment.label}</span>
                {value === segment.order ? (
                  <Icon name="check" size={12} aria-hidden />
                ) : null}
              </button>
            ))}
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

interface SearchFieldProps {
  value: string;
  onChange: (next: string) => void;
}

// Search collapsed behind its own icon. Search composes with the category
// selection via AND inside the hook, so a query narrows whatever category
// the user has already picked rather than discarding the category
// context. Collapsed, the field is a single icon button; the 200px input
// only claims width once someone actually reaches for it, which is what
// lets the category strip own the rest of the row.
//
// Both states stay mounted and swap a class, so the width transition
// plays in each direction — a React unmount would skip the exit entirely.
function SearchField({ value, onChange }: SearchFieldProps) {
  const t = useT();
  const [expanded, setExpanded] = useState(value.length > 0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // A query set from outside (restored state, or a category swap that keeps
  // the query) must force the field open: an active filter with no visible
  // control reads as an empty gallery with no explanation.
  useEffect(() => {
    if (value) setExpanded(true);
  }, [value]);

  function openSearch(): void {
    setExpanded(true);
    // Focus on the next frame so the caret lands in a field that is already
    // growing rather than one still at zero width.
    requestAnimationFrame(() => inputRef.current?.focus());
  }

  // Collapse on blur only while empty. A live query keeps the field open so
  // the user can see what is narrowing the grid, and can edit it back out.
  function handleBlur(): void {
    if (!value) setExpanded(false);
  }

  return (
    <div
      className={`plugins-home__search${expanded ? ' is-expanded' : ''}`}
      data-testid="plugins-home-search-field"
    >
      <button
        type="button"
        className="plugins-home__icon-btn plugins-home__search-toggle"
        aria-label={t('pluginsHome.searchAria')}
        title={t('pluginsHome.searchAria')}
        aria-expanded={expanded}
        data-active={value ? 'true' : 'false'}
        // Expanded, the icon is the field's own adornment — clicking it
        // should put the caret back in the input, not tear the field down
        // with the user's query still in it.
        onClick={expanded ? () => inputRef.current?.focus() : openSearch}
        data-testid="plugins-home-search-toggle"
      >
        <Icon name="search" size={14} />
      </button>
      <Input
        ref={inputRef}
        type="search"
        className="plugins-home__search-input"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={handleBlur}
        onKeyDown={(e) => {
          if (e.key !== 'Escape') return;
          // Escape clears then closes in one press; blur alone would only
          // close a field the user had already emptied by hand.
          onChange('');
          setExpanded(false);
          inputRef.current?.blur();
        }}
        placeholder={t('pluginsHome.searchPlaceholder')}
        aria-label={t('pluginsHome.searchAria')}
        data-testid="plugins-home-search"
        spellCheck={false}
        autoComplete="off"
        // Keep the collapsed input out of the tab order and off the
        // accessibility tree; the toggle above is the control at that size.
        tabIndex={expanded ? undefined : -1}
        aria-hidden={expanded ? undefined : true}
      />
      {expanded && value ? (
        <Button
          variant="subtle"
          className="plugins-home__search-clear"
          // Clearing must not take focus off the input: the default
          // mousedown blur would fire first, collapse the still-empty
          // field, and unmount this button before its click ever landed.
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            onChange('');
            inputRef.current?.focus();
          }}
          aria-label={t('pluginsHome.clearSearch')}
          data-testid="plugins-home-search-clear"
        >
          <Icon name="close" size={12} />
        </Button>
      ) : null}
    </div>
  );
}
