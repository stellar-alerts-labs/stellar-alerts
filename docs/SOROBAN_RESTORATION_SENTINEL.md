# Soroban Contract Instance & Code Restoration Sentinel

Protocol 20/21/22 state archival evicts persistent Soroban ledger entries once
they pass their `liveUntilLedgerSeq`. A contract cannot be invoked while any key
in its footprint is archived — the invocation transaction fails with
`entry archived` until the keys are restored via `RestoreFootprint`.

The restoration sentinel watches the **contract instance** entry and its
**WASM code** entry for every active contract subscription, classifies eviction
risk, and prices the exact restoration fee **before** an invocation would fail.

## Components

| File | Responsibility |
| ---- | -------------- |
| `apps/api/src/services/restorationSentinel.ts` | Pure logic: TTL classification + restoration fee math. |
| `apps/api/src/workers/soroban-restoration.worker.ts` | Ingestion loop: resolves the instance/code footprint from the Soroban RPC and runs the engine. |

## Severity model

For each entry, `remainingLedgers = liveUntilLedgerSeq - currentLedger`:

| Severity | Condition |
| -------- | --------- |
| `OK` | `remainingLedgers` above the warning threshold. |
| `WARNING` | `remainingLedgers <= SOROBAN_RESTORATION_WARNING_LEDGERS` (default 17280, ~1 day). |
| `CRITICAL` | `remainingLedgers <= SOROBAN_RESTORATION_CRITICAL_LEDGERS` (default 1000). |
| `EVICTED` | `remainingLedgers < 0` — the entry is archived and must be restored. |

A contract's rolled-up severity is the worst of its entries. `requiresRestoration`
is `true` only when at least one entry is evicted.

## Restoration fee

Restoring an evicted entry costs a one-off **write fee** to re-materialise it into
live state, plus **rent** to keep it live for `SOROBAN_RESTORATION_MIN_RESTORE_LEDGERS`
ledgers:

```
writeFeeStroops = byteSize * writeFeePerByteStroops
rentFeeStroops  = byteSize * minRestoreLedgers * rentFeePerBytePerLedgerStroops
totalFeeStroops = writeFeeStroops + rentFeeStroops
```

Fees are computed in `bigint` stroops and rendered as a fixed 7-dp XLM string, so
there is no floating-point drift. Temporary entries are out of scope: once expired
they are permanently deleted and cannot be restored.

## Configuration

| Env var | Default | Meaning |
| ------- | ------- | ------- |
| `SOROBAN_RESTORATION_WORKER_ENABLED` | `true` | Spawn the worker under the supervisor. |
| `SOROBAN_RESTORATION_WORKER_INTERVAL_MS` | `60000` | Poll interval. |
| `SOROBAN_RESTORATION_WARNING_LEDGERS` | `17280` | WARNING threshold. |
| `SOROBAN_RESTORATION_CRITICAL_LEDGERS` | `1000` | CRITICAL threshold. |
| `SOROBAN_RESTORATION_MIN_RESTORE_LEDGERS` | `4096` | Ledgers a restored entry is brought back to live for. |

## Tests

`apps/api/src/services/__tests__/restorationSentinel.test.ts` covers XLM
formatting, per-entry classification, exact fee math, and footprint aggregation.
