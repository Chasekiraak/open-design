import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  applyPlugin,
  contributeGeneratedPluginToOpenDesign,
  createDesignSystemProjectFromProject,
  createProject,
  createPluginShareProject,
  deleteProject,
  duplicateProject,
  importClaudeDesignZip,
  importFolderProject,
  installGeneratedPluginFolder,
  listProjects,
  listWorkspaceProjectSummaries,
  listPlugins,
  patchProject,
  pickLocalFolderPath,
  publishGeneratedPluginToGitHub,
} from '../../src/state/projects';
import {
  buildWorkspacePermissions,
  buildWorkspaceSeatSummary,
  type WorkspaceCollabContext,
} from '@open-design/contracts';

function personalWorkspaceContext(): WorkspaceCollabContext {
  return {
    workspaceId: 'ws-personal',
    workspaceType: 'personal',
    workspaceMemberId: 'wm-1',
    role: 'owner',
    memberStatus: 'active',
    lifecycleState: 'active',
    billingState: 'active',
    planId: null,
    providerMode: 'platform_credits',
    seatSummary: buildWorkspaceSeatSummary({ seatLimit: 1, usedSeats: 1 }),
    permissions: buildWorkspacePermissions({ role: 'owner', lifecycleState: 'active' }),
  };
}

function teamWorkspaceContext(
  overrides: Partial<WorkspaceCollabContext> = {},
): WorkspaceCollabContext {
  return {
    ...personalWorkspaceContext(),
    workspaceId: 'ws-team',
    workspaceType: 'team',
    role: 'member',
    teamId: 'team-1',
    ...overrides,
  };
}

describe('applyPlugin', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('passes the current locale to the daemon apply endpoint', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(
      JSON.stringify({
        query: '生成一份简报。',
        contextItems: [],
        inputs: [],
        assets: [],
        mcpServers: [],
        projectMetadata: {},
        trust: 'trusted',
        capabilitiesGranted: [],
        capabilitiesRequired: [],
        appliedPlugin: {
          snapshotId: 'snap-1',
          pluginId: 'sample-plugin',
          pluginVersion: '1.0.0',
          manifestSourceDigest: 'a'.repeat(64),
          inputs: {},
          resolvedContext: { items: [] },
          capabilitiesGranted: [],
          capabilitiesRequired: [],
          assetsStaged: [],
          taskKind: 'new-generation',
          appliedAt: 0,
          connectorsRequired: [],
          connectorsResolved: [],
          mcpServers: [],
          status: 'fresh',
        },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));
    vi.stubGlobal('fetch', fetchMock);

    await applyPlugin('sample-plugin', { locale: 'zh-CN' });

    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(String(init?.body))).toMatchObject({
      inputs: {},
      grantCaps: [],
      locale: 'zh-CN',
    });
  });
});

