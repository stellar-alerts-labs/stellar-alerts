# Pre-Execution Transaction Simulation

`POST /tx-simulation/analyze` scores a Stellar or Soroban transaction envelope
*before* it is submitted, and returns a `verdict` of `allow`, `review`, or
`block` alongside the specific reasons.

The engine lives in `apps/api/src/lib/tx-simulation.ts` and is a pure
function: no network, no database, no clock. Everything it needs is an
argument. That makes the analysis reproducible — the same envelope, simulation
result, and baselines always produce the same report — and it makes the whole
thing testable without a live network.

## What it looks for

Indicators are grouped into five categories.

### footprint — declared vs. actually accessed

A Soroban transaction declares a ledger footprint up front and is charged for
it. If the simulation touched keys outside that set, the envelope and the
simulation disagree, and someone is about to sign something they did not
model. `FOOTPRINT_UNDECLARED_WRITE` is the critical one: a Soroban transaction
cannot write outside its declared read-write footprint, so a write that was
never declared means the simulation was run against a *different* envelope.

| Code | Severity | Meaning |
| --- | --- | --- |
| `FOOTPRINT_UNDECLARED_WRITE` | critical | Written but never declared. Do not submit. |
| `FOOTPRINT_UNDECLARED_READ` | medium | Read but declared nowhere; resource fee did not cover it. |
| `FOOTPRINT_READ_WRITE_OVERLAP` | medium | Declared read-write but only ever read; billed rent for nothing. |
| `FOOTPRINT_UNUSED_WRITE` | low | Declared read-write but never touched — fee waste. |
| `FOOTPRINT_ACCESS_EXPANSION` | high | Accessed footprint is large relative to declared. |
| `FOOTPRINT_ARCHIVE_RESURRECTION` | medium | Archived entries are in the accessed set and will be restored. |
| `FOOTPRINT_RESTORE_REQUIRED` | medium | RPC returned a restore preamble instead of a final simulation. |

These only appear when you supply a `simulation` block. Without one there is
no accessed set to diff against, and guessing would be worse than silence —
`coverage.footprintDiff` tells you which mode you got.

### drain — value leaving the account

`DRAIN_BALANCE_EXHAUSTION` (critical) is the headline case: outflows consume
more than `drainExhaustionRatio` of the account's native balance.
`DRAIN_DUST_RESIDUE` catches the variant that sweeps to near-zero without
tripping the ratio. `DRAIN_MULTI_DESTINATION_SPLIT` flags fan-out above
`drainSplitDestinationThreshold`, which is what splitting a drain looks like
to avoid any single-transfer heuristic.

