import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  closeDatabase,
  ensureWorkspaceProject,
  insertProject,
  openDatabase,
} from '../../src/db.js';
import {
  openDesignAmrTraceEnvForProject,
  type ProjectWorkspaceScopeOutcome,
} from '../../src/runtimes/project-amr-trace-env.js';

// Proof REFUSAL and proof FAILURE are different events. These specs pin the
// split: only a directory that actually answered may refuse a run, an authority
// that could not be reached must be retried and then reported as its own
// outcome, and every branch must stay separately identifiable.
//
// Asserting on the literal identity strings (rather than importing the error
// class) is deliberate — it is what makes collapsing the identities back
// together turn these specs red, which is exactly the regression that cost three
// wrong root causes in one day.
const REFUSED = 'ProjectWorkspaceScopeRefusedError';
const REFUSED_CODE = 'PROJECT_WORKSPACE_SCOPE_REFUSED';

let tempDir: string | null = null;

afterEach(() => {
  closeDatabase();
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  tempDir = null;
});

function seedBoundProject(prefix: string, ids: {
  projectId: string;
  workspaceId: string;
  memberId: string;
}) {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const db = openDatabase(tempDir);
  const now = Date.now();
  insertProject(db, {
    id: ids.projectId,
    name: ids.projectId,
    createdAt: now,
    updatedAt: now,
  });
  ensureWorkspaceProject(db, {
    projectId: ids.projectId,
    workspaceId: ids.workspaceId,
    visibility: 'personal',
    createdByWorkspaceMemberId: ids.memberId,
  });
  return db;
}

function activeItem(overrides: {
  workspaceId: string;
  workspaceType: 'personal' | 'team';
  workspaceMemberId: string;
}) {
  return {
    workspaceName: `${overrides.workspaceId} name`,
    role: 'owner' as const,
    memberStatus: 'active' as const,
    lifecycleState: 'active' as const,
    ...overrides,
  };
}

