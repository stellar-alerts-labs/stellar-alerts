import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { TestServer, getTestServer, cleanupTestServer } from '../utils/test-server';
import { TestDatabase, setupTestIsolation, cleanupTestIsolation } from '../utils/test-db';
import { 
  createTestUser, 
  createTestUsers,
  createTestUserWithWallet,
  makeAuthenticatedRequest, 
  makeUnauthenticatedRequest,
} from '../utils/auth-helpers';

describe('Comprehensive Validation and Authorization Tests', () => {
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

  describe('Authentication Validation Across All Protected Endpoints', () => {
    const protectedEndpoints = [
      { method: 'GET', path: '/auth/me' },
      { method: 'POST', path: '/auth/logout' },
      { method: 'POST', path: '/auth/revoke-session' },
      { method: 'GET', path: '/auth/mfa/status' },
      { method: 'POST', path: '/auth/mfa/setup' },
      { method: 'GET', path: '/wallets' },
      { method: 'POST', path: '/wallets' },
      { method: 'GET', path: '/notifications/preferences' },
      { method: 'POST', path: '/notifications/preferences' },
      { method: 'POST', path: '/notifications/test-ping' },
      { method: 'GET', path: '/dead-letters' },
    ];

    protectedEndpoints.forEach(({ method, path }) => {
      it(`should require authentication for ${method} ${path}`, async () => {
        const unauthRequest = makeUnauthenticatedRequest(testServer);
        let request = unauthRequest.get(path);

        if (method === 'POST') {
          request = unauthRequest.post(path);
        } else if (method === 'PUT') {
          request = unauthRequest.put(path);
        } else if (method === 'PATCH') {
          request = unauthRequest.patch(path);
        } else if (method === 'DELETE') {
          request = unauthRequest.delete(path);
        }

        const response = await request.expect(401);

        expect(response.body.error).toMatchObject({
          code: 'AUTH_REQUIRED',
          message: 'You must be logged in to perform this action.',
        });
        expect(response.body.error.requestId).toBeDefined();
      });
    });

    it('should reject malformed Authorization headers consistently', async () => {
      const malformedHeaders = [
        'Bearer',
        'Bearer ',
        'NotBearer valid-token',
        'bearer lowercase-bearer',
        'Basic not-jwt-auth',
      ];

      for (const header of malformedHeaders) {
        const response = await testServer.server
          .get('/auth/me')
          .set('Authorization', header)
          .expect(401);

        expect(response.body.error).toMatchObject({
          code: 'AUTH_REQUIRED',
          message: 'You must be logged in to perform this action.',
        });
        expect(response.body.error.requestId).toBeDefined();
      }
    });

    it('should reject invalid JWT tokens consistently', async () => {
      const invalidTokens = [
        'invalid.jwt.token',
        'eyJ0eXAiOiJKV1QiLCJhbGciOiJub25lIn0.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiYWRtaW4iOnRydWV9.',
        'expired-or-malformed-token',
      ];

      for (const token of invalidTokens) {
        const response = await testServer.server
          .get('/auth/me')
          .set('Authorization', `Bearer ${token}`)
          .expect(401);

        expect(response.body.error).toMatchObject({
          code: 'INVALID_TOKEN',
          message: 'Invalid or expired session token.',
        });
        expect(response.body.error.requestId).toBeDefined();
      }
    });
  });

  describe('Request Validation Failures', () => {
    describe('Wallet Registration Validation', () => {
      it('should validate required fields comprehensively', async () => {
        const testUser = await createTestUser();
        const authRequest = makeAuthenticatedRequest(testServer, testUser);

        const invalidPayloads = [
          {},
          { publicKey: null },
          { publicKey: undefined },
          { publicKey: '' },
          { publicKey: 123 },
          { publicKey: ['not-a-string'] },
          { publicKey: { invalid: 'object' } },
        ];

        for (const payload of invalidPayloads) {
          const response = await authRequest
            .post('/wallets')
            .send(payload)
            .expect(400);

          expect(response.body.error).toMatchObject({
            code: 'VALIDATION_ERROR',
            message: 'Invalid payload',
          });
          expect(response.body.error.details).toBeDefined();
        }
      });

      it('should validate Stellar public key format strictly', async () => {
        const testUser = await createTestUser();
        const authRequest = makeAuthenticatedRequest(testServer, testUser);

        const invalidPublicKeys = [
          'GB', // Too short
          'GBPDX2DPUHABCGNHXQRNK5A6NGV5R7T244HJ5CXAWSWVRTZR4WMADE', // Missing char
          'GBPDX2DPUHABCGNHXQRNK5A6NGV5R7T244HJ5CXAWSWVRTZR4WMADE721', // Too long
          'XBPDX2DPUHABCGNHXQRNK5A6NGV5R7T244HJ5CXAWSWVRTZR4WMADE72', // Wrong prefix
          'gbpdx2dpuhabcgnhxqrnk5a6ngv5r7t244hj5cxawswvrtzr4wmade72', // Lowercase
          'INVALID_PUBLIC_KEY_WITH_UNDERSCORE_CHARACTERS',
          'GBPDX2DPUHABCGNHXQRNK5A6NGV5R7T244HJ5CXAWSWVRTZR4WMADE00', // Invalid checksum
        ];

        for (const publicKey of invalidPublicKeys) {
          const response = await authRequest
            .post('/wallets')
            .send({ publicKey })
            .expect(400);

          expect(response.body.error.details.publicKey._errors).toContain(
            'Invalid Stellar public key format or checksum'
          );
        }
      });
    });

    describe('Notification Preferences Validation', () => {
      it('should validate WhatsApp number format', async () => {
        const testUser = await createTestUser();
        const authRequest = makeAuthenticatedRequest(testServer, testUser);

        const invalidWhatsAppNumbers = [
          '1234567890', // Missing +
          '+1234', // Too short
          'invalid-phone',
          '+123456789012345678901234', // Too long
          '+1-800-123-4567', // Dashes not allowed in E.164
          '+1 (800) 123-4567', // Spaces and parentheses not allowed
        ];

        for (const whatsappNumber of invalidWhatsAppNumbers) {
          const response = await authRequest
            .post('/notifications/preferences')
            .send({ whatsappNumber, whatsappEnabled: true })
            .expect(400);

          expect(response.body.error).toMatchObject({
            code: 'INVALID_WHATSAPP_PREFERENCES',
            message: 'Invalid WhatsApp number. Use E.164 format, e.g. +14155551234.',
          });
        }
      });

      it('should validate test ping channel parameter', async () => {
        const testUser = await createTestUser();
        const authRequest = makeAuthenticatedRequest(testServer, testUser);

        const invalidChannels = [
          'invalid-channel',
          'email',
          'whatsapp',
          'sms',
          '',
          null,
          123,
        ];

        for (const channel of invalidChannels) {
          const response = await authRequest
            .post('/notifications/test-ping')
            .send({ channel })
            .expect(400);

          expect(response.body.error).toMatchObject({
            code: 'INVALID_CHANNEL',
            message: 'channel must be "telegram"',
          });
        }
      });
    });

    describe('Dead Letters Query Validation', () => {
      it('should validate pagination parameters', async () => {
        const testUser = await createTestUser();
        const authRequest = makeAuthenticatedRequest(testServer, testUser);

        const invalidQueries = [
          '?limit=-1',
          '?limit=0',
          '?limit=not-a-number',
          '?limit=1.5',
          '?limit=1000000', // Potentially too large
        ];

        for (const query of invalidQueries) {
          const response = await authRequest
            .get(`/dead-letters${query}`)
            .expect(400);

          expect(response.body.error).toMatchObject({
            code: 'VALIDATION_ERROR',
            message: 'Invalid query',
          });
        }
      });

      it('should validate dead letter ID format', async () => {
        const testUser = await createTestUser();
        const authRequest = makeAuthenticatedRequest(testServer, testUser);

        const invalidIds = [
          'invalid-id',
          '',
          '123',
          'not-a-cuid',
          'too-short',
          'way-too-long-to-be-a-valid-cuid-identifier',
        ];

        for (const id of invalidIds) {
          const response = await authRequest
            .get(`/dead-letters/${id}`)
            .expect(400);

          expect(response.body.error).toMatchObject({
            code: 'VALIDATION_ERROR',
            message: 'Invalid parameters',
          });
        }
      });
    });
  });

  describe('Resource Ownership and Isolation', () => {
    describe('Wallet Ownership', () => {
      it('should enforce wallet ownership in listing', async () => {
        const [user1, user2] = await createTestUsers(2);

        // Create wallets for each user
        const auth1 = makeAuthenticatedRequest(testServer, user1);
        await auth1.post('/wallets').send({
          publicKey: 'GBPDX2DPUHABCGNHXQRNK5A6NGV5R7T244HJ5CXAWSWVRTZR4WMADE72',
          label: 'User 1 Wallet',
        });

        const auth2 = makeAuthenticatedRequest(testServer, user2);
        await auth2.post('/wallets').send({
          publicKey: 'GBXKLMIJND3WUCENWNUKCZ2PNWNI7LL757JRBMHVVRORYIMEDNYWDIJS',
          label: 'User 2 Wallet',
        });

        // Each user should only see their own wallets
        const response1 = await auth1.get('/wallets').expect(200);
        expect(response1.body.wallets).toHaveLength(1);
        expect(response1.body.wallets[0].label).toBe('User 1 Wallet');

        const response2 = await auth2.get('/wallets').expect(200);
        expect(response2.body.wallets).toHaveLength(1);
        expect(response2.body.wallets[0].label).toBe('User 2 Wallet');
      });

      it('should enforce wallet ownership in ingestion status access', async () => {
        const user = await createTestUserWithWallet();
        const authRequest = makeAuthenticatedRequest(testServer, user);

        // Create another user to test cross-user access
        const otherUser = await createTestUser();
        const otherAuthRequest = makeAuthenticatedRequest(testServer, otherUser);

        // User should be able to access their wallet's ingestion status
        const response = await authRequest
          .get(`/wallets/${user.walletId}/ingestion-status`)
          .expect(200);

        expect(response.body.success).toBe(true);

        // Other user should not be able to access the first user's wallet
        const unauthorizedResponse = await otherAuthRequest
          .get(`/wallets/${user.walletId}/ingestion-status`)
          .expect(404);

        expect(unauthorizedResponse.body.error).toMatchObject({
          code: 'NOT_FOUND',
          message: 'Wallet not found',
        });
      });
    });

    describe('Notification Preferences Isolation', () => {
      it('should prevent cross-user preference access', async () => {
        const [user1, user2] = await createTestUsers(2);

        // Set preferences for user1
        const auth1 = makeAuthenticatedRequest(testServer, user1);
        await auth1.post('/notifications/preferences').send({
          emailEnabled: true,
          telegramChatId: 'user1-telegram',
        });

        // Set preferences for user2
        const auth2 = makeAuthenticatedRequest(testServer, user2);
        await auth2.post('/notifications/preferences').send({
          emailEnabled: false,
          telegramChatId: 'user2-telegram',
        });

        // Verify each user only sees their own preferences
        const response1 = await auth1.get('/notifications/preferences').expect(200);
        expect(response1.body.preferences.telegramChatId).toBe('user1-telegram');

        const response2 = await auth2.get('/notifications/preferences').expect(200);
        expect(response2.body.preferences.telegramChatId).toBe('user2-telegram');
      });
    });

    describe('Dead Letters Authorization', () => {
      it('should enforce user isolation in dead letters access', async () => {
        const [user1, user2] = await createTestUsers(2);

        // Both users should see empty lists (proper isolation)
        const auth1 = makeAuthenticatedRequest(testServer, user1);
        const response1 = await auth1.get('/dead-letters').expect(200);
        expect(response1.body.deadLetters).toHaveLength(0);

        const auth2 = makeAuthenticatedRequest(testServer, user2);
        const response2 = await auth2.get('/dead-letters').expect(200);
        expect(response2.body.deadLetters).toHaveLength(0);

        // Trying to access non-existent dead letter should return 404
        // (not 403, which would leak existence information)
        const nonExistentId = 'cljk2h3k40000wq8t123456789';
        const response3 = await auth1.get(`/dead-letters/${nonExistentId}`).expect(404);
        expect(response3.body.error.message).toContain('Dead letter');
      });
    });
  });

  describe('Rate Limiting and Edge Cases', () => {
    it('should handle concurrent requests properly', async () => {
      const testUser = await createTestUser();
      const authRequest = makeAuthenticatedRequest(testServer, testUser);

      // Make multiple concurrent requests to the same endpoint
      const promises = Array.from({ length: 5 }, () => 
        authRequest.get('/auth/me').expect(200)
      );

      const responses = await Promise.all(promises);

      // All requests should succeed with the same user data
      responses.forEach(response => {
        expect(response.body.user.id).toBe(testUser.id);
      });
    });

    it('should handle empty request bodies gracefully', async () => {
      const testUser = await createTestUser();
      const authRequest = makeAuthenticatedRequest(testServer, testUser);

      // Test various endpoints with empty bodies
      const prefsResponse = await authRequest.post('/notifications/preferences').send().expect(200);
      expect(prefsResponse.body.success).toBe(true);

      // Logout last: it revokes the token, so no authenticated request may follow.
      await authRequest.post('/auth/logout').send().expect(200);
    });

    it('should handle malformed JSON payloads', async () => {
      const testUser = await createTestUser();

      // Send malformed JSON to various endpoints
      const response = await testServer.server
        .post('/wallets')
        .set('Authorization', `Bearer ${testUser.token}`)
        .set('Content-Type', 'application/json')
        .send('{ invalid json }')
        .expect(400);

      // Fastify should handle JSON parsing errors
      expect(response.body).toHaveProperty('error');
    });
  });
});