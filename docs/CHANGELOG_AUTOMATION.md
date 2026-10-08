# Changelog automation

Release notes are generated from the metadata of **merged pull requests**, so the
notes describe what actually shipped and who shipped it. The generator lives in
`scripts/generate-changelog.ts` and is safe by default: it prints a section for
review and only touches `CHANGELOG.md` when you pass `--write`.

## Quick start

```bash
# Review the section for the next release (nothing is written).
npm run changelog:dry-run -- --version 1.4.0 --since 2026-09-01

# Offline, with no token and no network, from a sample file.
npx tsx scripts/generate-changelog.ts \
  --from scripts/changelog/fixtures/sample-pull-requests.json --version 1.4.0

# Update CHANGELOG.md once the section reads well.
npm run changelog:write -- --version 1.4.0 --since 2026-09-01
```

A dry run prints the section, then a summary of what was kept, dropped and
scrubbed:

```text
## [1.4.0] - 2026-09-27

_Generated from 5 merged pull requests._

### ⚠️ Breaking Changes

- feat(api)!: require the X-Signature header on every webhook ([#405](...)) by @carol

### ✨ Features

- feat(api): watch anchor deposit transactions ([#401](...)) by @alice
...

Release notes summary
---------------------
source:            GitHub API
merged PRs kept:   5
closed PRs scanned: 84
breaking     1
features     1
...
warning: 3 pull requests skipped as automation or release plumbing
```

## Categories

A merged pull request is classified by its conventional-commit prefix, then by
its labels, then as internal:

| Section | What lands there | How it is detected |
| --- | --- | --- |
| ⚠️ Breaking Changes | Behaviour or configuration users must act on | `feat!:` / `fix!:` prefix, a `BREAKING CHANGE:` trailer, or a `breaking-change` label |
| ✨ Features | New user-visible capability | `feat:` prefix, or a `feature` / `enhancement` label |
| 🐛 Fixes | Bug fixes | `fix:` prefix, or a `bug` label |
| ⚡ Performance | Speed, cost or resource wins | `perf:` prefix, or a `performance` label |
| 📚 Documentation | Docs readers or API consumers can act on | `docs:` prefix, or a `docs` / `documentation` label |
| 🔧 Internal | Refactors, chores, CI, tests, build, deps, anything unlabelled | everything else; **excluded unless `--include-internal`** |

The rules live in `scripts/changelog/categories.ts` and are covered by
`scripts/changelog/categories.test.ts`. If a section feels wrong, change the rule
there rather than editing generated text by hand.

## What is never included

- **Automation.** Pull requests from `dependabot[bot]`, `renovate[bot]` and
  `github-actions[bot]`, or anything labelled `dependencies`, are dropped. So are
  release-plumbing titles such as `chore(release): 1.5.0` or `Update changelog`.
- **Pull requests that opt out.** Label a pull request `skip changelog`,
  `no-changelog` or `internal`, or put `[skip changelog]` in the title, and it is
  left out even when internal work is listed.
- **Unmerged work.** Only pull requests with a `merged_at` timestamp inside the
  requested window are considered, so a closed-without-merge pull request never
  appears in a release note.
- **Secrets.** Every title, author and body passes through
  `scripts/changelog/redact.ts` before rendering: GitHub, Slack, Stripe and AWS
  credentials, JWTs, Stellar secret seeds (`S…`), `Authorization: Bearer` headers
  and private key blocks are replaced with `[redacted]`. `--write` re-checks the
  rendered text and refuses to touch `CHANGELOG.md` if anything credential-shaped
  survives. The GitHub token itself is read from `GITHUB_TOKEN` / `GH_TOKEN` and
  only ever travels in an `Authorization` header - never in a URL and never in
  the output.

## Flags

| Flag | Meaning |
| --- | --- |
| `--repo <owner/name>` | Repository to read; defaults to `$GITHUB_REPOSITORY` |
| `--version <label>` | Section heading, for example `1.4.0` or `Unreleased` |
| `--date <YYYY-MM-DD>` | Date printed next to the version; defaults to today (UTC) |
| `--from <file.json>` | Read pull requests from a file instead of the API |
| `--since <ISO date>` / `--until <ISO date>` | Limit by merge time |
| `--limit <n>` | Maximum merged pull requests to keep (default 200) |
| `--out <file>` | Also write the rendered section to a file |
| `--include-internal` | List refactors, chores, CI and tests too |
| `--write` | Update `CHANGELOG.md` (the only flag that writes anything) |
| `--dry-run` | Explicitly write nothing; this is the default |

`--write` and `--dry-run` cannot be combined, and the run stops with an error
when nothing was collected.

## GitHub Actions

`.github/workflows/changelog.yml` runs the generator on demand
(**Actions → Changelog → Run workflow**), uploads the generated section as the
`changelog-dry-run` artifact, and never commits: the release manager reviews the
artifact, then lands it in `CHANGELOG.md` through a pull request. It needs no
secrets beyond the automatic `GITHUB_TOKEN`, which the workflow passes through
the environment rather than the command line.

`CHANGELOG.md` is written newest-first, and re-running the same version replaces
that section in place, so running the release twice is not additive.

## Tests

```bash
npm run test:scripts
```

covers category classification, noise filtering, credential scrubbing, API
pagination (against a stubbed `fetch`), rendering and the end-to-end offline dry
run over the sample file.
