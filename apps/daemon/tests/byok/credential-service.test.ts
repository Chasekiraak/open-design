import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  ByokCredentialService,
  type ByokSecretBackend,
} from '../../src/byok/credential-service.js';

class MemorySecretBackend implements ByokSecretBackend {
  readonly kind = 'test-memory';
  readonly secrets = new Map<string, string>();

  async available() {
    return true;
  }

  async set(profileId: string, secret: string) {
    this.secrets.set(profileId, secret);
  }

  async get(profileId: string) {
    return this.secrets.get(profileId) ?? null;
  }

  async delete(profileId: string) {
    return this.secrets.delete(profileId);
  }
}

describe('BYOK credential service', () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it('keeps API keys in the secret backend and only non-secret profile metadata under OD_DATA_DIR', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'od-byok-credentials-'));
    roots.push(dataDir);
    const backend = new MemorySecretBackend();
    const service = new ByokCredentialService({ dataDir, backend });
    const apiKey = 'test-openrouter-secret-not-for-disk';

    const profile = await service.upsert({
      label: 'OpenRouter',
      protocol: 'openai',
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'openrouter/free',
      apiKey,
    });

    expect(profile).toMatchObject({
      label: 'OpenRouter',
      protocol: 'openai',
      configured: true,
      keyTail: 'disk',
    });
    expect(JSON.stringify(profile)).not.toContain(apiKey);
    const metadata = await readFile(path.join(dataDir, 'byok', 'profiles.json'), 'utf8');
    expect(metadata).not.toContain(apiKey);
    expect(metadata).not.toContain('keyTail');
    expect(backend.secrets.get(profile.id)).toBe(apiKey);

    const resolved = await service.resolve(profile.id);
    expect(resolved?.apiKey).toBe(apiKey);
    expect(JSON.stringify(await service.list())).not.toContain(apiKey);

    expect(await service.delete(profile.id)).toBe(true);
    expect(await service.resolve(profile.id)).toBeNull();
  });

  it('fails closed when no secure backend is available', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'od-byok-credentials-'));
    roots.push(dataDir);
    const backend = new MemorySecretBackend();
    backend.available = async () => false;
    const service = new ByokCredentialService({ dataDir, backend });

    await expect(service.upsert({
      label: 'OpenRouter',
      protocol: 'openai',
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'openrouter/free',
      apiKey: 'test-secret',
    })).rejects.toThrow(/secure credential storage is unavailable/i);
  });

  it('serializes concurrent metadata mutations so profiles cannot overwrite each other', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'od-byok-credentials-'));
    roots.push(dataDir);
    const service = new ByokCredentialService({
      dataDir,
      backend: new MemorySecretBackend(),
    });

    await Promise.all([
      service.upsert({
        id: 'byok-provider-one',
        label: 'Provider One',
        protocol: 'openai',
        baseUrl: 'https://one.example/v1',
        model: 'model-one',
        apiKey: 'test-secret-one',
      }),
      service.upsert({
        id: 'byok-provider-two',
        label: 'Provider Two',
        protocol: 'openai',
        baseUrl: 'https://two.example/v1',
        model: 'model-two',
        apiKey: 'test-secret-two',
      }),
    ]);

    expect((await service.list()).map((profile) => profile.id).sort()).toEqual([
      'byok-provider-one',
      'byok-provider-two',
    ]);
  });

  it.each([
    'https://user:password@example.test/v1',
    'https://example.test/v1?api_key=plaintext',
    'https://example.test/v1#plaintext',
  ])('rejects credential-bearing provider metadata before persistence: %s', async (baseUrl) => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'od-byok-credentials-'));
    roots.push(dataDir);
    const service = new ByokCredentialService({
      dataDir,
      backend: new MemorySecretBackend(),
    });

    await expect(service.upsert({
      label: 'Unsafe',
      protocol: 'openai',
      baseUrl,
      model: 'model',
      apiKey: 'test-secret',
    })).rejects.toThrow(/without credentials, query, or fragment/i);
  });
});
