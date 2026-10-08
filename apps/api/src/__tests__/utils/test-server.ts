import { FastifyInstance } from 'fastify';
import { buildApp } from '../../app';
import supertest from 'supertest';

/**
 * Reusable Supertest harness for authenticated API integration tests.
 * 
 * This harness creates a Fastify application instance for testing without starting
 * a real HTTP server. It provides access to the actual application middleware,
 * routes, and controllers for comprehensive integration testing.
 */
export class TestServer {
  private app: FastifyInstance | null = null;
  private _server: supertest.SuperTest<supertest.Test> | null = null;

  /**
   * Initialize the Fastify app for testing
   */
  async setup(): Promise<void> {
    if (this.app) return;
    
    this.app = await buildApp();
    await this.app.ready();
    this._server = supertest(this.app.server);
  }

  /**
   * Clean up resources
   */
  async teardown(): Promise<void> {
    if (this.app) {
      await this.app.close();
      this.app = null;
      this._server = null;
    }
  }

  /**
   * Get the supertest instance for making HTTP requests
   */
  get server(): supertest.SuperTest<supertest.Test> {
    if (!this._server) {
      throw new Error('TestServer not initialized. Call setup() first.');
    }
    return this._server;
  }

  /**
   * Get the Fastify app instance
   */
  get fastify(): FastifyInstance {
    if (!this.app) {
      throw new Error('TestServer not initialized. Call setup() first.');
    }
    return this.app;
  }
}

/**
 * Global test server instance that can be reused across test suites
 */
let globalTestServer: TestServer | null = null;

/**
 * Get or create the global test server instance
 */
export async function getTestServer(): Promise<TestServer> {
  if (!globalTestServer) {
    globalTestServer = new TestServer();
    await globalTestServer.setup();
  }
  return globalTestServer;
}

/**
 * Clean up the global test server instance
 */
export async function cleanupTestServer(): Promise<void> {
  if (globalTestServer) {
    await globalTestServer.teardown();
    globalTestServer = null;
  }
}