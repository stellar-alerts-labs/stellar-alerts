// Dynamic fee threshold alert filter rules engine
// Evaluates user-defined filter conditions against payment data

export type RuleOperator = 'gt' | 'lt' | 'gte' | 'lte' | 'eq' | 'neq';
export type RuleLogic = 'AND' | 'OR';

export interface FilterRule {
  field: 'amount' | 'asset' | 'fromAddress';
  operator: RuleOperator;
  value: string | number;
}

export interface AlertFilterConfig {
  logic: RuleLogic; // 'AND' = all rules must match, 'OR' = any rule must match
  rules: FilterRule[];
}

export interface PaymentContext {
  amount: number;
  asset: string;
  fromAddress: string;
}

/**
 * Evaluates a single filter rule against a payment context.
 * Numeric operators (gt, lt, gte, lte) only apply when both the field value
 * and the rule value are numeric; for string fields they fall back to
 * lexicographic comparison.
 */
function evaluateRule(payment: PaymentContext, rule: FilterRule): boolean {
  const fieldValue = payment[rule.field];

  switch (rule.operator) {
    case 'eq':
      // Loose equality: compare as strings for string fields, numbers for amount
      if (rule.field === 'amount') {
        return Number(fieldValue) === Number(rule.value);
      }
      return String(fieldValue) === String(rule.value);

    case 'neq':
      if (rule.field === 'amount') {
        return Number(fieldValue) !== Number(rule.value);
      }
      return String(fieldValue) !== String(rule.value);

    case 'gt':
      return Number(fieldValue) > Number(rule.value);

    case 'lt':
      return Number(fieldValue) < Number(rule.value);

    case 'gte':
      return Number(fieldValue) >= Number(rule.value);

    case 'lte':
      return Number(fieldValue) <= Number(rule.value);

    default:
      // Unknown operator — conservatively pass the rule (don't suppress)
      console.warn(`[RulesEngine] Unknown operator "${rule.operator}", passing rule by default`);
      return true;
  }
}

/**
 * Evaluates whether a payment passes all configured filter rules.
 *
 * - Returns `true`  if the alert SHOULD be sent (payment passes the filter).
 * - Returns `false` if the alert SHOULD be suppressed (payment fails the filter).
 *
 * An empty rules array always passes (no suppression).
 */
export function evaluateAlertRules(
  payment: PaymentContext,
  config: AlertFilterConfig
): boolean {
  const { logic, rules } = config;

  if (!rules || rules.length === 0) {
    return true;
  }

  if (logic === 'AND') {
    // All rules must match for the alert to be sent
    return rules.every((rule) => evaluateRule(payment, rule));
  }

  // OR: at least one rule must match for the alert to be sent
  return rules.some((rule) => evaluateRule(payment, rule));
}
