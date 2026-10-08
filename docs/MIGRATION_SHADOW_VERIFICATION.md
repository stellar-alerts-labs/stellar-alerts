# Prisma Migration Verification Pipeline

Two complementary checks, both runnable locally and both wired into CI
(`.github/workflows/ci.yml`'s `migration-shadow-verification` job):

## 1. Static lint — `scripts/verify-migrations.ts`

```bash
npm run verify:migrations           # fails (exit 1) on structural errors
npm run verify:migrations:dry-run   # same checks, explicitly read-only
```

Regex-scans each `apps/api/prisma/migrations/*/migration.sql` for risky
patterns — `DROP`, `ALTER COLUMN ... SET NOT NULL`, new foreign keys, new
indexes — and reports them as warnings, plus a couple of schema/SQL
consistency sanity checks. **This never executes anything against a real
database** — it's text analysis only, fast enough to run on every commit,
but it can't tell you whether a flagged migration would *actually* fail.

## 2. Shadow-database verification — `scripts/verify-migrations-shadow.ts`

```bash
SHADOW_DATABASE_URL="postgresql://user:password@localhost:5432/postgres" \
  npm run verify:migrations:shadow
```

This is the empirical half the static lint can't provide, and what this
pipeline was missing before: for each migration, it

1. Creates a throwaway database on the given Postgres server (`CREATE DATABASE shadow_verify_<timestamp>`).
2. Applies every prior migration against it, to reach the real "before" schema state.
3. For every column the migration under test adds a `NOT NULL` constraint
   to (`findAddedNotNullColumns`, extracted from the migration SQL), seeds
   one row that satisfies the *current* schema but leaves that column
   `NULL` — the exact row shape that would make the constraint fail in
   production.
4. Applies the migration itself, timing it, and reports whether it
   genuinely succeeds or fails — not a lint guess.
5. Drops the throwaway database.

A migration that fails *because* of a seeded NULL row is reported as an
expected, valuable finding (⚠️, not ❌) — it proves the migration needs a
backfill step first. An *unexpected* failure (schema drift, a genuine SQL
error) fails the script (exit 1), which is what CI gates on.

**Requires a disposable Postgres server** (`SHADOW_DATABASE_URL`, falling
back to `DATABASE_URL`) with `CREATE DATABASE`/`DROP DATABASE` privileges —
CI's dedicated `migration-shadow-verification` job service container, or a
local `docker compose up -d postgres`. It only ever creates/drops its own
throwaway databases, never touches tables on an existing database on that
server, but the server itself should still be a throwaway instance (a CI
service container, not a shared/production one), since the credentials
used need admin-level `CREATE`/`DROP DATABASE` rights.

### What this does *not* verify

Postgres rejects `CREATE INDEX CONCURRENTLY` inside a transaction block,
and Prisma applies each migration inside one — so this script can't
empirically prove a non-concurrent index creation would (or wouldn't) take
a long-held lock on a populated production table the way `CONCURRENTLY`
avoids. A migration that runs slowly against the near-empty shadow database
(over the `SLOW_MIGRATION_THRESHOLD_MS` in `verify-migrations-shadow.ts`)
is flagged for manual review of its locking behavior, rather than treated
as a hard pass/fail — that structural detection (unqualified `CREATE INDEX`) still comes from the static lint above.

## Compatibility

Purely additive tooling: two new scripts, one new CI job, two small
exports added to `verify-migrations.ts` (`getMigrations`,
`findAddedNotNullColumns`) so the shadow script can reuse them instead of
duplicating the migration-listing/regex logic. No application code,
schema, or existing migration changed.
