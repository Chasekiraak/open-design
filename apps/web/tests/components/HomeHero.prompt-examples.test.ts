import { describe, expect, it } from 'vitest';
import {
  HOME_LOCALIZED_PROMPT_EXAMPLE_CHIP_IDS,
  homeHeroChipPromptExamplesForLocale,
} from '../../src/components/HomeHero';
import { LOCALES } from '../../src/i18n/types';

describe('home hero prompt examples localization', () => {
  it('resolves the three primary visual-product prompts before More examples', () => {
    expect(homeHeroChipPromptExamplesForLocale('web-clone', 'en').slice(0, 3)).toEqual([
      'Recreate this website’s page structure and visual style.',
      'Use this website as visual reference and create a new page for my product.',
      'Recreate the page modules from the uploaded screenshot.',
    ]);
    expect(homeHeroChipPromptExamplesForLocale('landing-page', 'en')).toHaveLength(5);
    expect(homeHeroChipPromptExamplesForLocale('prototype', 'en')).toHaveLength(5);
    expect(homeHeroChipPromptExamplesForLocale('wireframe', 'en')).toHaveLength(4);
    expect(homeHeroChipPromptExamplesForLocale('deck', 'en')).toHaveLength(5);
  });

  it('resolves four localized media prompts in every supported locale', () => {
    for (const locale of LOCALES) {
      for (const chipId of HOME_LOCALIZED_PROMPT_EXAMPLE_CHIP_IDS) {
        const examples = homeHeroChipPromptExamplesForLocale(chipId, locale);
        expect(examples, `${locale}/${chipId}`).toHaveLength(4);
        for (const example of examples) {
          expect(example.trim().length, `${locale}/${chipId} non-empty`).toBeGreaterThan(0);
        }
      }
    }
  });

  it('does not fall back to English media example strings for a non-English locale', () => {
    for (const locale of LOCALES) {
      if (locale === 'en') continue;
      for (const chipId of HOME_LOCALIZED_PROMPT_EXAMPLE_CHIP_IDS) {
        const localized = homeHeroChipPromptExamplesForLocale(chipId, locale);
        const english = homeHeroChipPromptExamplesForLocale(chipId, 'en');
        expect(
          localized,
          `${locale}/${chipId} must be localized, not the English fallback`,
        ).not.toEqual(english);
      }
    }
  });
});
