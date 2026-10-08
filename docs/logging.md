# Structured logging (Pino)

Stellar Alerts uses **Pino** for structured, machine-queryable JSON logs across the API and background workers.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `LOG_LEVEL` | `info` | Pino level (`fatal` … `trace`) |
| `SERVICE_NAME` | `stellar-alerts` | `service` field on every line |
| `NODE_ENV` | `development` | Emitted as `env` |

## Correlation

- Fastify resolves `x-request-id` (or generates a UUID) and binds it as **`requestId`** on `request.log`.
- Workers should call `createLogger({ module, requestId })` so the same field appears outside the HTTP lifecycle.

## Redaction

Sensitive fields are never emitted. Pino `redact` paths (and `sanitizeForLog`) censor tokens, secrets, private keys, auth headers/cookies, and notification message contents to `[REDACTED]`.

Prefer structured fields over string interpolation:

```ts
import { createLogger } from '../lib/logger';

const log = createLogger({ module: 'WatcherWorker' });
log.info({ walletId }, 'Processing wallet');
```

Do **not** log raw JWT / PAT / seed / private key / alert plaintext bodies.
