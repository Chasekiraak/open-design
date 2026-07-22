// Horizontal "Recent projects" rail for the Home view.
//
// Mirrors the strip Lovart shows under its hero: a small set of
// recent project cards with a "View all" link that switches to the
// full Projects view. We keep the data shape narrow (Project[] +
// onOpen / onViewAll) so the strip can be reused later by other
// surfaces (e.g. an in-project quick-switcher pane).

import type { CSSProperties } from 'react';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Dialog, DialogDescription, DialogFooter, DialogTitle } from '@open-design/components';
import { useT } from '../i18n';
import type { Dict } from '../i18n/types';
import { fetchProjectFiles, fetchProjectFileText, projectFileUrl } from '../providers/registry';
import type {
  DesignSystemSummary,
  Project,
  ProjectDisplayStatus,
  ProjectFile,
  ProjectKind,
  PromptTemplateSummary,
} from '../types';
import { Icon } from './Icon';
import { InviteDialog } from './InviteDialog';
import { STATUS_LABEL_KEYS } from './DesignsTab';
import { isDesignSystemProject, isPublishedDesignSystemProject } from './design-system-project';
import { rememberDemoProjectAccessContext } from './demoProjectAccess';

interface Props {
  projects: Project[];
  /** Used only to show a "Published" status for design-system projects whose
   *  backing system is published (independent of the project's run status). */
  designSystems?: DesignSystemSummary[];
  /** Drives the "Templates" tab on the Home browser. */
  promptTemplates?: PromptTemplateSummary[];
  /** Retained for call-site compatibility; the strip skips rendering
   *  while the list is loading so we never need a loading state. */
  loading?: boolean;
  /** Section heading (defaults to the Canva-style "最近使用"). */
  heading?: string;
  description?: string;
  onOpen: (id: string) => void;
  onViewAll?: () => void;
  onDelete?: (id: string) => Promise<boolean | void> | boolean | void;
  onRename?: (id: string, name: string) => void;
  limit?: number;
  /** 'recent' = mixed private/shared (home); 'drafts' = all private (mine);
   *  'team' = all shared, varied team-member creators. */
  space?: SpaceKind;
  /** Demo-only: Cloud has team visibility, CLI/BYOK does not. */
  collaborationEnabled?: boolean;
  /** Owner / Admin can invite teammates and choose invited roles. */
  canAssignInviteRoles?: boolean;
  /** Owner / Admin-only collection actions: invite, bulk delete, and team-space moves. */
  canManageProjectCollection?: boolean;
}

type BrowseTab = 'projects' | 'design-systems' | 'templates';
type OwnerFilter = 'all' | 'mine' | 'others';
type ProjectKindFilter = 'all' | 'prototype' | 'deck' | 'media' | 'other';

const EMPTY_DESIGN_SYSTEMS: DesignSystemSummary[] = [];

// Demo-only mocked metadata so the grid shows a believable mix of owners,
// visibility, and recency instead of the seeded "我创建 · just now" uniformity.
const MOCK_MEMBERS = [
  { id: 'me', nameKey: 'demo.RecentProjectsStrip.tsx.member.me.name', initialKey: 'demo.RecentProjectsStrip.tsx.member.me.initial', img: '/team-avatars/a2.png' },
  { id: 'zhangwei', nameKey: 'demo.RecentProjectsStrip.tsx.member.zhangwei.name', initialKey: 'demo.RecentProjectsStrip.tsx.member.zhangwei.initial', img: '/team-avatars/a1.png' },
  { id: 'lina', nameKey: 'demo.RecentProjectsStrip.tsx.member.lina.name', initialKey: 'demo.RecentProjectsStrip.tsx.member.lina.initial', img: '/team-avatars/a3.png' },
  { id: 'wangfang', nameKey: 'demo.RecentProjectsStrip.tsx.member.wangfang.name', initialKey: 'demo.RecentProjectsStrip.tsx.member.wangfang.initial', img: '/team-avatars/a4.png' },
  { id: 'chenming', nameKey: 'demo.RecentProjectsStrip.tsx.member.chenming.name', initialKey: 'demo.RecentProjectsStrip.tsx.member.chenming.initial', img: '/team-avatars/a6.png' },
  { id: 'liuyang', nameKey: 'demo.RecentProjectsStrip.tsx.member.liuyang.name', initialKey: 'demo.RecentProjectsStrip.tsx.member.liuyang.initial', img: '/team-avatars/a7.png' },
] as const satisfies ReadonlyArray<{ id: string; nameKey: keyof Dict; initialKey: keyof Dict; img: string }>;
const MOCK_TIME_KEYS: (keyof Dict)[] = [
  'demo.RecentProjectsStrip.tsx.time.justNow',
  'demo.RecentProjectsStrip.tsx.time.min12',
  'demo.RecentProjectsStrip.tsx.time.hr1',
  'demo.RecentProjectsStrip.tsx.time.hr3',
  'demo.RecentProjectsStrip.tsx.time.yesterday',
  'demo.RecentProjectsStrip.tsx.time.day2',
  'demo.RecentProjectsStrip.tsx.time.lastWeek',
  'demo.RecentProjectsStrip.tsx.time.week3',
];
const DEMO_PROJECT_NAMES = [
  'Brand Portal Refresh',
  'Mobile Banking Concept',
  'AI Writing Landing Page',
  'Creator Dashboard Audit',
  'E-commerce Product Detail',
  'Design Ops Weekly Deck',
  'Healthcare Intake Flow',
  'Fintech Onboarding Kit',
  'SaaS Pricing Experiment',
  'Travel App Homepage',
  'Analytics Command Center',
  'Membership Checkout Flow',
  'Developer Docs Redesign',
  'Campaign Microsite',
  'Consumer App Settings',
  'Team Workspace Overview',
  'Retail Loyalty Prototype',
  'Enterprise Admin Console',
  'Conference Event Site',
  'Restaurant Booking Flow',
  'Education Course Landing',
  'Marketplace Seller Center',
  'AI Image Studio',
  'Portfolio Editorial Site',
  'Subscription Paywall Test',
  'Design System Migration',
  'Customer Support Console',
  'Real Estate Listing Page',
  'Video Tool Launch Deck',
  'Community Growth Report',
];

