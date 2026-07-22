// @vitest-environment jsdom
//
// recvpZCr4MAqNQ: a project's name stayed "未命名" forever, even after its
// first prompt ran and produced real content. Root cause: the Drafts / All-
// projects empty-state "New project" CTA (`EntryShell.startBlankProjectFromRail`)
// created a project with the literal placeholder name and NO `nameSource`
// metadata at all. `canAutoRenameProjectFromPrompt` (utils/projectName.ts)
// only re-engages for `nameSource: 'generated' | 'prompt'` — a project
// missing the field entirely fails closed forever, unlike every other blank/
// no-name create path (`handleCreateProjectFromDesignSystem`, the New Project
// panel's blank pick), which already tag `nameSource: 'generated'`.

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import {
  buildWorkspacePermissions,
  buildWorkspaceSeatSummary,
  type WorkspaceCollabContext,
} from '@open-design/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EntryShell } from '../../src/components/EntryShell';
import { I18nProvider } from '../../src/i18n';
import type { AgentInfo, AppConfig } from '../../src/types';
import { resetTeamProjectsCache, resetWorkspaceContextCache } from '../../src/collab/useWorkspaceContext';

const originalFetch = globalThis.fetch;
const originalResizeObserver = globalThis.ResizeObserver;

class ResizeObserverMock {
  observe() {}
  disconnect() {}
  unobserve() {}
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// Drafts / All-projects are workspace-only views: EntryShell redirects them
// back to Home once the workspace-context read resolves with nothing. Give
// every test a resolved team context up front — the real bug reproduces
// inside a team workspace ("OD Feature Team" in the live acceptance check) —
// so the empty-state CTA renders deterministically instead of racing a
// same-tick redirect.
function teamContext(): WorkspaceCollabContext {
  const role = 'member' as const;
  const lifecycleState = 'active' as const;
  return {
    workspaceId: 'ws-1',
    workspaceType: 'team',
    workspaceMemberId: 'wm-1',
    role,
    memberStatus: 'active',
    lifecycleState,
    billingState: 'active',
    planId: null,
    providerMode: 'platform_credits',
    seatSummary: buildWorkspaceSeatSummary({ seatLimit: 5, usedSeats: 1 }),
    permissions: buildWorkspacePermissions({ role, lifecycleState }),
    displayName: 'Ma Shu',
  };
}

function installFetchMock() {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const pathname = new URL(String(input), 'http://d.local').pathname;
    if (pathname.endsWith('/workspace/context')) {
      return jsonResponse({ context: teamContext() });
    }
    if (pathname.endsWith('/workspace/projects/team')) {
      return jsonResponse({ projects: [] });
    }
    return jsonResponse({});
  }) as typeof fetch;
}

function cliAgent(overrides: Partial<AgentInfo> = {}): AgentInfo {
  return {
    id: 'claude-code',
    name: 'Claude Code',
    bin: 'claude',
    available: true,
    version: '1.0.0',
    models: [{ id: 'sonnet', label: 'Sonnet' }],
    ...overrides,
  };
}

function baseConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    mode: 'daemon',
    agentId: 'claude-code',
    agentModels: { 'claude-code': { model: 'sonnet' } },
    apiProtocol: 'anthropic',
    apiProtocolConfigs: {},
    apiKey: '',
    baseUrl: '',
    model: '',
    theme: 'system',
    ...overrides,
  } as AppConfig;
}

function renderAt(path: string, overrides: Partial<React.ComponentProps<typeof EntryShell>> = {}) {
  window.history.replaceState(null, '', path);
  const props: React.ComponentProps<typeof EntryShell> = {
    skills: [],
    designTemplates: [],
    designSystems: [],
    projects: [],
    templates: [],
    promptTemplates: [],
    defaultDesignSystemId: null,
    connectors: [],
    connectorsLoading: false,
    config: baseConfig(),
    agents: [cliAgent()],
    daemonLive: true,
    onModeChange: vi.fn(),
    onAgentChange: vi.fn(),
    onAgentModelChange: vi.fn(),
    onApiProtocolChange: vi.fn(),
    onApiModelChange: vi.fn(),
    onConfigPersist: vi.fn(),
    onRefreshAgents: vi.fn(() => [cliAgent()]),
    onThemeChange: vi.fn(),
    onCreateProject: vi.fn(() => Promise.resolve(true)),
    onCreatePluginShareProject: vi.fn(),
    onImportClaudeDesign: vi.fn(),
    onOpenProject: vi.fn(),
    onOpenLiveArtifact: vi.fn(),
    onDeleteProject: vi.fn(),
    onRenameProject: vi.fn(),
    onChangeDefaultDesignSystem: vi.fn(),
    onPersistComposioKey: vi.fn(),
    onOpenSettings: vi.fn(),
    onCompleteOnboarding: vi.fn(),
    ...overrides,
  };

  render(
    <I18nProvider initial="en">
      <EntryShell {...props} />
    </I18nProvider>,
  );

  return props;
}

beforeEach(() => {
  globalThis.ResizeObserver = ResizeObserverMock as typeof ResizeObserver;
  resetWorkspaceContextCache();
  resetTeamProjectsCache();
  installFetchMock();
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  globalThis.ResizeObserver = originalResizeObserver;
  resetWorkspaceContextCache();
  resetTeamProjectsCache();
});

describe('EntryShell blank-project creation tags nameSource', () => {
  it('tags the Drafts empty-state "New project" CTA as generated', async () => {
    const props = renderAt('/drafts');

    const cta = await screen.findByRole('button', { name: 'New project' });
    fireEvent.click(cta);

    expect(props.onCreateProject).toHaveBeenCalledTimes(1);
    expect(props.onCreateProject).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Untitled',
        metadata: expect.objectContaining({ nameSource: 'generated' }),
      }),
    );
  });

  it('tags the All-projects empty-state "New project" CTA as generated', async () => {
    const props = renderAt('/all-projects');

    const cta = await screen.findByRole('button', { name: 'New project' });
    fireEvent.click(cta);

    expect(props.onCreateProject).toHaveBeenCalledTimes(1);
    expect(props.onCreateProject).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Untitled',
        metadata: expect.objectContaining({ nameSource: 'generated' }),
      }),
    );
  });
});
