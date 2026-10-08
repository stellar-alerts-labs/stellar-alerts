# ADR 0003: Content-addressed delivery keys with a Redis gate and Postgres uniqueness for notification idempotency

- **Status**: Accepted
- **Subsystem**: Notification delivery
- **Primary code**: `apps/api/src/lib/delivery.ts`, `apps/api/src/lib/queue.ts`, `apps/api/prisma/schema.prisma`, `apps/api/src/lib/dead-letter.ts`

## Context

A single payment fans out to several destinations. Retries happen at two
independent layers — BullMQ retries the job (ADR 0002) and each channel's provider
may fail transiently — and the same payment can be enqueued twice by the ingestion
race described in ADR 0001. A user receiving "payment received" three times for one
on-chain payment is a correctness bug, not a cosmetic one: it erodes trust in the
alert that exists to be trusted.

The difficulty is that "did we already send this?" cannot be answered by the
process that is trying to send it, because the process that might be sending the
same thing concurrently is a different worker. Duplicate suppression therefore has
to be expressed somewhere both processes can see.

## Decision

### A delivery is identified by a content hash of (payment, channel, destination)

`buildDeliveryKey` is the foundation of the whole model
(`apps/api/src/lib/delivery.ts:93`):

```ts
export function buildDeliveryKey(
  paymentId: string,
  channel: DeliveryChannel | string,
  destination: string,
): string {
  return crypto
    .createHash('sha256')
    .update(`${paymentId}:${channel}:${destination}`)
    .digest('hex');
}
```

The key is *derived*, not allocated. Two independent code paths that agree on
`(paymentId, channel, destination)` produce the same key with no coordination,
which is what lets a BullMQ retry, a DLQ replay, and a concurrently enqueued
duplicate job all collide on the same row.

`destination` is channel-appropriate: a webhook `id` for webhook, a recipient
email for email, a chat id for Telegram. Two webhooks on the same payment are
distinct deliveries; the same webhook across two payments is a distinct delivery.

### Postgres uniqueness is the durable backstop

`NotificationDelivery` carries two constraints that must both hold
(`apps/api/prisma/schema.prisma:479`):

```prisma
deliveryKey String @unique
...
@@unique([paymentId, channel, destination])
```

and `NotificationDeliveryAttempt` enforces one row per attempt number per key
(`apps/api/prisma/schema.prisma:523`):

```prisma
@@unique([deliveryKey, attempt])
```

The attempt table is append-only history. The `deliveryKey` uniqueness is what
makes "already sent?" answerable by any process at any time, and it survives a
Redis outage because it does not depend on Redis.

### The delivery lifecycle is an explicit state machine

`VALID_LIFECYCLE_TRANSITIONS` (`apps/api/src/lib/delivery.ts:39`) makes terminal
states absorbing:

```ts
pending: ['in_progress', 'suppressed', 'skipped'],
in_progress: ['delivered', 'failed', 'exhausted', 'suppressed'],
failed: ['in_progress', 'exhausted', 'suppressed'],
delivered: [],
exhausted: [],
suppressed: [],
skipped: [],
```

`validateDeliveryTransition` throws on any transition out of a terminal state
(`apps/api/src/lib/delivery.ts:49`), and `recordDeliveryAttempt` independently
rejects recording an attempt against a terminal delivery
(`apps/api/src/lib/delivery.ts:235`). The rule is therefore enforced at two
levels: a helper, and a check on the write path. The full model is documented in
[`../DELIVERY_LIFECYCLE.md`](../DELIVERY_LIFECYCLE.md).

### A Redis gate serializes concurrent dispatch, and fails open

Concurrent jobs for the same key must not both talk to the provider.
`acquireDeliveryGate` is a `SET NX PX` lock with a 30s TTL and 2 retries
(`apps/api/src/lib/delivery.ts:110`). Release is a compare-and-delete Lua script
so a worker cannot release a lock it no longer owns
(`apps/api/src/lib/delivery.ts:79`):

```ts
const RELEASE_GATE_LUA_SCRIPT = `
  if redis.call("get", KEYS[1]) == ARGV[1] then
    return redis.call("del", KEYS[1])
  else
    return 0
  end
`;
```

The gate **fails open** when Redis is unavailable
(`apps/api/src/lib/delivery.ts:124`):

```ts
} catch (err: any) {
  // Redis is unavailable. Fail open: gate contention serialization degrades,
  // but delivery availability must not depend on Redis. The persisted
  // `alreadyDelivered` source of truth in Postgres still prevents replays.
  log.warn({ err: err.message }, 'Redis acquire delivery gate error; failing open');
  return token;
}
```

