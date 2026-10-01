import fp from 'fastify-plugin';
import websocket from '@fastify/websocket';
import { FastifyInstance } from 'fastify';
import { redis } from '../lib/redis';
import { verifyToken, UserPayload } from '../utils/jwt';
import { REALTIME_CHANNELS, RealtimeEnvelope } from '../lib/realtime';
import { ClientRegistry, WebSocketMessage } from '../lib/clientRegistry';
import { WsAuthManager, WsAuthEntry } from '../lib/ws-auth-manager';

export type { WebSocketMessage } from '../lib/clientRegistry';

declare module 'fastify' {
  interface FastifyInstance {
    broadcastToUser: (userId: string, message: WebSocketMessage) => void;
  }
}

export default fp(async (server: FastifyInstance) => {
  // Register the websocket plugin for type augmentation
  await server.register(websocket);

  const registry = new ClientRegistry();
  const authManager = new WsAuthManager();

  // Create Redis subscriber for pub/sub
  const subscriber = redis.duplicate();

  try {
    await subscriber.connect();
    server.log.info('🔌 Redis subscriber connected for WebSocket');
  } catch (error) {
    server.log.warn({ err: error }, '⚠️ Redis subscriber connection failed, WebSocket will not work');
  }

  // Subscribe to persisted-event channels published by the watcher worker
  // (payments) and the webhook dispatcher (deliveries) — see lib/realtime.ts.
  const channels = [REALTIME_CHANNELS.PAYMENTS, REALTIME_CHANNELS.DELIVERIES];
  await subscriber.subscribe(...channels, (err) => {
    if (err) {
      server.log.error({ err }, '❌ Failed to subscribe to realtime channels');
    } else {
      server.log.info({ channels }, '📡 Subscribed to realtime channels');
    }
  });

  // Relay each Redis-published event only to the sockets belonging to the
  // user it names — this is the tenant-isolation boundary: routing is keyed
  // off the JWT-verified userId captured at connect time (registry), never
  // off anything the client sends.
  subscriber.on('message', (_channel, message) => {
    try {
      const envelope = JSON.parse(message) as RealtimeEnvelope;
      if (!envelope?.userId) return;

      registry.broadcastToUser(envelope.userId, {
        type: envelope.type,
        payload: envelope.payload,
        timestamp: envelope.timestamp,
      });
    } catch (error) {
      server.log.error({ err: error }, '❌ Error processing realtime message');
    }
  });

  server.decorate('broadcastToUser', (userId: string, message: WebSocketMessage) => {
    registry.broadcastToUser(userId, message);
  });

  // ---------------------------------------------------------------------------
  // Helper: extract and verify a JWT from a WebSocket request (Authorization
  // header or ?token= query param).
  // ---------------------------------------------------------------------------
  function extractUser(request: any): UserPayload | null {
    let user = (request as any).user;
    if (!user) {
      const authHeader = request.headers?.['authorization'];
      const token = authHeader?.replace(/^Bearer\s+/i, '') || (request.query as any)?.token;
      if (token) {
        try {
          user = verifyToken<UserPayload>(token);
        } catch {
          return null;
        }
      }
    }
    return user ?? null;
  }

  // Register WebSocket upgrade endpoint
  server.get('/ws', { websocket: true } as any, (socket: any, request: any) => {
    const user = extractUser(request);
    if (!user) {
      socket.close(4401, 'Unauthorized');
      return;
    }

    const userId = user.id;
    const entry = registry.register(userId, socket);
    server.log.info(
      `🔗 WebSocket client connected for user ${userId.substring(0, 8)}... (total for user: ${registry.clientCountForUser(userId)})`,
    );

    registry.sendToEntry(entry, {
      type: 'connection',
      payload: { status: 'connected' },
      timestamp: new Date().toISOString(),
    });

    // ------------------------------------------------------------------
    // Auth expiry tracking (issue #333)
    // ------------------------------------------------------------------
    const tokenExp = user.exp ?? 0; // JWT `exp` claim (seconds since epoch)

    const authEntry: WsAuthEntry = {
      userId,
      tokenExp,
      onExpiring: () => {
        // Warn the client ~60 s ahead so it can refresh and reconnect.
        registry.sendToEntry(entry, {
          type: 'token_expiring',
          payload: {
            message: 'Your session token will expire soon. Please reauthenticate.',
            expiresAt: new Date(tokenExp * 1000).toISOString(),
          },
          timestamp: new Date().toISOString(),
        });
      },
      onExpired: () => {
        // Gracefully close the socket with a 4401 close code so the client
        // knows it must re-authenticate before opening a new connection.
        try {
          registry.sendToEntry(entry, {
            type: 'token_expired',
            payload: {
              message: 'Session token has expired. Reconnect with a fresh token.',
            },
            timestamp: new Date().toISOString(),
          });
        } catch {
          // Best-effort — socket may already be closing.
        }
        socket.close(4401, 'Token expired');
      },
    };

    authManager.track(authEntry);

    // ------------------------------------------------------------------
    // Inbound message handler
    // ------------------------------------------------------------------
    socket.on('message', (data: import('ws').RawData) => {
      try {
        const message = JSON.parse(data.toString());
        server.log.debug({ message }, '📩 Received WebSocket message');

        // ----------------------------------------------------------------
        // Re-authentication: client sends { type: 'reauth', token: '...' }
        // with a freshly obtained access token. We verify it, update the
        // auth manager with the new expiry, and restore subscriptions.
        // ----------------------------------------------------------------
        if (message?.type === 'reauth' && typeof message?.token === 'string') {
          let refreshedUser: UserPayload | null = null;
          try {
            refreshedUser = verifyToken<UserPayload>(message.token);
          } catch {
            registry.sendToEntry(entry, {
              type: 'token_expired',
              payload: { message: 'Provided token is invalid or expired.' },
              timestamp: new Date().toISOString(),
            });
            socket.close(4401, 'Unauthorized');
            return;
          }

          if (refreshedUser.id !== userId) {
            // Token belongs to a different user — reject.
            socket.close(4401, 'Unauthorized');
            return;
          }

          // Stop the old expiry timer and start a new one for the fresh token.
          authManager.untrack(authEntry);
          authEntry.tokenExp = refreshedUser.exp ?? 0;
          authManager.track(authEntry);

          // Restore subscriptions that were active before expiry.
          const restoredTopics = Array.from(entry.subscriptions);

          registry.sendToEntry(entry, {
            type: 'connection',
            payload: {
              status: 'reauthenticated',
              restoredSubscriptions: restoredTopics,
            },
            timestamp: new Date().toISOString(),
          });

          server.log.info(
            `🔄 WebSocket re-auth successful for user ${userId.substring(0, 8)}… ` +
            `(restored ${restoredTopics.length} subscription(s))`,
          );
          return;
        }

        // ----------------------------------------------------------------
        // Subscription management: { type: 'subscribe', topic: '...' }
        // ----------------------------------------------------------------
        if (message?.type === 'subscribe' && typeof message?.topic === 'string') {
          registry.subscribe(entry, message.topic);
          server.log.debug(
            { userId: userId.substring(0, 8), topic: message.topic },
            '📌 Client subscribed to topic',
          );
          return;
        }

        // ----------------------------------------------------------------
        // Unsubscribe: { type: 'unsubscribe', topic: '...' }
        // ----------------------------------------------------------------
        if (message?.type === 'unsubscribe' && typeof message?.topic === 'string') {
          registry.unsubscribe(entry, message.topic);
          server.log.debug(
            { userId: userId.substring(0, 8), topic: message.topic },
            '📌 Client unsubscribed from topic',
          );
          return;
        }
      } catch (error: unknown) {
        server.log.warn({ err: error }, '⚠️ Invalid WebSocket message');
      }
    });

    socket.on('close', () => {
      authManager.untrack(authEntry);
      registry.unregister(userId, entry);
      server.log.info(`🔌 WebSocket client disconnected for user ${userId.substring(0, 8)}...`);
    });

    socket.on('error', (error: Error) => {
      server.log.error({ err: error }, '❌ WebSocket error');
      authManager.untrack(authEntry);
      registry.unregister(userId, entry);
    });
  });

  // Cleanup on server close
  server.addHook('onClose', async () => {
    for (const entry of registry.getAllEntries()) {
      try {
        (entry.socket as unknown as import('ws').WebSocket).close();
      } catch {}
    }

    await subscriber.quit();
    server.log.info('🔌 WebSocket and Redis subscriber cleaned up');
  });
});
