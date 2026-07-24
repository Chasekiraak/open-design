import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  TeamProject,
  WorkspaceBillingResponse,
  WorkspaceBillingSummary,
  WorkspaceCollabContext,
  WorkspaceContextResponse,
  WorkspaceTeamProjectsResponse,
} from '@open-design/contracts';
import { coalescedGet, forceCoalescedGet } from '../lib/coalesced-get';
import { useWorkspaceInvalidation } from './workspace-events';

// One shared read of the workspace context (`GET /api/workspace/context`) for the
// navigation shell. The daemon proxies B's `CurrentWorkspaceContext`; `context`
// is non-null for both personal and team workspaces when the local AMR identity
// is available, and null when signed out / offline / B unavailable. Every
// workspace surface in the entry shell consumes THIS one read so the shell never
// re-derives role/permission judgements or fans out duplicate fetches. See
// `packages/contracts/src/api/collab.ts` for the shape.
export interface WorkspaceContextState {
  context: WorkspaceCollabContext | null;
  loading: boolean;
}

/** Coalescing key for `GET /api/workspace/context`; shared so an identity
 *  change can evict exactly this read instead of the whole cache. */
const WORKSPACE_CONTEXT_COALESCE_KEY = 'workspace-context';

// Last successfully-resolved workspace context, kept at module scope so it
// survives a component unmount/remount. Returning to the home view remounts the
// nav shell, and starting each remount from `null` flashed the signed-out state
// for the full duration of the (vela-backed, seconds-long) context read before
// snapping to the real workspace. Seeding the remount from this cache shows the
// last-known signed-in state instantly while the background read revalidates.
let cachedWorkspaceContext: WorkspaceContextState['context'] = null;

/** Test seam: clear the module-level context cache between tests. */
export function resetWorkspaceContextCache(): void {
  cachedWorkspaceContext = null;
}

/**
 * The last context the shell resolved, for consumers that mount later and would
 * otherwise start their own read from `null`. Read-only: this cache is owned by
 * `useWorkspaceContext` and only a successful read redefines it.
 */
export function lastResolvedWorkspaceContext(): WorkspaceContextState['context'] {
  return cachedWorkspaceContext;
}

// Last team-shared catalog this shell successfully read. `null` means "never
// loaded", which is NOT the same as "nothing is shared" — consumers that relax
// a fail-closed gate on this must treat null as "unknown" and keep failing
// closed.
let cachedTeamProjects: TeamProject[] | null = null;

/** Test seam: clear the module-level team-project cache between tests. */
export function resetTeamProjectsCache(): void {
  cachedTeamProjects = null;
}

/**
 * The team-shared catalog the shell last resolved, or null if it never has.
 * Same source the 全部项目 grid reads, exposed for consumers that need to know
 * whether a project is shared before `/collab/status` answers.
 */
export function lastResolvedTeamProjects(): TeamProject[] | null {
  return cachedTeamProjects;
}

