# Slack Slash Commands (`/stellar`)

Stellar Alerts ships a Slack App that lets users query wallet status directly
from Slack with the `/stellar` command (issue #452). Responses are **ephemeral**
— visible only to the invoking user — and every request is **cryptographically
verified** against Slack's signature scheme before any data is returned.

## Commands

| Command | Description |
| --- | --- |
| `/stellar balance <address>` | Current XLM and asset balances for a tracked wallet, fetched live from Horizon |
| `/stellar alerts <address>` | Alert rules that apply to a tracked wallet (wallet-scoped plus user-wide rules) |
| `/stellar help` (or bare `/stellar`) | Command reference |

Wallets must already be registered in Stellar Alerts (via the web app) before
they can be queried from Slack; unregistered or malformed addresses receive a
helpful ephemeral hint instead of an error stack.

## Setup

1. **Create the Slack App from the manifest.** In Slack app settings choose
   *Build App → From an app manifest* and paste [`slack-app-manifest.yml`](../slack-app-manifest.yml)
   (repo root). Replace the `<your-api-host>` placeholder in the `/stellar`
   command request URL with the publicly reachable host of this API
   (e.g. `https://api.example.com`).
2. **Configure the signing secret.** Copy the *Signing Secret* shown under
   *App Credentials* and set it in the API environment:
   ```
   SLACK_SIGNING_SECRET=<your signing secret>
   ```
3. **Install the app to your workspace** and invite the bot to the channels
   where users should be able to run `/stellar`.

The endpoint is `POST /slack/commands` (see `apps/api/src/modules/slack/`).

## Request verification

The route verifies every request exactly as documented in
[Slack — Verifying requests from Slack](https://api.slack.com/authentication/verifying-requests-from-slack):

- Base string: `v0:{x-slack-request-timestamp}:{raw request body}`
- Signature: HMAC-SHA256 of the base string with `SLACK_SIGNING_SECRET`,
  hex-encoded, sent as the `v0=`-prefixed `x-slack-signature` header.
- The HMAC is computed over the **raw body bytes** — the module registers a
  pass-through `application/x-www-form-urlencoded` content-type parser scoped
  to the Slack routes only, so signature verification is never defeated by
  re-serialization.
- Requests whose timestamp is more than **5 minutes** from the server clock are
  rejected (`stale_timestamp`) to blunt replay attacks.
- Comparisons are timing-safe (`crypto.timingSafeEqual`).

Failure modes:

| Condition | Response |
| --- | --- |
| Missing / stale / invalid signature | `401` with `reason` field |
| `SLACK_SIGNING_SECRET` not configured | `503` (fail closed) |
| Body missing required Slack fields | `400` |
| Valid command | `200` with `{ response_type: "ephemeral", text }` |

## Configuration

| Variable | Required | Purpose |
| --- | --- | --- |
| `SLACK_SIGNING_SECRET` | For the Slack route | HMAC secret from the Slack App credentials page. Optional globally so the API stays bootable without Slack configured; the route refuses to serve (503) while it is unset. |

No database migrations are required — the feature only reads the existing
`Wallet` and `AlertRule` tables.

## Testing

Focused automated tests live in `apps/api/src/modules/slack/__tests__/`:

- `slack.signature.test.ts` — signature scheme, replay window, fail-closed
- `slack.service.test.ts` — command routing, address validation, balance and
  alert-rule formatting (Prisma and Horizon mocked)
- `slack.routes.test.ts` — end-to-end Fastify `inject` tests covering signed
  requests, tampering, replay, and the fail-closed path

Run them with:

```bash
npm run test:api -- src/modules/slack
```

## Compatibility and rollout

- **Additive rollout.** The feature is a new route plus one new optional env
  var; existing routes, auth flows, and the database schema are untouched, so
  it can be enabled by deploying the API and creating the Slack App — no
  migration or data backfill.
- **Per-environment enablement.** Environments without `SLACK_SIGNING_SECRET`
  keep serving all other traffic; only the Slack route fails closed.
- **Rate limiting.** The global `@fastify/rate-limit` budget applies to
  `/slack/commands` as well, which protects against accidental Slack retry
  storms.
- **Timeouts.** Responses are sent synchronously (JSON in the HTTP response),
  well within Slack's 3-second cutoff; Horizon lookups reuse the configured
  `HORIZON_REQUEST_TIMEOUT_MS` deadline.
