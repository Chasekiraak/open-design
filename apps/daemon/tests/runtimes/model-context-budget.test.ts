import { describe, expect, it } from 'vitest';

import {
  estimatePromptTokens,
  evaluateModelContextBudget,
} from '../../src/runtimes/model-context-budget.js';

describe('model context budget', () => {
  it('uses a conservative byte estimate for ASCII and CJK prompt text', () => {
    expect(estimatePromptTokens('a'.repeat(12))).toBe(4);
    expect(estimatePromptTokens('设计系统测试')).toBe(6);
  });

  it('blocks a Claude-family prompt before the provider rejects its 204800-token window', () => {
    const decision = evaluateModelContextBudget({
      prompt: 'x'.repeat(650_000),
      modelId: 'anthropic/claude-sonnet-4-5',
    });

    expect(decision.action).toBe('blocked');
    expect(decision.source).toBe('known_model_family');
    expect(decision.contextWindowTokens).toBe(204_800);
    expect(decision.estimatedPromptTokens).toBeGreaterThan(
      decision.inputBudgetTokens!,
    );
    expect(decision.error?.code).toBe('AGENT_PROMPT_TOO_LARGE');
  });

  it('recognizes dotted Bedrock Claude model ids when catalog metadata is absent', () => {
    const decision = evaluateModelContextBudget({
      prompt: 'x'.repeat(650_000),
      modelId: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
    });

    expect(decision).toMatchObject({
      action: 'blocked',
      source: 'known_model_family',
      contextWindowTokens: 204_800,
      error: { code: 'AGENT_PROMPT_TOO_LARGE' },
    });
  });

  it('blocks an oversized prompt selected through the built-in Sonnet alias', () => {
    const decision = evaluateModelContextBudget({
      prompt: 'x'.repeat(650_000),
      modelId: 'sonnet',
    });

    expect(decision).toMatchObject({
      action: 'blocked',
      source: 'known_model_family',
      modelId: 'sonnet',
      contextWindowTokens: 204_800,
      error: { code: 'AGENT_PROMPT_TOO_LARGE' },
    });
  });

  it('uses provider metadata and preserves output plus safety headroom', () => {
    const decision = evaluateModelContextBudget({
      prompt: 'short prompt',
      modelId: 'provider/model',
      metadata: {
        contextWindowTokens: 32_768,
        maxOutputTokens: 4_096,
      },
    });

    expect(decision).toMatchObject({
      action: 'within_budget',
      source: 'model_metadata',
      contextWindowTokens: 32_768,
      reservedOutputTokens: 4_096,
      safetyMarginTokens: 1_639,
      inputBudgetTokens: 27_033,
    });
  });

  it('stays observation-only when the selected model has no trustworthy limit', () => {
    expect(
      evaluateModelContextBudget({
        prompt: 'hello',
        modelId: 'provider/brand-new-model',
      }),
    ).toMatchObject({
      action: 'unmeasured',
      source: 'unknown',
      estimatedPromptTokens: 2,
    });
  });
});
