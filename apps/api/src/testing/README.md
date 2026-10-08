# Disposable, parallel-safe integration fixtures

Helpers for integration tests that need a real Postgres and Redis, without
sharing state between parallel vitest forks or leaving anything behind.

- `createPostgresFixture()` — private Postgres schema per fork/worker
- `createRedisFixture()` — dedicated Redis db index + unique key prefix per fork

Both fixtures throw when their backing service is unreachable, and the
`isPostgresAvailable` / `isRedisAvailable` probes let suites skip cleanly when
the services are down. Unit-only runs are unaffected: nothing here runs unless
a suite opts in.

## Postgres strategy

1. A shared test database (default
   `postgresql://postgres:postgres@localhost:5432/stellar_alerts_test`,
   override with `TEST_DATABASE_URL`) hosts one template schema
   (`stellar_alerts_template`).
2. The first fork to arrive replays all Prisma migrations into the template
   under a Postgres advisory lock; every other fork waits, then clones it with
   `CREATE SCHEMA ... TEMPLATE`, which is fast and metadata-only.
3. Every fork works in its own `it_<worker>_<uuid>` schema, so parallel forks
   never share rows, sequences, or locks.
4. `reset()` truncates the fork's tables in one statement with
   `RESTART IDENTITY CASCADE`, giving every test a deterministic starting
   state.
5. `teardown()` drops the schema — nothing disposable survives the run.

## Redis strategy

1. A shared Redis (default `redis://localhost:6379`, override with
   `TEST_REDIS_URL`) is partitioned two ways:
   - db index derived from the worker id (`TEST_REDIS_DB` overrides), and
   - a unique `sa-it:<uuid>:` key prefix per fixture instance.
2. `reset()` is a deterministic SCAN+DEL under the prefix only — never
   FLUSHDB/FLUSHALL, so other Redis consumers (dev apps, other forks) are
   untouched.
3. `teardown()` deletes remaining prefixed keys and closes the connection.

## Usage

```ts
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { createPostgresFixture, createRedisFixture, isPostgresAvailable } from '../testing';

const pgUp = await isPostgresAvailable();

describe.skipIf(!pgUp)('payments integration', () => {
  const pg = await createPostgresFixture();
  const redis = await createRedisFixture();

  beforeAll(async () => {
    await pg.db.$connect();
  });

  beforeEach(async () => {
    await pg.reset();
    await redis.reset();
  });

  afterAll(async () => {
    await pg.teardown();
    await redis.teardown();
  });

  it('writes through prisma', async () => {
    const user = await pg.db.user.create({ data: { email: 'a@b.c' } });
    expect(user.id).toBeTruthy();
  });
});
```

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `TEST_DATABASE_URL` | `postgresql://postgres:postgres@localhost:5432/stellar_alerts_test` | Shared test Postgres database |
| `TEST_REDIS_URL` | `redis://localhost:6379` | Shared test Redis |
| `TEST_REDIS_DB` | worker-id modulo | Force a specific logical db index |

## Local & CI setup

```bash
docker compose up -d postgres redis

npm run test:integration --workspace=api
```

The test database is created on demand by the fixture (the connection user
needs `CREATEDB`-equivalent rights, which the compose defaults have). No other
configuration is required.
