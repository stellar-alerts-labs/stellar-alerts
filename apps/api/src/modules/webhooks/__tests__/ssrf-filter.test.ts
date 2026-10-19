import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../lib/prisma', () => ({
  prisma: {
    securityAuditLog: {
      create: vi.fn(),
    },
    webhook: {
      create: vi.fn(),
    },
  },
}));

vi.mock('../../../lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
}));

import { prisma } from '../../../lib/prisma';
import {
  SsrfFilter,
  ssrfFilter,
  isPrivateIpv4,
  isPrivateIpv6,
  isRestrictedIp,
  SsrfBlockedError,
} from '../ssrf-filter';
import { validateWebhookUrl } from '../webhook.validator';
import { WebhooksController } from '../webhooks.controller';
import { webhooksService } from '../webhooks.service';

describe('SsrfFilter & Webhook SSRF Guard (#650)', () => {
  let filter: SsrfFilter;

  beforeEach(() => {
    vi.clearAllMocks();
    filter = new SsrfFilter();
  });

  describe('IP & CIDR Blocklist Validation', () => {
    it('blocks loopback IPv4 addresses (127.0.0.0/8)', () => {
      expect(isPrivateIpv4('127.0.0.1')).toBe(true);
      expect(isPrivateIpv4('127.0.0.2')).toBe(true);
      expect(isPrivateIpv4('127.255.255.254')).toBe(true);
      expect(isRestrictedIp('127.0.0.1')).toBe(true);
    });

    it('blocks RFC 1918 10.0.0.0/8 private addresses', () => {
      expect(isPrivateIpv4('10.0.0.1')).toBe(true);
      expect(isPrivateIpv4('10.254.0.1')).toBe(true);
      expect(isPrivateIpv4('10.255.255.255')).toBe(true);
      expect(isRestrictedIp('10.0.0.5')).toBe(true);
    });

    it('blocks RFC 1918 172.16.0.0/12 private addresses', () => {
      expect(isPrivateIpv4('172.16.0.1')).toBe(true);
      expect(isPrivateIpv4('172.24.1.10')).toBe(true);
      expect(isPrivateIpv4('172.31.255.255')).toBe(true);
      // 172.32.0.1 is public
      expect(isPrivateIpv4('172.32.0.1')).toBe(false);
    });

    it('blocks RFC 1918 192.168.0.0/16 private addresses', () => {
      expect(isPrivateIpv4('192.168.0.1')).toBe(true);
      expect(isPrivateIpv4('192.168.1.100')).toBe(true);
      expect(isPrivateIpv4('192.168.255.255')).toBe(true);
    });

    it('blocks cloud metadata endpoint 169.254.169.254 and link-local (169.254.0.0/16)', () => {
      expect(isPrivateIpv4('169.254.169.254')).toBe(true);
      expect(isPrivateIpv4('169.254.1.1')).toBe(true);
      expect(isRestrictedIp('169.254.169.254')).toBe(true);
    });

    it('blocks current network 0.0.0.0/8', () => {
      expect(isPrivateIpv4('0.0.0.0')).toBe(true);
      expect(isPrivateIpv4('0.1.2.3')).toBe(true);
    });

    it('blocks IPv6 loopback, unspecified, link-local, and unique-local', () => {
      expect(isPrivateIpv6('::1')).toBe(true);
      expect(isPrivateIpv6('::')).toBe(true);
      expect(isPrivateIpv6('fe80::1')).toBe(true);
      expect(isPrivateIpv6('fc00::1')).toBe(true);
      expect(isPrivateIpv6('fd00::1')).toBe(true);
      expect(isRestrictedIp('::1')).toBe(true);
      expect(isRestrictedIp('fe80::dead:beef')).toBe(true);
    });

    it('blocks IPv4-mapped IPv6 pointing to private ranges', () => {
      expect(isPrivateIpv6('::ffff:127.0.0.1')).toBe(true);
      expect(isPrivateIpv6('::ffff:10.0.0.1')).toBe(true);
      expect(isPrivateIpv6('::ffff:169.254.169.254')).toBe(true);
      expect(isPrivateIpv6('::ffff:8.8.8.8')).toBe(false);
    });

    it('allows legitimate public IP addresses', () => {
      expect(isPrivateIpv4('8.8.8.8')).toBe(false);
      expect(isPrivateIpv4('1.1.1.1')).toBe(false);
      expect(isPrivateIpv4('93.184.216.34')).toBe(false);
      expect(isRestrictedIp('8.8.8.8')).toBe(false);
      expect(isRestrictedIp('2606:4700:4700::1111')).toBe(false);
    });
  });

  describe('SsrfFilter.validate URL filtering', () => {
    it('blocks localhost and reserved local domain names', async () => {
      const urls = [
        'http://localhost/webhook',
        'http://localhost:8080/hook',
        'http://api.localhost/hook',
        'http://internal-service.local/webhook',
        'http://db.internal/webhook',
        'http://redis.lan:6379',
      ];

      for (const url of urls) {
        const result = await filter.validate(url);
        expect(result.valid).toBe(false);
        expect(result.reason).toBeDefined();
      }
    });

    it('blocks literal private IP URLs', async () => {
      const urls = [
        'http://127.0.0.1/webhook',
        'http://10.0.0.1:8080',
        'http://172.16.0.1:443',
        'http://192.168.1.1/hook',
        'http://169.254.169.254/latest/meta-data',
        'http://[::1]/webhook',
        'http://[fe80::1]/hook',
      ];

      for (const url of urls) {
        const result = await filter.validate(url);
        expect(result.valid).toBe(false);
        expect(result.blockedIp).toBeDefined();
      }
    });

    it('blocks URLs with embedded credentials', async () => {
      const result = await filter.validate('https://admin:secret@api.example.com/webhook');
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('embedded authentication credentials');
    });

    it('blocks unsupported protocols like ftp, gopher, and file', async () => {
      const result1 = await filter.validate('ftp://api.example.com/webhook');
      expect(result1.valid).toBe(false);

      const result2 = await filter.validate('file:///etc/passwd');
      expect(result2.valid).toBe(false);

      const result3 = await filter.validate('gopher://127.0.0.1:6379');
      expect(result3.valid).toBe(false);
    });

    it('blocks non-standard/dangerous ports (e.g. redis 6379, postgres 5432)', async () => {
      const mockDns = async () => ['93.184.216.34'];
      const result = await filter.validate('https://api.example.com:6379/webhook', {
        dnsLookupFn: mockDns,
      });
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('Port 6379 is not allowed');
    });

    it('blocks hostnames that resolve to private or cloud metadata IPs via DNS', async () => {
      const mockDnsPrivate = async () => ['10.0.0.25'];
      const result1 = await filter.validate('https://my-internal-host.com/webhook', {
        dnsLookupFn: mockDnsPrivate,
      });
      expect(result1.valid).toBe(false);
      expect(result1.blockedIp).toBe('10.0.0.25');

      const mockDnsMetadata = async () => ['169.254.169.254'];
      const result2 = await filter.validate('https://cloud-meta.attacker.com/webhook', {
        dnsLookupFn: mockDnsMetadata,
      });
      expect(result2.valid).toBe(false);
      expect(result2.blockedIp).toBe('169.254.169.254');
    });

    it('blocks multi-homed hostnames if ANY resolved address is private', async () => {
      const mockDnsMixed = async () => ['93.184.216.34', '127.0.0.1'];
      const result = await filter.validate('https://rebinding-test.com/webhook', {
        dnsLookupFn: mockDnsMixed,
      });
      expect(result.valid).toBe(false);
      expect(result.blockedIp).toBe('127.0.0.1');
    });

    it('allows valid public HTTPS webhook endpoints seamlessly and pins IP', async () => {
      const mockDnsPublic = async () => ['93.184.216.34'];
      const result = await filter.validate('https://api.github.com/webhook', {
        dnsLookupFn: mockDnsPublic,
      });

      expect(result.valid).toBe(true);
      expect(result.pinnedIp).toBe('93.184.216.34');
      expect(result.resolvedIps).toEqual(['93.184.216.34']);
    });
  });

  describe('DNS Rebinding Prevention with IP Pinning', () => {
    it('creates an agent with lookup pinned to the validated IP', () => {
      const pinnedIp = '93.184.216.34';
      const agents = filter.createPinnedAgent(pinnedIp);

      expect(agents.httpAgent).toBeDefined();
      expect(agents.httpsAgent).toBeDefined();

      // Test that the internal lookup callback returns the pinned IP immediately
      const lookupFn = (agents.httpsAgent as any).options.lookup;
      expect(typeof lookupFn).toBe('function');

      let resolvedAddress = '';
      let resolvedFamily = 0;
      lookupFn('attacker-rebound.com', {}, (err: any, addr: string, fam: number) => {
        expect(err).toBeNull();
        resolvedAddress = addr;
        resolvedFamily = fam;
      });

      expect(resolvedAddress).toBe(pinnedIp);
      expect(resolvedFamily).toBe(4);
    });
  });

  describe('webhook.validator: validateWebhookUrl & Security Audit Log', () => {
    it('persists a SecurityAuditLog entry and throws SsrfBlockedError on SSRF violation', async () => {
      const targetUrl = 'http://169.254.169.254/latest/meta-data';
      const context = {
        userId: 'user-attacker',
        clientIp: '198.51.100.5',
        userAgent: 'Mozilla/5.0 MaliciousBot',
      };

      await expect(validateWebhookUrl(targetUrl, context, filter)).rejects.toThrow(
        SsrfBlockedError
      );

      // Verify Prisma SecurityAuditLog record creation
      expect(prisma.securityAuditLog.create).toHaveBeenCalledTimes(1);
      expect(prisma.securityAuditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            userId: 'user-attacker',
            action: 'SSRF_ATTEMPT_BLOCKED',
            ipAddress: '198.51.100.5',
            userAgent: 'Mozilla/5.0 MaliciousBot',
            details: expect.objectContaining({
              targetUrl,
              blockedIp: '169.254.169.254',
            }),
          }),
        })
      );
    });

    it('passes and does not create SecurityAuditLog when target URL is legitimate public HTTPS', async () => {
      const mockDns = async () => ['93.184.216.34'];
      const targetUrl = 'https://webhook.site/stellar-listener';

      const result = await validateWebhookUrl(
        targetUrl,
        { userId: 'user-legit', options: { dnsLookupFn: mockDns } },
        filter
      );

      expect(result.valid).toBe(true);
      expect(result.pinnedIp).toBe('93.184.216.34');
      expect(prisma.securityAuditLog.create).not.toHaveBeenCalled();
    });
  });

  describe('WebhooksController integration', () => {
    it('rejects addWebhook request with 400 when SSRF target URL is provided', async () => {
      const controller = new WebhooksController();
      const mockRequest: any = {
        body: { url: 'http://127.0.0.1:6379/flushall' },
        user: { id: 'user-1' },
        ip: '203.0.113.1',
        headers: { 'user-agent': 'TestAgent' },
      };
      const mockReply: any = {
        status: vi.fn().mockReturnThis(),
        send: vi.fn().mockReturnThis(),
      };

      await expect(controller.addWebhook(mockRequest, mockReply)).rejects.toThrow(
        SsrfBlockedError
      );

      expect(prisma.securityAuditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: 'SSRF_ATTEMPT_BLOCKED',
          }),
        })
      );
    });

    it('accepts addWebhook request when legitimate public URL is provided', async () => {
      const controller = new WebhooksController();
      const mockRequest: any = {
        body: { url: 'https://example.com/webhook' },
        user: { id: 'user-1' },
        ip: '203.0.113.1',
        headers: { 'user-agent': 'TestAgent' },
      };
      const mockReply: any = {
        status: vi.fn().mockReturnThis(),
        send: vi.fn().mockReturnThis(),
      };

      vi.spyOn(webhooksService, 'addWebhook').mockResolvedValue({
        id: 'wh-123',
        url: 'https://example.com/webhook',
        isActive: true,
      } as any);

      // Mock DNS resolution in validator for this test
      vi.spyOn(ssrfFilter, 'validate').mockResolvedValue({
        valid: true,
        url: new URL('https://example.com/webhook'),
        hostname: 'example.com',
        resolvedIps: ['93.184.216.34'],
        pinnedIp: '93.184.216.34',
      });

      await controller.addWebhook(mockRequest, mockReply);

      expect(mockReply.status).toHaveBeenCalledWith(201);
      expect(mockReply.send).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          webhook: expect.objectContaining({ id: 'wh-123' }),
        })
      );
    });
  });
});
