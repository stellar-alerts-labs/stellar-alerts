import cron from 'node-cron';
import { computeDailyMerkleRoot } from '../services/checksumChain.service';
import { createLogger } from '../lib/logger';

const log = createLogger({ module: 'ChecksumChainWorker' });

/**
 * Rolls up "yesterday" (UTC) into a DailyChecksumRoot. Runs a day behind
 * on purpose: at 00:10 UTC a handful of payments ingested in the last
 * seconds of the previous UTC day may not have committed yet, so rolling
 * up "today" immediately at midnight would risk an incomplete leaf set.
 */
export async function runDailyChecksumRootJob(day: Date = new Date(Date.now() - 24 * 60 * 60 * 1000)) {
  log.info({ day: day.toISOString().slice(0, 10) }, '🚀 Starting daily payment checksum Merkle root job...');
  try {
    const result = await computeDailyMerkleRoot(day);
    if (result) {
      log.info(result, '✅ Finished daily payment checksum Merkle root job.');
    } else {
      log.info('✅ Finished daily payment checksum Merkle root job (no payments that day).');
    }
  } catch (error: any) {
    log.error({ err: error }, '❌ Daily payment checksum Merkle root job failed');
  }
}

export function scheduleChecksumChainJobs() {
  // 00:10 UTC daily — see runDailyChecksumRootJob's doc comment for why it
  // rolls up the previous day rather than the one that just started.
  cron.schedule('10 0 * * *', () => runDailyChecksumRootJob());

  log.info('🕒 Scheduled daily payment checksum Merkle root cron job.');
}

if (require.main === module) {
  scheduleChecksumChainJobs();
}
