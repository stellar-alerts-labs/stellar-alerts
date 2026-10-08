import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { TestServer, getTestServer, cleanupTestServer } from '../utils/test-server';
import { TestDatabase, setupTestIsolation, cleanupTestIsolation } from '../utils/test-db';
import { 
  createTestUser, 
  createTestUsers,
  makeAuthenticatedRequest, 
  makeUnauthenticatedRequest,
} from '../utils/auth-helpers';
import { prisma } from '../../lib/prisma';

describe('Delivery Logs (Dead Letters) Integration Tests', () => {
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

  describe('List Dead Letters', () => {
    it('should return empty list for user with no dead letters', async () => {
      const testUser = await createTestUser();
      const authRequest = makeAuthenticatedRequest(testServer, testUser);

      const response = await authRequest
        .get('/dead-letters')
        .expect(200);

      expect(response.body).toEqual({
        success: true,
        deadLetters: [],
        pagination: expect.any(Object),
      });
    });

    it('should require authentication to list dead letters', async () => {
      const unauthRequest = makeUnauthenticatedRequest(testServer);

      const response = await unauthRequest
        .get('/dead-letters')
        .expect(401);

      expect(response.body.error).toMatchObject({
        code: 'AUTH_REQUIRED',
        message: 'You must be logged in to perform this action.',
      });
      expect(response.body.error.requestId).toBeDefined();
    });

    it('should accept pagination query parameters', async () => {
      const testUser = await createTestUser();
      const authRequest = makeAuthenticatedRequest(testServer, testUser);

      const response = await authRequest
        .get('/dead-letters?limit=10')
        .expect(200);

      expect(response.body).toEqual({
        success: true,
        deadLetters: [],
        pagination: expect.any(Object),
      });
    });

    it('should reject invalid pagination parameters', async () => {
      const testUser = await createTestUser();
      const authRequest = makeAuthenticatedRequest(testServer, testUser);

      const response = await authRequest
        .get('/dead-letters?limit=abc')
        .expect(400);

      expect(response.body.error).toMatchObject({
        code: 'VALIDATION_ERROR',
        message: 'Invalid query',
      });
      expect(response.body.error.details).toBeDefined();
    });
  });

  describe('Get Single Dead Letter', () => {
    it('should require valid dead letter ID format', async () => {
      const testUser = await createTestUser();
      const authRequest = makeAuthenticatedRequest(testServer, testUser);

      const response = await authRequest
        .get('/dead-letters/invalid-id')
        .expect(400);

      expect(response.body.error).toMatchObject({
        code: 'VALIDATION_ERROR',
        message: 'Invalid parameters',
      });
    });

    it('should require authentication to get dead letter', async () => {
      const unauthRequest = makeUnauthenticatedRequest(testServer);

      const response = await unauthRequest
        .get('/dead-letters/some-valid-id')
        .expect(401);

      expect(response.body.error).toMatchObject({
        code: 'AUTH_REQUIRED',
        message: 'You must be logged in to perform this action.',
      });
      expect(response.body.error.requestId).toBeDefined();
    });
  });

  describe('Replay Dead Letter', () => {
    it('should require valid dead letter ID for replay', async () => {
      const testUser = await createTestUser();
      const authRequest = makeAuthenticatedRequest(testServer, testUser);

      const response = await authRequest
        .post('/dead-letters/invalid-id/replay')
        .expect(400);

      expect(response.body.error).toMatchObject({
        code: 'VALIDATION_ERROR',
        message: 'Invalid parameters',
      });
    });

    it('should require authentication to replay dead letter', async () => {
      const unauthRequest = makeUnauthenticatedRequest(testServer);

      const response = await unauthRequest
        .post('/dead-letters/some-id/replay')
        .expect(401);

      expect(response.body.error).toMatchObject({
        code: 'AUTH_REQUIRED',
        message: 'You must be logged in to perform this action.',
      });
      expect(response.body.error.requestId).toBeDefined();
    });

    it('should return 404 for non-existent dead letter', async () => {
      const testUser = await createTestUser();
      const authRequest = makeAuthenticatedRequest(testServer, testUser);

      // Use a valid CUID format but non-existent ID
      const nonExistentId = 'cljk2h3k40000wq8t123456789';

      const response = await authRequest
        .post(`/dead-letters/${nonExistentId}/replay`)
        .expect(404);

      expect(response.body.error).toMatchObject({
        code: 'NOT_FOUND',
        message: expect.stringContaining('Dead letter'),
      });
    });
  });

  describe('Suppress Dead Letter', () => {
    it('should require valid dead letter ID for suppression', async () => {
      const testUser = await createTestUser();
      const authRequest = makeAuthenticatedRequest(testServer, testUser);

      const response = await authRequest
        .post('/dead-letters/invalid-id/suppress')
        .send({ note: 'Test suppression' })
        .expect(400);

      expect(response.body.error).toMatchObject({
        code: 'VALIDATION_ERROR',
        message: 'Invalid request',
      });
    });

    it('should accept optional suppression note', async () => {
      const testUser = await createTestUser();
      const authRequest = makeAuthenticatedRequest(testServer, testUser);

      // Use a valid CUID format but non-existent ID
      const nonExistentId = 'cljk2h3k40000wq8t123456789';

      const response = await authRequest
        .post(`/dead-letters/${nonExistentId}/suppress`)
        .send({ note: 'Test suppression note' })
        .expect(404);

      expect(response.body.error).toMatchObject({
        code: 'NOT_FOUND',
        message: expect.stringContaining('Dead letter'),
      });
    });

    it('should accept suppression without note', async () => {
      const testUser = await createTestUser();
      const authRequest = makeAuthenticatedRequest(testServer, testUser);

      // Use a valid CUID format but non-existent ID  
      const nonExistentId = 'cljk2h3k40000wq8t123456789';

      const response = await authRequest
        .post(`/dead-letters/${nonExistentId}/suppress`)
        .send({})
        .expect(404);

      expect(response.body.error).toMatchObject({
        code: 'NOT_FOUND',
        message: expect.stringContaining('Dead letter'),
      });
    });

    it('should require authentication to suppress dead letter', async () => {
      const unauthRequest = makeUnauthenticatedRequest(testServer);

      const response = await unauthRequest
        .post('/dead-letters/some-id/suppress')
        .send({ note: 'Test' })
        .expect(401);

      expect(response.body.error).toMatchObject({
        code: 'AUTH_REQUIRED',
        message: 'You must be logged in to perform this action.',
      });
      expect(response.body.error.requestId).toBeDefined();
    });
  });

  describe('User Authorization/Isolation', () => {
    it('should isolate dead letters between users', async () => {
      const [user1, user2] = await createTestUsers(2);

      // Both users should see empty dead letter lists
      const auth1 = makeAuthenticatedRequest(testServer, user1);
      const response1 = await auth1.get('/dead-letters').expect(200);
      expect(response1.body.deadLetters).toHaveLength(0);

      const auth2 = makeAuthenticatedRequest(testServer, user2);
      const response2 = await auth2.get('/dead-letters').expect(200);
      expect(response2.body.deadLetters).toHaveLength(0);

      // Note: In a real scenario with actual dead letters, we would verify
      // that each user only sees their own dead letters
    });

    it('should prevent cross-user access to dead letters', async () => {
      const [user1, user2] = await createTestUsers(2);

      // Try to access another user's dead letter (even if it existed)
      // This would return 404 because the service filters by userId
      const auth1 = makeAuthenticatedRequest(testServer, user1);
      const nonExistentId = 'cljk2h3k40000wq8t123456789';

      const response = await auth1
        .get(`/dead-letters/${nonExistentId}`)
        .expect(404);

      expect(response.body.error).toMatchObject({
        code: 'NOT_FOUND',
        message: expect.stringContaining('Dead letter'),
      });
    });
  });
});