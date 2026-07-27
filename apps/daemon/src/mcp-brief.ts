import {
  collectOpenDesignBrief,
  openDesignBriefCatalog,
  type OpenDesignBriefAnswers,
  type OpenDesignBriefArtifactType,
} from '@open-design/contracts';
import { randomBytes, randomUUID } from 'node:crypto';
import {
  type ExternalPluginContext,
  validateExternalPluginContext,
  validatePluginWorkflowId,
} from './mcp-observability.js';

const DEFAULT_BRIEF_TTL_MS = 15 * 60 * 1000;

type UnknownRecord = Record<string, unknown>;

export interface LocalMcpBriefStoreOptions {
  now?: () => number;
  ttlMs?: number;
}

interface StoredBriefDraft {
  artifactType: OpenDesignBriefArtifactType;
  projectTitle: string;
  knownAnswers: UnknownRecord;
  nonce: string;
  expiresAt: number;
  confirmation?: LocalMcpBriefConfirmation;
  confirmationAnswersDigest?: string;
  pluginWorkflowId?: string;
  externalPluginContext?: ExternalPluginContext;
  briefState?: 'confirmed' | 'skipped';
}

export interface LocalMcpBriefForm {
  view: 'brief-form';
  artifactType: OpenDesignBriefArtifactType;
  projectTitle: string;
  briefDraftId: string;
  nonce: string;
  expiresAt: number;
  pluginWorkflowId?: string;
  externalPluginContext?: ExternalPluginContext;
  questionForm: {
    id: 'open-design-brief';
    title: string;
    description: string;
    submitLabel: 'Confirm brief';
    questions: Array<{
      id: string;
      label: string;
      description: string;
      type: 'radio';
      required: true;
      allowCustom: false;
      defaultValue: string;
      options: Array<{
        value: string;
        label: string;
        description: string;
      }>;
    }>;
  };
}

export interface LocalMcpBriefConfirmation {
  view: 'brief-confirmed';
  artifactType: OpenDesignBriefArtifactType;
  projectTitle: string;
  briefDraftId: string;
  briefConfirmationId: string;
  confirmedAt: number;
  answers: OpenDesignBriefAnswers;
  summary: string;
  pluginWorkflowId?: string;
  externalPluginContext?: ExternalPluginContext;
}

export interface LocalMcpBriefStore {
  collect(input: UnknownRecord): LocalMcpBriefForm;
  confirm(input: UnknownRecord): LocalMcpBriefConfirmation;
  attributionForDraft(
    briefDraftId: unknown,
  ): {
    pluginWorkflowId: string;
    externalPluginContext: ExternalPluginContext;
  } | null;
  briefStateForWorkflow(
    pluginWorkflowId: unknown,
  ): 'confirmed' | 'skipped' | 'not_applicable';
}

