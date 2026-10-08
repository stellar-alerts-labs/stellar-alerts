# ADR 0001: Horizon paging-token cursors with bounded backfill for on-chain ingestion

- **Status**: Accepted
- **Subsystem**: Ingestion
- **Primary code**: `apps/api/src/workers/watcher.worker.ts`, `apps/api/src/lib/cursor-recovery.ts`, `apps/api/src/lib/stellar.ts`

## Context

Stellar Alerts must notice payments to watched wallets promptly and exactly once.
The sources are heterogeneous: Horizon's payments endpoint returns a mix of
`payment`, `create_account`, and SAC token transfer operations; a second path
consumes the Horizon SSE stream for low-latency delivery; a third watches Soroban
contracts. All of them converge on the same requirement: if the worker is down,
restarts, or reconnects, it must resume without replaying a storm of duplicates
and without silently skipping payments.

Two failure modes are being defended against simultaneously:

- **Duplicates.** The SSE stream and the poll loop run concurrently against the
  same wallet. A payment can arrive on both paths, or twice on the same path
  after a reconnect.
- **Gaps.** A cursor that resumes from the wrong position, or a Horizon node that
  skips records for an account, leaves a hole in the payment history. A silently
  truncated history is worse than a late one, because the user cannot tell.

## Decision

### A durable per-wallet paging token is the single source of ingestion position

Each wallet's progress is one `IngestionCursor` row holding a Horizon paging
token. `ensureCursor` creates it on first sight, seeded from the wallet's latest
Horizon activity:

`apps/api/src/workers/watcher.worker.ts:363`

Paging tokens are opaque to the worker. Gap detection decodes them for ledger
comparison but never constructs or rewrites one.

### The token is opaque, but its ledger sequence is decoded for gap detection

A Horizon TOID packs `ledger_seq << 32 | tx_order << 12 | op_order`, so the
ledger is recoverable with a shift:

`apps/api/src/lib/cursor-recovery.ts:32`

```ts
const value = BigInt(pagingToken);
if (value <= 0n) return null;
return Number(value >> 32n);
```

`detectLedgerGap` compares consecutive tokens for the same wallet and flags a
jump larger than `DEFAULT_MAX_LEDGER_JUMP = 5` ledgers
(`apps/api/src/lib/cursor-recovery.ts:25`, `:53`). A missing or undecodable
previous token — the first record for a wallet — is explicitly not a gap:

```ts
if (previousLedger === null || nextLedger === null) {
  return { hasGap: false, ledgerDelta: 0 };
}
```

A small jump is normal, because a quiet wallet spans many ledgers between
payments. A large jump means records were skipped.

### Gap recovery is bounded, not exhaustive

A detected gap triggers a replay of at most the `BOUNDED_BACKFILL_LIMIT = 200`
most recent records:

`apps/api/src/lib/cursor-recovery.ts:16`

The comment states the reasoning plainly: this recovers what Horizon's recent
window still holds, logs the gap, and moves on rather than stalling ingestion. A
gap larger than 200 records is **not** fully recovered and is recorded as
`status: 'gap_detected'` with `lastGapLedgerDelta` so an operator can see it.

### Catch-up is bounded per poll, resumable across polls

Polling walks at most `MAX_CATCHUP_PAGES = 20` pages of
`CURSOR_PAGE_SIZE = 50` records per wallet per pass:

`apps/api/src/workers/watcher.worker.ts:271`, `:275`

When the limit is hit the cursor is not rewound; the next poll resumes from where
this one stopped. A long outage is therefore recovered gradually across many
polls instead of stalling one pass indefinitely.

### Provider outage is distinguished from "caught up"

`getPaymentsSinceResult` returns an explicit `allNodesFailed` flag rather than
an empty record list, because an empty list from an unreachable provider is
indistinguishable from a quiet wallet:

`apps/api/src/lib/stellar.ts:331`

On a total outage the cursor position is left **untouched** and only health
metadata is written:

`apps/api/src/workers/watcher.worker.ts:401`

```ts
if (result.allNodesFailed) {
  const currentCursor = await prisma.ingestionCursor.findUnique({ where: { walletId: wallet.id } });
  await prisma.ingestionCursor.update({
    where: { walletId: wallet.id },
    data: buildCursorOutageUpdate(result.lastError || 'All Horizon nodes unreachable', currentCursor?.consecutiveFailures ?? 0),
  });
  return;
}
```

This is the key asymmetry: **on outage the cursor does not advance, so no data is
lost.** The next poll retries from the same point.

Horizon reads fail over across a configured node list within a single call, under
`withDeadline` with `env.HORIZON_REQUEST_TIMEOUT_MS`
(`apps/api/src/lib/stellar.ts:352`).

### Exactly-once is enforced by a unique key, not by locking

