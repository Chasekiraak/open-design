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
  ProjectWorkspaceScopeRefusedError,
} from '../../src/runtimes/project-amr-trace-env.js';

let tempDir: string | null = null;

afterEach(() => {
  closeDatabase();
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  tempDir = null;
});

describe('openDesignAmrTraceEnvForProject', () => {
  it('does not read workspace scope for a non-AMR runtime', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'od-non-amr-project-scope-'));
    const db = openDatabase(tempDir);
    const fetchWorkspaceDirectory = vi.fn(async () => {
      throw new Error('directory must not be read');
    });

    await expect(openDesignAmrTraceEnvForProject(db, {
      agentId: 'claude',
      runId: 'run-claude',
      runAttempt: 0,
      projectId: 'project-a',
    }, {
      fetchWorkspaceDirectory,
    })).resolves.toEqual({});
    expect(fetchWorkspaceDirectory).not.toHaveBeenCalled();
  });

  it('fails closed instead of charging the account wallet for an unbound AMR project', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'od-amr-unbound-scope-'));
    const db = openDatabase(tempDir);
    const now = Date.now();
    insertProject(db, {
      id: 'project-unbound',
      name: 'Unbound project',
      createdAt: now,
      updatedAt: now,
    });
    const fetchWorkspaceDirectory = vi.fn(async () => ({
      ok: true as const,
      items: [],
    }));

    await expect(openDesignAmrTraceEnvForProject(db, {
      agentId: 'amr',
      runId: 'run-unbound',
      runAttempt: 0,
      projectId: 'project-unbound',
    }, {
      fetchWorkspaceDirectory,
    })).rejects.toEqual(expect.objectContaining({
      name: ProjectWorkspaceScopeRefusedError.name,
      projectId: 'project-unbound',
      workspaceId: null,
    }));
    expect(fetchWorkspaceDirectory).not.toHaveBeenCalled();
  });

  it('carries the real SQLite team binding into the final AMR spawn environment', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'od-amr-project-scope-'));
    const db = openDatabase(tempDir);
    const now = Date.now();
    insertProject(db, {
      id: 'project-a',
      name: 'Project A',
      createdAt: now,
      updatedAt: now,
    });
    ensureWorkspaceProject(db, {
      projectId: 'project-a',
      workspaceId: 'workspace-a',
      visibility: 'team',
      createdByWorkspaceMemberId: 'member-a',
    });

    const env = await openDesignAmrTraceEnvForProject(db, {
      agentId: 'amr',
      runId: 'run-a',
      conversationId: 'conversation-a',
      runAttempt: 0,
      projectId: 'project-a',
    }, {
      fetchWorkspaceDirectory: async () => ({
        ok: true,
        items: [{
          workspaceId: 'workspace-a',
          workspaceName: 'Workspace A',
          workspaceType: 'team',
          workspaceMemberId: 'member-a',
          role: 'member',
          memberStatus: 'active',
          lifecycleState: 'active',
        }],
      }),
    });

    expect(env).toMatchObject({
      OPEN_DESIGN_RUN_ID: 'run-a',
      OPEN_DESIGN_SESSION_ID: 'conversation-a',
      OPEN_DESIGN_WORKSPACE_ID: 'workspace-a',
    });
  });

  it('uses the team wallet for a private draft bound to a team workspace', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'od-amr-team-draft-scope-'));
    const db = openDatabase(tempDir);
    const now = Date.now();
    insertProject(db, {
      id: 'project-team-draft',
      name: 'Team draft',
      createdAt: now,
      updatedAt: now,
    });
    ensureWorkspaceProject(db, {
      projectId: 'project-team-draft',
      workspaceId: 'workspace-team',
      visibility: 'personal',
      createdByWorkspaceMemberId: 'member-team',
    });

    const env = await openDesignAmrTraceEnvForProject(db, {
      agentId: 'amr',
      runId: 'run-team-draft',
      runAttempt: 0,
      projectId: 'project-team-draft',
    }, {
      fetchWorkspaceDirectory: async () => ({
        ok: true,
        items: [{
          workspaceId: 'workspace-team',
          workspaceName: 'Workspace Team',
          workspaceType: 'team',
          workspaceMemberId: 'member-team',
          role: 'member',
          memberStatus: 'active',
          lifecycleState: 'active',
        }],
      }),
    });

    expect(env.OPEN_DESIGN_WORKSPACE_ID).toBe('workspace-team');
  });

  it('keeps a personal-workspace project on the account wallet', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'od-amr-personal-scope-'));
    const db = openDatabase(tempDir);
    const now = Date.now();
    insertProject(db, {
      id: 'project-personal',
      name: 'Personal project',
      createdAt: now,
      updatedAt: now,
    });
    ensureWorkspaceProject(db, {
      projectId: 'project-personal',
      workspaceId: 'workspace-personal',
      visibility: 'personal',
      createdByWorkspaceMemberId: 'member-personal',
    });

    const env = await openDesignAmrTraceEnvForProject(db, {
      agentId: 'amr',
      runId: 'run-personal',
      runAttempt: 0,
      projectId: 'project-personal',
    }, {
      fetchWorkspaceDirectory: async () => ({
        ok: true,
        items: [{
          workspaceId: 'workspace-personal',
          workspaceName: 'Personal',
          workspaceType: 'personal',
          workspaceMemberId: 'member-personal',
          role: 'owner',
          memberStatus: 'active',
          lifecycleState: 'active',
        }],
      }),
    });

    expect(env).not.toHaveProperty('OPEN_DESIGN_WORKSPACE_ID');
  });

  // This used to drive the refusal with `{ ok: false }` — an UNREADABLE
  // directory. That now takes the authorised account-wallet fallback instead
  // (see `project-amr-workspace-proof.test.ts`), because an authority we could
  // not reach proved nothing. The refusal this test guards is the one that
  // survives: the directory ANSWERED, and it does not list the binding.
  it('fails closed when an answered directory does not prove the persisted binding', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'od-amr-unavailable-scope-'));
    const db = openDatabase(tempDir);
    const now = Date.now();
    insertProject(db, {
      id: 'project-unavailable',
      name: 'Unavailable project',
      createdAt: now,
      updatedAt: now,
    });
    ensureWorkspaceProject(db, {
      projectId: 'project-unavailable',
      workspaceId: 'workspace-missing',
      visibility: 'personal',
      createdByWorkspaceMemberId: 'member-missing',
    });

    await expect(openDesignAmrTraceEnvForProject(db, {
      agentId: 'amr',
      runId: 'run-unavailable',
      runAttempt: 0,
      projectId: 'project-unavailable',
    }, {
      fetchWorkspaceDirectory: async () => ({
        ok: true,
        items: [{
          workspaceId: 'workspace-other',
          workspaceName: 'Some other workspace',
          workspaceType: 'personal',
          workspaceMemberId: 'member-other',
          role: 'owner',
          memberStatus: 'active',
          lifecycleState: 'active',
        }],
      }),
    })).rejects.toEqual(expect.objectContaining({
      name: ProjectWorkspaceScopeRefusedError.name,
      projectId: 'project-unavailable',
      workspaceId: 'workspace-missing',
    }));
  });

  // The two regimes of the workspace-authority gate. `resolveCreatedProjectWorkspace`
  // states that a headerless request is a legal anonymous caller that intentionally
  // leaves its project unbound; without this split, AMR then refused to run for
  // exactly the projects that contract says are legitimate.
  it('runs an unbound AMR project on the account wallet when workspace-team is not configured', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'od-amr-unconfigured-scope-'));
    const db = openDatabase(tempDir);
    const now = Date.now();
    insertProject(db, {
      id: 'project-legacy',
      name: 'Legacy local project',
      createdAt: now,
      updatedAt: now,
    });
    const fetchWorkspaceDirectory = vi.fn(async () => ({
      ok: true as const,
      items: [],
    }));

    const env = await openDesignAmrTraceEnvForProject(db, {
      agentId: 'amr',
      runId: 'run-legacy',
      runAttempt: 0,
      projectId: 'project-legacy',
    }, {
      fetchWorkspaceDirectory,
      isWorkspaceTeamConfigured: () => false,
    });

    // Account wallet, i.e. exactly what this daemon did before workspace-team.
    // `OPEN_DESIGN_WORKSPACE_ID` is the key a team binding would have set, so
    // its absence is what "billed to the account, not a team" means here.
    expect(env).not.toHaveProperty('OPEN_DESIGN_WORKSPACE_ID');
    expect(env.OPEN_DESIGN_RUN_ID).toBe('run-legacy');
    // An unconfigured daemon must not turn a local run into a network call.
    expect(fetchWorkspaceDirectory).not.toHaveBeenCalled();
  });

  it('still fails closed for an unbound AMR project when workspace-team is configured', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'od-amr-configured-unbound-scope-'));
    const db = openDatabase(tempDir);
    const now = Date.now();
    insertProject(db, {
      id: 'project-unbound-live',
      name: 'Unbound project on a live workspace daemon',
      createdAt: now,
      updatedAt: now,
    });

    await expect(openDesignAmrTraceEnvForProject(db, {
      agentId: 'amr',
      runId: 'run-unbound-live',
      runAttempt: 0,
      projectId: 'project-unbound-live',
    }, {
      fetchWorkspaceDirectory: async () => ({ ok: true, items: [] }),
      isWorkspaceTeamConfigured: () => true,
    })).rejects.toEqual(expect.objectContaining({
      name: ProjectWorkspaceScopeRefusedError.name,
      projectId: 'project-unbound-live',
      workspaceId: null,
    }));
  });
});
