import { FastifyRequest, FastifyReply } from 'fastify';
import { requestLinkSchema, verifyLinkSchema } from './auth.schema';
import { authService } from './auth.service';

export class AuthController {
  async requestMagicLink(request: FastifyRequest, reply: FastifyReply) {
    const parsed = requestLinkSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Invalid email', details: parsed.error.format() });
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
      return reply.status(400).send({ error: 'Invalid token parameter', details: parsed.error.format() });
    }

    try {
      const { token: sessionToken, user } = await authService.verifyMagicLink(parsed.data.token);
      return reply.send({ success: true, token: sessionToken, user });
    } catch (error: any) {
      if (error.message === 'Invalid or expired token') {
        return reply.status(401).send({ error: 'Invalid or expired token' });
      }
      return reply.status(500).send({ error: 'Internal server error', message: error.message });
    }
  }

  async getMe(request: FastifyRequest, reply: FastifyReply) {
    if (!request.user) {
      return reply.status(401).send({ error: 'Unauthorized', message: 'User not authenticated' });
    }

    try {
      const user = await authService.getMe(request.user.id);
      return reply.send({ success: true, user });
    } catch (error: any) {
      if (error.message === 'User not found') {
        return reply.status(404).send({ error: 'Not found', message: 'User not found' });
      }
      return reply.status(500).send({ error: 'Internal server error', message: error.message });
    }
  }

  async logout(request: FastifyRequest, reply: FastifyReply) {
    if (!request.user) {
      return reply.status(401).send({ error: 'Unauthorized', message: 'User not authenticated' });
    }

    try {
      await authService.revokeSession(request.user);
      return reply.send({ success: true, message: 'Logged out successfully.' });
    } catch (error: any) {
      return reply.status(500).send({ error: 'Internal server error', message: error.message });
    }
  }
}

export const authController = new AuthController();