Also covered: `DRAIN_ACCOUNT_MERGE`, `DRAIN_CLAWBACK`,
`DRAIN_TRUSTLINE_AUTHORIZATION_REVOKED`,
`DRAIN_ASYMMETRIC_PATH_PAYMENT`, and `DRAIN_UNKNOWN_RECIPIENT` (destination
not in the caller's `knownRecipients` baseline).

Balance-relative math needs `ledgerBaseline.nativeBalanceStroops`. Without it
those checks are skipped and `coverage.balanceBaseline` is `false`.

### authorization — capability changes

`AUTH_MASTER_KEY_GRANT` (critical) for a `setOptions` that installs or re-arms
a master key signer, `AUTH_THRESHOLD_CHANGE` (medium) for threshold moves,
`DRAIN_TRUSTLINE_AUTHORIZATION_REVOKED` for `authorized` being set to false,
and `DRAIN_CLAWBACK` for clawback operations. These decode from the envelope
alone — no simulation required.

### contract — Soroban host functions

`CONTRACT_UNVERIFIED_DEPLOYMENT` (high) for a `createContract` or
`uploadContractWasm`, `CONTRACT_UNVERIFIED_INTERACTION` (high) for an
`invokeContract` against a contract absent from `ledgerBaseline.trustedContracts`,
`CONTRACT_TTL_EXTENSION_EXCESSIVE` (medium) for TTL pushes beyond
`ttlExtensionLedgerThreshold`, `CONTRACT_RESTORE_FOOTPRINT_OP` (high) for the
protocol 23+ `restoreFootprint` operation, and `CONTRACT_COMPOSITION_MULTIPLE`
(medium) when several contracts are touched in one envelope.

Contract IDs are recovered as StrKey `C...` addresses, so they can be compared
against an allow-list directly.

### resource — exhaustion shape

`RESOURCE_CPU_BUDGET_ANOMALY` (medium) for a simulated instruction count above
`cpuInstructionThreshold`, and `RESOURCE_FOOTPRINT_SIZE` (low) for an accessed
footprint above `maxFootprintEntries`. Both are DoS-shaped rather than
theft-shaped, which is why neither can move a verdict on its own.

## Scoring

Severity contributes a fixed weight — `low` 5, `medium` 12, `high` 25,
`critical` 40 — matching `utils/wasm-analyzer.ts` so a "critical" means the
same magnitude across both analyzers. Category subtotals are capped at 100 and
the total saturates at 100.

A level floor guarantees one serious finding is never diluted by a pile of
low-severity noise. Each level's floor equals that severity's weight (`low` 5,
`medium` 12, `high` 25, `critical` 40), so a lone `high` indicator scores 25 and
therefore reports as `high` rather than being knocked down a band — and adding
low-severity findings on top can only raise the score, never lower it.
`verdict` is then:

- `block` — the level is critical, or any single indicator is critical.
- `review` — level is high or medium.
- `allow` — otherwise.

A critical indicator cannot be voted down by a low total score: it is worth 40
points on its own, which sits at the `high` floor, so it would otherwise read as
`review`. That override is what makes the verdict usable as a signing gate
rather than a dashboard.

## Request

```jsonc
POST /tx-simulation/analyze
{
  "envelopeXdr": "AAAAAgAAAAC...",      // required
  "networkPassphrase": "Test SDF Network ; September 2015",  // required

  // Optional. Result of simulateTransaction against the SAME envelope.
  "simulation": {
    "status": "SUCCESS",
    "costCpuInsns": "1234567",
    "readOnlyLedgerKeys": ["AAAA..."],
    "readWriteLedgerKeys": [],
    "archivedLedgerKeys": [],
    "restoreRequired": false
  },

  // Optional. Caller-known ledger facts; each one raises `coverage`.
  "ledgerBaseline": {
    "nativeBalanceStroops": "100000000",
    "knownRecipients": ["GC..."],
    "trustedContracts": ["CA..."]
  },

  // Optional per-request threshold overrides.
  "options": {
    "drainExhaustionRatio": 0.9,
    "drainSplitDestinationThreshold": 3,
    "ttlExtensionLedgerThreshold": 535
  },

  "persist": true  // default; false skips the audit row
}
```

Only `envelopeXdr` and `networkPassphrase` are required. The body is strict at
every level: an unrecognised key is a typo or a smuggling attempt, and silently
dropping it would quietly lower `coverage` without telling anyone.

### Why the caller supplies the simulation

The endpoint never calls an RPC. If it re-simulated server-side, a caller could
pair a clean simulation with a hostile envelope. Accepting the caller's
`simulateTransaction` output keeps the pairing explicit in the request and the
analysis honest about what it actually checked.

## Response

```jsonc
{
  "success": true,
  "simulationId": "clx...",
  "persisted": true,
  "report": {
    "envelope": {
      "txHash": "…",          // outer envelope hash; for a fee-bump this is the outer one
      "innerTxHash": "…",     // equals txHash unless fee-bump
      "isFeeBump": false,
      "sourceAccount": "GC…",
      "operationCount": 2,
      "outflows": [ /* … */ ],
      "contractInvocations": [ /* … */ ],
      "authorization": { /* … */ },
      "ttlExtensions": { "operationCount": 0, "restoreFootprintOperationCount": 0 }
    },
    "footprintDiff": { /* declared vs accessed, or null */ },
    "risk": {
      "score": 40,
      "level": "critical",
      "verdict": "block",
      "indicators": [
        {
          "code": "FOOTPRINT_UNDECLARED_WRITE",
          "category": "footprint",
          "severity": "critical",
          "title": "…",
          "detail": "…",
          "remediation": "…",
          "evidence": { /* numbers, identifiers, truncated lists */ }
        }
      ],
      "breakdown": [ /* per-category subtotals */ ],
      "recommendations": [ /* de-duplicated, worst first */ ]
    },
    "coverage": {
      "footprintDiff": true,
      "balanceBaseline": false,
      "trustedContractBaseline": false,
      "recipientBaseline": true
    }
  }
}
```

### Where the types live

The example above is illustrative. The authoritative shapes are TypeScript, and
they are the only place the response is declared — this project generates
`openapi.json` from Zod *request* schemas only, and registers no per-route
response schemas, so `AnalyzeTransactionInput` appears under
`components.schemas` while the report body does not:

- Request: `AnalyzeTransactionRequest` (inferred from the Zod schema) and, in
  `openapi.json` → `components.schemas.AnalyzeTransactionInput`, the generated
  `AnalyzeTransactionInput` in `@stellar-alerts/shared`.
- Response: `AnalyzeTransactionResponse` in
  `apps/api/src/modules/tx-simulation/tx-simulation.service.ts`, whose `report`
  is the engine's own `SimulationReport` from `src/lib/tx-simulation.ts`.

Anything importing the response type should import it rather than redeclaring the
shape — the breakdown, indicator and coverage blocks are large and evolve with
the engine.

### Read `coverage` first
A clean verdict on a thin analysis is not the same as a clean verdict on a
thorough one. `coverage` says which checks actually ran:

- `footprintDiff: false` — no footprint diffing happened at all.
- `balanceBaseline: false` — no balance-relative drain math.
- `trustedContractBaseline: false` — every contract invocation is "unverified".
- `recipientBaseline: false` — no recipient allow-list, so no unknown-recipient checks.

A `verdict: allow` with all four `false` means very little was checked. Gate on
the verdict, but surface the coverage alongside it.

## Errors

| Status | Code | Cause |
| --- | --- | --- |
| 400 | `VALIDATION_ERROR` | Body failed schema validation; `details` names the field. |
| 400 | `INVALID_ENVELOPE_XDR` | `envelopeXdr` is not decodable transaction/fee-bump XDR. |
| 401 | `AUTH_REQUIRED` / `INVALID_TOKEN` / `TOKEN_REVOKED` | Session missing, invalid, or revoked. |
| 429 | rate limit | Per-client cap, separate from the global limiter. |

A failed audit write never fails the request: the caller already has the
verdict, so the response reports `persisted: false` and the report is returned
intact.

## Fee-bump envelopes

`envelope.txHash` is the hash of the envelope as submitted — for a fee-bump
that is the *outer* envelope, which is what the ledger indexes and what
identifies the submission. The inner transaction's hash is reported separately
as `innerTxHash`; the two differ on a fee-bump. Analysis reads the inner
transaction's operations, as the inner tx is what actually executes.

## Limitations

- `TransactionBuilder.fromXDR` does not validate the network passphrase, so
  this is not a network-authenticity check. Confirm the passphrase elsewhere
  if that matters.
- The archived-footprint set comes from the supplied simulation, since the
  envelope carries no archive information.
- `SorobanTransactionData.ext` is an anonymous int-union the SDK's public
  `xdr` namespace does not re-export; the engine normalizes its switch through
  `switchArm`.
- Soroban operations are read from raw XDR because the parsed
  `invokeHostFunction` operation exposes its host function as an opaque union
  with no arm accessors in this SDK build.

## Persistence

Each call writes a `TransactionSimulation` row (user, hashes, network, level,
verdict, score, indicator codes, report JSON, footprint diff, request
snapshot). The envelope XDR itself is deliberately **not** stored: the row is
already identified by `envelopeHash`, and keeping raw XDR out means the table
cannot become a store of unscanned payloads. Callers still receive the XDR in
the HTTP response. Use `persist: false` for dry runs.

## Configuration

| Variable | Default | Effect |
| --- | --- | --- |
| `TX_SIMULATION_MAX_ENVELOPE_BYTES` | 65536 | Declared envelope size budget. The zod cap is a char limit derived from it. |
| `TX_SIMULATION_RATE_LIMIT_MAX` | 20 | Per-client requests/minute on this route. |

Threshold defaults live in `DEFAULT_SIMULATION_THRESHOLDS` in
`src/lib/tx-simulation.ts` and can be overridden per request via `options`.
