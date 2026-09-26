# Service Level Objectives (SLOs) & End-to-End Tracing Architecture (#275)

## Overview

StellarAlerts provides high-reliability, real-time alert notifications for transactions across Stellar Classic and Soroban smart contract operations. This document outlines our Service Level Objectives (SLOs), Service Level Indicators (SLIs), W3C trace propagation standard, and privacy sanitization pipeline.

---

## Service Level Objectives (SLOs)

| Category | Metric / SLI | Target Objective | Measurement Window | Alert Threshold |
| :--- | :--- | :--- | :--- | :--- |
| **Ingestion Latency** | P95 latency from Horizon/Soroban event emission to ingestion queue | **< 200 ms** | 5-minute rolling window | P95 > 200 ms for 3 consecutive cycles |
| **Delivery Success Rate** | Percentage of webhook & provider alerts delivered (2xx responses) | **≥ 99.9%** | 24-hour window | Success rate < 99.5% |
| **API Availability** | Uptime of Fastify HTTP endpoints & WebSocket stream gateway | **≥ 99.9%** | 30-day window | Error rate (5xx) > 0.1% |

---

## End-to-End W3C Trace Context Propagation

All operations carry W3C-compliant trace headers through every stage of the lifecycle:

```
[Horizon / Soroban Ingestion]
        │ (x-correlation-id / traceparent)
        ▼
[Rules Evaluation Engine]
        │ (traceparent embedded in job.data)
        ▼
[BullMQ Dispatch Worker]
        │ (x-correlation-id + traceparent in HTTP headers)
        ▼
[External Provider (Webhook / Telegram / Email)]
```

### Trace Headers Standard

1. **`traceparent`**: Standard W3C Trace Context string formatted as:
   `00-{32 hex traceId}-{16 hex spanId}-01`
2. **`x-correlation-id`**: Unique request/event correlation identifier preserved end-to-end for log aggregation in Grafana / Loki.
3. **`x-request-id`**: Client-originated or gateway-assigned request ID echoed on all HTTP responses.

---

## Privacy Sanitization & Redaction

To maintain compliance and protect user credentials, all telemetry spans, logs, and trace attributes automatically pass through `sanitizePayloadForTrace()`.

### Redacted Fields
- `authorization` / `auth` / `bearer`
- `token` / `mfaToken` / `secret`
- `password` / `apiKey` / `privateKey`
- `email` / `telegramChatId` / `phoneNumber`

All redacted fields are replaced with `"[REDACTED]"` before reaching OpenTelemetry exporters or log sinks.
