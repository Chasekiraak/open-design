// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetCoalescedGet } from '../src/lib/coalesced-get';
import {
  notifyWorkspaceContextRefresh,
  resetWorkspaceContextCache,
  useWorkspaceBilling,
  useWorkspaceBillingResponse,
} from '../src/collab/useWorkspaceContext';

function teamContext(workspaceId: string) {
  return {
    workspaceId,
    workspaceType: 'team',
    workspaceMemberId: `member-${workspaceId}`,
    role: 'member',
    memberStatus: 'active',
    lifecycleState: 'active',
  };
}

function billingResponse(workspaceId: string, balanceUsd: string) {
  return {
    summary: {
      workspaceId: null,
      membershipTier: 'team_plus',
      totalAvailableCredits: 0,
      subscriptionCredits: 0,
      rechargeCredits: 0,
      balanceUsd: '999.00',
      subscriptionStatus: 'active',
      availableActions: [],
      workspaceBalance: null,
    },
    workspaceBalance: {
      workspaceId,
      workspaceMemberId: `member-${workspaceId}`,
      balanceUsd,
      billingScopeVersion: 2,
      expiresAt: null,
      updatedAt: '2026-07-26T12:00:00Z',
    },
  };
}

describe('useWorkspaceBilling explicit scope', () => {
  beforeEach(() => {
    resetCoalescedGet();
    resetWorkspaceContextCache();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    resetCoalescedGet();
    resetWorkspaceContextCache();
  });

  it('keys A and B separately and never shows A while B is still loading', async () => {
    let currentContext = teamContext('workspace-a');
    let resolveWorkspaceB!: (response: Response) => void;
    const workspaceBResponse = new Promise<Response>((resolve) => {
      resolveWorkspaceB = resolve;
    });
    const billingCalls: string[] = [];

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === '/api/workspace/context') {
          return new Response(JSON.stringify({ context: currentContext }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (url.startsWith('/api/workspace/billing?')) {
          billingCalls.push(url);
          const parsed = new URL(url, 'http://open-design.test');
          const workspaceId = parsed.searchParams.get('workspaceId');
          expect(parsed.searchParams.get('scope')).toBe('workspace');
          if (workspaceId === 'workspace-a') {
            return new Response(JSON.stringify(billingResponse('workspace-a', '1.25')), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            });
          }
          if (workspaceId === 'workspace-b') return workspaceBResponse;
        }
        throw new Error(`unexpected fetch ${url}`);
      }),
    );

    const hook = renderHook(() => useWorkspaceBillingResponse());
    await waitFor(() => {
      expect(hook.result.current?.workspaceBalance?.workspaceId).toBe('workspace-a');
    });

    currentContext = teamContext('workspace-b');
    await act(async () => {
      notifyWorkspaceContextRefresh();
    });
    await waitFor(() => {
      expect(
        billingCalls.some((url) => url.includes('workspaceId=workspace-b')),
      ).toBe(true);
    });
    expect(hook.result.current).toBeNull();

    await act(async () => {
      resolveWorkspaceB(
        new Response(JSON.stringify(billingResponse('workspace-b', '8.50')), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    });
    await waitFor(() => {
      expect(hook.result.current?.workspaceBalance).toMatchObject({
        workspaceId: 'workspace-b',
        balanceUsd: '8.50',
      });
    });

    expect(billingCalls).toEqual([
      '/api/workspace/billing?scope=workspace&workspaceId=workspace-a',
      '/api/workspace/billing?scope=workspace&workspaceId=workspace-b',
    ]);
  });

  it('keeps a proven workspace balance when account metadata is unavailable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === '/api/workspace/context') {
          return new Response(JSON.stringify({ context: teamContext('workspace-a') }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (url.startsWith('/api/workspace/billing?')) {
          return new Response(JSON.stringify({
            ...billingResponse('workspace-a', '1.25'),
            summary: null,
          }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        throw new Error(`unexpected fetch ${url}`);
      }),
    );

    const hook = renderHook(() => useWorkspaceBillingResponse());
    await waitFor(() => {
      expect(hook.result.current?.summary).toBeNull();
      expect(hook.result.current?.workspaceBalance?.balanceUsd).toBe('1.25');
    });
  });

  it('uses the explicit account route for a personal workspace', async () => {
    const billingCalls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === '/api/workspace/context') {
          return new Response(
            JSON.stringify({
              context: {
                workspaceId: 'personal-a',
                workspaceType: 'personal',
                workspaceMemberId: 'member-personal',
              },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        if (url.startsWith('/api/workspace/billing?')) {
          billingCalls.push(url);
          return new Response(
            JSON.stringify({
              summary: {
                ...billingResponse('unused', '0').summary,
                workspaceBalance: null,
              },
              workspaceBalance: null,
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        throw new Error(`unexpected fetch ${url}`);
      }),
    );

    const hook = renderHook(() => useWorkspaceBilling());
    await waitFor(() => expect(hook.result.current).not.toBeNull());

    expect(billingCalls).toEqual(['/api/workspace/billing?scope=account']);
  });
});
