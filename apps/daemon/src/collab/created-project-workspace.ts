import {
  isWorkspaceResourceLocked,
  workspaceResourceContextFromRequest,
  type WorkspaceResourceContext,
} from './workspace-resource-mutation.js';

export type CreatedProjectWorkspaceResolution =
  | { ok: true; context: WorkspaceResourceContext | null }
  | {
      ok: false;
      status: 400 | 403;
      code: 'WORKSPACE_CONTEXT_INCOMPLETE' | 'WORKSPACE_PROJECT_PERMISSION_DENIED';
      message: string;
    };

/**
 * Resolve the workspace authority for a route that creates a project.
 *
 * A completely headerless request is a legal legacy/anonymous caller and
 * intentionally leaves the new project unbound. Once either workspace
 * identity header is present, however, the request is a workspace-aware
 * caller: partial, removed, locked, or non-writing identities must fail
 * closed instead of silently creating an unbound orphan.
 */
export function resolveCreatedProjectWorkspace(
  req: unknown,
): CreatedProjectWorkspaceResolution {
  const context = workspaceResourceContextFromRequest(req);
  if (context === null) return { ok: true, context: null };
  if (context === 'missing') {
    return {
      ok: false,
      status: 400,
      code: 'WORKSPACE_CONTEXT_INCOMPLETE',
      message: 'workspace project creation requires both workspace and member identity',
    };
  }
  if (
    context.memberStatus !== 'active'
    || !context.canWriteSyncedFiles
    || isWorkspaceResourceLocked(context)
  ) {
    return {
      ok: false,
      status: 403,
      code: 'WORKSPACE_PROJECT_PERMISSION_DENIED',
      message: 'workspace project creation is not allowed',
    };
  }
  return { ok: true, context };
}

export function bindCreatedProjectToWorkspace(
  ensureWorkspaceProject: (input: {
    projectId: string;
    workspaceId: string;
    visibility: 'personal';
    resourceState: 'active';
    createdByWorkspaceMemberId: string;
    updatedByWorkspaceMemberId: string;
    syncState: 'local_only';
    resourceHubResourceId: null;
    cloudTombstonedAt: null;
    createdAt: number;
    updatedAt: number;
  }) => unknown,
  context: WorkspaceResourceContext | null,
  projectId: string,
  now: number,
): void {
  if (!context) return;
  ensureWorkspaceProject({
    projectId,
    workspaceId: context.workspaceId,
    visibility: 'personal',
    resourceState: 'active',
    createdByWorkspaceMemberId: context.workspaceMemberId,
    updatedByWorkspaceMemberId: context.workspaceMemberId,
    syncState: 'local_only',
    resourceHubResourceId: null,
    cloudTombstonedAt: null,
    createdAt: now,
    updatedAt: now,
  });
}
