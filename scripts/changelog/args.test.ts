import { describe, expect, it } from 'vitest';

import {
  DEFAULT_LIMIT,
  DEFAULT_REPO,
  parseArgs,
  readToken,
  USAGE,
} from './args';

/** No ambient configuration: the tests always state what they rely on. */
const NO_ENV = {};

describe('parseArgs defaults', () => {
  it('is a dry run for the default repository', () => {
    const options = parseArgs([], NO_ENV);
    expect(options).toMatchObject({
      repo: DEFAULT_REPO,
      version: 'Unreleased',
      limit: DEFAULT_LIMIT,
      dryRun: true,
      write: false,
      includeInternal: false,
      help: false,
    });
    expect(options.from).toBeUndefined();
    expect(options.out).toBeUndefined();
  });

  it('prefers the repository CI checked out', () => {
    expect(parseArgs([], { GITHUB_REPOSITORY: 'o/r' }).repo).toBe('o/r');
    expect(parseArgs(['--repo', 'other/repo'], { GITHUB_REPOSITORY: 'o/r' }).repo).toBe(
      'other/repo'
    );
  });
});

describe('parseArgs flags', () => {
  it('reads every value flag', () => {
    const options = parseArgs(
      [
        '--repo',
        'o/r',
        '--version',
        '1.4.0',
        '--from',
        'fixture.json',
        '--since',
        '2026-09-01T00:00:00Z',
        '--until',
        '2026-09-30T00:00:00Z',
        '--date',
        '2026-09-27',
        '--limit',
        '25',
        '--out',
        'notes.md',
        '--include-internal',
      ],
      NO_ENV
    );

    expect(options).toMatchObject({
      repo: 'o/r',
      version: '1.4.0',
      from: 'fixture.json',
      since: '2026-09-01T00:00:00Z',
      until: '2026-09-30T00:00:00Z',
      date: '2026-09-27',
      limit: 25,
      out: 'notes.md',
      includeInternal: true,
    });
  });

  it('only writes when --write is explicit', () => {
    const written = parseArgs(['--version', '1.4.0', '--write'], NO_ENV);
    expect(written.write).toBe(true);
    expect(written.dryRun).toBe(false);

    const dryRun = parseArgs(['--version', '1.4.0', '--dry-run'], NO_ENV);
    expect(dryRun.write).toBe(false);
    expect(dryRun.dryRun).toBe(true);
  });

  it('refuses --write together with --dry-run', () => {
    expect(() => parseArgs(['--write', '--dry-run'], NO_ENV)).toThrow(
      /cannot be combined/
    );
  });

  it('shows help', () => {
    expect(parseArgs(['--help'], NO_ENV).help).toBe(true);
    expect(parseArgs(['-h'], NO_ENV).help).toBe(true);
    expect(USAGE).toContain('--from');
    expect(USAGE).toContain('GITHUB_TOKEN');
  });
});

describe('parseArgs validation', () => {
  it.each([
    [['--unknown'], /unknown argument/],
    [['--limit', '0'], /positive integer/],
    [['--limit', 'ten'], /positive integer/],
    [['--repo'], /requires a value/],
    [['--repo', '--version', '1.0.0'], /requires a value/],
    [['--repo', 'not-a-repo'], /owner\/name/],
    [['--version', ''], /must not be empty/],
    [['--since', 'yesterday'], /ISO-8601/],
    [['--date', 'x'], /ISO-8601/],
  ])('rejects %j', (argv, expected) => {
    expect(() => parseArgs(argv as string[], NO_ENV)).toThrow(expected as RegExp);
  });
});

describe('readToken', () => {
  it('reads a token from the environment', () => {
    expect(readToken({ GITHUB_TOKEN: 'from-github' })).toBe('from-github');
    expect(readToken({ GH_TOKEN: 'from-gh' })).toBe('from-gh');
    expect(readToken({ GITHUB_TOKEN: 'first', GH_TOKEN: 'second' })).toBe('first');
  });

  it('treats an empty or blank token as absent', () => {
    expect(readToken({})).toBeUndefined();
    expect(readToken({ GITHUB_TOKEN: '' })).toBeUndefined();
    expect(readToken({ GITHUB_TOKEN: '   ' })).toBeUndefined();
  });
});
