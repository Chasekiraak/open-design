import type { Express } from 'express';
import type {
  CollabCloudMemberDirectoryEntry,
  CollabCloudMembersResponse,
  TeamProject,
  WorkspaceBillingCatalog,
  WorkspaceBillingCatalogResponse,
  WorkspaceBillingCheckoutResponse,
  WorkspaceBillingSnapshot,
  WorkspaceTeamBillingPlanId,
  WorkspaceBillingResponse,
  WorkspaceBillingSummary,
  WorkspaceWalletBalance,
  WorkspaceDirectoryItem,
  WorkspaceDirectoryResponse,
  WorkspaceContextResponse,
  WorkspaceActiveResponse,
  WorkspaceInviteCreateResponse,
  WorkspaceInviteCreateResult,
  WorkspaceInviteRole,
  WorkspaceTeamProjectsResponse,
} from '@open-design/contracts';
import {
  parseWorkspaceCollabContext,
  type WorkspaceContextProvider,
} from '../collab/workspace-context.js';
import { createTeamProjectsLister } from '../collab/team-projects.js';
import {
  consumeInviteContinuation,
  type InviteContinueOutcome,
} from '../collab/invite-continue.js';
import {
  createWorkspaceInvite,
  type CreateInviteOutcome,
  type CreateWorkspaceInviteInput,
} from '../collab/invite-create.js';
import {
  fetchBillingCheckoutUrl,
  fetchVelaBillingCatalog,
  fetchVelaWorkspaceBillingProjection,
  fetchVelaBillingSummary,
  type VelaWorkspaceBillingProjection,
} from '../integrations/vela-billing.js';
import { listVelaWorkspaceDirectory } from '../collab/vela-workspace-context.js';

export interface RegisterCollabContextRoutesDeps {
  workspaceContext: WorkspaceContextProvider;
  /** Injectable for tests; defaults to consuming against B with the vela session. */
  consumeInvite?: (nonce: string) => Promise<InviteContinueOutcome>;
  /** Injectable for tests; defaults to creating invites on B with the vela session. */
  createInvite?: (input: CreateWorkspaceInviteInput) => Promise<CreateInviteOutcome>;
  /** Injectable for tests; defaults to the vela billing CLI 收口. */
  fetchBilling?: () => Promise<WorkspaceBillingSummary | null>;
  /** Injectable for tests; returns one backend-proven v2 workspace wallet. */
  fetchWorkspaceBalance?: (workspaceId: string) => Promise<WorkspaceWalletBalance | null>;
  /** Injectable for tests; returns the additive atomic plan+wallet projection. */
  fetchWorkspaceBillingProjection?: (
    workspaceId: string,
  ) => Promise<VelaWorkspaceBillingProjection>;
  /** Injectable for tests; defaults to the vela billing catalog CLI 收口. */
  fetchBillingCatalog?: (workspaceId: string) => Promise<WorkspaceBillingCatalog | null>;
  /** Injectable for tests; defaults to the vela billing checkout CLI 收口. */
  startCheckout?: (input: {
    workspaceId?: string;
    planId?: WorkspaceTeamBillingPlanId;
    seats?: number;
  }) => Promise<string | null>;
  /** Injectable for tests; defaults to the resource-hub team-project lister
   *  built from the same workspace context + env-configured hub client the share
   *  path uses. */
  listTeamProjects?: () => Promise<TeamProject[]>;
  /**
   * The team's collab-cloud member directory (memberId → {displayName, role}),
   * so the web client can resolve comment authors + the shared-project owner to
   * a name + role. Empty off-team / when the collab cloud is unconfigured. STUB:
   * B's roster is the real source; the collab-cloud directory stands in for it.
   */
  listMembers?: () => Promise<CollabCloudMemberDirectoryEntry[]>;
  /**
   * OD-local active workspace selection. Vela Web lists/creates workspaces but
   * does not choose which workspace this local OD daemon is operating in.
   */
  activeWorkspace?: {
    get(): string | null;
    set(workspaceId: string): Promise<void>;
    clear(): Promise<void>;
  };
  /** Injectable for tests; defaults to the Vela workspace directory API. */
  listWorkspaceDirectory?: () => Promise<WorkspaceDirectoryItem[]>;
  /**
   * Collab realtime hop-2 — the workspace-scoped invalidation SSE seams. When
   * both are provided the daemon registers `GET /api/workspace/events`; the route
   * adds its per-connection sink to `workspaceEventSinks` (fed by the
   * workspace-invalidation poller) and drops it on disconnect. Omitted in tests
   * that do not exercise the stream — the route then 404s cleanly.
   */
  createSseResponse?: (res: unknown, opts?: unknown) => {
    send: (event: string, data: unknown, id?: string | number | null) => boolean;
  };
  workspaceEventSinks?: Set<(payload: unknown) => void>;
}

