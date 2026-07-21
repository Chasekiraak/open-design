import type {
  WorkspaceBillingCatalog,
  WorkspaceBillingSummary,
  WorkspaceTeamBillingPlanId,
} from '@open-design/contracts';
import { runVelaCommand, velaWorkspaceCommandOptions } from './vela-command.js';

// A-lane billing 收口. Instead of the daemon holding billing credentials, it
// shells out to `vela billing summary --format json`, which authenticates with
// the same vela login session AMR + the resource CLI use — one identity, and
// the billing truth lives in the vela backend. This is the read-side twin of
// the resource CLI adapter (see vela-cli-resource-adapter.ts): the client shows
// real credits + plan tier instead of a placeholder, and it degrades to null
// (the client keeps its context-derived tier hint) when the CLI / session is
// unavailable. The child process is injectable so the mapping is unit-tested
// without a live CLI.

/** Run `vela billing <args>` and resolve its stdout. */
export type RunVelaBilling = (args: string[]) => Promise<string>;

export interface FetchVelaBillingOptions {
  /** Injectable child-process runner; defaults to spawning the vela binary. */
  run?: RunVelaBilling;
}

/**
 * Fetch the billing summary for `workspaceId` via the CLI 收口. Returns null
 * when the CLI is missing, the user has no billing session, or the payload
 * can't be parsed — every failure is a clean "no summary", never a throw, so
 * the route can always answer and the client falls back to its context tier
 * hint.
 *
 * The workspace travels to vela the same way it does for collab, resources,
 * and team projects: as `VELA_WORKSPACE_ID` on the child environment, which
 * vela's `workspaceScopedClient` turns into the `x-vela-workspace-id` header.
 * Passing it here is what makes the read a WORKSPACE question rather than an
 * account one — the summary used to go out with no scope whatsoever, so an
 * account saw identical credits and an identical tier in every workspace.
 *
 * An empty `workspaceId` is allowed and means "no workspace context": the
 * account-level read still answers (B's wallet does not require a workspace),
 * it is simply left unstamped rather than being attributed to a workspace the
 * daemon could not name.
 */
export async function fetchVelaBillingSummary(
  workspaceId: string,
  options: FetchVelaBillingOptions = {},
): Promise<WorkspaceBillingSummary | null> {
  const trimmedWorkspaceId = workspaceId.trim();
  const run = options.run ?? runVelaBillingForWorkspace(trimmedWorkspaceId);
  let stdout: string;
  try {
    stdout = await run(['summary', '--format', 'json']);
  } catch {
    return null;
  }
  return parseBillingSummary(stdout, trimmedWorkspaceId);
}

export interface BillingCheckoutOptions {
  /** Team workspace id whose subscription is being purchased. */
  workspaceId?: string;
  /** Vela team subscription plan id. */
  planId?: WorkspaceTeamBillingPlanId;
  /** Seats to purchase for the team subscription (>= 1). */
  seats?: number;
  /** Where Stripe returns the user after success / cancel. */
  successUrl?: string;
  cancelUrl?: string;
  /** Injectable child-process runner; defaults to spawning the vela binary. */
  run?: RunVelaBilling;
}

/**
 * Start a team-subscription checkout via the CLI 收口 and return the Stripe
 * checkout URL to open, or null when the CLI / session / backend route is
 * unavailable. Mirrors A's `POST …/billing/team-subscription/checkout-sessions`
 * behind `vela billing checkout`. Never throws — a null return means "no URL",
 * so the caller shows an error toast instead of crashing.
 */
export async function fetchBillingCheckoutUrl(
  options: BillingCheckoutOptions = {},
): Promise<string | null> {
  const workspaceId = options.workspaceId?.trim();
  if (!workspaceId) return null;
  const planId = options.planId ?? 'team_plus';
  const seats = options.seats && options.seats > 0 ? Math.floor(options.seats) : 1;
  const args = [
    'checkout',
    '--workspace-id',
    workspaceId,
    '--plan-id',
    planId,
    '--seats',
    String(seats),
    '--format',
    'json',
  ];
  if (options.successUrl) args.push('--success-url', options.successUrl);
  if (options.cancelUrl) args.push('--cancel-url', options.cancelUrl);
  const run = options.run ?? defaultRunVelaBilling;
  let stdout: string;
  try {
    stdout = await run(args);
  } catch {
    return null;
  }
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  try {
    const raw = JSON.parse(trimmed) as Record<string, unknown>;
    return typeof raw.checkoutUrl === 'string' && raw.checkoutUrl ? raw.checkoutUrl : null;
  } catch {
    return null;
  }
}

