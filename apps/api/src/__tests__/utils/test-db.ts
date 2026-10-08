import { prisma } from '../../lib/prisma';

/**
 * Database utilities for test isolation
 * 
 * This provides helpers to ensure tests start from a clean state
 * and clean up after themselves.
 */
export class TestDatabase {
  /**
   * Clean up test data between tests
   * Removes all records that were created during testing
   */
  static async cleanup(): Promise<void> {
    // Clean up in correct order due to foreign key constraints
    try {
      // Delete ingestion cursors first (they reference wallets)
      await prisma.ingestionCursor.deleteMany({
        where: {
          wallet: {
            user: {
              email: {
                contains: 'test.example'
              }
            }
          }
        }
      });

      // Delete payments (they reference wallets)
      await prisma.payment.deleteMany({
        where: {
          wallet: {
            user: {
              email: {
                contains: 'test.example'
              }
            }
          }
        }
      });

      // Delete test wallets (they reference users)
      await prisma.wallet.deleteMany({
        where: {
          OR: [
            {
              user: {
                email: {
                  contains: 'test.example'
                }
              }
            },
            {
              publicKey: {
                startsWith: 'GBPDX2DPUHABCGNHXQRNK5A6NGV5R7T244HJ5CXAWSWVRTZR4WMADE'
              }
            },
            {
              publicKey: {
                startsWith: 'GDQJ7Z7LJDFT4ESK3WCGAMDQYQCEIYLW7N5RLQH5XQJCAUNG4C3ZASJ'
              }
            }
          ]
        }
      });

      // Delete notification preferences (they reference users)
      await prisma.notificationPreference.deleteMany({
        where: {
          user: {
            email: {
              contains: 'test.example'
            }
          }
        }
      });

      // Delete dead letters (they reference users)
      await prisma.deadLetter.deleteMany({
        where: {
          user: {
            email: {
              contains: 'test.example'
            }
          }
        }
      });

      // Delete notification delivery attempts (they reference users)
      await prisma.notificationDeliveryAttempt.deleteMany({
        where: {
          user: {
            email: {
              contains: 'test.example'
            }
          }
        }
      });

      // Delete notification deliveries (they reference users)
      await prisma.notificationDelivery.deleteMany({
        where: {
          user: {
            email: {
              contains: 'test.example'
            }
          }
        }
      });

      // Delete refresh sessions (they reference users)
      await prisma.refreshSession.deleteMany({
        where: {
          user: {
            email: {
              contains: 'test.example'
            }
          }
        }
      });

      // Delete MFA recovery codes (they reference users)
      await prisma.mfaRecoveryCode.deleteMany({
        where: {
          user: {
            email: {
              contains: 'test.example'
            }
          }
        }
      });

      // Delete test users last (they are referenced by everything else)
      await prisma.user.deleteMany({
        where: {
          email: {
            contains: 'test.example'
          }
        }
      });

      // Clean up any orphaned test data by public key patterns
      await prisma.wallet.deleteMany({
        where: {
          OR: [
            { publicKey: { startsWith: 'GBPDX2DPUHABCGNHXQRNK5A6NGV5R7T244HJ5CXAWSWVRTZR4WMADE' } },
            { publicKey: { startsWith: 'GDQJ7Z7LJDFT4ESK3WCGAMDQYQCEIYLW7N5RLQH5XQJCAUNG4C3ZASJ' } },
          ]
        }
      });

    } catch (error) {
      console.error('Test cleanup error:', error);
      // Don't throw to avoid breaking test suite, but log for debugging
    }
  }

  /**
   * Reset the database to a known state for testing
   */
  static async reset(): Promise<void> {
    await this.cleanup();
  }

  /**
   * Check database connection
   */
  static async checkConnection(): Promise<boolean> {
    try {
      await prisma.$queryRaw`SELECT 1`;
      return true;
    } catch (error) {
      console.error('Database connection check failed:', error);
      return false;
    }
  }
}

/**
 * Test isolation helper that can be used in beforeEach/afterEach
 */
export async function setupTestIsolation(): Promise<void> {
  await TestDatabase.reset();
}

export async function cleanupTestIsolation(): Promise<void> {
  await TestDatabase.cleanup();
}