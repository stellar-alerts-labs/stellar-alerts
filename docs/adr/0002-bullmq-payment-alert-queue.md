# ADR 0002: BullMQ on Redis for the payment-alert queue and its dead-letter path

- **Status**: Accepted
- **Subsystem**: Queueing
- **Primary code**: `apps/api/src/lib/queue.ts`, `apps/api/src/lib/dead-letter.ts`, `apps/api/prisma/schema.prisma`

## Context

Ingestion (ADR 0001) detects a payment and hands off. The hand-off must not block
the ingestion loop, because a slow or hanging notification provider must not stall
payment detection for every other wallet. The work that follows is fan-out: one
payment may need to reach several webhooks plus Telegram, email, WhatsApp,
Discord, Slack, and push. Each of those can be slow, rate-limited, or down
independently.

The queue therefore has to satisfy several requirements at once:

- Fan out one payment to N destinations without N round trips through ingestion.
- Survive worker restarts without losing or double-sending.
- Bound the blast radius of a failing provider.
- Give operators a way to inspect and replay terminal failures after BullMQ has
  already discarded the job.

## Decision

### BullMQ on Redis, with two queues

`bullmq` is instantiated at module load in `apps/api/src/lib/queue.ts:434-448`:

```ts
alertQueue = new Queue<AlertJobData>("payment-alerts", {
  connection,
  defaultJobOptions: {
    attempts: 5,
    backoff: { type: "exponential", delay: 2000 },
    removeOnComplete: 100,
    removeOnFail: 500,
  },
});

dlqQueue = new Queue<AlertJobData>('payment-alerts-dlq', { connection });
alertQueueEvents = new QueueEvents('payment-alerts', { connection });
```

Retries are BullMQ's own: **5 attempts, exponential backoff from 2s**, giving
roughly 2s, 4s, 8s, 16s. Completed jobs are trimmed to the last 100 and failures
to the last 500, so Redis memory is bounded.

### Producer side: enqueue is best-effort, and falls back to inline dispatch

`enqueuePaymentAlert` is the single producer entry point
(`apps/api/src/lib/queue.ts:769`):

```ts
if (!alertQueue) {
  return processAlertDispatch(data);
}
try {
  const job = await alertQueue.add("dispatch-alert", data, { jobId: `payment-${data.txHash}` });
  return job;
} catch (err: any) {
  return processAlertDispatch(data);
}
```

Two properties follow. The queue is a **latency and isolation optimization, not a
durability requirement** — if Redis is unreachable the alert is still delivered,
just synchronously on the ingestion thread. And the `jobId` of
`payment-${txHash}` means a repeated enqueue for the same transaction maps to the
same job identity, so a re-enqueue within the job's retention window is a no-op
rather than a second job.

The tradeoff is explicit: a Redis outage converts fan-out into blocking work on
the ingestion path, which couples notification latency to payment detection.

### Consumer side: one worker, one processor function

A single `Worker` consumes `payment-alerts` and delegates to
`processAlertDispatch` (`apps/api/src/lib/queue.ts:450`):

```ts
alertWorker = new Worker<AlertJobData>(
  'payment-alerts',
  async (job) => processAlertDispatch(job.data),
  { connection, concurrency: env.ALERT_WORKER_CONCURRENCY },
);
```

`ALERT_WORKER_CONCURRENCY` defaults to 5
(`apps/api/src/config/env.ts:43`). The processor fans out to all channels for one
payment; per-channel isolation comes from the delivery layer, not from separate
queues.

### Terminal failure routes to both a BullMQ DLQ and a Postgres dead-letter

Failure detection listens on `QueueEvents`, not on the Worker's own `failed` event
(`apps/api/src/lib/queue.ts:464`):

```ts
alertQueueEvents.on("failed", async ({ jobId, failedReason }) => {
  const job = await Job.fromId(alertQueue, jobId);
  if (job && job.attemptsMade >= (job.opts.attempts || 5)) {
    await dlqQueue.add("dispatch-alert-failed", job.data, { jobId: `dlq-${jobId}` });
    void persistDeadLetter({ channel: "queue", destination: jobId, ... });
  }
});
```

`QueueEvents` was chosen over a worker-level `failed` handler deliberately. In
BullMQ, `Job.moveToFailed` decides whether to retry *before* publishing any event:
a retry goes to `moveToDelayed` and publishes nothing, and only the terminal branch
calls `moveToFinished`. `QueueEvents` reads the Redis event stream, so it fires
**only on terminal failure**, when `attemptsMade === 5`. A worker-level
`failed` handler fires unconditionally on every processor throw, which would have
produced five dead-letter rows per job. The
`job.attemptsMade >= job.opts.attempts` guard is therefore currently redundant,
but it is load-bearing protection against that refactor.

The same terminal failure is written to two places with different lifetimes:

| Destination | Lifetime | Purpose |
|---|---|---|
| `payment-alerts-dlq` (BullMQ) | until trimmed | mechanical replay |
| `DeadLetter` (Postgres) | durable | operator inspection, replay, suppression |

`DeadLetter` persists the channel, destination, sanitized payload, and error
(`apps/api/src/lib/dead-letter.ts:27`), and `persistDeadLetter` is itself
failure-tolerant — it never throws into the worker loop
(`apps/api/src/lib/dead-letter.ts:57`). `DeadLetterAudit` records operator
`retry`/`suppress` actions against each row.

### Dead-letter capture is deduped when a delivery key is known, never dropped

`apps/api/src/lib/dead-letter.ts:29` returns an existing `pending` row for the
same `deliveryKey` instead of writing a duplicate. When no stable key is known —
as in the queue-level capture, which has only a `jobId` — a new row is always
written, so **bookkeeping is never allowed to silently lose a failure**.