export function useWorkspaceContext(): WorkspaceContextState {
  const [state, setState] = useState<WorkspaceContextState>(() => ({
    context: cachedWorkspaceContext,
    loading: cachedWorkspaceContext === null,
  }));
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  /**
   * Read the workspace context.
   *
   * `markLoading` announces that this read was triggered by something that just
   * CHANGED the identity (a sign-in), so the shell should treat the answer it
   * currently holds as void rather than authoritative. It only ever promotes
   * "no context" to "loading": a read that starts while a context is already in
   * hand keeps showing it, which is what stops the rail flashing signed-out.
   *
   * Without it, signing in during onboarding left the bottom-left "sign in to
   * Open Design Cloud" callout on screen for the whole (vela-backed,
   * up-to-seconds) re-read, because `loading` had already settled to false on
   * the earlier signed-out read and only `context !== null` gates the callout
   * (#140). It also forces the coalescing entry, whose whole premise — that
   * sub-second staleness is invisible — stops holding at exactly this moment:
   * the cached answer describes the identity the user just replaced.
   *
   * This hook is mounted by a dozen-plus components at once (App, EntryShell,
   * SettingsDialog, HomeView, ...), and a sign-in fires ONE broadcast event
   * every mounted instance reacts to in the same synchronous pass. Forcing via
   * `forceCoalescedGet` (rather than `evictCoalescedGet` + `coalescedGet`
   * directly) collapses that whole burst to a single real fetch instead of one
   * per mounted instance — see its doc for why the naive evict-then-fetch
   * pattern is unsafe here.
   */
  const loadContext = useCallback(async (options: { markLoading?: boolean } = {}) => {
    if (options.markLoading && mountedRef.current) {
      setState((prev) =>
        prev.context === null && !prev.loading ? { ...prev, loading: true } : prev,
      );
    }
    try {
      const fetchContext = async () => {
        const res = await fetch('/api/workspace/context', { cache: 'no-store' });
        if (!res.ok) throw new Error(`workspace-context ${res.status}`);
        return (await res.json()) as WorkspaceContextResponse;
      };
      // Coalesced: every mounted consumer of this hook (and every focus/pageshow
      // refresh across them) fires the same read on a home-view burst — collapse
      // them to one request. The nav shell tolerates sub-second staleness.
      // An explicit identity-change refresh forces a fresh read instead of
      // sharing a settled answer that predates the change.
      const body = options.markLoading
        ? await forceCoalescedGet(WORKSPACE_CONTEXT_COALESCE_KEY, fetchContext)
        : await coalescedGet(WORKSPACE_CONTEXT_COALESCE_KEY, fetchContext);
      // A successful read is the only thing that redefines "signed in": persist it
      // (including an explicit null for a genuinely signed-out response) so the
      // next remount seeds from the truth, not a stale value.
      cachedWorkspaceContext = body.context ?? null;
      if (mountedRef.current) setState({ context: cachedWorkspaceContext, loading: false });
    } catch {
      // Transient failure (offline, momentary daemon/hub hiccup): keep the
      // last-known context instead of flashing the signed-out state. A never-
      // signed-in / personal user has a null cache, so this still shows the local
      // state for them.
      if (mountedRef.current) setState({ context: cachedWorkspaceContext, loading: false });
    }
  }, []);

  useEffect(() => {
    void loadContext();
  }, [loadContext]);

  // Collab realtime hop-2: subscribe to the workspace SSE and re-fetch on a
  // pushed `workspace-context-changed`. `connected` drives poll-as-floor below.
  // `loadContext` is the coalesced no-arg reader (it keeps the last-known context
  // on failure rather than clearing), so the SSE re-fetch just calls it.
  const { connected: sseConnected } = useWorkspaceInvalidation(
    { 'workspace-context-changed': () => void loadContext() },
    { onActive: () => void loadContext() },
  );

  useEffect(() => {
    // Poll-as-floor: slow the poll while the SSE is delivering, run it at full
    // cadence when the stream is unavailable so there is no regression.
    const intervalMs = sseConnected ? WORKSPACE_CONTEXT_SSE_FLOOR_MS : WORKSPACE_CONTEXT_POLL_MS;
    const interval = setInterval(() => {
      if (document.visibilityState === 'visible') void loadContext();
    }, intervalMs);
    return () => clearInterval(interval);
  }, [loadContext, sseConnected]);

  useEffect(() => {
    const refresh = () => {
      void loadContext();
    };
    // An EXPLICIT refresh means a caller just changed the identity (signed in
    // through onboarding or the rail callout) and is telling us so. Focus and
    // visibility are ambient revalidation and stay silent — only the deliberate
    // signal may blank a stale signed-out answer while the re-read runs (#140).
    const refreshAfterIdentityChange = () => {
      void loadContext({ markLoading: true });
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key === WORKSPACE_CONTEXT_REFRESH_STORAGE_KEY) refreshAfterIdentityChange();
    };
    window.addEventListener('focus', refresh);
    window.addEventListener('pageshow', refresh);
    window.addEventListener(WORKSPACE_CONTEXT_REFRESH_EVENT, refreshAfterIdentityChange);
    window.addEventListener('storage', onStorage);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      window.removeEventListener('focus', refresh);
      window.removeEventListener('pageshow', refresh);
      window.removeEventListener(WORKSPACE_CONTEXT_REFRESH_EVENT, refreshAfterIdentityChange);
      window.removeEventListener('storage', onStorage);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [loadContext]);

  return state;
}

const WORKSPACE_CONTEXT_POLL_MS = 30_000;
// Poll-as-floor cadence while the workspace SSE is connected — a slow safety net
// behind the pushed `workspace-context-changed` events.
const WORKSPACE_CONTEXT_SSE_FLOOR_MS = 120_000;
export const WORKSPACE_CONTEXT_REFRESH_EVENT = 'od:workspace-context-refresh';
const WORKSPACE_CONTEXT_REFRESH_STORAGE_KEY = 'od.workspaceContext.refreshAt';

export function notifyWorkspaceContextRefresh(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new Event(WORKSPACE_CONTEXT_REFRESH_EVENT));
  try {
    window.localStorage.setItem(WORKSPACE_CONTEXT_REFRESH_STORAGE_KEY, String(Date.now()));
  } catch {
    // The in-window event is enough when localStorage is unavailable.
  }
}

