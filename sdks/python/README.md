# Stellar Alerts Webhook Signature Verification SDK (Python)

Minimal Python SDK for verifying Stellar Alerts webhook signatures with HMAC-SHA256, timestamp drift, and replay nonce protection.

## Installation

```bash
pip install stellar-alerts-webhook
```

## Usage

```python
from stellar_alerts_webhook import WebhookVerifier

verifier = WebhookVerifier(
    secret="your_webhook_secret",
    tolerance_ms=300000  # 5 minutes default
)

# Verify webhook signature
result = verifier.verify(
    payload=b'{"event": "payment.received"}',
    signature_header="t=1234567890,v1=abc123...",
    nonce="unique_nonce_value"
)

if result.valid:
    print("Signature valid")
else:
    print(f"Invalid signature: {result.error}")
```

## Features

- HMAC-SHA256 signature verification
- Timestamp drift protection (configurable tolerance)
- Replay attack prevention via nonce checking
- Grace period for key rotation (48 hours)
