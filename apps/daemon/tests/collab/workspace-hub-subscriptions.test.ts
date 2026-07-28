import { describe, expect, it, vi } from 'vitest';
import type { HubEventsSubscriber } from '../../src/collab/hub-events-subscriber.js';
import { createWorkspaceHubSubscriptionManager } from '../../src/collab/workspace-hub-subscriptions.js';

describe('WorkspaceHubSubscriptionManager', () => {
  it('dedupes ambient and billing reasons into one upstream per workspace', () => {
    const started: string[] = [];
    const stopped: string[] = [];
    const manager = createWorkspaceHubSubscriptionManager({
      start: (workspaceId): HubEventsSubscriber => {
        started.push(workspaceId);
        return {
          connected: () => true,
          refreshEndpoint: vi.fn(),
          stop: () => stopped.push(workspaceId),
        };
      },
    });

    manager.setAmbientWorkspace('workspace-a');
    manager.setBillingInterests(['workspace-a', 'workspace-b', 'workspace-b']);
    expect(started).toEqual(['workspace-a', 'workspace-b']);
    expect(manager.activeWorkspaceIds()).toEqual(['workspace-a', 'workspace-b']);

    manager.setAmbientWorkspace('workspace-b');
    expect(started).toEqual(['workspace-a', 'workspace-b']);
    expect(stopped).toEqual([]);

    manager.setBillingInterests(['workspace-b']);
    expect(stopped).toEqual(['workspace-a']);
    expect(manager.activeWorkspaceIds()).toEqual(['workspace-b']);

    manager.dispose();
    expect(stopped).toEqual(['workspace-a', 'workspace-b']);
  });

  it('stops a workspace immediately after its final reason is revoked', () => {
    const stop = vi.fn();
    const manager = createWorkspaceHubSubscriptionManager({
      start: (): HubEventsSubscriber => ({
        connected: () => false,
        refreshEndpoint: vi.fn(),
        stop,
      }),
    });
    manager.setBillingInterests(['workspace-a']);
    manager.setBillingInterests([]);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(manager.activeWorkspaceIds()).toEqual([]);
    manager.dispose();
  });

  it('caps live upstream SSE connections and always prioritizes the ambient workspace', () => {
    const started: string[] = [];
    const stopped: string[] = [];
    const manager = createWorkspaceHubSubscriptionManager({
      maxSubscribers: 2,
      start: (workspaceId): HubEventsSubscriber => {
        started.push(workspaceId);
        return {
          connected: () => true,
          refreshEndpoint: vi.fn(),
          stop: () => stopped.push(workspaceId),
        };
      },
    });

    manager.setBillingInterests(['workspace-a', 'workspace-b', 'workspace-c']);
    expect(manager.activeWorkspaceIds()).toEqual(['workspace-a', 'workspace-b']);
    manager.setAmbientWorkspace('workspace-c');
    expect(manager.activeWorkspaceIds()).toEqual(['workspace-a', 'workspace-c']);
    expect(started).toEqual(['workspace-a', 'workspace-b', 'workspace-c']);
    expect(stopped).toEqual(['workspace-b']);
    manager.dispose();
  });
});
