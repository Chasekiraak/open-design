// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DesignSystemSummary, SkillSummary } from '@open-design/contracts';

vi.mock('../../src/providers/registry', () => ({
  fetchDesignTemplates: vi.fn(async (): Promise<SkillSummary[]> => [
    {
      id: 'deck-fundraising',
      name: 'Fundraising Pitch',
      description: 'Investor deck',
      triggers: [],
      mode: 'deck',
      category: 'fundraising-pitch',
      previewType: 'html',
      designSystemRequired: false,
      defaultFor: [],
      upstream: null,
      hasBody: true,
      examplePrompt: 'Build a fundraising deck',
      aggregatesExamples: false,
    } as SkillSummary,
    {
      id: 'proto-dashboard',
      name: 'Analytics Dashboard',
      description: 'SaaS dashboard prototype',
      triggers: [],
      mode: 'prototype',
      category: 'data-finance',
      previewType: 'html',
      designSystemRequired: false,
      defaultFor: [],
      upstream: null,
      hasBody: true,
      examplePrompt: 'Build a dashboard',
      aggregatesExamples: false,
    } as SkillSummary,
  ]),
  fetchDesignSystems: vi.fn(async (): Promise<DesignSystemSummary[]> => [
    {
      id: 'user:editorial',
      title: 'Editorial',
      category: 'editorial',
      summary: 'Serif-led editorial language',
      swatches: ['#111111', '#f5f1e8', '#c96442'],
      source: 'user',
    } as DesignSystemSummary,
    ...['Bento', 'Organic', 'Nocturne', 'Modernist', 'Classical'].map(
      (title) =>
        ({
          id: title.toLowerCase(),
          title,
          category: 'included',
          summary: `${title} bundled system`,
          swatches: ['#222222', '#eeeeee'],
        }) as DesignSystemSummary,
    ),
  ]),
  projectRawUrl: (projectId: string, filePath: string) =>
    `/api/projects/${projectId}/raw/${filePath
      .split('/')
      .map((seg) => encodeURIComponent(seg))
      .join('/')}`,
}));

import { QuestionFormView } from '../../src/components/QuestionForm';
import {
  InspirationPicker,
  resetInspirationCatalogCacheForTests,
} from '../../src/components/InspirationPicker';
import { useT } from '../../src/i18n';
import type { QuestionForm } from '../../src/artifacts/question-form';

const inspirationForm: QuestionForm = {
  id: 'inspiration',
  title: 'Pick a reference — optional',
  questions: [
    {
      id: 'inspiration',
      label: 'Ground this task in a reference',
      type: 'inspiration',
      query: 'product landing page',
    },
  ],
};

beforeEach(() => {
  resetInspirationCatalogCacheForTests();
  const fetchMock = vi.fn<typeof fetch>();
  fetchMock.mockResolvedValue({ ok: true } as Response);
  vi.stubGlobal('fetch', fetchMock);
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: vi.fn(() => 'blob:mock'),
  });
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true,
    value: vi.fn(),
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

/**
 * The picker seeds the top-ranked template + design system as a default
 * answer the first time the catalogues render. Tests that exercise manual
 * picking clear that seed first, so their assertions stay about the
 * interaction under test rather than the default.
 */
async function clearSeededPicks() {
  await screen.findByTestId('inspiration-picked');
  for (let guard = 0; guard < 10; guard += 1) {
    const remove = screen.queryAllByRole('button', { name: /^Remove: / });
    if (remove.length === 0) return;
    fireEvent.click(remove[0]!);
  }
  throw new Error('seeded picks did not clear');
}

