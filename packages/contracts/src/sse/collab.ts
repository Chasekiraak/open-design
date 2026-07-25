// Collab realtime — hop-2 (daemon → web) thin invalidation events.
//
// These are SIGNALS, not payloads. An event says only "something of type X
// changed" (plus the scoping id when relevant); the web reacts by RE-FETCHING
// the affected resource through its existing loaders. Never widen these into
// fat payloads — the whole point of the thin model is that a missed event during
// a disconnect is harmless (the reconnect snapshot re-fetch closes the gap), so
// no server-side event buffer / Last-Event-ID replay is required for
// correctness.
//
// Two multiplexed sinks carry these:
//   - Project-scoped events ride the EXISTING `/api/projects/:id/events` SSE
//     alongside `file-changed` / `live_artifact*` / `conversation-created`.
//   - Workspace-scoped events ride the `/api/workspace/events` SSE.
//
// Producer: `apps/daemon` (see `emitProjectEvent` / `emitWorkspaceEvent` in
// `apps/daemon/src/server.ts`). Consumer: `apps/web` (the collab hooks +
// `useEventStream`). One shared type here keeps producer and consumer from
// drifting as the stream grows.

/** A comment was added / edited / status-changed / deleted for this project. */
export interface CommentChangedSsePayload {
  type: 'comment-changed';
  projectId: string;
  /** Emit time (epoch ms); advisory only. */
  at?: number;
}

/** A member joined / left this project's presence set. */
export interface PresenceChangedSsePayload {
  type: 'presence-changed';
  projectId: string;
  at?: number;
}

/** The project's name / settings / share metadata changed. */
export interface ProjectMetadataChangedSsePayload {
  type: 'project-metadata-changed';
  projectId: string;
  at?: number;
}

/**
 * Project-scoped collab invalidation events multiplexed onto
 * `/api/projects/:id/events`. Each carries the `projectId` it invalidates.
 */
export type CollabProjectInvalidationSsePayload =
  | CommentChangedSsePayload
  | PresenceChangedSsePayload
  | ProjectMetadataChangedSsePayload;

/** The SSE `event:` names for the project-scoped collab invalidations. */
export const COLLAB_PROJECT_INVALIDATION_EVENTS = [
  'comment-changed',
  'presence-changed',
  'project-metadata-changed',
] as const;

export type CollabProjectInvalidationEventName =
  (typeof COLLAB_PROJECT_INVALIDATION_EVENTS)[number];

/** A project was shared / unshared / created / deleted in the team. */
export interface TeamProjectsChangedSsePayload {
  type: 'team-projects-changed';
  at?: number;
}

/** One team project's pulled content and local read-only binding are ready. */
export interface TeamProjectContentReadySsePayload {
  type: 'team-project-content-ready';
  projectId: string;
  workspaceId: string;
  at?: number;
}

/** A member joined / left / changed role in the team. */
export interface WorkspaceMembersChangedSsePayload {
  type: 'members-changed';
  at?: number;
}

/** Seat count / entitlement / role / lifecycle in the workspace context changed. */
export interface WorkspaceContextChangedSsePayload {
  type: 'workspace-context-changed';
  at?: number;
}

/** Subscription / seat billing changed. */
export interface WorkspaceBillingChangedSsePayload {
  type: 'billing-changed';
  at?: number;
}

/**
 * Workspace-scoped invalidation events carried on `/api/workspace/events`.
 * Workspace scope is singular per daemon (one signed-in identity). Broad
 * invalidations carry no id; project-content readiness names the one card
 * whose local files just became readable.
 */
export type WorkspaceInvalidationSsePayload =
  | TeamProjectsChangedSsePayload
  | TeamProjectContentReadySsePayload
  | WorkspaceMembersChangedSsePayload
  | WorkspaceContextChangedSsePayload
  | WorkspaceBillingChangedSsePayload;

/** The SSE `event:` names for the workspace-scoped invalidations. */
export const WORKSPACE_INVALIDATION_EVENTS = [
  'team-projects-changed',
  'team-project-content-ready',
  'members-changed',
  'workspace-context-changed',
  'billing-changed',
] as const;

export type WorkspaceInvalidationEventName =
  (typeof WORKSPACE_INVALIDATION_EVENTS)[number];

/**
 * The handshake event the workspace SSE emits immediately on open, so a client
 * can treat the stream as live and reset its reconnect backoff (mirrors the
 * project stream's `ready`).
 */
export const WORKSPACE_EVENTS_READY_EVENT = 'ready';
