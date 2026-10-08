# Stellar Alerts Webhook Signature Verification SDK (Go)

Minimal Go SDK for verifying Stellar Alerts webhook signatures with HMAC-SHA256, timestamp drift, and replay nonce protection.

## Installation

```bash
go get github.com/stellar-alerts-labs/stellar-alerts/sdks/go
```

## Usage

```go
package main

import (
    "fmt"
    "github.com/stellar-alerts-labs/stellar-alerts/sdks/go"
)

func main() {
    verifier := webhook.NewVerifier("your_webhook_secret", 300000) // 5 minutes tolerance
    
    result := verifier.Verify(
        []byte(`{"event": "payment.received"}`),
        "t=1234567890,v1=abc123...",
        "unique_nonce_value",
    )
    
    if result.Valid {
        fmt.Println("Signature valid")
    } else {
        fmt.Printf("Invalid signature: %s\n", result.Error)
    }
}
```

## Features

- HMAC-SHA256 signature verification
- Timestamp drift protection (configurable tolerance)
- Replay attack prevention via nonce checking
- Grace period for key rotation (48 hours)
