# Webhook Dispatch Telemetry (W3C TraceContext + phase-level spans)

## Overview

When a subscriber webhook is slow or failing, a queue-level metric tells you
*that* deliveries are degrading but not *why*. The dispatcher now instruments
every outbound POST with W3C TraceContext propagation and records the five
phases of the request as both OpenTelemetry spans (Jaeger) and Prometheus
histograms.

Phases captured, in request order:

| Phase             | Source                        | Meaning                                        |
| ----------------- | ----------------------------- | ---------------------------------------------- |
| `dns_lookup`      | socket `lookup` event         | Hostname resolution                             |
| `tcp_connect`     | socket `connect` event        | TCP handshake                                   |
| `tls_handshake`   | socket `secureConnect` event  | TLS negotiation (HTTPS targets only)            |
| `ttfb`            | response callback             | Request sent to first response byte            |
| `response_stream` | response `end`                | Time spent streaming the response body         |

Each phase is measured from the completion of the previous one, so the phase
durations sum to approximately the end-to-end request time.

## Trace propagation

Every dispatch attaches a W3C `traceparent` header to the outbound request:

```
00-{32 hex traceId}-{16 hex spanId}-01
```

The trace is continued across the queue boundary: `AlertJobData` carries an
optional `traceparent` from the payment-detection request, and the dispatcher
attaches it to the dispatch span as a **remote parent**. Subscribers that are
themselves instrumented can therefore join the trace and show where their own
handling time goes.

The header is always spec-valid, including when no OpenTelemetry SDK is
registered (unit tests, or telemetry disabled) — the transport falls back to the
repository's existing W3C generator in `apps/api/src/lib/tracing.ts`.

## Spans

One `webhook.dispatch` CLIENT span per attempt, carrying every phase as an
attribute so a single span is searchable in Jaeger:

| Attribute                            | Meaning                              |
| ------------------------------------ | ------------------------------------ |
| `webhook.id`                         | Subscriber webhook record id         |
| `url.full`, `server.address`         | Target endpoint                      |
| `http.response.status_code`          | Subscriber response status           |
| `webhook.socket.reused`              | Request used a pooled keep-alive socket |
| `webhook.dns_lookup.duration_ms`     | DNS duration                         |
| `webhook.tcp_connect.duration_ms`    | TCP duration                         |
| `webhook.tls_handshake.duration_ms`  | TLS duration                         |
| `webhook.ttfb.duration_ms`           | TTFB duration                        |
| `webhook.response_stream.duration_ms` | Body streaming duration              |
| `webhook.dispatch.total_ms`          | End-to-end duration                  |

Plus one child span per completed phase (`webhook.phase.dns_lookup`,
`webhook.phase.tcp_connect`, `webhook.phase.tls_handshake`, `webhook.phase.ttfb`,
`webhook.phase.response_stream`) for flame graphs.

Failed dispatches set the span status to `ERROR` and record the exception, and
still emit whatever phases completed before the failure.

### Phases that did not occur are omitted

A phase is **not** recorded when it did not happen. Two cases:

- **Plaintext endpoints** never perform a TLS handshake, so `tls_handshake` is
  absent rather than reported as `0 ms`.
- **Reused keep-alive sockets** skip DNS, TCP and TLS entirely, so those phases
  are absent on the second and subsequent requests to a warm subscriber, and
  `webhook.socket.reused` is `true`.

Recording these as zero would make `histogram_quantile` meaningless, so
absence is the signal. When comparing endpoints, filter on
`webhook.socket.reused="false"` to compare cold-path latency.

## Metrics

| Metric                                                    | Type      | Labels             |
| --------------------------------------------------------- | --------- | ------------------ |
| `stellar_alerts_webhook_dispatch_phase_duration_seconds`   | histogram | `phase`            |
| `stellar_alerts_webhook_dispatch_total_duration_seconds`   | histogram | `outcome`          |
| `stellar_alerts_webhook_dispatch_total`                    | counter   | `outcome`          |

Buckets (milliseconds, declared as seconds): `1, 5, 10, 25, 50, 100, 250, 500,
1000, 2500, 5000, 10000`.

Example —p99 TTFB per phase:

```promql
histogram_quantile(
  0.99,
  sum by (le, phase) (
    rate(stellar_alerts_webhook_dispatch_phase_duration_seconds_bucket[5m])
  )
)
```

