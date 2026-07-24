// recvqb6mfyqXLD: a design system materialized locally from a teammate's team
// share must not be editable, publish-toggleable, or deletable by a plain
// member — only the original sharer, or a workspace owner/admin, may mutate
// it (the same rule "who can unshare" already enforces). The UI hides the
// affordances (DesignSystemsTab.tsx `canManageTeamSynced`), but nothing
// stopped a direct PATCH/DELETE call before this guard: `canMutateUserDesignSystem`
// is the server-side enforcement point these specs pin down.
//
// Spec 9.2 adds a second, independent gate on top: a locked/deleted workspace
// (billing lapse, deletion in progress) must refuse every PATCH/DELETE
// regardless of what `canMutateUserDesignSystem` itself would say — see the
// "workspace lock" describe block below. That gate lives in the route, not
// inside the (here mocked) `canMutateUserDesignSystem`, precisely so it holds
// no matter what a caller-supplied mutation predicate decides.

import type http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerDesignSystemRoutes } from '../../src/routes/design-systems.js';
import type { DesignSystemSummary } from '../../src/design-systems/index.js';
import { closeDatabase, openDatabase } from '../../src/db.js';

let server: http.Server | null = null;
let tempDir: string | null = null;

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = null;
  }
  closeDatabase();
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

function listen(app: express.Express): Promise<string> {
  return new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      const address = server?.address() as { port: number };
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

const designSystemSummary: DesignSystemSummary = {
  id: 'user:teammate-ds',
  title: 'Teammate DS',
  category: 'Custom',
  summary: 'Synced from a teammate.',
  swatches: [],
  surface: 'web',
  body: '# Teammate DS',
  source: 'user',
  status: 'draft',
  isEditable: true,
};

function registerRoutes(app: express.Express, canMutate: (root: string, id: string, req: any) => Promise<boolean>) {
  tempDir = mkdtempSync(path.join(os.tmpdir(), 'od-ds-mutation-guard-'));
  const db = openDatabase(tempDir, { dataDir: tempDir });
  const updateUserDesignSystem = vi.fn(async () => ({ ...designSystemSummary, status: 'published' as const }));
  const deleteUserDesignSystem = vi.fn(async () => true);
  registerDesignSystemRoutes(app, {
    db,
    paths: {
      CRAFT_DIR: '',
      USER_DESIGN_SYSTEMS_DIR: '',
    } as never,
    projectFiles: {} as never,
    projectStore: {} as never,
    designSystems: {
      buildUserDesignSystemArchive: async () => null,
      canMutateUserDesignSystem: canMutate,
      createUserDesignSystem: async () => designSystemSummary,
      deleteUserDesignSystem,
      ensureUserDesignSystemWorkspaceProject: async () => null,
      listAllDesignSystems: async () => [designSystemSummary],
      listUserDesignSystemFiles: async () => null,
      listUserDesignSystemRevisions: async () => null,
      prepareDesignTokenContractRebuild: async () => ({ decision: { available: false } }) as never,
      readAvailableDesignSystem: async () => null,
      readAvailableDesignSystemPackageInfo: async () => null,
      readAvailableDesignSystemStaticFile: async () => null,
      readDesignSystemWorkspaceTextFile: async () => null,
      readUserDesignSystemFile: async () => null,
      renderDesignSystemPreview: () => '<!doctype html>',
      renderDesignSystemShowcase: () => '<!doctype html>',
      syncUserDesignSystemAssetsFromWorkspace: async () => ({ ok: false, reason: 'not-found' }),
      updateUserDesignSystem,
      updateUserDesignSystemRevisionStatus: async () => null,
    },
    generationJobs: {
      get: () => null,
      rebuildTokenContract: () => ({}) as never,
      revise: () => ({}) as never,
      start: () => ({}) as never,
    },
  });
  return { updateUserDesignSystem, deleteUserDesignSystem };
}

describe('design system PATCH/DELETE team-share mutation guard', () => {
  it('rejects publishing/editing a team-synced design system the caller may not manage', async () => {
    const app = express();
    app.use(express.json());
    const { updateUserDesignSystem } = registerRoutes(app, async () => false);
    const baseUrl = await listen(app);

    const res = await fetch(`${baseUrl}/api/design-systems/user:teammate-ds`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'published' }),
    });

    expect(res.status).toBe(403);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe('WORKSPACE_RESOURCE_MANAGE_DENIED');
    expect(updateUserDesignSystem).not.toHaveBeenCalled();
  });

  it('rejects deleting a team-synced design system the caller may not manage', async () => {
    const app = express();
    app.use(express.json());
    const { deleteUserDesignSystem } = registerRoutes(app, async () => false);
    const baseUrl = await listen(app);

    const res = await fetch(`${baseUrl}/api/design-systems/user:teammate-ds`, { method: 'DELETE' });

    expect(res.status).toBe(403);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe('WORKSPACE_RESOURCE_MANAGE_DENIED');
    expect(deleteUserDesignSystem).not.toHaveBeenCalled();
  });

  it('still allows publishing/editing when the caller can manage the shared system (owner or workspace admin)', async () => {
    const app = express();
    app.use(express.json());
    const { updateUserDesignSystem } = registerRoutes(app, async () => true);
    const baseUrl = await listen(app);

    const res = await fetch(`${baseUrl}/api/design-systems/user:teammate-ds`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'published' }),
    });

    expect(res.status).toBe(200);
    expect(updateUserDesignSystem).toHaveBeenCalledOnce();
  });

  it('still allows deleting a personal (non-team-synced) design system', async () => {
    const app = express();
    app.use(express.json());
    const { deleteUserDesignSystem } = registerRoutes(app, async () => true);
    const baseUrl = await listen(app);

    const res = await fetch(`${baseUrl}/api/design-systems/user:mine`, { method: 'DELETE' });

    expect(res.status).toBe(204);
    expect(deleteUserDesignSystem).toHaveBeenCalledOnce();
  });
});

