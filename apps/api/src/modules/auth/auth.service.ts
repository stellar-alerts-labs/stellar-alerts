import { PrismaClient } from '@prisma/client';
import jwt from 'jsonwebtoken';
import { env } from '../../config/env';

const prisma = new PrismaClient();

export class AuthService {
  async requestMagicLink(email: string): Promise<void> {
    const token = jwt.sign({ email }, env.JWT_SECRET, { expiresIn: '15m' });
    console.log(`[AuthService] Magic link generated: http://localhost:3000/?token=${token}`);
  }

  async verifyMagicLink(token: string): Promise<{ token: string, user: { id: string, email: string } }> {
    try {
      const decoded = jwt.verify(token, env.JWT_SECRET) as { email: string };

      const user = await prisma.user.upsert({
        where: { email: decoded.email },
        update: {},
        create: { email: decoded.email },
      });

      const sessionToken = jwt.sign({ id: user.id, email: user.email }, env.JWT_SECRET, { expiresIn: '7d' });

      console.log(`[AuthService] Magic link verified for: ${decoded.email}`);
      return { token: sessionToken, user: { id: user.id, email: user.email } };
    } catch (error) {
      throw new Error('Invalid or expired token');
    }
  }
}

export const authService = new AuthService();
