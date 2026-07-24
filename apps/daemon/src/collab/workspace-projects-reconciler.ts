// Realtime reconciliation of the local `workspace_projects` SQLite table
// against Vela's team-project catalog — the remote source of truth for "is
// project X still shared to my team, and who owns it."
//
// Two existing daemon triggers already learn about a team-catalog change:
//   - `startHubEventsSubscriber`'s `team-projects-changed` push (server.ts).
//   - `workspaceInvalidationPoller`'s ~15s diff-and-signal cadence
//     (collab/workspace-invalidation-poller.ts).
// Both used to do nothing more than invalidate the DISPLAY cache
// (`teamProjectsDisplayCache`) and nudge the web to refetch — the local
// `workspace_projects` row itself was never re-examined, so a row this
// daemon had already bound could silently disagree with reality forever
// (the concrete, repeatedly-reported case: an owner unshares a project and a
// member's local "team" binding never converges back to personal). This
// module closes that gap: `handleHubTeamProjectsChanged` and
// `handlePolledWorkspaceInvalidation` below hook BOTH existing triggers to
// also run `reconcileWorkspaceProjectsWithRemote`, a real read-modify-write
// pass over this daemon's own team rows. No new polling loop is introduced —
// both hooks ride the cadence their trigger already has.
//
// Scope: PROJECTS only (`workspace_projects`). Plugins / skills / design
// systems have their own generic `workspace_resources` table and are
// deliberately NOT covered here.
//
// Relationship to the two existing point fixes — neither is replaced:
//   - `reconcileUnboundProjectBeforeMove` (routes/project/index.ts) stays: it
//     is a synchronous, request-scoped correctness gate for ONE specific
//     decision (`/move` to personal) that must not wait for the next
//     background sweep — a user clicking "move to personal" right now needs
//     the answer right now, not in up to 15s.
//   - `reconcileLocalRowWithRemoteTeamAccess` (routes/project/index.ts) stays
//     too: it runs on every `GET /api/workspaces/:workspaceId/projects` and
//     has access to the RICHER `VelaTeamProjectRecord` (`resourceId`,
//     `access.canEdit`, `frozen`) that the simpler `listTeamProjects()` this
//     module consumes does not carry. It remains the precise, per-request
//     completion pass for a brand-new row (in particular, the one that fills
//     in the real `resourceHubResourceId` this module leaves null). This
//     module additionally covers the direction that pass structurally never
//     reaches — an ALREADY-bound row the remote catalog no longer confirms —
//     and runs proactively instead of waiting for the next list request.

import type { WorkspaceInvalidationSsePayload } from '@open-design/contracts';

/** This daemon's one local `workspace_projects` row for a project, as far as
 *  reconciliation cares. */
export interface LocalTeamProjectBinding {
  projectId: string;
  workspaceId: string;
  visibility: 'personal' | 'team';
  createdByWorkspaceMemberId: string | null;
  resourceHubResourceId: string | null;
}

/** What the remote catalog says about a shared project — the subset
 *  `listTeamProjects()` (contracts' `TeamProject`) actually carries. */
export interface RemoteTeamProjectRef {
  projectId: string;
  ownerMemberId: string;
}

export interface WorkspaceProjectBindPatch {
  workspaceId: string;
  visibility: 'team';
  resourceState: 'active';
  createdByWorkspaceMemberId: string | null;
  updatedByWorkspaceMemberId: string;
  resourceHubResourceId: string | null;
  cloudTombstonedAt: null;
  syncState: 'synced';
}

export interface WorkspaceProjectDemotePatch {
  visibility: 'personal';
  createdByWorkspaceMemberId: string;
  resourceHubResourceId: null;
  cloudTombstonedAt: null;
  syncState: 'local_only';
}

export type WorkspaceProjectReconcileAction =
  | { kind: 'bind'; projectId: string; patch: WorkspaceProjectBindPatch }
  | { kind: 'demote'; projectId: string; workspaceId: string; patch: WorkspaceProjectDemotePatch };

/**
 * Pure planner: given what the remote catalog reports and what this daemon's
 * OWN `workspace_projects` table currently claims for the active team
 * workspace, decide which rows disagree and how to fix them. No I/O — the
 * orchestrator below (`reconcileWorkspaceProjectsWithRemote`) is the only
 * caller that touches the database, which is what keeps this function
 * directly unit-testable.
 *
 * `localBindings` must carry an entry for every project this function needs
 * an opinion on: every `remoteProjects[].projectId` (so a brand-new remote
 * share can be told apart from an already-correct one) AND every row already
 * bound `visibility: 'team'` under `workspaceId` (so a row remote no longer
 * lists can be found at all). The caller builds this union — see
 * `reconcileWorkspaceProjectsWithRemote`.
 */
