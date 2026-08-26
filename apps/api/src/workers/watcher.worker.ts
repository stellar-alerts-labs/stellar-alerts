import * as StellarSdk from 'stellar-sdk';
import { prisma } from '../lib/prisma';
import { stellar, decodeHorizonAsset, parseSacTransferEvent } from '../lib/stellar';
import { enqueuePaymentAlert } from '../lib/queue';
import { getSorobanLatestLedger } from '../lib/soroban';
import { createLogger } from '../lib/logger';

const log = createLogger({ module: 'WatcherWorker' });

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

    amount = sacTransfer.amount;
    asset = sacTransfer.assetCode ?? sacTransfer.contractId ?? 'Unknown';
    assetIssuer = sacTransfer.assetIssuer;
    fromAddress = sacTransfer.from;
  }

  if (!amount || !txHash) return;

  // Deduplicate check
  const existing = await prisma.payment.findUnique({ where: { txHash } });
  if (!existing) {
    log.info(
      {
        walletPublicKey: wallet.publicKey.substring(0, 8),
        amount,
        asset,
        type: record.type,
      },
      '💰 New payment detected'
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
  log.info(
    { walletPublicKey: wallet.publicKey.substring(0, 8), pagingToken },
    '🔖 Seeded ingestion cursor'
  );
  return created.pagingToken;
}

export async function processWalletPayments(wallet: { id: string; publicKey: string }) {
  if (!wallet.publicKey || !StellarSdk.StrKey.isValidEd25519PublicKey(wallet.publicKey)) {
    log.warn({ walletPublicKey: wallet.publicKey }, 'Skipping invalid public key checksum');
    return;
  }

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

  log.warn(
    { walletPublicKey: wallet.publicKey.substring(0, 8), cursor },
    'Catch-up page limit reached, resuming next poll from cursor'
  );
}

export async function startHorizonSSEStream(wallet: { id: string; publicKey: string }) {
  log.info(
    { walletPublicKey: wallet.publicKey.substring(0, 8) },
    '📡 Opening Horizon SSE payment stream'
  );

  try {
    const cursor = await ensureCursor(wallet);

    const closeStream = stellar.server
      .payments()
      .forAccount(wallet.publicKey)
      .cursor(cursor)
      .stream({
        onmessage: async (record: any) => {
          log.info({ type: record.type }, '⚡ Live SSE stream message received');
          await processPaymentRecord(wallet, record);
          if (record.paging_token) {
            await saveCursor(wallet.id, record.paging_token);
          }
        },
        onerror: (error: any) => {
          log.error(
            { walletPublicKey: wallet.publicKey.substring(0, 8), err: error },
            'SSE stream error'
          );
        },
      });

    return closeStream;
  } catch (err: any) {
    log.error({ err: err.message }, 'Failed to open SSE stream');
    return null;
  }
}

export async function runWatcher() {
  log.info('🚀 Starting Stellar Testnet Watcher Worker...');

  const poll = async () => {
    try {
      const wallets = await prisma.wallet.findMany();
      if (wallets.length === 0) {
        log.info('No wallets registered in DB to watch. Waiting for next poll...');
        return;
      }

      log.info({ walletCount: wallets.length }, 'Checking registered wallets');
      for (const wallet of wallets) {
        await processWalletPayments(wallet);
      }
    } catch (error) {
      log.error({ err: error }, 'Polling error');
    }
  };

  // Initial payment catchup run
  await poll();

  // Schedule periodic catchup poll every 30 seconds
  setInterval(poll, 30000);
}

if (require.main === module) {
  runWatcher();
}
