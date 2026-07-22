import { createHash } from 'node:crypto';

const SECTION_INPUTS = {
  memory: ['memoryBody', 'memoryHooks'],
  intent: [
    'metadata',
    'template',
    'freeformDeckSignal',
    'mediaHintSignal',
    'platformHintSignal',
  ],
  mode: ['sessionMode', 'executionProfile', 'streamFormat'],
  'design-system': [
    'designSystemBody',
    'designSystemTitle',
    'designSystemUsageMd',
    'designSystemTokensCss',
    'designSystemComponentsManifest',
    'designSystemFixtureHtml',
    'designSystemPullIndex',
    'designSystemImportMode',
  ],
  skill: ['skillBody', 'skillName', 'skillMode', 'skillModes'],
  craft: ['craftBody', 'craftSections'],
  plugin: ['pluginBlock', 'activeStageBlocks'],
  instructions: ['userInstructions', 'projectInstructions'],
  locale: ['locale'],
  media: [
    'mediaExecution',
    'byokMediaDefaults',
    'audioVoiceOptions',
    'audioVoiceOptionsError',
  ],
  critique: ['critique', 'critiqueBrand', 'critiqueSkill'],
  mcp: ['connectedExternalMcp'],
  runtime: [
    'agentId',
    'includeCodexImagegenOverride',
    'promptCoreVariant',
    'runtimeToolPrompt',
  ],
  'client-system': ['clientSystemPrompt'],
} as const satisfies Readonly<Record<string, readonly string[]>>;

export type StableSectionName = keyof typeof SECTION_INPUTS;

export const STABLE_SECTION_NAMES = Object.keys(SECTION_INPUTS) as StableSectionName[];

export type StableSectionHashes = Readonly<Partial<Record<StableSectionName, string>>>;

export type StableChangedSection = StableSectionName | 'unattributed';

function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, val: unknown) => {
    if (val === null || typeof val !== 'object' || Array.isArray(val)) return val;
    return Object.fromEntries(
      Object.entries(val as Record<string, unknown>).sort(([a], [b]) =>
        a < b ? -1 : a > b ? 1 : 0,
      ),
    );
  });
}

function digest(value: unknown): string {
  return createHash('sha256').update(stableStringify(value), 'utf8').digest('hex').slice(0, 16);
}

export function computeStableSectionHashes(
  inputs: Readonly<Record<string, unknown>>,
): StableSectionHashes {
  const hashes: Partial<Record<StableSectionName, string>> = {};
  for (const section of STABLE_SECTION_NAMES) {
    const present = SECTION_INPUTS[section].filter((key) => inputs[key] !== undefined);
    if (present.length === 0) continue;
    hashes[section] = digest(present.map((key) => [key, inputs[key]]));
  }
  return hashes;
}

export function diffStableSections(
  storedSections: StableSectionHashes | null | undefined,
  currentSections: StableSectionHashes,
): StableSectionName[] {
  const stored = storedSections ?? {};
  return STABLE_SECTION_NAMES.filter((name) => stored[name] !== currentSections[name]);
}

export function describeChangedStableSections(
  storedSections: StableSectionHashes | null | undefined,
  currentSections: StableSectionHashes,
): StableChangedSection[] {
  const changed = diffStableSections(storedSections, currentSections);
  return changed.length > 0 ? changed : ['unattributed'];
}

export function serializeStableSections(sections: StableSectionHashes): string {
  return JSON.stringify(sections);
}

export function parseStableSections(raw: unknown): StableSectionHashes | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const hashes: Partial<Record<StableSectionName, string>> = {};
  for (const name of STABLE_SECTION_NAMES) {
    const value = (parsed as Record<string, unknown>)[name];
    if (typeof value === 'string' && value.length > 0) hashes[name] = value;
  }
  return hashes;
}
