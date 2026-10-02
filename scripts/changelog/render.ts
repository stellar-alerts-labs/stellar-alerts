/**
 * Rendering the release notes (issue #289).
 *
 * `buildReleaseNotes` turns collected pull requests into the Markdown block that
 * is printed by a dry run and, with `--write`, prepended to CHANGELOG.md. It is
 * a pure function of its inputs so the same range always produces the same text,
 * which is what makes a dry run reviewable.
 */

import type { ChangelogPlan, PullRequestInput } from './categories';
import { planChangelog } from './categories';
import { findSecretKinds, redactSecrets } from './redact';

export const CHANGELOG_TITLE = '# Changelog';

export const CHANGELOG_PREAMBLE = [
  CHANGELOG_TITLE,
  '',
  'All notable changes to this project are documented here.',
  '',
  'Release sections are generated from merged pull requests by',
  '`npx tsx scripts/generate-changelog.ts`; see `docs/CHANGELOG_AUTOMATION.md`.',
  '',
].join('\n');

export interface RenderOptions {
  /** Heading for the section, e.g. `1.3.0` or `Unreleased`. */
  version: string;
  /** ISO date (`YYYY-MM-DD`); defaults to today in UTC. */
  date?: string;
  /** `owner/name`, used to build pull request links when one is missing. */
  repo?: string | null;
  /** Include the 🔧 Internal section (refactors, chores, CI, tests). */
  includeInternal?: boolean;
  pullRequests: PullRequestInput[];
}

export interface RenderedRelease {
  markdown: string;
  plan: ChangelogPlan;
  /** Credential shapes scrubbed while rendering, by name. */
  redactions: string[];
  /** Non-fatal notes for the dry-run summary. */
  warnings: string[];
}

/** isoDate renders a date as `YYYY-MM-DD`, defaulting to today (UTC). */
export function isoDate(date?: string | Date): string {
  const value = date instanceof Date ? date : date ? new Date(date) : new Date();
  if (Number.isNaN(value.getTime())) {
    throw new Error(`not a valid date: ${String(date)}`);
  }
  return value.toISOString().slice(0, 10);
}

/**
 * sanitiseInline makes a pull request title safe to drop into a Markdown list
 * item: single line, no control characters, and without a trailing `(#123)`,
 * because the entry adds its own link.
 */
