import dns from 'dns';
import net from 'net';
import http from 'http';
import https from 'https';
import { ValidationError } from '../../lib/errors';
import { createLogger } from '../../lib/logger';

const log = createLogger({ module: 'SsrfFilter' });

export class SsrfBlockedError extends ValidationError {
  public readonly targetUrl: string;
  public readonly blockedIp?: string;

  constructor(message: string, targetUrl: string, blockedIp?: string) {
    super(`SSRF Filter blocked destination: ${message}`, { targetUrl, blockedIp }, 'SSRF_BLOCKED');
    this.name = 'SsrfBlockedError';
    this.targetUrl = targetUrl;
    this.blockedIp = blockedIp;
  }
}

/**
 * Standard RFC 1918, loopback, link-local, carrier NAT and cloud metadata CIDR ranges.
 */
export const PRIVATE_IPV4_CIDRS = [
  '0.0.0.0/8',       // Broadcast / current network
  '10.0.0.0/8',      // RFC 1918 Private
  '100.64.0.0/10',   // Carrier-grade NAT
  '127.0.0.0/8',     // Loopback
  '169.254.0.0/16',  // Link-local / Cloud metadata (AWS, GCP, Azure 169.254.169.254)
  '172.16.0.0/12',   // RFC 1918 Private
  '192.0.0.0/24',    // IETF Protocol
  '192.0.2.0/24',    // TEST-NET-1
  '192.168.0.0/16',  // RFC 1918 Private
  '198.18.0.0/15',   // Benchmarking
  '198.51.100.0/24', // TEST-NET-2
  '203.0.113.0/24',  // TEST-NET-3
  '224.0.0.0/4',     // Multicast
  '240.0.0.0/4',     // Reserved
  '255.255.255.255/32',
];

export function ipv4ToUint32(ip: string): number {
  return ip.split('.').reduce((acc, octet) => ((acc << 8) + parseInt(octet, 10)) >>> 0, 0);
}

export function isIpInCidr(ip: string, cidr: string): boolean {
  const [network, prefixStr] = cidr.split('/');
  const prefix = parseInt(prefixStr, 10);
  const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;
  const ipLong = ipv4ToUint32(ip);
  const networkLong = ipv4ToUint32(network);
  return (ipLong & mask) === (networkLong & mask);
}

export function isPrivateIpv4(ip: string): boolean {
  for (const cidr of PRIVATE_IPV4_CIDRS) {
    if (isIpInCidr(ip, cidr)) {
      return true;
    }
  }
  return false;
}

export function isPrivateIpv6(ip: string): boolean {
  const normalized = ip.toLowerCase().trim();

  // Loopback and unspecified
  if (normalized === '::1' || normalized === '::') {
    return true;
  }

  // IPv4-mapped IPv6 (::ffff:127.0.0.1 or ::ffff:7f00:1)
  if (normalized.startsWith('::ffff:')) {
    const v4Part = normalized.slice(7);
    if (net.isIPv4(v4Part)) {
      return isPrivateIpv4(v4Part);
    }
  }

  // Unique local addresses (fc00::/7)
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) {
    return true;
  }

  // Link-local addresses (fe80::/10)
  if (
    normalized.startsWith('fe8') ||
    normalized.startsWith('fe9') ||
    normalized.startsWith('fea') ||
    normalized.startsWith('feb')
  ) {
    return true;
  }

  // Multicast (ff00::/8)
  if (normalized.startsWith('ff')) {
    return true;
  }

  return false;
}

export function isRestrictedIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    return isPrivateIpv4(ip);
  }
  if (net.isIPv6(ip)) {
    return isPrivateIpv6(ip);
  }
  // Unknown IP format treated as unsafe
  return true;
}

export interface SsrfFilterOptions {
  allowHttpInDev?: boolean;
  allowedPorts?: number[];
  dnsLookupFn?: (hostname: string) => Promise<string[]>;
}

export interface SsrfValidationResult {
  valid: boolean;
  url: URL;
  hostname: string;
  resolvedIps: string[];
  pinnedIp?: string;
  reason?: string;
  blockedIp?: string;
}

/**
 * Default DNS lookup using Node's dns.promises.lookup
 */
async function defaultLookup(hostname: string): Promise<string[]> {
  try {
    const results = await dns.promises.lookup(hostname, { all: true });
    return results.map((r) => r.address);
  } catch (err: any) {
    throw new Error(`DNS resolution failed for host "${hostname}": ${err.message}`);
  }
}

export class SsrfFilter {
  private allowedPorts: number[] = [80, 443, 8080, 8443];

