/**
 * Collecting merged pull requests for the changelog (issue #289).
 *
 * Two sources are supported on purpose:
 *
 * - the GitHub REST API, which is what a release run uses, and
 * - a JSON file, which is what `--from` uses so a dry run works offline, in a
 *   test, or on a fork with no token.
 *
 * A token is optional and is only ever placed in the `Authorization` header:
 * it is never put in a URL, a log line or an error message.
 */

import { readFileSync } from 'node:fs';
import type { PullRequestInput } from './categories';
import { redactSecrets } from './redact';

export const DEFAULT_API_BASE = 'https://api.github.com';
export const GITHUB_API_VERSION = '2022-11-28';
export const USER_AGENT = 'stellar-alerts-changelog';

export interface CollectOptions {
  /** `owner/name`. */
  repo: string;
  /** Optional GitHub token; read from GITHUB_TOKEN/GH_TOKEN by the CLI. */
  token?: string | null;
  /** Only keep pull requests merged at or after this ISO timestamp. */
  since?: string | null;
  /** Only keep pull requests merged at or before this ISO timestamp. */
  until?: string | null;
  /** Maximum number of merged pull requests to keep. */
  limit?: number;
  apiBase?: string;
  /** Injectable for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

export interface CollectResult {
  pullRequests: PullRequestInput[];
  source: 'api' | 'file';
  /** Pull requests seen before filtering (merged and unmerged). */
  scanned: number;
  pagesFetched: number;
  /** True when the limit was reached and older merged pull requests remain. */
  truncated: boolean;
}

/** Raw shapes the collector accepts, normalised by `normalisePullRequest`. */
interface RawPullRequest {
  number?: unknown;
  title?: unknown;
  user?: { login?: unknown } | null;
  author?: unknown;
  html_url?: unknown;
  url?: unknown;
  merged_at?: unknown;
  mergedAt?: unknown;
  labels?: unknown;
  body?: unknown;
}

