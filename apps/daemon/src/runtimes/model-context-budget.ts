import type { ModelMetadata } from '@open-design/contracts';
import type { RuntimePromptBudgetError } from './types.js';

export type ModelContextBudgetSource =
  | 'model_metadata'
  | 'known_model_family'
  | 'unknown';

export type ModelContextBudgetAction =
  | 'unmeasured'
  | 'within_budget'
  | 'blocked'
  | 'rollover';

export interface ModelContextBudgetDecision {
  action: ModelContextBudgetAction;
  source: ModelContextBudgetSource;
  modelId: string | null;
  estimatedPromptTokens: number;
  contextWindowTokens?: number;
  reservedOutputTokens?: number;
  safetyMarginTokens?: number;
  inputBudgetTokens?: number;
  budgetRatio?: number;
  error?: RuntimePromptBudgetError;
}

const DEFAULT_OUTPUT_RESERVE_TOKENS = 8_192;
const MIN_SAFETY_MARGIN_TOKENS = 1_024;
const SAFETY_MARGIN_RATIO = 0.05;

export function estimatePromptTokens(prompt: string): number {
  // UTF-8 bytes / 3 deliberately overestimates normal English/code (usually
  // closer to 4 bytes per token) while remaining realistic for CJK text.
  // This is a launch guard, not billing telemetry: a small false-positive
  // margin is safer than forwarding a request the provider will reject.
  return Math.ceil(Buffer.byteLength(prompt, 'utf8') / 3);
}

function positiveInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
    ? value
    : null;
}

function knownModelFamilyContextWindow(modelId: string | null): number | null {
  if (!modelId) return null;
  const normalized = modelId.toLowerCase();
  // OpenCode/provider errors in the 0.15.0 incident report a 204,800-token
  // ceiling for Claude-family routes. Keep this fallback narrow; every other
  // model remains observation-only until its live catalog supplies metadata.
  if (/(?:^|[/.])claude[-_]/u.test(normalized)) return 204_800;
  return null;
}

export function evaluateModelContextBudget({
  prompt,
  modelId,
  metadata,
}: {
  prompt: string;
  modelId: string | null | undefined;
  metadata?: ModelMetadata | null;
}): ModelContextBudgetDecision {
  const normalizedModel = typeof modelId === 'string' && modelId.trim()
    ? modelId.trim()
    : null;
  const estimatedPromptTokens = estimatePromptTokens(prompt);
  const metadataWindow = positiveInteger(metadata?.contextWindowTokens);
  const familyWindow = knownModelFamilyContextWindow(normalizedModel);
  const contextWindowTokens = metadataWindow ?? familyWindow;
  const source: ModelContextBudgetSource = metadataWindow
    ? 'model_metadata'
    : familyWindow
      ? 'known_model_family'
      : 'unknown';

  if (!contextWindowTokens) {
    return {
      action: 'unmeasured',
      source,
      modelId: normalizedModel,
      estimatedPromptTokens,
    };
  }

  const declaredOutput = positiveInteger(metadata?.maxOutputTokens);
  const reservedOutputTokens = Math.min(
    declaredOutput ?? DEFAULT_OUTPUT_RESERVE_TOKENS,
    Math.floor(contextWindowTokens * 0.25),
  );
  const safetyMarginTokens = Math.max(
    MIN_SAFETY_MARGIN_TOKENS,
    Math.ceil(contextWindowTokens * SAFETY_MARGIN_RATIO),
  );
  const inputBudgetTokens = Math.max(
    1,
    contextWindowTokens - reservedOutputTokens - safetyMarginTokens,
  );
  const budgetRatio = estimatedPromptTokens / inputBudgetTokens;
  const blocked = estimatedPromptTokens > inputBudgetTokens;

  return {
    action: blocked ? 'blocked' : 'within_budget',
    source,
    modelId: normalizedModel,
    estimatedPromptTokens,
    contextWindowTokens,
    reservedOutputTokens,
    safetyMarginTokens,
    inputBudgetTokens,
    budgetRatio,
    ...(blocked
      ? {
          error: {
            code: 'AGENT_PROMPT_TOO_LARGE',
            limit: inputBudgetTokens,
            message:
              `The composed prompt is estimated at ${estimatedPromptTokens} tokens, above the safe input budget of ${inputBudgetTokens} tokens for ${normalizedModel ?? 'the selected model'} ` +
              `(context window ${contextWindowTokens}; ${reservedOutputTokens} reserved for output; ${safetyMarginTokens} safety margin). ` +
              'Shorten the conversation, remove large attachments, or start a new conversation.',
          },
        }
      : {}),
  };
}