/**
 * One shared read of the caller's Vela billing summary for the nav shell
 * (`GET /api/workspace/billing`, A-lane data via the vela CLI 收口). Null until
 * it loads, or when the CLI / billing session is unavailable — the credits chip
 * then falls back to the plan-tier hint the workspace context already carries.
 */
export function useWorkspaceBilling(): WorkspaceBillingSummary | null {
  const [summary, setSummary] = useState<WorkspaceBillingSummary | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const loadBilling = useCallback(async (clearOnFailure: boolean) => {
    try {
      const summary = await coalescedGet('workspace-billing', async () => {
        const res = await fetch('/api/workspace/billing', { cache: 'no-store' });
        if (!res.ok) throw new Error(`billing ${res.status}`);
        const body = (await res.json()) as WorkspaceBillingResponse;
        return body.summary ?? null;
      });
      if (mountedRef.current) setSummary(summary);
    } catch {
      if (clearOnFailure && mountedRef.current) setSummary(null);
    }
  }, []);

  useEffect(() => {
    void loadBilling(true);
  }, [loadBilling]);

  // Collab realtime hop-2: subscribe to `billing-changed` for a pushed refresh
  // (e.g. after the daemon later gains a billing change source) and re-fetch on
  // reconnect/visible via `onActive`. The poll cadence is intentionally left
  // UNCHANGED: the daemon does not yet emit `billing-changed`, so slowing the
  // poll would delay periodic billing updates — see the report's follow-ups.
  useWorkspaceInvalidation(
    { 'billing-changed': () => void loadBilling(false) },
    { onActive: () => void loadBilling(false) },
  );

  useEffect(() => {
    const interval = setInterval(() => {
      if (document.visibilityState === 'visible') void loadBilling(false);
    }, WORKSPACE_BILLING_POLL_MS);
    return () => clearInterval(interval);
  }, [loadBilling]);

  useEffect(() => {
    const refresh = () => {
      void loadBilling(true);
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key === WORKSPACE_BILLING_REFRESH_STORAGE_KEY) refresh();
    };
    window.addEventListener('focus', refresh);
    window.addEventListener('pageshow', refresh);
    window.addEventListener(WORKSPACE_BILLING_REFRESH_EVENT, refresh);
    window.addEventListener('storage', onStorage);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      window.removeEventListener('focus', refresh);
      window.removeEventListener('pageshow', refresh);
      window.removeEventListener(WORKSPACE_BILLING_REFRESH_EVENT, refresh);
      window.removeEventListener('storage', onStorage);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [loadBilling]);

  return summary;
}

const WORKSPACE_BILLING_POLL_MS = 30_000;
export const WORKSPACE_BILLING_REFRESH_EVENT = 'od:workspace-billing-refresh';
const WORKSPACE_BILLING_REFRESH_STORAGE_KEY = 'od.workspaceBilling.refreshAt';

export function notifyWorkspaceBillingRefresh(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new Event(WORKSPACE_BILLING_REFRESH_EVENT));
  try {
    window.localStorage.setItem(WORKSPACE_BILLING_REFRESH_STORAGE_KEY, String(Date.now()));
  } catch {
    // The in-window event is enough when localStorage is unavailable.
  }
}

export interface TeamProjectsState {
  projects: TeamProject[];
  loading: boolean;
  /** Re-fetch the team-shared project list (e.g. after a member pulls one). */
  reload: () => void;
}

/**
 * Team-wide shared-project discovery for the "全部项目" view
 * (`GET /api/workspace/projects/team`, resource-hub data behind the daemon).
 * A member's own `/api/projects` list is only their LOCAL projects; the projects
 * the owner shared to the team live on the hub until pulled, and this read
 * surfaces them so a member can discover + open them. Empty off-team or when the
 * hub is not configured — the daemon degrades to `{ projects: [] }` there.
 */
// Poll cadence for the team-shared list. Match the foreground collab cadence so
// a teammate sees a newly shared project within a few seconds, while focus and
// visibility changes still refresh immediately.
const TEAM_PROJECTS_POLL_MS = 15_000;
// Poll-as-floor cadence while the workspace SSE is connected.
const TEAM_PROJECTS_SSE_FLOOR_MS = 60_000;
export const TEAM_PROJECTS_CHANGED_EVENT = 'od:team-projects-changed';
const TEAM_PROJECTS_CHANGED_STORAGE_KEY = 'od.teamProjects.changedAt';

