// The Apollo Server accepts either a DocumentNode or a plain string for typeDefs.
// We use a tagged template for syntax highlighting without importing 'graphql' directly.
export const typeDefs = `#graphql
  type Payment {
    id: String!
    walletId: String!
    txHash: String!
    fromAddress: String!
    amount: String!
    asset: String!
    assetIssuer: String
    memo: String
    receivedAt: String!
  }

  type SorobanEvent {
    id: String!
    contractId: String!
    ledgerSeq: Int!
    topics: String!
    txHash: String
  }

  type QueueMetrics {
    waiting: Int!
    active: Int!
    delayed: Int!
  }

  type SystemMetrics {
    queueDepth: QueueMetrics!
    deliveryLatency: Float!
    workerStatus: String!
  }

  input PaymentFilter {
    walletId: String
    asset: String
    minAmount: Float
  }

  input SorobanEventFilter {
    contractId: String
    topicSymbol: String
  }

  type Subscription {
    paymentStream(filter: PaymentFilter): Payment!
    sorobanEventStream(filter: SorobanEventFilter): SorobanEvent!
    systemMetrics: SystemMetrics!
  }

  type Query {
    health: String
  }
`;
