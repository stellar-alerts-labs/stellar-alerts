# Webhook Dispatch Observability

How a webhook delivery is traced and measured end to end: what spans and
metrics exist, how the W3C trace context crosses the BullMQ boundary, how to
read each HTTP phase, and how to roll the whole thing back.

Related: [`SLO_DASHBOARDS.md`](./SLO_DASHBOARDS.md) (fleet-wide SLOs and the
W3C standard), [`DELIVERY_LIFECYCLE.md`](./DELIVERY_LIFECYCLE.md).

---

## 1. What problem this solves

A webhook delivery is a single HTTP POST to a customer-controlled endpoint. A
latency number alone cannot tell you whether to page the on-call, email the
customer, or fix the cluster: a slow resolver, a full SYN backlog, a
misconfigured certificate and a slow application all produce the same
end-to-end number.

Every delivery attempt is therefore broken into five phases:

| Phase | How it is measured | What a bad number means |
| :--- | :--- | :--- |
| `dns` | custom `lookup` callback, timed from call to callback | resolver pressure, a bad `/etc/hosts` or a dead upstream resolver |
| `tcp_connect` | socket `connect` event | SYN backlog exhaustion, firewall drops, a saturated accept queue |
| `tls_handshake` | socket `secureConnect` event | certificate/CPU problems, TLS interception middleboxes |
| `ttfb` | `response` event (headers received) | the customer's handler is slow to respond |
| `response_stream` | `response` to end of body | the endpoint streams slowly, or never finishes draining |

### Unobserved phases are `null`, not `0`

A `null` phase means "this work did not happen" — never "it was instantaneous".
Two cases matter:

- **Reused keep-alive socket.** No DNS, TCP or TLS work occurs, so all three are
  `null` and `webhook.connection.reused` is `true`.
- **Plain-HTTP endpoint.** There is no TLS, so only `tls_handshake` is `null`.

This distinction is preserved in both transports. A histogram that recorded a
reused socket as three `0ms` phases would report a healthy connection pool as a
fleet-wide latency regression. The `+Inf` bucket and the `*_count` series are
therefore the reliable totals; do not sum the individual phases to get end-to-end
time, and never treat a missing series as a zero measurement.

Note that a **literal IP address** in the webhook URL also produces a `null`
`dns` phase, because Node resolves IP literals without a DNS lookup. That is a
property of the URL, not a reused connection.

---

## 2. Trace propagation across the queue

```
[Horizon / Soroban ingestion]     span: horizon.sse.consume
        │  enqueuePaymentAlert captures the active context
        ▼
[BullMQ job.data]                  { traceparent, tracestate }
        │  processAlertDispatch re-establishes it as a remote parent
        ▼
[webhook.dispatch]                 client span (the HTTP attempt)
        │  W3C headers injected on the outbound request
        ▼
[Customer endpoint]                may or may not continue the trace
```

BullMQ serialises plain JSON and cannot carry an `opentelemetry-api` `Context`,
so the context is serialised by hand in the W3C wire format
(`lib/webhook-trace-context.ts`) and stored on the job payload.

Two deliberate choices:

1. **`tracestate` is carried verbatim.** It has no representation on a
   `SpanContext`, so a propagator round-trip would silently drop the caller's
   `tracestate` before it reached the customer's endpoint.
2. **The wire format is parsed directly** rather than through the global
   propagator, so a process that has not called `startTelemetry()` (tests, and
   any deployment mid-rollout) still injects a correct header. The global
   propagator is still installed for the rest of the OpenTelemetry
   instrumentation; this is additive.

Jobs enqueued **before** this shipped simply have no `traceparent` and start a
new trace. Delivery is never blocked on the presence of trace context — an
unparsable or absent header degrades to a fresh trace rather than failing the
delivery.

---

## 3. The `webhook.dispatch` span

One client span per HTTP attempt, named `webhook.dispatch`, produced by the
`stellar-alerts.webhook-dispatcher` tracer.

