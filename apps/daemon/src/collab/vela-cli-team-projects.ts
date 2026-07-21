import type { ProjectMetadata, TeamProject } from '@open-design/contracts';
import type {
  UpsertVelaTeamProjectInput,
  VelaTeamProjectCatalogClient,
  VelaTeamProjectRecord,
  VelaTeamProjectSyncState,
} from '../integrations/vela-team-projects.js';
import {
  runVelaCommand,
  velaWorkspaceCommandOptions,
} from '../integrations/vela-command.js';

const PROJECT_RESOURCE_PREFIX = 'project-';

export type RunVelaTeamProjects = (
  args: string[],
  workspaceId?: string,
) => Promise<string>;
export type RunVelaResources = (
  args: string[],
  workspaceId?: string,
) => Promise<string>;

interface VelaCliTeamProjectCatalogOptions {
  run?: RunVelaTeamProjects;
  runResource?: RunVelaResources;
  supportsTeamProjects?: () => boolean | Promise<boolean>;
  getWorkspaceId?: () => string | null | undefined;
}

export interface VelaTeamProjectCatalog {
  list(): Promise<TeamProject[]>;
  upsert(input: {
    projectId: string;
    resourceId?: string;
    displayName?: string | null;
    syncState?: 'pending_upload' | 'syncing' | 'synced' | 'failed';
    lastSyncedVersionId?: string | null;
    metadata?: Record<string, unknown> | null;
  }): Promise<void>;
  remove(projectId: string): Promise<void>;
}

type TeamProjectWire = {
  projectId?: unknown;
  resourceId?: unknown;
  ownerMemberId?: unknown;
  displayName?: unknown;
  syncState?: unknown;
  lastSyncedVersionId?: unknown;
  metadata?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
};

type TeamProjectsListWire = {
  workspaceId?: unknown;
  projects?: unknown;
};

type SharedResourceWire = {
  id: string;
  teamId: string;
  kind: 'project';
  ownerMemberId: string;
  metadata?: unknown;
  createdAt: string;
  deletedAt?: null;
};

type SharedResourcesListWire = {
  resources?: unknown;
};

export function projectResourceId(projectId: string): string {
  return `${PROJECT_RESOURCE_PREFIX}${projectId}`;
}

export function createVelaCliTeamProjectCatalog(
  options: VelaCliTeamProjectCatalogOptions = {},
): VelaTeamProjectCatalog {
  const run = options.run ?? defaultRunVelaTeamProjects;
  const runResource = options.runResource ?? defaultRunVelaResources;
  const getWorkspaceId = () => options.getWorkspaceId?.()?.trim() || undefined;
  const supportsTeamProjects = createTeamProjectsCapabilityCheck(
    run,
    options.supportsTeamProjects,
    getWorkspaceId,
  );

  async function runJson<T>(args: string[]): Promise<T> {
    const stdout = await run(args, getWorkspaceId());
    const trimmed = stdout.trim();
    if (!trimmed) return {} as T;
    return JSON.parse(trimmed) as T;
  }

  return {
    async list(): Promise<TeamProject[]> {
      if (!(await supportsTeamProjects())) {
        const resources = await listSharedProjectResources(
          runResource,
          getWorkspaceId(),
        );
        return resources.map(toFallbackTeamProject);
      }
      const payload = await runJson<TeamProjectsListWire>(['list']);
      return Array.isArray(payload.projects)
        ? payload.projects.map(toTeamProject).filter((project): project is TeamProject => project != null)
        : [];
    },

    async upsert(input): Promise<void> {
      // Older packaged Vela builds expose only the resource index. The project
      // push writes the same discovery metadata there, so no second catalog
      // write is required in compatibility mode.
      if (!(await supportsTeamProjects())) return;
      const args = [
        'upsert',
        input.projectId,
        '--resource-id',
        input.resourceId ?? projectResourceId(input.projectId),
      ];
      if (input.displayName?.trim()) args.push('--display-name', input.displayName.trim());
      if (input.syncState) args.push('--sync-state', input.syncState);
      if (input.lastSyncedVersionId?.trim()) {
        args.push('--last-synced-version-id', input.lastSyncedVersionId.trim());
      }
      if (input.metadata && Object.keys(input.metadata).length > 0) {
        args.push('--metadata-json', JSON.stringify(input.metadata));
      }
      await run(args, getWorkspaceId());
    },

    async remove(projectId): Promise<void> {
      // The resource adapter removes the resource-index row in compatibility
      // mode; there is no separate catalog row to delete.
      if (!(await supportsTeamProjects())) return;
      await run(['remove', projectId], getWorkspaceId());
    },
  };
}