const ASSIGNABLE_ROLES = new Set<WorkspaceInviteRole>(['admin', 'member']);

/**
 * Normalize an invite-create request body into validated { email, role } items.
 * Accepts either the canonical `{ invites: [...] }` batch shape or a single
 * top-level `{ email, role }`. Rows without a non-empty email are dropped; a
 * missing/unknown role defaults to 'member' (never 'owner').
 */
function parseInviteCreateItems(
  body: unknown,
): Array<{ email: string; role: WorkspaceInviteRole }> {
  const raw = body as { invites?: unknown; email?: unknown; role?: unknown } | null;
  const source: unknown[] = Array.isArray(raw?.invites)
    ? raw!.invites
    : raw && typeof raw === 'object' && typeof raw.email === 'string'
      ? [raw]
      : [];
  const items: Array<{ email: string; role: WorkspaceInviteRole }> = [];
  for (const entry of source) {
    if (!entry || typeof entry !== 'object') continue;
    const rec = entry as { email?: unknown; role?: unknown };
    if (typeof rec.email !== 'string') continue;
    const email = rec.email.trim();
    if (!email) continue;
    const role: WorkspaceInviteRole =
      typeof rec.role === 'string' && ASSIGNABLE_ROLES.has(rec.role as WorkspaceInviteRole)
        ? (rec.role as WorkspaceInviteRole)
        : 'member';
    items.push({ email, role });
  }
  return items;
}

/**
 * Workspace-context route : the daemon's single B-integration seam. The
 * web client fetches the current caller's workspace context here to decide
 * whether collab runs and who the present member is (resolveCollabSession). In
 * production the provider proxies B; the dev provider is settable via PUT so a
 * demo/tools-dev run can exercise the full path before B is reachable.
 */
