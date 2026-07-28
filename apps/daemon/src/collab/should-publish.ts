// The `shouldPublish` predicate `collab-publish-watcher.ts` consults before
// attaching a file watcher to a project (see that file's read-only-gate
// invariant: watched only when team-shared AND this daemon's member is its
// owner). Extracted to its own module so the memberStatus invariant below is
// independently unit-testable without spinning up the whole server.

import {
  contextToResourceHubPrincipal,
  type ResourceHubPrincipal,
} from './resource-principal.js';
import type { WorkspaceContextProvider } from './workspace-context.js';

export interface CreateShouldPublishOptions {
  /** Server-authoritative owner lookup (the team hub catalog, never a client-supplied id). */
  resolveSharedProjectOwner: (projectId: string) => Promise<string | null>;
  /** The one login-backed workspace context every collab surface derives identity from. */
  workspaceContext: WorkspaceContextProvider;
  /** Remember the resolved principal so the scheduler/adapter scope the publish under it. */
  rememberTeamShare: (projectId: string, principal: ResourceHubPrincipal) => void;
  /**
   * Whether the local record for `projectId` is still an unmaterialized
   * shared-project placeholder (`isUnmaterializedSharedPlaceholder` over the
   * local project row — see collab/shared-project-placeholder.ts). Required,
   * not optional: forgetting to wire it is exactly the fresh-install wipe of
   * recvqzaDvUU6B3, where an empty placeholder on a wiped data root passed
   * the owner check and was published over the team's real content.
   */
  hasUnmaterializedPlaceholder: (projectId: string) => boolean;
}

/**
 * Whether THIS daemon should attach a file watcher to `projectId` and publish
 * its local edits: the project is team-shared, this daemon's member is its
 * OWNER (the single writer), AND that membership is currently ACTIVE.
 *
 * The active-membership check is not redundant with
 * `contextToResourceHubPrincipal` / `workspaceContextHasTeamIdentity`: that
 * predicate only proves the context can ADDRESS the resource hub at all
 * (`workspaceType`/`workspaceId`/`workspaceMemberId` all resolve), which
 * stays true for a member B has already removed from the team — only
 * `memberStatus` flips to `'removed'`. Without the explicit check below, a
 * member removed from the team while their daemon keeps running would still
 * pass the owner check on every project they used to share, and a reconcile
 * after a restart (or a brand-new local project) would attach a watcher B no
 * longer authorizes.
 *
 * This only gates whether a NEW watch is attached — `collab-publish-
 * watcher.ts`'s `reconcile` never re-checks `shouldPublish` for a project it
 * is already watching (see that file's doc comment). The already-attached
 * case is instead closed at the transport layer: `createVelaCliResource
 * Adapter`'s `contextHasTeamIdentity` re-derives this same live workspace
 * context on every publish/pull/syncLatest/unpublish attempt, so a watcher
 * that predates a removal still stops reaching `vela resource push` on its
 * very next attempt. Both checks must hold the same rule for a removed
 * member's daemon to be unable to either start or continue publishing their
 * former team's project.
 */
export function createShouldPublish(
  options: CreateShouldPublishOptions,
): (projectId: string) => Promise<boolean> {
  return async (projectId: string): Promise<boolean> => {
    // Fresh-install wipe guard (recvqzaDvUU6B3): a local record that is still
    // an unmaterialized shared-project placeholder is not content authority —
    // it must never be watched or publish, no matter what the owner check
    // says. Checked before the hub round-trips so a placeholder never even
    // reaches the catalog.
    if (options.hasUnmaterializedPlaceholder(projectId)) return false;
    const owner = await options.resolveSharedProjectOwner(projectId);
    if (!owner) return false;
    const ctx = await options.workspaceContext.current({});
    if (ctx?.memberStatus !== 'active') return false;
    const principal = contextToResourceHubPrincipal(ctx);
    if (!principal || owner !== principal.memberId) return false;
    options.rememberTeamShare(projectId, principal);
    return true;
  };
}
