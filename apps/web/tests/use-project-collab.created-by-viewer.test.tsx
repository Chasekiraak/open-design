// @vitest-environment jsdom
//
// recvpZzWYQrhZQ: a freshly created project flashed the "共享项目不能编辑"
// read-only banner for ~3s before flipping to editable. Issue #99's
// `knownOwnedByViewer` fix (see use-project-collab.context-seed.test.tsx) only
// relaxes the single-writer gate once the hub catalog already lists the
// project. A project the viewer just created is never in that catalog yet —
// it was only just created, not shared — so `knownUnshared` stayed false and
// the project-level gate kept failing closed until the catalog and/or
// `/collab/status` happened to answer. `markProjectCreatedByViewer` gives the
// hook a same-session signal it can trust immediately, independent of either
// network read.

import { cleanup, renderHook, waitFor } from '@testing-library/react';
import {
  buildWorkspacePermissions,
  buildWorkspaceSeatSummary,
  type WorkspaceCollabContext,
} from '@open-design/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  markProjectCreatedByViewer,
  resetProjectsCreatedByViewerCache,
  useProjectCollab,
} from '../src/collab/useProjectCollab';
import {
  lastResolvedTeamProjects,
  resetTeamProjectsCache,
  resetWorkspaceContextCache,
  useWorkspaceContext,
} from '../src/collab/useWorkspaceContext';

function teamContext(): WorkspaceCollabContext {
  const role = 'member' as const;
  const lifecycleState = 'active' as const;
  return {
    workspaceId: 'ws-1',
    workspaceType: 'team',
    workspaceMemberId: 'wm-1',
    role,
    memberStatus: 'active',
    lifecycleState,
    billingState: 'active',
    planId: null,
    providerMode: 'platform_credits',
    seatSummary: buildWorkspaceSeatSummary({ seatLimit: 5, usedSeats: 1 }),
    permissions: buildWorkspacePermissions({ role, lifecycleState }),
    displayName: 'Ma Shu',
  };
}

/** Resolves the workspace context only; the team catalog and collab status
 *  both hang forever — modeling the residual window where a brand-new
 *  project's own project view mounts before the (separate, shell-owned)
 *  catalog request has come back. */
function installContextOnlyResolvingFetch() {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const pathname = new URL(String(input), 'http://d.local').pathname;
    if (pathname.endsWith('/workspace/context')) {
      return { ok: true, status: 200, json: async () => ({ context: teamContext() }) } as unknown as Response;
    }
    return new Promise<Response>(() => {
      /* team catalog + collab status never resolve */
    });
  }) as typeof fetch;
}

/** Seeds the module-level workspace-context cache without ever warming the
 *  team-catalog cache, so `lastResolvedTeamProjects()` stays null. */
async function warmContextOnly() {
  installContextOnlyResolvingFetch();
  const ctx = renderHook(() => useWorkspaceContext());
  await waitFor(() => expect(ctx.result.current.loading).toBe(false));
  ctx.unmount();
}

function installFullyHangingFetch() {
  globalThis.fetch = vi.fn(async () => new Promise<Response>(() => {})) as typeof fetch;
}

const originalFetch = globalThis.fetch;

beforeEach(() => {
  resetWorkspaceContextCache();
  resetTeamProjectsCache();
  resetProjectsCreatedByViewerCache();
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  resetWorkspaceContextCache();
  resetTeamProjectsCache();
  resetProjectsCreatedByViewerCache();
  vi.restoreAllMocks();
});

describe('useProjectCollab: project created by the viewer this session', () => {
  it('still fails closed for an unmarked project while the team catalog has not loaded yet', async () => {
    // Sanity check the scenario: the catalog genuinely never warmed.
    await warmContextOnly();
    expect(lastResolvedTeamProjects()).toBeNull();

    installFullyHangingFetch();
    const project = renderHook(() => useProjectCollab('p-unmarked'));

    expect(project.result.current.viewerOnly).toBe(true);
  });

  it('does not fail closed for a project the viewer created this session, even before the team catalog loads', async () => {
    await warmContextOnly();
    expect(lastResolvedTeamProjects()).toBeNull();

    installFullyHangingFetch();
    markProjectCreatedByViewer('p-new');
    const project = renderHook(() => useProjectCollab('p-new'));

    await waitFor(() => {
      expect(project.result.current.viewerOnly).toBe(false);
    });
  });

  it('scopes the signal to the exact project id — an unrelated project still fails closed', async () => {
    await warmContextOnly();

    installFullyHangingFetch();
    markProjectCreatedByViewer('p-new');
    const project = renderHook(() => useProjectCollab('p-someone-elses'));

    expect(project.result.current.viewerOnly).toBe(true);
  });

  it('clears between tests via the reset seam', async () => {
    markProjectCreatedByViewer('p-leftover');
    resetProjectsCreatedByViewerCache();

    await warmContextOnly();
    installFullyHangingFetch();
    const project = renderHook(() => useProjectCollab('p-leftover'));

    expect(project.result.current.viewerOnly).toBe(true);
  });
});
