#!/usr/bin/env node

/**
 * Shadow-Database Migration Verification
 *
 * scripts/verify-migrations.ts already does STATIC linting: it regex-scans
 * migration.sql files for risky patterns (DROP, SET NOT NULL, new indexes,
 * new foreign keys) and warns. It never actually runs anything against a
 * real database — its "dry run" is pure text parsing.
 *
 * This script fills that gap: it applies every migration up to a target
 * one against a disposable Postgres database, seeds a row that would
 * violate any NOT NULL constraint the target migration is about to add
 * (exactly the production scenario that constraint would break on), times
 * the migration's actual execution, and reports whether it genuinely
 * succeeds or fails — an empirical result, not a lint guess.
 *
 * Requires a reachable, DISPOSABLE Postgres server via SHADOW_DATABASE_URL
 * (preferred) or DATABASE_URL. This script creates its own throwaway
 * database on that server for each migration it checks and drops it
 * afterwards, so it never touches any existing database/tables on that
 * server — but the server itself should still be a throwaway instance
 * (a CI service container, or local docker-compose), not a shared one,
 * since this connects with CREATE DATABASE / DROP DATABASE privileges.
 *
 * Usage:
 *   npx tsx scripts/verify-migrations-shadow.ts [--migration <name>]
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { Client } from 'pg';
import { getMigrations, findAddedNotNullColumns, MIGRATIONS_DIR } from './verify-migrations';

interface NotNullCheck {
  table: string;
  column: string;
  /** true once we've confirmed the migration actually failed because of this seeded NULL row. */
  violated: boolean;
}

interface ShadowResult {
  migrationName: string;
  applied: boolean;
  durationMs: number;
  error: string | null;
  notNullChecks: NotNullCheck[];
}

export function requireBaseUrl(): string {
  const url = process.env.SHADOW_DATABASE_URL || process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      'Set SHADOW_DATABASE_URL (preferred) or DATABASE_URL to a disposable Postgres server before running shadow verification.',
    );
  }
  return url;
}

/** Swaps the database name in a Postgres connection URL, keeping host/port/credentials/query params. */
export function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

