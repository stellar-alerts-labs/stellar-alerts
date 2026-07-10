import { FastifyInstance } from 'fastify';
import { requestLinkSchema, verifyLinkSchema } from './auth.schema';
import { authService } from './auth.service';

export async function authRoutes(app: FastifyInstance) {
  app.post('/auth/request-link', async (request, reply) => {
    const parsed = requestLinkSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Invalid email', details: parsed.error.format() });
    }
    
    await authService.requestMagicLink(parsed.data.email);
    return reply.send({ success: true, message: 'If the email exists, a magic link was sent.' });
  });

  app.get('/auth/verify', async (request, reply) => {
    const parsed = verifyLinkSchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Invalid token' });
    }

    const sessionToken = await authService.verifyMagicLink(parsed.data.token);
    return reply.send({ success: true, token: sessionToken });
  });
}
