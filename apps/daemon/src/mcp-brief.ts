import {
  collectOpenDesignBrief,
  openDesignBriefCatalog,
  type OpenDesignBriefAnswers,
  type OpenDesignBriefArtifactType,
} from '@open-design/contracts';
import { randomBytes, randomUUID } from 'node:crypto';

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
}

export interface LocalMcpBriefForm {
  view: 'brief-form';
  artifactType: OpenDesignBriefArtifactType;
  projectTitle: string;
  briefDraftId: string;
  nonce: string;
  expiresAt: number;
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
}

export interface LocalMcpBriefStore {
  collect(input: UnknownRecord): LocalMcpBriefForm;
  confirm(input: UnknownRecord): LocalMcpBriefConfirmation;
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
    collect(input) {
      const at = now();
      pruneExpired(at);
      const artifactType = readArtifactType(input.artifactType);
      const projectTitle = readProjectTitle(input.projectTitle);
      const knownAnswers = readAnswerRecord(input.knownAnswers, 'knownAnswers');
      const skip = input.skip === true;
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
      });

      return {
        view: 'brief-form',
        artifactType,
        projectTitle,
        briefDraftId,
        nonce,
        expiresAt,
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
      };
      draft.confirmation = confirmation;
      draft.confirmationAnswersDigest = confirmationAnswersDigest;
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
