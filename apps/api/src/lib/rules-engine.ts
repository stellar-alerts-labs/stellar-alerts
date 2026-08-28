export interface FilterRule {
  field: 'amount' | 'asset' | 'fromAddress' | 'memo';
  operator: 'gt' | 'gte' | 'lt' | 'lte' | 'eq' | 'ne' | 'contains';
  value: string | number;
}

export interface FilterRuleGroup {
  operator: 'AND' | 'OR';
  rules: (FilterRule | FilterRuleGroup)[];
}

export interface PaymentContext {
  amount: number | string;
  asset: string;
  fromAddress?: string;
  memo?: string | null;
}

export function evaluateRule(rule: FilterRule, context: PaymentContext): boolean {
  const fieldValue = context[rule.field];
  
  // Handle null/undefined values
  if (fieldValue === null || fieldValue === undefined) {
    return false;
  }

  // Convert amount to number for numeric comparisons
  const contextValue = rule.field === 'amount' ? Number(fieldValue) : String(fieldValue);
  const ruleValue = rule.field === 'amount' ? Number(rule.value) : String(rule.value);

  switch (rule.operator) {
    case 'gt':
      return contextValue > ruleValue;
    case 'gte':
      return contextValue >= ruleValue;
    case 'lt':
      return contextValue < ruleValue;
    case 'lte':
      return contextValue <= ruleValue;
    case 'eq':
      return contextValue === ruleValue;
    case 'ne':
      return contextValue !== ruleValue;
    case 'contains':
      return String(contextValue).toLowerCase().includes(String(ruleValue).toLowerCase());
    default:
      throw new Error(`Unknown operator: ${rule.operator}`);
  }
}

export function evaluateRuleGroup(group: FilterRuleGroup, context: PaymentContext): boolean {
  if (group.rules.length === 0) {
    return true; // Empty group means no restrictions
  }

  const results = group.rules.map(rule => {
    if ('operator' in rule && (rule.operator === 'AND' || rule.operator === 'OR')) {
      return evaluateRuleGroup(rule as FilterRuleGroup, context);
    } else {
      return evaluateRule(rule as FilterRule, context);
    }
  });

  return group.operator === 'AND' 
    ? results.every(result => result)
    : results.some(result => result);
}

export function shouldAlert(filterRules: FilterRuleGroup | null, payment: PaymentContext): boolean {
  // If no filter rules are defined, alert on all payments
  if (!filterRules || filterRules.rules.length === 0) {
    return true;
  }

  try {
    return evaluateRuleGroup(filterRules, payment);
  } catch (error) {
    console.error('[RulesEngine] Error evaluating filter rules:', error);
    // Fail open: if rules evaluation fails, still alert to avoid missing payments
    return true;
  }
}

export function createAmountThresholdRule(minAmount: number): FilterRuleGroup {
  return {
    operator: 'AND',
    rules: [
      {
        field: 'amount',
        operator: 'gte',
        value: minAmount,
      },
    ],
  };
}

export function createAssetFilterRule(allowedAssets: string[]): FilterRuleGroup {
  if (allowedAssets.length === 0) {
    return { operator: 'OR', rules: [] };
  }

  if (allowedAssets.length === 1) {
    return {
      operator: 'AND',
      rules: [
        {
          field: 'asset',
          operator: 'eq',
          value: allowedAssets[0],
        },
      ],
    };
  }

  return {
    operator: 'OR',
    rules: allowedAssets.map(asset => ({
      field: 'asset' as const,
      operator: 'eq' as const,
      value: asset,
    })),
  };
}

export function createCombinedFilter(minAmount?: number, allowedAssets?: string[]): FilterRuleGroup {
  const rules: (FilterRule | FilterRuleGroup)[] = [];

  if (minAmount !== undefined && minAmount > 0) {
    rules.push(createAmountThresholdRule(minAmount));
  }

  if (allowedAssets && allowedAssets.length > 0) {
    rules.push(createAssetFilterRule(allowedAssets));
  }

  if (rules.length === 0) {
    return { operator: 'AND', rules: [] };
  }

  if (rules.length === 1) {
    return rules[0] as FilterRuleGroup;
  }

  return {
    operator: 'AND',
    rules,
  };
}