import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { TestServer, getTestServer, cleanupTestServer } from '../utils/test-server';
import { TestDatabase, setupTestIsolation, cleanupTestIsolation } from '../utils/test-db';
import { 
  createTestUser, 
  createTestUsers,
  makeAuthenticatedRequest, 
  makeUnauthenticatedRequest,
} from '../utils/auth-helpers';

describe('Notification Preferences Integration Tests', () => {
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

  describe('Get Notification Preferences', () => {
    it('should return empty preferences for new user', async () => {
      const testUser = await createTestUser();
      const authRequest = makeAuthenticatedRequest(testServer, testUser);

      const response = await authRequest
        .get('/notifications/preferences')
        .expect(200);

      expect(response.body).toEqual({
        success: true,
        preferences: {},
      });
    });

    it('should require authentication to get preferences', async () => {
      const unauthRequest = makeUnauthenticatedRequest(testServer);

      const response = await unauthRequest
        .get('/notifications/preferences')
        .expect(401);

      expect(response.body.error).toMatchObject({
        code: 'AUTH_REQUIRED',
        message: 'You must be logged in to perform this action.',
      });
      expect(response.body.error.requestId).toBeDefined();
    });
  });

  describe('Update Notification Preferences', () => {
    it('should successfully update email preferences', async () => {
      const testUser = await createTestUser();
      const authRequest = makeAuthenticatedRequest(testServer, testUser);

      const preferences = {
        emailEnabled: true,
      };

      const response = await authRequest
        .post('/notifications/preferences')
        .send(preferences)
        .expect(200);

      expect(response.body).toEqual({
        success: true,
        message: 'Notification preferences updated successfully',
      });

      // Verify preferences were saved
      const getResponse = await authRequest
        .get('/notifications/preferences')
        .expect(200);

      expect(getResponse.body.preferences).toMatchObject({
        emailEnabled: true,
      });
    });

    it('should successfully update telegram preferences', async () => {
      const testUser = await createTestUser();
      const authRequest = makeAuthenticatedRequest(testServer, testUser);

      const preferences = {
        telegramChatId: '123456789',
        telegramEnabled: true,
      };

      const response = await authRequest
        .post('/notifications/preferences')
        .send(preferences)
        .expect(200);

      expect(response.body).toEqual({
        success: true,
        message: 'Notification preferences updated successfully',
      });

      // Verify preferences were saved (telegram chat ID should be encrypted/decrypted)
      const getResponse = await authRequest
        .get('/notifications/preferences')
        .expect(200);

      expect(getResponse.body.preferences).toMatchObject({
        telegramChatId: '123456789',
        telegramEnabled: true,
      });
    });

    it('should require authentication to update preferences', async () => {
      const unauthRequest = makeUnauthenticatedRequest(testServer);

      const preferences = {
        emailEnabled: true,
      };

      const response = await unauthRequest
        .post('/notifications/preferences')
        .send(preferences)
        .expect(401);

      expect(response.body.error).toMatchObject({
        code: 'AUTH_REQUIRED',
        message: 'You must be logged in to perform this action.',
      });
      expect(response.body.error.requestId).toBeDefined();
    });
  });

  describe('WhatsApp Preferences Validation', () => {
    it('should reject invalid WhatsApp number format', async () => {
      const testUser = await createTestUser();
      const authRequest = makeAuthenticatedRequest(testServer, testUser);

      const preferences = {
        whatsappNumber: 'invalid-phone-number',
        whatsappEnabled: true,
      };

      const response = await authRequest
        .post('/notifications/preferences')
        .send(preferences)
        .expect(400);

      expect(response.body.error).toMatchObject({
        code: 'INVALID_WHATSAPP_PREFERENCES',
        message: 'Invalid WhatsApp number. Use E.164 format, e.g. +14155551234.',
      });
    });

    it('should accept valid E.164 WhatsApp number', async () => {
      const testUser = await createTestUser();
      const authRequest = makeAuthenticatedRequest(testServer, testUser);

      const preferences = {
        whatsappNumber: '+14155551234',
        whatsappEnabled: true,
      };

      const response = await authRequest
        .post('/notifications/preferences')
        .send(preferences)
        .expect(200);

      expect(response.body).toEqual({
        success: true,
        message: 'Notification preferences updated successfully',
      });
    });

    it('should require WhatsApp number when enabling WhatsApp notifications', async () => {
      const testUser = await createTestUser();
      const authRequest = makeAuthenticatedRequest(testServer, testUser);

      const preferences = {
        whatsappEnabled: true,
        // No whatsappNumber provided
      };

      const response = await authRequest
        .post('/notifications/preferences')
        .send(preferences)
        .expect(400);

      expect(response.body.error).toMatchObject({
        code: 'INVALID_WHATSAPP_PREFERENCES',
        message: 'A valid WhatsApp number is required to enable WhatsApp notifications',
      });
    });
  });

  describe('Test Ping Functionality', () => {
    it('should reject test ping for invalid channel', async () => {
      const testUser = await createTestUser();
      const authRequest = makeAuthenticatedRequest(testServer, testUser);

      const response = await authRequest
        .post('/notifications/test-ping')
        .send({ channel: 'invalid-channel' })
        .expect(400);

      expect(response.body.error).toMatchObject({
        code: 'INVALID_CHANNEL',
        message: 'channel must be "telegram"',
      });
    });

    it('should reject test ping without channel', async () => {
      const testUser = await createTestUser();
      const authRequest = makeAuthenticatedRequest(testServer, testUser);

      const response = await authRequest
        .post('/notifications/test-ping')
        .send({})
        .expect(400);

      expect(response.body.error).toMatchObject({
        code: 'INVALID_CHANNEL',
        message: 'channel must be "telegram"',
      });
    });

    it('should require authentication for test ping', async () => {
      const unauthRequest = makeUnauthenticatedRequest(testServer);

      const response = await unauthRequest
        .post('/notifications/test-ping')
        .send({ channel: 'telegram' })
        .expect(401);

      expect(response.body.error).toMatchObject({
        code: 'AUTH_REQUIRED',
        message: 'You must be logged in to perform this action.',
      });
      expect(response.body.error.requestId).toBeDefined();
    });
  });

  describe('User Isolation', () => {
    it('should isolate notification preferences between users', async () => {
      const [user1, user2] = await createTestUsers(2);

      // User 1 sets preferences
      const auth1 = makeAuthenticatedRequest(testServer, user1);
      await auth1
        .post('/notifications/preferences')
        .send({ emailEnabled: true, telegramChatId: '111111' })
        .expect(200);

      // User 2 sets different preferences
      const auth2 = makeAuthenticatedRequest(testServer, user2);
      await auth2
        .post('/notifications/preferences')
        .send({ emailEnabled: false, telegramChatId: '222222' })
        .expect(200);

      // User 1 should see their preferences
      const response1 = await auth1.get('/notifications/preferences').expect(200);
      expect(response1.body.preferences).toMatchObject({
        emailEnabled: true,
        telegramChatId: '111111',
      });

      // User 2 should see their preferences
      const response2 = await auth2.get('/notifications/preferences').expect(200);
      expect(response2.body.preferences).toMatchObject({
        emailEnabled: false,
        telegramChatId: '222222',
      });
    });
  });
});