# Liquidity Pool Impermanent Loss Tracker

Tracks AMM liquidity-pool share balances across **SDEX** (classic protocol
`LiquidityPool` reserves) and **Soroban DEX** pools, computes impermanent loss
(IL) against a **HODL baseline**, and dispatches an alert when a position's IL
crosses a user-defined risk threshold.

## What "impermanent loss" means here

IL is the value gap between providing liquidity and simply holding the deposited
tokens:

```
lpValue   = (shares / totalShares) * reserve0 * price0
          + (shares / totalShares) * reserve1 * price1
hodlValue = deposited0 * price0 + deposited1 * price1
IL        = (lpValue - hodlValue) / hodlValue      // negative = loss vs HODL
```

Prices are supplied in a common numeraire (e.g. USD). The engine derives IL from
the **actual live reserves and share balance** rather than a closed form, so it
handles multi-deposit positions and partial withdrawals correctly. For
verification, `constantProductIl(r)` gives the closed-form IL for a 50/50
constant-product pool after a price-ratio change `r` — e.g. a 2× move ≈ −5.72%,
a 4× move = −20%.

Trading fees are excluded from the IL number itself; `netOfFeesPct` adds accrued
fee income on top so callers can see the position's true P&L versus HODL.

## Components

| File | Responsibility |
| ---- | -------------- |
| `apps/api/src/services/impermanentLossTracker.ts` | Pure logic: position registry, deposit/withdrawal accounting, IL math, threshold classification. |
| `apps/api/src/workers/impermanent-loss-watcher.worker.ts` | Polling loop with injectable pool-state / price / threshold resolvers and a pluggable notifier. |

## Position lifecycle

- `openPosition` — register a position from an initial deposit (records the
  cost-basis token amounts and LP shares).
- `applyDeposit` — a follow-up deposit extends the cost basis and share balance.
- `applyWithdrawal` — removing shares reduces the cost basis proportionally so
  the HODL baseline stays consistent; removing all shares closes the position.
- `computeImpermanentLoss` / `evaluateThreshold` — evaluate against a live
  `PoolStateSnapshot` (reserves, total shares, spot prices).

## Severity & thresholds

| Severity | Default trigger |
| -------- | --------------- |
| `WARNING` | IL magnitude ≥ 5% |
| `CRITICAL` | IL magnitude ≥ 10% |

`evaluateThreshold` fires an alert once the IL magnitude reaches the caller's
per-user threshold (percent).

## Configuration

| Env var | Default | Meaning |
| ------- | ------- | ------- |
| `IL_WATCHER_INTERVAL_MS` | `60000` | Poll interval. |
| `IL_WATCHER_DEFAULT_THRESHOLD_PCT` | `5` | Fallback threshold when no per-user value is resolved. |

The watcher is intentionally **not** auto-spawned by the supervisor: it requires
a pool-state / price resolver to be wired via `runImpermanentLossWatcher()`
before it produces meaningful alerts.

## Tests

`apps/api/src/services/__tests__/impermanentLossTracker.test.ts` covers the
closed-form reference, live-reserve IL computation (including the ~5.72% 2× case),
share-fraction scaling, deposit/withdrawal accounting, threshold alerting, and
fee-offset math.
