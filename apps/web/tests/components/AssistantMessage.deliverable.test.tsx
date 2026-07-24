// @vitest-environment jsdom

/**
 * The task-completion deliverable card: a terminal turn that produced a
 * headline artifact shows the real scaled preview, keeps share/export in a
 * compact overflow menu, and offers one attachment + "view all files" in its
 * footer instead of the old three-button action row.
 */

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { AssistantMessage } from '../../src/components/AssistantMessage';
import { DESIGN_FILES_TAB } from '../../src/components/FileWorkspace';
import type { ChatMessage, ProjectFile } from '../../src/types';

const fetchMock = vi.fn();

beforeAll(() => {
  const store = new Map<string, string>();
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      clear: () => store.clear(),
      getItem: (key: string) => store.get(key) ?? null,
      removeItem: (key: string) => store.delete(key),
      setItem: (key: string, value: string) => store.set(key, value),
    },
  });
  vi.stubGlobal('fetch', fetchMock);
});

beforeEach(() => {
  // Most behavior tests do not need to resolve the iframe. The component
  // degrades to its calm file placeholder on a rejected thumbnail request.
  fetchMock.mockReset();
  fetchMock.mockRejectedValue(new Error('no network'));
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

function baseMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'msg-1',
    role: 'assistant',
    content: 'Done.',
    runStatus: 'succeeded',
    startedAt: 1700000000,
    endedAt: 1700000005,
    events: [{ kind: 'text', text: 'Done.' } as NonNullable<ChatMessage['events']>[number]],
    producedFiles: [],
    ...overrides,
  } as ChatMessage;
}

function file(name: string, kind: ProjectFile['kind'], mtime = 1700000005): ProjectFile {
  return {
    name,
    path: name,
    size: 200,
    mtime,
    kind,
    mime: 'application/octet-stream',
  } as ProjectFile;
}

describe('AssistantMessage — task deliverable card', () => {
  it('headlines the HTML artifact and keeps the footer to one attachment plus all files', () => {
    const onRequestOpenFile = vi.fn();
    render(
      <AssistantMessage
        message={baseMessage({
          producedFiles: [
            file('report.md', 'text', 1700000004),
            file('agent-native-app.html', 'html', 1700000005),
          ],
        })}
        streaming={false}
        projectId="proj-1"
        isLast
        onRequestOpenFile={onRequestOpenFile}
      />,
    );

    const card = screen.getByTestId('task-deliverable-card');
    expect(card).toBeTruthy();
    // Title humanized from the HTML filename (the highest-ranked deliverable).
    expect(card.textContent).toContain('Agent Native App');
    // The first supporting output becomes the single compact attachment tile.
    expect(card.textContent).toContain('report.md');
    expect(card.textContent).not.toContain('More outputs');
    expect(screen.queryByText('View')).toBeNull();
    expect(screen.queryByText('Share')).toBeNull();
    expect(screen.queryByText('Download')).toBeNull();

    fireEvent.click(within(card).getByRole('button', { name: /report\.md/i }));
    expect(onRequestOpenFile).toHaveBeenCalledWith('report.md');

    // The preview itself opens the primary artifact.
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    expect(onRequestOpenFile).toHaveBeenCalledWith('agent-native-app.html');

    // "View all files" opens the All-Files workspace tab.
    fireEvent.click(screen.getByText(/View all files in this task/));
    expect(onRequestOpenFile).toHaveBeenCalledWith(DESIGN_FILES_TAB);
  });

  it('keeps Share and Download inside the HTML overflow menu', () => {
    const onArtifactShare = vi.fn();
    const onArtifactDownload = vi.fn();
    render(
      <AssistantMessage
        message={baseMessage({ producedFiles: [file('demo.html', 'html')] })}
        streaming={false}
        projectId="proj-1"
        isLast
        onArtifactShare={onArtifactShare}
        onArtifactDownload={onArtifactDownload}
        onRequestOpenFile={vi.fn()}
      />,
    );

    expect(screen.queryByText('Share')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Share' }));
    expect(onArtifactShare).toHaveBeenCalledWith('demo.html');

    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Download' }));
    expect(onArtifactDownload).toHaveBeenCalledWith('demo.html');
  });

  it('refreshes the preview from current project metadata and renders a desktop-scaled iframe', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      text: async () => '<!doctype html><html><body>Latest result</body></html>',
    });
    const stale = file('demo.html', 'html', 1700000005);
    const current = { ...stale, mtime: 1700009000, size: 4096 };

    render(
      <AssistantMessage
        message={baseMessage({ producedFiles: [stale] })}
        streaming={false}
        projectId="proj-1"
        projectFiles={[current]}
        isLast
        onRequestOpenFile={vi.fn()}
      />,
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/projects/proj-1/raw/demo.html?v=1700009000');
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ cache: 'no-store' });

    await screen.findAllByTitle('demo.html');
    const iframe = screen
      .getAllByTitle('demo.html')
      .find((element) => element.tagName === 'IFRAME');
    expect(iframe).toBeTruthy();
    if (!iframe) throw new Error('Expected the deliverable preview iframe');
    fireEvent.load(iframe);
    expect(iframe.getAttribute('class')).toBeTruthy();
    expect(screen.getByText('Web page · 4.0 KB')).toBeTruthy();
  });

  it('uses the compact changes mode when no file headlines', () => {
    render(
      <AssistantMessage
        message={baseMessage({ producedFiles: [file('DESIGN.md', 'text')] })}
        streaming={false}
        projectId="proj-1"
        isLast
        onRequestOpenFile={vi.fn()}
      />,
    );
    // DESIGN.md is scaffolding, not a headline deliverable, so the card keeps
    // the completion summary without inventing a fake product preview.
    const card = screen.getByTestId('task-deliverable-card');
    expect(card.textContent).toContain('1 files changed');
    expect(screen.queryByRole('button', { name: 'Preview' })).toBeNull();
  });

  // The card's status label is an unconditional "Done", so it must never
  // render for a run that reached a terminal state without succeeding — a
  // failed or canceled run that wrote files would otherwise present a
  // partial artifact as delivered while the same message reports the error.
  // Those turns keep the plain file ledger instead.
  it.each(['failed', 'canceled'] as const)(
    'keeps the deliverable card off a %s run that produced files',
    (runStatus) => {
      render(
        <AssistantMessage
          message={baseMessage({
            runStatus,
            producedFiles: [
              file('report.md', 'text', 1700000004),
              file('agent-native-app.html', 'html', 1700000005),
            ],
          })}
          streaming={false}
          projectId="proj-1"
          isLast
          onRequestOpenFile={vi.fn()}
        />,
      );

      expect(screen.queryByTestId('task-deliverable-card')).toBeNull();
    },
  );
});
