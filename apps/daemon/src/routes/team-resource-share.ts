import type { Express } from 'express';
import {
  TeamResourceShareForbiddenError,
  type TeamResourceShareRecord,
  type TeamResourceShareService,
} from '../collab/team-resource-share.js';

export interface TeamResourceShareListing {
  ids: string[];
  resources: TeamResourceShareRecord[];
}

export interface RegisterTeamResourceShareRoutesDeps {
  /** URL segment for this resource kind: `design-systems` | `plugins` | `skills`. */
  basePath: string;
  share: TeamResourceShareService;
  /** Optional materialization hook for shared team resources. */
  syncSharedResource?: (resource: TeamResourceShareRecord) => Promise<void>;
  /**
   * Optional stale-while-revalidate provider for the `/team` list. Each GET
   * otherwise hits the resource hub (and re-materializes every shared resource)
   * on the request path — slow when the workspace shell re-reads all three kinds
   * on navigation. When provided, the route serves this cached listing instead,
   * so warm reads return instantly and refresh in the background.
   *
   * When the provider also exposes `invalidate()` (see `createSwrCache` /
   * `cachedTeamResourceList` in server.ts), the share/unshare handlers below
   * call it on success so the client's immediate refetch reads the new state
   * instead of the pre-change list the cache would otherwise keep serving for
   * up to its freshMs (or the client's slower background poll once SSE lowers
   * its cadence). Best-effort and optional: a `listTeam` with no `invalidate`
   * just falls back to the old behavior of catching up on the next refresh.
   */
  listTeam?: (() => Promise<TeamResourceShareListing>) & { invalidate?: () => void };
}

/**
 * Team resource sharing routes for one resource kind. A member promotes a
 * personal resource into the team scope; the share service packs its directory
 * and pushes it to the resource hub so teammates can pull it. When there is no
 * team identity (or the hub is not configured), share returns `shared: false`
 * so the client keeps a local-only view instead of erroring. Mounted once per
 * kind (design systems, plugins, skills).
 */
export function registerTeamResourceShareRoutes(
  app: Express,
  deps: RegisterTeamResourceShareRoutesDeps,
): void {
  const { basePath, share } = deps;
  const root = `/api/workspace/${basePath}`;

  // The mutation itself already succeeded by the time this runs — a cache seam
  // failing here must not turn a successful share/unshare into a reported
  // failure, so this is best-effort and swallows its own errors.
  function invalidateListTeam(): void {
    try {
      deps.listTeam?.invalidate?.();
    } catch {
      // ignore
    }
  }

  // Ids shared to the team — drives the "team" collection for this kind.
  app.get(`${root}/team`, async (_req, res) => {
    if (deps.listTeam) {
      res.json(await deps.listTeam());
      return;
    }
    const resources = await share.sharedResources();
    if (deps.syncSharedResource) {
      await Promise.all(resources.map((resource) => deps.syncSharedResource?.(resource)));
    }
    res.json({ ids: resources.map((resource) => resource.id), resources });
  });

  // Share a personal resource to the team.
  app.post(`${root}/:id/share`, async (req, res) => {
    const id = typeof req.params.id === 'string' ? decodeURIComponent(req.params.id) : '';
    if (!id) return res.status(400).json({ error: 'invalid resource id' });
    try {
      const result = await share.share(id);
      if (!result) return res.json({ shared: false });
      // The cached `/team` listing is now stale by construction — drop it so
      // the client's immediate refetch (it fires one right after this
      // response) reads the new state instead of waiting out the cache's
      // freshMs, or worse, the client's slower background poll once SSE
      // lowers its cadence.
      invalidateListTeam();
      res.json({ shared: true, version: result.version });
    } catch (error) {
      if (error instanceof TeamResourceShareForbiddenError) {
        return res.status(403).json({ error: 'WORKSPACE_RESOURCE_SHARE_DENIED' });
      }
      res.status(500).json({ error: error instanceof Error ? error.message : 'share failed' });
    }
  });

  // Remove a resource from the team index. Vela remains the permission source of
  // truth: only the resource owner can edit/remove the shared resource.
  app.delete(`${root}/:id/share`, async (req, res) => {
    const id = typeof req.params.id === 'string' ? decodeURIComponent(req.params.id) : '';
    if (!id) return res.status(400).json({ error: 'invalid resource id' });
    try {
      const unshared = await share.unshare(id);
      if (unshared) invalidateListTeam();
      res.json({ unshared });
    } catch (error) {
      if (error instanceof TeamResourceShareForbiddenError) {
        return res.status(403).json({ error: 'WORKSPACE_RESOURCE_UNSHARE_DENIED' });
      }
      res.status(500).json({ error: error instanceof Error ? error.message : 'unshare failed' });
    }
  });
}