export function planWorkspaceProjectReconciliation(input: {
  workspaceId: string;
  workspaceMemberId: string;
  remoteProjects: readonly RemoteTeamProjectRef[];
  localBindings: ReadonlyMap<string, LocalTeamProjectBinding>;
}): WorkspaceProjectReconcileAction[] {
  const { workspaceId, workspaceMemberId, remoteProjects, localBindings } = input;
  const actions: WorkspaceProjectReconcileAction[] = [];
  const remoteIds = new Set(remoteProjects.map((project) => project.projectId));

  // Direction 1: remote reports the project as shared to my team — correct a
  // missing, mis-owned, or wrong-visibility local row. Ownership drives
  // `createdByWorkspaceMemberId` the same way `reconcileLocalRowWithRemoteTeamAccess`
  // does: the hub's single writer per project is its `ownerMemberId`, so only
  // a match against the CURRENT member earns an editable local binding.
  for (const remote of remoteProjects) {
    const local = localBindings.get(remote.projectId) ?? null;
    const isOwner = remote.ownerMemberId === workspaceMemberId;
    const wantCreatedBy = isOwner ? workspaceMemberId : null;
    const alreadyCorrect =
      local != null &&
      local.workspaceId === workspaceId &&
      local.visibility === 'team' &&
      local.createdByWorkspaceMemberId === wantCreatedBy;
    if (alreadyCorrect) continue;
    actions.push({
      kind: 'bind',
      projectId: remote.projectId,
      patch: {
        workspaceId,
        visibility: 'team',
        resourceState: 'active',
        createdByWorkspaceMemberId: wantCreatedBy,
        updatedByWorkspaceMemberId: workspaceMemberId,
        // Preserve a resourceId this daemon already learned (e.g. from the
        // request-driven `reconcileLocalRowWithRemoteTeamAccess`, which reads
        // the richer catalog client that DOES carry it); `listTeamProjects()`
        // itself does not expose one. Leaving it null here is safe: the next
        // `GET /api/workspaces/:workspaceId/projects` still completes it via
        // that existing, higher-fidelity pass.
        resourceHubResourceId: local?.resourceHubResourceId ?? null,
        cloudTombstonedAt: null,
        syncState: 'synced',
      },
    });
  }

  // Direction 2: a local row still claims `visibility: 'team'` in the active
  // workspace, but remote no longer lists it at all (unshared / deleted /
  // this member's access revoked). Collapse it back to a personal draft,
  // attributed to the CURRENT reconciling member — after the collapse this
  // really is just a local copy that happens to live on this member's
  // machine, the same as any other project they created. This attribution is
  // deliberate, not incidental: `workspaceProjectRowBelongsToCurrentWorkspace`
  // (routes/project/index.ts) treats a `visibility: 'personal'` row with a
  // NULL creator inside a team workspace as pre-workspace-isolation legacy
  // junk and suppresses it from every view — exactly the shape a former
  // read-only team mirror's row already has
  // (`reconcileLocalRowWithRemoteTeamAccess`'s canEdit:false branch never
  // sets a creator). Leaving it null here would make the demoted project
  // vanish from `GET /api/workspaces/:workspaceId/projects` entirely instead
  // of correctly reappearing as an ordinary personal draft.
  for (const [projectId, local] of localBindings) {
    if (local.workspaceId !== workspaceId || local.visibility !== 'team') continue;
    if (remoteIds.has(projectId)) continue;
    actions.push({
      kind: 'demote',
      projectId,
      workspaceId,
      patch: {
        visibility: 'personal',
        createdByWorkspaceMemberId: workspaceMemberId,
        resourceHubResourceId: null,
        cloudTombstonedAt: null,
        syncState: 'local_only',
      },
    });
  }

  return actions;
}

export interface WorkspaceProjectsReconcilerDeps {
  /** The signed-in team workspace + member this daemon is currently acting
   *  as, or null off-team / signed out / removed. Must gate on active
   *  membership (`memberStatus === 'active'`), the same defensive check
   *  `should-publish.ts`'s `createShouldPublish` uses — a context that can
   *  still ADDRESS a resource hub partition is not proof this member is still
   *  IN the team (see that file's doc comment). */
  getWorkspaceIdentity: () => Promise<{ workspaceId: string; workspaceMemberId: string } | null>;
  /** `listTeamProjects()` narrowed to what the planner needs — reuse the
   *  daemon's existing `teamProjectsForDisplay` (server.ts), the exact same
   *  read every other realtime consumer already shares, so this module never
   *  opens a second transport to Vela. */
  listRemoteTeamProjects: () => Promise<readonly RemoteTeamProjectRef[]>;
  /** Every row this daemon currently has bound `visibility: 'team'` for
   *  `workspaceId` (`listWorkspaceProjects(db, workspaceId)`, pre-filtered). */
  listLocalTeamRows: (workspaceId: string) => readonly LocalTeamProjectBinding[];
  /** This one project's current local binding (any workspace), or null if
   *  unbound (`getWorkspaceProjectByProjectId`). Only consulted for a remote
   *  project not already covered by `listLocalTeamRows`. */
  getLocalBinding: (projectId: string) => LocalTeamProjectBinding | null;
  /**
   * Write a 'bind' action. MUST handle both cases `db.ts`'s two primitives
   * split across: a project with an existing (wrong) row (`rebindWorkspaceProject`,
   * keyed on project id alone so a stale workspace_id is corrected too) AND a
   * project with NO local row at all (`rebindWorkspaceProject` is a no-op in
   * that case — it never inserts — so the caller must fall back to
   * `ensureWorkspaceProject` with the same patch). See the wiring in
   * server.ts for the reference implementation.
   */
  applyBind: (projectId: string, patch: WorkspaceProjectBindPatch) => void;
  applyDemote: (workspaceId: string, projectId: string, patch: WorkspaceProjectDemotePatch) => void;
  onError?: (error: unknown) => void;
}

