import { prisma } from '../../lib/prisma';
import { authService } from '../../modules/auth/auth.service';
import { generateAccessToken } from '../../utils/jwt';
import { TestServer } from './test-server';

export interface TestUser {
  id: string;
  email: string;
  token: string;
}

export interface CreateTestUserOptions {
  email?: string;
  mfaEnabled?: boolean;
}

/**
 * Creates a test user and returns authentication context
 */
export async function createTestUser(options: CreateTestUserOptions = {}): Promise<TestUser> {
  const email = options.email || `test-user-${Date.now()}-${Math.random().toString(36).substr(2, 9)}@test.example`;
  
  // Create user directly in database to avoid external dependencies
  const user = await prisma.user.create({
    data: {
      email,
      mfaEnabled: options.mfaEnabled || false,
    },
  });

  // Generate a valid access token for this user
  const token = generateAccessToken(user);

  return {
    id: user.id,
    email: user.email,
    token,
  };
}

/**
 * Creates a test user with a wallet
 */
export async function createTestUserWithWallet(publicKey?: string): Promise<TestUser & { walletId: string }> {
  const user = await createTestUser();
  const defaultPublicKey = publicKey || `GBPDX2DPUHABCGNHXQRNK5A6NGV5R7T244HJ5CXAWSWVRTZR4WMADE${Math.random().toString(36).substr(2, 2).toUpperCase()}`;
  
  const wallet = await prisma.wallet.create({
    data: {
      userId: user.id,
      publicKey: defaultPublicKey,
      label: 'Test Wallet',
    },
  });

  return {
    ...user,
    walletId: wallet.id,
  };
}

/**
 * Creates multiple test users for testing authorization isolation
 */
export async function createTestUsers(count: number = 2): Promise<TestUser[]> {
  const users: TestUser[] = [];
  for (let i = 0; i < count; i++) {
    const user = await createTestUser({ email: `test-user-${i}-${Date.now()}@test.example` });
    users.push(user);
  }
  return users;
}

/**
 * Helper to make authenticated requests
 */
export function makeAuthenticatedRequest(server: TestServer, user: TestUser) {
  return {
    get: (path: string) => server.server.get(path).set('Authorization', `Bearer ${user.token}`),
    post: (path: string) => server.server.post(path).set('Authorization', `Bearer ${user.token}`),
    put: (path: string) => server.server.put(path).set('Authorization', `Bearer ${user.token}`),
    patch: (path: string) => server.server.patch(path).set('Authorization', `Bearer ${user.token}`),
    delete: (path: string) => server.server.delete(path).set('Authorization', `Bearer ${user.token}`),
  };
}

/**
 * Helper to make unauthenticated requests (for testing auth failures)
 */
export function makeUnauthenticatedRequest(server: TestServer) {
  return {
    get: (path: string) => server.server.get(path),
    post: (path: string) => server.server.post(path),
    put: (path: string) => server.server.put(path),
    patch: (path: string) => server.server.patch(path),
    delete: (path: string) => server.server.delete(path),
  };
}

/**
 * Cleanup test users and related data
 */
export async function cleanupTestUsers(): Promise<void> {
  // Clean up dependent rows before users to satisfy foreign-key constraints.
  // Mirrors the ordering in TestDatabase.cleanup() (test-db.ts).
  const userWhere = {
    email: {
      contains: 'test.example'
    }
  } as const;

  await prisma.notificationPreference.deleteMany({ where: { user: userWhere } });
  await prisma.deadLetter.deleteMany({ where: { user: userWhere } });
  await prisma.notificationDeliveryAttempt.deleteMany({ where: { user: userWhere } });
  await prisma.notificationDelivery.deleteMany({ where: { user: userWhere } });
  await prisma.refreshSession.deleteMany({ where: { user: userWhere } });
  await prisma.mfaRecoveryCode.deleteMany({ where: { user: userWhere } });

  await prisma.wallet.deleteMany({
    where: {
      user: userWhere
    }
  });

  await prisma.user.deleteMany({
    where: {
      email: {
        contains: 'test.example'
      }
    }
  });
}