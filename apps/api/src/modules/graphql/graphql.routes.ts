import { ApolloServer } from '@apollo/server';
import { fastifyApolloDrainPlugin, fastifyApolloHandler } from '@as-integrations/fastify';
import { makeExecutableSchema } from '@graphql-tools/schema';
import { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import { parse, subscribe, validate, type GraphQLError, type GraphQLSchema } from 'graphql';
import { typeDefs } from './graphql.schema';
import { createResolvers } from './graphql.resolvers';
import { redis } from '../../lib/redis';

interface GraphQLWireMessage {
  id?: string;
  type?: string;
  query?: string;
  variables?: Record<string, unknown>;
  operationName?: string;
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return typeof value === 'object' && value !== null && Symbol.asyncIterator in value;
}

/**
 * Bridges a single WebSocket connection onto GraphQL subscriptions.
 *
 * Apollo Server 4 deliberately ships no WebSocket server and `graphql-ws` is
 * not a dependency here, so the slice of the protocol these subscriptions
 * actually use is implemented directly: one `{query, variables, operationName}`
 * frame in, a stream of `next` frames out, terminated by `complete` (or
 * `error`). An unsupported frame is answered with `error` rather than closing
 * the socket, so a client mistake does not kill a live subscription.
 */
function handleGraphQLWebSocket(socket: WebSocket, schema: GraphQLSchema): void {
  const send = (payload: Record<string, unknown>) => {
    if (socket.readyState === socket.OPEN) {
      socket.send(JSON.stringify(payload));
    }
  };

  // At most one active subscription per connection. A further `start` frame
  // replaces the previous one, matching the request/response semantics of a
  // WebSocket rather than multiplexing streams over a single id.
  let active: AsyncIterator<unknown> | null = null;

  const stopActive = () => {
    void active?.return?.();
    active = null;
  };

  const fail = (id: string | null, payload: string | string[]) => {
    send({ id, type: 'error', payload });
  };

  socket.on('message', (raw: unknown) => {
    void (async () => {
      let message: GraphQLWireMessage;
      try {
        message = JSON.parse(String(raw)) as GraphQLWireMessage;
      } catch {
        fail(null, 'Malformed message: expected JSON');
        return;
      }

      const id = message.id ?? null;

      if (message.type === 'stop' || message.type === 'complete') {
        stopActive();
        return;
      }

      if (message.type && message.type !== 'start' && message.type !== 'subscribe') {
        fail(id, `Unsupported message type: ${message.type}`);
        return;
      }

      if (!message.query) {
        fail(id, 'Missing `query`');
        return;
      }

      let document;
      try {
        document = parse(message.query);
      } catch (error) {
        fail(id, (error as GraphQLError).message);
        return;
      }

      const validationErrors = validate(schema, document);
      if (validationErrors.length > 0) {
        fail(id, validationErrors.map((e) => e.message));
        return;
      }

      let result;
      try {
        result = await subscribe({
          schema,
          document,
          variableValues: message.variables ?? undefined,
          operationName: message.operationName ?? undefined,
        });
      } catch (error) {
        fail(id, (error as Error).message);
        return;
      }

      if (!isAsyncIterable(result)) {
        // A query or mutation rather than a subscription: answer once, then end.
        send({ id, type: 'next', payload: result });
        send({ id, type: 'complete' });
        return;
      }

      stopActive();
      active = result[Symbol.asyncIterator]();

      try {
        for (;;) {
          const next = await active.next();
          if (next.done === true) break;
          send({ id, type: 'next', payload: next.value });
        }
        send({ id, type: 'complete' });
      } catch (error) {
        fail(id, (error as Error).message);
      } finally {
        active = null;
      }
    })();
  });

  socket.on('close', stopActive);
  socket.on('error', stopActive);
}

export const graphqlRoutes = async (app: FastifyInstance) => {
  const resolvers = createResolvers(redis);

  // Apollo Server owns the HTTP path. The executable schema is rebuilt only
  // because `subscribe()` needs a `GraphQLSchema` to resolve the subscription
  // field against, and Apollo does not expose the one it compiled internally.
  const schema = makeExecutableSchema({ typeDefs, resolvers });

  const server = new ApolloServer({
    typeDefs,
    resolvers,
    plugins: [fastifyApolloDrainPlugin(app)],
  });

  await server.start();

  const handler = fastifyApolloHandler(server);

  app.route({
    url: '/graphql',
    method: ['GET', 'POST'],
    handler,
    wsHandler: (socket: WebSocket) => handleGraphQLWebSocket(socket, schema),
  });
};
