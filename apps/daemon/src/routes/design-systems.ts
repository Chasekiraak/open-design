import type { Express } from 'express';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { RouteDeps } from '../server-context.js';
import type {
  DesignSystemFileDetail,
  DesignSystemFileSummary,
  DesignSystemPackageInfo,
  DesignSystemRevision,
  DesignSystemSummary,
  UserDesignSystemInput,
} from '../design-systems/index.js';
import type { DesignTokenContractRebuildPreparation } from '../design-systems/token-contract-rebuild.js';
import type {
  DesignSystemGenerationJob,
  DesignSystemRevisionInput,
  DesignSystemTokenContractRebuildInput,
} from '../design-systems/generation-jobs.js';
import { deleteWorkspaceResourceByResourceId, type openDatabase } from '../db.js';
import {
  isWorkspaceResourceLocked,
  workspaceResourceContextFromRequest,
} from '../collab/workspace-resource-mutation.js';
import type { Project, ProjectFile } from '@open-design/contracts';

type DbHandle = ReturnType<typeof openDatabase>;

type DesignSystemWorkspaceProject = {
  project: Project;
  files: ProjectFile[];
};

type AvailableDesignSystemSummary = DesignSystemSummary & {
  source?: 'built-in' | 'installed' | 'user';
};

const PACKAGED_SHOWCASE_PATH = 'system/kit.html';

export interface RegisterDesignSystemRoutesDeps extends RouteDeps<'db' | 'paths' | 'projectFiles' | 'projectStore'> {
  designSystems: {
    buildUserDesignSystemArchive: (
      root: string,
      id: string,
    ) => Promise<{ buffer: Buffer; baseName: string; title: string } | null>;
    /**
     * Whether the caller may mutate (edit / publish-toggle / delete) `id`.
     * Always true for a system the caller authored themselves. For a system
     * materialized locally from a teammate's team share, true only when the
     * caller can manage that share — the original sharer, or a workspace
     * owner/admin (see `canManageSharedResource` in
     * `collab/team-resource-share.ts`) — mirroring the "who can unshare"
     * rule exactly. Without this gate, a plain member with a synced local
     * copy could PATCH/DELETE a design system that was never theirs
     * (recvqb6mfyqXLD): the UI hides the affordances, but nothing stopped a
     * direct API call.
     *
     * `req` (spec 9.2) lets the implementation also refuse when the caller's
     * own workspace is locked/deleted (billing lapse, deletion in progress)
     * — a check design system never had, unlike project/plugin.
     */
    canMutateUserDesignSystem: (root: string, id: string, req: any) => Promise<boolean>;
    createUserDesignSystem: (root: string, input: UserDesignSystemInput) => Promise<DesignSystemSummary>;
    deleteUserDesignSystem: (root: string, id: string) => Promise<boolean>;
    ensureUserDesignSystemWorkspaceProject: (db: DbHandle, id: string) => Promise<DesignSystemWorkspaceProject | null>;
    listAllDesignSystems: () => Promise<AvailableDesignSystemSummary[]>;
    listUserDesignSystemFiles: (root: string, id: string) => Promise<DesignSystemFileSummary[] | null>;
    listUserDesignSystemRevisions: (root: string, id: string) => Promise<DesignSystemRevision[] | null>;
    prepareDesignTokenContractRebuild: (root: string, id: string, options?: { force?: boolean }) => Promise<DesignTokenContractRebuildPreparation>;
    readAvailableDesignSystem: (id: string) => Promise<string | null>;
    readAvailableDesignSystemPackageInfo: (id: string) => Promise<DesignSystemPackageInfo | null>;
    readAvailableDesignSystemStaticFile: (id: string, filePath: string) => Promise<{
      bytes: Buffer;
      contentType: string;
      updatedAt: string;
    } | null>;
    readDesignSystemWorkspaceTextFile: (db: DbHandle, summary: AvailableDesignSystemSummary | undefined, filePath: string) => Promise<string | null>;
    readUserDesignSystemFile: (root: string, id: string, filePath: string) => Promise<DesignSystemFileDetail | null>;
    renderDesignSystemPreview: (id: string, body: string) => string;
    renderDesignSystemShowcase: (id: string, body: string) => string;
    /**
     * Physically copies the real `assets/` files out of a user design
     * system's workspace project (where an agent's Write/Edit tool calls
     * actually land) into the canonical directory — the fix for spec 04
     * §9.3 (recvqb1t4FrckM): canonical is the only directory
     * `team-resource-share` and the download archive read from, and until
     * this existed nothing ever copied a regenerated logo back into it.
     */
    syncUserDesignSystemAssetsFromWorkspace: (
      db: DbHandle,
      id: string,
    ) => Promise<{ ok: true; synced: string[] } | { ok: false; reason: 'not-found' | 'no-workspace-project' }>;
    updateUserDesignSystem: (root: string, id: string, input: UserDesignSystemInput) => Promise<DesignSystemSummary | null>;
    updateUserDesignSystemRevisionStatus: (root: string, id: string, revisionId: string, status: 'accepted' | 'rejected') => Promise<DesignSystemRevision | null>;
    /**
     * spec 04 §11: unshare `id` from the team hub BEFORE the local delete
     * proceeds, but only when it is CURRENTLY on the live team share list
     * (`designSystemsTeamShare.sharedResources()` in server.ts) — never on
     * `isTeamSyncedUserDesignSystem` alone. That flag is true only on a
     * teammate's PULLED copy; the sharer deleting their OWN original always
     * reads `teamSynced: false`, which is exactly why the hub index used to
     * survive this route untouched and teammates kept seeing the deleted
     * design system. Returns whether an unshare actually ran (false when the
     * system was never shared, or team sharing isn't configured) so tests can
     * assert on the real state transition instead of a call-was-made mock.
     */
    unshareTeamDesignSystemIfShared: (id: string) => Promise<boolean>;
  };
  generationJobs: {
    get: (jobId: string) => DesignSystemGenerationJob | null;
    rebuildTokenContract: (input: DesignSystemTokenContractRebuildInput) => DesignSystemGenerationJob;
    revise: (input: DesignSystemRevisionInput) => DesignSystemGenerationJob;
    start: (input: UserDesignSystemInput) => DesignSystemGenerationJob;
  };
};