async function withClient<T>(connectionString: string, fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/** A safe placeholder value for a generic seeded row, by Postgres data type. */
export function placeholderValueFor(dataType: string): unknown {
  switch (dataType) {
    case 'integer':
    case 'bigint':
    case 'smallint':
    case 'numeric':
    case 'double precision':
    case 'real':
      return 0;
    case 'boolean':
      return false;
    case 'timestamp without time zone':
    case 'timestamp with time zone':
    case 'date':
      return new Date();
    case 'jsonb':
    case 'json':
      return {};
    case 'ARRAY':
      return [];
    default:
      return `shadow-verify-${Math.random().toString(36).slice(2, 10)}`;
  }
}

/**
 * Inserts one row into `table` satisfying every column that's currently
 * NOT NULL with no default (so the insert doesn't violate the schema as it
 * exists *before* the target migration), while leaving every nullable
 * column — including the one the target migration is about to constrain —
 * explicitly NULL. That's the exact row shape a real production table
 * could contain, and the worst case for a new NOT NULL constraint.
 */
async function seedMinimalRow(client: Client, table: string): Promise<void> {
  const { rows: columns } = await client.query<{
    column_name: string;
    data_type: string;
    is_nullable: string;
    column_default: string | null;
  }>(
    `SELECT column_name, data_type, is_nullable, column_default
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1
     ORDER BY ordinal_position`,
    [table],
  );

  if (columns.length === 0) {
    throw new Error(`Table "${table}" does not exist yet at this point in the migration history`);
  }

  const insertColumns: string[] = [];
  const values: unknown[] = [];

  for (const col of columns) {
    if (col.column_default !== null) continue; // e.g. autoincrement/cuid default — let Postgres fill it in
    if (col.is_nullable === 'YES') continue; // deliberately left NULL, including the column under test

    insertColumns.push(`"${col.column_name}"`);
    values.push(placeholderValueFor(col.data_type));
  }

  if (insertColumns.length === 0) {
    await client.query(`INSERT INTO "${table}" DEFAULT VALUES`);
    return;
  }

  const placeholders = values.map((_, i) => `$${i + 1}`);
  await client.query(`INSERT INTO "${table}" (${insertColumns.join(', ')}) VALUES (${placeholders.join(', ')})`, values);
}

async function verifyOneMigration(baseUrl: string, priorMigrations: string[], target: string): Promise<ShadowResult> {
  const shadowDbName = `shadow_verify_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const adminUrl = withDatabase(baseUrl, 'postgres');
  const shadowUrl = withDatabase(baseUrl, shadowDbName);

  await withClient(adminUrl, (admin) => admin.query(`CREATE DATABASE "${shadowDbName}"`));

  const result: ShadowResult = {
    migrationName: target,
    applied: false,
    durationMs: 0,
    error: null,
    notNullChecks: [],
  };

  try {
    await withClient(shadowUrl, async (client) => {
      for (const migrationName of priorMigrations) {
        const sql = readFileSync(join(MIGRATIONS_DIR, migrationName, 'migration.sql'), 'utf-8');
        await client.query(sql);
      }

      const targetSql = readFileSync(join(MIGRATIONS_DIR, target, 'migration.sql'), 'utf-8');
      const addedNotNullColumns = findAddedNotNullColumns(targetSql);

      for (const { table, column } of addedNotNullColumns) {
        try {
          await seedMinimalRow(client, table);
          result.notNullChecks.push({ table, column, violated: false });
        } catch {
          // Table doesn't exist yet at this point in history, or has other
          // NOT NULL columns this generic seeder can't safely satisfy —
          // inconclusive for this column, not a migration failure.
        }
      }

      const start = Date.now();
      try {
        await client.query(targetSql);
        result.durationMs = Date.now() - start;
        result.applied = true;
      } catch (error: any) {
        result.durationMs = Date.now() - start;
        result.error = error?.message ?? String(error);
        for (const check of result.notNullChecks) {
          if (result.error && result.error.includes(check.column)) check.violated = true;
        }
      }
    });
  } finally {
    await withClient(adminUrl, async (admin) => {
      // Postgres refuses DROP DATABASE while sessions are still attached.
      await admin.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
        [shadowDbName],
      );
      await admin.query(`DROP DATABASE IF EXISTS "${shadowDbName}"`);
    });
  }

  return result;
}

// A migration exceeding this against a near-empty shadow database is not
// itself proof of a production-locking problem (a populated table will
// always be slower) — it's a signal to specifically review the migration
// for ACCESS EXCLUSIVE-locking operations (non-CONCURRENT index creation,
// full-table rewrites), which this script cannot fully reproduce: Postgres
// rejects CREATE INDEX CONCURRENTLY inside a transaction block, and Prisma
// migrations run inside one, so this can't empirically confirm concurrent
// index creation would avoid a lock the way it would outside a migration.
const SLOW_MIGRATION_THRESHOLD_MS = 2000;

async function main() {
  const args = process.argv.slice(2);
  const migrationArg = args.find((arg, i) => args[i - 1] === '--migration');

  console.log('🧪 Shadow-Database Migration Verification');
  console.log('==========================================\n');

  const baseUrl = requireBaseUrl();
  const migrations = getMigrations();

  let targets = migrations;
  if (migrationArg) {
    targets = migrations.filter((m) => m.includes(migrationArg));
    if (targets.length === 0) {
      console.error(`❌ Migration not found: ${migrationArg}`);
      process.exit(1);
    }
  }

  let allPassed = true;

  for (const target of targets) {
    const priorMigrations = migrations.slice(0, migrations.indexOf(target));
    console.log(`\n📋 Shadow-verifying: ${target}`);
    console.log(`   Applying ${priorMigrations.length} prior migration(s) first...`);

    const result = await verifyOneMigration(baseUrl, priorMigrations, target);

    if (result.notNullChecks.length > 0) {
      console.log('   Seeded a NULL-column row to empirically test each new NOT NULL constraint:');
      for (const check of result.notNullChecks) {
        console.log(
          `      - ${check.table}.${check.column}: ${
            check.violated
              ? '❌ migration correctly rejected the pre-existing NULL row'
              : 'ℹ️  no violation observed (seeding was inconclusive, or the column had no NULLs to reject)'
          }`,
        );
      }
    }

    if (result.applied) {
      console.log(`   ✅ Applied successfully in ${result.durationMs}ms`);
      if (result.durationMs > SLOW_MIGRATION_THRESHOLD_MS) {
        console.log(
          `   ⚠️  Took over ${SLOW_MIGRATION_THRESHOLD_MS}ms against a near-empty shadow database — review for ACCESS EXCLUSIVE-locking operations before running against a populated production table.`,
        );
      }
    } else {
      const wasExpectedNotNullFailure = result.notNullChecks.some((c) => c.violated);
      if (wasExpectedNotNullFailure) {
        console.log(
          '   ⚠️  Migration failed against seeded data with an existing NULL in a column it makes NOT NULL — this WILL fail in production unless that column is backfilled first.',
        );
      } else {
        console.log(`   ❌ Migration failed unexpectedly: ${result.error}`);
        allPassed = false;
      }
    }
  }

  console.log('\n==========================================');
  if (allPassed) {
    console.log('✅ Shadow verification complete — no unexpected failures.');
  } else {
    console.log('❌ One or more migrations failed shadow verification unexpectedly. Review the errors above.');
    process.exit(1);
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error('❌ Script failed:', error);
    process.exit(1);
  });
}
