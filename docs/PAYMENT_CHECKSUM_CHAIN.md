# Payment Ledger Checksum Chain

An append-only, tamper-evident audit trail over every ingested `Payment`
row, built from two new tables and one service
(`apps/api/src/services/checksumChain.service.ts`).

## Design

### `PaymentChecksum` — the hash-pointer chain

One row per `Payment`, appended immediately after it's ingested (see
`workers/watcher.worker.ts`'s `processPaymentRecord`). Each row stores:

- `payloadHash` — SHA-256 of the payment's own immutable fields (id,
  walletId, txHash, fromAddress, amount, asset, assetIssuer, memo,
  receivedAt), pipe-joined the same way `utils/receipt-generator.ts`'s
  `computeReceiptVerificationHash` does, for consistency across the
  codebase's checksum utilities.
- `previousHash` — the prior row's `chainHash`, or a fixed genesis constant
  (`sha256("stellar-alerts:payment-checksum-chain:genesis")`) for the very
  first row.
- `chainHash` — `sha256(previousHash + ":" + payloadHash)`.

Because each `chainHash` commits to everything before it, altering or
deleting **any** historical `Payment` or `PaymentChecksum` row changes that
row's recomputed `chainHash` and, transitively, every row appended after
it. Walking the chain from genesis and recomputing (`verifyChain()`) is
what actually detects tampering — this is exercised directly by
`services/__tests__/checksumChain.service.test.ts`.

**Ordering**: the chain follows *ingestion order* (an auto-incrementing
`sequence` column), not `Payment.receivedAt`. On-chain time is set by the
Stellar network and can arrive out of order relative to when this service
observed and wrote the row (backfills, multi-node failover, reorg-like
duplicate delivery); ingestion order is the only order this service can
itself guarantee monotonicity for.

**Concurrency**: `appendPaymentChecksum()` reads the current chain tail and
writes the next row inside a single `Serializable` Prisma transaction, so
two callers racing to append (e.g. the SSE watcher and a concurrent
backfill pass) can't both read the same tail and each link to it — Postgres
aborts one side with a serialization failure, which is retried with a
small backoff (`isSerializationFailure()`). A duplicate append for the same
payment (P2002 on `paymentId`'s unique constraint) is treated as
already-done, not an error, matching `Payment.txHash`'s existing
concurrent-insert handling in the same worker.

**Failure isolation**: an append failure (retries exhausted) is logged and
swallowed — it never throws back into the payment-ingestion path. A broken
checksum chain must not block real payment ingestion or alerting, which
remains the system's actual job. A skipped append shows up as a `Payment`
with no `PaymentChecksum` row and can be backfilled or investigated
out-of-band.

### `DailyChecksumRoot` — daily Merkle roots

Once a day (00:10 UTC, `workers/checksum-chain.worker.ts`), every
`PaymentChecksum.payloadHash` appended during the *previous* UTC day (see
that worker's doc comment for why it's the previous day, not the one that
just started) is folded into a Merkle tree using this codebase's existing,
tested primitives in `utils/merkle-verifier.ts` — no new Merkle-tree code
was written for this feature. The resulting root, and the leaf count it
covers, is upserted into `DailyChecksumRoot` keyed by `date` (`YYYY-MM-DD`,
UTC).

`verifyPaymentInDailyRoot(paymentId, day)` rebuilds that day's tree and
checks a fresh inclusion proof (`generateMerkleProof` /
`verifyMerkleProof`) rather than comparing hashes directly, so it exercises
the same proof path an external/offline verifier would use.

## Running an integrity check manually

```ts
import { verifyChain } from './services/checksumChain.service';

const result = await verifyChain();
if (!result.valid) {
  console.error(`Chain broken at sequence ${result.brokenAtSequence}: ${result.reason}`);
}
```

## Running the daily rollup worker

```bash
npm run dev:checksum-worker --workspace=api
```

Schedules the 00:10 UTC cron job (`node-cron`, matching
`workers/reporting.worker.ts`'s scheduling pattern). `runDailyChecksumRootJob(day?)`
is also exported for one-off/backfill invocation from a script or REPL.

## Compatibility

Purely additive: two new tables (`PaymentChecksum`, `DailyChecksumRoot`),
one new nullable-by-construction relation field on `Payment`
(`checksum PaymentChecksum?`), and one new call in the existing payment
ingestion path that cannot fail the ingestion itself (see "Failure
isolation" above). No existing table, column, or API response shape
changes. The migration
(`apps/api/prisma/migrations/20261016000000_add_payment_checksum_chain/`)
was reviewed statically only — no live Postgres instance was available in
the sandbox this was authored in; please confirm it applies cleanly via CI
or a local `docker compose up -d && npm run db:push` before merging.
