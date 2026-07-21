import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  closeDatabase,
  ensureWorkspaceProject,
  findTeamWorkspaceIdForProject,
  getWorkspaceProject,
  insertProject,
  listTeamWorkspaceProjectShares,
  openDatabase,
  updateWorkspaceProject,
} from '../../src/db.js';
import {
  createWorkspaceTypeRegistry,
  impossibleTeamShareRows,
  projectCollabScope,
  refuseTeamShareScope,
} from '../../src/collab/team-share-scope.js';

// The reporter's real ids, kept verbatim: `OD Feature Team` (a TEAM workspace)
// and the owner's PERSONAL workspace, which is what their `workspace_projects`
// row for `Simple Deck` was pinned to.
const PERSONAL_WS = 'eh0z7baa1w6jjgyed3v32y0j';
const TEAM_WS = 'vp44mftzknedrrqgy05oqpv9';

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'od-team-share-scope-'));
});

afterEach(async () => {
  closeDatabase();
  await rm(tmp, { recursive: true, force: true });
});

function seedImpossibleTeamShare(projectId: string) {
  const db = openDatabase(tmp, { dataDir: tmp });
  const now = Date.now();
  insertProject(db, { id: projectId, name: 'Simple Deck', createdAt: now, updatedAt: now });
  ensureWorkspaceProject(db, {
    projectId,
    // The contradiction: a TEAM projection pinned to a PERSONAL workspace.
    workspaceId: PERSONAL_WS,
    visibility: 'team',
    resourceState: 'active',
    syncState: 'pending_upload',
    resourceHubResourceId: 'resource-keyed-on-the-personal-workspace',
    createdByWorkspaceMemberId: 'member-owner',
    updatedByWorkspaceMemberId: 'member-owner',
    createdAt: now,
    updatedAt: now,
  });
  return db;
}

function registryKnowing(...facts: Array<{ workspaceId: string; workspaceType: string }>) {
  const registry = createWorkspaceTypeRegistry();
  registry.learn(facts);
  return registry;
}

