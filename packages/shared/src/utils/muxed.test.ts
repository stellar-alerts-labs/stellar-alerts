import { describe, expect, it } from 'vitest';
import { Keypair } from 'stellar-sdk';
import { MAX_MUXED_ID, MuxedAccountResolver } from './muxed';
import { parseMuxedAddress } from '../strkey';

/** SEP-23 example: account GA7QYNF7...SGZ with id 9223372036854775808. */
const BASE = 'GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ';
const MUXED_SEP23 = 'MA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVAAAAAAAAAAAAAJLK';
const OTHER = Keypair.random().publicKey();
const CONTRACT = 'CA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJUWDA';

const resolver = new MuxedAccountResolver();

describe('MuxedAccountResolver.resolve', () => {
  it('decodes an M address into the base account and the 64-bit id', () => {
    expect(resolver.resolve(MUXED_SEP23)).toEqual({
      baseAccountId: BASE,
      muxedId: '9223372036854775808',
    });
  });

  it('resolves a plain G address with a null id', () => {
    expect(resolver.resolve(BASE)).toEqual({ baseAccountId: BASE, muxedId: null });
  });

  it.each([
    ['a contract id', CONTRACT],
    ['an empty string', ''],
    ['garbage', 'not-an-address'],
    ['a G address with a bad checksum', BASE.slice(0, -1) + (BASE.endsWith('A') ? 'B' : 'A')],
    ['a number', 42],
    ['null', null],
    ['undefined', undefined],
  ])('returns null for %s', (_label, value) => {
    expect(resolver.resolve(value)).toBeNull();
  });

  it('returns null for an M address with a corrupted checksum', () => {
    const corrupted = MUXED_SEP23.slice(0, -1) + (MUXED_SEP23.endsWith('A') ? 'B' : 'A');
    expect(resolver.resolve(corrupted)).toBeNull();
  });
});

describe('MuxedAccountResolver.encode', () => {
  it('reproduces the SEP-23 example', () => {
    expect(resolver.encode(BASE, '9223372036854775808')).toBe(MUXED_SEP23);
  });

  it.each(['0', '1', '42', '9223372036854775807', '9223372036854775808', MAX_MUXED_ID.toString()])(
    'round-trips id %s through the independent StrKey parser',
    (id) => {
      const encoded = resolver.encode(OTHER, id);

      expect(encoded).toHaveLength(69);
      expect(encoded.startsWith('M')).toBe(true);
      expect(parseMuxedAddress(encoded)).toEqual({ accountId: OTHER, id });
      expect(resolver.resolve(encoded)).toEqual({ baseAccountId: OTHER, muxedId: id });
    },
  );

  it.each([
    ['one past the 64-bit maximum', (MAX_MUXED_ID + 1n).toString()],
    ['a negative id', '-1'],
    ['a decimal', '1.5'],
    ['a leading zero', '007'],
    ['hex', '0x10'],
    ['an empty string', ''],
    ['a huge number', '9'.repeat(40)],
  ])('rejects %s', (_label, id) => {
    expect(() => resolver.encode(BASE, id)).toThrow(/unsigned 64-bit/);
  });

  it('rejects a base account that is not a G address', () => {
    expect(() => resolver.encode(MUXED_SEP23, '1')).toThrow(/Ed25519/);
    expect(() => resolver.encode(CONTRACT, '1')).toThrow(/Ed25519/);
    expect(() => resolver.encode('nope', '1')).toThrow(/Ed25519/);
  });
});