const ME = MOCK_MEMBERS[0]!;
type SpaceKind = 'recent' | 'drafts' | 'team';
const OWNER_FILTER_OPTIONS: Array<{ id: OwnerFilter; labelKey: keyof Dict }> = [
  { id: 'all', labelKey: 'demo.RecentProjectsStrip.tsx.ownerFilter.all' },
  { id: 'mine', labelKey: 'demo.RecentProjectsStrip.tsx.ownerFilter.mine' },
  { id: 'others', labelKey: 'demo.RecentProjectsStrip.tsx.ownerFilter.others' },
];
const KIND_FILTER_OPTIONS: Array<{ id: ProjectKindFilter; labelKey: keyof Dict }> = [
  { id: 'all', labelKey: 'demo.RecentProjectsStrip.tsx.kindFilter.all' },
  { id: 'prototype', labelKey: 'demo.RecentProjectsStrip.tsx.kindFilter.prototype' },
  { id: 'deck', labelKey: 'demo.RecentProjectsStrip.tsx.kindFilter.deck' },
  { id: 'media', labelKey: 'demo.RecentProjectsStrip.tsx.kindFilter.media' },
  { id: 'other', labelKey: 'demo.RecentProjectsStrip.tsx.kindFilter.other' },
];
function mockCardMeta(index: number, space: SpaceKind) {
  const timeKey = MOCK_TIME_KEYS[index % MOCK_TIME_KEYS.length] ?? MOCK_TIME_KEYS[0]!;
  if (space === 'team') {
    // All projects: everything is shared, owned by varied team members.
    const m = MOCK_MEMBERS[(index * 5 + 1) % MOCK_MEMBERS.length] ?? ME;
    return { ownerId: m.id, ownerNameKey: m.nameKey, ownerInitialKey: m.initialKey, ownerImg: m.img, badge: 'shared' as 'private' | 'shared', timeKey };
  }
  if (space === 'drafts') {
    // Drafts: everything is private, owned by me.
    return { ownerId: ME.id, ownerNameKey: ME.nameKey, ownerInitialKey: ME.initialKey, ownerImg: ME.img, badge: 'private' as 'private' | 'shared', timeKey };
  }
  // Recent (home): a believable mix — private items are mine, shared ones were
  // created by varied teammates (so the avatars read as a real team).
  const badge: 'private' | 'shared' = index % 3 === 0 ? 'shared' : 'private';
  if (badge === 'shared') {
    const m = MOCK_MEMBERS[(index * 3 + 2) % MOCK_MEMBERS.length] ?? ME;
    return { ownerId: m.id, ownerNameKey: m.nameKey, ownerInitialKey: m.initialKey, ownerImg: m.img, badge, timeKey };
  }
  return { ownerId: ME.id, ownerNameKey: ME.nameKey, ownerInitialKey: ME.initialKey, ownerImg: ME.img, badge, timeKey };
}

type ProjectCardMeta = ReturnType<typeof mockCardMeta>;

function canMutateProject(meta: ProjectCardMeta): boolean {
  return meta.ownerId === ME.id;
}

function isReadonlySharedProject(meta: ProjectCardMeta): boolean {
  return meta.badge === 'shared' && !canMutateProject(meta);
}

const NO_PROJECT_MUTATION_TITLE_KEY = 'demo.RecentProjectsStrip.tsx.noMutationTitle';

function filterKindForProject(project: Project): ProjectKindFilter {
  const kind = project.metadata?.kind;
  if (kind === 'deck') return 'deck';
  if (kind === 'image' || kind === 'video') return 'media';
  if (kind === 'prototype' || kind === 'template') return 'prototype';
  return 'other';
}

function withDemoProjects(projects: Project[], space: SpaceKind, targetCount: number): Project[] {
  if (targetCount <= 0 || projects.length >= targetCount) return projects;
  const existingIds = new Set(projects.map((project) => project.id));
  const now = Date.now();
  const demoProjects: Project[] = [];
  for (let index = 0; demoProjects.length < targetCount - projects.length; index += 1) {
    const name = DEMO_PROJECT_NAMES[index % DEMO_PROJECT_NAMES.length] ?? `Design Demo ${index + 1}`;
    const id = `demo-${space}-${index + 1}`;
    if (existingIds.has(id)) continue;
    const kindCycle: ProjectKind[] = [
      'prototype',
      'deck',
      'template',
      'image',
      'other',
    ];
    const kind = kindCycle[index % kindCycle.length] ?? 'prototype';
    demoProjects.push({
      id,
      name,
      skillId: null,
      designSystemId: null,
      createdAt: now - (index + projects.length + 1) * 86_400_000,
      updatedAt: now - (index + projects.length + 1) * 3_600_000,
      status: { value: 'succeeded', updatedAt: now - index * 3_600_000 },
      metadata: {
        kind,
        fidelity: index % 4 === 0 ? 'wireframe' : 'high-fidelity',
        platform: index % 3 === 0 ? 'mobile-ios' : 'responsive',
        nameSource: 'user',
      },
    });
  }
  return [...projects, ...demoProjects];
}

const DECK_PREVIEW_WIDTH = 1280;
const DECK_PREVIEW_HEIGHT = 720;
const deckCoverCache = new Map<string, string>();
const deckCoverInflight = new Map<string, Promise<string>>();
const DEMO_PROJECT_TARGET_COUNT = 30;