describe('team share scope invariant', () => {
  it('does not pin a team row whose workspace is a personal workspace', () => {
    const projectId = 'project-impossible-scope';
    const db = seedImpossibleTeamShare(projectId);
    const refused: string[] = [];

    // This is exactly the composition the daemon uses for every project-scoped
    // collab call (presence heartbeat / list / leave): the project's pinned
    // workspace outranks the local selection.
    const scope = projectCollabScope({
      projectId,
      projectWorkspaceId: findTeamWorkspaceIdForProject(db, projectId),
      localSelection: TEAM_WS,
      registry: registryKnowing(
        { workspaceId: PERSONAL_WS, workspaceType: 'personal' },
        { workspaceId: TEAM_WS, workspaceType: 'team' },
      ),
      onRefused: ({ workspaceId }) => refused.push(workspaceId),
    }).workspaceId;

    // The personal workspace has no team plane, so B answers every call scoped
    // to it with 403 missing_principal. The local selection — which holds the
    // real team workspace — must win instead.
    expect(scope).toBe(TEAM_WS);
    // …and the refusal is observable, not silent.
    expect(refused).toEqual([PERSONAL_WS]);
    // The row itself is untouched by a read.
    expect(getWorkspaceProject(db, PERSONAL_WS, projectId)).toMatchObject({
      visibility: 'team',
    });
  });

  it('still pins a team row whose workspace is a real team workspace', () => {
    const projectId = 'project-valid-scope';
    const db = openDatabase(tmp, { dataDir: tmp });
    const now = Date.now();
    insertProject(db, { id: projectId, name: 'Simple Deck', createdAt: now, updatedAt: now });
    ensureWorkspaceProject(db, {
      projectId,
      workspaceId: TEAM_WS,
      visibility: 'team',
      resourceState: 'active',
      syncState: 'synced',
      createdAt: now,
      updatedAt: now,
    });

    // The whole point of pinning is that it survives a workspace switch made on
    // another device — the local selection here is deliberately something else.
    expect(
      projectCollabScope({
        projectWorkspaceId: findTeamWorkspaceIdForProject(db, projectId),
        localSelection: 'ws-switched-elsewhere',
        registry: registryKnowing({ workspaceId: TEAM_WS, workspaceType: 'team' }),
      }),
    ).toEqual({ workspaceId: TEAM_WS, source: 'project' });
  });

  it('pins an unknown workspace rather than guessing it is broken', () => {
    // Evidence-gated: a workspace the daemon has not learned about (cold start,
    // signed out, directory unreachable) is never refused.
    expect(
      projectCollabScope({
        projectWorkspaceId: 'ws-never-seen',
        localSelection: TEAM_WS,
        registry: createWorkspaceTypeRegistry(),
      }),
    ).toEqual({ workspaceId: 'ws-never-seen', source: 'project' });
  });

  it('refuses on either witness: the caller assertion or the directory', () => {
    const registry = registryKnowing({ workspaceId: PERSONAL_WS, workspaceType: 'personal' });
    expect(refuseTeamShareScope(PERSONAL_WS, { assertedType: 'personal' })).toBe('asserted_personal');
    expect(refuseTeamShareScope(PERSONAL_WS, { registry })).toBe('directory_personal');
    // A caller that lies about the type is still caught by the directory.
    expect(refuseTeamShareScope(PERSONAL_WS, { assertedType: 'team', registry })).toBe(
      'directory_personal',
    );
    // No witness, no refusal.
    expect(refuseTeamShareScope(TEAM_WS, { assertedType: 'team', registry })).toBeNull();
    expect(refuseTeamShareScope('ws-never-seen', { registry })).toBeNull();
  });

  it('heals only the contradictory rows and leaves personal rows alone', () => {
    const brokenId = 'project-broken-share';
    const db = seedImpossibleTeamShare(brokenId);
    const now = Date.now();

    // A legitimately-personal row in the same personal workspace: normal, and
    // must never be rewritten.
    const personalId = 'project-personal-draft';
    insertProject(db, { id: personalId, name: 'Personal draft', createdAt: now, updatedAt: now });
    ensureWorkspaceProject(db, {
      projectId: personalId,
      workspaceId: PERSONAL_WS,
      visibility: 'personal',
      resourceState: 'active',
      syncState: 'local_only',
      createdAt: now,
      updatedAt: now,
    });

    // A healthy team share: must survive untouched.
    const healthyId = 'project-healthy-share';
    insertProject(db, { id: healthyId, name: 'Healthy share', createdAt: now, updatedAt: now });
    ensureWorkspaceProject(db, {
      projectId: healthyId,
      workspaceId: TEAM_WS,
      visibility: 'team',
      resourceState: 'active',
      syncState: 'synced',
      createdByWorkspaceMemberId: 'member-owner',
      createdAt: now,
      updatedAt: now,
    });

    const registry = registryKnowing(
      { workspaceId: PERSONAL_WS, workspaceType: 'personal' },
      { workspaceId: TEAM_WS, workspaceType: 'team' },
    );
    const broken = impossibleTeamShareRows(listTeamWorkspaceProjectShares(db), registry);
    expect(broken.map((row) => row.projectId)).toEqual([brokenId]);

    for (const row of broken) {
      updateWorkspaceProject(db, row.workspaceId, row.projectId, {
        visibility: 'personal',
        resourceHubResourceId: null,
        cloudTombstonedAt: null,
        syncState: 'local_only',
      });
    }

    expect(getWorkspaceProject(db, PERSONAL_WS, brokenId)).toMatchObject({
      visibility: 'personal',
      resourceHubResourceId: null,
      syncState: 'local_only',
      // NOT tombstoned: a copy that genuinely exists in the team catalog must
      // keep showing up instead of being suppressed as "unshared here".
      cloudTombstonedAt: null,
    });
    expect(getWorkspaceProject(db, PERSONAL_WS, personalId)).toMatchObject({
      visibility: 'personal',
      syncState: 'local_only',
    });
    expect(getWorkspaceProject(db, TEAM_WS, healthyId)).toMatchObject({
      visibility: 'team',
      syncState: 'synced',
    });

    // After healing, the project's collab scope falls back to the real team
    // workspace instead of the address that always 403s.
    expect(
      projectCollabScope({
        projectWorkspaceId: findTeamWorkspaceIdForProject(db, brokenId),
        localSelection: TEAM_WS,
        registry,
      }).workspaceId,
    ).toBe(TEAM_WS);
  });

  it('leaves rows in an unknown workspace alone when healing', () => {
    const projectId = 'project-unknown-workspace';
    const db = seedImpossibleTeamShare(projectId);
    // Empty registry = no evidence; healing must be a no-op rather than
    // demoting every team share the daemon cannot currently classify.
    expect(
      impossibleTeamShareRows(listTeamWorkspaceProjectShares(db), createWorkspaceTypeRegistry()),
    ).toEqual([]);
  });
});
