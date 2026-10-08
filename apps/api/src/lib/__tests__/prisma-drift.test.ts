/**
 * Tests for the Prisma drift detection logic.
 *
 * These tests exercise the same invariants the CI script checks, but in a
 * fast, in-process way using the actual repository artefacts:
 *   • migration_lock.toml provider matches schema.prisma datasource provider
 *   • all migration directory names follow the YYYYMMDDHHMMSS_name convention
 *   • migration timestamps are strictly non-decreasing
 *   • every migration directory contains a non-empty migration.sql
 *   • the generated Prisma client directory exists
 *
 * The tests read real files from the repository to give genuine coverage of
 * the current state, not a fixture.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { resolve, join } from 'path';

const API_ROOT = resolve(__dirname, '../../..');
const SCHEMA_PATH = join(API_ROOT, 'prisma/schema.prisma');
const MIGRATIONS_DIR = join(API_ROOT, 'prisma/migrations');
const LOCK_FILE = join(MIGRATIONS_DIR, 'migration_lock.toml');
const GENERATED_DIR = join(API_ROOT, 'generated/prisma');

const MIGRATION_NAME_RE = /^(\d{14})_.+/;

describe('Prisma drift detection — repository artefacts', () => {
  it('schema.prisma exists', () => {
    expect(existsSync(SCHEMA_PATH)).toBe(true);
  });

  it('migration_lock.toml exists', () => {
    expect(existsSync(LOCK_FILE)).toBe(true);
  });

  it('migration_lock.toml provider matches schema.prisma datasource provider', () => {
    const lockContent = readFileSync(LOCK_FILE, 'utf-8');
    const lockMatch = lockContent.match(/provider\s*=\s*"([^"]+)"/);
    expect(lockMatch, 'migration_lock.toml must declare a provider').not.toBeNull();
    const lockProvider = lockMatch![1];

    const schemaContent = readFileSync(SCHEMA_PATH, 'utf-8');
    const schemaMatch = schemaContent.match(
      /datasource\s+\w+\s*\{[^}]*provider\s*=\s*"([^"]+)"/s,
    );
    expect(schemaMatch, 'schema.prisma must declare a datasource provider').not.toBeNull();
    const schemaProvider = schemaMatch![1];

    expect(lockProvider).toBe(schemaProvider);
  });

  it('migrations directory exists and contains at least one migration', () => {
    expect(existsSync(MIGRATIONS_DIR)).toBe(true);
    const dirs = readdirSync(MIGRATIONS_DIR).filter((n) =>
      statSync(join(MIGRATIONS_DIR, n)).isDirectory(),
    );
    expect(dirs.length).toBeGreaterThan(0);
  });

  it('all migration directory names follow the YYYYMMDDHHMMSS_name convention', () => {
    const dirs = readdirSync(MIGRATIONS_DIR).filter((n) =>
      statSync(join(MIGRATIONS_DIR, n)).isDirectory(),
    );
    const violations = dirs.filter((d) => !MIGRATION_NAME_RE.test(d));
    expect(violations).toHaveLength(0);
  });

  it('migration timestamps are in non-decreasing order', () => {
    const dirs = readdirSync(MIGRATIONS_DIR)
      .filter((n) => statSync(join(MIGRATIONS_DIR, n)).isDirectory())
      .sort();

    let prev = '';
    const violations: string[] = [];
    for (const dir of dirs) {
      const match = dir.match(MIGRATION_NAME_RE);
      if (!match) continue;
      const ts = match[1];
      if (ts < prev) {
        violations.push(`${dir} (ts=${ts}) comes after ${prev}`);
      }
      prev = ts;
    }
    expect(violations).toHaveLength(0);
  });

  it('every migration directory contains a non-empty migration.sql', () => {
    const dirs = readdirSync(MIGRATIONS_DIR)
      .filter((n) => statSync(join(MIGRATIONS_DIR, n)).isDirectory())
      .sort();

    const missing: string[] = [];
    for (const dir of dirs) {
      const sqlPath = join(MIGRATIONS_DIR, dir, 'migration.sql');
      if (!existsSync(sqlPath)) {
        missing.push(`${dir}: missing migration.sql`);
      } else if (statSync(sqlPath).size === 0) {
        missing.push(`${dir}: migration.sql is empty`);
      }
    }
    expect(missing).toHaveLength(0);
  });

  it('generated Prisma client directory exists (prisma generate has been run)', () => {
    expect(existsSync(GENERATED_DIR)).toBe(true);
  });
});
