import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  LICENSE_REPORT_JSON_FILENAME,
  LICENSE_REPORT_MD_FILENAME,
  SBOM_FILENAME,
  buildLicenseReport,
  buildReleaseReport,
  buildSbom,
  deterministicSerialNumber,
  evaluateLicensePolicy,
  evaluateVulnerabilityPolicy,
  extractReleasePackages,
  licenseToCycloneDx,
  loadReleasePolicy,
  normalizeLicense,
  parseLicenseExpression,
  renderLicenseMarkdown,
  run,
  tokenizeLicenseExpression,
  toPackageUrl,
  type ReleasePackage,
  type ReleasePolicy,
} from './release-report';

const REPO_LOCKFILE = new URL('../package-lock.json', import.meta.url);
const REPO_POLICY = new URL('../release-policy.json', import.meta.url);

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'release-report-test-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

/** Builds a minimal npm v3 lockfile around the given `node_modules/*` entries. */
function lockfile(packages: Record<string, Record<string, unknown>>): string {
  return JSON.stringify({
    name: 'fixture',
    version: '1.0.0',
    lockfileVersion: 3,
    requires: true,
    packages: { '': { name: 'fixture', version: '1.0.0' }, ...packages },
  });
}

const RESOLVED = 'https://registry.npmjs.org/-/fixture-1.0.0.tgz';

function policy(overrides: Partial<ReleasePolicy> = {}): ReleasePolicy {
  return {
    allowedLicenses: [],
    deniedLicenses: [],
    allowUnknownLicense: false,
    failOnVulnerabilitySeverities: ['CRITICAL', 'HIGH'],
    exceptions: [],
    ...overrides,
  };
}

function pkg(overrides: Partial<ReleasePackage> = {}): ReleasePackage {
  return {
    name: 'example',
    version: '1.0.0',
    license: 'MIT',
    purl: 'pkg:npm/example@1.0.0',
    scope: 'required',
    ...overrides,
  };
}

describe('normalizeLicense', () => {
  it('passes SPDX strings through, trimming whitespace', () => {
    expect(normalizeLicense('MIT')).toBe('MIT');
    expect(normalizeLicense('  Apache-2.0  ')).toBe('Apache-2.0');
    expect(normalizeLicense('(MIT OR CC0-1.0)')).toBe('(MIT OR CC0-1.0)');
  });

  it('collapses absent, empty and unusable values to UNKNOWN', () => {
    expect(normalizeLicense(undefined)).toBe('UNKNOWN');
    expect(normalizeLicense(null)).toBe('UNKNOWN');
    expect(normalizeLicense('')).toBe('UNKNOWN');
    expect(normalizeLicense('   ')).toBe('UNKNOWN');
    expect(normalizeLicense(42)).toBe('UNKNOWN');
  });

  it('joins a legacy `licenses` array into an OR expression', () => {
    expect(normalizeLicense([{ type: 'MIT' }, { type: 'ISC' }])).toBe('MIT OR ISC');
    expect(normalizeLicense(['MIT', 'ISC'])).toBe('MIT OR ISC');
  });

  it('ignores unusable entries in a legacy array', () => {
    expect(normalizeLicense([{ type: 'MIT' }, { url: 'http://example.com' }])).toBe('MIT');
    expect(normalizeLicense([{ url: 'http://example.com' }])).toBe('UNKNOWN');
  });

  it('reads the `type` / `name` of an object form', () => {
    expect(normalizeLicense({ type: 'BSD' })).toBe('BSD');
    expect(normalizeLicense({ name: 'MIT' })).toBe('MIT');
  });
});

describe('tokenizeLicenseExpression', () => {
  it('splits identifiers, operators and parentheses', () => {
    expect(tokenizeLicenseExpression('(MIT OR CC0-1.0)')).toEqual([
      { kind: '(', value: '(' },
      { kind: 'license', value: 'MIT' },
      { kind: 'or', value: 'OR' },
      { kind: 'license', value: 'CC0-1.0' },
      { kind: ')', value: ')' },
    ]);
  });

  it('matches operators case-insensitively (lockfiles use `and`)', () => {
    expect(tokenizeLicenseExpression('MIT and ISC').map((token) => token.kind)).toEqual([
      'license',
      'and',
      'license',
    ]);
    expect(tokenizeLicenseExpression('MIT or ISC').map((token) => token.kind)).toEqual(['license', 'or', 'license']);
  });

  it('treats WITH as its own operator', () => {
    expect(tokenizeLicenseExpression('GPL-2.0-only WITH Classpath-exception-2.0').map((token) => token.kind)).toEqual([
      'license',
      'with',
      'license',
    ]);
  });

  it('returns no tokens for an empty expression', () => {
    expect(tokenizeLicenseExpression('')).toEqual([]);
  });
});

