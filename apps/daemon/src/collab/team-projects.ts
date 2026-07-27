// Team-wide shared-project discovery. The Vela CLI is the only production
// transport: it reuses the login session and keeps backend credentials out of
// the Open Design daemon.

import type { TeamProject } from '@open-design/contracts';
import { contextToResourceHubPrincipal } from './resource-principal.js';
import {
  createVelaCliTeamProjectCatalog,
  shouldUseVelaCliTeamProjectCatalog,
  type VelaTeamProjectCatalog,
} from './vela-cli-team-projects.js';
import type { WorkspaceContextProvider } from './workspace-context.js';

export interface CreateTeamProjectsListerOptions {
  /** The one login-backed workspace context used by every collab surface. */
  workspaceContext: WorkspaceContextProvider;
  /** Injectable Vela catalog for tests. */
  teamProjectCatalog?: VelaTeamProjectCatalog;
  env?: NodeJS.ProcessEnv;
}

export function createTeamProjectsLister(
  options: CreateTeamProjectsListerOptions,
): (workspaceId?: string) => Promise<TeamProject[]> {
  const env = options.env ?? process.env;
  return async (workspaceId?: string) => {
    const principal = contextToResourceHubPrincipal(
      await options.workspaceContext.current({}),
    );
    if (!principal) return [];
    if (options.teamProjectCatalog) return options.teamProjectCatalog.list(workspaceId);
    if (!shouldUseVelaCliTeamProjectCatalog(env)) return [];
    return createVelaCliTeamProjectCatalog().list(workspaceId);
  };
}
