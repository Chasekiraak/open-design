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
//
// spec 04 §10 addendum: "no scope" itself now splits into two distinct
// signals a caller can send, not one. `workspaceId` OMITTED entirely means an
// internal caller never asked to be scoped (id resolution, self-lookup after
// a write) and must keep seeing everything. `workspaceId: null` or `''` means
// a caller DID ask to be scoped — `GET /api/design-systems` with no verified
// session — and must now see ONLY unclaimed systems, not everything, or a
// signed-out reader could still list every workspace's claimed systems.

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

  it('lists everything when the `workspaceId` option is OMITTED (the unscoped-catalog contract)', async () => {
    // Callers that resolve a system BY ID — project validation, install/import
    // lookups, and `createUserDesignSystem`/`updateUserDesignSystem`/
    // `linkUserDesignSystemProject` re-reading the system they just wrote —
    // must keep seeing the whole catalog regardless of which workspace
    // happens to be active. This is the ONE "no scope" case that must stay
    // permissive: those call sites pass no `workspaceId` key at all, and
    // `designSystemVisibleFromWorkspace` treats an OMITTED (`undefined`)
    // scope as "never asked to be scoped" — see spec 04 §10 fix #2's
    // undefined-vs-null split. Getting this wrong would make
    // `listDesignSystems(...).find(...)` fail to find a system right after
    // writing it, whenever that system happens to be workspace-claimed.
    const root = freshRoot();
    seedSystem(root, 'from-a', { title: 'From A', workspaceId: WORKSPACE_A });
    seedSystem(root, 'from-b', { title: 'From B', workspaceId: WORKSPACE_B });

    expect(listIds(await listDesignSystems(root))).toEqual(['from-a', 'from-b']);
  });

  it('hides claimed systems when the caller passes an explicit empty workspace scope (spec 04 §10)', async () => {
    // `GET /api/design-systems` ALWAYS passes a `workspaceId` key — `null`
    // whenever there is no verified session — which is a DIFFERENT signal
    // from the omitted-key case above: this caller DID ask to be scoped, it
    // just has no identity to offer. Before this fix, `!scopeId` alone
    // resolved to "visible", which meant a signed-out reader (or a plain
    // `curl` with no headers) could still list every claimed system in every
    // workspace — "no scope" silently meant "trust everything"
    // (recvqbeDjAsejl / recvqbklNGDqYY). Only a genuinely UNCLAIMED system
    // stays visible to this caller.
    const root = freshRoot();
    seedSystem(root, 'from-a', { title: 'From A', workspaceId: WORKSPACE_A });
    seedSystem(root, 'from-b', { title: 'From B', workspaceId: WORKSPACE_B });
    seedSystem(root, 'legacy', { title: 'Legacy' });

    expect(listIds(await listDesignSystems(root, { workspaceId: '' }))).toEqual(['legacy']);
    expect(listIds(await listDesignSystems(root, { workspaceId: null }))).toEqual(['legacy']);
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
