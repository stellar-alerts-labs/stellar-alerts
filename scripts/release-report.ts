import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';

/**
 * Release dependency & license reporting with SBOM generation and policy
 * enforcement (issue #339).
 *
 * For a given release this produces, under `--out-dir` (default
 * `release-artifacts/`):
 *   - `sbom.cdx.json`       A CycloneDX 1.5 SBOM covering every resolved
 *                           third-party package in the lockfile.
 *   - `license-report.json` Machine-readable license inventory + violations.
 *   - `license-report.md`   Human-readable license inventory + violations.
 *
 * ...and exits non-zero when either policy is violated:
 *   - License policy: `release-policy.json` (allow/deny lists plus reviewed
 *     per-package exceptions).
 *   - Vulnerability policy: the JSON report written by
 *     `scripts/security-audit.ts --report <file>` (an OSV scan of the same
 *     lockfile). The severities that fail the gate are configurable.
 *
 * Like `security-audit.ts`, this deliberately introduces no new dependency:
 * it reads `package-lock.json` with `JSON.parse`, hand-builds the CycloneDX
 * document, and uses only Node built-ins. Every value is derived from the
 * lockfile alone, so the output is byte-stable whether or not `node_modules`
 * is installed (the lockfile is the source of truth npm reshapes, and CI
 * already treats it that way for the OSV scan).
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const SBOM_FILENAME = 'sbom.cdx.json';
export const LICENSE_REPORT_JSON_FILENAME = 'license-report.json';
export const LICENSE_REPORT_MD_FILENAME = 'license-report.md';

export type DependencyScope = 'required' | 'optional' | 'dev';
export type Severity = 'CRITICAL' | 'HIGH' | 'MODERATE' | 'LOW' | 'UNKNOWN';

export interface ReleasePackage {
  name: string;
  version: string;
  /** Raw declared license from the lockfile, or `UNKNOWN` when absent. */
  license: string;
  /** Package URL (purl) — `pkg:npm/<name>@<version>`. */
  purl: string;
  scope: DependencyScope;
}

export interface LicenseViolation {
  package: string;
  version: string;
  license: string;
  reason: string;
}

export interface VulnerabilityViolation {
  package: string;
  version: string;
  vulnId: string;
  severity: Severity;
  summary: string | null;
}

/** A package the maintainers have explicitly reviewed and accepted. */
export interface LicenseException {
  package: string;
  /** Exact version, or `*`/omitted to match any version. */
  version?: string;
  /** Only bypass the policy when the declared license matches, if set. */
  license?: string;
  reason: string;
}

export interface ReleasePolicy {
  allowedLicenses: string[];
  deniedLicenses: string[];
  allowUnknownLicense: boolean;
  failOnVulnerabilitySeverities: Severity[];
  exceptions: LicenseException[];
}

export const DEFAULT_POLICY: ReleasePolicy = {
  allowedLicenses: [],
  deniedLicenses: [],
  allowUnknownLicense: false,
  failOnVulnerabilitySeverities: ['CRITICAL', 'HIGH'],
  exceptions: [],
};

const UNKNOWN_LICENSE = 'UNKNOWN';

function isUnknownLicense(license: string): boolean {
  const value = license.trim().toUpperCase();
  return (
    value === '' ||
    value === UNKNOWN_LICENSE ||
    value === 'UNLICENSED' ||
    value === 'NONE' ||
    value.startsWith('SEE LICENSE IN')
  );
}

/**
 * Normalizes the several shapes npm uses to record a license: a `license`
 * SPDX string, a legacy `licenses` array of `{ type }` objects, or an object
 * with `type`/`name`. Anything unusable collapses to `UNKNOWN` so the policy
 * can decide what to do about it rather than throwing mid-scan.
 */
