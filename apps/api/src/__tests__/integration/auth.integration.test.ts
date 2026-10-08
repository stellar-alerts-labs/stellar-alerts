import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { TestServer, getTestServer, cleanupTestServer } from '../utils/test-server';
import { TestDatabase, setupTestIsolation, cleanupTestIsolation } from '../utils/test-db';
import { 
  createTestUser, 
  makeAuthenticatedRequest, 
  makeUnauthenticatedRequest 
} from '../utils/auth-helpers';

describe('Authentication Integration Tests', () => {
  let testServer: TestServer;

  beforeAll(async () => {
    // Check database connection before running tests
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

  describe('Health Endpoints (No Auth Required)', () => {
    it('should return health status', async () => {
      const response = await testServer.server
        .get('/health')
        .expect(200);

      expect(response.body).toEqual({ status: 'ok' });
    });

    it('should return readiness status', async () => {
      const response = await testServer.server
        .get('/health/ready')
        .expect(200);

      expect(response.body).toHaveProperty('status');
      expect(response.body).toHaveProperty('redis');
    });
  });

  describe('Authentication Success Cases', () => {
    it('should accept valid authentication token for /auth/me', async () => {
      const testUser = await createTestUser();
      const authRequest = makeAuthenticatedRequest(testServer, testUser);

      const response = await authRequest
        .get('/auth/me')
        .expect(200);

      expect(response.body).toEqual({
        success: true,
        user: expect.objectContaining({
          id: testUser.id,
          email: testUser.email,
        }),
      });
    });

    it('should successfully logout with valid token', async () => {
      const testUser = await createTestUser();
      const authRequest = makeAuthenticatedRequest(testServer, testUser);

      const response = await authRequest
        .post('/auth/logout')
        .expect(200);

      expect(response.body).toEqual({
        success: true,
        message: 'Logged out successfully.'
      });
    });
  });

  describe('Authentication Failure Cases', () => {
    it('should reject requests without Authorization header', async () => {
      const unauthRequest = makeUnauthenticatedRequest(testServer);

      const response = await unauthRequest
        .get('/auth/me')
        .expect(401);

      expect(response.body.error).toMatchObject({
        code: 'AUTH_REQUIRED',
        message: 'You must be logged in to perform this action.',
      });
      expect(response.body.error.requestId).toBeDefined();
    });

    it('should reject requests with malformed Authorization header', async () => {
      const response = await testServer.server
        .get('/auth/me')
        .set('Authorization', 'NotBearer invalid-token')
        .expect(401);

      expect(response.body.error).toMatchObject({
        code: 'AUTH_REQUIRED',
        message: 'You must be logged in to perform this action.',
      });
      expect(response.body.error.requestId).toBeDefined();
    });

    it('should reject requests with invalid JWT token', async () => {
      const response = await testServer.server
        .get('/auth/me')
        .set('Authorization', 'Bearer invalid.jwt.token')
        .expect(401);

      expect(response.body.error).toMatchObject({
        code: 'INVALID_TOKEN',
        message: 'Invalid or expired session token.',
      });
      expect(response.body.error.requestId).toBeDefined();
    });

    it('should reject requests with expired JWT token', async () => {
      // Create a token that's already expired
      const expiredToken = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6InVzci0xMjM0NSIsImVtYWlsIjoidGVzdEB0ZXN0LmNvbSIsImlhdCI6MTYwMDAwMDAwMCwiZXhwIjoxNjAwMDAwOTAwLCJqdGkiOiJleHBpcmVkLXRva2VuIn0.invalid';
      
      const response = await testServer.server
        .get('/auth/me')
        .set('Authorization', `Bearer ${expiredToken}`)
        .expect(401);

      expect(response.body.error).toMatchObject({
        code: 'INVALID_TOKEN',
        message: 'Invalid or expired session token.',
      });
      expect(response.body.error.requestId).toBeDefined();
    });
  });

  describe('Magic Link Flow', () => {
    it('should accept magic link request with valid email', async () => {
      const response = await testServer.server
        .post('/auth/request-link')
        .send({ email: 'test@example.com' })
        .expect(200);

      expect(response.body).toEqual({
        success: true,
        message: 'If the email exists, a magic link was sent.',
        token: expect.any(String), // Token is exposed in non-production
      });
    });

    it('should reject magic link request with invalid email', async () => {
      const response = await testServer.server
        .post('/auth/request-link')
        .send({ email: 'invalid-email' })
        .expect(400);

      expect(response.body.error).toMatchObject({
        code: 'VALIDATION_ERROR',
        message: 'Invalid email',
      });
      expect(response.body.error.details).toBeDefined();
    });

    it('should reject magic link request without email', async () => {
      const response = await testServer.server
        .post('/auth/request-link')
        .send({})
        .expect(400);

      expect(response.body.error).toMatchObject({
        code: 'VALIDATION_ERROR',
        message: 'Invalid email',
      });
    });
  });

  describe('MFA Endpoints Authentication', () => {
    it('should require authentication for MFA setup', async () => {
      const response = await testServer.server
        .post('/auth/mfa/setup')
        .expect(401);

      expect(response.body.error).toMatchObject({
        code: 'AUTH_REQUIRED',
        message: 'You must be logged in to perform this action.',
      });
      expect(response.body.error.requestId).toBeDefined();
    });

    it('should allow authenticated access to MFA status', async () => {
      const testUser = await createTestUser();
      const authRequest = makeAuthenticatedRequest(testServer, testUser);

      const response = await authRequest
        .get('/auth/mfa/status')
        .expect(200);

      expect(response.body).toEqual({
        success: true,
        mfaEnabled: false,
        recoveryCodesRemaining: 0,
        recoveryCodesTotal: 0,
      });
    });
  });
});