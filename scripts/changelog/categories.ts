/**
 * Release-note categories and the rules that map a merged pull request onto one
 * of them (issue #289).
 *
 * Classification is deliberately conservative: a pull request only reaches a
 * user-facing section when its title follows the conventional-commit prefix the
 * repo already uses, or when it carries a label that says the same thing.
 * Everything else lands in `internal`, which is dropped from the changelog
 * unless `--include-internal` asks for it, so a release note stays about
 * behaviour rather than about the plumbing that produced it.
 */

/** A section of the generated changelog. */
export type ReleaseCategoryId =
  | 'breaking'
  | 'features'
  | 'fixes'
  | 'performance'
  | 'docs'
  | 'internal';

export interface ReleaseCategory {
  id: ReleaseCategoryId;
  /** Heading text, emoji included, exactly as it appears in the changelog. */
  heading: string;
  /** One line explaining what lands here; used by the docs and `--help`. */
  description: string;
  /** Order in the generated changelog; lower sorts first. */
  order: number;
  /** Internal categories are omitted unless `--include-internal` is passed. */
  includeByDefault: boolean;
}

/** Every category, in the order the changelog prints them. */
export const RELEASE_CATEGORIES: ReleaseCategory[] = [
  {
    id: 'breaking',
    heading: '⚠️ Breaking Changes',
    description: 'Behaviour or configuration that existing users must act on.',
    order: 0,
    includeByDefault: true,
  },
  {
    id: 'features',
    heading: '✨ Features',
    description: 'New user-visible capability (`feat:` or a `feature` label).',
    order: 1,
    includeByDefault: true,
  },
  {
    id: 'fixes',
    heading: '🐛 Fixes',
    description: 'Bug fixes and corrections (`fix:` or a `bug` label).',
    order: 2,
    includeByDefault: true,
  },
  {
    id: 'performance',
    heading: '⚡ Performance',
    description: 'Speed, cost or resource improvements (`perf:`).',
    order: 3,
    includeByDefault: true,
  },
  {
    id: 'docs',
    heading: '📚 Documentation',
    description: 'Documentation readers of the repo or the API can act on.',
    order: 4,
    includeByDefault: true,
  },
  {
    id: 'internal',
    heading: '🔧 Internal',
    description:
      'Refactors, chores, CI, tests, dependency bumps and anything unlabelled. Excluded from the changelog by default.',
    order: 5,
    includeByDefault: false,
  },
];

const CATEGORY_BY_ID = new Map<ReleaseCategoryId, ReleaseCategory>(
  RELEASE_CATEGORIES.map((category) => [category.id, category])
);

/** categoryById returns the definition for an id; unknown ids never happen. */
export function categoryById(id: ReleaseCategoryId): ReleaseCategory {
  const category = CATEGORY_BY_ID.get(id);
  if (!category) throw new Error(`unknown release category: ${id}`);
  return category;
}

/** The subset of a merged pull request the changelog needs. */
export interface PullRequestInput {
  number: number;
  title: string;
  /** GitHub login of the merged pull request's author. */
  author?: string | null;
  /** html_url of the pull request. */
  url?: string | null;
  mergedAt?: string | null;
  labels?: string[];
  /** Body text, scanned for a `BREAKING CHANGE:` trailer. */
  body?: string | null;
}

/** conventionalPrefix matches `type(scope)!: subject`. */
const CONVENTIONAL_PREFIX = /^([a-z]+)(?:\([^)]*\))?(!)?:\s*/i;

/** Conventional-commit types that belong in a user-facing section. */const TYPE_CATEGORIES: Record<string, ReleaseCategoryId> = {
  feat: 'features',
  feature: 'features',
  fix: 'fixes',
  perf: 'performance',
  docs: 'docs',
  // Deliberately internal: these change the repo, not the released behaviour.
  build: 'internal',
  chore: 'internal',
  ci: 'internal',
  deps: 'internal',
  refactor: 'internal',
  revert: 'internal',
  style: 'internal',
  test: 'internal',
};

/** Label names that stand in for a missing conventional-commit prefix. */
const LABEL_CATEGORIES: Record<string, ReleaseCategoryId> = {
  breaking: 'breaking',
  'breaking change': 'breaking',
  'breaking-change': 'breaking',
  feature: 'features',
  enhancement: 'features',
  'type: feature': 'features',
  bug: 'fixes',
  'bug fix': 'fixes',
  fix: 'fixes',
  'type: bug': 'fixes',
  performance: 'performance',
  documentation: 'docs',
  docs: 'docs',
  'type: docs': 'docs',
};

/** Labels that explicitly keep a pull request out of the changelog. */
const SKIP_LABELS = new Set([
  'skip changelog',
  'skip-changelog',
  'no-changelog',
  'no changelog',
  'internal',
  'wave: internal',
]);

const AUTOMATION_AUTHORS = new Set([
  'dependabot',
  'dependabot[bot]',
  'renovate',
  'renovate[bot]',
  'github-actions',
  'github-actions[bot]',
]);

/** Titles that describe release plumbing rather than a change users can see. */
const NOISY_TITLES: RegExp[] = [
  /^chore\(deps\)/i,
  /^chore\(release\)/i,
  /^chore:\s*(release|bump|version)/i,
  /^release\s*v?\d/i,
  /^bump\s+/i,
  /^merge\s+(branch|pull request|remote-tracking)/i,
  /^update changelog/i,
  /^\[skip changelog\]/i,
];

