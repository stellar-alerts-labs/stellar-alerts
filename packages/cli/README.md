# stellar-alerts-cli

Command-line tool for managing Stellar Alerts wallets, streaming payments, and
auditing locally cached transaction history.

## Install / run

```bash
npm install
npm run dev --workspace=packages/cli -- <command> [options]
# or, after `npm run build --workspace=packages/cli`:
node packages/cli/dist/cli.js <command> [options]
```

All commands accept `-u, --api-url <url>` on the root `program` (defaults to
`http://localhost:3001` or `STELLAR_ALERTS_API_URL`), and most accept
`-t, --token <token>` for API authentication.

## Commands

### `wallet`

Manage watched Stellar wallets (`add`, `list`, `remove`/`rm`).

### `stream`

Watch (`watch`) or list (`history`) real-time/cached payment records.

#### `stream watch`

Tails `GET /payments/stream` (newline-delimited JSON, one `PaymentDTO` per line) and keeps going across network failures.

| Option | Default | Description |
| --- | --- | --- |
| `-w, --wallet <walletId>` | — | Only this wallet's payments (sent as `?walletId=`) |
| `-t, --token <token>` | — | API token |
| `--cursor <token>` | saved cursor | Resume after this cursor. `now` starts from the live tail and ignores the saved cursor. |
| `--cursor-file <path>` | `~/.stellar-alerts/stream-cursor[-<wallet>].json` | Where the resume cursor is stored |
| `--no-resume` | — | Do not read or write the cursor file |
| `--max-retries <n>` | unlimited | Consecutive failed reconnects before exiting with code 1 |
| `--max-backoff <ms>` | `60000` | Upper bound for the reconnect delay |

##### Reconnect

When the connection fails or the server closes it, the CLI reconnects with exponential backoff (1s, 2s, 4s … capped at `--max-backoff`, with jitter across the upper half of each step). The backoff resets as soon as a connection delivers a payment. `5xx`, `408` and `429` responses and network errors are retried. Other HTTP errors, such as `401` or `404`, exit straight away.

##### Cursor and resume

After each payment is printed, the CLI atomically writes `{ cursor, lastId }` to the cursor file (it writes a temp file, then renames it over the old one). The cursor is the payment's `pagingToken` when the server sends one, otherwise its `id`. On reconnect or restart it is sent as `?cursor=<value>`. A missing or corrupted cursor file prints a warning and falls back to the live tail.

Delivery is **at-least-once**. The CLI never advances the cursor past a payment it has not finished handling, and it drops replayed payments by `id`, remembering the last 1,000 ids plus the saved `lastId` across restarts.

##### Shutdown

`SIGINT` or `SIGTERM` closes the connection, lets the payment being handled finish, flushes its cursor, removes the signal handlers and exits `0`. A second signal exits immediately with code `130`.

##### Compatibility

- With no cursor file (a fresh install, or `--no-resume`), the request is the same bare `GET /payments/stream` as before.
- `cursor` is an optional query parameter. A server that ignores it still works: the CLI drops the replayed payments, and a replay older than the id window shows up as duplicate output rather than a missed payment.
- To use cursors, a server should resume *after* the given `pagingToken`/`id` and may add `pagingToken` to each record.

### `health`

Checks API reachability.

### `verify-ledger`

Audits locally cached payment records against Horizon and emits a
Merkle-based verification certificate.

```bash
stellar-alerts-cli verify-ledger [--wallet <id>] [--limit <n>] [--output <file>] [--token <token>] [--horizon-url <url>]
stellar-alerts-cli verify-ledger check <certificate-file>
```

**What it actually verifies (read this before trusting the output):** for
each cached payment record (from this app's own database, via the API), the
command independently re-queries Horizon directly for that transaction and
compares the cached amount, asset, and sender address against what Horizon
reports. This catches local database corruption or tampering — a cached
amount, asset, or sender that doesn't match the real on-chain record. Every
record that matches is hashed into a Merkle leaf (using this monorepo's
shared, tested, domain-separated SHA-256 primitives in
`@stellar-alerts/shared`), and a Merkle tree is built over all verified
leaves. The resulting **verification certificate** (a JSON document) contains
the Merkle root, a summary of verified/mismatched/unverifiable counts, and
per-record status — including each verified record's own leaf hash and
Merkle inclusion proof path, so the certificate can be checked later without
re-running the audit or re-fetching anything.

**What it is *not*:** this is **not** a proof that a transaction was included
in a specific Stellar ledger at the protocol/consensus level. Reconstructing
Stellar Core's actual `GeneralizedTransactionSet` ledger-header Merkle hash
tree (`txSetResultHash`) and per-transaction inclusion proofs against it
would require replaying Core's exact XDR-based hashing algorithm — Horizon's
public API doesn't expose the data needed to do that, so this command doesn't
claim to. What it provides instead is honest and still useful: independent
cached-record integrity verification against Horizon, plus a tamper-evident
Merkle commitment over the verified set.

Use `verify-ledger check <certificate-file>` to later validate a previously
generated certificate: it recomputes each verified record's leaf hash from
its stored fields and checks the Merkle proof against the certificate's
recorded root, without contacting Horizon or the API again. This detects
both a record whose fields were edited after the certificate was generated,
and a certificate whose Merkle root/proof data was corrupted directly.

Options for the audit form:
- `-w, --wallet <walletId>` — only audit payments for one watched wallet
- `-l, --limit <number>` — max cached payments to audit (default `50`)
- `-o, --output <path>` — write the full certificate JSON to a file
- `-t, --token <token>` — API authentication token
- `--horizon-url <url>` — Horizon server to verify against (default `https://horizon-testnet.stellar.org` / `HORIZON_URL`)
