import { describe, it, expect, beforeEach, vi } from "vitest";
import { prisma } from "./prisma";

describe("WebhookLog Creation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should create a webhook log with statusCode and responseBody", async () => {
    // Create test data
    const userId = "test-user-123";
    const webhookUrl = "https://example.com/webhook";

    const user = await prisma.user.create({
      data: { email: `test-${Date.now()}@example.com` },
    });

    const webhook = await prisma.webhook.create({
      data: {
        userId: user.id,
        url: webhookUrl,
        secret: "test-secret-key-123",
        isActive: true,
      },
    });

    // Create webhook log
    const log = await prisma.webhookLog.create({
      data: {
        webhookId: webhook.id,
        statusCode: 200,
        responseBody: JSON.stringify({ success: true }),
      },
    });

    expect(log).toBeDefined();
    expect(log.webhookId).toBe(webhook.id);
    expect(log.statusCode).toBe(200);
    expect(log.responseBody).toContain("success");
    expect(log.error).toBeNull();
    expect(log.sentAt).toBeInstanceOf(Date);

    // Cleanup
    await prisma.webhookLog.deleteMany({ where: { webhookId: webhook.id } });
    await prisma.webhook.delete({ where: { id: webhook.id } });
    await prisma.user.delete({ where: { id: user.id } });
  });

  it("should create a webhook log with error message on failure", async () => {
    const user = await prisma.user.create({
      data: { email: `test-error-${Date.now()}@example.com` },
    });

    const webhook = await prisma.webhook.create({
      data: {
        userId: user.id,
        url: "https://example.com/webhook",
        secret: "test-secret",
        isActive: true,
      },
    });

    const errorMsg = "Connection timeout";
    const log = await prisma.webhookLog.create({
      data: {
        webhookId: webhook.id,
        error: errorMsg,
        statusCode: null,
        responseBody: null,
      },
    });

    expect(log).toBeDefined();
    expect(log.error).toBe(errorMsg);
    expect(log.statusCode).toBeNull();
    expect(log.responseBody).toBeNull();

    // Cleanup
    await prisma.webhookLog.deleteMany({ where: { webhookId: webhook.id } });
    await prisma.webhook.delete({ where: { id: webhook.id } });
    await prisma.user.delete({ where: { id: user.id } });
  });

  it("should cascade delete webhook logs when webhook is deleted", async () => {
    const user = await prisma.user.create({
      data: { email: `test-cascade-${Date.now()}@example.com` },
    });

    const webhook = await prisma.webhook.create({
      data: {
        userId: user.id,
        url: "https://example.com/webhook",
        secret: "test-secret",
      },
    });

    // Create multiple logs
    await prisma.webhookLog.create({
      data: { webhookId: webhook.id, statusCode: 200 },
    });
    await prisma.webhookLog.create({
      data: { webhookId: webhook.id, statusCode: 500 },
    });

    const logsBeforeDelete = await prisma.webhookLog.findMany({
      where: { webhookId: webhook.id },
    });
    expect(logsBeforeDelete).toHaveLength(2);

    // Delete webhook
    await prisma.webhook.delete({ where: { id: webhook.id } });

    const logsAfterDelete = await prisma.webhookLog.findMany({
      where: { webhookId: webhook.id },
    });
    expect(logsAfterDelete).toHaveLength(0);

    // Cleanup
    await prisma.user.delete({ where: { id: user.id } });
  });
});
