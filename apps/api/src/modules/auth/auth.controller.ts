import { FastifyRequest, FastifyReply } from 'fastify';
import {
  requestLinkSchema,
  verifyLinkSchema,
  telegramInitDataSchema,
  didChallengeSchema,
  didVerifySchema,
  refreshTokenSchema,
  revokeSessionSchema,
} from './auth.schema';
import { authService } from './auth.service';
import { mfaService } from './mfa.service';
import { TelegramInitDataError } from '../../utils/telegram';
import { TokenReuseError, SessionRevokedError } from '../../lib/session-manager';
import { createPublicKey, verify as cryptoVerify } from 'crypto';
import {
  AuthenticationError,
  NotFoundError,
  RateLimitError,
  ValidationError,
  zodValidationError,
} from '../../lib/errors';

const TRUSTED_KEY_IDS = ['key1', 'key2', 'key3'];

const getTrustedPublicKeys = (): string[] => {
  const raw = process.env.TSS_VERIFICATION_KEYS;
  if (!raw) {
    throw new Error('TSS_VERIFICATION_KEYS is not configured');
  }
  const keys = JSON.parse(raw);
  if (!Array.isArray(keys) || keys.length <3 ) {
    throw new Error('TSS_VERIFICATION_KEYS must be an array of 3 public keys');
  }
  return keys.map((key) => String(key));
};

const verifyThresholdSignatures = (
  message: string,
  signatures: Array<{ keyId: string; signature: string }>,
  threshold: number = 2
): { k: string; sig: Buffer; valid: boolean }[] => {
  const trustedKeys = getTrustedPublicKeys();
  const validAttempts = [];
  const usedKeyIds = new Set<string>();

  for (const sigRecord of signatures) {
    const index = TRUSTED_KEY_IDS.indexOf(sigRecord.keyId);
    if (index === -1) continue;
    if (usedKeyIds.has(sigRecord.keyId)) continue;

    const pubKeyString = trustedKeys[index];
    if (!pubKeyString) continue;

    try {
      const publicKey = createPublicKey({
        key: pubKeyString,
        format: 'pem',
      });
      const signatureBuf = Buffer.from(sigRecord.signature, 'base64');
      const messageBuf = Buffer.from(message, 'utf8');
      const isValid = cryptoVerify('sha256', messageBuf, publicKey, signatureBuf);
      if (isValid) {
        usedKeyIds.add(sigRecord.keyId);
        validAttempts.push({
          k: sigRecord.keyId,
          sig: signatureBuf,
          valid: true,
        });
      }
    } catch (error) {
      // invalid signature or key, skip
      continue;
    }
  }

  return validAttempts.length >= threshold ? validAttempts.slice(0, threshold) : [];
};

export class AuthController {
  async requestMagicLink(request: FastifyRequest, reply: FastifyReply) {
    const parsed = requestLinkSchema.safeParse(request.body);
    if (!parsed.success) {
      throw zodValidationError(parsed, 'Invalid email');
    }

    const token = await authService.requestMagicLink(parsed.data.email);
    return reply.send({
      success: true,
      message: 'If the email exists, a magic link was sent.',
      ...(process.env.NODE_ENV !== 'production' ? { token } : {}),
    });
  }

  async verifyMagicLink(request: FastifyRequest, reply: FastifyReply) {
    const parsed = verifyLinkSchema.safeParse(request.query);
    if (!parsed.success) {
      throw zodValidationError(parsed, 'Invalid token parameter');
    }

    try {
      const { token: sessionToken, user } = await authService.verifyMagicLink(parsed.data.token);
      return reply.send({ success: true, token: sessionToken, user });
    } catch (error: any) {
      if (error.message === 'Invalid or expired token') {
        throw new AuthenticationError('Invalid or expired token', 'INVALID_TOKEN');
      }
      throw error;
    }
  }

  async requestDIDChallenge(request: FastifyRequest, reply: FastifyReply) {
    const parsed = didChallengeSchema.safeParse(request.body);
    if (!parsed.success) {
      throw zodValidationError(parsed, 'Invalid DID parameter');
    }

    try {
      const challengeObj = await authService.requestDIDChallenge(parsed.data.did);
      return reply.send({ success: true, ...challengeObj });
    } catch (error: any) {
      throw new ValidationError(error.message);
    }
  }

