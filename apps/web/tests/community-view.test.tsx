// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CommunityView } from '../src/components/CommunityView';

afterEach(cleanup);

describe('CommunityView remix', () => {
  it('threads the chosen template id + a starting prompt into onRemixTemplate', () => {
    // The primary "Remix" CTA must not drop the selected template: it hands the
    // template id AND a Home-composer starting prompt to the caller, which seeds
    // Home instead of navigating to a generic page.
    const onRemix = vi.fn();
    render(<CommunityView onRemixTemplate={onRemix} />);

    // The default view (Slides) shows non-prompt cards whose action reads "Remix".
    const remixButtons = screen.getAllByRole('button', { name: 'Remix' });
    expect(remixButtons.length).toBeGreaterThan(0);
    fireEvent.click(remixButtons[0]!);

    expect(onRemix).toHaveBeenCalledTimes(1);
    const arg = onRemix.mock.calls[0]![0] as { templateId: string; prompt: string };
    expect(typeof arg.templateId).toBe('string');
    expect(arg.templateId.length).toBeGreaterThan(0);
    // The prompt is template-specific, not a generic fallback.
    expect(arg.prompt).toMatch(/^Remix the ".+" community template into a new Open Design project/);
  });
});

describe('CommunityView facet counts', () => {
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

  function renderedCardCount() {
    return document.querySelectorAll(
      '.community-template-grid .community-template-card',
    ).length;
  }

  it('shows a badge equal to the number of cards each type actually renders', () => {
    // Regression: the badges were a hand-written lookup table unrelated to the
    // catalogue, so Slides advertised 80 while rendering 2 cards, and Live
    // Artifact advertised 5 while rendering 8. The badge must be derived from
    // the same array the grid maps over.
    render(<CommunityView />);

    const facets = readFacets();
    expect(facets.length).toBeGreaterThan(0);

    for (const { tab, label, badge } of facets) {
      fireEvent.click(tab);
      expect(
        { type: label, badge, rendered: renderedCardCount() },
      ).toEqual({ type: label, badge, rendered: badge });
    }
  });

  it('never advertises a facet total larger than the whole catalogue', () => {
    // The old table summed to 269 across 24 templates; the badges must sum to
    // the catalogue size instead.
    render(<CommunityView />);

    const facets = readFacets();
    const badgeTotal = facets.reduce((sum, facet) => sum + facet.badge, 0);

    // Walk every tab to collect the true catalogue size from the grid itself.
    let renderedTotal = 0;
    for (const { tab } of facets) {
      fireEvent.click(tab);
      renderedTotal += renderedCardCount();
    }

    expect(badgeTotal).toBe(renderedTotal);
  });
});
