// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AmrBalanceDialog } from '../../src/components/AmrBalanceDialog';
import { resetWorkspaceContextCache } from '../../src/collab/useWorkspaceContext';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  // The context hook caches at module scope; clear it so cases don't leak.
  resetWorkspaceContextCache();
});

describe('AmrBalanceDialog', () => {
  it('dismisses from the corner close button', () => {
    const onClose = vi.fn();

    render(
      <AmrBalanceDialog
        reason="insufficient"
        balanceUsd="0.00"
        profile="prod"
        entrySource="chat_balance_gate_upgrade"
        metricsConsent={false}
        installationId={null}
        onClose={onClose}
        onResolved={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  // Acceptance #73: 「升级套餐」 used to open the console and leave the user to
  // find the plan picker. B auto-opens a subscription dialog when the URL
  // carries `billing=checkout` OR `billing=plan`, and the destination is the
  // team DASHBOARD, not settings — but WHICH param depends on whether the
  // team has ever completed a first checkout (see `teamConsoleUrl`'s
  // docblock in EntryNavRail.tsx).
  it('lands the upgrade CTA on the first-checkout dialog when the team has never subscribed', async () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = String(input);
      if (url.includes('/api/workspace/context')) {
        return Promise.resolve(new Response(JSON.stringify({
          context: {
            workspaceId: 'ws-1',
            workspaceType: 'team',
            planId: null,
            billingState: 'free',
            workspaceSettingsUrl: 'https://open-design.ai/console/settings?workspaceId=ws-1',
          },
        }), { status: 200, headers: { 'content-type': 'application/json' } }));
      }
      if (url.includes('/api/workspace/billing')) {
        return Promise.resolve(new Response(JSON.stringify({
          summary: { workspaceId: 'ws-1', membershipTier: '' },
        }), { status: 200, headers: { 'content-type': 'application/json' } }));
      }
      return Promise.reject(new Error(`unexpected fetch ${url}`));
    });

    render(
      <AmrBalanceDialog
        reason="insufficient"
        balanceUsd="0.00"
        profile="prod"
        entrySource="chat_balance_gate_upgrade"
        metricsConsent={false}
        installationId={null}
        onClose={vi.fn()}
        onResolved={vi.fn()}
      />,
    );

    await waitFor(() => {
      fireEvent.click(screen.getByTestId('amr-balance-dialog-plans'));
      expect(open).toHaveBeenCalled();
      const target = new URL(String(open.mock.calls.at(-1)?.[0]));
      expect(target.pathname).toBe('/console/dashboard');
      expect(target.searchParams.get('billing')).toBe('checkout');
      // The deep link keeps the workspace this client is pinned to.
      expect(target.searchParams.get('workspaceId')).toBe('ws-1');
    });
  });

  // recvpYEiH019cD / recvpSQKna0LwR: `billing=checkout` only auto-opens B's
  // dialog for a team that has never subscribed — for a team with an ALREADY
  // active plan, that gate is false and B silently opens nothing (confirmed
  // live: an already-subscribed "Team Pro" workspace landed on the bare
  // Overview page). `planId: 'team_pro'` here is exactly that already-paying
  // state, so the CTA must switch to `billing=plan`, B's change-plan dialog.
  it('lands the upgrade CTA on the change-plan dialog when the team already has an active plan', async () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = String(input);
      if (url.includes('/api/workspace/context')) {
        return Promise.resolve(new Response(JSON.stringify({
          context: {
            workspaceId: 'ws-1',
            workspaceType: 'team',
            planId: 'team_pro',
            billingState: 'active',
            workspaceSettingsUrl: 'https://open-design.ai/console/settings?workspaceId=ws-1',
          },
        }), { status: 200, headers: { 'content-type': 'application/json' } }));
      }
      if (url.includes('/api/workspace/billing')) {
        return Promise.resolve(new Response(JSON.stringify({
          summary: { workspaceId: 'ws-1', membershipTier: 'team_pro' },
        }), { status: 200, headers: { 'content-type': 'application/json' } }));
      }
      return Promise.reject(new Error(`unexpected fetch ${url}`));
    });

    render(
      <AmrBalanceDialog
        reason="insufficient"
        balanceUsd="0.00"
        profile="prod"
        entrySource="chat_balance_gate_upgrade"
        metricsConsent={false}
        installationId={null}
        onClose={vi.fn()}
        onResolved={vi.fn()}
      />,
    );

    await waitFor(() => {
      fireEvent.click(screen.getByTestId('amr-balance-dialog-plans'));
      expect(open).toHaveBeenCalled();
      const target = new URL(String(open.mock.calls.at(-1)?.[0]));
      expect(target.pathname).toBe('/console/dashboard');
      expect(target.searchParams.get('billing')).toBe('plan');
      expect(target.searchParams.get('workspaceId')).toBe('ws-1');
    });
  });

  // No workspace console URL (personal workspace, or the context read has not
  // landed): the CTA must still go somewhere, not become a dead end — and it
  // must land on the pricing modal (`view=plans`), not the bare wallet page,
  // otherwise the user has to hunt for the upgrade dialog themselves (dogfood
  // acceptance regression: recvpYEiH019cD).
  it('falls back to the profile plans deep link when no console URL is known', async () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));

    render(
      <AmrBalanceDialog
        reason="insufficient"
        balanceUsd="0.00"
        profile="prod"
        entrySource="chat_balance_gate_upgrade"
        metricsConsent={false}
        installationId={null}
        onClose={vi.fn()}
        onResolved={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByTestId('amr-balance-dialog-plans'));

    const target = new URL(String(open.mock.calls.at(-1)?.[0]));
    expect(target.pathname).toBe('/amr/wallet');
    expect(target.searchParams.get('view')).toBe('plans');
  });
});
