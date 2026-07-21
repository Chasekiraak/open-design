import type { TeamProject, WorkspaceCollabContext } from '@open-design/contracts';
import type { Project } from '../types';

/**
 * The card list behind the 全部项目 grid.
 *
 * The invariant: **only SHARED projects appear here.** A project becomes shared
 * when the user takes the share action; until then it lives in 草稿 and nowhere
 * else. That is a product decision, recorded on the acceptance doc
 * (2026-07-20): "项目要用户点击共享动作才会共享，不然默认是会到草稿里". A previous
 * change read the grid's name literally and let every local project in — do not
 * redo that without checking with product first.
 *
 * So the list is: the member's own local projects that the hub already lists as
 * shared, plus the shared projects they have not pulled yet, deduped by id.
 *
 * A shared project the member has not pulled yet has no local record, so it is
 * synthesized into a normal card: placeholder name until the pull registers it
 * under its real name, timestamps from when it was shared.
 *
 * Names follow the hub catalog for rows owned by SOMEONE ELSE (a pulled copy's
 * local name freezes at pull time, so an owner's rename would otherwise never
 * converge here). The member's own rows keep the local name — their fresh
 * rename may not have round-tripped to the catalog yet, and letting the stale
 * catalog name win would look like the rename bounced.
 */
export function buildAllProjectsList(input: {
  projects: Project[];
  teamProjects: TeamProject[];
  workspaceContext: WorkspaceCollabContext | null;
  /** Display name for a shared project that has no catalog name yet. */
  sharedFallbackName: string;
  now?: () => number;
}): Project[] {
  const { projects, teamProjects, workspaceContext, sharedFallbackName } = input;
  const now = input.now ?? Date.now;

  // A personal workspace has no hub side: the local list already IS everything.
  if (workspaceContext?.workspaceType === 'personal') return projects;

  const localProjectIds = new Set(projects.map((project) => project.id));
  const selfMemberId = workspaceContext?.workspaceMemberId ?? null;

  const catalogNameOverride = new Map(
    teamProjects
      .filter((teamProject) => teamProject.ownerMemberId !== selfMemberId)
      .map((teamProject) => [teamProject.projectId, teamProject.name?.trim() || '']),
  );

  const teamSharedProjectIds = new Set(teamProjects.map((teamProject) => teamProject.projectId));
  const localCards = projects
    .filter((project) => teamSharedProjectIds.has(project.id))
    .map((project) => {
      const catalogName = catalogNameOverride.get(project.id);
      return catalogName && catalogName !== project.name ? { ...project, name: catalogName } : project;
    });

  const sharedCards: Project[] = teamProjects
    .filter((teamProject) => !localProjectIds.has(teamProject.projectId))
    .map((teamProject) => {
      const sharedAtMs = Date.parse(teamProject.sharedAt);
      const fallbackTimestamp = Number.isFinite(sharedAtMs) ? sharedAtMs : now();
      return {
        id: teamProject.projectId,
        name: teamProject.name?.trim() || sharedFallbackName,
        skillId: teamProject.skillId ?? null,
        designSystemId: teamProject.designSystemId ?? null,
        createdAt: typeof teamProject.createdAt === 'number' ? teamProject.createdAt : fallbackTimestamp,
        updatedAt: typeof teamProject.updatedAt === 'number' ? teamProject.updatedAt : fallbackTimestamp,
        ...(teamProject.metadata ? { metadata: teamProject.metadata } : {}),
      } satisfies Project;
    });

  return [...localCards, ...sharedCards];
}


/**
 * The card list behind the 草稿 grid: the member's own projects that are NOT
 * shared yet.
 *
 * 草稿 and 全部项目 are complements, not overlapping views — sharing is the
 * explicit action that moves a project from one to the other. A shared project
 * lingering in 草稿 reads as "it did not move".
 */
export function buildDraftsList(input: {
  projects: Project[];
  teamProjects: TeamProject[];
  workspaceContext: WorkspaceCollabContext | null;
}): Project[] {
  const { projects, teamProjects, workspaceContext } = input;
  // A personal workspace has no team side, so nothing is ever shared away.
  if (workspaceContext?.workspaceType === 'personal') return projects;
  const shared = new Set(teamProjects.map((teamProject) => teamProject.projectId));
  return projects.filter((project) => !shared.has(project.id));
}
