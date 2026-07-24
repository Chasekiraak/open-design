import { afterEach, describe, expect, it, vi } from 'vitest';

import { handleMcpToolCall, TOOL_DEFS } from '../src/mcp.js';

const originalFetch = globalThis.fetch;

function firstText(result: { content: Array<{ text: string }> }): string {
  const item = result.content[0];
  if (!item) throw new Error('expected MCP text content');
  return item.text;
}

describe('local MCP Vela login tools', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    globalThis.fetch = originalFetch;
  });

  it('advertises narrow Vela login and login-status tools', () => {
    const names = TOOL_DEFS.map((tool) => tool.name);
    expect(names).toContain('start_vela_login');
    expect(names).toContain('get_vela_login_status');
  });

  it('starts login through the local daemon, then returns a sanitized activation state', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/api/integrations/vela/login')) {
        expect(init?.method).toBe('POST');
        return new Response(
          JSON.stringify({ pid: 42, startedAt: '2026-07-24T00:00:00.000Z', profile: 'default' }),
          { status: 202 },
        );
      }
      if (url.endsWith('/api/integrations/vela/status')) {
        return new Response(
          JSON.stringify({
            loggedIn: false,
            loginInFlight: true,
            profile: 'default',
            user: null,
            configPath: '/local/private/vela.json',
            activationUrl: 'https://amr-link.open-design.ai/activate',
            userCode: 'ABCD-EFGH',
          }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected URL ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await handleMcpToolCall(
      'http://127.0.0.1:17456',
      'start_vela_login',
      {},
    );
    const payload = JSON.parse(firstText(result));

    expect(payload).toEqual({
      started: { pid: 42, startedAt: '2026-07-24T00:00:00.000Z', profile: 'default' },
      status: {
        loggedIn: false,
        loginInFlight: true,
        profile: 'default',
        user: null,
        activationUrl: 'https://amr-link.open-design.ai/activate',
        userCode: 'ABCD-EFGH',
      },
    });
    expect(firstText(result)).not.toContain('/local/private');
  });

  it('gets the current login status without exposing the local config path', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toBe('http://127.0.0.1:17456/api/integrations/vela/status');
      return new Response(
        JSON.stringify({
          loggedIn: true,
          loginInFlight: false,
          profile: 'default',
          user: { id: 'user-1', email: 'person@example.com' },
          configPath: '/local/private/vela.json',
        }),
        { status: 200 },
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await handleMcpToolCall(
      'http://127.0.0.1:17456',
      'get_vela_login_status',
      {},
    );
    const payload = JSON.parse(firstText(result));

    expect(payload).toMatchObject({
      loggedIn: true,
      loginInFlight: false,
      profile: 'default',
    });
    expect(payload).not.toHaveProperty('configPath');
  });
});
