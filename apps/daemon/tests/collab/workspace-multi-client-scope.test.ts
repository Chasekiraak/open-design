import { describe, expect, it } from 'vitest';
import { createVelaWorkspaceContextProvider } from '../../src/collab/vela-workspace-context.js';

// Two clients, ONE account. This suite models B (vela) exactly as its source
// behaves today, so the account-level Active Workspace can be reasoned about
// without a live backend:
//
//  - `active_workspace_selections` is keyed by app_user_id ALONE
//    (db/schema/public.hcl:792 `primary_key { columns = [column.app_user_id] }`),
//    so the account has exactly one selection — there is no client/device axis.
//  - `GET /api/v1/workspaces/current` DISCARDS a `?workspaceId=` hint. The
//    handler never reads the query (services/api/src/workspaces/routes.ts:166-176
//    only sets workspaceId when team workspaces are DISABLED) and vela locks
//    that in by name: test "ignores URL workspace hints when resolving
//    server-owned current context" (services/api/test/workspaces-personal.test.ts:480).
//  - `PUT /api/v1/workspaces/current` moves that single account-level row.
//  - `GET /api/v1/workspaces` (the membership directory) is scoped by
//    app_user_id, NOT by the selection (services/api/src/workspaces/routes.ts:460),
//    so it answers the same for every client of the account.

const TEAM = 'ws-team-1';
const PERSONAL = 'ws-personal-1';

const B_TEAM_CONTEXT = {
  userId: 'auth-user-1',
  appUserId: 'app-user-1',
  workspaceId: TEAM,
  workspaceName: 'Team',
  workspaceType: 'team',
  workspaceMemberId: 'wm-1',
  role: 'member',
  memberStatus: 'active',
  lifecycleState: 'active',
  billingState: 'active',
  planId: 'team-pro',
  providerMode: 'platform_credits',
  seatSummary: { seatLimit: 5, usedSeats: 2, availableSeats: 3, isSeatFull: false },
};

const B_PERSONAL_CONTEXT = {
  ...B_TEAM_CONTEXT,
  workspaceId: PERSONAL,
  workspaceName: 'Personal',
  workspaceType: 'personal',
  workspaceMemberId: 'wm-p1',
  role: 'owner',
  planId: 'personal-pro',
};

const DIRECTORY = {
  items: [
    {
      workspaceId: TEAM,
      workspaceName: 'Team',
      workspaceType: 'team',
      workspaceMemberId: 'wm-1',
      role: 'member',
      memberStatus: 'active',
      lifecycleState: 'active',
    },
    {
      workspaceId: PERSONAL,
      workspaceName: 'Personal',
      workspaceType: 'personal',
      workspaceMemberId: 'wm-p1',
      role: 'owner',
      memberStatus: 'active',
      lifecycleState: 'active',
    },
  ],
};

const SESSION = {
  profile: 'prod',
  apiUrl: 'https://vela.example',
  controlKey: 'ck-1',
  user: null,
  configMtimeMs: null,
};

function jsonResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

/** One vela account: one selection row, shared by every client that signs in. */
function createOneAccountVela(initialSelection: string) {
  const bodies: Record<string, unknown> = {
    [TEAM]: B_TEAM_CONTEXT,
    [PERSONAL]: B_PERSONAL_CONTEXT,
  };
  let selection = initialSelection;
  let currentReads = 0;
  let directoryReads = 0;

  const fetchImpl = (async (url: URL | string, init?: RequestInit) => {
    const u = String(url);
    const method = init?.method ?? 'GET';
    if (u.includes('/workspaces/current') && method === 'PUT') {
      const body = JSON.parse(String(init?.body ?? '{}')) as { workspaceId?: string };
      if (body.workspaceId) selection = body.workspaceId;
      return jsonResponse(200, bodies[selection]);
    }
    if (u.includes('/workspaces/current') && method === 'GET') {
      currentReads += 1;
      // The `?workspaceId=` hint OD appends is dropped on the floor here,
      // exactly as vela's handler drops it.
      return jsonResponse(200, bodies[selection]);
    }
    if (u.endsWith('/api/v1/workspaces') && method === 'GET') {
      directoryReads += 1;
      return jsonResponse(200, DIRECTORY);
    }
    throw new Error(`unexpected fetch ${method} ${u}`);
  }) as unknown as typeof fetch;

  return {
    fetchImpl,
    selection: () => selection,
    currentReads: () => currentReads,
    directoryReads: () => directoryReads,
  };
}

/** One OD daemon: its own local pin, sharing the account's vela session. */
function createClient(vela: ReturnType<typeof createOneAccountVela>, pinned: string) {
  let pin: string | null = pinned;
  const provider = createVelaWorkspaceContextProvider({
    fetch: vela.fetchImpl,
    readSession: () => SESSION,
    getActiveWorkspaceId: () => pin,
    setLocalSelection: (id) => {
      pin = id;
    },
    clearLocalSelection: () => {
      pin = null;
    },
  });
  return {
    pin: () => pin,
    context: () => provider.current({}),
    /** What OD's PUT /api/workspace/active does: move B, then move the pin. */
    async switchTo(workspaceId: string) {
      const switched = await provider.selectWorkspace?.(workspaceId);
      if (switched) pin = workspaceId;
      return switched;
    },
  };
}

