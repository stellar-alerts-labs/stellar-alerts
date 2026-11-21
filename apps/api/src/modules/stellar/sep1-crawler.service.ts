/**
 * SEP-0001 `stellar.toml` verification (#981).
 *
 * An asset is verified only when the link holds in **both** directions:
 *   1. the issuer account's on-chain `home_domain` names the domain, and
 *   2. that domain's `/.well-known/stellar.toml` lists the same code and issuer in `[[CURRENCIES]]`.
 *
 * Anyone can publish a toml that claims an issuer, so step 1 is what stops a spoofer from
 * borrowing someone else's name. Unverified assets get a spoof warning. Results are cached for 24
 * hours (failures for a short time, so a broken domain is not hammered).
 *
 * The on-chain lookup, the HTTP fetch and the clock are injected, so this needs no network. The
 * domain checks reject obviously unsafe hosts before any request is made; they are not a
 * substitute for network-level egress controls on the resolved address.
 */

// ── TOML subset ──────────────────────────────────────────────────────────────────────────────

export type TomlValue = string | number | boolean | TomlValue[] | TomlTable;
export interface TomlTable {
  [key: string]: TomlValue;
}

export class TomlParseError extends Error {
  constructor(
    message: string,
    readonly line: number,
  ) {
    super(`stellar.toml line ${line}: ${message}`);
    this.name = 'TomlParseError';
  }
}

function unescapeBasic(body: string, line: number): string {
  let out = '';
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (ch !== '\\') {
      out += ch;
      continue;
    }
    const next = body[i + 1];
    i += 1;
    switch (next) {
      case 'n': out += '\n'; break;
      case 't': out += '\t'; break;
      case 'r': out += '\r'; break;
      case 'b': out += '\b'; break;
      case 'f': out += '\f'; break;
      case '"': out += '"'; break;
      case '\\': out += '\\'; break;
      case 'u':
      case 'U': {
        const size = next === 'u' ? 4 : 8;
        const hex = body.slice(i + 1, i + 1 + size);
        if (!new RegExp(`^[0-9a-fA-F]{${size}}$`).test(hex)) throw new TomlParseError('bad unicode escape', line);
        out += String.fromCodePoint(parseInt(hex, 16));
        i += size;
        break;
      }
      default:
        throw new TomlParseError(`unknown escape \\${next ?? ''}`, line);
    }
  }
  return out;
}

/** Parses one value starting at `text[index]`; returns the value and the index after it. */
function parseValue(text: string, start: number, line: number): { value: TomlValue; end: number } {
  let i = start;
  while (text[i] === ' ' || text[i] === '\t') i += 1;
  const ch = text[i];

  if (text.startsWith('"""', i) || text.startsWith("'''", i)) {
    const quote = text.slice(i, i + 3);
    const close = text.indexOf(quote, i + 3);
    if (close === -1) throw new TomlParseError('unterminated multi-line string', line);
    let body = text.slice(i + 3, close);
    if (body.startsWith('\n')) body = body.slice(1);
    return { value: quote === '"""' ? unescapeBasic(body, line) : body, end: close + 3 };
  }

  if (ch === '"') {
    let j = i + 1;
    while (j < text.length && text[j] !== '"') {
      if (text[j] === '\\') j += 1;
      if (text[j] === '\n') throw new TomlParseError('unterminated string', line);
      j += 1;
    }
    if (text[j] !== '"') throw new TomlParseError('unterminated string', line);
    return { value: unescapeBasic(text.slice(i + 1, j), line), end: j + 1 };
  }

  if (ch === "'") {
    const close = text.indexOf("'", i + 1);
    if (close === -1 || text.slice(i + 1, close).includes('\n')) throw new TomlParseError('unterminated string', line);
    return { value: text.slice(i + 1, close), end: close + 1 };
  }

  if (ch === '[') {
    const items: TomlValue[] = [];
    let j = i + 1;
    for (;;) {
      while (/[\s,]/.test(text[j] ?? '')) {
        if (text[j] === '\n') line += 1;
        j += 1;
      }
      if (text[j] === '#') {
        while (j < text.length && text[j] !== '\n') j += 1;
        continue;
      }
      if (j >= text.length) throw new TomlParseError('unterminated array', line);
      if (text[j] === ']') return { value: items, end: j + 1 };
      const item = parseValue(text, j, line);
      items.push(item.value);
      j = item.end;
    }
  }

  const bare = /^[^\s,\]#]+/.exec(text.slice(i));
  if (!bare) throw new TomlParseError('missing value', line);
  const token = bare[0];
  if (token === 'true') return { value: true, end: i + token.length };
  if (token === 'false') return { value: false, end: i + token.length };
  if (/^[+-]?\d[\d_]*$/.test(token)) return { value: Number(token.replace(/_/g, '')), end: i + token.length };
  if (/^[+-]?\d[\d_]*\.\d[\d_]*([eE][+-]?\d+)?$/.test(token)) {
    return { value: Number(token.replace(/_/g, '')), end: i + token.length };
  }
  throw new TomlParseError(`unsupported value ${JSON.stringify(token)}`, line);
}

