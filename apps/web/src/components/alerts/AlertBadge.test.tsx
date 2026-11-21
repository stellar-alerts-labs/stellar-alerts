import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { AlertBadge } from './AlertBadge';

const alertColors = {
  light: {
    low: ['#dbeafe', '#1e3a8a'],
    medium: ['#fef3c7', '#713f12'],
    high: ['#ffe4e6', '#881337'],
    critical: ['#fee2e2', '#7f1d1d'],
  },
  dark: {
    low: ['#1e3a8a', '#dbeafe'],
    medium: ['#713f12', '#fef3c7'],
    high: ['#881337', '#ffe4e6'],
    critical: ['#7f1d1d', '#fee2e2'],
  },
} as const;

function relativeLuminance(hex: string): number {
  const channels = [0, 1, 2].map((index) => {
    const channel = Number.parseInt(hex.slice(index * 2 + 1, index * 2 + 3), 16) / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });

  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrastRatio(background: string, foreground: string): number {
  const backgroundLuminance = relativeLuminance(background);
  const foregroundLuminance = relativeLuminance(foreground);
  const lighter = Math.max(backgroundLuminance, foregroundLuminance);
  const darker = Math.min(backgroundLuminance, foregroundLuminance);

  return (lighter + 0.05) / (darker + 0.05);
}

describe('AlertBadge', () => {
  it.each(['low', 'medium', 'high', 'critical'] as const)(
    '%s has WCAG AA contrast in light and dark themes',
    (severity) => {
      expect(contrastRatio(...alertColors.light[severity])).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(...alertColors.dark[severity])).toBeGreaterThanOrEqual(4.5);
    },
  );

  it('renders the severity label and semantic classes', () => {
    const { container } = render(<AlertBadge severity="critical" />);
    const badge = container.firstElementChild;

    expect(badge).toHaveTextContent('Critical');
    expect(badge).toHaveClass('bg-alert-critical-bg', 'text-alert-critical-fg');
    expect(badge).toHaveAttribute('data-severity', 'critical');
  });
});
