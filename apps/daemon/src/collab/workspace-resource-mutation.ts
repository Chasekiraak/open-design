// Workspace-resource mutation gate, shared by every resource type that binds
// into the generic `workspace_resources` table (see `db.ts`): project,
// plugin, and (later) skill / design system.
//
// This module is an EXTRACTION, not a new design. It used to live entirely
// inside `apps/daemon/src/routes/project/index.ts` as
// `enforceWorkspaceProjectMutation` / `projectAccess`, hard-coded to
// "project". Project's own logic has been fixed three times this week alone
// from dogfood feedback — a mistake here is easy to make and expensive to
// repeat, so every other resource type should call THIS module rather than
// forking its own copy. Project's route file still owns the project-specific
// affordances (canMoveToTeam / canMoveToPersonal / canOpen / canExport /
// canSendTo) that only make sense for a project; this module owns the part
// that generalizes cleanly: reading the caller's workspace identity off
// headers, and deciding whether a caller may mutate a bound resource row.
import type { Response } from 'express';

export type WorkspaceResourceContext = {
  workspaceId: string;
  workspaceType: 'personal' | 'team';
  /**
   * The caller's RAW `x-od-workspace-type` claim, before it is collapsed into
   * `workspaceType` above. `workspaceType` defaults an absent header to
   * 'personal', which is the right default for view filtering but must never
   * be read as the caller ASSERTING "personal" — only an explicit header is
   * evidence. Null means the caller made no claim.
   */
  workspaceTypeAsserted: 'personal' | 'team' | null;
  appUserId: string;
  workspaceMemberId: string;
  role: 'owner' | 'admin' | 'member';
  memberStatus: 'active' | 'removed';
  lifecycleState: 'active' | 'billing_past_due' | 'locked' | 'deleting' | 'deleted';
  canShareProjects: boolean;
  canWriteSyncedFiles: boolean;
};

export type WorkspaceResourceMutationCapability = 'rename' | 'delete' | 'duplicate' | 'writeFiles';

export type WorkspaceResourceAccessInput = {
  visibility?: string | null;
  resourceState?: string | null;
  createdByWorkspaceMemberId?: string | null;
};

