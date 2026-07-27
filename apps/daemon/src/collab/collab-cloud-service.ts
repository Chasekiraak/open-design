// Collab-cloud orchestration (C-lane §D2.5 / §D4): ties the collab-cloud client
// to the one workspace context so a single signed-in identity drives member
// registration, comment push, and the pull+merge poller. Kept OUT of
// collab/runtime.ts (which #5383 is also editing) so the surfaces do not collide.
//
// Everything degrades to a no-op off-team: when the workspace context has no
// team identity, registration/push/poll all short-circuit. The client itself is
// only constructed when OD_COLLAB_CLOUD_URL is set (see createCollabCloudClientFromEnv),
// so an unconfigured daemon never even reaches here.

import type {
  CollabCloudComment,
  CollabCloudMemberDirectoryEntry,
  PreviewComment,
} from '@open-design/contracts';
import type { CollabCloudClient } from '../integrations/collab-cloud.js';
import type { WorkspaceContextProvider } from './workspace-context.js';

/** The daemon-local seams the service needs; injected so this file stays free of
 *  SQLite and the poller is unit-testable with fakes. */
export interface CollabCloudServiceDeps {
  client: CollabCloudClient;
  /** The one workspace context — team identity gate + memberId/teamId/role source. */
  workspaceContext: WorkspaceContextProvider;
  /** Local project ids to poll for inbound comments. */
  listProjectIds: () => string[];
  /**
   * Resolve a LOCAL conversation id to re-home synced comments onto (conversation
   * ids do not cross daemons, and preview_comments has a conversation FK). Null
   * when the project has no local conversation yet — the poller then skips it.
   */
  resolveLocalConversationId: (projectId: string) => string | null;
  /**
   * Merge one pulled comment into local storage, idempotently by comment id.
   * Returns true when a new row was inserted (false when it already existed).
   */
  mergeComment: (input: {
    projectId: string;
    conversationId: string;
    comment: CollabCloudComment;
  }) => boolean;
  /** Poll cadence; defaults to the spec's foreground 5s (§D4.5). */
  pollIntervalMs?: number;
  onError?: (error: unknown) => void;
  onMerged?: (input: { projectId: string; inserted: number }) => void;
}

const DEFAULT_POLL_INTERVAL_MS = 5_000;

/**
 * Map a locally-stored preview comment to the cloud sync unit. Carries the full
 * anchoring payload + drift-ladder fields so the comment keeps pointing at the
 * same element on the receiver. `memberId` is the AUTHOR (who wrote it), taken
 * from the comment's authorMemberId, falling back to the sharing member.
 */
export function previewCommentToCloud(
  comment: PreviewComment,
  fallbackMemberId: string,
): CollabCloudComment {
  const cloud: CollabCloudComment = {
    id: comment.id,
    projectId: comment.projectId,
    conversationId: comment.conversationId,
    memberId: comment.authorMemberId ?? fallbackMemberId,
    seq: 0,
    note: comment.note,
    filePath: comment.filePath,
    elementId: comment.elementId,
    selector: comment.selector,
    label: comment.label,
    text: comment.text,
    htmlHint: comment.htmlHint,
    position: comment.position,
    status: comment.status,
    createdAt: comment.createdAt,
    updatedAt: comment.updatedAt,
  };
  // Copy optional fields only when present (exactOptionalPropertyTypes-safe).
  if (comment.style !== undefined) cloud.style = comment.style;
  if (comment.selectionKind !== undefined) cloud.selectionKind = comment.selectionKind;
  if (comment.memberCount !== undefined) cloud.memberCount = comment.memberCount;
  if (comment.podMembers !== undefined) cloud.podMembers = comment.podMembers;
  if (comment.slideIndex !== undefined) cloud.slideIndex = comment.slideIndex;
  if (comment.attachments !== undefined) cloud.attachments = comment.attachments;
  if (comment.anchorState !== undefined) cloud.anchorState = comment.anchorState;
  if (comment.anchoredVersion !== undefined) cloud.anchoredVersion = comment.anchoredVersion;
  if (comment.lastGoodPosition !== undefined) cloud.lastGoodPosition = comment.lastGoodPosition;
  return cloud;
}

