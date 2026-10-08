# Dashboard summary Redis cache (#285)

## Behavior

- **Keys:** `summary:{version}:{kind}:user:{userId}[:wallet:{id}][:fiat:{code}]`
- **Kinds:** `payments`, `delivery`, `cross_ledger` (as wired)
- **TTL:** `SUMMARY_CACHE_TTL_SECONDS` (default **60**), capped at **300**
- **Version:** `SUMMARY_CACHE_VERSION` (`v1`) — bump when response shape changes

## Stale data

Cached summaries may lag primary Postgres by up to the TTL after a write if invalidation is skipped.  
Invalidation runs via `invalidateUserSummaryCache(userId)` on write paths when wired; otherwise **TTL** bounds staleness.

Clients must tolerate summaries that are **eventually consistent** within the TTL window.

## Failure mode

Redis outages, timeouts, or parse errors **never** fail the HTTP read path.  
The loader always falls through to **primary** (Postgres) aggregates.

## Config

| Variable | Default | Meaning |
|----------|---------|---------|
| `SUMMARY_CACHE_TTL_SECONDS` | `60` | Cache TTL for summary payloads |
| `REDIS_URL` / host port | existing | Shared with BullMQ / nonce cache |

## Ops

- Cache miss → one aggregate query → SET with TTL  
- Cache hit → no aggregate query  
- Degraded Redis (`getRedisStatus` not ready) → primary only
