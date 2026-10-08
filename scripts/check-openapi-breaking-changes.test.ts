import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  checkOpenApiBreakingChanges,
  readBaseSpecFromGit,
  summarizeSpec,
  compareSemver,
  analyzeComponentSchemas,
  normalizeSpecForOpenApiDiff,
} from './check-openapi-breaking-changes';

/**
 * Focused tests for the OpenAPI breaking-change detection (issue #457).
 *
 * The real openapi-diff engine is exercised (not mocked) so these tests prove
 * the actual classification of contract changes: path/response removals and
 * narrowings are breaking, additions are not, and the git/file plumbing
 * handles missing base specs without failing the build.
 */

function specFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    openapi: '3.0.3',
    info: { title: 'Stellar Alerts API', version: '1.0.0' },
    // openapi-diff (via swagger-parser) rejects OpenAPI 3.0 documents without
    // a paths object, so fixtures always include it.
    paths: {},
    ...overrides,
  };
}

const walletSchema = {
  type: 'object',
  required: ['address'],
  properties: {
    address: { type: 'string' },
    label: { type: 'string' },
  },
};

async function writeTempSpec(content: Record<string, unknown>): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'openapi-check-'));
  const file = path.join(dir, 'spec.json');
  await fsp.writeFile(file, JSON.stringify(content, null, 2), 'utf8');
  return file;
}

/** Runs the checker against explicit base/head temp files. */
async function checkWithFiles(base: Record<string, unknown>, head: Record<string, unknown>) {
  const baseFile = await writeTempSpec(base);
  const headFile = await writeTempSpec(head);
  return checkOpenApiBreakingChanges({ basePath: baseFile, headPath: headFile });
}

/** Synchronous variant for the CLI exit-code test. */
function writeTempSpecSync(content: Record<string, unknown>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openapi-check-'));
  const file = path.join(dir, 'spec.json');
  fs.writeFileSync(file, JSON.stringify(content, null, 2), 'utf8');
  return file;
}

const originalCwd = process.cwd();

describe('summarizeSpec', () => {
  it('counts paths and component schemas and extracts the version', () => {
    const summary = summarizeSpec({
      info: { version: '2.5.0' },
      paths: { '/wallets': {}, '/payments': {} },
      components: { schemas: { CreateWalletInput: {}, Wallet: {} } },
    });
    expect(summary).toEqual({ paths: 2, schemas: 2, version: '2.5.0' });
  });

  it('tolerates missing paths/components/info blocks', () => {
    expect(summarizeSpec({})).toEqual({ paths: 0, schemas: 0, version: null });
  });
});

describe('compareSemver', () => {
  it('compares major, minor and patch numerically', () => {
    expect(compareSemver('2.0.0', '1.9.9')).toBeGreaterThan(0);
    expect(compareSemver('1.1.0', '1.0.9')).toBeGreaterThan(0);
    expect(compareSemver('1.0.1', '1.0.0')).toBeGreaterThan(0);
    expect(compareSemver('1.0.0', '1.0.0')).toBe(0);
    expect(compareSemver('1.0.0', '2.0.0')).toBeLessThan(0);
  });

  it('treats missing or malformed versions as "no bump"', () => {
    expect(compareSemver(null, '1.0.0')).toBe(0);
    expect(compareSemver('1.0.0', null)).toBe(0);
    expect(compareSemver('not-semver', '1.0.0')).toBe(0);
    expect(compareSemver('1.0', '1.0.0')).toBe(0);
    expect(compareSemver('v1.0.1', '1.0.0')).toBeGreaterThan(0);
  });
});

