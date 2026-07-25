import type { Express } from 'express';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  workspaceContextHasWorkspaceIdentity,
  type ProjectMetadata,
  type ProjectSyncIntentEvent,
  type TeamProject,
  type WorkspaceCollabContext,
} from '@open-design/contracts';
import type { CollabRuntime } from '../collab/runtime.js';
import {
  contextToResourceHubPrincipal,
  type ResourceHubPrincipal,
} from '../collab/resource-principal.js';
import { parseVelaResourceSnapshot, runVelaResourceCommand } from '../collab/vela-cli-resource-adapter.js';
import { readVelaControlApiContext } from '../integrations/vela.js';
import { readProjectManifest } from '../project-locations.js';

/** The fields register-on-pull reads out of a pulled project's manifest. */
export interface PulledProjectManifest {
  name?: string;
  skillId?: string | null;
  designSystemId?: string | null;
  createdAt?: number;
  updatedAt?: number;
}

export interface RegisterPulledProjectInput {
  id: string;
  name: string;
  skillId: string | null;
  designSystemId: string | null;
  metadata?: ProjectMetadata;
  createdAt: number;
  updatedAt: number;
}

export interface TeamMirrorPullScope {
  workspaceId: string;
  resourceTeamId: string;
  viewerMemberId: string;
  ownerMemberId: string;
}

export interface PulledProjectStore {
  get?: (projectId: string) => { name?: string | null } | null;
  has(projectId: string): boolean;
  register(input: RegisterPulledProjectInput): void;
  update?: (input: RegisterPulledProjectInput) => void;
  /**
   * Atomically materialize the project row and its active team binding, then
   * return only after a strict readback proves the mirror is mutation-gated.
   */
  materializeTeamMirror?: (
    input: RegisterPulledProjectInput,
    scope: TeamMirrorPullScope,
  ) => { localRecordChanged: boolean };
}

export interface RegisterCollabSyncRoutesDeps {
  collab: Pick<
    CollabRuntime,
    | 'scheduler'
    | 'publishedVersion'
    | 'publishedHead'
    | 'projectSyncState'
    | 'projectOwnerMemberId'
    | 'requestTeamShare'
    | 'requestTeamUnshare'
    | 'pullLatest'
    | 'workspaceContext'
  >;
  resolveSharedProjectOwner?: (projectId: string) => Promise<string | null>;
  resolveSharedProject?: (
    projectId: string,
    scope?: TeamMirrorPullScope | null,
  ) => Promise<TeamProject | null>;
  /** Set/clear the non-destructive "team mirror revoked" flag on a local
   *  project so read routes stop serving a project that has left the team. */
  markTeamProjectRevoked?: (projectId: string, revoked: boolean) => void;
  resolveOwnerDisplayName?: (
    memberId: string,
  ) => Promise<{ displayName: string; role: 'owner' | 'admin' | 'member' } | null>;
  projectStore?: PulledProjectStore;
  resolveProjectDir?: (projectId: string) => string | Promise<string>;
  resolvePullDir?: (projectId: string) => string;
  readManifest?: (projectDir: string) => Promise<PulledProjectManifest | null>;
  onTeamShareStateChanged?: (input: {
    projectId: string;
    principal?: ResourceHubPrincipal | null;
    visibility: 'personal' | 'team';
    ownerMemberId?: string | null;
    updatedByMemberId?: string | null;
  }) => void;
  /**
   * Notify any live `/api/projects/:id/events` SSE subscribers that this
   * project's files changed on disk. Called after a successful
   * `POST /collab/pull` materializes new content.
   *
   * This is NOT redundant with the project's chokidar watcher: the `vela
   * resource pull` transport materializes a pulled project by replacing its
   * ENTIRE directory (a fresh inode every pull, confirmed via `stat` across
   * repeated pulls against a live resource-hub project) rather than updating
   * files in place. A chokidar watch established before that swap keeps
   * watching the OLD (now-orphaned) directory handle and silently stops
   * firing — so the member's own currently-open FileViewer tab never saw
   * `file-changed`, even though `/collab/status` and the file's bytes on disk
   * were both already correct (recvq6CIesNvWZ). Firing this explicit signal
   * right after the pull we know just landed sidesteps the swap entirely
   * instead of depending on chokidar surviving it.
   */
  notifyFilesChanged?: (projectId: string) => void;
  /**
   * Notify any live `/api/projects/:id/events` SSE subscribers that this
   * project's LOCAL record (name / skill / design-system) changed as part of
   * a pull. `registerPulledProject` is what replaces the "共享项目"
   * placeholder record with the real project name — but that write is
   * DB-only, and the only other post-pull signal (`notifyFilesChanged`)
   * refreshes the file list, never the project record. Without this signal a
   * member web that seeded its `projects` state from the placeholder keeps
   * rendering "共享项目" in the sidebar/tab until a full page reload
   * (recvqhwv6RPU1j). Wired to the existing `project-metadata-changed` thin
   * event; fired only when the pull actually registered or updated the local
   * record, so steady-state content pulls emit nothing.
   */
  notifyProjectMetadataChanged?: (projectId: string) => void;
}

/** Result of one shared-project content pull — the same flow whether it was
 *  reached over `POST /api/projects/:id/collab/pull` or daemon-internally
 *  through {@link CollabSyncRoutesHandle.pullSharedProject}. */
export type CollabSyncPullOutcome =
  | { status: 'pulled'; version: number | null }
  | { status: 'revoked' }
  | { status: 'register_failed' };

/** Daemon-internal surface `registerCollabSyncRoutes` hands back so non-HTTP
 *  callers (the hub push channel's proactive content pull, server.ts) can run
 *  the same pull flow the POST route runs. */
