import { describe, expect, it, vi } from 'vitest';
import {
  createHttpTomlFetcher,
  isSafeHomeDomain,
  parseStellarToml,
  Sep1TomlCrawler,
  SEP1_CACHE_TTL_MS,
  SEP1_FAILURE_TTL_MS,
  TomlParseError,
} from '../sep1-crawler.service';

const ISSUER = 'GISSUERACCOUNT000000000000000000000000000000000000000000';
const SPOOFER = 'GSPOOFERACCOUNT00000000000000000000000000000000000000000';

const VALID_TOML = `
# Example anchor
VERSION="2.0.0"
SIGNING_KEY="GSIGNINGKEY"
ACCOUNTS=[
  "${ISSUER}",  # issuing account
  "GOTHER",
]

[DOCUMENTATION]
ORG_NAME="Example Anchor Inc."
ORG_URL="https://anchor.example"

[[CURRENCIES]]
code="USDC"
issuer="${ISSUER}"
name="USD Coin"
image="https://anchor.example/usdc.png"
is_asset_anchored=true
display_decimals=2

[[CURRENCIES]]
code="EURC"
issuer="GEURCISSUER"
name='Euro Coin'
`;

describe('parseStellarToml', () => {
  it('parses scalars, arrays and comments', () => {
    const toml = parseStellarToml(VALID_TOML);

    expect(toml.VERSION).toBe('2.0.0');
    expect(toml.ACCOUNTS).toEqual([ISSUER, 'GOTHER']);
  });

  it('parses tables and arrays of tables', () => {
    const toml = parseStellarToml(VALID_TOML);

    expect(toml.DOCUMENTATION).toEqual({ ORG_NAME: 'Example Anchor Inc.', ORG_URL: 'https://anchor.example' });
    expect(toml.CURRENCIES).toEqual([
      {
        code: 'USDC',
        issuer: ISSUER,
        name: 'USD Coin',
        image: 'https://anchor.example/usdc.png',
        is_asset_anchored: true,
        display_decimals: 2,
      },
      { code: 'EURC', issuer: 'GEURCISSUER', name: 'Euro Coin' },
    ]);
  });

  it('handles basic string escapes, literal strings and multi-line strings', () => {
    const toml = parseStellarToml(
      ['a="tab\\there \\"quoted\\" \\u00e9"', "b='C:\\raw\\path'", 'c="""', 'line one', 'line two"""', 'd=-5', 'e=1_000', 'f=2.5'].join('\n'),
    );

    expect(toml).toEqual({ a: 'tab\there "quoted" é', b: 'C:\\raw\\path', c: 'line one\nline two', d: -5, e: 1000, f: 2.5 });
  });

  it('does not treat # inside a string as a comment', () => {
    expect(parseStellarToml('a="x # y" # real comment')).toEqual({ a: 'x # y' });
  });

  it('handles Windows line endings', () => {
    expect(parseStellarToml('a="1"\r\nb="2"\r\n')).toEqual({ a: '1', b: '2' });
  });

  it('parses an empty document', () => {
    expect(parseStellarToml('')).toEqual({});
    expect(parseStellarToml('# only a comment\n\n')).toEqual({});
  });

  it('parses an array of strings split over lines', () => {
    expect(parseStellarToml('list = [\n "a",\n "b"\n]\nafter="x"')).toEqual({ list: ['a', 'b'], after: 'x' });
  });

  it.each([
    ['a duplicate key', 'a="1"\na="2"'],
    ['an unterminated string', 'a="oops'],
    ['an unterminated array', 'a=["x"'],
    ['a missing value', 'a='],
    ['text after a value', 'a="x" junk'],
    ['a line that is not a key', 'this is not toml'],
    ['an unknown escape', 'a="\\q"'],
    ['a bad unicode escape', 'a="\\u12"'],
    ['an unsupported value', 'a=2026-01-01T00:00:00Z'],
    ['a redefined table', '[T]\na="1"\n[T]\nb="2"'],
    ['a table that clashes with an array of tables', '[[T]]\na="1"\n[T]'],
  ])('rejects %s', (_label, source) => {
    expect(() => parseStellarToml(source)).toThrow(TomlParseError);
  });

  it('reports the line of the error', () => {
    expect(() => parseStellarToml('a="1"\nb="2"\nbroken')).toThrow(/line 3/);
  });
});