describe('listProjects', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('keeps the default fail-soft behavior for background app startup', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => new Response(null, { status: 503 })));

    await expect(listProjects()).resolves.toEqual([]);
  });

  it('can reject transport failures for refresh paths that must preserve current state', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => new Response(null, { status: 503 })));

    await expect(listProjects({ throwOnError: true })).rejects.toThrow('projects 503');
  });

  it('coalesces a burst of identical reads into a single request', async () => {
    // A rapid tab switch (草稿 ↔ 全部项目) or several separately-mounted grids
    // each call listProjects at once; without coalescing that is one vela-backed
    // request — and one spawned CLI subprocess — per caller, which overwhelmed
    // the daemon and hung the loader. Identical in-flight reads must share one.
    const fetchMock = vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify({ projects: [{ id: 'p1' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const [a, b, c] = await Promise.all([listProjects(), listProjects(), listProjects()]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(a).toEqual([{ id: 'p1' }]);
    expect(b).toBe(a);
    expect(c).toBe(a);
  });

  it('returns raw workspace summaries with the captured member scope', async () => {
    const summary = { id: 'p1', project: { id: 'p1' } };
    const fetchMock = vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify({ projects: [summary] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const context = teamWorkspaceContext();

    await expect(listWorkspaceProjectSummaries({
      context,
      workspaceView: 'team',
      throwOnError: true,
    })).resolves.toEqual([summary]);

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/workspaces/ws-team/projects?view=team',
      expect.objectContaining({
        headers: expect.objectContaining({
          'x-od-workspace-id': 'ws-team',
          'x-od-workspace-member-id': 'wm-1',
        }),
      }),
    );
  });

  it('returns one card model when workspace summaries repeat a logical project', async () => {
    const localProject = {
      id: 'shared-project',
      name: 'Local project',
      createdAt: 1,
      updatedAt: 3,
    };
    const remoteProject = {
      id: 'shared-project',
      name: 'Remote catalog copy',
      createdAt: 1,
      updatedAt: 2,
    };
    const fetchMock = vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify({
        projects: [
          { id: 'local-summary', project: localProject },
          { id: 'remote-resource-summary', project: remoteProject },
        ],
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(listProjects({
      workspaceContext: teamWorkspaceContext(),
      workspaceView: 'recent',
      throwOnError: true,
    })).resolves.toEqual([localProject]);
  });

  it('does not coalesce workspace snapshots across different members', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetchMock = vi.fn<typeof fetch>(async () => {
      await gate;
      return new Response(JSON.stringify({ projects: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const first = listWorkspaceProjectSummaries({
      context: teamWorkspaceContext({ workspaceMemberId: 'wm-1' }),
      workspaceView: 'team',
    });
    const second = listWorkspaceProjectSummaries({
      context: teamWorkspaceContext({ workspaceMemberId: 'wm-2' }),
      workspaceView: 'team',
    });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    release();
    await Promise.all([first, second]);
  });
});

describe('createProject', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('preserves daemon validation messages from non-2xx create responses', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(
      JSON.stringify({
        error: {
          message: 'draft design systems cannot be used by projects',
        },
      }),
      { status: 400, headers: { 'content-type': 'application/json' } },
    ));
    vi.stubGlobal('fetch', fetchMock);

    await expect(createProject({
      name: 'Draft DS project',
      skillId: null,
      designSystemId: 'user:draft-system',
    })).rejects.toThrow('draft design systems cannot be used by projects');

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/projects',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  });
});

// recvq5ecTkar91: a team project that leaked into a personal workspace's 草稿
// grid was also really deletable from there, not just visible — because this
// call never told the daemon which workspace it was acting from.
// `enforceWorkspaceProjectMutation` (apps/daemon/src/routes/project/index.ts)
// treats a request with NEITHER `x-od-workspace-id` NOR
// `x-od-workspace-member-id` as a legacy caller outside the workspace system
// entirely and skips its ownership check — so every delete from a
// workspace-team build silently bypassed cross-workspace permission checking,
// wrong-workspace project or not. Attaching the same headers
// `moveWorkspaceProject` already sends is what lets the daemon's existing
// (correct) `getWorkspaceProject(ctx.workspaceId, projectId)` scoping fire.
describe('deleteProject', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('attaches workspace identity headers so the daemon can enforce ownership', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await deleteProject('leaked-team-project', personalWorkspaceContext());

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/projects/leaked-team-project',
      expect.objectContaining({
        method: 'DELETE',
        headers: expect.objectContaining({
          'x-od-workspace-id': 'ws-personal',
          'x-od-workspace-member-id': 'wm-1',
          'x-od-workspace-type': 'personal',
        }),
      }),
    );
  });

  it('omits workspace headers when there is no workspace context (legacy local mode)', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await deleteProject('local-only-project');

    const [, init] = fetchMock.mock.calls[0]!;
    expect(init).toEqual({ method: 'DELETE' });
  });

  it('reports failure when the daemon refuses the delete', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => new Response(null, { status: 403 })));

    await expect(deleteProject('someone-elses-project', personalWorkspaceContext())).resolves.toBe(false);
  });
});

// Same gap as deleteProject, found while auditing every client caller of a
// daemon route behind enforceWorkspaceProjectMutation: duplicate and
// design-system-copy sent no workspace headers either, so both bypassed the
// daemon's cross-workspace ownership check the exact same way.
describe('duplicateProject', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('attaches workspace identity headers so the daemon can enforce ownership', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      new Response(
        JSON.stringify({ project: { id: 'dup-1' }, conversationId: 'conv-1', copiedFiles: [] }),
        { status: 200 },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    await duplicateProject('leaked-team-project', {}, personalWorkspaceContext());

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/projects/leaked-team-project/duplicate',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'x-od-workspace-id': 'ws-personal',
          'x-od-workspace-member-id': 'wm-1',
        }),
      }),
    );
  });

  it('omits workspace headers when there is no workspace context (legacy local mode)', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      new Response(
        JSON.stringify({ project: { id: 'dup-1' }, conversationId: 'conv-1', copiedFiles: [] }),
        { status: 200 },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    await duplicateProject('local-only-project');

    const [, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(init.headers).toEqual({ 'Content-Type': 'application/json' });
  });
});

