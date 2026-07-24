import { describe, expect, it } from 'vitest';
import {
  heroCapabilitiesForHome,
  inferHomeModeSuggestion,
  orderHomeTemplateIds,
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

  it('moves role-matched types to the front without hiding the catalog', () => {
    const catalog = ['web-clone', 'landing-page', 'deck', 'prototype', 'wireframe', 'image'];

    expect(orderHomeTemplateIds('designer', catalog)).toEqual([
      'prototype',
      'wireframe',
      'web-clone',
      'landing-page',
      'deck',
      'image',
    ]);
    expect(orderHomeTemplateIds('marketing', catalog)).toEqual([
      'landing-page',
      'deck',
      'web-clone',
      'prototype',
      'wireframe',
      'image',
    ]);
    expect(orderHomeTemplateIds(null, catalog)).toEqual(catalog);
  });
});

describe('Home Hero capability carousel', () => {
  it('starts designers with design systems and marketing with templates', () => {
    expect(heroCapabilitiesForHome('designer')[0]?.id)
      .toBe('design-system');
    expect(heroCapabilitiesForHome('marketing')[0]?.id)
      .toBe('templates');
  });

  it('keeps every start path in the carousel after context is supplied', () => {
    const ids = heroCapabilitiesForHome(null).map((item) => item.id);
    expect(ids).toEqual(['design-system', 'visual-references', 'project-files', 'templates']);
  });

  it('uses a concise inspiration label for the reference-upload entry point', () => {
    const capability = heroCapabilitiesForHome(null).find((item) => item.id === 'visual-references');

    expect(capability?.label).toBe('inspiration');
  });

  it('uses a stable set of start-path labels and explanations', () => {
    expect(heroCapabilitiesForHome(null)).toEqual([
      {
        id: 'design-system',
        label: 'your design system',
        subtitle: 'Keep every screen aligned with your visual language.',
      },
      {
        id: 'visual-references',
        label: 'inspiration',
        subtitle: 'Turn references into a visual direction.',
      },
      {
        id: 'project-files',
        label: 'project files',
        subtitle: 'Build from work already in your workspace.',
      },
      {
        id: 'templates',
        label: 'a template',
        subtitle: 'Start from a proven structure, not a blank canvas.',
      },
    ]);
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
