// Independent, high-priority gap found during the workspace-team data-isolation
// sprint, out of scope for spec 04 §10/§11: `POST /api/runs` (and its sibling
// `POST /api/chat`, same file) — the actual "send a message" / "create a run"
// path — had ZERO `enforceWorkspace*` coverage. Every OTHER project write
// (rename/delete/duplicate/writeFiles, and comments per §10 fix #4/#6) is
// gated by `enforceWorkspaceResourceMutation('project', …)`; run creation was
// not, so a caller who merely knew a projectId could spawn an agent run
// against a TEAM-bound project without any workspace identity header at all.
//
// This file wires `registerRunRoutes`'s new
// `enforceWorkspaceProjectMutation`/`projectStore` deps to the REAL
// `enforceWorkspaceResourceMutation('project', …)` gate (the same one
// `routes/project/index.ts` builds for its own project routes, and the same
// one `routes/project/comments.ts` borrows — see
// `project-comment-workspace-gate.test.ts`), against a real project bound
// into `workspace_projects` — not a stub — so this exercises the actual
// production wiring at the HTTP layer.

import http from 'node:http';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  closeDatabase,
  ensureWorkspaceProject,
  getWorkspaceProject,
  getWorkspaceProjectByProjectId,
  insertProject,
  openDatabase,
} from '../src/db.js';
import { enforceWorkspaceResourceMutation } from '../src/collab/workspace-resource-mutation.js';
import { createEnforceWorkspaceProjectMutation } from '../src/routes/project/index.js';
import { registerRunRoutes } from '../src/routes/runs.js';
import { connectorService } from '../src/connectors/service.js';

let server: http.Server | null = null;
let tempDir: string | null = null;

afterEach(async () => {
  if (server) {
    const toClose = server;
    server = null;
    await new Promise<void>((resolve) => toClose.close(() => resolve()));
  }
  closeDatabase();
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  tempDir = null;
});

const TEAM_PROJECT = 'p-team-run';
const UNBOUND_PROJECT = 'p-unbound-run';
const WORKSPACE_ID = 'ws-run-gate';
const OWNER_MEMBER_ID = 'member-owner-run';

function sendApiError(res: any, status: number, code: string, message: string) {
  return res.status(status).json({ error: { code, message } });
}

function workspaceHeaders(memberId: string, role: 'owner' | 'admin' | 'member') {
  return {
    'x-od-workspace-id': WORKSPACE_ID,
    'x-od-workspace-member-id': memberId,
    'x-od-workspace-role': role,
  };
}

// A minimal in-memory ChatRunService stub. POST /api/runs only exercises
// create/start/wait on this file's happy path (see the handler in
// ../src/routes/runs.ts) — get/list/statusBody/stream/cancel/isTerminal are
// required by the interface but never reached by this test, so they are
// filled in with harmless no-ops rather than faithfully reproduced.
function createRunsServiceStub() {
  const runs = new Map<string, any>();
  let seq = 0;
  return {
    create(meta: any) {
      const run = {
        id: `run-${++seq}`,
        projectId: typeof meta.projectId === 'string' ? meta.projectId : null,
        // Deliberately left unset: with no conversationId, the handler's
        // post-response `detectSkillPluginCandidateOnRunSuccess` branch
        // (gated on `run.projectId && run.conversationId`) never fires, so
        // this stub does not need a real on-disk project directory.
        conversationId: typeof meta.conversationId === 'string' ? meta.conversationId : null,
        assistantMessageId: typeof meta.assistantMessageId === 'string' ? meta.assistantMessageId : null,
        agentId: typeof meta.agentId === 'string' ? meta.agentId : null,
        status: 'queued',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        events: [],
        clients: new Set(),
      };
      runs.set(run.id, run);
      return run;
    },
    get: (id: string) => runs.get(id) ?? null,
    list: () => [],
    statusBody: (run: any) => ({ ...run }),
    stream: () => {},
    // Intentionally does NOT invoke `starter` — this test only asserts on the
    // HTTP response to POST /api/runs, not on real agent-process spawning.
    start: (run: any) => run,
    wait: async () => ({ status: 'succeeded' }),
    cancel: async () => ({ status: 'canceled' }),
    isTerminal: (status: string) => status === 'succeeded' || status === 'failed' || status === 'canceled',
  };
}

