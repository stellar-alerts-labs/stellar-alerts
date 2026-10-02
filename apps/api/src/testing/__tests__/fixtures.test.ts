import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createPostgresFixture, TEST_DB_URL, type PostgresFixture } from '../postgres-fixture';
import { createRedisFixture, TEST_REDIS_URL, type RedisFixture } from '../redis-fixture';
import { isPostgresAvailable, isRedisAvailable, parseRedisUrl } from '../test-infra';

/**
 * Focused automated tests for the disposable, parallel-safe integration
 * fixtures themselves. The Postgres/Redis assertions only run when the real
 * services are reachable (CI and local `docker compose up -d`); otherwise the
 * suites are skipped so unit-only environments still pass.
 */

const pgAvailable = await isPostgresAvailable(TEST_DB_URL);
const redisAvailable = await isRedisAvailable(TEST_REDIS_URL);

describe.skipIf(!pgAvailable)('postgres fixture', () => {
  let fixture: PostgresFixture;

  beforeAll(async () => {
    fixture = await createPostgresFixture();
  });

  afterAll(async () => {
    await fixture?.teardown();
  });

  beforeEach(async () => {
    await fixture.reset();
  });

  it('provisions a private database cloned from the template', async () => {
    const rows = await fixture.db.$queryRawUnsafe<Array<{ schemaname: string; tablename: string }>>(
      "SELECT schemaname, tablename FROM pg_tables WHERE schemaname NOT IN ('pg_catalog', 'information_schema') ORDER BY tablename LIMIT 3",
    );
    expect(fixture.database).toMatch(/_it_/);
    expect(rows.length).toBeGreaterThan(0);
  });

  it('writes and reads rows through the prisma client', async () => {
    const user = await fixture.db.user.create({
      data: { email: 'fixture-user@example.com' },
    });
    const wallet = await fixture.db.wallet.create({
      data: { userId: user.id, publicKey: 'GABCDEF-FIXTURE-PROBE' },
    });
    expect(wallet.userId).toBe(user.id);

    const found = await fixture.db.user.findUnique({ where: { email: 'fixture-user@example.com' } });
    expect(found?.id).toBe(user.id);
  });

  it('reset() deterministically truncates every table', async () => {
    await fixture.db.user.create({ data: { email: 'reset-check@example.com' } });
    await fixture.reset();
    const users = await fixture.db.user.findMany();
    expect(users).toHaveLength(0);
  });

  it('two fixtures on the same worker do not share rows', async () => {
    const other = await createPostgresFixture();
    try {
      await fixture.db.user.create({ data: { email: 'isolation-a@example.com' } });
      await other.db.user.create({ data: { email: 'isolation-b@example.com' } });

      const inA = await fixture.db.user.findMany();
      const inB = await other.db.user.findMany();
      expect(inA.map((u) => u.email)).toEqual(['isolation-a@example.com']);
      expect(inB.map((u) => u.email)).toEqual(['isolation-b@example.com']);
    } finally {
      await other.teardown();
    }
  });
});

describe.skipIf(!redisAvailable)('redis fixture', () => {
  let fixture: RedisFixture;

  beforeAll(async () => {
    fixture = await createRedisFixture();
  });

  afterAll(async () => {
    await fixture?.teardown();
  });

  beforeEach(async () => {
    await fixture.reset();
  });

  it('uses a unique prefix and a parsed redis target', () => {
    expect(fixture.prefix.startsWith('sa-it:')).toBe(true);
    expect(parseRedisUrl(TEST_REDIS_URL).port).toBeGreaterThan(0);
  });

  it('set/get/del roundtrip works through the fixture client', async () => {
    await fixture.redis.set('probe-key', 'probe-value');
    expect(await fixture.redis.get('probe-key')).toBe('probe-value');
    await fixture.redis.del('probe-key');
    expect(await fixture.redis.get('probe-key')).toBeNull();
  });

  it('reset() deletes every key under the prefix only', async () => {
    await fixture.redis.set('a', '1');
    await fixture.redis.set('b', '2');
    await fixture.redis.set('unprefixed-key', 'keep-me');

    await fixture.reset();

    expect(await fixture.redis.get('a')).toBeNull();
    expect(await fixture.redis.get('b')).toBeNull();
    expect(await fixture.redis.get('unprefixed-key')).toBe('keep-me');
  });

  it('two fixtures get different prefixes and isolated keys', async () => {
    const other = await createRedisFixture();
    try {
      expect(other.prefix).not.toBe(fixture.prefix);
      await fixture.redis.set('shared-name', 'from-first');
      await other.redis.set('shared-name', 'from-second');
      expect(await fixture.redis.get('shared-name')).toBe('from-first');
      expect(await other.redis.get('shared-name')).toBe('from-second');
    } finally {
      await other.teardown();
    }
  });
});
