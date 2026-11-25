'use client';

import { useMemo } from 'react';
import {
  useRelativeTicker,
  formatRelativeTime,
} from '@/hooks/useRelativeTicker';

export interface RelativeTimeProps {
  /** Past timestamp to render relatively. Accepts Date, ISO string, or epoch ms. */
  timestamp: Date | string | number;
  className?: string;
}

function toUtcString(timestamp: Date | string | number): string {
  const date = timestamp instanceof Date ? timestamp : new Date(timestamp);
  return date.toISOString();
}

export function RelativeTime({ timestamp, className }: RelativeTimeProps) {
  // tick increments every 10s via the shared interval — including it in the
  // memo dep array ensures the relative string is recomputed on every tick.
  const tick = useRelativeTicker();

  const isoString = useMemo(() => toUtcString(timestamp), [timestamp]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const relative = useMemo(() => formatRelativeTime(timestamp), [timestamp, tick]);

  return (
    <time dateTime={isoString} title={isoString} className={className}>
      {relative}
    </time>
  );
}

export default RelativeTime;
