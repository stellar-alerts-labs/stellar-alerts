# Idempotency keys

Correlation IDs (`x-request-id`, see [#44]) answer *"which log lines belong to
this request?"*. Idempotency keys answer a different question: *"has this exact
mutation already been applied?"*

Without them, a client that times out and retries `POST /wallets` creates two
wallets, and a proxy that duplicates a request does the same thing silently.

## Using it

Send an `Idempotency-Key` header on a mutating request. The value is yours to
generate — a UUIDv4 is the conventional choice, and it must be unique per
*operation*, not per user.

```bash
curl -X POST https://api.example.com/wallets \
  -H "Authorization: Bearer $TOKEN" \
  -H "Idempotency-Key: 8f14e45f-ceea-467a-9d1b-2b2e2b1b0c9a" \
  -H "Content-Type: application/json" \
  -d '{"publicKey":"G...","label":"Trading"}'
```

The header is **opt-in**: a request without it behaves exactly as before.

| Case | Response |
|---|---|
| First request | The handler runs. `idempotency-replayed: false` |
| Retry, same key and body | The stored response is replayed. The handler does **not** run. `idempotency-replayed: true` |
| Retry while the first is still in flight | `409 IDEMPOTENCY_IN_PROGRESS` |
| Same key, **different body** | `422 IDEMPOTENCY_KEY_REUSED` |
| Handler returned 5xx | The reservation is released, so the retry really re-runs |

The original status code is preserved on replay, so a retried `POST` that
returned `201` still returns `201`.

### Retry guidance

On `409`, wait briefly and retry with the **same** key. Do not generate a new
one — that defeats the purpose and applies the mutation twice.

On `422`, you reused a key for a different payload. Generate a fresh key; do not
retry with the same one.

## Which routes are guarded

Mutating routes only. Reads have no side effect to deduplicate and skip the
extra database round trip:

| Route | Guarded |
|---|---|
| `POST /wallets` | yes |
| `DELETE /wallets/:id` | yes |
| `POST /webhooks` | yes |
| `DELETE /webhooks/:id` | yes |
| `POST /dead-letters/:id/replay` | yes |
| `POST /dead-letters/:id/suppress` | yes |
| `POST /webhooks/:id/test` | **no** — deliberate, see below |
| all `GET` routes | no |

`POST /webhooks/:id/test` is excluded on purpose. It exists to trigger an
outbound delivery; replaying a stored response would make the second press look
like it worked when nothing was sent.

## Adding it to a new route

```ts
import { idempotencyHooks } from '../../middleware/idempotency.middleware';

const idempotent = idempotencyHooks();

app.post(
  '/things',
  {
    preValidation: idempotent.preValidation,
    onSend: idempotent.onSend,
    onResponse: idempotent.onResponse,
  },
  controller.create.bind(controller)
);
```

**Use `preValidation` for the reservation, not `onRequest`.** Fastify parses the
body between those two hooks, so in `onRequest` `request.body` is `undefined`.
A payload fingerprint computed there hashes nothing for every request, which
silently defeats the "same key, different body" check — the 422 branch becomes
unreachable and the replay path returns the wrong thing.

One `idempotencyHooks()` instance may be shared by several routes; the request
state is held in a `WeakMap`.

## Storage

Records live in the `IdempotencyKey` table:

| Column | Purpose |
|---|---|
| `key`, `scope` | Unique together. `scope` is `METHOD /route`, so the same key on two endpoints stays independent |
| `userId` | Owner, when the route is authenticated |
| `requestHash` | SHA-256 of the canonicalised body, for the 422 check |
| `status` | `in_progress` or `completed` |
| `statusCode`, `response` | Stored response for replay |
| `expiresAt` | Retention deadline |

Completed keys are replayable for **24 hours** by default. A concurrent
duplicate is detected by the unique index, not by a read-then-write check, so
two simultaneous retries cannot both run the handler.

### Retention

`reapExpiredIdempotencyKeys(batchSize)` deletes keys past `expiresAt`. Call it
from the scheduler; each run is bounded so it cannot hold a long transaction.

## Implementation note

The reservation is an `INSERT` and the unique index on `(key, scope)` is the
concurrency control. If the insert violates the constraint, the failing side
reads the existing row and decides: replay it, `409` if still in progress, or
`422` if the body differs. No advisory locks and no read-then-write race.

[#44]: https://github.com/stellar-alerts-labs/stellar-alerts/issues/44
