import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTeamResourceVersionStore } from '../src/collab/team-resource-version-store.js';

const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    roots.splice(0).map((root) =>
      fs.promises.rm(root, { recursive: true, force: true }),
    ),
  );
});

describe('team resource version store', () => {
  it('persists independent workspace and resource cursors', async () => {
    const root = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), 'od-team-resource-versions-'),
    );
    roots.push(root);
    const store = createTeamResourceVersionStore(root);

    await store.set('team-a', 'skill', 'review-kit', 'version-1');
    await store.set('team-b', 'skill', 'review-kit', 'version-2');

    const reloaded = createTeamResourceVersionStore(root);
    expect(reloaded.get('team-a', 'skill', 'review-kit')).toBe('version-1');
    expect(reloaded.get('team-b', 'skill', 'review-kit')).toBe('version-2');
    expect(reloaded.get('team-a', 'plugin', 'review-kit')).toBeNull();
  });

  it('publishes a cursor in memory only after the atomic rename commits', async () => {
    const root = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), 'od-team-resource-versions-'),
    );
    roots.push(root);
    const store = createTeamResourceVersionStore(root);
    vi.spyOn(fs.promises, 'rename').mockRejectedValueOnce(
      new Error('disk unavailable'),
    );

    await expect(
      store.set('team-a', 'project-content', 'project-a', '7'),
    ).rejects.toThrow('disk unavailable');
    expect(store.get('team-a', 'project-content', 'project-a')).toBeNull();

    // The rejected write must not poison the queue or leak into later writes.
    // Concurrent keys serialize, and each next snapshot builds from the last
    // successfully committed in-memory state.
    await Promise.all([
      store.set('team-a', 'project-content', 'project-b', '8'),
      store.set('team-a', 'project-content', 'project-c', '9'),
    ]);

    expect(store.get('team-a', 'project-content', 'project-a')).toBeNull();
    expect(store.get('team-a', 'project-content', 'project-b')).toBe('8');
    expect(store.get('team-a', 'project-content', 'project-c')).toBe('9');
    const reloaded = createTeamResourceVersionStore(root);
    expect(reloaded.get('team-a', 'project-content', 'project-a')).toBeNull();
    expect(reloaded.get('team-a', 'project-content', 'project-b')).toBe('8');
    expect(reloaded.get('team-a', 'project-content', 'project-c')).toBe('9');
  });
});
