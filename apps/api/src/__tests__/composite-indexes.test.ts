import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { prisma } from '../lib/prisma';

describe('Composite Index Optimization Tests', () => {
  // Test data IDs for cleanup
  const testUserIds: string[] = [];
  const testWalletIds: string[] = [];
  const testPaymentIds: string[] = [];
  const testDeliveryAttemptIds: string[] = [];

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    // Cleanup test data in dependency order
    if (testDeliveryAttemptIds.length > 0) {
      await prisma.notificationDeliveryAttempt.deleteMany({
        where: { id: { in: testDeliveryAttemptIds } }
      });
      testDeliveryAttemptIds.length = 0;
    }

    if (testPaymentIds.length > 0) {
      await prisma.payment.deleteMany({
        where: { id: { in: testPaymentIds } }
      });
      testPaymentIds.length = 0;
    }

    if (testWalletIds.length > 0) {
      await prisma.wallet.deleteMany({
        where: { id: { in: testWalletIds } }
      });
      testWalletIds.length = 0;
    }

    if (testUserIds.length > 0) {
      await prisma.user.deleteMany({
        where: { id: { in: testUserIds } }
      });
      testUserIds.length = 0;
    }
  });

  describe('Index Existence Verification', () => {
    it('verifies Wallet (userId, createdAt) composite index exists', async () => {
      const indexes = await prisma.$queryRaw<Array<{indexname: string, tablename: string}>>`
        SELECT indexname, tablename FROM pg_indexes 
        WHERE schemaname = 'public' 
        AND indexname = 'Wallet_userId_createdAt_idx'
      `;

      expect(indexes).toHaveLength(1);
      expect(indexes[0].indexname).toBe('Wallet_userId_createdAt_idx');
      expect(indexes[0].tablename).toBe('Wallet');
    });

    it('verifies NotificationDeliveryAttempt (deliveryKey, status) composite index exists', async () => {
      const indexes = await prisma.$queryRaw<Array<{indexname: string, tablename: string}>>`
        SELECT indexname, tablename FROM pg_indexes 
        WHERE schemaname = 'public' 
        AND indexname = 'NotificationDeliveryAttempt_deliveryKey_status_idx'
      `;

      expect(indexes).toHaveLength(1);
      expect(indexes[0].indexname).toBe('NotificationDeliveryAttempt_deliveryKey_status_idx');
      expect(indexes[0].tablename).toBe('NotificationDeliveryAttempt');
    });

    it('lists all relevant indexes for verification', async () => {
      const indexes = await prisma.$queryRaw<Array<{indexname: string, tablename: string}>>`
        SELECT indexname, tablename FROM pg_indexes 
        WHERE schemaname = 'public' 
        AND (
          indexname LIKE 'Wallet_%' OR
          indexname LIKE 'NotificationDeliveryAttempt_%' OR
          indexname LIKE 'Payment_%'
        )
        ORDER BY tablename, indexname
      `;

      const indexNames = indexes.map(i => i.indexname);
      
      // Verify our new indexes are present
      expect(indexNames).toContain('Wallet_userId_createdAt_idx');
      expect(indexNames).toContain('NotificationDeliveryAttempt_deliveryKey_status_idx');
      
      // Verify existing Payment indexes are still there
      expect(indexNames).toContain('Payment_walletId_receivedAt_idx');
      expect(indexNames).toContain('Payment_walletId_idx');
      expect(indexNames).toContain('Payment_asset_idx');
    });
  });

  describe('Wallet Query Functionality', () => {
    it('maintains correct query results for getWallets() pattern after index addition', async () => {
      // Create test user
      const testUser = await prisma.user.create({
        data: { email: 'test-wallet-query@test.local' }
      });
      testUserIds.push(testUser.id);

      // Create test wallets with specific creation times
      const baseTime = new Date('2024-01-01T00:00:00Z');
      
      const wallet1 = await prisma.wallet.create({
        data: {
          userId: testUser.id,
          publicKey: 'GTEST1' + 'A'.repeat(51),
          label: 'Wallet 1',
          createdAt: new Date(baseTime.getTime() + 1000) // +1 second
        }
      });
      testWalletIds.push(wallet1.id);

      const wallet2 = await prisma.wallet.create({
        data: {
          userId: testUser.id,
          publicKey: 'GTEST2' + 'B'.repeat(51),
          label: 'Wallet 2', 
          createdAt: new Date(baseTime.getTime() + 2000) // +2 seconds
        }
      });
      testWalletIds.push(wallet2.id);

      const wallet3 = await prisma.wallet.create({
        data: {
          userId: testUser.id,
          publicKey: 'GTEST3' + 'C'.repeat(51),
          label: 'Wallet 3',
          createdAt: new Date(baseTime.getTime() + 3000) // +3 seconds
        }
      });
      testWalletIds.push(wallet3.id);

      // Query using the same pattern as walletsService.getWallets()
      const wallets = await prisma.wallet.findMany({
        where: { userId: testUser.id },
        orderBy: { createdAt: 'desc' }
      });

      // Verify correct ordering (newest first)
      expect(wallets).toHaveLength(3);
      expect(wallets[0].id).toBe(wallet3.id);
      expect(wallets[1].id).toBe(wallet2.id); 
      expect(wallets[2].id).toBe(wallet1.id);

      // Verify all expected fields are returned
      expect(wallets[0]).toMatchObject({
        id: wallet3.id,
        userId: testUser.id,
        publicKey: 'GTEST3' + 'C'.repeat(51),
        label: 'Wallet 3'
      });
    });

    it('handles empty wallet result set correctly', async () => {
      const testUser = await prisma.user.create({
        data: { email: 'test-empty-wallets@test.local' }
      });
      testUserIds.push(testUser.id);

      const wallets = await prisma.wallet.findMany({
        where: { userId: testUser.id },
        orderBy: { createdAt: 'desc' }
      });

      expect(wallets).toHaveLength(0);
    });
  });

  describe('Delivery Attempt Query Functionality', () => {
    it('maintains correct idempotency check behavior after index addition', async () => {
      // Create test data
      const testUser = await prisma.user.create({
        data: { email: 'test-delivery@test.local' }
      });
      testUserIds.push(testUser.id);

      const testWallet = await prisma.wallet.create({
        data: {
          userId: testUser.id,
          publicKey: 'GDELIV' + 'D'.repeat(51),
          label: 'Delivery Test Wallet'
        }
      });
      testWalletIds.push(testWallet.id);

      const testPayment = await prisma.payment.create({
        data: {
          walletId: testWallet.id,
          txHash: 'delivery-test-hash',
          fromAddress: 'GFROM' + 'E'.repeat(51),
          amount: 50,
          asset: 'XLM'
        }
      });
      testPaymentIds.push(testPayment.id);

      // Create delivery attempts with different statuses
      const deliveryKey = `${testPayment.id}:telegram:987654321`;

      const pendingAttempt = await prisma.notificationDeliveryAttempt.create({
        data: {
          deliveryKey,
          paymentId: testPayment.id,
          channel: 'telegram',
          destination: '987654321',
          status: 'pending',
          userId: testUser.id
        }
      });
      testDeliveryAttemptIds.push(pendingAttempt.id);

      const deliveredAttempt = await prisma.notificationDeliveryAttempt.create({
        data: {
          deliveryKey,
          paymentId: testPayment.id,
          channel: 'telegram',
          destination: '987654321', 
          status: 'delivered',
          userId: testUser.id,
          attempt: 2
        }
      });
      testDeliveryAttemptIds.push(deliveredAttempt.id);

      // Test the idempotency query pattern from delivery.ts
      const deliveredCheck = await prisma.notificationDeliveryAttempt.findFirst({
        where: { deliveryKey, status: 'delivered' },
        select: { id: true }
      });

      expect(deliveredCheck).not.toBeNull();
      expect(deliveredCheck?.id).toBe(deliveredAttempt.id);

      // Test with a non-existent delivery key
      const nonExistentCheck = await prisma.notificationDeliveryAttempt.findFirst({
        where: { deliveryKey: 'non-existent-key', status: 'delivered' },
        select: { id: true }
      });

      expect(nonExistentCheck).toBeNull();

      // Test with wrong status
      const wrongStatusCheck = await prisma.notificationDeliveryAttempt.findFirst({
        where: { deliveryKey, status: 'failed' },
        select: { id: true }
      });

      expect(wrongStatusCheck).toBeNull();
    });

    it('handles multiple delivery attempts with same key but different statuses', async () => {
      const testUser = await prisma.user.create({
        data: { email: 'test-multi-delivery@test.local' }
      });
      testUserIds.push(testUser.id);

      const testWallet = await prisma.wallet.create({
        data: {
          userId: testUser.id,
          publicKey: 'GMULTI' + 'F'.repeat(51),
          label: 'Multi Delivery Test'
        }
      });
      testWalletIds.push(testWallet.id);

      const testPayment = await prisma.payment.create({
        data: {
          walletId: testWallet.id,
          txHash: 'multi-delivery-hash',
          fromAddress: 'GFROM' + 'G'.repeat(51),
          amount: 75,
          asset: 'XLM'
        }
      });
      testPaymentIds.push(testPayment.id);

      const deliveryKey = `${testPayment.id}:email:test@example.com`;

      // Create multiple attempts
      const statuses = ['pending', 'failed', 'delivered', 'skipped'];
      const attemptIds: string[] = [];

      for (let i = 0; i < statuses.length; i++) {
        const attempt = await prisma.notificationDeliveryAttempt.create({
          data: {
            deliveryKey,
            paymentId: testPayment.id,
            channel: 'email',
            destination: 'test@example.com',
            status: statuses[i],
            attempt: i + 1,
            userId: testUser.id
          }
        });
        attemptIds.push(attempt.id);
        testDeliveryAttemptIds.push(attempt.id);
      }

      // Verify the composite index works for each status
      for (const status of statuses) {
        const result = await prisma.notificationDeliveryAttempt.findFirst({
          where: { deliveryKey, status },
          select: { id: true, status: true }
        });

        expect(result).not.toBeNull();
        expect(result?.status).toBe(status);
      }

      // Verify only one 'delivered' result
      const deliveredResults = await prisma.notificationDeliveryAttempt.findMany({
        where: { deliveryKey, status: 'delivered' }
      });

      expect(deliveredResults).toHaveLength(1);
      expect(deliveredResults[0].status).toBe('delivered');
    });
  });

  describe('Performance Characteristics', () => {
    it('executes wallet queries without timing out', async () => {
      const testUser = await prisma.user.create({
        data: { email: 'test-perf@test.local' }
      });
      testUserIds.push(testUser.id);

      // Create multiple wallets to test index effectiveness
      const walletPromises = Array.from({ length: 10 }, (_, i) => 
        prisma.wallet.create({
          data: {
            userId: testUser.id,
            publicKey: `GPERF${i.toString().padStart(2, '0')}${'H'.repeat(49)}`,
            label: `Performance Test Wallet ${i}`,
            createdAt: new Date(Date.now() - (i * 1000)) // Staggered times
          }
        }).then(w => { testWalletIds.push(w.id); return w; })
      );

      await Promise.all(walletPromises);

      // Time the query
      const start = performance.now();
      const wallets = await prisma.wallet.findMany({
        where: { userId: testUser.id },
        orderBy: { createdAt: 'desc' }
      });
      const duration = performance.now() - start;

      expect(wallets).toHaveLength(10);
      expect(duration).toBeLessThan(100); // Should be fast with index
      
      // Verify correct ordering
      for (let i = 0; i < wallets.length - 1; i++) {
        expect(wallets[i].createdAt.getTime()).toBeGreaterThanOrEqual(
          wallets[i + 1].createdAt.getTime()
        );
      }
    });

    it('executes delivery idempotency checks efficiently', async () => {
      const deliveryKey = 'performance-test-key';
      
      // Create test attempt
      const attempt = await prisma.notificationDeliveryAttempt.create({
        data: {
          deliveryKey,
          channel: 'performance',
          destination: 'test',
          status: 'delivered'
        }
      });
      testDeliveryAttemptIds.push(attempt.id);

      // Time the idempotency check
      const start = performance.now();
      const result = await prisma.notificationDeliveryAttempt.findFirst({
        where: { deliveryKey, status: 'delivered' },
        select: { id: true }
      });
      const duration = performance.now() - start;

      expect(result).not.toBeNull();
      expect(result?.id).toBe(attempt.id);
      expect(duration).toBeLessThan(50); // Should be very fast with composite index
    });
  });

  describe('Migration Rollback Safety', () => {
    it('can identify the composite indexes for rollback', async () => {
      const targetIndexes = [
        'Wallet_userId_createdAt_idx',
        'NotificationDeliveryAttempt_deliveryKey_status_idx'
      ];

      for (const indexName of targetIndexes) {
        const indexInfo = await prisma.$queryRaw<Array<{indexname: string}>>`
          SELECT indexname FROM pg_indexes 
          WHERE schemaname = 'public' AND indexname = ${indexName}
        `;

        expect(indexInfo).toHaveLength(1);
        expect(indexInfo[0].indexname).toBe(indexName);
      }

      // Verify we can get the exact DROP statements needed for rollback
      const dropStatements = targetIndexes.map(name => 
        `DROP INDEX IF EXISTS "${name}";`
      );

      expect(dropStatements).toEqual([
        'DROP INDEX IF EXISTS "Wallet_userId_createdAt_idx";',
        'DROP INDEX IF EXISTS "NotificationDeliveryAttempt_deliveryKey_status_idx";'
      ]);
    });
  });
});