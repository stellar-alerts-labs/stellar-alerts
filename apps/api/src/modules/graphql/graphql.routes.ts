import { ApolloServer } from '@apollo/server';
import { fastifyApolloDrainPlugin, fastifyApolloHandler } from '@as-integrations/fastify';
import { FastifyInstance } from 'fastify';
import { typeDefs } from './graphql.schema';
import { createResolvers } from './graphql.resolvers';
import { redis } from '../../lib/redis';

export const graphqlRoutes = async (app: FastifyInstance) => {
  const resolvers = createResolvers(redis);

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
    // @as-integrations/fastify v2 ships no WebSocket-aware handler; keep the
    // existing ws wiring until subscriptions move to a graphql-ws transport.
    wsHandler: fastifyApolloHandler(server, {
      context: async () => ({ redis }),
    }) as any,
  });
};
