# stellar-alerts-cli

Command-line client for managing Stellar Alerts wallets and watching payment streams.

```bash
npm run dev --workspace=stellar-alerts-cli -- <command>
```

| Variable | Default | Purpose |
| --- | --- | --- |
| `STELLAR_ALERTS_API_URL` | `http://localhost:3001` | API base URL |
| `STELLAR_ALERTS_API_KEY` | — | Bearer token (or pass `--token`) |

## `stream watch`

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

### Reconnect

When the connection fails or the server closes it, the CLI reconnects with exponential backoff (1s, 2s, 4s … capped at `--max-backoff`, with jitter across the upper half of each step). The backoff resets as soon as a connection delivers a payment. `5xx`, `408` and `429` responses and network errors are retried. Other HTTP errors, such as `401` or `404`, exit straight away.

### Cursor and resume

After each payment is printed, the CLI atomically writes `{ cursor, lastId }` to the cursor file (it writes a temp file, then renames it over the old one). The cursor is the payment's `pagingToken` when the server sends one, otherwise its `id`. On reconnect or restart it is sent as `?cursor=<value>`. A missing or corrupted cursor file prints a warning and falls back to the live tail.

Delivery is **at-least-once**. The CLI never advances the cursor past a payment it has not finished handling, and it drops replayed payments by `id`, remembering the last 1,000 ids plus the saved `lastId` across restarts.

### Shutdown

`SIGINT` or `SIGTERM` closes the connection, lets the payment being handled finish, flushes its cursor, removes the signal handlers and exits `0`. A second signal exits immediately with code `130`.

### Compatibility

- With no cursor file (a fresh install, or `--no-resume`), the request is the same bare `GET /payments/stream` as before.
- `cursor` is an optional query parameter. A server that ignores it still works: the CLI drops the replayed payments, and a replay older than the id window shows up as duplicate output rather than a missed payment.
- To use cursors, a server should resume *after* the given `pagingToken`/`id` and may add `pagingToken` to each record.