describe('isSafeHomeDomain', () => {
  it.each(['anchor.example', 'api.anchor.example.com', 'a-b.co', 'xn--bcher-kva.example'])('accepts %s', (domain) => {
    expect(isSafeHomeDomain(domain)).toBe(true);
  });

  it.each([
    ['an IPv4 address', '192.168.1.10'],
    ['an IPv6 literal', '[::1]'],
    ['localhost', 'localhost'],
    ['a single label', 'intranet'],
    ['a local name', 'printer.local'],
    ['an internal name', 'db.internal'],
    ['a port', 'anchor.example:8443'],
    ['a path', 'anchor.example/path'],
    ['credentials', 'user@anchor.example'],
    ['uppercase', 'Anchor.Example'],
    ['an empty string', ''],
    ['a leading hyphen', '-bad.example'],
    ['a trailing dot', 'anchor.example.'],
    ['a space', 'anchor .example'],
    ['a number', 42],
    ['null', null],
  ])('rejects %s', (_label, domain) => {
    expect(isSafeHomeDomain(domain)).toBe(false);
  });
});

function crawler(overrides: { homeDomain?: string | null; toml?: string | Error; now?: () => number } = {}) {
  const getHomeDomain = vi.fn().mockResolvedValue('homeDomain' in overrides ? overrides.homeDomain : 'anchor.example');
  const fetchToml = vi.fn().mockImplementation(async () => {
    const toml = overrides.toml ?? VALID_TOML;
    if (toml instanceof Error) throw toml;
    return toml;
  });
  const instance = new Sep1TomlCrawler({ getHomeDomain, fetchToml, now: overrides.now });
  return { crawler: instance, getHomeDomain, fetchToml };
}

describe('Sep1TomlCrawler.verifyAsset', () => {
  it('verifies an asset the issuer\'s domain lists, and returns the organization, name and icon', async () => {
    const { crawler: c, fetchToml } = crawler();

    const result = await c.verifyAsset('USDC', ISSUER);

    expect(result).toMatchObject({
      verified: true,
      spoofWarning: false,
      reason: 'VERIFIED',
      homeDomain: 'anchor.example',
      organizationName: 'Example Anchor Inc.',
      assetName: 'USD Coin',
      iconUrl: 'https://anchor.example/usdc.png',
    });
    expect(fetchToml).toHaveBeenCalledWith('anchor.example');
  });

  it('falls back to the asset code for the display name when the toml gives none', async () => {
    const toml = `[[CURRENCIES]]\ncode="USDC"\nissuer="${ISSUER}"\n`;
    const result = await crawler({ toml }).crawler.verifyAsset('USDC', ISSUER);
    expect(result).toMatchObject({ verified: true, assetName: 'USDC', iconUrl: null, organizationName: null });
  });

  it('drops an icon that is not served over https', async () => {
    const toml = `[[CURRENCIES]]\ncode="USDC"\nissuer="${ISSUER}"\nimage="http://anchor.example/usdc.png"\n`;
    expect((await crawler({ toml }).crawler.verifyAsset('USDC', ISSUER)).iconUrl).toBeNull();
  });

  it('flags a spoofed asset: the toml of a domain claims an issuer whose own home_domain is elsewhere', async () => {
    // The spoofer publishes a toml listing a real asset, but the issuer account it points at does
    // not name the spoofer's domain on-chain, so the on-chain link (step 1) fails.
    const { crawler: c, fetchToml } = crawler({ homeDomain: null });

    const result = await c.verifyAsset('USDC', ISSUER);

    expect(result).toMatchObject({ verified: false, spoofWarning: true, reason: 'NO_HOME_DOMAIN' });
    expect(fetchToml).not.toHaveBeenCalled();
  });

  it('flags a toml that does not list the asset', async () => {
    const result = await crawler().crawler.verifyAsset('XYZ', ISSUER);
    expect(result).toMatchObject({ verified: false, spoofWarning: true, reason: 'NOT_LISTED' });
  });

  it('flags the same ticker issued by a different account, the classic spoof', async () => {
    const result = await crawler().crawler.verifyAsset('USDC', SPOOFER);
    expect(result).toMatchObject({ verified: false, spoofWarning: true, reason: 'LISTED_FOR_OTHER_ISSUER' });
    expect(result.organizationName).toBeNull();
    expect(result.iconUrl).toBeNull();
  });

  it('does not hand out organization details for an unverified asset', async () => {
    const result = await crawler().crawler.verifyAsset('USDC', SPOOFER);
    expect([result.organizationName, result.assetName, result.iconUrl]).toEqual([null, null, null]);
  });

  it('flags an unsafe home domain without making a request', async () => {
    const { crawler: c, fetchToml } = crawler({ homeDomain: '169.254.169.254' });

    const result = await c.verifyAsset('USDC', ISSUER);

    expect(result).toMatchObject({ verified: false, reason: 'UNSAFE_HOME_DOMAIN' });
    expect(fetchToml).not.toHaveBeenCalled();
  });

  it('flags a toml that cannot be fetched, and one that is malformed', async () => {
    expect((await crawler({ toml: new Error('ECONNREFUSED') }).crawler.verifyAsset('USDC', ISSUER)).reason).toBe('TOML_UNAVAILABLE');
    expect((await crawler({ toml: 'not = valid = toml' }).crawler.verifyAsset('USDC', ISSUER)).reason).toBe('TOML_INVALID');
  });

  it('treats a failed on-chain lookup as unverified instead of throwing', async () => {
    const c = new Sep1TomlCrawler({
      getHomeDomain: async () => {
        throw new Error('horizon down');
      },
      fetchToml: async () => VALID_TOML,
    });
    expect((await c.verifyAsset('USDC', ISSUER)).reason).toBe('NO_HOME_DOMAIN');
  });
});

