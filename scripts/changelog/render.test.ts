import { describe, expect, it } from 'vitest';

import type { PullRequestInput } from './categories';
import {
  buildReleaseNotes,
  CHANGELOG_TITLE,
  entryLine,
  formatSummary,
  insertReleaseSection,
  isNewerVersion,
  isoDate,
  pullRequestLink,
  sanitiseInline,
} from './render';

const REPO = 'stellar-alerts-labs/stellar-alerts';

/** Assembled at runtime: a token-shaped literal must not sit in the repo. */
const FAKE_TOKEN = ['ghp_', 'A'.repeat(36)].join('');

function pr(overrides: Partial<PullRequestInput> = {}): PullRequestInput {
  return {
    number: 12,
    title: 'feat: add the wallet watcher',
    author: 'alice',
    url: `https://github.com/${REPO}/pull/12`,
    mergedAt: '2026-09-20T10:00:00Z',
    labels: [],
    body: '',
    ...overrides,
  };
}

describe('isoDate', () => {
  it('formats a date as YYYY-MM-DD', () => {
    expect(isoDate('2026-09-27T13:45:00Z')).toBe('2026-09-27');
    expect(isoDate(new Date('2026-01-02T00:00:00Z'))).toBe('2026-01-02');
  });

  it('rejects a date it cannot format', () => {
    expect(() => isoDate('not a date')).toThrow(/valid date/);
  });
});

describe('sanitiseInline', () => {
  it('collapses whitespace and control characters', () => {
    expect(sanitiseInline('feat:  add\n\tthing\u0007')).toBe('feat: add thing');
  });

  it('removes a trailing pull request reference it is going to add anyway', () => {
    expect(sanitiseInline('fix: stop double notifications (#412)')).toBe(
      'fix: stop double notifications'
    );
  });
});

describe('entryLine', () => {
  it('renders a bullet with a link and an author', () => {
    expect(entryLine(pr())).toBe(
      `- feat: add the wallet watcher ([#12](https://github.com/${REPO}/pull/12)) by @alice`
    );
  });

  it('builds the link from the repo when the pull request has no url', () => {
    expect(entryLine(pr({ url: null }), { repo: REPO })).toBe(
      `- feat: add the wallet watcher ([#12](https://github.com/${REPO}/pull/12)) by @alice`
    );
    expect(pullRequestLink(pr({ url: null }))).toBe('#12');
  });

  it('never lets a credential reach the changelog', () => {
    const line = entryLine(pr({ title: `fix: rotate token ${FAKE_TOKEN}` }));
    expect(line).not.toContain('ghp_');
    expect(line).toContain('[redacted]');
  });

  it('falls back to the number when the title is unusable', () => {
    expect(entryLine(pr({ title: '   ' }))).toContain('Pull request #12');
  });
});

describe('buildReleaseNotes', () => {
  const pullRequests: PullRequestInput[] = [
    pr({ number: 12, title: 'feat: add the wallet watcher' }),
    pr({ number: 13, title: 'fix: stop double notifications' }),
    pr({ number: 14, title: 'refactor: split the worker' }),
    pr({ number: 15, title: 'chore(deps): bump axios', author: 'dependabot[bot]' }),
  ];

  it('renders a reviewable section with one heading per populated category', () => {
    const release = buildReleaseNotes({
      version: '1.4.0',
      date: '2026-09-27',
      repo: REPO,
      pullRequests,
    });

    expect(release.markdown).toContain('## [1.4.0] - 2026-09-27');
    expect(release.markdown).toContain('_Generated from 2 merged pull requests._');
    expect(release.markdown).toContain('### ✨ Features');
    expect(release.markdown).toContain('- feat: add the wallet watcher');
    expect(release.markdown).toContain('### 🐛 Fixes');
    // Internal work and dependency bumps stay out of the release note.
    expect(release.markdown).not.toContain('### 🔧 Internal');
    expect(release.markdown).not.toContain('refactor: split the worker');
    expect(release.markdown).not.toContain('dependabot');
    expect(release.markdown.endsWith('\n')).toBe(true);
  });

  it('puts breaking changes first and can include internal work', () => {
    const release = buildReleaseNotes({
      version: '1.4.0',
      date: '2026-09-27',
      repo: REPO,
      includeInternal: true,
      pullRequests: [
        pr({ number: 12, title: 'feat: add the wallet watcher' }),
        pr({ number: 16, title: 'feat(api)!: drop the v1 callback' }),
        pr({ number: 14, title: 'refactor: split the worker' }),
      ],
    });

    const headings = release.markdown
      .split('\n')
      .filter((line) => line.startsWith('### '));
    expect(headings).toEqual(['### ⚠️ Breaking Changes', '### ✨ Features', '### 🔧 Internal']);
    expect(release.plan.counts.internal).toBe(1);
  });

  it('says so when a release has nothing to announce', () => {
    const release = buildReleaseNotes({
      version: 'Unreleased',
      date: '2026-09-27',
      pullRequests: [pr({ title: 'chore: tidy the workflows' })],
    });

    expect(release.markdown).toContain('## [Unreleased] - 2026-09-27');
    expect(release.markdown).toContain('_No user-facing changes in this release._');
    expect(release.markdown).not.toContain('### ');
  });

  it('reports what it dropped and what it scrubbed', () => {
    const release = buildReleaseNotes({
      version: '1.4.0',
      date: '2026-09-27',
      pullRequests: [
        pr({ title: `fix: rotate ${FAKE_TOKEN}` }),
        pr({ number: 15, title: 'chore(deps): bump axios', author: 'dependabot[bot]' }),
      ],
    });

    expect(release.redactions).toEqual(['github token']);
    expect(release.warnings.join(' ')).toContain('skipped as automation or release plumbing');
    expect(release.warnings.join(' ')).toContain('scrubbed github token');
  });

  it('requires a version', () => {
    expect(() => buildReleaseNotes({ version: '  ', pullRequests: [] })).toThrow(/version/);
  });
});

