// Workspace scoping for the user design-system library (#145).
//
// Acceptance report: a design system authored in one workspace also showed up
// in a brand-new second workspace. User design systems all live in ONE flat
// directory under the daemon data root — there is no per-workspace store — so
// the only thing that can separate them is the `workspaceId` claim written into
// each system's `metadata.json` plus the filter this file pins.
//
// The rule is deliberately asymmetric, and both halves matter:
//   • a system CLAIMED by another workspace is hidden (the reported bug), and
//   • an UNCLAIMED system stays visible everywhere.
// Unclaimed is exactly what every system written before this change looks like,
// so hiding those would empty an upgrading user's library — a worse regression
// than the leak being fixed.

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { createUserDesignSystem, listDesignSystems } from '../../src/design-systems/index.js';

const WORKSPACE_A = 'vp44mftzknedrrqgy05oqpv9';
const WORKSPACE_B = 'jg63to8cbic0kzbczbu95a4g';

function freshRoot(): string {
  return mkdtempSync(path.join(tmpdir(), 'od-ds-workspace-scope-'));
}

/** Write a design system directly on disk with the given metadata. */
function seedSystem(root: string, dirId: string, metadata: Record<string, unknown>): void {
  const dir = path.join(root, dirId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'DESIGN.md'), `# ${dirId}\n\nA seeded system.\n`, 'utf8');
  writeFileSync(path.join(dir, 'metadata.json'), `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
}

function listIds(systems: Array<{ id: string }>): string[] {
  return systems.map((system) => system.id).sort();
}

describe('design-system workspace scoping', () => {
  it('hides a system claimed by another workspace', async () => {
    const root = freshRoot();
    seedSystem(root, 'from-a', { title: 'From A', workspaceId: WORKSPACE_A });
    seedSystem(root, 'from-b', { title: 'From B', workspaceId: WORKSPACE_B });

    const fromB = await listDesignSystems(root, { workspaceId: WORKSPACE_B });

    expect(listIds(fromB)).toEqual(['from-b']);
  });

  it('keeps an unclaimed (pre-#145) system visible from every workspace', async () => {
    const root = freshRoot();
    seedSystem(root, 'legacy', { title: 'Legacy' });
    seedSystem(root, 'from-a', { title: 'From A', workspaceId: WORKSPACE_A });

    const fromA = await listDesignSystems(root, { workspaceId: WORKSPACE_A });
    const fromB = await listDesignSystems(root, { workspaceId: WORKSPACE_B });

    expect(listIds(fromA)).toEqual(['from-a', 'legacy']);
    expect(listIds(fromB)).toEqual(['legacy']);
  });

  it('lists everything when no workspace scope is given', async () => {
    // Callers that resolve a system BY ID — project validation, install/import
    // lookups — must keep seeing the whole catalog regardless of which
    // workspace happens to be active, or a project would stop finding its own
    // design system after a switch.
    const root = freshRoot();
    seedSystem(root, 'from-a', { title: 'From A', workspaceId: WORKSPACE_A });
    seedSystem(root, 'from-b', { title: 'From B', workspaceId: WORKSPACE_B });

    expect(listIds(await listDesignSystems(root))).toEqual(['from-a', 'from-b']);
    expect(listIds(await listDesignSystems(root, { workspaceId: '' }))).toEqual([
      'from-a',
      'from-b',
    ]);
  });

  it('claims a newly created system for the authoring workspace', async () => {
    const root = freshRoot();
    const created = await createUserDesignSystem(root, {
      title: 'Authored in A',
      workspaceId: WORKSPACE_A,
    });

    const fromA = await listDesignSystems(root, { idPrefix: 'user:', workspaceId: WORKSPACE_A });
    const fromB = await listDesignSystems(root, { idPrefix: 'user:', workspaceId: WORKSPACE_B });

    expect(fromA.map((system) => system.id)).toContain(created.id);
    expect(fromB).toEqual([]);
  });

  it('leaves a system unclaimed when no workspace is active', async () => {
    // Signed out / single-player: there are no workspaces to isolate, so the
    // system must stay visible rather than becoming unreachable later.
    const root = freshRoot();
    const created = await createUserDesignSystem(root, { title: 'Local only' });

    const scoped = await listDesignSystems(root, { idPrefix: 'user:', workspaceId: WORKSPACE_A });

    expect(scoped.map((system) => system.id)).toContain(created.id);
  });

  it('ignores a malformed workspace claim instead of trusting it', async () => {
    const root = freshRoot();
    seedSystem(root, 'garbled', { title: 'Garbled', workspaceId: '../../etc/passwd' });

    const scoped = await listDesignSystems(root, { workspaceId: WORKSPACE_A });

    expect(listIds(scoped)).toEqual(['garbled']);
  });
});