export function RecentProjectsStrip({
  projects,
  designSystems = EMPTY_DESIGN_SYSTEMS,
  heading,
  description,
  space = 'recent',
  onOpen,
  onDelete,
  onRename,
  limit = 6,
  collaborationEnabled = true,
  canAssignInviteRoles = true,
  canManageProjectCollection = true,
}: Props) {
  const t = useT();
  const resolvedHeading = heading ?? t('demo.RecentProjectsStrip.tsx.heading');
  const [view, setView] = useState<'grid' | 'list'>('grid');
  const [ownerFilter, setOwnerFilter] = useState<OwnerFilter>('all');
  const [kindFilter, setKindFilter] = useState<ProjectKindFilter>('all');
  const [openHeaderMenu, setOpenHeaderMenu] = useState<'owner' | 'kind' | null>(null);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [moveTarget, setMoveTarget] = useState<{
    project: Project;
    action: 'to-team' | 'to-personal';
  } | null>(null);
  const [moveDontRemind, setMoveDontRemind] = useState(false);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedProjectIds, setSelectedProjectIds] = useState<Set<string>>(() => new Set());
  const [locallyDeletedIds, setLocallyDeletedIds] = useState<Set<string>>(() => new Set());
  // Projects flipped private → shared via "转入团队空间" (demo-local).
  const [movedToTeam, setMovedToTeam] = useState<Set<string>>(() => new Set());
  // Projects flipped shared → private via "移出团队空间" (demo-local).
  const [movedToPersonal, setMovedToPersonal] = useState<Set<string>>(() => new Set());
  const moveTitleId = useId();

  const sorted = useMemo(
    () => [...projects].sort((a, b) => b.updatedAt - a.updatedAt),
    [projects],
  );
  const displayProjects = useMemo(
    () => withDemoProjects(sorted, space, Math.min(limit, DEMO_PROJECT_TARGET_COUNT)),
    [limit, sorted, space],
  );
  const visibleProjectCards = useMemo(
    () => displayProjects
      .map((project, index) => {
        const baseMeta = mockCardMeta(index, space);
        const meta = movedToTeam.has(project.id)
          ? { ...baseMeta, badge: 'shared' as const }
          : movedToPersonal.has(project.id)
            ? { ...baseMeta, badge: 'private' as const, ownerId: ME.id, ownerNameKey: ME.nameKey, ownerInitialKey: ME.initialKey, ownerImg: ME.img }
            : baseMeta;
        return { project, meta };
      })
      .filter(({ project, meta }) => {
        if (locallyDeletedIds.has(project.id)) return false;
        const ownerMatches =
          ownerFilter === 'all'
          || (ownerFilter === 'mine' && meta.ownerId === ME.id)
          || (ownerFilter === 'others' && meta.ownerId !== ME.id);
        const kindMatches = kindFilter === 'all' || filterKindForProject(project) === kindFilter;
        return ownerMatches && kindMatches;
      })
      .slice(0, limit),
    [displayProjects, kindFilter, limit, locallyDeletedIds, movedToPersonal, movedToTeam, ownerFilter, space],
  );
  const [coverByProject, setCoverByProject] = useState<
    Record<string, { kind: 'html' | 'image' | 'video' | 'logo'; name: string } | null>
  >({});
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null);
  const [renameTarget, setRenameTarget] = useState<{ id: string; original: string } | null>(null);
  const [renameInput, setRenameInput] = useState('');
  const [confirmTarget, setConfirmTarget] = useState<Project | null>(null);
  const menuContainerRef = useRef<HTMLDivElement | null>(null);
  const renameTitleId = useId();
  const confirmTitleId = useId();
  const actionsAvailable = canManageProjectCollection && Boolean(onDelete || onRename || collaborationEnabled);
  const activeSelectionMode = canManageProjectCollection && selectionMode;
  const selectedProjectCards = visibleProjectCards.filter(({ project }) => selectedProjectIds.has(project.id));
  const selectedCount = selectedProjectIds.size;
  const selectedProjectNames = selectedProjectCards.map(({ project }) => project.name);
  const selectedContainsReadonlyProject = selectedProjectCards.some(({ meta }) => !canMutateProject(meta));
  const selectedMutationDisabled = selectedCount === 0 || selectedContainsReadonlyProject;
  const selectedMutationTitle = selectedContainsReadonlyProject
    ? t('demo.RecentProjectsStrip.tsx.selectedReadonlyTitle')
    : selectedProjectNames.join('、');
  const canMoveToTeam = canManageProjectCollection && collaborationEnabled && space !== 'team';
  const canMoveToPersonal = canManageProjectCollection && collaborationEnabled && space !== 'drafts';

  useEffect(() => {
    setSelectedProjectIds((current) => {
      if (current.size === 0) return current;
      const visibleIds = new Set(visibleProjectCards.map(({ project }) => project.id));
      const next = new Set([...current].filter((id) => visibleIds.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [visibleProjectCards]);

  useEffect(() => {
    if (!menuOpenId) return;
    function handlePointerDown(event: PointerEvent) {
      const target = event.target;
      if (target instanceof Node && menuContainerRef.current?.contains(target)) return;
      setMenuOpenId(null);
    }
    document.addEventListener('pointerdown', handlePointerDown);
    return () => document.removeEventListener('pointerdown', handlePointerDown);
  }, [menuOpenId]);

  useEffect(() => {
    let cancelled = false;
    if (visibleProjectCards.length === 0) {
      setCoverByProject({});
      return;
    }

    void Promise.all(
      visibleProjectCards.map(async ({ project }) => {
        const designSystemProject = isDesignSystemProject(project);
        if (project.id.startsWith('demo-')) return [project.id, null] as const;
        if (project.metadata?.entryFile && !designSystemProject) return [project.id, null] as const;
        let files: Awaited<ReturnType<typeof fetchProjectFiles>>;
        try {
          files = await fetchProjectFiles(project.id);
        } catch {
          return [project.id, null] as const;
        }
        if (designSystemProject) {
          const cover = await findDesignSystemCover(project.id, files);
          if (cover) {
            return [
              project.id,
              cover,
            ] as const;
          }
          return [project.id, null] as const;
        }
        const html =
          files.find((file) => (file.path ?? file.name) === 'index.html') ??
          files
            .filter((file) => file.kind === 'html')
            .sort((a, b) => b.mtime - a.mtime)[0];
        if (html) {
          return [
            project.id,
            { kind: 'html' as const, name: html.path ?? html.name },
          ] as const;
        }
        const image = files
          .filter((file) => file.kind === 'image')
          .sort((a, b) => b.mtime - a.mtime)[0];
        if (image) {
          return [
            project.id,
            { kind: 'image' as const, name: image.path ?? image.name },
          ] as const;
        }
        const video = files
          .filter((file) => file.kind === 'video')
          .sort((a, b) => b.mtime - a.mtime)[0];
        if (video) {
          return [
            project.id,
            { kind: 'video' as const, name: video.path ?? video.name },
          ] as const;
        }
        return [project.id, null] as const;
      }),
    ).then((entries) => {
      if (cancelled) return;
      setCoverByProject(Object.fromEntries(entries));
    });

    return () => {
      cancelled = true;
    };
  }, [visibleProjectCards]);

  // First-run home shouldn't reserve space for an empty "Recent
  // projects" rail — the dashed empty box just adds visual noise
  // above the plugin gallery. We also skip rendering during the
  // load window so the section doesn't pop in and then collapse;
  // the prompt hero is enough chrome on its own.
  if (visibleProjectCards.length === 0) {
    return null;
  }

  function startRename(project: Project) {
    const card = visibleProjectCards.find(({ project: candidate }) => candidate.id === project.id);
    if (card && !canMutateProject(card.meta)) return;
    setMenuOpenId(null);
    setRenameTarget({ id: project.id, original: project.name });
    setRenameInput(project.name);
  }

  function cancelRename() {
    setRenameTarget(null);
    setRenameInput('');
  }

  function commitRename() {
    if (!renameTarget || !onRename) return;
    const trimmed = renameInput.trim();
    if (trimmed && trimmed !== renameTarget.original) {
      onRename(renameTarget.id, trimmed);
    }
    cancelRename();
  }

  function requestDelete(project: Project) {
    const card = visibleProjectCards.find(({ project: candidate }) => candidate.id === project.id);
    if (card && !canMutateProject(card.meta)) return;
    setMenuOpenId(null);
    setConfirmTarget(project);
  }

  async function commitDelete() {
    if (!confirmTarget || !onDelete) return;
    const target = confirmTarget;
    setConfirmTarget(null);
    await onDelete(target.id);
  }

  function toggleSelection(projectId: string) {
    setSelectedProjectIds((current) => {
      const next = new Set(current);
      if (next.has(projectId)) {
        next.delete(projectId);
      } else {
        next.add(projectId);
      }
      return next;
    });
  }

  function exitSelectionMode() {
    setSelectionMode(false);
    setSelectedProjectIds(new Set());
  }

  async function batchDeleteSelected() {
    if (selectedProjectIds.size === 0) return;
    if (selectedContainsReadonlyProject) return;
    const ids = [...selectedProjectIds];
    setLocallyDeletedIds((current) => {
      const next = new Set(current);
      ids.forEach((id) => next.add(id));
      return next;
    });
    exitSelectionMode();
    if (!onDelete) return;
    await Promise.all(
      ids
        .filter((id) => !id.startsWith('demo-'))
        .map((id) => Promise.resolve(onDelete(id))),
    );
  }

  function batchMoveSelected(action: 'to-team' | 'to-personal') {
    if (selectedProjectIds.size === 0) return;
    if (selectedContainsReadonlyProject) return;
    const ids = [...selectedProjectIds];
    if (action === 'to-team') {
      setMovedToTeam((current) => {
        const next = new Set(current);
        ids.forEach((id) => next.add(id));
        return next;
      });
      setMovedToPersonal((current) => {
        const next = new Set(current);
        ids.forEach((id) => next.delete(id));
        return next;
      });
    } else {
      setMovedToPersonal((current) => {
        const next = new Set(current);
        ids.forEach((id) => next.add(id));
        return next;
      });
      setMovedToTeam((current) => {
        const next = new Set(current);
        ids.forEach((id) => next.delete(id));
        return next;
      });
    }
    exitSelectionMode();
  }

  return (
    <section className="recent-projects" data-testid="recent-projects-strip">
      <header className="recent-projects__head">
        <div className="recent-projects__title-block">
          <h2 className="recent-projects__heading">{resolvedHeading}</h2>
          {description ? (
            <p className="recent-projects__description">{description}</p>
          ) : null}
        </div>
        <div className="recent-projects__controls">
          {collaborationEnabled && space === 'team' && canAssignInviteRoles ? (
            <button
              type="button"
              className="recent-projects__invite"
              onClick={() => setInviteOpen(true)}
            >
              <Icon name="share" size={15} /> {t('demo.RecentProjectsStrip.tsx.invite')}
            </button>
          ) : null}
          {canManageProjectCollection ? (
            <button
              type="button"
              className={`recent-projects__select-toggle${selectionMode ? ' is-active' : ''}`}
              aria-pressed={selectionMode}
              onClick={() => {
                if (selectionMode) {
                  exitSelectionMode();
                } else {
                  setSelectionMode(true);
                  setMenuOpenId(null);
                }
              }}
            >
              {t('demo.RecentProjectsStrip.tsx.multiSelect')}
            </button>
          ) : null}
          <div className="recent-projects__filter-wrap">
            <button
              type="button"
              className="recent-projects__filter"
              aria-expanded={openHeaderMenu === 'owner'}
              onClick={() => setOpenHeaderMenu((current) => current === 'owner' ? null : 'owner')}
            >
              {(() => {
                const active = OWNER_FILTER_OPTIONS.find((option) => option.id === ownerFilter);
                return t((active ?? OWNER_FILTER_OPTIONS[0]!).labelKey);
              })()}
              <Icon name="chevron-down" size={14} />
            </button>
            {openHeaderMenu === 'owner' ? (
              <div className="recent-projects__filter-menu" role="menu">
                {OWNER_FILTER_OPTIONS.map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    className={ownerFilter === option.id ? 'is-active' : ''}
                    onClick={() => {
                      setOwnerFilter(option.id);
                      setOpenHeaderMenu(null);
                    }}
                  >
                    {t(option.labelKey)}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
          <div className="recent-projects__filter-wrap">
            <button
              type="button"
              className="recent-projects__filter"
              aria-expanded={openHeaderMenu === 'kind'}
              onClick={() => setOpenHeaderMenu((current) => current === 'kind' ? null : 'kind')}
            >
              {(() => {
                const active = KIND_FILTER_OPTIONS.find((option) => option.id === kindFilter);
                return t((active ?? KIND_FILTER_OPTIONS[0]!).labelKey);
              })()}
              <Icon name="chevron-down" size={14} />
            </button>
            {openHeaderMenu === 'kind' ? (
              <div className="recent-projects__filter-menu" role="menu">
                {KIND_FILTER_OPTIONS.map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    className={kindFilter === option.id ? 'is-active' : ''}
                    onClick={() => {
                      setKindFilter(option.id);
                      setOpenHeaderMenu(null);
                    }}
                  >
                    {t(option.labelKey)}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
          <button type="button" className="recent-projects__view-btn" aria-label={t('demo.RecentProjectsStrip.tsx.sort')}>
            <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 7h6M3 12h10M3 17h14M17 4v8m0 0 3-3m-3 3-3-3" />
            </svg>
          </button>
          <div className="recent-projects__view" role="group" aria-label={t('designs.viewToggleAria')}>
            <button
              type="button"
              className={`recent-projects__view-btn${view === 'grid' ? ' is-active' : ''}`}
              aria-pressed={view === 'grid'}
              aria-label={t('designs.viewGrid')}
              onClick={() => setView('grid')}
            >
              <Icon name="grid" size={15} />
            </button>
            <button
              type="button"
              className={`recent-projects__view-btn${view === 'list' ? ' is-active' : ''}`}
              aria-pressed={view === 'list'}
              onClick={() => setView('list')}
            >
              <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
                <path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01" />
              </svg>
            </button>
          </div>
        </div>
      </header>
      {activeSelectionMode ? (
        <div className="recent-projects__bulkbar" role="toolbar" aria-label={t('demo.RecentProjectsStrip.tsx.bulkToolbar')}>
          <span className="recent-projects__bulkbar-count">
            {t('demo.RecentProjectsStrip.tsx.selectedPrefix')} <strong>{selectedCount}</strong> {t('demo.RecentProjectsStrip.tsx.selectedSuffix')}
          </span>
          <div className="recent-projects__bulkbar-actions">
            {canMoveToTeam ? (
              <button
                type="button"
                disabled={selectedMutationDisabled}
                title={selectedMutationTitle}
                onClick={() => batchMoveSelected('to-team')}
              >
                <Icon name="import" size={14} /> {t('demo.RecentProjectsStrip.tsx.moveToTeam')}
              </button>
            ) : null}
            {canMoveToPersonal ? (
              <button
                type="button"
                disabled={selectedMutationDisabled}
                title={selectedMutationTitle}
                onClick={() => batchMoveSelected('to-personal')}
              >
                <Icon name="log-out" size={14} /> {t('demo.RecentProjectsStrip.tsx.moveToPersonal')}
              </button>
            ) : null}
            <button
              type="button"
              className="danger"
              disabled={selectedMutationDisabled}
              title={selectedMutationTitle}
              onClick={() => void batchDeleteSelected()}
            >
              <Icon name="trash" size={14} /> {t('demo.RecentProjectsStrip.tsx.bulkDelete')}
            </button>
            <button type="button" className="ghost" onClick={exitSelectionMode}>
              {t('demo.RecentProjectsStrip.tsx.cancel')}
            </button>
          </div>
        </div>
      ) : null}
      <div
        className={`recent-projects__row recent-projects__row--${view}${menuOpenId ? ' recent-projects__row--menu-open' : ''}${activeSelectionMode ? ' is-selecting' : ''}`}
        role="list"
      >
        {visibleProjectCards.map(({ project, meta }, cardIndex) => {
          const cover = projectCover(project, coverByProject[project.id] ?? null, cardIndex);
          const projectMoveAction: 'to-team' | 'to-personal' =
            meta.badge === 'shared' ? 'to-personal' : 'to-team';
          const designSystemProject = isDesignSystemProject(project);
          const status: ProjectDisplayStatus = project.status?.value ?? 'not_started';
          const publishedDesignSystem = isPublishedDesignSystemProject(project, designSystems);
          const isActive =
            !publishedDesignSystem &&
            (status === 'running' || status === 'queued' || status === 'awaiting_input');
          const selected = selectedProjectIds.has(project.id);
          const readonlySharedProject = isReadonlySharedProject(meta);
          const projectMutationAllowed = canMutateProject(meta);
          const isShared = collaborationEnabled && space !== 'team' && meta.badge === 'shared';
          const sharedBadge = (variant: 'overlay' | 'inline') =>
            isShared ? (
              <span
                className={`recent-projects__card-badge recent-projects__card-badge--shared recent-projects__card-badge--${variant}`}
              >
                <svg width={11} height={11} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="9" cy="8" r="3" />
                  <path d="M3 20a6 6 0 0 1 12 0M16 11a3 3 0 1 0-1-5.8M21 20a6 6 0 0 0-5-5.9" />
                </svg>
                {t('demo.RecentProjectsStrip.tsx.shared')}
              </span>
            ) : null;
          return (
            <div
              key={project.id}
              role="listitem"
              className={`recent-projects__card${designSystemProject ? ' is-design-system-project' : ''}${menuOpenId === project.id ? ' is-menu-open' : ''}${activeSelectionMode && selected ? ' is-selected' : ''}${readonlySharedProject ? ' is-readonly-shared' : ''}`}
              data-project-id={project.id}
            >
              {activeSelectionMode ? (
                <button
                  type="button"
                  className="recent-projects__select-check"
                  aria-pressed={selected}
                  aria-label={selected ? `${t('demo.RecentProjectsStrip.tsx.deselect')} ${project.name}` : `${t('demo.RecentProjectsStrip.tsx.select')} ${project.name}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    toggleSelection(project.id);
                  }}
                >
                  <span aria-hidden>
                    {selected ? (
                      <svg
                        viewBox="0 0 24 24"
                        fill="currentColor"
                        width={16}
                        height={16}
                        style={{ display: 'block' }}
                      >
                        <path d="M9.9997 15.1709L19.1921 5.97852L20.6063 7.39273L9.9997 17.9993L3.63574 11.6354L5.04996 10.2212L9.9997 15.1709Z" />
                      </svg>
                    ) : null}
                  </span>
                </button>
              ) : null}
              <button
                type="button"
                className="recent-projects__card-main"
                onClick={() => {
                  if (activeSelectionMode) {
                    toggleSelection(project.id);
                  } else {
                    rememberDemoProjectAccessContext({
                      projectId: project.id,
                      projectName: project.name,
                      ownerName: t(meta.ownerNameKey),
                      ownerInitial: t(meta.ownerInitialKey),
                      ...(meta.ownerImg ? { ownerImg: meta.ownerImg } : {}),
                      badge: meta.badge,
                      space,
                      viewerOnly: collaborationEnabled && readonlySharedProject,
                    });
                    onOpen(project.id);
                  }
                }}
                title={project.name}
              >
                <div
                  className={`recent-projects__card-thumb recent-projects__card-thumb-${cover.kind}`}
                  style={cover.style}
                  aria-hidden
                >
                  {(cover.kind === 'image' || cover.kind === 'logo') && cover.src ? (
                    <img
                      className="recent-projects__thumb-media"
                      src={cover.src}
                      alt=""
                      loading="lazy"
                    />
                  ) : cover.kind === 'video' && cover.src ? (
                    <video
                      className="recent-projects__thumb-media"
                      src={cover.src}
                      muted
                      preload="metadata"
                      playsInline
                    />
                  ) : cover.kind === 'html' && cover.src ? (
                    <RecentProjectHtmlThumb
                      src={cover.src}
                      deckCoverOnly={project.metadata?.kind === 'deck'}
                    />
                  ) : (
                    <span className="recent-projects__card-glyph">{cover.initial}</span>
                  )}
                  {view === 'grid' ? sharedBadge('overlay') : null}
                </div>
                <div className="recent-projects__card-meta">
                  <div className="recent-projects__card-name-row">
                    <span className="recent-projects__card-name">{project.name}</span>
                    {view === 'list' ? sharedBadge('inline') : null}
                  </div>
                  <div className="recent-projects__card-footer">
                    <div className="recent-projects__card-time">
                      <span className="recent-projects__card-owner" aria-hidden>
                        {meta.ownerImg ? <img src={meta.ownerImg} alt="" loading="lazy" /> : t(meta.ownerInitialKey)}
                      </span>
                      <span className="recent-projects__card-owner-name">{t('demo.RecentProjectsStrip.tsx.createdBy', { name: t(meta.ownerNameKey) })}</span>
                      <span className="recent-projects__card-sep" aria-hidden>·</span>
                      {t(meta.timeKey)}
                    </div>
                    <div className="design-card-tag-row">
                      {designSystemProject ? (
                        <DesignSystemProjectTag />
                      ) : (
                        <ProjectTag category={projectCategory(project)} />
                      )}
                    </div>
                  </div>
                </div>
              </button>
              {actionsAvailable && !selectionMode ? (
                <div
                  className="recent-projects__card-menu-anchor"
                  ref={menuOpenId === project.id ? menuContainerRef : undefined}
                >
                  <button
                    type="button"
                  className="recent-projects__card-more"
                  aria-label={t('designs.menuMore')}
                  aria-haspopup="menu"
                  aria-expanded={menuOpenId === project.id}
                    onClick={(event) => {
                      event.stopPropagation();
                      setMenuOpenId((current) => current === project.id ? null : project.id);
                    }}
                  >
                    <Icon name="more-horizontal" size={14} />
                  </button>
                  {menuOpenId === project.id ? (
                    <div
                      className="recent-projects__card-menu"
                      role="menu"
                      onClick={(event) => event.stopPropagation()}
                    >
                      {collaborationEnabled ? (
                        <button
                          type="button"
                          role="menuitem"
                          disabled={!projectMutationAllowed}
                          title={projectMutationAllowed ? undefined : t(NO_PROJECT_MUTATION_TITLE_KEY)}
                          onClick={() => {
                            if (!projectMutationAllowed) return;
                            setMenuOpenId(null);
                            setMoveTarget({ project, action: projectMoveAction });
                          }}
                        >
                          <Icon name={projectMoveAction === 'to-team' ? 'import' : 'log-out'} size={14} />
                          <span>{projectMoveAction === 'to-team' ? t('demo.RecentProjectsStrip.tsx.moveToTeam') : t('demo.RecentProjectsStrip.tsx.moveToPersonal')}</span>
                        </button>
                      ) : null}
                      {onRename ? (
                        <button
                          type="button"
                          role="menuitem"
                          disabled={!projectMutationAllowed}
                          title={projectMutationAllowed ? undefined : t(NO_PROJECT_MUTATION_TITLE_KEY)}
                          onClick={() => startRename(project)}
                        >
                          <Icon name="pencil" size={14} />
                          <span>{t('designs.menuRename')}</span>
                        </button>
                      ) : null}
                      {onDelete ? (
                        <button
                          type="button"
                          role="menuitem"
                          className="danger"
                          disabled={!projectMutationAllowed}
                          title={projectMutationAllowed ? undefined : t(NO_PROJECT_MUTATION_TITLE_KEY)}
                          onClick={() => requestDelete(project)}
                        >
                          <Icon name="close" size={14} />
                          <span>{t('designs.menuDelete')}</span>
                        </button>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
      {renameTarget ? (
        <Dialog
          as="form"
          className="modal-rename"
          onClose={cancelRename}
          closeOnEscape
          ariaLabelledBy={renameTitleId}
          onSubmit={(event) => {
            event.preventDefault();
            commitRename();
          }}
        >
          <DialogTitle id={renameTitleId}>{t('designs.renameTitle')}</DialogTitle>
          <input
            type="text"
            aria-label={t('designs.renameTitle')}
            value={renameInput}
            autoFocus
            onChange={(event) => setRenameInput(event.target.value)}
          />
          <DialogFooter className="row">
            <button type="button" onClick={cancelRename}>
              {t('designs.renameCancel')}
            </button>
            <button
              type="submit"
              className="primary"
              disabled={!renameInput.trim() || renameInput.trim() === renameTarget.original}
            >
              {t('designs.renameSave')}
            </button>
          </DialogFooter>
        </Dialog>
      ) : null}
      {confirmTarget ? (
        <Dialog
          className="modal-confirm"
          role="alertdialog"
          onClose={() => setConfirmTarget(null)}
          closeOnEscape
          ariaLabelledBy={confirmTitleId}
        >
          <DialogTitle id={confirmTitleId}>{t('designs.deleteTitle')}</DialogTitle>
          <DialogDescription>
            {t('demo.RecentProjectsStrip.tsx.deleteConfirm', { name: confirmTarget.name })}
          </DialogDescription>
          <DialogFooter className="row">
            <button type="button" onClick={() => setConfirmTarget(null)}>
              {t('designs.renameCancel')}
            </button>
            <button type="button" className="primary danger" onClick={() => void commitDelete()}>
              {t('designs.menuDelete')}
            </button>
          </DialogFooter>
        </Dialog>
      ) : null}
      {moveTarget ? (
        <Dialog
          className="modal-confirm"
          role="alertdialog"
          onClose={() => setMoveTarget(null)}
          closeOnEscape
          ariaLabelledBy={moveTitleId}
        >
          <DialogTitle id={moveTitleId}>
            {moveTarget.action === 'to-team' ? t('demo.RecentProjectsStrip.tsx.moveToTeam') : t('demo.RecentProjectsStrip.tsx.moveToPersonal')}
          </DialogTitle>
          <DialogDescription>
            {moveTarget.action === 'to-team' ? (
              <>
                {t('demo.RecentProjectsStrip.tsx.moveToTeamDesc.pre')}<strong>{t('demo.RecentProjectsStrip.tsx.moveToTeamDesc.strong')}</strong>{t('demo.RecentProjectsStrip.tsx.moveToTeamDesc.post')}
              </>
            ) : (
              <>
                {t('demo.RecentProjectsStrip.tsx.moveToPersonalDesc.pre')}<strong>{t('demo.RecentProjectsStrip.tsx.moveToPersonalDesc.strong')}</strong>{t('demo.RecentProjectsStrip.tsx.moveToPersonalDesc.post')}
              </>
            )}
          </DialogDescription>
          <DialogFooter className="row">
            <label
              className="recent-projects__move-remind"
              style={{ marginRight: 'auto', alignSelf: 'center' }}
            >
              <input
                type="checkbox"
                checked={moveDontRemind}
                onChange={(event) => setMoveDontRemind(event.target.checked)}
              />
              {t('demo.RecentProjectsStrip.tsx.dontRemind')}
            </label>
            <button type="button" onClick={() => setMoveTarget(null)}>
              {t('designs.renameCancel')}
            </button>
            <button
              type="button"
              className={`primary${moveTarget.action === 'to-team' ? ' recent-projects__move-confirm' : ''}`}
              onClick={() => {
                if (moveTarget.action === 'to-team') {
                  setMovedToTeam((prev) => new Set(prev).add(moveTarget.project.id));
                  setMovedToPersonal((prev) => {
                    const next = new Set(prev);
                    next.delete(moveTarget.project.id);
                    return next;
                  });
                } else {
                  setMovedToPersonal((prev) => new Set(prev).add(moveTarget.project.id));
                  setMovedToTeam((prev) => {
                    const next = new Set(prev);
                    next.delete(moveTarget.project.id);
                    return next;
                  });
                }
                setMoveTarget(null);
              }}
            >
              {moveTarget.action === 'to-team' ? t('demo.RecentProjectsStrip.tsx.confirmMoveToTeam') : t('demo.RecentProjectsStrip.tsx.confirmMoveToPersonal')}
            </button>
          </DialogFooter>
        </Dialog>
      ) : null}
      <InviteDialog
        open={inviteOpen}
        onClose={() => setInviteOpen(false)}
        canAssignRoles={canAssignInviteRoles}
      />
    </section>
  );
}

function RecentProjectHtmlThumb({
  src,
  deckCoverOnly,
}: {
  src: string;
  deckCoverOnly: boolean;
}) {
  if (!deckCoverOnly) {
    return (
      <iframe
        className="recent-projects__thumb-iframe"
        src={src}
        title=""
        loading="lazy"
        sandbox="allow-scripts"
        tabIndex={-1}
      />
    );
  }

  return <DeckCoverThumb src={src} />;
}

function DeckCoverThumb({ src }: { src: string }) {
  const frameRef = useRef<HTMLDivElement | null>(null);
  const [srcDoc, setSrcDoc] = useState<string | null>(() => deckCoverCache.get(src) ?? null);
  const [scale, setScale] = useState(1);

  useEffect(() => {
    let cancelled = false;
    const cached = deckCoverCache.get(src);
    if (cached) {
      setSrcDoc(cached);
      return;
    }
    setSrcDoc(null);
    loadDeckCover(src)
      .then((next) => {
        if (!cancelled) setSrcDoc(next);
      })
      .catch(() => {
        if (cancelled) return;
        setSrcDoc(null);
      });
    return () => {
      cancelled = true;
    };
  }, [src]);

  useEffect(() => {
    const node = frameRef.current;
    if (!node) return;
    const update = () => {
      const rect = node.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      setScale(Math.min(rect.width / DECK_PREVIEW_WIDTH, rect.height / DECK_PREVIEW_HEIGHT));
    };
    update();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', update);
      return () => window.removeEventListener('resize', update);
    }
    const observer = new ResizeObserver(update);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={frameRef}
      className="recent-projects__deck-frame"
      style={{ '--recent-deck-scale': scale } as CSSProperties}
      aria-hidden
    >
      {srcDoc ? (
        <iframe
          className="recent-projects__deck-iframe"
          srcDoc={srcDoc}
          title=""
          loading="lazy"
          sandbox=""
          tabIndex={-1}
        />
      ) : (
        <span className="recent-projects__deck-cover-loading" aria-hidden />
      )}
    </div>
  );
}

async function loadDeckCover(src: string): Promise<string> {
  const cached = deckCoverCache.get(src);
  if (cached) return cached;
  const existing = deckCoverInflight.get(src);
  if (existing) return existing;
  const run = fetch(src)
    .then((res) => {
      if (!res.ok) throw new Error(`Failed to load project cover: ${res.status}`);
      return res.text();
    })
    .then((html) => {
      const parsed = deckPreviewSrcDoc(html);
      deckCoverCache.set(src, parsed);
      deckCoverInflight.delete(src);
      return parsed;
    })
    .catch((error) => {
      deckCoverInflight.delete(src);
      throw error;
    });
  deckCoverInflight.set(src, run);
  return run;
}

function deckPreviewSrcDoc(html: string): string {
  const withoutScripts = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/giu, '');
  const style = `<style id="od-recent-deck-real-preview">
    html,
    body {
      margin: 0 !important;
      width: ${DECK_PREVIEW_WIDTH}px !important;
      height: ${DECK_PREVIEW_HEIGHT}px !important;
      overflow: hidden !important;
    }
    body {
      display: block !important;
      scroll-snap-type: none !important;
    }
    .slide,
    section[data-slide],
    section[data-screen-label] {
      position: absolute !important;
      inset: 0 !important;
      width: ${DECK_PREVIEW_WIDTH}px !important;
      height: ${DECK_PREVIEW_HEIGHT}px !important;
      flex: none !important;
      scroll-snap-align: none !important;
    }
    .slide:not(:first-of-type),
    section[data-slide]:not(:first-of-type),
    section[data-screen-label]:not(:first-of-type),
    .deck-counter,
    .deck-controls,
    .deck-hint,
    .deck-page-controls,
    .deck-pager,
    .deck-progress,
    .deck-nav,
    .deck-navigation,
    .page-controls,
    .page-flip-controls,
    .page-nav,
    .page-navigation,
    .pagination-control,
    .pagination-controls,
    #deck-prev,
    #deck-next,
    #deck-cur,
    #deck-total,
    [data-deck-controls],
    [data-page-controls],
    [data-pagination],
    [aria-label="Previous slide"],
    [aria-label="Next slide"],
    [aria-label="Deck navigation"],
    [aria-label="Page navigation"],
    [aria-label="Pagination"],
    nav[aria-label*="page" i],
    nav[aria-label*="pagination" i] {
      display: none !important;
      visibility: hidden !important;
      pointer-events: none !important;
    }
  </style>`;
  return injectBefore(withoutScripts, '</head>', style);
}

function injectBefore(source: string, marker: string, addition: string): string {
  const index = source.toLowerCase().lastIndexOf(marker);
  if (index === -1) return `${addition}${source}`;
  return `${source.slice(0, index)}${addition}${source.slice(index)}`;
}

function statusLabel(
  status: ProjectDisplayStatus,
  t: ReturnType<typeof useT>,
): string {
  return t(STATUS_LABEL_KEYS[status]);
}

function relativeTime(ts: number, t: ReturnType<typeof useT>): string {
  const diff = Date.now() - ts;
  const min = 60_000;
  const hr = 60 * min;
  const day = 24 * hr;
  if (diff < min) return t('common.justNow');
  if (diff < hr) return t('common.minutesAgo', { n: Math.floor(diff / min) });
  if (diff < day) return t('common.hoursAgo', { n: Math.floor(diff / hr) });
  if (diff < 7 * day) return t('common.daysAgo', { n: Math.floor(diff / day) });
  return new Date(ts).toLocaleDateString();
}

// Temporary placeholder covers for projects without a real cover: 12 mock
// images under public/mock-covers, cycled by the card's list position so
// neighboring cards never repeat. Remove once real covers exist for all
// projects.
const MOCK_COVER_COUNT = 12;
function mockCoverUrl(cardIndex: number): string {
  return `/mock-covers/cover-${cardIndex % MOCK_COVER_COUNT}.jpg`;
}

export function projectCover(
  project: Project,
  override: { kind: 'html' | 'image' | 'video' | 'logo'; name: string } | null,
  cardIndex: number,
): {
  kind: 'image' | 'video' | 'html' | 'logo' | 'fallback';
  src?: string;
  style: CSSProperties;
  initial: string;
} {
  const style: CSSProperties = {
    background: 'linear-gradient(135deg, var(--bg-subtle) 0%, var(--bg-panel) 100%)',
  };
  const trimmed = project.name.trim();
  const initial = (trimmed ? Array.from(trimmed)[0]! : '?').toUpperCase();
  if (override) {
    return {
      kind: override.kind,
      src: projectFileUrl(project.id, override.name),
      style,
      initial,
    };
  }
  const meta = project.metadata;
  const entry = meta?.entryFile;
  if (entry) {
    const src = projectFileUrl(project.id, entry);
    if (meta?.kind === 'image') return { kind: 'image', src, style, initial };
    if (meta?.kind === 'video') return { kind: 'video', src, style, initial };
    if (/\.html?$/i.test(entry)) return { kind: 'html', src, style, initial };
  }
  return { kind: 'image', src: mockCoverUrl(cardIndex), style, initial };
}

export type ProjectCategory = 'prototype' | 'live-artifact' | 'slide' | 'media' | 'brand';

export function projectCategory(project: Project): ProjectCategory {
  const meta = project.metadata;
  if (meta?.intent === 'live-artifact' || project.skillId === 'live-artifact') {
    return 'live-artifact';
  }
  if (meta?.kind === 'deck') return 'slide';
  if (meta?.kind === 'brand') return 'brand';
  if (meta?.kind === 'image' || meta?.kind === 'video' || meta?.kind === 'audio') {
    return 'media';
  }
  return 'prototype';
}

export function ProjectTag({ category }: { category: ProjectCategory }) {
  const t = useT();
  const label =
    category === 'live-artifact'
      ? t('designs.tagLiveArtifact')
      : category === 'slide'
        ? t('designs.tagSlide')
        : category === 'brand'
          ? 'Brand'
        : category === 'media'
          ? t('designs.tagMedia')
          : t('designs.tagPrototype');
  return <span className={`design-card-tag tag-${category}`}>{label}</span>;
}

function DesignSystemProjectTag() {
  return <span className="design-card-tag tag-design-system">Design System</span>;
}

function findDesignSystemLogoFile(files: ProjectFile[]): ProjectFile | null {
  const logoCandidates = files
    .filter((file) => file.type !== 'dir')
    .filter((file) => {
      const name = file.path ?? file.name;
      return file.kind === 'image' || /\.(svg|png|jpe?g|webp|gif)$/iu.test(name);
    });
  return (
    logoCandidates.find((file) => (file.path ?? file.name).toLowerCase() === 'assets/logo.svg') ??
    logoCandidates.find((file) => /(^|\/)(logo|wordmark|brand-mark|brandmark|mark|icon|favicon)[^/]*\.(svg|png|jpe?g|webp|gif)$/iu.test(file.path ?? file.name)) ??
    null
  );
}

async function findDesignSystemCover(
  projectId: string,
  files: ProjectFile[],
): Promise<{ kind: 'image' | 'logo'; name: string } | null> {
  const knownFiles = new Set(files.map((file) => file.path ?? file.name));
  const brandCover = await designSystemCoverFromBrandJson(projectId, knownFiles);
  if (brandCover) return brandCover;

  const logo = findDesignSystemLogoFile(files);
  if (!logo) return null;
  return { kind: 'logo', name: logo.path ?? logo.name };
}

async function designSystemCoverFromBrandJson(
  projectId: string,
  knownFiles: ReadonlySet<string>,
): Promise<{ kind: 'image' | 'logo'; name: string } | null> {
  const raw = await fetchProjectFileText(projectId, 'brand.json', { cache: 'no-store' });
  if (!raw) return null;
  let brand: unknown;
  try {
    brand = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!brand || typeof brand !== 'object') return null;
  const root = brand as Record<string, unknown>;
  const imagery = root.imagery && typeof root.imagery === 'object'
    ? root.imagery as Record<string, unknown>
    : null;
  const samples = Array.isArray(imagery?.samples) ? imagery.samples : [];
  const samplePaths = samples
    .filter((sample): sample is Record<string, unknown> => Boolean(sample && typeof sample === 'object'))
    .sort((a, b) => imageSampleRank(a.kind) - imageSampleRank(b.kind))
    .map((sample) => typeof sample.file === 'string' ? sample.file : null)
    .filter((file): file is string => Boolean(file));
  const image = samplePaths.find((file) => knownFiles.has(file) && isRasterOrSvgImage(file));
  if (image) return { kind: 'image', name: image };

  const logo = root.logo && typeof root.logo === 'object' ? root.logo as Record<string, unknown> : null;
  const alternates = Array.isArray(logo?.alternates) ? logo.alternates : [];
  const logoCandidates = [
    typeof logo?.primary === 'string' ? logo.primary : null,
    ...alternates,
  ];
  const nonFaviconLogo = logoCandidates.find(
    (candidate): candidate is string =>
      typeof candidate === 'string' &&
      knownFiles.has(candidate) &&
      isRasterOrSvgImage(candidate) &&
      !/(^|\/)favicon[-.]/iu.test(candidate),
  );
  if (nonFaviconLogo) return { kind: 'logo', name: nonFaviconLogo };
  if (typeof logo?.primary === 'string' && knownFiles.has(logo.primary) && isRasterOrSvgImage(logo.primary)) {
    return { kind: 'logo', name: logo.primary };
  }
  return null;
}

function imageSampleRank(kind: unknown): number {
  if (kind === 'cover') return 0;
  if (kind === 'hero') return 1;
  return 2;
}

function isRasterOrSvgImage(path: string): boolean {
  return /\.(svg|png|jpe?g|webp|gif)$/iu.test(path);
}
