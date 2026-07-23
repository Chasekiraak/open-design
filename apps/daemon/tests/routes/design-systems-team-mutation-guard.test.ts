// recvqb6mfyqXLD: a design system materialized locally from a teammate's team
// share must not be editable, publish-toggleable, or deletable by a plain
// member — only the original sharer, or a workspace owner/admin, may mutate
// it (the same rule "who can unshare" already enforces). The UI hides the
// affordances (DesignSystemsTab.tsx `canManageTeamSynced`), but nothing
// stopped a direct PATCH/DELETE call before this guard: `canMutateUserDesignSystem`
// is the server-side enforcement point these specs pin down.

import type http from 'node:http';
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerDesignSystemRoutes } from '../../src/routes/design-systems.js';
import type { DesignSystemSummary } from '../../src/design-systems/index.js';

let server: http.Server | null = null;

afterEach(async () => {
  if (!server) return;
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  server = null;
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

function registerRoutes(app: express.Express, canMutate: (root: string, id: string) => Promise<boolean>) {
  const updateUserDesignSystem = vi.fn(async () => ({ ...designSystemSummary, status: 'published' as const }));
  const deleteUserDesignSystem = vi.fn(async () => true);
  registerDesignSystemRoutes(app, {
    db: {} as never,
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
