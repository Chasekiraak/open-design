/*
 * Snapshot GitHub stats for the repos behind the curated Codex design skills.
 *
 * Why a committed snapshot rather than a build-time fetch: the landing build
 * runs in CI and must stay deterministic and offline-safe. This mirrors the
 * `vendor-contributors.ts` pattern — run the script, commit the result.
 *
 * Output:
 *   app/_data/codex-repo-stats.json  — { fetchedAt, repos: { "<owner/name>": {...} } }
 *
 * Re-run to refresh:  pnpm codex:repo-stats
 * Set GITHUB_TOKEN to avoid the 60 req/h unauthenticated rate limit.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CODEX_SKILLS } from '../app/_lib/codex-design';

const OUT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../app/_data/codex-repo-stats.json',
);

interface RepoStats {
  stars: number;
  forks: number;
  /** Null when the contributor count can't be determined (see below). */
  contributors: number | null;
  /** ISO date of the repo's last push. */
  pushedAt: string;
  htmlUrl: string;
}

function headers(): Record<string, string> {
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  return {
    accept: 'application/vnd.github+json',
    'user-agent': 'open-design-landing-codex-repo-stats',
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: headers() });
  if (!res.ok) throw new Error(`GitHub ${res.status} for ${url}`);
  return (await res.json()) as T;
}

/*
 * GitHub has no direct "contributor count" field. Asking for one contributor
 * per page and reading the `last` page number off the Link header gives the
 * total in a single request. Repos with more than 500 contributors return no
 * pagination for this endpoint, hence the nullable result.
 */
async function fetchContributorCount(repo: string): Promise<number | null> {
  const url = `https://api.github.com/repos/${repo}/contributors?per_page=1&anon=1`;
  const res = await fetch(url, { headers: headers() });
  if (!res.ok) return null;
  const link = res.headers.get('link');
  if (!link) {
    const page = (await res.json()) as unknown[];
    return page.length;
  }
  const last = /[?&]page=(\d+)>; rel="last"/.exec(link);
  return last?.[1] ? Number(last[1]) : null;
}

async function main() {
  const repos = [...new Set(CODEX_SKILLS.map((s) => s.repo))].sort();
  const out: Record<string, RepoStats> = {};

  for (const repo of repos) {
    const meta = await fetchJson<{
      stargazers_count: number;
      forks_count: number;
      pushed_at: string;
      html_url: string;
    }>(`https://api.github.com/repos/${repo}`);

    out[repo] = {
      stars: meta.stargazers_count,
      forks: meta.forks_count,
      contributors: await fetchContributorCount(repo),
      pushedAt: meta.pushed_at,
      htmlUrl: meta.html_url,
    };
    console.log(
      `[codex-repo-stats] ${repo}: ${out[repo].stars}★ ${out[repo].forks} forks ` +
        `${out[repo].contributors ?? '?'} contributors`,
    );
  }

  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(
    OUT,
    `${JSON.stringify({ fetchedAt: new Date().toISOString(), repos: out }, null, 2)}\n`,
  );
  console.log(`[codex-repo-stats] wrote ${repos.length} repos → app/_data/codex-repo-stats.json`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