  async verifyDIDAuth(request: FastifyRequest, reply: FastifyReply) {
    const parsed = didVerifySchema.safeParse(request.body);
    if (!parsed.success) {
      throw zodValidationError(parsed, 'Missing or invalid did, challenge, or signature parameters');
    }

    try {
      const result = await authService.verifyDIDAuth(parsed.data.did, parsed.data.challenge, parsed.data.signature);
      return reply.send({ success: true, ...result });
    } catch (error: any) {
      throw new AuthenticationError(error.message, 'DID_AUTH_FAILED');
    }
  }

  /**
   * Authenticates a Telegram Mini App session from the client-provided
   * `initData` string (HMAC-SHA256 validated server-side). Returns a session
   * JWT identical in shape to the magic-link / DID responses.
   */
  async verifyTelegramInitData(request: FastifyRequest, reply: FastifyReply) {
    const parsed = telegramInitDataSchema.safeParse(request.body);
    if (!parsed.success) {
      throw zodValidationError(parsed, 'Invalid initData parameter');
    }

    const initData = parsed.data.initData.trim();
    if (!initData.includes('hash=')) {
      throw new ValidationError(
        'initData is missing the HMAC hash field required for WebApp validation.',
        undefined,
        'MISSING_HASH',
      );
    }

    try {
      const result = await authService.verifyTelegramInitData(initData);
      return reply.send({
        success: true,
        authMethod: 'telegram_webapp_hmac',
        ...result,
      });
    } catch (error: any) {
      if (error instanceof TelegramInitDataError) {
        if (error.code === 'INVALID_SIGNATURE' || error.code === 'EXPIRED') {
          throw new AuthenticationError(error.message, error.code);
        }
        throw new ValidationError(error.message, undefined, error.code);
      }
      throw error;
    }
  }

  async getMe(request: FastifyRequest, reply: FastifyReply) {
    if (!request.user) {
      throw new AuthenticationError('User not authenticated');
    }

    try {
      const user = await authService.getMe(request.user.id);
      return reply.send({ success: true, user });
    } catch (error: any) {
      if (error.message === 'User not found') {
        throw new NotFoundError('User not found');
      }
      throw error;
    }
  }

  async refreshTokens(request: FastifyRequest, reply: FastifyReply) {
    const parsed = refreshTokenSchema.safeParse(request.body);
    if (!parsed.success) {
      throw zodValidationError(parsed, 'Missing or invalid refreshToken parameter');
    }

    try {
      const result = await authService.rotateRefreshToken(parsed.data.refreshToken, {
        ip: request.ip,
        userAgent: request.headers['user-agent'] as string | undefined,
      });
      return reply.send({
        success: true,
        ...result,
      });
    } catch (error: any) {
      if (error instanceof TokenReuseError || error instanceof SessionRevokedError) {
        throw new AuthenticationError(error.message, error.code);
      }
      if (error.message === 'Invalid or expired refresh token') {
        throw new AuthenticationError(error.message, 'INVALID_TOKEN');
      }
      throw error;
    }
  }

  async revokeSession(request: FastifyRequest, reply: FastifyReply) {
    if (!request.user) {
      throw new AuthenticationError('User not authenticated');
    }

    const parsed = revokeSessionSchema.safeParse(request.body);
    const targetFamilyId = (parsed.success && parsed.data.familyId) || request.user.familyId;

    if (targetFamilyId && targetFamilyId !== 'legacy') {
      await authService.revokeSessionFamily(targetFamilyId);
    }
    await authService.revokeSession(request.user);
    return reply.send({
      success: true,
      message: 'Session family revoked successfully.',
    });
  }

  async logout(request: FastifyRequest, reply: FastifyReply) {
    if (!request.user) {
      throw new AuthenticationError('User not authenticated');
    }

    await authService.revokeSession(request.user);
    return reply.send({ success: true, message: 'Logged out successfully.' });
  }

  // ========== MFA Endpoints ==========

