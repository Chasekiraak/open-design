// spec 04 §10 fix #4/#6 (recvqbklNGDqYY): before this fix,
// `apps/daemon/src/routes/project/comments.ts` had ZERO `enforceWorkspace*`
// coverage — not "only blocks team, lets personal through" like the other
// three resource types' mutation gate, but literally no gate at all. A
// caller with no workspace identity whatsoever (signed out, a plain `curl`)
// could POST/PATCH/DELETE comments on ANY project, including one bound to a
// team workspace it has never had any relationship with.
//
// This file wires `registerProjectCommentRoutes`'s new
// `enforceWorkspaceProjectMutation`/`sendApiError` deps to the REAL
// `enforceWorkspaceResourceMutation('project', …)` gate (the same one
// `routes/project/index.ts` builds for its own project routes), against a
// real project bound into `workspace_projects` — not a stub — so this is
// exercising the actual production wiring path end to end at the HTTP layer,
// not just the shared gate function in isolation (that is
// `tests/collab/workspace-resource-mutation.test.ts`'s job).

import http from 'node:http';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  closeDatabase,
  deletePreviewComment,
  ensureWorkspaceProject,
  getConversation,
  getPreviewComment,
  getWorkspaceProject,
  getWorkspaceProjectByProjectId,
  insertConversation,
  insertProject,
  listPreviewComments,
  openDatabase,
  reorderPreviewComment,
  updatePreviewCommentAnchor,
  updatePreviewCommentStatus,
  updateProject,
  upsertPreviewComment,
} from '../src/db.js';
import { enforceWorkspaceResourceMutation } from '../src/collab/workspace-resource-mutation.js';
import { registerProjectCommentRoutes } from '../src/routes/project/comments.js';

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

const TEAM_PROJECT = 'p-team';
const PERSONAL_PROJECT = 'p-personal';
const UNBOUND_PROJECT = 'p-unbound';
const WORKSPACE_ID = 'ws-comment-gate';
const OWNER_MEMBER_ID = 'member-owner';

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

const COMMENT_TARGET = {
  filePath: 'index.html',
  elementId: 'hero',
  selector: '[data-od-id="hero"]',
  label: 'h1.hero',
  text: 'Hero',
  htmlHint: '<h1>',
  position: { x: 0, y: 0, width: 0, height: 0 },
};

async function startServer() {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'od-comment-ws-gate-'));
  const db = openDatabase(tempDir);
  const now = Date.now();
  for (const [id, conv] of [
    [TEAM_PROJECT, 'conv-team'],
    [PERSONAL_PROJECT, 'conv-personal'],
    [UNBOUND_PROJECT, 'conv-unbound'],
  ] as const) {
    insertProject(db, { id, name: id, createdAt: now, updatedAt: now });
    insertConversation(db, { id: conv, projectId: id, title: 'Chat', createdAt: now, updatedAt: now });
  }
  ensureWorkspaceProject(db, {
    projectId: TEAM_PROJECT,
    workspaceId: WORKSPACE_ID,
    visibility: 'team',
    createdByWorkspaceMemberId: OWNER_MEMBER_ID,
  });
  ensureWorkspaceProject(db, {
    projectId: PERSONAL_PROJECT,
    workspaceId: WORKSPACE_ID,
    visibility: 'personal',
    createdByWorkspaceMemberId: OWNER_MEMBER_ID,
  });
  // UNBOUND_PROJECT deliberately gets no `workspace_projects` row — the
  // "legacy / never claimed" control case the gate must leave alone.

  const app = express();
  app.use(express.json());
  registerProjectCommentRoutes(app, {
    db,
    projectStore: { updateProject, getWorkspaceProject, getWorkspaceProjectByProjectId } as any,
    conversations: {
      getConversation,
      listPreviewComments,
      upsertPreviewComment,
      getPreviewComment,
      updatePreviewCommentStatus,
      updatePreviewCommentAnchor,
      deletePreviewComment,
      reorderPreviewComment,
    } as any,
    sendApiError,
    enforceWorkspaceProjectMutation: (req, res, sendError, getWp, getWpByProjectId, dbArg, projectId, capability) =>
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
      ),
    resolveAuthorMemberId: async () => undefined,
  });
  const created = http.createServer(app);
  server = created;
  await new Promise<void>((resolve) => created.listen(0, resolve));
  const address = created.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return `http://127.0.0.1:${port}`;
}

