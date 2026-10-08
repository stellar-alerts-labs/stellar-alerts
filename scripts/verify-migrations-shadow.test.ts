import { describe, it, expect } from 'vitest';
import { withDatabase, placeholderValueFor, requireBaseUrl } from './verify-migrations-shadow';
import { findAddedNotNullColumns } from './verify-migrations';

describe('verify-migrations-shadow: pure helpers', () => {
  describe('withDatabase', () => {
    it('swaps only the database name, keeping host/port/credentials', () => {
      const result = withDatabase('postgresql://user:pass@localhost:5432/stellar_alerts', 'shadow_verify_123');
      expect(result).toBe('postgresql://user:pass@localhost:5432/shadow_verify_123');
    });

    it('preserves query parameters (e.g. schema, connection_limit)', () => {
      const result = withDatabase(
        'postgresql://user:pass@localhost:5432/stellar_alerts?schema=public&connection_limit=20',
        'shadow_verify_456',
      );
      expect(result).toContain('/shadow_verify_456');
      expect(result).toContain('schema=public');
      expect(result).toContain('connection_limit=20');
    });
  });

  describe('placeholderValueFor', () => {
    it('returns type-appropriate placeholders that Postgres will accept for common column types', () => {
      expect(placeholderValueFor('integer')).toBe(0);
      expect(placeholderValueFor('boolean')).toBe(false);
      expect(placeholderValueFor('jsonb')).toEqual({});
      expect(placeholderValueFor('ARRAY')).toEqual([]);
      expect(placeholderValueFor('timestamp with time zone')).toBeInstanceOf(Date);
      expect(typeof placeholderValueFor('text')).toBe('string');
    });

    it('produces a distinct value each call for text columns, to avoid accidental unique-constraint collisions across seeded rows', () => {
      const a = placeholderValueFor('text');
      const b = placeholderValueFor('text');
      expect(a).not.toBe(b);
    });
  });

  describe('requireBaseUrl', () => {
    it('throws a clear error when neither SHADOW_DATABASE_URL nor DATABASE_URL is set', () => {
      const prevShadow = process.env.SHADOW_DATABASE_URL;
      const prevDb = process.env.DATABASE_URL;
      delete process.env.SHADOW_DATABASE_URL;
      delete process.env.DATABASE_URL;

      try {
        expect(() => requireBaseUrl()).toThrow(/SHADOW_DATABASE_URL/);
      } finally {
        if (prevShadow !== undefined) process.env.SHADOW_DATABASE_URL = prevShadow;
        if (prevDb !== undefined) process.env.DATABASE_URL = prevDb;
      }
    });

    it('prefers SHADOW_DATABASE_URL over DATABASE_URL when both are set', () => {
      const prevShadow = process.env.SHADOW_DATABASE_URL;
      const prevDb = process.env.DATABASE_URL;
      process.env.SHADOW_DATABASE_URL = 'postgresql://shadow-host/db';
      process.env.DATABASE_URL = 'postgresql://app-host/db';

      try {
        expect(requireBaseUrl()).toBe('postgresql://shadow-host/db');
      } finally {
        if (prevShadow !== undefined) process.env.SHADOW_DATABASE_URL = prevShadow;
        else delete process.env.SHADOW_DATABASE_URL;
        if (prevDb !== undefined) process.env.DATABASE_URL = prevDb;
        else delete process.env.DATABASE_URL;
      }
    });
  });

  describe('findAddedNotNullColumns (re-exported from verify-migrations.ts)', () => {
    it('extracts every table/column pair a migration adds a NOT NULL constraint to', () => {
      const sql = `
        ALTER TABLE "Wallet" ALTER COLUMN "label" SET NOT NULL;
        CREATE TABLE "Foo" ("id" TEXT NOT NULL);
        ALTER TABLE "Payment" ALTER COLUMN "memo" SET NOT NULL;
      `;

      expect(findAddedNotNullColumns(sql)).toEqual([
        { table: 'Wallet', column: 'label' },
        { table: 'Payment', column: 'memo' },
      ]);
    });

    it('returns an empty array for a migration with no SET NOT NULL statements', () => {
      const sql = `CREATE TABLE "Foo" ("id" TEXT NOT NULL PRIMARY KEY);`;
      expect(findAddedNotNullColumns(sql)).toEqual([]);
    });
  });
});
