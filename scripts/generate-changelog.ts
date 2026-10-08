#!/usr/bin/env node

/**
 * Changelog generator (issue #289).
 *
 * Turns merged pull request metadata into a reviewable release-note section:
 * categories come from `scripts/changelog/categories.ts`, credentials are
 * scrubbed by `scripts/changelog/redact.ts`, and the Markdown is produced by
 * `scripts/changelog/render.ts`.
 *
 * The default run is a dry run: the section is printed and nothing is written.
 * Only `--write` updates CHANGELOG.md, and only after the rendered text has been
 * checked for credentials again.
 *
 * Usage:
 *   npm run changelog:dry-run -- --version 1.4.0 --since 2026-09-01
 *   npx tsx scripts/generate-changelog.ts --from fixture.json --version 1.4.0
 *   npx tsx scripts/generate-changelog.ts --version 1.4.0 --write
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { USAGE, parseArgs, readToken, type CliOptions } from './changelog/args';
import {
  collectMergedPullRequests,
  filterMergedPullRequests,
  readPullRequestFile,
  sortAndLimit,
} from './changelog/collect';
import { containsSecret, findSecretKinds, redactSecrets } from './changelog/redact';
import {
  buildReleaseNotes,
  formatSummary,
  insertReleaseSection,
  type RenderedRelease,
} from './changelog/render';
import type { PullRequestInput } from './changelog/categories';

/** CHANGELOG.md at the repository root. */
export function changelogPath(cwd: string = process.cwd()): string {
  return path.resolve(cwd, 'CHANGELOG.md');
}

interface Collected {
  pullRequests: PullRequestInput[];
  source: 'api' | 'file';
  scanned?: number;
  truncated: boolean;
}

/** collect gathers pull requests from the API, or from a file when asked. */
async function collect(options: CliOptions, token?: string): Promise<Collected> {
  if (options.from) {
    const rows = readPullRequestFile(path.resolve(process.cwd(), options.from));
    const windowed =
      options.since || options.until
        ? filterMergedPullRequests(rows, {
            since: options.since,
            until: options.until,
            limit: options.limit,
          })
        : sortAndLimit(rows, options.limit);
    const truncated = windowed.length < rows.length;
    return { pullRequests: windowed, source: 'file', scanned: rows.length, truncated };
  }

  const result = await collectMergedPullRequests({
    repo: options.repo,
    token,
    since: options.since,
    until: options.until,
    limit: options.limit,
  });
  return {
    pullRequests: result.pullRequests,
    source: 'api',
    scanned: result.scanned,
    truncated: result.truncated,
  };
}

/** run performs one generator run and returns the process exit code. */
export async function run(argv: string[]): Promise<number> {
  let options: CliOptions;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(`error: ${(error as Error).message}`);
    console.error(`\n${USAGE}`);
    return 2;
  }

  if (options.help) {
    console.log(USAGE);
    return 0;
  }

  const token = readToken();
  if (!options.from && !token) {
    // Anonymous reads work; they just share a much smaller rate limit.
    console.warn(
      'warning: no GITHUB_TOKEN/GH_TOKEN set, reading the API anonymously (lower rate limit)'
    );
  }

  const collected = await collect(options, token);
  if (collected.truncated) {
    console.warn(
      'warning: the limit was reached, so older merged pull requests were not included (raise --limit)'
    );
  }

  const release: RenderedRelease = buildReleaseNotes({
    version: options.version,
    date: options.date,
    repo: options.repo,
    includeInternal: options.includeInternal,
    pullRequests: collected.pullRequests,
  });

  console.log(release.markdown);
  console.log(
    formatSummary(release, {
      source: collected.source,
      scanned: collected.scanned,
      pullRequests: collected.pullRequests.length,
    })
  );

  if (options.out) {
    const outPath = path.resolve(process.cwd(), options.out);
    writeFileSync(outPath, release.markdown, 'utf8');
    console.log(`\nwrote ${outPath}`);
  }

  if (!options.write) {
    console.log(
      `\ndry run: nothing else written (pass --write to update ${path.basename(changelogPath())})`
    );
    return 0;
  }

  // Last line of defence: the renderer already scrubbed credentials, so a
  // finding here means a pattern is missing and the write must not happen.
  const remaining = findSecretKinds(release.markdown);
  if (containsSecret(release.markdown)) {
    console.error(
      `error: refusing to write ${path.basename(changelogPath())}: the rendered notes still contain ${remaining.join(', ')}`
    );
    return 1;
  }

  const file = changelogPath();
  const existing = existsSync(file) ? readFileSync(file, 'utf8') : '';
  writeFileSync(file, insertReleaseSection(existing, release.markdown, options.version), 'utf8');
  console.log(`\nupdated ${file}`);
  return 0;
}

run(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    // API errors can quote the request, so strip anything credential-shaped
    // before it reaches a terminal or a CI log.
    console.error(`error: ${redactSecrets((error as Error).message)}`);
    process.exitCode = 1;
  });