export interface CollabCloudService {
  /** PUT the current member's directory entry (best-effort; no-op off-team). */
  registerSelf(): Promise<void>;
  /**
   * Push a created OR edited comment to the cloud (best-effort; no-op off-team).
   * The relay upserts by id and receivers apply the newest by `updatedAt`, so the
   * same call carries both the initial create and any later edit/status change.
   *
   * Resolves with the cloud-assigned `seq` for THIS push (or `null` off-team /
   * on failure) so the caller can reconcile a new comment's provisional
   * `pin_seq` — see `confirmPreviewCommentPinSeq` in db.ts and the
   * recvq5BVsolIxi design note above `previewCommentToCloud`. The value is
   * safe to feed into that reconciliation from EITHER a create or an edit
   * push: the guard there only ever applies once per comment, so whichever
   * push resolves first (in practice almost always the create) wins and a
   * later resolution is a no-op.
   */
  pushComment(comment: PreviewComment): Promise<{ seq: number } | null>;
  /**
   * Push a delete as a tombstone (best-effort; no-op off-team). Receivers remove
   * the comment by id. Stamps a fresh `updatedAt` so the tombstone is not treated
   * as a stale edit if it races an in-flight update.
   */
  pushCommentDeletion(comment: PreviewComment): Promise<void>;
  /** The team's member directory (empty off-team / on error). */
  listMembers(): Promise<CollabCloudMemberDirectoryEntry[]>;
  /** Resolve one member id to its directory entry, or null. */
  resolveMember(memberId: string): Promise<CollabCloudMemberDirectoryEntry | null>;
  /** Run one poll cycle (register + pull + merge across all local projects). */
  pollOnce(): Promise<void>;
  /**
   * Pull + merge ONE project's comments now, regardless of whether it has a
   * live events subscriber. This is the hub push-channel consumer: a
   * `comment-changed` dirty mark must be redeemable even when the project is
   * not in `listProjectIds()` (the poll loop's open-projects scope) — the
   * poll loop otherwise never covers it and the mark would be consumed for
   * nothing. Errors land on `onError`; never throws.
   *
   * Resolves `true` only when a pull actually ran against the relay for this
   * project (a legitimately-empty/not-modified result still counts). Resolves
   * `false` when it no-oped (no team identity yet, no local conversation to
   * merge into) or the pull failed — the caller must then treat its consumed
   * dirty mark as UNREDEEMED and restore it, otherwise a transient miss
   * silently loses the one signal a single comment ever gets.
   */
  pullProject(projectId: string): Promise<boolean>;
  /** Start the background poller. */
  start(): void;
  /** Stop the poller. */
  dispose(): void;
}

