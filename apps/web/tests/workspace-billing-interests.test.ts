// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ensureWorkspaceBillingInterestDeclared,
  resetWorkspaceBillingInterestRegistry,
  retainWorkspaceBillingInterest,
  workspaceBillingInterestHeaders,
} from '../src/collab/workspace-billing-interests';

const SCOPE_A = { workspaceId: 'workspace-a', workspaceMemberId: 'member-a' };
const SCOPE_B = { workspaceId: 'workspace-b', workspaceMemberId: 'member-b' };

describe('workspace billing renderer interest registry', () => {
  beforeEach(() => {
    resetWorkspaceBillingInterestRegistry();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    resetWorkspaceBillingInterestRegistry();
  });

  it('declares one renderer full set for simultaneous ambient A and project B', async () => {
    const requests: Array<{ method: string; generation: string; interests: unknown[] }> = [];
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        generation: string;
        interests: unknown[];
      };
      requests.push({
        method: init?.method ?? 'GET',
        generation: body.generation,
        interests: body.interests,
      });
      return new Response(JSON.stringify({
        clientId: workspaceBillingInterestHeaders(SCOPE_A)[
          'x-od-workspace-runtime-client-id'
        ],
        acceptedGeneration: body.generation,
        leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }));

    const releaseA = retainWorkspaceBillingInterest('ambient', SCOPE_A);
    const releaseB = retainWorkspaceBillingInterest('project', SCOPE_B);
    await ensureWorkspaceBillingInterestDeclared();

    expect(requests.at(-1)).toMatchObject({
      method: 'PUT',
      generation: '2',
      interests: [SCOPE_A, SCOPE_B],
    });
    const headersA = workspaceBillingInterestHeaders(SCOPE_A);
    const headersB = workspaceBillingInterestHeaders(SCOPE_B);
    expect(headersA['x-od-workspace-runtime-client-id']).toBe(
      headersB['x-od-workspace-runtime-client-id'],
    );
    expect(headersA['x-od-workspace-runtime-generation']).toBe('2');
    expect(headersB['x-od-workspace-runtime-generation']).toBe('2');

    releaseA();
    await ensureWorkspaceBillingInterestDeclared();
    expect(requests.at(-1)).toMatchObject({
      generation: '3',
      interests: [SCOPE_B],
    });
    releaseB();
  });

  it('revokes the daemon lease when the final renderer owner unmounts', async () => {
    const methods: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      methods.push(init?.method ?? 'GET');
      if (init?.method === 'DELETE') {
        expect(String(input)).toContain('generation=2');
        return new Response(JSON.stringify({ ok: true, released: true }), {
          status: 200,
        });
      }
      const body = JSON.parse(String(init?.body)) as { generation: string };
      const clientId = decodeURIComponent(String(input).split('/').at(-1)!);
      return new Response(JSON.stringify({
        clientId,
        acceptedGeneration: body.generation,
        leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }));

    const release = retainWorkspaceBillingInterest('surface', SCOPE_A);
    await ensureWorkspaceBillingInterestDeclared();
    release();
    await ensureWorkspaceBillingInterestDeclared();
    expect(methods).toEqual(['PUT', 'DELETE']);
  });

  it('degrades additively when an old daemon has no interest endpoint', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 404 }));
    vi.stubGlobal('fetch', fetchMock);
    retainWorkspaceBillingInterest('surface', SCOPE_A);
    await ensureWorkspaceBillingInterestDeclared();
    await ensureWorkspaceBillingInterestDeclared();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(workspaceBillingInterestHeaders(SCOPE_A)).toEqual({});
  });
});
