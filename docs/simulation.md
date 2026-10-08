# Pre-Execution Transaction Simulation

`POST /simulations/analyze` runs a Stellar/Soroban transaction envelope through a
threat engine **before** it is signed and submitted, and returns an explainable
threat score with a full indicator breakdown. Results are persisted so there is
an auditable record of what was checked and what was found.

The engine is a **decision-support tool, not a sandbox**. It reasons over the
state you give it; it does not execute the envelope, contact a Soroban RPC node,
or prove anything about a contract's behaviour. Every report carries a
`meta.simulated` flag, and an analysis with no host simulation result is
explicitly scored as a *lower bound* rather than presented as complete.

## Endpoints

All routes require a bearer token and are scoped to the authenticated user.

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/simulations/analyze` | Analyze an envelope. Returns `201` with the persisted assessment and a `Location` header. |
| `GET` | `/simulations` | Paginated history. Optional `band` and `sourceAccount` filters. |
| `GET` | `/simulations/:id` | One stored assessment. `Cache-Control: no-store`. |

`POST /simulations/analyze` is rate-limited to 20 requests/minute per client, on
top of the app-wide limiter, because each call is CPU work over up to 1000
operations plus a database write.

## Request shape

Everything except `sourceAccount` and `operations` is optional. The engine is
designed to produce a *lower bound* score from partial evidence rather than
refusing to analyze — reporting `NO_SIMULATION_RESULT` as an indicator is more
useful to a signer than a `400`.

```jsonc
{
  "sourceAccount": "G…",
  "network": "PUBLIC",              // PUBLIC | TESTNET | FUTURENET
  "label": "monthly rent",
  "envelopeXdr": "AAAAAQ==",        // optional; hashed, never stored verbatim
  "operations": [
    { "kind": "pay", "destination": "G…", "asset": { "type": "native" }, "amount": "10" },
    { "kind": "invokeContract", "contractId": "C…", "function": "withdraw" }
  ],
  "resources": {
    "footprint":          { "readOnly": [], "readWrite": [], "archived": [] },
    "requiredFootprint":  { "readOnly": [], "readWrite": [], "archived": [] },
    "ledgerBounds":       { "min": 100, "max": 200 },  // null = declares no bounds
    "hasTimeBounds":      true,
    "auth":               [/* SorobanAuthorizationEntry descriptors */]
  },
  "preState":  [{ "accountId": "G…", "nativeBalance": "100" }],
  "postState": [{ "accountId": "G…", "nativeBalance": "90" }],
  "outcome":   { "success": true, "ledger": 12345, "resultingBalances": [] },
  "contracts": [{ "contractId": "C…", "wasmHash": "…", "deployed": true }],
  "trustRegistry": {
    "byContractId":    { "C…": { "contractId": "C…", "verified": true, "wasmHash": "…" } },
    "allowlist":       ["C…"],
    "trustedDeployers": ["G…"]
  }
}
```

### Amounts are decimal strings, not numbers

Every amount is a string validated against `/^\d+(\.\d{1,7})?$/`. JavaScript
numbers cannot represent 7-decimal Stellar amounts exactly, and rounding a
balance before comparing it pre/post would corrupt the drain detection this
engine exists to perform. Amounts with more than 7 decimals are **rejected**,
not truncated, and negative amounts are rejected: Stellar amounts are unsigned on
the wire, and a negative parsed amount could net against a real outflow and mask
a drain. Negative *values* in the report are always derived from balance
subtraction.

### `null` is not the same as omitted

`resources.ledgerBounds: null` states "the envelope declares no bounds" — a
distinct, reportable condition (`UNBOUNDED_RESOURCE_LIMITS`) from "the caller did
not tell us", which leaves the rule silent.

### `envelopeXdr` is correlation metadata

The engine does not decode XDR. A submitted envelope is SHA-256 hashed into
`envelopeHash` so identical envelopes are detectable and the stored report never
contains the raw blob. Populate `resources.footprint`, `resources.requiredFootprint`,
and `outcome` from your own `simulateTransaction` call.

## Scoring

```
score = min(100, Σ weight of every distinct triggered indicator)
```

Three properties make the number trustworthy:

1. **Deduplicated by `code`.** A rule that fires once per operation cannot push a
   benign envelope into CRITICAL by sheer count. Volume is reported as *evidence*
   (`DESTINATION_FAN_OUT.evidence.destinationCount`), not as score.
2. **Reconcilable.** The per-category breakdown is computed from the same
   deduplicated set, so `Σ breakdown[].score == score` up to the 100-point cap.
   `assertScoreReconciliation` enforces this and is exercised in the test suite.
3. **Stable severities.** Weights are tied to severity buckets, so adding a new
   *low*-severity rule cannot silently reclassify an existing HIGH envelope.

| Band | Score |
| --- | --- |
| `SAFE` | 0–19 |
| `LOW` | 20–39 |
| `MODERATE` | 40–59 |
| `HIGH` | 60–79 |
| `CRITICAL` | 80–100 |

`blockExecution` is true when `score >= SIMULATION_RISK_BLOCK_THRESHOLD`
(default 80).

### Indicator categories

- **`drain`** — `FULL_BALANCE_DRAIN`, `NEAR_TOTAL_BALANCE_OUTFLOW`,
  `ACCOUNT_MERGE_SWEEP`, `DESTINATION_FAN_OUT`, `UNBOUNDED_SEQUENTIAL_TRANSFERS`,
  `ROUND_TRIP_SELF_DEAL`, `REVOCABLE_ASSET_TRANSFER`, `ASSET_LIQUIDATION_SWEEP`,
  `DUST_AMOUNT_TRANSFER`
- **`footprint`** — `UNDECLARED_FOOTPRINT_ACCESS`, `FOOTPRINT_WRITE_DOWNGRADE`,
  `FOOTPRINT_OVER_PERMISSION`, `UNUSED_FOOTPRINT_ENTRIES`,
  `EMPTY_FOOTPRINT_WITH_INVOCATION`, `ARCHIVED_KEY_ACCESS`,
  `FOOTPRINT_KEY_PROBING`, `UNBOUNDED_FOOTPRINT_GROWTH`
- **`contract`** — `UNVERIFIED_CONTRACT_INVOCATION`, `CONTRACT_CODE_HASH_MISMATCH`,
  `PRIVILEGED_CONTRACT_FUNCTION`, `PRIVILEGED_FUNCTION_WITHOUT_AUTH`,
  `NEWLY_DEPLOYED_CONTRACT_INVOKED`, `UNVERIFIED_SELF_DEPLOYED_CONTRACT`,
  `CONTRACT_NOT_DEPLOYED`, `INVOCATION_OF_ARCHIVED_CONTRACT`, `INVOCATION_FAN_OUT`
- **`envelope`** — `SIMULATION_REVERTED`, `SIMULATION_HOST_ERRORS`,
  `NO_SIMULATION_RESULT`, `MISSING_TIME_BOUNDS`, `UNBOUNDED_RESOURCE_LIMITS`,
  `ZERO_RESOURCE_LIMITS`, `ZERO_FEE_SOROBAN_ENVELOPE`

### A note on `FULL_BALANCE_DRAIN`'s weight

`FULL_BALANCE_DRAIN` is weighted **60**, which places a total drain in the HIGH
band but deliberately does *not* auto-block it on its own: "move my entire
balance to my other account" is routine, and the envelope alone cannot distinguish
that from a sweep. 60 is chosen so that a total drain **plus any independent
corroborating signal** crosses the default 80-point block threshold:

| Additional signal | Total | Blocked? |
| --- | --- | --- |
| none | 60 | no (HIGH) |
| `DESTINATION_FAN_OUT` (22) | 82 | yes |
| `UNVERIFIED_CONTRACT_INVOCATION` (24) | 84 | yes |
| `ACCOUNT_MERGE_SWEEP` (40) | 100 | yes |

Lowering this weight below 55 would let a full drain plus an unverified contract
pass the gate. Both this calibration and the corroboration rule are pinned by
tests in `simulation-engine.test.ts`; revisit them together if you retune weights.

## Configuration

Every threshold is an optional environment variable (see `.env.example`). The
engine module itself stays default-only and pure; the service layer resolves
`env` and passes the result in.

| Variable | Default | Gates |
| --- | --- | --- |
| `SIMULATION_NEAR_TOTAL_OUTFLOW_RATIO` | `0.85` | Outflow/pre-balance ratio counted as a drain (clamped to `(0, 1]`). |
| `SIMULATION_FAN_OUT_DESTINATION_THRESHOLD` | `3` | Distinct destinations counted as fan-out. |
| `SIMULATION_SEQUENTIAL_TRANSFER_THRESHOLD` | `8` | Outgoing transfers from one source counted as a burst. |
| `SIMULATION_MAX_FOOTPRINT_READ_WRITE_KEYS` | `64` | Declared read-write keys flagged as unbounded growth. |
| `SIMULATION_FOOTPRINT_PROBE_CONTRACT_THRESHOLD` | `5` | Distinct contracts spanned by a footprint flagged as probing. |
| `SIMULATION_MAX_INVOCATIONS_PER_CONTRACT` | `5` | Invocations of one contract flagged as fan-out (inclusive). |
| `SIMULATION_RISK_BLOCK_THRESHOLD` | `80` | Score at/above which `blockExecution` is true. |
| `SIMULATION_DUST_AMOUNT_STROOPS` | `10` | Amounts at/below this are treated as dust. |

Every report echoes the thresholds actually applied in `meta.thresholds`, so a
stored report stays explainable after the thresholds are retuned.

## Persistence

One `TransactionSimulation` row per `POST /simulations/analyze`:

- `score` / `band` / `blockExecution` are first-class columns so operators can
  query "every CRITICAL simulation in the last 24h" without a JSONB scan.
- `report` (JSONB) holds the complete engine output, including per-indicator
  evidence and the threshold set in force at the time.
- `envelopeHash` is a SHA-256 of the submitted envelope XDR; the envelope itself
  is never stored.
- `sourceAccount` is a public Stellar key, never a secret.

`HIGH` and `CRITICAL` results are additionally escalated into
`SecurityAuditLog` as `TRANSACTION_SIMULATION_RISK` so they land in the stream
operators already monitor, without duplicating every `SAFE` result into it.

Failure handling is deliberately asymmetric, because the two writes are not
equally load-bearing:

- **Persistence fails closed.** The row is the durable audit record for a
  pre-signing decision, and `201` + `Location` promise an id that resolves. A
  write failure therefore surfaces as a `500` rather than returning a verdict
  the caller would believe was recorded when it was not.
- **Audit-log failures are non-fatal.** The assessment is already persisted by
  that point, so a hiccup in the audit table is logged and swallowed rather than
  turning "this envelope looks like a takeover attempt" into a `500` a caller
  could read as "no risk found".

## Compatibility and rollout

- **Additive only.** The migration creates one new table plus a back-reference on
  `User` that Prisma models only (no SQL column). No existing column is altered
  and no data is dropped, so it is backward compatible and roll-forward/roll-back
  safe.
- **Deploy order.** Apply the migration before deploying the API. The new routes
  are purely additive; older clients are unaffected.
- **No default-on behavior change.** Nothing calls the engine unless a client
  posts to `/simulations/analyze`. Existing alerting and export flows are
  untouched.
- **Versioning.** The score, bands, and weights are the contract. Consumers
  should branch on `band` and `blockExecution` rather than on a specific numeric
  score, since thresholds are operator-tunable and weights may be recalibrated.
- **Rollback.** Revert the API deployment and drop the table; no other feature
  depends on it.

## Architecture

```
apps/api/src/services/simulation/     pure engine, no Prisma/env/network
  amounts.ts                           exact decimal ⇄ stroop conversion
  footprint-diff.ts                    declared vs required footprint
  drain-detector.ts                    balance-flow and transfer-pattern rules
  contract-trust.ts                    verification, privilege, deployment rules
  envelope-integrity.ts                footprint threats + envelope properties
  risk-scorer.ts                       dedupe, weights, bands, breakdown
  simulation-engine.ts                 orchestrator
apps/api/src/modules/simulation/      HTTP layer (schema/service/controller/routes)
```

The engine has no Prisma, env, or network dependency, which is what makes it
exhaustively testable and safe to reuse from workers.

## Tests

```
apps/api/src/services/__tests__/simulation-amounts.test.ts
apps/api/src/services/__tests__/simulation-engine.test.ts
apps/api/src/services/simulation/__tests__/footprint-diff.test.ts
apps/api/src/services/simulation/__tests__/drain-detector.test.ts
apps/api/src/services/simulation/__tests__/contract-trust.test.ts
apps/api/src/services/simulation/__tests__/envelope-integrity.test.ts
apps/api/src/services/simulation/__tests__/risk-scorer.test.ts
apps/api/src/modules/simulation/__tests__/simulation.service.test.ts
apps/api/src/modules/simulation/__tests__/simulation.routes.test.ts
```

The engine suite pins the exact-decimal arithmetic, the footprint diff
classification, every indicator's trigger *and* non-trigger conditions (an
engine that only tests its happy path reports false positives as loudly as false
negatives), the score cap and breakdown reconciliation, and the drain-weight
calibration described above.