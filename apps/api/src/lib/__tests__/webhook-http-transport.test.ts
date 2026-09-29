/**
 * Transport-level tests for the instrumented webhook HTTP path.
 *
 * These drive `requestWithPhaseTimings` against a real loopback `node:http`
 * server rather than mocking the transport, because the behaviour under test —
 * which connection phases are observable, whether a socket is reused, how
 * redirects rewrite the request — only exists at the socket level. Mocking
 * `node:http` would just assert the mock.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  requestWithPhaseTimings,
  fetchWithPhaseTimings,
  sendInstrumentedWebhookRequest,
  classifyWebhookResponse,
  classifyWebhookError,
  useNativePhaseTimingTransport,
  DEFAULT_MAX_REDIRECTS,
} from '../webhook-http-transport';
import { ExternalRequestTimeoutError } from '../external-request';
import { webhookDispatchMetrics } from '../webhook-telemetry';
import { env } from '../../config/env';

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void;

let server: http.Server;
let origin: string;

/** Requests seen by the fixture, so redirect rewriting can be asserted precisely. */
let seen: Array<{ method: string; url: string; headers: http.IncomingHttpHeaders; body: string }> = [];
let handler: Handler = (_req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end('ok');
};

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      seen.push({
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      });
      handler(req, res);
    });
  });

  // Listen on every interface and address it as `localhost`, so the client
  // performs a real name lookup. Node skips `dns.lookup` for IP-literal hosts,
  // which would leave the DNS phase untested (and legitimately unobserved).
  await new Promise<void>((resolve) => server.listen(0, () => resolve()));
  origin = `http://localhost:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  // The transport uses the default global agent, which keeps sockets alive.
  // Drop the pool between tests so "fresh connection" and "reused connection"
  // are asserted against a known state rather than whatever ran before.
  http.globalAgent.destroy();
  seen = [];
  handler = (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
  };
});

describe('requestWithPhaseTimings: request/response', () => {
  it('performs the POST and returns status, body and headers', async () => {
    handler = (req, res) => {
      res.writeHead(201, { 'content-type': 'application/json', 'x-custom': 'abc' });
      res.end('{"ok":true}');
    };

    const result = await requestWithPhaseTimings({
      url: `${origin}/hooks`,
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"event":"payment"}',
    });

    expect(result.response.status).toBe(201);
    expect(await result.response.text()).toBe('{"ok":true}');
    expect(result.response.headers.get('x-custom')).toBe('abc');
    expect(result.finalUrl).toBe(`${origin}/hooks`);
    expect(result.redirects).toEqual([]);

    expect(seen).toHaveLength(1);
    expect(seen[0].method).toBe('POST');
    expect(seen[0].url).toBe('/hooks');
    expect(seen[0].body).toBe('{"event":"payment"}');
  });

  it('sets content-length from the body when the caller did not', async () => {
    await requestWithPhaseTimings({
      url: `${origin}/len`,
      method: 'POST',
      body: 'hello',
    });

    expect(seen[0].headers['content-length']).toBe('5');
  });

  it('returns a null body for a 204 without throwing', async () => {
    handler = (_req, res) => {
      res.writeHead(204);
      res.end();
    };

    const result = await requestWithPhaseTimings({ url: `${origin}/no-content` });
    expect(result.response.status).toBe(204);
    expect(result.response.body).toBeNull();
  });
});

describe('requestWithPhaseTimings: phase timings', () => {
  it('observes DNS, TCP, TTFB and stream on a fresh plain-HTTP connection', async () => {
    const result = await requestWithPhaseTimings({ url: `${origin}/timed` });

    expect(typeof result.timings.dnsMs).toBe('number');
    expect(typeof result.timings.tcpConnectMs).toBe('number');
    expect(typeof result.timings.ttfbMs).toBe('number');
    expect(typeof result.timings.responseStreamMs).toBe('number');
    expect(result.timings.totalMs).toBeGreaterThanOrEqual(0);
    expect(result.reusedConnection).toBe(false);
  });

  it('reports tls_handshake as null for a plain-HTTP endpoint', async () => {
    // A TLS number for an http:// request would be fabricated; the phase simply
    // did not happen and must read as "not observed".
    const result = await requestWithPhaseTimings({ url: `${origin}/plain` });
    expect(result.timings.tlsHandshakeMs).toBeNull();
  });

  it('reports a slow response body separately from time-to-first-byte', async () => {
    handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.write('first');
      setTimeout(() => res.end('-drained'), 120);
    };

    const result = await requestWithPhaseTimings({ url: `${origin}/slow-body` });

    expect(result.timings.ttfbMs).toBeLessThan(result.timings.responseStreamMs!);
    expect(result.timings.responseStreamMs!).toBeGreaterThanOrEqual(100);
  });

  it('detects a reused keep-alive socket and drops the connect phases', async () => {
    const first = await requestWithPhaseTimings({ url: `${origin}/reuse` });
    const second = await requestWithPhaseTimings({ url: `${origin}/reuse` });

    expect(first.reusedConnection).toBe(false);
    expect(first.timings.dnsMs).not.toBeNull();

    expect(second.reusedConnection).toBe(true);
    expect(second.timings.dnsMs).toBeNull();
    expect(second.timings.tcpConnectMs).toBeNull();
    // The phases after the socket are still observable on a reused connection.
    expect(typeof second.timings.ttfbMs).toBe('number');
  });

  it('does not mistake an IP-literal host for a reused connection', async () => {
    // Node resolves an IP address without calling `dns.lookup`, so the DNS phase
    // is legitimately absent here. Reuse must be detected from the socket, not
    // inferred from a missing DNS mark, or every IP-addressed webhook URL would
    // be permanently mislabelled as reused.
    const { port } = server.address() as AddressInfo;
    const result = await requestWithPhaseTimings({ url: `http://127.0.0.1:${port}/ip-host` });

    expect(result.timings.dnsMs).toBeNull();
    expect(result.reusedConnection).toBe(false);
  });
});

