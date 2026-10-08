import { prisma } from '../lib/prisma';
import { FilterRuleGroup } from '../lib/rules-engine';

export interface CreateAlertRuleDto {
  userId: string;
  walletId?: string | null;
  name?: string | null;
  assets?: string[];
  minAmount?: number | string | null;
  maxAmount?: number | string | null;
  memo?: string | null;
  channels?: string[];
  conditions?: FilterRuleGroup | any | null;
  isActive?: boolean;
}

export interface UpdateAlertRuleDto {
  name?: string | null;
  walletId?: string | null;
  assets?: string[];
  minAmount?: number | string | null;
  maxAmount?: number | string | null;
  memo?: string | null;
  channels?: string[];
  conditions?: FilterRuleGroup | any | null;
  isActive?: boolean;
  expectedVersion?: number;
}

export class AlertRuleRepository {
  /**
   * Create a new versioned AlertRule linked to a user and optional wallet.
   */
  async createRule(data: CreateAlertRuleDto) {
    return (prisma as any).alertRule.create({
      data: {
        userId: data.userId,
        walletId: data.walletId ?? null,
        name: data.name ?? null,
        assets: data.assets ?? [],
        minAmount: data.minAmount !== undefined && data.minAmount !== null ? String(data.minAmount) : null,
        maxAmount: data.maxAmount !== undefined && data.maxAmount !== null ? String(data.maxAmount) : null,
        memo: data.memo ?? null,
        channels: data.channels ?? [],
        conditions: data.conditions ?? null,
        isActive: data.isActive ?? true,
        version: 1,
      },
    });
  }

  /**
   * List all alert rules for a specific user, with optional filters.
   */
  async findRulesByUserId(
    userId: string,
    filter?: { isActive?: boolean; walletId?: string }
  ) {
    const where: any = { userId };
    if (filter?.isActive !== undefined) {
      where.isActive = filter.isActive;
    }
    if (filter?.walletId !== undefined) {
      where.walletId = filter.walletId;
    }

    return (prisma as any).alertRule.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: {
        wallet: {
          select: {
            id: true,
            publicKey: true,
            label: true,
          },
        },
      },
    });
  }

  /**
   * Find an alert rule by ID, optionally verifying ownership.
   */
  async findRuleById(id: string, userId?: string) {
    const where: any = { id };
    if (userId) {
      where.userId = userId;
    }
    return (prisma as any).alertRule.findFirst({
      where,
      include: {
        wallet: true,
      },
    });
  }

  /**
   * Update an alert rule with automatic version increment and optional optimistic concurrency.
   */
  async updateRule(id: string, userId: string, data: UpdateAlertRuleDto) {
    const existing = await (prisma as any).alertRule.findFirst({
      where: { id, userId },
    });

    if (!existing) {
      throw new Error('Alert rule not found or unauthorized');
    }

    if (data.expectedVersion !== undefined && existing.version !== data.expectedVersion) {
      throw new Error(`Concurrency conflict: expected version ${data.expectedVersion} but rule is at version ${existing.version}`);
    }

    const updateData: any = {
      version: { increment: 1 },
    };

    if (data.name !== undefined) updateData.name = data.name;
    if (data.walletId !== undefined) {
      updateData.wallet = data.walletId ? { connect: { id: data.walletId } } : { disconnect: true };
    }
    if (data.assets !== undefined) updateData.assets = data.assets;
    if (data.minAmount !== undefined) {
      updateData.minAmount = data.minAmount !== null ? String(data.minAmount) : null;
    }
    if (data.maxAmount !== undefined) {
      updateData.maxAmount = data.maxAmount !== null ? String(data.maxAmount) : null;
    }
    if (data.memo !== undefined) updateData.memo = data.memo;
    if (data.channels !== undefined) updateData.channels = data.channels;
    if (data.conditions !== undefined) {
      updateData.conditions = data.conditions;
    }
    if (data.isActive !== undefined) updateData.isActive = data.isActive;

    return (prisma as any).alertRule.update({
      where: { id },
      data: updateData,
    });
  }

  /**
   * Delete an alert rule scoped to user.
   */
  async deleteRule(id: string, userId: string) {
    const existing = await (prisma as any).alertRule.findFirst({
      where: { id, userId },
    });
    if (!existing) {
      throw new Error('Alert rule not found or unauthorized');
    }

    return (prisma as any).alertRule.delete({
      where: { id },
    });
  }

  /**
   * Toggle active state of a rule.
   */
  async toggleRuleActive(id: string, userId: string, isActive: boolean) {
    return this.updateRule(id, userId, { isActive });
  }

  /**
   * Find candidate active rules for a wallet payment event.
   */
  async findActiveRulesForPayment(walletId: string, asset: string, amount: number | string, memo?: string | null) {
    const rules = await (prisma as any).alertRule.findMany({
      where: {
        isActive: true,
        OR: [{ walletId }, { walletId: null }],
      },
    });

    const numAmount = Number(amount);

    return rules.filter((rule: any) => {
      // Asset filter
      if (rule.assets && rule.assets.length > 0 && !rule.assets.includes(asset)) {
        return false;
      }
      // Min amount filter
      if (rule.minAmount !== null && rule.minAmount !== undefined && numAmount < Number(rule.minAmount)) {
        return false;
      }
      // Max amount filter
      if (rule.maxAmount !== null && rule.maxAmount !== undefined && numAmount > Number(rule.maxAmount)) {
        return false;
      }
      // Memo filter
      if (rule.memo && (!memo || !memo.toLowerCase().includes(rule.memo.toLowerCase()))) {
        return false;
      }
      return true;
    });
  }

  /**
   * Migration helper: migrate legacy JSON filterRules from NotificationPreference
   * into a first-class versioned AlertRule.
   */
  async migrateLegacyFilterRulesToAlertRules(userId: string) {
    // Check if user already has alert rules
    const existingRules = await (prisma as any).alertRule.count({ where: { userId } });
    if (existingRules > 0) {
      return null; // Already migrated or has first-class rules
    }

    const pref = await (prisma as any).notificationPreference.findUnique({
      where: { userId },
    });

    if (!pref || !pref.filterRules) {
      return null;
    }

    const filterGroup = pref.filterRules as unknown as FilterRuleGroup;
    const rule = await this.createRule({
      userId,
      name: 'Migrated Legacy Filters',
      conditions: filterGroup as any,
      isActive: true,
    });

    return rule;
  }
}

export const alertRuleRepository = new AlertRuleRepository();