describe('design system PATCH/DELETE workspace-lock guard (spec 9.2)', () => {
  const lockedHeaders = {
    'x-od-workspace-id': 'ws-locked',
    'x-od-workspace-member-id': 'member-1',
    'x-od-workspace-lifecycle-state': 'locked',
  };

  it('rejects publishing/editing when the caller workspace is locked, even if otherwise permitted', async () => {
    const app = express();
    app.use(express.json());
    // canMutate itself says yes — the lock gate must still win.
    const { updateUserDesignSystem } = registerRoutes(app, async () => true);
    const baseUrl = await listen(app);

    const res = await fetch(`${baseUrl}/api/design-systems/user:mine`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...lockedHeaders },
      body: JSON.stringify({ status: 'published' }),
    });

    expect(res.status).toBe(403);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe('WORKSPACE_LOCKED');
    expect(updateUserDesignSystem).not.toHaveBeenCalled();
  });

  it('rejects deleting when the caller workspace is locked, even if otherwise permitted', async () => {
    const app = express();
    app.use(express.json());
    const { deleteUserDesignSystem } = registerRoutes(app, async () => true);
    const baseUrl = await listen(app);

    const res = await fetch(`${baseUrl}/api/design-systems/user:mine`, {
      method: 'DELETE',
      headers: lockedHeaders,
    });

    expect(res.status).toBe(403);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe('WORKSPACE_LOCKED');
    expect(deleteUserDesignSystem).not.toHaveBeenCalled();
  });

  it('rejects deleting when the caller workspace is deleted', async () => {
    const app = express();
    app.use(express.json());
    const { deleteUserDesignSystem } = registerRoutes(app, async () => true);
    const baseUrl = await listen(app);

    const res = await fetch(`${baseUrl}/api/design-systems/user:mine`, {
      method: 'DELETE',
      headers: { ...lockedHeaders, 'x-od-workspace-lifecycle-state': 'deleted' },
    });

    expect(res.status).toBe(403);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe('WORKSPACE_LOCKED');
    expect(deleteUserDesignSystem).not.toHaveBeenCalled();
  });

  it('still allows deleting an active (unlocked) workspace resource', async () => {
    const app = express();
    app.use(express.json());
    const { deleteUserDesignSystem } = registerRoutes(app, async () => true);
    const baseUrl = await listen(app);

    const res = await fetch(`${baseUrl}/api/design-systems/user:mine`, {
      method: 'DELETE',
      headers: { ...lockedHeaders, 'x-od-workspace-lifecycle-state': 'active' },
    });

    expect(res.status).toBe(204);
    expect(deleteUserDesignSystem).toHaveBeenCalledOnce();
  });
});