| Attribute | Meaning |
| :--- | :--- |
| `webhook.id` | internal webhook record id |
| `http.request.method` | always `POST` in practice |
| `url.scheme`, `server.address`, `url.path` | destination, **split into fields** |
| `http.response.status_code` | only set when a response actually arrived |
| `webhook.response.class` | `2xx` / `3xx` / `4xx` / `5xx` / `none` |
| `webhook.dispatch.outcome` | terminal classification (below) |
| `webhook.dispatch.attempt` | 1-based retry attempt |
| `webhook.redirects` | redirect hops followed |
| `webhook.connection.reused` | response came off a pooled socket |
| `webhook.duration.total_ms` | end-to-end attempt duration |
| `webhook.phase.{dns,tcp_connect,tls_handshake,ttfb,response_stream}_ms` | per-phase, omitted when unobserved |
| `error.type` | set on transport failures |

Each observed phase is also emitted as a **span event** (`dns.lookup`,
`tcp.connect`, `tls.handshake`, `http.ttfb`, `http.response.stream`) so the
Jaeger waterfall shows the connection breakdown inline.

### Query strings are never recorded

Customers routinely put signing secrets in the webhook URL's query string. The
span records `url.scheme` / `server.address` / `url.path` as separate
attributes and **never** `url.query`, so a secret cannot reach a third-party
collector. Webhook ids and URLs are likewise kept off the Prometheus series —
see the cardinality note below.

### Outcomes

`delivered`, `rate_limited`, `server_error`, `client_error`, `timeout`,
`connection_error`, `circuit_open`, `ssrf_blocked`.

Only `delivered` is span status `OK`. A 429 or 5xx is a *completed* round trip
that failed the delivery, not a transport error, but it is still recorded as
`ERROR` with the outcome as the message so Jaeger error filters find it. Genuine
transport failures additionally record a span exception.

---

## 4. Prometheus metrics

Served on the API's existing `/metrics` route and, when
`WORKER_METRICS_ENABLED=true`, on the dispatcher worker's own
`http://<worker>:3002/metrics`.

| Metric | Type | Labels |
| :--- | :--- | :--- |
| `stellar_alerts_webhook_dispatch_attempts_total` | counter | `outcome` |
| `stellar_alerts_webhook_dispatch_duration_seconds` | histogram | `result` |
| `stellar_alerts_webhook_dispatch_phase_duration_seconds` | histogram | `phase` |
| `stellar_alerts_webhook_dispatch_in_flight` | gauge | — |

Latency buckets are in seconds, dense below 100 ms where healthy endpoints live,
with a long tail so a genuinely slow customer still lands in a bucket instead of
`+Inf` by default.

### Cardinality is deliberately bounded

The only labels are `outcome`, `result` and `phase` — all fixed enumerations.
**Webhook ids, hostnames and URLs are never labels**: they are user-controlled
and unbounded, so keying on them would let a single tenant inflate the series
count for the whole fleet. Those values live on the span, where they cost
nothing when nobody is looking. A defensive cap of 64 values per label name
backstops this; if a future call site passes user data through, series are
dropped rather than allowed to explode.

### Useful queries

```promql
# Delivery success ratio, matching the 99.9% SLO.
sum(rate(stellar_alerts_webhook_dispatch_attempts_total{outcome="delivered"}[5m]))
  /
sum(rate(stellar_alerts_webhook_dispatch_attempts_total[5m]))

# P95 end-to-end delivery latency.
histogram_quantile(0.95,
  sum by (le) (rate(stellar_alerts_webhook_dispatch_duration_seconds_bucket[5m])))

# P95 time-to-first-byte — isolates the customer's handler.
histogram_quantile(0.95,
  sum by (le) (rate(stellar_alerts_webhook_dispatch_phase_duration_seconds_bucket{phase="ttfb"}[5m])))

# Share of deliveries that opened a NEW connection. `tcp_connect` is only
# observed when the agent did not hand us a pooled socket, so this is the
# complement of the reused-socket share: a fall here while TCP connect times
# climb means the keep-alive pool is churning.
1 - (
  sum(rate(stellar_alerts_webhook_dispatch_phase_duration_seconds_count{phase="tcp_connect"}[5m]))
    /
  sum(rate(stellar_alerts_webhook_dispatch_duration_seconds_count[5m]))
)

# Timeouts and rate limiting, as separate series.
sum(rate(stellar_alerts_webhook_dispatch_attempts_total{outcome=~"timeout|rate_limited"}[5m]))
```

