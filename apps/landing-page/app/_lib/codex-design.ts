/*
 * Data model for the curated "Codex design" collection under
 * `/plugins/codex-design/`.
 *
 * Unlike the rest of `/plugins/*`, these are NOT Open Design bundled
 * plugins — they are real, external, verified skills and resources for
 * doing design work with OpenAI Codex (openai/skills, MengTo/Skills,
 * etc.). The collection positions Open Design as the home for designing
 * with Codex and drives to the client download + the curated
 * `awesome-codex-design` list.
 *
 * English is the baseline here; per-locale copy is layered on top via
 * `codex-design-i18n.ts` (falls back to English on any miss), matching
 * the `plugins-i18n.ts` strategy. Every entry below is verified against
 * a real upstream source — do not add anything that can't be linked.
 */

export const AWESOME_REPO_URL = 'https://github.com/nexu-io/awesome-codex-design';
export const OD_DOWNLOAD_URL = '/download/';
export const OD_GUIDE_HREF = '/agents/codex-design/';

export type CodexSkillCategory = 'Frontend & UI' | 'Figma → Code' | 'Design Systems';

export interface CodexSkillLink {
  readonly label: string;
  readonly url: string;
}

export interface CodexSkill {
  /** Route slug under /plugins/codex-design/<slug>/ */
  readonly slug: string;
  readonly name: string;
  readonly category: CodexSkillCategory;
  /** Short attribution shown as a badge: "Official" for openai/skills, else author. */
  readonly badge: string;
  /** One-line promise. */
  readonly tagline: string;
  /** Illustration under /plugins/codex-design/skills/<file>. */
  readonly image: string;
  /** 1–2 sentence "what it is". */
  readonly whatIsIt: string;
  /** Why it matters for *design* specifically (bullets). */
  readonly whyForDesign: readonly string[];
  /** How you run it with Codex — plain steps. */
  readonly howWithCodex: readonly string[];
  /** Optional worked example / when-to-reach-for-it note. */
  readonly example?: string;
  /** Canonical upstream source (repo / folder). */
  readonly source: CodexSkillLink;
  /** Optional extra reference (docs, author). */
  readonly reference?: CodexSkillLink;
}

export interface CodexCollection {
  readonly eyebrow: string;
  readonly heading: string;
  readonly lede: string;
  readonly stats: readonly { readonly value: string; readonly label: string }[];
  /** Intro paragraph above the skills grid. */
  readonly intro: string;
  /** "Why these" framing shown before the grid. */
  readonly categories: readonly { readonly key: CodexSkillCategory; readonly blurb: string }[];
}

export const CODEX_COLLECTION: CodexCollection = {
  eyebrow: 'Codex design',
  heading: 'The design skills that make Codex ship real UI',
  lede: 'OpenAI Codex writes working code — but left alone it defaults to safe fonts, average spacing, and centered Helvetica. This is a curated set of the skills, Figma pipelines, and design-system rules that give Codex taste. Install one, or run all of them inside Open Design.',
  stats: [
    { value: '6', label: 'flagship skills' },
    { value: '3', label: 'design workflows' },
    { value: 'Open', label: 'source & verified' },
  ],
  intro:
    'Every skill below is real and links to its source. They fall into three jobs: set aesthetic taste before code, bridge Figma and code, and lock your design system into rules the agent obeys.',
  categories: [
    {
      key: 'Frontend & UI',
      blurb: 'Override Codex’s default aesthetic decisions before a single line is written.',
    },
    {
      key: 'Figma → Code',
      blurb: 'Read a real Figma design and turn it into near-production frontend code.',
    },
    {
      key: 'Design Systems',
      blurb: 'Turn your tokens and components into rules Codex follows instead of inventing.',
    },
  ],
};

