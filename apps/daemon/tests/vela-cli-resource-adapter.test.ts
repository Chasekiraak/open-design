import { describe, expect, it } from 'vitest';
import {
  contextHasTeamIdentity,
  createVelaCliResourceAdapter,
  shouldUseVelaCliResourceTransport,
} from '../src/collab/vela-cli-resource-adapter.js';

function recordingRun(outputs: Record<string, string>) {
  const calls: string[][] = [];
  const workspaces: Array<string | undefined> = [];
  const run = async (args: string[], workspaceId?: string): Promise<string> => {
    calls.push(args);
    workspaces.push(workspaceId);
    return outputs[args[0] ?? ''] ?? '';
  };
  return { run, calls, workspaces };
}

function scriptedRun(steps: Array<{ match: string[]; output?: string; error?: Error }>) {
  const calls: string[][] = [];
  const run = async (args: string[]): Promise<string> => {
    calls.push(args);
    const step = steps.shift();
    if (!step) throw new Error(`unexpected call: ${args.join(' ')}`);
    expect(args).toEqual(step.match);
    if (step.error) throw step.error;
    return step.output ?? '';
  };
  return { run, calls };
}

const OPTS = {
  resolveProjectDir: (id: string) => `/projects/${id}`,
  resolvePullDir: (id: string) => `/copies/${id}`,
  resourceIdFor: (id: string) => `project-${id}`,
  kind: 'design_system',
  hasTeamIdentity: () => true,
};