describe('one account, two clients, one account-level Active Workspace', () => {
  it('does NOT hand a client the other client’s workspace — the local pin holds', async () => {
    const vela = createOneAccountVela(TEAM);
    const clientA = createClient(vela, TEAM);
    const clientB = createClient(vela, PERSONAL);

    // Client B switches. This moves the ONE account-level row.
    expect(await clientB.switchTo(PERSONAL)).toBe(true);
    expect(vela.selection()).toBe(PERSONAL);

    // Client A reads its context next. B's `current` now answers PERSONAL for
    // the whole account, but A must stay on its own pinned TEAM scope.
    const a = await clientA.context();
    expect(a?.workspaceId).toBe(TEAM);
    expect(clientA.pin()).toBe(TEAM);
  });

  it('DOES degrade the losing client’s billing/seat context to a directory synthesis', async () => {
    const vela = createOneAccountVela(TEAM);
    const clientA = createClient(vela, TEAM);
    const clientB = createClient(vela, PERSONAL);

    // While the account-level row still points at A's workspace, A gets B's
    // rich context: real plan id and real seat counts.
    const enriched = await clientA.context();
    expect(enriched?.planId).toBe('team-pro');
    expect(enriched?.seatSummary).toEqual({
      seatLimit: 5,
      usedSeats: 2,
      availableSeats: 3,
      isSeatFull: false,
    });
    const directoryReadsWhileWinning = vela.directoryReads();

    // Client B switches away. Nothing about A's workspace, membership, plan or
    // seats changed — only which workspace the ACCOUNT row names.
    await clientB.switchTo(PERSONAL);

    const degraded = await clientA.context();
    // Same workspace…
    expect(degraded?.workspaceId).toBe(TEAM);
    // …but the billing plane is gone, because B's `current` can only describe
    // ONE workspace per account and OD must fall back to synthesizing A's
    // context from the membership directory, which carries no billing data.
    expect(degraded?.planId).toBeNull();
    // Worse than merely blank: a 0/0 seat summary derives `isSeatFull: true`,
    // so the losing client reads its own healthy 3-free-seat workspace as
    // full. The seat gate is a client-side check (#115), which makes this a
    // user-visible block on inviting, not just a cosmetic badge.
    expect(degraded?.seatSummary).toEqual({
      seatLimit: 0,
      usedSeats: 0,
      availableSeats: 0,
      isSeatFull: true,
    });
    expect(enriched?.seatSummary.isSeatFull).toBe(false);
    // And it costs an extra round-trip that the winning client never pays.
    expect(vela.directoryReads()).toBeGreaterThan(directoryReadsWhileWinning);
  });

  it('makes the losing client’s context read depend on a second, fallible call', async () => {
    // Same setup, but the directory read fails once — a blip that the winning
    // client would never even notice, because it never makes that call.
    const vela = createOneAccountVela(PERSONAL);
    let failDirectory = false;
    const fetchImpl = (async (url: URL | string, init?: RequestInit) => {
      if (String(url).endsWith('/api/v1/workspaces') && failDirectory) {
        throw new Error('directory blip');
      }
      return (vela.fetchImpl as unknown as typeof fetch)(url as never, init as never);
    }) as unknown as typeof fetch;

    const clientA = createClient({ ...vela, fetchImpl }, TEAM);

    failDirectory = true;
    // B's account row says PERSONAL, A is pinned to TEAM, so A can only resolve
    // its own scope through the directory — and that call just failed.
    expect(await clientA.context()).toBeNull();
    // The pin survives (nothing was confirmed), but this client has NO context
    // for a full poll tick purely because another client owns the account row.
    expect(clientA.pin()).toBe(TEAM);

    failDirectory = false;
    expect((await clientA.context())?.workspaceId).toBe(TEAM);
  });

  it('lets each client yank the other’s server-side scope on every switch', async () => {
    const vela = createOneAccountVela(TEAM);
    const clientA = createClient(vela, TEAM);
    const clientB = createClient(vela, PERSONAL);

    await clientB.switchTo(PERSONAL);
    expect(vela.selection()).toBe(PERSONAL);

    // A switches back to its own workspace — a purely local UI action — and in
    // doing so re-points the account row out from under client B. Whatever on
    // the vela side still resolves a workspace from that row (rather than from
    // an explicit parameter) is now aimed at A's workspace for BOTH clients.
    await clientA.switchTo(TEAM);
    expect(vela.selection()).toBe(TEAM);
    expect(clientB.pin()).toBe(PERSONAL);
  });
});
