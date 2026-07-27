import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  ProjectWorkspaceScope,
  ProjectWorkspaceScopeResponse,
  WorkspaceCollabContext,
} from '@open-design/contracts';
import { WORKSPACE_CONTEXT_REFRESH_EVENT } from './useWorkspaceContext';
import { useWorkspaceInvalidation } from './workspace-events';

const PROJECT_SCOPE_RETRY_MS = 5_000;

export interface ProjectWorkspaceScopeState {
  loading: boolean;
  scope: ProjectWorkspaceScope | null;
}

export function projectWorkspaceContext(
  scope: ProjectWorkspaceScope | null | undefined,
): WorkspaceCollabContext | null {
  return scope?.kind === 'personal' || scope?.kind === 'team'
    ? scope.context
    : null;
}

export function projectWorkspaceScopeReady(
  scope: ProjectWorkspaceScope | null | undefined,
): boolean {
  return scope?.kind === 'unbound' || scope?.kind === 'personal' || scope?.kind === 'team';
}

function validScopeForProject(
  scope: ProjectWorkspaceScope,
  projectId: string,
): boolean {
  if (scope.projectId !== projectId) return false;
  if (scope.kind === 'unbound') {
    return scope.workspaceId === null && scope.context === null;
  }
  if (!scope.workspaceId || scope.context === undefined) return false;
  if (scope.kind === 'unavailable') return scope.context === null;
  return (
    scope.context.workspaceId === scope.workspaceId &&
    scope.context.workspaceMemberId.trim().length > 0 &&
    scope.context.workspaceType === scope.kind
  );
}

async function fetchProjectWorkspaceScope(
  projectId: string,
  signal: AbortSignal,
): Promise<ProjectWorkspaceScope> {
  const response = await fetch(
    `/api/projects/${encodeURIComponent(projectId)}/workspace-scope`,
    { cache: 'no-store', signal },
  );
  if (!response.ok) throw new Error(`project workspace scope ${response.status}`);
  const body = (await response.json()) as ProjectWorkspaceScopeResponse;
  if (!body.scope || !validScopeForProject(body.scope, projectId)) {
    throw new Error('project workspace scope identity mismatch');
  }
  return body.scope;
}

/**
 * Project detail scope is pinned by the daemon's workspace_projects row, not
 * by whichever workspace happens to be active in the navigation rail.
 */
export function useProjectWorkspaceScope(projectId: string): ProjectWorkspaceScopeState {
  const epochRef = useRef(0);
  const deferredRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [refreshRevision, setRefreshRevision] = useState(0);
  const [state, setState] = useState<ProjectWorkspaceScopeState & {
    resolvedRevision: number;
  }>({
    loading: true,
    scope: null,
    resolvedRevision: -1,
  });

  const revalidate = useCallback(() => {
    setRefreshRevision((revision) => revision + 1);
    // The daemon shares a short successful directory cache between the scope
    // endpoint and final spawn. Re-read once after that TTL too, so a same-login
    // member removal/rejoin cannot be hidden by the immediately cached answer.
    if (deferredRefreshTimerRef.current) {
      clearTimeout(deferredRefreshTimerRef.current);
    }
    deferredRefreshTimerRef.current = setTimeout(() => {
      deferredRefreshTimerRef.current = null;
      setRefreshRevision((revision) => revision + 1);
    }, PROJECT_SCOPE_RETRY_MS);
  }, []);

  useWorkspaceInvalidation(
    { 'workspace-context-changed': revalidate },
    { onActive: revalidate },
  );

  useEffect(() => {
    window.addEventListener(WORKSPACE_CONTEXT_REFRESH_EVENT, revalidate);
    window.addEventListener('pageshow', revalidate);
    return () => {
      window.removeEventListener(WORKSPACE_CONTEXT_REFRESH_EVENT, revalidate);
      window.removeEventListener('pageshow', revalidate);
      if (deferredRefreshTimerRef.current) {
        clearTimeout(deferredRefreshTimerRef.current);
        deferredRefreshTimerRef.current = null;
      }
    };
  }, [revalidate]);

  useEffect(() => {
    const epoch = ++epochRef.current;
    const controller = new AbortController();
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let firstAttempt = true;

    const load = async () => {
      if (firstAttempt) {
        setState({
          loading: true,
          scope: null,
          resolvedRevision: refreshRevision,
        });
        firstAttempt = false;
      }
      try {
        const scope = await fetchProjectWorkspaceScope(projectId, controller.signal);
        if (controller.signal.aborted || epoch !== epochRef.current) return;
        setState({
          loading: false,
          scope,
          resolvedRevision: refreshRevision,
        });
        if (scope.kind === 'unavailable') {
          retryTimer = setTimeout(() => void load(), PROJECT_SCOPE_RETRY_MS);
        }
      } catch {
        if (controller.signal.aborted || epoch !== epochRef.current) return;
        setState({
          loading: false,
          scope: null,
          resolvedRevision: refreshRevision,
        });
        retryTimer = setTimeout(() => void load(), PROJECT_SCOPE_RETRY_MS);
      }
    };

    void load();
    return () => {
      controller.abort();
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [projectId, refreshRevision]);

  // React preserves hook state across a ProjectView A→B prop change until the
  // effect above runs. Never expose A's already-resolved scope during that
  // transition frame: it could briefly enable B's composer with A's wallet.
  if (
    state.resolvedRevision !== refreshRevision ||
    state.scope?.projectId !== projectId
  ) {
    return { loading: true, scope: null };
  }
  return { loading: state.loading, scope: state.scope };
}
