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
  ProjectWorkspaceScopeUnavailableError,
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

  it('fails closed when the persisted workspace binding cannot be proven', async () => {
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
      fetchWorkspaceDirectory: async () => ({ ok: false, items: [] }),
    })).rejects.toEqual(expect.objectContaining({
      name: ProjectWorkspaceScopeUnavailableError.name,
      projectId: 'project-unavailable',
      workspaceId: 'workspace-missing',
    }));
  });
});
