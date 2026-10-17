import { FastifyInstance } from 'fastify';
import { authController } from './auth.controller';
import { authenticateHook } from '../../middleware/auth.middleware';

export async function authRoutes(app: FastifyInstance) {
  app.post('/auth/request-link', { schema: { tags: ['auth'], summary: 'Request a magic-link email', description: 'Sends a one-time sign-in link to the given email address.' } }, authController.requestMagicLink.bind(authController));
  app.get('/auth/verify', { schema: { tags: ['auth'], summary: 'Verify magic-link token', description: 'Validates the one-time token from the magic-link email and returns a session JWT.' } }, authController.verifyMagicLink.bind(authController));
  app.post('/auth/did/challenge', { schema: { tags: ['auth'], summary: 'Request a DID sign-in challenge', description: 'Issues a single-use, expiring challenge for Stellar Freighter wallet sign-in.' } }, authController.requestDIDChallenge.bind(authController));
  app.post('/auth/did/verify', { schema: { tags: ['auth'], summary: 'Verify DID sign-in', description: 'Validates the signed DID challenge and returns a session JWT.' } }, authController.verifyDIDAuth.bind(authController));
  app.post('/auth/telegram', { schema: { tags: ['auth'], summary: 'Authenticate with Telegram', description: 'Validates Telegram Mini App initData and returns a session JWT.' } }, authController.verifyTelegramInitData.bind(authController));
  app.post('/auth/refresh', { schema: { tags: ['auth'], summary: 'Refresh session tokens', description: 'Exchanges a valid refresh token for a new access/refresh token pair.' } }, authController.refreshTokens.bind(authController));
  app.post('/auth/revoke-session', { preHandler: [authenticateHook], schema: { tags: ['auth'], summary: 'Revoke the current session', description: 'Invalidates the bearer token so it cannot be used for further requests.' } }, authController.revokeSession.bind(authController));
  app.get('/auth/me', { preHandler: [authenticateHook], schema: { tags: ['auth'], summary: 'Get current user profile', description: 'Returns the authenticated user\'s account information.' } }, authController.getMe.bind(authController));
  app.post('/auth/logout', { preHandler: [authenticateHook], schema: { tags: ['auth'], summary: 'Log out', description: 'Logs out the current session and invalidates the token.' } }, authController.logout.bind(authController));
  
  // MFA endpoints (require authentication)
  app.post('/auth/mfa/setup', { preHandler: [authenticateHook], schema: { tags: ['auth'], summary: 'Set up TOTP MFA', description: 'Generates a TOTP secret and QR code URI for authenticator app enrollment.' } }, authController.setupMFA.bind(authController));
  app.post('/auth/mfa/enable', { preHandler: [authenticateHook], schema: { tags: ['auth'], summary: 'Enable MFA', description: 'Confirms the TOTP code and enables MFA on the account.' } }, authController.enableMFA.bind(authController));
  app.post('/auth/mfa/disable', { preHandler: [authenticateHook], schema: { tags: ['auth'], summary: 'Disable MFA', description: 'Disables TOTP MFA after verifying the current TOTP code.' } }, authController.disableMFA.bind(authController));
  app.get('/auth/mfa/status', { preHandler: [authenticateHook], schema: { tags: ['auth'], summary: 'Get MFA status', description: 'Returns whether MFA is enabled for the current account.' } }, authController.getMFAStatus.bind(authController));
  app.post('/auth/mfa/recovery-codes', { preHandler: [authenticateHook], schema: { tags: ['auth'], summary: 'Generate MFA recovery codes', description: 'Generates a new set of single-use recovery codes, invalidating any previous set.' } }, authController.generateRecoveryCodes.bind(authController));
  app.get('/auth/mfa/recovery-codes', { preHandler: [authenticateHook], schema: { tags: ['auth'], summary: 'Get recovery code status', description: 'Returns how many unused recovery codes remain.' } }, authController.getRecoveryCodeStatus.bind(authController));

  // Lost device recovery (public)
  app.post('/auth/mfa/recover', { schema: { tags: ['auth'], summary: 'Recover account with recovery code', description: 'Bypasses TOTP MFA using a single-use recovery code.' } }, authController.recoverAccount.bind(authController));
}

