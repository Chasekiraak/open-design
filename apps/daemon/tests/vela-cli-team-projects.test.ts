import { describe, expect, it } from 'vitest';
import {
  createVelaCliTeamProjectCatalog,
  createVelaCliTeamProjectCatalogClient,
  shouldUseVelaCliTeamProjectCatalog,
} from '../src/collab/vela-cli-team-projects.js';

describe('Vela CLI team-project catalog adapter', () => {
  it('uses an explicitly captured workspace for an authoritative list', async () => {
    const catalog = createVelaCliTeamProjectCatalog({
      supportsTeamProjects: () => true,
      getWorkspaceId: () => 'team-current',
      run: async (args, workspaceId) => {
        expect(args).toEqual(['list']);
        expect(workspaceId).toBe('team-captured');
        return JSON.stringify({ projects: [] });
      },
    });

    await expect(catalog.list('team-captured')).resolves.toEqual([]);
  });

  it('maps list output into team-project DTOs', async () => {
    const catalog = createVelaCliTeamProjectCatalog({
      supportsTeamProjects: () => true,
      getWorkspaceId: () => 'team-selected',
      run: async (args, workspaceId) => {
        expect(args).toEqual(['list']);
        expect(workspaceId).toBe('team-selected');
        return JSON.stringify({
          projects: [
            {
              projectId: 'p1',
              ownerMemberId: 'wm-owner',
              displayName: 'Electric Studio 2',
              syncState: 'synced',
              metadata: {
                skillId: 'deck-builder',
                designSystemId: 'ds-emerald',
                createdAt: 1719820800000,
                updatedAt: 1719907200000,
                metadata: { kind: 'deck', entryFile: 'index.html' },
              },
              createdAt: '2026-07-01T00:00:00.000Z',
              updatedAt: '2026-07-02T00:00:00.000Z',
            },
          ],
        });
      },
    });

    await expect(catalog.list()).resolves.toEqual([
      {
        projectId: 'p1',
        ownerMemberId: 'wm-owner',
        sharedAt: '2026-07-01T00:00:00.000Z',
        name: 'Electric Studio 2',
        skillId: 'deck-builder',
        designSystemId: 'ds-emerald',
        createdAt: 1719820800000,
        updatedAt: 1719907200000,
        metadata: { kind: 'deck', entryFile: 'index.html' },
      },
    ]);
  });

  it('hides catalog rows whose project bytes are not synced yet', async () => {
    const catalog = createVelaCliTeamProjectCatalog({
      supportsTeamProjects: () => true,
      run: async () => JSON.stringify({
        projects: [
          {
            projectId: 'pending',
            ownerMemberId: 'wm-owner',
            displayName: 'Pending Upload',
            syncState: 'pending_upload',
            createdAt: '2026-07-01T00:00:00.000Z',
          },
          {
            projectId: 'failed',
            ownerMemberId: 'wm-owner',
            displayName: 'Failed Upload',
            syncState: 'failed',
            createdAt: '2026-07-01T00:00:00.000Z',
          },
          {
            projectId: 'synced',
            ownerMemberId: 'wm-owner',
            displayName: 'Ready Project',
            syncState: 'synced',
            createdAt: '2026-07-01T00:00:00.000Z',
          },
        ],
      }),
    });

    await expect(catalog.list()).resolves.toEqual([
      {
        projectId: 'synced',
        ownerMemberId: 'wm-owner',
        sharedAt: '2026-07-01T00:00:00.000Z',
        name: 'Ready Project',
        createdAt: Date.parse('2026-07-01T00:00:00.000Z'),
      },
    ]);
  });

  it('uses Vela team-project commands for upsert and remove', async () => {
    const calls: string[][] = [];
    const catalog = createVelaCliTeamProjectCatalog({
      supportsTeamProjects: () => true,
      run: async (args) => {
        calls.push(args);
        return '{}';
      },
    });

    await catalog.upsert({
      projectId: 'p1',
      displayName: 'Electric Studio 2',
      syncState: 'pending_upload',
      lastSyncedVersionId: 'v2',
      metadata: {
        skillId: 'deck-builder',
        designSystemId: 'ds-emerald',
        metadata: { kind: 'deck' },
      },
    });
    await catalog.remove('p1');

    expect(calls).toEqual([
      [
        'upsert',
        'p1',
        '--resource-id',
        'project-p1',
        '--display-name',
        'Electric Studio 2',
        '--sync-state',
        'pending_upload',
        '--last-synced-version-id',
        'v2',
        '--metadata-json',
        JSON.stringify({
          skillId: 'deck-builder',
          designSystemId: 'ds-emerald',
          metadata: { kind: 'deck' },
        }),
      ],
      ['remove', 'p1'],
    ]);
  });

  it('falls back to vela resource shared when the CLI lacks team-projects', async () => {
    const scopedId = `project-${Buffer.from(
      JSON.stringify(['team-1', 'member-owner', 'p-fallback']),
      'utf8',
    ).toString('base64url')}`;
    const teamCalls: string[][] = [];
    const resourceCalls: string[][] = [];
    const sharedOutput = JSON.stringify({
      resources: [
        {
          id: scopedId,
          teamId: 'team-1',
          kind: 'project',
          ownerMemberId: 'member-owner',
          metadata: {
            name: 'Fallback Project',
            skillId: 'deck-builder',
            createdAt: 1719820800000,
            updatedAt: 1719907200000,
            metadata: { kind: 'deck' },
          },
          createdAt: '2026-07-01T00:00:00.000Z',
          deletedAt: null,
        },
      ],
    });
    const options = {
      run: async (args: string[]) => {
        teamCalls.push(args);
        throw new Error('unknown command "team-projects" for "vela"');
      },
      runResource: async (args: string[]) => {
        resourceCalls.push(args);
        return sharedOutput;
      },
    };

    const catalog = createVelaCliTeamProjectCatalog(options);
    await expect(catalog.list()).resolves.toEqual([
      {
        projectId: 'p-fallback',
        ownerMemberId: 'member-owner',
        sharedAt: '2026-07-01T00:00:00.000Z',
        name: 'Fallback Project',
        skillId: 'deck-builder',
        createdAt: 1719820800000,
        updatedAt: 1719907200000,
        metadata: { kind: 'deck' },
      },
    ]);
    await catalog.upsert({ projectId: 'p-fallback' });
    await catalog.remove('p-fallback');
    expect(teamCalls).toEqual([['--help']]);
    expect(resourceCalls).toEqual([['shared', '--json']]);

    const client = createVelaCliTeamProjectCatalogClient(options);
    await expect(client.list()).resolves.toEqual([
      expect.objectContaining({
        workspaceId: 'team-1',
        projectId: 'p-fallback',
        resourceId: scopedId,
        ownerMemberId: 'member-owner',
        displayName: 'Fallback Project',
        syncState: 'synced',
      }),
    ]);
    await expect(client.upsert({
      projectId: 'p-fallback',
      resourceId: scopedId,
    })).resolves.toBeNull();
    expect(teamCalls).toEqual([['--help'], ['--help']]);
    expect(resourceCalls).toEqual([
      ['shared', '--json'],
      ['shared', '--json'],
    ]);
  });

  it('keeps Vela workspace context authoritative over legacy transport flags', () => {
    expect(shouldUseVelaCliTeamProjectCatalog({
      OD_WORKSPACE_CONTEXT_SOURCE: 'vela',
      OD_TEAM_PROJECTS_TRANSPORT: 'resource-hub',
    })).toBe(true);
  });
});
