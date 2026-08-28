import { prisma } from '../../lib/prisma';
import { generateMagicToken, generateSessionToken, verifyToken, MagicLinkPayload, UserPayload } from '../../utils/jwt';
import { revokeToken } from '../../lib/tokenBlocklist';
import { parseDID, generateDIDChallenge, verifyDIDSignature, DIDChallenge } from '../../utils/did';

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
   * Generates a signed challenge for W3C Decentralized Identity (DID) authentication.
   */
  requestDIDChallenge(did: string): DIDChallenge {
    console.log(`[AuthService] 🆔 Requesting DID challenge for: ${did}`);
    return generateDIDChallenge(did);
  }

  /**
   * Verifies signed DID challenge payload and issues a valid session JWT bound to the DID user identity.
   */
  async verifyDIDAuth(did: string, challenge: string, signature: string): Promise<{ token: string; user: { id: string; email: string; did: string } }> {
    const parsed = parseDID(did);
    const isValid = verifyDIDSignature(did, challenge, signature);

    if (!isValid) {
      console.error(`[AuthService] ❌ DID signature verification failed for ${did}`);
      throw new Error('Invalid DID challenge signature');
    }

    const syntheticEmail = `${parsed.address.toLowerCase().substring(0, 20)}@did.stellar-alerts.org`;

    const user = await prisma.user.upsert({
      where: { email: syntheticEmail },
      update: {},
      create: { email: syntheticEmail },
    });

    const sessionToken = generateSessionToken({ id: user.id, email: user.email });

    console.log(`[AuthService] 🔑 DID Authentication successful for ${did}. Session JWT issued.`);
    return {
      token: sessionToken,
      user: {
        id: user.id,
        email: user.email,
        did,
      },
    };
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
