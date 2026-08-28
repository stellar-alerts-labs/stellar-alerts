import { PrismaClient } from '../../generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { env } from '../config/env';

export let activeDatabaseUrl = process.env.DATABASE_URL || env.DATABASE_URL || 'postgresql://user:password@localhost:5432/stellar_alerts?schema=public';

let adapter = new PrismaPg({
  connectionString: activeDatabaseUrl,
});

export let prisma = new PrismaClient({ adapter });

export async function switchDatabaseUrl(newConnectionString: string): Promise<void> {
  console.log(`[DR Engine] 🔄 Switching database connection pool to secondary region: ${newConnectionString}`);
  activeDatabaseUrl = newConnectionString;
  process.env.DATABASE_URL = newConnectionString;

  try {
    await prisma.$disconnect();
  } catch (_) {}

  adapter = new PrismaPg({
    connectionString: newConnectionString,
  });
  prisma = new PrismaClient({ adapter });
}

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