export function normalizeLicense(raw: unknown): string {
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    return trimmed === '' ? UNKNOWN_LICENSE : trimmed;
  }
  if (Array.isArray(raw)) {
    const joined = raw
      .map((entry) =>
        normalizeLicense(typeof entry === 'object' && entry ? (entry as Record<string, unknown>).type : entry),
      )
      .filter((entry) => entry !== UNKNOWN_LICENSE);
    return joined.length > 0 ? joined.join(' OR ') : UNKNOWN_LICENSE;
  }
  if (raw && typeof raw === 'object') {
    const record = raw as Record<string, unknown>;
    return normalizeLicense(record.type ?? record.name);
  }
  return UNKNOWN_LICENSE;
}

export type LicenseNode =
  | { type: 'license'; id: string }
  | { type: 'and'; left: LicenseNode; right: LicenseNode }
  | { type: 'or'; left: LicenseNode; right: LicenseNode };

type Token = { kind: 'license' | 'and' | 'or' | 'with' | '(' | ')'; value: string };

/**
 * Splits an SPDX-style expression (`(MIT OR CC0-1.0)`,
 * `Apache-2.0 AND LGPL-3.0-or-later`, `MIT and ISC`) into tokens. Operators
 * are matched case-insensitively because lockfiles in the wild (this repo
 * included) mix `AND` and `and`.
 */
export function tokenizeLicenseExpression(expression: string): Token[] {
  const tokens: Token[] = [];
  const pattern = /\s*(\(|\)|AND|OR|WITH|[^\s()]+)/gi;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(expression)) !== null) {
    const value = match[1];
    const upper = value.toUpperCase();
    if (upper === 'AND') tokens.push({ kind: 'and', value });
    else if (upper === 'OR') tokens.push({ kind: 'or', value });
    else if (upper === 'WITH') tokens.push({ kind: 'with', value });
    else if (value === '(') tokens.push({ kind: '(', value });
    else if (value === ')') tokens.push({ kind: ')', value });
    else tokens.push({ kind: 'license', value });
  }

  return tokens;
}

/** Parses a license expression into an AND/OR tree of license identifiers. */
export function parseLicenseExpression(expression: string): LicenseNode {
  const tokens = tokenizeLicenseExpression(expression);
  if (tokens.length === 0) return { type: 'license', id: UNKNOWN_LICENSE };

  let position = 0;

  const peek = (): Token | undefined => tokens[position];
  const consume = (): Token => {
    const token = tokens[position];
    if (!token) throw new Error(`Unexpected end of license expression: "${expression}"`);
    position += 1;
    return token;
  };

  const parsePrimary = (): LicenseNode => {
    const token = consume();
    if (token.kind === '(') {
      const node = parseOr();
      const closing = consume();
      if (closing.kind !== ')') throw new Error(`Missing ")" in license expression: "${expression}"`);
      return node;
    }
    if (token.kind !== 'license') {
      throw new Error(`Unexpected token "${token.value}" in license expression: "${expression}"`);
    }
    return { type: 'license', id: token.value };
  };

  const parseWith = (): LicenseNode => {
    let node = parsePrimary();
    while (peek()?.kind === 'with') {
      consume();
      const exception = consume();
      if (exception.kind !== 'license' || node.type !== 'license') {
        throw new Error(`Invalid WITH clause in license expression: "${expression}"`);
      }
      node = { type: 'license', id: `${node.id} WITH ${exception.value}` };
    }
    return node;
  };

  const parseAnd = (): LicenseNode => {
    let node = parseWith();
    while (peek()?.kind === 'and') {
      consume();
      node = { type: 'and', left: node, right: parseWith() };
    }
    return node;
  };

  const parseOr = (): LicenseNode => {
    let node = parseAnd();
    while (peek()?.kind === 'or') {
      consume();
      node = { type: 'or', left: node, right: parseAnd() };
    }
    return node;
  };

  const node = parseOr();
  if (position !== tokens.length) {
    throw new Error(`Unexpected trailing tokens in license expression: "${expression}"`);
  }
  return node;
}

