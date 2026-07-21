import { describe, expect, it } from 'vitest';
import type { TeamProject, WorkspaceCollabContext } from '@open-design/contracts';

import { buildAllProjectsList, buildDraftsList } from '../src/collab/all-projects-list';
import type { Project } from '../src/types';

const SELF = 'member-self';

function teamContext(overrides: Partial<WorkspaceCollabContext> = {}): WorkspaceCollabContext {
  return {
    workspaceId: 'ws-1',
    workspaceType: 'team',
    workspaceMemberId: SELF,
    role: 'owner',
    memberStatus: 'active',
    lifecycleState: 'active',
    permissions: {},
    ...overrides,
  } as WorkspaceCollabContext;
}

function localProject(id: string, name: string): Project {
  return {
    id,
    name,
    skillId: null,
    designSystemId: null,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
  } as Project;
}

function sharedProject(overrides: Partial<TeamProject> & { projectId: string }): TeamProject {
  return {
    ownerMemberId: 'member-other',
    sharedAt: '2026-07-01T00:00:00.000Z',
    ...overrides,
  } as TeamProject;
}

const build = (input: {
  projects: Project[];
  teamProjects: TeamProject[];
  workspaceContext?: WorkspaceCollabContext | null;
}) =>
  buildAllProjectsList({
    projects: input.projects,
    teamProjects: input.teamProjects,
    workspaceContext: input.workspaceContext ?? teamContext(),
    sharedFallbackName: '共享项目',
    now: () => 1_700_000_000_000,
  });

describe('buildAllProjectsList', () => {
  // Acceptance #29 was raised as "my new empty project never showed up in
  // 全部项目", and product ruled it working as designed on the acceptance doc
  // (2026-07-20): sharing is an explicit user action, and until it happens the
  // project belongs to 草稿 only. This test exists so the grid's name does not
  // tempt someone into "fixing" it again.
  it('leaves an unshared local project out', () => {
    const list = build({
      projects: [localProject('p-fresh', 'Fresh empty project')],
      teamProjects: [],
    });

    expect(list).toEqual([]);
  });

  it('lists the member’s own project once it is shared', () => {
    const list = build({
      projects: [localProject('p-mine', 'Mine')],
      teamProjects: [sharedProject({ projectId: 'p-mine', ownerMemberId: SELF, name: 'Mine' })],
    });

    expect(list.map((project) => project.id)).toEqual(['p-mine']);
  });

  it('lists shared projects the member has not pulled alongside their shared own', () => {
    const list = build({
      projects: [localProject('p-mine', 'Mine'), localProject('p-draft', 'Draft')],
      teamProjects: [
        sharedProject({ projectId: 'p-mine', ownerMemberId: SELF, name: 'Mine' }),
        sharedProject({ projectId: 'p-theirs', name: 'Theirs' }),
      ],
    });

    expect(list.map((project) => project.id).sort()).toEqual(['p-mine', 'p-theirs']);
  });

  it('does not duplicate a shared project the member already pulled', () => {
    const list = build({
      projects: [localProject('p-shared', 'Pulled copy')],
      teamProjects: [sharedProject({ projectId: 'p-shared', name: 'Pulled copy' })],
    });

    expect(list).toHaveLength(1);
  });

  it("follows the catalog name for another member's project, not the frozen local one", () => {
    const list = build({
      projects: [localProject('p-shared', 'Old name at pull time')],
      teamProjects: [sharedProject({ projectId: 'p-shared', name: 'Renamed by owner' })],
    });

    expect(list[0]?.name).toBe('Renamed by owner');
  });

  it('keeps the local name for the member’s OWN project so a fresh rename holds', () => {
    const list = build({
      projects: [localProject('p-mine', 'Just renamed')],
      teamProjects: [
        sharedProject({ projectId: 'p-mine', ownerMemberId: SELF, name: 'Stale catalog name' }),
      ],
    });

    expect(list[0]?.name).toBe('Just renamed');
  });

  it('falls back to a placeholder name for a shared project with no catalog name', () => {
    const list = build({
      projects: [],
      teamProjects: [sharedProject({ projectId: 'p-unnamed' })],
    });

    expect(list[0]?.name).toBe('共享项目');
  });

  it('returns the local list untouched in a personal workspace', () => {
    const projects = [localProject('p-a', 'A'), localProject('p-b', 'B')];
    const list = build({
      projects,
      teamProjects: [sharedProject({ projectId: 'p-hub' })],
      workspaceContext: teamContext({ workspaceType: 'personal' }),
    });

    expect(list).toBe(projects);
  });
});

// Acceptance #78: a project that had been shared kept showing in 草稿, so the
// share read as "it did not move". 草稿 and 全部项目 are complements.
describe('buildDraftsList', () => {
  const drafts = (projects: Project[], teamProjects: TeamProject[], ctx = teamContext()) =>
    buildDraftsList({ projects, teamProjects, workspaceContext: ctx });

  it('drops a project once it is shared', () => {
    const list = drafts(
      [localProject('p-shared', 'Shared'), localProject('p-draft', 'Draft')],
      [sharedProject({ projectId: 'p-shared', ownerMemberId: SELF })],
    );
    expect(list.map((p) => p.id)).toEqual(['p-draft']);
  });

  it('keeps everything while nothing is shared', () => {
    const list = drafts([localProject('p-a', 'A'), localProject('p-b', 'B')], []);
    expect(list.map((p) => p.id)).toEqual(['p-a', 'p-b']);
  });

  // The two grids must partition the local list, never double-count.
  it('complements 全部项目 — no project appears in both', () => {
    const projects = [localProject('p-shared', 'Shared'), localProject('p-draft', 'Draft')];
    const teamProjects = [sharedProject({ projectId: 'p-shared', ownerMemberId: SELF })];
    const inDrafts = new Set(drafts(projects, teamProjects).map((p) => p.id));
    const inAll = new Set(
      buildAllProjectsList({
        projects,
        teamProjects,
        workspaceContext: teamContext(),
        sharedFallbackName: '共享项目',
        now: () => 1_700_000_000_000,
      }).map((p) => p.id),
    );
    for (const id of inDrafts) expect(inAll.has(id)).toBe(false);
    expect([...inDrafts, ...inAll].sort()).toEqual(['p-draft', 'p-shared']);
  });

  it('leaves a personal workspace untouched — nothing is ever shared away', () => {
    const projects = [localProject('p-a', 'A')];
    const list = drafts(projects, [sharedProject({ projectId: 'p-a' })], teamContext({ workspaceType: 'personal' }));
    expect(list).toBe(projects);
  });
});
