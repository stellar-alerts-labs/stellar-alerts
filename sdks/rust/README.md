# Stellar Alerts Webhook Signature Verification SDK (Rust)

Minimal Rust SDK for verifying Stellar Alerts webhook signatures with HMAC-SHA256, timestamp drift, and replay nonce protection.

## Installation

Add to `Cargo.toml`:

```toml
[dependencies]
stellar-alerts-webhook = "0.1.0"
```

## Usage

```rust
use stellar_alerts_webhook::WebhookVerifier;

let verifier = WebhookVerifier::new("your_webhook_secret", 300000); // 5 minutes tolerance

let result = verifier.verify(
    b"{\"event\": \"payment.received\"}",
    "t=1234567890,v1=abc123...",
    Some("unique_nonce_value"),
);

if result.is_valid() {
    println!("Signature valid");
} else {
    println!("Invalid signature: {}", result.error().unwrap_or("unknown"));
}
```

## Features

- HMAC-SHA256 signature verification
- Timestamp drift protection (configurable tolerance)
- Replay attack prevention via nonce checking
- Grace period for key rotation (48 hours)
