# API Integration Tests

This directory contains comprehensive Supertest integration tests for the Stellar Alerts API, providing focused coverage for authenticated API contracts.

## Overview

The integration tests exercise the actual Fastify application stack including:
- Authentication middleware and JWT token validation
- Route handlers and controllers
- Service layer business logic
- Database interactions via Prisma
- Request validation and error handling
- Authorization and user isolation

## Test Structure

```
src/__tests__/
├── integration/               # Integration test suites
│   ├── auth.integration.test.ts           # Authentication flows
│   ├── wallets.integration.test.ts        # Wallet registration & management
│   ├── notifications.integration.test.ts  # Notification preferences
│   ├── dead-letters.integration.test.ts   # Delivery logs (dead letters)
│   └── validation-and-auth.integration.test.ts # Comprehensive validation & auth
├── utils/                     # Test utilities
│   ├── test-server.ts         # Supertest harness for Fastify app
│   ├── auth-helpers.ts        # Authentication test helpers
│   └── test-db.ts            # Database isolation utilities
├── setup/                     # Test environment setup
│   └── test-env.ts           # Environment validation and setup
└── README.md                 # This file
```

## Test Coverage

### Authentication Integration (`auth.integration.test.ts`)
- ✅ Health endpoints (no auth required)
- ✅ Valid JWT token acceptance
- ✅ Authentication success cases (`/auth/me`, logout)
- ✅ Authentication failure cases (missing, malformed, invalid tokens)
- ✅ Magic link request/validation flow
- ✅ MFA endpoint authentication requirements

### Wallet Registration (`wallets.integration.test.ts`)
- ✅ Successful wallet registration with valid Stellar public keys
- ✅ Wallet listing and user isolation
- ✅ Validation failures (invalid public keys, missing fields)
- ✅ Authorization failures (unauthenticated requests)
- ✅ Duplicate registration prevention
- ✅ Cross-user wallet access restrictions

### Notification Preferences (`notifications.integration.test.ts`)
- ✅ Get/update preferences for authenticated users
- ✅ Email, Telegram, WhatsApp preference management
- ✅ WhatsApp E.164 number validation
- ✅ Test ping functionality
- ✅ User preference isolation
- ✅ Authentication requirements

### Delivery Logs (`dead-letters.integration.test.ts`)
- ✅ Dead letter listing with pagination
- ✅ Individual dead letter access
- ✅ Replay and suppression operations
- ✅ User authorization and data isolation
- ✅ Parameter validation
- ✅ Authentication requirements

### Comprehensive Validation (`validation-and-auth.integration.test.ts`)
- ✅ Authentication validation across all protected endpoints
- ✅ Request validation failure handling
- ✅ Resource ownership and user isolation enforcement
- ✅ Edge cases and concurrent request handling
- ✅ Malformed JSON and header handling

## Test Utilities

### TestServer (`test-server.ts`)
Reusable Supertest harness that:
- Creates Fastify application instance for testing
- Provides `supertest` wrapper without starting HTTP server
- Handles setup and teardown lifecycle
- Supports global test server instance reuse

```typescript
const testServer = await getTestServer();
const response = await testServer.server.get('/health').expect(200);
```

### Authentication Helpers (`auth-helpers.ts`)
Utilities for creating test users and making authenticated requests:
- `createTestUser()` - Creates user with valid JWT token
- `createTestUserWithWallet()` - Creates user + wallet for testing
- `createTestUsers(count)` - Creates multiple users for isolation tests
- `makeAuthenticatedRequest()` - Helper for authenticated HTTP requests
- `makeUnauthenticatedRequest()` - Helper for testing auth failures

```typescript
const user = await createTestUser();
const authRequest = makeAuthenticatedRequest(testServer, user);
const response = await authRequest.get('/wallets').expect(200);
```

### Database Isolation (`test-db.ts`)
Ensures test isolation and cleanup:
- `TestDatabase.cleanup()` - Removes all test data
- `setupTestIsolation()` - Prepares clean test state
- `cleanupTestIsolation()` - Cleans up after tests
- Handles foreign key constraints correctly

