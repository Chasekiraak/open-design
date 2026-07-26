import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import http from 'node:http';
import { buildWorkspacePermissions, buildWorkspaceSeatSummary } from '@open-design/contracts';
import {
  registerCollabContextRoutes,
  type RegisterCollabContextRoutesDeps,
} from '../src/routes/collab-context.js';
import {
  createDevWorkspaceContextProvider,
  parseWorkspaceCollabContext,
} from '../src/collab/workspace-context.js';

let server: http.Server | null = null;

afterEach(async () => {
  if (server) {
    const toClose = server;
    server = null;
    await new Promise<void>((resolve) => toClose.close(() => resolve()));
  }
});

/** The minimal payload a dev/demo run PUTs — only enum + identity fields. */
const TEAM_CONTEXT = {
  workspaceType: 'team',
  workspaceMemberId: 'wm-1',
  role: 'member',
  memberStatus: 'active',
  lifecycleState: 'active',
  displayName: 'Ma Shu',
};

const ADMIN_CONTEXT = {
  ...TEAM_CONTEXT,
  role: 'admin',
};

/** What `parseWorkspaceCollabContext` returns: the minimal input enriched with the
 *  fields it derives — workspaceId fallback, provider/billing defaults, and the
 *  permissions + seat summary derived through B's shared helpers. */
const TEAM_CONTEXT_PARSED = {
  workspaceId: 'wm-1',
  workspaceType: 'team',
  workspaceMemberId: 'wm-1',
  role: 'member',
  memberStatus: 'active',
  lifecycleState: 'active',
  billingState: 'active',
  planId: null,
  providerMode: 'platform_credits',
  seatSummary: buildWorkspaceSeatSummary({ seatLimit: 5, usedSeats: 1 }),
  permissions: buildWorkspacePermissions({ role: 'member', lifecycleState: 'active' }),
  // Invariant: a team context always carries teamId (the workspace IS the
  // team scope) — collab gates on it, so the parser pins it when omitted.
  teamId: 'wm-1',
  displayName: 'Ma Shu',
};