describe('parseLicenseExpression', () => {
  it('falls back to a single UNKNOWN leaf for an empty expression', () => {
    expect(parseLicenseExpression('')).toEqual({ type: 'license', id: 'UNKNOWN' });
    expect(parseLicenseExpression('   ')).toEqual({ type: 'license', id: 'UNKNOWN' });
  });

  it('builds a left-associative AND/OR tree', () => {
    expect(parseLicenseExpression('MIT AND ISC')).toEqual({
      type: 'and',
      left: { type: 'license', id: 'MIT' },
      right: { type: 'license', id: 'ISC' },
    });
    expect(parseLicenseExpression('Apache-2.0 AND LGPL-3.0-or-later AND MIT')).toEqual({
      type: 'and',
      left: {
        type: 'and',
        left: { type: 'license', id: 'Apache-2.0' },
        right: { type: 'license', id: 'LGPL-3.0-or-later' },
      },
      right: { type: 'license', id: 'MIT' },
    });
  });

  it('honours parentheses as grouping', () => {
    expect(parseLicenseExpression('(MIT OR ISC) AND Apache-2.0')).toEqual({
      type: 'and',
      left: {
        type: 'or',
        left: { type: 'license', id: 'MIT' },
        right: { type: 'license', id: 'ISC' },
      },
      right: { type: 'license', id: 'Apache-2.0' },
    });
  });

  it('keeps a WITH clause attached to its identifier', () => {
    expect(parseLicenseExpression('GPL-2.0-only WITH Classpath-exception-2.0')).toEqual({
      type: 'license',
      id: 'GPL-2.0-only WITH Classpath-exception-2.0',
    });
  });

  it('throws on malformed expressions', () => {
    expect(() => parseLicenseExpression('(MIT ISC)')).toThrow(/Missing/);
    expect(() => parseLicenseExpression('(MIT OR ISC')).toThrow(/Unexpected end of license expression/);
    expect(() => parseLicenseExpression('MIT AND')).toThrow(/Unexpected end of license expression/);
    expect(() => parseLicenseExpression('AND MIT')).toThrow(/Unexpected token/);
  });
});

describe('toPackageUrl', () => {
  it('builds unscoped purls', () => {
    expect(toPackageUrl('react', '19.2.0')).toBe('pkg:npm/react@19.2.0');
  });

  it('percent-encodes npm scopes', () => {
    expect(toPackageUrl('@stellar/stellar-sdk', '13.3.0')).toBe('pkg:npm/%40stellar/stellar-sdk@13.3.0');
  });
});

describe('extractReleasePackages', () => {
  const fixture = lockfile({
    'node_modules/mit-pkg': { version: '1.0.0', resolved: RESOLVED, license: 'MIT' },
    'node_modules/dev-pkg': { version: '2.0.0', resolved: RESOLVED, license: 'ISC', dev: true },
    'node_modules/opt-pkg': { version: '3.0.0', resolved: RESOLVED, license: 'MIT', optional: true },
    'node_modules/unknown-pkg': { version: '4.0.0', resolved: RESOLVED },
    'node_modules/@scope/pkg': { version: '5.0.0', resolved: RESOLVED, license: 'Apache-2.0' },
    'node_modules/legacy-array': { version: '6.0.0', resolved: RESOLVED, licenses: [{ type: 'BSD' }] },
    // duplicate of an already-seen name+version, nested under another package
    'node_modules/mit-pkg/node_modules/mit-pkg': { version: '1.0.0', resolved: RESOLVED, license: 'MIT' },
    // workspace-local entries carry no `resolved` tarball and must be skipped
    'apps/api': { version: '1.0.0', license: 'MIT' },
    'packages/shared': { version: '1.0.0', link: true },
  });

  it('collects deduplicated, sorted registry packages', () => {
    const packages = extractReleasePackages(fixture);
    expect(packages.map((entry) => `${entry.name}@${entry.version}`)).toEqual([
      '@scope/pkg@5.0.0',
      'dev-pkg@2.0.0',
      'legacy-array@6.0.0',
      'mit-pkg@1.0.0',
      'opt-pkg@3.0.0',
      'unknown-pkg@4.0.0',
    ]);
  });

  it('derives the dependency scope from the lockfile flags', () => {
    const byName = new Map(extractReleasePackages(fixture).map((entry) => [entry.name, entry]));
    expect(byName.get('mit-pkg')?.scope).toBe('required');
    expect(byName.get('dev-pkg')?.scope).toBe('dev');
    expect(byName.get('opt-pkg')?.scope).toBe('optional');
  });

  it('normalizes missing licenses to UNKNOWN and legacy arrays to expressions', () => {
    const byName = new Map(extractReleasePackages(fixture).map((entry) => [entry.name, entry]));
    expect(byName.get('unknown-pkg')?.license).toBe('UNKNOWN');
    expect(byName.get('legacy-array')?.license).toBe('BSD');
  });

  it('assigns an encoded purl to every package', () => {
    const byName = new Map(extractReleasePackages(fixture).map((entry) => [entry.name, entry]));
    expect(byName.get('@scope/pkg')?.purl).toBe('pkg:npm/%40scope/pkg@5.0.0');
    expect(byName.get('mit-pkg')?.purl).toBe('pkg:npm/mit-pkg@1.0.0');
  });

  it('is stable across repeated parsing of the same lockfile', () => {
    expect(extractReleasePackages(fixture)).toEqual(extractReleasePackages(fixture));
  });

  it('returns an empty list for an empty or malformed lockfile', () => {
    expect(extractReleasePackages('{}')).toEqual([]);
    expect(extractReleasePackages(lockfile({}))).toEqual([]);
  });
});

