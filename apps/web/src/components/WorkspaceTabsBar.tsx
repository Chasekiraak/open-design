import {
  type DragEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { useT } from '../i18n';
import { navigate, type EntryHomeView, type Route } from '../router';
import type { Project } from '../types';
import { Icon, type IconName } from './Icon';
import {
  HOME_APPLY_TEMPLATE_EVENT,
  orderedCreateChips,
  type HomeHeroChip,
} from './home-hero/chips';
import {
  ENTRY_RAIL_STATE_EVENT,
  ENTRY_RAIL_TOGGLE_EVENT,
  readStoredRailOpen,
} from './entryRailBridge';
import { homeHeroChipLabel } from './home-hero/chip-labels';
import { useGlideIndicator } from '../hooks/useGlideIndicator';
import { useLiquidGlass } from '../hooks/useLiquidGlass';

type WorkspaceChromeTab =
  | {
      id: string;
      kind: 'entry';
      view: EntryHomeView;
      createdAt: number;
      lastActiveAt: number;
    }
  | {
      id: string;
      kind: 'project';
      projectId: string;
      conversationId: string | null;
      fileName: string | null;
      createdAt: number;
      lastActiveAt: number;
    }
  | {
      id: string;
      kind: 'marketplace';
      pluginId: string | null;
      createdAt: number;
      lastActiveAt: number;
    };

interface WorkspaceTabsState {
  tabs: WorkspaceChromeTab[];
  activeTabId: string;
}

interface DisplayTab {
  id: string;
  title: string;
  meta: string;
  icon: IconName;
  tab: WorkspaceChromeTab;
}

type TabDropEdge = 'before' | 'after';

interface TabDragTarget {
  tabId: string;
  edge: TabDropEdge;
}

interface Props {
  route: Route;
  projects: Project[];
  // Once onboarding is finished, the permanent entry
  // tab must never linger on the 'onboarding' (Welcome) view — some completion
  // paths navigate straight to a new project/design-system and leave the entry
  // tab showing Welcome in the background. This flips it back to Home.
  onboardingCompleted?: boolean;
  /**
   * Stable "AMR account + active workspace" identity key the currently open
   * tabs belong to (derived in App.tsx from `amrLoginStatus` +
   * `workspaceContext` — see the comment there for the exact composition).
   * `null` means "not resolved yet" (before the first AMR status read
   * completes): the bar leaves whatever it already restored from
   * localStorage untouched rather than guessing.
   *
   * Once resolved, a value that differs from whatever this bar last
   * persisted closes every open tab down to a single fresh Home tab — see
   * the effect that watches this prop below for the full rationale. Signing
   * out, signing in as a different account, switching workspace, or simply
   * never having signed into AMR at all are each their own scope; a tab
   * opened under one must not silently keep pointing at a project/section
   * the next identity has no standing to see.
   */
  identityScopeKey?: string | null;
}

const STORAGE_KEY = 'open-design:workspace-tabs:v1';
const OPEN_WORKSPACE_TAB_EVENT = 'open-design:workspace-tabs:open';
const MAX_SEARCH_RESULTS = 80;
const TAB_DRAG_HAPTIC_MS = 8;
const TAB_DROP_HAPTIC_MS = 12;

function consumeWorkspaceTabShortcut(event: KeyboardEvent) {
  event.preventDefault();
  event.stopPropagation();
}

function shouldDeferShortcutToProjectWorkspace(): boolean {
  if (typeof document === 'undefined') return false;
  return document.querySelector('[data-testid="file-workspace"]') !== null;
}

export function openWorkspaceTab(route: Route): void {
  window.dispatchEvent(
    new CustomEvent<{ route: Route }>(OPEN_WORKSPACE_TAB_EVENT, {
      detail: { route },
    }),
  );
}

function nowId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function createEntryTab(view: EntryHomeView, timestamp = Date.now()): WorkspaceChromeTab {
  return {
    id: `entry:${view}:${nowId()}`,
    kind: 'entry',
    view,
    createdAt: timestamp,
    lastActiveAt: timestamp,
  };
}

function tabFromRoute(route: Route, timestamp = Date.now()): WorkspaceChromeTab {
  if (route.kind === 'project') {
    return {
      id: `project:${route.projectId}:${nowId()}`,
      kind: 'project',
      projectId: route.projectId,
      conversationId: route.conversationId ?? null,
      fileName: route.fileName,
      createdAt: timestamp,
      lastActiveAt: timestamp,
    };
  }
  if (route.kind === 'marketplace' || route.kind === 'marketplace-detail') {
    const pluginId = route.kind === 'marketplace-detail' ? route.pluginId : null;
    return {
      id: `marketplace:${pluginId ?? 'index'}:${nowId()}`,
      kind: 'marketplace',
      pluginId,
      createdAt: timestamp,
      lastActiveAt: timestamp,
    };
  }
  return createEntryTab(route.kind === 'home' ? route.view : 'design-systems', timestamp);
}

function routeForTab(tab: WorkspaceChromeTab): Route {
  if (tab.kind === 'project') {
    return {
      kind: 'project',
      projectId: tab.projectId,
      conversationId: tab.conversationId,
      fileName: tab.fileName,
    };
  }
  if (tab.kind === 'marketplace') {
    return tab.pluginId
      ? { kind: 'marketplace-detail', pluginId: tab.pluginId }
      : { kind: 'marketplace' };
  }
  return { kind: 'home', view: tab.view };
}

function reviveTab(value: unknown): WorkspaceChromeTab | null {
  if (value === null || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const id = typeof record.id === 'string' ? record.id : '';
  const createdAt = typeof record.createdAt === 'number' ? record.createdAt : Date.now();
  const lastActiveAt = typeof record.lastActiveAt === 'number' ? record.lastActiveAt : createdAt;
  if (!id) return null;
  if (record.kind === 'entry') {
    const view = record.view;
    if (
      view === 'home'
      || view === 'projects'
      || view === 'tasks'
      || view === 'plugins'
      || view === 'design-systems'
      || view === 'integrations'
    ) {
      return { id, kind: 'entry', view, createdAt, lastActiveAt };
    }
  }
  if (record.kind === 'project' && typeof record.projectId === 'string') {
    return {
      id,
      kind: 'project',
      projectId: record.projectId,
      conversationId: typeof record.conversationId === 'string' ? record.conversationId : null,
      fileName: typeof record.fileName === 'string' ? record.fileName : null,
      createdAt,
      lastActiveAt,
    };
  }
  if (record.kind === 'marketplace') {
    return {
      id,
      kind: 'marketplace',
      pluginId: typeof record.pluginId === 'string' ? record.pluginId : null,
      createdAt,
      lastActiveAt,
    };
  }
  return null;
}

function uniqueIdForTab(tab: WorkspaceChromeTab): string {
  if (tab.kind === 'project') return `project:${tab.projectId}:${nowId()}`;
  if (tab.kind === 'marketplace') {
    return `marketplace:${tab.pluginId ?? 'index'}:${nowId()}`;
  }
  return `entry:${tab.view}:${nowId()}`;
}

function normalizeTabsState(state: WorkspaceTabsState): WorkspaceTabsState {
  let sourceTabs = state.tabs.length > 0 ? state.tabs : [createEntryTab('home')];

  // Deduplicate entry tabs (singleton constraint): all sidebar sections
  // (home / projects / tasks / design-systems / plugins / integrations) share
  // ONE entry tab that switches its view in place. Keep the canonical one:
  // 1. Is one of them currently active?
  // 2. Otherwise, pick the one with highest lastActiveAt.
  // 3. Otherwise, pick the first one.
  const entryTabs = sourceTabs.filter((tab) => tab.kind === 'entry');
  if (entryTabs.length > 1) {
    let canonicalEntry = entryTabs.find((tab) => tab.id === state.activeTabId);
    if (!canonicalEntry) {
      canonicalEntry = entryTabs.reduce((newest, currentTab) =>
        currentTab.lastActiveAt > newest.lastActiveAt ? currentTab : newest,
        entryTabs[0]!
      );
    }
    // Drop every other entry tab; the survivor keeps its own view so the
    // section the user was on is preserved.
    sourceTabs = sourceTabs.filter(
      (tab) => tab.kind !== 'entry' || tab.id === canonicalEntry!.id,
    );
  }

  // Pin the single entry tab to the leftmost position (Figma-style). It is the
  // one permanent, non-closable tab regardless of which section it currently
  // shows; project / marketplace tabs always sit to its right in insertion
  // order. If no entry tab survives normalization — e.g. a user who reopens on
  // a saved `[project, ...]` workspace — create one so the invariant "an entry
  // tab always exists and is leftmost" holds for migrated state too.
  const entryIndex = sourceTabs.findIndex((tab) => tab.kind === 'entry');
  if (entryIndex < 0) {
    sourceTabs = [createEntryTab('home'), ...sourceTabs];
  } else if (entryIndex > 0) {
    const [entryTab] = sourceTabs.splice(entryIndex, 1);
    sourceTabs = [entryTab!, ...sourceTabs];
  }

  const usedIds = new Set<string>();
  let activeTabId = '';
  let activeClaimed = false;
  const tabs = sourceTabs.map((tab) => {
    const wasActive = tab.id === state.activeTabId && !activeClaimed;
    if (wasActive) activeClaimed = true;
    const id = tab.id && !usedIds.has(tab.id) ? tab.id : uniqueIdForTab(tab);
    usedIds.add(id);
    if (wasActive) activeTabId = id;
    return id === tab.id ? tab : { ...tab, id };
  });
  return {
    tabs,
    activeTabId: activeTabId || tabs[0]!.id,
  };
}

function reorderTabsById(
  tabs: WorkspaceChromeTab[],
  sourceId: string,
  targetId: string,
  edge: TabDropEdge,
): WorkspaceChromeTab[] {
  if (sourceId === targetId) return tabs;
  const movedTab = tabs.find((tab) => tab.id === sourceId);
  if (!movedTab) return tabs;

  const nextTabs = tabs.filter((tab) => tab.id !== sourceId);
  const targetIndex = nextTabs.findIndex((tab) => tab.id === targetId);
  if (targetIndex < 0) return tabs;
  nextTabs.splice(edge === 'after' ? targetIndex + 1 : targetIndex, 0, movedTab);
  if (nextTabs.every((tab, index) => tab.id === tabs[index]?.id)) return tabs;
  return nextTabs;
}

function tabDragTargetKey(target: TabDragTarget): string {
  return `${target.tabId}:${target.edge}`;
}

/**
 * A tab's horizontal span in viewport X, measured from layout geometry
 * (offsetLeft/offsetWidth) instead of getBoundingClientRect. Layout geometry
 * excludes transforms, so the FLIP slide animation and drag styling never
 * shift the rects the drop hit-testing reads — a transformed hovered tab used
 * to move its own midpoint, flip the before/after edge, transform back, and
 * oscillate (visible jitter while dragging).
 */
function tabLayoutSpan(
  strip: HTMLElement,
  element: HTMLElement,
): { left: number; right: number; mid: number } {
  const stripLeft = strip.getBoundingClientRect().left - strip.scrollLeft;
  const left = stripLeft + element.offsetLeft;
  const width = element.offsetWidth;
  return { left, right: left + width, mid: left + width / 2 };
}

function tabDropEdgeFromElement(
  event: DragEvent<HTMLElement>,
  strip: HTMLElement,
  element: HTMLElement,
): TabDropEdge {
  return event.clientX > tabLayoutSpan(strip, element).mid ? 'after' : 'before';
}

function pulseTabDragHaptic(durationMs = TAB_DRAG_HAPTIC_MS) {
  if (typeof navigator === 'undefined' || typeof navigator.vibrate !== 'function') return;
  try {
    navigator.vibrate(durationMs);
  } catch {
    // Haptics are opportunistic; unsupported environments should keep dragging normally.
  }
}

function initialTabsState(route: Route): WorkspaceTabsState {
  const fallback = tabFromRoute(route);
  if (typeof window === 'undefined') {
    return syncStateToRoute({ tabs: [fallback], activeTabId: fallback.id }, route);
  }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return syncStateToRoute({ tabs: [fallback], activeTabId: fallback.id }, route);
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== 'object') {
      return syncStateToRoute({ tabs: [fallback], activeTabId: fallback.id }, route);
    }
    const record = parsed as Record<string, unknown>;
    const tabs = Array.isArray(record.tabs)
      ? record.tabs.map(reviveTab).filter((tab): tab is WorkspaceChromeTab => tab !== null)
      : [];
    const activeTabId = typeof record.activeTabId === 'string' ? record.activeTabId : '';
    if (tabs.length === 0) {
      return syncStateToRoute({ tabs: [fallback], activeTabId: fallback.id }, route);
    }
    return syncStateToRoute({ tabs, activeTabId: activeTabId || tabs[0]!.id }, route);
  } catch {
    return syncStateToRoute({ tabs: [fallback], activeTabId: fallback.id }, route);
  }
}

