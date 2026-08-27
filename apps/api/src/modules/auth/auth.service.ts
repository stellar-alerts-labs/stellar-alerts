import { prisma } from '../../lib/prisma';
import { generateMagicToken, generateSessionToken, verifyToken, MagicLinkPayload, UserPayload } from '../../utils/jwt';
import { revokeToken } from '../../lib/tokenBlocklist';

export class AuthService {
  async requestMagicLink(email: string): Promise<string> {
    const token = generateMagicToken(email);
    console.log(`[AuthService] ✉️ Magic link generated: http://localhost:3000/verify?token=${token}`);
    return token;
  }

  async verifyMagicLink(token: string): Promise<{ token: string; user: { id: string; email: string } }> {
    let decoded: MagicLinkPayload;
    try {
      decoded = verifyToken<MagicLinkPayload>(token);
    } catch (err: any) {
      console.error('[AuthService] Token verification failed:', err.message);
      throw new Error('Invalid or expired token');
    }

    if (!decoded || !decoded.email) {
      console.error('[AuthService] Token payload missing email:', decoded);
      throw new Error('Invalid or expired token');
    }

    try {
      const user = await prisma.user.upsert({
        where: { email: decoded.email },
        update: {},
        create: { email: decoded.email },
      });

      const sessionToken = generateSessionToken({ id: user.id, email: user.email });

      console.log(`[AuthService] Magic link verified for: ${decoded.email}`);
      return { token: sessionToken, user: { id: user.id, email: user.email } };
    } catch (dbError: any) {
      console.error('[AuthService] Database error during magic link verification:', dbError);
      throw dbError;
    }
  }

  /**
   * Revokes an active session token by adding its jti to the Redis blocklist.
   * The blocklist entry TTL matches the token's remaining lifetime so it
   * self-cleans without manual maintenance.
   */
  async revokeSession(user: UserPayload): Promise<void> {
    if (!user.jti || !user.exp) {
      // Token has no jti/exp — nothing to revoke (should not occur with generateSessionToken).
      console.warn('[AuthService] revokeSession called with token missing jti or exp');
      return;
    }
    await revokeToken(user.jti, user.exp);
    console.log(`[AuthService] 🔓 Session revoked for user ${user.id}`);
  }

  async getMe(userId: string) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: {
        wallets: true,
        notifyPrefs: true,
      },
    });

    if (!user) {
      throw new Error('User not found');
    }

    return user;
  }
}

export const authService = new AuthService();