describe('evaluateLicensePolicy', () => {
  it('passes a package whose license is on the allow list', () => {
    expect(evaluateLicensePolicy(pkg({ license: 'MIT' }), policy({ allowedLicenses: ['MIT'] }))).toBeNull();
  });

  it('flags a package whose license is absent from a non-empty allow list', () => {
    const violation = evaluateLicensePolicy(pkg({ license: 'GPL-3.0' }), policy({ allowedLicenses: ['MIT'] }));
    expect(violation).toEqual({
      package: 'example',
      version: '1.0.0',
      license: 'GPL-3.0',
      reason: '"GPL-3.0" is not covered by the allowed license list.',
    });
  });

  it('matches the allow list case-insensitively and tolerates a trailing `+`', () => {
    expect(evaluateLicensePolicy(pkg({ license: 'lgpl-3.0-or-later' }), policy({ allowedLicenses: ['LGPL-3.0-or-later'] }))).toBeNull();
    expect(evaluateLicensePolicy(pkg({ license: 'MIT+' }), policy({ allowedLicenses: ['MIT'] }))).toBeNull();
  });

  it('accepts `A OR B` when either operand is allowed', () => {
    expect(evaluateLicensePolicy(pkg({ license: '(MIT OR CC0-1.0)' }), policy({ allowedLicenses: ['MIT'] }))).toBeNull();
    expect(evaluateLicensePolicy(pkg({ license: '(MIT OR GPL-3.0)' }), policy({ allowedLicenses: ['ISC'] }))).not.toBeNull();
  });

  it('accepts `A AND B` only when every operand is allowed', () => {
    expect(
      evaluateLicensePolicy(pkg({ license: 'Apache-2.0 AND LGPL-3.0-or-later' }), policy({ allowedLicenses: ['Apache-2.0', 'LGPL-3.0-or-later'] })),
    ).toBeNull();
    expect(evaluateLicensePolicy(pkg({ license: 'MIT and ISC' }), policy({ allowedLicenses: ['MIT'] }))).not.toBeNull();
  });

  it('lets the deny list win over the allow list', () => {
    const violation = evaluateLicensePolicy(
      pkg({ license: 'AGPL-3.0-only' }),
      policy({ allowedLicenses: ['AGPL-3.0-only'], deniedLicenses: ['AGPL-3.0-only'] }),
    );
    expect(violation?.reason).toBe('"AGPL-3.0-only" is on the denied license list.');
  });

  it('finds a denied identifier nested in an expression', () => {
    const violation = evaluateLicensePolicy(
      pkg({ license: 'MIT OR AGPL-3.0-only' }),
      policy({ allowedLicenses: ['MIT'], deniedLicenses: ['AGPL-3.0-only'] }),
    );
    expect(violation?.reason).toBe('"AGPL-3.0-only" is on the denied license list.');
  });

  it('flags unknown licenses unless the policy allows them', () => {
    const violation = evaluateLicensePolicy(pkg({ license: 'UNKNOWN' }), policy({ allowedLicenses: ['MIT'] }));
    expect(violation?.reason).toMatch(/does not declare a machine-readable license/);
    expect(evaluateLicensePolicy(pkg({ license: 'UNKNOWN' }), policy({ allowUnknownLicense: true }))).toBeNull();
  });

  it('is strict about unknown identifiers even inside an OR expression', () => {
    expect(evaluateLicensePolicy(pkg({ license: '(MIT OR UNKNOWN)' }), policy({ allowedLicenses: ['MIT'] }))).not.toBeNull();
  });

  it('acts as a deny-list-only gate when the allow list is empty', () => {
    expect(evaluateLicensePolicy(pkg({ license: 'WTFPL' }), policy({ deniedLicenses: ['AGPL-3.0-only'] }))).toBeNull();
  });

  it('honours a reviewed exception for an exact version', () => {
    const exceptions = [{ package: 'esprima', version: '1.2.5', license: 'UNKNOWN', reason: 'verified BSD-2-Clause upstream' }];
    expect(evaluateLicensePolicy(pkg({ name: 'esprima', version: '1.2.5', license: 'UNKNOWN' }), policy({ exceptions }))).toBeNull();
    expect(evaluateLicensePolicy(pkg({ name: 'esprima', version: '9.9.9', license: 'UNKNOWN' }), policy({ exceptions }))).not.toBeNull();
  });

  it('only applies an exception when the declared license matches', () => {
    const exceptions = [{ package: 'esprima', version: '1.2.5', license: 'UNKNOWN', reason: 'verified upstream' }];
    const violation = evaluateLicensePolicy(
      pkg({ name: 'esprima', version: '1.2.5', license: 'GPL-3.0' }),
      policy({ allowedLicenses: ['MIT'], exceptions }),
    );
    expect(violation?.reason).toBe('"GPL-3.0" is not covered by the allowed license list.');
  });

  it('applies version-less exceptions to every version', () => {
    const exceptions = [{ package: 'legacy-dep', reason: 'vendored, reviewed' }];
    expect(evaluateLicensePolicy(pkg({ name: 'legacy-dep', version: '3.2.1', license: 'UNKNOWN' }), policy({ exceptions }))).toBeNull();
  });
});