describe('Sep1TomlCrawler caching', () => {
  it('caches a verified result for 24 hours and no longer', async () => {
    let now = 0;
    const { crawler: c, fetchToml } = crawler({ now: () => now });

    await c.verifyAsset('USDC', ISSUER);
    now = SEP1_CACHE_TTL_MS - 1;
    await c.verifyAsset('USDC', ISSUER);
    expect(fetchToml).toHaveBeenCalledTimes(1);

    now = SEP1_CACHE_TTL_MS;
    await c.verifyAsset('USDC', ISSUER);
    expect(fetchToml).toHaveBeenCalledTimes(2);
  });

  it('caches a failure only briefly, so a recovered domain is picked up', async () => {
    let now = 0;
    const { crawler: c, fetchToml } = crawler({ now: () => now, toml: new Error('down') });

    await c.verifyAsset('USDC', ISSUER);
    now = SEP1_FAILURE_TTL_MS - 1;
    await c.verifyAsset('USDC', ISSUER);
    expect(fetchToml).toHaveBeenCalledTimes(1);

    now = SEP1_FAILURE_TTL_MS;
    await c.verifyAsset('USDC', ISSUER);
    expect(fetchToml).toHaveBeenCalledTimes(2);
  });

  it('keeps results for different assets and issuers apart', async () => {
    const { crawler: c } = crawler();
    expect((await c.verifyAsset('USDC', ISSUER)).verified).toBe(true);
    expect((await c.verifyAsset('USDC', SPOOFER)).verified).toBe(false);
    expect((await c.verifyAsset('USDC', ISSUER)).verified).toBe(true);
  });

  it('shares one lookup between concurrent requests for the same asset', async () => {
    const { crawler: c, getHomeDomain } = crawler();

    const results = await Promise.all([c.verifyAsset('USDC', ISSUER), c.verifyAsset('USDC', ISSUER), c.verifyAsset('USDC', ISSUER)]);

    expect(getHomeDomain).toHaveBeenCalledTimes(1);
    expect(new Set(results.map((r) => r.verifiedAt)).size).toBe(1);
  });
});

describe('createHttpTomlFetcher', () => {
  function response(body: string, init: { status?: number; headers?: Record<string, string> } = {}) {
    return new Response(body, { status: init.status ?? 200, headers: init.headers });
  }

  it('requests the well-known path over https and refuses redirects', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response('a="1"'));

    const body = await createHttpTomlFetcher({ fetchImpl })('anchor.example');

    expect(body).toBe('a="1"');
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://anchor.example/.well-known/stellar.toml');
    expect(init.redirect).toBe('error');
  });

  it('refuses an unsafe domain without a request', async () => {
    const fetchImpl = vi.fn();
    await expect(createHttpTomlFetcher({ fetchImpl })('localhost')).rejects.toThrow(/Unsafe/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects a non-200 answer', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response('nope', { status: 404 }));
    await expect(createHttpTomlFetcher({ fetchImpl })('anchor.example')).rejects.toThrow(/404/);
  });

  it('rejects a file over the size cap, by declared length and by actual length', async () => {
    const declared = vi.fn().mockResolvedValue(response('x', { headers: { 'content-length': '999999' } }));
    await expect(createHttpTomlFetcher({ fetchImpl: declared, maxBytes: 1024 })('anchor.example')).rejects.toThrow(/too large/);

    const actual = vi.fn().mockResolvedValue(response('x'.repeat(2048)));
    await expect(createHttpTomlFetcher({ fetchImpl: actual, maxBytes: 1024 })('anchor.example')).rejects.toThrow(/too large/);
  });

  it('aborts a request that takes longer than the timeout', async () => {
    const fetchImpl = vi.fn().mockImplementation(
      (_url: string, init: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );

    await expect(createHttpTomlFetcher({ fetchImpl, timeoutMs: 10 })('anchor.example')).rejects.toThrow('aborted');
  });
});