function collectIdentifiers(node: LicenseNode, out: Set<string> = new Set()): Set<string> {
  if (node.type === 'license') {
    out.add(node.id.toUpperCase());
  } else {
    collectIdentifiers(node.left, out);
    collectIdentifiers(node.right, out);
  }
  return out;
}

/**
 * Finds the allow/deny list entry matching an identifier (case-insensitive,
 * tolerating a trailing `+`), returning the list's own spelling so violation
 * messages quote the policy rather than an uppercased copy.
 */
function findLicenseListMatch(identifier: string, list: string[]): string | null {
  const normalized = identifier.trim().toUpperCase();
  const withoutOrLater = normalized.replace(/\+$/, '');
  const match = list.find((entry) => {
    const candidate = entry.trim().toUpperCase();
    return candidate === normalized || candidate === withoutOrLater;
  });
  return match ?? null;
}

function expressionContainsUnknown(node: LicenseNode): boolean {
  if (node.type === 'license') return isUnknownLicense(node.id);
  return expressionContainsUnknown(node.left) || expressionContainsUnknown(node.right);
}

/**
 * Evaluates an expression against the allow list using SPDX semantics:
 * `A OR B` is satisfied when either operand is allowed (the consumer picks),
 * `A AND B` requires both. An unknown leaf is only acceptable when the policy
 * explicitly allows unknown licenses.
 */
function isExpressionAllowed(node: LicenseNode, policy: ReleasePolicy): boolean {
  if (node.type === 'license') {
    if (isUnknownLicense(node.id)) return policy.allowUnknownLicense;
    return findLicenseListMatch(node.id, policy.allowedLicenses) !== null;
  }
  if (node.type === 'or') {
    return isExpressionAllowed(node.left, policy) || isExpressionAllowed(node.right, policy);
  }
  return isExpressionAllowed(node.left, policy) && isExpressionAllowed(node.right, policy);
}

/**
 * Applies the license policy to a single package, returning the violation to
 * report or `null` when the package is acceptable. Order of precedence:
 * reviewed exception, then denied list, then unknown handling, then allow
 * list (which is skipped entirely for a deny-list-only policy).
 */
export function evaluateLicensePolicy(pkg: ReleasePackage, policy: ReleasePolicy): LicenseViolation | null {
  const exception = policy.exceptions.find(
    (entry) =>
      entry.package.toLowerCase() === pkg.name.toLowerCase() &&
      (entry.version === undefined || entry.version === '*' || entry.version === pkg.version) &&
      (entry.license === undefined || entry.license.toUpperCase() === pkg.license.toUpperCase()),
  );
  if (exception) return null;

  const node = parseLicenseExpression(pkg.license);

  const deniedIdentifier = Array.from(collectIdentifiers(node)).find(
    (identifier) => findLicenseListMatch(identifier, policy.deniedLicenses) !== null,
  );
  if (deniedIdentifier) {
    const matched = findLicenseListMatch(deniedIdentifier, policy.deniedLicenses);
    return {
      package: pkg.name,
      version: pkg.version,
      license: pkg.license,
      reason: `"${matched ?? deniedIdentifier}" is on the denied license list.`,
    };
  }

  if (expressionContainsUnknown(node) && !policy.allowUnknownLicense) {
    return {
      package: pkg.name,
      version: pkg.version,
      license: pkg.license,
      reason: 'Package does not declare a machine-readable license and unknown licenses are not allowed.',
    };
  }

  if (policy.allowedLicenses.length === 0) return null;

  if (isExpressionAllowed(node, policy)) return null;

  return {
    package: pkg.name,
    version: pkg.version,
    license: pkg.license,
    reason: `"${pkg.license}" is not covered by the allowed license list.`,
  };
}

/** Builds a purl; npm scopes are percent-encoded (`pkg:npm/%40scope/name@1.0.0`). */
export function toPackageUrl(name: string, version: string): string {
  if (name.startsWith('@')) {
    const [scope, packageName] = name.slice(1).split('/');
    return `pkg:npm/%40${scope}/${packageName}@${version}`;
  }
  return `pkg:npm/${name}@${version}`;
}

