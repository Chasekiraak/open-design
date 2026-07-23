import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';

import { getAccessToken } from '../scripts/blog-indexing/lib.ts';

const originalEnv = { ...process.env };
const originalFetch = globalThis.fetch;
const originalWarn = console.warn;

test.afterEach(() => {
  process.env = { ...originalEnv };
  globalThis.fetch = originalFetch;
  console.warn = originalWarn;
});

test('blog indexing auth falls back to service account when OAuth refresh token is invalid', async () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const serviceAccountKey = {
    client_email: 'blog-indexing@example.iam.gserviceaccount.com',
    private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    token_uri: 'https://oauth2.googleapis.com/token',
  };
  const calls: Array<{ url: string; body: string }> = [];

  process.env.GSC_OAUTH_CLIENT_ID = 'client-id';
  process.env.GSC_OAUTH_CLIENT_SECRET = 'client-secret';
  process.env.GSC_OAUTH_REFRESH_TOKEN = 'stale-refresh-token';
  process.env.GSC_SERVICE_ACCOUNT_KEY = JSON.stringify(serviceAccountKey);
  const warnings: string[] = [];
  console.warn = (message?: unknown) => {
    warnings.push(String(message));
  };

  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: String(init?.body ?? '') });
    if (calls.length === 1) {
      return new Response(
        JSON.stringify({ error: 'invalid_grant', error_description: 'Bad Request' }),
        { status: 400 },
      );
    }
    return Response.json({ access_token: 'service-account-token', expires_in: 3600 });
  };

  const token = await getAccessToken();

  assert.equal(token, 'service-account-token');
  assert.equal(calls.length, 2);
  assert.match(calls[0]!.body, /grant_type=refresh_token/);
  assert.match(calls[1]!.body, /grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer/);
  assert.match(warnings[0] ?? '', /falling back to service account auth/);
});
