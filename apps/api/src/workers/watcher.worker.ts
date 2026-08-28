import * as StellarSdk from 'stellar-sdk';
import { prisma, connectWithRetry } from '../lib/prisma';
import { stellar, decodeHorizonAsset, parseSacTransferEvent } from '../lib/stellar';
import { enqueuePaymentAlert } from '../lib/queue';
import {
  getSorobanLatestLedger,
  loadContractRegistry,
  getActiveContractIds,
  parseSorobanTransferEvent,
  routeEventToUsers,
} from '../lib/soroban';
import { registerSupervisorHeartbeat } from './supervisor';
import { withWalletLock } from '../lib/lock';
import { shouldAlert, PaymentContext } from '../lib/rules-engine';



export async function processPaymentRecord(
  wallet: { id: string; publicKey: string; userId?: string },
  record: any
) {
  let amount: string | undefined;
  let asset: string = "XLM";
  let assetIssuer: string | null = null;
  let fromAddress: string = '';
  let memo: string | null = null;
  const txHash: string = record.transaction_hash || record.hash || '';
  const receivedAt: Date = new Date(record.created_at || Date.now());

  if (record.type === "payment") {
    const decodedAsset = decodeHorizonAsset(record);
    amount = record.amount;
    asset = decodedAsset.assetCode;
    assetIssuer = decodedAsset.assetIssuer;
    fromAddress = record.from || '';
    memo = record.memo || null;
  } else if (record.type === 'create_account') {
    amount = record.starting_balance;
    asset = "XLM";
    assetIssuer = null;
    fromAddress = record.funder || "";
  } else {
    const sacTransfer = parseSacTransferEvent(record);
    if (!sacTransfer) return;

    amount = sacTransfer.amount;
    asset = sacTransfer.assetCode ?? sacTransfer.contractId ?? "Unknown";
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
        8,
      )}...): ${amount} ${asset}`,
    );

    const payment = await prisma.payment.create({
      data: {
        walletId: wallet.id,
        txHash,
        fromAddress,
        amount: Number(amount),
        asset,
        assetIssuer,
        memo,
        receivedAt,
      },
    });

    // Apply filter rules to determine if we should alert
    let shouldSendAlert = true;
    
    if (wallet.userId) {
      const notifyPrefs = await prisma.notificationPreference.findUnique({
        where: { userId: wallet.userId },
      });

      if ((notifyPrefs as any)?.filterRules) {
        const paymentContext: PaymentContext = {
          amount: Number(amount),
          asset,
          fromAddress,
          memo,
        };
        
        shouldSendAlert = shouldAlert((notifyPrefs as any)?.filterRules, paymentContext);
        
        if (!shouldSendAlert) {
          console.log(
            `[WatcherWorker] 🔕 Payment filtered by rules for wallet (${wallet.publicKey.substring(
              0,
              8
            )}...): ${amount} ${asset}`
          );
        }
      }
    }

    // Enqueue off-chain alert dispatch job to BullMQ queue only if rules pass
    if (shouldSendAlert) {
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
export async function ensureCursor(wallet: {
  id: string;
  publicKey: string;
}): Promise<string> {
  const existing = await prisma.ingestionCursor.findUnique({
    where: { walletId: wallet.id },
  });
  if (existing) return existing.pagingToken;

  const pagingToken = await stellar.getLatestPagingToken(wallet.publicKey);
  const created = await prisma.ingestionCursor.create({
    data: { walletId: wallet.id, pagingToken },
  });
  console.log(
    `[WatcherWorker] 🔖 Seeded ingestion cursor for wallet ${wallet.publicKey.substring(0, 8)}... at ${pagingToken}`,
  );
  return created.pagingToken;
}

export async function processWalletPayments(wallet: { id: string; publicKey: string; userId?: string }) {
  if (!wallet.publicKey || !StellarSdk.StrKey.isValidEd25519PublicKey(wallet.publicKey)) {
    console.warn(`[WatcherWorker] Skipping invalid public key checksum: "${wallet.publicKey}"`);
    return;
  }

  let cursor = await ensureCursor(wallet);

  for (let page = 0; page < MAX_CATCHUP_PAGES; page++) {
    const records = (await stellar.getPaymentsSince(
      wallet.publicKey,
      cursor,
      CURSOR_PAGE_SIZE,
    )) as any[];
    if (records.length === 0) return;

    for (const record of records) {
      await processPaymentRecord(wallet, record);
      if (record.paging_token) {
        cursor = record.paging_token;
        await saveCursor(wallet.id, cursor);
      }

      if (records.length < CURSOR_PAGE_SIZE) return;
    }

    console.warn(
      `[WatcherWorker] Catch-up page limit reached for ${wallet.publicKey.substring(0, 8)}..., resuming next poll from ${cursor}`
    );
  } finally {
    await lock.release();
  }

  console.warn(
    `[WatcherWorker] Catch-up page limit reached for ${wallet.publicKey.substring(0, 8)}..., resuming next poll from ${cursor}`,
  );
}

export async function startHorizonSSEStream(wallet: { id: string; publicKey: string; userId?: string }) {
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
          console.log(
            `[WatcherStream] ⚡ Live SSE stream message received: ${record.type}`,
          );
          await processPaymentRecord(wallet, record);
          if (record.paging_token) {
            await saveCursor(wallet.id, record.paging_token);
          }
        },
        onerror: (error: any) => {
          console.error(
            `[WatcherStream] SSE stream error for ${wallet.publicKey.substring(0, 8)}...:`,
            error,
          );
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
  console.log("[WatcherWorker] 🚀 Starting Stellar Testnet Watcher Worker...");

  // Load Soroban contract subscriptions
  await loadContractRegistry();

  const poll = async () => {
    try {
      const wallets = await prisma.wallet.findMany();
      if (wallets.length === 0) {
        console.log(
          "[WatcherWorker] No wallets registered in DB to watch. Waiting for next poll...",
        );
        return;
      }

      console.log(
        `[WatcherWorker] Checking ${wallets.length} registered wallet(s)...`,
      );
      for (const wallet of wallets) {
        await processWalletPayments({ id: wallet.id, publicKey: wallet.publicKey, userId: wallet.userId });
      }

      // Process multi-contract Soroban events
      const contractIds = getActiveContractIds();
      if (contractIds.length > 0) {
        console.log(
          `[WatcherWorker] Processing ${contractIds.length} Soroban contract subscriptions...`,
        );
        for (const contractId of contractIds) {
          await processSorobanContractEvents(contractId);
        }
      }
    } catch (error) {
      console.error("[WatcherWorker] Polling error:", error);
    }
  };

  // Initial payment catchup run
  await poll();

  // Schedule periodic catchup poll every 30 seconds
  setInterval(poll, 30000);

  // Reload contract registry every 5 minutes
  setInterval(() => {
    loadContractRegistry();
  }, 300000);
}

async function processSorobanContractEvents(contractId: string) {
  try {
    const latestLedger = await getSorobanLatestLedger();
    if (latestLedger === 0) return;

    const lastSnapshot = await prisma.sorobanEventSnapshot.findFirst({
      where: { contractId },
      orderBy: { ledgerSeq: "desc" },
      select: { ledgerSeq: true },
    });

    const startLedger = lastSnapshot
      ? lastSnapshot.ledgerSeq + 1
      : latestLedger - 1000;
    if (startLedger > latestLedger) return;

    const { fetchContractEventsInRange } = await import("../lib/soroban");

    for await (const eventBatch of fetchContractEventsInRange(
      contractId,
      startLedger,
      latestLedger,
    )) {
      for (const event of eventBatch) {
        const parsed = parseSacTransferEvent(event);
        if (!parsed) continue;

        const routes = routeEventToUsers(event);

        for (const route of routes) {
          console.log(
            `[SorobanRouter] Event ${route.topic} from ${contractId.substring(0, 8)}... routed to ${route.userIds.length} user(s)`,
          );

          try {
            await prisma.sorobanEventSnapshot.upsert({
              where: {
                contractId_ledgerSeq_from_to_amount: {
                  contractId: parsed.contractId,
                  ledgerSeq: (parsed as any).ledgerSeq || event.ledgerSeq || 0,
                  from: parsed.from,
                  to: parsed.to,
                  amount: parsed.amount,
                },
              },
              create: {
                contractId: parsed.contractId,
                from: parsed.from,
                to: parsed.to,
                amount: parsed.amount,
                ledgerSeq: (parsed as any).ledgerSeq || event.ledgerSeq || 0,
              },
              update: {},
            });
          } catch (err: any) {
            if (err.code !== "P2025") {
              console.warn(
                "[SorobanRouter] Error storing event snapshot:",
                err.message,
              );
            }
          }
        }
      }
    }
  } catch (error: any) {
    console.error(
      `[SorobanRouter] Error processing contract ${contractId}:`,
      error.message,
    );
  }
}

if (require.main === module) {
  registerSupervisorHeartbeat();
  runWatcher();

  // Issue #20: Graceful shutdown for the watcher worker process
  let watcherIntervalId: NodeJS.Timeout | undefined;

  // Patch runWatcher to capture the interval handle so we can stop it
  const originalSetInterval = global.setInterval;
  (global as any).setInterval = (fn: (...args: any[]) => void, delay?: number, ...args: any[]) => {
    const id = originalSetInterval(fn, delay, ...args);
    watcherIntervalId = id;
    return id;
  };

  const shutdownWorker = async (signal: string) => {
    console.log(`[WatcherWorker] Received ${signal}. Shutting down gracefully...`);

    if (watcherIntervalId !== undefined) {
      clearInterval(watcherIntervalId);
      watcherIntervalId = undefined;
    }

    try {
      await prisma.$disconnect();
      console.log('[WatcherWorker] Shutdown complete.');
      process.exit(0);
    } catch (err) {
      console.error('[WatcherWorker] Error during shutdown:', err);
      process.exit(1);
    }
  };

  process.once('SIGTERM', () => shutdownWorker('SIGTERM'));
  process.once('SIGINT', () => shutdownWorker('SIGINT'));
}