---

## 5. Configuration and rollout

| Variable | Default | Effect |
| :--- | :--- | :--- |
| `OTEL_TRACES_ENABLED` | `true` | `false` prevents the OTel SDK from being constructed at all |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `http://localhost:4318/v1/traces` | OTLP/HTTP collector (Jaeger by default) |
| `OTEL_SERVICE_NAME` | `stellar-alerts-api` | worker overrides with `stellar-alerts-dispatcher` |
| `WEBHOOK_DISPATCH_TELEMETRY_ENABLED` | `true` | `false` disables spans **and** metrics for dispatch |
| `WEBHOOK_DISPATCH_TRANSPORT` | `native` | `fetch` rolls back to undici |
| `WEBHOOK_DISPATCH_MAX_REDIRECTS` | `5` | redirect hop cap |
| `WORKER_METRICS_ENABLED` | `false` | opens the worker's own `:3002/metrics` |
| `WORKER_METRICS_PORT` | `3002` | port for the above |

### Rollout order

1. Deploy the code with `WEBHOOK_DISPATCH_TELEMETRY_ENABLED=false`. The native
   transport is already live, so delivery behaviour is unchanged and nothing is
   exported yet.
2. Bring up the collector, confirm spans arrive, then flip
   `WEBHOOK_DISPATCH_TELEMETRY_ENABLED=true`.
3. Set `WORKER_METRICS_ENABLED=true` on the worker so the delivery series are
   scraped from the process that actually performs the deliveries.

### Rollback

Each switch is independent and takes effect without a code change:

- `WEBHOOK_DISPATCH_TELEMETRY_ENABLED=false` — stops spans and metrics. Requests
  are still delivered, and the endpoint still returns status and outcome.
- `WEBHOOK_DISPATCH_TRANSPORT=fetch` — returns to undici. TTFB and
  response-stream timings are preserved; `dns` / `tcp_connect` /
  `tls_handshake` report `null`, because undici exposes no connection callbacks.
  Sizing the alerting off those three series requires switching back to
  `native`.
- `OTEL_TRACES_ENABLED=false` — stops the SDK for the whole process, not just
  the dispatcher.

No database migration is required; trace context rides on the existing BullMQ
payload as two optional string fields.

---

## 6. Local stack

```bash
docker compose up -d jaeger prometheus
npm run dev:worker            # in apps/api, with WORKER_METRICS_ENABLED=true
```

- Jaeger UI: <http://localhost:16686> (search for service `stellar-alerts-dispatcher`)
- Prometheus: <http://localhost:9090>

Point the app at the collector with:

```
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318/v1/traces
```

The dispatcher is reachable in Jaeger as `stellar-alerts-dispatcher` because the
worker entrypoint passes its own `serviceName`; without that override its spans
would be indistinguishable from the API server's.

Scrape targets are defined in `monitoring/prometheus.yml` and assume the app
runs on the host. In a deployed environment, replace them with the cluster's own
`ServiceMonitor` / `PodMonitor` configuration.

---

## 7. Known limitations

- **Redirect hops report only the final hop's phases.** Each hop is timed
  internally, but `WebhookHttpRequestResult.timings` is overwritten per hop, so
  a slow redirect chain is attributed to the last response. The hop count is
  available as `webhook.redirects`.
- **Response size is the declared `content-length`**, not the bytes actually
  read, so a chunked response reports `null` for `http.response.body.size`.
- **TLS handshake timing is only asserted at the unit level.** The phase
  plumbing is shared and covered, but there is no self-signed-certificate
  fixture in the repository, so the end-to-end HTTPS path is not exercised by
  an integration test.
