import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WebSocketMessage } from './websocket';

const verifyToken = vi.fn();

vi.mock('../utils/jwt', () => ({
  verifyToken: (...args: unknown[]) => verifyToken(...args),
}));

// Fake Redis subscriber captured so tests can simulate published messages.
let subscriberMessageHandler: ((channel: string, message: string) => void) | undefined;
const fakeSubscriber = {
  connect: vi.fn().mockResolvedValue(undefined),
  subscribe: vi.fn().mockResolvedValue(undefined),
  on: vi.fn((event: string, handler: any) => {
    if (event === 'message') subscriberMessageHandler = handler;
  }),
  quit: vi.fn().mockResolvedValue(undefined),
};

vi.mock('../lib/redis', () => ({
  redis: {
    duplicate: vi.fn(() => fakeSubscriber),
  },
}));

vi.mock('@fastify/websocket', () => ({ default: vi.fn() }));

// WsAuthManager is replaced with a no-op so timer-based tests don't need fake
// timers in this file — those are tested in ws-auth-manager.test.ts.
vi.mock('../lib/ws-auth-manager', () => ({
  WsAuthManager: vi.fn().mockImplementation(() => ({
    track: vi.fn(),
    untrack: vi.fn(),
    activeCount: vi.fn().mockReturnValue(0),
  })),
  EXPIRY_WARN_BEFORE_SECONDS: 60,
}));

function makeFakeSocket() {
  return {
    readyState: 1, // OPEN
    sent: [] as any[],
    send(data: string) {
      this.sent.push(JSON.parse(data));
    },
    on: vi.fn(),
    close: vi.fn(),
  };
}

async function loadPlugin() {
  const mod = await import('./websocket');
  return mod.default as unknown as (server: any) => Promise<void>;
}

function makeFakeServer() {
  const routes: Record<string, any> = {};
  const decorations: Record<string, any> = {};
  const server = {
    register: vi.fn().mockResolvedValue(undefined),
    decorate: vi.fn((name: string, value: any) => {
      decorations[name] = value;
    }),
    get: vi.fn((path: string, _opts: any, handler: any) => {
      routes[path] = handler;
    }),
    addHook: vi.fn(),
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    routes,
    decorations,
  };
  return server;
}

// Helper: grab the handler registered for a socket event.
function getSocketHandler(socket: ReturnType<typeof makeFakeSocket>, event: string) {
  return socket.on.mock.calls.find(([e]) => e === event)?.[1];
}

