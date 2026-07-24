import { describe, expect, it } from 'vitest';

import {
  createLocalMcpBriefStore,
  handleMcpToolCall,
  localMcpResourceDefinitions,
  localMcpToolDefinitions,
} from '../src/mcp.js';

describe('local Open Design MCP brief app', () => {
  it('exposes collect_brief through the canonical MCP Apps resource', () => {
    const collectBrief = localMcpToolDefinitions().find(
      (tool) => tool.name === 'collect_brief',
    );

    expect(collectBrief).toMatchObject({
      name: 'collect_brief',
      _meta: {
        ui: {
          resourceUri: 'ui://open-design-cloud/artifact-card-v1.html',
        },
        'ui/resourceUri': 'ui://open-design-cloud/artifact-card-v1.html',
        'openai/outputTemplate': 'ui://open-design-cloud/artifact-card-v1.html',
      },
    });
    expect(localMcpResourceDefinitions()).toContainEqual(
      expect.objectContaining({
        uri: 'ui://open-design-cloud/artifact-card-v1.html',
        mimeType: 'text/html;profile=mcp-app',
      }),
    );
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
});