describe('analyzeComponentSchemas', () => {
  const schemas = (s: Record<string, unknown>) => ({ components: { schemas: s } });

  it('flags removed schemas', () => {
    const changes = analyzeComponentSchemas(
      schemas({ CreateWalletInput: walletSchema, Legacy: walletSchema }),
      schemas({ CreateWalletInput: walletSchema })
    );
    expect(changes.map((c) => c.code)).toEqual(['schema.removed']);
    expect(changes[0].schema).toBe('Legacy');
    expect(changes[0].location).toBe('components.schemas.Legacy');
  });

  it('flags removed properties recursively', () => {
    const base = {
      type: 'object',
      properties: {
        address: {
          type: 'object',
          properties: { value: { type: 'string' }, chain: { type: 'string' } },
        },
      },
    };
    const head = {
      type: 'object',
      properties: {
        address: {
          type: 'object',
          properties: { value: { type: 'string' } },
        },
      },
    };
    const changes = analyzeComponentSchemas(schemas({ S: base }), schemas({ S: head }));
    expect(changes).toHaveLength(1);
    expect(changes[0].code).toBe('schema.property.removed');
    expect(changes[0].location).toBe(
      'components.schemas.S.properties.address.properties.chain'
    );
  });

  it('flags newly required properties', () => {
    const base = {
      type: 'object',
      required: ['address'],
      properties: { address: { type: 'string' }, memo: { type: 'string' } },
    };
    const head = {
      type: 'object',
      required: ['address', 'memo'],
      properties: { address: { type: 'string' }, memo: { type: 'string' } },
    };
    const changes = analyzeComponentSchemas(schemas({ S: base }), schemas({ S: head }));
    expect(changes.map((c) => c.code)).toEqual(['schema.required.added']);
    expect(changes[0].detail).toContain('memo');
  });

  it('flags changed property types', () => {
    const changes = analyzeComponentSchemas(
      schemas({ S: { type: 'object', properties: { amount: { type: 'string' } } } }),
      schemas({ S: { type: 'object', properties: { amount: { type: 'integer' } } } })
    );
    expect(changes.map((c) => c.code)).toEqual(['schema.type.changed']);
  });

  it('flags removed enum values', () => {
    const changes = analyzeComponentSchemas(
      schemas({
        S: { type: 'object', properties: { status: { type: 'string', enum: ['active', 'frozen'] } } },
      }),
      schemas({
        S: { type: 'object', properties: { status: { type: 'string', enum: ['active'] } } },
      })
    );
    expect(changes.map((c) => c.code)).toEqual(['schema.enum.value.removed']);
    expect(changes[0].detail).toContain('"frozen"');
  });

  it('does not flag additive changes (new schema, property, or enum value)', () => {
    const base = {
      type: 'object',
      required: ['address'],
      properties: { address: { type: 'string' }, status: { type: 'string', enum: ['active'] } },
    };
    const head = {
      type: 'object',
      required: ['address'],
      properties: {
        address: { type: 'string' },
        status: { type: 'string', enum: ['active', 'frozen'] },
        memo: { type: 'string' },
      },
    };
    const changes = analyzeComponentSchemas(
      schemas({ S: base }),
      schemas({ S: head, Extra: walletSchema })
    );
    expect(changes).toEqual([]);
  });
});

describe('readBaseSpecFromGit', () => {
  it('returns the committed spec content for an existing ref:path', () => {
    // HEAD always has openapi.json in this repo — asserts real git plumbing.
    const content = readBaseSpecFromGit('HEAD', 'openapi.json');
    expect(content).toBeTruthy();
    expect(() => JSON.parse(content as string)).not.toThrow();
  });

  it('returns null (does not throw) when the path is absent on the ref', () => {
    expect(readBaseSpecFromGit('HEAD', 'definitely/not/here.json')).toBeNull();
  });

  it('returns null for an unknown ref instead of crashing', () => {
    expect(
      readBaseSpecFromGit('0000000000000000000000000000000000000000', 'openapi.json')
    ).toBeNull();
  });
});