function syncStateToRoute(state: WorkspaceTabsState, route: Route): WorkspaceTabsState {
  const timestamp = Date.now();
  const current = normalizeTabsState(state);
  const currentActive = current.tabs.find((tab) => tab.id === current.activeTabId) ?? null;

  // 1. If we are navigating to any entry view (home / projects / tasks /
  // design-systems / plugins / integrations / onboarding), reuse the single
  // entry tab and switch its view IN PLACE — all sidebar sections collapse
  // into the one leftmost tab. Only create one if none exists.
  if (route.kind === 'home') {
    const existingEntryTab = current.tabs.find((tab) => tab.kind === 'entry');
    if (existingEntryTab) {
      return normalizeTabsState({
        ...current,
        tabs: current.tabs.map((tab) =>
          tab.id === existingEntryTab.id
            ? { ...tab, view: route.view, lastActiveAt: timestamp }
            : tab,
        ),
        activeTabId: existingEntryTab.id,
      });
    }
    const nextTab = tabFromRoute(route, timestamp);
    return normalizeTabsState({
      tabs: [...current.tabs, nextTab],
      activeTabId: nextTab.id,
    });
  }

  // 2. If we are navigating to a project, and that project tab already exists:
  if (route.kind === 'project') {
    const existingProjectTab = current.tabs.find(
      (tab) => tab.kind === 'project' && tab.projectId === route.projectId,
    );
    if (existingProjectTab) {
      return normalizeTabsState({
        ...current,
        tabs: current.tabs.map((tab) =>
          tab.id === existingProjectTab.id
            ? {
                ...tab,
                conversationId: route.conversationId ?? null,
                fileName: route.fileName,
                lastActiveAt: timestamp,
              }
            : tab,
        ),
        activeTabId: existingProjectTab.id,
      });
    }

    // 3. If we are navigating to a project, and the project tab does NOT exist,
    // but the current active tab is the (single) entry tab, we should NOT
    // replace it — append a new project tab instead, regardless of which entry
    // view it currently shows.
    if (currentActive && currentActive.kind === 'entry') {
      const nextTab = tabFromRoute(route, timestamp);
      return normalizeTabsState({
        tabs: [...current.tabs, nextTab],
        activeTabId: nextTab.id,
      });
    }
  }

  if (!currentActive) {
    const nextTab = tabFromRoute(route, timestamp);
    return normalizeTabsState({
      tabs: [...current.tabs, nextTab],
      activeTabId: nextTab.id,
    });
  }

  const replacement = {
    ...tabFromRoute(route, currentActive.createdAt),
    id: currentActive.id,
    lastActiveAt: timestamp,
  };
  const nextTabs = current.tabs.map((tab) =>
    tab.id === currentActive.id ? replacement : tab,
  );
  return normalizeTabsState({ tabs: nextTabs, activeTabId: replacement.id });
}