This is the central tradeoff of the ADR, and it is deliberate. A gate that fails
*closed* would mean a Redis blip silently discards user notifications. Failing
open means concurrent duplicate requests may both reach the provider, but
correctness still holds because the Postgres-backed `alreadyDelivered` check
runs again immediately before dispatch.

### The dispatch path is a double-checked sequence

`deliverWithIdempotency` (`apps/api/src/lib/delivery.ts:398`) is the only
supported entry point, and its ordering is the whole design:

1. `alreadyDelivered(deliveryKey)` → if terminal, return `skipped` without
   contacting the provider.
2. `acquireDeliveryGate(deliveryKey)` → if contended, **re-check
   `alreadyDelivered`** and return; the holder is mid-flight or just finished.
3. `alreadyDelivered(deliveryKey)` again, now holding the gate.
4. `recordDeliveryAttempt(...)` → appends the attempt row.
5. `dispatch(attemptId)` → the only provider call.
6. `markDeliveryDelivered(attemptId)`.
7. `releaseDeliveryGate` in a `finally`, so a throw cannot leak the lock.

Step 2's re-check is the part that makes the open gate safe. Losing the gate race
is not itself treated as a duplicate — the persisted state is consulted again to
find out what actually happened.

`alreadyDelivered` consults two sources in order
(`apps/api/src/lib/delivery.ts:165`): the `NotificationDelivery` row's status
first, then the attempt table for a `delivered` attempt. The first is wrapped in a
`try`/`catch` that falls through, so the layer degrades to the attempt table
rather than throwing if the delivery table is unavailable.

### Per-channel behavior: the layer is not uniformly adopted

`deliverWithIdempotency` wraps exactly two call sites — webhook
(`apps/api/src/lib/queue.ts:593`) and email (`apps/api/src/lib/queue.ts:730`).
Other channels use weaker, channel-specific mechanisms:

| Channel | Mechanism | Source |
|---|---|---|
| Webhook | `deliverWithIdempotency` + per-webhook circuit breaker | `queue.ts:593` |
| Email | `deliverWithIdempotency` | `queue.ts:730` |
| WhatsApp | `whatsAppDeliveryLog.findFirst({ success: true })` | `queue.ts:646` |
| Discord | `DeliveryLog` row keyed `(paymentId, channel)` | `queue.ts:683` |
| Slack | `DeliveryLog` row keyed `(paymentId, channel)` | `queue.ts:712` |
| Telegram | none — fire-and-forget with `.catch()` | `queue.ts:612` |
| Push | none | — |

The local `alreadyDelivered` in `queue.ts:89` is deliberately coarser than the
delivery-key one. Its own docstring explains why:

> Records a channel delivery attempt and skips re-dispatching a channel that
> already has a logged attempt for this payment, so BullMQ's job-level retry
> (5 attempts, exponential backoff) doesn't double-send to Discord/Slack on retry
> once a prior attempt already succeeded.

Discord and Slack are keyed on `(paymentId, channel)` with no `destination`, so a
user with two Slack webhooks would have them conflated. Telegram has no
idempotency at all and swallows its error.

### Webhook delivery has its own resilience layer

Webhooks are the only channel with a circuit breaker
(`apps/api/src/lib/queue.ts:133`, opossum):

- 10 requests in a 60s window, `errorThresholdPercentage: 100` → open.
- Open for 60s (`queue.ts:240`), then one half-open probe (`queue.ts:253`).
- 5xx throws; **429 is surfaced with its status and headers** attached
  (`queue.ts:155`) so the adaptive limiter can react to the provider's own
  backoff signal rather than treating it as a generic failure.

Breaker state is persisted per webhook in `WebhookCircuitBreaker`
(`updateCircuitBreakerState`, `queue.ts:183`), so a breaker survives a worker
restart and is shared across replicas — a process-local breaker would reset on
every deploy.

Before any dispatch: SSRF validation (`queue.ts:223`), adaptive per-domain
backoff (`queue.ts:260`), payload templating (`queue.ts:266`), and HMAC signing
via `generateWebhookSignature` (`queue.ts:282`). Every one of these can terminate
the attempt with a `WebhookLog` row and no provider call.

### Dead letters are the operator-facing terminal record

Terminal failures are persisted via `persistDeadLetter`
(`apps/api/src/lib/dead-letter.ts:27`) with the payload run through
`sanitizePayload` and the error truncated to 4000 chars. Payload sanitization
matters here because the payload is destined for an operator UI. Actions against
a dead letter are audited in `DeadLetterAudit` with `retry`/`suppress` and an
optional actor.

## Tradeoffs

