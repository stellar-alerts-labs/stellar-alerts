# API Health Checks

The API exposes separate process and dependency checks:

- `GET /health/live` (and the backward-compatible `GET /health`) checks only that the process can serve requests.
- `GET /health/ready` checks PostgreSQL, Redis, Horizon, and Soroban RPC. It returns `200` when all are reachable and `503` when any check is degraded. Its legacy top-level `redis` status object remains available alongside the new diagnostics.
- `GET /health/dependencies` returns per-dependency diagnostics and the same overall status as readiness.

Dependency checks run concurrently, are bounded by `HEALTH_CHECK_TIMEOUT_MS` (default `1500`), and share an in-flight/cached result for `HEALTH_CHECK_CACHE_TTL_MS` (default `5000`). This limits load when probes run frequently. The response contains a `checkedAt` timestamp and, for each dependency, `status`, `latencyMs`, and a sanitized `error` when unavailable. Liveness never runs dependency checks.

Provider endpoints can be configured with `HORIZON_URL` and `SOROBAN_RPC_URL`; existing testnet defaults are preserved. Tune timeout/cache values according to provider and database latency budgets.

Use these probes on the API container (the existing `k8s/hpa.yaml` Deployment is for the separate worker and does not serve these routes):

```yaml
startupProbe:
  httpGet:
    path: /health/live
    port: http
  periodSeconds: 5
  timeoutSeconds: 2
  failureThreshold: 30
livenessProbe:
  httpGet:
    path: /health/live
    port: http
  periodSeconds: 10
  timeoutSeconds: 2
  failureThreshold: 3
readinessProbe:
  httpGet:
    path: /health/ready
    port: http
  periodSeconds: 10
  timeoutSeconds: 2
  failureThreshold: 3
  successThreshold: 1
```

Keep liveness independent of databases, Redis, and providers so a dependency incident does not restart every API replica. Readiness removes unhealthy replicas from service without triggering restart cascades.