async function startServer(opts?: {
  /**
   * Override the gate wired into `registerRunRoutes`. Defaults to the bare
   * `enforceWorkspaceResourceMutation` call (no last-known-membership
   * cross-check, matching most of this file's tests). The cross-check
   * tests below pass `createEnforceWorkspaceProjectMutation(workspaceContext)`
   * instead — the SAME factory `apps/daemon/src/server.ts` calls for the
   * real `/api/runs` wiring — with a stub `workspaceContext.lastKnown()` so
   * this exercises the real production wiring, not a re-derived copy of it.
   */
  enforceWorkspaceProjectMutation?: (
    req: any,
    res: any,
    sendError: any,
    getWp: any,
    getWpByProjectId: any,
    dbArg: any,
    projectId: string,
    capability: any,
  ) => boolean;
}) {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'od-run-ws-gate-'));
  const db = openDatabase(tempDir);
  const now = Date.now();
  for (const id of [TEAM_PROJECT, UNBOUND_PROJECT]) {
    insertProject(db, { id, name: id, createdAt: now, updatedAt: now });
  }
  ensureWorkspaceProject(db, {
    projectId: TEAM_PROJECT,
    workspaceId: WORKSPACE_ID,
    visibility: 'team',
    createdByWorkspaceMemberId: OWNER_MEMBER_ID,
  });
  // UNBOUND_PROJECT deliberately gets no `workspace_projects` row — the
  // "legacy / never claimed" control case the gate must leave alone
  // (personal / solo usage with no workspace at all).

  const app = express();
  app.use(express.json());
  registerRunRoutes(app, {
    db,
    design: {
      runs: createRunsServiceStub(),
      analytics: { capture: () => {} },
      getAppVersion: () => 'test',
    },
    http: {
      createSseResponse: () => ({ send() {}, end() {}, cleanup() {} }),
      sendApiError,
    },
    paths: { PROJECTS_DIR: tempDir, RUNTIME_DATA_DIR: tempDir },
    agents: {
      detectAgents: async () => [],
      getAgentDef: () => null,
    },
    chat: { startChatRun: async () => undefined },
    lifecycle: { isDaemonShuttingDown: () => false },
    plugins: {
      connectorService,
      detectSkillPluginCandidateOnRunSuccess: () => {},
      firePipelineForRun: () => {},
      loadPluginRegistryView: async () => ({} as any),
      renderPluginBriefTemplate: (template: string) => template,
    },
    telemetry: {
      reportRunCompletionTelemetryFallback: () => {},
      resolveRunProjectKindForAnalytics: () => null,
      runArtifactBaselines: { take: () => undefined },
      runRetryEventsForAnalytics: () => [],
    },
    messages: {
      pinAssistantMessageOnRunCreate: () => {},
      reconcileAssistantMessageOnRunEnd: () => {},
    },
    enforceWorkspaceProjectMutation:
      opts?.enforceWorkspaceProjectMutation ??
      ((req, res, sendError, getWp, getWpByProjectId, dbArg, projectId, capability) =>
        enforceWorkspaceResourceMutation(
          'project',
          req,
          res,
          sendError,
          getWp,
          getWpByProjectId,
          dbArg,
          projectId,
          capability,
        )),
    projectStore: { getWorkspaceProject, getWorkspaceProjectByProjectId },
  } as any);
  const created = http.createServer(app);
  server = created;
  await new Promise<void>((resolve) => created.listen(0, resolve));
  const address = created.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return `http://127.0.0.1:${port}`;
}

