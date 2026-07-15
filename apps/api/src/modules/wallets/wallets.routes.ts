import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { createWalletSchema, deleteWalletSchema } from './wallets.schema';
import { walletsService } from './wallets.service';
import jwt from 'jsonwebtoken';
import { env } from '../../config/env';

export async function walletsRoutes(app: FastifyInstance) {
  app.addHook('preHandler', async (request: FastifyRequest, reply: FastifyReply) => {
    const authHeader = request.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return reply.status(401).send({ 
        error: 'Unauthorized', 
        message: 'You must be logged in to perform this action.', 
        code: 'AUTH_REQUIRED' 
      });
    }

    const token = authHeader.split(' ')[1];
    try {
      const decoded = jwt.verify(token, env.JWT_SECRET) as { id: string, email: string };
      (request as any).user = decoded;
    } catch (error) {
      return reply.status(401).send({ 
        error: 'Unauthorized', 
        message: 'Invalid or expired session token.', 
        code: 'INVALID_TOKEN' 
      });
    }
  });

  app.post('/wallets', async (request, reply) => {
    const parsed = createWalletSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Invalid payload', details: parsed.error.format() });
    }

    const userId = (request as any).user.id;
    const wallet = await walletsService.addWallet(
      userId,
      parsed.data.publicKey,
      parsed.data.label
    );
    return reply.status(201).send({ success: true, wallet });
  });

  app.delete('/wallets/:id', async (request, reply) => {
    const parsed = deleteWalletSchema.safeParse(request.params);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Invalid parameters', details: parsed.error.format() });
    }

    try {
      await walletsService.removeWallet(parsed.data.id);
      return reply.send({ success: true });
    } catch (error: any) {
      if (error.message === 'Wallet not found') {
        return reply.status(404).send({ error: 'Not Found', message: error.message });
      }
      throw error;
    }
  });
}
