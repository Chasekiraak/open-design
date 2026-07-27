// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceCollabContext } from '@open-design/contracts';

import { AvatarMenu } from '../../src/components/AvatarMenu';
import type { ProjectWorkspaceScopeState } from '../../src/collab/useProjectWorkspaceScope';
import type { AgentInfo, AppConfig, ExecMode } from '../../src/types';

vi.mock('../../src/i18n', () => ({
  useT: () => (key: string) => key,
}));

// recvqfYKutwWlQ: the AMR upgrade entry point must only render for a caller who
// can actually act on it (`permissions.canManageBilling`), never just a
// caller whose plan tier happens to be upgradeable. Personal workspaces
// resolve `canManageBilling` true because the user is always their own owner
// there (`buildWorkspacePermissions`: `canManageBilling: readable && isOwner`),
// so this fixture doubles as the "personal identity keeps the upgrade entry"
// control case.
function personalWorkspaceContext(
  overrides: Partial<WorkspaceCollabContext> = {},
): WorkspaceCollabContext {
  return {
    workspaceId: 'ws-personal',
    workspaceType: 'personal',
    workspaceMemberId: 'wm-1',
    role: 'owner',
    memberStatus: 'active',
    lifecycleState: 'active',
    billingState: 'active',
    planId: null,
    providerMode: 'personal_byok',
    seatSummary: { seatLimit: 1, usedSeats: 1, availableSeats: 0, isSeatFull: false },
    permissions: {
      canManageMembers: true,
      canManageBilling: true,
      canInviteMembers: true,
      canManageAutoRecharge: true,
      canShareProjects: true,
      canWriteSyncedFiles: true,
      canViewWorkspaceSettings: true,
      canManageSharedResources: true,
    },
    ...overrides,
  } as WorkspaceCollabContext;
}

// A team MEMBER (not owner/admin) — `canManageBilling` folds in role, so this
// is the "cannot act on billing" case the upgrade entry must hide for.
function teamMemberWorkspaceContext(
  overrides: Partial<WorkspaceCollabContext> = {},
): WorkspaceCollabContext {
  return {
    ...personalWorkspaceContext(),
    workspaceId: 'ws-team',
    workspaceType: 'team',
    role: 'member',
    teamId: 'team-1',
    teamName: 'OD Feature Team',
    permissions: {
      canManageMembers: false,
      canManageBilling: false,
      canInviteMembers: false,
      canManageAutoRecharge: false,
      canShareProjects: true,
      canWriteSyncedFiles: true,
      canViewWorkspaceSettings: true,
      canManageSharedResources: false,
    },
    ...overrides,
  } as WorkspaceCollabContext;
}