async function startContextServer(
  overrides: Partial<Omit<RegisterCollabContextRoutesDeps, 'workspaceContext'>> = {},
) {
  const app = express();
  app.use(express.json());
  registerCollabContextRoutes(app, {
    workspaceContext: createDevWorkspaceContextProvider(),
    ...overrides,
  });
  server = http.createServer(app);
  await new Promise<void>((resolve) => server!.listen(0, resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server did not bind to a TCP port');
  const base = `http://127.0.0.1:${address.port}`;
  return {
    async req(
      route: string,
      options: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
    ) {
      const init: RequestInit = { method: options.method ?? 'GET' };
      if (options.headers) init.headers = options.headers;
      if (options.body !== undefined) {
        init.headers = { ...options.headers, 'content-type': 'application/json' };
        init.body = JSON.stringify(options.body);
      }
      const response = await fetch(`${base}${route}`, init);
      return { status: response.status, body: (await response.json()) as Record<string, any> };
    },
  };
}

describe('parseWorkspaceCollabContext', () => {
  it('accepts a well-formed team context and derives permissions/seats', () => {
    expect(parseWorkspaceCollabContext(TEAM_CONTEXT)).toEqual(TEAM_CONTEXT_PARSED);
  });

  it('rejects a bad enum or a missing member id', () => {
    expect(parseWorkspaceCollabContext({ ...TEAM_CONTEXT, role: 'viewer' })).toBeNull();
    expect(parseWorkspaceCollabContext({ ...TEAM_CONTEXT, lifecycleState: 'frozen' })).toBeNull();
    expect(parseWorkspaceCollabContext({ ...TEAM_CONTEXT, workspaceMemberId: '' })).toBeNull();
  });
});

describe('collab context routes', () => {
  it('returns null context before any is set', async () => {
    const api = await startContextServer();
    expect((await api.req('/api/workspace/context')).body).toEqual({ context: null });
  });

  it('round-trips a context set via the dev PUT', async () => {
    const api = await startContextServer();
    const put = await api.req('/api/workspace/context', { method: 'PUT', body: TEAM_CONTEXT });
    expect(put.status).toBe(200);
    expect(put.body).toEqual({ context: TEAM_CONTEXT_PARSED });
    expect((await api.req('/api/workspace/context')).body).toEqual({ context: TEAM_CONTEXT_PARSED });
  });

  it('clears the context on an empty PUT body', async () => {
    const api = await startContextServer();
    await api.req('/api/workspace/context', { method: 'PUT', body: TEAM_CONTEXT });
    const cleared = await api.req('/api/workspace/context', { method: 'PUT', body: {} });
    expect(cleared.body).toEqual({ context: null });
    expect((await api.req('/api/workspace/context')).body).toEqual({ context: null });
  });

  it('rejects an invalid context body', async () => {
    const api = await startContextServer();
    const res = await api.req('/api/workspace/context', { method: 'PUT', body: { workspaceType: 'team' } });
    expect(res.status).toBe(400);
  });
});

describe('workspace billing routes', () => {
  const teamDirectory = (workspaceId = 'wm-1') => [{
    workspaceId,
    workspaceName: 'Workspace',
    workspaceType: 'team' as const,
    workspaceMemberId: 'member-1',
    role: 'member' as const,
    memberStatus: 'active' as const,
    lifecycleState: 'active' as const,
  }];

  // recvqgaMLxEdZX: the URL workspace id is the selection source. Membership
  // authorization comes from the independently fetched directory, not from
  // daemon-global active/current state: two clients may address different
  // workspaces through the same daemon without switching each other.
  it('returns the explicit backend-scoped balance even when current points elsewhere', async () => {
    const accountCalls: string[] = [];
    const workspaceCalls: string[] = [];
    const api = await startContextServer({
      listWorkspaceDirectory: async () => teamDirectory('wm-1'),
      fetchBilling: async () => {
        accountCalls.push('account');
        return {
          workspaceId: null,
          membershipTier: 'team_plus',
          totalAvailableCredits: 1_386_294,
          subscriptionCredits: 1_000_000,
          rechargeCredits: 386_294,
          balanceUsd: '13.86',
          subscriptionStatus: 'active',
          availableActions: ['billing_portal'],
          workspaceBalance: null,
        };
      },
      fetchWorkspaceBalance: async (workspaceId) => {
        workspaceCalls.push(workspaceId);
        return {
          workspaceId: 'wm-1',
          workspaceMemberId: 'member-1',
          balanceUsd: '7.89',
          billingScopeVersion: 2,
          expiresAt: null,
          updatedAt: '2026-07-26T12:00:00Z',
        };
      },
    });
    await api.req('/api/workspace/context', {
      method: 'PUT',
      body: { ...TEAM_CONTEXT, workspaceMemberId: 'wm-other' },
    });

    const res = await api.req('/api/workspace/billing?scope=workspace&workspaceId=wm-1');

    expect(res.status).toBe(200);
    expect(accountCalls).toEqual(['account']);
    expect(workspaceCalls).toEqual(['wm-1']);
    expect(res.body.summary).toMatchObject({
      workspaceId: null,
      membershipTier: 'team_plus',
      workspaceBalance: null,
    });
    expect(res.body.workspaceBalance).toMatchObject({
      workspaceId: 'wm-1',
      balanceUsd: '7.89',
      billingScopeVersion: 2,
    });
  });

  it('returns an authorized atomic workspace plan and wallet snapshot additively', async () => {
    const api = await startContextServer({
      listWorkspaceDirectory: async () => teamDirectory('wm-1'),
      fetchBilling: async () => null,
      fetchWorkspaceBillingProjection: async () => ({
        snapshot: {
          schemaVersion: 1,
          workspaceId: 'wm-1',
          workspaceMemberId: 'member-1',
          billingScopeVersion: 2,
          billing: { billingState: 'active', planId: 'team_plus' },
          wallet: {
            balanceUsd: '7.89',
            expiresAt: null,
            updatedAt: '2026-07-27T00:00:00Z',
          },
          revisions: { billing: 'billing-2', wallet: 'wallet-2' },
        },
        workspaceBalance: {
          workspaceId: 'wm-1',
          workspaceMemberId: 'member-1',
          balanceUsd: '7.89',
          billingScopeVersion: 2,
          expiresAt: null,
          updatedAt: '2026-07-27T00:00:00Z',
        },
      }),
    });

    const res = await api.req('/api/workspace/billing?scope=workspace&workspaceId=wm-1');

    expect(res.status).toBe(200);
    expect(res.body.workspaceSnapshot).toMatchObject({
      workspaceId: 'wm-1',
      workspaceMemberId: 'member-1',
      billing: { billingState: 'active', planId: 'team_plus' },
      revisions: { billing: 'billing-2', wallet: 'wallet-2' },
    });
    expect(res.body.workspaceBalance).toMatchObject({
      workspaceId: 'wm-1',
      workspaceMemberId: 'member-1',
      balanceUsd: '7.89',
    });
  });

  it('single-flights simultaneous exact-scope billing reads in the daemon', async () => {
    let projectionCalls = 0;
    let releaseProjection!: () => void;
    const projectionGate = new Promise<void>((resolve) => {
      releaseProjection = resolve;
    });
    const api = await startContextServer({
      listWorkspaceDirectory: async () => teamDirectory('wm-1'),
      fetchBilling: async () => null,
      fetchWorkspaceBillingProjection: async () => {
        projectionCalls += 1;
        await projectionGate;
        return {
          snapshot: {
            schemaVersion: 1,
            workspaceId: 'wm-1',
            workspaceMemberId: 'member-1',
            billingScopeVersion: 2,
            billing: { billingState: 'active', planId: 'team_plus' },
            wallet: {
              balanceUsd: '7.89',
              expiresAt: null,
              updatedAt: '2026-07-27T00:00:00Z',
            },
            revisions: { billing: 'billing-2', wallet: 'wallet-2' },
          },
          workspaceBalance: {
            workspaceId: 'wm-1',
            workspaceMemberId: 'member-1',
            balanceUsd: '7.89',
            billingScopeVersion: 2,
            expiresAt: null,
            updatedAt: '2026-07-27T00:00:00Z',
          },
        };
      },
    });

    const first = api.req('/api/workspace/billing?scope=workspace&workspaceId=wm-1');
    const second = api.req('/api/workspace/billing?scope=workspace&workspaceId=wm-1');
    await vi.waitFor(() => expect(projectionCalls).toBeGreaterThan(0));
    try {
      expect(projectionCalls).toBe(1);
    } finally {
      releaseProjection();
    }

    const [firstResponse, secondResponse] = await Promise.all([first, second]);
    expect(firstResponse.status).toBe(200);
    expect(secondResponse.status).toBe(200);
    expect(projectionCalls).toBe(1);
    expect(firstResponse.body.workspaceRuntime).toMatchObject({
      workspaceId: 'wm-1',
      workspaceMemberId: 'member-1',
      status: 'fresh',
      revision: '2',
    });
    expect(secondResponse.body.workspaceRuntime).toEqual(firstResponse.body.workspaceRuntime);
  });

  it('clears a known client billing snapshot when membership disappears', async () => {
    let authorized = true;
    const api = await startContextServer({
      listWorkspaceDirectory: async () => authorized ? teamDirectory('wm-1') : [],
      fetchBilling: async () => null,
      fetchWorkspaceBillingProjection: async () => ({
        snapshot: null,
        workspaceBalance: {
          workspaceId: 'wm-1',
          workspaceMemberId: 'member-1',
          balanceUsd: '7.89',
          billingScopeVersion: 2,
          expiresAt: null,
          updatedAt: '2026-07-27T00:00:00Z',
        },
      }),
    });
    const headers = {
      'x-od-workspace-runtime-client-id': 'window-1',
      'x-od-workspace-runtime-generation': '1',
    };

    const initial = await api.req(
      '/api/workspace/billing?scope=workspace&workspaceId=wm-1',
      { headers },
    );
    expect(initial.body.workspaceBalance.balanceUsd).toBe('7.89');
    authorized = false;

    const revoked = await api.req(
      '/api/workspace/billing?scope=workspace&workspaceId=wm-1',
      { headers },
    );
    expect(revoked.status).toBe(200);
    expect(revoked.body).toMatchObject({
      summary: null,
      workspaceBalance: null,
      workspaceSnapshot: null,
      workspaceRuntime: {
        workspaceId: 'wm-1',
        workspaceMemberId: 'member-1',
        status: 'access-revoked',
        errorCode: 'workspace_not_authorized',
      },
    });
  });

  it('retains internal last-good state across a transient directory outage', async () => {
    let directoryAvailable = true;
    let balance = '7.89';
    const api = await startContextServer({
      fetchWorkspaceDirectory: async () => ({
        ok: directoryAvailable,
        items: directoryAvailable ? teamDirectory('wm-1') : [],
      }),
      fetchBilling: async () => null,
      fetchWorkspaceBillingProjection: async () => ({
        snapshot: null,
        workspaceBalance: {
          workspaceId: 'wm-1',
          workspaceMemberId: 'member-1',
          balanceUsd: balance,
          billingScopeVersion: 2,
          expiresAt: null,
          updatedAt: '2026-07-27T00:00:00Z',
        },
      }),
    });
    const request = (generation: string) =>
      api.req('/api/workspace/billing?scope=workspace&workspaceId=wm-1', {
        headers: {
          'x-od-workspace-runtime-client-id': 'window-1',
          'x-od-workspace-runtime-generation': generation,
        },
      });

    expect((await request('1')).body.workspaceBalance.balanceUsd).toBe('7.89');
    directoryAvailable = false;
    const unavailable = await request('1');
    expect(unavailable.status).toBe(200);
    expect(unavailable.body).toMatchObject({
      workspaceBalance: null,
      workspaceRuntime: {
        status: 'error',
        errorCode: 'workspace_directory_unavailable',
      },
    });

    directoryAvailable = true;
    balance = '8.99';
    const recovered = await request('2');
    expect(recovered.body).toMatchObject({
      workspaceBalance: { balanceUsd: '8.99' },
      workspaceRuntime: { status: 'fresh' },
    });
  });

  it('reads the account summary explicitly without requesting a workspace balance', async () => {
    const accountCalls: string[] = [];
    const workspaceCalls: string[] = [];
    const api = await startContextServer({
      fetchBilling: async () => {
        accountCalls.push('account');
        return {
          workspaceId: null,
          membershipTier: '',
          totalAvailableCredits: 0,
          subscriptionCredits: 0,
          rechargeCredits: 0,
          balanceUsd: '0',
          subscriptionStatus: '',
          availableActions: [],
          workspaceBalance: null,
        };
      },
      fetchWorkspaceBalance: async (workspaceId) => {
        workspaceCalls.push(workspaceId);
        return null;
      },
    });

    const res = await api.req('/api/workspace/billing?scope=account');

    expect(res.status).toBe(200);
    expect(accountCalls).toEqual(['account']);
    expect(workspaceCalls).toEqual([]);
    expect(res.body.summary).toMatchObject({ workspaceId: null, workspaceBalance: null });
    expect(res.body.workspaceBalance).toBeNull();
  });

  it('fails closed when the explicit workspace is absent from the membership directory', async () => {
    const calls: string[] = [];
    const api = await startContextServer({
      listWorkspaceDirectory: async () => teamDirectory('wm-1'),
      fetchBilling: async () => {
        calls.push('account');
        return null;
      },
      fetchWorkspaceBalance: async (workspaceId) => {
        calls.push(workspaceId);
        return null;
      },
    });
    await api.req('/api/workspace/context', { method: 'PUT', body: TEAM_CONTEXT });

    const res = await api.req('/api/workspace/billing?scope=workspace&workspaceId=other');

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'workspace_not_authorized' });
    expect(calls).toEqual([]);
  });

  it('rejects missing or contradictory billing scope parameters', async () => {
    const api = await startContextServer();
    expect((await api.req('/api/workspace/billing')).status).toBe(400);
    expect((await api.req('/api/workspace/billing?scope=workspace')).status).toBe(400);
    expect(
      (await api.req('/api/workspace/billing?scope=account&workspaceId=wm-1')).status,
    ).toBe(400);
  });

  it('keeps account metadata separate when the scoped balance is unavailable', async () => {
    const api = await startContextServer({
      listWorkspaceDirectory: async () => teamDirectory(),
      fetchBilling: async () => ({
        workspaceId: null,
        membershipTier: 'team_plus',
        totalAvailableCredits: 10,
        subscriptionCredits: 10,
        rechargeCredits: 0,
        balanceUsd: '999.00',
        subscriptionStatus: 'active',
        availableActions: [],
        workspaceBalance: null,
      }),
      fetchWorkspaceBalance: async () => null,
    });
    await api.req('/api/workspace/context', { method: 'PUT', body: TEAM_CONTEXT });

    const res = await api.req('/api/workspace/billing?scope=workspace&workspaceId=wm-1');

    expect(res.status).toBe(200);
    expect(res.body.summary).toMatchObject({
      membershipTier: 'team_plus',
      balanceUsd: '999.00',
      workspaceBalance: null,
    });
    expect(res.body.workspaceBalance).toBeNull();
  });

  it('preserves a proven workspace balance when the account summary is unavailable', async () => {
    const api = await startContextServer({
      listWorkspaceDirectory: async () => teamDirectory(),
      fetchBilling: async () => null,
      fetchWorkspaceBalance: async () => ({
        workspaceId: 'wm-1',
        workspaceMemberId: 'member-1',
        balanceUsd: '7.89',
        billingScopeVersion: 2,
        expiresAt: null,
        updatedAt: null,
      }),
    });

    const res = await api.req('/api/workspace/billing?scope=workspace&workspaceId=wm-1');

    expect(res.status).toBe(200);
    expect(res.body.summary).toBeNull();
    expect(res.body.workspaceBalance).toMatchObject({
      workspaceId: 'wm-1',
      balanceUsd: '7.89',
      billingScopeVersion: 2,
    });
  });

  it('rejects a workspace wallet issued to a different directory membership', async () => {
    const api = await startContextServer({
      listWorkspaceDirectory: async () => teamDirectory(),
      fetchBilling: async () => null,
      fetchWorkspaceBalance: async () => ({
        workspaceId: 'wm-1',
        workspaceMemberId: 'different-member',
        balanceUsd: '7.89',
        billingScopeVersion: 2,
        expiresAt: null,
        updatedAt: null,
      }),
    });

    const res = await api.req('/api/workspace/billing?scope=workspace&workspaceId=wm-1');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      summary: null,
      workspaceBalance: null,
      workspaceRuntime: {
        workspaceId: 'wm-1',
        workspaceMemberId: 'member-1',
        status: 'error',
        errorCode: 'workspace_billing_scope_mismatch',
      },
    });
  });

  it('returns the real team billing catalog for the current workspace', async () => {
    const calls: string[] = [];
    const api = await startContextServer({
      fetchBillingCatalog: async (workspaceId) => {
        calls.push(workspaceId);
        return {
          workspaceId,
          billingInterval: 'monthly',
          plans: [
            {
              planId: 'team_plus',
              seatUnitAmountCents: 3900,
              currency: 'usd',
              minSeats: 1,
              status: 'active',
            },
          ],
        };
      },
    });
    await api.req('/api/workspace/context', { method: 'PUT', body: TEAM_CONTEXT });

    const res = await api.req('/api/workspace/billing/catalog');

    expect(res.status).toBe(200);
    expect(calls).toEqual(['wm-1']);
    expect(res.body).toEqual({
      catalog: {
        workspaceId: 'wm-1',
        billingInterval: 'monthly',
        plans: [
          {
            planId: 'team_plus',
            seatUnitAmountCents: 3900,
            currency: 'usd',
            minSeats: 1,
            status: 'active',
          },
        ],
      },
    });
  });

  it('starts checkout with workspace-derived id and selected team plan', async () => {
    const calls: Array<{ workspaceId?: string; planId?: string; seats?: number }> = [];
    const api = await startContextServer({
      startCheckout: async (input) => {
        calls.push(input);
        return 'https://checkout.stripe.test/cs_team';
      },
    });
    await api.req('/api/workspace/context', { method: 'PUT', body: TEAM_CONTEXT });

    const res = await api.req('/api/workspace/billing/checkout', {
      method: 'POST',
      body: { workspaceId: 'spoofed', planId: 'team_pro', seats: 3 },
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ checkoutUrl: 'https://checkout.stripe.test/cs_team' });
    expect(calls).toEqual([{ workspaceId: 'wm-1', planId: 'team_pro', seats: 3 }]);
  });
});