// Same enforceWorkspaceProjectMutation bypass as deleteProject/duplicateProject:
// a rename, metadata patch, or pendingPrompt clear sent no workspace headers,
// so a read-only team member could still push a PATCH through.
describe('patchProject', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('attaches workspace identity headers so the daemon can enforce ownership', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(
      JSON.stringify({ id: 'leaked-team-project', name: 'Renamed' }),
      { status: 200 },
    ));
    vi.stubGlobal('fetch', fetchMock);

    await patchProject('leaked-team-project', { name: 'Renamed' }, personalWorkspaceContext());

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/projects/leaked-team-project',
      expect.objectContaining({
        method: 'PATCH',
        headers: expect.objectContaining({
          'Content-Type': 'application/json',
          'x-od-workspace-id': 'ws-personal',
          'x-od-workspace-member-id': 'wm-1',
        }),
      }),
    );
  });

  it('omits workspace headers when there is no workspace context (legacy local mode)', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(
      JSON.stringify({ id: 'local-only-project', name: 'Renamed' }),
      { status: 200 },
    ));
    vi.stubGlobal('fetch', fetchMock);

    await patchProject('local-only-project', { name: 'Renamed' });

    const [, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(init.headers).toEqual({ 'Content-Type': 'application/json' });
  });

  it('reports failure when the daemon refuses the patch', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => new Response(null, { status: 403 })));

    await expect(
      patchProject('someone-elses-project', { name: 'Renamed' }, personalWorkspaceContext()),
    ).resolves.toBeNull();
  });
});

describe('createDesignSystemProjectFromProject', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('attaches workspace identity headers so the daemon can enforce ownership', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      new Response(
        JSON.stringify({
          project: { id: 'ds-1' },
          conversationId: 'conv-1',
          designSystemId: 'ds-sys-1',
          copiedFiles: [],
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    await createDesignSystemProjectFromProject('leaked-team-project', {}, personalWorkspaceContext());

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/projects/leaked-team-project/design-system-copy',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'x-od-workspace-id': 'ws-personal',
          'x-od-workspace-member-id': 'wm-1',
        }),
      }),
    );
  });
});

describe('listPlugins', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('hides plugins marked od.hidden from UI-facing lists', async () => {
    const visible = {
      id: 'od-new-generation',
      title: 'New generation',
      manifest: { od: { kind: 'scenario' } },
    };
    const hidden = {
      id: 'od-default',
      title: 'Default design router',
      manifest: { od: { kind: 'scenario', hidden: true } },
    };
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => new Response(
      JSON.stringify({ plugins: [hidden, visible] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )));

    const rows = await listPlugins();

    expect(rows.map((row) => row.id)).toEqual(['od-new-generation']);
  });

  it('can include hidden plugins for installed-entry matching', async () => {
    const visible = {
      id: 'od-new-generation',
      title: 'New generation',
      manifest: { od: { kind: 'scenario' } },
    };
    const hidden = {
      id: 'od-default',
      title: 'Default design router',
      manifest: { od: { kind: 'scenario', hidden: true } },
    };
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => new Response(
      JSON.stringify({ plugins: [hidden, visible] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )));

    const rows = await listPlugins({ includeHidden: true });

    expect(rows.map((row) => row.id)).toEqual(['od-default', 'od-new-generation']);
  });
});

