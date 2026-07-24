// @vitest-environment jsdom
//
// Scenario-card rail coverage.
//   - The default create rail renders illustrated scenario cards carrying a
//     title AND a one-line description.
//   - The rail keeps Website clone source-first, then offers Landing page for
//     zero-to-one product and campaign pages.
//   - The finer-grained scenarios (wireframe / mobile / document) exist and
//     route to a working scenario plugin.

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const placeholderCarouselMock = vi.hoisted(() => ({
  reportScenario: false,
  reportedScenarioId: null as string | null,
}));

vi.mock('../../src/components/home-hero/PlaceholderCarousel', () => ({
  PlaceholderCarousel: ({
    scenarios,
    active,
    onScenarioChange,
  }: {
    scenarios: Array<{ id: string; chipId?: string | null; text: string }>;
    active: boolean;
    onScenarioChange: (scenario: { id: string; chipId?: string | null; text: string }) => void;
  }) => {
    const scenario = scenarios[0];
    if (
      placeholderCarouselMock.reportScenario &&
      active &&
      scenario &&
      placeholderCarouselMock.reportedScenarioId !== scenario.id
    ) {
      placeholderCarouselMock.reportedScenarioId = scenario.id;
      queueMicrotask(() => onScenarioChange(scenario));
    }
    return null;
  },
}));

import { HomeHero } from '../../src/components/HomeHero';
import { findChip, orderedCreateChips } from '../../src/components/home-hero/chips';

afterEach(() => {
  placeholderCarouselMock.reportScenario = false;
  placeholderCarouselMock.reportedScenarioId = null;
  cleanup();
  window.localStorage.removeItem('open-design:home-template-recommendation:v1');
});

function renderHero(overrides: Partial<React.ComponentProps<typeof HomeHero>> = {}) {
  const props = {
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
    onPickPlugin: () => undefined,
    onPickChip: () => undefined,
    contextItemCount: 0,
    error: null,
    ...overrides,
  } as React.ComponentProps<typeof HomeHero>;
  render(<HomeHero {...props} />);
}

describe('HomeHero scenario cards', () => {
  it('labels each create scenario in the readable template catalog', () => {
    renderHero();
    expect(screen.getByTestId('home-hero-rail-prototype').textContent).toContain('UI Mockup');
    expect(screen.getByTestId('home-hero-rail-deck').textContent).toContain('Slide deck');
  });

  it('overlays the primary recommendation badge instead of placing it in card copy', () => {
    renderHero({ onboardingRole: 'designer' });

    const card = screen.getByTestId('home-hero-rail-prototype');
    const badge = card.querySelector('.home-hero__recommendation-badge');
    expect(badge?.textContent).toBe('For you');
    expect(badge?.parentElement).toBe(card);
    expect(card.querySelector('.home-hero__scenario-card-body .home-hero__recommendation-badge')).toBeNull();
  });

  it('keeps Website clone source-first, followed by Landing page creation', () => {
    const ordered = orderedCreateChips();
    expect(ordered[0]?.id).toBe('web-clone');
    expect(ordered[1]?.id).toBe('landing-page');
  });

  it('adds the finer-grained scenarios as templates routed to a scenario plugin', () => {
    renderHero();
    for (const id of ['wireframe', 'mobile', 'document']) {
      expect(screen.getByTestId(`home-hero-rail-${id}`)).toBeTruthy();
      expect(findChip(id)?.action.kind).toBe('apply-scenario');
    }
    // Wireframe reuses the web-prototype seed at lo-fi fidelity.
    expect(findChip('wireframe')?.action).toMatchObject({
      pluginId: 'example-web-prototype',
      projectKind: 'prototype',
      projectMetadata: { kind: 'prototype', fidelity: 'wireframe' },
    });
    expect(findChip('document')?.action).toMatchObject({
      pluginId: 'od-new-generation',
      projectKind: 'other',
    });
  });

  it('keeps the input carousel active while the Hero cycle is active', async () => {
    placeholderCarouselMock.reportScenario = true;
    const onSubmit = vi.fn();
    const onSubmitScenario = vi.fn();
    renderHero({
      pluginsLoading: true,
      onSubmit,
      onSubmitScenario,
    });

    await waitFor(() => expect(placeholderCarouselMock.reportedScenarioId).not.toBeNull());
    const submit = screen.getByTestId('home-hero-submit') as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.click(submit);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(onSubmitScenario).not.toHaveBeenCalled();
  });

  it('submits the visible carousel example while the Hero cycle is active', async () => {
    placeholderCarouselMock.reportScenario = true;
    const onSubmitScenario = vi.fn();
    renderHero({ onSubmitScenario });

    await waitFor(() => expect(placeholderCarouselMock.reportedScenarioId).not.toBeNull());
    fireEvent.click(screen.getByTestId('home-hero-submit'));
    expect(onSubmitScenario).toHaveBeenCalledWith(expect.objectContaining({
      id: placeholderCarouselMock.reportedScenarioId,
    }));
  });
});