describe('InspirationPicker inside QuestionFormView', () => {
  it('seeds the top-ranked template and design system as the default answer', async () => {
    const onSubmit = vi.fn();
    render(<QuestionFormView form={inspirationForm} interactive onSubmit={onSubmit} />);

    // Nothing clicked: the default answer is already populated. The template
    // is the catalogue leader, and Editorial wins among design systems on
    // palette vividness (terracotta accent vs. the greyscale bundles).
    const chips = await screen.findByTestId('inspiration-picked');
    expect(chips.textContent).toContain('Fundraising Pitch');
    expect(chips.textContent).toContain('Editorial');

    fireEvent.click(screen.getByText('Send answers'));
    const [, , , , inspiration] = onSubmit.mock.calls[0]!;
    expect(inspiration).toEqual({
      templates: [{ id: 'deck-fundraising', label: 'Fundraising Pitch' }],
      designSystems: [{ id: 'user:editorial', label: 'Editorial' }],
    });
  });

  it('filters templates whose preview HTML cannot be found', async () => {
    vi.mocked(fetch).mockImplementation(async (input) => ({
      ok: !String(input).includes('/deck-fundraising/preview'),
    }) as Response);

    render(<QuestionFormView form={inspirationForm} interactive onSubmit={vi.fn()} />);

    expect(await screen.findByLabelText('Analytics Dashboard')).toBeTruthy();
    await waitFor(() => {
      expect(screen.queryByLabelText('Fundraising Pitch')).toBeNull();
      expect(screen.getByTestId('inspiration-picked').textContent).toContain(
        'Analytics Dashboard',
      );
    });
  });

  it('never re-seeds after the user clears the default picks', async () => {
    const onSubmit = vi.fn();
    render(<QuestionFormView form={inspirationForm} interactive onSubmit={onSubmit} />);

    await clearSeededPicks();
    // The seed latches on first decision, so re-rendering the catalogue (here
    // via a tab switch) must not quietly restore what the user removed.
    fireEvent.click(screen.getByRole('tab', { name: /Design systems/ }));
    fireEvent.click(screen.getByRole('tab', { name: /Templates/ }));

    expect(screen.queryByTestId('inspiration-picked')).toBeNull();
    fireEvent.click(screen.getByText('Send answers'));
    const [, , , , inspiration] = onSubmit.mock.calls[0]!;
    expect(inspiration).toBeUndefined();
  });

  it('reports a template pick through the structured inspiration payload', async () => {
    const onSubmit = vi.fn();
    render(<QuestionFormView form={inspirationForm} interactive onSubmit={onSubmit} />);

    expect(screen.getByTestId('inspiration-picker')).toBeTruthy();
    expect(screen.getByText('product landing page')).toBeTruthy();

    await clearSeededPicks();
    fireEvent.click(await screen.findByLabelText('Fundraising Pitch'));
    fireEvent.click(screen.getByText('Send answers'));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    const [text, answers, source, files, inspiration] = onSubmit.mock.calls[0]!;
    expect(source).toBe('submit');
    expect(text).toContain('Fundraising Pitch [template:deck-fundraising]');
    expect(answers.inspiration).toEqual(['Fundraising Pitch [template:deck-fundraising]']);
    expect(files).toEqual([]);
    expect(inspiration).toEqual({
      templates: [{ id: 'deck-fundraising', label: 'Fundraising Pitch' }],
      designSystems: [],
    });
  });

  it('reports a design-system pick from the design-systems tab', async () => {
    const onSubmit = vi.fn();
    render(<QuestionFormView form={inspirationForm} interactive onSubmit={onSubmit} />);

    await clearSeededPicks();
    fireEvent.click(screen.getByRole('tab', { name: /Design systems/ }));
    fireEvent.click(await screen.findByLabelText('Editorial'));
    fireEvent.click(screen.getByText('Send answers'));

    const [text, , , , inspiration] = onSubmit.mock.calls[0]!;
    expect(text).toContain('Editorial [ds:user:editorial]');
    expect(inspiration).toEqual({
      templates: [],
      designSystems: [{ id: 'user:editorial', label: 'Editorial' }],
    });
  });

  it('inline design-system picks stay single-select (replace, not stack)', async () => {
    const onSubmit = vi.fn();
    render(<QuestionFormView form={inspirationForm} interactive onSubmit={onSubmit} />);

    await clearSeededPicks();
    fireEvent.click(screen.getByRole('tab', { name: /Design systems/ }));
    fireEvent.click(await screen.findByLabelText('Editorial'));
    fireEvent.click(screen.getByLabelText('Bento'));
    fireEvent.click(screen.getByText('Send answers'));

    const [, answers, , , inspiration] = onSubmit.mock.calls[0]!;
    expect(answers.inspiration).toEqual(['Bento [ds:bento]']);
    expect(inspiration.designSystems).toEqual([{ id: 'bento', label: 'Bento' }]);
  });

  it('gallery multi-select accumulates design systems and clear-selection empties them', async () => {
    const onSubmit = vi.fn();
    render(<QuestionFormView form={inspirationForm} interactive onSubmit={onSubmit} />);

    await clearSeededPicks();
    fireEvent.click(screen.getByRole('tab', { name: /Design systems/ }));
    // 6 systems, inline grid shows 4 → the "+2" more tile opens the gallery.
    fireEvent.click(await screen.findByRole('button', { name: 'Browse all' }));
    fireEvent.click(screen.getByRole('button', { name: /Select multiple/ }));

    // The inline grid stays mounted behind the dialog, so the same title
    // appears twice; the gallery copy is the last match.
    const galleryCard = (title: string) => screen.getAllByLabelText(title).at(-1)!;
    fireEvent.click(galleryCard('Bento'));
    fireEvent.click(galleryCard('Organic'));
    fireEvent.click(screen.getByRole('button', { name: /done/i }));
    fireEvent.click(screen.getByText('Send answers'));

    const [text, answers, , , inspiration] = onSubmit.mock.calls[0]!;
    expect(answers.inspiration).toEqual(['Bento [ds:bento]', 'Organic [ds:organic]']);
    expect(text).toContain('Bento [ds:bento]');
    expect(inspiration.designSystems).toEqual([
      { id: 'bento', label: 'Bento' },
      { id: 'organic', label: 'Organic' },
    ]);
  });

  it('pasted images join the upload channel', async () => {
    const onSubmit = vi.fn();
    render(<QuestionFormView form={inspirationForm} interactive onSubmit={onSubmit} />);

    await clearSeededPicks();
    const picker = await screen.findByTestId('inspiration-picker');
    const file = new File(['png-bytes'], 'pasted-shot.png', { type: 'image/png' });
    fireEvent.paste(picker, { clipboardData: { files: [file] } });
    fireEvent.click(screen.getByText('Send answers'));

    const [, answers, , files] = onSubmit.mock.calls[0]!;
    expect(answers.inspiration).toEqual(['pasted-shot.png']);
    expect(files).toEqual([
      expect.objectContaining({ questionId: 'inspiration', files: [file] }),
    ]);
  });

  it('replaces instead of stacking template picks (max 1)', async () => {
    const onSubmit = vi.fn();
    render(<QuestionFormView form={inspirationForm} interactive onSubmit={onSubmit} />);

    await clearSeededPicks();
    fireEvent.click(await screen.findByLabelText('Fundraising Pitch'));
    fireEvent.click(screen.getByLabelText('Analytics Dashboard'));
    fireEvent.click(screen.getByText('Send answers'));

    const [, answers] = onSubmit.mock.calls[0]!;
    expect(answers.inspiration).toEqual([
      'Analytics Dashboard [template:proto-dashboard]',
    ]);
  });

  it('skip-all serializes (skipped) with no inspiration payload', async () => {
    const onSubmit = vi.fn();
    render(<QuestionFormView form={inspirationForm} interactive onSubmit={onSubmit} />);

    await screen.findByLabelText('Fundraising Pitch');
    fireEvent.click(screen.getByText('Skip all'));

    const [text, , source, files, inspiration] = onSubmit.mock.calls[0]!;
    expect(source).toBe('skip');
    expect(text).toContain('Ground this task in a reference: (skipped)');
    expect(files).toBeUndefined();
    expect(inspiration).toBeUndefined();
  });

  it('uploads ride the standard file-submission channel with names in the answer', async () => {
    const onSubmit = vi.fn();
    const { container } = render(
      <QuestionFormView form={inspirationForm} interactive onSubmit={onSubmit} />,
    );

    fireEvent.click(screen.getByRole('tab', { name: /Your images/ }));
    const input = container.querySelector('input[type="file"]');
    expect(input).not.toBeNull();
    const file = new File(['x'], 'reference-shot.png', { type: 'image/png' });
    fireEvent.change(input!, { target: { files: [file] } });
    fireEvent.click(screen.getByText('Send answers'));

    const [text, answers, , files, inspiration] = onSubmit.mock.calls[0]!;
    expect(answers.inspiration).toEqual(['reference-shot.png']);
    expect(text).toContain('reference-shot.png');
    expect(files).toEqual([
      {
        questionId: 'inspiration',
        questionLabel: 'Ground this task in a reference',
        files: [file],
      },
    ]);
    // Uploads alone carry no template/design-system payload.
    expect(inspiration).toBeUndefined();
  });

  it('selection chips list every pick and remove works across families', async () => {
    const onSubmit = vi.fn();
    render(<QuestionFormView form={inspirationForm} interactive onSubmit={onSubmit} />);

    await clearSeededPicks();
    fireEvent.click(await screen.findByLabelText('Fundraising Pitch'));
    fireEvent.click(screen.getByRole('tab', { name: /Design systems/ }));
    fireEvent.click(screen.getByLabelText('Editorial'));

    const chips = screen.getByTestId('inspiration-picked');
    expect(chips.textContent).toContain('Fundraising Pitch');
    expect(chips.textContent).toContain('Editorial');

    // Removing via the chip clears that family's pick even when its card is
    // not on the active tab.
    fireEvent.click(screen.getByRole('button', { name: 'Remove: Fundraising Pitch' }));
    fireEvent.click(screen.getByText('Send answers'));
    const [, answers] = onSubmit.mock.calls[0]!;
    expect(answers.inspiration).toEqual(['Editorial [ds:user:editorial]']);
  });

  it('locked with picks renders the compact read-only summary instead of the catalog', () => {
    function Harness() {
      const t = useT();
      return (
        <InspirationPicker
          formId="inspiration"
          questionId="inspiration"
          query="product landing page"
          value={['Fundraising Pitch [template:deck-fundraising]', 'reference-shot.png']}
          files={[]}
          disabled
          onChange={() => {}}
          onFilesChange={() => {}}
          t={t}
        />
      );
    }
    render(<Harness />);
    const picker = screen.getByTestId('inspiration-picker');
    expect(picker.className).toContain('qf-insp-summary');
    const chips = screen.getByTestId('inspiration-picked');
    expect(chips.textContent).toContain('Fundraising Pitch');
    expect(chips.textContent).toContain('reference-shot.png');
    // No catalog UI in the locked record.
    expect(screen.queryByRole('tab', { name: /Design systems/ })).toBeNull();
  });

  it('locked summary resolves an uploaded image to its real project path', () => {
    function Harness() {
      const t = useT();
      return (
        <InspirationPicker
          formId="inspiration"
          questionId="inspiration"
          value={['image.png']}
          files={[]}
          disabled
          onChange={() => {}}
          onFilesChange={() => {}}
          t={t}
          projectId="proj-1"
          uploadPathByName={{ 'image.png': 'uploads/image-2.png' }}
        />
      );
    }
    render(<Harness />);
    const img = screen.getByTestId('inspiration-picked').querySelector('img');
    expect(img).not.toBeNull();
    // De-dup path wins over the raw name, encoded per segment.
    expect(img!.getAttribute('src')).toBe('/api/projects/proj-1/raw/uploads/image-2.png');
  });

  it('uses the card document for both design-system detail and gallery previews', async () => {
    render(<QuestionFormView form={inspirationForm} interactive onSubmit={vi.fn()} />);

    fireEvent.click(screen.getByRole('tab', { name: /Design systems/ }));
    await screen.findByLabelText('Editorial');

    const previewButtons = screen.getAllByRole('button', { name: 'Preview: Editorial' });
    fireEvent.click(previewButtons[0]!);
    const detailFrame = document.querySelector<HTMLIFrameElement>('.qf-insp-detail-frame');
    expect(detailFrame?.getAttribute('src')).toBe('/api/design-systems/user%3Aeditorial/card');

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    fireEvent.click(screen.getByRole('button', { name: 'Browse all' }));

    await waitFor(() => {
      const galleryFrame = document.querySelector<HTMLIFrameElement>('.qf-dsx-preview-frame');
      expect(galleryFrame?.getAttribute('src')).toBe(
        '/api/design-systems/user%3Aeditorial/card',
      );
    });
    expect(screen.queryByText('Loading preview…')).toBeNull();
  });

  it('locks the picker when the form is not interactive', async () => {
    render(<QuestionFormView form={inspirationForm} interactive={false} onSubmit={vi.fn()} />);
    const card = await screen.findByLabelText('Fundraising Pitch');
    expect((card as HTMLInputElement).disabled).toBe(true);
  });
});
