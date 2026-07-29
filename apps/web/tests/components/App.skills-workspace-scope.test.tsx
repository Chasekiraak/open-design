// @vitest-environment jsdom
//
// The app-level skills list must be read under the caller's workspace identity,
// and re-read when that identity changes.
//
// `fetchSkills(workspaceContext)` exists to attach `workspaceProjectHeaders` so
// the daemon's `GET /api/skills` can apply `skillVisibleFromWorkspace`. Two
// callers pass it (SkillsSection, ExtensionsMarketplace); App.tsx's three did
// not — and the daemon's rule is FAIL-CLOSED on a missing `x-od-workspace-id`
// (`skills.ts`: `if (!scopeId) return !ownerId;`), not "unfiltered". So a
// headerless read does not return everything; it returns everything EXCEPT the
// claimed skills — hiding a skill from the very workspace that claimed it.
//
// Second half of the same defect: nothing refetched skills when the active
// workspace changed. Design systems got exactly this effect (App.tsx, keyed on
// `workspaceContext?.workspaceId`) because the switcher lives ON the home view,
// so `route.kind` stays 'home' and no route change fires. Skills never did.

import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from '../../src/App';
import type { AppConfig, Project } from '../../src/types';
import {
  fetchComposioConfigFromDaemon,
  fetchDaemonConfig,
  loadConfig,
  mergeDaemonConfig,
} from '../../src/state/config';
import {
  daemonIsLive,
  fetchAgentsStream,
  fetchAppVersionInfo,
  fetchDesignSystems,
  fetchDesignTemplates,
  fetchPromptTemplates,
  fetchSkills,
} from '../../src/providers/registry';
import { listProjects, listTemplates } from '../../src/state/projects';
import {
  notifyWorkspaceContextRefresh,
  resetTeamProjectsCache,
  resetWorkspaceContextCache,
} from '../../src/collab/useWorkspaceContext';
import { resetCoalescedGet } from '../../src/lib/coalesced-get';

vi.mock('../../src/components/EntryView', () => ({
  EntryView: () => <main><div data-testid="entry-home-surface" /></main>,
}));

vi.mock('../../src/components/ProjectView', () => ({
  ProjectView: () => <main data-testid="project-view" />,
}));

vi.mock('../../src/components/WorkspaceTabsBar', () => ({
  WorkspaceTabsBar: () => null,
  openWorkspaceTab: () => {},
}));

vi.mock('../../src/components/pet/PetOverlay', () => ({
  PetOverlay: () => null,
}));

vi.mock('../../src/components/pet/pets', () => ({
  migrateCustomPetAtlas: vi.fn().mockResolvedValue(null),
}));

vi.mock('../../src/components/SettingsDialog', () => ({
  SettingsDialog: () => null,
  switchApiProtocolConfig: (config: AppConfig) => config,
  updateCurrentApiProtocolConfig: (config: AppConfig) => config,
}));

vi.mock('../../src/providers/registry', async () => {
  const actual = await vi.importActual<typeof import('../../src/providers/registry')>(
    '../../src/providers/registry',
  );
  return {
    ...actual,
    daemonIsLive: vi.fn(),
    fetchAgentsStream: vi.fn(),
    fetchAppVersionInfo: vi.fn(),
    fetchDesignSystems: vi.fn(),
    fetchDesignTemplates: vi.fn(),
    fetchPromptTemplates: vi.fn(),
    fetchSkills: vi.fn(),
  };
});

vi.mock('../../src/state/projects', async () => {
  const actual = await vi.importActual<typeof import('../../src/state/projects')>(
    '../../src/state/projects',
  );
  return {
    ...actual,
    listProjects: vi.fn(),
    listTemplates: vi.fn(),
  };
});

vi.mock('../../src/state/config', async () => {
  const actual = await vi.importActual<typeof import('../../src/state/config')>(
    '../../src/state/config',
  );
  return {
    ...actual,
    fetchDaemonConfig: vi.fn().mockResolvedValue({}),
    fetchComposioConfigFromDaemon: vi.fn().mockResolvedValue(null),
    loadConfig: vi.fn(),
    mergeDaemonConfig: vi.fn(),
    saveConfig: vi.fn(),
    syncComposioConfigToDaemon: vi.fn().mockResolvedValue(true),
    syncConfigToDaemon: vi.fn().mockResolvedValue(undefined),
  };
});

