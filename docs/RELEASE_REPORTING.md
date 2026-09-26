# Release dependency & license reporting, SBOM generation & policy enforcement

`scripts/release-report.ts` produces the legal/provenance paperwork every
release needs and enforces it as a gate (issue #339):

| Artifact | Purpose |
| :--- | :--- |
| `release-artifacts/sbom.cdx.json` | CycloneDX 1.5 SBOM covering every resolved third-party package in `package-lock.json`. Feed it to a customer's SCA tooling or an attestation/`cosign` step. |
| `release-artifacts/license-report.json` | Machine-readable license inventory, per-package scope, and any policy violations. |
| `release-artifacts/license-report.md` | The same report rendered for humans (also appended to the GitHub Actions job summary). |

Plus whatever vulnerability report you hand it (`release-artifacts/osv-report.json`
in the release workflow) — findings at or above the configured severities are
policy violations too, so the SBOM/report generation and the CVE gate share one
exit code instead of two unrelated jobs.

## Running locally

```bash
npm run release:report                              # write release-artifacts/{sbom.cdx.json,license-report.json,license-report.md}
npm run release:report:check                        # evaluate the policies, write nothing, exit non-zero on a violation
npx tsx scripts/release-report.ts --warn-only       # report violations but exit 0 (for triage/experiments)
```

Flags:

| Flag | Default | Meaning |
| :--- | :--- | :--- |
| `--lockfile <path>` | `package-lock.json` | npm v3 lockfile to inventory. |
| `--policy <path>` | `release-policy.json` | Policy to enforce. |
| `--vulnerability-report <path>` | *(none)* | JSON written by `scripts/security-audit.ts --report <file>`; when omitted the vulnerability half of the gate is skipped with a warning. |
| `--out-dir <path>` | `release-artifacts/` | Where the three artifacts are written. |
| `--release-version <version>` | `package.json` `version` | Version stamped into the SBOM component and the report header (the release workflow passes the git tag with the leading `v` stripped). |
| `--check` | — | Never write files (used by CI on every push/PR). |
| `--warn-only` | — | Log violations but keep the exit code 0. |

## Why the lockfile, and why no new dependency

Like `scripts/security-audit.ts`, this script reads `package-lock.json` and uses
Node built-ins only (`node:fs`, `node:crypto`, `node:path`, `node:url`) — no
`@cyclonedx/cyclonedx-npm`, no SPDX toolchain, nothing to keep patched. The
lockfile is already the source of truth CI treats as authoritative for the OSV
scan, and it carries the exact resolved version *and* the declared license of
every transitive package, which is what a release SBOM is about.

Consequences worth knowing:

- A package installed but absent from the lockfile (or vice versa) does not
  appear; `npm ci` in CI guarantees the two agree.
- Workspace-local packages (`apps/*`, `packages/*`) are skipped — they are not
  registry dependencies and carry no third-party license to enforce.
- Duplicate copies nested under another package's `node_modules` are
  deduplicated by name+version, and everything is sorted, so two runs over the
  same lockfile produce identical output.

## The policy file (`release-policy.json`)

```jsonc
{
  "allowedLicenses": ["MIT", "Apache-2.0", "..."],   // exact SPDX ids, matched case-insensitively
  "deniedLicenses": ["AGPL-3.0-only", "..."],        // hard block, checked before the allow list
  "allowUnknownLicense": false,                      // true = missing metadata is acceptable
  "failOnVulnerabilitySeverities": ["CRITICAL", "HIGH"],
  "exceptions": [
    { "package": "esprima", "version": "1.2.5", "license": "UNKNOWN", "reason": "..." }
  ]
}
```

A malformed policy (wrong type, exception without a `reason`) throws and fails
the run rather than silently disabling the gate.

Evaluation order per package, first match wins:

1. **Reviewed exception** — `package` must match and, if present, `version`
   (`*` or omitted = any) and `license` (matched case-insensitively). Every
   exception needs a written `reason`; it is the audit trail.
2. **Denied list** — any identifier in the expression matching a denied entry
   is fatal, even inside an `OR` where the other branch would be acceptable.
3. **Unknown handling** — `UNKNOWN` (also `UNLICENSED`, `NONE`, `SEE LICENSE
   IN …`, empty) violates unless `allowUnknownLicense` is `true`. This is
   deliberately checked *before* the allow list, so `(MIT OR UNKNOWN)` still
   demands review instead of quietly resolving to `MIT`.
4. **Allow list** — a non-empty allow list means everything not on it is a
   violation. `A AND B` requires every operand; `A OR B` requires one. An empty
   allow list turns the script into a deny-list-only gate.

Operator parsing handles the shapes that actually show up in lockfiles:
parentheses, mixed-case `and`/`or`/`WITH`, and a trailing `+`
(`GPL-2.0+` matches an allow/deny entry of `GPL-2.0`). A genuinely malformed
expression (unbalanced parentheses) aborts the run with the offending
expression in the message — an exception for that package is the escape hatch.

### Why the current allow list looks the way it does

- Permissive licenses the tree already depends on: `MIT`, `MIT-0`, `ISC`,
  `Apache-2.0`, `BSD-2-Clause`, `BSD-3-Clause`, `0BSD`, `BlueOak-1.0.0`,
  `Unlicense`, `CC0-1.0`, plus data/content licenses `CC-BY-4.0`
  (`caniuse-lite`) and `Python-2.0` (`argparse`).
- Weak copyleft, allowed after review: `MPL-2.0` (`lightningcss`, `axe-core`),
  `EPL-2.0` (`elkjs`), `LGPL-3.0-or-later` (the optional prebuilt `sharp`
  image libraries, which are dynamically linked and never modified).
- `GPL-3.0` — required, not optional: `snarkjs` and its `@iden3/*` /
  `ffjavascript` / `r1csfile` / `wasmbuilder` / `wasmcurves` / `fastfile`
  dependency tree power zero-knowledge proof verification. This is an
  intentional, documented exception to the "no GPL in the dependency tree"
  default; if that tree is ever replaced, drop `GPL-3.0` from the allow list
  first so the change is enforced.
- Denied outright (fail fast if any of them enters the tree): the AGPL family
  (`AGPL-1.0-*`, `AGPL-3.0-*`), source-available/commercial licenses
  (`BUSL-1.1`, `Elastic-2.0`, `SSPL-1.0`, `Commons-Clause`), and
  non-commercial content licenses (`CC-BY-NC-*`).
- `exceptions` carries five packages whose published metadata is unusable and
  which were verified by hand: `esprima@1.2.5` (legacy npm `licenses: [{ type:
  "BSD" }]` array — upstream is BSD-2-Clause), and `png-js@2.0.0`,
  `seq-queue@0.0.5`, `thirty-two@1.0.2`, `unpkg@0.2.0` (no `license` field at
  all; each upstream repository ships MIT). If any of them is upgraded or
  removed the exception stops matching and the gate re-fails, which is the
  intended nudge to re-review it. The script also tolerates a legacy
  `licenses: [{ type }]` array in the lockfile itself, joining it into an
  `A OR B` expression.

To see exactly which packages a run flags, look at
`release-artifacts/license-report.md` (violations, unknown-license packages and
the full distribution) or `license-report.json` for the same data in
machine-readable form.

## Reproducibility

`metadata.timestamp` is the only field that changes between two runs over the
same lockfile. The SBOM `serialNumber` is a SHA-256-derived, RFC 4122-shaped
UUID seeded from `project@version|purl,purl,…`, so regenerating a release's
SBOM reproduces the same document identity instead of churning a fresh random
UUID — diffable, cacheable, and safe to publish alongside the build.

## What the SBOM contains

`bomFormat: "CycloneDX"`, `specVersion: "1.5"`, one `metadata.component` for
this application (`pkg:npm/stellar-alerts@<version>`), and one
`type: "library"` entry per dependency with `name`, `version`, `purl`,
`bom-ref` (equal to the purl), the license, and the npm dependency scope:

```json
{
  "type": "library",
  "name": "@stellar/stellar-sdk",
  "version": "13.3.0",
  "purl": "pkg:npm/%40stellar/stellar-sdk@13.3.0",
  "bom-ref": "pkg:npm/%40stellar/stellar-sdk@13.3.0",
  "scope": "optional",
  "licenses": [{ "license": { "id": "Apache-2.0" } }],
  "properties": [{ "name": "stellar-alerts:dependency-scope", "value": "dev" }]
}
```

Notes on the mapping:

- npm scopes are percent-encoded in purls (`pkg:npm/%40scope/name@1.0.0`), as
  the purl spec requires.
- CycloneDX only knows `required` / `optional` / `excluded`, so both `dev` and
  `optional` npm dependencies are emitted as `optional`; the exact npm scope is
  preserved in the `stellar-alerts:dependency-scope` property so a consumer can
  still tell a development-only package from a runtime optional one (the
  license report's `packages[].scope` has the same value).
- A lone SPDX identifier becomes `{ "license": { "id": … } }`, a multi-license
  expression keeps its `{ "expression": … }` form, and anything unusable is
  recorded as `{ "license": { "name": "UNKNOWN" } }` rather than dropped.

## Where this runs in CI

- `.github/workflows/ci.yml` (every push/PR to `main`): `npm run test:scripts`
  runs `scripts/**/*.test.ts` under `scripts/vitest.config.ts`, and
  `npm run release:report:check` enforces the license policy without writing
  files. A new copyleft or unlicensed dependency fails the PR that introduces
  it, not the release tag weeks later.
- `.github/workflows/release.yml` (tag `v*`): `npm ci` → OSV scan
  (`scripts/security-audit.ts --report release-artifacts/osv-report.json`) →
  `scripts/release-report.ts` with the tagged version and that vulnerability
  report → uploads all four files as a workflow artifact and attaches them to
  the GitHub release. A CRITICAL/HIGH finding or a license violation fails the
  run before anything is published.
- The markdown report is appended to `$GITHUB_STEP_SUMMARY` on any runner that
  sets it, so the distribution and violations show up on the job page.

## Troubleshooting

| Symptom | What to do |
| :--- | :--- |
| `"X" is not covered by the allowed license list.` | Confirm X's obligations are acceptable, then add it to `allowedLicenses` in the same PR (reviewers see the decision in the diff). |
| `Package does not declare a machine-readable license …` | Resolve the real license from the upstream repo/`LICENSE` file and add a `exceptions` entry with a `reason` — keep `allowUnknownLicense: false`. |
| `"X" is on the denied license list.` | Replace the dependency (or remove the identifier from `deniedLicenses`, which needs an explicit review). |
| `Missing value for --vulnerability-report` | Flags take a value; pass a path or omit the flag entirely. |
| SBOM diff shows only a new `timestamp` | Expected — the `serialNumber` and components are deterministic. |
