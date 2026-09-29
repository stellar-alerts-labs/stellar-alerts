# WhatsApp interactive alert configuration

Stellar Alerts supports Meta WhatsApp Business Cloud API interactive list and
reply-button messages for configuring the legacy notification threshold from a
WhatsApp chat. Existing Twilio payment delivery remains available and is not
changed by this feature.

Set `WHATSAPP_CLOUD_API_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, and
`WHATSAPP_WEBHOOK_VERIFY_TOKEN` in the API environment. Optionally set
`WHATSAPP_CLOUD_API_VERSION` (default `v21.0`). Configure Meta's webhook URL as
`GET/POST /webhooks/whatsapp`, subscribe to `messages`, and use the same verify
token. The sender's E.164 number must already be saved in notification
preferences; inbound messages never create an unverified account link.

The list choices update `NotificationPreference.filterRules` with an inclusive
minimum amount rule and enable WhatsApp alerts. The quick actions enable or
disable WhatsApp alerts, or reopen the threshold list. If Cloud API settings
are absent, the webhook acknowledges unrelated events but returns `503` for an
interactive action, allowing rollout behind environment configuration.

The webhook intentionally acknowledges malformed/non-interactive events and
does not echo message text. Provider access tokens are only read from the
environment and are never persisted or included in responses.