/**
 * Extracts the resolved third-party packages (name + exact version + declared
 * license) from an npm v3-format `package-lock.json`. Workspace-local packages
 * (no `resolved` tarball URL — this repo's own `apps/*`/`packages/*` entries)
 * are skipped because they are not registry dependencies and don't carry a
 * license to enforce. Duplicates nested under other packages' `node_modules`
 * are deduplicated by name+version, and the result is sorted so the SBOM and
 * reports are byte-stable between runs.
 */
export function extractReleasePackages(lockfileJson: string): ReleasePackage[] {
  const lockfile = JSON.parse(lockfileJson);
  const packages =
    lockfile && typeof lockfile === 'object' ? ((lockfile as Record<string, unknown>).packages as any) ?? {} : {};

  const seen = new Map<string, ReleasePackage>();

  for (const [key, meta] of Object.entries<any>(packages)) {
    if (!key || !meta || typeof meta.version !== 'string') continue;
    if (!meta.resolved) continue; // workspace-local package, not a registry dependency

    const match = key.match(/node_modules\/((?:@[^/]+\/)?[^/]+)$/);
    if (!match) continue;
    const name = match[1];

    const dedupeKey = `${name}@${meta.version}`;
    if (seen.has(dedupeKey)) continue;

    const scope: DependencyScope = meta.dev ? 'dev' : meta.optional ? 'optional' : 'required';
    seen.set(dedupeKey, {
      name,
      version: meta.version,
      license: normalizeLicense(meta.license ?? meta.licenses),
      purl: toPackageUrl(name, meta.version),
      scope,
    });
  }

  return Array.from(seen.values()).sort(
    (a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version),
  );
}

/** A simple, unparenthesized SPDX identifier such as `MIT` or `Apache-2.0`. */
export function isSpdxIdentifier(license: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9.+-]*$/.test(license.trim());
}

/**
 * Maps a declared license to CycloneDX's `licenses` shape: a known identifier
 * becomes `{ license: { id } }`, an expression keeps its `{ expression }`
 * form, and anything else (including unknown) is recorded by name so no
 * information is lost.
 */
export function licenseToCycloneDx(license: string): Array<Record<string, unknown>> {
  const trimmed = license.trim();
  if (isUnknownLicense(trimmed)) return [{ license: { name: UNKNOWN_LICENSE } }];
  if (/[()]|\b(AND|OR|WITH)\b/i.test(trimmed)) return [{ expression: trimmed }];
  if (isSpdxIdentifier(trimmed)) return [{ license: { id: trimmed } }];
  return [{ license: { name: trimmed } }];
}

/**
 * Derives a stable UUID (v4 shape) from a seed so the same component set
 * always yields the same SBOM `serialNumber` — making release SBOMs
 * reproducible and diffable instead of churning a fresh random UUID per run.
 */