`processPaymentRecord` normalizes a record, then attempts
`prisma.payment.create`. The insert races are expected — the SSE stream and the
poll loop overlap by design — and the `P2002` unique-violation code is treated as
a benign duplicate rather than an error:

`apps/api/src/workers/watcher.worker.ts:125`

```ts
} catch (err: any) {
  if (err.code === 'P2002') {
    // A concurrent processor (SSE stream + poll loop, or two
    // overlapping bounded-backfill passes) inserted this payment
    // first — reorg-like duplicate delivery, not a real error.
    // Treat it as already recorded: don't re-alert.
    log.info({ txHash }, '🔁 Duplicate payment insert raced and lost, skipping (already recorded)');
    payment = await prisma.payment.findUnique({ where: { txHash } });
  } else {
    throw err;
  }
}
```

Enforcement is the `txHash String @unique` constraint on `Payment`
(`apps/api/prisma/schema.prisma:64`). Alerting is additionally gated on
`isNewPayment`, so a duplicate record never produces a second notification.

There is a `withWalletLock` Redis mutex available
(`apps/api/src/lib/lock.ts:81`) that could serialize per-wallet ingestion, but
the watcher's ingestion path does not take it. See Known gaps.

### Backpressure is bounded at two layers

The SSE handler processes messages strictly one at a time in arrival order via a
`processingChain` promise chain, and drops rather than buffers once
`maxQueuedMessages` (default 50) are waiting:

`apps/api/src/workers/watcher.worker.ts:512`

```ts
if (queueLength >= maxQueuedMessages) {
  streamMetrics.backpressureDropped++;
  console.warn(`[WatcherStream] ⚠️ Backpressure limit reached (${maxQueuedMessages}); dropping message ...`);
  return Promise.resolve();
}
```

Wallet-level concurrency is separately bounded by
`processWalletsConcurrently(wallets, env.WATCHER_WALLET_CONCURRENCY)`
(`apps/api/src/workers/watcher.worker.ts:665`), so one high-volume wallet cannot
starve the others.

### Cursor health is persisted for operator visibility

`IngestionCursor` carries `status`, `consecutiveFailures`, `lastError`,
`lastSuccessAt`, `gapDetectedAt`, and `lastGapLedgerDelta`, populated by pure
helpers in `apps/api/src/lib/cursor-recovery.ts:79-108`. That module does no I/O
by design, which keeps the gap arithmetic unit-testable without mocking Horizon or
Prisma.

## Tradeoffs

**Gaps larger than 200 records are not repaired.** The system prefers bounded,
predictable work over completeness, and surfaces the shortfall for a human. A
wallet that was unwatched for a long period will have a truncated history that
only an operator action can fix. The alternative — unbounded replay — risks
stalling the ingestion loop for every other wallet.

**Duplicate suppression is a database constraint, not a lock.** This makes
correctness depend on Postgres holding the unique index, and it costs a
read-then-write round trip on every record. The alternative, a per-wallet Redis
lock, would avoid most of those races but adds a Redis dependency to the
correctness path and still cannot cover a process crash mid-flight.

**Dropping stream messages under backpressure trades completeness for liveness.**
At 50 queued messages the newest message is discarded. It is counted in
`streamMetrics.backpressureDropped` and the cursor-based poll loop remains the
backstop, so a dropped stream message is normally recovered by polling. This is
acceptable only because the poll loop exists.

**Per-frame cursor writes.** Every record updates the `IngestionCursor` row,
which is one write per payment. This keeps the cursor exactly correct at the cost
of write amplification on high-volume wallets.

**Two ingestion paths mean two sets of edge cases.** Running SSE and polling
concurrently is what makes latency good, but it is also why the `P2002` handling
exists at all. A single-path design would be simpler and slower.

## Known gaps

- **`withWalletLock` is unused by the ingestion path.** The mutex in
  `apps/api/src/lib/lock.ts` is imported by the watcher but not applied to
  `processWalletPayments`, so per-wallet serialization does not actually happen.
  Idempotency currently rests entirely on the `txHash` unique index.
- **Two independent `alreadyDelivered` implementations exist.**
  `apps/api/src/lib/queue.ts:89` keys on `(paymentId, channel)` against
  `DeliveryLog`; `apps/api/src/lib/delivery.ts:165` keys on `deliveryKey` against
  `NotificationDelivery`/`NotificationDeliveryAttempt`. Channels outside
  `deliverWithIdempotency` use the former. See ADR 0003.
- **Worker memory/backpressure state is per-process.** `maxQueuedMessages` and the
  stream metrics counter bound one process's intake. With multiple worker replicas
  the effective ceiling is the per-process bound times the replica count.
- **Bounded backfill can itself race.** Two overlapping backfill passes are
  anticipated by the `P2002` handling, but the comment at
  `watcher.worker.ts:127` describes the case rather than proving it cannot
  produce a double notification.