export function notifyTeamProjectsChanged(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new Event(TEAM_PROJECTS_CHANGED_EVENT));
  try {
    window.localStorage.setItem(TEAM_PROJECTS_CHANGED_STORAGE_KEY, String(Date.now()));
  } catch {
    // localStorage can be unavailable in restricted contexts; the in-window event
    // already refreshed the current client.
  }
}

export function useTeamProjects(): TeamProjectsState {
  const [projects, setProjects] = useState<TeamProject[]>([]);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Fetch the full list. Shared by the initial load, manual reload(), and the
  // poll. Never flips `loading` (only the initial/reload effect does) so a
  // background refresh has no spinner. `force` bypasses a settled/in-flight
  // cache entry for a genuine identity/workspace change (see
  // `onTeamProjectsChanged` below) via `forceCoalescedGet`, which also
  // collapses the case where every mounted `useTeamProjects()` instance reacts
  // to that same change in one synchronous burst into a single fetch.
  const loadFull = useCallback(async (force = false) => {
    try {
      const fetchProjects = async () => {
        const res = await fetch('/api/workspace/projects/team');
        if (!res.ok) throw new Error(`team-projects ${res.status}`);
        const body = (await res.json()) as WorkspaceTeamProjectsResponse;
        return body.projects ?? [];
      };
      const projects = force
        ? await forceCoalescedGet('workspace-team-projects', fetchProjects)
        : await coalescedGet('workspace-team-projects', fetchProjects);
      cachedTeamProjects = projects;
      if (mountedRef.current) {
        setProjects(projects);
        setLoading(false);
      }
    } catch {
      // Personal / offline / daemon without the hub: no team-shared projects.
      if (mountedRef.current) {
        setProjects([]);
        setLoading(false);
      }
    }
  }, []);

  // Initial load + manual reload (nonce bump).
  useEffect(() => {
    setLoading(true);
    void loadFull();
  }, [nonce, loadFull]);

  // Collab realtime hop-2: subscribe to the workspace SSE and re-fetch on a
  // pushed `team-projects-changed` (a teammate shared/unshared a project). The
  // daemon's workspace-invalidation poller diffs the team list and pushes only
  // on an actual change. `connected` drives poll-as-floor below.
  const { connected: sseConnected } = useWorkspaceInvalidation(
    { 'team-projects-changed': () => void loadFull() },
    { onActive: () => void loadFull() },
  );

  // Lightweight polling so teammates see each other's shares without refreshing.
  // A daemon-local read is cheap enough to just refetch; offline errors keep the
  // last snapshot until the next tick. Poll-as-floor: slow the poll while the SSE
  // is delivering, run it at full cadence when the stream is unavailable so a
  // client whose SSE never connects has zero regression.
  useEffect(() => {
    const intervalMs = sseConnected ? TEAM_PROJECTS_SSE_FLOOR_MS : TEAM_PROJECTS_POLL_MS;
    const interval = setInterval(() => {
      // Only poll while the tab is actually visible — an idle/backgrounded tab
      // was refetching the whole team list (and cascading cover fetches) every
      // few seconds for nothing. Focus/visibility/changed-event handlers below
      // still refresh immediately, so a teammate's share shows up right away.
      if (document.visibilityState === 'visible') void loadFull();
    }, intervalMs);
    return () => clearInterval(interval);
  }, [loadFull, sseConnected]);

  // Demo and real team usage often switch between two browser windows after a
  // teammate shares a project. Refresh immediately on focus/visibility instead
  // of making the member wait for the next poll tick.
  useEffect(() => {
    const onFocus = () => {
      void loadFull();
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') void loadFull();
    };
    const onTeamProjectsChanged = () => {
      // A workspace switch fires this same event (see `switchWorkspace` in
      // EntryNavRail.tsx). Without forcing, an in-flight coalesced read
      // started just before the switch can resolve inside the new call's
      // coalescing window and hand back the PREVIOUS workspace's team list.
      void loadFull(true);
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key === TEAM_PROJECTS_CHANGED_STORAGE_KEY) void loadFull();
    };
    window.addEventListener('focus', onFocus);
    window.addEventListener(TEAM_PROJECTS_CHANGED_EVENT, onTeamProjectsChanged);
    window.addEventListener('storage', onStorage);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      window.removeEventListener('focus', onFocus);
      window.removeEventListener(TEAM_PROJECTS_CHANGED_EVENT, onTeamProjectsChanged);
      window.removeEventListener('storage', onStorage);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [loadFull]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { projects, loading, reload };
}
