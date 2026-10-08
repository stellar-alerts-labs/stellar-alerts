import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      // Same alias as the unit config so shared-package imports resolve from
      // TypeScript source without a pre-built dist.
      '@stellar-alerts/shared': path.resolve(__dirname, '../../packages/shared/src/index.ts'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    // Only the integration fixture suites live here; the default unit run
    // (`test:unit`) excludes them so unit stays hermetic.
    include: ['src/testing/__tests__/**/*.test.ts'],
    env: {
      // Defaults match the `integration` CI job's Postgres/Redis services.
      // CI exports the real TEST_* URLs; these are fallbacks for local runs.
      TEST_DATABASE_URL: 'postgresql://postgres:postgrespassword@localhost:5432/stellar_alerts_test',
      TEST_REDIS_URL: 'redis://localhost:6379',
      DATABASE_URL: 'postgresql://postgres:postgrespassword@localhost:5432/stellar_alerts_test',
      REDIS_URL: 'redis://localhost:6379',
      TELEGRAM_BOT_TOKEN: 'test-telegram-token',
      JWT_SECRET: 'test-jwt-secret',
    },
  },
});
