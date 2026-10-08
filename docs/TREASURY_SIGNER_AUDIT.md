# Treasury signer weight drift audit

The multisig treasury watcher now audits each watched account on every pass, even when there are no pending approval transactions to process.

## What is monitored

- signer weight changes detected from the latest `set_options` record
- master key weight modifications
- total signer + master weight falling below the treasury's configured threshold for the active threshold level

## Alert behavior

When drift is detected, the worker notifies each configured watcher attached to the affected treasury. This is designed to catch compromised-key misuse or misconfiguration before the registry loses enough signing power to meet the required threshold.

## Compatibility and rollout

- This check does not require a database migration.
- It is additive to the existing pending-transaction multisig approval flow.
- The worker treats the most recent `set_options` operation as the audit signal and deduplicates repeated findings within a pass.
- If Horizon cannot load the account or set-options history, the worker logs the issue and skips that treasury for that poll cycle rather than firing a false-positive alert.
