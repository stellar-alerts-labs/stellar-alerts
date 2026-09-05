import { FastifyInstance } from 'fastify';
import { authController } from './auth.controller';
import { authenticateHook } from '../../middleware/auth.middleware';
import { verifyTSSThreshold } from '../../utils/tss-verifier';

export async function authRoutes(app: FastifyInstance) {
  app.post('/auth/request-link', authController.requestMagicLink.bind(authController));
  app.get('/auth/verify', authController.verifyMagicLink.bind(authController));
  app.post('/auth/did/challenge', authController.requestDIDChallenge.bind(authController));
  app.post('/auth/did/verify', authController.verifyDIDAuth.bind(authController));
  app.post('/auth/telegram', authController.verifyTelegramInitData.bind(authController));
  app.get('/auth/me', { preHandler: [authenticateHook] }, authController.getMe.bind(authController));
  app.post('/auth/logout', { preHandler: [authenticateHook] }, authController.logout.bind(authController));

  app.post('/auth/tss/authorize', { preHandler: [authenticateHook] }, async (req, rep) => {
    const { message, signatures } = req.body as { message: string; signatures: Array<{ partyId: string; signature: string }> };
    if (!message || !Array.isArray(signatures) || signatures.length === 0) {
      return rep.status(400).send({ error: 'Missing required TSS fields' });
    }
    try {
      const authorized = await verifyTSSThreshold(message, signatures);
      return rep.send({ authorized });
    } catch (error) {
      req.log.error(error, 'TSS verification failed');
      return rep.status(500).send({ error: 'TSS verification failed' });
    }
  });
}