// Strip a brand title down to a safe download filename stem (no path
// separators, control chars, or trailing dashes; capped so the OS accepts it).
function sanitizeArchiveFilename(raw: string): string {
  return String(raw ?? '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

export function registerDesignSystemRoutes(app: Express, ctx: RegisterDesignSystemRoutesDeps) {
  const { db } = ctx;
  const { CRAFT_DIR, USER_DESIGN_SYSTEMS_DIR } = ctx.paths;
  const {
    buildUserDesignSystemArchive,
    canMutateUserDesignSystem,
    createUserDesignSystem,
    deleteUserDesignSystem,
    ensureUserDesignSystemWorkspaceProject,
    listAllDesignSystems,
    listUserDesignSystemFiles,
    listUserDesignSystemRevisions,
    prepareDesignTokenContractRebuild,
    readAvailableDesignSystem,
    readAvailableDesignSystemPackageInfo,
    readAvailableDesignSystemStaticFile,
    readDesignSystemWorkspaceTextFile,
    readUserDesignSystemFile,
    renderDesignSystemPreview,
    renderDesignSystemShowcase,
    syncUserDesignSystemAssetsFromWorkspace,
    unshareTeamDesignSystemIfShared,
    updateUserDesignSystem,
    updateUserDesignSystemRevisionStatus,
  } = ctx.designSystems;
  const designSystemGenerationJobs = ctx.generationJobs;

  // Workspace-lock gate (spec 9.2), unconditional and independent of
  // `canMutateUserDesignSystem`'s own teamSynced/canUnshare verdict — a
  // locked/deleted workspace (billing lapse, deletion in progress) must
  // refuse every PATCH/DELETE regardless of who the caller is, the same
  // guarantee `enforceWorkspaceResourceMutation` gives project/plugin/skill.
  // Reuses that module's own `workspaceResourceContextFromRequest`/
  // `isWorkspaceResourceLocked` rather than re-deriving the header contract
  // here. Checked at the route rather than folded silently into
  // `canMutateUserDesignSystem`'s boolean so it applies no matter what a
  // caller-supplied implementation of that hook decides.
  function isRequestWorkspaceLocked(req: any): boolean {
    const requestCtx = workspaceResourceContextFromRequest(req);
    return Boolean(requestCtx && requestCtx !== 'missing' && isWorkspaceResourceLocked(requestCtx));
  }

  app.post('/api/design-systems', async (req, res) => {
    try {
      const created = await createUserDesignSystem(USER_DESIGN_SYSTEMS_DIR, req.body || {});
      res.status(201).json({ ...created as object, designSystem: created });
    } catch (err) {
      res.status(400).json({ error: String(err) });
    }
  });

  app.post('/api/design-systems/generation-jobs', async (req, res) => {
    try {
      const job = designSystemGenerationJobs.start(req.body || {});
      res.status(202).json({ job });
    } catch (err) {
      res.status(400).json({ error: String(err) });
    }
  });

  app.get('/api/design-systems/generation-jobs/:jobId', async (req, res) => {
    try {
      const job = designSystemGenerationJobs.get(req.params.jobId);
      if (!job) {
        return res.status(404).json({ error: 'design system generation job not found' });
      }
      res.json({ job });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.post('/api/design-systems/:id/revision-jobs', async (req, res) => {
    try {
      const feedback = typeof req.body?.feedback === 'string' ? req.body.feedback : '';
      if (!feedback.trim()) return res.status(400).json({ error: 'feedback is required' });
      const job = designSystemGenerationJobs.revise({
        designSystemId: req.params.id,
        feedback,
        sectionTitle: typeof req.body?.sectionTitle === 'string' ? req.body.sectionTitle : undefined,
        body: typeof req.body?.body === 'string' ? req.body.body : undefined,
      });
      res.status(202).json({ job });
    } catch (err) {
      res.status(400).json({ error: String(err) });
    }
  });

  app.post('/api/design-systems/:id/token-contract/rebuild-jobs', async (req, res) => {
    try {
      const preparation = await prepareDesignTokenContractRebuild(
        USER_DESIGN_SYSTEMS_DIR,
        req.params.id,
        { force: req.body?.force === true },
      );
      if (!preparation.decision.available) {
        return res.status(200).json({ decision: preparation.decision });
      }
      if (!preparation.revision) {
        return res.status(200).json({ decision: preparation.decision });
      }
      const job = designSystemGenerationJobs.rebuildTokenContract({
        designSystemId: req.params.id,
        decision: preparation.decision,
        ...preparation.revision,
      });
      res.status(202).json({ decision: preparation.decision, job });
    } catch (err) {
      res.status(400).json({ error: String(err) });
    }
  });

  app.get('/api/design-systems/:id/revisions', async (req, res) => {
    try {
      const revisions = await listUserDesignSystemRevisions(
        USER_DESIGN_SYSTEMS_DIR,
        req.params.id,
      );
      if (!revisions) {
        return res.status(404).json({ error: 'editable design system not found' });
      }
      res.json({ revisions });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.patch('/api/design-systems/:id/revisions/:revisionId', async (req, res) => {
    try {
      const status = typeof req.body?.status === 'string' ? req.body.status : '';
      if (status !== 'accepted' && status !== 'rejected') {
        return res.status(400).json({ error: 'status must be accepted or rejected' });
      }
      const revision = await updateUserDesignSystemRevisionStatus(
        USER_DESIGN_SYSTEMS_DIR,
        req.params.id,
        req.params.revisionId,
        status,
      );
      if (!revision) {
        return res.status(404).json({ error: 'design system revision not found' });
      }
      res.json({ revision });
    } catch (err) {
      res.status(400).json({ error: String(err) });
    }
  });

  app.get('/api/design-systems/:id', async (req, res) => {
    try {
      const systems = await listAllDesignSystems();
      const summary = systems.find((s) => s.id === req.params.id);
      const projectBody = await readDesignSystemWorkspaceTextFile(db, summary, 'DESIGN.md');
      const body = projectBody ?? await readAvailableDesignSystem(req.params.id);
      if (body === null || !summary) {
        return res.status(404).json({ error: 'design system not found' });
      }
      const packageInfo = await readAvailableDesignSystemPackageInfo(req.params.id);
      const detail = { ...summary, body, ...(packageInfo ? { packageInfo } : {}) };
      res.json({ ...detail, designSystem: detail });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.get('/api/design-systems/:id/preview', async (req, res) => {
    try {
      const body = await readAvailableDesignSystem(req.params.id);
      if (body === null) return res.status(404).type('text/plain').send('not found');
      const html = renderDesignSystemPreview(req.params.id, body);
      res.type('text/html').send(html);
    } catch (err) {
      res.status(500).type('text/plain').send(String(err));
    }
  });

  app.get('/api/design-systems/:id/showcase', async (req, res) => {
    try {
      const packaged = await readAvailableDesignSystemStaticFile(req.params.id, PACKAGED_SHOWCASE_PATH);
      if (packaged?.contentType.startsWith('text/html')) {
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Last-Modified', packaged.updatedAt);
        return res.type('text/html').send(
          rewriteDesignSystemShowcaseAssetUrls(
            packaged.bytes.toString('utf8'),
            req.params.id,
            path.posix.dirname(PACKAGED_SHOWCASE_PATH),
          ),
        );
      }
      const body = await readAvailableDesignSystem(req.params.id);
      if (body === null) return res.status(404).type('text/plain').send('not found');
      const html = renderDesignSystemShowcase(req.params.id, body);
      res.type('text/html').send(html);
    } catch (err) {
      res.status(500).type('text/plain').send(String(err));
    }
  });

  app.get('/api/design-systems/:id/static', async (req, res) => {
    try {
      const requestedPath = typeof req.query.path === 'string' ? req.query.path : '';
      const file = await readAvailableDesignSystemStaticFile(req.params.id, requestedPath);
      if (!file) return res.status(404).type('text/plain').send('not found');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Last-Modified', file.updatedAt);
      res.type(file.contentType).send(file.bytes);
    } catch (err) {
      res.status(500).type('text/plain').send(String(err));
    }
  });

  app.post('/api/design-systems/:id/workspace', async (req, res) => {
    try {
      const workspace = await ensureUserDesignSystemWorkspaceProject(db, req.params.id);
      if (!workspace) {
        return res.status(404).json({ error: 'editable design system not found' });
      }
      res.status(201).json(workspace);
    } catch (err) {
      res.status(400).json({ error: String(err) });
    }
  });

  app.get('/api/design-systems/:id/files', async (req, res) => {
    try {
      const files = await listUserDesignSystemFiles(USER_DESIGN_SYSTEMS_DIR, req.params.id);
      if (!files) {
        return res.status(404).json({ error: 'editable design system not found' });
      }
      res.json({ files });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.get('/api/design-systems/:id/file', async (req, res) => {
    try {
      const requestedPath = typeof req.query.path === 'string' ? req.query.path : '';
      const file = await readUserDesignSystemFile(
        USER_DESIGN_SYSTEMS_DIR,
        req.params.id,
        requestedPath,
      );
      if (!file) return res.status(404).json({ error: 'design system file not found' });
      res.json({ file });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // Streams a .zip of the whole user design system directory plus a generated
  // SKILLS.md usage guide, so the "Download brand" action (and `od
  // design-systems download`) hand the recipient a self-contained, shareable
  // brand package. Only user systems have an editable dir; presets resolve to
  // null and surface as 404.
  app.get('/api/design-systems/:id/archive', async (req, res) => {
    try {
      const archive = await buildUserDesignSystemArchive(USER_DESIGN_SYSTEMS_DIR, req.params.id);
      if (!archive) {
        return res.status(404).json({ error: 'downloadable design system not found' });
      }
      const fileSlug = sanitizeArchiveFilename(archive.baseName) || 'design-system';
      const filename = `${fileSlug}.zip`;
      // RFC 5987: ASCII `filename=` fallback plus UTF-8 `filename*=` so brand
      // names with non-ASCII characters (CJK, accents) download without mojibake.
      const asciiFallback =
        filename.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '_') || 'design-system.zip';
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
      );
      res.send(archive.buffer);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.patch('/api/design-systems/:id', async (req, res) => {
    try {
      if (isRequestWorkspaceLocked(req)) {
        return res.status(403).json({ error: 'WORKSPACE_LOCKED' });
      }
      if (!(await canMutateUserDesignSystem(USER_DESIGN_SYSTEMS_DIR, req.params.id, req))) {
        return res.status(403).json({ error: 'WORKSPACE_RESOURCE_MANAGE_DENIED' });
      }
      const updated = await updateUserDesignSystem(
        USER_DESIGN_SYSTEMS_DIR,
        req.params.id,
        req.body || {},
      );
      if (!updated) {
        return res.status(404).json({ error: 'editable design system not found' });
      }
      res.json({ ...updated as object, designSystem: updated });
    } catch (err) {
      res.status(400).json({ error: String(err) });
    }
  });

  // Asset sync (spec 04 §9.3, recvqb1t4FrckM): a signal-only endpoint — the
  // browser never uploads file bytes here. The daemon locates the design
  // system's workspace project itself (same lookup
  // `ensureUserDesignSystemWorkspaceProject` uses) and copies real files
  // under that project's `assets/` directory into the canonical design
  // system directory, entirely on the daemon side of the data-directory
  // boundary. Gated the same way as PATCH/DELETE: a locked workspace or a
  // caller who cannot manage the (possibly team-synced) design system may
  // not trigger a write to canonical.
  app.post('/api/design-systems/:id/sync-assets', async (req, res) => {
    try {
      if (isRequestWorkspaceLocked(req)) {
        return res.status(403).json({ error: 'WORKSPACE_LOCKED' });
      }
      if (!(await canMutateUserDesignSystem(USER_DESIGN_SYSTEMS_DIR, req.params.id, req))) {
        return res.status(403).json({ error: 'WORKSPACE_RESOURCE_MANAGE_DENIED' });
      }
      const outcome = await syncUserDesignSystemAssetsFromWorkspace(db, req.params.id);
      if (!outcome.ok) {
        if (outcome.reason === 'not-found') {
          return res.status(404).json({ error: 'editable design system not found' });
        }
        // No workspace project to sync from yet — a benign no-op, not an
        // error; the trigger sites call this speculatively on every asset
        // write and run-end.
        return res.json({ synced: [] });
      }
      res.json({ synced: outcome.synced });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.delete('/api/design-systems/:id', async (req, res) => {
    try {
      if (isRequestWorkspaceLocked(req)) {
        return res.status(403).json({ error: 'WORKSPACE_LOCKED' });
      }
      if (!(await canMutateUserDesignSystem(USER_DESIGN_SYSTEMS_DIR, req.params.id, req))) {
        return res.status(403).json({ error: 'WORKSPACE_RESOURCE_MANAGE_DENIED' });
      }
      // spec 04 §11: drop the hub-side share BEFORE the local delete, so a
      // sharer deleting their OWN design system does not leave the hub index
      // pointing at a canonical directory that is about to stop existing —
      // otherwise `syncSharedTeamDesignSystem` (server.ts) keeps re-stamping
      // `markTeamSynced()` onto every teammate's already-synced local copy
      // forever, because the hub still reports the resource as shared. A
      // thrown error here (e.g. the caller cannot actually manage the share)
      // aborts before `deleteUserDesignSystem` runs, matching "unshare must
      // succeed before the local delete proceeds".
      await unshareTeamDesignSystemIfShared(req.params.id);
      const ok = await deleteUserDesignSystem(USER_DESIGN_SYSTEMS_DIR, req.params.id);
      if (!ok) {
        return res.status(404).json({ error: 'editable design system not found' });
      }
      // Envelope cleanup (spec 9.2): drop the `workspace_resources` binding
      // row too, mirroring skill's DELETE route (routes/static-resource.ts)
      // and plugin uninstall (plugins/installer.ts) — the generic table has
      // no ON DELETE CASCADE, so skipping this leaves an orphan row pointing
      // at a design system that no longer exists on disk.
      deleteWorkspaceResourceByResourceId(db, 'design_system', req.params.id);
      res.status(204).end();
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.get('/api/craft', async (_req, res) => {
    try {
      let entries;
      try {
        entries = await fsp.readdir(CRAFT_DIR, { withFileTypes: true });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          return res.json({ craft: [] });
        }
        throw err;
      }
      const out = [];
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
        const slug = entry.name.replace(/\.md$/, '');
        try {
          const fullPath = `${CRAFT_DIR}/${entry.name}`;
          const text = await fsp.readFile(fullPath, 'utf8');
          const heading = text.split('\n').find((line) => line.startsWith('# '));
          out.push({
            id: slug,
            label: heading ? heading.replace(/^#+\s*/, '').trim() : slug,
            bytes: Buffer.byteLength(text, 'utf8'),
          });
        } catch {
          // Skip unreadable files; surface what we can.
        }
      }
      res.json({ craft: out });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.get('/api/craft/:id', async (req, res) => {
    try {
      const slug = req.params.id;
      if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
        return res.status(400).json({ error: 'invalid craft id' });
      }
      try {
        const text = await fsp.readFile(`${CRAFT_DIR}/${slug}.md`, 'utf8');
        res.json({ id: slug, body: text });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          return res.status(404).json({ error: 'craft section not found' });
        }
        throw err;
      }
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });
}

export function rewriteDesignSystemShowcaseAssetUrls(
  html: string,
  designSystemId: string,
  baseDir: string,
): string {
  if (!html) return html;
  return html
    .replace(/\b(src|href)=(["'])([^"']+)\2/gi, (match, attr: string, quote: string, raw: string) => {
      const rewritten = rewriteDesignSystemShowcaseAssetUrl(raw, designSystemId, baseDir);
      return rewritten === raw ? match : `${attr}=${quote}${rewritten}${quote}`;
    })
    .replace(/url\(\s*(["']?)([^"')]+)\1\s*\)/gi, (match, quote: string, raw: string) => {
      const rewritten = rewriteDesignSystemShowcaseAssetUrl(raw, designSystemId, baseDir);
      return rewritten === raw ? match : `url(${quote}${rewritten}${quote})`;
    });
}

function rewriteDesignSystemShowcaseAssetUrl(
  rawUrl: string,
  designSystemId: string,
  baseDir: string,
): string {
  const value = rawUrl.trim();
  if (
    value.length === 0
    || value.startsWith('#')
    || value.startsWith('/')
    || /^[a-z][a-z0-9+.-]*:/i.test(value)
  ) {
    return rawUrl;
  }

  const match = /^([^?#]+)([?#].*)?$/.exec(value);
  if (!match) return rawUrl;
  const [, rawPath, suffix = ''] = match;
  if (!rawPath) return rawUrl;
  const relativePath = path.posix.normalize(path.posix.join(baseDir, rawPath));
  if (
    relativePath === '.'
    || relativePath.startsWith('../')
    || path.posix.isAbsolute(relativePath)
  ) {
    return rawUrl;
  }

  const staticUrl = `/api/design-systems/${encodeURIComponent(designSystemId)}/static?path=${encodeURIComponent(relativePath)}`;
  if (suffix.startsWith('?')) return `${staticUrl}&${suffix.slice(1)}`;
  return `${staticUrl}${suffix}`;
}
