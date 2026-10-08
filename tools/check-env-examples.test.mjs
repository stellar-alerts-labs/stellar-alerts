import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  formatValidationError,
  validateEnvExample,
  validateEnvExamplesAtRoot,
} from './check-env-examples.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('the repository environment examples are valid', async () => {
  const results = await validateEnvExamplesAtRoot(repositoryRoot);

  assert.deepEqual(
    results.map((result) => result.errors),
    [[], []],
  );
});

test('accepts comments, blank lines, and uppercase environment keys', () => {
  const result = validateEnvExample(
    [
      '# Service configuration',
      '',
      'DATABASE_URL=postgresql://localhost/example',
      'JWT_SECRET=',
    ].join('\n'),
    { filePath: 'fixture.env', requiredKeys: ['DATABASE_URL', 'JWT_SECRET'] },
  );

  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.keys, ['DATABASE_URL', 'JWT_SECRET']);
});

test('reports malformed assignments, invalid names, duplicates, and missing keys', () => {
  const result = validateEnvExample(
    [
      'VALID_KEY=one',
      'lowercase_key=two',
      'BROKEN-LINE',
      'VALID_KEY=three',
    ].join('\n'),
    {
      filePath: 'fixture.env',
      allowedKeys: ['VALID_KEY', 'REQUIRED_KEY'],
      requiredKeys: ['VALID_KEY', 'REQUIRED_KEY'],
    },
  );

  assert.deepEqual(result.errors, [
    { code: 'INVALID_KEY', filePath: 'fixture.env', line: 2 },
    { code: 'MALFORMED_ASSIGNMENT', filePath: 'fixture.env', line: 3 },
    { code: 'DUPLICATE_KEY', filePath: 'fixture.env', line: 4, key: 'VALID_KEY' },
    { code: 'MISSING_KEY', filePath: 'fixture.env', key: 'REQUIRED_KEY' },
  ]);
});

test('rejects uppercase typos and stale environment names', () => {
  const result = validateEnvExample(
    [
      'DATABASE_URL=postgresql://localhost/example',
      'DATABSE_URL=postgresql://localhost/typo',
      'DID_CHALLENGE_TTL_SECONDS=300',
    ].join('\n'),
    {
      filePath: 'apps/api/.env.example',
      allowedKeys: ['DATABASE_URL'],
      requiredKeys: ['DATABASE_URL'],
    },
  );

  assert.deepEqual(result.errors, [
    {
      code: 'UNKNOWN_KEY',
      filePath: 'apps/api/.env.example',
      line: 2,
      key: 'DATABSE_URL',
    },
    {
      code: 'UNKNOWN_KEY',
      filePath: 'apps/api/.env.example',
      line: 3,
      key: 'DID_CHALLENGE_TTL_SECONDS',
    },
  ]);
  assert.match(
    formatValidationError(result.errors[0]),
    /unknown environment key DATABSE_URL/,
  );
});

test('formatted errors never expose assignment values', () => {
  const secretValues = [
    'first-sensitive-value',
    'second-sensitive-value',
    'third-sensitive-value',
  ];
  const result = validateEnvExample(
    [
      `VALID_KEY=${secretValues[0]}`,
      `invalid-key=${secretValues[1]}`,
      `VALID_KEY=${secretValues[2]}`,
    ].join('\n'),
    {
      filePath: 'fixture.env',
      allowedKeys: ['VALID_KEY', 'MISSING_KEY'],
      requiredKeys: ['MISSING_KEY'],
    },
  );
  const output = result.errors.map(formatValidationError).join('\n');

  for (const secret of secretValues) {
    assert.equal(output.includes(secret), false);
  }
  assert.match(output, /invalid environment key name/);
  assert.match(output, /duplicate environment key VALID_KEY/);
  assert.match(output, /missing required environment key MISSING_KEY/);
});
