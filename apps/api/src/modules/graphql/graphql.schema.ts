// `gql` was removed from the `graphql` root export in 16.14; `parse` is the
// supported way to turn an SDL template literal into a DocumentNode.
import { parse } from 'graphql';

export const typeDefs = parse(`
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
`);
