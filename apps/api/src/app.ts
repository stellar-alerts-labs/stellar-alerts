import Fastify from 'fastify';

export const buildApp = async () => {
  const app = Fastify({
    logger: true,
  });

  app.get('/health', async () => {
    return { status: 'ok' };
  });

  return app;
};