export async function fetchVelaBillingCatalog(
  workspaceId: string,
  options: FetchVelaBillingOptions = {},
): Promise<WorkspaceBillingCatalog | null> {
  const trimmedWorkspaceId = workspaceId.trim();
  if (!trimmedWorkspaceId) return null;
  const run = options.run ?? defaultRunVelaBilling;
  let stdout: string;
  try {
    stdout = await run([
      'team-catalog',
      '--workspace-id',
      trimmedWorkspaceId,
      '--format',
      'json',
    ]);
  } catch {
    return null;
  }
  return parseBillingCatalog(stdout);
}

/**
 * Map the `vela billing summary` JSON into the client-facing summary, stamped
 * with the workspace the read was scoped to.
 *
 * B reports the wallet as three numbers under `balances`: the subscription
 * grant bucket, the top-up bucket, and their total. Keeping only the total is
 * what left the account menu's 附加积分 row with nothing to read — carry all
 * three so the UI shows B's real split instead of a constant.
 */
export function parseBillingSummary(
  stdout: string,
  workspaceId: string,
): WorkspaceBillingSummary | null {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return null;
  }
  const balances = (raw.balances ?? {}) as Record<string, unknown>;
  return {
    workspaceId: workspaceId.trim() || null,
    membershipTier: str(raw.membershipTier),
    totalAvailableCredits: credits(balances.totalAvailableCredits),
    subscriptionCredits: credits(balances.subscriptionCredits),
    rechargeCredits: credits(balances.rechargeCredits),
    balanceUsd: str(raw.balanceUsd) || '0',
    subscriptionStatus: str(raw.subscriptionStatus),
    availableActions: Array.isArray(raw.availableActions)
      ? raw.availableActions.filter((a): a is string => typeof a === 'string')
      : [],
  };
}

/** B sends credit buckets as decimal strings; a missing/garbage bucket is 0. */
function credits(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function parseBillingCatalog(stdout: string): WorkspaceBillingCatalog | null {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return null;
  }
  const workspaceId = str(raw.workspaceId);
  const billingInterval = raw.billingInterval === 'monthly' ? 'monthly' : null;
  if (!workspaceId || !billingInterval || !Array.isArray(raw.plans)) return null;
  const plans = raw.plans
    .map((plan): WorkspaceBillingCatalog['plans'][number] | null => {
      if (!plan || typeof plan !== 'object') return null;
      const record = plan as Record<string, unknown>;
      const planId = parseTeamPlanId(record.planId);
      const seatUnitAmountCents = Number(record.seatUnitAmountCents);
      const minSeats = Number(record.minSeats);
      const currency = record.currency === 'usd' ? 'usd' : null;
      const status =
        record.status === 'active' || record.status === 'disabled'
          ? record.status
          : null;
      if (
        !planId ||
        !currency ||
        !status ||
        !Number.isFinite(seatUnitAmountCents) ||
        seatUnitAmountCents <= 0 ||
        !Number.isFinite(minSeats) ||
        minSeats <= 0
      ) {
        return null;
      }
      return {
        planId,
        seatUnitAmountCents,
        currency,
        minSeats,
        status,
      };
    })
    .filter((plan): plan is WorkspaceBillingCatalog['plans'][number] => plan !== null);
  return { workspaceId, billingInterval, plans };
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function parseTeamPlanId(value: unknown): WorkspaceTeamBillingPlanId | null {
  return value === 'team_plus' || value === 'team_pro' || value === 'team_max'
    ? value
    : null;
}

const defaultRunVelaBilling: RunVelaBilling = (args) => runVelaBillingForWorkspace('')(args);

/**
 * A `vela billing` runner scoped to one workspace, using the same env carrier
 * as the collab / resource / team-project adapters.
 *
 * `velaWorkspaceCommandOptions` omits `VELA_WORKSPACE_ID` entirely for an empty
 * id, so an unscoped call still reaches vela unscoped. It does also add the
 * `VELA_INVOCATION_SOURCE=open-design` tag those adapters already send, which
 * billing previously did not — a source label, not a behavioral input.
 */
function runVelaBillingForWorkspace(workspaceId: string): RunVelaBilling {
  const workspaceOptions = velaWorkspaceCommandOptions(workspaceId);
  return (args) =>
    runVelaCommand(['billing', ...args], {
      ...workspaceOptions,
      maxBuffer: 4 * 1024 * 1024,
    });
}