export interface WorkspaceProjectsReconcileResult {
  bound: number;
  demoted: number;
}

const NO_OP_RESULT: WorkspaceProjectsReconcileResult = { bound: 0, demoted: 0 };

/**
 * Run one reconciliation pass: read the remote team-project list, diff it
 * against this daemon's own `workspace_projects` rows, and write back
 * whatever disagrees. Best-effort throughout — a failed identity read or a
 * failed remote read returns a no-op result rather than throwing, so a
 * transient Vela outage can never be misread as "remote reports zero
 * projects" and demote every local team row on missing (as opposed to
 * genuinely empty) data.
 */
export async function reconcileWorkspaceProjectsWithRemote(
  deps: WorkspaceProjectsReconcilerDeps,
): Promise<WorkspaceProjectsReconcileResult> {
  const identity = await deps.getWorkspaceIdentity().catch((error) => {
    deps.onError?.(error);
    return null;
  });
  if (!identity) return NO_OP_RESULT;

  let remoteProjects: readonly RemoteTeamProjectRef[];
  try {
    remoteProjects = await deps.listRemoteTeamProjects();
  } catch (error) {
    deps.onError?.(error);
    return NO_OP_RESULT;
  }

  const localBindings = new Map<string, LocalTeamProjectBinding>();
  for (const row of deps.listLocalTeamRows(identity.workspaceId)) {
    localBindings.set(row.projectId, row);
  }
  for (const remote of remoteProjects) {
    if (localBindings.has(remote.projectId)) continue;
    const existing = deps.getLocalBinding(remote.projectId);
    if (existing) localBindings.set(remote.projectId, existing);
  }

  const actions = planWorkspaceProjectReconciliation({
    workspaceId: identity.workspaceId,
    workspaceMemberId: identity.workspaceMemberId,
    remoteProjects,
    localBindings,
  });

  for (const action of actions) {
    try {
      if (action.kind === 'bind') deps.applyBind(action.projectId, action.patch);
      else deps.applyDemote(action.workspaceId, action.projectId, action.patch);
    } catch (error) {
      deps.onError?.(error);
    }
  }

  return {
    bound: actions.filter((action) => action.kind === 'bind').length,
    demoted: actions.filter((action) => action.kind === 'demote').length,
  };
}

/**
 * Hub → daemon handling for the `team-projects-changed` push (see
 * `startHubEventsSubscriber`'s `onEvent` in server.ts). Sibling of
 * `handleHubWorkspaceContextChanged` just above it in that file: besides
 * refreshing the display cache and sending the thin web signal
 * (`emitTeamProjectsChangedDeduped`), this now ALSO runs a real
 * `workspace_projects` reconciliation pass, so a member whose owner just
 * unshared a project (or who just gained access to a new one) converges
 * immediately instead of waiting for the ~15s poller.
 *
 * Extracted as its own named, exported step for the same reason
 * `handleHubWorkspaceContextChanged` is: directly unit-testable without
 * standing up a real hub connection.
 */
export function handleHubTeamProjectsChanged(
  emitTeamProjectsChangedDeduped: () => void,
  reconcileWorkspaceProjects: () => Promise<unknown>,
): void {
  emitTeamProjectsChangedDeduped();
  void reconcileWorkspaceProjects().catch(() => undefined);
}

/**
 * `workspaceInvalidationPoller`'s `emit` wrapper (server.ts). The poller
 * itself stays a pure "diff and signal" utility
 * (`collab/workspace-invalidation-poller.ts`) with no opinion on
 * `workspace_projects`; this is the one seam where a `team-projects-changed`
 * signal ALSO kicks the real reconciliation — the poller's own ~15s-cadence
 * twin of `handleHubTeamProjectsChanged` above, for daemons that are signed
 * in but whose hub SSE channel is down (the poller is the sole delivery
 * mechanism in that state, per `startHubEventsSubscriber`'s own doc comment).
 */
export function handlePolledWorkspaceInvalidation(
  payload: WorkspaceInvalidationSsePayload,
  emit: (payload: WorkspaceInvalidationSsePayload) => void,
  reconcileWorkspaceProjects: () => Promise<unknown>,
): void {
  emit(payload);
  if (payload.type === 'team-projects-changed') {
    void reconcileWorkspaceProjects().catch(() => undefined);
  }
}
