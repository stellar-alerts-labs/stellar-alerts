import type { ComponentPropsWithoutRef } from 'react';

export type AlertSeverity = 'low' | 'medium' | 'high' | 'critical';

type AlertBadgeProps = ComponentPropsWithoutRef<'span'> & {
  severity: AlertSeverity;
};

const severityLabels: Record<AlertSeverity, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  critical: 'Critical',
};

const severityClasses: Record<AlertSeverity, string> = {
  low: 'bg-alert-low-bg text-alert-low-fg',
  medium: 'bg-alert-medium-bg text-alert-medium-fg',
  high: 'bg-alert-high-bg text-alert-high-fg',
  critical: 'bg-alert-critical-bg text-alert-critical-fg',
};

export function AlertBadge({
  severity,
  className,
  children,
  ...props
}: AlertBadgeProps) {
  const classes = ['inline-flex items-center rounded-full px-2.5 py-1 text-xs font-semibold', severityClasses[severity], className]
    .filter(Boolean)
    .join(' ');

  return (
    <span className={classes} data-severity={severity} {...props}>
      {children ?? severityLabels[severity]}
    </span>
  );
}