### Provider rate limits are budgeted before dispatch, and fairness is per-wallet

Two independent controls in `apps/api/src/lib/rate-budget.ts`:

- `acquireProviderBudget(provider, maxWaitMs = 1500)` — token bucket per provider,
  awaited before the provider call. Returns `true` immediately when no budget is
  configured for that provider, so unconfigured channels are unaffected.
- `acquireWalletSlot(walletId, maxWaitMs = 1000)` — bounds concurrent dispatches
  per wallet so a single high-volume wallet cannot monopolize worker threads.

`acquireProviderBudget('webhook')` and `acquireProviderBudget('email')` are called
inside the idempotency-gated dispatch closures
(`apps/api/src/lib/queue.ts:601`, `:738`), so budget is spent only on work that
will actually be sent.

### Redis connection supports Sentinel failover

`createRedisConnectionConfig` (`apps/api/src/lib/queue.ts:400`) returns Sentinel
config when `REDIS_SENTINELS` is set, including a `reconnectOnError` hook that
reconnects on `READONLY` so the client follows a promoted master. Non-Sentinel
config uses `lazyConnect` and `maxRetriesPerRequest: null` so BullMQ can manage
reconnection.

### Initialization failure degrades instead of crashing the process

The whole BullMQ setup is wrapped in a `try`/`catch` that logs a warning
(`apps/api/src/lib/queue.ts:489`), leaving `alertQueue` and friends `null`. The
producer checks for `null` and dispatches inline, so the service starts and
notifies even with no queue.

## Tradeoffs

**The queue is not a durability boundary.** Because `enqueuePaymentAlert` falls
back to inline dispatch on any enqueue error, a Redis outage converts fan-out into
blocking work on the ingestion thread. The alternative — failing the payment when
the queue is down — would couple notification infrastructure to ingestion
availability and lose alerts. Liveness was chosen over isolation.

**No per-channel queues.** One job fans out to all channels, so a single slow
provider (e.g. a 10s-hanging webhook) occupies a worker slot for all of them
rather than only its own. Splitting per channel would give better isolation and
per-channel concurrency, at the cost of a fan-out producer and cross-channel
coordination for a payment that hits several channels.

**BullMQ retries and the delivery layer's attempts are separate counters.**
BullMQ counts job attempts; `NotificationDelivery.maxAttempts` and
`NotificationDeliveryAttempt.attempt` count provider attempts within one job
(`apps/api/prisma/schema.prisma:490`, `:523`). They are not unified, so total
provider attempts for one payment can exceed either number in isolation. This is
why the dead-letter table carries a `retryCount`
(`apps/api/prisma/schema.prisma:551`).

**Two dead-letter stores can diverge.** The BullMQ DLQ is trimmed under memory
pressure; the Postgres `DeadLetter` is durable. A job present in one and not the
other is expected, not a bug, and the Postgres row is the operator-facing truth.

**Exponential backoff from 2s is short for a provider outage.** Four retries
complete in about 30 seconds. A provider down for minutes will exhaust all five
attempts and land in the dead-letter table, requiring operator replay rather than
self-healing. The tradeoff is bounded job lifetime versus slower automatic
recovery.

## Known gaps

- **A missing `ALERT_WORKER_CONCURRENCY` can silently disable consumption.**
  The fallback `env` object (`apps/api/src/config/env.ts:120`) omits
  `ALERT_WORKER_CONCURRENCY`, `WATCHER_WALLET_CONCURRENCY`, the
  `PROVIDER_RATE_BUDGET_*` family, `WALLET_BURST_ALLOWANCE`, and the
  `*_TIMEOUT_MS` vars. The `Worker` constructor receives
  `{ concurrency: undefined }`; BullMQ's default merge copies explicit `undefined`
  and its setter throws `concurrency must be a finite number greater than 0`. That
  throw is inside the same `try`, so it is swallowed at `:491` after the Queue and
  QueueEvents are already constructed but before the worker is. The result is a
  `non-null` `alertQueue` that accepts jobs, a `null` `alertWorker` that consumes
  nothing, no `failed` listener, and no cleanup task — jobs accumulate with no
  consumer and no signal. Reachable in development, where
  `env.ts:114-118` does not `process.exit(1)` on a validation failure. Fix is
  `concurrency: env.ALERT_WORKER_CONCURRENCY ?? 5`, plus registering the cleanup
  task and the `failed` listener before constructing the Worker so partial
  initialization is not possible.
- **`failedJobHandler` (`apps/api/src/lib/queue.ts:494`) is dead code.** It is
  never registered. The live path is the `QueueEvents` listener.
- **The delivery lifecycle guards are only partly wired.**
  `validateDeliveryTransition` (`apps/api/src/lib/delivery.ts:49`),
  `markDeliveryFailed` (`apps/api/src/lib/delivery.ts:334`),
  `markDeliverySuppressed` (`apps/api/src/lib/delivery.ts:367`), and
  `getOrCreateDelivery` (`apps/api/src/lib/delivery.ts:182`) are each referenced
  only from `apps/api/src/lib/__tests__/delivery-lifecycle.test.ts`, never from
  production code. `isTerminalDeliveryStatus` is live. The `failed` and
  `exhausted` lifecycle states are therefore never written in production. See
  ADR 0003.
- **Queue depth metrics are hardcoded, not measured.** The HPA scales on
  `stellar_alerts_queue_waiting_jobs` (`k8s/hpa.yaml:21-27`), but the gauge the
  worker publishes does not track real BullMQ depth, so autoscaling does not
  currently respond to a real backlog.
- **The 2s initial backoff applies to all failure causes**, including permanent
  ones like a deleted webhook destination. Permanent failures burn four retries
  before dead-lettering.
