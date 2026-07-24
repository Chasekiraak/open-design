// @vitest-environment jsdom
//
// Perf follow-up to the 29e8b4c85 fail-closed fix: `/collab/status` is a
// plain project-keyed read (the daemon resolves the caller's own identity
// server-side from request headers/cookies, not from anything the front end
// sends), so it does not need to wait for `/api/workspace/context` to resolve
// `member` first. Before this, `useCollab`'s single `active` gate required
// `member` — which only exists once `resolveCollabSession` has a context —
// so the two real network round-trips ran serialized (~5s on a cold real hub)
// instead of in parallel (~2.5s). These tests pin: (1) the status poll now
// starts in the same tick the workspace-context read is still pending,
// without ever announcing presence before an identity resolves, and (2) once
// the context read resolves to a CONFIRMED permission-denied reason (member
// removed, workspace frozen) — an identity/permission gate, not a
// "haven't read the response yet" problem — the poll stops, so decoupling did
// not open a lasting leak.

import { act, cleanup, renderHook } from '@testing-library/react';
import {
  buildWorkspacePermissions,
  buildWorkspaceSeatSummary,
  type WorkspaceCollabContext,
  type WorkspaceLifecycleState,
} from '@open-design/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useProjectCollab } from '../src/collab/useProjectCollab';

function teamContext(overrides: Partial<WorkspaceCollabContext> = {}): WorkspaceCollabContext {
  const role = 'member' as const;
  const lifecycleState = (overrides.lifecycleState ?? 'active') as WorkspaceLifecycleState;
  return {
    workspaceId: 'ws-1',
    workspaceType: 'team',
    workspaceMemberId: 'wm-1',
    role,
    memberStatus: 'active',
    lifecycleState,
    billingState: 'active',
    planId: null,
    providerMode: 'platform_credits',
    seatSummary: buildWorkspaceSeatSummary({ seatLimit: 5, usedSeats: 1 }),
    permissions: buildWorkspacePermissions({ role, lifecycleState }),
    displayName: 'Ma Shu',
    ...overrides,
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('useProjectCollab: status poll runs in parallel with /api/workspace/context', () => {
  it('starts /collab/status while the workspace-context read is still pending', async () => {
    const calls: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const pathname = new URL(String(input), 'http://d.local').pathname;
      calls.push(pathname);
      if (pathname.endsWith('/workspace/context')) {
        return new Promise<Response>(() => {
          /* never resolves — models the ~2.5s real hub round-trip */
        });
      }
      if (pathname.endsWith('/collab/status')) {
        return { ok: true, status: 200, json: async () => ({ publishedVersion: 1, syncState: 'synced' }) } as unknown as Response;
      }
      return { ok: true, status: 200, json: async () => ({ ok: true }) } as unknown as Response;
    }) as typeof fetch;

    renderHook(() => useProjectCollab('p1', { fetch: fetchImpl }));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    // The status read fired even though /api/workspace/context never answered.
    expect(calls.some((p) => p.endsWith('/collab/status'))).toBe(true);
    // Presence never announces itself without a resolved identity — the
    // context read (which member depends on) is still hanging.
    expect(calls.some((p) => p.endsWith('/presence/heartbeat'))).toBe(false);
  });

  it('keeps polling status on its normal cadence while member resolves, then starts presence', async () => {
    let contextCalls = 0;
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const pathname = new URL(String(input), 'http://d.local').pathname;
      if (pathname.endsWith('/workspace/context')) {
        contextCalls += 1;
        // Resolves on the SECOND call to model a real async round-trip that
        // outlives the first render/effect flush.
        if (contextCalls < 2) return new Promise<Response>(() => {});
        return { ok: true, status: 200, json: async () => ({ context: teamContext() }) } as unknown as Response;
      }
      if (pathname.endsWith('/collab/status')) {
        return { ok: true, status: 200, json: async () => ({ publishedVersion: 1, syncState: 'synced' }) } as unknown as Response;
      }
      if (pathname.endsWith('/presence/heartbeat')) {
        return { ok: true, status: 200, json: async () => ({ present: [{ memberId: 'wm-1' }] }) } as unknown as Response;
      }
      return { ok: true, status: 200, json: async () => ({ ok: true }) } as unknown as Response;
    }) as typeof fetch;

    const { result } = renderHook(() => useProjectCollab('p1', { fetch: fetchImpl }));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    // Context is still hanging on this first flush; status already answered.
    expect(result.current.syncState).toBe('synced');
    expect(result.current.enabled).toBe(false);
    expect(result.current.present).toEqual([]);
  });
});

