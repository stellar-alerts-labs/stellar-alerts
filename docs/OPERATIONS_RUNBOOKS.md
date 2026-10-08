# Operations Runbooks: Incidents, Provider Outages & Data Repair (#340)

## Overview

This document is the on-call reference for operating Stellar Alerts in production. It covers the four incident classes that account for the majority of operational pages:

1. **Notification provider outages** (Telegram, WhatsApp, Email/Resend, outbound webhooks)
2. **Redis / BullMQ outages** (standalone and Sentinel deployments)
3. **Stuck or crash-looping workers** (Watcher, Soroban indexer, token analytics, etc.)
4. **Data repair**: migration rollback and duplicate-alert remediation

Each runbook follows the same structure: **Symptoms → Detection → Immediate Mitigation → Recovery → Verification**. Commands assume the repository root as the working directory unless stated otherwise.

---

## Escalation & Severity

| Severity | Definition | Examples | Response |
| :--- | :--- | :--- | :--- |
| **SEV-1** | Alerts are not being ingested or delivered at all | Redis down, watcher frozen, Horizon stream dead | Immediate mitigation; page secondary on-call if unresolved in 15 min |
| **SEV-2** | Degraded delivery or partial outage | One provider down, elevated DLQ growth, elevated retry rate | Mitigate within 1 hour |
| **SEV-3** | Latent data issue, no live user impact | Duplicate deliveries in `NotificationDelivery`, stuck migration on a staging env | Fix during business hours |

Log snippets and dashboards referenced below use the `x-correlation-id` / `traceparent` fields described in `docs/SLO_DASHBOARDS.md`.

---

## Runbook 1: Notification Provider Outage

Covers Telegram (`api.telegram.org`), WhatsApp (`dispatchWhatsAppAlert`), Email (Resend), and subscriber webhooks.

### Symptoms

- `WebhookLog` rows with `error` set and no `statusCode`, or repeated `5xx`/`429` responses.
- `webhook_circuit_breaker` rows transitioning to `state = 'open'`.
- Worker logs show `Failed to dispatch webhook`, `Telegram ... timed out`, or Resend API errors.
- `payment-alerts-dlq` queue depth growing (`Moved failed job to DLQ` warnings).

### Detection

```sql
-- Providers with the most failures in the last hour
SELECT w.url, count(*) AS failures
FROM "WebhookLog" l JOIN "Webhook" w ON w.id = l."webhookId"
WHERE l."createdAt" > now() - interval '1 hour' AND l.error IS NOT NULL
GROUP BY w.url ORDER BY failures DESC LIMIT 20;

-- Open circuit breakers
SELECT "webhookId", state, "failureCount", "openedAt"
FROM "WebhookCircuitBreaker" WHERE state = 'open';
```

Queue depth via BullMQ or redis-cli:

```bash
redis-cli -h "$REDIS_HOST" LLEN bull:payment-alerts:wait
redis-cli -h "$REDIS_HOST" LLEN bull:payment-alerts-dlq:wait
```

### Immediate Mitigation

- **Single webhook endpoint down**: the per-webhook circuit breaker (`CIRCUIT_BREAKER_THRESHOLD = 10` consecutive failures, 60s cooldown) handles this automatically. No action needed unless the endpoint is permanently gone — deactivate it via `PATCH /webhooks/:id` with `isActive: false`.
- **Telegram/WhatsApp/Resend outage**: deliveries fail inside `processAlertDispatch` and are recorded as dead letters. Nothing is lost; suppress noisy retries if the outage is prolonged by scaling the alert worker to 0 or lowering `ALERT_WORKER_CONCURRENCY`.
- **Endpoint rate-limiting (429)**: the adaptive webhook rate limiter backs off per-domain automatically. Do not manually flush the queue — that amplifies the rate limiting.

### Recovery

