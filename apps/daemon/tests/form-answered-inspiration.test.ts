import { describe, expect, it } from 'vitest';

import {
  FORM_ANSWERED_GENERIC_OVERRIDE,
  FORM_ANSWERED_INSPIRATION_OVERRIDE,
  FORM_ANSWERED_SYSTEM_OVERRIDE,
  composeChatUserRequestForAgent,
  resolveFormAnsweredOverride,
} from '../src/server.js';
import {
  INSPIRATION_FLOW_STEP,
  pendingPromptFlowStep,
  type PromptFlowStep,
} from '../src/prompts/flow-steps.js';
import { INSPIRATION_STEP_GUIDANCE, composeSystemPrompt } from '../src/prompts/system.js';

// Red spec for the missing inspiration step after the discovery brief
// (Superdesign-style flow: brief answered → reference picker → build).
//
// The regression this pins: on the `[form answers — discovery]` turn the
// daemon injected FORM_ANSWERED_SYSTEM_OVERRIDE, which forbade a
// `<question-form>` tag of ANY id and directed the model to build
// immediately — so the `## Inspiration step` section that
// composeSystemPrompt had just composed for the same ungrounded run could
// never execute, and generation started without the picker.
//
// The fix is deliberately pluggable: flow steps are data
// (prompts/flow-steps.ts), the daemon detects the pending step generically
// from the composed prompt + transcript, and the route stays free of any
// step-specific wiring so later stages (research, plan, …) register the
// same way.

const UNGROUNDED_PROMPT = composeSystemPrompt({});
const DISCOVERY_ANSWER_TURN = [
  '[form answers — discovery]',
  '- output: Slide deck / pitch',
  '- brand: Pick a direction for me [value: pick_direction]',
].join('\n');
const TRANSCRIPT_WITHOUT_INSPIRATION = [
  '## user',
  'Design an agent-native keynote.',
  '',
  '## assistant',
  '<question-form id="discovery" title="Quick brief — 30 seconds"></question-form>',
  '',
  '## user',
  DISCOVERY_ANSWER_TURN,
].join('\n');

describe('pendingPromptFlowStep', () => {
  it('detects the inspiration step when its section is composed and no picker was shown yet', () => {
    expect(UNGROUNDED_PROMPT).toContain(INSPIRATION_STEP_GUIDANCE);
    expect(
      pendingPromptFlowStep({
        composedSystemPrompt: UNGROUNDED_PROMPT,
        transcript: TRANSCRIPT_WITHOUT_INSPIRATION,
      }),
    ).toBe(INSPIRATION_FLOW_STEP);
  });

  it('returns null when the run is grounded (no Inspiration step composed)', () => {
    const grounded = composeSystemPrompt({
      designSystemTitle: 'Editorial',
      designSystemBody: '# Editorial\n\n--accent: #101010',
    });
    expect(
      pendingPromptFlowStep({
        composedSystemPrompt: grounded,
        transcript: TRANSCRIPT_WITHOUT_INSPIRATION,
      }),
    ).toBe(null);
  });

  it('returns null once the conversation already showed the inspiration picker', () => {
    const withPicker =
      TRANSCRIPT_WITHOUT_INSPIRATION +
      '\n\n## assistant\n<question-form id="inspiration" title="Pick a reference"></question-form>';
    expect(
      pendingPromptFlowStep({
        composedSystemPrompt: UNGROUNDED_PROMPT,
        transcript: withPicker,
      }),
    ).toBe(null);
  });

  it('returns null once the inspiration answers landed (form markup trimmed from transcript)', () => {
    const withAnswers =
      TRANSCRIPT_WITHOUT_INSPIRATION +
      '\n\n## user\n[form answers — inspiration]\n- Ground this task in a reference: (skipped)';
    expect(
      pendingPromptFlowStep({
        composedSystemPrompt: UNGROUNDED_PROMPT,
        transcript: withAnswers,
      }),
    ).toBe(null);
  });

  it('resolves future steps from the same registry seam without daemon changes', () => {
    const researchStep: PromptFlowStep = {
      id: 'research',
      heading: '\n## Research step',
      formAnsweredOverride: '## OVERRIDE — research step next\n',
      transitionLine: 'Emit the research form next.',
    };
    const prompt = 'preamble\n\n## Research step — dig before building\n…';
    expect(
      pendingPromptFlowStep({
        composedSystemPrompt: prompt,
        transcript: '## user\nbrief',
        steps: [researchStep],
      }),
    ).toBe(researchStep);
    expect(
      pendingPromptFlowStep({
        composedSystemPrompt: prompt,
        transcript: '## assistant\n<question-form id="research"></question-form>',
        steps: [researchStep],
      }),
    ).toBe(null);
  });
});

