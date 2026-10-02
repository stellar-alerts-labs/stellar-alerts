import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../generated/prisma/client';
import { isPostgresAvailable } from './test-infra';

/**
 * Postgres integration fixtures.
 *
 * Strategy for parallel-safe, disposable test databases:
 * - Every worker/fork provisions its own private database on the shared test
 *   Postgres server, cloned from a template database via
 *   `CREATE DATABASE ... TEMPLATE` (vanilla Postgres feature), so parallel
 *   forks never share rows, sequences, or locks.
 * - One fork pays a one-time cost to replay the full Prisma migration history
 *   into the template database; the replay is guarded by a Postgres advisory
 *   lock so concurrent forks serialize instead of racing.
 * - The template is fingerprinted against the contents of
 *   `prisma/migrations`, so a stale template (schema changes between runs) is
 *   detected and rebuilt automatically.
 * - Between tests the fork's tables are truncated in one statement with
 *   deterministic identity restarts, so each test starts from the same state.
 * - On teardown the fork's database is dropped (`WITH (FORCE)` on PG 13+):
 *   nothing disposable survives the run.
 *
 * Set STELLAR_ALERTS_IT=0 (or skip the `test:integration` script) to keep
 * unit-only runs completely unaffected.
 */

export const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ??
  'postgresql://postgres:postgrespassword@localhost:5432/stellar_alerts_test';

const ADVISORY_LOCK_KEY = 918_273_645_918;

/** Postgres identifier length cap (63 bytes). */
function safeIdent(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9_]/g, '_').slice(-40);
}

function forkSlug(): string {
  if (process.env.VITEST_POOL_ID) return safeIdent(`w${process.env.VITEST_POOL_ID}`);
  if (process.env.VITEST_WORKER_ID) return safeIdent(`w${process.env.VITEST_WORKER_ID}`);
  if (process.env.JEST_WORKER_ID) return safeIdent(`w${process.env.JEST_WORKER_ID}`);
  return safeIdent(`p${process.pid}`);
}

function baseUrl(): URL {
  return new URL(TEST_DB_URL);
}

function urlForDatabase(databaseName: string): string {
  const url = baseUrl();
  url.pathname = `/${databaseName}`;
  url.search = '';
  return url.toString();
}

/** URL of the `postgres` maintenance database on the same server. */
function maintenanceUrl(): string {
  return urlForDatabase('postgres');
}

function baseDatabaseName(): string {
  const name = baseUrl().pathname.replace(/^\//, '');
  if (!name || name === 'postgres') {
    throw new Error('TEST_DATABASE_URL must name a non-maintenance database');
  }
  return name;
}

function templateDatabaseName(): string {
  return safeIdent(`${baseDatabaseName()}_template`).slice(0, 63);
}

function prismaRoot(): string {
  return path.resolve(__dirname, '../..');
}

/** Stable fingerprint of the migration history for template staleness checks. */
function migrationsFingerprint(): string {
  const migrationsDir = path.join(prismaRoot(), 'prisma', 'migrations');
  const entries = existsSync(migrationsDir) ? readdirSync(migrationsDir).sort() : [];
  const hash = createHash('sha256');
  for (const entry of entries) {
    const sqlPath = path.join(migrationsDir, entry, 'migration.sql');
    if (existsSync(sqlPath)) {
      hash.update(entry);
      hash.update(readFileSync(sqlPath));
    }
  }
  return hash.digest('hex');
}

/** Best-effort Prisma migration replay against one database. */
async function replayMigrations(databaseName: string): Promise<void> {
  const { execFileSync } = (await import('node:child_process')) as typeof import('node:child_process');

  const apiRoot = prismaRoot();
  const repoRoot = path.resolve(apiRoot, '../..');
  const candidates = [
    path.join(apiRoot, 'node_modules', 'prisma', 'build', 'index.js'),
    path.join(repoRoot, 'node_modules', 'prisma', 'build', 'index.js'),
  ];
  const prismaBin = candidates.find((candidate) => existsSync(candidate));
  if (!prismaBin) {
    throw new Error(
      `Could not locate the prisma CLI (looked in ${candidates.join(', ')}). Run \`npm install\` first.`,
    );
  }

  execFileSync(
    process.execPath,
    [prismaBin, 'migrate', 'deploy', '--schema', 'prisma/schema.prisma'],
    {
      cwd: apiRoot,
      env: { ...process.env, DATABASE_URL: urlForDatabase(databaseName) },
      stdio: 'pipe',
    },
  );
}

async function databaseExists(admin: PrismaClient, name: string): Promise<boolean> {
  const rows = await admin.$queryRawUnsafe<Array<{ datname: string }>>(
    'SELECT datname FROM pg_database WHERE datname = $1',
    name,
  );
  return rows.length > 0;
}

async function createDatabase(admin: PrismaClient, name: string, template?: string): Promise<void> {
  const templateClause = template ? ` TEMPLATE "${template}"` : '';
  await admin.$executeRawUnsafe(`CREATE DATABASE "${name}"${templateClause}`);
}

async function dropDatabase(admin: PrismaClient, name: string): Promise<void> {
  // WITH (FORCE) (PG 13+) drops even with lingering connections; older
  // servers fall back to the plain form.
  try {
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  } catch {
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}"`);
  }
}

