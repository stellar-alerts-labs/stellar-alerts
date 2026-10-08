# Telegram Mini App — Alert Triage & Filter Tuning

The Stellar Alerts bot embeds a Telegram [Mini App](https://core.telegram.org/bots/webapps)
that lets mobile users triage alerts and tune filters without leaving the chat:

- **Live alert feed** — recent `NotificationDelivery` rows for the user.
- **Notification routes** — toggle Telegram / Email / WhatsApp / Discord / Slack / Push.
- **Asset thresholds** — set or clear a per-asset minimum amount.
- **Native haptics** — impact/notification/selection cues on every interaction.

## Cryptographic authentication

Every Mini App request re-verifies the signed `initData` handed to the WebApp by
the Telegram client, using the shared HMAC-SHA256 validator in
`apps/api/src/utils/telegram.ts`:

```
secret_key = HMAC_SHA256(key = "WebAppData", message = <bot_token>)
hash       = HMAC_SHA256(key = secret_key,   message = data_check_string)
```

Because these endpoints mutate notification routing, they verify `initData`
per-request (via the `X-Telegram-Init-Data` header) rather than trusting a
longer-lived bearer token. A stale `auth_date` (default > 24h) is rejected as
`EXPIRED`, and a mismatched hash as `INVALID_SIGNATURE`.

## API

All endpoints require the `X-Telegram-Init-Data` header (the raw signed
`initData` string).

| Method | Path | Purpose |
| ------ | ---- | ------- |
| `GET`  | `/notifications/telegram/miniapp/state` | Bootstrap: routes + thresholds + feed. |
| `GET`  | `/notifications/telegram/miniapp/feed?feedLimit=N` | Live feed only (N clamped to 1–100, default 20). |
| `POST` | `/notifications/telegram/miniapp/routes` | Body `{ route, enabled }` — toggle a route. |
| `POST` | `/notifications/telegram/miniapp/thresholds` | Body `{ asset, minAmount }` — `minAmount: null` clears. |

Per-asset thresholds are stored inside `NotificationPreference.filterRules` JSON
under an `assetThresholds` map (upper-cased asset codes), so the feature is
migration-free and preserves any existing filter blob.

## Files

| File | Responsibility |
| ---- | -------------- |
| `apps/api/src/modules/notifications/telegram-miniapp.service.ts` | initData auth + route/threshold/feed logic. |
| `apps/api/src/modules/notifications/telegram-miniapp.controller.ts` | Per-request `initData` verification + HTTP handlers. |
| `apps/web/src/app/tma/alert-triage.tsx` | Mini App triage panel. |
| `apps/web/src/app/tma/alert-triage.helpers.ts` | Pure formatting/validation helpers. |
| `apps/web/src/app/tma/haptics.ts` | Telegram HapticFeedback wrapper. |

## Tests

- `apps/api/src/modules/notifications/__tests__/telegram-miniapp.service.test.ts` — signature verification, route mapping, threshold merge math.
- `apps/web/src/app/tma/alert-triage.helpers.test.tsx` — feed formatting, status badges, threshold parsing, optimistic route toggling.
