import * as StellarSdk from 'stellar-sdk';
import { prisma } from '../lib/prisma';
import { stellar, decodeHorizonAsset, parseSacTransferEvent, formatTokenAmount } from '../lib/stellar';
import { enqueuePaymentAlert } from '../lib/queue';
import { getSorobanLatestLedger } from '../lib/soroban';
import { withWalletLock } from '../lib/lock';

export async function processPaymentRecord(
  wallet: { id: string; publicKey: string },
  record: any
) {
  let amount: string | undefined;
  let asset: string = 'XLM';
  let assetIssuer: string | null = null;
  let fromAddress: string = '';
  const txHash: string = record.transaction_hash || record.hash || '';
  const receivedAt: Date = new Date(record.created_at || Date.now());

  if (record.type === 'payment') {
    const decodedAsset = decodeHorizonAsset(record);
    amount = record.amount;
    asset = decodedAsset.assetCode;
    assetIssuer = decodedAsset.assetIssuer;
    fromAddress = record.from || '';
  } else if (record.type === 'create_account') {
    amount = record.starting_balance;
    asset = 'XLM';
    assetIssuer = null;
    fromAddress = record.funder || '';
  } else {
    const sacTransfer = parseSacTransferEvent(record);
    if (!sacTransfer) return;

    let decimals = 7;
    let symbol = sacTransfer.assetCode ?? sacTransfer.contractId ?? 'Unknown';

    if (sacTransfer.contractId) {
      try {
        const meta = await getSacMetadata(sacTransfer.contractId);
        if (meta) {
          decimals = meta.decimals;
          symbol = meta.symbol || symbol;
        }
      } catch (err: any) {
        console.warn(`[WatcherWorker] Error resolving SAC metadata for ${sacTransfer.contractId}:`, err?.message);
      }
    }

    amount = formatTokenAmount(sacTransfer.rawAmount, decimals);
    asset = symbol;
    assetIssuer = sacTransfer.assetIssuer;
    fromAddress = sacTransfer.from;
  }

  if (!amount || !txHash) return;

  // Deduplicate check
  const existing = await prisma.payment.findUnique({ where: { txHash } });
  if (!existing) {
    console.log(
      `[WatcherWorker] 💰 New ${record.type} detected for wallet (${wallet.publicKey.substring(
        0,
        8
      )}...): ${amount} ${asset}`
    );

    const payment = await prisma.payment.create({
      data: {
        walletId: wallet.id,
        txHash,
        fromAddress,
        amount: Number(amount),
        asset,
        assetIssuer,
        receivedAt,
      },
    });

    // Enqueue off-chain alert dispatch job to BullMQ queue
    await enqueuePaymentAlert({
      paymentId: payment.id,
      txHash,
      walletId: wallet.id,
      amount,
      asset,
      assetIssuer,
      fromAddress,
      receivedAt: receivedAt.toISOString(),
    });
  }
}

// Number of operations pulled from Horizon per cursor page
const CURSOR_PAGE_SIZE = 50;

// Upper bound on pages walked in a single catch-up pass, so a long outage
// cannot stall the poll loop indefinitely
const MAX_CATCHUP_PAGES = 20;

export async function saveCursor(walletId: string, pagingToken: string) {
  await prisma.ingestionCursor.upsert({
    where: { walletId },
    create: { walletId, pagingToken },
    update: { pagingToken },
  });
}

/**
 * Returns the persisted paging token for a wallet, creating the cursor record
 * on first sight. A fresh cursor is seeded from the wallet's latest Horizon
 * paging token so that registering a wallet does not replay its whole history.
 */
export async function ensureCursor(wallet: { id: string; publicKey: string }): Promise<string> {
  const existing = await prisma.ingestionCursor.findUnique({ where: { walletId: wallet.id } });
  if (existing) return existing.pagingToken;

  const pagingToken = await stellar.getLatestPagingToken(wallet.publicKey);
  const created = await prisma.ingestionCursor.create({
    data: { walletId: wallet.id, pagingToken },
  });
  console.log(
    `[WatcherWorker] 🔖 Seeded ingestion cursor for wallet ${wallet.publicKey.substring(0, 8)}... at ${pagingToken}`
  );
  return created.pagingToken;
}

