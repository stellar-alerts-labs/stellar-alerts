## PostgreSQL Continuous Materialized View Pipeline (Hourly/Daily)

This document describes the proposed continuous rollup pipeline implemented
via materialized views and a refresh helper function.

Goals
- Precompute hourly and daily aggregates for: transaction count, total
  amount, failure rates, and average gas used per watched wallet.
- Avoid requiring superuser-only extensions in migrations (pg_cron/Timescale).
- Provide operators with a simple, readable migration and a refresh function
  they can schedule with their preferred tooling.

What was added
- `apps/api/prisma/migrations/20261020000000_add_hourly_daily_rollups/migration.sql`:
  - Creates `payment_hourly_rollup` and `payment_daily_rollup` materialized
    views (created WITH NO DATA to avoid long migration locks).
  - Adds `public.refresh_payment_rollups()` helper function to refresh both
    rollups.
  - Adds `payment_hourly_rollup_enriched` view with `failure_rate` and
    `avg_gas_used` placeholders for future enrichment.

Rollout and compatibility
- The migration is additive and read-only: it creates materialized views
  WITHOUT modifying existing tables or imposing NOT NULL/constraint changes.
- Because rollups are created WITH NO DATA, operators should run the
  `SELECT public.refresh_payment_rollups();` once in a maintenance window
  to populate initial data.
- Scheduling refreshes:
  - Managed Postgres (RDS/Cloud SQL): use the platform's scheduler or an
    external cron worker to call `SELECT public.refresh_payment_rollups();`.
  - Self-hosted Postgres: consider `pg_cron` or TimescaleDB continuous
    aggregates for more efficient incremental maintenance (requires
    superuser and extension install).

Testing strategy
- Unit tests should focus on the SQL logic via an integration test that:
  1. Seeds a small set of `Payment` rows with varying `receivedAt` times.
  2. Calls `SELECT public.refresh_payment_rollups();`.
  3. Asserts that the materialized views contain expected rollup rows.

Next steps
- If failure flags and gas usage metrics are stored in ingestion records,
  extend the rollup queries to compute `failure_rate` and `avg_gas_used`.
- Add automated CI job that runs the focused integration test against a
  test Postgres instance (e.g., via GitHub Actions service containers).