describe('AMR workspace-binding proof: refusal vs unreachable authority', () => {
  it('refuses the run when the directory ANSWERED and the membership is genuinely absent', async () => {
    // The line the product ruling does not move: someone else's wallet.
    const db = seedBoundProject('od-amr-proof-refused-', {
      projectId: 'project-foreign',
      workspaceId: 'workspace-foreign',
      memberId: 'member-foreign',
    });
    const fetchWorkspaceDirectory = vi.fn(async () => ({
      ok: true as const,
      // Answered, and this member's memberships simply do not include it.
      items: [activeItem({
        workspaceId: 'workspace-mine',
        workspaceType: 'personal',
        workspaceMemberId: 'member-mine',
      })],
    }));
    const outcomes: ProjectWorkspaceScopeOutcome[] = [];

    await expect(openDesignAmrTraceEnvForProject(db, {
      agentId: 'amr',
      runId: 'run-foreign',
      runAttempt: 0,
      projectId: 'project-foreign',
    }, {
      fetchWorkspaceDirectory,
      isWorkspaceTeamConfigured: () => true,
      onWorkspaceScopeOutcome: (outcome) => outcomes.push(outcome),
      sleep: async () => {},
    })).rejects.toEqual(expect.objectContaining({
      name: REFUSED,
      code: REFUSED_CODE,
      outcome: 'refused_no_active_membership',
      projectId: 'project-foreign',
      workspaceId: 'workspace-foreign',
    }));
    // An answered directory is conclusive, so there is nothing to retry.
    expect(fetchWorkspaceDirectory).toHaveBeenCalledTimes(1);
    expect(outcomes).toEqual([expect.objectContaining({
      kind: 'refused_no_active_membership',
      projectId: 'project-foreign',
      workspaceId: 'workspace-foreign',
      directoryOk: true,
      directoryItemCount: 1,
      directoryReadAttempts: 1,
    })]);
  });

  it('retries a failed directory read, then proceeds on the account wallet and reports it', async () => {
    const db = seedBoundProject('od-amr-proof-unreachable-', {
      projectId: 'project-blip',
      workspaceId: 'workspace-blip',
      memberId: 'member-blip',
    });
    // Production shape: fetchVelaWorkspaceDirectory swallows missing sessions,
    // non-2xx responses and network errors into { ok: false } rather than
    // rejecting.
    const fetchWorkspaceDirectory = vi.fn(async () => ({
      ok: false as const,
      items: [],
    }));
    const outcomes: ProjectWorkspaceScopeOutcome[] = [];
    const sleep = vi.fn(async () => {});

    const env = await openDesignAmrTraceEnvForProject(db, {
      agentId: 'amr',
      runId: 'run-blip',
      runAttempt: 0,
      projectId: 'project-blip',
    }, {
      fetchWorkspaceDirectory,
      isWorkspaceTeamConfigured: () => true,
      onWorkspaceScopeOutcome: (outcome) => outcomes.push(outcome),
      sleep,
    });

    // Proceeds — a hard failure here was a production P0.
    expect(env.OPEN_DESIGN_RUN_ID).toBe('run-blip');
    // No workspace => the caller pays for the caller's own run. The reverse,
    // billing a personal run to a team, must stay impossible.
    expect(env).not.toHaveProperty('OPEN_DESIGN_WORKSPACE_ID');
    // Bounded retry, not a single shot: one slow response must not move a charge.
    expect(fetchWorkspaceDirectory.mock.calls.length).toBeGreaterThan(1);
    expect(sleep).toHaveBeenCalled();
    // Distinguishable from a refusal, and countable.
    expect(outcomes).toEqual([expect.objectContaining({
      kind: 'proceeded_directory_unreadable',
      projectId: 'project-blip',
      workspaceId: 'workspace-blip',
      directoryOk: false,
    })]);
    expect(outcomes[0]?.directoryReadAttempts).toBeGreaterThan(1);
  });

  it('treats a REJECTED directory read as a failed attempt, not as a refusal', async () => {
    const db = seedBoundProject('od-amr-proof-throw-', {
      projectId: 'project-throw',
      workspaceId: 'workspace-throw',
      memberId: 'member-throw',
    });
    const fetchWorkspaceDirectory = vi.fn(async () => {
      throw new Error('ETIMEDOUT');
    });
    const outcomes: ProjectWorkspaceScopeOutcome[] = [];

    const env = await openDesignAmrTraceEnvForProject(db, {
      agentId: 'amr',
      runId: 'run-throw',
      runAttempt: 0,
      projectId: 'project-throw',
    }, {
      fetchWorkspaceDirectory,
      isWorkspaceTeamConfigured: () => true,
      onWorkspaceScopeOutcome: (outcome) => outcomes.push(outcome),
      sleep: async () => {},
    });

    expect(env).not.toHaveProperty('OPEN_DESIGN_WORKSPACE_ID');
    expect(fetchWorkspaceDirectory.mock.calls.length).toBeGreaterThan(1);
    expect(outcomes[0]?.kind).toBe('proceeded_directory_unreadable');
  });

  it('recovers on retry: a first failed read then a good one resolves normally, no fallback', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'od-amr-proof-recover-'));
    const db = openDatabase(tempDir);
    const now = Date.now();
    insertProject(db, {
      id: 'project-recover',
      name: 'Recover',
      createdAt: now,
      updatedAt: now,
    });
    ensureWorkspaceProject(db, {
      projectId: 'project-recover',
      workspaceId: 'workspace-recover',
      visibility: 'personal',
      createdByWorkspaceMemberId: 'member-recover',
    });
    const good = {
      ok: true as const,
      items: [activeItem({
        workspaceId: 'workspace-recover',
        workspaceType: 'team',
        workspaceMemberId: 'member-recover',
      })],
    };
    let call = 0;
    const fetchWorkspaceDirectory = vi.fn(async () => {
      call += 1;
      if (call === 1) return { ok: false as const, items: [] };
      return good;
    });
    const outcomes: ProjectWorkspaceScopeOutcome[] = [];

    const env = await openDesignAmrTraceEnvForProject(db, {
      agentId: 'amr',
      runId: 'run-recover',
      runAttempt: 0,
      projectId: 'project-recover',
    }, {
      fetchWorkspaceDirectory,
      isWorkspaceTeamConfigured: () => true,
      onWorkspaceScopeOutcome: (outcome) => outcomes.push(outcome),
      sleep: async () => {},
    });

    // A transient blip must not cost the team binding — a private draft in a
    // team workspace still spends the team wallet.
    expect(env.OPEN_DESIGN_WORKSPACE_ID).toBe('workspace-recover');
    expect(fetchWorkspaceDirectory).toHaveBeenCalledTimes(2);
    expect(outcomes).toEqual([expect.objectContaining({
      kind: 'resolved_team',
      directoryOk: true,
      directoryReadAttempts: 2,
    })]);
  });

  it('refuses an unbound project without reading the directory at all', async () => {
    // SQLite alone proves this one; no directory read could change the answer,
    // so it is a refusal and must carry the refusal identity.
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'od-amr-proof-unbound-'));
    const db = openDatabase(tempDir);
    const now = Date.now();
    insertProject(db, {
      id: 'project-no-binding',
      name: 'No binding',
      createdAt: now,
      updatedAt: now,
    });
    const fetchWorkspaceDirectory = vi.fn(async () => ({
      ok: true as const,
      items: [],
    }));
    const outcomes: ProjectWorkspaceScopeOutcome[] = [];

    await expect(openDesignAmrTraceEnvForProject(db, {
      agentId: 'amr',
      runId: 'run-no-binding',
      runAttempt: 0,
      projectId: 'project-no-binding',
    }, {
      fetchWorkspaceDirectory,
      isWorkspaceTeamConfigured: () => true,
      onWorkspaceScopeOutcome: (outcome) => outcomes.push(outcome),
    })).rejects.toEqual(expect.objectContaining({
      name: REFUSED,
      code: REFUSED_CODE,
      outcome: 'refused_no_binding',
      workspaceId: null,
    }));
    expect(fetchWorkspaceDirectory).not.toHaveBeenCalled();
    expect(outcomes).toEqual([expect.objectContaining({
      kind: 'refused_no_binding',
      directoryOk: null,
      directoryItemCount: null,
      directoryReadAttempts: 0,
    })]);
  });

  it('names an EMPTY answered directory separately from a proven non-membership', async () => {
    // Vela runs ensurePersonalWorkspace before listing and applies no type
    // filter, so an authenticated caller always has at least their personal
    // workspace. An empty list is therefore a malformed answer, not "you were
    // removed" — and a support reader must not confuse the two.
    const db = seedBoundProject('od-amr-proof-empty-', {
      projectId: 'project-empty-dir',
      workspaceId: 'workspace-empty-dir',
      memberId: 'member-empty-dir',
    });
    const outcomes: ProjectWorkspaceScopeOutcome[] = [];

    await expect(openDesignAmrTraceEnvForProject(db, {
      agentId: 'amr',
      runId: 'run-empty-dir',
      runAttempt: 0,
      projectId: 'project-empty-dir',
    }, {
      fetchWorkspaceDirectory: async () => ({ ok: true, items: [] }),
      isWorkspaceTeamConfigured: () => true,
      onWorkspaceScopeOutcome: (outcome) => outcomes.push(outcome),
      sleep: async () => {},
    })).rejects.toEqual(expect.objectContaining({
      name: REFUSED,
      outcome: 'refused_directory_empty',
    }));
    expect(outcomes[0]?.kind).toBe('refused_directory_empty');
  });

  it('reports a proven PERSONAL binding as its own outcome on the account wallet', async () => {
    // Hypothesis check turned regression guard: the `personal` branch must be
    // reachable in production. Vela's directory includes personal workspaces
    // (no type filter) and reports them memberStatus/lifecycleState 'active',
    // which is exactly what resolveProjectWorkspaceScope's find requires.
    const db = seedBoundProject('od-amr-proof-personal-', {
      projectId: 'project-personal-ok',
      workspaceId: 'workspace-personal-ok',
      memberId: 'member-personal-ok',
    });
    const outcomes: ProjectWorkspaceScopeOutcome[] = [];

    const env = await openDesignAmrTraceEnvForProject(db, {
      agentId: 'amr',
      runId: 'run-personal-ok',
      runAttempt: 0,
      projectId: 'project-personal-ok',
    }, {
      fetchWorkspaceDirectory: async () => ({
        ok: true,
        items: [activeItem({
          workspaceId: 'workspace-personal-ok',
          workspaceType: 'personal',
          workspaceMemberId: 'member-personal-ok',
        })],
      }),
      isWorkspaceTeamConfigured: () => true,
      onWorkspaceScopeOutcome: (outcome) => outcomes.push(outcome),
    });

    expect(env).not.toHaveProperty('OPEN_DESIGN_WORKSPACE_ID');
    expect(outcomes[0]?.kind).toBe('resolved_personal');
  });

  it('stays silent for a non-AMR runtime', async () => {
    // This path is AMR-only by design; it must not log or count for anyone else.
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'od-amr-proof-non-amr-'));
    const db = openDatabase(tempDir);
    const outcomes: ProjectWorkspaceScopeOutcome[] = [];

    await openDesignAmrTraceEnvForProject(db, {
      agentId: 'claude',
      runId: 'run-claude',
      runAttempt: 0,
      projectId: 'project-any',
    }, {
      fetchWorkspaceDirectory: async () => ({ ok: true, items: [] }),
      isWorkspaceTeamConfigured: () => true,
      onWorkspaceScopeOutcome: (outcome) => outcomes.push(outcome),
    });

    expect(outcomes).toEqual([]);
  });

  it('keeps every branch separately identifiable', async () => {
    // The regression that cost today: five causes collapsing into one
    // indistinguishable error. If two branches ever report the same kind again,
    // this fails.
    const seen = new Set<string>();
    const record = (outcome: ProjectWorkspaceScopeOutcome) => {
      seen.add(outcome.kind);
    };

    // refused_no_binding
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'od-amr-proof-matrix-a-'));
    let db = openDatabase(tempDir);
    const now = Date.now();
    insertProject(db, { id: 'p1', name: 'p1', createdAt: now, updatedAt: now });
    await openDesignAmrTraceEnvForProject(db, {
      agentId: 'amr', runId: 'r1', runAttempt: 0, projectId: 'p1',
    }, {
      fetchWorkspaceDirectory: async () => ({ ok: true, items: [] }),
      isWorkspaceTeamConfigured: () => true,
      onWorkspaceScopeOutcome: record,
    }).catch(() => undefined);
    closeDatabase();
    fs.rmSync(tempDir, { recursive: true, force: true });

    // refused_directory_empty
    db = seedBoundProject('od-amr-proof-matrix-b-', {
      projectId: 'p2', workspaceId: 'w2', memberId: 'm2',
    });
    await openDesignAmrTraceEnvForProject(db, {
      agentId: 'amr', runId: 'r2', runAttempt: 0, projectId: 'p2',
    }, {
      fetchWorkspaceDirectory: async () => ({ ok: true, items: [] }),
      isWorkspaceTeamConfigured: () => true,
      onWorkspaceScopeOutcome: record,
      sleep: async () => {},
    }).catch(() => undefined);
    closeDatabase();
    fs.rmSync(tempDir, { recursive: true, force: true });

    // refused_no_active_membership
    db = seedBoundProject('od-amr-proof-matrix-c-', {
      projectId: 'p3', workspaceId: 'w3', memberId: 'm3',
    });
    await openDesignAmrTraceEnvForProject(db, {
      agentId: 'amr', runId: 'r3', runAttempt: 0, projectId: 'p3',
    }, {
      fetchWorkspaceDirectory: async () => ({
        ok: true,
        items: [activeItem({
          workspaceId: 'other', workspaceType: 'personal', workspaceMemberId: 'mo',
        })],
      }),
      isWorkspaceTeamConfigured: () => true,
      onWorkspaceScopeOutcome: record,
      sleep: async () => {},
    }).catch(() => undefined);
    closeDatabase();
    fs.rmSync(tempDir, { recursive: true, force: true });

    // proceeded_directory_unreadable
    db = seedBoundProject('od-amr-proof-matrix-d-', {
      projectId: 'p4', workspaceId: 'w4', memberId: 'm4',
    });
    await openDesignAmrTraceEnvForProject(db, {
      agentId: 'amr', runId: 'r4', runAttempt: 0, projectId: 'p4',
    }, {
      fetchWorkspaceDirectory: async () => ({ ok: false, items: [] }),
      isWorkspaceTeamConfigured: () => true,
      onWorkspaceScopeOutcome: record,
      sleep: async () => {},
    });
    closeDatabase();
    fs.rmSync(tempDir, { recursive: true, force: true });

    // resolved_team
    db = seedBoundProject('od-amr-proof-matrix-e-', {
      projectId: 'p5', workspaceId: 'w5', memberId: 'm5',
    });
    await openDesignAmrTraceEnvForProject(db, {
      agentId: 'amr', runId: 'r5', runAttempt: 0, projectId: 'p5',
    }, {
      fetchWorkspaceDirectory: async () => ({
        ok: true,
        items: [activeItem({
          workspaceId: 'w5', workspaceType: 'team', workspaceMemberId: 'm5',
        })],
      }),
      isWorkspaceTeamConfigured: () => true,
      onWorkspaceScopeOutcome: record,
    });
    closeDatabase();
    fs.rmSync(tempDir, { recursive: true, force: true });

    // resolved_personal
    db = seedBoundProject('od-amr-proof-matrix-f-', {
      projectId: 'p6', workspaceId: 'w6', memberId: 'm6',
    });
    await openDesignAmrTraceEnvForProject(db, {
      agentId: 'amr', runId: 'r6', runAttempt: 0, projectId: 'p6',
    }, {
      fetchWorkspaceDirectory: async () => ({
        ok: true,
        items: [activeItem({
          workspaceId: 'w6', workspaceType: 'personal', workspaceMemberId: 'm6',
        })],
      }),
      isWorkspaceTeamConfigured: () => true,
      onWorkspaceScopeOutcome: record,
    });

    expect([...seen].sort()).toEqual([
      'proceeded_directory_unreadable',
      'refused_directory_empty',
      'refused_no_active_membership',
      'refused_no_binding',
      'resolved_personal',
      'resolved_team',
    ]);
  });
});
