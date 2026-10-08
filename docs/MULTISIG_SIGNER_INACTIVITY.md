# Multi-Sig Key Weight Decay & Signer Inactivity Watcher

Analyses longitudinal signing behaviour across multi-sig treasury accounts,
flags signer keypairs that have gone quiet over configurable lookback windows,
and warns administrators when a treasury's quorum threshold is at risk of
becoming unreachable through signer abandonment.

## Two signals

1. **Discrete signer status** — days since last observed signing activity:

   | Status | Default window |
   | ------ | -------------- |
   | `ACTIVE` | < 30 days |
   | `STALE` | 30–89 days (weight decay begins) |
   | `INACTIVE` | 90–179 days |
   | `ABANDONED` | ≥ 180 days, or never observed |

2. **Weight decay** — an inactive signer's contribution decays linearly from
   full weight at the stale boundary to zero at the abandonment boundary, giving
   an early, continuous read on eroding quorum headroom before any signer is
   written off entirely.

## Quorum risk

For the account's selected threshold tier (`low`/`medium`/`high`):

| Risk | Condition |
| ---- | --------- |
| `CRITICAL` | `reachableWeight < requiredThreshold` — even every non-abandoned signer combined can no longer reach quorum. |
| `WARNING` | Recently-active signers alone can't reach quorum (relies on stale signers returning), **or** losing the single highest-weight active signer would drop below quorum (concentration risk). |
| `OK` | Comfortable active headroom above the threshold. |

- `reachableWeight` = weight of signers not yet `ABANDONED`.
- `activeWeight` = weight of `ACTIVE` signers only.
- `decayedWeight` = decay-weighted total across all signers.

## Components

| File | Responsibility |
| ---- | -------------- |
| `apps/api/src/services/signerInactivityWatcher.ts` | Pure logic: status classification, weight decay, treasury quorum-risk assessment. |
| `apps/api/src/workers/multisig-inactivity-watcher.worker.ts` | Loads tracked treasuries, joins on-chain signers with observed activity, assesses and notifies. |

The worker resolves each signer's last-signing time via a pluggable
`SignerActivityResolver`; the default (`resolveActivityFromPendingTxs`) credits
signers from stored `PendingMultisigTransaction` collected-signature history.

## Configuration

| Env var | Default | Meaning |
| ------- | ------- | ------- |
| `MULTISIG_INACTIVITY_WORKER_ENABLED` | `true` | Spawn the worker under the supervisor. |
| `MULTISIG_INACTIVITY_INTERVAL_MS` | `3600000` | Poll interval (default hourly). |

Window sizes (stale / inactive / abandoned days) are constructor options on
`SignerInactivityWatcher`.

## Tests

`apps/api/src/services/__tests__/signerInactivityWatcher.test.ts` covers status
classification, linear weight decay, per-signer assessment, the CRITICAL /
WARNING (stale-reliance and concentration) / OK quorum paths, the batch
at-risk filter, and the signer-activity join helper.
