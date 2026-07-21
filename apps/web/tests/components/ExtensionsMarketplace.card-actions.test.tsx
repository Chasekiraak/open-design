// @vitest-environment jsdom

// Acceptance regressions for the #5517 扩展 marketplace port:
//
//   #129 — plugin AND skill cards were inert markup. The port kept the row
//          chrome but dropped `is-clickable` + the click handler, so nothing in
//          扩展 opened a detail view.
//   #131 — a skill card carried `action: { kind: 'none' }`, so there was no
//          affordance anywhere in the app to actually run a skill from 扩展.
//   #132 — an import always lands in the user's own registry, which only the
//          个人的 scope lists. The catalog stayed on whatever tab it was on, so
//          a successful import looked like a no-op.
//   #109 — installs are serialized daemon-side, but only the installing card's
//          own button went disabled; every other Install button still looked
//          live and swallowed the click with zero feedback.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { ExtensionsMarketplace } from '../../src/components/PluginsView';
import { I18nProvider } from '../../src/i18n';

vi.mock('../../src/analytics/provider', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/analytics/provider')>();
  return { ...actual, useAnalytics: () => ({ track: vi.fn() }) };
});

vi.mock('../../src/collab/useWorkspaceContext', () => ({
  useWorkspaceContext: () => ({ context: null, loading: false, refresh: vi.fn() }),
  useWorkspaceBilling: () => null,
}));

const USER_SKILL = {
  id: 'deck-polish',
  name: 'deck-polish',
  description: 'Tidy up a slide deck.',
  triggers: [],
  mode: 'prototype',
  surface: 'web',
  source: 'user',
  category: null,
  examplePrompt: 'Polish this deck',
};

const OFFICIAL_SKILL = { ...USER_SKILL, id: 'brand-kit', name: 'brand-kit', source: 'builtin' };

const MARKETPLACE = {
  id: 'official',
  url: 'https://example.com/marketplace.json',
  trust: 'official',
  manifest: {
    name: 'Official',
    plugins: [
      { name: 'alpha-plugin', version: '1.0.0', description: 'First plugin' },
      { name: 'beta-plugin', version: '1.0.0', description: 'Second plugin' },
    ],
  },
};

const IMPORT_URL = 'https://example.com/imported-plugin';

