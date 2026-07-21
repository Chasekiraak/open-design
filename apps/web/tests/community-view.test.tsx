// @vitest-environment jsdom
//
// Community is the plugin catalogue rendered as a template gallery. Its cards,
// facet badges, thumbnails, and composer seeds must all resolve from the one
// live source — GET /api/plugins — so the page can never drift back to a
// hand-written demo array that shows 24 templates while the daemon serves ~300.

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CommunityView } from '../src/components/CommunityView';

type PluginFixture = {
  id: string;
  title: string;
  manifest: Record<string, unknown>;
};

function plugin(fixture: PluginFixture) {
  return {
    id: fixture.id,
    title: fixture.title,
    version: '1.0.0',
    trust: 'bundled' as const,
    sourceKind: 'bundled' as const,
    source: `/plugins/_official/${fixture.id}`,
    manifest: { name: fixture.id, title: fixture.title, ...fixture.manifest },
  };
}

const PITCH_DECK = plugin({
  id: 'example-fundraising-deck',
  title: 'Seed Round Pitch',
  manifest: {
    description: 'A decision-grade seed round narrative.',
    tags: ['deck'],
    od: {
      mode: 'deck',
      category: 'fundraising-pitch',
      preview: { type: 'html', entry: './example.html' },
      bakedPreview: { poster: 'https://assets.test/fundraising/poster.jpg', video: 'https://assets.test/fundraising/preview.mp4' },
    },
  },
});

const SALES_DECK = plugin({
  id: 'example-b2b-deck',
  title: 'Enterprise Sales Deck',
  manifest: {
    description: 'A B2B sales narrative built for procurement.',
    tags: ['deck'],
    od: { mode: 'deck', category: 'b2b-sales', preview: { type: 'html', entry: './example.html' } },
  },
});

const LANDING_PROTOTYPE = plugin({
  id: 'example-landing-prototype',
  title: 'SaaS Landing Page',
  manifest: {
    description: 'A conversion-focused SaaS landing page.',
    tags: ['landing'],
    od: { mode: 'prototype', preview: { type: 'html', entry: './example.html' } },
  },
});

const IMAGE_TEMPLATE = plugin({
  id: 'image-template-poster',
  title: 'Typographic Poster',
  manifest: {
    description: 'A typography-led key art poster.',
    tags: ['poster'],
    od: { mode: 'image', preview: { type: 'image', poster: 'https://assets.test/poster.jpg' } },
  },
});

// Neither of these belongs in the gallery: hidden plugins are filtered by
// listPlugins(), and design-system plugins resolve to no artifact category.
const HIDDEN_PLUGIN = plugin({
  id: 'hidden-utility',
  title: 'Hidden Utility',
  manifest: { od: { mode: 'deck', hidden: true } },
});

const DESIGN_SYSTEM_PLUGIN = plugin({
  id: 'design-system-airbnb',
  title: 'Airbnb',
  manifest: { od: { mode: 'design-system' } },
});