const baseConfig: AppConfig = {
  mode: 'daemon',
  apiKey: '',
  apiProtocol: 'anthropic',
  apiVersion: '',
  baseUrl: 'https://api.anthropic.com',
  model: 'claude-sonnet-4-5',
  apiProviderBaseUrl: 'https://api.anthropic.com',
  apiProtocolConfigs: {},
  agentId: 'codex',
  skillId: null,
  designSystemId: null,
  onboardingCompleted: true,
  privacyDecisionAt: 1778244000000,
  mediaProviders: {},
  composio: {},
  agentModels: {},
  agentCliEnv: {},
};

function workspaceContextPayload(workspaceId: string) {
  return {
    context: {
      workspaceId,
      workspaceType: 'team',
      workspaceMemberId: `member-${workspaceId}`,
      role: 'member',
      memberStatus: 'active',
      lifecycleState: 'active',
      billingState: 'active',
      planId: null,
      providerMode: 'platform_credits',
      seatSummary: { seatLimit: 5, usedSeats: 1, availableSeats: 4, isSeatFull: false },
      permissions: {
        canManageMembers: false,
        canManageBilling: false,
        canInviteMembers: false,
        canManageAutoRecharge: false,
        canShareProjects: true,
        canWriteSyncedFiles: true,
        canViewWorkspaceSettings: false,
        canManageSharedResources: false,
      },
      displayName: workspaceId,
    },
  };
}

/** Workspace ids `fetchSkills` was called for, in order. `undefined` marks a
 *  headerless read — the fail-closed one that hides claimed skills. */
function skillsReadScopes(): Array<string | undefined> {
  return vi
    .mocked(fetchSkills)
    .mock.calls.map(([context]) => context?.workspaceId ?? undefined);
}

const projects: Project[] = [];

describe('App skills list — workspace scope', () => {
  beforeEach(() => {
    resetWorkspaceContextCache();
    resetTeamProjectsCache();
    resetCoalescedGet();
    window.history.replaceState(null, '', '/');
    vi.mocked(daemonIsLive).mockResolvedValue(true);
    vi.mocked(fetchAgentsStream).mockResolvedValue([]);
    vi.mocked(fetchSkills).mockResolvedValue([]);
    vi.mocked(fetchDesignTemplates).mockResolvedValue([]);
    vi.mocked(fetchDesignSystems).mockResolvedValue([]);
    vi.mocked(fetchPromptTemplates).mockResolvedValue([]);
    vi.mocked(fetchAppVersionInfo).mockResolvedValue(null);
    vi.mocked(listProjects).mockResolvedValue(projects);
    vi.mocked(listTemplates).mockResolvedValue([]);
    vi.mocked(fetchDaemonConfig).mockResolvedValue({});
    vi.mocked(fetchComposioConfigFromDaemon).mockResolvedValue(null);
    vi.mocked(mergeDaemonConfig).mockImplementation((local) => local);
    vi.mocked(loadConfig).mockReturnValue({ ...baseConfig });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    resetWorkspaceContextCache();
    resetTeamProjectsCache();
    resetCoalescedGet();
  });

  it('reads skills under the active workspace identity, once, and again on a switch', async () => {
    let activeWorkspaceId = 'ws-a';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const pathname = new URL(String(input), 'http://d.local').pathname;
        return {
          ok: true,
          json: async () =>
            pathname.endsWith('/workspace/context')
              ? workspaceContextPayload(activeWorkspaceId)
              : {},
        } as Response;
      }),
    );

    render(<App />);
    await waitFor(() => expect(screen.getByTestId('entry-home-surface')).toBeTruthy());

    // Startup: the skills list is read for the workspace that is actually
    // active — not headerless, which the daemon answers by hiding every
    // claimed skill.
    await waitFor(() => expect(skillsReadScopes()).toContain('ws-a'));

    // …and exactly once. A boot read plus a workspace-keyed read would be a
    // second request on the startup path.
    expect(skillsReadScopes()).toEqual(['ws-a']);

    // The switch: the switcher lives on the home view, so no route change
    // fires. Only a workspace-keyed refresh can correct the list.
    activeWorkspaceId = 'ws-b';
    await act(async () => {
      notifyWorkspaceContextRefresh();
      await Promise.resolve();
    });

    await waitFor(() => expect(skillsReadScopes()).toContain('ws-b'));
    expect(skillsReadScopes()).toEqual(['ws-a', 'ws-b']);
  });
});
