# Discord Interactive Alert Actions

Operators can **acknowledge**, **snooze**, or **re-route** a payment alert
directly from the Discord message instead of switching to the dashboard. The
alert embed ships with an action row of buttons; pressing one round-trips
through the API and updates the alert's action state.

## Button layout

Each alert message carries a single action row (Discord caps rows at 5
components):

| Button | `custom_id` | Effect |
|--------|-------------|--------|
| ✅ Acknowledge | `sa:v1:ack:<alertId>` | Marks the alert acknowledged by the operator. |
| ⏰ Snooze 1h | `sa:v1:snooze:<alertId>:3600` | Suppresses re-notification until the window elapses. |
| ⏰ Snooze 4h | `sa:v1:snooze:<alertId>:14400` | Same, four-hour window. |
| 🔀 Re-route | `sa:v1:reroute:<alertId>:<target>` | Routes the alert to another destination. |

`custom_id` format is `sa:v1:<action>:<alertId>[:<param>]`. The `sa:` namespace
prevents collisions with other bots, and the `v1` segment lets the format
evolve without breaking deployed messages.

Build the row server-side with `buildDiscordAlertComponents(alertId)` from
`apps/api/src/utils/discord.ts`. `dispatchDiscordAlert(url, data, { alertId })`
attaches them automatically.

## Endpoint

`POST /integrations/discord/interactions`

- Must be the **Interactions Endpoint URL** configured in the Discord
  Developer Portal.
- Every request is verified against the app's Ed25519 public key
  (`DISCORD_PUBLIC_KEY`) using the `X-Signature-Ed25519` and
  `X-Signature-Timestamp` headers. Verification uses the **raw** request body,
  so the route registers a scoped JSON content-type parser that captures the
  buffer before Fastify parses it.
- Timestamps outside a ±5 minute window are rejected as replays.
- Requests with a missing/malformed signature get `401`; an unconfigured
  `DISCORD_PUBLIC_KEY` gets `503`.

The `PING` interaction (Discord's endpoint-verification handshake) is answered
with `{ "type": 1 }`. Button presses get an **ephemeral** (`flags: 64`)
confirmation so only the operator who clicked sees the result.

## Configuration

| Variable | Required | Description |
|----------|----------|-------------|
| `DISCORD_PUBLIC_KEY` | For the endpoint | Application public key from the Discord Developer Portal. When unset the route returns `503` and alert messages are still delivered without buttons. |

## State

`DiscordInteractionsService` writes action state through the
`DiscordAlertActionStore` interface:

- `InMemoryDiscordAlertActionStore` (default) keeps `acknowledged` /
  `snoozed` / `rerouted` state plus an append-only history per alert.
- For multi-instance deployments, implement the same interface against
  Redis/Prisma and pass it to the service constructor.

## Tests

`apps/api/src/modules/discord-interactions/__tests__/discord-interactions.test.ts`
covers signature verification (valid, tampered, stale, malformed), the
`custom_id` codec, component building, embed attachment, the PING handshake,
and each action's success and failure paths.
