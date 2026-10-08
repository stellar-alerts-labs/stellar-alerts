-- Add materialized views for hourly and daily payment rollups
-- NOTE: This migration creates read-only materialized views and a helper
-- refresh function. Scheduling automated refreshes (pg_cron, TimescaleDB
-- continuous aggregates, or external scheduler) is intentionally left to
-- the DBA/operator because extensions like pg_cron/Timescale require
-- superuser privileges and are environment-specific.

-- Payment hourly rollup: total tx count and total amount per watched wallet
CREATE MATERIALIZED VIEW IF NOT EXISTS "payment_hourly_rollup" AS
SELECT
  "walletId",
  date_trunc('hour', "receivedAt") AT TIME ZONE 'UTC' AS "hour_start",
  count(*)::BIGINT AS tx_count,
  sum("amount")::NUMERIC AS total_amount
FROM "Payment"
GROUP BY "walletId", date_trunc('hour', "receivedAt")
WITH NO DATA;

CREATE INDEX IF NOT EXISTS "payment_hourly_rollup_wallet_hour_idx" ON "payment_hourly_rollup" ("walletId", "hour_start");

-- Payment daily rollup
CREATE MATERIALIZED VIEW IF NOT EXISTS "payment_daily_rollup" AS
SELECT
  "walletId",
  date_trunc('day', "receivedAt") AT TIME ZONE 'UTC' AS "day_start",
  count(*)::BIGINT AS tx_count,
  sum("amount")::NUMERIC AS total_amount
FROM "Payment"
GROUP BY "walletId", date_trunc('day', "receivedAt")
WITH NO DATA;

CREATE INDEX IF NOT EXISTS "payment_daily_rollup_wallet_day_idx" ON "payment_daily_rollup" ("walletId", "day_start");

-- Helper function to refresh rollups. Operators can call this from a DB
-- scheduler to drive hourly/daily refreshes. Using `CONCURRENTLY` would
-- be ideal in production, but it requires unique indexes and non-transactional
-- execution; keep this simple and safe for typical managed DB setups.
CREATE OR REPLACE FUNCTION public.refresh_payment_rollups()
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  REFRESH MATERIALIZED VIEW "payment_hourly_rollup";
  REFRESH MATERIALIZED VIEW "payment_daily_rollup";
END;
$$;

-- Optional: populate immediately on deployment. Operators may prefer to
-- run the refresh after migration in controlled windows; this statement
-- is provided but commented out to avoid long-running migration locks.
-- SELECT public.refresh_payment_rollups();

-- Add a simple view that exposes failure_rate and avg_gas placeholders.
-- These fields are left NULL until ingestion stores failure flags and
-- gas measurements in the primary tables (see docs/DATABASE_ROLLUPS.md).
CREATE OR REPLACE VIEW IF NOT EXISTS "payment_hourly_rollup_enriched" AS
SELECT
  phr.*,
  NULL::NUMERIC AS failure_rate,
  NULL::NUMERIC AS avg_gas_used
FROM "payment_hourly_rollup" phr;