describe('loadReleasePolicy', () => {
  it('parses a complete policy document', () => {
    const loaded = loadReleasePolicy(
      JSON.stringify({
        allowedLicenses: ['MIT', ' Apache-2.0 '],
        deniedLicenses: ['AGPL-3.0-only'],
        allowUnknownLicense: true,
        failOnVulnerabilitySeverities: ['critical', 'high'],
        exceptions: [{ package: 'legacy-dep', version: '*', license: 'UNKNOWN', reason: 'reviewed' }],
      }),
    );

    expect(loaded.allowedLicenses).toEqual(['MIT', 'Apache-2.0']);
    expect(loaded.deniedLicenses).toEqual(['AGPL-3.0-only']);
    expect(loaded.allowUnknownLicense).toBe(true);
    expect(loaded.failOnVulnerabilitySeverities).toEqual(['CRITICAL', 'HIGH']);
    expect(loaded.exceptions).toEqual([
      { package: 'legacy-dep', version: '*', license: 'UNKNOWN', reason: 'reviewed' },
    ]);
  });

  it('applies defaults for omitted fields', () => {
    const loaded = loadReleasePolicy('{}');
    expect(loaded.allowedLicenses).toEqual([]);
    expect(loaded.deniedLicenses).toEqual([]);
    expect(loaded.allowUnknownLicense).toBe(false);
    expect(loaded.failOnVulnerabilitySeverities).toEqual(['CRITICAL', 'HIGH']);
    expect(loaded.exceptions).toEqual([]);
  });

  it('throws on a policy that is not a JSON object', () => {
    expect(() => loadReleasePolicy('[]')).toThrow(/must be a JSON object/);
    expect(() => loadReleasePolicy('"policy"')).toThrow(/must be a JSON object/);
  });

  it('throws when a list field is not an array of strings', () => {
    expect(() => loadReleasePolicy('{"allowedLicenses": "MIT"}')).toThrow(/allowedLicenses/);
    expect(() => loadReleasePolicy('{"deniedLicenses": [1]}')).toThrow(/deniedLicenses/);
    expect(() => loadReleasePolicy('{"failOnVulnerabilitySeverities": [1]}')).toThrow(
      /failOnVulnerabilitySeverities/,
    );
  });

  it('throws when exceptions are malformed', () => {
    expect(() => loadReleasePolicy('{"exceptions": {}}')).toThrow(/must be an array/);
    expect(() => loadReleasePolicy('{"exceptions": [{"reason": "why"}]}')).toThrow(/must be an object with a "package" string/);
    expect(() => loadReleasePolicy('{"exceptions": [{"package": "x"}]}')).toThrow(/must include a "reason"/);
  });
});

