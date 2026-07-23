import { describe, expect, it } from 'vitest';
import {
  heroCapabilitiesForHome,
  inferHomeModeSuggestion,
  recentProjectChipId,
  resolveHomeTemplateRecommendation,
} from '../src/components/home-hero/main-flow';

describe('Home main-flow recommendations', () => {
  it('gives designers prototype first and wireframe second', () => {
    expect(resolveHomeTemplateRecommendation({
      role: 'designer',
      prompt: '',
      hasReferenceFiles: false,
      hasDesignSystem: false,
      recentChipId: null,
    })).toMatchObject({ primaryChipId: 'prototype', secondaryChipId: 'wireframe' });
  });

  it('gives marketing users the zero-to-one landing-page path', () => {
    expect(resolveHomeTemplateRecommendation({
      role: 'marketing',
      prompt: '',
      hasReferenceFiles: false,
      hasDesignSystem: false,
      recentChipId: null,
    })).toMatchObject({ primaryChipId: 'landing-page', secondaryChipId: 'deck' });
  });

  it('uses only explicit context when no onboarding role exists', () => {
    expect(resolveHomeTemplateRecommendation({
      role: null,
      prompt: 'Use https://example.com as the starting point',
      hasReferenceFiles: true,
      hasDesignSystem: true,
      recentChipId: 'deck',
    }).primaryChipId).toBe('web-clone');

    expect(resolveHomeTemplateRecommendation({
      role: null,
      prompt: '',
      hasReferenceFiles: false,
      hasDesignSystem: false,
      recentChipId: null,
    })).toMatchObject({
      primaryChipId: null,
      emptyStateMessage: 'Choose what you want to create to get started.',
    });
  });
});

describe('Home Hero capability carousel', () => {
  it('starts designers with design systems and marketing with templates', () => {
    expect(heroCapabilitiesForHome('designer', { hasDesignSystem: false, hasReferenceFiles: false })[0]?.id)
      .toBe('design-system');
    expect(heroCapabilitiesForHome('marketing', { hasDesignSystem: false, hasReferenceFiles: false })[0]?.id)
      .toBe('templates');
  });

  it('does not re-suggest selected context', () => {
    const ids = heroCapabilitiesForHome(null, { hasDesignSystem: true, hasReferenceFiles: true })
      .map((item) => item.id);
    expect(ids).not.toContain('design-system');
    expect(ids).not.toContain('visual-references');
  });
});

describe('Home mode suggestions', () => {
  it('suggests rather than decides Ask and Plan paths', () => {
    expect(inferHomeModeSuggestion('帮我想想这个方案')).toBe('chat');
    expect(inferHomeModeSuggestion('先帮我梳理页面结构，再写设计 Brief')).toBe('plan');
    expect(inferHomeModeSuggestion('Create a landing page')).toBeNull();
  });

  it('maps recent projects to a closest Home template without guessing', () => {
    expect(recentProjectChipId({ kind: 'deck' })).toBe('deck');
    expect(recentProjectChipId({ kind: 'prototype', intent: 'web-clone' })).toBe('web-clone');
    expect(recentProjectChipId({ kind: 'other' })).toBeNull();
  });
});
