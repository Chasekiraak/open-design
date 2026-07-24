// @vitest-environment jsdom
//
// Stage B of plugin-driven-flow-plan — Home intent tabs / shortcuts.
// Covers:
//   - Every chip in the catalog renders with its test id.
//   - Clicking a chip forwards the full chip descriptor to onPickChip
//     so the dispatcher in HomeView can route to the right flow.
//   - The active + pending UI states light up the right chip and
//     disable all chips while a plugin is mid-apply.

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DesignSystemSummary, InstalledPluginRecord } from '@open-design/contracts';

vi.mock('../../src/components/home-hero/PlaceholderCarousel', () => ({
  PlaceholderCarousel: () => null,
}));

import { HomeHero, homeHeroExamplePluginsForChip } from '../../src/components/HomeHero';
import {
  HOME_HERO_CHIPS,
  findChip,
} from '../../src/components/home-hero/chips';

afterEach(() => {
  cleanup();
  window.localStorage.removeItem('open-design:home-template-recommendation:v1');
});

function makePlugin(
  id: string,
  mode: string,
  title = id,
  extraTags: string[] = [],
  options: { query?: string | null } = {},
): InstalledPluginRecord {
  return {
    id,
    title,
    version: '1.0.0',
    sourceKind: 'bundled',
    source: '/tmp',
    trust: 'bundled',
    capabilitiesGranted: ['prompt:inject'],
    manifest: {
      name: id,
      version: '1.0.0',
      title,
      description: 'Plugin preset fixture',
      tags: [mode, ...extraTags],
      od: {
        mode,
        useCase: {
          ...(options.query !== null
            ? { query: options.query ?? `Create with {{topic}} using ${title}` }
            : {}),
        },
        inputs: [
          {
            name: 'topic',
            label: 'Topic',
            type: 'text',
            default: 'a focused brief',
          },
        ],
        preview: { type: 'image', poster: '/preview.png' },
      },
    },
    fsPath: '/tmp',
    installedAt: 0,
    updatedAt: 0,
  };
}

function renderHero(overrides: Partial<React.ComponentProps<typeof HomeHero>> = {}) {
  const onPickChip = vi.fn();
  const onPickPlugin = vi.fn();
  const onPickExamplePlugin = vi.fn();
  const onOpenPluginDetails = vi.fn();
  const onClearActiveChip = vi.fn();
  render(
    <HomeHero
      prompt=""
      onPromptChange={() => undefined}
      onSubmit={() => undefined}
      activePluginTitle={null}
      activeChipId={null}
      onClearActivePlugin={() => undefined}
      pluginOptions={[]}
      pluginsLoading={false}
      pendingPluginId={null}
      pendingChipId={null}
      onPickPlugin={onPickPlugin}
      onPickExamplePlugin={onPickExamplePlugin}
      onOpenPluginDetails={onOpenPluginDetails}
      onPickChip={onPickChip}
      onClearActiveChip={onClearActiveChip}
      contextItemCount={0}
      error={null}
      {...overrides}
    />,
  );
  return { onPickChip, onPickPlugin, onPickExamplePlugin, onOpenPluginDetails, onClearActiveChip };
}

const NEUTRAL_MODERN: DesignSystemSummary = {
  id: 'neutral-modern',
  title: 'Neutral Modern',
  category: 'Starter',
  summary: 'A neutral fallback system.',
  source: 'built-in',
  status: 'published',
};

// First-time Home renders the catalog inline. Returning users use the exact
// same cards after expanding the composer footer trigger.
function openTemplateGrid() {
  if (!screen.queryByTestId('home-hero-type-tabs')) {
    fireEvent.click(screen.getByTestId('home-hero-template-trigger'));
  }
}

function pickTemplate(chipId: string) {
  openTemplateGrid();
  fireEvent.click(screen.getByTestId(`home-hero-rail-${chipId}`));
}

