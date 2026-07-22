/*
 * Read-side for the GitHub stats snapshot written by
 * `scripts/codex-repo-stats.ts`.
 *
 * The snapshot is committed so the build never depends on the network. A repo
 * missing from it renders no stats block rather than failing the build, which
 * keeps adding a new skill from an unfamiliar repo a one-line change.
 */
import snapshot from '../_data/codex-repo-stats.json';

export interface CodexRepoStats {
  readonly stars: number;
  readonly forks: number;
  readonly contributors: number | null;
  readonly pushedAt: string;
  readonly htmlUrl: string;
}

const repos = snapshot.repos as Record<string, CodexRepoStats | undefined>;

export function getRepoStats(repo: string): CodexRepoStats | undefined {
  return repos[repo];
}

/** 23997 → "24.0K". Keeps the stat row narrow enough for the meta rail. */
export function formatCount(n: number): string {
  if (n < 1000) return String(n);
  return `${(n / 1000).toFixed(1)}K`;
}