describe('useProjectCollab: confirmed permission-denied reasons still stop the status poll', () => {
  it('stops polling once the context confirms the member was removed', async () => {
    const calls: string[] = [];
    const removed = teamContext({ memberStatus: 'removed' });
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const pathname = new URL(String(input), 'http://d.local').pathname;
      calls.push(pathname);
      if (pathname.endsWith('/workspace/context')) {
        return { ok: true, status: 200, json: async () => ({ context: removed }) } as unknown as Response;
      }
      if (pathname.endsWith('/collab/status')) {
        return { ok: true, status: 200, json: async () => ({ publishedVersion: 1, syncState: 'local_only' }) } as unknown as Response;
      }
      return { ok: true, status: 200, json: async () => ({ ok: true }) } as unknown as Response;
    }) as typeof fetch;

    const { result } = renderHook(() => useProjectCollab('p1', { fetch: fetchImpl, statusPollMs: 50 }));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(0);
    });

    // It DID start (the decoupling worked)…
    expect(calls.some((p) => p.endsWith('/collab/status'))).toBe(true);
    // …but a removed member never gets a presence identity.
    expect(calls.some((p) => p.endsWith('/presence/heartbeat'))).toBe(false);
    expect(result.current.enabled).toBe(false);

    const pollsAtSettle = calls.filter((p) => p.endsWith('/collab/status')).length;

    // Advance well past several poll intervals.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });

    const pollsAfterWaiting = calls.filter((p) => p.endsWith('/collab/status')).length;
    // …and it stops for good once the removal is confirmed, not just paused.
    expect(pollsAfterWaiting).toBe(pollsAtSettle);
  });

  it('stops polling once the context confirms the workspace lifecycle is frozen (locked)', async () => {
    const calls: string[] = [];
    const locked = teamContext({ lifecycleState: 'locked' });
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const pathname = new URL(String(input), 'http://d.local').pathname;
      calls.push(pathname);
      if (pathname.endsWith('/workspace/context')) {
        return { ok: true, status: 200, json: async () => ({ context: locked }) } as unknown as Response;
      }
      if (pathname.endsWith('/collab/status')) {
        return { ok: true, status: 200, json: async () => ({ publishedVersion: 1, syncState: 'local_only' }) } as unknown as Response;
      }
      return { ok: true, status: 200, json: async () => ({ ok: true }) } as unknown as Response;
    }) as typeof fetch;

    const { result } = renderHook(() => useProjectCollab('p1', { fetch: fetchImpl, statusPollMs: 50 }));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(calls.some((p) => p.endsWith('/collab/status'))).toBe(true);
    expect(calls.some((p) => p.endsWith('/presence/heartbeat'))).toBe(false);
    expect(result.current.enabled).toBe(false);

    const pollsAtSettle = calls.filter((p) => p.endsWith('/collab/status')).length;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });

    const pollsAfterWaiting = calls.filter((p) => p.endsWith('/collab/status')).length;
    expect(pollsAfterWaiting).toBe(pollsAtSettle);
  });

  it('never polls status at all when there is no project id', async () => {
    const calls: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const pathname = new URL(String(input), 'http://d.local').pathname;
      calls.push(pathname);
      return { ok: true, status: 200, json: async () => ({ context: teamContext() }) } as unknown as Response;
    }) as typeof fetch;

    renderHook(() => useProjectCollab(null, { fetch: fetchImpl, statusPollMs: 50 }));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });

    expect(calls.some((p) => p.endsWith('/collab/status'))).toBe(false);
  });
});