describe('HomeHero intent rail', () => {
  it('keeps the title prefix static while remounting only the capability value', () => {
    renderHero();

    const title = screen.getByRole('heading', { level: 1 });
    expect(title.querySelector('.home-hero__title-prefix')?.textContent).toBe('Start with');
    expect(title.querySelector('.home-hero__capability-value')).toBeTruthy();
  });

  it('keeps cycling Hero capabilities after a Home interaction', () => {
    vi.useFakeTimers();
    try {
      renderHero();
      fireEvent.click(screen.getByTestId('home-hero-capability-design-system'));

      act(() => {
        vi.advanceTimersByTime(3_600);
      });

      expect(screen.getByTestId('home-hero-capability-visual-references')).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('cues a prefilled Design mode before its selected design system, then stops after interaction', () => {
    vi.useFakeTimers();
    try {
      renderHero({
        sessionMode: 'design',
        selectedSessionMode: 'design',
        designSystems: [NEUTRAL_MODERN],
        selectedDesignSystemId: NEUTRAL_MODERN.id,
        onDesignSystemChange: vi.fn(),
        prefilledDesignModeAttentionKey: 'new:designer:neutral-modern',
      });

      const modeIcon = screen.getByTestId('composer-mode-icon');
      const designSystemIcon = screen.getByTestId('home-hero-selected-design-system-icon');
      expect(modeIcon).toHaveClass('is-prefill-attention');
      expect(designSystemIcon).not.toHaveClass('is-prefill-attention');

      act(() => {
        vi.advanceTimersByTime(180);
      });
      expect(modeIcon).not.toHaveClass('is-prefill-attention');
      expect(designSystemIcon).toHaveClass('is-prefill-attention');

      // Any composer control ends the one-shot hint and prevents a later
      // timer phase from restarting it.
      fireEvent.pointerDown(screen.getByTestId('home-hero-plus-trigger'));
      expect(designSystemIcon).not.toHaveClass('is-prefill-attention');
      act(() => {
        vi.advanceTimersByTime(500);
      });
      expect(modeIcon).not.toHaveClass('is-prefill-attention');
      expect(designSystemIcon).not.toHaveClass('is-prefill-attention');
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels the prefilled attention before a user starts typing', () => {
    vi.useFakeTimers();
    try {
      renderHero({
        sessionMode: 'design',
        selectedSessionMode: 'design',
        designSystems: [NEUTRAL_MODERN],
        selectedDesignSystemId: NEUTRAL_MODERN.id,
        onDesignSystemChange: vi.fn(),
        prefilledDesignModeAttentionKey: 'new:designer:neutral-modern',
      });

      fireEvent.input(screen.getByTestId('home-hero-input'));
      expect(screen.getByTestId('composer-mode-icon')).not.toHaveClass('is-prefill-attention');
      act(() => {
        vi.advanceTimersByTime(500);
      });
      expect(screen.getByTestId('home-hero-selected-design-system-icon')).not.toHaveClass('is-prefill-attention');
    } finally {
      vi.useRealTimers();
    }
  });

  it('offers every scenario template as a readable first-time card', () => {
    renderHero();
    expect(screen.queryByTestId('home-hero-template-trigger')).toBeNull();
    expect(screen.getByTestId('home-hero-template-entry-hint').textContent).toContain('Creation type');
    for (const chip of HOME_HERO_CHIPS) {
      const card = screen.queryByTestId(`home-hero-rail-${chip.id}`);
      if (chip.group === 'create' && chip.action.kind === 'apply-scenario') {
        expect(card).toBeTruthy();
      } else {
        // Brand Kit (its own action) and the migrate shortcuts are reached from
        // the Brand Kit tab, the Extensions tab, and the composer + menu.
        expect(card).toBeNull();
      }
    }
  });

  it('puts a designer’s prototype and wireframe cards first without hiding other types', () => {
    renderHero({ onboardingRole: 'designer' });

    expect(screen.getByTestId('home-hero-template-section')).toBeTruthy();
    const ids = Array.from(
      screen.getByTestId('home-hero-type-tabs').querySelectorAll<HTMLElement>('[data-chip-id]'),
    ).map((node) => node.dataset.chipId);
    expect(ids.slice(0, 2)).toEqual(['prototype', 'wireframe']);
    expect(ids).toContain('landing-page');
    expect(ids).toContain('deck');
  });

  it('keeps returning Home compact, then expands into the same readable catalog', () => {
    window.localStorage.setItem('open-design:home-template-recommendation:v1', '1');
    renderHero();

    expect(screen.queryByTestId('home-hero-template-section')).toBeNull();
    fireEvent.click(screen.getByTestId('home-hero-template-trigger'));
    expect(screen.getByTestId('home-hero-template-section')).toBeTruthy();
    expect(screen.getByTestId('home-hero-rail-prototype').textContent).toContain('UI Mockup');
  });

  it('opens the Home working-directory menu above the first-run card catalog', () => {
    renderHero({ onPickWorkingDir: vi.fn() });

    fireEvent.click(screen.getByTestId('working-dir-trigger'));
    expect(screen.getByTestId('working-dir-panel')).toHaveAttribute('data-placement', 'up');
  });

  it('surfaces a first-run recommendation on its matching template cards', () => {
    renderHero({ onboardingRole: 'designer' });

    const picker = screen.getByTestId('home-hero-template-picker');
    expect(picker).toHaveClass('is-inline-catalog');
    expect(screen.queryByTestId('home-hero-template-trigger')).toBeNull();

    expect(screen.getByTestId('home-hero-rail-prototype')).toHaveClass('is-recommended');
    expect(screen.getByTestId('home-hero-rail-wireframe')).toHaveClass('is-secondary-recommended');
  });

  it('renders execution switcher inside the input footer when provided', () => {
    renderHero({
      executionSwitcher: (
        <button type="button" data-testid="home-execution-switcher">
          Local CLI
        </button>
      ),
    });

    const switcher = screen.getByTestId('home-execution-switcher');
    const footer = switcher.closest('.home-hero__input-foot');
    expect(footer).toBeTruthy();
  });

  it('forwards the matching chip descriptor when clicked', () => {
    const { onPickChip } = renderHero();
    pickTemplate('image');
    expect(onPickChip).toHaveBeenCalledTimes(1);
    expect(onPickChip).toHaveBeenCalledWith(findChip('image'));
  });

  it('moves the active creation chip into the composer and hides the tab row', () => {
    renderHero({ activeChipId: 'video' });
    expect(screen.queryByTestId('home-hero-type-tabs')).toBeNull();
    expect(screen.queryByTestId('home-hero-rail-video')).toBeNull();
    const node = screen.getByTestId('home-hero-template-trigger');
    expect(node.textContent).toContain('Video');
  });

  it('does not reserve an empty active-context row for a hidden chip-bound plugin', () => {
    renderHero({
      activeChipId: 'wireframe',
      activePluginTitle: 'Wireframe',
      showActivePluginChip: false,
      contextItemCount: 3,
    });

    expect(document.querySelector('.home-hero__active')).toBeNull();
    expect(screen.getByTestId('home-hero-template-trigger').textContent).toContain('Wireframe');
  });

  it('lets the active creation chip be removed from the composer', () => {
    const { onClearActiveChip } = renderHero({ activeChipId: 'prototype' });
    fireEvent.click(screen.getByTestId('home-hero-template-reset'));
    expect(onClearActiveChip).toHaveBeenCalledTimes(1);
  });

  it('tracks the committed template on the footer pill and resets it on clear', () => {
    // The pill mirrors the committed chip: it must pick the label up when a
    // template becomes active and fall back to the empty "Template" kicker the
    // moment the chip is cleared (issue: the pill stayed "Slide deck").
    const baseProps = {
      prompt: '',
      onPromptChange: () => undefined,
      onSubmit: () => undefined,
      activePluginTitle: null,
      activeChipId: null,
      onClearActivePlugin: () => undefined,
      pluginOptions: [],
      pluginsLoading: false,
      pendingPluginId: null,
      pendingChipId: null,
      onPickPlugin: vi.fn(),
      onPickExamplePlugin: vi.fn(),
      onPickChip: vi.fn(),
      onClearActiveChip: vi.fn(),
      contextItemCount: 0,
      error: null,
    } as React.ComponentProps<typeof HomeHero>;

    const { rerender } = render(<HomeHero {...baseProps} activeChipId={null} />);
    expect(screen.getByTestId('home-hero-template-entry-hint').textContent).toContain('Creation type');

    // Picking a template commits the chip through the host.
    rerender(<HomeHero {...baseProps} activeChipId="deck" />);
    expect(screen.getByTestId('home-hero-template-trigger').textContent).toContain('Slide deck');

    // Clear nulls the active chip — the pill must fall back to the empty
    // first-run state, where the inline card catalog remains the only picker.
    rerender(<HomeHero {...baseProps} activeChipId={null} />);
    const hint = screen.getByTestId('home-hero-template-entry-hint');
    expect(hint.textContent).toContain('Creation type');
    expect(hint.textContent).not.toContain('Slide deck');
  });

  it('uses the active creation chip as the only clear control for a chip-bound plugin', () => {
    const activePlugin = makePlugin('example-image-a', 'image', 'Product image');
    renderHero({
      activeChipId: 'image',
      activePluginTitle: 'Product image',
      activePluginRecord: activePlugin,
      showActivePluginChip: true,
    });

    expect(screen.getByTestId('home-hero-active-plugin')).toBeTruthy();
    expect(screen.getByTestId('home-hero-template-trigger').textContent).not.toContain('None');
    expect(screen.queryByLabelText('Clear active plugin')).toBeNull();
  });

  it('keeps the active plugin clear control when no creation chip is active', () => {
    const activePlugin = makePlugin('example-image-a', 'image', 'Product image');
    const onClearActivePlugin = vi.fn();
    renderHero({
      activeChipId: null,
      activePluginTitle: 'Product image',
      activePluginRecord: activePlugin,
      onClearActivePlugin,
      showActivePluginChip: true,
    });

    const clear = screen.getByLabelText('Clear active plugin');
    fireEvent.click(clear);

    expect(onClearActivePlugin).toHaveBeenCalledTimes(1);
  });

  it('shows prompt examples below the composer for the selected tab', () => {
    const onPromptChange = vi.fn();
    renderHero({ activeChipId: 'deck', onPromptChange });

    expect(screen.getByTestId('home-hero-prompt-examples')).toBeTruthy();
    const examples = screen.getAllByTestId('home-hero-prompt-example');
    expect(examples).toHaveLength(3);

    fireEvent.click(examples[0]!);
    expect(onPromptChange).toHaveBeenCalledWith(
      'Generate a product-launch presentation from the product materials.',
    );
    // The top "selected example" pill was removed from the composer; picking an
    // example still seeds the prompt but no longer surfaces a dismissible chip.
    expect(screen.queryByTestId('home-hero-active-example')).toBeNull();
  });

  it('shows matching plugin presets in the example prompt area for the selected tab', () => {
    const deckPlugin = makePlugin('example-deck-a', 'deck', 'Investor deck');
    const imagePlugin = makePlugin('example-image-a', 'image', 'Product image');
    const { onPickExamplePlugin, onOpenPluginDetails } = renderHero({
      activeChipId: 'deck',
      pluginOptions: [deckPlugin, imagePlugin],
    });

    const presets = screen.getAllByTestId('home-hero-plugin-preset');
    expect(presets).toHaveLength(1);
    // The preset card is now a thumbnail + name only; the prompt blurb was
    // dropped from the card face but is still passed through on Use below.
    expect(presets[0]?.textContent).toContain('Investor deck');

    // Clicking the card body opens the preview (detail modal), not the seed.
    fireEvent.click(presets[0]!);
    expect(onOpenPluginDetails).toHaveBeenCalledWith(deckPlugin);
    expect(onPickExamplePlugin).not.toHaveBeenCalled();

    // The Use button is what seeds the composer with the preset's brief.
    fireEvent.click(screen.getByTestId('home-hero-plugin-preset-use-example-deck-a'));
    expect(onPickExamplePlugin).toHaveBeenCalledWith(
      deckPlugin,
      'deck',
      'Create with a focused brief using Investor deck',
    );
  });

  it('maps powered WebGL presets to the WebGL chip without exposing a Worker chip', () => {
    const webgl = makePlugin('example-webgl-experience', 'prototype', 'WebGL Experience', [
      'webgl',
      'webgl2',
      'shader',
      'gpu',
      'powered-preview',
    ]);
    const worker = makePlugin('example-worker-visualizer', 'prototype', 'Worker Visualizer', [
      'web-worker',
      'worker',
      'sharedarraybuffer',
      'offscreencanvas',
      'powered-preview',
    ]);
    const unrelated = makePlugin('example-web-prototype', 'prototype', 'Prototype');

    expect(homeHeroExamplePluginsForChip('webgl', [webgl, unrelated, worker], 'en')).toEqual([webgl]);
    expect(findChip('worker')).toBeUndefined();
  });

  it('orders curated example presets first for the selected artifact type', () => {
    const ordinaryDeck = makePlugin('example-ordinary-deck', 'deck', 'Ordinary deck');
    const capsule = makePlugin(
      'example-html-ppt-zhangzara-capsule',
      'deck',
      'Html Ppt Zhangzara Capsule',
    );
    const creativeMode = makePlugin(
      'example-html-ppt-zhangzara-creative-mode',
      'deck',
      'Html Ppt Zhangzara Creative Mode',
    );
    renderHero({
      activeChipId: 'deck',
      pluginOptions: [ordinaryDeck, capsule, creativeMode],
    });

    const presets = screen.getAllByTestId('home-hero-plugin-preset');
    expect(presets.map((preset) => preset.getAttribute('data-plugin-id'))).toEqual([
      'example-html-ppt-zhangzara-creative-mode',
      'example-html-ppt-zhangzara-capsule',
      'example-ordinary-deck',
    ]);
  });

  it('keeps curated presets even when they rely on fallback prompt text', () => {
    const otakuDance = makePlugin(
      'image-template-infographic-otaku-dance-choreography-breakdown-gokurakujodo-16-panels',
      'image',
      'Infographic - Otaku Dance Choreography Breakdown (Gokuraku Jodo, 16 Panels)',
      ['image-template'],
      { query: null },
    );
    const ordinaryImage = makePlugin(
      'image-template-ordinary',
      'image',
      'Ordinary image',
      ['image-template'],
    );
    renderHero({
      activeChipId: 'image',
      pluginOptions: [ordinaryImage, otakuDance],
    });

    const presets = screen.getAllByTestId('home-hero-plugin-preset');
    expect(presets[0]?.getAttribute('data-plugin-id')).toBe(
      'image-template-infographic-otaku-dance-choreography-breakdown-gokurakujodo-16-panels',
    );
  });

  it('keeps Hatch Pet at the end of the image example presets', () => {
    const hatchPet = makePlugin('example-hatch-pet', 'image', 'Hatch Pet');
    const imagePoster = makePlugin('image-template-poster', 'image', 'Image Poster');
    const stoneInfographic = makePlugin('image-template-stone', 'image', 'Stone Infographic');
    renderHero({
      activeChipId: 'image',
      pluginOptions: [hatchPet, imagePoster, stoneInfographic],
    });

    const presets = screen.getAllByTestId('home-hero-plugin-preset');
    expect(presets.map((preset) => preset.textContent)).toEqual([
      expect.stringContaining('Image Poster'),
      expect.stringContaining('Stone Infographic'),
      expect.stringContaining('Hatch Pet'),
    ]);
  });

  it('moves live artifact presets out of Image and into Live artifact examples', () => {
    const imagePoster = makePlugin('image-template-poster', 'image', 'Image Poster');
    const liveDashboard = makePlugin(
      'example-live-dashboard',
      'prototype',
      'Live Dashboard',
      ['live-dashboard'],
    );
    const notionDashboard = makePlugin(
      'image-template-notion-team-dashboard-live-artifact',
      'image',
      'Notion-style Team Dashboard (Live Artifact)',
      ['live-artifact'],
    );
    const socialTracker = makePlugin(
      'example-social-media-matrix-tracker-template',
      'template',
      'Social Media Matrix Tracker Template',
      ['live-artifacts'],
    );
    const tradingDashboard = makePlugin(
      'example-trading-analysis-dashboard-template',
      'template',
      'Trading Analysis Dashboard Template',
      ['live-artifacts'],
    );
    const liveArtifact = makePlugin(
      'example-live-artifact',
      'prototype',
      'Live Artifact',
      ['live-artifact'],
    );
    renderHero({
      activeChipId: 'image',
      pluginOptions: [imagePoster, liveDashboard, notionDashboard],
    });

    let presets = screen.getAllByTestId('home-hero-plugin-preset');
    expect(presets).toHaveLength(1);
    expect(presets[0]?.textContent).toContain('Image Poster');

    cleanup();
    renderHero({
      activeChipId: 'live-artifact',
      pluginOptions: [
        imagePoster,
        liveArtifact,
        tradingDashboard,
        notionDashboard,
        socialTracker,
        liveDashboard,
      ],
    });

    presets = screen.getAllByTestId('home-hero-plugin-preset');
    // Order within a facet is now usage/sink-driven (OPEND-449); this test is
    // about which presets route into Live Artifact, so assert membership only.
    expect(presets.map((preset) => preset.getAttribute('data-plugin-id')).sort()).toEqual([
      'example-live-artifact',
      'example-live-dashboard',
      'example-social-media-matrix-tracker-template',
      'example-trading-analysis-dashboard-template',
      'image-template-notion-team-dashboard-live-artifact',
    ]);
  });

  it('disables every template while a plugin apply is in flight', () => {
    const { onPickChip } = renderHero({
      pendingPluginId: 'od-figma-migration',
      pendingChipId: 'figma',
    });
    openTemplateGrid();
    const scenarioChips = HOME_HERO_CHIPS.filter(
      (item) => item.group === 'create' && item.action.kind === 'apply-scenario',
    );
    for (const chip of scenarioChips) {
      const card = screen.getByTestId(`home-hero-rail-${chip.id}`) as HTMLButtonElement;
      expect(card.disabled).toBe(true);
    }
    fireEvent.click(screen.getByTestId(`home-hero-rail-${scenarioChips[0]!.id}`));
    expect(onPickChip).not.toHaveBeenCalled();
  });

  it('keeps the generic fallback in the free-form prompt instead of an Other chip', () => {
    renderHero();

    expect(findChip('other')).toBeUndefined();
    expect(screen.queryByTestId('home-hero-rail-other')).toBeNull();
  });

  it('migration chips carry the right action discriminator', () => {
    expect(findChip('create-plugin')?.action).toMatchObject({ kind: 'create-plugin' });
    expect(findChip('figma')?.action).toMatchObject({ kind: 'apply-figma-migration' });
    expect(findChip('folder')).toBeUndefined();
    expect(findChip('template')?.action).toMatchObject({ kind: 'open-template-picker' });
  });

  it('leads the create group with the Brand Kit chip and its own action discriminator', () => {
    const createChips = HOME_HERO_CHIPS.filter((chip) => chip.group === 'create');
    expect(createChips[0]?.id).toBe('create-brand-kit');
    expect(findChip('create-brand-kit')?.action).toMatchObject({ kind: 'create-brand-kit' });
    expect(findChip('create-brand-kit')?.icon).toBe('swatchbook');
  });

  it('media chips route to od-media-generation with the matching project kind', () => {
    expect(findChip('image')?.action).toMatchObject({
      kind: 'apply-scenario',
      pluginId: 'od-media-generation',
      projectKind: 'image',
    });
    expect(findChip('video')?.action).toMatchObject({ pluginId: 'od-media-generation', projectKind: 'video' });
    expect(findChip('audio')?.action).toMatchObject({ pluginId: 'od-media-generation', projectKind: 'audio' });
  });

  it('prototype and slide-deck chips route to their specialised bundled scenario plugin', () => {
    // Prototype now binds to web-prototype's seed template instead of
    // the generic od-new-generation router. Same for Slide deck →
    // simple-deck. See packages/contracts/src/plugins/scenario-defaults.ts
    // for the rationale (battle-tested seed + layouts + checklist).
    expect(findChip('prototype')?.action).toMatchObject({ pluginId: 'example-web-prototype', projectKind: 'prototype' });
    expect(findChip('deck')?.action).toMatchObject({ pluginId: 'example-simple-deck', projectKind: 'deck' });
  });

  it('specialised category chips route to their bundled scenario plugin', () => {
    // HyperFrames is the motion-graphics specialisation of Video,
    // surfaced as a separate chip so users can target it directly
    // instead of routing through the generic Video chip.
    expect(findChip('hyperframes')?.action).toMatchObject({
      kind: 'apply-scenario',
      pluginId: 'example-hyperframes',
      projectKind: 'video',
    });
    expect(findChip('live-artifact')?.action).toMatchObject({
      kind: 'apply-scenario',
      pluginId: 'example-live-artifact',
      projectKind: 'prototype',
      projectMetadata: {
        kind: 'prototype',
        intent: 'live-artifact',
        fidelity: 'high-fidelity',
      },
    });
  });
});
