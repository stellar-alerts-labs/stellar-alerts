import { describe, expect, it, vi } from 'vitest';

import {
  applyWindow,
  collectMergedPullRequests,
  filterMergedPullRequests,
  normalisePullRequest,
  parsePullRequestFile,
  sortAndLimit,
} from './collect';

/** A GitHub API shaped pull request. */
function apiPullRequest(overrides: Record<string, unknown> = {}) {
  return {
    number: 12,
    title: 'feat: add the wallet watcher',
    user: { login: 'alice' },
    html_url: 'https://github.com/stellar-alerts-labs/stellar-alerts/pull/12',
    merged_at: '2026-09-20T10:00:00Z',
    labels: [{ name: 'Stellar Wave' }, { name: 'enhancement' }],
    body: 'Adds a watcher.',
    ...overrides,
  };
}

/** A minimal fetch double that returns queued pages and records the calls. */
function fetchStub(pages: Array<{ status?: number; body?: unknown; text?: string }>) {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const index = calls.length;
    calls.push({
      url: String(url),
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    const page = pages[index] ?? { body: [] };
    const status = page.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: status === 200 ? 'OK' : 'Error',
      json: async () => page.body ?? [],
      text: async () => page.text ?? '',
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

describe('normalisePullRequest', () => {
  it('reads the GitHub API shape', () => {
    expect(normalisePullRequest(apiPullRequest())).toEqual({
      number: 12,
      title: 'feat: add the wallet watcher',
      author: 'alice',
      url: 'https://github.com/stellar-alerts-labs/stellar-alerts/pull/12',
      mergedAt: '2026-09-20T10:00:00Z',
      labels: ['Stellar Wave', 'enhancement'],
      body: 'Adds a watcher.',
    });
  });

  it('accepts a simplified fixture shape', () => {
    const pr = normalisePullRequest({
      number: 5,
      title: 'fix: x',
      author: 'bob',
      mergedAt: '2026-09-01T00:00:00Z',
      labels: ['bug'],
    });
    expect(pr.author).toBe('bob');
    expect(pr.url).toBeNull();
    expect(pr.labels).toEqual(['bug']);
  });

  it('rejects a row that cannot become a release note', () => {
    expect(() => normalisePullRequest({ title: 'no number' } as never)).toThrow(/number/);
    expect(() => normalisePullRequest({ number: 3 } as never)).toThrow(/title/);
  });
});

describe('parsePullRequestFile', () => {
  const rows = [apiPullRequest(), apiPullRequest({ number: 13, title: 'fix: y' })];

  it('accepts an array, the GitHub search envelope and a "pull_requests" envelope', () => {
    expect(parsePullRequestFile(JSON.stringify(rows))).toHaveLength(2);
    expect(parsePullRequestFile(JSON.stringify({ items: rows }))).toHaveLength(2);
    expect(parsePullRequestFile(JSON.stringify({ pull_requests: rows }))).toHaveLength(2);
  });

  it('explains what is wrong with an unusable file', () => {
    expect(() => parsePullRequestFile('not json')).toThrow(/not valid JSON/);
    expect(() => parsePullRequestFile('{"other": true}')).toThrow(/pull_requests/);
    expect(() => parsePullRequestFile('42')).toThrow(/array or object/);
  });
});

describe('applyWindow / sortAndLimit', () => {
  const rows = [
    { number: 3, title: 'fix: c', mergedAt: '2026-09-30T00:00:00Z' },
    { number: 1, title: 'fix: a', mergedAt: '2026-09-01T00:00:00Z' },
    { number: 2, title: 'feat: b', mergedAt: null },
    { number: 4, title: 'feat: d', mergedAt: '2026-09-15T00:00:00Z' },
  ];

  it('keeps only the merged pull requests inside the window', () => {
    expect(applyWindow(rows).map((pr) => pr.number)).toEqual([3, 1, 4]);
    expect(
      applyWindow(rows, { since: '2026-09-10T00:00:00Z' }).map((pr) => pr.number)
    ).toEqual([3, 4]);
    expect(
      applyWindow(rows, { until: '2026-09-10T00:00:00Z' }).map((pr) => pr.number)
    ).toEqual([1]);
  });

  it('sorts by number and applies the limit', () => {
    expect(sortAndLimit(rows).map((pr) => pr.number)).toEqual([1, 2, 3, 4]);
    expect(sortAndLimit(rows, 2).map((pr) => pr.number)).toEqual([1, 2]);
  });

  it('combines both in filterMergedPullRequests', () => {
    expect(filterMergedPullRequests(rows, { limit: 1 }).map((pr) => pr.number)).toEqual([1]);
  });
});

describe('collectMergedPullRequests', () => {
  it('paginates until a short page and keeps only merged pull requests', async () => {
    const fullPage = Array.from({ length: 100 }, (_, index) =>
      apiPullRequest({ number: index + 1 })
    );
    fullPage[0] = apiPullRequest({ number: 1, merged_at: null });
    const { fetchImpl, calls } = fetchStub([
      { body: fullPage },
      { body: [apiPullRequest({ number: 101 })] },
    ]);

    const result = await collectMergedPullRequests({
      repo: 'stellar-alerts-labs/stellar-alerts',
      fetchImpl,
    });

    expect(calls).toHaveLength(2);
    expect(result.scanned).toBe(101);
    expect(result.pullRequests).toHaveLength(100);
    expect(result.pullRequests.map((pr) => pr.number)).toContain(101);
    // Closed without being merged, so it is not a release note.
    expect(result.pullRequests.map((pr) => pr.number)).not.toContain(1);
    expect(result.source).toBe('api');
    expect(result.truncated).toBe(false);
    expect(calls[0].url).toContain('/repos/stellar-alerts-labs/stellar-alerts/pulls?');
    expect(calls[0].url).toContain('state=closed');
    expect(calls[1].url).toContain('page=2');
  });

  it('sends the token in the header and never in the URL', async () => {
    const { fetchImpl, calls } = fetchStub([{ body: [] }]);

    await collectMergedPullRequests({
      repo: 'o/r',
      token: 'test-token-not-a-real-credential',
      fetchImpl,
    });

    expect(calls[0].headers.Authorization).toBe('Bearer test-token-not-a-real-credential');
    expect(calls[0].url).not.toContain('test-token');
    expect(calls[0].headers['User-Agent']).toBeTruthy();
  });

  it('filters by merge date and marks a truncated scan', async () => {
    const { fetchImpl } = fetchStub([
      {
        body: [
          apiPullRequest({ number: 1, merged_at: '2026-01-01T00:00:00Z' }),
          apiPullRequest({ number: 2, merged_at: '2026-09-20T00:00:00Z' }),
          apiPullRequest({ number: 3, merged_at: '2026-09-25T00:00:00Z' }),
        ],
      },
    ]);

    const result = await collectMergedPullRequests({
      repo: 'o/r',
      since: '2026-09-01T00:00:00Z',
      limit: 1,
      fetchImpl,
    });

    expect(result.pullRequests.map((pr) => pr.number)).toEqual([2]);
    expect(result.truncated).toBe(true);
  });

  it('reports an API failure with the status and path', async () => {
    const { fetchImpl } = fetchStub([{ status: 403, text: 'API rate limit exceeded' }]);

    await expect(
      collectMergedPullRequests({ repo: 'o/r', fetchImpl })
    ).rejects.toThrow(/403.*rate limit/s);
  });
});
