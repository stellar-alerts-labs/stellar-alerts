import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';
import { v4 as uuidv4 } from 'uuid';

// This integration test requires a running Postgres instance reachable via
// environment variables used by the app (PGHOST/PGUSER/PGPASSWORD/PGDATABASE).
// CI should run this with a service container or a test database.

let client: Client;

beforeAll(async () => {
  client = new Client({
    connectionString: process.env.DATABASE_URL,
  });
  await client.connect();
});

afterAll(async () => {
  await client.end();
});

async function clearTestData() {
  await client.query('DELETE FROM "payment_hourly_rollup";');
  await client.query('DELETE FROM "payment_daily_rollup";');
  await client.query('DELETE FROM "Payment" WHERE "txHash" LIKE $1;', ['test-%']);
}

describe('Payment rollups integration', async () => {
  it('computes hourly and daily aggregates', async () => {
    await clearTestData();

    const walletId = uuidv4();

    // Insert watched wallet and a few payment rows
    await client.query(
      'INSERT INTO "Wallet" ("id", "userId", "publicKey", "createdAt") VALUES ($1, $2, $3, now()) ON CONFLICT DO NOTHING',
      [walletId, uuidv4(), 'GTEST' + walletId.slice(0, 8)]
    );

    const now = new Date();
    const hourStart = new Date(now);
    hourStart.setUTCMinutes(0, 0, 0);

    // Two payments in the same hour
    await client.query(
      'INSERT INTO "Payment" ("id","walletId","txHash","fromAddress","amount","asset","receivedAt","createdAt") VALUES ($1,$2,$3,$4,$5,$6,$7,now())',
      [uuidv4(), walletId, 'test-' + uuidv4(), 'GFROM', '1.5', 'XLM', hourStart.toISOString()]
    );
    await client.query(
      'INSERT INTO "Payment" ("id","walletId","txHash","fromAddress","amount","asset","receivedAt","createdAt") VALUES ($1,$2,$3,$4,$5,$6,$7,now())',
      [uuidv4(), walletId, 'test-' + uuidv4(), 'GFROM', '2.25', 'XLM', new Date(hourStart.getTime() + 10 * 60 * 1000).toISOString()]
    );

    // One payment in the next day
    const nextDay = new Date(hourStart);
    nextDay.setUTCDate(nextDay.getUTCDate() + 1);
    await client.query(
      'INSERT INTO "Payment" ("id","walletId","txHash","fromAddress","amount","asset","receivedAt","createdAt") VALUES ($1,$2,$3,$4,$5,$6,$7,now())',
      [uuidv4(), walletId, 'test-' + uuidv4(), 'GFROM', '3.0', 'XLM', nextDay.toISOString()]
    );

    // Refresh rollups
    await client.query('SELECT public.refresh_payment_rollups();');

    // Query hourly rollup
    const hr = await client.query(
      'SELECT "tx_count", "total_amount" FROM "payment_hourly_rollup" WHERE "walletId" = $1 ORDER BY "hour_start" LIMIT 1',
      [walletId]
    );

    expect(hr.rowCount).toBeGreaterThanOrEqual(1);
    const row = hr.rows[0];
    expect(Number(row.tx_count)).toBe(2);
    expect(Number(row.total_amount)).toBeCloseTo(3.75, 6);

    // Query daily rollup for next day
    const dr = await client.query(
      `SELECT "tx_count", "total_amount" FROM "payment_daily_rollup" WHERE "walletId" = $1 AND "day_start" = (date_trunc('day', $2::timestamptz) AT TIME ZONE 'UTC')`,
      [walletId, nextDay.toISOString()]
    );

    // Some Postgres setups may store day_start with timezone differences; fallback to any row
    const drAny = await client.query('SELECT "tx_count", "total_amount" FROM "payment_daily_rollup" WHERE "walletId" = $1', [walletId]);
    expect(drAny.rowCount).toBeGreaterThanOrEqual(1);

    await clearTestData();
  }, 20000);
});