describe('WebSocket plugin auth + tenant isolation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    subscriberMessageHandler = undefined;
  });

  it('rejects a connection with no token', async () => {
    const plugin = await loadPlugin();
    const server = makeFakeServer();
    await plugin(server);

    const socket = makeFakeSocket();
    server.routes['/ws'](socket, { query: {} });

    expect(socket.close).toHaveBeenCalledWith(4401, 'Unauthorized');
    expect(socket.sent).toHaveLength(0);
  });

  it('rejects a connection with an invalid/expired token', async () => {
    verifyToken.mockImplementation(() => {
      throw new Error('invalid token');
    });
    const plugin = await loadPlugin();
    const server = makeFakeServer();
    await plugin(server);

    const socket = makeFakeSocket();
    server.routes['/ws'](socket, { query: { token: 'bad-token' } });

    expect(socket.close).toHaveBeenCalledWith(4401, 'Unauthorized');
  });

  it('admits a connection with a valid token and sends a connection message', async () => {
    verifyToken.mockReturnValue({ id: 'user-a', email: 'a@example.com', exp: 9999999999 });
    const plugin = await loadPlugin();
    const server = makeFakeServer();
    await plugin(server);

    const socket = makeFakeSocket();
    server.routes['/ws'](socket, { query: { token: 'good-token' } });

    expect(socket.close).not.toHaveBeenCalled();
    expect(socket.sent).toEqual([
      expect.objectContaining({ type: 'connection', payload: { status: 'connected' } }),
    ]);
  });

  it('routes a Redis-published event only to the connected sockets for that userId', async () => {
    verifyToken.mockImplementation((token: string) =>
      token === 'token-a'
        ? { id: 'user-a', exp: 9999999999 }
        : { id: 'user-b', exp: 9999999999 },
    );
    const plugin = await loadPlugin();
    const server = makeFakeServer();
    await plugin(server);

    const socketA = makeFakeSocket();
    const socketB = makeFakeSocket();
    server.routes['/ws'](socketA, { query: { token: 'token-a' } });
    server.routes['/ws'](socketB, { query: { token: 'token-b' } });
    socketA.sent = [];
    socketB.sent = [];

    expect(subscriberMessageHandler).toBeDefined();
    subscriberMessageHandler!(
      'stellar-alerts:payments',
      JSON.stringify({
        userId: 'user-a',
        type: 'payment',
        payload: { id: 'pay_1' },
        timestamp: new Date().toISOString(),
      }),
    );

    expect(socketA.sent).toHaveLength(1);
    expect(socketA.sent[0].payload.id).toBe('pay_1');
    expect(socketB.sent).toHaveLength(0);
  });

  it('routes delivery events to the connected user the same way as payment events', async () => {
    verifyToken.mockReturnValue({ id: 'user-a', exp: 9999999999 });
    const plugin = await loadPlugin();
    const server = makeFakeServer();
    await plugin(server);

    const socket = makeFakeSocket();
    server.routes['/ws'](socket, { query: { token: 'token-a' } });
    socket.sent = [];

    subscriberMessageHandler!(
      'stellar-alerts:deliveries',
      JSON.stringify({
        userId: 'user-a',
        type: 'delivery',
        payload: { id: 'log_1', statusCode: 200 },
        timestamp: new Date().toISOString(),
      }),
    );

    expect(socket.sent).toHaveLength(1);
    expect(socket.sent[0].type).toBe('delivery');
  });

  it('stops routing to a socket after it disconnects', async () => {
    verifyToken.mockReturnValue({ id: 'user-a', exp: 9999999999 });
    const plugin = await loadPlugin();
    const server = makeFakeServer();
    await plugin(server);

    const socket = makeFakeSocket();
    server.routes['/ws'](socket, { query: { token: 'token-a' } });
    socket.sent = [];

    const closeHandler = getSocketHandler(socket, 'close');
    expect(closeHandler).toBeDefined();
    closeHandler();

    subscriberMessageHandler!(
      'stellar-alerts:payments',
      JSON.stringify({
        userId: 'user-a',
        type: 'payment',
        payload: { id: 'pay_1' },
        timestamp: new Date().toISOString(),
      }),
    );

    expect(socket.sent).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Issue #333 — reauth, subscribe / unsubscribe
// ---------------------------------------------------------------------------
describe('WebSocket plugin – reauth flow (issue #333)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    subscriberMessageHandler = undefined;
  });

  it('accepts a valid reauth message and sends reauthenticated status', async () => {
    // First call: initial connect token. Second call: reauth token.
    verifyToken
      .mockReturnValueOnce({ id: 'user-a', exp: 9999999999 })
      .mockReturnValueOnce({ id: 'user-a', exp: 9999999999 + 900 });

    const plugin = await loadPlugin();
    const server = makeFakeServer();
    await plugin(server);

    const socket = makeFakeSocket();
    server.routes['/ws'](socket, { query: { token: 'initial-token' } });
    socket.sent = []; // clear connection message

    const msgHandler = getSocketHandler(socket, 'message');
    msgHandler!(Buffer.from(JSON.stringify({ type: 'reauth', token: 'new-token' })));

    expect(socket.sent).toHaveLength(1);
    expect(socket.sent[0].type).toBe('connection');
    expect(socket.sent[0].payload.status).toBe('reauthenticated');
  });

  it('includes restored subscriptions in the reauthenticated payload', async () => {
    verifyToken
      .mockReturnValueOnce({ id: 'user-a', exp: 9999999999 })
      .mockReturnValueOnce({ id: 'user-a', exp: 9999999999 + 900 });

    const plugin = await loadPlugin();
    const server = makeFakeServer();
    await plugin(server);

    const socket = makeFakeSocket();
    server.routes['/ws'](socket, { query: { token: 'initial-token' } });

    const msgHandler = getSocketHandler(socket, 'message');

    // Subscribe to a topic first
    msgHandler!(Buffer.from(JSON.stringify({ type: 'subscribe', topic: 'payments' })));

    socket.sent = [];
    msgHandler!(Buffer.from(JSON.stringify({ type: 'reauth', token: 'new-token' })));

    expect(socket.sent[0].payload.restoredSubscriptions).toContain('payments');
  });

  it('closes the socket when reauth token belongs to a different user', async () => {
    verifyToken
      .mockReturnValueOnce({ id: 'user-a', exp: 9999999999 })
      .mockReturnValueOnce({ id: 'user-b', exp: 9999999999 }); // different user!

    const plugin = await loadPlugin();
    const server = makeFakeServer();
    await plugin(server);

    const socket = makeFakeSocket();
    server.routes['/ws'](socket, { query: { token: 'token-a' } });

    const msgHandler = getSocketHandler(socket, 'message');
    msgHandler!(Buffer.from(JSON.stringify({ type: 'reauth', token: 'token-b' })));

    expect(socket.close).toHaveBeenCalledWith(4401, 'Unauthorized');
  });

  it('closes the socket when reauth token is invalid', async () => {
    verifyToken
      .mockReturnValueOnce({ id: 'user-a', exp: 9999999999 })
      .mockImplementationOnce(() => { throw new Error('expired'); });

    const plugin = await loadPlugin();
    const server = makeFakeServer();
    await plugin(server);

    const socket = makeFakeSocket();
    server.routes['/ws'](socket, { query: { token: 'token-a' } });
    socket.sent = [];

    const msgHandler = getSocketHandler(socket, 'message');
    msgHandler!(Buffer.from(JSON.stringify({ type: 'reauth', token: 'bad-token' })));

    const errorMsg = socket.sent.find((m) => m.type === 'token_expired');
    expect(errorMsg).toBeDefined();
    expect(socket.close).toHaveBeenCalledWith(4401, 'Unauthorized');
  });
});