describe('resolveFormAnsweredOverride', () => {
  it('uses the visual-source priority after inspiration is answered', () => {
    expect(resolveFormAnsweredOverride({ formId: 'inspiration', pendingFlowStep: null })).toBe(
      FORM_ANSWERED_INSPIRATION_OVERRIDE,
    );
    expect(
      resolveFormAnsweredOverride({ formId: 'inspiration', pendingFlowStep: INSPIRATION_FLOW_STEP }),
    ).toBe(FORM_ANSWERED_INSPIRATION_OVERRIDE);
    const imagePriority = FORM_ANSWERED_INSPIRATION_OVERRIDE.indexOf('image references');
    const templatePriority = FORM_ANSWERED_INSPIRATION_OVERRIDE.indexOf('selected Design template');
    const designSystemPriority = FORM_ANSWERED_INSPIRATION_OVERRIDE.indexOf(
      'selected Style / design system',
    );
    expect(imagePriority).toBeGreaterThan(-1);
    expect(templatePriority).toBeGreaterThan(imagePriority);
    expect(designSystemPriority).toBeGreaterThan(templatePriority);
    expect(FORM_ANSWERED_INSPIRATION_OVERRIDE).toContain('selected Design');
    expect(FORM_ANSWERED_INSPIRATION_OVERRIDE).toContain('selected Style');
    expect(FORM_ANSWERED_INSPIRATION_OVERRIDE).toContain('never override');
  });

  it('routes brief answers to the pending flow step override', () => {
    expect(
      resolveFormAnsweredOverride({ formId: 'discovery', pendingFlowStep: INSPIRATION_FLOW_STEP }),
    ).toBe(INSPIRATION_FLOW_STEP.formAnsweredOverride);
    expect(
      resolveFormAnsweredOverride({ formId: 'task-type', pendingFlowStep: INSPIRATION_FLOW_STEP }),
    ).toBe(INSPIRATION_FLOW_STEP.formAnsweredOverride);
  });

  it('routes brief answers with no pending step to the build-now override', () => {
    expect(resolveFormAnsweredOverride({ formId: 'discovery', pendingFlowStep: null })).toBe(
      FORM_ANSWERED_SYSTEM_OVERRIDE,
    );
  });

  it('keeps the generic override for other non-brief form ids', () => {
    expect(resolveFormAnsweredOverride({ formId: 'preferences', pendingFlowStep: null })).toBe(
      FORM_ANSWERED_GENERIC_OVERRIDE,
    );
  });

  it('returns no override for a non-form turn', () => {
    expect(resolveFormAnsweredOverride({ formId: null, pendingFlowStep: INSPIRATION_FLOW_STEP })).toBe('');
  });
});

describe('inspiration flow step override literal', () => {
  it('directs this turn to the single inspiration picker instead of building', () => {
    const override = INSPIRATION_FLOW_STEP.formAnsweredOverride;
    expect(override).toContain('<question-form id="inspiration">');
    expect(override).toContain('stop the turn');
    // The brief re-ask stays forbidden — the ban is scoped, not "any id",
    // because the required output of this very turn IS a question-form.
    expect(override).toContain('`discovery`');
    expect(override).toContain('`task-type`');
    expect(override).not.toContain('tag of any id');
  });

  it('keeps the Branch A escape hatch: a provided/promised brand source skips the picker', () => {
    expect(INSPIRATION_FLOW_STEP.formAnsweredOverride).toContain('brand_spec');
    expect(INSPIRATION_FLOW_STEP.formAnsweredOverride).toContain('reference_match');
  });

  it('never claims an <artifact> contract the filesystem charter forbids', () => {
    expect(INSPIRATION_FLOW_STEP.formAnsweredOverride).not.toContain('<artifact>');
  });
});

describe('FORM_ANSWERED_SYSTEM_OVERRIDE stays truthful for both charter variants', () => {
  it('qualifies RULE labels so slim-charter runs do not read them as invented', () => {
    // The slim core charter has no RULE 1/2/3 headings; an override that
    // asserts them unconditionally reads as prompt injection (observed:
    // Fable flagged the block as untrusted and ignored it).
    expect(FORM_ANSWERED_SYSTEM_OVERRIDE).toContain('slim charter');
  });

  it('scopes the <artifact> directive to the handoff contract instead of demanding it', () => {
    // Filesystem runs must never emit a source-code <artifact> block.
    expect(FORM_ANSWERED_SYSTEM_OVERRIDE).toContain('only when');
    expect(FORM_ANSWERED_SYSTEM_OVERRIDE).not.toContain('RULE 3 (emit the `<artifact>` block');
  });
});

describe('composeChatUserRequestForAgent — flow-step-aware transition', () => {
  it('redirects the brief-answered transition to the picker when the step is pending', () => {
    const prompt = composeChatUserRequestForAgent(
      TRANSCRIPT_WITHOUT_INSPIRATION,
      DISCOVERY_ANSWER_TURN,
      { pendingFlowStep: INSPIRATION_FLOW_STEP },
    );
    expect(prompt).toContain('The user has answered the discovery form. Do not emit another discovery form.');
    expect(prompt).toContain('<question-form id="inspiration">');
    expect(prompt).not.toContain('build now instead of asking another brief');
  });

  it('keeps the build-now transition when no step is pending', () => {
    const prompt = composeChatUserRequestForAgent(
      TRANSCRIPT_WITHOUT_INSPIRATION,
      DISCOVERY_ANSWER_TURN,
      { pendingFlowStep: null },
    );
    expect(prompt).toContain('Continue with RULE 2 / RULE 3 now.');
    expect(prompt).not.toContain('<question-form id="inspiration">');
  });

  it('defaults to the build-now transition when the option is absent (legacy callers)', () => {
    const prompt = composeChatUserRequestForAgent(
      TRANSCRIPT_WITHOUT_INSPIRATION,
      DISCOVERY_ANSWER_TURN,
    );
    expect(prompt).toContain('Continue with RULE 2 / RULE 3 now.');
  });
});