describe('installGeneratedPluginFolder', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('installs a project-relative generated plugin folder', async () => {
    const dispatchEvent = vi.fn();
    vi.stubGlobal('window', { dispatchEvent });
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(
      JSON.stringify({
        ok: true,
        plugin: { id: 'generated-plugin', title: 'Generated Plugin' },
        warnings: [],
        message: 'Installed Generated Plugin.',
        log: [],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));
    vi.stubGlobal('fetch', fetchMock);

    const outcome = await installGeneratedPluginFolder('project-1', 'generated-plugin');

    expect(outcome.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/projects/project-1/plugins/install-folder',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ path: 'generated-plugin' }),
      }),
    );
    expect(dispatchEvent).toHaveBeenCalled();
  });

  it('preserves install diagnostics from non-2xx project folder responses', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(
      JSON.stringify({
        ok: false,
        warnings: ['Missing open-design.json'],
        message: 'Plugin validation failed.',
        log: ['Validating generated-plugin'],
      }),
      { status: 400, headers: { 'content-type': 'application/json' }, statusText: 'Bad Request' },
    ));
    vi.stubGlobal('fetch', fetchMock);

    const outcome = await installGeneratedPluginFolder('project-1', 'generated-plugin');

    expect(outcome).toMatchObject({
      ok: false,
      warnings: ['Missing open-design.json'],
      message: 'Plugin validation failed.',
      log: ['Validating generated-plugin'],
    });
  });
});

describe('importClaudeDesignZip', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('preserves daemon import errors from non-2xx responses', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(
      JSON.stringify({ error: 'Unable to unpack Claude export.' }),
      { status: 422, headers: { 'content-type': 'application/json' } },
    ));
    vi.stubGlobal('fetch', fetchMock);

    const file = new File(['zip-bytes'], 'claude-design.zip', {
      type: 'application/zip',
    });

    await expect(importClaudeDesignZip(file)).rejects.toThrow(
      'Unable to unpack Claude export.',
    );
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/import/claude-design',
      expect.objectContaining({
        method: 'POST',
        body: expect.any(FormData),
      }),
    );
  });
});

describe('generated plugin share actions', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('posts publish and contribute actions for project-relative plugin folders', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(
      JSON.stringify({
        ok: true,
        message: 'Ready',
        url: 'https://github.com/example/generated-plugin',
        log: ['ok'],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));
    vi.stubGlobal('fetch', fetchMock);

    const publish = await publishGeneratedPluginToGitHub('project-1', 'generated-plugin');
    const contribute = await contributeGeneratedPluginToOpenDesign('project-1', 'generated-plugin');

    expect(publish).toMatchObject({ ok: true, message: 'Ready' });
    expect(contribute).toMatchObject({ ok: true, message: 'Ready' });
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      '/api/projects/project-1/plugins/publish-github',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ path: 'generated-plugin' }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      '/api/projects/project-1/plugins/contribute-open-design',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ path: 'generated-plugin' }),
      }),
    );
  });
});