describe('MuxedAccountResolver.matches', () => {
  const customer1 = resolver.encode(BASE, '1');
  const customer2 = resolver.encode(BASE, '2');

  it('a watcher on the G address receives a payment to the bare G address', () => {
    expect(resolver.matches(BASE, BASE)).toBe(true);
  });

  it('a watcher on the G address receives a payment to any M address of it', () => {
    expect(resolver.matches(customer1, BASE)).toBe(true);
    expect(resolver.matches(customer2, BASE)).toBe(true);
    expect(resolver.matches(MUXED_SEP23, BASE)).toBe(true);
  });

  it('a watcher on one M address receives only that exact virtual address', () => {
    expect(resolver.matches(customer1, customer1)).toBe(true);
    expect(resolver.matches(customer2, customer1)).toBe(false);
  });

  it('a watcher on an M address does not receive a payment to the bare G address', () => {
    expect(resolver.matches(BASE, customer1)).toBe(false);
  });

  it('id 0 is a real virtual account and is distinct from the bare G address', () => {
    const zero = resolver.encode(BASE, '0');
    expect(resolver.matches(zero, zero)).toBe(true);
    expect(resolver.matches(BASE, zero)).toBe(false);
    expect(resolver.matches(customer1, zero)).toBe(false);
  });

  it('never matches a different base account', () => {
    expect(resolver.matches(OTHER, BASE)).toBe(false);
    expect(resolver.matches(resolver.encode(OTHER, '1'), BASE)).toBe(false);
    expect(resolver.matches(resolver.encode(OTHER, '1'), customer1)).toBe(false);
  });

  it('never matches when either side is invalid', () => {
    expect(resolver.matches('garbage', BASE)).toBe(false);
    expect(resolver.matches(BASE, 'garbage')).toBe(false);
    expect(resolver.matches(CONTRACT, CONTRACT)).toBe(false);
    expect(resolver.matches(undefined, BASE)).toBe(false);
  });
});

describe('MuxedAccountResolver.matchWatchers', () => {
  const customer1 = resolver.encode(BASE, '1');
  const customer2 = resolver.encode(BASE, '2');
  const watchers = [
    { id: 'base', address: BASE },
    { id: 'c1', address: customer1 },
    { id: 'c2', address: customer2 },
    { id: 'other', address: OTHER },
    { id: 'broken', address: 'garbage' },
  ];

  it('delivers a payment to customer 1 to the base watcher and the customer 1 watcher only', () => {
    expect(resolver.matchWatchers(customer1, watchers).map((w) => w.id)).toEqual(['base', 'c1']);
  });

  it('delivers a payment to the bare G address to the base watcher only', () => {
    expect(resolver.matchWatchers(BASE, watchers).map((w) => w.id)).toEqual(['base']);
  });

  it('delivers to nobody for an account nobody watches', () => {
    expect(resolver.matchWatchers(Keypair.random().publicKey(), watchers)).toEqual([]);
  });

  it('delivers to nobody for an invalid destination, instead of throwing', () => {
    expect(resolver.matchWatchers('garbage', watchers)).toEqual([]);
  });

  it('returns the watchers themselves, unchanged and in order', () => {
    const result = resolver.matchWatchers(customer2, watchers);
    expect(result[0]).toBe(watchers[0]);
    expect(result[1]).toBe(watchers[2]);
  });
});

describe('MuxedAccountResolver payload fields', () => {
  it('includes muxedAccount and muxedId for a payment to an M address', () => {
    expect(resolver.payloadFields(MUXED_SEP23)).toEqual({
      muxedAccount: MUXED_SEP23,
      muxedId: '9223372036854775808',
    });
  });

  it('keeps the id as a string so a 64-bit value is not rounded by JSON.parse', () => {
    const fields = resolver.payloadFields(resolver.encode(BASE, MAX_MUXED_ID.toString()));
    expect(fields.muxedId).toBe('18446744073709551615');
    expect(typeof fields.muxedId).toBe('string');
  });

  it('sets both fields to null for a plain account and for anything invalid', () => {
    const none = { muxedAccount: null, muxedId: null };
    expect(resolver.payloadFields(BASE)).toEqual(none);
    expect(resolver.payloadFields('garbage')).toEqual(none);
    expect(resolver.payloadFields(undefined)).toEqual(none);
  });

  it('annotate keeps the payload and does not mutate it', () => {
    const payload = { type: 'payment', amount: '10.0000000' };

    const annotated = resolver.annotate(payload, MUXED_SEP23);

    expect(annotated).toEqual({
      type: 'payment',
      amount: '10.0000000',
      muxedAccount: MUXED_SEP23,
      muxedId: '9223372036854775808',
    });
    expect(payload).toEqual({ type: 'payment', amount: '10.0000000' });
  });
});
