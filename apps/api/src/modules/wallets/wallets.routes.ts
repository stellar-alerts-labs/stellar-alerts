import { FastifyInstance } from 'fastify';
import { createWalletSchema, deleteWalletSchema } from './wallets.schema';
import { walletsService } from './wallets.service';

export async function walletsRoutes(app: FastifyInstance) {
  app.post('/wallets', async (request, reply) => {
    const parsed = createWalletSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Invalid payload', details: parsed.error.format() });
    }

    const wallet = await walletsService.addWallet(
      parsed.data.userId,
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

    await walletsService.removeWallet(parsed.data.id);
    return reply.send({ success: true });
  });
}