describe('createPluginShareProject', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('creates an agent-backed share project for an installed plugin', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(
      JSON.stringify({
        ok: true,
        project: {
          id: 'project-1',
          name: 'Publish to GitHub: Sample Plugin',
          skillId: null,
          designSystemId: null,
          createdAt: 1,
          updatedAt: 1,
          pendingPrompt: 'Publish it',
          metadata: { kind: 'prototype' },
        },
        conversationId: 'conversation-1',
        appliedPluginSnapshotId: 'snapshot-1',
        actionPluginId: 'od-plugin-publish-github',
        sourcePluginId: 'sample-plugin',
        stagedPath: 'plugin-source/sample-plugin',
        prompt: 'Publish it',
        message: 'Created a Publish to GitHub task.',
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));
    vi.stubGlobal('fetch', fetchMock);

    const outcome = await createPluginShareProject(
      'sample-plugin',
      'publish-github',
      'zh-CN',
    );

    expect(outcome).toMatchObject({
      ok: true,
      project: { id: 'project-1' },
      appliedPluginSnapshotId: 'snapshot-1',
      stagedPath: 'plugin-source/sample-plugin',
    });
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/plugins/sample-plugin/share-project',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ action: 'publish-github', locale: 'zh-CN' }),
      }),
    );
  });

  it('surfaces share project errors from the daemon', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(
      JSON.stringify({
        ok: false,
        code: 'share-action-plugin-missing',
        message: 'Restart the daemon.',
      }),
      { status: 409, headers: { 'content-type': 'application/json' } },
    ));
    vi.stubGlobal('fetch', fetchMock);

    const outcome = await createPluginShareProject(
      'sample-plugin',
      'contribute-open-design',
    );

    expect(outcome).toEqual({
      ok: false,
      code: 'share-action-plugin-missing',
      message: 'Restart the daemon.',
    });
  });
});

describe('importFolderProject', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns the project on success', async () => {
    const response = {
      project: { id: 'p-1', name: 'My Folder' },
      conversationId: 'conv-1',
      entryFile: 'index.html',
    };
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => new Response(
      JSON.stringify(response),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )));

    const result = await importFolderProject({ baseDir: '/home/user/project' });
    expect(result).toMatchObject({ project: { id: 'p-1' }, entryFile: 'index.html' });
  });

  it('throws with daemon error message for filesystem root', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => new Response(
      JSON.stringify({ error: { code: 'BAD_REQUEST', message: 'cannot import the filesystem root' } }),
      { status: 400, headers: { 'content-type': 'application/json' } },
    )));

    await expect(importFolderProject({ baseDir: '/' }))
      .rejects.toThrow('cannot import the filesystem root');
  });

  it('throws with daemon error message for non-existent folder', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => new Response(
      JSON.stringify({ error: { code: 'BAD_REQUEST', message: 'folder not found' } }),
      { status: 400, headers: { 'content-type': 'application/json' } },
    )));

    await expect(importFolderProject({ baseDir: '/abc/xyz/notexist' }))
      .rejects.toThrow('folder not found');
  });

  it('throws with daemon error message for file path', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => new Response(
      JSON.stringify({ error: { code: 'BAD_REQUEST', message: 'path must be a directory' } }),
      { status: 400, headers: { 'content-type': 'application/json' } },
    )));

    await expect(importFolderProject({ baseDir: '/etc/hosts' }))
      .rejects.toThrow('path must be a directory');
  });

  it('throws a fallback message when response body has no error detail', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => new Response(
      'Internal Server Error',
      { status: 500 },
    )));

    await expect(importFolderProject({ baseDir: '/some/path' }))
      .rejects.toThrow('Failed to import folder');
  });
});

describe('pickLocalFolderPath', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns the selected native folder path', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(
      JSON.stringify({ path: '/Users/me/Site' }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));
    vi.stubGlobal('fetch', fetchMock);

    await expect(pickLocalFolderPath()).resolves.toBe('/Users/me/Site');
    expect(fetchMock).toHaveBeenCalledWith('/api/dialog/open-folder', {
      method: 'POST',
    });
  });

  it('returns null when the native picker is cancelled', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => new Response(
      JSON.stringify({ path: null }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )));

    await expect(pickLocalFolderPath()).resolves.toBeNull();
  });

  it('throws with the daemon picker error message', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => new Response(
      JSON.stringify({ error: 'cross-origin request rejected' }),
      { status: 403, headers: { 'content-type': 'application/json' } },
    )));

    await expect(pickLocalFolderPath()).rejects.toThrow('cross-origin request rejected');
  });
});