export function createVelaCliTeamProjectCatalogClient(
  options: VelaCliTeamProjectCatalogOptions = {},
): VelaTeamProjectCatalogClient {
  const run = options.run ?? defaultRunVelaTeamProjects;
  const runResource = options.runResource ?? defaultRunVelaResources;
  const getWorkspaceId = () => options.getWorkspaceId?.()?.trim() || undefined;
  const supportsTeamProjects = createTeamProjectsCapabilityCheck(
    run,
    options.supportsTeamProjects,
    getWorkspaceId,
  );

  async function runJson<T>(args: string[]): Promise<T> {
    const stdout = await run(args, getWorkspaceId());
    const trimmed = stdout.trim();
    if (!trimmed) return {} as T;
    return JSON.parse(trimmed) as T;
  }

  return {
    async list(): Promise<VelaTeamProjectRecord[]> {
      if (!(await supportsTeamProjects())) {
        const resources = await listSharedProjectResources(
          runResource,
          getWorkspaceId(),
        );
        return resources.map(toFallbackVelaTeamProjectRecord);
      }
      const payload = await runJson<TeamProjectsListWire>(['list']);
      return Array.isArray(payload.projects)
        ? payload.projects
            .map((project) => toVelaTeamProjectRecord(project))
            .filter((project): project is VelaTeamProjectRecord => project != null)
        : [];
    },

    async upsert(input: UpsertVelaTeamProjectInput): Promise<VelaTeamProjectRecord | null> {
      // See the catalog adapter above: resource push owns the fallback index.
      if (!(await supportsTeamProjects())) return null;
      const args = [
        'upsert',
        input.projectId,
        '--resource-id',
        input.resourceId,
      ];
      if (input.displayName?.trim()) args.push('--display-name', input.displayName.trim());
      if (input.syncState) args.push('--sync-state', input.syncState);
      if (input.lastSyncedVersionId?.trim()) {
        args.push('--last-synced-version-id', input.lastSyncedVersionId.trim());
      }
      const stdout = await run(args, getWorkspaceId());
      return toVelaTeamProjectRecord(JSON.parse(stdout.trim()) as unknown);
    },
  };
}

export function createVelaCliTeamProjectCatalogClientFromEnv(
  options: VelaCliTeamProjectCatalogOptions = {},
): VelaTeamProjectCatalogClient | null {
  return shouldUseVelaCliTeamProjectCatalog()
    ? createVelaCliTeamProjectCatalogClient(options)
    : null;
}

export function createVelaCliTeamProjectCatalogFromEnv(
  options: VelaCliTeamProjectCatalogOptions = {},
): VelaTeamProjectCatalog | null {
  return shouldUseVelaCliTeamProjectCatalog()
    ? createVelaCliTeamProjectCatalog(options)
    : null;
}

export function shouldUseVelaCliTeamProjectCatalog(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.OD_WORKSPACE_CONTEXT_SOURCE?.trim() === 'vela') return true;
  const explicitTransport = env.OD_TEAM_PROJECTS_TRANSPORT?.trim();
  if (explicitTransport) return explicitTransport === 'vela-cli';
  return env.OD_RESOURCE_TRANSPORT?.trim() === 'vela-cli';
}