export interface CollabSyncRoutesHandle {
  /**
   * Materialize the latest published content for a shared project, exactly as
   * `POST /api/projects/:id/collab/pull` would: revocation gate, owner-routed
   * hub pull, register-on-pull, and the `file-changed` /
   * `project-metadata-changed` signals. The viewer principal is derived from
   * the daemon's own workspace context (there is no request to read headers
   * from). Concurrent pulls for the same project+scope — including a member
   * web's racing POST — coalesce onto one in-flight materialization.
   */
  pullSharedProject(projectId: string, scope: TeamMirrorPullScope): Promise<CollabSyncPullOutcome>;
}

const SYNC_INTENT_EVENTS: ReadonlySet<ProjectSyncIntentEvent> = new Set([
  'project_visibility_changed',
  'project_team_share_requested',
  'project_team_unshare_requested',
]);
const PULLED_PROJECT_PLACEHOLDER_NAME = '共享项目';
const PUBLIC_FILE_RESOURCE_KIND = 'project';
const PUBLIC_FILE_REF = 'published';

interface PublicFilePublication {
  url: string;
  slug: string;
  fileName: string;
}

const publicFilePublications = new Map<string, PublicFilePublication>();

function cleanPulledProjectName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.replace(/\s+/g, ' ').trim();
  if (!trimmed || trimmed === 'index.html') return null;
  return trimmed;
}