export function headerValue(req: any, name: string): string | null {
  const value = req.get(name);
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function headerBool(req: any, name: string, fallback: boolean): boolean {
  const value = headerValue(req, name);
  if (value === null) return fallback;
  if (value === 'false') return false;
  if (value === 'true') return true;
  return fallback;
}

// Temporary adapter until the B-owned CurrentWorkspaceContext is wired into
// the daemon. Keep resource CRUD behind this seam so the header fallback can
// be replaced without changing visibility and permission logic.
export function workspaceResourceContext(req: any, workspaceId: string): WorkspaceResourceContext | null {
  const workspaceMemberId = headerValue(req, 'x-od-workspace-member-id');
  if (!workspaceMemberId) return null;
  const workspaceTypeHeader = headerValue(req, 'x-od-workspace-type');
  const lifecycleState = headerValue(req, 'x-od-workspace-lifecycle-state') ?? 'active';
  const role = headerValue(req, 'x-od-workspace-role') ?? 'member';
  const legacyWriteEnabled = headerBool(req, 'x-od-workspace-write-enabled', true);
  const canWriteSyncedFiles = headerBool(req, 'x-od-workspace-can-write-synced-files', legacyWriteEnabled);
  return {
    workspaceId,
    workspaceType: workspaceTypeHeader === 'team' ? 'team' : 'personal',
    workspaceTypeAsserted:
      workspaceTypeHeader === 'team' || workspaceTypeHeader === 'personal' ? workspaceTypeHeader : null,
    appUserId: headerValue(req, 'x-od-app-user-id') ?? 'local-user',
    workspaceMemberId,
    role: role === 'owner' || role === 'admin' ? role : 'member',
    memberStatus: headerValue(req, 'x-od-workspace-member-status') === 'removed' ? 'removed' : 'active',
    lifecycleState: lifecycleState === 'billing_past_due' || lifecycleState === 'locked' || lifecycleState === 'deleting' || lifecycleState === 'deleted'
      ? lifecycleState
      : 'active',
    canShareProjects: headerBool(req, 'x-od-workspace-can-share-projects', canWriteSyncedFiles),
    canWriteSyncedFiles,
  };
}

export function workspaceResourceContextFromRequest(req: any): WorkspaceResourceContext | 'missing' | null {
  const workspaceId = headerValue(req, 'x-od-workspace-id');
  const workspaceMemberId = headerValue(req, 'x-od-workspace-member-id');
  if (!workspaceId && !workspaceMemberId) return null;
  if (!workspaceId || !workspaceMemberId) return 'missing';
  return workspaceResourceContext(req, workspaceId) ?? 'missing';
}

export function isWorkspaceResourceLocked(ctx: WorkspaceResourceContext): boolean {
  return ctx.lifecycleState === 'locked' || ctx.lifecycleState === 'deleted';
}

/**
 * The core frozen/privilege/mutate computation shared by every resource
 * type. Deliberately narrower than project's own `projectAccess` in
 * `routes/project/index.ts` — it does not compute
 * canMoveToTeam/canMoveToPersonal/canOpen/canExport/canSendTo, which are
 * project-specific UX affordances project's own wrapper still builds on top
 * of this. What it DOES compute is the part every resource type needs
 * identically, and the part a correctness fix tends to land in.
 */
export function workspaceResourceAccess(
  wp: WorkspaceResourceAccessInput,
  ctx: WorkspaceResourceContext,
): {
  frozen: boolean;
  selfCreated: boolean;
  privileged: boolean;
  canMutate: boolean;
  unattributed: boolean;
  canShareLocal: boolean;
  disabledReason?: 'workspace_deleted' | 'workspace_locked' | 'permission_denied';
} {
  const frozen = wp.resourceState === 'frozen' || wp.resourceState === 'deleted' || isWorkspaceResourceLocked(ctx);
  const selfCreated = wp.createdByWorkspaceMemberId != null && wp.createdByWorkspaceMemberId === ctx.workspaceMemberId;
  const privileged = ctx.role === 'owner' || ctx.role === 'admin';
  const canMutate = !frozen && ctx.canWriteSyncedFiles && ctx.memberStatus === 'active' && (privileged || selfCreated);
  // Sharing is the one mutation that must ALSO work on an unattributed row:
  // lazy projection never assigns ownership to the reader (adoption red
  // line), yet a local resource physically exists only on this user's disk —
  // sharing it stamps the sharer as owner. Without this, a plain member's own
  // local resources could never be shared. Destructive actions
  // (delete/rename/unshare) stay on the strict `canMutate`.
  const unattributed = wp.createdByWorkspaceMemberId == null;
  const canShareLocal =
    !frozen && ctx.canWriteSyncedFiles && ctx.memberStatus === 'active' &&
    (privileged || selfCreated || unattributed);
  const disabledReason: 'workspace_deleted' | 'workspace_locked' | 'permission_denied' | undefined = frozen
    ? ctx.lifecycleState === 'deleted' || wp.resourceState === 'deleted'
      ? 'workspace_deleted'
      : 'workspace_locked'
    : canMutate
      ? undefined
      : 'permission_denied';
  return {
    frozen,
    selfCreated,
    privileged,
    canMutate,
    unattributed,
    canShareLocal,
    ...(disabledReason ? { disabledReason } : {}),
  };
}

function workspaceResourceMutationAllowed(
  row: WorkspaceResourceAccessInput | null | undefined,
  ctx: WorkspaceResourceContext,
  _capability: WorkspaceResourceMutationCapability,
): boolean {
  if (!row) return false;
  // Every mutation capability collapses to the same `canMutate` bit today —
  // project's original per-capability branch (`canRename`/`canDelete`/
  // `canDuplicate`/`canRestoreVersion`) all read the identical computed
  // value. `capability` stays a parameter so a future resource type that DOES
  // need one capability to diverge (e.g. staying allowed while frozen) has a
  // seam to hang that on without another signature change at every call site.
  return workspaceResourceAccess(row, ctx).canMutate;
}

/**
 * Gate a mutation route for any resource bound into `workspace_resources`.
 *
 * `resourceType` ('project' | 'plugin' | 'skill' | 'design_system') feeds
 * both the lookup callbacks' semantics and the permission-denied error code
 * (`WORKSPACE_<RESOURCE_TYPE>_PERMISSION_DENIED`) — for `resourceType:
 * 'project'` that reproduces the exact `WORKSPACE_PROJECT_PERMISSION_DENIED`
 * code the project route already shipped and has tests pinned against.
 *
 * `getWorkspaceResource`/`getWorkspaceResourceByResourceId` are caller-bound
 * closures over the specific resource's storage (e.g. `workspace_projects` or
 * `workspace_resources` filtered to `resource_type = 'plugin'`) so this
 * module never has to know which table backs which resource type.
 */
export function enforceWorkspaceResourceMutation(
  resourceType: string,
  req: any,
  res: Response,
  sendApiError: (res: Response, status: number, code: string, message: string) => unknown,
  getWorkspaceResource: (db: unknown, workspaceId: string, resourceId: string) => WorkspaceResourceAccessInput | null | undefined,
  getWorkspaceResourceByResourceId: (db: unknown, resourceId: string) => WorkspaceResourceAccessInput | null | undefined,
  db: unknown,
  resourceId: string,
  capability: WorkspaceResourceMutationCapability,
): boolean {
  const ctx = workspaceResourceContextFromRequest(req);
  if (ctx === null) {
    // No workspace headers at all — a legacy pre-workspace caller, or a
    // client that just logged out (the frontend only attaches these headers
    // while `workspaceContext` is non-null). Either way there is no identity
    // to check against a team. That's fine for a resource this daemon has
    // never bound to a workspace, or one bound as `personal` — but a resource
    // bound `team` requires proof of membership the request doesn't carry;
    // treat it the same as `'missing'` rather than granting the mutation.
    const row = getWorkspaceResourceByResourceId(db, resourceId);
    if (row && row.visibility === 'team') {
      sendApiError(res, 401, 'WORKSPACE_CONTEXT_REQUIRED', 'workspace context is required');
      return false;
    }
    return true;
  }
  if (ctx === 'missing') {
    sendApiError(res, 401, 'WORKSPACE_CONTEXT_REQUIRED', 'workspace context is required');
    return false;
  }
  const row = getWorkspaceResource(db, ctx.workspaceId, resourceId);
  if (!workspaceResourceMutationAllowed(row, ctx, capability)) {
    const code = row && isWorkspaceResourceLocked(ctx)
      ? 'WORKSPACE_LOCKED'
      : `WORKSPACE_${resourceType.toUpperCase()}_PERMISSION_DENIED`;
    sendApiError(res, 403, code, `workspace ${resourceType} mutation is not allowed`);
    return false;
  }
  return true;
}