export async function processWalletPayments(wallet: { id: string; publicKey: string }) {
  if (!wallet.publicKey || !StellarSdk.StrKey.isValidEd25519PublicKey(wallet.publicKey)) {
    console.warn(`[WatcherWorker] Skipping invalid public key checksum: "${wallet.publicKey}"`);
    return;
  }

  await withWalletLock(wallet.id, async () => {
    let cursor = await ensureCursor(wallet);

    for (let page = 0; page < MAX_CATCHUP_PAGES; page++) {
      const records = (await stellar.getPaymentsSince(
        wallet.publicKey,
        cursor,
        CURSOR_PAGE_SIZE
      )) as any[];
      if (records.length === 0) return;

      for (const record of records) {
        await processPaymentRecord(wallet, record);
        if (record.paging_token) {
          cursor = record.paging_token;
          await saveCursor(wallet.id, cursor);
        }
      }

      if (records.length < CURSOR_PAGE_SIZE) return;
    }

    console.warn(
      `[WatcherWorker] Catch-up page limit reached for ${wallet.publicKey.substring(0, 8)}..., resuming next poll from ${cursor}`
    );
  });
}

export async function startHorizonSSEStream(wallet: { id: string; publicKey: string }) {
  console.log(`[WatcherWorker] 📡 Opening Horizon SSE payment stream for wallet ${wallet.publicKey.substring(0, 8)}...`);

  let timeoutId: NodeJS.Timeout;
  let closeStream: (() => void) | undefined;

  const resetHeartbeat = () => {
    clearTimeout(timeoutId);
    timeoutId = setTimeout(() => {
      console.warn(`[WatcherStream] ⚠️ Heartbeat timeout for ${wallet.publicKey.substring(0, 8)}... Reconnecting...`);
      if (closeStream) closeStream();
      startHorizonSSEStream(wallet);
    }, 60000);
  };

  try {
    const cursor = await ensureCursor(wallet);
    resetHeartbeat();

    closeStream = stellar.server
      .payments()
      .forAccount(wallet.publicKey)
      .cursor(cursor)
      .stream({
        onmessage: async (record: any) => {
          resetHeartbeat();
          console.log(`[WatcherStream] ⚡ Live SSE stream message received: ${record.type}`);
          await withWalletLock(wallet.id, async () => {
            await processPaymentRecord(wallet, record);
            if (record.paging_token) {
              await saveCursor(wallet.id, record.paging_token);
            }
          });
        },
        onerror: (error: any) => {
          console.error(`[WatcherStream] SSE stream error for ${wallet.publicKey.substring(0, 8)}...:`, error);
          resetHeartbeat();
        },
      }) as unknown as () => void; // cast to avoid typings issues since stellar-sdk types might vary

    const originalClose = closeStream;
    closeStream = () => {
      clearTimeout(timeoutId);
      if (originalClose) originalClose();
    };

    return closeStream;
  } catch (err: any) {
    console.error(`[WatcherStream] Failed to open SSE stream: ${err.message}`);
    clearTimeout(timeoutId!);
    return null;
  }
}

export async function runWatcher() {
  console.log('[WatcherWorker] 🚀 Starting Stellar Testnet Watcher Worker...');
  await connectWithRetry();

  const poll = async () => {
    try {
      const wallets = await prisma.wallet.findMany();
      if (wallets.length === 0) {
        console.log('[WatcherWorker] No wallets registered in DB to watch. Waiting for next poll...');
        return;
      }

      console.log(`[WatcherWorker] Checking ${wallets.length} registered wallet(s)...`);
      for (const wallet of wallets) {
        await processWalletPayments(wallet);
      }
    } catch (error) {
      console.error('[WatcherWorker] Polling error:', error);
    }
  };

  // Initial payment catchup run
  await poll();

  // Schedule periodic catchup poll every 30 seconds
  const intervalId = setInterval(poll, 30000);

  const shutdown = async () => {
    console.log('[WatcherWorker] 🛑 Graceful shutdown initiated...');
    clearInterval(intervalId);
    setTimeout(() => {
      console.error('[WatcherWorker] ⚠️ Could not close connections in time, forcefully shutting down');
      process.exit(1);
    }, 5000);

    await prisma.$disconnect();
    console.log('[WatcherWorker] ✅ Prisma disconnected cleanly');
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

/**
 * Answers heartbeat pings from a supervising parent process (see
 * supervisor.ts). Only registered when running as a forked child with an
 * IPC channel, so standalone `node watcher.worker.js` runs are unaffected.
 */
function registerSupervisorHeartbeat() {
  if (!process.send) return;

  process.on('message', (message: any) => {
    if (message?.type === 'ping') {
      process.send?.({ type: 'pong', pid: process.pid });
    }
  });
}

if (require.main === module) {
  registerSupervisorHeartbeat();
  runWatcher();
}