  /**
   * Setup MFA - Generate secret and QR code
   */
  async setupMFA(request: FastifyRequest, reply: FastifyReply) {
    if (!request.user) {
      throw new AuthenticationError('User not authenticated');
    }

    const { secret, qrCode } = await mfaService.setupMFA(request.user.id, request.user.email);
    return reply.send({
      success: true,
      secret,
      qrCode,
      message: 'Scan QR code with your authenticator app and verify with a 6-digit code',
    });
  }

  /**
   * Enable MFA - Verify first TOTP token and generate recovery codes
   */
  async enableMFA(request: FastifyRequest, reply: FastifyReply) {
    if (!request.user) {
      throw new AuthenticationError('User not authenticated');
    }

    const { token } = (request.body as any) || {};
    if (!token || typeof token !== 'string') {
      throw new ValidationError('Missing or invalid token');
    }

    try {
      const result = await mfaService.enableMFA(request.user.id, token);
      return reply.send({
        success: true,
        message: 'MFA enabled successfully',
        recoveryCodes: result.recoveryCodes,
      });
    } catch (error: any) {
      throw new ValidationError(error.message, undefined, 'MFA_ENABLE_FAILED');
    }
  }

  /**
   * Disable MFA - Requires valid TOTP token
   */
  async disableMFA(request: FastifyRequest, reply: FastifyReply) {
    if (!request.user) {
      throw new AuthenticationError('User not authenticated');
    }

    const { token } = (request.body as any) || {};
    if (!token || typeof token !== 'string') {
      throw new ValidationError('Missing or invalid token');
    }

    try {
      await mfaService.disableMFA(request.user.id, token);
      return reply.send({
        success: true,
        message: 'MFA disabled successfully',
      });
    } catch (error: any) {
      throw new ValidationError(error.message, undefined, 'MFA_DISABLE_FAILED');
    }
  }

  /**
   * Check MFA status
   */
  async getMFAStatus(request: FastifyRequest, reply: FastifyReply) {
    if (!request.user) {
      throw new AuthenticationError('User not authenticated');
    }

    const enabled = await mfaService.isMFAEnabled(request.user.id);
    const codeStatus = enabled
      ? await mfaService.getRecoveryCodeStatus(request.user.id)
      : { total: 0, remaining: 0 };

    return reply.send({
      success: true,
      mfaEnabled: enabled,
      recoveryCodesRemaining: codeStatus.remaining,
      recoveryCodesTotal: codeStatus.total,
    });
  }

  /**
   * Generate/Regenerate one-time recovery codes (#317)
   */
  async generateRecoveryCodes(request: FastifyRequest, reply: FastifyReply) {
    if (!request.user) {
      throw new AuthenticationError('User not authenticated');
    }

    try {
      const codes = await mfaService.generateRecoveryCodes(request.user.id);
      return reply.send({
        success: true,
        recoveryCodes: codes,
        message: 'New recovery codes generated. Store them securely; they will not be shown again.',
      });
    } catch (error: any) {
      throw new ValidationError(error.message, undefined, 'RECOVERY_CODE_GENERATION_FAILED');
    }
  }

  /**
   * Get remaining recovery codes count (#317)
   */
  async getRecoveryCodeStatus(request: FastifyRequest, reply: FastifyReply) {
    if (!request.user) {
      throw new AuthenticationError('User not authenticated');
    }

    const status = await mfaService.getRecoveryCodeStatus(request.user.id);
    return reply.send({
      success: true,
      ...status,
    });
  }

  /**
   * Recover account with a one-time recovery code when device is lost (#317)
   */
  async recoverAccount(request: FastifyRequest, reply: FastifyReply) {
    const { email, recoveryCode } = (request.body as any) || {};

    if (!email || typeof email !== 'string') {
      throw new ValidationError('Missing or invalid email');
    }
    if (!recoveryCode || typeof recoveryCode !== 'string') {
      throw new ValidationError('Missing or invalid recovery code');
    }

    try {
      const result = await mfaService.recoverAccountWithCode(
        email,
        recoveryCode,
        request.ip,
      );
      return reply.send({
        success: true,
        ...result,
      });
    } catch (error: any) {
      if (error.message.includes('Too many recovery attempts')) {
        throw new RateLimitError(error.message);
      }
      throw new ValidationError(error.message, undefined, 'RECOVERY_FAILED');
    }
  }
}

export const authController = new AuthController();