/**
 * Parses the subset of TOML that `stellar.toml` uses: comments, `key = value` with strings,
 * numbers, booleans and arrays, `[table]` and `[[array of tables]]`. Anything else, including a
 * duplicate key, throws `TomlParseError`, so a malformed file is never half-trusted.
 */
export function parseStellarToml(source: string): TomlTable {
  const root: TomlTable = {};
  let current: TomlTable = root;
  const text = source.replace(/\r\n?/g, '\n');
  let pos = 0;
  let line = 1;

  while (pos < text.length) {
    const eol = text.indexOf('\n', pos);
    const rawLine = text.slice(pos, eol === -1 ? text.length : eol);
    const trimmed = rawLine.trim();

    if (trimmed === '' || trimmed.startsWith('#')) {
      pos = eol === -1 ? text.length : eol + 1;
      line += 1;
      continue;
    }

    const arrayTable = /^\[\[\s*([A-Za-z0-9_-]+)\s*\]\]\s*(#.*)?$/.exec(trimmed);
    const table = /^\[\s*([A-Za-z0-9_-]+)\s*\]\s*(#.*)?$/.exec(trimmed);
    if (arrayTable) {
      const name = arrayTable[1];
      const existing = root[name];
      if (existing !== undefined && !Array.isArray(existing)) throw new TomlParseError(`${name} redefined`, line);
      const next: TomlTable = {};
      root[name] = [...((existing as TomlTable[] | undefined) ?? []), next];
      current = next;
      pos = eol === -1 ? text.length : eol + 1;
      line += 1;
      continue;
    }
    if (table) {
      const name = table[1];
      if (name in root) throw new TomlParseError(`${name} redefined`, line);
      const next: TomlTable = {};
      root[name] = next;
      current = next;
      pos = eol === -1 ? text.length : eol + 1;
      line += 1;
      continue;
    }

    const keyMatch = /^(\s*)([A-Za-z0-9_-]+|"[^"]*")\s*=/.exec(rawLine);
    if (!keyMatch) throw new TomlParseError('expected key = value', line);
    const key = keyMatch[2].replace(/^"|"$/g, '');
    if (key in current) throw new TomlParseError(`duplicate key ${key}`, line);

    const valueStart = pos + keyMatch[0].length;
    const parsed = parseValue(text, valueStart, line);
    current[key] = parsed.value;

    // Only a comment may follow the value on the same line.
    const restEnd = text.indexOf('\n', parsed.end);
    const rest = text.slice(parsed.end, restEnd === -1 ? text.length : restEnd).trim();
    if (rest !== '' && !rest.startsWith('#')) throw new TomlParseError('unexpected text after value', line);

    const consumed = text.slice(pos, parsed.end);
    line += (consumed.match(/\n/g) ?? []).length + 1;
    pos = restEnd === -1 ? text.length : restEnd + 1;
  }

  return root;
}

// ── Domain safety ────────────────────────────────────────────────────────────────────────────

/**
 * Whether `home_domain` is a plain public hostname that is safe to request: no IP literals, ports,
 * paths, credentials, single-label or local names.
 */
export function isSafeHomeDomain(domain: unknown): domain is string {
  if (typeof domain !== 'string' || domain.length === 0 || domain.length > 253) return false;
  if (domain !== domain.toLowerCase()) return false;
  // The top-level label must be letters, which also rules out IPv4 literals such as 169.254.169.254.
  if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain)) return false;
  const blockedSuffixes = ['.local', '.localhost', '.internal', '.lan', '.home', '.corp', '.test', '.invalid'];
  return !blockedSuffixes.some((suffix) => domain.endsWith(suffix));
}

// ── Verification ─────────────────────────────────────────────────────────────────────────────

export type Sep1Reason =
  | 'VERIFIED'
  | 'NO_HOME_DOMAIN'
  | 'UNSAFE_HOME_DOMAIN'
  | 'TOML_UNAVAILABLE'
  | 'TOML_INVALID'
  | 'NOT_LISTED'
  | 'LISTED_FOR_OTHER_ISSUER';

export interface AssetVerification {
  code: string;
  issuer: string;
  verified: boolean;
  /** `true` for every asset that is not verified: do not trust its ticker or name. */
  spoofWarning: boolean;
  reason: Sep1Reason;
  homeDomain: string | null;
  organizationName: string | null;
  assetName: string | null;
  /** Only an `https` icon URL is kept. */
  iconUrl: string | null;
  verifiedAt: number;
}

export interface Sep1Dependencies {
  /** The issuer account's on-chain `home_domain`, or `null`. */
  getHomeDomain(issuer: string): Promise<string | null>;
  /** The raw `stellar.toml` of a domain. Throws if it cannot be fetched. */
  fetchToml(domain: string): Promise<string>;
  now?: () => number;
}

export interface Sep1Options {
  /** How long a verification is cached. Default 24 hours. */
  ttlMs?: number;
  /** How long a failed verification is cached. Default 5 minutes. */
  failureTtlMs?: number;
}

export const SEP1_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
export const SEP1_FAILURE_TTL_MS = 5 * 60 * 1000;