async function readJsonObject(filePath: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed = JSON.parse(await readFile(filePath, 'utf8')) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

async function inferNameFromSkillManifest(projectDir: string): Promise<string | null> {
  const skillsDir = path.join(projectDir, '.od-skills');
  let entries: string[];
  try {
    entries = await readdir(skillsDir);
  } catch {
    return null;
  }
  for (const entry of entries) {
    const manifest = await readJsonObject(path.join(skillsDir, entry, 'open-design.json'));
    const title = cleanPulledProjectName(manifest?.title);
    if (title) return title;
    const name = cleanPulledProjectName(manifest?.name);
    if (name) return name;
  }
  return null;
}

async function inferNameFromHtmlTitle(projectDir: string): Promise<string | null> {
  try {
    const html = await readFile(path.join(projectDir, 'index.html'), 'utf8');
    const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    return cleanPulledProjectName(match?.[1]?.replace(/<[^>]*>/g, ''));
  } catch {
    return null;
  }
}

async function resolvePulledProjectName(
  projectDir: string,
  manifest: PulledProjectManifest | null,
): Promise<string> {
  return cleanPulledProjectName(manifest?.name)
    ?? await inferNameFromSkillManifest(projectDir)
    ?? await inferNameFromHtmlTitle(projectDir)
    ?? PULLED_PROJECT_PLACEHOLDER_NAME;
}

function headerValue(req: { get(name: string): string | undefined }, name: string): string | null {
  const value = req.get(name);
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function headerBool(req: { get(name: string): string | undefined }, name: string, fallback: boolean): boolean {
  const value = headerValue(req, name);
  if (value === null) return fallback;
  if (value === 'false') return false;
  if (value === 'true') return true;
  return fallback;
}

function headerPrincipalForRequest(req: { get(name: string): string | undefined }): ResourceHubPrincipal | null {
  const teamId = headerValue(req, 'x-od-workspace-id');
  const memberId = headerValue(req, 'x-od-workspace-member-id');
  if (!teamId || !memberId) return null;
  const role = headerValue(req, 'x-od-workspace-role') ?? 'member';
  const lifecycleState = headerValue(req, 'x-od-workspace-lifecycle-state') ?? 'active';
  return {
    teamId,
    memberId,
    role: role === 'owner' || role === 'admin' ? role : 'member',
    lifecycleState:
      lifecycleState === 'billing_past_due' ||
      lifecycleState === 'locked' ||
      lifecycleState === 'deleting' ||
      lifecycleState === 'deleted'
        ? lifecycleState
        : 'active',
  };
}

function normalizePublicFilePath(raw: string): string | null {
  if (raw.includes('\\')) return null;
  let decoded: string;
  try {
    decoded = raw
      .split('/')
      .map((part) => decodeURIComponent(part))
      .join('/');
  } catch {
    return null;
  }
  if (decoded.includes('\\')) return null;
  const normalized = decoded.replace(/^\/+/, '').replace(/\/+/g, '/');
  if (
    !normalized ||
    normalized.includes('\0') ||
    normalized.split('/').some((part) => part === '' || part === '.' || part === '..')
  ) {
    return null;
  }
  return normalized;
}

async function resolvePublicSourceFile(projectDir: string, filePath: string): Promise<string> {
  const [projectRoot, candidate] = await Promise.all([
    realpath(projectDir),
    realpath(path.join(projectDir, filePath)),
  ]);
  const relative = path.relative(projectRoot, candidate);
  if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
    return candidate;
  }
  const error = new Error('public file path escapes project root') as NodeJS.ErrnoException;
  error.code = 'EACCES';
  throw error;
}

function publicFileResourceIdFor(
  projectId: string,
  filePath: string,
  principal: ResourceHubPrincipal,
): string {
  const scoped = Buffer.from(
    JSON.stringify([principal.teamId, principal.memberId, projectId, filePath]),
    'utf8',
  ).toString('base64url');
  return `project-file-${scoped}`;
}

function publicFilePublicationKey(projectId: string, filePath: string, principal: ResourceHubPrincipal): string {
  return JSON.stringify([principal.teamId, principal.memberId, projectId, filePath]);
}

function encodePublicFileUrlPath(filePath: string): string {
  return filePath.split('/').map((part) => encodeURIComponent(part)).join('/');
}

/**
 * The 409 body for a public-file request that has no team workspace behind it.
 *
 * Public links are snapshots in the workspace resource hub, which only a team
 * workspace can address (`workspaceContextHasTeamIdentity`). A personal or
 * signed-out session — and a team session whose context read momentarily fails —
 * lands here. Ship a sentence alongside the code so every surface that is not
 * the web UI (the `od` CLI, embedding agents) states the reason instead of
 * echoing `WORKSPACE_IDENTITY_REQUIRED` at a human. The web UI localizes the
 * code itself; see `publicFilePublishFailureKey` in apps/web.
 */
function workspaceIdentityRequiredBody() {
  return {
    error: 'WORKSPACE_IDENTITY_REQUIRED',
    message:
      'Publishing a public link needs a signed-in workspace. Sign in to Open Design Cloud, ' +
      'or use Deploy to publish this file without one.',
  };
}

/**
 * Resource-hub principal for the PUBLIC SINGLE-FILE publish routes.
 *
 * These routes deliberately do NOT use `contextToResourceHubPrincipal`, which
 * requires `workspaceContextHasTeamIdentity` and is still exactly right for team
 * project sharing (a shared project needs teammates to share WITH).
 *
 * A public file link needs no such thing. The hub addresses purely by workspace
 * id, and B stopped refusing a personal workspace on its control-key auth path:
 * `authenticateSession` now mints a principal whose `teamId` IS the workspace id
 * — "a partition of one" — and `resolveAccess` only ever compares that id with
 * the resource's own. So the real requirement here is A workspace, not a TEAM
 * workspace: an id to publish under and a member id to own the resource with.
 *
 * A signed-out session still has neither, and is still refused — this widens the
 * gate, it does not remove it. The web UI must gate its entry point on the SAME
 * rule (`canPublishPublicFile` in apps/web/src/collab/public-file-publish.ts);
 * a button that renders where this returns 409 is the bug this pair exists to
 * prevent.
 */
function publicFilePrincipal(context: WorkspaceCollabContext | null): ResourceHubPrincipal | null {
  if (!workspaceContextHasWorkspaceIdentity(context) || !context) return null;
  // The predicate above already proved both ids are present; this is the type
  // narrowing TS needs, not a second copy of the rule.
  const { workspaceId, workspaceMemberId } = context;
  if (!workspaceId || !workspaceMemberId) return null;
  return {
    memberId: workspaceMemberId,
    // Personal workspaces carry no `teamId`; the workspace id is the scope.
    teamId: context.teamId ?? workspaceId,
    role: context.role,
    lifecycleState: context.lifecycleState,
    workspaceType: context.workspaceType,
  };
}

function publicResourceHubBaseUrl(): string | null {
  return readVelaControlApiContext()?.apiUrl?.trim() || process.env.OD_RESOURCE_HUB_URL?.trim() || null;
}

function publicSnapshotFileUrl(baseUrl: string, slug: string, filePath: string): string {
  const relative = `/api/v1/public/snapshots/${encodeURIComponent(slug)}/files/${encodePublicFileUrlPath(filePath)}`;
  return new URL(relative, baseUrl).toString();
}

async function resolveSharedProjectForPublicFile(
  resolveSharedProject: RegisterCollabSyncRoutesDeps['resolveSharedProject'],
  projectId: string,
): Promise<{ ok: true; project: TeamProject | null } | { ok: false }> {
  try {
    return { ok: true, project: await resolveSharedProject?.(projectId) ?? null };
  } catch (error) {
    console.warn('[od] failed to resolve public file project ownership:', error);
    return { ok: false };
  }
}

export function registerCollabSyncRoutes(
  app: Express,
  deps: RegisterCollabSyncRoutesDeps,
): CollabSyncRoutesHandle {
  const {
    scheduler,
    publishedVersion,
    publishedHead,
    projectSyncState,
    projectOwnerMemberId,
    requestTeamShare,
    requestTeamUnshare,
    pullLatest,
    workspaceContext,
  } = deps.collab;
  const {
    projectStore,
    resolveProjectDir,
    resolvePullDir,
    resolveSharedProjectOwner,
    resolveSharedProject,
    markTeamProjectRevoked,
    resolveOwnerDisplayName,
    notifyFilesChanged,
    notifyProjectMetadataChanged,
  } = deps;
  const readManifest = deps.readManifest ?? readProjectManifest;

  async function principalForRequest(req: {
    get(name: string): string | undefined;
    headers: { authorization?: string | string[] | undefined };
  }) {
    const authorization = Array.isArray(req.headers.authorization)
      ? req.headers.authorization[0]
      : req.headers.authorization;
    return headerPrincipalForRequest(req) ?? contextToResourceHubPrincipal(await workspaceContext.current({ authorization }));
  }

  /**
   * Principal for the public single-file publish routes only. Same header
   * short-circuit as `principalForRequest` (tests and the CLI assert identity
   * through headers), but the context fallback accepts ANY workspace — see
   * `publicFilePrincipal` for why a personal workspace is a valid publisher.
   */
  async function publicFilePrincipalForRequest(req: {
    get(name: string): string | undefined;
    headers: { authorization?: string | string[] | undefined };
  }) {
    const authorization = Array.isArray(req.headers.authorization)
      ? req.headers.authorization[0]
      : req.headers.authorization;
    return headerPrincipalForRequest(req) ?? publicFilePrincipal(await workspaceContext.current({ authorization }));
  }

  async function resourcePrincipalForSharedProject(
    projectId: string,
    // Null for daemon-internal callers (the proactive content pull) — there is
    // no request to read identity headers from, so the viewer principal comes
    // straight from the workspace context.
    req: {
      get(name: string): string | undefined;
      headers: { authorization?: string | string[] | undefined };
    } | null,
  ): Promise<ResourceHubPrincipal | null> {
    const viewerPrincipal = req
      ? await principalForRequest(req)
      : contextToResourceHubPrincipal(await workspaceContext.current({}));
    // Only the owner id is needed to route the pull/head at the resource hub, so
    // read it through the cached owner resolver rather than the uncached
    // resolveSharedProject — this keeps /collab/status and the pull principal off
    // a fresh catalog round-trip. Revocation still uses the uncached
    // resolveSharedProject in the pull gate.
    let ownerMemberId: string | null = null;
    try {
      ownerMemberId = (await resolveSharedProjectOwner?.(projectId)) ?? null;
    } catch {
      ownerMemberId = null;
    }
    if (!ownerMemberId || !viewerPrincipal?.teamId) {
      return viewerPrincipal;
    }
    return {
      ...viewerPrincipal,
      memberId: ownerMemberId,
      role: ownerMemberId === viewerPrincipal.memberId ? viewerPrincipal.role : 'member',
    };
  }

  async function pullAccessForRequest(
    projectId: string,
    req: {
      get(name: string): string | undefined;
      headers: { authorization?: string | string[] | undefined };
    },
  ): Promise<{ principal: ResourceHubPrincipal | null; scope: TeamMirrorPullScope | null }> {
    const headerPrincipal = headerPrincipalForRequest(req);
    const authorization = Array.isArray(req.headers.authorization)
      ? req.headers.authorization[0]
      : req.headers.authorization;
    const context = await workspaceContext.current({ authorization });
    const viewerPrincipal = headerPrincipal ?? contextToResourceHubPrincipal(context);
    let ownerMemberId: string | null = null;
    try {
      ownerMemberId = (await resolveSharedProjectOwner?.(projectId)) ?? null;
    } catch {
      ownerMemberId = null;
    }
    const workspaceId = headerPrincipal
      ? req.get('x-od-workspace-id') ?? headerPrincipal.teamId
      : context?.workspaceId;
    const contextMatchesViewer =
      context?.workspaceType === 'team' &&
      context.memberStatus === 'active' &&
      context.lifecycleState === 'active' &&
      context.workspaceId === workspaceId &&
      context.workspaceMemberId === viewerPrincipal?.memberId;
    const resourceTeamId = contextMatchesViewer
      ? context.teamId ?? context.workspaceId
      : viewerPrincipal?.teamId;
    const scope =
      ownerMemberId &&
      viewerPrincipal &&
      workspaceId &&
      resourceTeamId &&
      (headerPrincipal != null || context?.workspaceType === 'team')
        ? {
            workspaceId,
            resourceTeamId,
            viewerMemberId: viewerPrincipal.memberId,
            ownerMemberId,
          }
        : null;
    const principal = ownerMemberId && viewerPrincipal?.teamId
      ? {
          ...viewerPrincipal,
          ...(scope ? { teamId: scope.resourceTeamId } : {}),
          memberId: ownerMemberId,
          role: ownerMemberId === viewerPrincipal.memberId ? viewerPrincipal.role : 'member' as const,
        }
      : viewerPrincipal;
    return { principal, scope };
  }

  async function canShareProjectsForRequest(req: {
    get(name: string): string | undefined;
    headers: { authorization?: string | string[] | undefined };
  }) {
    const headerPrincipal = headerPrincipalForRequest(req);
    if (headerPrincipal) {
      const legacyWriteEnabled = headerBool(req, 'x-od-workspace-write-enabled', true);
      const canWriteSyncedFiles = headerBool(req, 'x-od-workspace-can-write-synced-files', legacyWriteEnabled);
      return headerBool(req, 'x-od-workspace-can-share-projects', canWriteSyncedFiles);
    }
    const authorization = Array.isArray(req.headers.authorization)
      ? req.headers.authorization[0]
      : req.headers.authorization;
    return (await workspaceContext.current({ authorization }))?.permissions.canShareProjects ?? false;
  }

  async function capturedScopeIsStillActive(scope: TeamMirrorPullScope): Promise<boolean> {
    try {
      const context = await workspaceContext.current({});
      return Boolean(
        context &&
        context.workspaceType === 'team' &&
        context.memberStatus === 'active' &&
        context.lifecycleState === 'active' &&
        context.workspaceId === scope.workspaceId &&
        (context.teamId ?? context.workspaceId) === scope.resourceTeamId &&
        context.workspaceMemberId === scope.viewerMemberId
      );
    } catch {
      return false;
    }
  }

  interface PreparedPulledProjectRegistration {
    existing: { name?: string | null } | null;
    fallbackName: string;
    manifest: PulledProjectManifest | null;
    now: number;
    projectId: string;
  }

  async function preparePulledProjectRegistration(
    projectId: string,
    scope: TeamMirrorPullScope | null,
  ): Promise<PreparedPulledProjectRegistration | null> {
    if (!projectStore || !resolvePullDir) {
      if (scope) throw new Error('team mirror project store unavailable');
      return null;
    }
    const existing = projectStore.get?.(projectId);
    if (!scope) {
      if (!existing && projectStore.has(projectId)) return null;
      if (existing && cleanPulledProjectName(existing.name) !== PULLED_PROJECT_PLACEHOLDER_NAME) return null;
    }
    const projectDir = resolvePullDir(projectId);
    let manifest: PulledProjectManifest | null = null;
    try {
      manifest = await readManifest(projectDir);
    } catch {
      manifest = null;
    }
    return {
      existing: existing ?? null,
      fallbackName: await resolvePulledProjectName(projectDir, manifest),
      manifest,
      now: Date.now(),
      projectId,
    };
  }

  /**
   * Register/refresh the local project record for a just-pulled shared
   * project. This function is deliberately synchronous: a scoped caller does
   * its final authoritative catalog read and workspace-identity check
   * immediately before entering the SQLite transaction, with no ambient
   * metadata await able to reopen a workspace/unshare race in between.
   */
  function registerPreparedPulledProject(
    prepared: PreparedPulledProjectRegistration | null,
    scope: TeamMirrorPullScope | null,
    teamProject: TeamProject | null,
  ): boolean {
    if (!prepared || !projectStore) return false;
    const { existing, fallbackName, manifest, now, projectId } = prepared;
    const input = {
      id: projectId,
      name: cleanPulledProjectName(teamProject?.name) ?? fallbackName,
      skillId: teamProject?.skillId ?? manifest?.skillId ?? null,
      designSystemId: teamProject?.designSystemId ?? manifest?.designSystemId ?? null,
      ...(teamProject?.metadata ? { metadata: teamProject.metadata } : {}),
      createdAt: typeof teamProject?.createdAt === 'number'
        ? teamProject.createdAt
        : typeof manifest?.createdAt === 'number'
          ? manifest.createdAt
          : now,
      updatedAt: typeof teamProject?.updatedAt === 'number'
        ? teamProject.updatedAt
        : typeof manifest?.updatedAt === 'number'
          ? manifest.updatedAt
          : now,
    };
    if (scope) {
      if (!projectStore.materializeTeamMirror) {
        throw new Error('team mirror materializer unavailable');
      }
      return projectStore.materializeTeamMirror(input, scope).localRecordChanged;
    }
    if (existing) {
      if (!projectStore.update) return false;
      projectStore.update(input);
      return true;
    }
    projectStore.register(input);
    return true;
  }

  /**
   * Register a minimal placeholder project record the moment a member opens a
   * shared project they don't have locally yet — synchronously, with no hub
   * round-trip. Without it `getProject` fails for the multi-second window before
   * the resource pull materializes the project, and every project route
   * (conversations, events SSE, tabs, files) 404s. The web answers those 404s
   * with retry storms + EventSource reconnects — the request flood that made a
   * shared project take tens of seconds to open. The post-pull
   * `registerPulledProject` overwrites the placeholder name with the real one;
   * this is a no-op once the project is known locally.
   */
  function ensureSharedProjectPlaceholder(projectId: string): void {
    if (!projectStore || projectStore.has(projectId)) return;
    const now = Date.now();
    projectStore.register({
      id: projectId,
      name: PULLED_PROJECT_PLACEHOLDER_NAME,
      skillId: null,
      designSystemId: null,
      createdAt: now,
      updatedAt: now,
    });
  }

  app.post('/api/projects/:id/collab/changed', (req, res) => {
    scheduler.notifyChanged(req.params.id, 'change');
    res.json({ ok: true });
  });

  app.post('/api/projects/:id/collab/publish', (req, res) => {
    scheduler.notifyChanged(req.params.id, 'run');
    scheduler.runBoundary(req.params.id);
    res.json({ ok: true });
  });

  app.post(/^\/api\/projects\/([^/]+)\/files\/(.+)\/publish-public$/u, async (req, res) => {
    const params = req.params as unknown as { 0?: string; 1?: string };
    const projectId = String(params[0] ?? '');
    const filePath = normalizePublicFilePath(String(params[1] ?? ''));
    if (!projectId || !filePath) {
      return res.status(400).json({ error: 'invalid_file_path' });
    }
    const principal = await publicFilePrincipalForRequest(req);
    if (!principal) {
      return res.status(409).json(workspaceIdentityRequiredBody());
    }
    if (!await canShareProjectsForRequest(req)) {
      return res.status(403).json({ error: 'WORKSPACE_PROJECT_SHARE_DENIED' });
    }
    const sharedProjectResult = await resolveSharedProjectForPublicFile(resolveSharedProject, projectId);
    if (!sharedProjectResult.ok) {
      return res.status(503).json({ error: 'WORKSPACE_PROJECT_OWNERSHIP_UNAVAILABLE' });
    }
    const sharedProject = sharedProjectResult.project;
    if (sharedProject?.ownerMemberId && sharedProject.ownerMemberId !== principal.memberId) {
      return res.status(403).json({ error: 'WORKSPACE_PROJECT_PUBLISH_DENIED' });
    }
    const baseUrl = publicResourceHubBaseUrl();
    if (!baseUrl) {
      return res.status(502).json({ error: 'PUBLIC_FILE_URL_UNAVAILABLE' });
    }
    if (!resolveProjectDir) {
      return res.status(500).json({ error: 'PROJECT_DIR_UNAVAILABLE' });
    }

    const projectDir = await resolveProjectDir(projectId);
    let data: Buffer;
    try {
      const sourceFile = await resolvePublicSourceFile(projectDir, filePath);
      data = await readFile(sourceFile);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      return res.status(code === 'ENOENT' ? 404 : 400).json({
        error: code === 'ENOENT' ? 'FILE_NOT_FOUND' : 'FILE_UNAVAILABLE',
      });
    }

    const resourceId = publicFileResourceIdFor(projectId, filePath, principal);
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'od-public-file-'));
    try {
      const targetFile = path.join(tempDir, filePath);
      await mkdir(path.dirname(targetFile), { recursive: true });
      await writeFile(targetFile, data);
      const metadata = {
        source: 'open-design',
        projectId,
        fileName: filePath,
      };
      await runVelaResourceCommand([
        'push',
        PUBLIC_FILE_RESOURCE_KIND,
        resourceId,
        tempDir,
        '--ref',
        PUBLIC_FILE_REF,
        '--metadata-json',
        JSON.stringify(metadata),
        '--json',
      ], principal.teamId);
      const snapshot = parseVelaResourceSnapshot(await runVelaResourceCommand([
        'snapshot',
        resourceId,
        '--ref',
        PUBLIC_FILE_REF,
        '--name',
        path.basename(filePath),
        '--json',
      ], principal.teamId));
      if (!snapshot) {
        return res.status(502).json({ error: 'PUBLIC_SNAPSHOT_UNAVAILABLE' });
      }
      const publication = {
        url: publicSnapshotFileUrl(baseUrl, snapshot.slug, filePath),
        slug: snapshot.slug,
        fileName: filePath,
      };
      publicFilePublications.set(publicFilePublicationKey(projectId, filePath, principal), publication);
      return res.json(publication);
    } catch (error) {
      console.warn('[od] failed to publish public project file:', error);
      return res.status(502).json({ error: 'PUBLIC_FILE_PUBLISH_UNAVAILABLE' });
    } finally {
      await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  app.delete(/^\/api\/projects\/([^/]+)\/files\/(.+)\/publish-public$/u, async (req, res) => {
    const params = req.params as unknown as { 0?: string; 1?: string };
    const projectId = String(params[0] ?? '');
    const filePath = normalizePublicFilePath(String(params[1] ?? ''));
    const slug = typeof (req.body as { slug?: unknown } | undefined)?.slug === 'string'
      ? (req.body as { slug: string }).slug.trim()
      : '';
    if (!projectId || !filePath || !slug) {
      return res.status(400).json({ error: 'invalid_public_file' });
    }
    const principal = await publicFilePrincipalForRequest(req);
    if (!principal) {
      return res.status(409).json(workspaceIdentityRequiredBody());
    }
    if (!await canShareProjectsForRequest(req)) {
      return res.status(403).json({ error: 'WORKSPACE_PROJECT_SHARE_DENIED' });
    }
    const sharedProjectResult = await resolveSharedProjectForPublicFile(resolveSharedProject, projectId);
    if (!sharedProjectResult.ok) {
      return res.status(503).json({ error: 'WORKSPACE_PROJECT_OWNERSHIP_UNAVAILABLE' });
    }
    const sharedProject = sharedProjectResult.project;
    if (sharedProject?.ownerMemberId && sharedProject.ownerMemberId !== principal.memberId) {
      return res.status(403).json({ error: 'WORKSPACE_PROJECT_PUBLISH_DENIED' });
    }
    const resourceId = publicFileResourceIdFor(projectId, filePath, principal);
    try {
      await runVelaResourceCommand([
        'snapshot-redact',
        resourceId,
        slug,
        '--json',
      ], principal.teamId);
      publicFilePublications.delete(publicFilePublicationKey(projectId, filePath, principal));
      return res.json({ ok: true, slug, fileName: filePath });
    } catch (error) {
      console.warn('[od] failed to unpublish public project file:', error);
      return res.status(502).json({ error: 'PUBLIC_FILE_UNPUBLISH_UNAVAILABLE' });
    }
  });

  app.get(/^\/api\/projects\/([^/]+)\/files\/(.+)\/publish-public$/u, async (req, res) => {
    const params = req.params as unknown as { 0?: string; 1?: string };
    const projectId = String(params[0] ?? '');
    const filePath = normalizePublicFilePath(String(params[1] ?? ''));
    if (!projectId || !filePath) {
      return res.status(400).json({ error: 'invalid_file_path' });
    }
    const principal = await publicFilePrincipalForRequest(req);
    if (!principal) {
      return res.status(409).json(workspaceIdentityRequiredBody());
    }
    if (!await canShareProjectsForRequest(req)) {
      return res.status(403).json({ error: 'WORKSPACE_PROJECT_SHARE_DENIED' });
    }
    const sharedProjectResult = await resolveSharedProjectForPublicFile(resolveSharedProject, projectId);
    if (!sharedProjectResult.ok) {
      return res.status(503).json({ error: 'WORKSPACE_PROJECT_OWNERSHIP_UNAVAILABLE' });
    }
    const sharedProject = sharedProjectResult.project;
    if (sharedProject?.ownerMemberId && sharedProject.ownerMemberId !== principal.memberId) {
      return res.status(403).json({ error: 'WORKSPACE_PROJECT_PUBLISH_DENIED' });
    }
    return res.json({
      publication: publicFilePublications.get(publicFilePublicationKey(projectId, filePath, principal)) ?? null,
    });
  });

  app.post('/api/projects/:id/collab/sync-intent', async (req, res) => {
    const event = (req.body as { event?: unknown } | undefined)?.event;
    if (typeof event !== 'string' || !SYNC_INTENT_EVENTS.has(event as ProjectSyncIntentEvent)) {
      return res.status(400).json({ error: 'invalid sync intent event' });
    }
    const projectId = req.params.id;
    const principal = await principalForRequest(req);
    const context = await workspaceContext.current({ authorization: req.headers.authorization });

    if (event === 'project_team_share_requested') {
      if (!(await canShareProjectsForRequest(req))) {
        return res.status(403).json({ error: 'WORKSPACE_PROJECT_SHARE_DENIED' });
      }
      const sharerMemberId = principal?.memberId ?? context?.workspaceMemberId;
      const existingSharedProject = await resolveSharedProject?.(projectId) ?? null;
      if (
        existingSharedProject?.ownerMemberId &&
        existingSharedProject.ownerMemberId !== sharerMemberId
      ) {
        return res.json({
          ok: true,
          syncState: 'synced',
          publishedVersion: publishedVersion(projectId, principal),
        });
      }
      let nextPublishedVersion: number | null;
      try {
        ({ version: nextPublishedVersion } = await requestTeamShare(projectId, principal ?? sharerMemberId));
      } catch (error) {
        console.warn('[od] failed to publish team-shared project bytes:', error);
        return res.status(502).json({ error: 'TEAM_PROJECT_PUBLISH_UNAVAILABLE' });
      }
      if (nextPublishedVersion == null) {
        return res.status(502).json({ error: 'TEAM_PROJECT_PUBLISH_UNAVAILABLE' });
      }
      deps.onTeamShareStateChanged?.({
        projectId,
        principal,
        visibility: 'team',
        ownerMemberId: sharerMemberId ?? null,
        updatedByMemberId: sharerMemberId ?? null,
      });
      return res.json({
        ok: true,
        syncState: projectSyncState(projectId, principal),
        publishedVersion: nextPublishedVersion,
      });
    }

    if (event === 'project_team_unshare_requested') {
      if (!(await canShareProjectsForRequest(req))) {
        return res.status(403).json({ error: 'WORKSPACE_PROJECT_SHARE_DENIED' });
      }
      const callerMemberId = principal?.memberId ?? context?.workspaceMemberId;
      const sharedProject = await resolveSharedProject?.(projectId) ?? null;
      const ownerMemberId = sharedProject?.ownerMemberId ?? projectOwnerMemberId(projectId, principal);
      if (ownerMemberId && ownerMemberId !== callerMemberId) {
        return res.status(403).json({ error: 'WORKSPACE_PROJECT_UNSHARE_DENIED' });
      }
      await requestTeamUnshare(projectId, principal);
      deps.onTeamShareStateChanged?.({
        projectId,
        principal,
        visibility: 'personal',
        ownerMemberId,
        updatedByMemberId: callerMemberId ?? null,
      });
    }

    res.json({ ok: true, syncState: projectSyncState(projectId, principal) });
  });

  /**
   * The one shared-project content pull flow, shared verbatim between
   * `POST /api/projects/:id/collab/pull` and the daemon-internal handle
   * (`CollabSyncRoutesHandle.pullSharedProject`, driven by the hub push
   * channel's proactive pull). Extracted so the two entry points cannot
   * drift: revocation gate → hub pull → register-on-pull → post-pull
   * signals, in that order.
   */
  async function pullSharedProjectOnce(
    projectId: string,
    principal: ResourceHubPrincipal | null,
    scope: TeamMirrorPullScope | null,
  ): Promise<CollabSyncPullOutcome> {
    if (scope && !(await capturedScopeIsStillActive(scope))) {
      return { status: 'register_failed' };
    }
    // Revocation gate: a project may only be pulled while it is still shared to
    // the caller's team. Once the owner moves it out of the team its catalog
    // entry disappears, and a stale local copy must stop syncing new content.
    // A transient catalog/hub lookup error falls through to the existing pull
    // path rather than hard-denying a legitimate pull.
    let authoritativeSharedProject: TeamProject | null = null;
    if (resolveSharedProject) {
      let stillShared = true;
      try {
        authoritativeSharedProject = await resolveSharedProject(projectId, scope);
        stillShared = authoritativeSharedProject != null &&
          (!scope || authoritativeSharedProject.ownerMemberId === scope.ownerMemberId);
      } catch {
        if (scope) return { status: 'register_failed' };
        stillShared = true;
      }
      if (scope && !(await capturedScopeIsStillActive(scope))) {
        return { status: 'register_failed' };
      }
      if (!stillShared) {
        // The project has left the team: mark the stale local mirror revoked so
        // its files stop being served (non-destructive — files remain on disk).
        markTeamProjectRevoked?.(projectId, true);
        return { status: 'revoked' };
      }
    } else if (scope) {
      return { status: 'register_failed' };
    }
    const result = await pullLatest(projectId, principal);
    if (result.version !== null) {
      let prepared: PreparedPulledProjectRegistration | null = null;
      try {
        prepared = await preparePulledProjectRegistration(projectId, scope);
      } catch (error) {
        console.warn('[od] failed to prepare pulled team project:', error);
        return { status: 'register_failed' };
      }

      // The initial catalog result only authorized starting the transfer. The
      // owner may unshare while bytes are in flight, so scoped materialization
      // requires a second uncached authoritative read after every other async
      // metadata operation has completed.
      if (scope) {
        try {
          authoritativeSharedProject = await resolveSharedProject!(projectId, scope);
        } catch {
          return { status: 'register_failed' };
        }
        if (!authoritativeSharedProject) {
          markTeamProjectRevoked?.(projectId, true);
          return { status: 'revoked' };
        }
        if (authoritativeSharedProject.ownerMemberId !== scope.ownerMemberId) {
          return { status: 'register_failed' };
        }
        // Keep this check adjacent to the synchronous SQLite transaction.
        // Nothing below may await before materializeTeamMirror revalidates the
        // binding and commits it.
        if (!(await capturedScopeIsStillActive(scope))) {
          return { status: 'register_failed' };
        }
      } else if (resolveSharedProject) {
        try {
          authoritativeSharedProject = await resolveSharedProject(projectId, null);
        } catch {
          authoritativeSharedProject = null;
        }
      }

      let localRecordChanged = false;
      try {
        localRecordChanged = registerPreparedPulledProject(
          prepared,
          scope,
          authoritativeSharedProject,
        );
      } catch (error) {
        console.warn('[od] failed to register pulled team project:', error);
        return { status: 'register_failed' };
      }
      // The pull already materialized new bytes on disk at this point —
      // notify now rather than relying on the project's chokidar watcher,
      // which the pull's directory-replace can silently orphan (see
      // `notifyFilesChanged`'s doc comment). A currently-open FileViewer tab
      // for this project refreshes on the same `file-changed` path a real
      // local edit would take.
      notifyFilesChanged?.(projectId);
      if (localRecordChanged) {
        // The register above swapped the "共享项目" placeholder record for
        // the real name (or first-registered the record): push the existing
        // `project-metadata-changed` thin signal so the open project view
        // re-reads the record and the sidebar/tab title follows without a
        // manual reload (recvqhwv6RPU1j).
        notifyProjectMetadataChanged?.(projectId);
      }
    }
    // A successful pull means the project is shared again (or still is): clear
    // any prior revocation so its files are served normally.
    markTeamProjectRevoked?.(projectId, false);
    return { status: 'pulled', version: result.version };
  }

  // In-flight pulls keyed by project + resource-hub scope. A hub-event
  // proactive pull and a member web's poll-triggered POST that race each
  // other coalesce onto ONE materialization (the `vela resource pull`
  // transport replaces the whole project directory, so a duplicate pull is a
  // full-tree transfer, not a cheap no-op). The scope key includes the
  // principal's team + member ids because the same project can be shared
  // under more than one scope (see `scopedProjectKey` in collab/runtime.ts) —
  // only identically-routed pulls may share a result.
  const pullsInFlight = new Map<string, Promise<CollabSyncPullOutcome>>();

  function pullSharedProjectCoalesced(
    projectId: string,
    principal: ResourceHubPrincipal | null,
    scope: TeamMirrorPullScope | null,
  ): Promise<CollabSyncPullOutcome> {
    const key = JSON.stringify([
      projectId,
      principal?.teamId ?? null,
      principal?.memberId ?? null,
      scope?.viewerMemberId ?? null,
    ]);
    const existing = pullsInFlight.get(key);
    if (existing) return existing;
    const run = (async () => {
      try {
        return await pullSharedProjectOnce(projectId, principal, scope);
      } finally {
        pullsInFlight.delete(key);
      }
    })();
    pullsInFlight.set(key, run);
    return run;
  }

  app.post('/api/projects/:id/collab/pull', async (req, res) => {
    const projectId = req.params.id;
    const { principal, scope } = await pullAccessForRequest(projectId, req);
    const outcome = await pullSharedProjectCoalesced(projectId, principal, scope);
    if (outcome.status === 'revoked') {
      return res.status(403).json({ error: 'WORKSPACE_PROJECT_PULL_DENIED' });
    }
    if (outcome.status === 'register_failed') {
      return res.status(502).json({ error: 'TEAM_PROJECT_PULL_REGISTER_UNAVAILABLE' });
    }
    res.json({ ok: true, version: outcome.version });
  });

  app.get('/api/projects/:id/collab/status', async (req, res) => {
    const projectId = req.params.id;
    const principal = await principalForRequest(req);
    let syncState = projectSyncState(projectId, principal);
    let ownerMemberId = projectOwnerMemberId(projectId, principal);
    let ownerDisplayName: string | undefined;
    let ownerRole: 'owner' | 'admin' | 'member' | undefined;
    // Resolve ownership first through the CACHED hub owner lookup. This decides
    // whether the project is shared at all — and a project that is local-only AND
    // unowned on the hub is a genuine personal project with no hub-published head.
    // Answering its version from local state lets us skip the uncached ~2s
    // publishedHead round-trip that otherwise ran on every status poll. That hub
    // call was the reason a member's OWN project flashed the "shared read-only"
    // notice for seconds after opening: the front end fails closed until
    // /collab/status confirms ownership, so a slow status made the flash long.
    if (ownerMemberId == null && resolveSharedProjectOwner) {
      try {
        const hubOwner = await resolveSharedProjectOwner(projectId);
        if (hubOwner != null) {
          if (syncState === 'local_only') syncState = 'synced';
          ownerMemberId = hubOwner;
        }
      } catch {
        // Hub unavailable: fall back to the local state.
      }
    }
    // The caller owns the project when the resolved owner id matches their own
    // member id. The owner is the single writer of their own project: the front
    // end shows them an editable surface (not the "shared by X" banner) and they
    // never auto-pull, so they need NEITHER the owner display-name directory
    // lookup NOR the hub published-head round-trip. Both are uncached ~1-3s vela
    // calls, and running them made a member's own shared project sit in the
    // fail-closed "shared read-only" state (disabled history/share, disabled
    // composer) for tens of seconds before /collab/status confirmed ownership.
    const callerIsOwner =
      ownerMemberId != null && principal?.memberId != null && ownerMemberId === principal.memberId;
    // Anyone opening a shared project absent from this daemon's local DB needs
    // the placeholder so the project's other routes stop 404ing while the pull
    // runs (see ensureSharedProjectPlaceholder). This covers BOTH a member
    // viewing someone else's shared project AND an owner opening their OWN shared
    // project that was created/shared on another machine (or attributed to them
    // by a smoke test) and never materialized here: the owner never auto-pulls,
    // so without this its conversations/events/tabs 404 forever and the left pane
    // hangs for a minute. ensureSharedProjectPlaceholder no-ops once the project
    // is known locally, so an owner's normal local project is untouched. The web
    // polls /collab/status on open, so this fires before the conversations/events
    // retry storm builds up.
    if (ownerMemberId) {
      ensureSharedProjectPlaceholder(projectId);
    }
    // The owner display-name directory lookup and the hub published-head
    // round-trip are BOTH uncached ~1-2s vela calls, and ONLY a non-owner member
    // of a shared project needs either one (the owner never auto-pulls and shows
    // no "shared by X" banner). They are independent, so run them concurrently:
    // serialized, they made a member's /collab/status a ~2x round-trip, delaying
    // the "shared by X" banner and the read-only state for their combined time.
    // Only a NON-OWNER member of a shared project needs the hub-published head: it
    // drives their auto-pull cursor. The owner reads their (newest) version from
    // local state, and a local-only project has no hub head at all.
    const needsHubHead = (syncState !== 'local_only' || ownerMemberId != null) && !callerIsOwner;
    const [ownerNameEntry, head] = await Promise.all([
      ownerMemberId && !callerIsOwner && resolveOwnerDisplayName
        ? resolveOwnerDisplayName(ownerMemberId).catch(() => null)
        : Promise.resolve(null),
      needsHubHead
        ? (async () => {
            const resourcePrincipal = await resourcePrincipalForSharedProject(projectId, req);
            try {
              return await publishedHead(projectId, resourcePrincipal);
            } catch {
              return publishedVersion(projectId, principal);
            }
          })()
        : Promise.resolve(publishedVersion(projectId, principal)),
    ]);
    if (ownerNameEntry) {
      ownerDisplayName = ownerNameEntry.displayName;
      ownerRole = ownerNameEntry.role;
    }
    res.json({
      publishedVersion: head,
      syncState,
      ownerMemberId,
      ...(ownerDisplayName ? { ownerDisplayName } : {}),
      ...(ownerRole ? { ownerRole } : {}),
    });
  });

  return {
    async pullSharedProject(
      projectId: string,
      scope: TeamMirrorPullScope,
    ): Promise<CollabSyncPullOutcome> {
      const principal: ResourceHubPrincipal = {
        teamId: scope.resourceTeamId,
        memberId: scope.ownerMemberId,
        role: 'member',
        lifecycleState: 'active',
        workspaceType: 'team',
      };
      return pullSharedProjectCoalesced(projectId, principal, scope);
    },
  };
}
