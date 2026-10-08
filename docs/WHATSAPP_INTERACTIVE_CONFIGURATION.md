# WhatsApp interactive alert configuration

The API can receive Meta WhatsApp Cloud API webhooks and offer a list message for common payment alert filters plus quick replies to enable or disable WhatsApp alerts. A user's WhatsApp number must already be linked to their notification preferences. Inbound messages are matched against the encrypted preference number; unknown senders are ignored.

## Setup

Configure `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_APP_SECRET`, and `WHATSAPP_WEBHOOK_VERIFY_TOKEN` from the Meta app and WhatsApp Business account. Set the Meta webhook callback URL to `https://<api-host>/notifications/whatsapp/webhook`, subscribe it to the `messages` field, and enter the same verify token in Meta. `WHATSAPP_GRAPH_API_VERSION` is optional and defaults to `v23.0`.

The callback verifies Meta's `X-Hub-Signature-256` against the raw request bytes and rejects requests when the app secret is absent or invalid. The phone number ID in each event must match the configured sender. Replies update the existing `minAmount`, `assetFilters`, and `whatsappEnabled` preferences. Threshold choices are 10, 50, and 100; asset choices are all assets, XLM, and USDC.

Outgoing payment receipts continue using the configured Twilio credentials. Cloud API credentials are used only for interactive configuration messages. Deployments that do not configure the Meta variables retain existing delivery behavior and should not register the callback in Meta.
