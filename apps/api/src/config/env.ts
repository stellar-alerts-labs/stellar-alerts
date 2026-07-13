import { z } from 'zod';

const envSchema = z.object({
  DATABASE_URL: z.string().url(),
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  JWT_SECRET: z.string().min(1),
  REDIS_URL: z.string().url(),
  PORT: z.string().optional().default("3001"),
});

const parseEnv = () => {
  const parsed = envSchema.safeParse(process.env);

  if (!parsed.success) {
    console.error("❌ Invalid environment variables:", parsed.error.format());
    process.exit(1);
  }

  return parsed.data;
};

export const env = parseEnv();