function toTeamProject(input: unknown): TeamProject | null {
  if (!input || typeof input !== 'object') return null;
  const record = input as TeamProjectWire;
  // A catalog row is discoverable only after project bytes are durable in the
  // resource hub. Older local data may still contain pending rows from the
  // previous fire-and-forget share flow; hide them so teammates do not open
  // empty project shells.
  if (typeof record.syncState === 'string' && record.syncState !== 'synced') {
    return null;
  }
  if (
    typeof record.projectId !== 'string' ||
    typeof record.ownerMemberId !== 'string' ||
    typeof record.createdAt !== 'string'
  ) {
    return null;
  }
  const project: TeamProject = {
    projectId: record.projectId,
    ownerMemberId: record.ownerMemberId,
    sharedAt: record.createdAt,
  };
  if (typeof record.displayName === 'string' && record.displayName.trim()) {
    project.name = record.displayName.trim();
  }
  const metadata = recordObject(record.metadata);
  if (metadata) {
    if (typeof metadata.skillId === 'string') project.skillId = metadata.skillId;
    if (typeof metadata.designSystemId === 'string') project.designSystemId = metadata.designSystemId;
    const projectMetadata = recordObject(metadata.metadata);
    if (projectMetadata) project.metadata = projectMetadata as unknown as ProjectMetadata;
    if (typeof metadata.createdAt === 'number') project.createdAt = metadata.createdAt;
    if (typeof metadata.updatedAt === 'number') project.updatedAt = metadata.updatedAt;
  }
  if (typeof record.updatedAt === 'string') {
    const updatedAt = Date.parse(record.updatedAt);
    if (Number.isFinite(updatedAt) && project.updatedAt === undefined) project.updatedAt = updatedAt;
  }
  const createdAt = Date.parse(record.createdAt);
  if (Number.isFinite(createdAt) && project.createdAt === undefined) project.createdAt = createdAt;
  return project;
}

function toVelaTeamProjectRecord(input: unknown): VelaTeamProjectRecord | null {
  if (!input || typeof input !== 'object') return null;
  const record = input as TeamProjectWire & {
    id?: unknown;
    workspaceId?: unknown;
    access?: unknown;
    lastSyncedVersionId?: unknown;
  };
  if (
    typeof record.id !== 'string' ||
    typeof record.workspaceId !== 'string' ||
    typeof record.projectId !== 'string' ||
    typeof record.resourceId !== 'string' ||
    typeof record.ownerMemberId !== 'string' ||
    typeof record.syncState !== 'string' ||
    typeof record.createdAt !== 'string' ||
    typeof record.updatedAt !== 'string'
  ) {
    return null;
  }
  const access = record.access && typeof record.access === 'object' && !Array.isArray(record.access)
    ? record.access as Partial<VelaTeamProjectRecord['access']>
    : {};
  return {
    id: record.id,
    workspaceId: record.workspaceId,
    projectId: record.projectId,
    resourceId: record.resourceId,
    ownerMemberId: record.ownerMemberId,
    displayName: typeof record.displayName === 'string' ? record.displayName : null,
    syncState: toVelaSyncState(record.syncState),
    lastSyncedVersionId: typeof record.lastSyncedVersionId === 'string' ? record.lastSyncedVersionId : null,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    access: {
      canView: access.canView ?? true,
      canComment: access.canComment ?? true,
      canEdit: access.canEdit ?? false,
      frozen: access.frozen ?? false,
    },
  };
}

function toVelaSyncState(value: string): VelaTeamProjectSyncState {
  if (value === 'syncing' || value === 'synced' || value === 'failed') return value;
  return 'pending_upload';
}

function recordObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function createTeamProjectsCapabilityCheck(
  run: RunVelaTeamProjects,
  injected?: () => boolean | Promise<boolean>,
  getWorkspaceId?: () => string | undefined,
): () => Promise<boolean> {
  // The packaged dependency can lag the source-built CLI. Probe once per
  // adapter so source builds use the richer catalog while older builds retain
  // resource-index discovery without a version pin.
  let result: Promise<boolean> | null = null;
  return () => {
    if (!injected && run === defaultRunVelaTeamProjects) {
      defaultTeamProjectsCapability ??= run(
        ['--help'],
        getWorkspaceId?.(),
      ).then(
        () => true,
        () => false,
      );
      return defaultTeamProjectsCapability;
    }
    result ??= injected
      ? Promise.resolve().then(injected)
      : run(['--help'], getWorkspaceId?.()).then(
          () => true,
          () => false,
        );
    return result;
  };
}

let defaultTeamProjectsCapability: Promise<boolean> | null = null;

