import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AnyBaseline } from './no-new-any';
import { checkPolicy, createBaseline, scanProductionAny, scanSource } from './no-new-any';

function baselineFor(source: string): AnyBaseline {
  return createBaseline(new Map([['apps/api/src/example.ts', scanSource(source)]]));
}

describe('no-new-any policy', () => {
  it('detects explicit any types and casts without matching prose', () => {
    const occurrences = scanSource(`
      // any value in prose is allowed
      const payload: any = value as any;
      const safe: unknown = value;
    `);

    expect(occurrences.map(({ kind }) => kind)).toEqual(['type', 'cast']);
  });

  it('excludes tests and generated sources from production scanning', async () => {
    const repositoryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'no-new-any-'));
    try {
      await fs.mkdir(path.join(repositoryRoot, 'apps/api/src/generated'), { recursive: true });
      await fs.writeFile(path.join(repositoryRoot, 'apps/api/src/index.ts'), 'export const value: any = null;');
      await fs.writeFile(path.join(repositoryRoot, 'apps/api/src/index.test.ts'), 'const testValue: any = null;');
      await fs.writeFile(path.join(repositoryRoot, 'apps/api/src/generated/types.ts'), 'export type Value = any;');

      const findings = await scanProductionAny(repositoryRoot);

      expect([...findings.keys()]).toEqual(['apps/api/src/index.ts']);
    } finally {
      await fs.rm(repositoryRoot, { recursive: true, force: true });
    }
  });

  it('accepts unchanged owned baseline occurrences', () => {
    const source = 'export function parse(value: any): any { return value; }';
    const findings = new Map([['apps/api/src/example.ts', scanSource(source)]]);

    expect(checkPolicy(findings, baselineFor(source))).toEqual({ errors: [], occurrenceCount: 2 });
  });

  it('rejects a new explicit any even when the file is already baselined', () => {
    const original = 'export const parse = (value: any) => value;';
    const changed = `${original}\nexport const serialize = (value: any) => value;`;
    const findings = new Map([['apps/api/src/example.ts', scanSource(changed)]]);

    const result = checkPolicy(findings, baselineFor(original));

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('new explicit any');
  });

  it('requires every baseline exception to have an owner and reason', () => {
    const source = 'const payload: any = value;';
    const baseline = baselineFor(source);
    baseline.exceptions[0].owner = '';

    expect(checkPolicy(new Map([['apps/api/src/example.ts', scanSource(source)]]), baseline).errors).toContain(
      'Baseline exception apps/api/src/example.ts must include an owner, reason, and fingerprints.',
    );
  });

  it('reports stale occurrences so removed debt cannot remain as unused allowance', () => {
    const baseline = baselineFor('const payload: any = value;');

    const result = checkPolicy(new Map(), baseline);

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('stale baseline occurrence');
  });
});
