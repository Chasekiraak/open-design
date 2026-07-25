import Database from 'better-sqlite3';

import {
  ensureWorkspaceProject,
  getProject,
  getWorkspaceProject,
  getWorkspaceProjectByProjectId,
  insertProject,
  rebindWorkspaceProject,
  updateProject,
} from '../db.js';
import { projectResourceIdFor } from '../integrations/vela-team-projects.js';
import type {
  RegisterPulledProjectInput,
  TeamMirrorPullScope,
} from '../routes/collab-sync.js';
import type { ResourceHubPrincipal } from './resource-principal.js';

type SqliteDb = Database.Database;

export interface MaterializePulledTeamMirrorResult {
  localRecordChanged: boolean;
}

/**
 * Atomically create/update a pulled project and bind it as a read-only mirror
 * in the exact validated team scope. Existing bindings are never migrated:
 * only an absent row or a compatible active mirror may proceed.
 */
export function materializePulledTeamMirror(
  db: SqliteDb,
  input: RegisterPulledProjectInput,
  scope: TeamMirrorPullScope,
): MaterializePulledTeamMirrorResult {
  return db.transaction(() => {
    const ownerPrincipal: ResourceHubPrincipal = {
      teamId: scope.resourceTeamId,
      memberId: scope.ownerMemberId,
      role: 'member',
      lifecycleState: 'active',
      workspaceType: 'team',
    };
    const expectedCreator =
      scope.ownerMemberId === scope.viewerMemberId ? scope.viewerMemberId : null;
    const resourceHubResourceId = projectResourceIdFor(input.id, ownerPrincipal);
    const existingBinding = getWorkspaceProjectByProjectId(db, input.id) as
      | {
          workspaceId: string;
          visibility: string;
          resourceState: string | null;
          createdByWorkspaceMemberId: string | null;
          resourceHubResourceId: string | null;
          cloudTombstonedAt: number | null;
        }
      | undefined;
    const compatibleBinding =
      !existingBinding ||
      (
        existingBinding.workspaceId === scope.workspaceId &&
        existingBinding.visibility === 'team' &&
        existingBinding.resourceState === 'active' &&
        existingBinding.cloudTombstonedAt === null &&
        existingBinding.createdByWorkspaceMemberId === expectedCreator &&
        (
          existingBinding.resourceHubResourceId === null ||
          existingBinding.resourceHubResourceId === resourceHubResourceId
        )
      );
    if (!compatibleBinding) {
      throw new Error(`team mirror binding conflict for ${input.id}`);
    }

    const existing = getProject(db, input.id);
    let localRecordChanged = false;
    if (!existing) {
      insertProject(db, {
        id: input.id,
        name: input.name,
        skillId: input.skillId,
        designSystemId: input.designSystemId,
        metadata: input.metadata,
        createdAt: input.createdAt,
        updatedAt: input.updatedAt,
      });
      localRecordChanged = true;
    } else if (existing.name === '共享项目') {
      updateProject(db, input.id, {
        name: input.name,
        skillId: input.skillId,
        designSystemId: input.designSystemId,
        metadata: input.metadata,
        updatedAt: input.updatedAt,
      });
      localRecordChanged = true;
    }

    const patch = {
      workspaceId: scope.workspaceId,
      visibility: 'team' as const,
      resourceState: 'active' as const,
      createdByWorkspaceMemberId: expectedCreator,
      updatedByWorkspaceMemberId: scope.viewerMemberId,
      resourceHubResourceId,
      cloudTombstonedAt: null,
      syncState: 'synced' as const,
    };
    if (existingBinding) {
      rebindWorkspaceProject(db, input.id, patch);
    } else {
      ensureWorkspaceProject(db, { projectId: input.id, ...patch });
    }
    const binding = getWorkspaceProject(db, scope.workspaceId, input.id) as
      | {
          workspaceId: string;
          visibility: string;
          resourceState: string | null;
          createdByWorkspaceMemberId: string | null;
          updatedByWorkspaceMemberId: string | null;
          resourceHubResourceId: string | null;
          cloudTombstonedAt: number | null;
          syncState: string | null;
        }
      | undefined;
    if (
      !binding ||
      binding.workspaceId !== patch.workspaceId ||
      binding.visibility !== patch.visibility ||
      binding.resourceState !== patch.resourceState ||
      binding.createdByWorkspaceMemberId !== patch.createdByWorkspaceMemberId ||
      binding.updatedByWorkspaceMemberId !== patch.updatedByWorkspaceMemberId ||
      binding.resourceHubResourceId !== patch.resourceHubResourceId ||
      binding.cloudTombstonedAt !== null ||
      binding.syncState !== patch.syncState
    ) {
      throw new Error(`team mirror binding verification failed for ${input.id}`);
    }
    return { localRecordChanged };
  })();
}