describe('requestWithPhaseTimings: redirects', () => {
  it('follows a 302 and downgrades POST to GET, dropping body headers', async () => {
    handler = (req, res) => {
      if (req.url === '/start') {
        res.writeHead(302, { location: '/end' });
        res.end();
        return;
      }
      res.writeHead(200);
      res.end('landed');
    };

    const result = await requestWithPhaseTimings({
      url: `${origin}/start`,
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"a":1}',
    });

    expect(result.response.status).toBe(200);
    expect(result.finalUrl).toBe(`${origin}/end`);
    expect(result.redirects).toEqual([`${origin}/end`]);

    expect(seen[0].method).toBe('POST');
    expect(seen[1].method).toBe('GET');
    expect(seen[1].body).toBe('');
    expect(seen[1].headers['content-length']).toBeUndefined();
    expect(seen[1].headers['content-type']).toBeUndefined();
  });

  it('replays method and body across a 307', async () => {
    handler = (req, res) => {
      if (req.url === '/keep') {
        res.writeHead(307, { location: '/replay' });
        res.end();
        return;
      }
      res.writeHead(200);
      res.end('replayed');
    };

    const result = await requestWithPhaseTimings({
      url: `${origin}/keep`,
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"a":1}',
    });

    expect(seen[1].method).toBe('POST');
    expect(seen[1].body).toBe('{"a":1}');
    expect(seen[1].headers['content-length']).toBe('7');
    expect(result.finalUrl).toBe(`${origin}/replay`);
  });

  it('resolves a relative Location against the current URL', async () => {
    handler = (req, res) => {
      if (req.url === '/a/b') {
        res.writeHead(302, { location: '../c' });
        res.end();
        return;
      }
      res.writeHead(200);
      res.end('relative');
    };

    const result = await requestWithPhaseTimings({ url: `${origin}/a/b` });
    expect(result.finalUrl).toBe(`${origin}/c`);
  });

  it('does not treat a redirect status without Location as a redirect', async () => {
    handler = (_req, res) => {
      res.writeHead(302);
      res.end('no location header');
    };

    const result = await requestWithPhaseTimings({ url: `${origin}/nowhere` });
    expect(result.response.status).toBe(302);
    expect(result.redirects).toEqual([]);
  });

  it('invokes the onRedirect hook for every hop, with source and target', async () => {
    handler = (req, res) => {
      if (req.url === '/one') {
        res.writeHead(302, { location: '/two' });
        res.end();
        return;
      }
      if (req.url === '/two') {
        res.writeHead(302, { location: '/three' });
        res.end();
        return;
      }
      res.writeHead(200);
      res.end('done');
    };

    const hops: Array<[string, string]> = [];
    await requestWithPhaseTimings({
      url: `${origin}/one`,
      onRedirect: (from, to) => {
        hops.push([from, to]);
      },
    });

    expect(hops).toEqual([
      [`${origin}/one`, `${origin}/two`],
      [`${origin}/two`, `${origin}/three`],
    ]);
  });

  it('aborts the chain when the onRedirect hook throws', async () => {
    // This is the SSRF path: a redirect to a link-local address must stop here,
    // not be fetched.
    handler = (req, res) => {
      if (req.url === '/open-redirect') {
        res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' });
        res.end();
        return;
      }
      res.writeHead(200);
      res.end('should not be reached');
    };

    await expect(
      requestWithPhaseTimings({
        url: `${origin}/open-redirect`,
        onRedirect: (_from, to) => {
          throw new Error('Blocked by SSRF policy');
        },
      }),
    ).rejects.toThrow('Blocked by SSRF policy');

    // Only the first hop was ever requested.
    expect(seen.map((r) => r.url)).toEqual(['/open-redirect']);
  });

  it('throws once the hop cap is exceeded rather than reporting a redirect as delivered', async () => {
    handler = (req, res) => {
      const hop = Number((req.url ?? '/0').slice(1) || 0);
      res.writeHead(302, { location: `/${hop + 1}` });
      res.end();
    };

    await expect(
      requestWithPhaseTimings({ url: `${origin}/0`, maxRedirects: 2 }),
    ).rejects.toThrow('redirect limit of 2 exceeded');
  });

  it('defaults to a hop cap of 5', () => {
    expect(DEFAULT_MAX_REDIRECTS).toBe(5);
  });
});

