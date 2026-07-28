import { describe, expect, it } from 'vitest';

import {
  MCP_SERVER_INSTRUCTIONS,
  _localeFromMcpToolMetadata,
  createLocalMcpBriefStore,
  handleMcpToolCall,
  localMcpResourceDefinitions,
  localMcpToolDefinitions,
} from '../src/mcp.js';
import { OPEN_DESIGN_BRIEF_APP_HTML } from '../src/mcp-apps/brief-resource.js';

describe('local Open Design MCP brief app', () => {
  it('exposes collect_brief through the canonical MCP Apps resource', () => {
    const collectBrief = localMcpToolDefinitions().find(
      (tool) => tool.name === 'collect_brief',
    );

    expect(collectBrief).toMatchObject({
      name: 'collect_brief',
      _meta: {
        ui: {
          resourceUri: 'ui://open-design-cloud/artifact-card-v2.html',
        },
        'ui/resourceUri': 'ui://open-design-cloud/artifact-card-v2.html',
        'openai/outputTemplate': 'ui://open-design-cloud/artifact-card-v2.html',
      },
    });
    expect(localMcpResourceDefinitions()).toContainEqual(
      expect.objectContaining({
        uri: 'ui://open-design-cloud/artifact-card-v2.html',
        mimeType: 'text/html;profile=mcp-app',
      }),
    );

    const confirmBrief = localMcpToolDefinitions().find(
      (tool) => tool.name === 'confirm_brief',
    );
    expect(confirmBrief).not.toHaveProperty('_meta');
  });

  it('keeps one brief card and reports every intrinsic height change', () => {
    expect(OPEN_DESIGN_BRIEF_APP_HTML).toContain('ResizeObserver');
    expect(OPEN_DESIGN_BRIEF_APP_HTML).toContain(
      'ui/notifications/size-changed',
    );
    expect(OPEN_DESIGN_BRIEF_APP_HTML).toContain('{ width, height }');
    expect(OPEN_DESIGN_BRIEF_APP_HTML).toContain(
      'root.style.height = "max-content"',
    );
    expect(OPEN_DESIGN_BRIEF_APP_HTML).toContain(
      'width: Math.ceil(window.innerWidth)',
    );
    expect(OPEN_DESIGN_BRIEF_APP_HTML).toContain(
      'width === lastWidth && height === lastHeight',
    );
    expect(OPEN_DESIGN_BRIEF_APP_HTML).toContain('observer.observe(main)');
    expect(OPEN_DESIGN_BRIEF_APP_HTML).toContain('notifyIntrinsicHeight');
    expect(OPEN_DESIGN_BRIEF_APP_HTML).toContain('requestAnimationFrame');
    expect(OPEN_DESIGN_BRIEF_APP_HTML).toContain(
      'ui/notifications/host-context-changed',
    );
    expect(OPEN_DESIGN_BRIEF_APP_HTML).toContain(
      'updateHostLocale(result && result.hostContext)',
    );
    expect(OPEN_DESIGN_BRIEF_APP_HTML).toContain(
      'draft.localeSource === "fallback"',
    );
    expect(OPEN_DESIGN_BRIEF_APP_HTML).toContain(
      'payload.questionFormsByLocale',
    );
    expect(OPEN_DESIGN_BRIEF_APP_HTML).toContain(
      'draft.briefDraftId === payload.briefDraftId',
    );
    expect(OPEN_DESIGN_BRIEF_APP_HTML).toContain(
      'candidate.value === (previousValue || item.defaultValue)',
    );
    expect(OPEN_DESIGN_BRIEF_APP_HTML).not.toContain(
      'error instanceof Error ? error.message',
    );
    expect(OPEN_DESIGN_BRIEF_APP_HTML).not.toContain('setWidgetState');
  });

  it('lets Host context localize an otherwise language-neutral brief', async () => {
    const briefStore = createLocalMcpBriefStore();
    const collected = await handleMcpToolCall(
      'http://127.0.0.1:17456',
      'collect_brief',
      {
        artifactType: 'website',
        projectTitle: 'Host localized website',
      },
      { briefStore },
    );
    const payload = collected.structuredContent as {
      locale: string;
      localeSource: string;
      briefDraftId: string;
      nonce: string;
      questionForm: {
        questions: Array<{ id: string; defaultValue: string }>;
      };
      questionFormsByLocale: Record<
        string,
        {
          title: string;
          submitLabel: string;
          questions: Array<{ label: string }>;
        }
      >;
    };

    expect(payload).toMatchObject({
      locale: 'en',
      localeSource: 'fallback',
    });
    expect(payload.questionFormsByLocale['zh-CN']).toMatchObject({
      title: '选择网站方向',
      submitLabel: '确认需求',
    });
    expect(
      payload.questionFormsByLocale['zh-CN']?.questions[0],
    ).toMatchObject({
      label: '这个网站需要实现什么目标？',
    });

    const answers = Object.fromEntries(
      payload.questionForm.questions.map((question) => [
        question.id,
        [question.defaultValue],
      ]),
    );
    const confirmed = await handleMcpToolCall(
      'http://127.0.0.1:17456',
      'confirm_brief',
      {
        briefDraftId: payload.briefDraftId,
        nonce: payload.nonce,
        answers,
        locale: 'zh-CN',
      },
      { briefStore },
    );

    expect(confirmed.structuredContent).toMatchObject({ locale: 'zh-CN' });
    expect(String(confirmed.structuredContent?.summary)).toContain(
      '这个网站需要实现什么目标？',
    );
    expect(confirmed.content[0]?.text).toContain('需求已确认。');
  });

  it('accepts host locale metadata only as the collect_brief fallback', () => {
    expect(_localeFromMcpToolMetadata({
      'openai/locale': 'zh-CN',
    })).toBe('zh-CN');
    expect(_localeFromMcpToolMetadata({ locale: 'ja-JP' })).toBe('ja-JP');
    expect(_localeFromMcpToolMetadata({
      'openai/locale': ' ',
      locale: 42,
    })).toBeUndefined();
  });

  it('collects and confirms a human-readable website brief locally', async () => {
    const briefStore = createLocalMcpBriefStore();
    const collected = await handleMcpToolCall(
      'http://127.0.0.1:17456',
      'collect_brief',
      {
        artifactType: 'website',
        projectTitle: 'AI analytics startup',
      },
      { briefStore },
    );

    expect(collected.structuredContent).toMatchObject({
      view: 'brief-form',
      artifactType: 'website',
      questionForm: {
        submitLabel: 'Confirm brief',
      },
    });
    const draft = collected.structuredContent as {
      briefDraftId: string;
      nonce: string;
      questionForm: {
        questions: Array<{
          id: string;
          defaultValue?: string;
          options: Array<{ value: string }>;
        }>;
      };
    };
    const answers = Object.fromEntries(
      draft.questionForm.questions.map((question) => [
        question.id,
        [
          question.defaultValue
            ?? question.options[0]?.value
            ?? '',
        ],
      ]),
    );

    const confirmed = await handleMcpToolCall(
      'http://127.0.0.1:17456',
      'confirm_brief',
      {
        briefDraftId: draft.briefDraftId,
        nonce: draft.nonce,
        answers,
      },
      { briefStore },
    );

    expect(confirmed.structuredContent).toMatchObject({
      view: 'brief-confirmed',
      artifactType: 'website',
    });
    expect(String(confirmed.structuredContent?.summary)).toContain(
      'What should this website do?',
    );
    expect(String(confirmed.structuredContent?.summary)).not.toMatch(
      /^brief-confirmation-v1\./u,
    );
    expect(confirmed.content[0]?.text).toContain('Brief confirmed.');
    expect(confirmed.content[0]?.text).toContain(
      'What should this website do?',
    );
    expect(confirmed.content[0]?.text).not.toContain(
      'brief-confirmation-v1.',
    );
    expect(confirmed.content[0]?.text).not.toContain(draft.briefDraftId);
    expect(confirmed.content[0]?.text).not.toContain(draft.nonce);

    const repeated = await handleMcpToolCall(
      'http://127.0.0.1:17456',
      'confirm_brief',
      {
        briefDraftId: draft.briefDraftId,
        nonce: draft.nonce,
        answers,
      },
      { briefStore },
    );
    expect(repeated.structuredContent).toEqual(confirmed.structuredContent);
  });

  it.each([
    ['zh-CN', '选择网站方向', '确认需求', '这个网站需要实现什么目标？'],
    ['zh-TW', '選擇網站方向', '確認需求', '這個網站需要達成什麼目標？'],
    ['ja', 'ウェブサイトの方向性を選択', 'ブリーフを確認', 'このウェブサイトの目的は何ですか？'],
  ] as const)(
    'localizes website brief copy for explicit request locale %s without translating protocol ids',
    async (locale, expectedTitle, expectedSubmit, expectedQuestion) => {
      const briefStore = createLocalMcpBriefStore();
      const collected = await handleMcpToolCall(
        'http://127.0.0.1:17456',
        'collect_brief',
        {
          artifactType: 'website',
          locale,
          projectTitle: 'Localized website',
        },
        { briefStore },
      );
      const payload = collected.structuredContent as {
        locale: string;
        briefDraftId: string;
        nonce: string;
        questionForm: {
          title: string;
          submitLabel: string;
          questions: Array<{
            id: string;
            label: string;
            defaultValue: string;
            options: Array<{ value: string; label: string }>;
          }>;
        };
      };

      expect(payload.locale).toBe(locale);
      expect(payload.questionForm.title).toBe(expectedTitle);
      expect(payload.questionForm.submitLabel).toBe(expectedSubmit);
      expect(payload.questionForm.questions[0]).toMatchObject({
        id: 'website.goal',
        label: expectedQuestion,
        defaultValue: 'launch-product',
        options: [
          expect.objectContaining({ value: 'launch-product' }),
          expect.objectContaining({ value: 'sell-service' }),
          expect.objectContaining({ value: 'showcase-work' }),
        ],
      });
      expect(payload.questionForm.questions[0]?.options[0]?.label).not.toBe(
        'Launch a product',
      );

      const answers = Object.fromEntries(
        payload.questionForm.questions.map((question) => [
          question.id,
          [question.defaultValue],
        ]),
      );
      const confirmed = await handleMcpToolCall(
        'http://127.0.0.1:17456',
        'confirm_brief',
        {
          briefDraftId: payload.briefDraftId,
          nonce: payload.nonce,
          answers,
        },
        { briefStore },
      );

      expect(confirmed.structuredContent).toMatchObject({ locale });
      expect(String(confirmed.structuredContent?.summary)).toContain(
        expectedQuestion,
      );
      expect(confirmed.content[0]?.text).not.toContain('Brief confirmed.');
    },
  );

  it('falls back unsupported request locales to English', async () => {
    const collected = await handleMcpToolCall(
      'http://127.0.0.1:17456',
      'collect_brief',
      {
        artifactType: 'website',
        locale: 'fr-FR',
      },
      { briefStore: createLocalMcpBriefStore() },
    );

    expect(collected.structuredContent).toMatchObject({
      locale: 'en',
      questionForm: {
        title: 'Choose the website direction',
        submitLabel: 'Confirm brief',
      },
    });
  });

  it('keeps user-facing MCP copy on public Open Design product terms', () => {
    const visibleToolCopy = localMcpToolDefinitions()
      .flatMap((tool) => [
        tool.description,
        tool.annotations?.title,
        ...Object.values(tool.inputSchema.properties ?? {})
          .map((property) => property.description),
      ])
      .filter((value): value is string => typeof value === 'string')
      .join('\n');
    const visibleResourceCopy = localMcpResourceDefinitions()
      .flatMap((resource) => [
        resource.name,
        resource.title,
        resource.description,
      ])
      .filter((value): value is string => typeof value === 'string')
      .join('\n');
    const userFacingCopy = [
      visibleToolCopy,
      visibleResourceCopy,
      MCP_SERVER_INSTRUCTIONS,
    ].join('\n');

    expect(userFacingCopy).toContain('Open Design Cloud');
    expect(userFacingCopy).toContain('Local Codex');
    expect(userFacingCopy).toContain('Secure BYOK');
    expect(userFacingCopy).not.toMatch(/\b(?:Vela|AMR)\b/u);
    expect(userFacingCopy).not.toMatch(/agent\s*:\s*["']?[a-z]/iu);
  });
});
