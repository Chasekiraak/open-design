// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import type { DesignSystemSummary } from '@open-design/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from '../../src/App';
import {
  daemonIsLive,
  fetchAgentsStream,
  fetchAppVersionInfo,
  fetchDesignSystems,
  fetchDesignTemplates,
  fetchPromptTemplates,
  fetchSkills,
} from '../../src/providers/registry';
import {
  fetchComposioConfigFromDaemon,
  fetchDaemonConfig,
  loadConfig,
  mergeDaemonConfig,
  syncComposioConfigToDaemon,
  syncConfigToDaemon,
} from '../../src/state/config';
import { listProjects, listTemplates } from '../../src/state/projects';
import type { AppConfig } from '../../src/types';

vi.mock('../../src/router', () => ({
  navigate: vi.fn(),
  useRoute: () => ({ kind: 'home' as const, view: 'design-systems' as const }),
}));

vi.mock('../../src/components/EntryView', () => ({
  EntryView: ({
    designSystems,
    designSystemsLoading,
  }: {
    designSystems: DesignSystemSummary[];
    designSystemsLoading?: boolean;
  }) => (
    <div
      data-testid="design-systems-state"
      data-loading={designSystemsLoading ? 'true' : 'false'}
    >
      {designSystems.map((system) => (
        <span key={system.id}>{system.title}</span>
      ))}
    </div>
  ),
}));

vi.mock('../../src/components/ProjectView', () => ({
  ProjectView: () => <div>Project view</div>,
}));

vi.mock('../../src/components/pet/PetOverlay', () => ({
  PetOverlay: () => null,
}));

vi.mock('../../src/components/pet/pets', () => ({
  migrateCustomPetAtlas: vi.fn().mockResolvedValue(null),
}));

vi.mock('../../src/components/SettingsDialog', () => ({
  SettingsDialog: () => null,
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
    fetchComposioConfigFromDaemon: vi.fn(),
    fetchDaemonConfig: vi.fn(),
    loadConfig: vi.fn(),
    mergeDaemonConfig: vi.fn(),
    syncComposioConfigToDaemon: vi.fn(),
    syncConfigToDaemon: vi.fn(),
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

const readySystem: DesignSystemSummary = {
  id: 'user:ready',
  title: 'Ready design system',
  category: 'Custom',
  summary: 'Loaded from the successful workspace-scoped request.',
  surface: 'web',
  source: 'user',
  status: 'published',
  isEditable: true,
};

beforeEach(() => {
  vi.mocked(daemonIsLive).mockResolvedValue(true);
  vi.mocked(fetchAgentsStream).mockResolvedValue([]);
  vi.mocked(fetchAppVersionInfo).mockResolvedValue(null);
  vi.mocked(fetchDesignTemplates).mockResolvedValue([]);
  vi.mocked(fetchPromptTemplates).mockResolvedValue([]);
  vi.mocked(fetchSkills).mockResolvedValue([]);
  vi.mocked(listProjects).mockResolvedValue([]);
  vi.mocked(listTemplates).mockResolvedValue([]);
  vi.mocked(fetchDaemonConfig).mockResolvedValue({});
  vi.mocked(fetchComposioConfigFromDaemon).mockResolvedValue(null);
  vi.mocked(mergeDaemonConfig).mockImplementation((local) => local);
  vi.mocked(loadConfig).mockReturnValue({ ...baseConfig });
  vi.mocked(syncConfigToDaemon).mockResolvedValue(undefined);
  vi.mocked(syncComposioConfigToDaemon).mockResolvedValue(true);
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({}),
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe('App design-system catalog loading race', () => {
  it('clears loading when any concurrent initial catalog request succeeds', async () => {
    const neverSettles = new Promise<DesignSystemSummary[]>(() => {});
    vi.mocked(fetchDesignSystems)
      // The workspace-scoped effect fires synchronously; this is the observed
      // 200 response that already supplied a usable catalog.
      .mockResolvedValueOnce([readySystem])
      // Bootstrap resumes after daemonIsLive and can restart as its nominally
      // stable dependencies settle. Those duplicate requests own the old
      // loading flag; if they stall, they must not hide the first result.
      .mockReturnValue(neverSettles);

    render(<App />);

    await waitFor(() => {
      expect(vi.mocked(fetchDesignSystems).mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(screen.getByText('Ready design system')).toBeTruthy();
    });

    expect(screen.getByTestId('design-systems-state').dataset.loading).toBe('false');
  });
});