function labelNames(labels: unknown): string[] {
  if (!Array.isArray(labels)) return [];
  return labels
    .map((label) => {
      if (typeof label === 'string') return label;
      if (label && typeof label === 'object' && 'name' in label) {
        return String((label as { name?: unknown }).name ?? '');
      }
      return '';
    })
    .filter((name) => name.length > 0);
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * normalisePullRequest accepts either the GitHub API shape or an already
 * simplified one, so fixtures stay readable and the API needs no adapter layer.
 */
export function normalisePullRequest(raw: RawPullRequest): PullRequestInput {
  const number = Number(raw?.number);
  if (!Number.isFinite(number) || number <= 0) {
    throw new Error('pull request is missing a numeric "number" field');
  }
  const title = asString(raw?.title);
  if (!title) {
    throw new Error(`pull request #${number} is missing a "title"`);
  }
  return {
    number,
    title,
    author: asString(raw?.user?.login) ?? asString(raw?.author),
    url: asString(raw?.html_url) ?? asString(raw?.url),
    mergedAt: asString(raw?.merged_at) ?? asString(raw?.mergedAt),
    labels: labelNames(raw?.labels),
    body: asString(raw?.body),
  };
}

/** parsePullRequestFile reads the JSON fixtures/API dumps the collector accepts. */
export function parsePullRequestFile(contents: string): PullRequestInput[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch (error) {
    throw new Error(`--from file is not valid JSON: ${(error as Error).message}`);
  }

  let rows: unknown[];
  if (Array.isArray(parsed)) {
    rows = parsed;
  } else if (parsed && typeof parsed === 'object') {
    const record = parsed as { pull_requests?: unknown; items?: unknown };
    if (Array.isArray(record.pull_requests)) {
      rows = record.pull_requests;
    } else if (Array.isArray(record.items)) {
      // The GitHub search API wraps results in `items`.
      rows = record.items;
    } else {
      throw new Error(
        '--from file must be an array of pull requests, or an object with a "pull_requests" or "items" array'
      );
    }
  } else {
    throw new Error('--from file must contain a JSON array or object');
  }

  return rows.map((row) => normalisePullRequest(row as RawPullRequest));
}

/** readPullRequestFile reads and parses a pull-request JSON file. */
export function readPullRequestFile(filePath: string): PullRequestInput[] {
  return parsePullRequestFile(readFileSync(filePath, 'utf8'));
}

function withinRange(
  mergedAt: string | null | undefined,
  since: string | null | undefined,
  until: string | null | undefined
): boolean {
  const merged = mergedAt ? Date.parse(mergedAt) : Number.NaN;
  if (!Number.isFinite(merged)) return false;
  if (since) {
    const from = Date.parse(since);
    if (Number.isFinite(from) && merged < from) return false;
  }
  if (until) {
    const to = Date.parse(until);
    if (Number.isFinite(to) && merged > to) return false;
  }
  return true;
}

/**
 * applyWindow keeps only the pull requests whose merge time falls inside the
 * requested window. Entries without a usable `merged_at` are dropped: a release
 * note must not claim a pull request that was closed without being merged.
 */
export function applyWindow(
  pullRequests: PullRequestInput[],
  options: { since?: string | null; until?: string | null } = {}
): PullRequestInput[] {
  return pullRequests.filter((pr) =>
    withinRange(pr.mergedAt, options.since, options.until)
  );
}

/** sortAndLimit orders by pull request number and applies the limit. */
export function sortAndLimit(
  pullRequests: PullRequestInput[],
  limit?: number
): PullRequestInput[] {
  const sorted = [...pullRequests].sort((a, b) => a.number - b.number);
  return limit && limit > 0 ? sorted.slice(0, limit) : sorted;
}

/** filterMergedPullRequests applies the window and the limit in one step. */
export function filterMergedPullRequests(
  pullRequests: PullRequestInput[],
  options: { since?: string | null; until?: string | null; limit?: number } = {}
): PullRequestInput[] {
  return sortAndLimit(applyWindow(pullRequests, options), options.limit);
}

/**
 * collectMergedPullRequests walks the closed-pull-request pages of a repository
 * and returns the ones that were actually merged inside the requested window.
 */
export async function collectMergedPullRequests(
  options: CollectOptions
): Promise<CollectResult> {
  const apiBase = (options.apiBase ?? DEFAULT_API_BASE).replace(/\/+$/, '');
  const doFetch = options.fetchImpl ?? fetch;
  const perPage = 100;
  const limit = options.limit && options.limit > 0 ? options.limit : 500;
  const maxPages = Math.max(1, Math.ceil(limit / perPage) + 1);

  const merged: PullRequestInput[] = [];
  let scanned = 0;
  let pagesFetched = 0;
  let truncated = false;

  for (let page = 1; page <= maxPages; page += 1) {
    const query = new URLSearchParams({
      state: 'closed',
      sort: 'updated',
      direction: 'desc',
      per_page: String(perPage),
      page: String(page),
    });
    const path = `/repos/${options.repo}/pulls?${query.toString()}`;
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': GITHUB_API_VERSION,
      'User-Agent': USER_AGENT,
    };
    // The token only ever travels in the header, never in the URL.
    if (options.token) headers.Authorization = `Bearer ${options.token}`;

    const response = await doFetch(`${apiBase}${path}`, { headers });
    pagesFetched += 1;

    if (!response.ok) {
      const detail = redactSecrets((await safeText(response)).slice(0, 300));
      throw new Error(
        `GitHub API ${response.status} for ${path}: ${detail || response.statusText}`
      );
    }

    const payload = (await response.json()) as unknown;
    if (!Array.isArray(payload)) {
      throw new Error(`GitHub API returned ${typeof payload}, expected an array`);
    }
    if (payload.length === 0) break;

    scanned += payload.length;
    for (const row of payload) {
      const pr = normalisePullRequest(row as RawPullRequest);
      if (!withinRange(pr.mergedAt, options.since, options.until)) continue;
      merged.push(pr);
    }

    if (merged.length >= limit) {
      truncated = true;
      break;
    }
    if (payload.length < perPage) break;
  }

  const limited = filterMergedPullRequests(merged, { limit });
  if (limited.length < merged.length) truncated = true;

  return {
    pullRequests: limited,
    source: 'api',
    scanned,
    pagesFetched,
    truncated,
  };
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}
