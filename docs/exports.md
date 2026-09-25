# Asynchronous Export Jobs

Large CSV/PDF exports are generated in the background by the export worker
instead of inside the HTTP request. A client starts a job, polls its progress,
and downloads the file through a short-lived signed URL. Files expire and are
cleaned up automatically.

## Export types

| `type` | Output | Parameters | Default period |
|---|---|---|---|
| `ledger_csv` | Ledger statement CSV (same columns as the emailed statement) | `walletId?`, `periodStart?`, `periodEnd?` | trailing 365 days |
| `ledger_pdf` | Ledger statement PDF | `walletId?`, `periodStart?`, `periodEnd?` | trailing 365 days |
| `tax_csv` | Tax-software CSV | `walletId?`, `periodStart?`, `periodEnd?`, `format?` (`cointracker` \| `koinly` \| `irs8949`, default `cointracker`) | full history |

Dates accept `YYYY-MM-DD` (a date-only `periodEnd` includes that whole day) or
an ISO date-time with offset. `walletId` must belong to the caller.

## API

All endpoints except the download are authenticated with the usual bearer JWT.

### `POST /exports` → `202 Accepted`

```bash
curl -X POST http://localhost:3001/exports \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"type":"ledger_pdf","periodStart":"2026-01-01","periodEnd":"2026-03-31"}'
```

```json
{ "success": true, "export": { "id": "cm…", "status": "queued", "progress": 0, "download": null, "…": "…" } }
```

The `Location` header points at the status endpoint. Errors: `400` invalid
body, `404 WALLET_NOT_FOUND`, `429 TOO_MANY_ACTIVE_EXPORTS` (more than
`EXPORT_MAX_ACTIVE_JOBS_PER_USER` jobs queued/running).

### `GET /exports/:id`

Returns `status` (`queued` → `running` → `completed` | `failed`, later
`expired`), `progress` (0–100), `rowsTotal`, `rowsProcessed` and, on failure,
a user-safe `error`. When the job is `completed` and not yet expired it also
returns:

```json
"download": { "url": "/exports/cm…/download?expires=1790000000&sig=…", "expiresAt": "…" }
```

A new URL is signed on every call, valid for
`EXPORT_DOWNLOAD_URL_TTL_SECONDS` (never beyond the file's own expiry).
Another user's job id returns `404`, the same as a missing one.

### `GET /exports`

Lists the caller's jobs, newest first (`page`, `pageSize` ≤ 100).

### `GET /exports/:id/download?expires=…&sig=…`

Streams the file as an attachment (`Cache-Control: private, no-store`). The
signed query string is the credential, so the URL works from a plain browser
navigation without a bearer token.

| Status | Code | Meaning |
|---|---|---|
| `403` | `INVALID_DOWNLOAD_LINK` | Missing, malformed or tampered signature, or unknown job |
| `403` | `DOWNLOAD_LINK_EXPIRED` | The link elapsed; fetch a fresh one from `GET /exports/:id` |
| `409` | `EXPORT_NOT_READY` | Job is still queued/running, or failed |
| `410` | `EXPORT_EXPIRED` | The file passed `expiresAt` and was (or is about to be) deleted |

## Security model

- **Owner scoping.** Every job query filters by the authenticated `userId`, and
  wallet filters are re-checked against the owner both at creation and during
  generation.
- **Signed downloads.** The signature is HMAC-SHA256 over
  `jobId:ownerUserId:expires`. The key is derived from `JWT_SECRET` with a
  fixed label. Comparison is constant time. The owner id is signed but not put
  in the URL, so a link cannot be reused for another job or user, or past its
  expiry. Rotating `JWT_SECRET` invalidates all outstanding links.
- **No user-controlled paths.** Files are stored as `<jobId>.<csv|pdf>`. The
  storage layer rejects any name that is not a plain basename.
- **Safe errors.** Only `ExportError` messages, such as the row-limit message,
  are shown to users. Unexpected failures are logged and recorded as a generic
  message.

## Processing and cleanup

1. `POST /exports` inserts an `ExportJob` row and enqueues its id on the
   `export-jobs` BullMQ queue.
2. The worker atomically claims the row (`queued` → `running`), so a
   duplicate delivery is a no-op. It then counts the matching payments and
   rejects the job if there are more than `EXPORT_MAX_ROWS`.
3. It reads payments with keyset pagination in batches of
   `EXPORT_BATCH_SIZE`, updating `progress` after each batch: 0–90% while
   reading, then 100% once the file is written.
4. The file is written to a `.tmp` file and renamed into place. The job is
   marked `completed` with `expiresAt = completedAt + EXPORT_TTL_SECONDS`.
5. Every `EXPORT_CLEANUP_INTERVAL_MS` the cleanup pass does three things:
   - deletes files of completed jobs past `expiresAt` and marks those jobs
     `expired`;
   - fails jobs that stayed `queued`/`running` longer than
     `EXPORT_STALE_JOB_MS` without progress, for example after a worker crash;
   - removes stale `.tmp` files.

Job rows are kept after expiry as history. They are deleted with the user
(`ON DELETE CASCADE`).

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `EXPORT_WORKER_ENABLED` | `true` | `true`: jobs go to the export worker (`npm run dev:exports`, or spawned by the supervisor). `false`: jobs and cleanup run inside the API process. |
| `EXPORT_STORAGE_DIR` | `<os tmpdir>/stellar-alerts-exports` | Where files are written. **The API and the worker must see the same directory.** |
| `EXPORT_TTL_SECONDS` | `86400` | How long a finished file stays downloadable |
| `EXPORT_DOWNLOAD_URL_TTL_SECONDS` | `300` | Lifetime of each signed download URL |
| `EXPORT_MAX_ROWS` | `100000` | Row cap per export |
| `EXPORT_BATCH_SIZE` | `500` | Payments read per batch / progress update |
| `EXPORT_MAX_ACTIVE_JOBS_PER_USER` | `3` | Concurrent queued/running jobs per user |
| `EXPORT_WORKER_CONCURRENCY` | `2` | Jobs processed in parallel per worker |
| `EXPORT_CLEANUP_INTERVAL_MS` | `600000` | Cleanup pass interval |
| `EXPORT_STALE_JOB_MS` | `1800000` | Idle time after which a queued/running job is failed |

## Compatibility and rollout

- **Additive.** The existing synchronous endpoints are unchanged and keep
  their current behaviour, including the 5,000-row cap:
  - `GET /payments/tax-export`
  - `GET /payments/export/pdf`

  Clients can move to `/exports` at their own pace. Deprecating the
  synchronous endpoints is left as a separate follow-up.
- **Migration.** `20261003000000_add_export_jobs` only creates the `ExportJob`
  table, so it is safe to apply before deploying the new code.
- **Deploy order.** Apply the migration, deploy the API, then start the export
  worker. Until the worker is running, queued jobs wait in Redis. If Redis is
  unreachable, or does not accept the job within 5 seconds, the API processes
  the job in-process instead so exports still complete.
- **Shared storage.** When the API and the worker run on different hosts or
  pods, mount the same volume at `EXPORT_STORAGE_DIR` on both. Otherwise
  downloads return `410`. For a single-host setup, or to skip the worker
  entirely, set `EXPORT_WORKER_ENABLED=false`.
- **Rollback.** Stop the worker and roll back the API. The `ExportJob` table
  can stay, since nothing else reads it.
