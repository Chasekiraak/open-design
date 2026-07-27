// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceCollabContext } from '@open-design/contracts';

import { resetCoalescedGet } from '../src/lib/coalesced-get';
import {
  lastResolvedWorkspaceContext,
  notifyWorkspaceContextRefresh,
  resetWorkspaceBillingCache,
  resetWorkspaceContextCache,
  shouldRefreshWorkspaceBilling,
  useWorkspaceBilling,
  useWorkspaceBillingResponse,
} from '../src/collab/useWorkspaceContext';

function teamContext(workspaceId: string): WorkspaceCollabContext {
  return {
    workspaceId,
    workspaceType: 'team',
    workspaceMemberId: `member-${workspaceId}`,
    role: 'member',
    memberStatus: 'active',
    lifecycleState: 'active',
  } as WorkspaceCollabContext;
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

type EventSourceListener = (event: unknown) => void;
class MockWorkspaceEventSource {
  static instances: MockWorkspaceEventSource[] = [];
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  listeners = new Map<string, Set<EventSourceListener>>();

  constructor(readonly url: string) {
    MockWorkspaceEventSource.instances.push(this);
  }

  addEventListener(name: string, listener: EventSourceListener): void {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    this.listeners.get(name)!.add(listener);
  }

  removeEventListener(name: string, listener: EventSourceListener): void {
    this.listeners.get(name)?.delete(listener);
  }

  dispatch(name: string, data: unknown): void {
    for (const listener of this.listeners.get(name) ?? []) {
      listener({ data: JSON.stringify(data) });
    }
  }

  close(): void {}
}

describe('useWorkspaceBilling explicit scope', () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    resetCoalescedGet();
    resetWorkspaceContextCache();
    resetWorkspaceBillingCache();
    MockWorkspaceEventSource.instances = [];
    vi.stubGlobal('EventSource', MockWorkspaceEventSource as unknown as typeof EventSource);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    window.sessionStorage.clear();
    resetCoalescedGet();
    resetWorkspaceContextCache();
    resetWorkspaceBillingCache();
  });

  it('accepts only v2 invalidations for the selected workspace and member', () => {
    const context = teamContext('workspace-a');
    expect(
      shouldRefreshWorkspaceBilling(
        {
          type: 'billing-subscription-changed',
          workspaceId: 'workspace-a',
          revision: 'billing-2',
        },
        context,
      ),
    ).toBe(true);
    expect(
      shouldRefreshWorkspaceBilling(
        {
          type: 'wallet-balance-changed',
          workspaceId: 'workspace-a',
          workspaceMemberId: 'member-workspace-a',
          revision: 'wallet-2',
        },
        context,
      ),
    ).toBe(true);
    expect(
      shouldRefreshWorkspaceBilling(
        {
          type: 'wallet-balance-changed',
          workspaceId: 'workspace-a',
          workspaceMemberId: 'member-other',
          revision: 'wallet-3',
        },
        context,
      ),
    ).toBe(false);
    expect(
      shouldRefreshWorkspaceBilling(
        {
          type: 'billing-changed',
          workspaceId: 'workspace-b',
          revision: 'legacy-v2-alias',
        },
        context,
      ),
    ).toBe(false);
    expect(
      shouldRefreshWorkspaceBilling(
        {
          type: 'wallet-balance-changed',
          workspaceId: 'workspace-b',
          workspaceMemberId: 'member-workspace-a',
        },
        context,
      ),
    ).toBe(false);
  });

  it('forces a fresh read for legacy and matching v2 billing invalidations', async () => {
    let balance = '1.25';
    const billingCalls: string[] = [];
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
          billingCalls.push(url);
          return new Response(JSON.stringify(billingResponse('workspace-a', balance)), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        throw new Error(`unexpected fetch ${url}`);
      }),
    );

    const hook = renderHook(() => useWorkspaceBillingResponse());
    await waitFor(() => expect(hook.result.current?.workspaceBalance?.balanceUsd).toBe('1.25'));
    expect(MockWorkspaceEventSource.instances).toHaveLength(1);

    balance = '2.50';
    act(() => {
      MockWorkspaceEventSource.instances[0]!.dispatch('billing-changed', {
        type: 'billing-changed',
      });
    });
    await waitFor(() => expect(hook.result.current?.workspaceBalance?.balanceUsd).toBe('2.50'));

    const beforeForeign = billingCalls.length;
    act(() => {
      MockWorkspaceEventSource.instances[0]!.dispatch('wallet-balance-changed', {
        type: 'wallet-balance-changed',
        workspaceId: 'workspace-a',
        workspaceMemberId: 'member-other',
        revision: 'wallet-foreign',
      });
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(billingCalls).toHaveLength(beforeForeign);

    balance = '3.75';
    act(() => {
      MockWorkspaceEventSource.instances[0]!.dispatch('wallet-balance-changed', {
        type: 'wallet-balance-changed',
        workspaceId: 'workspace-a',
        workspaceMemberId: 'member-workspace-a',
        revision: 'wallet-current',
      });
    });
    await waitFor(() => expect(hook.result.current?.workspaceBalance?.balanceUsd).toBe('3.75'));

    balance = '4.00';
    const beforeAliases = billingCalls.length;
    act(() => {
      MockWorkspaceEventSource.instances[0]!.dispatch('billing-subscription-changed', {
        type: 'billing-subscription-changed',
        workspaceId: 'workspace-a',
        revision: 'shared-revision',
      });
      MockWorkspaceEventSource.instances[0]!.dispatch('billing-changed', {
        type: 'billing-changed',
        workspaceId: 'workspace-a',
        revision: 'shared-revision',
      });
    });
    await waitFor(() => expect(hook.result.current?.workspaceBalance?.balanceUsd).toBe('4.00'));
    expect(billingCalls.length - beforeAliases).toBe(1);
  });

  it('rejects a late response from the first A after switching A to B to A', async () => {
    let currentContext = teamContext('workspace-a');
    let billingACalls = 0;
    let resolveOldA!: (response: Response) => void;
    const oldAResponse = new Promise<Response>((resolve) => {
      resolveOldA = resolve;
    });

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
          const workspaceId = new URL(url, 'http://open-design.test').searchParams.get(
            'workspaceId',
          );
          if (workspaceId === 'workspace-b') {
            return new Response(JSON.stringify(billingResponse('workspace-b', '8.50')), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            });
          }
          if (workspaceId === 'workspace-a') {
            billingACalls += 1;
            if (billingACalls === 1) {
              return new Response(JSON.stringify(billingResponse('workspace-a', '1.25')), {
                status: 200,
                headers: { 'content-type': 'application/json' },
              });
            }
            if (billingACalls === 2) return oldAResponse;
            return new Response(JSON.stringify(billingResponse('workspace-a', '3.75')), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            });
          }
        }
        throw new Error(`unexpected fetch ${url}`);
      }),
    );

    const hook = renderHook(() => useWorkspaceBillingResponse());
    await waitFor(() => expect(hook.result.current?.workspaceBalance?.balanceUsd).toBe('1.25'));

    act(() => {
      MockWorkspaceEventSource.instances[0]!.dispatch('billing-changed', {
        type: 'billing-changed',
        at: 1,
      });
    });
    await waitFor(() => expect(billingACalls).toBe(2));

    currentContext = teamContext('workspace-b');
    act(() => notifyWorkspaceContextRefresh());
    await waitFor(() => {
      expect(hook.result.current?.workspaceBalance?.workspaceId).toBe('workspace-b');
    });

    // Explicit refreshes are burst-coalesced for multi-consumer mounts. This is
    // a separate user switch, outside that one-event burst.
    await new Promise((resolve) => setTimeout(resolve, 300));
    currentContext = teamContext('workspace-a');
    act(() => notifyWorkspaceContextRefresh());
    await waitFor(() => {
      expect(hook.result.current?.workspaceBalance).toMatchObject({
        workspaceId: 'workspace-a',
        balanceUsd: '3.75',
      });
    });

    await act(async () => {
      resolveOldA(
        new Response(JSON.stringify(billingResponse('workspace-a', '0.50')), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
      await oldAResponse;
    });
    expect(hook.result.current?.workspaceBalance?.balanceUsd).toBe('3.75');
  });

  it('keeps last-good money on a pushed read failure and retries after five seconds', async () => {
    let billingCalls = 0;
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
          billingCalls += 1;
          if (billingCalls === 2) throw new Error('temporary daemon read failure');
          const balance = billingCalls >= 3 ? '2.50' : '1.25';
          return new Response(JSON.stringify(billingResponse('workspace-a', balance)), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        throw new Error(`unexpected fetch ${url}`);
      }),
    );

    const hook = renderHook(() => useWorkspaceBillingResponse());
    await waitFor(() => expect(hook.result.current?.workspaceBalance?.balanceUsd).toBe('1.25'));

    act(() => {
      MockWorkspaceEventSource.instances[0]!.dispatch('billing-changed', {
        type: 'billing-changed',
        at: 2,
      });
    });
    await waitFor(() => expect(billingCalls).toBe(2));
    expect(hook.result.current?.workspaceBalance?.balanceUsd).toBe('1.25');

    await waitFor(
      () => expect(hook.result.current?.workspaceBalance?.balanceUsd).toBe('2.50'),
      { timeout: 6_000 },
    );
  }, 7_000);

  it('projects the authoritative workspace plan over stale account metadata', async () => {
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
            summary: {
              ...billingResponse('workspace-a', '1.25').summary,
              membershipTier: 'free',
              subscriptionStatus: 'inactive',
            },
            workspaceSnapshot: {
              schemaVersion: 1,
              workspaceId: 'workspace-a',
              workspaceMemberId: 'member-workspace-a',
              billingScopeVersion: 2,
              billing: { billingState: 'active', planId: 'team_plus' },
              wallet: {
                balanceUsd: '1.25',
                expiresAt: null,
                updatedAt: '2026-07-27T00:00:00Z',
              },
              revisions: { billing: 'b2', wallet: 'w2' },
            },
          }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        throw new Error(`unexpected fetch ${url}`);
      }),
    );

    const hook = renderHook(() => useWorkspaceBilling());
    await waitFor(() => expect(hook.result.current?.membershipTier).toBe('team_plus'));
    expect(hook.result.current?.subscriptionStatus).toBe('active');
  });

  it('keys A and B separately and never shows A while B is still loading', async () => {
    let currentContext = teamContext('workspace-a');
    let resolveWorkspaceB!: (response: Response) => void;
    const workspaceBResponse = new Promise<Response>((resolve) => {
      resolveWorkspaceB = resolve;
    });
    const billingCalls: string[] = [];
    const runtimeHeaders: Array<{ clientId: string; generation: string }> = [];

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === '/api/workspace/context') {
          return new Response(JSON.stringify({ context: currentContext }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (url.startsWith('/api/workspace/billing?')) {
          billingCalls.push(url);
          const headers = new Headers(init?.headers);
          runtimeHeaders.push({
            clientId: headers.get('x-od-workspace-runtime-client-id') ?? '',
            generation: headers.get('x-od-workspace-runtime-generation') ?? '',
          });
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
    expect(runtimeHeaders).toHaveLength(2);
    expect(runtimeHeaders[0]!.clientId).not.toBe('');
    expect(runtimeHeaders[1]!.clientId).toBe(runtimeHeaders[0]!.clientId);
    expect(BigInt(runtimeHeaders[1]!.generation)).toBeGreaterThan(
      BigInt(runtimeHeaders[0]!.generation),
    );
  });

  it('gives each renderer page lifecycle an independent runtime client id', async () => {
    const runtimeHeaders: Array<{ clientId: string; generation: string }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === '/api/workspace/context') {
          return new Response(JSON.stringify({ context: teamContext('workspace-a') }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (url.startsWith('/api/workspace/billing?')) {
          const headers = new Headers(init?.headers);
          runtimeHeaders.push({
            clientId: headers.get('x-od-workspace-runtime-client-id') ?? '',
            generation: headers.get('x-od-workspace-runtime-generation') ?? '',
          });
          return new Response(JSON.stringify(billingResponse('workspace-a', '1.25')), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        throw new Error(`unexpected fetch ${url}`);
      }),
    );

    const firstPage = renderHook(() => useWorkspaceBillingResponse());
    await waitFor(() => expect(runtimeHeaders).toHaveLength(1));
    firstPage.unmount();

    // The reset seam models a new renderer module/page lifecycle while keeping
    // sessionStorage intact, as Duplicate Tab/window.open may do.
    resetCoalescedGet();
    resetWorkspaceContextCache();
    resetWorkspaceBillingCache();

    const secondPage = renderHook(() => useWorkspaceBillingResponse());
    await waitFor(() => expect(runtimeHeaders).toHaveLength(2));
    secondPage.unmount();

    expect(runtimeHeaders[0]!.clientId).not.toBe('');
    expect(runtimeHeaders[1]!.clientId).not.toBe(runtimeHeaders[0]!.clientId);
    expect(runtimeHeaders.map((header) => header.generation)).toEqual(['1', '1']);
  });

  it('retains additive daemon runtime freshness metadata', async () => {
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
            workspaceRuntime: {
              workspaceId: 'workspace-a',
              workspaceMemberId: 'member-workspace-a',
              status: 'fresh',
              revision: '7',
              observedAt: '2026-07-27T00:00:00.000Z',
              retryAt: null,
              errorCode: null,
              reason: 'poll-floor',
              sourceGapDetected: false,
            },
          }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        throw new Error(`unexpected fetch ${url}`);
      }),
    );

    const hook = renderHook(() => useWorkspaceBillingResponse());
    await waitFor(() => expect(hook.result.current?.workspaceRuntime).toMatchObject({
      status: 'fresh',
      revision: '7',
      reason: 'poll-floor',
    }));
  });

  it('keeps B when the initial A context response arrives after the explicit switch', async () => {
    let resolveWorkspaceAContext!: (response: Response) => void;
    const workspaceAContextResponse = new Promise<Response>((resolve) => {
      resolveWorkspaceAContext = resolve;
    });
    let contextCalls = 0;
    const billingCalls: string[] = [];

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === '/api/workspace/context') {
          contextCalls += 1;
          if (contextCalls === 1) return workspaceAContextResponse;
          if (contextCalls === 2) {
            return new Response(JSON.stringify({ context: teamContext('workspace-b') }), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            });
          }
        }
        if (url.startsWith('/api/workspace/billing?')) {
          billingCalls.push(url);
          const workspaceId = new URL(url, 'http://open-design.test').searchParams.get(
            'workspaceId',
          );
          if (workspaceId === 'workspace-a' || workspaceId === 'workspace-b') {
            return new Response(
              JSON.stringify(
                billingResponse(
                  workspaceId,
                  workspaceId === 'workspace-a' ? '1.25' : '8.50',
                ),
              ),
              {
                status: 200,
                headers: { 'content-type': 'application/json' },
              },
            );
          }
        }
        throw new Error(`unexpected fetch ${url}`);
      }),
    );

    const hook = renderHook(() => useWorkspaceBillingResponse());
    await waitFor(() => expect(contextCalls).toBe(1));

    await act(async () => {
      notifyWorkspaceContextRefresh();
    });
    await waitFor(() => {
      expect(hook.result.current?.workspaceBalance).toMatchObject({
        workspaceId: 'workspace-b',
        balanceUsd: '8.50',
      });
    });

    await act(async () => {
      resolveWorkspaceAContext(
        new Response(JSON.stringify({ context: teamContext('workspace-a') }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
      await workspaceAContextResponse;
    });

    await waitFor(() => {
      expect(hook.result.current?.workspaceBalance).toMatchObject({
        workspaceId: 'workspace-b',
        balanceUsd: '8.50',
      });
    });
    expect(lastResolvedWorkspaceContext()?.workspaceId).toBe('workspace-b');
    expect(billingCalls).toEqual([
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
