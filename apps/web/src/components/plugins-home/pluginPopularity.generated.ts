// AUTO-GENERATED — DO NOT EDIT BY HAND.
//
// Blended template popularity, used to order the plugin/example grid and the
// Home rail so the templates users actually reach for lead each category and
// sub-category (OPEND-449). Higher score = more popular; range [0, 1].
//
// How it is built (deterministic, creds-free transform):
//   score = 0.6 * norm(log1p(distinctUsers)) + 0.4 * norm(log1p(runs))
//   • window: trailing 28 days of `run_finished` events (by plugin_id)
//   • distinct users are the anti-gaming signal; runs add engagement depth
//   • log1p tames the head-template scale gap; min-max normalized over the
//     live-catalog template set so both metrics land in [0, 1]
//   • RETIRED plugins (absent from the live catalog) are dropped
//   • templates with no renderable preview are EXCLUDED — mode-seed entries
//     (e.g. the generic Live Artifact / HyperFrames options) live in the
//     composer mode picker, not the gallery, so usage must not float them up
//   • templates below 20 distinct users are OMITTED so thin-sample
//     tail templates keep their curated/visual fallback order
//
// Regenerate with: pnpm exec tsx scripts/refresh-plugin-popularity.ts --write
// Refreshed weekly by .github/workflows/refresh-plugin-popularity.yml.
// See pluginPopularity.RUNBOOK.md here.

export interface PluginPopularityMeta {
  readonly generatedAt: string;
  readonly windowDays: number;
  readonly weights: { readonly users: number; readonly runs: number };
  readonly minUsers: number;
  readonly count: number;
}

export const PLUGIN_POPULARITY_META: PluginPopularityMeta = {
  generatedAt: '2026-07-27',
  windowDays: 28,
  weights: { users: 0.6, runs: 0.4 },
  minUsers: 20,
  count: 122,
};

