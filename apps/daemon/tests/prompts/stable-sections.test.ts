import { describe, expect, it } from 'vitest';

import {
  computeStableSectionHashes,
  describeChangedStableSections,
  diffStableSections,
  parseStableSections,
  serializeStableSections,
  STABLE_SECTION_NAMES,
} from '../../src/prompts/stable-sections.js';

const BASE = {
  agentId: 'claude',
  memoryBody: '## Personal memory\n\n- prefers terse copy',
  sessionMode: 'design',
  designSystemBody: '# Acme\n\n- primary: #000',
  skillBody: '# Skill\n\nbuild a deck',
  locale: 'en',
  runtimeToolPrompt: '## Tools\n\n- od_read',
  clientSystemPrompt: 'be helpful',
};

describe('computeStableSectionHashes', () => {
  it('is deterministic for the same inputs', () => {
    expect(computeStableSectionHashes(BASE)).toEqual(computeStableSectionHashes({ ...BASE }));
  });

  it('ignores the order keys were built in', () => {
    const reordered = Object.fromEntries(Object.entries(BASE).reverse());
    expect(computeStableSectionHashes(reordered)).toEqual(computeStableSectionHashes(BASE));
  });

  it('hashes nested objects by value, not by key insertion order', () => {
    const a = { ...BASE, metadata: { kind: 'deck', fidelity: 'high' } };
    const b = { ...BASE, metadata: { fidelity: 'high', kind: 'deck' } };
    expect(computeStableSectionHashes(a).intent).toBe(computeStableSectionHashes(b).intent);
  });

  it('omits a section whose inputs are all absent rather than hashing it as empty', () => {
    const hashes = computeStableSectionHashes({ memoryBody: 'x' });
    expect(hashes.memory).toBeTypeOf('string');
    expect(hashes).not.toHaveProperty('design-system');
    expect(hashes).not.toHaveProperty('critique');
  });

  it('leaves the mcp section dormant unless that input is present', () => {
    expect(computeStableSectionHashes(BASE)).not.toHaveProperty('mcp');
    expect(computeStableSectionHashes({ ...BASE, connectedExternalMcp: [{ id: 'github' }] }))
      .toHaveProperty('mcp');
  });
});

describe('diffStableSections', () => {
  it('names only the section whose input moved', () => {
    const before = computeStableSectionHashes(BASE);
    const after = computeStableSectionHashes({ ...BASE, memoryBody: `${BASE.memoryBody}\n- likes dark mode` });
    expect(diffStableSections(before, after)).toEqual(['memory']);
  });

  it('names every section that moved, in declaration order', () => {
    const before = computeStableSectionHashes(BASE);
    const after = computeStableSectionHashes({
      ...BASE,
      memoryBody: 'changed',
      sessionMode: 'plan',
      designSystemBody: 'changed',
    });
    expect(diffStableSections(before, after)).toEqual(['memory', 'mode', 'design-system']);
  });

  it('treats a section appearing or disappearing as a change', () => {
    expect(diffStableSections(
      computeStableSectionHashes({ agentId: 'claude' }),
      computeStableSectionHashes({ agentId: 'claude', memoryBody: 'first fact' }),
    )).toEqual(['memory']);
    expect(diffStableSections(
      computeStableSectionHashes({ agentId: 'claude', memoryBody: 'a fact' }),
      computeStableSectionHashes({ agentId: 'claude' }),
    )).toEqual(['memory']);
  });

  it('reports nothing when the inputs are unchanged', () => {
    const hashes = computeStableSectionHashes(BASE);
    expect(diffStableSections(hashes, hashes)).toEqual([]);
  });

  it('treats a missing baseline as everything-changed', () => {
    expect(diffStableSections(null, computeStableSectionHashes(BASE)).length).toBeGreaterThan(0);
  });
});

describe('describeChangedStableSections', () => {
  it('reports the changed section for an attributable drift', () => {
    const before = computeStableSectionHashes(BASE);
    const after = computeStableSectionHashes({ ...BASE, skillBody: 'a different skill' });
    expect(describeChangedStableSections(before, after)).toEqual(['skill']);
  });

  it('reports unattributed when the prefix drifted but no tracked section did', () => {
    const hashes = computeStableSectionHashes(BASE);
    expect(describeChangedStableSections(hashes, hashes)).toEqual(['unattributed']);
  });
});

describe('serializeStableSections / parseStableSections', () => {
  it('round-trips', () => {
    const hashes = computeStableSectionHashes(BASE);
    expect(parseStableSections(serializeStableSections(hashes))).toEqual(hashes);
  });

  it('degrades safely for legacy or malformed stored values', () => {
    expect(parseStableSections(null)).toBeNull();
    expect(parseStableSections('')).toBeNull();
    expect(parseStableSections('{not json')).toBeNull();
    expect(parseStableSections('[]')).toBeNull();
    expect(parseStableSections('"a string"')).toBeNull();
  });

  it('drops entries that are not known sections with string digests', () => {
    expect(parseStableSections(
      JSON.stringify({ memory: 'abc123', unknownSection: 'def', mode: 42 }),
    )).toEqual({ memory: 'abc123' });
  });
});

describe('section table', () => {
  it('covers the high-signal drift sections', () => {
    for (const name of ['memory', 'intent', 'mode', 'design-system', 'skill', 'runtime']) {
      expect(STABLE_SECTION_NAMES).toContain(name);
    }
  });
});