export function createLocalMcpBriefStore(
  options: LocalMcpBriefStoreOptions = {},
): LocalMcpBriefStore {
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? DEFAULT_BRIEF_TTL_MS;
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
    throw new Error('brief ttlMs must be a positive integer');
  }
  const drafts = new Map<string, StoredBriefDraft>();

  const pruneExpired = (at: number) => {
    for (const [id, draft] of drafts) {
      if (draft.expiresAt <= at) drafts.delete(id);
    }
  };

  return {
    attributionForDraft(briefDraftId) {
      if (typeof briefDraftId !== 'string') return null;
      const draft = drafts.get(briefDraftId);
      if (!draft?.pluginWorkflowId || !draft.externalPluginContext) return null;
      return {
        pluginWorkflowId: draft.pluginWorkflowId,
        externalPluginContext: draft.externalPluginContext,
      };
    },
    briefStateForWorkflow(pluginWorkflowId) {
      if (typeof pluginWorkflowId !== 'string') return 'not_applicable';
      for (const draft of drafts.values()) {
        if (
          draft.pluginWorkflowId === pluginWorkflowId
          && draft.briefState
        ) {
          return draft.briefState;
        }
      }
      return 'not_applicable';
    },
    collect(input) {
      const at = now();
      pruneExpired(at);
      const artifactType = readArtifactType(input.artifactType);
      const projectTitle = readProjectTitle(input.projectTitle);
      const knownAnswers = readAnswerRecord(input.knownAnswers, 'knownAnswers');
      const skip = input.skip === true;
      const hasPluginContext = Object.prototype.hasOwnProperty.call(
        input,
        'externalPluginContext',
      );
      const externalPluginContext = hasPluginContext
        ? validateExternalPluginContext(input.externalPluginContext)
        : undefined;
      const pluginWorkflowId = hasPluginContext
        ? validatePluginWorkflowId(input.pluginWorkflowId)
        : undefined;
      if (!hasPluginContext && input.pluginWorkflowId !== undefined) {
        throw new Error(
          'pluginWorkflowId requires a validated externalPluginContext',
        );
      }
      const decision = collectOpenDesignBrief({
        artifactType,
        knownAnswers,
        skip,
      });
      const briefDraftId = randomUUID();
      const nonce = randomBytes(24).toString('hex');
      const expiresAt = at + ttlMs;
      drafts.set(briefDraftId, {
        artifactType,
        projectTitle,
        knownAnswers: { ...decision.answers },
        nonce,
        expiresAt,
        ...(pluginWorkflowId ? { pluginWorkflowId } : {}),
        ...(externalPluginContext ? { externalPluginContext } : {}),
        ...(pluginWorkflowId && skip ? { briefState: 'skipped' as const } : {}),
      });

      return {
        view: 'brief-form',
        artifactType,
        projectTitle,
        briefDraftId,
        nonce,
        expiresAt,
        ...(pluginWorkflowId ? { pluginWorkflowId } : {}),
        ...(externalPluginContext ? { externalPluginContext } : {}),
        questionForm: {
          id: 'open-design-brief',
          title: `Choose the ${artifactType.replaceAll('-', ' ')} direction`,
          description:
            'Choose one option for each decision. The same readable brief can be used with Open Design Cloud, Local Codex, or Local BYOK.',
          submitLabel: 'Confirm brief',
          questions: decision.questions.map((question) => ({
            id: question.id,
            label: question.label,
            description: question.description,
            type: question.type,
            required: question.required,
            allowCustom: question.allowCustom,
            defaultValue: question.defaultOptionId,
            options: question.options.map((candidate) => ({
              value: candidate.id,
              label: candidate.label,
              description: candidate.description,
            })),
          })),
        },
      };
    },

    confirm(input) {
      const at = now();
      pruneExpired(at);
      const briefDraftId = readRequiredString(
        input.briefDraftId,
        'briefDraftId',
      );
      const nonce = readRequiredString(input.nonce, 'nonce');
      const draft = drafts.get(briefDraftId);
      if (!draft) {
        throw new Error(
          'The Open Design brief has expired or is unknown. Call collect_brief again.',
        );
      }
      if (draft.nonce !== nonce) {
        throw new Error('The Open Design brief nonce is invalid.');
      }
      const submittedAnswers = readAnswerRecord(input.answers, 'answers');
      const mergedAnswers: UnknownRecord = {
        ...draft.knownAnswers,
        ...submittedAnswers,
      };
      const decision = collectOpenDesignBrief({
        artifactType: draft.artifactType,
        knownAnswers: mergedAnswers,
      });
      if (!decision.complete) {
        const missing = decision.questions.map((question) => question.id);
        throw new Error(
          `The Open Design brief is incomplete. Missing: ${missing.join(', ')}.`,
        );
      }
      const confirmationAnswersDigest = stableAnswerDigest(decision.answers);
      if (draft.confirmation) {
        if (draft.confirmationAnswersDigest !== confirmationAnswersDigest) {
          throw new Error(
            'This Open Design brief was already confirmed with different answers.',
          );
        }
        return draft.confirmation;
      }

      const confirmation: LocalMcpBriefConfirmation = {
        view: 'brief-confirmed',
        artifactType: draft.artifactType,
        projectTitle: draft.projectTitle,
        briefDraftId,
        briefConfirmationId: randomUUID(),
        confirmedAt: at,
        answers: decision.answers,
        summary: decision.summary,
        ...(draft.pluginWorkflowId
          ? { pluginWorkflowId: draft.pluginWorkflowId }
          : {}),
        ...(draft.externalPluginContext
          ? { externalPluginContext: draft.externalPluginContext }
          : {}),
      };
      draft.confirmation = confirmation;
      draft.confirmationAnswersDigest = confirmationAnswersDigest;
      if (draft.pluginWorkflowId && draft.briefState !== 'skipped') {
        draft.briefState = 'confirmed';
      }
      return confirmation;
    },
  };
}

function readArtifactType(value: unknown): OpenDesignBriefArtifactType {
  if (
    typeof value !== 'string'
    || !Object.hasOwn(openDesignBriefCatalog, value)
  ) {
    throw new Error(
      `artifactType must be one of: ${Object.keys(openDesignBriefCatalog).join(', ')}`,
    );
  }
  return value as OpenDesignBriefArtifactType;
}

function readProjectTitle(value: unknown): string {
  if (value === undefined) return 'Untitled Open Design artifact';
  const title = readRequiredString(value, 'projectTitle').trim();
  if (title.length > 256) {
    throw new Error('projectTitle must be at most 256 characters');
  }
  return title;
}

function readRequiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

function readAnswerRecord(value: unknown, field: string): UnknownRecord {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  return { ...(value as UnknownRecord) };
}

function stableAnswerDigest(answers: OpenDesignBriefAnswers): string {
  return JSON.stringify(
    Object.entries(answers)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => [key, [...value]]),
  );
}