## Running Tests

### Prerequisites
1. **PostgreSQL database** running and accessible
2. **Redis server** running (for session management)
3. **Environment variables** configured

### Environment Variables
```bash
DATABASE_URL="postgresql://user:password@localhost:5432/stellar_alerts?schema=public"
REDIS_URL="redis://localhost:6379"
JWT_SECRET="test-jwt-secret-key-min-32-chars!!"
MASTER_ENCRYPTION_KEY="0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
TELEGRAM_BOT_TOKEN="test-telegram-token"
NODE_ENV="test"
```

### Local Development
```bash
# Ensure database schema is up to date
npm run db:push

# Run all integration tests
npm run test:integration

# Run specific test file
npx vitest run src/__tests__/integration/auth.integration.test.ts

# Run unit tests only
npm run test:unit

# Run all tests
npm test
```

### CI/CD
The tests are configured to run in GitHub Actions with:
- PostgreSQL 16 service container
- Redis 7 service container
- Automatic database schema setup
- Proper environment variable configuration

## Test Design Principles

### 1. Real Application Stack
Tests exercise the actual Fastify application, middleware, and routes rather than mocking the entire API layer.

### 2. Database Integration
Uses real PostgreSQL database with proper test data isolation rather than mocking Prisma.

### 3. Deterministic and Isolated
Each test starts from a clean state and cleans up after itself. Tests don't depend on execution order.

### 4. Focused on API Contracts
Tests verify HTTP request/response contracts, status codes, and error formats without testing internal implementation details.

### 5. Authentication Coverage
Comprehensive coverage of JWT-based authentication including success paths, various failure modes, and authorization isolation.

### 6. Validation Testing
Tests actual Zod schema validation and Stellar public key format validation as implemented in the API.

## Common Test Patterns

### Testing Authentication Success
```typescript
const testUser = await createTestUser();
const authRequest = makeAuthenticatedRequest(testServer, testUser);
const response = await authRequest.get('/protected-endpoint').expect(200);
```

### Testing Authentication Failures
```typescript
const unauthRequest = makeUnauthenticatedRequest(testServer);
const response = await unauthRequest.get('/protected-endpoint').expect(401);
expect(response.body).toEqual({
  error: 'Unauthorized',
  message: 'You must be logged in to perform this action.',
  code: 'AUTH_REQUIRED',
});
```

### Testing User Isolation
```typescript
const [user1, user2] = await createTestUsers(2);
// Create resource for user1
// Verify user2 cannot access user1's resource
```

### Testing Validation Failures
```typescript
const response = await authRequest
  .post('/endpoint')
  .send({ invalid: 'data' })
  .expect(400);
expect(response.body).toHaveProperty('error');
```

## Maintenance Notes

### Adding New Tests
1. Create test file in `src/__tests__/integration/`
2. Use existing test utilities for consistency
3. Follow test isolation patterns with `beforeEach`/`afterEach`
4. Test both success and failure paths
5. Include user authorization/isolation tests

### Database Schema Changes
When Prisma schema changes:
1. Update `TestDatabase.cleanup()` if new relations are added
2. Ensure cleanup handles foreign key constraints properly
3. Test isolation may need updates for new user-owned resources

### Authentication Changes
If authentication mechanism changes:
1. Update `auth-helpers.ts` token generation
2. Update authentication failure test expectations
3. Verify all existing auth tests still pass

## Troubleshooting

### Database Connection Errors
- Ensure PostgreSQL is running and accessible
- Verify `DATABASE_URL` environment variable
- Check database permissions and schema exists

### Redis Connection Errors
- Ensure Redis server is running
- Verify `REDIS_URL` environment variable
- Check if Redis authentication is required

### Test Timeouts
- Increase test timeout in vitest config if needed
- Check for database connection pools not being closed
- Verify test cleanup is properly implemented

### Test Flakiness
- Ensure proper test isolation with database cleanup
- Check for race conditions in concurrent tests
- Verify deterministic test data generation