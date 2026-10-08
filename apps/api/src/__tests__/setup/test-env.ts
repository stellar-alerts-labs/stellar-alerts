/**
 * Test Environment Setup
 * 
 * Ensures tests run with proper environment configuration and database isolation.
 * This file is imported by test files to set up the test environment before running tests.
 */

import { prisma } from '../../lib/prisma';

// Ensure we're running in test environment
if (process.env.NODE_ENV !== 'test' && process.env.VITEST !== 'true') {
  console.warn('⚠️ Tests should run with NODE_ENV=test or VITEST=true');
}

// Validate required environment variables for tests
const requiredEnvVars = {
  DATABASE_URL: process.env.DATABASE_URL,
  JWT_SECRET: process.env.JWT_SECRET,
  REDIS_URL: process.env.REDIS_URL,
};

for (const [key, value] of Object.entries(requiredEnvVars)) {
  if (!value) {
    throw new Error(`Missing required environment variable for tests: ${key}`);
  }
}

// Ensure we're using a test database (safety check)
const dbUrl = process.env.DATABASE_URL || '';
if (!dbUrl.includes('test') && !dbUrl.includes('stellar_alerts') && process.env.NODE_ENV === 'production') {
  throw new Error('Refusing to run tests against production database. Use a test database URL.');
}

/**
 * Global test setup - runs once before all tests
 */
export async function setup() {
  try {
    // Verify database connection
    await prisma.$connect();
    console.log('✅ Test database connection established');

    // Ensure test database schema is up to date
    // Note: In CI, this is handled by "npm run db:push" step
    // Locally, developers should run db:push before running integration tests
    
  } catch (error) {
    console.error('❌ Test setup failed:', error);
    throw error;
  }
}

/**
 * Global test teardown - runs once after all tests
 */
export async function teardown() {
  try {
    await prisma.$disconnect();
    console.log('✅ Test database connection closed');
  } catch (error) {
    console.error('❌ Test teardown failed:', error);
    // Don't throw here to avoid masking test failures
  }
}

/**
 * Verify test environment is properly configured
 */
export function verifyTestEnvironment() {
  const checks = [
    {
      name: 'Database URL configured',
      passed: !!process.env.DATABASE_URL,
    },
    {
      name: 'JWT Secret configured',
      passed: !!process.env.JWT_SECRET && process.env.JWT_SECRET.length >= 16,
    },
    {
      name: 'Redis URL configured',
      passed: !!process.env.REDIS_URL,
    },
    {
      name: 'Test environment detected',
      passed: process.env.NODE_ENV === 'test' || process.env.VITEST === 'true',
    },
  ];

  const failures = checks.filter(check => !check.passed);
  
  if (failures.length > 0) {
    console.error('❌ Test environment check failures:');
    failures.forEach(failure => {
      console.error(`  - ${failure.name}`);
    });
    throw new Error('Test environment is not properly configured');
  }

  console.log('✅ Test environment verified');
}

// Verify environment on import
verifyTestEnvironment();