async function listSharedProjectResources(
  runResource: RunVelaResources,
  workspaceId?: string,
): Promise<SharedResourceWire[]> {
  const stdout = await runResource(['shared', '--json'], workspaceId);
  const trimmed = stdout.trim();
  if (!trimmed) return [];
  const payload = JSON.parse(trimmed) as SharedResourcesListWire;
  if (!Array.isArray(payload.resources)) return [];
  return payload.resources.filter(isSharedProjectResource);
}

function isSharedProjectResource(value: unknown): value is SharedResourceWire {
  if (!value || typeof value !== 'object') return false;
  const resource = value as Record<string, unknown>;
  return resource.kind === 'project' &&
    typeof resource.id === 'string' &&
    typeof resource.teamId === 'string' &&
    typeof resource.ownerMemberId === 'string' &&
    typeof resource.createdAt === 'string' &&
    (resource.deletedAt === null || resource.deletedAt === undefined);
}

function toFallbackTeamProject(resource: SharedResourceWire): TeamProject {
  const metadata = recordObject(resource.metadata) ?? {};
  const project: TeamProject = {
    projectId: fallbackProjectId(resource, metadata),
    ownerMemberId: resource.ownerMemberId,
    sharedAt: resource.createdAt,
  };
  if (typeof metadata.name === 'string' && metadata.name.trim()) {
    project.name = metadata.name.trim();
  }
  if (metadata.skillId === null || typeof metadata.skillId === 'string') {
    project.skillId = metadata.skillId;
  }
  if (metadata.designSystemId === null || typeof metadata.designSystemId === 'string') {
    project.designSystemId = metadata.designSystemId;
  }
  if (typeof metadata.createdAt === 'number') project.createdAt = metadata.createdAt;
  if (typeof metadata.updatedAt === 'number') project.updatedAt = metadata.updatedAt;
  const projectMetadata = recordObject(metadata.metadata);
  if (projectMetadata) project.metadata = projectMetadata as unknown as ProjectMetadata;
  return project;
}

function toFallbackVelaTeamProjectRecord(
  resource: SharedResourceWire,
): VelaTeamProjectRecord {
  const metadata = recordObject(resource.metadata) ?? {};
  const project = toFallbackTeamProject(resource);
  const createdAt = resource.createdAt;
  const updatedAt = typeof metadata.updatedAt === 'number' && Number.isFinite(metadata.updatedAt)
    ? new Date(metadata.updatedAt).toISOString()
    : createdAt;
  return {
    id: resource.id,
    workspaceId: resource.teamId,
    projectId: project.projectId,
    resourceId: resource.id,
    ownerMemberId: resource.ownerMemberId,
    displayName: project.name ?? null,
    syncState: 'synced',
    lastSyncedVersionId: null,
    createdAt,
    updatedAt,
    access: {
      canView: true,
      canComment: true,
      canEdit: false,
      frozen: false,
    },
  };
}

function fallbackProjectId(
  resource: SharedResourceWire,
  metadata: Record<string, unknown>,
): string {
  if (typeof metadata.projectId === 'string' && metadata.projectId.trim()) {
    return metadata.projectId.trim();
  }
  const resourceId = resource.id;
  const suffix = resourceId.startsWith(PROJECT_RESOURCE_PREFIX)
    ? resourceId.slice(PROJECT_RESOURCE_PREFIX.length)
    : resourceId;
  try {
    const decoded = JSON.parse(Buffer.from(suffix, 'base64url').toString('utf8')) as unknown;
    if (Array.isArray(decoded) && typeof decoded[2] === 'string' && decoded[2].trim()) {
      return decoded[2].trim();
    }
  } catch {
    // Legacy resource ids are simply `project-<projectId>`.
  }
  return suffix;
}

const defaultRunVelaTeamProjects: RunVelaTeamProjects = (args, workspaceId) =>
  runVelaCommand(
    ['team-projects', ...args],
    velaWorkspaceCommandOptions(workspaceId),
  );

const defaultRunVelaResources: RunVelaResources = (args, workspaceId) =>
  runVelaCommand(
    ['resource', ...args],
    velaWorkspaceCommandOptions(workspaceId),
  );
