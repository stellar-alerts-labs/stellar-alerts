import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { filterMergedPullRequests, parsePullRequestFile } from './collect';
import { containsSecret } from './redact';
import { buildReleaseNotes, formatSummary } from './render';

/**
 * The acceptance criterion for issue #289 is that a dry run produces a
 * reviewable changelog. This walks the exact path the CLI takes with `--from`:
 * read the fixture, filter it like the CLI does, render, then check what a
 * reviewer would see.
 */
const FIXTURE = new URL('./fixtures/sample-pull-requests.json', import.meta.url);
const REPO = 'stellar-alerts-labs/stellar-alerts';

describe('offline dry run', () => {
  const rows = parsePullRequestFile(readFileSync(FIXTURE, 'utf8'));
  const pullRequests = filterMergedPullRequests(rows);
  const release = buildReleaseNotes({
    version: '1.4.0',
    date: '2026-09-27',
    repo: REPO,
    pullRequests,
  });

  it('reads the sample file through the same parser the CLI uses', () => {
    expect(rows).toHaveLength(7);
    expect(pullRequests.map((pr) => pr.number)).toEqual([401, 402, 403, 404, 405, 406, 407]);
  });

  it('produces a release note a reviewer can read', () => {
    expect(release.markdown.startsWith('## [1.4.0] - 2026-09-27')).toBe(true);
    expect(release.markdown).toContain('_Generated from 5 merged pull requests._');
    expect(release.markdown).toContain(
      '- feat(api): watch anchor deposit transactions ([#401](https://github.com/stellar-alerts-labs/stellar-alerts/pull/401)) by @alice'
    );
    expect(
      release.markdown.split('\n').filter((line) => line.startsWith('### '))
    ).toEqual([
      '### ⚠️ Breaking Changes',
      '### ✨ Features',
      '### 🐛 Fixes',
      '### ⚡ Performance',
      '### 📚 Documentation',
    ]);
  });

  it('leaves noisy and internal work out of the notes but counts it', () => {
    expect(release.markdown).not.toContain('refactor(api): split the watcher supervisor');
    expect(release.markdown).not.toContain('dependabot');
    expect(release.plan.counts.internal).toBe(1);
    expect(release.plan.skipped.map((entry) => entry.pr.number)).toEqual([406]);
    expect(release.plan.skipped[0].reason).toContain('automation author');
  });

  it('can list internal work on request', () => {
    const verbose = buildReleaseNotes({
      version: '1.4.0',
      date: '2026-09-27',
      repo: REPO,
      includeInternal: true,
      pullRequests,
    });
    expect(verbose.markdown).toContain('### 🔧 Internal');
    expect(verbose.markdown).toContain('refactor(api): split the watcher supervisor');
  });

  it('never carries a credential into the notes', () => {
    expect(containsSecret(release.markdown)).toBe(false);
    expect(release.redactions).toEqual([]);
  });

  it('reports what it did for the person running the release', () => {
    const summary = formatSummary(release, {
      source: 'file',
      scanned: rows.length,
      pullRequests: pullRequests.length,
    });
    expect(summary).toContain('file (offline dry run)');
    expect(summary).toContain('pull requests read:   7');
    expect(summary).toContain('#406 automation author');
  });
});
