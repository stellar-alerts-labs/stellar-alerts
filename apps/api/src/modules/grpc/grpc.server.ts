import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { redis } from '../../lib/redis';
import path from 'path';

const PROTO_PATH = path.join(__dirname, 'stellar.proto');

const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
});

const stellarProto = grpc.loadPackageDefinition(packageDefinition).stellar as any;

export const createGrpcServer = (port: number = 50051) => {
  const server = new grpc.Server();

  const ledgerServiceImpl = {
    StreamLedgerEvents: (call: any) => {
      const pubsub = redis.duplicate();
      const channel = 'ledger_events';

      pubsub.subscribe(channel, (err?: Error | null) => {
        if (err) {
          call.emit('error', err);
          return;
        }
      });

      pubsub.on('message', (channel: string, message: string) => {
        const event = JSON.parse(message);
        call.write({
          ledger_seq: event.ledgerSeq,
          tx_hash: event.txHash,
          timestamp: event.timestamp,
          operations: event.operations,
        });
      });

      call.on('cancelled', () => {
        pubsub.quit();
      });
    },
    StreamWalletAlerts: (call: any) => {
      const { wallet_id, asset_filter, min_amount } = call.request;
      const pubsub = redis.duplicate();
      const channel = 'wallet_alerts';

      pubsub.subscribe(channel, (err?: Error | null) => {
        if (err) {
          call.emit('error', err);
          return;
        }
      });

      pubsub.on('message', (channel: string, message: string) => {
        const alert = JSON.parse(message);
        
        if (wallet_id && alert.walletId !== wallet_id) return;
        if (asset_filter && alert.asset !== asset_filter) return;
        if (min_amount && parseFloat(alert.amount) < min_amount) return;

        call.write({
          payment_id: alert.paymentId,
          wallet_id: alert.walletId,
          from_address: alert.fromAddress,
          amount: alert.amount,
          asset: alert.asset,
          received_at: alert.receivedAt,
          alert_type: alert.alertType,
        });
      });

      call.on('cancelled', () => {
        pubsub.quit();
      });
    },
    BidirectionalStream: (call: any) => {
      const subscriptions = new Map<string, any>();

      call.on('data', (data: any) => {
        const { subscription_id, alert_request, ledger_request } = data;

        if (alert_request) {
          const pubsub = redis.duplicate();
          pubsub.subscribe('wallet_alerts');
          
          subscriptions.set(subscription_id, { pubsub, type: 'alert' });

          pubsub.on('message', (channel: string, message: string) => {
            const alert = JSON.parse(message);
            call.write({
              subscription_id,
              alert_event: {
                payment_id: alert.paymentId,
                wallet_id: alert.walletId,
                from_address: alert.fromAddress,
                amount: alert.amount,
                asset: alert.asset,
                received_at: alert.receivedAt,
                alert_type: alert.alertType,
              },
            });
          });
        }

        if (ledger_request) {
          const pubsub = redis.duplicate();
          pubsub.subscribe('ledger_events');
          
          subscriptions.set(subscription_id, { pubsub, type: 'ledger' });

          pubsub.on('message', (channel: string, message: string) => {
            const event = JSON.parse(message);
            call.write({
              subscription_id,
              ledger_event: {
                ledger_seq: event.ledgerSeq,
                tx_hash: event.txHash,
                timestamp: event.timestamp,
                operations: event.operations,
              },
            });
          });
        }
      });

      call.on('end', () => {
        subscriptions.forEach((sub) => sub.pubsub.quit());
        call.end();
      });
    },
  };

  server.addService(stellarProto.LedgerService.service, ledgerServiceImpl);

  return {
    start: () => {
      server.bindAsync(
        `0.0.0.0:${port}`,
        grpc.ServerCredentials.createInsecure(),
        (err, port) => {
          if (err) {
            console.error('Failed to start gRPC server:', err);
            return;
          }
          console.log(`gRPC server running on port ${port}`);
          server.start();
        }
      );
    },
    stop: () => {
      server.tryShutdown((err) => {
        if (err) {
          console.error('Error shutting down gRPC server:', err);
        } else {
          console.log('gRPC server shut down gracefully');
        }
      });
    },
  };
};
