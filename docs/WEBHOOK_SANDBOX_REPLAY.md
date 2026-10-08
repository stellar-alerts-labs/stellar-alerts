# Webhook Dead-Letter Sandbox Replay & Mock Response Inspector (#456)

Administrative endpoints that let a developer replay a failed webhook
notification against a **simulated sandbox receiver**, then inspect the exact
request a receiver would have observed (headers, signed payload, body) and the
receiver's mock response (status, headers, body, delay), with end-to-end
timing — all without touching a real destination.

## Endpoints

All routes live under the authenticated `dead-letters` router
(`authenticateHook` pre-handler; per-user scoping on every query).

| Method | Path | Purpose |
| ------ | ---- | ------- |
| `POST` | `/dead-letters/:id/replay-sandbox` | Replay one dead letter against the sandbox receiver |
| `GET`  | `/dead-letters/sandbox-replays` | List the caller's sandbox inspections (paginated, filterable by `status`) |
| `GET`  | `/dead-letters/sandbox-replays/:replayId` | Fetch one inspection record |

### Replaying

```http
POST /dead-letters/dl-123/replay-sandbox
Content-Type: application/json

{
  "mockResponse": {
    "status": 500,
    "headers": { "X-Mock-Header": "1" },
    "body": "{\"error\":\"receiver exploded\"}",
    "delayMs": 250
  }
}
```

`mockResponse` is optional; defaults are `{ status: 200, headers: {}, body: "", delayMs: 0 }`.
Constraints: `status` 100–599, at most 50 headers, body ≤ 64 KB, `delayMs` 0–5000
(capped so a replay can never stall API workers).

### Response

```json
{
  "success": true,
  "replay": {
    "id": "sr-…",
    "status": "completed",
    "request": {
      "envelope": { "event": "payment.received", "timestamp": "…", "data": { "paymentId": "…", "amount": "125.50", "asset": "XLM", "…": "…" } },
      "body": "{\"event\":\"payment.received\",…}",
      "headers": {
        "Content-Type": "application/json",
        "User-Agent": "StellarAlerts-Sandbox/1.0",
        "X-Stellar-Signature": "t=1727…,v1=<hmac-sha256>",
        "X-Stellar-Sandbox-DeadLetter-Id": "dl-123"
      }
    },
    "response": {
      "status": 500,
      "headers": { "X-Mock-Header": "1", "X-Stellar-Sandbox": "mock-response" },
      "body": "{\"error\":\"receiver exploded\"}",
      "delayMs": 250
    },
    "durationMs": 251,
    "error": null,
    "createdAt": "…"
  }
}
```

`success` reflects the mock receiver verdict: `response.status` in `[200, 300)`.
Everything a receiver integration needs to be debugged is in the record:
envelope, exact body bytes, live HMAC signature, response, and timing.

## How it works

- **In-process receiver.** The sandbox receiver is a pure function — no socket
  is opened, no DNS is resolved, no HTTP request leaves the API process. This
  removes the entire SSRF surface that a real replay-against-URL feature would
  have (the same class of issue #312 guards against for webhooks), makes
  replays deterministic and instant, and means the real idempotency machinery
  (#272) is never at risk of a double-delivery.
- **Faithful request reconstruction.** `dead-letters.envelope.ts` rebuilds the
  canonical `payment.received` envelope from the dead letter payload (webhook
  channel dead letters already persist the full receiver envelope and are
  returned verbatim). The body is signed with the *real* webhook secret when it
  can be restored: for webhook-channel dead letters the destination IS the
  webhook URL, so the exact webhook row (and its encrypted secret) is resolved;
  otherwise the user's most recent webhook is used. If no secret is restorable,
  a clearly marked `t=0,v1=unsigned-sandbox-replay` header is emitted so the
  replay remains inspectable without implying validity.
- **Persisted inspection.** Every replay writes one `WebhookSandboxReplay` row
  (request envelope/headers/body, response status/headers/body/delay,
  `durationMs`, verdict). Replays appear in retention/DB tooling like any other
  table; deleting a dead letter cascades to its sandbox replays.

## Relationship to existing replay

`POST /dead-letters/:id/replay` (existing, #273) replays through the **real
dispatch pipeline** — BullMQ, providers, idempotency, audit. The sandbox
endpoints introduced here are the **dry, observable** counterpart: nothing is
dispatched anywhere, no delivery attempt rows are written, and the dead
letter's status/retry counters are untouched. Use real replay to actually
redeliver; use sandbox replay to develop and debug the receiver side.

## Configuration & rollout

- No new environment variables. No new services. The feature reuses Prisma,
  the crypto vault, and the standalone `KeyRotationManager`.
- Rollout is additive: one new table (`WebhookSandboxReplay`), three new
  routes, one new OpenAPI tag (`webhook-sandbox`) with three component
  schemas. The generated shared types (`packages/shared/src/generated/…`)
  gain the new operation types after running `npm run generate:types`.
- Backward compatibility: no existing route, schema, or behavior changes.
  The only touchpoint in existing code is extracting `toAlertJobData` into
  `dead-letters.envelope.ts` (a pure refactor; the real-replay path is
  unchanged and covered by the existing dead-letters test suite).
- Migration `20260928000000_add_webhook_sandbox_replay` is fully additive
  (create table + indexes + FKs); it can be applied online and reversed by
  dropping the table.

## Testing

`apps/api/src/modules/dead-letters/__tests__/webhook-sandbox.service.test.ts`
covers: full request/response capture, envelope rebuild (queue channel),
verbatim envelopes (webhook channel), unrenderable payloads, secret resolution
per channel, 5xx verdicts, cross-user isolation, delay/timing measurement,
persistence shape, list pagination, and schema validation bounds.