describe('evaluateVulnerabilityPolicy', () => {
  const report = JSON.stringify({
    scannedPackageCount: 1188,
    generatedAt: '2026-01-01T00:00:00.000Z',
    findings: [
      { packageName: 'left-pad', packageVersion: '1.0.0', vulnId: 'GHSA-1', severity: 'CRITICAL', summary: 'bad' },
      { packageName: 'lodash', packageVersion: '4.0.0', vulnId: 'GHSA-2', severity: 'high', summary: null },
      { packageName: 'debug', packageVersion: '2.0.0', vulnId: 'GHSA-3', severity: 'MODERATE', summary: null },
      { packageName: 'old', packageVersion: '1.0.0', vulnId: 'GHSA-4', severity: 'LOW', summary: null },
    ],
    blockingFindings: [],
  });

  it('keeps only the findings at or above the failure severities', () => {
    const violations = evaluateVulnerabilityPolicy(report, ['CRITICAL', 'HIGH']);
    expect(violations.map((violation) => violation.vulnId)).toEqual(['GHSA-1', 'GHSA-2']);
    expect(violations[0]).toEqual({
      package: 'left-pad',
      version: '1.0.0',
      vulnId: 'GHSA-1',
      severity: 'CRITICAL',
      summary: 'bad',
    });
    expect(violations[1].severity).toBe('HIGH');
  });

  it('returns nothing when the failure severities list is empty', () => {
    expect(evaluateVulnerabilityPolicy(report, [])).toEqual([]);
  });

  it('throws when the report is not the security-audit JSON shape', () => {
    expect(() => evaluateVulnerabilityPolicy('{}', ['HIGH'])).toThrow(/missing "findings" array/);
    expect(() => evaluateVulnerabilityPolicy('[]', ['HIGH'])).toThrow(/missing "findings" array/);
  });
});

describe('licenseToCycloneDx', () => {
  it('maps a lone SPDX identifier to `license.id`', () => {
    expect(licenseToCycloneDx('MIT')).toEqual([{ license: { id: 'MIT' } }]);
    expect(licenseToCycloneDx('BSD-3-Clause')).toEqual([{ license: { id: 'BSD-3-Clause' } }]);
  });

  it('keeps expressions in CycloneDX `expression` form', () => {
    expect(licenseToCycloneDx('(MIT OR CC0-1.0)')).toEqual([{ expression: '(MIT OR CC0-1.0)' }]);
    expect(licenseToCycloneDx('MIT and ISC')).toEqual([{ expression: 'MIT and ISC' }]);
    expect(licenseToCycloneDx('GPL-2.0-only WITH Classpath-exception-2.0')).toEqual([
      { expression: 'GPL-2.0-only WITH Classpath-exception-2.0' },
    ]);
  });

  it('records an unknown license as a name rather than dropping it', () => {
    expect(licenseToCycloneDx('UNKNOWN')).toEqual([{ license: { name: 'UNKNOWN' } }]);
  });

  it('falls back to a name for values that are not SPDX identifiers', () => {
    expect(licenseToCycloneDx('Acme Proprietary')).toEqual([{ license: { name: 'Acme Proprietary' } }]);
  });
});