// Plugin id -> blended popularity score in [0, 1], most-popular first.
export const PLUGIN_POPULARITY: Readonly<Record<string, number>> = {
  'example-web-prototype': 1.0,
  'example-simple-deck': 0.8712,
  'example-web-clone': 0.754,
  'example-open-design-landing': 0.7057,
  'example-mobile-app': 0.7002,
  'example-gamified-app': 0.6217,
  'example-wireframe-mobile-flow': 0.5965,
  'example-fs-creative-voltage': 0.5912,
  'example-kanban-board': 0.591,
  'example-wireframe-sketch': 0.5842,
  'example-webgl-experience': 0.5564,
  'example-fs-electric-studio': 0.5509,
  'example-mobile-onboarding': 0.5457,
  'example-dashboard': 0.5401,
  'example-fs-notebook-tabs': 0.5343,
  'image-template-anime-martial-arts-battle-illustration': 0.5331,
  'example-social-carousel': 0.5306,
  'example-wireframe-greybox': 0.5286,
  'example-fs-editorial-forest': 0.5152,
  'example-guizang-ppt': 0.515,
  'video-template-video-seedance-three-kingdoms-lyubu-yuanmen-archery': 0.5142,
  'example-huashu-slides': 0.5065,
  'example-digital-eguide': 0.5059,
  'example-huashu-keynote-black': 0.502,
  'example-video-hyperframes': 0.498,
  'example-social-media-matrix-tracker-template': 0.4978,
  'video-template-seedance-2-0-15-second-cinematic-japanese-romance-short-film': 0.4973,
  'example-html-ppt-zhangzara-creative-mode': 0.4956,
  'example-huashu-bento-insight': 0.4955,
  'example-motion-frames': 0.4929,
  'example-resume-modern': 0.4919,
  'example-html-ppt-knowledge-arch-blueprint': 0.4881,
  'example-wireframe-annotated': 0.4829,
  'example-velar-luxury-real-estate': 0.4776,
  'example-hps-academic-paper': 0.4775,
  'example-html-ppt-course-module': 0.4752,
  'example-fs-emerald-editorial': 0.4637,
  'example-codex-interactive-capability-map': 0.462,
  'image-template-e-commerce-live-stream-ui-mockup': 0.4615,
  'example-html-ppt-hermes-cyber-terminal': 0.4499,
  'example-blog-post': 0.4439,
  'example-mockup-device-3d': 0.4405,
  'example-huashu-takram-soft-tech': 0.4383,
  'example-html-ppt-zhangzara-capsule': 0.4381,
  'example-doc-kami-parchment': 0.4351,
  'example-webgl-caustic-pool': 0.4314,
  'example-audio-jingle': 0.431,
  'example-hps-bauhaus': 0.4282,
  'example-html-ppt-weekly-report': 0.4273,
  'example-html-ppt-zhangzara-scatterbrain': 0.4273,
  'example-huashu-golden-circle': 0.4239,
  'image-template-profile-avatar-casual-fashion-grid-photoshoot': 0.4196,
  'image-template-profile-avatar-anime-girl-to-cinematic-photo': 0.418,
  'example-image-poster': 0.4136,
  'video-template-frame-kinetic-type': 0.4124,
  'video-template-luxury-supercar-cinematic-narrative': 0.4124,
  'example-html-ppt-zhangzara-cobalt-grid': 0.4107,
  'example-open-design-landing-deck': 0.4106,
  'image-template-3d-stone-staircase-evolution-infographic': 0.4105,
  'example-docs-page': 0.4083,
  'example-hps-true-blueprint': 0.4072,
  'image-template-illustration-crayon-kid-drawing-rework': 0.4071,
  'example-html-ppt-tech-sharing': 0.407,
  'example-deck-swiss-international': 0.4054,
  'image-template-illustrated-city-food-map': 0.4,
  'example-finance-report': 0.3957,
  'example-html-ppt-zhangzara-block-frame': 0.3937,
  'image-template-social-media-post-showa-day-retro-culture-magazine-cover': 0.392,
  'example-html-ppt-zhangzara-sakura-chroma': 0.3911,
  'image-template-infographic-otaku-dance-choreography-breakdown-gokurakujodo-16-panels': 0.3901,
  'example-pm-spec': 0.3898,
  'example-huashu-sparkline-arc': 0.3868,
  'example-huashu-pentagram-grid': 0.3831,
  'video-template-frame-liquid-bg-hero': 0.3796,
  'image-template-notion-team-dashboard-live-artifact': 0.3784,
  'example-trading-analysis-dashboard-template': 0.3778,
  'example-huashu-luxe-whitespace': 0.3775,
  'video-template-frame-bold-poster': 0.3771,
  'example-social-media-dashboard': 0.3762,
  'example-html-ppt-graphify-dark-graph': 0.3753,
  'example-frontend-slides': 0.3738,
  'video-template-frame-glitch-title': 0.3729,
  'image-template-momotaro-explainer-slide-in-hybrid-style': 0.3698,
  'example-html-ppt-zhangzara-signal': 0.3678,
  'image-template-game-screenshot-anime-fighting-game-captain-ryuuga-vs-kaze-renshin': 0.3667,
  'example-web-prototype-taste-soft': 0.3657,
  'example-github-dashboard': 0.3647,
  'video-template-a-decade-of-refinement-glow-up': 0.3634,
  'video-template-cinematic-east-asian-woman-hand-dance': 0.3623,
  'example-frame-logo-outro': 0.3617,
  'example-critique': 0.3599,
  'example-eng-runbook': 0.3598,
  'example-html-ppt-zhangzara-blue-professional': 0.3595,
  'video-template-frame-build-minimal': 0.3582,
  'video-template-3d-animated-boy-building-lego': 0.3577,
  'video-template-frame-logo-outro': 0.3572,
  'example-html-ppt-presenter-mode-reveal': 0.357,
  'example-html-ppt-obsidian-claude-gradient': 0.3567,
  'example-invoice': 0.3527,
  'example-html-ppt-zhangzara-monochrome': 0.3511,
  'example-webgl-aurora-veil': 0.3443,
  'example-hps-memphis-pop': 0.3442,
  'example-html-ppt-zhangzara-neo-grid-bold': 0.3438,
  'image-template-profile-avatar-cinematic-south-asian-male-portrait-with-vultures': 0.3416,
  'example-ve-terminal-mono': 0.3403,
  'example-html-ppt-testing-safety-alert': 0.3398,
  'example-html-ppt-zhangzara-broadside': 0.3372,
  'example-hps-y2k-chrome': 0.3366,
  'example-video-shortform': 0.3362,
  'example-huashu-annual-letter': 0.3327,
  'example-ppt-keynote': 0.3321,
  'example-html-ppt-taste-brutalist': 0.3308,
  'example-flowai-live-dashboard-template': 0.3305,
  'example-frame-flowchart-sticky': 0.3303,
  'example-html-ppt-xhs-white-editorial': 0.3302,
  'example-html-ppt-xhs-pastel-card': 0.3256,
  'example-ve-midnight-editorial': 0.3239,
  'video-template-frame-pentagram-stat': 0.3235,
  'video-template-forbidden-city-cat-satire': 0.3232,
  'video-template-frame-data-rollup': 0.3125,
  'video-template-frame-decision-tree': 0.3125,
  'example-dating-web': 0.3033,
};

// Templates with no renderable preview — suppressed from the visual gallery
// grid so they never show as an empty letter card. They still reach users
// through the composer's mode picker. Repo-derived (baked manifest + on-disk
// `od.preview` entry existence), refreshed alongside the scores above.
export const PLUGIN_NO_PREVIEW: readonly string[] = [
  'example-dcf-valuation',
  'example-design-brief',
  'example-hatch-pet',
  'example-html-ppt',
  'example-hyperframes',
  'example-last30days',
  'example-live-artifact',
  'example-pptx-html-fidelity-audit',
  'example-x-research',
];
