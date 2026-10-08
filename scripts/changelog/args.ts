/**
 * Command-line parsing for the changelog generator (issue #289).
 *
 * Kept separate from the CLI entry point so the flags - especially the
 * destructive ones - are unit-tested. Two rules matter:
 *
 * - nothing is written unless `--write` is passed: the default is a dry run;
 * - the GitHub token is read from the environment, never from a flag, so it
 *   cannot end up in a shell history or a `ps` listing.
 */

export const DEFAULT_REPO = 'stellar-alerts-labs/stellar-alerts';
export const DEFAULT_LIMIT = 200;
export const DEFAULT_VERSION = 'Unreleased';

export interface CliOptions {
  repo: string;
  version: string;
  /** Path to a pull-request JSON file; makes the run offline. */
  from?: string;
  since?: string;
  until?: string;
  date?: string;
  limit: number;
  /** True unless `--write` was passed. */
  dryRun: boolean;
  /** Update CHANGELOG.md. Only ever true with an explicit `--write`. */
  write: boolean;
  /** Optional path for a standalone copy of the rendered section. */
  out?: string;
  includeInternal: boolean;
  help: boolean;
}

export const USAGE = `Generate a release-note section from merged pull requests.

Usage:
  npx tsx scripts/generate-changelog.ts [options]

Options:
  --repo <owner/name>   Repository to read (default: $GITHUB_REPOSITORY or ${DEFAULT_REPO})
  --version <label>     Section heading, e.g. 1.4.0 (default: ${DEFAULT_VERSION})
  --date <YYYY-MM-DD>   Date to print next to the version (default: today, UTC)
  --from <file.json>    Read pull requests from a file instead of the API
  --since <ISO date>    Only include pull requests merged at or after this time
  --until <ISO date>    Only include pull requests merged at or before this time
  --limit <n>           Maximum merged pull requests to keep (default: ${DEFAULT_LIMIT})
  --out <file>          Also write the rendered section to this file
  --include-internal    List refactors, chores, CI and tests too
  --write               Update CHANGELOG.md (otherwise the run is a dry run)
  --dry-run             Explicitly do not write anything (the default)
  -h, --help            Show this message

The GitHub token is read from $GITHUB_TOKEN or $GH_TOKEN. It is optional: without
one the API is read anonymously and rate limits are lower. Reads work offline with
--from, which is how the dry-run artifact in .github/workflows/changelog.yml is
produced in environments without network access.
`;

/** flagValue reads `--flag value` and rejects a missing value. */
function flagValue(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function parseDate(value: string, flag: string): string {
  if (!Number.isFinite(Date.parse(value))) {
    throw new Error(`${flag} must be an ISO-8601 date or timestamp, got "${value}"`);
  }
  return value;
}

/**
 * parseArgs turns argv (without the node/script prefix) into CLI options.
 * Throws a message suitable for printing when an argument is invalid.
 */
export function parseArgs(
  argv: string[],
  env: Record<string, string | undefined> = process.env
): CliOptions {
  const options: CliOptions = {
    repo: env.GITHUB_REPOSITORY || DEFAULT_REPO,
    version: DEFAULT_VERSION,
    limit: DEFAULT_LIMIT,
    dryRun: true,
    write: false,
    includeInternal: false,
    help: false,
  };
  let writeRequested = false;
  let dryRunRequested = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--repo':
        options.repo = flagValue(argv, i, arg);
        i += 1;
        break;
      case '--version':
        options.version = flagValue(argv, i, arg);
        i += 1;
        break;
      case '--from':
        options.from = flagValue(argv, i, arg);
        i += 1;
        break;
      case '--since':
        options.since = parseDate(flagValue(argv, i, arg), arg);
        i += 1;
        break;
      case '--until':
        options.until = parseDate(flagValue(argv, i, arg), arg);
        i += 1;
        break;
      case '--date':
        options.date = parseDate(flagValue(argv, i, arg), arg);
        i += 1;
        break;
      case '--out':
        options.out = flagValue(argv, i, arg);
        i += 1;
        break;
      case '--limit': {
        const raw = flagValue(argv, i, arg);
        const limit = Number(raw);
        if (!Number.isInteger(limit) || limit <= 0) {
          throw new Error(`--limit must be a positive integer, got "${raw}"`);
        }
        options.limit = limit;
        i += 1;
        break;
      }
      case '--include-internal':
        options.includeInternal = true;
        break;
      case '--write':
        writeRequested = true;
        break;
      case '--dry-run':
        dryRunRequested = true;
        break;
      case '-h':
      case '--help':
        options.help = true;
        break;
      default:
        throw new Error(`unknown argument "${arg}"`);
    }
  }

  if (writeRequested && dryRunRequested) {
    throw new Error('--write and --dry-run cannot be combined');
  }
  options.write = writeRequested;
  options.dryRun = !writeRequested;

  if (!options.repo.includes('/')) {
    throw new Error(`--repo must be "owner/name", got "${options.repo}"`);
  }
  if (!options.version.trim()) {
    throw new Error('--version must not be empty');
  }
  return options;
}

/** readToken returns the GitHub token from the environment, if any. */
export function readToken(
  env: Record<string, string | undefined> = process.env
): string | undefined {
  const token = env.GITHUB_TOKEN || env.GH_TOKEN;
  return token && token.trim() ? token.trim() : undefined;
}
