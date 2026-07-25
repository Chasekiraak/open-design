// @vitest-environment jsdom

import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InstalledPluginRecordSchema } from '@open-design/contracts';

import { PluginDetailView } from '../../src/components/PluginDetailView';
import { I18nProvider } from '../../src/i18n';

vi.mock('../../src/analytics/provider', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/analytics/provider')>();
  return { ...actual, useAnalytics: () => ({ track: vi.fn() }) };
});

vi.mock('../../src/router', () => ({
  navigate: vi.fn(),
}));

vi.mock('../../src/state/projects', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/state/projects')>();
  return { ...actual, applyPlugin: vi.fn() };
});

const PLUGIN = InstalledPluginRecordSchema.parse({
  id: 'research-suite',
  title: 'Research Suite',
  version: '2.4.0',
  sourceKind: 'bundled',
  source: '/plugins/research-suite',
  sourceMarketplaceId: 'official',
  sourceMarketplaceEntryName: 'open-design/research-suite',
  trust: 'bundled',
  capabilitiesGranted: ['prompt:inject'],
  manifest: {
    name: 'research-suite',
    title: 'Research Suite',
    version: '2.4.0',
    description: 'Turn source material into a focused research brief.',
    license: 'MIT',
    compat: {
      agentSkills: [
        { path: ' skills/source-review/SKILL.md ' },
        { path: 'skills/source-review/SKILL.md' },
      ],
    },
    od: {
      kind: 'bundle',
      context: {
        skills: [{}, { ref: '   ' }],
      },
      connectors: {
        required: [
          { id: ' notion ', tools: [' read_page ', 'read_page'] },
          { id: 'notion', tools: [] },
        ],
        optional: [
          { id: 'notion', tools: ['search_database', ' search_database '] },
          { id: 'github', tools: ['search_issues'] },
        ],
      },
      preview: { entry: './preview.html' },
      useCase: {
        exampleOutputs: [{ path: './examples/research.html', title: 'Research example' }],
      },
      capabilities: ['prompt:inject'],
    },
  },
  fsPath: '/plugins/research-suite',
  installedAt: 0,
  updatedAt: 0,
});

beforeEach(() => {
  globalThis.fetch = vi.fn(async () =>
    new Response(JSON.stringify(PLUGIN), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  ) as typeof fetch;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('PluginDetailView curated installed-extension layout', () => {
  it('maps real connector and skill metadata without inventing unavailable commands', async () => {
    const { container } = render(
      <I18nProvider initial="en">
        <PluginDetailView pluginId={PLUGIN.id} />
      </I18nProvider>,
    );

    expect(await screen.findByRole('heading', { name: 'Research Suite' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /back to list/i })).toBeTruthy();

    const quickCommands = screen.getByRole('region', { name: /quick commands/i });
    expect(within(quickCommands).getByRole('heading', { name: /quick commands.*0/i })).toBeTruthy();
    expect(within(quickCommands).getByText('No quick commands available.'))
      .toHaveClass('plugin-suite-detail__empty-row');
    expect(within(quickCommands).queryByRole('button')).toBeNull();

    const connections = screen.getByRole('region', { name: /data connections/i });
    expect(within(connections).getByRole('heading', { name: /data connections.*2/i })).toBeTruthy();
    expect(within(connections).getAllByText('notion')).toHaveLength(1);
    expect(within(connections).getByText('github')).toBeTruthy();
    expect(within(connections).getByText('read_page, search_database')).toBeTruthy();
    expect(within(connections).getByText(/required/i)).toBeTruthy();
    expect(within(connections).getByText(/optional/i)).toBeTruthy();

    const skills = screen.getByRole('region', { name: /knowledge skills/i });
    expect(within(skills).getByText('skills/source-review/SKILL.md')).toBeTruthy();
    expect(screen.getByText('@OpenDesign')).toBeTruthy();
    expect(screen.getByText('Open Design official')).toBeTruthy();

    const advanced = screen.getByTestId('plugin-meta-advanced');
    expect(advanced).not.toHaveAttribute('open');
    expect(within(advanced).getByText('MIT')).toBeTruthy();
    expect(within(advanced).getByText('od plugin install open-design/research-suite')).toBeTruthy();

    expect(screen.getByTestId('plugin-detail-preview-iframe').getAttribute('src'))
      .toBe('/api/plugins/research-suite/preview');
    expect(screen.getByTestId('plugin-detail-example-research').getAttribute('href'))
      .toBe('/api/plugins/research-suite/example/research');
    expect(screen.getByTestId('plugin-detail-use')).toBeTruthy();

    expect(container.querySelector('.plugin-suite-detail')).toBeTruthy();
    expect(container.querySelector('.plugin-suite-detail__hero')).toBeTruthy();
  });

  it('renders explicit empty states when connectors and skills are undeclared', async () => {
    const emptyPlugin = InstalledPluginRecordSchema.parse({
      ...PLUGIN,
      id: 'empty-suite',
      manifest: {
        ...PLUGIN.manifest,
        name: 'empty-suite',
        compat: undefined,
        od: { kind: 'bundle' },
      },
    });
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      new Response(JSON.stringify(emptyPlugin), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    render(
      <I18nProvider initial="en">
        <PluginDetailView pluginId={emptyPlugin.id} />
      </I18nProvider>,
    );

    const connections = await screen.findByRole('region', { name: /data connections/i });
    expect(within(connections).getByText(
      'This suite does not require any external data connections.',
    )).toHaveClass('plugin-suite-detail__empty-row');

    const skills = screen.getByRole('region', { name: /knowledge skills/i });
    expect(within(skills).getByText(
      'This suite has no standalone knowledge skills yet.',
    )).toHaveClass('plugin-suite-detail__empty-row');
  });

  it('renders the demo copy and official identity in Simplified Chinese', async () => {
    render(
      <I18nProvider initial="zh-CN">
        <PluginDetailView pluginId={PLUGIN.id} />
      </I18nProvider>,
    );

    expect(await screen.findByRole('button', { name: '返回列表' })).toBeTruthy();
    expect(screen.getByRole('region', { name: /快捷命令/ })).toBeTruthy();
    expect(screen.getByRole('region', { name: /数据连接/ })).toBeTruthy();
    expect(screen.getByRole('region', { name: /知识技能/ })).toBeTruthy();
    expect(screen.getByText('Open Design 官方')).toBeTruthy();
    expect(screen.getByText('@OpenDesign')).toBeTruthy();
  });
});