export function deterministicSerialNumber(seed: string): string {
  const hash = createHash('sha256').update(seed).digest('hex');
  const chars = hash.slice(0, 32).split('');
  chars[12] = '4'; // version 4
  chars[16] = ((parseInt(hash[16], 16) & 0x3) | 0x8).toString(16); // RFC 4122 variant
  const hex = chars.join('');
  return `urn:uuid:${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export interface SbomOptions {
  projectName?: string;
  projectVersion?: string;
  timestamp?: string;
}

export interface CycloneDxSbom {
  bomFormat: 'CycloneDX';
  specVersion: '1.5';
  serialNumber: string;
  version: 1;
  metadata: {
    timestamp: string;
    tools: Array<{ vendor: string; name: string; version: string }>;
    component: { type: 'application'; name: string; version: string; 'bom-ref': string };
  };
  components: Array<Record<string, unknown>>;
}

const TOOL_VERSION = '1.0.0';

/** Builds a CycloneDX 1.5 SBOM document from the resolved package list. */
export function buildSbom(packages: ReleasePackage[], options: SbomOptions = {}): CycloneDxSbom {
  const projectName = options.projectName ?? 'stellar-alerts';
  const projectVersion = options.projectVersion ?? '0.0.0';
  const timestamp = options.timestamp ?? new Date().toISOString();
  const seed = `${projectName}@${projectVersion}|${packages.map((pkg) => pkg.purl).join(',')}`;

  return {
    bomFormat: 'CycloneDX',
    specVersion: '1.5',
    serialNumber: deterministicSerialNumber(seed),
    version: 1,
    metadata: {
      timestamp,
      tools: [{ vendor: 'stellar-alerts', name: 'release-report', version: TOOL_VERSION }],
      component: {
        type: 'application',
        name: projectName,
        version: projectVersion,
        'bom-ref': `pkg:npm/${projectName}@${projectVersion}`,
      },
    },
    components: packages.map((pkg) => ({
      type: 'library',
      name: pkg.name,
      version: pkg.version,
      purl: pkg.purl,
      'bom-ref': pkg.purl,
      scope: pkg.scope === 'required' ? 'required' : 'optional',
      licenses: licenseToCycloneDx(pkg.license),
      properties: [{ name: 'stellar-alerts:dependency-scope', value: pkg.scope }],
    })),
  };
}

export interface LicenseInventoryEntry {
  name: string;
  version: string;
  license: string;
  scope: DependencyScope;
}

export interface LicenseReport {
  totalPackages: number;
  unknownPackages: Array<{ name: string; version: string }>;
  licenses: Array<{ license: string; count: number }>;
  packages: LicenseInventoryEntry[];
}

/** Builds the machine-readable license inventory (violations are added by `run`). */
export function buildLicenseReport(packages: ReleasePackage[]): LicenseReport {
  const counts = new Map<string, number>();
  for (const pkg of packages) {
    counts.set(pkg.license, (counts.get(pkg.license) ?? 0) + 1);
  }

  return {
    totalPackages: packages.length,
    unknownPackages: packages
      .filter((pkg) => isUnknownLicense(pkg.license))
      .map((pkg) => ({ name: pkg.name, version: pkg.version })),
    licenses: Array.from(counts.entries())
      .map(([license, count]) => ({ license, count }))
      .sort((a, b) => b.count - a.count || a.license.localeCompare(b.license)),
    packages: packages.map((pkg) => ({
      name: pkg.name,
      version: pkg.version,
      license: pkg.license,
      scope: pkg.scope,
    })),
  };
}

/**
 * Parses and validates the release policy file. Throws a descriptive error on
 * a malformed policy so a typo fails the release loudly instead of silently
 * disabling a gate.
 */
export function loadReleasePolicy(policyJson: string): ReleasePolicy {
  const parsed = JSON.parse(policyJson);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Release policy must be a JSON object.');
  }
  const record = parsed as Record<string, unknown>;

  const asStringArray = (value: unknown, field: string): string[] => {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
      throw new Error(`Release policy field "${field}" must be an array of strings.`);
    }
    return value.map((entry) => (entry as string).trim()).filter((entry) => entry.length > 0);
  };

  const severities = record.failOnVulnerabilitySeverities === undefined
    ? DEFAULT_POLICY.failOnVulnerabilitySeverities
    : asStringArray(record.failOnVulnerabilitySeverities, 'failOnVulnerabilitySeverities').map(
        (entry) => entry.toUpperCase() as Severity,
      );

  const exceptionsInput = record.exceptions;
  if (exceptionsInput !== undefined && !Array.isArray(exceptionsInput)) {
    throw new Error('Release policy field "exceptions" must be an array.');
  }

  const exceptions: LicenseException[] = (exceptionsInput ?? []).map((entry, index) => {
    if (!entry || typeof entry !== 'object' || typeof (entry as any).package !== 'string') {
      throw new Error(`Release policy exception #${index} must be an object with a "package" string.`);
    }
    if (typeof (entry as any).reason !== 'string' || (entry as any).reason.trim() === '') {
      throw new Error(`Release policy exception #${index} ("${(entry as any).package}") must include a "reason".`);
    }
    return {
      package: (entry as any).package,
      version: typeof (entry as any).version === 'string' ? (entry as any).version : undefined,
      license: typeof (entry as any).license === 'string' ? (entry as any).license : undefined,
      reason: (entry as any).reason,
    };
  });

  return {
    allowedLicenses: asStringArray(record.allowedLicenses, 'allowedLicenses'),
    deniedLicenses: asStringArray(record.deniedLicenses, 'deniedLicenses'),
    allowUnknownLicense: record.allowUnknownLicense === true,
    failOnVulnerabilitySeverities: severities,
    exceptions,
  };
}