/** normalisedLabels lowercases and trims the pull request's labels. */
export function normalisedLabels(pr: PullRequestInput): string[] {
  return (pr.labels ?? [])
    .map((label) => String(label).trim().toLowerCase())
    .filter((label) => label.length > 0);
}

/** conventionalType returns the `type` of a conventional-commit title, if any. */
export function conventionalType(title: string): string | null {
  const match = CONVENTIONAL_PREFIX.exec((title ?? '').trim());
  return match ? match[1].toLowerCase() : null;
}

/**
 * A conventional-commit `BREAKING CHANGE:` trailer, optionally inside a list
 * item or bold text. The colon is required on purpose: the pull request
 * template carries a "- [x] No breaking changes" checkbox, and a release note
 * that flags every pull request as breaking is worse than one that misses a
 * change a maintainer can move by hand.
 */
const BREAKING_TRAILER = /^[ \t>*-]*\**\s*BREAKING[ -]CHANGE\s*\**\s*:/im;

/** isBreaking reports whether a pull request must be called out as breaking. */
export function isBreaking(pr: PullRequestInput): boolean {
  const match = CONVENTIONAL_PREFIX.exec((pr.title ?? '').trim());
  if (match && match[2] === '!') return true;
  if (BREAKING_TRAILER.test((pr.body ?? '').replace(/\r\n/g, '\n'))) return true;
  return normalisedLabels(pr).some((label) => LABEL_CATEGORIES[label] === 'breaking');
}

/** classifyPullRequest maps a merged pull request onto exactly one category. */
export function classifyPullRequest(pr: PullRequestInput): ReleaseCategoryId {
  if (isBreaking(pr)) return 'breaking';

  const type = conventionalType(pr.title);
  if (type && TYPE_CATEGORIES[type]) return TYPE_CATEGORIES[type];

  for (const label of normalisedLabels(pr)) {
    const category = LABEL_CATEGORIES[label];
    if (category && category !== 'breaking') return category;
  }

  return 'internal';
}

/**
 * noiseReason returns why a pull request is left out of the changelog even when
 * `--include-internal` is set, or null when it should be kept. Automation and
 * release plumbing are removed here rather than being classified as internal,
 * so the dry run can report exactly what was dropped and why.
 */
export function noiseReason(pr: PullRequestInput): string | null {
  const author = (pr.author ?? '').trim().toLowerCase();
  if (AUTOMATION_AUTHORS.has(author)) {
    return `automation author (${author})`;
  }

  const labels = normalisedLabels(pr);
  if (labels.some((label) => SKIP_LABELS.has(label))) {
    return 'labelled as internal / skip-changelog';
  }
  if (labels.includes('dependencies')) {
    return 'dependency bump';
  }

  const title = (pr.title ?? '').trim();
  if (/\[skip changelog\]/i.test(title)) {
    return 'title asks to skip the changelog';
  }
  for (const pattern of NOISY_TITLES) {
    if (pattern.test(title)) return `release plumbing: ${title.slice(0, 60)}`;
  }

  return null;
}

/** isNoisy reports whether a pull request is dropped outright. */
export function isNoisy(pr: PullRequestInput): boolean {
  return noiseReason(pr) !== null;
}

export interface PlannedGroup {
  category: ReleaseCategory;
  entries: PullRequestInput[];
}

export interface SkippedPullRequest {
  pr: PullRequestInput;
  reason: string;
}

export interface ChangelogPlan {
  /** Populated categories, in print order. */
  groups: PlannedGroup[];
  /** Pull requests that never reach the changelog, with the reason why. */
  skipped: SkippedPullRequest[];
  /** How many pull requests were classified into each category. */
  counts: Record<ReleaseCategoryId, number>;
}

/**
 * planChangelog splits merged pull requests into the categories that will be
 * printed. Entries are ordered by pull request number so a re-run of the same
 * range produces byte-identical output.
 */
export function planChangelog(
  pullRequests: PullRequestInput[],
  options: { includeInternal?: boolean } = {}
): ChangelogPlan {
  const counts = Object.fromEntries(
    RELEASE_CATEGORIES.map((category) => [category.id, 0])
  ) as Record<ReleaseCategoryId, number>;
  const byCategory = new Map<ReleaseCategoryId, PullRequestInput[]>();
  const skipped: SkippedPullRequest[] = [];

  for (const pr of pullRequests) {
    const reason = noiseReason(pr);
    if (reason) {
      skipped.push({ pr, reason });
      continue;
    }
    const category = classifyPullRequest(pr);
    counts[category] += 1;
    const bucket = byCategory.get(category) ?? [];
    bucket.push(pr);
    byCategory.set(category, bucket);
  }

  const groups: PlannedGroup[] = [];
  for (const category of RELEASE_CATEGORIES) {
    if (category.id === 'internal' && !options.includeInternal) continue;
    const entries = byCategory.get(category.id);
    if (!entries || entries.length === 0) continue;
    entries.sort((a, b) => a.number - b.number);
    groups.push({ category, entries });
  }

  return { groups, skipped, counts };
}
