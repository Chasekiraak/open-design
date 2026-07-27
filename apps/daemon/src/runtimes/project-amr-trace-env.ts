import { getWorkspaceProjectByProjectId } from '../db.js';
import { resolveProjectWorkspaceScope } from '../collab/project-workspace-scope.js';
import type { WorkspaceDirectoryFetchResult } from '../collab/vela-workspace-context.js';
import { openDesignAmrTraceEnv } from './env.js';

type SqliteDb = Parameters<typeof getWorkspaceProjectByProjectId>[0];

export class ProjectWorkspaceScopeUnavailableError extends Error {
  constructor(
    readonly projectId: string,
    readonly workspaceId: string | null,
  ) {
    super(
      `Cannot authorize project ${projectId}: its persisted workspace ` +
        `${workspaceId ?? 'binding'} is unavailable for the signed-in member`,
    );
    this.name = 'ProjectWorkspaceScopeUnavailableError';
  }
}

/**
 * Build the final AMR trace environment from the project's persisted SQLite
 * binding and the signed-in member's exact authoritative workspace directory.
 * No caller-provided or ambient workspace identity participates.
 *
 * `workspace_projects.visibility` is deliberately not used as a billing-kind
 * discriminator: a private draft can belong to a team workspace and must still
 * spend that team's wallet. If the persisted binding cannot be proven against
 * the current directory, fail closed rather than silently charging the account
 * wallet.
 */
export async function openDesignAmrTraceEnvForProject(
  db: SqliteDb,
  input: {
    agentId: string;
    runId: string;
    conversationId?: string | null;
    runAttempt: number;
    projectId?: string | null;
  },
  deps: {
    fetchWorkspaceDirectory: () => Promise<WorkspaceDirectoryFetchResult>;
  },
): Promise<NodeJS.ProcessEnv> {
  const traceInput = {
    agentId: input.agentId,
    runId: input.runId,
    runAttempt: input.runAttempt,
    ...(input.conversationId !== undefined
      ? { conversationId: input.conversationId }
      : {}),
  };
  // Every runtime passes through the server launch env builder, but workspace
  // billing is an AMR-only concern. Non-AMR launches must neither depend on nor
  // pay latency for the Vela membership directory.
  if (input.agentId !== 'amr') return openDesignAmrTraceEnv(traceInput);

  const projectId = input.projectId?.trim();
  let workspaceId: string | null = null;
  if (projectId) {
    const binding = getWorkspaceProjectByProjectId(db, projectId);
    if (!binding) {
      throw new ProjectWorkspaceScopeUnavailableError(projectId, null);
    }
    const directory = await deps.fetchWorkspaceDirectory().catch(
      (): WorkspaceDirectoryFetchResult => ({ ok: false, items: [] }),
    );
    const scope = resolveProjectWorkspaceScope({
      projectId,
      binding,
      directory,
    });
    if (scope.kind === 'unbound' || scope.kind === 'unavailable') {
      throw new ProjectWorkspaceScopeUnavailableError(projectId, scope.workspaceId);
    }
    if (scope.kind === 'team') workspaceId = scope.workspaceId;
  }
  return openDesignAmrTraceEnv({
    ...traceInput,
    workspaceId,
  });
}