const CATALOGUE = [PITCH_DECK, SALES_DECK, LANDING_PROTOTYPE, IMAGE_TEMPLATE, HIDDEN_PLUGIN, DESIGN_SYSTEM_PLUGIN];

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(async (url: unknown) => {
    if (url === '/api/plugins') {
      return new Response(JSON.stringify({ plugins: CATALOGUE }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    throw new Error(`unexpected fetch ${String(url)}`);
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
});

/** Read every type tab as { label, badge } plus the cards currently gridded. */
function readFacets() {
  const tabs = Array.from(
    document.querySelectorAll('.community-template-view__type-tabs button'),
  ) as HTMLButtonElement[];
  return tabs.map((tab) => ({
    tab,
    label: tab.querySelector('span')?.textContent?.trim() ?? '',
    badge: Number(tab.querySelector('small')?.textContent?.trim()),
  }));
}

function renderedCards() {
  return Array.from(
    document.querySelectorAll('.community-template-grid .community-template-card'),
  ) as HTMLElement[];
}

async function renderCommunity(props: Parameters<typeof CommunityView>[0] = {}) {
  render(<CommunityView {...props} />);
  await waitFor(() => expect(readFacets().length).toBeGreaterThan(0));
}

describe('CommunityView catalogue source', () => {
  it('builds the grid from GET /api/plugins', async () => {
    await renderCommunity();

    expect(fetchMock).toHaveBeenCalledWith('/api/plugins');

    // Slides leads, and it carries exactly the two deck plugins the daemon
    // served — not a bundled demo array.
    const facets = readFacets();
    expect(facets.map((facet) => facet.label)).toEqual(['Slides', 'Prototype', 'Image']);
    expect(facets.map((facet) => facet.badge)).toEqual([2, 1, 1]);

    // The card footer reads "<type> · <sub-facet>", both resolved from the
    // shared plugins-home taxonomy.
    expect(renderedCards().map((card) => card.querySelector('.community-template-card__foot span')?.textContent))
      .toEqual(['Slides · Fundraising pitch', 'Slides · B2B sales']);
  });

  it('leaves hidden and design-system plugins out of the gallery', async () => {
    await renderCommunity();

    // Neither plugin has a home in the artifact taxonomy, so no tab may count
    // them and no tab may render them.
    const total = readFacets().reduce((sum, facet) => sum + facet.badge, 0);
    expect(total).toBe(4);
    expect(screen.queryByText(/Airbnb/)).toBeNull();
    expect(screen.queryByText(/Hidden Utility/)).toBeNull();
  });

  it('renders the sub-facet pills the selected type actually has plugins for', async () => {
    await renderCommunity();

    const pills = Array.from(
      document.querySelectorAll('.community-template-view__subtabs button'),
    ).map((button) => button.textContent?.trim());
    expect(pills).toEqual(['All', 'Fundraising pitch', 'B2B sales']);

    fireEvent.click(screen.getByRole('button', { name: 'B2B sales' }));
    expect(renderedCards()).toHaveLength(1);
  });
});

describe('CommunityView previews', () => {
  it('shows the plugin\'s own poster on the card and its live page in the modal', async () => {
    await renderCommunity();

    // Card thumbnail: the daemon-baked poster for that plugin.
    const thumb = renderedCards()[0]!.querySelector('img.community-template-thumb__image');
    expect(thumb?.getAttribute('src')).toBe('https://assets.test/fundraising/poster.jpg');

    // Detail modal: the plugin's real preview endpoint, not a synthesized page.
    fireEvent.click(renderedCards()[0]!);
    const frame = document.querySelector('iframe.community-template-preview__frame');
    expect(frame?.getAttribute('src')).toBe('/api/plugins/example-fundraising-deck/preview');
    expect(frame?.getAttribute('srcdoc')).toBeNull();
  });

  it('carries a media template\'s poster into the modal frame', async () => {
    await renderCommunity();

    fireEvent.click(readFacets().find((facet) => facet.label === 'Image')!.tab);
    fireEvent.click(renderedCards()[0]!);

    const frame = document.querySelector('iframe.community-template-preview__frame');
    expect(frame?.getAttribute('src')).toBeNull();
    expect(frame?.getAttribute('srcdoc')).toContain('https://assets.test/poster.jpg');
  });
});

describe('CommunityView remix', () => {
  it('threads the real plugin id + its curated seed prompt into onRemixTemplate', async () => {
    // The primary "Remix" CTA must not drop the selected template, and it must
    // hand over the plugin's own curated seed rather than a synthesized
    // "Remix the ... community template" sentence.
    const onRemix = vi.fn();
    await renderCommunity({ onRemixTemplate: onRemix });

    const remixButtons = screen.getAllByRole('button', { name: 'Remix' });
    expect(remixButtons.length).toBeGreaterThan(0);
    fireEvent.click(remixButtons[0]!);

    expect(onRemix).toHaveBeenCalledTimes(1);
    expect(onRemix.mock.calls[0]![0]).toEqual({
      templateId: 'example-fundraising-deck',
      prompt: 'A decision-grade seed round narrative.',
    });
  });
});

describe('CommunityView facet counts', () => {
  it('shows a badge equal to the number of cards each type actually renders', async () => {
    // Regression: the badges were a hand-written lookup table unrelated to the
    // catalogue, so Slides advertised 80 while rendering 2 cards, and Live
    // Artifact advertised 5 while rendering 8. The badge must be derived from
    // the same array the grid maps over.
    await renderCommunity();

    const facets = readFacets();
    expect(facets.length).toBeGreaterThan(0);

    for (const { tab, label, badge } of facets) {
      fireEvent.click(tab);
      expect(
        { type: label, badge, rendered: renderedCards().length },
      ).toEqual({ type: label, badge, rendered: badge });
    }
  });

  it('never advertises a facet total larger than the whole catalogue', async () => {
    // The old table summed to 269 across 24 templates; the badges must sum to
    // the catalogue size instead.
    await renderCommunity();

    const facets = readFacets();
    const badgeTotal = facets.reduce((sum, facet) => sum + facet.badge, 0);

    // Walk every tab to collect the true catalogue size from the grid itself.
    let renderedTotal = 0;
    for (const { tab } of facets) {
      fireEvent.click(tab);
      renderedTotal += renderedCards().length;
    }

    expect(badgeTotal).toBe(renderedTotal);
  });
});
