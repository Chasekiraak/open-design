import type { HubEventsSubscriber } from './hub-events-subscriber.js';

export interface WorkspaceHubSubscriptionManagerOptions {
  start(workspaceId: string): HubEventsSubscriber;
  /** Hard process cap; overflow workspaces recover through the poll floor. */
  maxSubscribers?: number;
}

/**
 * Owns the process-wide set of Vela workspace event streams.
 *
 * Ambient workspace activity and explicit billing interests are two reasons
 * for the same workspace stream, not two independent subscribers. Replacing
 * either reason set reconciles to one subscriber per workspace.
 */
export class WorkspaceHubSubscriptionManager {
  private ambientWorkspaceId: string | null = null;
  private billingWorkspaceIds = new Set<string>();
  private readonly subscribers = new Map<string, HubEventsSubscriber>();
  private disposed = false;
  private readonly maxSubscribers: number;

  constructor(private readonly options: WorkspaceHubSubscriptionManagerOptions) {
    this.maxSubscribers = Math.max(1, options.maxSubscribers ?? 8);
  }

  setAmbientWorkspace(workspaceIdInput: string | null | undefined): void {
    this.assertUsable();
    const workspaceId = workspaceIdInput?.trim() ?? '';
    if ((this.ambientWorkspaceId ?? '') === workspaceId) return;
    this.ambientWorkspaceId = workspaceId || null;
    this.reconcile();
  }

  setBillingInterests(workspaceIds: Iterable<string>): void {
    this.assertUsable();
    const next = new Set(
      [...workspaceIds]
        .map((workspaceId) => workspaceId.trim())
        .filter(Boolean),
    );
    if (sameSet(this.billingWorkspaceIds, next)) return;
    this.billingWorkspaceIds = next;
    this.reconcile();
  }

  activeWorkspaceIds(): string[] {
    return [...this.subscribers.keys()].sort();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const subscriber of this.subscribers.values()) subscriber.stop();
    this.subscribers.clear();
    this.billingWorkspaceIds.clear();
    this.ambientWorkspaceId = null;
  }

  private reconcile(): void {
    const ordered = [
      ...(this.ambientWorkspaceId ? [this.ambientWorkspaceId] : []),
      ...this.billingWorkspaceIds,
    ];
    const desired = new Set<string>();
    for (const workspaceId of ordered) {
      if (desired.size >= this.maxSubscribers) break;
      desired.add(workspaceId);
    }
    for (const [workspaceId, subscriber] of this.subscribers) {
      if (desired.has(workspaceId)) continue;
      subscriber.stop();
      this.subscribers.delete(workspaceId);
    }
    for (const workspaceId of desired) {
      if (this.subscribers.has(workspaceId)) continue;
      this.subscribers.set(workspaceId, this.options.start(workspaceId));
    }
  }

  private assertUsable(): void {
    if (this.disposed) {
      throw new Error('workspace hub subscription manager is disposed');
    }
  }
}

export function createWorkspaceHubSubscriptionManager(
  options: WorkspaceHubSubscriptionManagerOptions,
): WorkspaceHubSubscriptionManager {
  return new WorkspaceHubSubscriptionManager(options);
}

function sameSet(left: Set<string>, right: Set<string>): boolean {
  if (left.size !== right.size) return false;
  for (const value of left) {
    if (!right.has(value)) return false;
  }
  return true;
}