describe('createVelaCliResourceAdapter', () => {
  it('publishes by spawning `push … --ref published --json` and parses the version', async () => {
    const { run, calls } = recordingRun({ push: JSON.stringify({ version: 7, id: 'v7' }) });
    const adapter = createVelaCliResourceAdapter({ ...OPTS, run });
    const result = await adapter.publish({ projectId: 'p1', reason: 'edit' });
    expect(result).toEqual({ version: 7, versionId: 'v7' });
    expect(calls[0]).toEqual([
      'push',
      'design_system',
      'project-p1',
      '/projects/p1',
      '--ref',
      'published',
      '--json',
      '--exclude',
      '.file-versions',
      '--exclude',
      '.live-artifacts',
      '--exclude',
      '.od-skills',
      '--exclude',
      '.git',
      '--exclude',
      'node_modules',
      '--exclude',
      '.npmrc',
      '--exclude',
      '.yarnrc',
      '--exclude',
      '.yarnrc.yml',
      '--exclude',
      '.aws',
      '--exclude',
      '.ssh',
      '--exclude',
      '.azure',
      '--exclude',
      '.docker',
      '--exclude',
      '.gnupg',
      '--exclude',
      '.kube',
      '--exclude',
      '.pulumi',
      '--exclude',
      '.terraform',
      '--exclude',
      '.git-credentials',
      '--exclude',
      '.netrc',
      '--exclude',
      '.pypirc',
      '--exclude',
      'terraform.tfstate',
      '--exclude',
      'terraform.tfstate.backup',
      '--exclude-prefix',
      '.env',
    ]);
  });

  it('passes project metadata to the resource index when available', async () => {
    const { run, calls } = recordingRun({ push: JSON.stringify({ version: 7, id: 'v7' }) });
    const adapter = createVelaCliResourceAdapter({
      ...OPTS,
      describeProject: () => ({ name: 'Launch Deck', metadata: { kind: 'deck' } }),
      run,
    });
    await adapter.publish({ projectId: 'p1', reason: 'edit' });
    expect(calls[0]).toEqual([
      'push',
      'design_system',
      'project-p1',
      '/projects/p1',
      '--ref',
      'published',
      '--json',
      '--exclude',
      '.file-versions',
      '--exclude',
      '.live-artifacts',
      '--exclude',
      '.od-skills',
      '--exclude',
      '.git',
      '--exclude',
      'node_modules',
      '--exclude',
      '.npmrc',
      '--exclude',
      '.yarnrc',
      '--exclude',
      '.yarnrc.yml',
      '--exclude',
      '.aws',
      '--exclude',
      '.ssh',
      '--exclude',
      '.azure',
      '--exclude',
      '.docker',
      '--exclude',
      '.gnupg',
      '--exclude',
      '.kube',
      '--exclude',
      '.pulumi',
      '--exclude',
      '.terraform',
      '--exclude',
      '.git-credentials',
      '--exclude',
      '.netrc',
      '--exclude',
      '.pypirc',
      '--exclude',
      'terraform.tfstate',
      '--exclude',
      'terraform.tfstate.backup',
      '--exclude-prefix',
      '.env',
      '--metadata-json',
      JSON.stringify({ name: 'Launch Deck', metadata: { kind: 'deck' } }),
    ]);
  });

  it('stores the project id in project resource metadata for legacy catalog fallback', async () => {
    const { run, calls } = recordingRun({ push: JSON.stringify({ version: 7 }) });
    const adapter = createVelaCliResourceAdapter({
      ...OPTS,
      kind: 'project',
      describeProject: () => ({ name: 'Launch Deck' }),
      run,
    });

    await adapter.publish({ projectId: 'p1', reason: 'share' });

    expect(calls[0]?.slice(-2)).toEqual([
      '--metadata-json',
      JSON.stringify({ projectId: 'p1', name: 'Launch Deck' }),
    ]);
  });

  it('reports the head version via `head` without pulling', async () => {
    const { run, calls } = recordingRun({ head: JSON.stringify({ version: 3 }) });
    const adapter = createVelaCliResourceAdapter({ ...OPTS, run });
    expect(await adapter.syncLatest!({ projectId: 'p1' })).toEqual({ version: 3 });
    expect(calls[0]).toEqual(['head', 'project-p1', '--ref', 'published', '--json']);
  });

  it('passes the selected team workspace to every scoped Vela invocation', async () => {
    const principal = {
      teamId: 'team-selected',
      memberId: 'member-1',
      role: 'member',
      lifecycleState: 'active',
      workspaceType: 'team',
    } as const;
    const { run, workspaces } = recordingRun({
      push: JSON.stringify({ version: 7 }),
      head: JSON.stringify({ version: 7 }),
      pull: JSON.stringify({ version: 7, versionId: 'v7' }),
      remove: '{}',
    });
    const adapter = createVelaCliResourceAdapter({ ...OPTS, run });

    await adapter.publish({ projectId: 'p1', principal, reason: 'edit' });
    await adapter.syncLatest!({ projectId: 'p1', principal });
    await adapter.pull!({ projectId: 'p1', principal });
    await adapter.unpublish!({ projectId: 'p1', principal });

    expect(workspaces).toEqual([
      'team-selected',
      'team-selected',
      'team-selected',
      'team-selected',
    ]);
  });

  it('treats a null head version (nothing published) as no result', async () => {
    const { run } = recordingRun({ head: JSON.stringify({ resourceId: 'project-p1', ref: 'published', version: null }) });
    const adapter = createVelaCliResourceAdapter({ ...OPTS, run });
    expect(await adapter.syncLatest!({ projectId: 'p1' })).toBeNull();
  });

  it('falls back to the legacy unscoped resource id when a scoped head is empty', async () => {
    const principal = { teamId: 't1', memberId: 'm1', role: 'member', lifecycleState: 'active' } as const;
    const { run, calls } = scriptedRun([
      {
        match: ['head', 'project-t1-m1-p1', '--ref', 'published', '--json'],
        output: JSON.stringify({ resourceId: 'project-t1-m1-p1', ref: 'published', version: null }),
      },
      {
        match: ['head', 'project-p1', '--ref', 'published', '--json'],
        output: JSON.stringify({ version: 9 }),
      },
    ]);
    const adapter = createVelaCliResourceAdapter({
      ...OPTS,
      resourceIdFor: (id, inputPrincipal) =>
        inputPrincipal ? `project-${inputPrincipal.teamId}-${inputPrincipal.memberId}-${id}` : `project-${id}`,
      run,
    });
    expect(await adapter.syncLatest!({ projectId: 'p1', principal })).toEqual({ version: 9 });
    expect(calls).toHaveLength(2);
  });

  it('returns the exact version materialized by `pull --json`', async () => {
    const { run, calls } = recordingRun({
      pull: JSON.stringify({
        version: 1,
        versionId: 'v1',
        manifestDigest: 'd1',
      }),
    });
    const adapter = createVelaCliResourceAdapter({ ...OPTS, run });
    const result = await adapter.pull!({ projectId: 'p1' });
    expect(result).toEqual({ version: 1, versionId: 'v1' });
    expect(calls[0]).toEqual(['pull', 'design_system', 'project-p1', '/copies/p1', '--ref', 'published', '--json']);
  });

  it('falls back to the legacy unscoped resource id when a scoped pull is missing', async () => {
    const principal = { teamId: 't1', memberId: 'm1', role: 'member', lifecycleState: 'active' } as const;
    const { run, calls } = scriptedRun([
      {
        match: ['pull', 'design_system', 'project-t1-m1-p1', '/copies/p1', '--ref', 'published', '--json'],
        error: new Error('resource_not_found'),
      },
      {
        match: ['pull', 'design_system', 'project-p1', '/copies/p1', '--ref', 'published', '--json'],
        output: JSON.stringify({ version: 9, versionId: 'v9' }),
      },
    ]);
    const adapter = createVelaCliResourceAdapter({
      ...OPTS,
      resourceIdFor: (id, inputPrincipal) =>
        inputPrincipal ? `project-${inputPrincipal.teamId}-${inputPrincipal.memberId}-${id}` : `project-${id}`,
      run,
    });
    await adapter.pull!({ projectId: 'p1', principal });
    expect(calls).toHaveLength(2);
  });

  it('fails closed when a successful pull response omits the materialized version', async () => {
    const { run } = recordingRun({
      pull: JSON.stringify({
        resourceId: 'project-p1',
        ref: 'published',
        dir: '/copies/p1',
      }),
    });
    const adapter = createVelaCliResourceAdapter({ ...OPTS, run });

    await expect(adapter.pull!({ projectId: 'p1' })).rejects.toThrow(
      'missing the materialized version',
    );
  });

  it('does not hide authentication failures behind a legacy pull fallback', async () => {
    const principal = { teamId: 't1', memberId: 'm1', role: 'member', lifecycleState: 'active' } as const;
    const { run, calls } = scriptedRun([
      {
        match: ['pull', 'design_system', 'project-t1-m1-p1', '/copies/p1', '--ref', 'published', '--json'],
        error: new Error('API request failed with status 403: missing_principal'),
      },
    ]);
    const adapter = createVelaCliResourceAdapter({
      ...OPTS,
      resourceIdFor: (id, inputPrincipal) =>
        inputPrincipal ? `project-${inputPrincipal.teamId}-${inputPrincipal.memberId}-${id}` : `project-${id}`,
      run,
    });

    await expect(adapter.pull!({ projectId: 'p1', principal })).rejects.toThrow(
      'missing_principal',
    );
    expect(calls).toHaveLength(1);
  });

  it('removes a project from the team resource index', async () => {
    const { run, calls } = recordingRun({ remove: JSON.stringify({ ok: true }) });
    const adapter = createVelaCliResourceAdapter({ ...OPTS, run });
    await adapter.unpublish!({ projectId: 'p1' });
    expect(calls[0]).toEqual(['remove', 'project-p1', '--json']);
  });

  it('no-ops (never spawns) when there is no team identity', async () => {
    const { run, calls } = recordingRun({ push: JSON.stringify({ version: 1 }) });
    const adapter = createVelaCliResourceAdapter({ ...OPTS, hasTeamIdentity: () => false, run });
    expect(await adapter.publish({ projectId: 'p1', reason: 'edit' })).toBeNull();
    expect(await adapter.syncLatest!({ projectId: 'p1' })).toBeNull();
    await adapter.pull!({ projectId: 'p1' });
    await adapter.unpublish!({ projectId: 'p1' });
    expect(calls.length).toBe(0);
  });

  it('stops spawning `vela resource push` on the very next attempt once the live context reports the member removed', async () => {
    // Reproduces the collab-publish-watcher gap: an already-attached file
    // watcher never re-checks `shouldPublish`, so the ONLY thing standing
    // between a removed owner's local edits and `vela resource push` is this
    // adapter re-deriving `hasTeamIdentity` fresh on every publish attempt.
    const { run, calls } = recordingRun({ push: JSON.stringify({ version: 1 }) });
    let memberStatus: 'active' | 'removed' = 'active';
    const adapter = createVelaCliResourceAdapter({
      ...OPTS,
      hasTeamIdentity: () =>
        contextHasTeamIdentity({
          workspaceType: 'team',
          workspaceId: 't1',
          workspaceMemberId: 'm1',
          memberStatus,
        } as never),
      run,
    });

    // While still an active member, an edit publishes normally.
    expect(await adapter.publish({ projectId: 'p1', reason: 'edit' })).toEqual({ version: 1 });
    expect(calls).toHaveLength(1);

    // The team removes this member out-of-band (B-side); the daemon keeps
    // running with the file watcher still attached.
    memberStatus = 'removed';

    // The next debounced publish for the SAME already-watched project must not
    // reach the vela CLI at all.
    expect(await adapter.publish({ projectId: 'p1', reason: 'edit' })).toBeNull();
    expect(calls).toHaveLength(1);

    // Read/unpublish operations on the same live session are refused too —
    // a removed member's daemon should not keep talking to the team hub at
    // all through this session.
    expect(await adapter.syncLatest!({ projectId: 'p1' })).toBeNull();
    await adapter.pull!({ projectId: 'p1' });
    await adapter.unpublish!({ projectId: 'p1' });
    expect(calls).toHaveLength(1);
  });
});