/**
 * Reads the machine-readable report produced by `scripts/security-audit.ts`
 * and returns the findings at or above the configured failure severities.
 */
export function evaluateVulnerabilityPolicy(
  reportJson: string,
  failOnSeverities: Severity[],
): VulnerabilityViolation[] {
  const report = JSON.parse(reportJson);
  if (!report || typeof report !== 'object' || !Array.isArray((report as any).findings)) {
    throw new Error(
      'Vulnerability report must be the JSON written by scripts/security-audit.ts --report (missing "findings" array).',
    );
  }

  const blocking = new Set(failOnSeverities.map((severity) => severity.toUpperCase()));

  return (report.findings as any[])
    .filter((finding) => finding && typeof finding.severity === 'string' && blocking.has(finding.severity.toUpperCase()))
    .map((finding) => ({
      package: String(finding.packageName ?? 'unknown'),
      version: String(finding.packageVersion ?? 'unknown'),
      vulnId: String(finding.vulnId ?? 'unknown'),
      severity: String(finding.severity).toUpperCase() as Severity,
      summary: typeof finding.summary === 'string' ? finding.summary : null,
    }));
}

export interface ReleaseReport {
  generatedAt: string;
  project: { name: string; version: string };
  policy: { path: string | null };
  summary: {
    totalPackages: number;
    distinctLicenses: number;
    licenseViolations: number;
    vulnerabilityViolations: number;
    passed: boolean;
  };
  licenses: Array<{ license: string; count: number }>;
  unknownPackages: Array<{ name: string; version: string }>;
  packages: LicenseInventoryEntry[];
  violations: {
    licenses: LicenseViolation[];
    vulnerabilities: VulnerabilityViolation[];
  };
}

export interface ReleaseReportInput {
  generatedAt: string;
  project: { name: string; version: string };
  policyPath: string | null;
  inventory: LicenseReport;
  licenseViolations: LicenseViolation[];
  vulnerabilityViolations: VulnerabilityViolation[];
}

/** Assembles the top-level `license-report.json` document. */
export function buildReleaseReport(input: ReleaseReportInput): ReleaseReport {
  const { inventory, licenseViolations, vulnerabilityViolations } = input;
  return {
    generatedAt: input.generatedAt,
    project: input.project,
    policy: { path: input.policyPath },
    summary: {
      totalPackages: inventory.totalPackages,
      distinctLicenses: inventory.licenses.length,
      licenseViolations: licenseViolations.length,
      vulnerabilityViolations: vulnerabilityViolations.length,
      passed: licenseViolations.length === 0 && vulnerabilityViolations.length === 0,
    },
    licenses: inventory.licenses,
    unknownPackages: inventory.unknownPackages,
    packages: inventory.packages,
    violations: {
      licenses: licenseViolations,
      vulnerabilities: vulnerabilityViolations,
    },
  };
}