describe('requestWithPhaseTimings: failures', () => {
  it('rejects an unsupported protocol', async () => {
    await expect(
      requestWithPhaseTimings({ url: 'ftp://example.com/hook' }),
    ).rejects.toThrow('Unsupported webhook protocol: ftp:');
  });

  it('rejects a malformed URL', async () => {
    await expect(
      requestWithPhaseTimings({ url: 'not-a-url' }),
    ).rejects.toThrow('Invalid webhook URL');
  });

  it('raises ExternalRequestTimeoutError when the endpoint never answers', async () => {
    handler = () => {
      // Never respond.
    };

    const error = await requestWithPhaseTimings({ url: `${origin}/hang`, timeoutMs: 150 })
      .then(() => null)
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(ExternalRequestTimeoutError);
    expect((error as ExternalRequestTimeoutError).timeoutMs).toBe(150);
  });

  it('propagates a connection failure', async () => {
    const closed = http.createServer();
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', () => resolve()));
    const deadPort = (closed.address() as AddressInfo).port;
    await new Promise<void>((resolve) => closed.close(() => resolve()));

    await expect(
      requestWithPhaseTimings({ url: `http://127.0.0.1:${deadPort}/gone`, timeoutMs: 2000 }),
    ).rejects.toThrow();
  });
});

describe('fetchWithPhaseTimings (rollback transport)', () => {
  it('keeps TTFB and stream timings but reports connect phases as unobserved', async () => {
    const result = await fetchWithPhaseTimings({
      url: `${origin}/fetch-fallback`,
      method: 'POST',
      body: 'payload',
    });

    expect(result.response.status).toBe(200);
    expect(await result.response.text()).toBe('ok');

    expect(typeof result.timings.ttfbMs).toBe('number');
    expect(typeof result.timings.responseStreamMs).toBe('number');
    // undici exposes no per-connection callbacks, so these cannot be faked.
    expect(result.timings.dnsMs).toBeNull();
    expect(result.timings.tcpConnectMs).toBeNull();
    expect(result.timings.tlsHandshakeMs).toBeNull();
    expect(result.reusedConnection).toBe(false);
  });

  it('does not throw when reconstructing a 204 response', async () => {
    handler = (_req, res) => {
      res.writeHead(204);
      res.end();
    };

    const result = await fetchWithPhaseTimings({ url: `${origin}/fetch-204` });
    expect(result.response.status).toBe(204);
    expect(result.response.body).toBeNull();
  });
});

describe('outcome classification', () => {
  it.each([
    [200, 'delivered'],
    [202, 'delivered'],
    [301, 'delivered'],
    [400, 'client_error'],
    [404, 'client_error'],
    [422, 'client_error'],
    [429, 'rate_limited'],
    [500, 'server_error'],
    [502, 'server_error'],
    [503, 'server_error'],
  ])('maps status %i to %s', (status, expected) => {
    expect(classifyWebhookResponse(status)).toBe(expected);
  });

  it('maps a deadline to timeout', () => {
    expect(
      classifyWebhookError(
        new ExternalRequestTimeoutError('slow', { provider: 'Webhook', timeoutMs: 10 }),
      ),
    ).toBe('timeout');
  });

  it.each(['AbortError', 'TimeoutError', 'ETIMEDOUT', 'UND_ERR_HEADERS_TIMEOUT'])(
    'maps the %s failure to timeout',
    (name) => {
      const err = new Error('failed');
      err.name = name;
      expect(classifyWebhookError(err)).toBe('timeout');
    },
  );

  it('maps other transport failures to connection_error', () => {
    expect(classifyWebhookError(new Error('ECONNRESET'))).toBe('connection_error');
    expect(classifyWebhookError('a string')).toBe('connection_error');
    expect(classifyWebhookError(null)).toBe('connection_error');
  });
});

describe('transport selection', () => {
  it('uses the native transport by default', () => {
    expect(useNativePhaseTimingTransport()).toBe(true);
  });

  it('falls back to fetch when the transport is rolled back', () => {
    const original = env.WEBHOOK_DISPATCH_TRANSPORT;
    env.WEBHOOK_DISPATCH_TRANSPORT = 'fetch';
    expect(useNativePhaseTimingTransport()).toBe(false);
    env.WEBHOOK_DISPATCH_TRANSPORT = original;
  });
});