function adminClient(url: string, max = 3): PrismaClient {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString: url, max }) });
}
/**
 * Ensure the template database exists and matches the current migration
 * history. Callers hold the advisory lock while this runs.
 */
async function ensureTemplate(maintenance: PrismaClient): Promise<string> {
  const template = templateDatabaseName();
  let templateDb = adminClient(urlForDatabase(template), 1);
  try {
    const fingerprint = migrationsFingerprint();

    const fresh = !(await databaseExists(maintenance, template));
    if (fresh) {
      await createDatabase(maintenance, template);
      templateDb = adminClient(urlForDatabase(template), 1);
    }

    const tableRows = await templateDb.$queryRawUnsafe<Array<{ tablename: string }>>(
      `SELECT tablename FROM pg_tables
       WHERE schemaname NOT IN ('pg_catalog', 'information_schema') LIMIT 1`,
    );
    const markerRows = await templateDb
      .$queryRawUnsafe<Array<{ value: string }>>(
        `SELECT value FROM template_meta WHERE key = 'fingerprint'`,
      )
      .catch(() => [] as Array<{ value: string }>);

    const stale =
      tableRows.length === 0 || markerRows.length === 0 || markerRows[0].value !== fingerprint;
    if (stale) {
      await templateDb.$disconnect().catch(() => undefined);
      await dropDatabase(maintenance, template);
      await createDatabase(maintenance, template);
      await replayMigrations(template);

      templateDb = adminClient(urlForDatabase(template), 1);
      await templateDb.$executeRawUnsafe(
        `CREATE TABLE IF NOT EXISTS template_meta (key text PRIMARY KEY, value text)`,
      );
      await templateDb.$executeRawUnsafe(
        `INSERT INTO template_meta (key, value) VALUES ('fingerprint', $1)
         ON CONFLICT (key) DO UPDATE SET value = $1`,
        fingerprint,
      );
    }

    return template;
  } finally {
    await templateDb.$disconnect().catch(() => undefined);
  }
}

export interface PostgresFixture {
  /** Prisma client bound to this fork's private database. */
  db: PrismaClient;
  /** Private database name (one per worker/fork). */
  database: string;
  /** Truncate every table in the database; deterministic state between tests. */
  reset: () => Promise<void>;
  /** Disconnect and drop the database. */
  teardown: () => Promise<void>;
}

export async function createPostgresFixture(): Promise<PostgresFixture> {
  if (!(await isPostgresAvailable(TEST_DB_URL))) {
    throw new Error(
      `Integration fixtures need Postgres at ${baseUrl().host} (start docker compose or set TEST_DATABASE_URL)`,
    );
  }

  const maintenance = adminClient(maintenanceUrl());
  // Advisory locks are session-scoped: with a pooled client, unlock could land
  // on a different connection than lock and leak the lock. A max=1 client pins
  // every statement to one session.
  const lockClient = adminClient(maintenanceUrl(), 1);
  const forkDatabase = safeIdent(`${baseDatabaseName()}_it_${forkSlug()}_${randomUUID().slice(0, 8)}`)
    .slice(0, 63);

  // Serialize template creation and cloning across all parallel forks via a
  // session-level advisory lock on the maintenance database.
  await lockClient.$executeRawUnsafe('SELECT pg_advisory_lock($1)', ADVISORY_LOCK_KEY);
  try {
    const template = await ensureTemplate(maintenance);
    await createDatabase(maintenance, forkDatabase, template);
  } finally {
    await lockClient.$executeRawUnsafe('SELECT pg_advisory_unlock($1)', ADVISORY_LOCK_KEY);
    await lockClient.$disconnect().catch(() => undefined);
  }

  const forkUrl = new URL(TEST_DB_URL);
  forkUrl.pathname = `/${forkDatabase}`;

  const db = new PrismaClient({
    adapter: new PrismaPg({ connectionString: forkUrl.toString(), max: 5 }),
  });
  await db.$connect();

  return {
    db,
    database: forkDatabase,
    async reset() {
      await db.$executeRawUnsafe(`
        DO $$
        DECLARE
          qualified text;
        BEGIN
          FOR qualified IN
            SELECT quote_ident(schemaname) || '.' || quote_ident(tablename)
            FROM pg_tables
            WHERE schemaname NOT IN ('pg_catalog', 'information_schema')
          LOOP
            EXECUTE 'TRUNCATE TABLE ' || qualified || ' RESTART IDENTITY CASCADE';
          END LOOP;
        END $$;
      `);
    },
    async teardown() {
      await db.$disconnect().catch(() => undefined);
      await dropDatabase(maintenance, forkDatabase).catch(() => undefined);
      await maintenance.$disconnect().catch(() => undefined);
    },
  };
}