let skills: Array<typeof USER_SKILL>;
let installResolvers: Array<() => void>;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** installPluginSource consumes an SSE stream, not a JSON body. */
function installSuccessStream(id: string): Response {
  const plugin = { id, title: id, version: '1.0.0', sourceKind: 'local', source: IMPORT_URL };
  const payload = `event: success\ndata: ${JSON.stringify({ kind: 'success', plugin })}\n\n`;
  return new Response(payload, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

beforeEach(() => {
  skills = [USER_SKILL, OFFICIAL_SKILL];
  installResolvers = [];
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.startsWith('/api/skills/import')) {
      const body = JSON.parse(String(init?.body ?? '{}')) as { name?: string };
      const imported = { ...USER_SKILL, id: body.name ?? 'imported', name: body.name ?? 'imported' };
      skills = [...skills, imported];
      return jsonResponse({ skill: imported });
    }
    if (url === '/api/skills') return jsonResponse({ skills });
    if (url.startsWith('/api/skills/')) {
      const id = decodeURIComponent(url.slice('/api/skills/'.length));
      const skill = skills.find((row) => row.id === id);
      return skill ? jsonResponse({ ...skill, body: '# body' }) : jsonResponse({}, 404);
    }
    if (url.startsWith('/api/plugins/install')) {
      const body = JSON.parse(String(init?.body ?? '{}')) as { source?: string };
      // The dialog's URL import completes; a card install is held open so the
      // test can observe the in-flight UI.
      if (body.source === IMPORT_URL) return installSuccessStream('imported-plugin');
      return new Promise<Response>((resolve) => {
        installResolvers.push(() => resolve(installSuccessStream('alpha-plugin')));
      });
    }
    if (url.startsWith('/api/plugins')) return jsonResponse({ plugins: [] });
    if (url.startsWith('/api/marketplaces')) return jsonResponse({ marketplaces: [MARKETPLACE] });
    if (url.includes('/api/workspace/')) return jsonResponse({ ids: [], resources: [] });
    return jsonResponse({});
  }) as typeof fetch;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function renderMarketplace(props: Partial<Parameters<typeof ExtensionsMarketplace>[0]> = {}) {
  return render(
    <I18nProvider initial="en">
      <ExtensionsMarketplace onCreatePlugin={vi.fn()} onUsePlugin={vi.fn()} {...props} />
    </I18nProvider>,
  );
}

/** Switches the catalog to 技能 / 个人的, where a user skill lives. */
async function showPersonalSkills(container: HTMLElement) {
  const modeButtons = container.querySelectorAll('.plugin-marketplace__switch button');
  fireEvent.click(modeButtons[modeButtons.length - 1]!);
  await waitFor(() => {
    const filters = container.querySelectorAll('.plugin-marketplace__filters button');
    expect(filters.length).toBeGreaterThan(0);
  });
  const filters = [...container.querySelectorAll('.plugin-marketplace__filters button')];
  const personal = filters.find((button) => /personal|mine|个人/i.test(button.textContent ?? ''));
  if (personal) fireEvent.click(personal);
}

describe('ExtensionsMarketplace card affordances', () => {
  it('#129 — marks every card backed by a record as clickable and opens its detail', async () => {
    const { container } = renderMarketplace();

    // The default landing scope is the official plugin catalog.
    await waitFor(() => {
      expect(container.querySelectorAll('.plugin-marketplace__item').length).toBeGreaterThan(0);
    });

    const cards = [...container.querySelectorAll('.plugin-marketplace__item')];
    expect(cards.length).toBeGreaterThan(0);
    for (const card of cards) {
      expect(card.classList.contains('is-clickable')).toBe(true);
      expect(card.getAttribute('role')).toBe('button');
      expect(card.getAttribute('tabindex')).toBe('0');
    }

    fireEvent.click(cards[0]!);
    await waitFor(() => {
      expect(document.querySelector('.plugin-details-modal')).toBeTruthy();
    });
  });

  it('#129 — a skill card opens the skill detail modal', async () => {
    const { container } = renderMarketplace();
    await showPersonalSkills(container);

    const card = await waitFor(() => {
      const found = container.querySelector('.plugin-marketplace__item--skill');
      expect(found).toBeTruthy();
      return found as HTMLElement;
    });
    expect(card.classList.contains('is-clickable')).toBe(true);

    fireEvent.click(card);
    await waitFor(() => {
      expect(screen.getByTestId('skill-details-modal')).toBeTruthy();
    });
  });

  it('#131 — a skill card runs the skill instead of offering nothing', async () => {
    const onUseSkill = vi.fn();
    const { container } = renderMarketplace({ onUseSkill });
    await showPersonalSkills(container);

    const useButton = await waitFor(() =>
      screen.getByTestId(`plugins-card-use-skill-${USER_SKILL.id}`),
    );
    fireEvent.click(useButton);

    expect(onUseSkill).toHaveBeenCalledTimes(1);
    expect(onUseSkill.mock.calls[0]![0]).toMatchObject({ id: USER_SKILL.id });
  });

  it('#131 — running a skill from its row does not also open the detail modal', async () => {
    const onUseSkill = vi.fn();
    const { container } = renderMarketplace({ onUseSkill });
    await showPersonalSkills(container);

    const useButton = await waitFor(() =>
      screen.getByTestId(`plugins-card-use-skill-${USER_SKILL.id}`),
    );
    fireEvent.click(useButton);

    expect(onUseSkill).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('skill-details-modal')).toBeNull();
    expect(container).toBeTruthy();
  });

  it('#109 — every other install button reads as blocked while one install runs', async () => {
    const { container } = renderMarketplace();
    await waitFor(() => {
      expect(container.querySelectorAll('.plugin-marketplace__item').length).toBe(2);
    });

    const installButtons = [
      ...container.querySelectorAll<HTMLButtonElement>('.plugin-marketplace__row-action'),
    ];
    expect(installButtons.length).toBe(2);
    expect(installButtons.every((button) => !button.disabled)).toBe(true);

    fireEvent.click(installButtons[0]!);

    await waitFor(() => {
      const buttons = [
        ...container.querySelectorAll<HTMLButtonElement>('.plugin-marketplace__row-action'),
      ];
      // Both are unclickable: the one installing, and the one that has to wait.
      expect(buttons.every((button) => button.disabled)).toBe(true);
      // …and the waiting one says why rather than looking live and doing nothing.
      const waiting = buttons[1]!;
      expect(waiting.textContent).toBeTruthy();
      expect(waiting.getAttribute('title')).toBeTruthy();
    });

    installResolvers.forEach((resolve) => resolve());
  });
});

describe('ExtensionsMarketplace import', () => {
  it('#132 — a successful import lands the catalog on the tab that holds the result', async () => {
    const { container } = renderMarketplace();
    await waitFor(() => {
      expect(container.querySelectorAll('.plugin-marketplace__item').length).toBeGreaterThan(0);
    });

    // Everything the dialog creates is a personal resource, but the catalog
    // lands on the official scope — so before the fix an import left the user
    // staring at a list the new resource is not part of.
    const personalTab = screen.getByTestId('plugins-tab-installed');
    expect(personalTab.classList.contains('is-active')).toBe(false);

    fireEvent.click(container.querySelector('.plugin-marketplace__create')!);
    const urlInput = await waitFor(() =>
      container.querySelector<HTMLInputElement>(
        'input[placeholder="https://example.com/open-design-suite"]',
      )!,
    );
    fireEvent.change(urlInput, { target: { value: IMPORT_URL } });
    fireEvent.click(screen.getByText('Import and upload'));

    await waitFor(() => {
      // Dialog closed and the catalog followed the resource to 个人的.
      expect(container.querySelector('.plugin-marketplace__create-panel')).toBeNull();
      expect(
        screen.getByTestId('plugins-tab-installed').classList.contains('is-active'),
      ).toBe(true);
    });
  });
});