Example —share of dispatches still waiting on DNS:

```promql
sum(rate(stellar_alerts_webhook_dispatch_phase_duration_seconds_count{phase="dns_lookup"}[5m]))
/
sum(rate(stellar_alerts_webhook_dispatch_total[5m]))
```

## Configuration

| Variable                        | Default                              | Purpose                                              |
| ------------------------------- | ------------------------------------ | ---------------------------------------------------- |
| `OTEL_EXPORTER_OTLP_ENDPOINT`   | `http://localhost:4318/v1/traces`    | OTLP/HTTP trace endpoint (collector)                 |
| `OTEL_SERVICE_NAME`             | `stellar-alerts-api`                 | Service name for the API process                     |
| `OTEL_WORKER_SERVICE_NAME`      | `stellar-alerts-webhook-dispatcher`  | Service name for worker processes                    |
| `WORKER_METRICS_PORT`           | _unset_                              | Opt-in Prometheus scrape port for the worker         |
| `WEBHOOK_TIMEOUT_MS`            | `10000`                              | Existing per-request deadline (unchanged)            |

Set `WORKER_METRICS_PORT=9101` on the dispatcher to expose its histograms, then
scrape `http://<worker>:9101/metrics`. When it is unset no listener is opened.

## Local development

```bash
docker compose up -d jaeger prometheus
```

- Jaeger UI: <http://localhost:16686> — search for service
  `stellar-alerts-webhook-dispatcher`, operation `webhook.dispatch`.
- Prometheus UI: <http://localhost:9090> — see `docker/prometheus.yml` for the
  scrape targets.

Point the app at the collector and enable the dispatcher scrape port:

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318/v1/traces
WORKER_METRICS_PORT=9101
```

## Compatibility and rollout

**No database migration.** This feature adds no columns, tables or indexes; the
`WebhookLog` write path is untouched.

**No API contract change.** The `traceparent` header is added to *outbound*
subscriber requests only. Inbound webhook subscriptions are unaffected.

**Subscriber compatibility.** Some strict receivers validate unknown headers.
`traceparent` is a standard W3C header and widely accepted, but if a subscriber
rejects requests carrying it, disable propagation with
`propagateTraceContext: false` on the dispatch call. No retry, dedupe or
signature behaviour changes.

**Signature compatibility.** `X-Stellar-Signature` still covers the request
*body* only, which is unchanged, so existing signature verification keeps
working. `traceparent` is not part of the signed payload.

**Rollout order.** Safe in any order; nothing is required before the app starts.

1. Deploy collector/Jaeger and Prometheus, and confirm traces arrive for
   `stellar-alerts-api`.
2. Deploy workers. `startTelemetry()` is now called from `runWatcher()`, so
   dispatch spans begin flowing with no configuration change.
3. Set `WORKER_METRICS_PORT` to begin scraping dispatcher histograms.
4. Add dashboards and alerts on the metrics above.

**Behavioural notes.**

- Dispatch still goes through the same `opossum` circuit breaker, SSRF
  validation, adaptive rate limiter and delivery idempotency gate. Only the
  HTTP call itself changed transport, from `fetch` to `node:http`/`node:https`,
  because `fetch` (undici) does not expose per-phase timings. The deadline
  still raises `ExternalRequestTimeoutError`, so existing retry and
  circuit-breaker classification is unchanged.
- The returned object is `Response`-shaped (`status`, `ok`, `headers`, `text()`),
  so call sites were not restructured.
- Keep-alive pooling is enabled (max 64 sockets per protocol). This reduces
  subscriber load but means warm requests legitimately report no DNS/TCP/TLS
  phase — see "Phases that did not occur are omitted".
- Response bodies are buffered in full before returning, matching the previous
  `response.text()` behaviour.
- If the OpenTelemetry collector is unreachable, span export fails silently and
  dispatch is unaffected; metrics are unaffected either way.

## Tests

```bash
npx vitest run src/lib/__tests__/webhook-telemetry.test.ts src/__tests__/webhook-dispatch-metrics.test.ts
```

`webhook-telemetry.test.ts` runs against a real local HTTP server so DNS, TCP,
TTFB and response-stream timings are genuinely exercised, and asserts span
structure and parentage via an in-memory span exporter. TLS attribution is
covered deterministically through `computePhases`, since standing up a TLS
fixture would require generating a certificate.
