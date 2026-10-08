#!/usr/bin/env tsx
/**
 * scripts/check-prisma-drift.ts
 *
 * Detects stale or invalid Prisma state without requiring a live database
 * connection.  Designed to run in CI on every PR.
 *
 * Checks performed:
 *   1. Migration lock provider consistency — migration_lock.toml must declare
 *      the same provider as schema.prisma's datasource block.
 *   2. Migration ordering — every migration directory name must begin with a
 *      valid ISO-8601-like timestamp (YYYYMMDDHHMMSS) and the list must be
 *      strictly ascending; gaps are allowed but regressions (a later directory
 *      with an earlier timestamp) are not.
 *   3. Migration SQL presence — every migration directory must contain a
 *      non-empty migration.sql file.
 *   4. Generated client freshness — the generated Prisma client directory
 *      (generated/prisma/) must exist.  If it is missing the schema has been
 *      edited but `prisma generate` has not been re-run.
 *   5. Schema parse — `prisma validate` is executed against the schema to
 *      catch syntax errors and invalid model definitions early.
 *
 * Exit codes:
 *   0  — all checks passed
 *   1  — one or more checks failed (details printed to stderr)
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { resolve, join } from 'path';
import { execSync } from 'child_process';

// ── Paths ──────────────────────────────────────────────────────────────────
const API_ROOT = resolve(__dirname, '../apps/api');
const SCHEMA_PATH = join(API_ROOT, 'prisma/schema.prisma');
const MIGRATIONS_DIR = join(API_ROOT, 'prisma/migrations');
const LOCK_FILE = join(API_ROOT, 'prisma/migrations/migration_lock.toml');
const GENERATED_DIR = join(API_ROOT, 'generated/prisma');

// ── Helpers ────────────────────────────────────────────────────────────────
const errors: string[] = [];

function fail(msg: string): void {
  errors.push(msg);
}

function pass(msg: string): void {
  console.log(`  ✅  ${msg}`);
}

// ── Check 1: Schema file exists ────────────────────────────────────────────
console.log('\n🔍 Prisma drift detection\n');
console.log('── Check 1: Schema file exists');
if (!existsSync(SCHEMA_PATH)) {
  fail(`schema.prisma not found at ${SCHEMA_PATH}`);
} else {
  pass('schema.prisma found');
}

// ── Check 2: Migration lock provider consistency ───────────────────────────
console.log('── Check 2: Migration lock provider consistency');
if (!existsSync(LOCK_FILE)) {
  fail(`migration_lock.toml not found at ${LOCK_FILE}`);
} else {
  const lockContent = readFileSync(LOCK_FILE, 'utf-8');
  const lockMatch = lockContent.match(/provider\s*=\s*"([^"]+)"/);
  const lockProvider = lockMatch?.[1];

  const schemaContent = readFileSync(SCHEMA_PATH, 'utf-8');
  // Match:  datasource db { provider = "postgresql" }
  const schemaMatch = schemaContent.match(/datasource\s+\w+\s*\{[^}]*provider\s*=\s*"([^"]+)"/s);
  const schemaProvider = schemaMatch?.[1];

  if (!lockProvider) {
    fail('Could not parse provider from migration_lock.toml');
  } else if (!schemaProvider) {
    fail('Could not parse datasource provider from schema.prisma');
  } else if (lockProvider !== schemaProvider) {
    fail(
      `Provider mismatch: migration_lock.toml says "${lockProvider}" but schema.prisma says "${schemaProvider}". ` +
        'Run `prisma migrate dev` to reconcile.',
    );
  } else {
    pass(`Providers match: "${lockProvider}"`);
  }
}

// ── Check 3: Migration ordering ────────────────────────────────────────────
console.log('── Check 3: Migration ordering and SQL presence');
const MIGRATION_NAME_RE = /^(\d{14})_.+/;

if (!existsSync(MIGRATIONS_DIR)) {
  fail(`migrations directory not found at ${MIGRATIONS_DIR}`);
} else {
  const entries = readdirSync(MIGRATIONS_DIR)
    .filter((name) => {
      // Skip the lock file entry (it is a file, not a directory).
      const fullPath = join(MIGRATIONS_DIR, name);
      return statSync(fullPath).isDirectory();
    })
    .sort(); // lexicographic sort aligns with timestamp-prefixed names

  if (entries.length === 0) {
    fail('No migration directories found — expected at least one migration');
  } else {
    let lastTimestamp = '';

    for (const entry of entries) {
      const match = entry.match(MIGRATION_NAME_RE);
      if (!match) {
        fail(
          `Migration directory "${entry}" does not follow the YYYYMMDDHHMMSS_name convention`,
        );
        continue;
      }

      const ts = match[1];

      // Ordering: timestamps must be strictly non-decreasing.
      if (ts < lastTimestamp) {
        fail(
          `Migration directory "${entry}" has timestamp ${ts} which is earlier than the ` +
            `previous migration timestamp ${lastTimestamp} — migrations must be ordered ascending`,
        );
      }
      lastTimestamp = ts;

      // SQL presence.
      const sqlPath = join(MIGRATIONS_DIR, entry, 'migration.sql');
      if (!existsSync(sqlPath)) {
        fail(`Migration "${entry}" is missing migration.sql`);
      } else {
        const sqlSize = statSync(sqlPath).size;
        if (sqlSize === 0) {
          fail(`Migration "${entry}/migration.sql" is empty`);
        }
      }
    }

    if (errors.length === 0 || !errors.some((e) => e.includes('Migration'))) {
      pass(`${entries.length} migration(s) validated — ordering and SQL presence OK`);
    }
  }
}

// ── Check 4: Generated client directory exists ────────────────────────────
console.log('── Check 4: Generated Prisma client');
if (!existsSync(GENERATED_DIR)) {
  fail(
    `Generated Prisma client directory not found at ${GENERATED_DIR}. ` +
      'Run `prisma generate` and commit the result, or add the directory to version control.',
  );
} else {
  pass('Generated Prisma client directory found');
}

// ── Check 5: Schema validation via prisma validate ───────────────────────
console.log('── Check 5: Schema validation (prisma validate)');
try {
  // `prisma validate` exits 0 on success, non-zero on schema errors.
  // We suppress stdout because it is verbose; only errors matter.
  execSync('npx prisma validate --schema=prisma/schema.prisma', {
    cwd: API_ROOT,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  pass('prisma validate passed');
} catch (err: any) {
  const stderr: string = err.stderr?.toString() ?? '';
  fail(`prisma validate failed:\n${stderr.trim()}`);
}

// ── Result ─────────────────────────────────────────────────────────────────
console.log('');
if (errors.length > 0) {
  console.error('❌ Prisma drift check FAILED:\n');
  errors.forEach((e) => console.error(`   • ${e}`));
  console.error('');
  process.exit(1);
} else {
  console.log('✅ All Prisma drift checks passed.\n');
  process.exit(0);
}
