// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ComponentProps } from 'react';
import { emptyManualEditStyles, type ManualEditTarget } from '../../src/edit-mode/types';
import type { ProjectFile } from '../../src/types';

const panelState = vi.hoisted(() => ({
  props: null as ComponentProps<typeof import('../../src/components/ManualEditPanel').ManualEditPanel> | null,
}));

vi.mock('../../src/components/ManualEditPanel', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/components/ManualEditPanel')>();
  return {
    ...actual,
    ManualEditPanel: (props: ComponentProps<typeof actual.ManualEditPanel>) => {
      panelState.props = props;
      return <div data-testid="mock-manual-edit-panel" />;
    },
  };
});

import { FileViewer } from '../../src/components/FileViewer';

function openManualTools() {
  // Manual tools now live directly in the primary toolbar.
}

function clickManualTool(testId: string) {
  openManualTools();
  fireEvent.click(screen.getByTestId(testId));
}

function clickAgentTool(testId: string) {
  fireEvent.click(screen.getByTestId(testId));
}

// Pins the inspector to a target. Selection rides the explicit click path
// (od-edit-select); since v2.1 the inspector panel is opt-in, so the helper
// mirrors the real two-step flow — select, then open the panel through the
// action bar's params button.
async function selectManualEditTarget(target = heroTarget()) {
  const frame = await waitFor(() => {
    const node = screen.getByTestId('artifact-preview-frame') as HTMLIFrameElement;
    if (!node.contentWindow) throw new Error('Preview frame not ready');
    return node;
  });
  act(() => {
    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'od-edit-select', target },
      source: frame.contentWindow,
    }));
  });
  await waitFor(() => {
    fireEvent.click(screen.getByTestId('manual-edit-open-inspector'));
  });
  await waitFor(() => expect(panelState.props).not.toBeNull());
}