  /**
   * Validates a target URL against SSRF policy:
   * 1. Protocol check (http/https only)
   * 2. Rejects embedded credentials (user:pass@host)
   * 3. Rejects private/local hostnames (localhost, *.local, *.internal)
   * 4. Resolves DNS and blocks any private/internal IP
   * 5. Selects and pins a valid public IP for connection to prevent DNS rebinding
   */
  public async validate(
    targetUrl: string,
    options: SsrfFilterOptions = {}
  ): Promise<SsrfValidationResult> {
    let parsed: URL;
    try {
      parsed = new URL(targetUrl);
    } catch {
      return {
        valid: false,
        url: new URL('http://invalid.local'),
        hostname: '',
        resolvedIps: [],
        reason: 'Malformed URL',
      };
    }

    const protocol = parsed.protocol.toLowerCase();
    const isProd = process.env.NODE_ENV === 'production';
    const allowHttp = options.allowHttpInDev ?? !isProd;

    if (protocol !== 'http:' && protocol !== 'https:') {
      return {
        valid: false,
        url: parsed,
        hostname: parsed.hostname,
        resolvedIps: [],
        reason: `Unsupported protocol "${protocol}". Only HTTP and HTTPS are permitted.`,
      };
    }

    if (protocol === 'http:' && !allowHttp) {
      return {
        valid: false,
        url: parsed,
        hostname: parsed.hostname,
        resolvedIps: [],
        reason: 'Plain HTTP is prohibited in production. Webhooks must use HTTPS.',
      };
    }

    if (parsed.username || parsed.password) {
      return {
        valid: false,
        url: parsed,
        hostname: parsed.hostname,
        resolvedIps: [],
        reason: 'URLs containing embedded authentication credentials are not permitted.',
      };
    }

    const hostname = parsed.hostname.toLowerCase();
    const rawHost = hostname.replace(/^\[|\]$/g, '');

    // Hostname blocklist
    if (
      hostname === 'localhost' ||
      hostname.endsWith('.localhost') ||
      hostname.endsWith('.local') ||
      hostname.endsWith('.internal') ||
      hostname.endsWith('.lan') ||
      hostname.endsWith('.corp')
    ) {
      return {
        valid: false,
        url: parsed,
        hostname,
        resolvedIps: [],
        reason: `Hostname "${hostname}" resolves to an internal or local reserved domain.`,
      };
    }

    const port = parsed.port
      ? parseInt(parsed.port, 10)
      : protocol === 'https:'
      ? 443
      : 80;
    const ports = options.allowedPorts ?? this.allowedPorts;
    if (!ports.includes(port)) {
      return {
        valid: false,
        url: parsed,
        hostname,
        resolvedIps: [],
        reason: `Port ${port} is not allowed. Allowed ports: ${ports.join(', ')}`,
      };
    }

    let resolvedIps: string[] = [];
    if (net.isIP(rawHost)) {
      resolvedIps = [rawHost];
    } else {
      const lookupFn = options.dnsLookupFn ?? defaultLookup;
      try {
        resolvedIps = await lookupFn(hostname);
      } catch (err: any) {
        return {
          valid: false,
          url: parsed,
          hostname,
          resolvedIps: [],
          reason: `DNS resolution failed: ${err.message}`,
        };
      }
    }

    if (resolvedIps.length === 0) {
      return {
        valid: false,
        url: parsed,
        hostname,
        resolvedIps: [],
        reason: `No IP addresses resolved for host "${hostname}".`,
      };
    }

    // Check every resolved IP: if ANY resolved IP is in a private/restricted range, reject!
    for (const ip of resolvedIps) {
      if (isRestrictedIp(ip)) {
        return {
          valid: false,
          url: parsed,
          hostname,
          resolvedIps,
          blockedIp: ip,
          reason: `Host "${hostname}" resolves to restricted or private IP: ${ip}`,
        };
      }
    }

    const pinnedIp = resolvedIps[0];
    return {
      valid: true,
      url: parsed,
      hostname,
      resolvedIps,
      pinnedIp,
    };
  }

  /**
   * Asserts that a URL is safe against SSRF; throws SsrfBlockedError (HTTP 400) if not.
   */
  public async assertSafe(
    targetUrl: string,
    options: SsrfFilterOptions = {}
  ): Promise<SsrfValidationResult> {
    const result = await this.validate(targetUrl, options);
    if (!result.valid) {
      log.warn({ url: targetUrl, reason: result.reason, blockedIp: result.blockedIp }, '🚨 SSRF attempt blocked');
      throw new SsrfBlockedError(result.reason || 'Restricted destination', targetUrl, result.blockedIp);
    }
    return result;
  }

  /**
   * Creates an HTTP/HTTPS Agent pinned directly to the validated IP to prevent DNS rebinding.
   */
  public createPinnedAgent(pinnedIp: string): { httpAgent: http.Agent; httpsAgent: https.Agent } {
    const family = net.isIPv6(pinnedIp) ? 6 : 4;
    const lookup = (
      _hostname: string,
      _options: any,
      callback: (err: NodeJS.ErrnoException | null, address: string, family: number) => void
    ) => {
      // Pins all socket connections to the pre-validated IP address
      callback(null, pinnedIp, family);
    };

    return {
      httpAgent: new http.Agent({ lookup, keepAlive: true }),
      httpsAgent: new https.Agent({ lookup, keepAlive: true }),
    };
  }
}

export const ssrfFilter = new SsrfFilter();