function workspaceContextResponse(context: WorkspaceCollabContext | null) {
  return new Response(JSON.stringify({ context }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

const codexAgent: AgentInfo = {
  id: 'codex',
  name: 'Codex CLI',
  bin: 'codex',
  available: true,
  version: '0.134.0',
  models: [{ id: 'default', label: 'Default (CLI config)' }],
  reasoningOptions: [
    { id: 'default', label: 'Default' },
    { id: 'high', label: 'High' },
  ],
};

const claudeAgent: AgentInfo = {
  id: 'claude',
  name: 'Claude Code',
  bin: 'claude',
  available: true,
  version: '2.1.131',
  models: [
    { id: 'default', label: 'Default (CLI config)' },
    { id: 'sonnet', label: 'Sonnet (alias)' },
  ],
};

const baseConfig: AppConfig = {
  mode: 'daemon',
  apiKey: '',
  apiProtocol: 'anthropic',
  apiVersion: '',
  baseUrl: 'https://api.anthropic.com',
  apiProviderBaseUrl: 'https://api.anthropic.com',
  apiProtocolConfigs: {},
  model: 'claude-sonnet-4-5',
  agentId: 'codex',
  skillId: null,
  designSystemId: null,
  onboardingCompleted: true,
  mediaProviders: {},
  agentModels: { codex: { model: 'default', reasoning: 'default' } },
  agentCliEnv: {},
};

type EventSourceListener = (event: unknown) => void;
class MockAvatarEventSource {
  static instances: MockAvatarEventSource[] = [];
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  listeners = new Map<string, Set<EventSourceListener>>();

  constructor(readonly url: string) {
    MockAvatarEventSource.instances.push(this);
  }

  addEventListener(name: string, listener: EventSourceListener): void {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    this.listeners.get(name)!.add(listener);
  }

  removeEventListener(name: string, listener: EventSourceListener): void {
    this.listeners.get(name)?.delete(listener);
  }

  dispatch(name: string, data: unknown): void {
    for (const listener of this.listeners.get(name) ?? []) {
      listener({ data: JSON.stringify(data) });
    }
  }

  close(): void {}
}

type ModeChangeHandler = (mode: ExecMode) => void;
type AgentChangeHandler = (id: string) => void;
type AgentModelChangeHandler = (
  id: string,
  choice: { model?: string; reasoning?: string },
) => void;
type VoidHandler = () => void;
type OpenSettingsHandler = (section?: 'execution') => void;

function renderMenu({
  config = baseConfig,
  agents = [codexAgent, claudeAgent],
  daemonLive = true,
  onModeChange = vi.fn<ModeChangeHandler>(),
  onAgentChange = vi.fn<AgentChangeHandler>(),
  onAgentModelChange = vi.fn<AgentModelChangeHandler>(),
  onOpenSettings = vi.fn<OpenSettingsHandler>(),
  onRefreshAgents = vi.fn<VoidHandler>(),
  projectWorkspaceScope,
}: {
  config?: AppConfig;
  agents?: AgentInfo[];
  daemonLive?: boolean;
  onModeChange?: ReturnType<typeof vi.fn<ModeChangeHandler>>;
  onAgentChange?: ReturnType<typeof vi.fn<AgentChangeHandler>>;
  onAgentModelChange?: ReturnType<typeof vi.fn<AgentModelChangeHandler>>;
  onOpenSettings?: ReturnType<typeof vi.fn<OpenSettingsHandler>>;
  onRefreshAgents?: ReturnType<typeof vi.fn<VoidHandler>>;
  projectWorkspaceScope?: ProjectWorkspaceScopeState;
} = {}) {
  render(
    <AvatarMenu
      config={config}
      agents={agents}
      daemonLive={daemonLive}
      onModeChange={onModeChange}
      onAgentChange={onAgentChange}
      onAgentModelChange={onAgentModelChange}
      onOpenSettings={onOpenSettings}
      onRefreshAgents={onRefreshAgents}
      projectWorkspaceScope={projectWorkspaceScope}
    />,
  );
  return {
    onModeChange,
    onAgentChange,
    onAgentModelChange,
    onOpenSettings,
    onRefreshAgents,
  };
}

function openMenu() {
  fireEvent.click(screen.getByRole('button', { name: 'avatar.title' }));
  return screen.getByRole('dialog', { name: 'avatar.title' });
}

describe('AvatarMenu', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    window.localStorage.clear();
    vi.clearAllMocks();
    MockAvatarEventSource.instances = [];
  });

  // The composer popover is a one-decision surface: pick the model for the
  // active agent. Execution mode, which CLI agent runs, PATH rescan, reasoning
  // effort and the BYOK model are configuration, and live in
  // Settings → Execution. Keeping them out is what makes the popover compact.
  it('keeps execution configuration out of the composer popover', () => {
    const onOpenSettings = vi.fn<OpenSettingsHandler>();
    const onRefreshAgents = vi.fn<VoidHandler>();
    renderMenu({ daemonLive: false, onOpenSettings, onRefreshAgents });

    openMenu();

    // The execution console itself is gone from this popover per #5517: no mode
    // switch, no CLI list, no PATH rescan.
    expect(screen.queryByRole('button', { name: /avatar.useLocal/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /avatar.useApi/i })).toBeNull();
    expect(screen.queryByRole('button', { name: 'avatar.rescan' })).toBeNull();
    expect(onRefreshAgents).not.toHaveBeenCalled();

    // …but the link OUT to it must stay. #5517 has no such entry, and it also
    // never moved CLI switching out of this popover — we did, so without this
    // the place switching moved TO is unreachable from where it used to be.
    const openSettings = screen.getByTestId('avatar-open-execution-settings');
    expect(openSettings).toBeTruthy();
    fireEvent.click(openSettings);
    expect(onOpenSettings).toHaveBeenCalledWith('execution');
  });

  it('lists only the Open Design account row, not every installed CLI', async () => {
    const amrAgent: AgentInfo = {
      id: 'amr',
      name: 'Open Design AMR',
      bin: 'vela',
      available: true,
      models: [{ id: 'default', label: 'Default (CLI config)' }],
    };
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url === '/api/integrations/vela/status') {
        return new Response(
          JSON.stringify({
            loggedIn: false,
            loginInFlight: false,
            profile: 'test',
            user: null,
            configPath: '/Users/test/.amr/config.json',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response('{}', { status: 200 });
    }));

    renderMenu({
      config: { ...baseConfig, agentId: 'amr' },
      agents: [codexAgent, claudeAgent, amrAgent],
    });
    const menu = openMenu();

    await waitFor(() => {
      expect(screen.getByTestId('avatar-agent-option-amr')).toBeTruthy();
    });
    expect(
      Array.from(menu.querySelectorAll('[data-testid^="avatar-agent-option-"]'))
        .map((row) => row.getAttribute('data-testid')),
    ).toEqual(['avatar-agent-option-amr']);
  });

  // The account card is scoped to the active agent. Before #5517 the popover
  // listed every installed CLI, so an AMR row alongside them was just one entry;
  // once that list went away it became a lone header card, and a user on Codex
  // was shown Open Design's plan and balance. Keep it out entirely — including
  // the plan badge and balance — even with a fully signed-in AMR status.
  it('hides the Open Design account row while another agent is active', async () => {
    const amrAgent: AgentInfo = {
      id: 'amr',
      name: 'Open Design AMR',
      bin: 'vela',
      available: true,
      models: [{ id: 'default', label: 'Default (CLI config)' }],
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url === '/api/integrations/vela/status') {
        return new Response(
          JSON.stringify({
            loggedIn: true,
            loginInFlight: false,
            profile: 'test',
            user: { id: 'u1', email: 'a@b.c' },
            account: { plan: 'plus', balanceUsd: '247.5087' },
            configPath: '/Users/test/.amr/config.json',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response('{}', { status: 202 });
    });
    vi.stubGlobal('fetch', fetchMock);

    // baseConfig runs Codex, with AMR installed and available.
    renderMenu({ agents: [codexAgent, claudeAgent, amrAgent] });
    const menu = openMenu();

    // Let the status fetch land so a late render cannot sneak the row back in.
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.queryByTestId('avatar-agent-option-amr')).toBeNull();
    expect(menu.querySelectorAll('[data-testid^="avatar-agent-option-"]')).toHaveLength(0);
    expect(within(menu).queryByText('Plus')).toBeNull();
    expect(menu.textContent).not.toContain('$247.51');
    expect(screen.queryByRole('link', { name: 'settings.amrUpgrade' })).toBeNull();
  });

  // Cross-agent switching moved to Settings → Execution with #5517, so this row
  // can only ever be shown for the already-active Open Design agent. What still
  // has to hold is that the card is a real agent-selection control wired to
  // `amr`, not a decorative header.
  it('selects Open Design from the account row', async () => {
    const amrAgent: AgentInfo = {
      id: 'amr',
      name: 'Open Design AMR',
      bin: 'vela',
      available: true,
      models: [{ id: 'default', label: 'Default (CLI config)' }],
    };
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 202 })));

    const { onAgentChange } = renderMenu({
      config: { ...baseConfig, agentId: 'amr' },
      agents: [codexAgent, amrAgent],
    });
    openMenu();

    const row = await screen.findByTestId('avatar-agent-option-amr');
    const select = row.querySelector('.avatar-amr-row__select') as HTMLElement;
    expect(select.getAttribute('aria-current')).toBe('true');
    fireEvent.click(select);

    expect(onAgentChange).toHaveBeenCalledWith('amr');
  });

  it('renders the active reasoning effort as a read-only readout', () => {
    renderMenu();

    const menu = openMenu();
    const rows = Array.from(menu.querySelectorAll('.avatar-select-row'));
    const reasoningRow = rows.find((row) =>
      row.querySelector('.avatar-select-label')?.textContent ===
      'avatar.reasoningLabel',
    );
    expect(reasoningRow).toBeTruthy();
    expect(
      reasoningRow!.querySelector('.avatar-static-value')?.textContent,
    ).toBe('Default');
    // Read-only: no control to change it from the composer.
    expect(reasoningRow!.querySelector('select')).toBeNull();
  });

  it('selects a model from the inline list and dismisses the popover', () => {
    const { onAgentModelChange } = renderMenu({
      config: { ...baseConfig, agentId: 'claude' },
      agents: [codexAgent, claudeAgent],
    });

    openMenu();
    const list = screen.getByTestId('avatar-model-list');
    const options = within(list).getAllByRole('radio');
    expect(options.map((o) => o.textContent)).toEqual([
      'Default (CLI config)',
      'Sonnet (alias)',
    ]);

    fireEvent.click(options[1]!);

    expect(onAgentModelChange).toHaveBeenCalledWith('claude', { model: 'sonnet' });
    expect(screen.queryByRole('dialog', { name: 'avatar.title' })).toBeNull();
  });

  it('keeps a custom saved model visible when it is not in the declared agent model list', () => {
    renderMenu({
      config: {
        ...baseConfig,
        agentModels: { codex: { model: 'custom-codex-model', reasoning: 'default' } },
      },
    });

    openMenu();
    // The model picker is an always-expanded radio list. A custom saved model
    // that isn't in the agent's declared list is appended as an extra option so
    // it stays visible and checked instead of silently dropping.
    const list = screen.getByTestId('avatar-model-list');
    const custom = within(list).getByRole('radio', { name: /custom-codex-model/i });
    expect(custom.getAttribute('aria-checked')).toBe('true');
  });

  it('routes plan-gated Open Design models to the plans page instead of selecting them', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 202 })));
    const openSpy = vi.fn();
    vi.stubGlobal('open', openSpy);

    const { onAgentModelChange } = renderMenu({
      config: { ...baseConfig, agentId: 'amr' },
      agents: [
        {
          id: 'amr',
          name: 'Open Design AMR',
          bin: 'vela',
          available: true,
          models: [
            { id: 'free-model', label: 'Free model', enabled: true },
            { id: 'paid-model', label: 'Paid model', enabled: false },
          ],
        },
      ],
    });

    openMenu();
    const list = screen.getByTestId('avatar-model-list');
    const locked = within(list).getByRole('radio', { name: /Paid model/i });
    expect(locked.getAttribute('aria-disabled')).toBe('true');

    fireEvent.click(locked);

    expect(onAgentModelChange).not.toHaveBeenCalled();
    await waitFor(() => expect(openSpy).toHaveBeenCalled());
    expect(String(openSpy.mock.calls[0]![0])).toContain('view=plans');
  });

  it('renders the signed-in plan/balance and stamps the avatar upgrade link', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url === '/api/integrations/vela/status') {
        return new Response(
          JSON.stringify({
            loggedIn: true,
            loginInFlight: false,
            profile: 'test',
            user: { id: 'u1', email: 'a@b.c' },
            account: { plan: 'plus', balanceUsd: '247.5087' },
            configPath: '/Users/test/.amr/config.json',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      // Personal workspace: `canManageBilling` is always true there, so this
      // is the control case proving the permission gate below does not
      // suppress the upgrade entry for non-team identities.
      if (url === '/api/workspace/context') {
        return workspaceContextResponse(personalWorkspaceContext());
      }
      return new Response('{}', { status: 202 });
    });
    vi.stubGlobal('fetch', fetchMock);

    renderMenu({
      config: {
        ...baseConfig,
        agentId: 'amr',
        telemetry: { metrics: true },
        installationId: 'od-install-abc',
        agentCliEnv: { amr: { OPEN_DESIGN_AMR_PROFILE: 'test' } },
      },
      agents: [
        {
          id: 'amr',
          name: 'Open Design AMR',
          bin: 'vela',
          available: true,
          models: [{ id: 'default', label: 'Default (CLI config)' }],
        },
      ],
    });

    const dialog = openMenu();
    // Plan badge + balance render once the signed-in status resolves.
    expect(await screen.findByText('Plus')).toBeTruthy();
    expect(dialog.textContent).toContain('$247.51');
    const amrRow = screen.getByTestId('avatar-agent-option-amr');
    expect(amrRow.querySelector('.avatar-amr-row__stat-label')?.textContent).toBe(
      'settings.amrBalance',
    );
    expect(amrRow.querySelector('.avatar-amr-row__stat-value')?.textContent).toBe(
      '$247.51',
    );

    expect(screen.queryByRole('link', { name: 'avatar.amrConsole' })).toBeNull();
    // The upgrade link additionally waits on the workspace-context read
    // (`canManageBilling`), a separate fetch from the AMR status above.
    const upgrade = (await screen.findByRole('link', {
      name: 'settings.amrUpgrade',
    })) as HTMLAnchorElement;
    fireEvent.click(upgrade);
    const url = new URL(upgrade.href);
    expect(url.searchParams.get('view')).toBe('plans');
    expect(url.searchParams.get('od_entry_source')).toBe('avatar_amr_upgrade');
    expect(url.searchParams.get('source')).toBe('open_design');
    expect(url.searchParams.get('od_device_id')).toBe('od-install-abc');
  });

  it('uses only the explicit team workspace balance, never the account fallback', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url === '/api/integrations/vela/status') {
        return new Response(
          JSON.stringify({
            loggedIn: true,
            loginInFlight: false,
            profile: 'test',
            user: { id: 'u1', email: 'a@b.c' },
            account: { plan: 'plus', balanceUsd: '247.5087' },
            configPath: '/Users/test/.amr/config.json',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url === '/api/workspace/context') {
        return workspaceContextResponse(teamMemberWorkspaceContext());
      }
      if (url === '/api/workspace/billing?scope=workspace&workspaceId=ws-team') {
        return new Response(
          JSON.stringify({
            summary: null,
            workspaceBalance: {
              billingScopeVersion: 2,
              workspaceId: 'ws-team',
              workspaceMemberId: 'wm-1',
              balanceUsd: '7.8912',
              expiresAt: null,
              updatedAt: '2026-07-26T00:00:00.000Z',
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response('{}', { status: 202 });
    });
    vi.stubGlobal('fetch', fetchMock);

    renderMenu({
      config: {
        ...baseConfig,
        agentId: 'amr',
      },
      agents: [
        {
          id: 'amr',
          name: 'Open Design AMR',
          bin: 'vela',
          available: true,
          models: [{ id: 'default', label: 'Default (CLI config)' }],
        },
      ],
    });

    const dialog = openMenu();
    expect(await within(dialog).findByText('$7.89')).toBeTruthy();
    expect(within(dialog).queryByText('$247.51')).toBeNull();
  });

  it('renders and refreshes the project-bound balance while ambient navigation is elsewhere', async () => {
    let balance = '131.08';
    vi.stubGlobal('EventSource', MockAvatarEventSource as unknown as typeof EventSource);
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url === '/api/integrations/vela/status') {
        return new Response(JSON.stringify({
          loggedIn: true,
          loginInFlight: false,
          profile: 'test',
          user: { id: 'u1', email: 'a@b.c' },
          account: { plan: 'plus', balanceUsd: '247.5087' },
          configPath: '/Users/test/.amr/config.json',
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url === '/api/workspace/context') {
        return workspaceContextResponse(teamMemberWorkspaceContext({
          workspaceId: 'workspace-b',
          workspaceMemberId: 'member-b',
          teamId: 'workspace-b',
        }));
      }
      if (url === '/api/workspace/billing?scope=workspace&workspaceId=workspace-a') {
        return new Response(JSON.stringify({
          summary: null,
          workspaceBalance: {
            billingScopeVersion: 2,
            workspaceId: 'workspace-a',
            workspaceMemberId: 'member-a',
            balanceUsd: balance,
            expiresAt: null,
            updatedAt: '2026-07-27T00:00:00.000Z',
          },
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('{}', { status: 202 });
    }));

    renderMenu({
      config: { ...baseConfig, agentId: 'amr' },
      agents: [{
        id: 'amr',
        name: 'Open Design AMR',
        bin: 'vela',
        available: true,
        models: [{ id: 'default', label: 'Default (CLI config)' }],
      }],
      projectWorkspaceScope: {
        loading: false,
        scope: {
          kind: 'team',
          projectId: 'project-a',
          workspaceId: 'workspace-a',
          visibility: 'personal',
          context: teamMemberWorkspaceContext({
            workspaceId: 'workspace-a',
            workspaceMemberId: 'member-a',
            teamId: 'workspace-a',
          }) as WorkspaceCollabContext & { workspaceType: 'team' },
        },
      },
    });

    const dialog = openMenu();
    expect(await within(dialog).findByText('$131.08')).toBeTruthy();
    expect(within(dialog).queryByText('$247.51')).toBeNull();

    balance = '132.09';
    act(() => {
      MockAvatarEventSource.instances[0]!.dispatch('wallet-balance-changed', {
        type: 'wallet-balance-changed',
        workspaceId: 'workspace-a',
        workspaceMemberId: 'member-a',
        revision: 'wallet-project-a',
      });
    });
    expect(await within(dialog).findByText('$132.09')).toBeTruthy();
  });

  it('omits wallet and upgrade links for non-upgradeable plans', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url === '/api/integrations/vela/status') {
        return new Response(
          JSON.stringify({
            loggedIn: true,
            loginInFlight: false,
            profile: 'test',
            user: { id: 'u1', email: 'a@b.c' },
            account: { plan: 'max', balanceUsd: '247.5087' },
            configPath: '/Users/test/.amr/config.json',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response('{}', { status: 202 });
    });
    vi.stubGlobal('fetch', fetchMock);

    renderMenu({
      config: {
        ...baseConfig,
        agentId: 'amr',
        telemetry: { metrics: true },
        installationId: 'od-install-abc',
        agentCliEnv: { amr: { OPEN_DESIGN_AMR_PROFILE: 'test' } },
      },
      agents: [
        {
          id: 'amr',
          name: 'Open Design AMR',
          bin: 'vela',
          available: true,
          models: [{ id: 'default', label: 'Default (CLI config)' }],
        },
      ],
    });

    openMenu();
    expect(await screen.findByText('Max')).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'settings.amrUpgrade' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'avatar.amrConsole' })).toBeNull();
  });

  it('falls back to the wallet snapshot when signed-in status has no account balance', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url === '/api/integrations/vela/status') {
        return new Response(
          JSON.stringify({
            loggedIn: true,
            loginInFlight: false,
            profile: 'test',
            user: { id: 'u1', email: 'a@b.c' },
            configPath: '/Users/test/.amr/config.json',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url === '/api/integrations/vela/wallet') {
        return new Response(
          JSON.stringify({
            status: 'available',
            profile: 'test',
            user: { id: 'u1', email: 'a@b.c' },
            balanceUsd: '31.0089',
            updatedAt: '2026-06-29T08:00:00.000Z',
            fetchedAt: '2026-06-29T08:00:01.000Z',
            stale: false,
            source: 'vela_api',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response('{}', { status: 202 });
    });
    vi.stubGlobal('fetch', fetchMock);

    renderMenu({
      config: {
        ...baseConfig,
        agentId: 'amr',
      },
      agents: [
        {
          id: 'amr',
          name: 'Open Design AMR',
          bin: 'vela',
          available: true,
          models: [{ id: 'default', label: 'Default (CLI config)' }],
        },
      ],
    });

    openMenu();
    expect(await screen.findByText('$31.01')).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith('/api/integrations/vela/wallet', {
      cache: 'no-store',
    });
  });

  it('uses the signed-in status profile for avatar console and upgrade links', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url === '/api/integrations/vela/status') {
        return new Response(
          JSON.stringify({
            loggedIn: true,
            loginInFlight: false,
            profile: 'test',
            user: { id: 'u1', email: 'a@b.c' },
            account: { plan: 'plus', balanceUsd: '247.5087' },
            configPath: '/Users/test/.amr/config.json',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url === '/api/workspace/context') {
        return workspaceContextResponse(personalWorkspaceContext());
      }
      return new Response('{}', { status: 202 });
    });
    vi.stubGlobal('fetch', fetchMock);

    renderMenu({
      config: {
        ...baseConfig,
        agentId: 'amr',
        telemetry: { metrics: true },
        installationId: 'od-install-abc',
      },
      agents: [
        {
          id: 'amr',
          name: 'Open Design AMR',
          bin: 'vela',
          available: true,
          models: [{ id: 'default', label: 'Default (CLI config)' }],
        },
      ],
    });

    openMenu();
    expect(await screen.findByText('Plus')).toBeTruthy();

    expect(screen.queryByRole('link', { name: 'avatar.amrConsole' })).toBeNull();
    const upgrade = (await screen.findByRole('link', {
      name: 'settings.amrUpgrade',
    })) as HTMLAnchorElement;
    fireEvent.click(upgrade);
    const upgradeUrl = new URL(upgrade.href);
    expect(upgradeUrl.origin).toBe('https://vela.powerformer.net');
    expect(upgradeUrl.searchParams.get('view')).toBe('plans');
  });

  // recvqfYKutwWlQ: a team member's plan tier can be upgradeable while the
  // member itself cannot act on billing (owner-only) — the upgrade entry must
  // stay hidden for them even with a fully signed-in, upgrade-eligible AMR
  // account.
  it('hides the AMR upgrade link for a team member without billing permission', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url === '/api/integrations/vela/status') {
        return new Response(
          JSON.stringify({
            loggedIn: true,
            loginInFlight: false,
            profile: 'test',
            user: { id: 'u1', email: 'a@b.c' },
            account: { plan: 'plus', balanceUsd: '247.5087' },
            configPath: '/Users/test/.amr/config.json',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url === '/api/workspace/context') {
        return workspaceContextResponse(teamMemberWorkspaceContext());
      }
      return new Response('{}', { status: 202 });
    });
    vi.stubGlobal('fetch', fetchMock);

    renderMenu({
      config: { ...baseConfig, agentId: 'amr' },
      agents: [
        {
          id: 'amr',
          name: 'Open Design AMR',
          bin: 'vela',
          available: true,
          models: [{ id: 'default', label: 'Default (CLI config)' }],
        },
      ],
    });

    openMenu();
    expect(await screen.findByText('Plus')).toBeTruthy();
    // Give the workspace-context fetch a beat to settle so a late render
    // cannot sneak the link back in.
    await waitFor(() => expect(fetchMock.mock.calls.some(([i]) =>
      i.toString() === '/api/workspace/context')).toBe(true));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.queryByRole('link', { name: 'settings.amrUpgrade' })).toBeNull();
  });

  it('clears stale AMR account data before refreshing on reopen', async () => {
    let statusCalls = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url === '/api/integrations/vela/status') {
        statusCalls += 1;
        if (statusCalls === 1) {
          return new Response(
            JSON.stringify({
              loggedIn: true,
              loginInFlight: false,
              profile: 'test',
              user: { id: 'u1', email: 'old@example.com' },
              account: { plan: 'plus', balanceUsd: '247.51' },
              configPath: '/Users/test/.amr/config.json',
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        throw new Error('status unavailable');
      }
      return new Response('{}', { status: 202 });
    });
    vi.stubGlobal('fetch', fetchMock);

    renderMenu({
      config: {
        ...baseConfig,
        agentId: 'amr',
        agentCliEnv: { amr: { OPEN_DESIGN_AMR_PROFILE: 'test' } },
      },
      agents: [
        {
          id: 'amr',
          name: 'Open Design AMR',
          bin: 'vela',
          available: true,
          models: [{ id: 'default', label: 'Default (CLI config)' }],
        },
      ],
    });

    const trigger = screen.getByRole('button', { name: 'avatar.title' });
    fireEvent.click(trigger);
    expect(await screen.findByText('Plus')).toBeTruthy();
    expect(screen.getByRole('dialog', { name: 'avatar.title' }).textContent).toContain('$247.51');

    fireEvent.click(trigger);
    fireEvent.click(trigger);

    // Count only the AMR status re-fetch this test is about — `fetchMock`
    // also now answers the unrelated `/api/workspace/context` read the
    // billing-permission gate added, so a raw total-call assertion would
    // couple this test to that unrelated fetch.
    await waitFor(() => expect(statusCalls).toBe(2));
    const dialog = screen.getByRole('dialog', { name: 'avatar.title' });
    expect(within(dialog).queryByText('Plus')).toBeNull();
    expect(dialog.textContent).not.toContain('$247.51');
  });
});
