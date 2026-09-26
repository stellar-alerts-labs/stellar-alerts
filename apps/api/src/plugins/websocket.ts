import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';

// In-memory set of active SSE connections
const clients = new Set<FastifyReply>();

/**
 * Registers GET /events SSE endpoint.
 * Clients connect and receive real-time payment events as SSE messages.
 * Uses Server-Sent Events (SSE) over native Fastify — no @fastify/websocket required.
 */
export async function registerSSEPushPlugin(app: FastifyInstance): Promise<void> {
  app.get(
    '/events',
    {
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });

      // Send initial connected event
      reply.raw.write('event: connected\ndata: {"status":"connected"}\n\n');

      // Register this client
      clients.add(reply);

      // Clean up on disconnect
      request.raw.on('close', () => {
        clients.delete(reply);
      });

      // Keep the connection open indefinitely — resolved only by client disconnect
      await new Promise<void>(() => {});
    },
  );
}

/**
 * Broadcasts a payment event to all connected SSE clients.
 * Silently removes any client whose connection has broken.
 */
export function broadcastPaymentEvent(data: object): void {
  const message = `event: payment\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of clients) {
    try {
      client.raw.write(message);
    } catch {
      // Connection is dead — remove it
      clients.delete(client);
    }
  }
}

/**
 * Returns the current count of active SSE connections.
 * Useful for health checks and metrics.
 */
export function getActiveClientCount(): number {
  return clients.size;
}
