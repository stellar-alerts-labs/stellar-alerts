import { nativeToScVal, xdr, Keypair } from 'stellar-sdk';

/**
 * Options for building mock Soroban contract events
 */
export interface MockSorobanEventOptions {
  contractId?: string;
  topics?: string[];
  data?: Record<string, any>;
  ledgerSeq?: number;
  txHash?: string;
  id?: string;
  timestamp?: Date | string;
}

/**
 * Encodes a JavaScript value to base64 XDR ScVal format
 */
export function encodeScValToBase64(value: any, type?: string): string {
  const scVal = nativeToScVal(value, type ? { type } : undefined);
  return scVal.toXDR('base64');
}

/**
 * Builds a mock Soroban event topic array with XDR-encoded Symbol values
 */
export function buildMockTopics(topics: string[]): string[] {
  return topics.map((topic) => {
    const symbolScVal = xdr.ScVal.scvSymbol(topic);
    return symbolScVal.toXDR('base64');
  });
}

/**
 * Generates a realistic Soroban contract ID (C-prefixed Stellar address)
 */
export function generateMockContractId(): string {
  const keypair = Keypair.random();
  // Soroban contract addresses start with 'C'
  return `C${keypair.publicKey().substring(1)}`;
}

/**
 * Builds a mock Soroban RPC contract event with XDR-encoded topics and data
 *
 * @example
 * // Basic transfer event
 * const event = buildMockSorobanEvent({
 *   topics: ['transfer'],
 *   data: { from: 'GABC...', to: 'GDEF...', amount: '1000000' }
 * });
 *
 * @example
 * // Swap event with specific contract
 * const event = buildMockSorobanEvent({
 *   contractId: 'CPOOL123...',
 *   topics: ['swap'],
 *   data: { amountIn: '5000000', amountOut: '4950000' }
 * });
 */
export function buildMockSorobanEvent(options: MockSorobanEventOptions = {}) {
  const {
    contractId = generateMockContractId(),
    topics = ['transfer'],
    data = {},
    ledgerSeq = 1000000,
    txHash = `tx_${Math.random().toString(36).substring(2, 15)}`,
    id = `evt_${Math.random().toString(36).substring(2, 15)}`,
    timestamp = new Date(),
  } = options;

  return {
    id,
    contractId,
    topics: buildMockTopics(topics),
    value: encodeScValToBase64(data),
    txHash,
    ledgerSeq,
    timestamp,
  };
}

/**
 * Builds a mock transfer event with standard Stellar Asset Contract fields
 */
export function buildMockTransferEvent(overrides: Partial<MockSorobanEventOptions> = {}) {
  const fromAddress = overrides.data?.from || Keypair.random().publicKey();
  const toAddress = overrides.data?.to || Keypair.random().publicKey();
  const amount = overrides.data?.amount || '1000000';

  return buildMockSorobanEvent({
    ...overrides,
    topics: ['transfer'],
    data: {
      from: fromAddress,
      to: toAddress,
      amount,
      ...overrides.data,
    },
  });
}

/**
 * Builds a mock swap event typical of DEX/AMM contracts
 */
export function buildMockSwapEvent(overrides: Partial<MockSorobanEventOptions> = {}) {
  return buildMockSorobanEvent({
    ...overrides,
    topics: ['swap'],
    data: {
      sender: Keypair.random().publicKey(),
      amountIn: '5000000',
      amountOut: '4950000',
      tokenIn: generateMockContractId(),
      tokenOut: generateMockContractId(),
      ...overrides.data,
    },
  });
}

/**
 * Builds a mock contract upgrade event
 */
export function buildMockUpgradeEvent(overrides: Partial<MockSorobanEventOptions> = {}) {
  return buildMockSorobanEvent({
    ...overrides,
    topics: ['update_wasm'],
    data: {
      oldWasmHash: '1111111111111111111111111111111111111111111111111111111111111111',
      newWasmHash: '2222222222222222222222222222222222222222222222222222222222222222',
      ...overrides.data,
    },
  });
}

/**
 * Builds multiple mock events for batch testing
 */
export function buildMockSorobanEvents(
  count: number,
  baseOptions: MockSorobanEventOptions = {},
): ReturnType<typeof buildMockSorobanEvent>[] {
  return Array.from({ length: count }, (_, index) =>
    buildMockSorobanEvent({
      ...baseOptions,
      ledgerSeq: (baseOptions.ledgerSeq || 1000000) + index,
      id: `evt_${index}_${Math.random().toString(36).substring(2, 15)}`,
    }),
  );
}
