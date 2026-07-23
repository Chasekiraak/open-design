// Home main-flow heuristics.
//
// This module deliberately stays DOM- and React-free: the Home hero can render
// the returned recommendation, while tests can exercise the decision order
// without mounting the composer or faking browser storage.

export type HomeOnboardingRole = 'designer' | 'marketing' | null;

export interface HomeRecommendationSignals {
  role: HomeOnboardingRole;
  prompt: string;
  hasReferenceFiles: boolean;
  hasDesignSystem: boolean;
  recentChipId: string | null;
}

export interface HomeTemplateRecommendation {
  primaryChipId: string | null;
  secondaryChipId: string | null;
  emptyStateMessage: string | null;
}

export interface HomeHeroCapability {
  id: 'design-system' | 'visual-references' | 'project-files' | 'templates';
  label: string;
  subtitle: string;
}

const HOME_HERO_CAPABILITIES: readonly HomeHeroCapability[] = [
  {
    id: 'design-system',
    label: 'design system',
    subtitle: 'Keep every screen aligned with your existing visual language.',
  },
  {
    id: 'visual-references',
    label: 'visual references',
    subtitle: 'Turn screenshots and inspiration into a clear visual direction.',
  },
  {
    id: 'project-files',
    label: 'project files',
    subtitle: 'Build from the work and context already in your workspace.',
  },
  {
    id: 'templates',
    label: 'templates',
    subtitle: 'Start from a proven output instead of a blank canvas.',
  },
];

const URL_PATTERN = /(?:https?:\/\/|www\.)[^\s]+/iu;

/**
 * Resolve the single primary template suggestion, with an intentionally mild
 * secondary option only for role-backed first-run recommendations. We do not
 * infer a role from a bare Home session: context is enough to suggest a path,
 * but not enough to make a personality claim.
 */
export function resolveHomeTemplateRecommendation(
  signals: HomeRecommendationSignals,
): HomeTemplateRecommendation {
  if (signals.role === 'designer') {
    return { primaryChipId: 'prototype', secondaryChipId: 'wireframe', emptyStateMessage: null };
  }
  if (signals.role === 'marketing') {
    return { primaryChipId: 'landing-page', secondaryChipId: 'deck', emptyStateMessage: null };
  }
  if (URL_PATTERN.test(signals.prompt)) {
    return { primaryChipId: 'web-clone', secondaryChipId: null, emptyStateMessage: null };
  }
  if (signals.hasReferenceFiles) {
    return { primaryChipId: 'prototype', secondaryChipId: null, emptyStateMessage: null };
  }
  if (signals.hasDesignSystem) {
    return { primaryChipId: 'prototype', secondaryChipId: 'landing-page', emptyStateMessage: null };
  }
  if (signals.recentChipId) {
    return { primaryChipId: signals.recentChipId, secondaryChipId: null, emptyStateMessage: null };
  }
  return {
    primaryChipId: null,
    secondaryChipId: null,
    emptyStateMessage: 'Choose what you want to create to get started.',
  };
}

/**
 * The capability carousel skips context the user has already supplied, and
 * changes only the initial ordering for the two explicitly reported roles.
 */
export function heroCapabilitiesForHome(
  role: HomeOnboardingRole,
  options: { hasDesignSystem: boolean; hasReferenceFiles: boolean },
): HomeHeroCapability[] {
  const visible = HOME_HERO_CAPABILITIES.filter((capability) => {
    if (capability.id === 'design-system') return !options.hasDesignSystem;
    if (capability.id === 'visual-references') return !options.hasReferenceFiles;
    return true;
  });
  const firstId = role === 'marketing'
    ? (visible.some((item) => item.id === 'templates') ? 'templates' : 'visual-references')
    : role === 'designer'
      ? 'design-system'
      : null;
  if (!firstId) return visible;
  const first = visible.find((item) => item.id === firstId);
  return first ? [first, ...visible.filter((item) => item !== first)] : visible;
}

export type HomeModeSuggestion = 'chat' | 'plan' | null;

/** A suggestion only — Home never changes an authored mode selection by itself. */
export function inferHomeModeSuggestion(prompt: string): HomeModeSuggestion {
  const normalized = prompt.trim().toLowerCase();
  if (!normalized) return null;
  if (/(先帮我梳理页面结构|写设计\s*brief|页面结构|设计\s*brief|page structure|design brief)/iu.test(normalized)) {
    return 'plan';
  }
  if (/(帮我想想|分析一下|给建议|帮我分析|help me think|analy[sz]e|give (?:me )?advice)/iu.test(normalized)) {
    return 'chat';
  }
  return null;
}

/** Map a recent project back to the template card closest to its output. */
export function recentProjectChipId(input: {
  kind?: string | null;
  intent?: string | null;
} | null | undefined): string | null {
  if (!input) return null;
  if (input.intent === 'web-clone') return 'web-clone';
  if (input.kind === 'deck') return 'deck';
  if (input.kind === 'prototype') return 'prototype';
  return null;
}
