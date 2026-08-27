import { PrismaClient } from '../../generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { env } from '../config/env';

const adapter = new PrismaPg({
  connectionString: env.DATABASE_URL || process.env.DATABASE_URL!,
});

export const prisma = new PrismaClient({ adapter });

export async function connectWithRetry(retries = 5, delay = 1000) {
  let attempt = 0;
  while (attempt < retries) {
    try {
      await prisma.$connect();
      console.log('✅ Successfully connected to database');
      return;
    } catch (error: any) {
      attempt++;
      console.warn(`⚠️ Database connection failed (attempt ${attempt}/${retries}): ${error.message}`);
      if (attempt >= retries) {
        console.error('❌ Exceeded maximum retries for database connection. Exiting.');
        process.exit(1);
      }
      await new Promise(res => setTimeout(res, delay));
      delay *= 2; // Exponential backoff
    }
  }
}