**Exactly-once is not achievable; at-least-once plus deduplication is.** The
sequence is check → gate → dispatch → mark. A worker that crashes between
`dispatch` and `markDeliveryDelivered` leaves a sent notification that the
database believes was not sent, and the retry will send it again. The 30s gate TTL
bounds the window for a *concurrent* duplicate but not for a crash after the
provider call. Closing this would need provider-side idempotency keys, which
Telegram, Discord, Slack, and Twilio do not offer.

**Failing the gate open trades strict serialization for availability.** Under
Redis failure, two workers can reach the provider for the same key. This is
accepted because the Postgres check is the real guarantee; the gate is an
optimization that avoids wasted duplicate requests, not the correctness
mechanism.

**Terminal states are absorbing, which makes corrections impossible.** Once
`delivered`, a delivery can never be reopened. An operator who needs to resend
must create a new delivery, not transition the old one. This is what makes replay
safe, and it is also why there is no "undo".

**The delivery-key model is only fully adopted on two of seven channels.** Adding
a channel with bespoke deduplication is currently cheaper than routing it through
`deliverWithIdempotency`, and the cost of that choice is inconsistent guarantees
across channels. Consolidating would mean changing Telegram's behaviour (from
best-effort to guaranteed-once-attempt) and correcting Discord/Slack keying to
include destination.

**Circuit breakers add a persisted write per failure.** Breaker state lives in
Postgres, so breaker accounting costs a write per failing dispatch. The
alternative, an in-process breaker, cannot be shared across replicas and would
reset on deploy.

**Webhook failures are recorded but not always retried.** SSRF blocks, template
errors, and open-circuit skips all `return` after writing a `WebhookLog` row
without throwing, so BullMQ sees the job as successful and does not retry. This is
correct for permanent failures but means a transient SSRF-DNS blip is not retried.

## Known gaps

- **`validateDeliveryTransition` and `markDeliveryFailed` are test-only.**
  `validateDeliveryTransition` (`delivery.ts:49`) is called only from
  `delivery-lifecycle.test.ts`; `markDeliveryFailed` (`delivery.ts:334`) only from
  `delivery-lifecycle.test.ts:236,262`. Neither is on a production path, so the
  `failed` and `exhausted` states in `VALID_LIFECYCLE_TRANSITIONS` are not
  currently written. `isTerminalDeliveryStatus` is live
  (`delivery.ts:172`, `:234`). A delivery that fails mid-dispatch is left
  `in_progress` rather than transitioning to `failed`/`exhausted`.
- **Two coexisting `alreadyDelivered` functions with different key granularity.**
  `queue.ts:89` (payment + channel) and `delivery.ts:165` (delivery key). Both
  are live, for different channels. Discord and Slack conflate multiple
  destinations for one user; see the per-channel table.
- **Telegram has no idempotency and swallows all errors.** `queue.ts:612-631`
  awaits `fetchWithTimeout(...).catch(console.warn)`, so a failed Telegram send
  neither retries nor dead-letters. The user is never told the alert was lost.
- **Push notifications have no idempotency and no rate budget.**
  `dispatchPushNotification` is re-exported (`queue.ts:790`) and referenced only
  from tests (`push-protocol.test.ts`, `e2e.test.ts:200`) — never from
  `processAlertDispatch`. Push delivery is therefore implemented and tested in
  isolation but not wired into the notification fan-out.
- **The `notificationDelivery` client is accessed via `as any`.**
  `getOrCreateDelivery`, `recordDeliveryAttempt`, and `alreadyDelivered` cast
  `prisma as any` (`delivery.ts:168`, `:197`, `:229`, `:252`, `:271`, `:309`, `:319`, `:344`, `:353`, `:373`), and the terminal-state
  check in `recordDeliveryAttempt` is wrapped in a `try`/`catch` that rethrows only
  if the message contains `"terminal state"`
  (`delivery.ts:240`). A Prisma error with a different message is swallowed and
  the write proceeds. The cast is not currently type-checked against the schema.
- **`getOrCreateDelivery` and `markDeliverySuppressed` are unreferenced by the
  dispatch path.** Both are called only from `delivery-lifecycle.test.ts`
  (`:79-80` and `:275`). `deliverWithIdempotency` relies on
  `recordDeliveryAttempt` to create the `NotificationDelivery` row as a side
  effect, so the intended create-or-get entry point is bypassed. Consequently the
  `suppressed` state is never reached in production either.
- **Dead-letter dedup only applies when `deliveryKey` is known.** The queue-level
  capture in `queue.ts:475` passes no `deliveryKey`, so it always writes a new row
  and relies on `removeOnFail: 500` plus the `dlq-${jobId}` job id for
  deduplication instead.