afterEach(() => {
  cleanup();
  panelState.props = null;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('FileViewer manual edit history regressions', () => {
  it('flushes pending style edits before activating draw mode from manual edit', async () => {
    const initialSource = '<!doctype html><html><body><h1 data-od-id="hero" style="color: #111111">Hero</h1></body></html>';
    let saveResolve!: (value: Response) => void;
    const saveResponse = new Promise<Response>((resolve) => {
      saveResolve = resolve;
    });
    const savedSources: string[] = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
      if (url.includes('/api/projects/project-1/deployments')) {
        return new Response(JSON.stringify({ deployments: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.includes('/api/projects/project-1/files') && init?.method === 'POST') {
        const payload = JSON.parse(String(init.body)) as { content: string };
        savedSources.push(payload.content);
        return saveResponse;
      }
      if (url.includes('/api/projects/project-1/raw/preview.html')) {
        return new Response(initialSource, { status: 200 });
      }
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <FileViewer projectId="project-1" projectKind="prototype" file={htmlPreviewFile()}
        liveHtml={initialSource}
      />,
    );

    clickManualTool('manual-edit-mode-toggle');
    await selectManualEditTarget();

    act(() => {
      panelState.props?.onStyleChange?.('hero', { color: '#ef4444' }, 'Style: Hero');
    });
    clickAgentTool('draw-overlay-toggle');

    await waitFor(() => expect(savedSources).toHaveLength(1));
    expect(savedSources[0]).toContain('rgb(239, 68, 68)');
    openManualTools();
    expect(screen.getByTestId('manual-edit-mode-toggle').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('draw-overlay-toggle').getAttribute('aria-pressed')).toBe('false');

    await act(async () => {
      saveResolve(new Response(JSON.stringify({ file: htmlPreviewFile() }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));
      await saveResponse;
    });

    await waitFor(() => {
      openManualTools();
      expect(screen.getByTestId('manual-edit-mode-toggle').getAttribute('aria-pressed')).toBe('false');
    });
    expect(screen.getByTestId('draw-overlay-toggle').getAttribute('aria-pressed')).toBe('true');
  });

  it('keeps the srcDoc iframe mounted when closing manual edit on a srcDoc-only preview', async () => {
    const source = '<!doctype html><html><body><script>localStorage.getItem("od");</script><main data-od-id="hero">Hero</main></body></html>';

    render(
      <FileViewer projectId="project-1" projectKind="prototype" file={htmlPreviewFile()}
        liveHtml={source}
      />,
    );

    clickManualTool('manual-edit-mode-toggle');
    await selectManualEditTarget();

    const editFrame = screen.getByTestId('artifact-preview-frame') as HTMLIFrameElement;
    expect(editFrame.getAttribute('data-od-render-mode')).toBe('srcdoc');
    expect(editFrame.srcdoc).toContain('data-od-edit-bridge');

    // Exiting edit mode is the toolbar toggle's job — the panel's own close
    // button only collapses the inspector and stays in edit.
    clickManualTool('manual-edit-mode-toggle');

    await waitFor(() => {
      const previewFrame = screen.getByTestId('artifact-preview-frame') as HTMLIFrameElement;
      expect(previewFrame).toBe(editFrame);
      expect(previewFrame.getAttribute('data-od-render-mode')).toBe('srcdoc');
      expect(previewFrame.srcdoc).toContain('Hero');
      expect(previewFrame.srcdoc).toContain('data-od-edit-bridge');
    });
  });

  it('uses the undone source snapshot for a follow-up edit after undo', async () => {
    const initialSource = '<!doctype html><html><body><h1 data-od-id="hero" style="color: #111111">Hero</h1></body></html>';
    let persistedSource = initialSource;
    const savedSources: string[] = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
      if (url.includes('/api/projects/project-1/deployments')) {
        return new Response(JSON.stringify({ deployments: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.includes('/api/projects/project-1/files') && init?.method === 'POST') {
        const payload = JSON.parse(String(init.body)) as { content: string };
        persistedSource = payload.content;
        savedSources.push(payload.content);
        return new Response(JSON.stringify({ file: htmlPreviewFile() }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.includes('/api/projects/project-1/raw/preview.html')) {
        return new Response(persistedSource, { status: 200 });
      }
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <FileViewer projectId="project-1" projectKind="prototype" file={htmlPreviewFile()}
        liveHtml={initialSource}
      />,
    );

    clickManualTool('manual-edit-mode-toggle');
    await selectManualEditTarget();

    act(() => {
      panelState.props?.onApplyPatch(
        { kind: 'set-style', id: 'hero', styles: { color: '#ef4444' } },
        'Style: Hero',
      );
    });
    await waitFor(() => expect(savedSources).toHaveLength(1));
    expect(savedSources[0]).toContain('rgb(239, 68, 68)');

    act(() => {
      panelState.props?.onUndo();
    });
    await waitFor(() => expect(savedSources).toHaveLength(2));
    expect(savedSources[1]).toBe(initialSource);

    act(() => {
      panelState.props?.onApplyPatch(
        { kind: 'set-style', id: 'hero', styles: { backgroundColor: '#f97316' } },
        'Style: Hero',
      );
    });
    await waitFor(() => expect(savedSources).toHaveLength(3));

    expect(savedSources[2]).toContain('background-color: rgb(249, 115, 22)');
    expect(savedSources[2]).not.toContain('rgb(239, 68, 68)');
  });

  it('redoes an undone edit from the redo stack and reapplies the saved source', async () => {
    const initialSource = '<!doctype html><html><body><h1 data-od-id="hero" style="color: #111111">Hero</h1></body></html>';
    let persistedSource = initialSource;
    const savedSources: string[] = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
      if (url.includes('/api/projects/project-1/deployments')) {
        return new Response(JSON.stringify({ deployments: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.includes('/api/projects/project-1/files') && init?.method === 'POST') {
        const payload = JSON.parse(String(init.body)) as { content: string };
        persistedSource = payload.content;
        savedSources.push(payload.content);
        return new Response(JSON.stringify({ file: htmlPreviewFile() }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.includes('/api/projects/project-1/raw/preview.html')) {
        return new Response(persistedSource, { status: 200 });
      }
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <FileViewer projectId="project-1" projectKind="prototype" file={htmlPreviewFile()}
        liveHtml={initialSource}
      />,
    );

    fireEvent.click(screen.getByTestId('manual-edit-mode-toggle'));
    await selectManualEditTarget();

    expect(panelState.props?.canUndo).toBe(false);
    expect(panelState.props?.canRedo).toBe(false);

    act(() => {
      panelState.props?.onApplyPatch(
        { kind: 'set-style', id: 'hero', styles: { color: '#ef4444' } },
        'Style: Hero',
      );
    });
    await waitFor(() => expect(savedSources).toHaveLength(1));
    await waitFor(() => expect(panelState.props?.canUndo).toBe(true));
    expect(panelState.props?.canRedo).toBe(false);

    act(() => {
      panelState.props?.onUndo();
    });
    await waitFor(() => expect(savedSources).toHaveLength(2));
    expect(savedSources[1]).toBe(initialSource);
    await waitFor(() => expect(panelState.props?.canRedo).toBe(true));
    expect(panelState.props?.canUndo).toBe(false);

    act(() => {
      panelState.props?.onRedo();
    });
    await waitFor(() => expect(savedSources).toHaveLength(3));

    // Redo re-persists the exact source the first apply produced.
    expect(savedSources[2]).toBe(savedSources[0]);
    expect(savedSources[2]).toContain('rgb(239, 68, 68)');
    await waitFor(() => expect(panelState.props?.canUndo).toBe(true));
    expect(panelState.props?.canRedo).toBe(false);
    await waitFor(() => expect(panelState.props?.draft.fullSource).toContain('rgb(239, 68, 68)'));
  });

  it('refuses to apply over external file changes and clears history instead of overwriting', async () => {
    const initialSource = '<!doctype html><html><body><h1 data-od-id="hero">Hero</h1></body></html>';
    const externalSource = '<!doctype html><html><body><h1 data-od-id="hero">Rewritten by the agent</h1></body></html>';
    let persistedSource = initialSource;
    const savedSources: string[] = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
      if (url.includes('/api/projects/project-1/deployments')) {
        return new Response(JSON.stringify({ deployments: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.includes('/api/projects/project-1/files') && init?.method === 'POST') {
        const payload = JSON.parse(String(init.body)) as { content: string };
        persistedSource = payload.content;
        savedSources.push(payload.content);
        return new Response(JSON.stringify({ file: htmlPreviewFile() }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.includes('/api/projects/project-1/raw/preview.html')) {
        return new Response(persistedSource, { status: 200 });
      }
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <FileViewer projectId="project-1" projectKind="prototype" file={htmlPreviewFile()}
        liveHtml={initialSource}
      />,
    );

    fireEvent.click(screen.getByTestId('manual-edit-mode-toggle'));
    await selectManualEditTarget();

    act(() => {
      panelState.props?.onApplyPatch(
        { id: 'hero', kind: 'set-text', value: 'Edited hero' },
        'Content: Hero',
      );
    });
    await waitFor(() => expect(savedSources).toHaveLength(1));
    await waitFor(() => expect(panelState.props?.canUndo).toBe(true));

    // Another writer (e.g. the agent) replaces the file behind manual edit's back.
    persistedSource = externalSource;

    act(() => {
      panelState.props?.onApplyPatch(
        { id: 'hero', kind: 'set-text', value: 'Second edit' },
        'Content: Hero',
      );
    });

    await waitFor(() => expect(panelState.props?.error).toContain('changed outside manual edit'));
    // The stale patch is never written over the external content.
    expect(savedSources).toHaveLength(1);
    expect(savedSources.some((saved) => saved.includes('Second edit'))).toBe(false);
    // History is cleared so undo cannot resurrect pre-external snapshots.
    expect(panelState.props?.canUndo).toBe(false);
    expect(panelState.props?.canRedo).toBe(false);
    // The editor re-bases onto the external content.
    await waitFor(() => expect(panelState.props?.draft.fullSource).toBe(externalSource));
  });

  it('refreshes the manual edit canvas after non-style source patches', async () => {
    const initialSource = '<!doctype html><html><body><h1 data-od-id="hero">Hero</h1></body></html>';
    const savedSources: string[] = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
      if (url.includes('/api/projects/project-1/deployments')) {
        return new Response(JSON.stringify({ deployments: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.includes('/api/projects/project-1/files') && init?.method === 'POST') {
        const payload = JSON.parse(String(init.body)) as { content: string };
        savedSources.push(payload.content);
        return new Response(JSON.stringify({ file: htmlPreviewFile() }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.includes('/api/projects/project-1/raw/preview.html')) {
        return new Response(initialSource, { status: 200 });
      }
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <FileViewer projectId="project-1" projectKind="prototype" file={htmlPreviewFile()}
        liveHtml={initialSource}
      />,
    );

    fireEvent.click(screen.getByTestId('manual-edit-mode-toggle'));
    await selectManualEditTarget();
    const getActivePreviewFrame = () => screen.getByTestId('artifact-preview-frame') as HTMLIFrameElement;

    await waitFor(() => {
      const frame = getActivePreviewFrame();
      expect(frame.getAttribute('data-od-active')).toBe('true');
      expect(frame.getAttribute('data-od-render-mode')).toBe('srcdoc');
      expect(panelState.props?.draft.fullSource).toContain('Hero');
    });
    act(() => {
      panelState.props?.onApplyPatch(
        { id: 'hero', kind: 'set-text', value: 'Updated hero' },
        'Content: Hero',
      );
    });

    await waitFor(() => expect(savedSources).toHaveLength(1));
    await waitFor(() => expect(panelState.props?.draft.fullSource).toContain('Updated hero'));
    await waitFor(() => {
      expect(getActivePreviewFrame().srcdoc).toContain('Updated hero');
    });
  });

  it('only exposes reset after the selected element draft changes', async () => {
    const initialSource = '<!doctype html><html><body><h1 data-od-id="hero">Hero</h1></body></html>';
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
      if (url.includes('/api/projects/project-1/deployments')) {
        return new Response(JSON.stringify({ deployments: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.includes('/api/projects/project-1/raw/preview.html')) {
        return new Response(initialSource, { status: 200 });
      }
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <FileViewer projectId="project-1" projectKind="prototype" file={htmlPreviewFile()}
        liveHtml={initialSource}
      />,
    );

    fireEvent.click(screen.getByTestId('manual-edit-mode-toggle'));
    await selectManualEditTarget();

    expect(panelState.props?.resetAvailable).toBe(false);

    act(() => {
      const currentDraft = panelState.props?.draft;
      if (!currentDraft) throw new Error('Manual edit draft not found');
      panelState.props?.onDraftChange({ ...currentDraft, text: 'Panel edited copy' });
    });

    await waitFor(() => expect(panelState.props?.resetAvailable).toBe(true));

    await act(async () => {
      panelState.props?.onResetDraft();
    });

    await waitFor(() => expect(panelState.props?.resetAvailable).toBe(false));
  });

  it('repairs the inspector from source when a saved style value did not persist', async () => {
    const initialSource = '<!doctype html><html><body><h1 data-od-id="hero">Hero</h1></body></html>';
    let persistedSource = initialSource;
    const savedSources: string[] = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
      if (url.includes('/api/projects/project-1/deployments')) {
        return new Response(JSON.stringify({ deployments: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.includes('/api/projects/project-1/files') && init?.method === 'POST') {
        const payload = JSON.parse(String(init.body)) as { content: string };
        persistedSource = payload.content;
        savedSources.push(payload.content);
        return new Response(JSON.stringify({ file: htmlPreviewFile() }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.includes('/api/projects/project-1/raw/preview.html')) {
        return new Response(persistedSource, { status: 200 });
      }
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <FileViewer projectId="project-1" projectKind="prototype" file={htmlPreviewFile()}
        liveHtml={initialSource}
      />,
    );

    fireEvent.click(screen.getByTestId('manual-edit-mode-toggle'));
    await selectManualEditTarget();
    const frame = screen.getByTestId('artifact-preview-frame') as HTMLIFrameElement;
    const postMessageSpy = vi.spyOn(frame.contentWindow!, 'postMessage');

    // A value the CSS engine refuses: the save succeeds (patcher no-ops the
    // property) but the persisted source then differs from the saved snapshot.
    act(() => {
      panelState.props?.onApplyPatch(
        { kind: 'set-style', id: 'hero', styles: { color: 'definitely-not-a-color' } },
        'Style: Hero',
      );
    });

    await waitFor(() => expect(savedSources).toHaveLength(1));
    expect(savedSources[0]).not.toContain('definitely-not-a-color');
    // Reconcile pushes the real source value back into the live preview...
    await waitFor(() => {
      expect(postMessageSpy).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'od-edit-preview-style', id: 'hero', styles: { color: '' } }),
        '*',
      );
    });
    // ...and repairs the inspector draft to match the persisted source.
    await waitFor(() => expect(panelState.props?.draft.styles.color).toBe(''));
    // Selection survives the reconcile: the target still exists in source.
    expect(panelState.props?.selectedTarget?.id).toBe('hero');
  });

  it('surfaces the reconcile mismatch message when a saved style diverges from the preview', async () => {
    const initialSource = '<!doctype html><html><body><h1 data-od-id="hero">Hero</h1></body></html>';
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
      if (url.includes('/api/projects/project-1/files') && init?.method === 'POST') {
        return new Response(JSON.stringify({ file: htmlPreviewFile() }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.includes('/api/projects/project-1/raw/preview.html')) {
        return new Response(initialSource, { status: 200 });
      }
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <FileViewer projectId="project-1" projectKind="prototype" file={htmlPreviewFile()}
        liveHtml={initialSource}
      />,
    );

    fireEvent.click(screen.getByTestId('manual-edit-mode-toggle'));
    await selectManualEditTarget();

    act(() => {
      panelState.props?.onApplyPatch(
        { kind: 'set-style', id: 'hero', styles: { color: 'definitely-not-a-color' } },
        'Style: Hero',
      );
    });

    await waitFor(() => {
      expect(panelState.props?.error).toBe(
        'Saved styles differed from the active preview. Reconciled the selected target from source.',
      );
    });
  });

  it('keeps runtime-only style selections when the save lands as an override', async () => {
    const brandKitSource = '<!doctype html><html><head>'
      + '<script id="od-brand-payload" type="application/json">{"status":"ready","brand":{"name":"Acme"}}</script>'
      + '</head><body><div id="root"></div></body></html>';
    let persistedSource = brandKitSource;
    const savedSources: string[] = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
      if (url.includes('/api/projects/project-1/deployments')) {
        return new Response(JSON.stringify({ deployments: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.includes('/api/projects/project-1/files') && init?.method === 'POST') {
        const payload = JSON.parse(String(init.body)) as { content: string };
        persistedSource = payload.content;
        savedSources.push(payload.content);
        return new Response(JSON.stringify({ file: htmlPreviewFile() }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.includes('/api/projects/project-1/raw/preview.html')) {
        return new Response(persistedSource, { status: 200 });
      }
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <FileViewer projectId="project-1" projectKind="prototype" file={htmlPreviewFile()}
        liveHtml={brandKitSource}
      />,
    );

    fireEvent.click(screen.getByTestId('manual-edit-mode-toggle'));
    // A runtime-rendered brand-kit element: real in the iframe DOM, absent from source.
    await selectManualEditTarget({
      ...heroTarget(),
      id: 'brand-header',
      kind: 'container',
      label: 'Brand header',
      tagName: 'div',
      outerHtml: '<div data-od-id="brand-header">Brand header</div>',
    });

    act(() => {
      panelState.props?.onApplyPatch(
        { kind: 'set-style', id: 'brand-header', styles: { color: '#ef4444' } },
        'Style: Brand header',
      );
    });

    // The save lands as a runtime style override (the element is not in source)...
    await waitFor(() => expect(savedSources).toHaveLength(1));
    expect(savedSources[0]).toContain('data-od-manual-edit-runtime-overrides');
    expect(savedSources[0]).toContain('[data-od-id="brand-header"]');
    expect(savedSources[0]).toContain('color: #ef4444 !important');
    // ...the brand payload is never corrupted...
    expect(savedSources[0]).toContain('od-brand-payload');
    // ...and reconcile keeps runtime-only targets selected: their saved source
    // representation is the override rule, not source markup.
    await waitFor(() => expect(screen.queryByTestId('mock-manual-edit-panel')).not.toBeNull());
    expect(panelState.props?.selectedTarget?.id).toBe('brand-header');
  });

  it('persists page-style changes to the body when saving the page card', async () => {
    const initialSource = '<!doctype html><html><body><h1 data-od-id="hero">Hero</h1></body></html>';
    let persistedSource = initialSource;
    const savedSources: string[] = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
      if (url.includes('/api/projects/project-1/deployments')) {
        return new Response(JSON.stringify({ deployments: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.includes('/api/projects/project-1/files') && init?.method === 'POST') {
        const payload = JSON.parse(String(init.body)) as { content: string };
        persistedSource = payload.content;
        savedSources.push(payload.content);
        return new Response(JSON.stringify({ file: htmlPreviewFile() }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.includes('/api/projects/project-1/raw/preview.html')) {
        return new Response(persistedSource, { status: 200 });
      }
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <FileViewer projectId="project-1" projectKind="prototype" file={htmlPreviewFile()}
        liveHtml={initialSource}
      />,
    );

    fireEvent.click(screen.getByTestId('manual-edit-mode-toggle'));
    // Clicking the empty canvas opens the page-styles card (no selected target).
    const frame = await waitFor(() => {
      const node = screen.getByTestId('artifact-preview-frame') as HTMLIFrameElement;
      if (!node.contentWindow) throw new Error('Preview frame not ready');
      return node;
    });
    act(() => {
      window.dispatchEvent(new MessageEvent('message', {
        data: { type: 'od-edit-background' },
        source: frame.contentWindow,
      }));
    });
    await waitFor(() => expect(panelState.props).not.toBeNull());
    expect(panelState.props?.selectedTarget).toBeNull();

    act(() => {
      panelState.props?.onStyleChange?.('__body__', { backgroundColor: '#3b82f6' }, 'Page styles');
    });
    act(() => {
      panelState.props?.onSaveDraft();
    });

    await waitFor(() => expect(savedSources).toHaveLength(1));
    // Only the changed field lands on the body inline style.
    expect(savedSources[0]).toContain('<body style="background-color: rgb(59, 130, 246);">');
    expect(savedSources[0]).toContain('<h1 data-od-id="hero">Hero</h1>');
    // Saving the page card closes it.
    await waitFor(() => expect(screen.queryByTestId('mock-manual-edit-panel')).toBeNull());
  });

  it('clears the selected target after deleting an element', async () => {
    const initialSource = '<!doctype html><html><body><h1 data-od-id="hero">Hero</h1><p data-od-id="body">Body</p></body></html>';
    let persistedSource = initialSource;
    const savedSources: string[] = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
      if (url.includes('/api/projects/project-1/deployments')) {
        return new Response(JSON.stringify({ deployments: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.includes('/api/projects/project-1/files') && init?.method === 'POST') {
        const payload = JSON.parse(String(init.body)) as { content: string };
        persistedSource = payload.content;
        savedSources.push(payload.content);
        return new Response(JSON.stringify({ file: htmlPreviewFile() }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.includes('/api/projects/project-1/raw/preview.html')) {
        return new Response(persistedSource, { status: 200 });
      }
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <FileViewer projectId="project-1" projectKind="prototype" file={htmlPreviewFile()}
        liveHtml={initialSource}
      />,
    );

    fireEvent.click(screen.getByTestId('manual-edit-mode-toggle'));
    await selectManualEditTarget();
    const frame = screen.getByTestId('artifact-preview-frame') as HTMLIFrameElement;
    const postMessageSpy = vi.spyOn(frame.contentWindow!, 'postMessage');

    await waitFor(() => expect(panelState.props?.selectedTarget?.id).toBe('hero'));
    expect(panelState.props?.draft.text).toBe('Hero');

    act(() => {
      panelState.props?.onApplyPatch(
        { id: 'hero', kind: 'remove-element' },
        'Delete element',
      );
    });

    await waitFor(() => expect(savedSources).toHaveLength(1));
    expect(savedSources[0]).not.toContain('data-od-id="hero"');
    expect(savedSources[0]).toContain('data-od-id="body"');
    // Clearing the selection closes the inspector: edit mode returns to a clean
    // canvas (no docked/pinned panel) and the iframe selection marker is reset.
    await waitFor(() => expect(screen.queryByTestId('mock-manual-edit-panel')).toBeNull());
    expect(postMessageSpy).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'od-edit-selected-target', id: null }),
      '*',
    );
    await waitFor(() => {
      expect((screen.getByTestId('artifact-preview-frame') as HTMLIFrameElement).srcdoc)
        .not.toContain('data-od-id="hero"');
    });
  });
});

function htmlPreviewFile(): ProjectFile {
  return {
    name: 'preview.html',
    path: 'preview.html',
    type: 'file',
    size: 1024,
    mtime: 1710000000,
    mime: 'text/html',
    kind: 'html',
    artifactManifest: {
      version: 1,
      kind: 'html',
      title: 'Preview',
      entry: 'preview.html',
      renderer: 'html',
      exports: ['html'],
    },
  };
}

function heroTarget(): ManualEditTarget {
  return {
    id: 'hero',
    kind: 'text',
    label: 'Hero',
    tagName: 'h1',
    className: '',
    text: 'Hero',
    rect: { x: 0, y: 0, width: 120, height: 40 },
    fields: { text: 'Hero' },
    attributes: { 'data-od-id': 'hero' },
    styles: emptyManualEditStyles(),
    isLayoutContainer: false,
    outerHtml: '<h1 data-od-id="hero">Hero</h1>',
  };
}
