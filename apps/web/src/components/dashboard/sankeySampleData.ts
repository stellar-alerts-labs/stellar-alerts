import type { PathPaymentFlow } from './sankeyLayout';

/**
 * Synthetic route fixture used only by the "Preview sample route" affordance in
 * the empty state. It mirrors the shape of a Stellar `path_payment_strict_receive`
 * operation (source asset -> N DEX pool offers -> destination asset) so the
 * Sankey rendering can be exercised before multi-hop path payment ingestion
 * ships a `/payments/path-flows` endpoint.
 */
export const SAMPLE_PATH_PAYMENT_FLOWS: PathPaymentFlow[] = [
  {
    id: 'sample-2hop',
    txHash: 'a1c4f70e58d94a4b9d1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f6071',
    ledger: 61842241,
    sourceAsset: 'XLM',
    sourceAmount: 10000,
    destinationAsset: 'EURC',
    destinationAmount: 2238.75,
    hops: [
      {
        poolId: 'sdex-xlm-usdc',
        poolLabel: 'SDEX XLM/USDC',
        fromAsset: 'XLM',
        fromAmount: 10000,
        toAsset: 'USDC',
        toAmount: 2450,
        feeAsset: 'XLM',
        feeAmount: 5,
      },
      {
        poolId: 'sdex-usdc-eurc',
        poolLabel: 'SDEX USDC/EURC',
        fromAsset: 'USDC',
        fromAmount: 2450,
        toAsset: 'EURC',
        toAmount: 2238.75,
        feeAsset: 'USDC',
        feeAmount: 1.225,
      },
    ],
  },
  {
    id: 'sample-1hop',
    txHash: 'b2d5e81f69ea5b5c0e2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f6071829',
    ledger: 61842993,
    sourceAsset: 'XLM',
    sourceAmount: 5000,
    destinationAsset: 'USDC',
    destinationAmount: 1225,
    hops: [
      {
        poolId: 'sdex-xlm-usdc',
        poolLabel: 'SDEX XLM/USDC',
        fromAsset: 'XLM',
        fromAmount: 5000,
        toAsset: 'USDC',
        toAmount: 1225,
        feeAsset: 'XLM',
        feeAmount: 2.5,
      },
    ],
  },
  {
    id: 'sample-3hop',
    txHash: 'c3e6f92f70fb6c6d1f3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f607182930',
    ledger: 61843117,
    sourceAsset: 'USDC',
    sourceAmount: 1000,
    destinationAsset: 'EURC',
    destinationAmount: 913.37,
    hops: [
      {
        poolId: 'sdex-usdc-eurc',
        poolLabel: 'SDEX USDC/EURC',
        fromAsset: 'USDC',
        fromAmount: 1000,
        toAsset: 'EURC',
        toAmount: 913.37,
        feeAsset: 'USDC',
        feeAmount: 0.5,
      },
    ],
  },
];