export const CODEX_SKILLS: readonly CodexSkill[] = [
  {
    slug: 'frontend-skill',
    name: 'Frontend skill',
    category: 'Frontend & UI',
    badge: 'Official',
    tagline: 'Give Codex taste before it writes a line.',
    image: '/plugins/codex-design/skills/frontend-skill.webp',
    whatIsIt:
      'The single highest-leverage design skill from OpenAI’s official catalog. It overrides Codex’s default aesthetic decisions before any code is written.',
    whyForDesign: [
      'Bans overused system fonts and forces a considered typeface choice.',
      'Requires a typography rationale, so spacing and hierarchy are intentional.',
      'Makes the agent commit to a color palette first, before laying out components.',
    ],
    howWithCodex: [
      'Install it from the official openai/skills catalog so Codex can load it.',
      'Describe the UI you want in plain language — no need to specify fonts or colors.',
      'The skill makes Codex decide typography and palette up front, then build to them.',
    ],
    example:
      'Reach for this on every greenfield UI. It is the difference between "a working page" and "a page a designer would sign off on."',
    source: {
      label: 'openai/skills · .curated/frontend-skill',
      url: 'https://github.com/openai/skills/tree/main/skills/.curated/frontend-skill',
    },
    reference: {
      label: 'Designing delightful frontends (OpenAI)',
      url: 'https://developers.openai.com/blog/designing-delightful-frontends-with-gpt-5-4',
    },
  },
  {
    slug: 'design-first-ui-prompting',
    name: 'Design-first UI prompting',
    category: 'Frontend & UI',
    badge: 'Meng To',
    tagline: 'Prompt UI so the agent designs on purpose.',
    image: '/plugins/codex-design/skills/design-first-prompting.webp',
    whatIsIt:
      'A set of prompting methods from Meng To (DesignCode) for getting an agent to design intentionally, instead of defaulting to generic slop.',
    whyForDesign: [
      'Teaches you to lead with intent and constraints, not "make it look nice".',
      'Turns vague requests into structured, opinionated UI direction.',
      'Pairs with the frontend skill — one sets the rules, this shapes the ask.',
    ],
    howWithCodex: [
      'Load the ui skills from Meng To’s agent-skills collection.',
      'Frame the design goal, references, and constraints before asking for code.',
      'Let Codex propose an intentional layout rather than a blank-canvas guess.',
    ],
    source: {
      label: 'MengTo/Skills · agent-skills/ui',
      url: 'https://github.com/MengTo/Skills/tree/main/agent-skills/ui',
    },
    reference: { label: 'Meng To (DesignCode)', url: 'https://github.com/MengTo' },
  },
  {
    slug: 'web-design',
    name: 'Web design craft',
    category: 'Frontend & UI',
    badge: 'Meng To',
    tagline: 'Landing-page craft: animation, GSAP, WebGL, Tailwind.',
    image: '/plugins/codex-design/skills/web-design.webp',
    whatIsIt:
      'Meng To’s web and landing-page craft skills: animation, GSAP, WebGL, Tailwind, Matter.js, and reference-to-prompt workflows.',
    whyForDesign: [
      'Adds motion and polish most agents skip — easing, scroll, micro-interaction.',
      'Covers the specific stacks a real landing page ships on.',
      'Turns a visual reference into a prompt the agent can actually build from.',
    ],
    howWithCodex: [
      'Load the web-design skills from Meng To’s agent-skills collection.',
      'Point Codex at a reference and the target stack (Tailwind, GSAP, …).',
      'Ask for the section, then iterate on motion and detail with the agent.',
    ],
    source: {
      label: 'MengTo/Skills · agent-skills/web-design',
      url: 'https://github.com/MengTo/Skills/tree/main/agent-skills/web-design',
    },
    reference: { label: 'Meng To (DesignCode)', url: 'https://github.com/MengTo' },
  },
  {
    slug: 'figma-implement-design',
    name: 'Figma → implement design',
    category: 'Figma → Code',
    badge: 'Official',
    tagline: 'Turn a Figma design into near-production code.',
    image: '/plugins/codex-design/skills/figma-implement-design.webp',
    whatIsIt:
      'An official skill that reads a Figma design and converts it into near-production frontend code. Pair it with the frontend skill for accuracy and quality.',
    whyForDesign: [
      'Preserves the designer’s intent — spacing, hierarchy, tokens — into code.',
      'Cuts the hand-off gap between "designed in Figma" and "built in the app".',
      'Works from your real frames, not a re-imagined guess.',
    ],
    howWithCodex: [
      'Connect Codex to Figma via the Figma Dev Mode MCP so it can read frames.',
      'Install the figma-implement-design skill from the official catalog.',
      'Point it at a frame and let it generate matching frontend code.',
    ],
    source: {
      label: 'openai/skills · .curated/figma-implement-design',
      url: 'https://github.com/openai/skills/tree/main/skills/.curated/figma-implement-design',
    },
    reference: {
      label: 'OpenAI Codex skills docs',
      url: 'https://developers.openai.com/codex/skills',
    },
  },
  {
    slug: 'figma-create-design-system-rules',
    name: 'Figma → design-system rules',
    category: 'Design Systems',
    badge: 'Official',
    tagline: 'Turn your design system into agent-readable rules.',
    image: '/plugins/codex-design/skills/figma-design-system-rules.webp',
    whatIsIt:
      'An official skill that turns a design system into agent-readable rules, so Codex stops inventing random spacing, colors, and component patterns.',
    whyForDesign: [
      'Encodes tokens — spacing, color, radius, type — as constraints the agent obeys.',
      'Kills drift: every generated screen uses the same system.',
      'Makes "on-brand" the default output, not a manual clean-up pass.',
    ],
    howWithCodex: [
      'Install the figma-create-design-system-rules skill from the official catalog.',
      'Run it against your Figma library to extract the rules.',
      'Codex then reads those rules on every design task.',
    ],
    source: {
      label: 'openai/skills · .curated/figma-create-design-system-rules',
      url: 'https://github.com/openai/skills/tree/main/skills/.curated/figma-create-design-system-rules',
    },
    reference: {
      label: 'OpenAI Codex skills docs',
      url: 'https://developers.openai.com/codex/skills',
    },
  },
  {
    slug: 'figma-generate-library',
    name: 'Figma → generate library',
    category: 'Design Systems',
    badge: 'Official',
    tagline: 'Generate a reusable component library in Figma.',
    image: '/plugins/codex-design/skills/figma-generate-library.webp',
    whatIsIt:
      'An official skill that generates reusable component libraries in Figma — the foundation a consistent design system is built on.',
    whyForDesign: [
      'Bootstraps a component library instead of hand-building every variant.',
      'Gives Codex a consistent set of parts to design and build with.',
      'Feeds directly into the design-system rules skill.',
    ],
    howWithCodex: [
      'Connect Codex to Figma via the Figma Dev Mode MCP.',
      'Install the figma-generate-library skill from the official catalog.',
      'Generate the component set, then reuse it across every screen.',
    ],
    source: {
      label: 'openai/skills · .curated/figma-generate-library',
      url: 'https://github.com/openai/skills/tree/main/skills/.curated/figma-generate-library',
    },
    reference: {
      label: 'OpenAI Codex skills docs',
      url: 'https://developers.openai.com/codex/skills',
    },
  },
];

export function getCodexSkill(slug: string): CodexSkill | undefined {
  return CODEX_SKILLS.find((s) => s.slug === slug);
}