/** Renders the human-readable `license-report.md`. */
export function renderLicenseMarkdown(report: ReleaseReport): string {
  const lines: string[] = [];
  const { project, summary } = report;

  lines.push('# Dependency License & SBOM Report');
  lines.push('');
  lines.push(`**Project:** \`${project.name}@${project.version}\``);
  lines.push(`**Generated:** ${report.generatedAt}`);
  lines.push(`**Packages scanned:** ${summary.totalPackages}`);
  lines.push(`**Status:** ${summary.passed ? '✅ passed' : '❌ failed'}`);
  lines.push('');

  lines.push('## License distribution');
  lines.push('');
  lines.push('| License | Packages |');
  lines.push('| --- | --- |');
  for (const entry of report.licenses) {
    lines.push(`| \`${entry.license}\` | ${entry.count} |`);
  }
  lines.push('');

  lines.push('## License policy violations');
  lines.push('');
  if (report.violations.licenses.length === 0) {
    lines.push('None.');
  } else {
    lines.push('| Package | License | Reason |');
    lines.push('| --- | --- | --- |');
    for (const violation of report.violations.licenses) {
      lines.push(`| \`${violation.package}@${violation.version}\` | \`${violation.license}\` | ${violation.reason} |`);
    }
  }
  lines.push('');

  lines.push('## Vulnerability policy violations');
  lines.push('');
  if (report.violations.vulnerabilities.length === 0) {
    lines.push('None.');
  } else {
    lines.push('| Package | Advisory | Severity | Summary |');
    lines.push('| --- | --- | --- | --- |');
    for (const violation of report.violations.vulnerabilities) {
      lines.push(
        `| \`${violation.package}@${violation.version}\` | ${violation.vulnId} | ${violation.severity} | ${violation.summary ?? ''} |`,
      );
    }
  }
  lines.push('');

  if (report.unknownPackages.length > 0) {
    lines.push('## Packages without declared license metadata');
    lines.push('');
    for (const pkg of report.unknownPackages) {
      lines.push(`- \`${pkg.name}@${pkg.version}\``);
    }
    lines.push('');
  }

  lines.push('---');
  lines.push('');
  lines.push('Generated by `scripts/release-report.ts` (issue #339).');
  lines.push('');
  return lines.join('\n');
}

export interface RunOptions {
  lockfilePath?: string;
  policyPath?: string;
  /** Path to the `security-audit.ts --report` JSON; omit to skip the vuln gate. */
  vulnerabilityReportPath?: string | null;
  /** Directory to write artifacts to; `null` (or `--check`) writes nothing. */
  outDir?: string | null;
  releaseVersion?: string;
  /** Validate policies only — write no artifacts. */
  check?: boolean;
}

export interface RunResult {
  passed: boolean;
  report: ReleaseReport;
  sbom: CycloneDxSbom;
  outputs: string[];
}

export const DEFAULT_LOCKFILE = path.join(REPO_ROOT, 'package-lock.json');
export const DEFAULT_POLICY_PATH = path.join(REPO_ROOT, 'release-policy.json');
export const DEFAULT_OUT_DIR = path.join(REPO_ROOT, 'release-artifacts');

async function resolveProjectMetadata(releaseVersion?: string): Promise<{ name: string; version: string }> {
  let name = 'stellar-alerts';
  let version = '0.0.0';

  try {
    const pkg = JSON.parse(await fs.readFile(path.join(REPO_ROOT, 'package.json'), 'utf8'));
    if (typeof pkg.name === 'string' && pkg.name) name = pkg.name;
    if (typeof pkg.version === 'string' && pkg.version) version = pkg.version;
  } catch {
    // Fall back to defaults; the lockfile scan does not depend on the manifest.
  }

  const override = releaseVersion ?? process.env.RELEASE_VERSION;
  if (override && override.trim() !== '') version = override.trim();

  return { name, version };
}

/**
 * Generates the SBOM + license report and evaluates both policies. Returns
 * `passed: false` (rather than throwing) when a policy is violated so callers
 * still get the artifacts and the caller decides the process exit code.
 */
