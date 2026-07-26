import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createActiveWorkspaceSelectionStore,
  resolveAuthorizedActiveTeamWorkspaceSnapshot,
} from '../../src/collab/active-workspace-selection.js';
import {
  createDevWorkspaceContextProvider,
  withLastKnownWorkspaceContext,
} from '../../src/collab/workspace-context.js';
import type { WorkspaceCollabContext } from '@open-design/contracts';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('observed active team workspace snapshot', () => {
  const activeIdentity = {
    workspaceId: 'workspace-1',
    teamId: 'team-1',
    workspaceMemberId: 'member-1',
    workspaceType: 'team',
    memberStatus: 'active',
    lifecycleState: 'active',
    role: 'member',
    billingState: 'active',
    planId: null,
    providerMode: 'platform_credits',
    seatSummary: { seatLimit: 5, usedSeats: 2, availableSeats: 3 },
    permissions: {
      canManageMembers: false,
      canManageBilling: false,
      canShareProjects: true,
      canWriteSyncedFiles: true,
    },
  } as WorkspaceCollabContext;

  it('uses the freshly verified team identity when no explicit pin exists', () => {
    expect(resolveAuthorizedActiveTeamWorkspaceSnapshot(
      { workspaceId: null, generation: 0 },
      { context: activeIdentity, generation: 1 },
    )).toEqual({ workspaceId: 'workspace-1', generation: 1 });
  });

  it('fails closed when an explicit pin disagrees with verified identity', () => {
    expect(resolveAuthorizedActiveTeamWorkspaceSnapshot(
      { workspaceId: 'workspace-pinned', generation: 4 },
      { context: activeIdentity, generation: 2 },
    )).toEqual({ workspaceId: null, generation: 6 });
  });

  it('records A to B to A even when no authorization snapshot was read at B', async () => {
    const provider = withLastKnownWorkspaceContext(
      createDevWorkspaceContextProvider(activeIdentity),
    );
    await provider.current({});
    const captured = provider.lastKnownSnapshot!();

    provider.set!({ ...activeIdentity, workspaceId: 'workspace-2' });
    provider.set!(activeIdentity);

    expect(provider.lastKnownSnapshot!()).toEqual({
      context: activeIdentity,
      generation: captured.generation + 2,
    });
  });

  it('increments identity generation for member and lifecycle drift', async () => {
    const provider = withLastKnownWorkspaceContext(
      createDevWorkspaceContextProvider(activeIdentity),
    );
    await provider.current({});
    const captured = provider.lastKnownSnapshot!();
    provider.set!({ ...activeIdentity, memberStatus: 'removed' });
    provider.set!({
      ...activeIdentity,
      lifecycleState: 'locked',
    });

    expect(provider.lastKnownSnapshot!()).toMatchObject({
      generation: captured.generation + 2,
    });
  });
});

describe('active workspace selection generation', () => {
  it('detects away-and-back changes even when the final workspace id matches', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'od-workspace-selection-'));
    roots.push(root);
    const store = createActiveWorkspaceSelectionStore(root);

    await store.set('workspace-1');
    const captured = store.snapshot();
    await store.set('workspace-2');
    await store.set('workspace-1');

    expect(store.snapshot()).toEqual({
      workspaceId: 'workspace-1',
      generation: captured.generation + 2,
    });
  });

  it('increments generation when the selection is cleared', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'od-workspace-selection-'));
    roots.push(root);
    const store = createActiveWorkspaceSelectionStore(root);
    await store.set('workspace-1');
    const captured = store.snapshot();

    await store.clear();

    expect(store.snapshot()).toEqual({
      workspaceId: null,
      generation: captured.generation + 1,
    });
  });
});