describe('checkOpenApiBreakingChanges', () => {
  it('passes when the specs are identical', async () => {
    const spec = specFixture({
      paths: { '/wallets': {} },
      components: { schemas: { CreateWalletInput: walletSchema } },
    });
    const result = await checkWithFiles(spec, spec);
    expect(result.breaking).toBe(false);
    expect(result.baseSpecMissing).toBe(false);
    expect(result.report).toContain('No API contract changes detected');
  });

  it('flags schema removal as a breaking change', async () => {
    const base = specFixture({
      components: { schemas: { CreateWalletInput: walletSchema, Legacy: walletSchema } },
    });
    const head = specFixture({
      components: { schemas: { CreateWalletInput: walletSchema } },
    });
    const result = await checkWithFiles(base, head);
    expect(result.breaking).toBe(true);
    expect(result.acknowledgedByVersionBump).toBe(false);
    expect(result.report).toContain('schema.removed');
    expect(result.report).toMatch(/would break existing API consumers/);
  });

  it('flags a narrowed response body as breaking via openapi-diff', async () => {
    const resp = () => ({
      description: 'ok',
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: { id: { type: 'string' }, balance: { type: 'string' } },
          },
        },
      },
    });
    const base = specFixture({ paths: { '/wallets': { get: { responses: { 200: resp() } } } } });
    const head = specFixture({
      paths: {
        '/wallets': {
          get: {
            responses: {
              200: {
                description: 'ok',
                content: {
                  'application/json': {
                    schema: { type: 'object', properties: { id: { type: 'string' } } },
                  },
                },
              },
            },
          },
        },
      },
    });
    const result = await checkWithFiles(base, head);
    expect(result.breaking).toBe(true);
    // openapi-diff reports a narrowed body with this code (its naming is
    // inverted relative to intent: the "add" is of the `not` constraint).
    expect(result.report).toContain('response.body.scope.add');
  });

  it('does not flag an added path as breaking', async () => {
    const pathItem = { get: { responses: { 200: { description: 'ok' } } } };
    const base = specFixture({ paths: { '/wallets': pathItem } });
    const head = specFixture({ paths: { '/wallets': pathItem, '/payments': pathItem } });
    const result = await checkWithFiles(base, head);
    expect(result.breaking).toBe(false);
    expect(result.report).toMatch(/non-breaking/i);
  });

  it('acknowledges breaking changes when info.version is bumped', async () => {
    const base = specFixture({
      info: { title: 'Stellar Alerts API', version: '1.0.0' },
      components: { schemas: { CreateWalletInput: walletSchema } },
    });
    const head = specFixture({
      info: { title: 'Stellar Alerts API', version: '2.0.0' },
      components: { schemas: {} },
    });
    const result = await checkWithFiles(base, head);
    expect(result.breaking).toBe(true);
    expect(result.acknowledgedByVersionBump).toBe(true);
    expect(result.report).toContain('acknowledged by an OpenAPI info.version bump');
  });

  it('does not acknowledge a version downgrade', async () => {
    // Schema is removed (breaking) while the version number goes backwards —
    // a downgrade must never count as the acknowledgement escape hatch.
    const base = specFixture({
      info: { title: 'Stellar Alerts API', version: '2.0.0' },
      components: { schemas: { Legacy: walletSchema } },
    });
    const head = specFixture({
      info: { title: 'Stellar Alerts API', version: '1.0.0' },
      components: { schemas: {} },
    });
    const result = await checkWithFiles(base, head);
    expect(result.breaking).toBe(true);
    expect(result.acknowledgedByVersionBump).toBe(false);
  });

  it('returns baseSpecMissing and does not fail when the base has no spec', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'openapi-check-'));
    const result = await checkOpenApiBreakingChanges({
      basePath: path.join(dir, 'does-not-exist.json'),
    });
    expect(result.baseSpecMissing).toBe(true);
    expect(result.breaking).toBe(false);
    expect(result.report).toContain('nothing to compare yet');
  });

  it('compares against the committed openapi.json on HEAD via git', async () => {
    // Uses the real git layer: HEAD's spec IS the current head spec, so this
    // must be clean, proving the ref:path plumbing works end to end.
    const result = await checkOpenApiBreakingChanges({ baseRef: 'HEAD' });
    expect(result.baseSpecMissing).toBe(false);
    expect(result.breaking).toBe(false);
    expect(result.report).toContain('No API contract changes detected');
  });

  it('exits 1 via the CLI when breaking, 0 when clean (exit-code contract)', async () => {
    const { execFileSync } = await import('node:child_process');
    const script = path.resolve(originalCwd, 'scripts/check-openapi-breaking-changes.ts');
    const run = (base: Record<string, unknown>, head: Record<string, unknown>): number => {
      const baseFile = writeTempSpecSync(base);
      const headFile = writeTempSpecSync(head);
      try {
        execFileSync(
          'npx',
          ['tsx', script, '--base-path', baseFile, '--head', headFile],
          { encoding: 'utf8', stdio: 'pipe', shell: process.platform === 'win32' }
        );
        return 0;
      } catch (err: unknown) {
        return (err as { status?: number }).status ?? -1;
      }
    };

    const breakingBase = specFixture({ components: { schemas: { CreateWalletInput: walletSchema } } });
    const breakingHead = specFixture({ components: { schemas: {} } });
    expect(run(breakingBase, breakingHead)).toBe(1);

    const cleanSpec = specFixture({ components: { schemas: { CreateWalletInput: walletSchema } } });
    expect(run(cleanSpec, cleanSpec)).toBe(0);
  }, 120000);
});

describe('normalizeSpecForOpenApiDiff', () => {
  it('drops the JSON-Schema-only propertyNames keyword from OpenAPI 3.0 records', () => {
    const normalized = normalizeSpecForOpenApiDiff(
      specFixture({
        components: {
          schemas: {
            RecordInput: {
              type: 'object',
              propertyNames: { type: 'string' },
              additionalProperties: { type: 'string' },
            },
          },
        },
      })
    ) as unknown as { components: { schemas: Record<string, Record<string, unknown>> } };

    const schema = normalized.components.schemas.RecordInput;
    expect(schema.propertyNames).toBeUndefined();
    expect(schema.additionalProperties).toEqual({ type: 'string' });
  });

  it('rewrites anyOf null branches as nullable so an OpenAPI 3.0 validator accepts them', () => {
    const normalized = normalizeSpecForOpenApiDiff(
      specFixture({
        components: {
          schemas: {
            LedgerBounds: {
              anyOf: [
                { type: 'object', properties: { min: { type: 'integer' } } },
                { type: 'null' },
              ],
            },
          },
        },
      })
    ) as unknown as { components: { schemas: Record<string, Record<string, unknown>> } };

    const schema = normalized.components.schemas.LedgerBounds;
    expect(schema.anyOf).toBeUndefined();
    expect(schema.nullable).toBe(true);
    expect(schema.type).toBe('object');
  });

  it('leaves OpenAPI 3.1 documents untouched, since 3.1 allows the full JSON Schema vocabulary', () => {
    const spec = {
      openapi: '3.1.0',
      info: { title: 'Stellar Alerts API', version: '1.0.0' },
      paths: {},
      components: {
        schemas: { RecordInput: { type: 'object', propertyNames: { type: 'string' } } },
      },
    };

    expect(normalizeSpecForOpenApiDiff(spec)).toBe(spec);
  });
});