describe('WebSocket plugin – subscription management (issue #333)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('records a subscribe message without sending a response', async () => {
    verifyToken.mockReturnValue({ id: 'user-a', exp: 9999999999 });
    const plugin = await loadPlugin();
    const server = makeFakeServer();
    await plugin(server);

    const socket = makeFakeSocket();
    server.routes['/ws'](socket, { query: { token: 'token-a' } });
    socket.sent = [];

    const msgHandler = getSocketHandler(socket, 'message');
    msgHandler!(Buffer.from(JSON.stringify({ type: 'subscribe', topic: 'payments' })));

    // No reply expected — the subscription is silently recorded server-side
    expect(socket.sent).toHaveLength(0);
    expect(socket.close).not.toHaveBeenCalled();
  });

  it('handles an unsubscribe message without error', async () => {
    verifyToken.mockReturnValue({ id: 'user-a', exp: 9999999999 });
    const plugin = await loadPlugin();
    const server = makeFakeServer();
    await plugin(server);

    const socket = makeFakeSocket();
    server.routes['/ws'](socket, { query: { token: 'token-a' } });
    socket.sent = [];

    const msgHandler = getSocketHandler(socket, 'message');
    msgHandler!(Buffer.from(JSON.stringify({ type: 'subscribe', topic: 'deliveries' })));
    msgHandler!(Buffer.from(JSON.stringify({ type: 'unsubscribe', topic: 'deliveries' })));

    expect(socket.close).not.toHaveBeenCalled();
  });

  it('does not crash on a malformed inbound message', async () => {
    verifyToken.mockReturnValue({ id: 'user-a', exp: 9999999999 });
    const plugin = await loadPlugin();
    const server = makeFakeServer();
    await plugin(server);

    const socket = makeFakeSocket();
    server.routes['/ws'](socket, { query: { token: 'token-a' } });

    const msgHandler = getSocketHandler(socket, 'message');
    expect(() => msgHandler!(Buffer.from('not-json-{{{}'))).not.toThrow();
  });
});

describe('WebSocketMessage type', () => {
  it('should create a valid WebSocket message', () => {
    const message: WebSocketMessage = {
      type: 'payment',
      payload: {
        id: '1',
        walletId: 'wallet1',
        txHash: 'hash123',
        fromAddress: 'GABC123',
        amount: 100,
        asset: 'XLM',
        receivedAt: new Date().toISOString(),
      },
      timestamp: new Date().toISOString(),
    };

    expect(message.type).toBe('payment');
    expect(message.payload).toBeDefined();
    expect(message.timestamp).toBeDefined();
  });

  it('should support the delivery message type', () => {
    const message: WebSocketMessage = {
      type: 'delivery',
      payload: { id: 'log_1', statusCode: 200 },
      timestamp: new Date().toISOString(),
    };

    expect(message.type).toBe('delivery');
  });

  it('should support token_expiring message type', () => {
    const message: WebSocketMessage = {
      type: 'token_expiring',
      payload: { message: 'Token expiring soon', expiresAt: new Date().toISOString() },
      timestamp: new Date().toISOString(),
    };
    expect(message.type).toBe('token_expiring');
  });

  it('should support token_expired message type', () => {
    const message: WebSocketMessage = {
      type: 'token_expired',
      payload: { message: 'Token has expired' },
      timestamp: new Date().toISOString(),
    };
    expect(message.type).toBe('token_expired');
  });
});