function asString(value: TomlValue | undefined): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function asTables(value: TomlValue | undefined): TomlTable[] {
  return Array.isArray(value) ? (value.filter((v) => typeof v === 'object' && v !== null && !Array.isArray(v)) as TomlTable[]) : [];
}

export class Sep1TomlCrawler {
  private readonly cache = new Map<string, { result: AssetVerification; expiresAt: number }>();
  private readonly inFlight = new Map<string, Promise<AssetVerification>>();
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly failureTtlMs: number;

  constructor(
    private readonly deps: Sep1Dependencies,
    options: Sep1Options = {},
  ) {
    this.now = deps.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? SEP1_CACHE_TTL_MS;
    this.failureTtlMs = options.failureTtlMs ?? SEP1_FAILURE_TTL_MS;
  }

  /** Verifies one asset, from cache when a fresh result exists. Concurrent calls share one lookup. */
  async verifyAsset(code: string, issuer: string): Promise<AssetVerification> {
    const key = `${code}:${issuer}`;
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > this.now()) return cached.result;

    const pending = this.inFlight.get(key);
    if (pending) return pending;

    const lookup = this.lookup(code, issuer)
      .then((result) => {
        const ttl = result.verified ? this.ttlMs : this.failureTtlMs;
        this.cache.set(key, { result, expiresAt: this.now() + ttl });
        return result;
      })
      .finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, lookup);
    return lookup;
  }

  private outcome(
    code: string,
    issuer: string,
    reason: Sep1Reason,
    homeDomain: string | null,
    details: Partial<Pick<AssetVerification, 'organizationName' | 'assetName' | 'iconUrl'>> = {},
  ): AssetVerification {
    const verified = reason === 'VERIFIED';
    return {
      code,
      issuer,
      verified,
      spoofWarning: !verified,
      reason,
      homeDomain,
      organizationName: details.organizationName ?? null,
      assetName: details.assetName ?? null,
      iconUrl: details.iconUrl ?? null,
      verifiedAt: this.now(),
    };
  }

  private async lookup(code: string, issuer: string): Promise<AssetVerification> {
    let homeDomain: string | null;
    try {
      homeDomain = await this.deps.getHomeDomain(issuer);
    } catch {
      return this.outcome(code, issuer, 'NO_HOME_DOMAIN', null);
    }
    if (!homeDomain) return this.outcome(code, issuer, 'NO_HOME_DOMAIN', null);
    if (!isSafeHomeDomain(homeDomain)) return this.outcome(code, issuer, 'UNSAFE_HOME_DOMAIN', homeDomain);

    let source: string;
    try {
      source = await this.deps.fetchToml(homeDomain);
    } catch {
      return this.outcome(code, issuer, 'TOML_UNAVAILABLE', homeDomain);
    }

    let toml: TomlTable;
    try {
      toml = parseStellarToml(source);
    } catch {
      return this.outcome(code, issuer, 'TOML_INVALID', homeDomain);
    }

    const currencies = asTables(toml.CURRENCIES);
    const listing = currencies.find((currency) => currency.code === code && currency.issuer === issuer);
    if (!listing) {
      const otherIssuer = currencies.some((currency) => currency.code === code);
      return this.outcome(code, issuer, otherIssuer ? 'LISTED_FOR_OTHER_ISSUER' : 'NOT_LISTED', homeDomain);
    }

    const documentation = typeof toml.DOCUMENTATION === 'object' && !Array.isArray(toml.DOCUMENTATION) ? (toml.DOCUMENTATION as TomlTable) : {};
    const image = asString(listing.image);
    return this.outcome(code, issuer, 'VERIFIED', homeDomain, {
      organizationName: asString(documentation.ORG_NAME),
      assetName: asString(listing.name) ?? code,
      iconUrl: image !== null && image.startsWith('https://') ? image : null,
    });
  }
}

// ── HTTP fetcher ─────────────────────────────────────────────────────────────────────────────

export interface TomlFetcherOptions {
  timeoutMs?: number;
  maxBytes?: number;
  fetchImpl?: typeof fetch;
}

/**
 * Fetches `https://<domain>/.well-known/stellar.toml` with a timeout and a size cap, never
 * following redirects (a redirect could point at an internal address).
 */
export function createHttpTomlFetcher(options: TomlFetcherOptions = {}): (domain: string) => Promise<string> {
  const timeoutMs = options.timeoutMs ?? 5_000;
  const maxBytes = options.maxBytes ?? 100 * 1024;
  const fetchImpl = options.fetchImpl ?? fetch;

  return async (domain) => {
    if (!isSafeHomeDomain(domain)) throw new Error('Unsafe home domain');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(`https://${domain}/.well-known/stellar.toml`, {
        redirect: 'error',
        signal: controller.signal,
        headers: { accept: 'text/plain, application/toml, */*' },
      });
      if (!response.ok) throw new Error(`stellar.toml returned ${response.status}`);
      const declared = Number(response.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > maxBytes) throw new Error('stellar.toml is too large');
      const body = await response.text();
      if (new TextEncoder().encode(body).length > maxBytes) throw new Error('stellar.toml is too large');
      return body;
    } finally {
      clearTimeout(timer);
    }
  };
}
