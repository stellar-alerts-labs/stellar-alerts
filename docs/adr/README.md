# Architecture Decision Records

Concise records of the decisions that shape ingestion, queueing, and notification
delivery. Each ADR documents the decision as it is **implemented today**, the
tradeoffs accepted, and the consequences a contributor needs to know before
changing the code.

These are not proposals. Where the current code has a known gap, the ADR says so
in a "Known gaps" section rather than describing an intended future state.

## Index

| ADR | Decision | Status |
|---|---|---|
| [0001](0001-horizon-cursor-ingestion.md) | Horizon paging-token cursors with bounded backfill for on-chain ingestion | Accepted |
| [0002](0002-bullmq-payment-alert-queue.md) | BullMQ on Redis for the payment-alert queue and its dead-letter path | Accepted |
| [0003](0003-notification-delivery-idempotency.md) | Content-addressed delivery keys with a Redis gate and Postgres uniqueness for notification idempotency | Accepted |

## Related documents

- [`../DELIVERY_LIFECYCLE.md`](../DELIVERY_LIFECYCLE.md) — the delivery state
  machine and its database constraints.
- [`../AUTH_TOKEN_ROTATION.md`](../AUTH_TOKEN_ROTATION.md) — auth token design.
- [`../ARCHITECTURE.md`](../../ARCHITECTURE.md) — repository layout and
  component overview.
- [`../CONTRIBUTING.md`](../../CONTRIBUTING.md) — development workflow.

## Format

Each ADR follows the same shape:

- **Status** — Accepted / Superseded.
- **Context** — the forces that made a decision necessary.
- **Decision** — what the code does, with `file:line` citations.
- **Tradeoffs** — what was given up, stated plainly.
- **Known gaps** — divergence between the design and the implementation.

## Adding an ADR

1. Take the next unused number in `0001`-style naming.
2. Follow the section order above.
3. Cite code as `path/to/file.ts:line` so a reader can verify every claim.
4. Record the tradeoffs, including the ones that hurt. An ADR with no
   acknowledged downside is usually an untested decision.
5. Add a row to the index in this file and link it from
   [`../../CONTRIBUTING.md`](../../CONTRIBUTING.md).