export function sanitiseInline(text: string): string {
  return String(text ?? '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\s*\(#\d+\)\s*$/, '')
    .trim();
}

/** pullRequestLink returns the `#123` reference, linked when a URL is known. */
export function pullRequestLink(
  pr: PullRequestInput,
  repo?: string | null
): string {
  const reference = `#${pr.number}`;
  const url = pr.url ?? (repo ? `https://github.com/${repo}/pull/${pr.number}` : null);
  return url ? `[${reference}](${url})` : reference;
}

/** entryLine renders one bullet for a merged pull request. */
export function entryLine(
  pr: PullRequestInput,
  options: { repo?: string | null } = {}
): string {
  const title = sanitiseInline(redactSecrets(pr.title)) || `Pull request #${pr.number}`;
  const link = pullRequestLink(pr, options.repo);
  const author = pr.author ? ` by @${sanitiseInline(redactSecrets(pr.author))}` : '';
  return `- ${title} (${link})${author}`;
}

/**
 * buildReleaseNotes plans the pull requests and renders the changelog section
 * for one release.
 */
export function buildReleaseNotes(options: RenderOptions): RenderedRelease {
  const version = String(options.version ?? '').trim();
  if (!version) throw new Error('a version (or "Unreleased") is required');

  const plan = planChangelog(options.pullRequests, {
    includeInternal: options.includeInternal,
  });

  const redactions = new Set<string>();
  for (const pr of options.pullRequests) {
    for (const kind of findSecretKinds(`${pr.title}\n${pr.author ?? ''}\n${pr.body ?? ''}`)) {
      redactions.add(kind);
    }
  }

  const lines: string[] = [`## [${version}] - ${isoDate(options.date)}`, ''];
  const total = plan.groups.reduce((sum, group) => sum + group.entries.length, 0);

  if (total === 0) {
    lines.push('_No user-facing changes in this release._', '');
  } else {
    lines.push(
      `_Generated from ${total} merged pull request${total === 1 ? '' : 's'}._`,
      ''
    );
  }

  for (const group of plan.groups) {
    lines.push(`### ${group.category.heading}`, '');
    for (const pr of group.entries) {
      lines.push(entryLine(pr, { repo: options.repo }));
    }
    lines.push('');
  }

  const warnings: string[] = [];
  if (plan.skipped.length > 0) {
    warnings.push(
      `${plan.skipped.length} pull request${plan.skipped.length === 1 ? '' : 's'} skipped as automation or release plumbing`
    );
  }
  if (!options.includeInternal && plan.counts.internal > 0) {
    warnings.push(
      `${plan.counts.internal} pull request${plan.counts.internal === 1 ? '' : 's'} classified as internal (pass --include-internal to list them)`
    );
  }
  if (redactions.size > 0) {
    warnings.push(`scrubbed ${[...redactions].join(', ')} from the rendered notes`);
  }

  const markdown = `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;

  return { markdown, plan, redactions: [...redactions].sort(), warnings };
}

/**
 * versionKey turns a version label into comparable parts: `Unreleased` sorts
 * above every numbered release, and `1.4.2`, `1.4.2-rc.1` become numbers and
 * strings that can be compared pairwise.
 */
function versionKey(version: string): Array<number | string> {
  const clean = String(version).trim().replace(/^v/i, '').toLowerCase();
  if (clean === 'unreleased') return [Number.POSITIVE_INFINITY];
  return clean
    .split(/[.\-+]/)
    .filter((part) => part.length > 0)
    .map((part) => (/^\d+$/.test(part) ? Number(part) : part));
}

/** isNewerVersion reports whether `a` should be listed above `b`. */
export function isNewerVersion(a: string, b: string): boolean {
  const left = versionKey(a);
  const right = versionKey(b);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const x = left[i] ?? 0;
    const y = right[i] ?? 0;
    if (x === y) continue;
    if (typeof x === 'number' && typeof y === 'number') return x > y;
    return String(x) > String(y);
  }
  return false;
}

/** normaliseFile tidies the file the caller is about to write: no trailing
 * whitespace, no double blank lines and exactly one newline at the end. */
function normaliseFile(text: string): string {
  return `${text
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\s+$/, '')}\n`;
}

/** SECTION_HEADING matches a release heading and captures its version label. */
const SECTION_HEADING = /^## \[([^\]]+)\]/gm;

/**
 * insertReleaseSection places a rendered section in a changelog.
 *
 * - an empty or missing changelog gets the standard preamble first;
 * - a section for the same version is replaced in place, so re-running a
 *   release is idempotent rather than additive;
 * - otherwise the section is inserted above the first release it is newer than
 *   (and at the end when it is the oldest), so the file stays newest-first
 *   whatever order releases are generated in.
 */
export function insertReleaseSection(
  existing: string | null | undefined,
  section: string,
  version: string
): string {
  const block = `${section.trim()}\n\n`;
  const current = String(existing ?? '').replace(/\r\n/g, '\n');
  if (!current.trim()) {
    // The preamble already ends with a newline, so one more makes a blank line.
    return normaliseFile(`${CHANGELOG_PREAMBLE}\n${block}`);
  }

  const marker = `## [${version}]`;
  const start = current.indexOf(marker);
  if (start !== -1) {
    const next = current.indexOf('\n## [', start + marker.length);
    const tail = next === -1 ? '' : current.slice(next + 1);
    return normaliseFile(`${current.slice(0, start)}${block}${tail}`);
  }

  let insertAt = -1;
  for (const match of current.matchAll(SECTION_HEADING)) {
    const label = match[1];
    if (isNewerVersion(version, label)) {
      insertAt = match.index ?? -1;
      break;
    }
  }

  if (insertAt === -1) {
    return normaliseFile(`${current}\n${block}`);
  }
  const head = current.slice(0, insertAt).replace(/\n+$/, '\n');
  return normaliseFile(`${head}\n${block}${current.slice(insertAt)}`);
}

/** formatSummary renders the dry-run report printed under the notes. */
export function formatSummary(
  release: RenderedRelease,
  meta: { source: 'api' | 'file'; scanned?: number; pullRequests: number }
): string {
  const lines: string[] = [
    'Release notes summary',
    '---------------------',
    `source:               ${meta.source === 'api' ? 'GitHub API' : 'file (offline dry run)'}`,
    `merged PRs in scope:  ${meta.pullRequests}`,
  ];
  if (typeof meta.scanned === 'number') {
    lines.push(`pull requests read:   ${meta.scanned}`);
  }
  for (const [id, count] of Object.entries(release.plan.counts)) {
    if (count > 0) lines.push(`  ${id.padEnd(12)} ${count}`);
  }
  for (const warning of release.warnings) {
    lines.push(`warning: ${warning}`);
  }
  if (release.plan.skipped.length > 0) {
    lines.push('skipped:');
    for (const { pr, reason } of release.plan.skipped.slice(0, 20)) {
      lines.push(`  #${pr.number} ${reason}`);
    }
    if (release.plan.skipped.length > 20) {
      lines.push(`  ... and ${release.plan.skipped.length - 20} more`);
    }
  }
  return lines.join('\n');
}
