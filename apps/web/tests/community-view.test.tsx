// @vitest-environment jsdom

// Community view — data-source contract.
//
// Regression this file guards: Community used to render a hardcoded 24-entry
// demo array, so the team build showed 24 cards where the released client
// showed the whole bundled catalogue (hundreds). Community must read the real
// catalogue from `GET /api/plugins`, and every count it advertises must be
// derived from those fetched records — never from a maintained table.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { InstalledPluginRecord } from '@open-design/contracts';
import { CommunityView } from '../src/components/CommunityView';
import { I18nProvider } from '../src/i18n';

afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
});

function makePlugin(
  id: string,
  mode: string,
  overrides: { description?: string } = {},
): InstalledPluginRecord {
  return {
    id,
    title: id,
    version: '0.1.0',
    sourceKind: 'bundled',
    source: `/tmp/${id}`,
    trust: 'bundled',
    capabilitiesGranted: ['prompt:inject'],
    fsPath: `/tmp/${id}`,
    installedAt: 0,
    updatedAt: 0,
    manifest: {
      name: id,
      title: id,
      version: '0.1.0',
      ...(overrides.description ? { description: overrides.description } : {}),
      od: { kind: 'scenario', taskKind: 'new-generation', mode },
    },
  };
}

/** Stub `GET /api/plugins` with the given catalogue. */
function stubCatalogue(plugins: InstalledPluginRecord[]): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/plugins')) {
        return {
          ok: true,
          json: async () => ({ plugins }),
        } as unknown as Response;
      }
      return { ok: false, json: async () => ({}) } as unknown as Response;
    }),
  );
}

function renderCommunity(props: Partial<Parameters<typeof CommunityView>[0]> = {}) {
  return render(
    <I18nProvider initial="en">
      <CommunityView {...props} />
    </I18nProvider>,
  );
}

function renderedCardIds(): string[] {
  return Array.from(
    document.querySelectorAll('.plugins-home__grid [data-plugin-id]'),
  ).map((node) => node.getAttribute('data-plugin-id') ?? '');
}

describe('CommunityView data source', () => {
  it('renders the catalogue served by /api/plugins, not a bundled demo list', async () => {
    stubCatalogue([
      makePlugin('deck-alpha', 'deck'),
      makePlugin('deck-beta', 'deck'),
      makePlugin('proto-gamma', 'prototype'),
    ]);

    renderCommunity();

    // The grid shows the fetched records by their real ids.
    await waitFor(() => {
      expect(renderedCardIds()).toEqual(['deck-alpha', 'deck-beta']);
    });
    expect(screen.getByTestId('plugins-home-section')).toBeTruthy();
    // Nothing from the old demo array survives.
    expect(screen.queryByText('Kanban Board')).toBeNull();
    expect(screen.queryByText('Open Design Landing')).toBeNull();
  });

  it('grows with the catalogue instead of capping at a fixed size', async () => {
    // Same view, a bigger payload: the card count must follow the data. A
    // hardcoded catalogue would render the same number for both payloads.
    const many = Array.from({ length: 21 }, (_unused, i) =>
      makePlugin(`deck-${i}`, 'deck'),
    );
    stubCatalogue(many);

    renderCommunity();

    await waitFor(() => {
      expect(renderedCardIds().length).toBe(many.length);
    });
  });

  it('derives every category badge from the fetched records', async () => {
    // The badge on each pill must equal the number of cards that pill renders,
    // so a facet can never advertise a number the grid cannot produce.
    stubCatalogue([
      makePlugin('deck-alpha', 'deck'),
      makePlugin('deck-beta', 'deck'),
      makePlugin('proto-gamma', 'prototype'),
      makePlugin('image-delta', 'image'),
    ]);

    renderCommunity();

    await waitFor(() => {
      expect(renderedCardIds().length).toBeGreaterThan(0);
    });

    const pills = Array.from(
      document.querySelectorAll('[data-testid^="plugins-home-pill-category-"]'),
    ) as HTMLButtonElement[];
    expect(pills.length).toBeGreaterThan(0);

    let badgeTotal = 0;
    let renderedTotal = 0;
    for (const pill of pills) {
      const badge = Number(
        pill.querySelector('.plugins-home__pill-count')?.textContent?.trim(),
      );
      if (badge === 0) continue; // Empty buckets stay visible but render no cards.
      fireEvent.click(pill);
      await waitFor(() => {
        expect(renderedCardIds().length).toBe(badge);
      });
      badgeTotal += badge;
      renderedTotal += renderedCardIds().length;
    }

    // And the badges sum to the catalogue, not to some larger invented total.
    expect(badgeTotal).toBe(renderedTotal);
    expect(badgeTotal).toBe(4);
  });
});

describe('CommunityView remix', () => {
  it('threads the real plugin id + its curated seed prompt into onRemixTemplate', async () => {
    const onRemix = vi.fn();
    stubCatalogue([
      makePlugin('deck-alpha', 'deck', { description: 'A decision-grade launch deck.' }),
    ]);

    renderCommunity({ onRemixTemplate: onRemix });

    const useButton = await screen.findByTestId('plugins-home-use-deck-alpha');
    fireEvent.click(useButton);

    expect(onRemix).toHaveBeenCalledTimes(1);
    const arg = onRemix.mock.calls[0]![0] as { templateId: string; prompt: string };
    // The id is the catalogue record's id, not a synthetic demo slug.
    expect(arg.templateId).toBe('deck-alpha');
    // The seed comes from the plugin's own curated copy, not a template string
    // synthesized from card metadata.
    expect(arg.prompt).toBe('A decision-grade launch deck.');
  });
});