describe('deterministicSerialNumber', () => {
  it('produces a stable, RFC 4122-shaped UUID for the same seed', () => {
    const serial = deterministicSerialNumber('stellar-alerts@1.0.0|pkg:npm/mit@1.0.0');
    expect(serial).toBe(deterministicSerialNumber('stellar-alerts@1.0.0|pkg:npm/mit@1.0.0'));
    expect(serial).toMatch(/^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('changes when the seed changes', () => {
    expect(deterministicSerialNumber('a')).not.toBe(deterministicSerialNumber('b'));
  });
});

describe('buildSbom', () => {
  const packages = [
    pkg({ name: 'mit-pkg', version: '1.0.0', license: 'MIT', purl: 'pkg:npm/mit-pkg@1.0.0' }),
    pkg({ name: 'dev-pkg', version: '2.0.0', license: 'UNKNOWN', purl: 'pkg:npm/dev-pkg@2.0.0', scope: 'dev' }),
    pkg({ name: 'opt-pkg', version: '3.0.0', license: 'MIXED', purl: 'pkg:npm/opt-pkg@3.0.0', scope: 'optional' }),
  ];
  const options = { projectName: 'stellar-alerts', projectVersion: '1.0.0', timestamp: '2026-01-01T00:00:00.000Z' };

  it('emits a CycloneDX 1.5 document describing the project', () => {
    const sbom = buildSbom(packages, options);
    expect(sbom.bomFormat).toBe('CycloneDX');
    expect(sbom.specVersion).toBe('1.5');
    expect(sbom.version).toBe(1);
    expect(sbom.serialNumber).toMatch(/^urn:uuid:/);
    expect(sbom.metadata.timestamp).toBe(options.timestamp);
    expect(sbom.metadata.component).toEqual({
      type: 'application',
      name: 'stellar-alerts',
      version: '1.0.0',
      'bom-ref': 'pkg:npm/stellar-alerts@1.0.0',
    });
    expect(sbom.metadata.tools[0].name).toBe('release-report');
  });

  it('lists every package as a library with purl, bom-ref and license', () => {
    const sbom = buildSbom(packages, options);
    expect(sbom.components).toHaveLength(3);
    expect(sbom.components[0]).toMatchObject({
      type: 'library',
      name: 'mit-pkg',
      version: '1.0.0',
      purl: 'pkg:npm/mit-pkg@1.0.0',
      'bom-ref': 'pkg:npm/mit-pkg@1.0.0',
      scope: 'required',
      licenses: [{ license: { id: 'MIT' } }],
    });
    expect(sbom.components[1].scope).toBe('optional');
    expect(sbom.components[2].licenses).toEqual([{ license: { id: 'MIXED' } }]);
  });

  it('records the npm dependency scope as a property so dev is not lost', () => {
    const sbom = buildSbom(packages, options);
    expect(sbom.components[1].properties).toEqual([
      { name: 'stellar-alerts:dependency-scope', value: 'dev' },
    ]);
    expect(sbom.components[2].properties).toEqual([
      { name: 'stellar-alerts:dependency-scope', value: 'optional' },
    ]);
  });

  it('only varies the timestamp between runs of the same component set', () => {
    const first = buildSbom(packages, options);
    const second = buildSbom(packages, { ...options, timestamp: '2026-06-01T00:00:00.000Z' });
    expect(second.serialNumber).toBe(first.serialNumber);
    expect(second.components).toEqual(first.components);
    expect(second.metadata.timestamp).not.toBe(first.metadata.timestamp);
  });

  it('changes the serial number when the component set changes', () => {
    const base = buildSbom(packages, options);
    const extended = buildSbom(
      [...packages, pkg({ name: 'extra', version: '1.0.0', purl: 'pkg:npm/extra@1.0.0' })],
      options,
    );
    expect(extended.serialNumber).not.toBe(base.serialNumber);
  });
});

describe('buildLicenseReport / buildReleaseReport / renderLicenseMarkdown', () => {
  const packages = [
    pkg({ name: 'alpha', version: '1.0.0', license: 'MIT', purl: 'pkg:npm/alpha@1.0.0' }),
    pkg({ name: 'beta', version: '1.0.0', license: 'MIT', purl: 'pkg:npm/beta@1.0.0', scope: 'dev' }),
    pkg({ name: 'gamma', version: '2.0.0', license: 'UNKNOWN', purl: 'pkg:npm/gamma@2.0.0' }),
    pkg({ name: 'delta', version: '3.0.0', license: 'GPL-3.0', purl: 'pkg:npm/delta@3.0.0' }),
  ];

  it('counts licenses by frequency and lists packages without metadata', () => {
    const inventory = buildLicenseReport(packages);
    expect(inventory.totalPackages).toBe(4);
    expect(inventory.licenses).toEqual([
      { license: 'MIT', count: 2 },
      { license: 'GPL-3.0', count: 1 },
      { license: 'UNKNOWN', count: 1 },
    ]);
    expect(inventory.unknownPackages).toEqual([{ name: 'gamma', version: '2.0.0' }]);
    expect(inventory.packages).toHaveLength(4);
  });

  it('marks the report as passing when no violation is recorded', () => {
    const report = buildReleaseReport({
      generatedAt: '2026-01-01T00:00:00.000Z',
      project: { name: 'stellar-alerts', version: '1.0.0' },
      policyPath: 'release-policy.json',
      inventory: buildLicenseReport(packages),
      licenseViolations: [],
      vulnerabilityViolations: [],
    });

    expect(report.summary).toEqual({
      totalPackages: 4,
      distinctLicenses: 3,
      licenseViolations: 0,
      vulnerabilityViolations: 0,
      passed: true,
    });
  });

  it('marks the report as failing and keeps the violation details', () => {
    const report = buildReleaseReport({
      generatedAt: '2026-01-01T00:00:00.000Z',
      project: { name: 'stellar-alerts', version: '1.0.0' },
      policyPath: null,
      inventory: buildLicenseReport(packages),
      licenseViolations: [
        { package: 'delta', version: '3.0.0', license: 'GPL-3.0', reason: '"GPL-3.0" is not covered by the allowed license list.' },
      ],
      vulnerabilityViolations: [
        { package: 'gamma', version: '2.0.0', vulnId: 'GHSA-3', severity: 'HIGH', summary: 'boom' },
      ],
    });

    expect(report.summary.passed).toBe(false);
    expect(report.summary.licenseViolations).toBe(1);
    expect(report.summary.vulnerabilityViolations).toBe(1);
    expect(report.policy.path).toBeNull();
  });

  it('renders a readable markdown report with every section', () => {
    const report = buildReleaseReport({
      generatedAt: '2026-01-01T00:00:00.000Z',
      project: { name: 'stellar-alerts', version: '1.2.3' },
      policyPath: 'release-policy.json',
      inventory: buildLicenseReport(packages),
      licenseViolations: [
        { package: 'delta', version: '3.0.0', license: 'GPL-3.0', reason: 'not allowed' },
      ],
      vulnerabilityViolations: [
        { package: 'gamma', version: '2.0.0', vulnId: 'GHSA-3', severity: 'HIGH', summary: 'boom' },
      ],
    });

    const markdown = renderLicenseMarkdown(report);
    expect(markdown).toContain('# Dependency License & SBOM Report');
    expect(markdown).toContain('`stellar-alerts@1.2.3`');
    expect(markdown).toContain('**Status:** ❌ failed');
    expect(markdown).toContain('| `MIT` | 2 |');
    expect(markdown).toContain('| `delta@3.0.0` | `GPL-3.0` | not allowed |');
    expect(markdown).toContain('| `gamma@2.0.0` | GHSA-3 | HIGH | boom |');
    expect(markdown).toContain('- `gamma@2.0.0`');
    expect(markdown.endsWith('\n')).toBe(true);
  });

  it('reports "None." instead of an empty table when everything passes', () => {
    const report = buildReleaseReport({
      generatedAt: '2026-01-01T00:00:00.000Z',
      project: { name: 'stellar-alerts', version: '1.2.3' },
      policyPath: 'release-policy.json',
      inventory: buildLicenseReport([pkg({ license: 'MIT' })]),
      licenseViolations: [],
      vulnerabilityViolations: [],
    });

    const markdown = renderLicenseMarkdown(report);
    expect(markdown).toContain('**Status:** ✅ passed');
    expect(markdown).toContain('None.');
    expect(markdown).not.toContain('## Packages without declared license metadata');
  });
});

describe('run', () => {
  /** A lockfile with one denied (AGPL) and one unknown-license package. */
  const violatingLockfile = lockfile({
    'node_modules/ok-pkg': { version: '1.0.0', resolved: RESOLVED, license: 'MIT' },
    'node_modules/copyleft-pkg': { version: '1.0.0', resolved: RESOLVED, license: 'AGPL-3.0-only' },
    'node_modules/mystery-pkg': { version: '1.0.0', resolved: RESOLVED },
  });

  const violatingPolicy = JSON.stringify(
    policy({ allowedLicenses: ['MIT'], deniedLicenses: ['AGPL-3.0-only'], allowUnknownLicense: false }),
  );

  function writeFixture(dir: string, name: string, contents: string): string {
    const target = join(dir, name);
    writeFileSync(target, contents, 'utf8');
    return target;
  }

  it('generates the SBOM, JSON report and markdown report for this repository', async () => {
    const outDir = makeTempDir();
    const result = await run({ outDir });

    expect(result.passed).toBe(true);
    expect(result.outputs).toEqual([
      join(outDir, SBOM_FILENAME),
      join(outDir, LICENSE_REPORT_JSON_FILENAME),
      join(outDir, LICENSE_REPORT_MD_FILENAME),
    ]);
    expect(result.report.violations.licenses).toEqual([]);
    expect(result.report.summary.totalPackages).toBeGreaterThan(500);

    const sbom = JSON.parse(readFileSync(join(outDir, SBOM_FILENAME), 'utf8'));
    expect(sbom.bomFormat).toBe('CycloneDX');
    expect(sbom.specVersion).toBe('1.5');
    expect(sbom.components).toHaveLength(result.report.summary.totalPackages);
    expect(
      sbom.components.every(
        (component: Record<string, string>) =>
          component.purl.startsWith('pkg:npm/') && component.purl === component['bom-ref'],
      ),
    ).toBe(true);

    const markdown = readFileSync(join(outDir, LICENSE_REPORT_MD_FILENAME), 'utf8');
    expect(markdown).toContain('**Status:** ✅ passed');
    expect(markdown).toContain('## License distribution');
  });

  it('ships a policy that covers every license in the repository lockfile', async () => {
    const lockfileJson = JSON.parse(readFileSync(fileURLToPath(REPO_LOCKFILE), 'utf8'));
    const policy = loadReleasePolicy(readFileSync(fileURLToPath(REPO_POLICY), 'utf8'));

    // `extractReleasePackages` walks the npm v3 `packages` map.
    expect(lockfileJson.lockfileVersion).toBe(3);
    expect(lockfileJson.packages).toBeTypeOf('object');

    const result = await run({ outDir: makeTempDir() });
    expect(result.report.policy.path).toBe('release-policy.json');
    expect(result.passed).toBe(true);

    // Every package without license metadata must be covered by a reviewed exception.
    const excepted = new Set(policy.exceptions.map((exception) => exception.package));
    for (const unknown of result.report.unknownPackages) {
      expect(excepted.has(unknown.name)).toBe(true);
    }

    // A license cannot be allowed and denied at the same time, and unknown
    // licenses stay opt-in so new gaps surface instead of slipping through.
    for (const denied of policy.deniedLicenses) {
      expect(policy.allowedLicenses).not.toContain(denied);
    }
    expect(policy.allowUnknownLicense).toBe(false);
    expect(policy.failOnVulnerabilitySeverities).toEqual(['CRITICAL', 'HIGH']);
  });

  it('produces the same serial number and components on a second run', async () => {
    const first = await run({ outDir: makeTempDir() });
    const second = await run({ outDir: makeTempDir() });
    expect(second.sbom.serialNumber).toBe(first.sbom.serialNumber);
    expect(second.sbom.components).toEqual(first.sbom.components);
    expect(second.report.packages).toEqual(first.report.packages);
  });

  it('still writes artifacts and reports failure when a license is denied', async () => {
    const dir = makeTempDir();
    const outDir = join(dir, 'artifacts');
    const result = await run({
      lockfilePath: writeFixture(dir, 'package-lock.json', violatingLockfile),
      policyPath: writeFixture(dir, 'release-policy.json', violatingPolicy),
      outDir,
    });

    expect(result.passed).toBe(false);
    expect(result.report.violations.licenses.map((violation) => violation.package)).toEqual([
      'copyleft-pkg',
      'mystery-pkg',
    ]);
    expect(existsSync(join(outDir, LICENSE_REPORT_MD_FILENAME))).toBe(true);
    expect(readFileSync(join(outDir, LICENSE_REPORT_MD_FILENAME), 'utf8')).toContain('**Status:** ❌ failed');
  });

  it('applies the vulnerability report when one is supplied', async () => {
    const dir = makeTempDir();
    const reportPath = writeFixture(
      dir,
      'osv-report.json',
      JSON.stringify({
        scannedPackageCount: 3,
        generatedAt: '2026-01-01T00:00:00.000Z',
        findings: [
          { packageName: 'ok-pkg', packageVersion: '1.0.0', vulnId: 'GHSA-1', severity: 'CRITICAL', summary: 'bad' },
          { packageName: 'ok-pkg', packageVersion: '1.0.0', vulnId: 'GHSA-2', severity: 'LOW', summary: 'meh' },
        ],
        blockingFindings: [],
      }),
    );

    const result = await run({
      lockfilePath: writeFixture(dir, 'package-lock.json', violatingLockfile),
      policyPath: writeFixture(dir, 'release-policy.json', violatingPolicy),
      vulnerabilityReportPath: reportPath,
      outDir: join(dir, 'artifacts'),
    });

    expect(result.report.violations.vulnerabilities).toEqual([
      { package: 'ok-pkg', version: '1.0.0', vulnId: 'GHSA-1', severity: 'CRITICAL', summary: 'bad' },
    ]);
    expect(result.passed).toBe(false);
  });

  it('writes nothing in check mode', async () => {
    const outDir = makeTempDir();
    const result = await run({ outDir, check: true });
    expect(result.outputs).toEqual([]);
    expect(existsSync(join(outDir, SBOM_FILENAME))).toBe(false);
    expect(existsSync(join(outDir, LICENSE_REPORT_JSON_FILENAME))).toBe(false);
    expect(existsSync(join(outDir, LICENSE_REPORT_MD_FILENAME))).toBe(false);
  });

  it('honours an explicit release version for the project metadata', async () => {
    const outDir = makeTempDir();
    const result = await run({ outDir, releaseVersion: '2.5.0' });
    expect(result.report.project).toEqual({ name: 'stellar-alerts', version: '2.5.0' });
    expect(result.sbom.metadata.component.version).toBe('2.5.0');
  });

  it('fails loudly when the policy file is missing', async () => {
    const dir = makeTempDir();
    await expect(run({ policyPath: join(dir, 'missing-policy.json'), outDir: dir })).rejects.toThrow(/ENOENT/);
  });
});
