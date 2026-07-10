import Fastify from 'fastify';
import { authRoutes } from './modules/auth/auth.routes';

export const buildApp = async () => {
  const app = Fastify({
    logger: true,
  });

  app.get('/health', async () => {
    return { status: 'ok' };
  });

  app.register(authRoutes);

  return app;
};