describe('sendInstrumentedWebhookRequest', () => {
  const originalTelemetry = env.WEBHOOK_DISPATCH_TELEMETRY_ENABLED;
  const originalTransport = env.WEBHOOK_DISPATCH_TRANSPORT;

  beforeEach(() => {
    webhookDispatchMetrics.reset();
  });

  afterEach(() => {
    env.WEBHOOK_DISPATCH_TELEMETRY_ENABLED = originalTelemetry;
    env.WEBHOOK_DISPATCH_TRANSPORT = originalTransport;
  });

  it('delivers and records the attempt outcome and phase timings', async () => {
    const attempt = await sendInstrumentedWebhookRequest({
      webhookId: 'wh_1',
      url: `${origin}/dispatch`,
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"event":"payment"}',
      attempt: 1,
    });

    expect(attempt.status).toBe(200);
    expect(attempt.outcome).toBe('delivered');
    expect(attempt.finalUrl).toBe(`${origin}/dispatch`);

    const output = webhookDispatchMetrics.render();
    expect(output).toContain('outcome="delivered"');
    expect(output).toContain('phase="ttfb"');
    // The gauge must return to zero even though an attempt was recorded.
    expect(output).toContain('stellar_alerts_webhook_dispatch_in_flight 0');
  });

  it('classifies a 503 as a server error without throwing', async () => {
    handler = (_req, res) => {
      res.writeHead(503);
      res.end('unavailable');
    };

    const attempt = await sendInstrumentedWebhookRequest({
      webhookId: 'wh_1',
      url: `${origin}/down`,
    });

    expect(attempt.status).toBe(503);
    expect(attempt.outcome).toBe('server_error');
    expect(webhookDispatchMetrics.render()).toContain('outcome="server_error"');
  });

  it('re-validates every redirect hop through the onRedirect hook', async () => {
    handler = (req, res) => {
      if (req.url === '/start') {
        res.writeHead(307, { location: 'http://169.254.169.254/latest/meta-data/' });
        res.end();
        return;
      }
      res.writeHead(200);
      res.end('should not be reached');
    };

    await expect(
      sendInstrumentedWebhookRequest({
        webhookId: 'wh_1',
        url: `${origin}/start`,
        onRedirect: (_from, to) => {
          throw new Error(`Blocked by SSRF policy: ${to}`);
        },
      }),
    ).rejects.toThrow('Blocked by SSRF policy');

    expect(webhookDispatchMetrics.render()).toContain('outcome="connection_error"');
  });

  it('releases the in-flight gauge when the request throws', async () => {
    const closed = http.createServer();
    await new Promise<void>((resolve) => closed.listen(0, () => resolve()));
    const deadPort = (closed.address() as AddressInfo).port;
    await new Promise<void>((resolve) => closed.close(() => resolve()));

    await expect(
      sendInstrumentedWebhookRequest({
        webhookId: 'wh_1',
        url: `http://127.0.0.1:${deadPort}/gone`,
        timeoutMs: 2000,
      }),
    ).rejects.toThrow();

    const output = webhookDispatchMetrics.render();
    expect(output).toContain('stellar_alerts_webhook_dispatch_in_flight 0');
    expect(output).toContain('outcome="connection_error"');
  });

  it('still delivers but records nothing when dispatch telemetry is disabled', async () => {
    // This is the documented rollback switch: the request must still go out,
    // it just stops emitting spans and samples.
    env.WEBHOOK_DISPATCH_TELEMETRY_ENABLED = 'false';

    const attempt = await sendInstrumentedWebhookRequest({
      webhookId: 'wh_1',
      url: `${origin}/rollback`,
    });

    expect(attempt.status).toBe(200);
    expect(attempt.outcome).toBe('delivered');
    expect(seen).toHaveLength(1);

    const output = webhookDispatchMetrics.render();
    expect(output).not.toContain('outcome="delivered"');
    expect(output).not.toContain('phase="ttfb"');
  });

  it('delivers over the fetch rollback transport', async () => {
    env.WEBHOOK_DISPATCH_TRANSPORT = 'fetch';

    const attempt = await sendInstrumentedWebhookRequest({
      webhookId: 'wh_1',
      url: `${origin}/fetch-rollback`,
      method: 'POST',
      body: 'payload',
    });

    expect(attempt.status).toBe(200);
    expect(await attempt.response.text()).toBe('ok');
    // undici cannot expose connection phases, so they stay unobserved.
    expect(attempt.timings.dnsMs).toBeNull();
    expect(typeof attempt.timings.ttfbMs).toBe('number');
  });
});