export function registerCollabContextRoutes(app: Express, deps: RegisterCollabContextRoutesDeps): void {
  const { workspaceContext } = deps;
  const consumeInvite = deps.consumeInvite ?? ((nonce: string) => consumeInviteContinuation(nonce));
  const createInvite =
    deps.createInvite ?? ((input: CreateWorkspaceInviteInput) => createWorkspaceInvite(input));
  const fetchBilling = deps.fetchBilling ?? (() => fetchVelaBillingSummary());
  const fetchWorkspaceBillingProjection =
    deps.fetchWorkspaceBillingProjection ??
    (deps.fetchWorkspaceBalance
      ? async (workspaceId: string): Promise<VelaWorkspaceBillingProjection> => ({
          snapshot: null,
          workspaceBalance: await deps.fetchWorkspaceBalance!(workspaceId),
        })
      : (workspaceId: string) => fetchVelaWorkspaceBillingProjection(workspaceId));
  const fetchBillingCatalog =
    deps.fetchBillingCatalog ?? ((workspaceId: string) => fetchVelaBillingCatalog(workspaceId));
  const startCheckout =
    deps.startCheckout ??
    ((input: { workspaceId?: string; planId?: WorkspaceTeamBillingPlanId; seats?: number }) =>
      fetchBillingCheckoutUrl(input));
  const listTeamProjects =
    deps.listTeamProjects ?? createTeamProjectsLister({ workspaceContext });
  const listMembers = deps.listMembers ?? (async () => []);
  const listWorkspaceDirectory =
    deps.listWorkspaceDirectory ?? (() => listVelaWorkspaceDirectory());

  // Desktop invite hand-off ("桌面唤起和本地恢复"): the desktop app parses the
  // opendesign:// invite deeplink and POSTs the nonce here. The daemon consumes
  // the one-time continuation on B with the signed-in vela session and returns
  // the resolved workspace context so the client can switch into the team
  // workspace. The nonce is single-use — B enforces subject match + one consume.
  app.post('/api/workspace/invite/continue', async (req, res) => {
    const body = req.body as { nonce?: unknown } | null;
    const nonce = body && typeof body.nonce === 'string' ? body.nonce : '';
    if (!nonce.trim()) return res.status(400).json({ error: 'missing_nonce' });
    const outcome = await consumeInvite(nonce);
    if (!outcome.ok) return res.status(outcome.status).json({ error: outcome.error });
    return res.json({ context: outcome.context, workspaceMemberId: outcome.workspaceMemberId });
  });

  // Invite CREATE (the inviter/host flow): the team switcher's "邀请同事" dialog
  // POSTs one or more { email, role } pairs here. The daemon derives the current
  // workspaceId from the caller's workspace context and creates each invite on B
  // with the signed-in vela session. Every outcome is typed: a missing session
  // 401s, a missing workspace 409s, and B's per-invite failures (including a 404
  // when B's create endpoint is absent locally) come back as `ok: false` results
  // — the endpoint never crashes on the backend being unavailable.
  app.post('/api/workspace/invite', async (req, res) => {
    const items = parseInviteCreateItems(req.body);
    if (items.length === 0) return res.status(400).json({ error: 'missing_invites' });

    const authorization = req.header('authorization') ?? undefined;
    const context = await workspaceContext.current({ authorization });
    const workspaceId = context?.workspaceId?.trim() ?? '';
    if (!context || !workspaceId) {
      return res.status(409).json({ error: 'no_workspace' });
    }
    if (!context.permissions.canInviteMembers) {
      return res.status(403).json({ error: 'forbidden' });
    }

    const results: WorkspaceInviteCreateResult[] = [];
    for (const item of items) {
      const outcome = await createInvite({ email: item.email, role: item.role, workspaceId });
      // The vela session is workspace-wide: if it is missing for one invite it is
      // missing for all, so short-circuit to a single 401 instead of N failures.
      if (!outcome.ok && outcome.error === 'no_session') {
        return res.status(401).json({ error: 'no_session' });
      }
      results.push(
        outcome.ok
          ? { email: item.email, ok: true, inviteId: outcome.inviteId }
          : { email: item.email, ok: false, error: outcome.error },
      );
    }
    const body: WorkspaceInviteCreateResponse = { results };
    return res.json(body);
  });

  app.get('/api/workspace/context', async (req, res) => {
    const authorization = req.header('authorization') ?? undefined;
    const context = await workspaceContext.current({ authorization });
    const body: WorkspaceContextResponse = { context };
    res.json(body);
  });

  // Collab realtime hop-2: workspace-scoped invalidation SSE. Carries thin
  // `WorkspaceInvalidationSsePayload` signals (`team-projects-changed`,
  // `members-changed`, `workspace-context-changed`, `billing-changed`); the web
  // re-fetches the affected resource on receipt. Modeled on the project events
  // SSE (`/api/projects/:id/events`): one flat sink set, dropped on disconnect
  // via `res.on('close')`. No event buffer — a disconnect gap is closed by the
  // client's reconnect snapshot re-fetch, not a server-side replay.
  const { createSseResponse, workspaceEventSinks } = deps;
  if (createSseResponse && workspaceEventSinks) {
    app.get('/api/workspace/events', (_req, res) => {
      const sse = createSseResponse(res);
      const sink = (payload: unknown) => {
        const type =
          payload && typeof payload === 'object' && 'type' in payload
            ? String((payload as { type: unknown }).type)
            : 'message';
        sse.send(type, payload);
      };
      workspaceEventSinks.add(sink);
      // Handshake so the client treats the stream as live and resets its
      // reconnect backoff immediately (mirrors the project stream's `ready`).
      sse.send('ready', { at: Date.now() });
      const cleanup = () => {
        workspaceEventSinks.delete(sink);
      };
      res.on('close', cleanup);
      res.on('finish', cleanup);
    });
  }

  app.get('/api/workspace/directory', async (req, res) => {
    const authorization = req.header('authorization') ?? undefined;
    const [items, context] = await Promise.all([
      listWorkspaceDirectory().catch(() => []),
      workspaceContext.current({ authorization }).catch(() => null),
    ]);
    const activeWorkspaceId =
      deps.activeWorkspace?.get() ??
      context?.workspaceId ??
      items.find((item) => item.workspaceType === 'team')?.workspaceId ??
      items[0]?.workspaceId ??
      null;
    const body: WorkspaceDirectoryResponse = { items, activeWorkspaceId };
    res.json(body);
  });

  app.put('/api/workspace/active', async (req, res) => {
    if (!deps.activeWorkspace) {
      return res.status(404).json({ error: 'workspace selection is not available' });
    }
    const raw = req.body as { workspaceId?: unknown } | null;
    const workspaceId = typeof raw?.workspaceId === 'string' ? raw.workspaceId.trim() : '';
    if (!workspaceId) return res.status(400).json({ error: 'missing_workspace_id' });

    const directory = await listWorkspaceDirectory().catch(() => []);
    if (!directory.some((item) => item.workspaceId === workspaceId)) {
      return res.status(404).json({ error: 'workspace_not_visible' });
    }

    const authorization = req.header('authorization') ?? undefined;
    const previous = deps.activeWorkspace.get();
    // B moved workspace selection server-side (2026-07-16): the account-level
    // active workspace must be switched ON THE BACKEND first, or every
    // follow-up context read and scoped CLI call stays on the old workspace
    // and the validation below always fails. Local-only providers (dev) have
    // no selectWorkspace and keep the previous behavior.
    if (workspaceContext.selectWorkspace) {
      const switched = await workspaceContext.selectWorkspace(workspaceId).catch(() => false);
      if (!switched) {
        return res.status(502).json({ error: 'workspace_switch_rejected' });
      }
    }
    await deps.activeWorkspace.set(workspaceId);
    const context = await workspaceContext.current({ authorization }).catch(() => null);
    if (!context || context.workspaceId !== workspaceId) {
      if (previous) {
        await deps.activeWorkspace.set(previous);
        // Undo the backend-side switch too, or the account stays parked on a
        // workspace the client just refused.
        await workspaceContext.selectWorkspace?.(previous).catch(() => false);
      } else await deps.activeWorkspace.clear();
      return res.status(404).json({ error: 'workspace_context_unavailable' });
    }
    const body: WorkspaceActiveResponse = { activeWorkspaceId: workspaceId, context };
    res.json(body);
  });

  // Team-wide shared-project discovery: the web "全部项目" view fetches every
  // project any member shared to the team here (read from the resource hub), so a
  // member whose own /api/projects list is empty still sees the owner's shared
  // projects to pull + open. Empty off-team / hub-unconfigured; a transient hub
  // error also degrades to [] so a hub outage never blanks the view with a 500.
  app.get('/api/workspace/projects/team', async (_req, res) => {
    let projects: TeamProject[] = [];
    try {
      projects = await listTeamProjects();
    } catch {
      projects = [];
    }
    const body: WorkspaceTeamProjectsResponse = { projects };
    res.json(body);
  });

  // Member directory: the web client resolves comment authors (authorMemberId →
  // "琼羽 · Owner") and the shared-project owner name from this. Read from the
  // collab-cloud directory; empty off-team / hub-unconfigured, and a directory
  // outage degrades to [] rather than a 500. STUB: stands in for B's roster.
  app.get('/api/workspace/members', async (_req, res) => {
    let members: CollabCloudMemberDirectoryEntry[] = [];
    try {
      members = await listMembers();
    } catch {
      members = [];
    }
    const body: CollabCloudMembersResponse = { members };
    res.json(body);
  });

  // Billing reads are explicit at the HTTP boundary:
  // - scope=account is the personal/account summary;
  // - scope=workspace requires a workspaceId that resolves to an active team
  //   membership in the directory, then reads Vela's independently scoped v2
  //   wallet response.
  //
  // The URL is the selection source. Authorization is an independent
  // membership lookup — never daemon-global active/current state — so two
  // clients can address different workspaces without switching each other.
  // Account metadata and workspace money remain independently nullable.
  app.get('/api/workspace/billing', async (req, res) => {
    const scope = typeof req.query.scope === 'string' ? req.query.scope.trim() : '';
    const requestedWorkspaceId =
      typeof req.query.workspaceId === 'string' ? req.query.workspaceId.trim() : '';
    if (
      (scope !== 'account' && scope !== 'workspace') ||
      (scope === 'account' && requestedWorkspaceId) ||
      (scope === 'workspace' && !requestedWorkspaceId)
    ) {
      return res.status(400).json({ error: 'invalid_billing_scope' });
    }
    if (scope === 'account') {
      const summary = await fetchBilling();
      const body: WorkspaceBillingResponse = { summary, workspaceBalance: null };
      return res.json(body);
    }

    const directory = await listWorkspaceDirectory().catch(() => []);
    const membership = directory.find(
      (item) =>
        item.workspaceId === requestedWorkspaceId &&
        item.workspaceType === 'team' &&
        item.memberStatus === 'active' &&
        item.lifecycleState === 'active',
    );
    if (!membership) {
      return res.status(409).json({ error: 'workspace_not_authorized' });
    }
    const [accountSummary, projection] = await Promise.all([
      fetchBilling(),
      fetchWorkspaceBillingProjection(requestedWorkspaceId),
    ]);
    const workspaceBalance = projection.workspaceBalance;
    const authorizedWorkspaceBalance =
      workspaceBalance?.workspaceId === requestedWorkspaceId &&
      workspaceBalance.workspaceMemberId === membership.workspaceMemberId
        ? workspaceBalance
        : null;
    const snapshot = projection.snapshot;
    const authorizedWorkspaceSnapshot: WorkspaceBillingSnapshot | null =
      snapshot?.workspaceId === requestedWorkspaceId &&
      snapshot.workspaceMemberId === membership.workspaceMemberId
        ? snapshot
        : null;
    const body: WorkspaceBillingResponse = {
      summary: accountSummary,
      workspaceBalance: authorizedWorkspaceBalance,
      ...(authorizedWorkspaceSnapshot
        ? { workspaceSnapshot: authorizedWorkspaceSnapshot }
        : {}),
    };
    return res.json(body);
  });

  app.get('/api/workspace/billing/catalog', async (req, res) => {
    const authorization = req.header('authorization') ?? undefined;
    const context = await workspaceContext.current({ authorization });
    const workspaceId = context?.workspaceId?.trim() ?? '';
    const catalog = workspaceId ? await fetchBillingCatalog(workspaceId) : null;
    const body: WorkspaceBillingCatalogResponse = { catalog };
    res.json(body);
  });

  // Compatibility checkout route. The current product UI opens Vela Web for
  // upgrade/payment, but keeping this endpoint avoids breaking existing tests
  // and lets A's CLI checkout path be exercised directly when needed.
  app.post('/api/workspace/billing/checkout', async (req, res) => {
    const authorization = req.header('authorization') ?? undefined;
    const context = await workspaceContext.current({ authorization });
    const workspaceId = context?.workspaceId?.trim() ?? '';
    const body = (req.body ?? {}) as { planId?: unknown; seats?: unknown };
    const planId = parseTeamBillingPlanId(body.planId);
    const seats = typeof body.seats === 'number' && body.seats > 0 ? Math.floor(body.seats) : undefined;
    const checkoutInput: {
      workspaceId?: string;
      planId?: WorkspaceTeamBillingPlanId;
      seats?: number;
    } = { workspaceId };
    if (planId) checkoutInput.planId = planId;
    if (seats !== undefined) checkoutInput.seats = seats;
    const checkoutUrl = await startCheckout(checkoutInput);
    const response: WorkspaceBillingCheckoutResponse = { checkoutUrl };
    res.json(response);
  });

  // Dev/demo seam: override the in-memory context. A real B-backed provider does
  // not expose `set`, so this 404s in production instead of spoofing identity.
  app.put('/api/workspace/context', (req, res) => {
    if (!workspaceContext.set) {
      return res.status(404).json({ error: 'workspace context is not settable' });
    }
    const body = req.body as unknown;
    // `null` explicitly clears the context (sign-out / leave team).
    if (body === null || (body && typeof body === 'object' && Object.keys(body).length === 0)) {
      workspaceContext.set(null);
      const cleared: WorkspaceContextResponse = { context: null };
      return res.json(cleared);
    }
    const context = parseWorkspaceCollabContext(body);
    if (!context) return res.status(400).json({ error: 'invalid workspace context' });
    workspaceContext.set(context);
    const response: WorkspaceContextResponse = { context };
    res.json(response);
  });
}

function parseTeamBillingPlanId(value: unknown): WorkspaceTeamBillingPlanId | null {
  return value === 'team_plus' || value === 'team_pro' || value === 'team_max' ? value : null;
}