describe('formatSummary', () => {
  it('reports the source, the counts and the skipped pull requests', () => {
    const release = buildReleaseNotes({
      version: '1.4.0',
      date: '2026-09-27',
      pullRequests: [
        pr({ title: 'feat: add the wallet watcher' }),
        pr({ number: 15, title: 'chore(deps): bump axios', author: 'dependabot[bot]' }),
      ],
    });

    const summary = formatSummary(release, { source: 'file', scanned: 2, pullRequests: 2 });
    expect(summary).toContain('file (offline dry run)');
    expect(summary).toContain('merged PRs in scope:  2');
    expect(summary).toContain('pull requests read:   2');
    expect(summary).toContain('features');
    expect(summary).toContain('#15 automation author');
  });
});

describe('insertReleaseSection', () => {
  const section = '## [1.4.0] - 2026-09-27\n\n### ✨ Features\n\n- feat: add the wallet watcher\n';

  it('creates a changelog with the standard preamble', () => {
    const created = insertReleaseSection('', section, '1.4.0');
    expect(created.startsWith(CHANGELOG_TITLE)).toBe(true);
    expect(created).toContain('docs/CHANGELOG_AUTOMATION.md');
    expect(created).toContain('## [1.4.0] - 2026-09-27');
    // A blank line before the section, no double blanks anywhere, one trailing
    // newline: the file has to survive a Markdown linter.
    expect(created).toMatch(/\n\n## \[1\.4\.0\]/);
    expect(created).not.toContain('\n\n\n');
    expect(created.endsWith('\n')).toBe(true);
    expect(created.endsWith('\n\n')).toBe(false);
  });

  it('inserts the newest section above the existing ones', () => {
    const existing = `${CHANGELOG_TITLE}\n\nOld notes.\n\n## [1.3.0] - 2026-01-01\n\n- fix: old\n`;
    const updated = insertReleaseSection(existing, section, '1.4.0');

    expect(updated.indexOf('## [1.4.0]')).toBeLessThan(updated.indexOf('## [1.3.0]'));
    expect(updated).toContain('Old notes.');
    expect(updated).toContain('- fix: old');
    expect(updated).not.toContain('\n\n\n');
    expect(updated).toMatch(/Old notes\.\n\n## \[1\.4\.0\]/);
  });

  it('replaces a section for the same version instead of duplicating it', () => {
    const first = insertReleaseSection('', section, '1.4.0');
    const second = insertReleaseSection(
      first,
      '## [1.4.0] - 2026-09-28\n\n- corrected\n',
      '1.4.0'
    );

    expect(second.match(/## \[1\.4\.0\]/g)).toHaveLength(1);
    expect(second).toContain('- corrected');
    expect(second).not.toContain('- feat: add the wallet watcher');
    expect(second).not.toContain('\n\n\n');
  });

  it('appends when the changelog has no release sections yet', () => {
    const updated = insertReleaseSection('Some notes.\n', section, '1.4.0');
    expect(updated.indexOf('Some notes.')).toBeLessThan(updated.indexOf('## [1.4.0]'));
    expect(updated).toMatch(/Some notes\.\n\n## \[1\.4\.0\]/);
  });

  it('keeps the file newest-first whatever order releases are generated in', () => {
    const newer = insertReleaseSection('', '## [1.5.0] - 2026-09-27\n\n- feat: newer\n', '1.5.0');
    const twoReleases = insertReleaseSection(
      newer,
      '## [1.4.0] - 2026-08-01\n\n- feat: older\n',
      '1.4.0'
    );

    // Generating 1.4.0 after 1.5.0 must land below it, not above.
    expect(twoReleases.indexOf('## [1.5.0]')).toBeLessThan(twoReleases.indexOf('## [1.4.0]'));

    const unreleased = insertReleaseSection(
      twoReleases,
      '## [Unreleased] - 2026-09-27\n\n- feat: next\n',
      'Unreleased'
    );
    expect(unreleased.indexOf('## [Unreleased]')).toBeLessThan(unreleased.indexOf('## [1.5.0]'));
    expect(unreleased.indexOf('## [1.5.0]')).toBeLessThan(unreleased.indexOf('## [1.4.0]'));
    expect(unreleased.match(/^## \[/gm)).toHaveLength(3);
  });

  it('compares version labels the way a reader would', () => {
    expect(isNewerVersion('1.4.0', '1.3.0')).toBe(true);
    expect(isNewerVersion('1.10.0', '1.9.0')).toBe(true);
    expect(isNewerVersion('1.3.0', '1.4.0')).toBe(false);
    expect(isNewerVersion('Unreleased', '9.9.9')).toBe(true);
    expect(isNewerVersion('1.4.0', '1.4.0')).toBe(false);
    expect(isNewerVersion('v2.0.0', '1.9.9')).toBe(true);
  });

  it('leaves no trailing whitespace behind', () => {
    const updated = insertReleaseSection('Notes.   \n\n\n', section, '1.4.0');
    expect(updated).not.toMatch(/[ \t]+\n/);
    expect(updated).not.toContain('\n\n\n');
  });
});
