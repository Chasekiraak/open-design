// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AvatarMenu } from '../../src/components/AvatarMenu';
import type { AgentInfo, AppConfig, ExecMode } from '../../src/types';

vi.mock('../../src/i18n', () => ({
  useT: () => (key: string) => key,
}));


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
}: {
  config?: AppConfig;
  agents?: AgentInfo[];
  daemonLive?: boolean;
  onModeChange?: ReturnType<typeof vi.fn<ModeChangeHandler>>;
  onAgentChange?: ReturnType<typeof vi.fn<AgentChangeHandler>>;
  onAgentModelChange?: ReturnType<typeof vi.fn<AgentModelChangeHandler>>;
  onOpenSettings?: ReturnType<typeof vi.fn<OpenSettingsHandler>>;
  onRefreshAgents?: ReturnType<typeof vi.fn<VoidHandler>>;
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

  // Product decision (2026-07-24): the popover is a model picker only. The
  // Open Design account row — plan badge, balance, upgrade/console links —
  // was removed entirely (account/billing surfaces live in the nav rail and
  // Settings), so none of it may render even with a fully signed-in AMR
  // status. This is the guard for that invariant.
  it('never renders the account row, plan badge or balance in the popover', async () => {
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

});
