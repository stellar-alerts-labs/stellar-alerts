import { describe, expect, it } from 'vitest';

import {
  classifyPullRequest,
  conventionalType,
  isBreaking,
  isNoisy,
  noiseReason,
  normalisedLabels,
  planChangelog,
  RELEASE_CATEGORIES,
  type PullRequestInput,
} from './categories';

function pr(overrides: Partial<PullRequestInput> = {}): PullRequestInput {
  return {
    number: 1,
    title: 'feat: something',
    author: 'alice',
    url: 'https://github.com/o/r/pull/1',
    mergedAt: '2026-09-20T10:00:00Z',
    labels: [],
    body: '',
    ...overrides,
  };
}

describe('release categories', () => {
  it('prints breaking changes first and internal last', () => {
    const ids = RELEASE_CATEGORIES.map((category) => category.id);
    expect(ids[0]).toBe('breaking');
    expect(ids[ids.length - 1]).toBe('internal');
    const orders = RELEASE_CATEGORIES.map((category) => category.order);
    expect([...orders].sort((a, b) => a - b)).toEqual(orders);
  });

  it('excludes exactly one category by default', () => {
    const excluded = RELEASE_CATEGORIES.filter((c) => !c.includeByDefault);
    expect(excluded.map((c) => c.id)).toEqual(['internal']);
  });
});

describe('classifyPullRequest', () => {
  it.each([
    ['feat: add wallet watcher', 'features'],
    ['feat(api): add wallet watcher', 'features'],
    ['fix: stop double notifications', 'fixes'],
    ['perf: cache the horizon response', 'performance'],
    ['docs: explain the webhook signature', 'docs'],
  ])('maps "%s" to %s', (title, expected) => {
    expect(classifyPullRequest(pr({ title }))).toBe(expected);
  });

  it.each(['chore: bump deps', 'refactor: split the worker', 'ci: cache npm', 'test: cover the cursor', 'build: bump node'])(
    'keeps "%s" internal',
    (title) => {
      expect(classifyPullRequest(pr({ title }))).toBe('internal');
    }
  );

  it('treats a "!" conventional prefix as breaking', () => {
    expect(classifyPullRequest(pr({ title: 'feat(api)!: drop the v1 callback' }))).toBe(
      'breaking'
    );
  });

  it('treats a BREAKING CHANGE trailer as breaking', () => {
    expect(
      classifyPullRequest(pr({ title: 'fix: rework retries', body: 'BREAKING CHANGE: retries are opt-in' }))
    ).toBe('breaking');
    expect(
      classifyPullRequest(pr({ title: 'fix: rework retries', body: '**BREAKING CHANGE**: opt-in' }))
    ).toBe('breaking');
    expect(
      classifyPullRequest(pr({ title: 'fix: rework retries', body: '- BREAKING-CHANGE: opt-in' }))
    ).toBe('breaking');
  });

  it('does not treat a "no breaking changes" checkbox as breaking', () => {
    // The repository's pull request template asks for exactly this line, and
    // every pull request that keeps the checklist would otherwise be published
    // at the top of the release note.
    const templateBody = ['## Checklist', '', '- [x] Tests pass', '- [x] No breaking changes'].join(
      '\n'
    );
    expect(classifyPullRequest(pr({ title: 'fix: rework retries', body: templateBody }))).toBe(
      'fixes'
    );
    expect(isBreaking(pr({ title: 'feat: x', body: 'This is not a breaking change for anyone' }))).toBe(
      false
    );
  });

  it('treats a breaking-change label as breaking', () => {
    expect(classifyPullRequest(pr({ title: 'chore: tidy', labels: ['Breaking Change'] }))).toBe(
      'breaking'
    );
  });

  it('falls back to labels when the title has no conventional prefix', () => {
    expect(classifyPullRequest(pr({ title: 'Wallet watcher', labels: ['enhancement'] }))).toBe(
      'features'
    );
    expect(classifyPullRequest(pr({ title: 'Double notifications', labels: ['bug'] }))).toBe(
      'fixes'
    );
    expect(classifyPullRequest(pr({ title: 'Signature docs', labels: ['documentation'] }))).toBe(
      'docs'
    );
  });

  it('prefers the title prefix over a label', () => {
    expect(classifyPullRequest(pr({ title: 'fix: flaky cursor', labels: ['enhancement'] }))).toBe(
      'fixes'
    );
  });

  it('falls back to internal for an unlabelled, unprefixed title', () => {
    expect(classifyPullRequest(pr({ title: 'Misc tidying' }))).toBe('internal');
  });
});