export function createCollabCloudService(deps: CollabCloudServiceDeps): CollabCloudService {
  const pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  // Per-project pull cursor + last ETag, so each poll only fetches new comments
  // and a 304 costs nothing.
  const cursors = new Map<string, number>();
  const etags = new Map<string, string | null>();
  let timer: NodeJS.Timeout | null = null;
  let running = false;
  // The identity we last pushed to the member directory. Re-registering only
  // when this changes keeps `pollOnce` from spawning a `vela member register`
  // process on every 5s tick (see pollOnce).
  let lastRegisteredKey: string | null = null;

  async function teamIdentity(): Promise<{
    teamId: string;
    memberId: string;
    role: 'owner' | 'admin' | 'member';
    displayName: string;
  } | null> {
    const context = await deps.workspaceContext.current({});
    // B's resources/collab plane is team-only: a personal-workspace principal
    // is rejected with 403 `missing_principal` BY DESIGN (resources/auth.ts on
    // B refuses non-team contexts). Only a team context — which carries
    // `teamId` — yields a collab identity; a personal workspace keeps the
    // whole collab-cloud surface dormant instead of hammering B with doomed
    // CLI calls on every poll tick.
    if (!context?.teamId) return null;
    return {
      teamId: context.teamId,
      memberId: context.workspaceMemberId,
      role: context.role,
      displayName: context.displayName?.trim() || context.workspaceMemberId,
    };
  }

  async function registerSelf(): Promise<void> {
    const identity = await teamIdentity();
    if (!identity) return;
    await deps.client.registerMember(identity.teamId, identity.memberId, {
      displayName: identity.displayName,
      role: identity.role,
    });
  }

  async function pushComment(comment: PreviewComment): Promise<{ seq: number } | null> {
    const identity = await teamIdentity();
    if (!identity) return null;
    const cloud = previewCommentToCloud(comment, identity.memberId);
    const result = await deps.client.pushComment(identity.teamId, comment.projectId, cloud);
    return result ?? null;
  }

  async function pushCommentDeletion(comment: PreviewComment): Promise<void> {
    const identity = await teamIdentity();
    if (!identity) return;
    const cloud = previewCommentToCloud(comment, identity.memberId);
    cloud.deleted = true;
    // The tombstone's own event time — newer than the comment's last content
    // edit so it can't be mistaken for a stale record on the relay/receiver.
    cloud.updatedAt = Date.now();
    await deps.client.pushComment(identity.teamId, comment.projectId, cloud);
  }

  async function listMembers(): Promise<CollabCloudMemberDirectoryEntry[]> {
    const identity = await teamIdentity();
    if (!identity) return [];
    try {
      return await deps.client.listMembers(identity.teamId);
    } catch (error) {
      deps.onError?.(error);
      return [];
    }
  }

  async function resolveMember(
    memberId: string,
  ): Promise<CollabCloudMemberDirectoryEntry | null> {
    const members = await listMembers();
    return members.find((m) => m.memberId === memberId) ?? null;
  }

  /** Resolves `true` when a pull ran (even if it returned nothing new),
   *  `false` when there was no local conversation to merge into. */
  async function pollProject(
    teamId: string,
    projectId: string,
  ): Promise<boolean> {
    const conversationId = deps.resolveLocalConversationId(projectId);
    // No local conversation to attach to yet (e.g. a member who pulled the
    // project but has not opened a chat) — nothing to merge into.
    if (!conversationId) return false;
    const sinceSeq = cursors.get(projectId) ?? 0;
    const result = await deps.client.pullComments(
      teamId,
      projectId,
      sinceSeq,
      etags.get(projectId),
    );
    etags.set(projectId, result.etag);
    if (result.notModified) return true;
    let inserted = 0;
    for (const comment of result.comments) {
      if (deps.mergeComment({ projectId, conversationId, comment })) inserted += 1;
    }
    cursors.set(projectId, result.latestSeq);
    if (inserted > 0) deps.onMerged?.({ projectId, inserted });
    return true;
  }

  async function pullProject(projectId: string): Promise<boolean> {
    const identity = await teamIdentity();
    if (!identity) return false;
    try {
      return await pollProject(identity.teamId, projectId);
    } catch (error) {
      deps.onError?.(error);
      return false;
    }
  }

  async function pollOnce(): Promise<void> {
    const identity = await teamIdentity();
    if (!identity) return;
    // Refresh our own directory entry only when the identity actually changes
    // (first time it resolves, or a rename/role change via PUT
    // /api/workspace/context after startup) rather than every 5s cycle — a
    // per-cycle re-register spawned a `vela member register` process on every
    // tick and scaled badly. Best-effort — a directory hiccup must not block
    // comment pull, and a failure leaves `lastRegisteredKey` unset so the next
    // cycle retries.
    const identityKey = `${identity.teamId}:${identity.memberId}:${identity.role}:${identity.displayName}`;
    if (identityKey !== lastRegisteredKey) {
      try {
        await deps.client.registerMember(identity.teamId, identity.memberId, {
          displayName: identity.displayName,
          role: identity.role,
        });
        lastRegisteredKey = identityKey;
      } catch (error) {
        deps.onError?.(error);
      }
    }
    for (const projectId of deps.listProjectIds()) {
      try {
        await pollProject(identity.teamId, projectId);
      } catch (error) {
        deps.onError?.(error);
      }
    }
  }

  function tick(): void {
    if (running) return;
    running = true;
    void pollOnce()
      .catch((error) => deps.onError?.(error))
      .finally(() => {
        running = false;
      });
  }

  return {
    registerSelf,
    pushComment,
    pushCommentDeletion,
    listMembers,
    resolveMember,
    pollOnce,
    pullProject,
    start() {
      if (timer) return;
      timer = setInterval(tick, pollIntervalMs);
      // Do not keep the event loop alive solely for polling.
      timer.unref?.();
    },
    dispose() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}