function normalizeSearch(value: string): string {
  return value.trim().toLocaleLowerCase();
}

/**
 * Whatever `identityScopeKey` this bar last persisted alongside the tabs
 * blob, read directly from storage. Used exactly once, at mount (see
 * `scopeKeyAtMount` below) — a fresh page load must compare the newly
 * resolved identity against what the PREVIOUS session actually left behind,
 * not against "nothing" (which would make every cold boot look like a brand
 * new identity and wipe a perfectly valid restored session). `undefined`
 * covers both "no tabs recorded yet" and "tabs recorded by a build that
 * predates this field" — both mean "nothing to conflict with", never a
 * reason to reset.
 */
function readPersistedScopeKey(): string | undefined {
  if (typeof window === 'undefined') return undefined;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as { scopeKey?: unknown };
    return typeof parsed.scopeKey === 'string' ? parsed.scopeKey : undefined;
  } catch {
    return undefined;
  }
}

export function WorkspaceTabsBar({
  route,
  projects,
  onboardingCompleted = false,
  identityScopeKey = null,
}: Props) {
  const t = useT();
  const [state, setState] = useState<WorkspaceTabsState>(() => initialTabsState(route));
  // Snapshot, once at mount, of whatever scope key a PRIOR session (or a
  // still-warm reload) already persisted — read before this mount's own
  // persistence effect above gets a chance to overwrite it with the freshly
  // resolved `identityScopeKey`. The reset effect below compares against
  // this ref (updating it as it goes) instead of re-reading storage on every
  // change, so its own writes never race the comparison that needs the OLD
  // value.
  const [scopeKeyAtMount] = useState(() => readPersistedScopeKey());
  const lastSeenScopeKeyRef = useRef<string | undefined>(scopeKeyAtMount);
  const [tabsMenuOpen, setTabsMenuOpen] = useState(false);
  // #5517 corner fan: the "+" button opens a corner-anchored radial menu of
  // template wedges instead of immediately spawning a home tab.
  const [radialMenu, setRadialMenu] = useState<{ x: number; y: number } | null>(null);
  const [radialHoverId, setRadialHoverId] = useState<string | null>(null);
  useEffect(() => {
    if (!radialMenu) setRadialHoverId(null);
  }, [radialMenu]);
  useEffect(() => {
    if (!radialMenu) return;
    // Uniform page blur: filter on the shell blurs every descendant equally
    // (backdrop-filter on the scrim sampled composited layers unevenly).
    document.documentElement.classList.add('od-radial-open');
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setRadialMenu(null);
    };
    window.addEventListener('keydown', onKey);
    return () => {
      document.documentElement.classList.remove('od-radial-open');
      window.removeEventListener('keydown', onKey);
    };
  }, [radialMenu]);
  const [query, setQuery] = useState('');
  const [tabsOverflowing, setTabsOverflowing] = useState(false);
  const stripRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const previousOnboardingCompletedRef = useRef(onboardingCompleted);
  const resetEntryToHomeAfterOnboardingRef = useRef(false);
  const dragSuppressClickRef = useRef(false);
  const draggingTabIdRef = useRef<string | null>(null);
  const dragHapticTargetRef = useRef<string | null>(null);
  const [draggingTabId, setDraggingTabId] = useState<string | null>(null);
  const [dragOverTarget, setDragOverTarget] = useState<TabDragTarget | null>(null);
  // recvq5eKj2kdF0: `projects` is the Home view's own fetch (recent/drafts,
  // capped) — navigating Home refetches and REPLACES it (App.tsx's
  // reconcileFetchedProjects), which drops any project that is open in a
  // background tab but falls outside that scope. `displayTabFor` then found
  // no entry for the tab's projectId and fell back to the untitled label,
  // even though the project genuinely has a name — the tab just "forgot" it
  // the moment Home reloaded. This ref remembers the last real name seen for
  // each project id so a tab never regresses to untitled once it has shown a
  // real one; it is intentionally a ref (not state) because it must not
  // itself trigger a render — the incoming `projects`/`state.tabs` change
  // that recomputes `displayTabs` already will.
  const knownProjectNamesRef = useRef<Map<string, string>>(new Map());

  // Liquid-glass glide indicator: one persistent pill that slides to the
  // active tab (see useGlideIndicator + .workspace-tabs-glide in routines.css).
  const glideRef = useRef<HTMLDivElement | null>(null);
  const glidePillRef = useRef<HTMLDivElement | null>(null);
  const glideGlassRef = useLiquidGlass<HTMLDivElement>({ strength: 0.2 });
  const setGlidePillRef = useCallback(
    (node: HTMLDivElement | null) => {
      glidePillRef.current = node;
      glideGlassRef(node);
    },
    [glideGlassRef],
  );

  // FLIP slide for live drag-reordering: when the tab order changes mid-drag,
  // each displaced tab starts at its previous slot (inverted transform) and
  // transitions to its new one instead of teleporting. Positions come from
  // offsetLeft (layout space, transform-free), so the in-flight slides never
  // feed back into the drop hit-testing in findTabDropTarget.
  const tabFlipLeftsRef = useRef(new Map<string, number>());
  useLayoutEffect(() => {
    const strip = stripRef.current;
    if (!strip) return;
    const previousLefts = tabFlipLeftsRef.current;
    const nextLefts = new Map<string, number>();
    for (const element of strip.querySelectorAll<HTMLElement>('[data-workspace-tab-id]')) {
      const id = element.dataset.workspaceTabId;
      if (!id) continue;
      nextLefts.set(id, element.offsetLeft);
      const before = previousLefts.get(id);
      if (before === undefined) continue;
      const delta = before - element.offsetLeft;
      if (!delta) continue;
      // The dragged tab itself snaps — its native drag ghost is what tracks
      // the pointer; animating the in-row placeholder would lag behind it.
      if (id === draggingTabIdRef.current) continue;
      element.style.transition = 'none';
      element.style.transform = `translateX(${delta}px)`;
      // Commit the inverted start position before re-enabling transitions.
      void element.offsetWidth;
      element.style.transition = '';
      element.style.transform = '';
    }
    tabFlipLeftsRef.current = nextLefts;
  });

  // Layout epoch for the glide indicator: any change in tab identity/order or
  // the overflow state can shift the active tab without changing which tab is
  // active — those reposition instantly (no fake slide).
  const tabsLayoutKey = useMemo(
    () => `${state.tabs.map((tab) => tab.id).join('|')}:${tabsOverflowing ? 1 : 0}`,
    [state.tabs, tabsOverflowing],
  );
  const activeChromeTab = state.tabs.find((tab) => tab.id === state.activeTabId);
  // The pinned entry tab renders only a flat rail-toggle whenever it's active —
  // the sidebar toggle on Home, the Home button in every other entry section
  // (settings / all-projects / community / design-systems). In ALL of these the
  // glide pill must not park its filled "active tab" surface over it, so key off
  // `kind === 'entry'` rather than the Home view alone (which left the pill
  // filling the button in the other sections).
  const activeIsEntryRailToggle = activeChromeTab?.kind === 'entry';
  useGlideIndicator({
    containerRef: stripRef,
    indicatorRef: glideRef,
    pillRef: glidePillRef,
    // On an entry section, target a never-matching selector so the glide pill
    // fades out over the toggle instead of filling it. (jsdom-safe — no `:has()`
    // in querySelector.)
    activeSelector: activeIsEntryRailToggle
      ? '.workspace-tab.is-active.__no-glide__'
      : '.workspace-tab.is-active',
    activeKey: state.activeTabId,
    layoutKey: tabsLayoutKey,
    frozen: draggingTabId !== null,
    // The pinned entry tab is position: sticky — its visual position diverges
    // from layout coords while the strip is scrolled, so chase it on scroll.
    trackScroll: activeChromeTab?.kind === 'entry',
  });

  // While the app is on the onboarding (Welcome) route, opening a new tab
  // would navigate away from onboarding and bypass the Connect gate. Key off
  // the live `route` (the URL truth), NOT `onboardingCompleted` and NOT the
  // internal tab `view`: a user who finished onboarding before (completion
  // persisted) can still land on /onboarding, and the entry tab's view can be
  // mid-rewrite by the post-completion effect. Gating in `createNewTab` blocks
  // both the "+" button and the Cmd/Ctrl+T shortcut from one place.
  const onboardingActive = route.kind === 'home' && route.view === 'onboarding';

  // Mirror of EntryShell's entry nav-rail open state, only used to reflect it
  // on the pinned Home tab's sidebar toggle (aria-expanded). EntryShell owns
  // the state and broadcasts changes as a window event because it renders in a
  // sibling React tree; the localStorage seed covers the frames before the
  // first broadcast arrives.
  const [entryRailOpen, setEntryRailOpen] = useState<boolean>(readStoredRailOpen);
  useEffect(() => {
    const onRailState = (event: Event) => {
      const open = (event as CustomEvent<{ open?: unknown }>).detail?.open;
      if (typeof open === 'boolean') setEntryRailOpen(open);
    };
    window.addEventListener(ENTRY_RAIL_STATE_EVENT, onRailState);
    return () => window.removeEventListener(ENTRY_RAIL_STATE_EVENT, onRailState);
  }, []);

  const projectById = useMemo(
    () => new Map(projects.map((project) => [project.id, project])),
    [projects],
  );

  // Refresh the fallback cache from whatever this fetch actually returned,
  // before `displayTabFor` below reads it — same render pass, so a tab
  // reading a name for the first time never has to wait a tick for it.
  for (const project of projects) {
    const name = project.name?.trim();
    if (name) knownProjectNamesRef.current.set(project.id, name);
  }

  const displayTabs = useMemo(
    () => state.tabs.map((tab) => displayTabFor(tab, projectById, t, knownProjectNamesRef.current)),
    [state.tabs, projectById, t],
  );
  const displayTabById = useMemo(
    () => new Map(displayTabs.map((tab) => [tab.id, tab])),
    [displayTabs],
  );
  const filteredTabs = useMemo(() => {
    const needle = normalizeSearch(query);
    const source = needle
      ? displayTabs.filter((tab) => {
          const haystack = `${tab.title} ${tab.meta}`.toLocaleLowerCase();
          return haystack.includes(needle);
        })
      : displayTabs;
    return source
      .slice()
      .sort((a, b) => b.tab.lastActiveAt - a.tab.lastActiveAt)
      .slice(0, MAX_SEARCH_RESULTS);
  }, [displayTabs, query]);

  useEffect(() => {
    setState((current) => syncStateToRoute(current, route));
  }, [route]);

  useEffect(() => {
    if (!previousOnboardingCompletedRef.current && onboardingCompleted) {
      resetEntryToHomeAfterOnboardingRef.current = true;
    }
    previousOnboardingCompletedRef.current = onboardingCompleted;
  }, [onboardingCompleted]);

  // Auto-close the Welcome tab once onboarding ends: rewrite any entry tab
  // still parked on the 'onboarding' view back to 'home'. This catches every
  // finish path uniformly — last-step Continue and any future route that
  // navigates away while leaving the entry tab on Welcome in the background.
  useEffect(() => {
    if (!onboardingCompleted) return;
    // Don't rewrite the tab back to 'home' while the user is *still* on the
    // onboarding route — a previously-completed user who re-opens /onboarding
    // should keep the "Onboarding" tab label, not flip to "Home". The rewrite
    // still fires the moment they navigate away (onboardingActive turns false).
    if (onboardingActive) return;
    const resetDesignSystemsEntry =
      resetEntryToHomeAfterOnboardingRef.current && route.kind === 'project';
    if (resetDesignSystemsEntry) {
      resetEntryToHomeAfterOnboardingRef.current = false;
    }
    setState((current) => {
      if (!current.tabs.some((tab) =>
        tab.kind === 'entry' &&
        (tab.view === 'onboarding' || (resetDesignSystemsEntry && tab.view === 'design-systems')),
      )) {
        return current;
      }
      return normalizeTabsState({
        ...current,
        tabs: current.tabs.map((tab) =>
          tab.kind === 'entry' &&
          (tab.view === 'onboarding' || (resetDesignSystemsEntry && tab.view === 'design-systems'))
            ? { ...tab, view: 'home' }
            : tab,
        ),
      });
    });
  }, [onboardingCompleted, onboardingActive, route.kind]);

  // Tab-scope enforcement: close every open tab down to a single fresh Home
  // tab whenever `identityScopeKey` (AMR account + active workspace, derived
  // in App.tsx) changes to something this bar has not already recorded.
  // Signing out, signing in as a different account, switching workspace, and
  // "never signed into AMR at all" are each their own scope — a tab left open
  // across one of those transitions would keep pointing at a project/section
  // the new identity may have no standing to see (the UI-side counterpart of
  // the API-level workspace-isolation bugs this sprint has been fixing).
  //
  // Closing is final, not "recoverable on switching back": a workspace tab is
  // a bookmark (kind/projectId/conversationId/fileName, or a plugin id, or an
  // entry-view name — see WorkspaceChromeTab above), never a place unsaved
  // editor content lives, so closing it drops no work — the project itself
  // stays on disk/daemon and is still discoverable from Projects/search under
  // whatever identity can actually see it. Keeping a per-scope "recently
  // closed" cache to restore on switching back was considered and rejected:
  // it would need its own unbounded-growth/eviction policy for a benefit that
  // only pays off for the narrow case of bouncing between exactly two scopes
  // with nothing else in between, and the underlying data was never at risk
  // either way.
  //
  // Suppressed while onboarding is active: `createNewTab`/`openRadialMenu`
  // are both gated on `onboardingActive`, so the ONLY tab that can exist
  // during onboarding is the single pinned entry tab — there is nothing to
  // protect against yet, and forcing a close+navigate-home mid-flow would
  // eject the user from the Connect step before they finish it (a real
  // scenario: finishing AMR sign-in mid-onboarding is exactly a scope change
  // per this design). The new key is still recorded via the ref so the
  // reconciliation does not re-fire the moment onboarding completes with a
  // scope that has not changed again since.
  useEffect(() => {
    if (identityScopeKey == null) return;
    const previous = lastSeenScopeKeyRef.current;
    lastSeenScopeKeyRef.current = identityScopeKey;
    if (previous === identityScopeKey) return;
    if (onboardingActive || previous === undefined) {
      // Mid-onboarding, or the very first scope this browser profile has
      // ever recorded (nothing prior to conflict with) — adopt silently.
      return;
    }
    const homeTab = createEntryTab('home');
    setState({ tabs: [homeTab], activeTabId: homeTab.id });
    navigate(routeForTab(homeTab));
  }, [identityScopeKey, onboardingActive]);

  // Close the Search-tabs popover whenever onboarding becomes active. The
  // trigger button is hidden during onboarding, so a popover left open across
  // a route flip to /onboarding (e.g. browser back/forward, which bypasses
  // activateTab/createNewTab) would otherwise float over the first-run flow
  // with no visible control to dismiss it. The portal is also gated on
  // !onboardingActive below so it never renders for the frame before this runs.
  useEffect(() => {
    if (onboardingActive) setTabsMenuOpen(false);
  }, [onboardingActive]);

  // Scroll the active tab into view when it changes. The strip itself
  // is native-scrollable horizontally (see CSS), so we just nudge the
  // browser's scroll position whenever the active id flips — keeps the
  // current tab visible after a route change even if the user had
  // scrolled the strip elsewhere.
  useEffect(() => {
    function onOpenWorkspaceTab(event: Event) {
      const detail = (event as CustomEvent<{ route?: Route }>).detail;
      const nextRoute = detail?.route;
      if (!nextRoute) return;
      const nextTab = tabFromRoute(nextRoute);
      setState((current) => {
        const normalized = normalizeTabsState(current);
        return normalizeTabsState({
          tabs: [...normalized.tabs, nextTab],
          activeTabId: nextTab.id,
        });
      });
      setTabsMenuOpen(false);
    }

    window.addEventListener(OPEN_WORKSPACE_TAB_EVENT, onOpenWorkspaceTab);
    return () => window.removeEventListener(OPEN_WORKSPACE_TAB_EVENT, onOpenWorkspaceTab);
  }, []);

  useEffect(() => {
    const stripElement = stripRef.current;
    if (!stripElement) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      setTabsOverflowing(stripElement.scrollWidth > stripElement.clientWidth + 1);
    };
    const requestMeasure = () => {
      if (frame) window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(measure);
    };
    requestMeasure();
    const resizeObserver =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(requestMeasure);
    if (resizeObserver) {
      resizeObserver.observe(stripElement);
      // Skip the glide indicator: its width transitions with every tab
      // switch and would feed a resize event into overflow measurement.
      Array.from(stripElement.children)
        .filter((child) => !child.classList.contains('workspace-tabs-glide'))
        .forEach((child) => resizeObserver.observe(child));
    }
    window.addEventListener('resize', requestMeasure);
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      resizeObserver?.disconnect();
      window.removeEventListener('resize', requestMeasure);
    };
  }, [state.tabs.length]);

  useEffect(() => {
    const stripElement = stripRef.current;
    if (!stripElement) return;
    const activeEl = stripElement.querySelector<HTMLElement>('.workspace-tab.is-active');
    if (!activeEl) return;
    if (typeof activeEl.scrollIntoView === 'function') {
      activeEl.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
  }, [state.activeTabId, state.tabs.length]);

  useEffect(() => {
    try {
      window.localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify(identityScopeKey == null ? state : { ...state, scopeKey: identityScopeKey }),
      );
    } catch {
      // Best-effort browser chrome state. Navigation itself remains URL-driven.
    }
  }, [state, identityScopeKey]);

  useEffect(() => {
    if (!tabsMenuOpen) return;
    const frame = window.requestAnimationFrame(() => {
      searchInputRef.current?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [tabsMenuOpen]);

  useEffect(() => {
    if (!tabsMenuOpen) return;
    function onPointerDown(event: MouseEvent) {
      const target = event.target as Node;
      const insideTrigger = menuRef.current?.contains(target) ?? false;
      // The popover is rendered through a portal into document.body to
      // escape the `contain: layout` containment block on
      // `.workspace-tabs-strip` (which would otherwise resolve our
      // fixed positioning against the strip instead of the viewport).
      // The portaled node is outside menuRef's subtree, so we also have
      // to count clicks inside it as "inside the menu".
      const insidePopover = popoverRef.current?.contains(target) ?? false;
      if (!insideTrigger && !insidePopover) {
        setTabsMenuOpen(false);
      }
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setTabsMenuOpen(false);
      }
    }
    document.addEventListener('mousedown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [tabsMenuOpen]);

  useEffect(() => {
    function onWorkspaceTabShortcut(event: KeyboardEvent) {
      if (event.defaultPrevented) return;

      const key = event.key;
      const lowerKey = key.toLocaleLowerCase();
      const primaryModifier = event.metaKey || event.ctrlKey;
      const primaryWithoutAlt = primaryModifier && !event.altKey;
      const ctrlWithoutPlatformModifiers = event.ctrlKey && !event.metaKey && !event.altKey;
      const isBrowserStyleTabShortcut =
        (primaryWithoutAlt && !event.shiftKey && (lowerKey === 't' || lowerKey === 'w'))
        || (ctrlWithoutPlatformModifiers && key === 'Tab')
        || (ctrlWithoutPlatformModifiers && !event.shiftKey && (key === 'PageDown' || key === 'PageUp'))
        || (primaryWithoutAlt && !event.shiftKey && /^[1-9]$/u.test(key));

      if (isBrowserStyleTabShortcut && shouldDeferShortcutToProjectWorkspace()) {
        return;
      }

      if (primaryWithoutAlt && !event.shiftKey && lowerKey === 't') {
        consumeWorkspaceTabShortcut(event);
        createNewTab();
        return;
      }

      if (primaryWithoutAlt && !event.shiftKey && lowerKey === 'w') {
        consumeWorkspaceTabShortcut(event);
        closeActiveTab();
        return;
      }

      if (ctrlWithoutPlatformModifiers && key === 'Tab') {
        consumeWorkspaceTabShortcut(event);
        activateTabByOffset(event.shiftKey ? -1 : 1);
        return;
      }

      if (ctrlWithoutPlatformModifiers && !event.shiftKey && key === 'PageDown') {
        consumeWorkspaceTabShortcut(event);
        activateTabByOffset(1);
        return;
      }

      if (ctrlWithoutPlatformModifiers && !event.shiftKey && key === 'PageUp') {
        consumeWorkspaceTabShortcut(event);
        activateTabByOffset(-1);
        return;
      }

      if (primaryWithoutAlt && !event.shiftKey && /^[1-9]$/u.test(key)) {
        consumeWorkspaceTabShortcut(event);
        const normalized = normalizeTabsState(state);
        const targetIndex = key === '9'
          ? normalized.tabs.length - 1
          : Number(key) - 1;
        activateTabByIndex(targetIndex);
      }
    }

    window.addEventListener('keydown', onWorkspaceTabShortcut, true);
    return () => window.removeEventListener('keydown', onWorkspaceTabShortcut, true);
  }, [state]);

  function activateTab(tab: WorkspaceChromeTab) {
    setState((current) => ({
      tabs: normalizeTabsState(current).tabs.map((item) =>
        item.id === tab.id ? { ...item, lastActiveAt: Date.now() } : item,
      ),
      activeTabId: tab.id,
    }));
    setTabsMenuOpen(false);
    navigate(routeForTab(tab));
  }

  function activateTabByOffset(offset: number) {
    const normalized = normalizeTabsState(state);
    if (normalized.tabs.length === 0) return;
    const activeIndex = Math.max(
      0,
      normalized.tabs.findIndex((tab) => tab.id === normalized.activeTabId),
    );
    const targetIndex =
      (activeIndex + offset + normalized.tabs.length) % normalized.tabs.length;
    activateTab(normalized.tabs[targetIndex]!);
  }

  function activateTabByIndex(index: number) {
    const normalized = normalizeTabsState(state);
    if (index < 0 || index >= normalized.tabs.length) return;
    activateTab(normalized.tabs[index]!);
  }

  function closeActiveTab() {
    const normalized = normalizeTabsState(state);
    closeTab(normalized.activeTabId);
  }

  function openTab(tab: WorkspaceChromeTab) {
    if (dragSuppressClickRef.current) {
      dragSuppressClickRef.current = false;
      return;
    }
    // Clicking the pinned Home tab always lands on the home page, whatever
    // entry section (projects / design-systems / …) the tab last showed.
    // Keyboard tab-cycling goes through activateTab directly and keeps the
    // remembered section.
    if (tab.kind === 'entry' && tab.view !== 'home') {
      activateTab({ ...tab, view: 'home' });
      return;
    }
    activateTab(tab);
  }

  // Corner-anchored radial fan menu on the "+" button: three concentric bands
  // sweep down-left from the button (the pivot at the top-right corner),
  // carrying the composer Template picker's icons. Each band is a ring split
  // into angular wedges — 3 / 4 from the inner bands outward, with the outer
  // band absorbing every remaining template (see `radialSlots`).
  // Picking a wedge opens the home tab with that template applied to the hero.
  const RADIAL_SIZE = 300;
  const RADIAL_PAD = 24;
  const RADIAL_R_IN = 56;
  const RADIAL_R_OUT = 264;
  const RADIAL_BANDS = [3, 4, 3];
  const RADIAL_START = 96; // fan start angle (screen degrees) …
  const RADIAL_SWEEP = 78; // … total arc, fanning toward the left
  const RADIAL_GAP = 0; // wedges abut; hairline strokes are the dividers
  const RADIAL_CX = RADIAL_SIZE - RADIAL_PAD;
  const RADIAL_CY = RADIAL_PAD;

  function radialBandRadius(band: number): number {
    return RADIAL_R_IN + ((RADIAL_R_OUT - RADIAL_R_IN) * band) / RADIAL_BANDS.length;
  }

  // Per-template placement across the bands, aligned to template order.
  const radialSlots = useMemo(() => {
    const chips = orderedCreateChips().filter((chip) => chip.action.kind === 'apply-scenario');
    const slots: Array<{ chip: HomeHeroChip; band: number; seg: number; segCount: number }> = [];
    let cursor = 0;
    RADIAL_BANDS.forEach((count, band) => {
      const isLast = band === RADIAL_BANDS.length - 1;
      const remaining = Math.max(chips.length - cursor, 0);
      const take = isLast ? remaining : Math.min(count, remaining);
      for (let seg = 0; seg < take; seg += 1) {
        const chip = chips[cursor + seg];
        if (chip) slots.push({ chip, band, seg, segCount: take });
      }
      cursor += take;
    });
    return slots;
  }, []);

  function radialWedgeAngles(seg: number, segCount: number): [number, number] {
    const step = RADIAL_SWEEP / segCount;
    return [RADIAL_START + seg * step + RADIAL_GAP / 2, RADIAL_START + (seg + 1) * step - RADIAL_GAP / 2];
  }

  function radialSectorPath(cx: number, cy: number, a1: number, a2: number, r0: number, r1: number): string {
    const rad = (a: number) => (a * Math.PI) / 180;
    const px = (r: number, a: number) => `${(cx + r * Math.cos(rad(a))).toFixed(2)} ${(cy + r * Math.sin(rad(a))).toFixed(2)}`;
    return `M ${px(r1, a1)} A ${r1} ${r1} 0 0 1 ${px(r1, a2)} L ${px(r0, a2)} A ${r0} ${r0} 0 0 0 ${px(r0, a1)} Z`;
  }

  function openEntryView(view: EntryHomeView) {
    const normalized = normalizeTabsState(state);
    const existingEntryTab = normalized.tabs.find((tab) => tab.kind === 'entry');
    if (existingEntryTab) {
      setState({ ...normalized, activeTabId: existingEntryTab.id });
    } else {
      const tab = createEntryTab(view);
      setState({ tabs: [...normalized.tabs, tab], activeTabId: tab.id });
    }
    navigate({ kind: 'home', view });
    setRadialMenu(null);
  }

  function openTemplateFromRadial(chip: HomeHeroChip) {
    openEntryView('home');
    // Hand the pick to the hero once the home tab has mounted/activated —
    // HomeHero applies the chip exactly as if its own picker was clicked.
    window.setTimeout(() => {
      window.dispatchEvent(
        new CustomEvent(HOME_APPLY_TEMPLATE_EVENT, { detail: { chipId: chip.id } }),
      );
    }, 50);
  }

  function openRadialMenu(event: React.MouseEvent<HTMLButtonElement>) {
    if (onboardingActive) return;
    const rect = event.currentTarget.getBoundingClientRect();
    setRadialMenu((cur) => (cur ? null : { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }));
  }

  function createNewTab() {
    // Onboarding gate — see `onboardingActive`. Covers the "+" button and the
    // Cmd/Ctrl+T keyboard shortcut, since both funnel through here.
    if (onboardingActive) return;
    const normalized = normalizeTabsState(state);
    const existingEntryTab = normalized.tabs.find((tab) => tab.kind === 'entry');
    if (existingEntryTab) {
      setState({
        ...normalized,
        activeTabId: existingEntryTab.id,
      });
      navigate({ kind: 'home', view: 'home' });
    } else {
      const tab = createEntryTab('home');
      setState({
        tabs: [...normalized.tabs, tab],
        activeTabId: tab.id,
      });
      navigate({ kind: 'home', view: 'home' });
    }
    setTabsMenuOpen(false);
  }

  function closeTab(tabId: string) {
    const normalized = normalizeTabsState(state);
    const closingIndex = normalized.tabs.findIndex((tab) => tab.id === tabId);
    if (closingIndex < 0) return;
    // The single entry tab is permanent — never close it, whatever section
    // (home / projects / design-systems / …) it currently shows.
    const closingTab = normalized.tabs[closingIndex]!;
    if (closingTab.kind === 'entry') return;
    let nextRoute: Route | null = null;
    const nextTabs = normalized.tabs.filter((tab) => tab.id !== tabId);
    let nextState: WorkspaceTabsState;
    if (nextTabs.length === 0) {
      const homeTab = createEntryTab('home');
      nextRoute = routeForTab(homeTab);
      nextState = { tabs: [homeTab], activeTabId: homeTab.id };
    } else if (normalized.activeTabId !== tabId) {
      nextState = { ...normalized, tabs: nextTabs };
    } else {
      const replacement = nextTabs[Math.min(closingIndex, nextTabs.length - 1)] ?? nextTabs[0]!;
      nextRoute = routeForTab(replacement);
      nextState = { tabs: nextTabs, activeTabId: replacement.id };
    }
    setState(nextState);
    if (nextRoute) navigate(nextRoute);
  }

  function reorderTab(sourceId: string, targetId: string, edge: TabDropEdge) {
    setTabsMenuOpen(false);
    setState((current) => {
      const normalized = normalizeTabsState(current);
      const tabs = reorderTabsById(normalized.tabs, sourceId, targetId, edge);
      if (tabs === normalized.tabs) return normalized;
      // Re-normalize so the Home tab is re-pinned to the leftmost slot even when
      // a drop would otherwise have placed a tab before it. Home is the one
      // permanent, non-closable tab and must always sit first.
      return normalizeTabsState({ ...normalized, tabs });
    });
  }

  function findTabDropTarget(event: DragEvent<HTMLElement>, sourceId: string): TabDragTarget | null {
    const strip = stripRef.current;
    if (!strip) return null;

    // The single entry tab is pinned leftmost: never expose a drop target that
    // would place another tab before it. Coerce any 'before entry' edge to
    // 'after entry' so the live drag indicator and persisted order keep it first.
    const entryTabId = state.tabs.find((tab) => tab.kind === 'entry')?.id;
    const resolveTarget = (target: TabDragTarget): TabDragTarget =>
      target.tabId === entryTabId && target.edge === 'before'
        ? { tabId: target.tabId, edge: 'after' }
        : target;

    const eventTarget = event.target;
    if (eventTarget instanceof HTMLElement) {
      const tabElement = eventTarget.closest<HTMLElement>('[data-workspace-tab-id]');
      if (tabElement && strip.contains(tabElement)) {
        const tabId = tabElement.dataset.workspaceTabId;
        if (tabId && tabId !== sourceId) {
          return resolveTarget({ tabId, edge: tabDropEdgeFromElement(event, strip, tabElement) });
        }
      }
    }

    let lastTarget: TabDragTarget | null = null;
    for (const tabElement of strip.querySelectorAll<HTMLElement>('[data-workspace-tab-id]')) {
      const tabId = tabElement.dataset.workspaceTabId;
      if (!tabId || tabId === sourceId) continue;
      const span = tabLayoutSpan(strip, tabElement);
      if (event.clientX <= span.mid) return resolveTarget({ tabId, edge: 'before' });
      if (event.clientX <= span.right) return resolveTarget({ tabId, edge: 'after' });
      lastTarget = { tabId, edge: 'after' };
    }
    return lastTarget;
  }

  function handleTabDragStart(tabId: string, event: DragEvent<HTMLDivElement>) {
    const target = event.target;
    if (target instanceof HTMLElement && target.closest('.workspace-tab__close')) {
      event.preventDefault();
      return;
    }
    dragSuppressClickRef.current = true;
    draggingTabIdRef.current = tabId;
    dragHapticTargetRef.current = `${tabId}:self`;
    setDragOverTarget(null);
    setDraggingTabId(tabId);
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', tabId);
    pulseTabDragHaptic();
  }

  function handleStripDragOver(event: DragEvent<HTMLDivElement>) {
    const sourceId = draggingTabIdRef.current ?? event.dataTransfer.getData('text/plain');
    if (!sourceId) return;
    const target = findTabDropTarget(event, sourceId);
    if (!target) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    const targetKey = tabDragTargetKey(target);
    setDragOverTarget((current) =>
      current && tabDragTargetKey(current) === targetKey ? current : target,
    );
    if (dragHapticTargetRef.current !== targetKey) {
      dragHapticTargetRef.current = targetKey;
      pulseTabDragHaptic();
    }
    reorderTab(sourceId, target.tabId, target.edge);
  }

  function handleStripDrop(event: DragEvent<HTMLDivElement>) {
    const sourceId = draggingTabIdRef.current ?? event.dataTransfer.getData('text/plain');
    if (sourceId) {
      event.preventDefault();
    }
    const target = sourceId ? findTabDropTarget(event, sourceId) : null;
    if (sourceId && target) {
      reorderTab(sourceId, target.tabId, target.edge);
      pulseTabDragHaptic(TAB_DROP_HAPTIC_MS);
    }
    draggingTabIdRef.current = null;
    dragHapticTargetRef.current = null;
    setDragOverTarget(null);
    setDraggingTabId(null);
    window.setTimeout(() => {
      dragSuppressClickRef.current = false;
    }, 0);
  }

  function handleStripDragLeave(event: DragEvent<HTMLDivElement>) {
    const nextTarget = event.relatedTarget;
    if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) return;
    setDragOverTarget(null);
  }

  function handleTabDragEnd() {
    draggingTabIdRef.current = null;
    dragHapticTargetRef.current = null;
    setDragOverTarget(null);
    setDraggingTabId(null);
    window.setTimeout(() => {
      dragSuppressClickRef.current = false;
    }, 0);
  }

  return (
    <header className="app-chrome-header workspace-tabs-chrome" aria-label="Workspace tabs">
      <div className="app-chrome-traffic-space workspace-tabs-traffic" aria-hidden />
      <div
        className={`workspace-tabs-strip${tabsOverflowing ? ' is-overflowing' : ''}`}
        role="tablist"
        aria-label="Open workspaces"
        ref={stripRef}
        onDragOver={handleStripDragOver}
        onDrop={handleStripDrop}
        onDragLeave={handleStripDragLeave}
      >
        {/* Render every open tab — the strip itself scrolls horizontally
            when the tabs exceed the available chrome width. Previous
            behaviour sliced to `visibleChromeTabs(...)` and squeezed
            the rest behind a "+N more" chip, which squished the entire
            chrome horizontally. The search-tabs popover still acts as
            a keyboard surface for finding a tab that's scrolled out of
            view. */}
        {/* Liquid-glass active-tab pill: positioned by useGlideIndicator in
            the strip's content coordinates, painted by the __pill (frosted
            everywhere, SDF refraction on Chromium via useLiquidGlass). First
            child so `.workspace-tab + .workspace-tab` sibling selectors and
            [data-workspace-tab-id] queries stay untouched. */}
        <div className="workspace-tabs-glide" ref={glideRef} aria-hidden="true">
          <div
            className="workspace-tabs-glide__pill od-glass-refract"
            ref={setGlidePillRef}
          />
        </div>
        {state.tabs.map((tab) => {
          const display =
            displayTabById.get(tab.id) ?? displayTabFor(tab, projectById, t, knownProjectNamesRef.current);
          const active = tab.id === state.activeTabId;
          // The single entry tab is permanent and pinned leftmost: it cannot be
          // closed or dragged out of the first slot, whatever section it shows.
          const isPinned = tab.kind === 'entry';
          const dragOverClass =
            dragOverTarget?.tabId === tab.id && draggingTabId !== tab.id
              ? ` is-drag-over-${dragOverTarget.edge}`
              : '';
          return (
            <div
              key={tab.id}
              className={`workspace-tab${active ? ' is-active' : ''}${isPinned ? ' is-pinned' : ''}${draggingTabId === tab.id ? ' is-dragging' : ''}${dragOverClass}`}
              data-workspace-tab-id={tab.id}
              role="tab"
              aria-selected={active}
              draggable={!isPinned && state.tabs.length > 1}
              onDragStart={(event) => handleTabDragStart(tab.id, event)}
              onDragEnd={handleTabDragEnd}
            >
              {isPinned && active && tab.view === 'home' ? (
                /* Home view only: the pinned tab is the sidebar toggle — a Home
                   button would be redundant since you are already home. */
                <button
                  type="button"
                  className="workspace-tab__rail-toggle od-tooltip"
                  aria-label={entryRailOpen ? t('entry.navCollapse') : t('entry.navExpand')}
                  aria-expanded={entryRailOpen}
                  title={entryRailOpen ? t('entry.navCollapse') : t('entry.navExpand')}
                  data-tooltip={entryRailOpen ? t('entry.navCollapse') : t('entry.navExpand')}
                  data-tooltip-placement="bottom"
                  data-testid="workspace-home-rail-toggle"
                  onClick={(event) => {
                    event.stopPropagation();
                    window.dispatchEvent(new CustomEvent(ENTRY_RAIL_TOGGLE_EVENT));
                  }}
                >
                  <Icon name="panel-left" size={14} />
                </button>
              ) : isPinned && active ? (
                /* Any other entry section (settings / all-projects / community /
                   design-systems …): show the Home icon; clicking returns home. */
                <button
                  type="button"
                  className="workspace-tab__rail-toggle od-tooltip"
                  aria-label={t('entry.navHome')}
                  title={t('entry.navHome')}
                  data-tooltip={t('entry.navHome')}
                  data-tooltip-placement="bottom"
                  data-testid="workspace-home-nav"
                  onClick={(event) => {
                    event.stopPropagation();
                    openTab(tab);
                  }}
                >
                  <Icon name="home" size={14} />
                </button>
              ) : (
                <>
                  <button
                    type="button"
                    className="workspace-tab__main"
                    onClick={() => openTab(tab)}
                  >
                    <span className="workspace-tab__icon" aria-hidden>
                      <Icon name={display.icon} size={14} />
                    </span>
                    <span className="workspace-tab__label">{display.title}</span>
                  </button>
                  {isPinned ? null : (
                    <button
                      type="button"
                      className="workspace-tab__close od-tooltip"
                      aria-label={t('common.close')}
                      title={t('common.close')}
                      data-tooltip={t('common.close')}
                      data-tooltip-placement="bottom"
                      onClick={() => closeTab(tab.id)}
                    >
                      <Icon name="close" size={14} />
                    </button>
                  )}
                </>
              )}
            </div>
          );
        })}
        {/* #5517 drops the top-right "+"; new tab stays reachable through
            ⌘/Ctrl+T. That "+" was the ONLY caller of openRadialMenu, so the
            radial template menu below is now unreachable — its state and
            markup stay, as the reference keeps them.

            The tab-search button is NOT dropped. The reference annotates its
            own removal as "Tab search removed for the demo.", i.e. a demo
            expedient, where it annotates the "+" as "removed per request" —
            a real decision. Following the first would have left the whole
            search popover unreachable (acceptance #46 was filed against it). */}
      </div>
      <div className="workspace-tabs-actions" ref={menuRef}>
        {onboardingActive ? null : (
          <button
            type="button"
            className={`workspace-tabs-icon-btn od-tooltip${tabsMenuOpen ? ' is-active' : ''}`}
            onClick={() => setTabsMenuOpen((open) => !open)}
            title={t('workspace.searchTabs')}
            data-tooltip={t('workspace.searchTabs')}
            data-tooltip-placement="bottom"
            aria-label={t('workspace.searchTabs')}
            aria-haspopup="dialog"
            aria-expanded={tabsMenuOpen}
            data-testid="workspace-tabs-search"
          >
            <Icon name="search" size={14} />
          </button>
        )}
        {tabsMenuOpen && !onboardingActive && typeof document !== 'undefined'
          ? createPortal(
              <div
                className="workspace-tabs-popover"
                role="dialog"
                aria-label={t('workspace.searchTabs')}
                ref={popoverRef}
              >
                <div className="workspace-tabs-search">
                  <Icon name="search" size={14} />
                  <input
                    ref={searchInputRef}
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder={t('workspace.searchFilesPlaceholder')}
                    aria-label={t('workspace.searchTabs')}
                  />
                </div>
                <div className="workspace-tabs-popover__section">
                  <span>{t('workspace.openTabs')}</span>
                  <span>{state.tabs.length}</span>
                </div>
                <div className="workspace-tabs-list" role="listbox" aria-label={t('workspace.openTabs')}>
                  {filteredTabs.length > 0 ? (
                    filteredTabs.map((display) => {
                      const active = display.id === state.activeTabId;
                      return (
                        <div
                          key={display.id}
                          className={`workspace-tabs-list__item${active ? ' is-active' : ''}`}
                          role="option"
                          aria-selected={active}
                        >
                          <button
                            type="button"
                            className="workspace-tabs-list__main od-tooltip"
                            onClick={() => openTab(display.tab)}
                            title={display.title}
                            data-tooltip={display.title}
                            data-tooltip-placement="right"
                          >
                            <span className="workspace-tabs-list__icon" aria-hidden>
                              <Icon name={display.icon} size={15} />
                            </span>
                            <span className="workspace-tabs-list__text">
                              <span className="workspace-tabs-list__title">{display.title}</span>
                              <span className="workspace-tabs-list__meta">{display.meta}</span>
                            </span>
                          </button>
                          {display.tab.kind === 'entry' ? null : (
                            <button
                              type="button"
                              className="workspace-tabs-list__close od-tooltip"
                              onClick={() => closeTab(display.id)}
                              title={t('common.close')}
                              data-tooltip={t('common.close')}
                              data-tooltip-placement="left"
                              aria-label={t('common.close')}
                            >
                              <Icon name="close" size={14} />
                            </button>
                          )}
                        </div>
                      );
                    })
                  ) : (
                    <div className="workspace-tabs-empty">{t('workspace.noTabsFound')}</div>
                  )}
                </div>
              </div>,
              document.body,
            )
          : null}
      </div>
      {radialMenu ? createPortal(
        <div className="workspace-radial-layer" onMouseDown={() => setRadialMenu(null)}>
          <div
            className="workspace-radial-menu"
            style={{ left: radialMenu.x - (RADIAL_SIZE - RADIAL_PAD), top: radialMenu.y - RADIAL_PAD, width: RADIAL_SIZE, height: RADIAL_SIZE }}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <svg width={RADIAL_SIZE} height={RADIAL_SIZE} viewBox={`0 0 ${RADIAL_SIZE} ${RADIAL_SIZE}`}>
              {radialSlots.map((slot) => {
                const [a1, a2] = radialWedgeAngles(slot.seg, slot.segCount);
                const r0 = radialBandRadius(slot.band);
                const r1 = radialBandRadius(slot.band + 1);
                const isHover = slot.chip.id === radialHoverId;
                return (
                  <path
                    key={slot.chip.id}
                    className={`workspace-radial-sector-path${isHover ? ' is-hover' : ''}`}
                    d={radialSectorPath(RADIAL_CX, RADIAL_CY, a1, a2, r0, r1)}
                    role="menuitem"
                    aria-label={homeHeroChipLabel(slot.chip.id, t)}
                    data-testid={`workspace-radial-template-${slot.chip.id}`}
                    onMouseEnter={() => setRadialHoverId(slot.chip.id)}
                    onMouseLeave={() => setRadialHoverId((v) => (v === slot.chip.id ? null : v))}
                    onClick={() => openTemplateFromRadial(slot.chip)}
                  />
                );
              })}
            </svg>
            {radialSlots.map((slot) => {
              const [a1, a2] = radialWedgeAngles(slot.seg, slot.segCount);
              const mid = (a1 + a2) / 2;
              const rmid = (radialBandRadius(slot.band) + radialBandRadius(slot.band + 1)) / 2;
              const ix = RADIAL_CX + rmid * Math.cos((mid * Math.PI) / 180);
              const iy = RADIAL_CY + rmid * Math.sin((mid * Math.PI) / 180);
              const isHover = slot.chip.id === radialHoverId;
              return (
                <span
                  key={slot.chip.id}
                  className={`workspace-radial-icon-btn${isHover ? ' is-hover' : ''}`}
                  aria-hidden
                  style={{ left: ix, top: iy }}
                  title={homeHeroChipLabel(slot.chip.id, t)}
                >
                  <Icon name={slot.chip.icon} size={17} />
                </span>
              );
            })}
          </div>
          <button
            type="button"
            className="workspace-radial-close"
            style={{ left: radialMenu.x, top: radialMenu.y }}
            aria-label={t('common.close')}
            title={t('common.close')}
            onMouseDown={(event) => event.stopPropagation()}
            onClick={() => setRadialMenu(null)}
          >
            <Icon name="plus" size={16} />
          </button>
        </div>,
        document.body,
      ) : null}
    </header>
  );
}

function displayTabFor(
  tab: WorkspaceChromeTab,
  projectById: Map<string, Project>,
  t: ReturnType<typeof useT>,
  knownProjectNames?: Map<string, string>,
): DisplayTab {
  if (tab.kind === 'project') {
    const project = projectById.get(tab.projectId);
    // recvq5eKj2kdF0: `projectById` only covers this render's fetched list
    // (Home's fetch is capped/scoped and does not include every open tab's
    // project) — fall back to the last real name this tab showed before
    // falling back further to the untitled label, so a tab with a real name
    // never regresses to "untitled" just because Home reloaded.
    const title = project?.name?.trim() || knownProjectNames?.get(tab.projectId) || t('common.untitled');
    return {
      id: tab.id,
      title,
      meta: t('workspaceTabs.project'),
      icon: 'folder',
      tab,
    };
  }
  if (tab.kind === 'marketplace') {
    return {
      id: tab.id,
      title: tab.pluginId ? t('workspaceTabs.pluginDetails') : t('workspaceTabs.marketplace'),
      meta: t('entry.navPlugins'),
      icon: 'grid',
      tab,
    };
  }
  const entryTitle: Record<EntryHomeView, string> = {
    home: t('entry.navHome'),
    onboarding: t('settings.welcomeTitle'),
    projects: t('entry.navProjects'),
    tasks: t('entry.navTasks'),
    plugins: t('entry.navPlugins'),
    'design-systems': t('entry.navDesignSystems'),
    library: 'Library',
    brands: t('entry.navBrands'),
    integrations: t('entry.navIntegrations'),
    community: t('pluginsHome.title'),
    drafts: t('entry.navDrafts'),
    'all-projects': t('entry.navAllProjects'),
    members: t('entry.navMembers'),
    board: t('entry.navBoard'),
    'workspace-settings': t('entry.navWorkspaceSettings'),
    settings: t('settings.title'),
  };
  const entryIcon: Record<EntryHomeView, IconName> = {
    home: 'home',
    onboarding: 'sparkles',
    projects: 'folder',
    tasks: 'kanban',
    plugins: 'grid',
    'design-systems': 'blocks',
    library: 'image',
    brands: 'blocks',
    integrations: 'link',
    community: 'globe',
    drafts: 'file',
    'all-projects': 'folder',
    members: 'users',
    board: 'kanban',
    'workspace-settings': 'settings',
    settings: 'settings',
  };
  return {
    id: tab.id,
    title: entryTitle[tab.view],
    meta: tab.view === 'home' ? 'Start a new project' : 'Workspace',
    icon: entryIcon[tab.view],
    tab,
  };
}