describe('POST /api/runs — workspace mutation gate', () => {
  it('rejects a headerless run creation against a team-bound project', async () => {
    const baseUrl = await startServer();
    const resp = await fetch(`${baseUrl}/api/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: TEAM_PROJECT, agentId: 'claude', message: 'hi' }),
    });
    expect(resp.status).toBe(401);
    const payload = await resp.json();
    expect(payload.error.code).toBe('WORKSPACE_CONTEXT_REQUIRED');
  });

  it('allows run creation with a properly-authenticated team member', async () => {
    const baseUrl = await startServer();
    const resp = await fetch(`${baseUrl}/api/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...workspaceHeaders(OWNER_MEMBER_ID, 'owner') },
      body: JSON.stringify({ projectId: TEAM_PROJECT, agentId: 'claude', message: 'hi' }),
    });
    expect(resp.status).toBe(202);
    const payload = await resp.json();
    expect(typeof payload.runId).toBe('string');
  });

  it('still allows a headerless run creation against a never-claimed (legacy) project', async () => {
    const baseUrl = await startServer();
    const resp = await fetch(`${baseUrl}/api/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: UNBOUND_PROJECT, agentId: 'claude', message: 'hi' }),
    });
    expect(resp.status).toBe(202);
    const payload = await resp.json();
    expect(typeof payload.runId).toBe('string');
  });

  it('still allows a headerless run creation with no projectId at all (scratch / non-project usage)', async () => {
    const baseUrl = await startServer();
    const resp = await fetch(`${baseUrl}/api/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId: 'claude', message: 'hi' }),
    });
    expect(resp.status).toBe(202);
    const payload = await resp.json();
    expect(typeof payload.runId).toBe('string');
  });
});

// A member removed from the team keeps sending STALE-BUT-REAL "active"
// workspace headers until their own client's next `/api/workspace/context`
// poll catches up (or the tab is refreshed) — those headers are not forged,
// they were simply true a moment ago. A gate that only compares the
// request's claimed workspaceId/memberStatus against the resource's binding
// row would keep accepting those requests indefinitely (as long as the tab
// stays open). The production gate closes that window itself: `server.ts`
// builds `enforceWorkspaceProjectMutation` via
// `createEnforceWorkspaceProjectMutation(collab.workspaceContext)`, which
// wires `getLastKnownMembership` to `workspaceContext.lastKnown()` — the
// daemon's OWN independently-refreshed membership cache (kept warm by
// `collab/workspace-invalidation-poller.ts`'s background poll and by every
// other in-daemon `.current()` caller), not anything the client asserts.
// `enforceWorkspaceResourceMutation` narrows a stale "active" claim to
// "removed" whenever this cache disagrees for the SAME workspace (see
// `withLastKnownMembership` in `collab/workspace-resource-mutation.ts`,
// already unit-tested in `tests/collab/workspace-resource-mutation.test.ts`).
//
// This block proves `registerRunRoutes` is wired to the SAME factory
// `server.ts` uses for the real `/api/runs` — not a weaker one — so a run
// creation against a team-bound project is cut off within one poll cycle of
// a real removal, instead of "never, as long as the tab stays open".
describe('POST /api/runs — cross-checks stale client headers against the daemon\'s own last-known membership', () => {
  it('rejects a run when headers still claim active membership but the daemon already knows the caller was removed', async () => {
    const workspaceContextStub = {
      lastKnown: () => ({ workspaceId: WORKSPACE_ID, memberStatus: 'removed' as const }),
    };
    const baseUrl = await startServer({
      enforceWorkspaceProjectMutation: createEnforceWorkspaceProjectMutation(workspaceContextStub as any) as any,
    });
    // Headers below are the exact shape a not-yet-refreshed client tab would
    // still be sending a moment after being removed: workspaceId/memberId
    // match, role is 'owner', no `x-od-workspace-member-status` override —
    // i.e. nothing in the request itself looks malicious or stale.
    const resp = await fetch(`${baseUrl}/api/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...workspaceHeaders(OWNER_MEMBER_ID, 'owner') },
      body: JSON.stringify({ projectId: TEAM_PROJECT, agentId: 'claude', message: 'hi' }),
    });
    expect(resp.status).toBe(403);
    const payload = await resp.json();
    expect(payload.error.code).toBe('WORKSPACE_PROJECT_PERMISSION_DENIED');
  });

  it('still allows the same headers when the daemon cache has no opinion yet (never polled this workspace)', async () => {
    const workspaceContextStub = { lastKnown: () => null };
    const baseUrl = await startServer({
      enforceWorkspaceProjectMutation: createEnforceWorkspaceProjectMutation(workspaceContextStub as any) as any,
    });
    const resp = await fetch(`${baseUrl}/api/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...workspaceHeaders(OWNER_MEMBER_ID, 'owner') },
      body: JSON.stringify({ projectId: TEAM_PROJECT, agentId: 'claude', message: 'hi' }),
    });
    expect(resp.status).toBe(202);
    const payload = await resp.json();
    expect(typeof payload.runId).toBe('string');
  });
});