1. Confirm the provider is healthy (provider status page, or a manual `curl` against the endpoint).
2. Circuit breakers self-heal: after `CIRCUIT_BREAKER_TIMEOUT` (60s) a breaker moves to `half-open` and closes on the first successful dispatch.
3. Replay failed deliveries — see [Runbook 4](#runbook-4-duplicate-alert-repair) for replay mechanics via `POST /dead-letters/:id/replay`. Replays pass through `deliverWithIdempotency`, so deliveries that actually succeeded during a flaky window will **not** be re-sent.

### Verification

```sql
SELECT count(*) FROM "WebhookLog"
WHERE "createdAt" > now() - interval '10 minutes' AND error IS NULL;
```

Success logs should resume and DLQ depth should stop growing.

---

## Runbook 2: Redis / BullMQ Outage

Redis backs the `payment-alerts` queue, `payment-alerts-dlq`, `QueueEvents`, rate limiting, and realtime pub/sub.

### Symptoms

- API logs: `Could not initialize BullMQ queue` at boot, or `ECONNREFUSED`/`READONLY`/`MaxRetriesPerRequestError` at runtime.
- Payments are ingested (DB writes succeed) but no alerts are dispatched — the gap between `Payment.receivedAt` and `WebhookLog.createdAt` grows.
- Workers log reconnect attempts every ~100–3000 ms (`retryStrategy` backoff).

### Detection

```bash
redis-cli -h "$REDIS_HOST" -p "$REDIS_PORT" PING   # expect PONG
redis-cli -h "$REDIS_HOST" INFO replication         # check role & master link
# Sentinel deployments:
redis-cli -h "$SENTINEL_HOST" -p 26379 SENTINEL get-master-addr-by-name mymaster
```

### Immediate Mitigation

- **Standalone Redis down**: restart the Redis process/container (`docker compose up -d redis`). The API and workers survive a Redis outage — BullMQ connections use `maxRetriesPerRequest: null` and will keep retrying — but no queue work proceeds until Redis returns.
- **Sentinel failover in progress**: a `READONLY` error is expected and handled (`reconnectOnError` triggers a reconnect to the new master). If the app does not recover within ~60s, restart the API/worker pods so connections re-resolve through Sentinel.
- **Redis losing data (AOF/RDB loss or flush)**: enqueued-but-undelivered alert jobs are gone, but every ingested `Payment` is durable in Postgres. After Redis is healthy, re-enqueue affected jobs (see Recovery).

### Recovery

1. Restore Redis and verify `PING` / `INFO replication` shows a healthy master.
2. Restart the API and worker processes to clear poisoned connections if they did not self-heal.
3. Re-enqueue alerts that were queued during the outage and lost. Jobs are idempotent on replay — `deliverWithIdempotency` dedupes on `paymentId:channel:destination`, so re-adding a payment that already delivered produces no duplicate notification.

```sql
-- Payments ingested while Redis was down with no delivery records
SELECT p.id, p."txHash", p."walletId"
FROM "Payment" p
LEFT JOIN "NotificationDelivery" d ON d."paymentId" = p.id
WHERE p."receivedAt" BETWEEN :outage_start AND :outage_end
  AND d.id IS NULL;
```

4. For each missing payment, re-enqueue an `AlertJobData` job onto `payment-alerts` (or replay via the dead-letters API if dead letters were persisted).

### Verification

- `redis-cli LLEN bull:payment-alerts:wait` drains to ~0.
- New `WebhookLog` rows appear with `statusCode` 2xx.
- No `Could not initialize BullMQ queue` in the last 15 minutes of logs.

---

## Runbook 3: Stuck or Crash-Looping Workers

Workers run as forked child processes under `WorkerSupervisor` (`apps/api/src/workers/supervisor.ts`). The supervisor pings each child every 10s and SIGKILLs it if it misses a 10s pong window; exits are restarted after a 1s delay.

### Symptoms

- Supervisor logs: `missed its heartbeat and appears frozen`, or repeated `exited — code=1 ... Restart #N scheduled`.
- Ingestion stalls: `Payment.receivedAt` stops advancing, or `IngestionCursor` does not move.
- Soroban indexer / staking-reward / SAC workers stopped producing output while the API is healthy.

### Detection

```bash
# Child PIDs and restart counts are logged by the supervisor.
# From the host:
ps -o pid,ppid,etime,cmd -C node | grep worker
```

Check the ingestion cursor lag directly:

```sql
SELECT * FROM "IngestionCursor" ORDER BY "updatedAt" DESC;
```

### Immediate Mitigation

- **Frozen worker**: the supervisor usually handles this. If a worker is alive but doing no work (heartbeat responds, no progress — e.g. deadlocked on a lock), kill the child PID manually; the supervisor respawns it in ~1s:

  ```bash
  kill -SIGKILL <worker_pid>
  ```

- **Crash loop** (`restartCount` climbing): do not keep restarting blindly. Pull the child's stderr — common causes are missing env vars (`env` validation throws at boot), DB connectivity, or an expired Horizon cursor. Fix the root cause before the next restart.
- **Supervisor itself wedged**: restart the supervisor process (`npm run dev:worker` / the worker container). Its children are killed with SIGTERM on shutdown via `stopAll()`.

### Recovery

1. After the worker restarts, confirm it resumes from the persisted `IngestionCursor` — ingestion is resumable and will backfill missed ledgers rather than skip them.
2. For Soroban gaps, the `soroban-backfill` worker can be run to re-scan a ledger range.
3. If a worker repeatedly freezes under memory pressure, check `MemoryMonitor` logs — workers run with `--expose-gc` and will request a restart instead of leaking indefinitely.

### Verification

- Supervisor logs show a stable child PID with no restarts for >10 minutes.
- `IngestionCursor.updatedAt` advances within the expected poll interval.
- New payments appear end-to-end (ingest → queue → `WebhookLog`).

---

## Runbook 4: Duplicate-Alert Repair

Duplicate alerts can occur after an uncontrolled replay, a queue flush during partial delivery, or a bug bypassing the idempotency gate.

### Background

Every channel dispatch goes through `deliverWithIdempotency` (`apps/api/src/lib/delivery.ts`), keyed by `deliveryKey = sha256(paymentId:channel:destination)`. `NotificationDelivery` enforces uniqueness on both `deliveryKey` and `(paymentId, channel, destination)` at the database level, and terminal states (`delivered`, `exhausted`, `suppressed`, `skipped`) reject further attempts. A true duplicate therefore means either the gate was bypassed or two distinct `destination` values mapped to the same real endpoint.

### Symptoms

- User reports receiving the same payment alert twice (or more).
- Multiple `WebhookLog` 2xx rows for the same webhook + payment within seconds.
- `NotificationDelivery` rows in `delivered` for the same payment across two `destination` values that are effectively the same endpoint.

### Detection

```sql
-- Deliveries grouped by payment/channel with more than one delivered record
SELECT "paymentId", channel, count(*) AS delivered_count
FROM "NotificationDelivery"
WHERE status = 'delivered'
GROUP BY "paymentId", channel
HAVING count(*) > 1;

-- Webhook-level view: same webhook, same payment, multiple successes
SELECT l."webhookId", d."paymentId", count(*)
FROM "WebhookLog" l
JOIN "NotificationDelivery" d ON d.destination = l."webhookId"
WHERE l."statusCode" BETWEEN 200 AND 299
GROUP BY l."webhookId", d."paymentId"
HAVING count(*) > 1;
```

### Repair Steps

1. **Freeze the source**: if duplicates are still being produced, stop the alert worker or drop `ALERT_WORKER_CONCURRENCY` to 1 while investigating. Do not purge `payment-alerts` — pending jobs will be lost.
2. **Identify scope**: run the queries above to enumerate affected `(paymentId, channel)` pairs.
3. **Suppress stray deliveries**: for any delivery still in a non-terminal state that should not retry, mark it `suppressed` — either via `POST /dead-letters/:id/suppress` for captured dead letters, or via `markDeliverySuppressed` in a one-off script.
4. **Root-cause the bypass**: check for code paths that call `dispatchWebhookAndLog` (or Telegram/WhatsApp/Email sends) directly instead of through `deliverWithIdempotency`. Direct calls are only acceptable inside an idempotency wrapper.
5. **Duplicate destinations**: if two `Webhook` rows point at the same URL, deactivate or delete the redundant one; the delivery gate treats distinct webhook IDs as distinct destinations by design.
6. **User communication**: for confirmed duplicate sends, note the `paymentId` and channel in the incident record; no data deletion is required since each `WebhookLog` accurately reflects a real HTTP dispatch.

### Verification

```sql
SELECT count(*) FROM "NotificationDelivery" d
WHERE d.status = 'delivered'
GROUP BY d."paymentId", d.channel
HAVING count(*) > 1;
```

Returns zero rows (or only rows corresponding to legitimately distinct destinations). New deliveries produce exactly one `delivered` row per `(paymentId, channel, destination)`.

---

## Runbook 5: Migration Rollback

Prisma migrations live in `apps/api/prisma/migrations` and are applied with `npm run db:migrate`. `scripts/verify-migrations.ts` (`npm run verify:migrations`, `--dry-run` available) validates migration integrity before deployment.

### Symptoms

- Deploy fails with `P3009`/`P3018` (failed migration recorded) or schema drift errors.
- A migration applied but the app errors on the new/changed columns.
- `prisma migrate status` shows a migration as `failed` or `pending` unexpectedly.

### Immediate Mitigation

- **Failed migration blocking deploys**: mark it resolved after manually fixing or reverting the partial DDL:

  ```bash
  cd apps/api
  npx prisma migrate resolve --rolled-back "<migration_name>"
  ```

- **Bad migration already applied in production**: Prisma does not auto-down-migrate. Roll back by applying a *forward* corrective migration rather than editing the applied one. For urgent mitigation, revert to the previous app release — the codebase should be compatible with at least the previous schema version (additive changes preferred for exactly this reason).

### Rollback Procedure

1. Snapshot first: `pg_dump -Fc "$DATABASE_URL" > pre-rollback-$(date +%F).dump`.
2. Identify the offending migration: `npx prisma migrate status`.
3. If it failed mid-flight, resolve it as rolled back (above), fix the SQL in the migration directory, then `npx prisma migrate deploy` again.
4. If it succeeded but must be undone, write a new migration that reverses it (`DROP`/`ALTER` back), and deploy normally. Never edit a migration that has already been applied to any shared environment — Prisma checksums them (`migration_lock.toml` also pins the provider).
5. If manual SQL was used to repair a partial failure, reconcile with `npx prisma migrate resolve --applied "<migration_name>"` once the database matches the migration's intended end state.

### Verification

```bash
npm run verify:migrations          # integrity check
cd apps/api && npx prisma migrate status   # all migrations applied, none failed
npm run test --workspace=api       # schema-dependent suites pass
```

App health endpoint returns 200 and ingestion resumes.

---

## Appendix: Useful Commands

| Task | Command |
| :--- | :--- |
| Queue depth | `redis-cli LLEN bull:payment-alerts:wait` |
| DLQ depth | `redis-cli LLEN bull:payment-alerts-dlq:wait` |
| List dead letters | `GET /dead-letters` (authenticated) |
| Replay a dead letter | `POST /dead-letters/:id/replay` |
| Suppress a dead letter | `POST /dead-letters/:id/suppress` |
| Migration status | `cd apps/api && npx prisma migrate status` |
| Verify migrations | `npm run verify:migrations` |
| API tests | `npm run test:api` |

All queue names, thresholds, and timeouts referenced above are defined in `apps/api/src/lib/queue.ts`; worker lifecycle behavior is in `apps/api/src/workers/supervisor.ts`; delivery idempotency and lifecycle rules are in `apps/api/src/lib/delivery.ts` and `docs/DELIVERY_LIFECYCLE.md`.
