import type {
  WorkspaceBillingInterestResponse,
  WorkspaceBillingInterestScope,
} from '@open-design/contracts';

const RENEW_FLOOR_MS = 5_000;
const RENEW_CEILING_MS = 20_000;

interface OwnerInterest extends WorkspaceBillingInterestScope {
  ownerId: string;
}

/**
 * Renderer-lifetime full interest-set lease.
 *
 * Hooks only retain/release exact scopes. This registry is the sole writer of
 * the renderer's daemon declaration, so ambient and project-scoped hooks can
 * coexist without racing one global "current workspace" generation.
 */
class WorkspaceBillingInterestRegistry {
  private readonly owners = new Map<string, OwnerInterest>();
  private generation = 0n;
  private signature = '';
  private declaredSignature = '';
  private clientId = createClientId();
  private inFlight: Promise<void> | null = null;
  private renewTimer: ReturnType<typeof setTimeout> | null = null;
  private unsupported = false;
  private disposed = false;

  retain(ownerId: string, scope: WorkspaceBillingInterestScope): () => void {
    const normalized: OwnerInterest = {
      ownerId,
      workspaceId: scope.workspaceId.trim(),
      workspaceMemberId: scope.workspaceMemberId.trim(),
    };
    if (!normalized.workspaceId || !normalized.workspaceMemberId) {
      return () => undefined;
    }
    this.owners.set(ownerId, normalized);
    this.bumpGenerationIfChanged();
    void this.flush();
    return () => this.release(ownerId);
  }

  async ensureDeclared(): Promise<void> {
    await this.flush();
  }

  headersFor(scope: WorkspaceBillingInterestScope): Record<string, string> {
    const normalized = `${scope.workspaceId.trim()}\0${scope.workspaceMemberId.trim()}`;
    const declared = this.scopes().some(
      (candidate) =>
        `${candidate.workspaceId}\0${candidate.workspaceMemberId}` === normalized,
    );
    return declared && !this.unsupported
      ? {
          'x-od-workspace-runtime-client-id': this.clientId,
          'x-od-workspace-runtime-generation': this.generation.toString(),
        }
      : {};
  }

  reset(): void {
    if (this.renewTimer) clearTimeout(this.renewTimer);
    this.renewTimer = null;
    this.owners.clear();
    this.generation = 0n;
    this.signature = '';
    this.declaredSignature = '';
    this.clientId = createClientId();
    this.inFlight = null;
    this.unsupported = false;
    this.disposed = false;
  }

  private release(ownerId: string): void {
    if (!this.owners.delete(ownerId)) return;
    this.bumpGenerationIfChanged();
    void this.flush();
  }

  private bumpGenerationIfChanged(): void {
    const signature = JSON.stringify(this.scopes());
    if (signature === this.signature) return;
    this.signature = signature;
    this.generation += 1n;
  }

  private scopes(): WorkspaceBillingInterestScope[] {
    const deduped = new Map<string, WorkspaceBillingInterestScope>();
    for (const owner of this.owners.values()) {
      const key = `${owner.workspaceId}\0${owner.workspaceMemberId}`;
      deduped.set(key, {
        workspaceId: owner.workspaceId,
        workspaceMemberId: owner.workspaceMemberId,
      });
    }
    return [...deduped.values()].sort((left, right) =>
      `${left.workspaceId}\0${left.workspaceMemberId}`.localeCompare(
        `${right.workspaceId}\0${right.workspaceMemberId}`,
      ),
    );
  }

  private flush(): Promise<void> {
    if (this.disposed || this.unsupported || typeof window === 'undefined') {
      return Promise.resolve();
    }
    if (this.inFlight) {
      return this.inFlight.then(() => {
        if (!this.unsupported && this.declaredSignature !== this.signature) {
          return this.flush();
        }
      });
    }
    const generation = this.generation.toString();
    const interests = this.scopes();
    const signature = JSON.stringify(interests);
    const url = `/api/workspace/billing/interests/${encodeURIComponent(this.clientId)}`;
    this.inFlight = fetch(
      interests.length > 0 ? url : `${url}?generation=${encodeURIComponent(generation)}`,
      interests.length > 0
        ? {
            method: 'PUT',
            cache: 'no-store',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ generation, interests }),
          }
        : {
            method: 'DELETE',
            cache: 'no-store',
            keepalive: true,
          },
    )
      .then(async (response) => {
        if (response.status === 404 || response.status === 405) {
          this.unsupported = true;
          this.clearRenewTimer();
          return;
        }
        if (!response.ok) return;
        if (interests.length === 0) {
          this.declaredSignature = signature;
          this.clearRenewTimer();
          return;
        }
        const lease = (await response.json()) as WorkspaceBillingInterestResponse;
        if (
          lease.clientId !== this.clientId ||
          lease.acceptedGeneration !== generation ||
          signature !== this.signature
        ) {
          return;
        }
        this.declaredSignature = signature;
        this.scheduleRenew(lease.leaseExpiresAt);
      })
      .catch(() => {
        // GET remains the compatibility/catch-up path. Focus, the 30-second
        // old-daemon floor, or the next lease renewal retries declaration.
      })
      .finally(() => {
        this.inFlight = null;
      });
    return this.inFlight;
  }

  private scheduleRenew(leaseExpiresAt: string): void {
    this.clearRenewTimer();
    const remaining = Date.parse(leaseExpiresAt) - Date.now();
    const delay = Math.max(
      RENEW_FLOOR_MS,
      Math.min(RENEW_CEILING_MS, Math.floor(remaining / 2)),
    );
    this.renewTimer = setTimeout(() => {
      this.renewTimer = null;
      void this.flush();
    }, delay);
  }

  private clearRenewTimer(): void {
    if (this.renewTimer) clearTimeout(this.renewTimer);
    this.renewTimer = null;
  }
}

let ownerSequence = 0;
const registry = new WorkspaceBillingInterestRegistry();

export function createWorkspaceBillingInterestOwnerId(): string {
  ownerSequence += 1;
  return `billing-interest-${ownerSequence}`;
}

export function retainWorkspaceBillingInterest(
  ownerId: string,
  scope: WorkspaceBillingInterestScope,
): () => void {
  return registry.retain(ownerId, scope);
}

export function ensureWorkspaceBillingInterestDeclared(): Promise<void> {
  return registry.ensureDeclared();
}

export function workspaceBillingInterestHeaders(
  scope: WorkspaceBillingInterestScope,
): Record<string, string> {
  return registry.headersFor(scope);
}

export function resetWorkspaceBillingInterestRegistry(): void {
  ownerSequence = 0;
  registry.reset();
}

function createClientId(): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `runtime-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}
