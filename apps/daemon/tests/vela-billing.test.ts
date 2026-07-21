import { describe, expect, it } from 'vitest';
import {
  fetchBillingCheckoutUrl,
  fetchVelaBillingCatalog,
  fetchVelaBillingSummary,
  parseBillingCatalog,
  parseBillingSummary,
} from '../src/integrations/vela-billing.js';

// A representative `vela billing summary --format json` payload.
const SAMPLE = JSON.stringify({
  balanceUsd: '1.2500',
  creditsPerUsd: 10000,
  balances: { subscriptionCredits: '5000', rechargeCredits: '7500', totalAvailableCredits: '12500' },
  membershipTier: 'team',
  billingInterval: 'monthly',
  subscriptionStatus: 'active',
  availableActions: ['subscription_checkout', 'billing_portal'],
});

const CATALOG_SAMPLE = JSON.stringify({
  workspaceId: 'ws_team',
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
});

describe('vela billing 收口', () => {
  // Acceptance #112: B splits the wallet into a subscription grant bucket and
  // a top-up bucket (`balances.subscriptionCredits` / `balances.rechargeCredits`,
  // summing to `totalAvailableCredits`). The mapper kept only the total, so the
  // menu's 附加积分 row had no field to read and could only ever print 0.
  it('maps the vela billing summary JSON, including BOTH credit buckets', () => {
    expect(parseBillingSummary(SAMPLE, 'ws_team')).toEqual({
      workspaceId: 'ws_team',
      membershipTier: 'team',
      totalAvailableCredits: 12500,
      subscriptionCredits: 5000,
      rechargeCredits: 7500,
      balanceUsd: '1.2500',
      subscriptionStatus: 'active',
      availableActions: ['subscription_checkout', 'billing_portal'],
    });
  });

  it('returns null on empty or malformed output (clean "no summary")', () => {
    expect(parseBillingSummary('', 'ws_team')).toBeNull();
    expect(parseBillingSummary('not json', 'ws_team')).toBeNull();
  });

  it('degrades to null when the CLI throws — no billing session', async () => {
    const out = await fetchVelaBillingSummary('ws_team', {
      run: async () => {
        throw new Error('no vela session');
      },
    });
    expect(out).toBeNull();
  });

  it('drives the injected runner and maps its output', async () => {
    const out = await fetchVelaBillingSummary('ws_team', { run: async () => SAMPLE });
    expect(out?.membershipTier).toBe('team');
    expect(out?.totalAvailableCredits).toBe(12500);
    expect(out?.rechargeCredits).toBe(7500);
    expect(out?.availableActions).toContain('billing_portal');
  });

  // #134 root cause: the summary went out with no workspace scope whatsoever,
  // so B answered for the ACCOUNT and every workspace showed the same numbers.
  // The workspace travels the same way it does for collab / resources /
  // team-projects — as VELA_WORKSPACE_ID on the child env — and the summary is
  // stamped with it so the client can tell whose billing it is holding.
  it('stamps the summary with the workspace it was requested for', async () => {
    const out = await fetchVelaBillingSummary('ws_team', { run: async () => SAMPLE });
    expect(out?.workspaceId).toBe('ws_team');
  });

  it('leaves the stamp null when no workspace is known', async () => {
    const out = await fetchVelaBillingSummary('', { run: async () => SAMPLE });
    expect(out?.workspaceId).toBeNull();
  });

  it('maps the vela team billing catalog JSON into client catalog data', () => {
    expect(parseBillingCatalog(CATALOG_SAMPLE)).toEqual({
      workspaceId: 'ws_team',
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
    });
    expect(parseBillingCatalog('not json')).toBeNull();
  });

  it('fetches team billing catalog through the vela CLI workspace route', async () => {
    const seen: string[][] = [];
    const out = await fetchVelaBillingCatalog('ws_team', {
      run: async (args) => {
        seen.push(args);
        return CATALOG_SAMPLE;
      },
    });
    expect(out?.plans[0]?.planId).toBe('team_plus');
    expect(seen).toEqual([
      ['team-catalog', '--workspace-id', 'ws_team', '--format', 'json'],
    ]);
  });

  it('starts checkout with workspace and selected team plan through the vela CLI', async () => {
    const seen: string[][] = [];
    const url = await fetchBillingCheckoutUrl({
      workspaceId: 'ws_team',
      planId: 'team_pro',
      seats: 4,
      run: async (args) => {
        seen.push(args);
        return JSON.stringify({
          checkoutSessionId: 'cs_team',
          checkoutUrl: 'https://checkout.stripe.test/cs_team',
        });
      },
    });
    expect(url).toBe('https://checkout.stripe.test/cs_team');
    expect(seen).toEqual([
      [
        'checkout',
        '--workspace-id',
        'ws_team',
        '--plan-id',
        'team_pro',
        '--seats',
        '4',
        '--format',
        'json',
      ],
    ]);
  });
});
