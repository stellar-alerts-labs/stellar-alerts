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
    // (`vitest run`) excludes them so unit stays hermetic.
    include: ['src/testing/__tests__/**/*.test.ts'],
    env: {
      DATABASE_URL: 'postgresql://user:password@localhost:5432/stellar_alerts?schema=public',
      TELEGRAM_BOT_TOKEN: 'test-telegram-token',
      JWT_SECRET: 'test-jwt-secret',
      REDIS_URL: 'redis://localhost:6379',
    },
  },
});
