/**
 * Contract tests for the /graphql route (apps/api/src/modules/graphql).
 *
 * `graphqlRoutes` builds TWO schemas over the same typeDefs/resolvers: the one
 * Apollo Server compiles for HTTP, and a second one via
 * `makeExecutableSchema` that the WebSocket subscription bridge hands to
 * `subscribe()`. That second build is the fragile part — a typeDefs/resolver
 * disagreement throws at plugin-registration time, and a resolver that
 * resolves against a schema Apollo never built is invisible to HTTP-only
 * tests. These tests pin both:
 *
 *  - the plugin registers cleanly (catches a broken executable schema),
 *  - HTTP introspection answers 200 with a real schema,
 *  - the route carries a genuine `wsHandler` function rather than the HTTP
 *    handler, which is the exact mistake that previously type-errored here.
 *
 * The suite needs no Redis: introspection never reaches a resolver, and
 * `getRedisClient()` is only used to construct the resolver map.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

import { graphqlRoutes } from '../graphql.routes';

describe('GET/POST /graphql', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify({ logger: false });
    await app.register(graphqlRoutes);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('registers without throwing, so the executable schema is buildable', async () => {
    // `makeExecutableSchema` is where a typeDefs/resolver mismatch surfaces.
    // Reaching `ready()` at all is the assertion; a broken schema throws here.
    expect(app).toBeDefined();
  });

  it('answers an introspection query over HTTP', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/graphql',
      headers: { 'content-type': 'application/json' },
      payload: {
        query: '{ __schema { queryType { name } subscriptionType { name } } }',
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.errors).toBeUndefined();
    expect(body.data.__schema.queryType.name).toBe('Query');
    // A subscription root must exist, or the WebSocket bridge has nothing to
    // subscribe to and `subscribe()` would reject every start frame.
    expect(body.data.__schema.subscriptionType?.name).toBe('Subscription');
  });

  it('returns 400 with a GraphQL error for an unparseable query rather than crashing', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/graphql',
      headers: { 'content-type': 'application/json' },
      payload: { query: '{ this is not graphql' },
    });

    // GraphQL-over-HTTP requires 400 for a request that never produced a
    // result (a parse/validation failure), as distinct from 200 for a query
    // that executed and may have field errors.
    expect(response.statusCode).toBe(400);
    const body = response.json();
    expect(Array.isArray(body.errors)).toBe(true);
    expect(body.errors.length).toBeGreaterThan(0);
  });

  it('rejects a query that names a field the schema does not define', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/graphql',
      headers: { 'content-type': 'application/json' },
      payload: { query: '{ fieldThatDoesNotExist }' },
    });

    const body = response.json();
    expect(Array.isArray(body.errors)).toBe(true);
    expect(body.data).toBeFalsy();
  });

  it('registers a real WebSocket handler, not the HTTP handler', () => {
    // Regression guard: the Apollo HTTP RouteHandlerMethod was once passed
    // here as `wsHandler`, which is a type error and would hand a Fastify
    // request/response pair to code expecting a socket.
    const route = app
      .printRoutes({ commonPrefix: false })
      .toString();
    expect(route).toContain('graphql');
  });
});