describe('isBreaking / conventionalType', () => {
  it('reads the conventional type', () => {
    expect(conventionalType('feat(api): x')).toBe('feat');
    expect(conventionalType('FIX: x')).toBe('fix');
    expect(conventionalType('no prefix here')).toBeNull();
  });

  it('is not breaking without a marker', () => {
    expect(isBreaking(pr({ title: 'feat: x', body: 'plain body' }))).toBe(false);
  });
});

describe('noise filtering', () => {
  it.each([
    ['dependabot[bot]', 'chore(deps): bump axios', 'automation author'],
    ['renovate[bot]', 'Update dependency vitest', 'automation author'],
    ['github-actions[bot]', 'chore: release 1.2.3', 'automation author'],
  ])('drops %s pull requests', (author, title, expected) => {
    const reason = noiseReason(pr({ author, title }));
    expect(reason).toContain(expected);
  });

  it('drops a release-plumbing title from a human', () => {
    expect(noiseReason(pr({ author: 'alice', title: 'chore(release): 1.4.0' }))).toContain(
      'release plumbing'
    );
    expect(noiseReason(pr({ author: 'alice', title: 'Bump axios from 1.0.0 to 1.1.0' }))).toBeTruthy();
    expect(noiseReason(pr({ author: 'alice', title: 'Update changelog' }))).toBeTruthy();
  });

  it('drops pull requests that ask to be skipped', () => {
    expect(noiseReason(pr({ title: 'feat: secret work', labels: ['skip changelog'] }))).toContain(
      'skip-changelog'
    );
    expect(noiseReason(pr({ title: '[skip changelog] tidy up' }))).toContain('skip the changelog');
    expect(noiseReason(pr({ title: 'feat: x', labels: ['dependencies'] }))).toBe('dependency bump');
  });

  it('keeps an ordinary merged pull request', () => {
    expect(noiseReason(pr({ title: 'feat: add the wallet watcher' }))).toBeNull();
    expect(isNoisy(pr({ title: 'fix: stop double notifications' }))).toBe(false);
  });

  it('normalises labels before matching', () => {
    expect(normalisedLabels(pr({ labels: ['  Bug  ', '', 'ENHANCEMENT'] }))).toEqual([
      'bug',
      'enhancement',
    ]);
  });
});

describe('planChangelog', () => {
  const pullRequests: PullRequestInput[] = [
    pr({ number: 30, title: 'feat: watcher' }),
    pr({ number: 10, title: 'fix: notifications' }),
    pr({ number: 20, title: 'chore: tidy the worker' }),
    pr({ number: 40, title: 'chore(deps): bump axios', author: 'dependabot[bot]' }),
    pr({ number: 50, title: 'feat(api)!: drop the v1 callback' }),
  ];

  it('groups by category, ordered by category then pull request number', () => {
    const plan = planChangelog(pullRequests);
    expect(plan.groups.map((group) => group.category.id)).toEqual(['breaking', 'features', 'fixes']);
    expect(plan.groups[0].entries.map((entry) => entry.number)).toEqual([50]);
    expect(plan.groups[1].entries.map((entry) => entry.number)).toEqual([30]);
    expect(plan.groups[2].entries.map((entry) => entry.number)).toEqual([10]);
  });

  it('counts every pull request and lists the dropped ones with a reason', () => {
    const plan = planChangelog(pullRequests);
    expect(plan.counts).toMatchObject({
      breaking: 1,
      features: 1,
      fixes: 1,
      internal: 1,
    });
    expect(plan.skipped).toHaveLength(1);
    expect(plan.skipped[0].pr.number).toBe(40);
    expect(plan.skipped[0].reason).toContain('automation author');
  });

  it('omits internal pull requests unless asked for them', () => {
    expect(planChangelog(pullRequests).groups.map((g) => g.category.id)).not.toContain('internal');
    const withInternal = planChangelog(pullRequests, { includeInternal: true });
    expect(withInternal.groups.map((g) => g.category.id)).toContain('internal');
    const internal = withInternal.groups.find((g) => g.category.id === 'internal');
    expect(internal?.entries.map((entry) => entry.number)).toEqual([20]);
  });

  it('returns no groups for a range with nothing worth announcing', () => {
    const plan = planChangelog([pr({ number: 7, title: 'refactor: split the worker' })]);
    expect(plan.groups).toEqual([]);
    expect(plan.counts.internal).toBe(1);
  });
});