describe('project comments — workspace mutation gate', () => {
  it('rejects a headerless POST (new comment) against a team-bound project', async () => {
    const baseUrl = await startServer();
    const resp = await fetch(`${baseUrl}/api/projects/${TEAM_PROJECT}/conversations/conv-team/comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target: COMMENT_TARGET, note: 'hi' }),
    });
    expect(resp.status).toBe(401);
  });

  it('rejects a headerless PATCH (status transition) against a team-bound project', async () => {
    const baseUrl = await startServer();
    // Seed a comment with a member header first (allowed — owner), then
    // retry the status PATCH with no headers at all.
    const create = await fetch(`${baseUrl}/api/projects/${TEAM_PROJECT}/conversations/conv-team/comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...workspaceHeaders(OWNER_MEMBER_ID, 'owner') },
      body: JSON.stringify({ target: COMMENT_TARGET, note: 'hi' }),
    });
    expect(create.status).toBe(200);
    const { comment } = (await create.json()) as { comment: { id: string } };

    const resp = await fetch(
      `${baseUrl}/api/projects/${TEAM_PROJECT}/conversations/conv-team/comments/${comment.id}`,
      { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'resolved' }) },
    );
    expect(resp.status).toBe(401);
  });

  it('rejects a headerless DELETE against a team-bound project', async () => {
    const baseUrl = await startServer();
    const create = await fetch(`${baseUrl}/api/projects/${TEAM_PROJECT}/conversations/conv-team/comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...workspaceHeaders(OWNER_MEMBER_ID, 'owner') },
      body: JSON.stringify({ target: COMMENT_TARGET, note: 'hi' }),
    });
    const { comment } = (await create.json()) as { comment: { id: string } };

    const resp = await fetch(
      `${baseUrl}/api/projects/${TEAM_PROJECT}/conversations/conv-team/comments/${comment.id}`,
      { method: 'DELETE' },
    );
    expect(resp.status).toBe(401);
  });

  // The exact recvqbklNGDqYY-shaped regression: BEFORE this fix, the shared
  // gate's null-ctx branch only refused `visibility: 'team'`, so a headerless
  // caller could still write to a `personal`-but-CLAIMED project's comments.
  it('rejects a headerless POST against a personal-visibility (but bound) project too', async () => {
    const baseUrl = await startServer();
    const resp = await fetch(`${baseUrl}/api/projects/${PERSONAL_PROJECT}/conversations/conv-personal/comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target: COMMENT_TARGET, note: 'hi' }),
    });
    expect(resp.status).toBe(401);
  });

  it('still allows a headerless POST/PATCH/DELETE against a never-claimed (legacy) project', async () => {
    const baseUrl = await startServer();
    const create = await fetch(`${baseUrl}/api/projects/${UNBOUND_PROJECT}/conversations/conv-unbound/comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target: COMMENT_TARGET, note: 'hi' }),
    });
    expect(create.status).toBe(200);
    const { comment } = (await create.json()) as { comment: { id: string } };

    const patch = await fetch(
      `${baseUrl}/api/projects/${UNBOUND_PROJECT}/conversations/conv-unbound/comments/${comment.id}`,
      { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'resolved' }) },
    );
    expect(patch.status).toBe(200);

    const del = await fetch(
      `${baseUrl}/api/projects/${UNBOUND_PROJECT}/conversations/conv-unbound/comments/${comment.id}`,
      { method: 'DELETE' },
    );
    expect(del.status).toBe(200);
  });

  it('allows a properly-authenticated team member to POST/PATCH/DELETE against the team-bound project', async () => {
    const baseUrl = await startServer();
    const create = await fetch(`${baseUrl}/api/projects/${TEAM_PROJECT}/conversations/conv-team/comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...workspaceHeaders(OWNER_MEMBER_ID, 'owner') },
      body: JSON.stringify({ target: COMMENT_TARGET, note: 'hi' }),
    });
    expect(create.status).toBe(200);
    const { comment } = (await create.json()) as { comment: { id: string } };

    const patch = await fetch(
      `${baseUrl}/api/projects/${TEAM_PROJECT}/conversations/conv-team/comments/${comment.id}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...workspaceHeaders(OWNER_MEMBER_ID, 'owner') },
        body: JSON.stringify({ status: 'resolved' }),
      },
    );
    expect(patch.status).toBe(200);

    const del = await fetch(
      `${baseUrl}/api/projects/${TEAM_PROJECT}/conversations/conv-team/comments/${comment.id}`,
      { method: 'DELETE', headers: workspaceHeaders(OWNER_MEMBER_ID, 'owner') },
    );
    expect(del.status).toBe(200);
  });
});
