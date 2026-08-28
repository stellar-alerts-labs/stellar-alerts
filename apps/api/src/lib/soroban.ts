import * as StellarSdk from "stellar-sdk";
import { prisma } from "./prisma";

const SOROBAN_RPC_URL =
  process.env.SOROBAN_RPC_URL || "https://soroban-testnet.stellar.org";
const LEDGER_BATCH_SIZE = 100;
const MAX_EVENTS_PER_QUERY = 10000;
const MAX_ACTIVE_CONTRACTS = 100;

export const sorobanServer = new (StellarSdk as any).rpc.Server(
  SOROBAN_RPC_URL,
);

export interface ParsedSorobanTransfer {
  contractId: string;
  from: string;
  to: string;
  amount: string;
  topic: string;
  ledgerSeq?: number;
}

export interface ContractRegistry {
  contractId: string;
  topicRoutes: Map<string, string[]>;
  lastPolled?: number;
}

// In-memory registry for fast topic routing
const contractRegistry = new Map<string, ContractRegistry>();

/**
 * Loads active Soroban contract subscriptions into in-memory registry.
 * Maintains up to MAX_ACTIVE_CONTRACTS.
 */
export async function loadContractRegistry(): Promise<
  Map<string, ContractRegistry>
> {
  try {
    const subscriptions = await prisma.sorobanContractSubscription.findMany({
      where: { isActive: true },
      orderBy: { createdAt: "desc" },
      take: MAX_ACTIVE_CONTRACTS,
    });

    contractRegistry.clear();

    // Group by contractId
    const grouped = new Map<string, Map<string, Set<string>>>();

    for (const sub of subscriptions) {
      if (!grouped.has(sub.contractId)) {
        grouped.set(sub.contractId, new Map());
      }

      const topicMap = grouped.get(sub.contractId)!;
      const topic = sub.topic || "default";

      if (!topicMap.has(topic)) {
        topicMap.set(topic, new Set());
      }

      topicMap.get(topic)!.add(sub.userId);
    }

    // Convert to registry format
    for (const [contractId, topicMap] of grouped.entries()) {
      const topicRoutes = new Map<string, string[]>();

      for (const [topic, userIds] of topicMap.entries()) {
        topicRoutes.set(topic, Array.from(userIds));
      }

      contractRegistry.set(contractId, {
        contractId,
        topicRoutes,
        lastPolled: Date.now(),
      });
    }

    console.log(
      `[Registry] Loaded ${contractRegistry.size} active contracts (${subscriptions.length} subscriptions)`,
    );
    return contractRegistry;
  } catch (error: any) {
    console.error("[Registry] Error loading contract registry:", error.message);
    return contractRegistry;
  }
}

/**
 * Routes an event to matching subscribed users based on contract ID and topic.
 */
export function routeEventToUsers(
  event: any,
): { contractId: string; topic: string; userIds: string[] }[] {
  const routes: { contractId: string; topic: string; userIds: string[] }[] = [];
  const contractId = event.contractId;

  if (!contractId) return routes;

  const contract = contractRegistry.get(contractId);
  if (!contract) return routes;

  // Determine topic from event
  const topic = event.topic?.[0] || "default";

  // Check for exact topic match
  let matchedUserIds = contract.topicRoutes.get(topic);

  // Fall back to 'default' topic if no exact match
  if (!matchedUserIds || matchedUserIds.length === 0) {
    matchedUserIds = contract.topicRoutes.get("default");
  }

  if (matchedUserIds && matchedUserIds.length > 0) {
    routes.push({
      contractId,
      topic,
      userIds: matchedUserIds,
    });
  }

  return routes;
}

/**
 * Gets all active contract IDs from registry.
 */
export function getActiveContractIds(): string[] {
  return Array.from(contractRegistry.keys());
}

/**
 * Gets contract subscriber count for a specific contract.
 */
export function getContractSubscriberCount(contractId: string): number {
  const contract = contractRegistry.get(contractId);
  if (!contract) return 0;

  let total = 0;
  for (const userIds of contract.topicRoutes.values()) {
    total += userIds.length;
  }

  return total;
}

/**
 * Fetches latest ledger sequence from Soroban RPC endpoint.
 */
export async function getSorobanLatestLedger(): Promise<number> {
  try {
    const health = await sorobanServer.getLatestLedger();
    return health.sequence;
  } catch (error: any) {
    console.warn(
      `[SorobanRPC] Could not fetch latest ledger: ${error.message}`,
    );
    return 0;
  }
}

/**
 * Fetches contract events from Soroban RPC for a specific contract address.
 */
export async function fetchContractEvents(
  contractId: string,
  startLedger: number,
): Promise<any[]> {
  try {
    const response = await sorobanServer.getEvents({
      startLedger,
      filters: [
        {
          type: "contract",
          contractIds: [contractId],
        },
      ],
    });
    return response.events || [];
  } catch (error: any) {
    console.error(
      `[SorobanRPC] Error fetching contract events for ${contractId}:`,
      error.message,
    );
    return [];
  }
}

/**
 * Fetches contract events within a ledger range with pagination.
 */
export async function* fetchContractEventsInRange(
  contractId: string,
  startLedger: number,
  endLedger: number,
): AsyncGenerator<any[]> {
  let currentStart = startLedger;

  while (currentStart <= endLedger) {
    const batchEnd = Math.min(currentStart + LEDGER_BATCH_SIZE, endLedger);

    try {
      console.log(
        `[SorobanRPC] Fetching events for ${contractId} from ledger ${currentStart} to ${batchEnd}`,
      );

      const response = await sorobanServer.getEvents({
        startLedger: currentStart,
        endLedger: batchEnd,
        filters: [
          {
            type: "contract",
            contractIds: [contractId],
          },
        ],
      });

      const events = response.events || [];

      if (events.length > 0) {
        const enrichedEvents = events.map((evt: any) => ({
          ...evt,
          ledgerSeq: evt.ledger || currentStart,
        }));
        yield enrichedEvents;
      }

      if (events.length > 0 && events[events.length - 1]?.ledger) {
        currentStart = events[events.length - 1].ledger + 1;
      } else {
        currentStart = batchEnd + 1;
      }

      if (events.length === 0) break;
    } catch (error: any) {
      console.error(
        `[SorobanRPC] Error fetching events for ${contractId} in range [${currentStart}, ${batchEnd}]:`,
        error.message,
      );
      currentStart = batchEnd + 1;
    }
  }
}

/**
 * Parses raw Soroban RPC event data into a clean transfer object.
 */
export function parseSorobanTransferEvent(
  event: any,
): ParsedSorobanTransfer | null {
  if (!event || !event.topic || event.topic.length === 0) {
    return null;
  }

  const contractId = event.contractId || "";
  const topic = event.topic[0] || "";

  const value = event.value || {};
  const from = value.from || value.transfer?.from || "";
  const to = value.to || value.transfer?.to || "";
  const amount = value.amount ? String(value.amount) : "0";

  return {
    contractId,
    from,
    to,
    amount,
    topic,
    ledgerSeq: event.ledgerSeq || event.ledger,
  };
}
