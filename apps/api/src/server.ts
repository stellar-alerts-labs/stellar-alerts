import { env } from './config/env';
import { buildApp } from './app';

const start = async () => {
  try {
    const app = await buildApp();
    const port = parseInt(env.PORT, 10);
    
    await app.listen({ port, host: '0.0.0.0' });
    console.log(`🚀 Server listening on http://localhost:${port}`);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
};

start();
