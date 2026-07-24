// @vitest-environment jsdom
//
// Web-clone example-card analytics (埋点文档 row 116, element=example_prompt).
// The source-first Website-clone examples are plain fill-only prompt cards. A
// click must still fire a home chat_composer ui_click with chip_id=web-clone,
// complementing the created project's project_kind=web_clone result.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { HomeView } from '../../src/components/HomeView';
import { I18nProvider } from '../../src/i18n';
import { writeHomeGuideStage } from '../../src/components/home-hero/firstRunGuide';

const analyticsMocks = vi.hoisted(() => ({ track: vi.fn() }));

// `send()` forwards a trailing request-id arg, so match on (event, props) and
// ignore any extra positional args rather than asserting exact arity.
function lastClickProps(element: string): Record<string, unknown> | undefined {
  const call = [...analyticsMocks.track.mock.calls]
    .reverse()
    .find((args) => args[0] === 'ui_click' && (args[1] as { element?: string })?.element === element);
  return call?.[1] as Record<string, unknown> | undefined;
}

vi.mock('../../src/analytics/provider', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/analytics/provider')>();
  return {
    ...actual,
    useAnalytics: () => ({
      track: analyticsMocks.track,
      newRequestId: () => 'request-1',
      setConfigureGlobals: vi.fn(),
      setConsent: vi.fn(),
      setIdentity: vi.fn(),
    }),
  };
});

// The Website-clone chip's base scenario (its action.pluginId). It only needs to
// exist so clicking the chip binds; the site examples themselves are static text
// prompt cards from HOME_PROMPT_EXAMPLES, not plugins.
const WEB_CLONE_BASE = {
  id: 'example-web-clone',
  title: 'Website clone',
  version: '0.1.0',
  trust: 'bundled' as const,
  sourceKind: 'bundled' as const,
  source: '/tmp/web-clone',
  capabilitiesGranted: ['prompt:inject'],
  fsPath: '/tmp/web-clone',
  installedAt: 0,
  updatedAt: 0,
  manifest: {
    name: 'example-web-clone',
    title: 'Website clone',
    version: '0.1.0',
    description: 'Recreate an existing website.',
    tags: ['web-clone', 'website-clone'],
    od: {
      kind: 'scenario',
      taskKind: 'new-generation',
      useCase: { query: 'Recreate the website at {{targetUrl}}.' },
    },
  },
};

function stubPlugins() {
  vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL) => {
    const href = typeof url === 'string' ? url : url.toString();
    if (href === '/api/plugins') {
      return new Response(JSON.stringify({ plugins: [WEB_CLONE_BASE] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({}), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }));
}

function renderHome() {
  return render(
    <I18nProvider initial="en">
      <HomeView
        projects={[]}
        onSubmit={() => undefined}
        onOpenProject={() => undefined}
        onViewAllProjects={() => undefined}
      />
    </I18nProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  analyticsMocks.track.mockClear();
  cleanup();
  window.localStorage.clear();
});

// #5517 removed the inline template rail from Home; scenario templates are
// picked from the composer footer's radial Template picker instead.
async function pickHomeTemplate(id: string) {
  const trigger = await screen.findByTestId('home-hero-template-trigger');
  await waitFor(() => expect((trigger as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(trigger);
  fireEvent.click(await screen.findByTestId(`home-hero-template-wedge-${id}`));
}

describe('web-clone example-card tracking', () => {
  it('renders the Website-clone examples as fill-only text prompt cards', async () => {
    writeHomeGuideStage('done');
    stubPlugins();
    renderHome();

    await pickHomeTemplate('web-clone');
    const textCards = await screen.findAllByTestId('home-hero-prompt-example');
    expect(textCards).toHaveLength(3);
    expect(screen.queryByTestId('home-hero-plugin-presets')).toBeNull();
    expect(document.querySelector('[data-testid^="home-hero-plugin-preset-duplicate"]')).toBeNull();
    expect(textCards.map((card) => card.textContent)).toEqual([
      'Recreate this website’s page structure and visual style.',
      'Use this website as visual reference and create a new page for my product.',
      'Recreate the page modules from the uploaded screenshot.',
    ]);
    expect(document.querySelector('.home-hero__prompt-example--site')).toBeNull();
  });

  it('shows the remaining Website-clone ideas behind More examples', async () => {
    writeHomeGuideStage('done');
    stubPlugins();
    renderHome();

    await pickHomeTemplate('web-clone');
    const moreExamples = screen.getByText('More examples');
    expect(moreExamples.closest('details')?.textContent).toContain(
      'Turn this existing site into a responsive reference implementation.',
    );
  });

  it('fires element=example_prompt with chip_id=web-clone when a text example is picked', async () => {
    writeHomeGuideStage('done');
    stubPlugins();
    renderHome();

    await pickHomeTemplate('web-clone');
    const textCards = await screen.findAllByTestId('home-hero-prompt-example');
    analyticsMocks.track.mockClear(); // ignore the chip-pick ui_click; assert the card event
    fireEvent.click(textCards[0]!);

    await waitFor(() => {
      expect(lastClickProps('example_prompt')).toMatchObject({
        page_name: 'home',
        area: 'chat_composer',
        element: 'example_prompt',
        chip_id: 'web-clone',
      });
    });
  });
});
