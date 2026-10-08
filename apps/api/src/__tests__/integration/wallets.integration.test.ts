import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { TestServer, getTestServer, cleanupTestServer } from '../utils/test-server';
import { TestDatabase, setupTestIsolation, cleanupTestIsolation } from '../utils/test-db';
import { 
  createTestUser, 
  createTestUsers,
  makeAuthenticatedRequest, 
  makeUnauthenticatedRequest,
} from '../utils/auth-helpers';

describe('Wallet Registration Integration Tests', () => {
  let testServer: TestServer;

  beforeAll(async () => {
    const dbConnected = await TestDatabase.checkConnection();
    if (!dbConnected) {
      throw new Error('Database connection failed. Ensure test database is running.');
    }
    
    testServer = await getTestServer();
  });

  afterAll(async () => {
    await cleanupTestServer();
  });

  beforeEach(async () => {
    await setupTestIsolation();
  });

  afterEach(async () => {
    await cleanupTestIsolation();
  });

  describe('Wallet Registration Success Cases', () => {
    it('should successfully register a wallet with valid public key', async () => {
      const testUser = await createTestUser();
      const authRequest = makeAuthenticatedRequest(testServer, testUser);

      const walletData = {
        publicKey: 'GBPDX2DPUHABCGNHXQRNK5A6NGV5R7T244HJ5CXAWSWVRTZR4WMADE72',
        label: 'Test Wallet',
      };

      const response = await authRequest
        .post('/wallets')
        .send(walletData)
        .expect(201);

      expect(response.body).toEqual({
        success: true,
        wallet: expect.objectContaining({
          id: expect.any(String),
          userId: testUser.id,
          publicKey: walletData.publicKey,
          label: walletData.label,
          createdAt: expect.any(String),
        }),
      });
    });

    it('should successfully register a wallet without label', async () => {
      const testUser = await createTestUser();
      const authRequest = makeAuthenticatedRequest(testServer, testUser);

      const walletData = {
        publicKey: 'GCVK6PYJVJ6BEU7IQM2A5ACL4Z74EJ5GMBGEHY63QUQRBD2THARK6UUV',
      };

      const response = await authRequest
        .post('/wallets')
        .send(walletData)
        .expect(201);

      expect(response.body).toEqual({
        success: true,
        wallet: expect.objectContaining({
          id: expect.any(String),
          userId: testUser.id,
          publicKey: walletData.publicKey,
          label: null,
          createdAt: expect.any(String),
        }),
      });
    });
  });

  describe('Wallet Registration Validation Failures', () => {
    it('should reject wallet registration with invalid public key', async () => {
      const testUser = await createTestUser();
      const authRequest = makeAuthenticatedRequest(testServer, testUser);

      const walletData = {
        publicKey: 'INVALID_PUBLIC_KEY_FORMAT',
        label: 'Test Wallet',
      };

      const response = await authRequest
        .post('/wallets')
        .send(walletData)
        .expect(400);

      expect(response.body.error).toMatchObject({
        code: 'VALIDATION_ERROR',
        message: 'Invalid payload',
        details: expect.objectContaining({
          publicKey: expect.objectContaining({
            _errors: expect.arrayContaining(['Invalid Stellar public key format or checksum']),
          }),
        }),
      });
    });

    it('should reject wallet registration without public key', async () => {
      const testUser = await createTestUser();
      const authRequest = makeAuthenticatedRequest(testServer, testUser);

      const walletData = {
        label: 'Test Wallet',
      };

      const response = await authRequest
        .post('/wallets')
        .send(walletData)
        .expect(400);

      expect(response.body.error).toMatchObject({
        code: 'VALIDATION_ERROR',
        message: 'Invalid payload',
        details: expect.objectContaining({
          publicKey: expect.objectContaining({
            _errors: expect.arrayContaining(['Invalid input: expected string, received undefined']),
          }),
        }),
      });
    });

    it('should reject wallet registration with malformed public key', async () => {
      const testUser = await createTestUser();
      const authRequest = makeAuthenticatedRequest(testServer, testUser);

      const walletData = {
        publicKey: 'GA', // Too short
        label: 'Test Wallet',
      };

      const response = await authRequest
        .post('/wallets')
        .send(walletData)
        .expect(400);

      expect(response.body.error).toMatchObject({
        code: 'VALIDATION_ERROR',
        message: 'Invalid payload',
        details: expect.objectContaining({
          publicKey: expect.objectContaining({
            _errors: expect.arrayContaining(['Invalid Stellar public key format or checksum']),
          }),
        }),
      });
    });
  });

  describe('Wallet Registration Authorization Failures', () => {
    it('should reject unauthenticated wallet registration', async () => {
      const unauthRequest = makeUnauthenticatedRequest(testServer);

      const walletData = {
        publicKey: 'GBPDX2DPUHABCGNHXQRNK5A6NGV5R7T244HJ5CXAWSWVRTZR4WMADE72',
        label: 'Test Wallet',
      };

      const response = await unauthRequest
        .post('/wallets')
        .send(walletData)
        .expect(401);

      expect(response.body.error).toMatchObject({
        code: 'AUTH_REQUIRED',
        message: 'You must be logged in to perform this action.',
      });
      expect(response.body.error.requestId).toBeDefined();
    });
  });

  describe('Duplicate Wallet Registration', () => {
    it('should reject duplicate wallet registration for same public key', async () => {
      const testUser = await createTestUser();
      const authRequest = makeAuthenticatedRequest(testServer, testUser);

      const walletData = {
        publicKey: 'GBPDX2DPUHABCGNHXQRNK5A6NGV5R7T244HJ5CXAWSWVRTZR4WMADE72',
        label: 'First Wallet',
      };

      // First registration should succeed
      await authRequest
        .post('/wallets')
        .send(walletData)
        .expect(201);

      // Second registration with same public key should fail
      const duplicateData = {
        ...walletData,
        label: 'Duplicate Wallet',
      };

      const response = await authRequest
        .post('/wallets')
        .send(duplicateData)
        .expect(409);

      expect(response.body.error).toMatchObject({
        code: 'CONFLICT',
        message: 'Wallet address is already registered',
      });
    });

    it('should reject duplicate registration even by different users', async () => {
      const [user1, user2] = await createTestUsers(2);

      const walletData = {
        publicKey: 'GBPDX2DPUHABCGNHXQRNK5A6NGV5R7T244HJ5CXAWSWVRTZR4WMADE72',
        label: 'Test Wallet',
      };

      // User 1 registers wallet
      const auth1 = makeAuthenticatedRequest(testServer, user1);
      await auth1
        .post('/wallets')
        .send(walletData)
        .expect(201);

      // User 2 tries to register same wallet
      const auth2 = makeAuthenticatedRequest(testServer, user2);
      const response = await auth2
        .post('/wallets')
        .send(walletData)
        .expect(409);

      expect(response.body.error).toMatchObject({
        code: 'CONFLICT',
        message: 'Wallet address is already registered',
      });
    });
  });

  describe('Wallet Listing', () => {
    it('should return empty list for user with no wallets', async () => {
      const testUser = await createTestUser();
      const authRequest = makeAuthenticatedRequest(testServer, testUser);

      const response = await authRequest
        .get('/wallets')
        .expect(200);

      expect(response.body).toEqual({
        success: true,
        wallets: [],
        pagination: {
          limit: 20,
          nextCursor: undefined,
          hasNextPage: false,
        },
      });
    });

    it('should return user wallets in descending order by creation date', async () => {
      const testUser = await createTestUser();
      const authRequest = makeAuthenticatedRequest(testServer, testUser);

      // Register first wallet
      const wallet1Data = {
        publicKey: 'GBPDX2DPUHABCGNHXQRNK5A6NGV5R7T244HJ5CXAWSWVRTZR4WMADE72',
        label: 'First Wallet',
      };
      await authRequest.post('/wallets').send(wallet1Data).expect(201);

      // Small delay to ensure different timestamps
      await new Promise(resolve => setTimeout(resolve, 10));

      // Register second wallet
      const wallet2Data = {
        publicKey: 'GBOYT5ZJJBQQIU7ONRSDMDVTSD2JSW4AA3O5HEYRUXZCJVUQLHP62CTP',
        label: 'Second Wallet',
      };
      await authRequest.post('/wallets').send(wallet2Data).expect(201);

      const response = await authRequest
        .get('/wallets')
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.wallets).toHaveLength(2);
      
      // Should be in descending order (most recent first)
      expect(response.body.wallets[0].publicKey).toBe(wallet2Data.publicKey);
      expect(response.body.wallets[1].publicKey).toBe(wallet1Data.publicKey);
    });

    it('should require authentication for wallet listing', async () => {
      const unauthRequest = makeUnauthenticatedRequest(testServer);

      const response = await unauthRequest
        .get('/wallets')
        .expect(401);

      expect(response.body.error).toMatchObject({
        code: 'AUTH_REQUIRED',
        message: 'You must be logged in to perform this action.',
      });
      expect(response.body.error.requestId).toBeDefined();
    });
  });

  describe('Wallet Authorization/Isolation', () => {
    it('should only return wallets owned by the authenticated user', async () => {
      const [user1, user2] = await createTestUsers(2);

      // User 1 registers wallets
      const auth1 = makeAuthenticatedRequest(testServer, user1);
      await auth1.post('/wallets').send({
        publicKey: 'GBPDX2DPUHABCGNHXQRNK5A6NGV5R7T244HJ5CXAWSWVRTZR4WMADE72',
        label: 'User 1 Wallet',
      }).expect(201);

      // User 2 registers wallets
      const auth2 = makeAuthenticatedRequest(testServer, user2);
      await auth2.post('/wallets').send({
        publicKey: 'GBS2HF3CE2CPEEANUDGALQFDQLPRLO6DU5NVO745PNZ2B6LLPYAHGV5V',
        label: 'User 2 Wallet',
      }).expect(201);

      // User 1 should only see their wallet
      const response1 = await auth1.get('/wallets').expect(200);
      expect(response1.body.wallets).toHaveLength(1);
      expect(response1.body.wallets[0].label).toBe('User 1 Wallet');

      // User 2 should only see their wallet
      const response2 = await auth2.get('/wallets').expect(200);
      expect(response2.body.wallets).toHaveLength(1);
      expect(response2.body.wallets[0].label).toBe('User 2 Wallet');
    });
  });
});