export async function run(options: RunOptions = {}): Promise<RunResult> {
  const lockfilePath = options.lockfilePath ?? DEFAULT_LOCKFILE;
  const policyPath = options.policyPath ?? DEFAULT_POLICY_PATH;
  const outDir = options.outDir !== undefined ? options.outDir : DEFAULT_OUT_DIR;
  const check = options.check ?? false;
  const generatedAt = new Date().toISOString();

  const project = await resolveProjectMetadata(options.releaseVersion);
  const packages = extractReleasePackages(await fs.readFile(lockfilePath, 'utf8'));
  const policy = loadReleasePolicy(await fs.readFile(policyPath, 'utf8'));

  const licenseViolations = packages
    .map((pkg) => evaluateLicensePolicy(pkg, policy))
    .filter((violation): violation is LicenseViolation => violation !== null);

  let vulnerabilityViolations: VulnerabilityViolation[] = [];
  if (options.vulnerabilityReportPath) {
    vulnerabilityViolations = evaluateVulnerabilityPolicy(
      await fs.readFile(options.vulnerabilityReportPath, 'utf8'),
      policy.failOnVulnerabilitySeverities,
    );
  } else {
    console.warn('[release-report] No vulnerability report supplied — vulnerability policy not evaluated.');
  }

  const inventory = buildLicenseReport(packages);
  const sbom = buildSbom(packages, {
    projectName: project.name,
    projectVersion: project.version,
    timestamp: generatedAt,
  });
  const report = buildReleaseReport({
    generatedAt,
    project,
    policyPath: path.relative(REPO_ROOT, policyPath) || policyPath,
    inventory,
    licenseViolations,
    vulnerabilityViolations,
  });

  const outputs: string[] = [];
  if (outDir !== null && !check) {
    await fs.mkdir(outDir, { recursive: true });
    const files: Array<[string, string]> = [
      [SBOM_FILENAME, JSON.stringify(sbom, null, 2) + '\n'],
      [LICENSE_REPORT_JSON_FILENAME, JSON.stringify(report, null, 2) + '\n'],
      [LICENSE_REPORT_MD_FILENAME, renderLicenseMarkdown(report)],
    ];
    for (const [filename, content] of files) {
      const target = path.join(outDir, filename);
      await fs.writeFile(target, content, 'utf8');
      outputs.push(target);
    }
  }

  logSummary(report, outputs);

  return { passed: report.summary.passed, report, sbom, outputs };
}

function logSummary(report: ReleaseReport, outputs: string[]): void {
  const { summary } = report;
  console.log(
    `[release-report] Scanned ${summary.totalPackages} package(s); ${summary.distinctLicenses} distinct license(s).`,
  );
  for (const output of outputs) {
    console.log(`[release-report] Wrote ${path.relative(process.cwd(), output)}`);
  }
  console.log(`[release-report] License policy: ${summary.licenseViolations} violation(s).`);
  console.log(`[release-report] Vulnerability policy: ${summary.vulnerabilityViolations} violation(s).`);
  console.log(
    summary.passed ? '[release-report] ✅ Release policies satisfied.' : '[release-report] ❌ Release policies violated.',
  );

  const stepSummaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (stepSummaryPath) {
    // Best-effort: a failed summary append must never fail the release.
    fs.appendFile(stepSummaryPath, renderLicenseMarkdown(report), 'utf8').catch(() => undefined);
  }
}

function readFlagValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`Missing value for ${flag}`);
  return value;
}

async function main() {
  const args = process.argv.slice(2);
  const check = args.includes('--check');
  const warnOnly = args.includes('--warn-only');

  try {
    const result = await run({
      lockfilePath: readFlagValue(args, '--lockfile'),
      policyPath: readFlagValue(args, '--policy'),
      vulnerabilityReportPath: readFlagValue(args, '--vulnerability-report') ?? null,
      outDir: check ? null : readFlagValue(args, '--out-dir'),
      releaseVersion: readFlagValue(args, '--release-version'),
      check,
    });

    if (!result.passed && !warnOnly) process.exitCode = 1;
  } catch (err) {
    console.error('[release-report] Failed:', err);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