describe('transport selection', () => {
  it('opts into the CLI transport for explicit or Vela-backed team modes', () => {
    expect(shouldUseVelaCliResourceTransport({ OD_RESOURCE_TRANSPORT: 'vela-cli' })).toBe(true);
    expect(shouldUseVelaCliResourceTransport({ OD_RESOURCE_TRANSPORT: 'sdk' })).toBe(false);
    expect(shouldUseVelaCliResourceTransport({ OD_WORKSPACE_CONTEXT_SOURCE: 'vela' })).toBe(true);
    expect(shouldUseVelaCliResourceTransport({
      OD_WORKSPACE_CONTEXT_SOURCE: 'vela',
      OD_RESOURCE_TRANSPORT: 'sdk',
    })).toBe(true);
    expect(shouldUseVelaCliResourceTransport({ OD_TEAM_PROJECTS_TRANSPORT: 'vela-cli' })).toBe(true);
    expect(shouldUseVelaCliResourceTransport({ OD_COLLAB_TRANSPORT: 'vela-cli' })).toBe(true);
    expect(shouldUseVelaCliResourceTransport({})).toBe(false);
  });

  it('gates team identity on a live team workspace context', () => {
    expect(
      contextHasTeamIdentity({
        workspaceType: 'team',
        workspaceId: 't1',
        workspaceMemberId: 'm1',
        memberStatus: 'active',
      } as never),
    ).toBe(true);
    expect(contextHasTeamIdentity({
      workspaceType: 'personal',
      workspaceId: 'personal-1',
      workspaceMemberId: 'm1',
      memberStatus: 'active',
    } as never)).toBe(false);
    expect(contextHasTeamIdentity(null)).toBe(false);
  });

  it('refuses a member the team has removed, even though their identity fields still resolve', () => {
    // A removed member's workspaceType/workspaceId/workspaceMemberId keep
    // resolving — only memberStatus flips — so the identity fields alone are
    // not enough to prove this session may still address the resource hub.
    expect(
      contextHasTeamIdentity({
        workspaceType: 'team',
        workspaceId: 't1',
        workspaceMemberId: 'm1',
        memberStatus: 'removed',
      } as never),
    ).toBe(false);
  });
});
