import type { Express, Response } from 'express';
import type { CollabPresenceMember } from '@open-design/contracts';
import type { CollabRuntime } from '../collab/runtime.js';
import type { PresenceMember } from '../collab/presence-tracker.js';
import type {
  VelaCliPresenceHeartbeatInput,
  VelaCliPresenceLeaveInput,
} from '../collab/vela-cli-collab-client.js';

type PresenceActivity = Exclude<PresenceMember['activity'], undefined>;

export interface CollabPresenceCloudClient {
  heartbeatPresence(
    projectId: string,
    input: VelaCliPresenceHeartbeatInput,
  ): Promise<CollabPresenceMember[]>;
  listPresence(projectId: string): Promise<CollabPresenceMember[]>;
  leavePresence(
    projectId: string,
    input: VelaCliPresenceLeaveInput,
  ): Promise<CollabPresenceMember[]>;
}

export interface RegisterCollabPresenceRoutesDeps {
  collab: Pick<CollabRuntime, 'presence'>;
  cloud?: CollabPresenceCloudClient | null;
  isProjectShared?: (projectId: string) => Promise<boolean>;
  /**
   * The configured cloud route authoritatively rejects projects outside the
   * requested workspace, so a separate remote team-project lookup is redundant.
   */
  cloudAuthorizesProjectPresence?: (projectId: string) => boolean;
}

function readHeartbeat(body: unknown): {
  member: PresenceMember;
  clientId?: string;
  filePath?: string | null;
  activity?: PresenceMember['activity'];
} | null {
  const raw = (body ?? {}) as Record<string, unknown>;
  const memberId = typeof raw.memberId === 'string' ? raw.memberId.trim() : '';
  if (!memberId) return null;
  const member: PresenceMember = { memberId };
  if (typeof raw.name === 'string' && raw.name.trim()) member.name = raw.name.trim();
  if (raw.role === 'owner' || raw.role === 'admin' || raw.role === 'member') member.role = raw.role;
  if (typeof raw.avatarUrl === 'string' || raw.avatarUrl === null) member.avatarUrl = raw.avatarUrl;
  if (typeof raw.filePath === 'string' || raw.filePath === null) member.filePath = raw.filePath;
  if (raw.activity !== undefined) member.activity = raw.activity as PresenceActivity;
  const clientId = typeof raw.clientId === 'string' && raw.clientId.trim()
    ? raw.clientId.trim()
    : memberId;
  const filePath = typeof raw.filePath === 'string' || raw.filePath === null
    ? raw.filePath
    : undefined;
  return {
    member,
    clientId,
    ...(filePath !== undefined ? { filePath } : {}),
    ...(member.activity !== undefined ? { activity: member.activity } : {}),
  };
}

function readLeave(body: unknown): { memberId: string; clientId?: string } | null {
  const raw = (body ?? {}) as Record<string, unknown>;
  const memberId = typeof raw.memberId === 'string' ? raw.memberId.trim() : '';
  if (!memberId) return null;
  const clientId = typeof raw.clientId === 'string' && raw.clientId.trim()
    ? raw.clientId.trim()
    : memberId;
  return { memberId, clientId };
}

function cloudError(res: Response, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return res.status(502).json({ error: 'collab_presence_unavailable', message });
}

/**
 * Team collaboration presence (presence) capability. Members heartbeat while viewing a
 * shared project; clients poll the present set (live cursors were cut, content
 * is polled — the spec). The set is process-local in {@link CollabRuntime}.
 */
export function registerCollabPresenceRoutes(app: Express, deps: RegisterCollabPresenceRoutesDeps): void {
  const { presence } = deps.collab;
  const cloud = deps.cloud ?? null;

  async function projectIsShared(projectId: string): Promise<boolean> {
    if (!deps.isProjectShared) return true;
    try {
      return await deps.isProjectShared(projectId);
    } catch (error) {
      return false;
    }
  }

  function cloudAuthorizesProject(projectId: string): boolean {
    if (!cloud || !deps.cloudAuthorizesProjectPresence) return false;
    try {
      return deps.cloudAuthorizesProjectPresence(projectId);
    } catch {
      return false;
    }
  }

  app.get('/api/projects/:id/presence', async (req, res) => {
    if (
      !cloudAuthorizesProject(req.params.id) &&
      !(await projectIsShared(req.params.id))
    ) {
      return res.json({ present: [] });
    }
    if (cloud) {
      try {
        return res.json({ present: await cloud.listPresence(req.params.id) });
      } catch (error) {
        return cloudError(res, error);
      }
    }
    res.json({ present: presence.present(req.params.id) });
  });

  app.post('/api/projects/:id/presence/heartbeat', async (req, res) => {
    const heartbeat = readHeartbeat(req.body);
    if (!heartbeat) return res.status(400).json({ error: 'memberId required' });
    if (
      !cloudAuthorizesProject(req.params.id) &&
      !(await projectIsShared(req.params.id))
    ) {
      return res.json({ present: [] });
    }
    if (cloud) {
      try {
        return res.json({
          present: await cloud.heartbeatPresence(req.params.id, heartbeat),
        });
      } catch (error) {
        return cloudError(res, error);
      }
    }
    presence.heartbeat(req.params.id, heartbeat.member);
    res.json({ present: presence.present(req.params.id) });
  });

  app.post('/api/projects/:id/presence/leave', async (req, res) => {
    const leave = readLeave(req.body);
    if (!leave) return res.status(400).json({ error: 'memberId required' });
    if (cloud) {
      try {
        return res.json({
          ok: true,
          present: await cloud.leavePresence(req.params.id, leave),
        });
      } catch (error) {
        return cloudError(res, error);
      }
    }
    presence.leave(req.params.id, leave.memberId);
    res.json({ ok: true, present: presence.present(req.params.id) });
  });
}