describe('POST /api/workspace/invite', () => {
  it('creates each invite against the current workspaceId and reports per-row results', async () => {
    const calls: Array<{ email: string; role: string; workspaceId: string }> = [];
    const api = await startContextServer({
      createInvite: async (input) => {
        calls.push(input);
        return { ok: true, inviteId: `inv-${input.email}` };
      },
    });
    // Derive workspaceId from the set context (parsed → workspaceId 'wm-1').
    await api.req('/api/workspace/context', { method: 'PUT', body: ADMIN_CONTEXT });
    const res = await api.req('/api/workspace/invite', {
      method: 'POST',
      body: { invites: [{ email: 'a@x.com', role: 'admin' }, { email: 'b@x.com', role: 'member' }] },
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      results: [
        { email: 'a@x.com', ok: true, inviteId: 'inv-a@x.com' },
        { email: 'b@x.com', ok: true, inviteId: 'inv-b@x.com' },
      ],
    });
    expect(calls).toEqual([
      { email: 'a@x.com', role: 'admin', workspaceId: 'wm-1' },
      { email: 'b@x.com', role: 'member', workspaceId: 'wm-1' },
    ]);
  });

  it('400s an empty invite list', async () => {
    const api = await startContextServer();
    const res = await api.req('/api/workspace/invite', { method: 'POST', body: { invites: [] } });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'missing_invites' });
  });

  it('409s with no_workspace when there is no current context', async () => {
    const api = await startContextServer({
      createInvite: async () => ({ ok: true, inviteId: 'inv-x' }),
    });
    const res = await api.req('/api/workspace/invite', {
      method: 'POST',
      body: { invites: [{ email: 'a@x.com', role: 'member' }] },
    });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'no_workspace' });
  });

  it('403s when the current team member cannot invite teammates', async () => {
    let called = false;
    const api = await startContextServer({
      createInvite: async () => {
        called = true;
        return { ok: true, inviteId: 'inv-x' };
      },
    });
    await api.req('/api/workspace/context', { method: 'PUT', body: TEAM_CONTEXT });

    const res = await api.req('/api/workspace/invite', {
      method: 'POST',
      body: { invites: [{ email: 'a@x.com', role: 'member' }] },
    });

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'forbidden' });
    expect(called).toBe(false);
  });

  it('short-circuits to 401 no_session', async () => {
    const api = await startContextServer({
      createInvite: async () => ({ ok: false, status: 401, error: 'no_session' }),
    });
    await api.req('/api/workspace/context', { method: 'PUT', body: ADMIN_CONTEXT });
    const res = await api.req('/api/workspace/invite', {
      method: 'POST',
      body: { invites: [{ email: 'a@x.com', role: 'member' }] },
    });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'no_session' });
  });

  it("degrades a failed B create (e.g. 404) to an ok:false result, HTTP 200", async () => {
    const api = await startContextServer({
      createInvite: async () => ({ ok: false, status: 404, error: 'create_404' }),
    });
    await api.req('/api/workspace/context', { method: 'PUT', body: ADMIN_CONTEXT });
    const res = await api.req('/api/workspace/invite', {
      method: 'POST',
      body: { invites: [{ email: 'a@x.com', role: 'member' }] },
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ results: [{ email: 'a@x.com', ok: false, error: 'create_404' }] });
  });
});
