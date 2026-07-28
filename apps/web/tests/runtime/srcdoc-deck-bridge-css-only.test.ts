// @vitest-environment node

import { describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { buildSrcdoc } from '../../src/runtime/srcdoc';

function extractDeckBridgeScript(srcdoc: string): string {
  const match = srcdoc.match(/<script data-od-deck-bridge>([\s\S]*?)<\/script>/);
  if (!match?.[1]) throw new Error('deck bridge script not found in srcdoc');
  return match[1];
}

function installQueuedTimers(win: object) {
  const callbacks: Array<() => void> = [];
  Object.defineProperty(win, 'setTimeout', {
    configurable: true,
    value: vi.fn((callback: () => void) => {
      if (typeof callback === 'function') callbacks.push(callback);
      return callbacks.length;
    }),
  });
  Object.defineProperty(win, 'clearTimeout', {
    configurable: true,
    value: vi.fn(),
  });
  return function flushTimers() {
    for (let i = 0; i < 100 && callbacks.length; i += 1) callbacks.shift()?.();
  };
}

function lastSlideState(parentPostMessage: ReturnType<typeof vi.fn>) {
  return parentPostMessage.mock.calls
    .map((call) => call[0])
    .filter((message) => message?.type === 'od:slide-state')
    .at(-1);
}

describe('deck bridge - CSS-only decks', () => {
  it('navigates decks whose only visibility rule is .slide:first-child', () => {
    const bodyHtml = `
      <style>
        .stage { width: 1920px; height: 1080px; position: relative; }
        .slide { display: none; }
        .slide:first-child { display: flex; }
      </style>
      <main class="stage">
        <section class="slide">One</section>
        <section class="slide">Two</section>
        <section class="slide">Three</section>
      </main>
    `;
    const script = extractDeckBridgeScript(buildSrcdoc(
      `<!doctype html><html><body>${bodyHtml}</body></html>`,
      { deck: true },
    ));
    const dom = new JSDOM(`<!doctype html><html><body>${bodyHtml}</body></html>`, {
      runScripts: 'outside-only',
      pretendToBeVisual: true,
    });
    const win = dom.window;
    const parentPostMessage = vi.fn();
    Object.defineProperty(win, 'parent', {
      configurable: true,
      value: { postMessage: parentPostMessage },
    });
    const flushTimers = installQueuedTimers(win);

    new win.Function(script).call(win);
    flushTimers();

    win.dispatchEvent(new win.MessageEvent('message', {
      data: { type: 'od:slide', action: 'next' },
    }));
    flushTimers();

    const slides = Array.from(win.document.querySelectorAll<HTMLElement>('.slide'));
    expect(slides.map((slide) => win.getComputedStyle(slide).display)).toEqual([
      'none',
      'flex',
      'none',
    ]);
    expect(lastSlideState(parentPostMessage)).toMatchObject({ active: 1, count: 3 });

    win.dispatchEvent(new win.MessageEvent('message', {
      data: { type: 'od:slide', action: 'go', index: 2 },
    }));
    flushTimers();

    expect(slides.map((slide) => win.getComputedStyle(slide).display)).toEqual([
      'none',
      'none',
      'flex',
    ]);
    expect(lastSlideState(parentPostMessage)).toMatchObject({ active: 2, count: 3 });
    win.close();
  });

  it('fits a fixed slide canvas inside a smaller iframe viewport', () => {
    const bodyHtml = `
      <style>
        .stage { width: 1920px; height: 1080px; position: relative; }
        .slide { position: absolute; inset: 0; }
        .slide:not(:first-child) { display: none; }
      </style>
      <main class="stage">
        <section class="slide">One</section>
        <section class="slide">Two</section>
      </main>
    `;
    const script = extractDeckBridgeScript(buildSrcdoc(
      `<!doctype html><html><body>${bodyHtml}</body></html>`,
      { deck: true },
    ));
    const dom = new JSDOM(`<!doctype html><html><body>${bodyHtml}</body></html>`, {
      runScripts: 'outside-only',
      pretendToBeVisual: true,
    });
    const win = dom.window;
    Object.defineProperty(win, 'parent', {
      configurable: true,
      value: { postMessage: vi.fn() },
    });
    Object.defineProperty(win, 'innerWidth', {
      configurable: true,
      value: 1518,
    });
    Object.defineProperty(win, 'innerHeight', {
      configurable: true,
      value: 870,
    });
    const stage = win.document.querySelector<HTMLElement>('.stage');
    if (!stage) throw new Error('stage not found');
    Object.defineProperty(stage, 'offsetWidth', {
      configurable: true,
      value: 1920,
    });
    Object.defineProperty(stage, 'offsetHeight', {
      configurable: true,
      value: 1080,
    });
    const flushTimers = installQueuedTimers(win);

    new win.Function(script).call(win);
    win.dispatchEvent(new win.Event('load'));
    flushTimers();

    expect(stage.dataset.odDeckAutoFit).toBe('true');
    expect(stage.style.transformOrigin).toBe('top left');
    expect(stage.style.transform).toContain('scale(0.790625)');
    expect(stage.style.transform).toContain('translate(0px, 8.0625px)');
    win.close();
  });

  it('does not add fallback fitting to framework decks with their own fit runtime', () => {
    const bodyHtml = `
      <div class="deck-shell">
        <div class="deck-stage" id="deck-stage">
          <section class="slide active">One</section>
          <section class="slide">Two</section>
        </div>
      </div>
    `;
    const script = extractDeckBridgeScript(buildSrcdoc(
      `<!doctype html><html><body>${bodyHtml}</body></html>`,
      { deck: true },
    ));
    const dom = new JSDOM(`<!doctype html><html><body>${bodyHtml}</body></html>`, {
      runScripts: 'outside-only',
      pretendToBeVisual: true,
    });
    const win = dom.window;
    Object.defineProperty(win, 'parent', {
      configurable: true,
      value: { postMessage: vi.fn() },
    });
    Object.defineProperty(win, 'innerWidth', {
      configurable: true,
      value: 1518,
    });
    Object.defineProperty(win, 'innerHeight', {
      configurable: true,
      value: 870,
    });
    const stage = win.document.getElementById('deck-stage') as HTMLElement;
    Object.defineProperty(stage, 'offsetWidth', {
      configurable: true,
      value: 1920,
    });
    Object.defineProperty(stage, 'offsetHeight', {
      configurable: true,
      value: 1080,
    });
    const flushTimers = installQueuedTimers(win);

    new win.Function(script).call(win);
    win.dispatchEvent(new win.Event('load'));
    flushTimers();

    expect(stage.dataset.odDeckAutoFit).toBeUndefined();
    expect(stage.style.transform).toBe('');
    win.close();
  });
});
