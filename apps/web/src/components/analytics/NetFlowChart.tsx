'use client';

import React, { useRef, useEffect, useMemo, useState } from 'react';

export interface NetFlowDay {
  date: string;
  inflow: number;
  outflow: number;
  netChange: number;
}

export interface NetFlowChartProps {
  data: NetFlowDay[];
  walletTags?: string[];
  selectedTags?: string[];
  startDate?: Date;
  endDate?: Date;
  height?: number | string;
}

const INFLOW_COLOR = '#22c55e'; // Green
const OUTFLOW_COLOR = '#ef4444'; // Red
const NET_POSITIVE_COLOR = '#10b981'; // Emerald
const NET_NEGATIVE_COLOR = '#f87171'; // Light red

export const NetFlowChart: React.FC<NetFlowChartProps> = ({
  data,
  height = 400,
  selectedTags,
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const [tooltipPos, setTooltipPos] = useState<{ x: number; y: number } | null>(null);

  // Calculate chart dimensions and scale
  const chartConfig = useMemo(() => {
    if (data.length === 0) return null;

    const maxAbsValue = Math.max(
      ...data.map((d) => Math.abs(d.inflow)),
      ...data.map((d) => Math.abs(d.outflow))
    );

    return {
      padding: { top: 20, right: 20, bottom: 60, left: 60 },
      maxValue: maxAbsValue * 1.15,
      barWidth: Math.max(6, 200 / Math.max(data.length, 1)),
      barGap: 2,
      dataCount: data.length,
    };
  }, [data]);

  // Main canvas render
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !chartConfig) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = typeof height === 'number' ? height : canvas.clientHeight || 400;

    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
      canvas.width = w * dpr;
      canvas.height = h * dpr;
    }

    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);

    // Background
    ctx.fillStyle = '#0f172a';
    ctx.fillRect(0, 0, w, h);

    const { padding, maxValue, barWidth, barGap, dataCount } = chartConfig;
    const chartWidth = w - padding.left - padding.right;
    const chartHeight = h - padding.top - padding.bottom;

    // Draw grid and axes
    ctx.strokeStyle = '#334155';
    ctx.lineWidth = 1;
    ctx.fillStyle = '#94a3b8';
    ctx.font = '12px monospace';
    ctx.textAlign = 'center';

    // Y-axis scale labels
    const gridLines = 5;
    for (let i = 0; i <= gridLines; i++) {
      const y = padding.top + (chartHeight / gridLines) * i;
      const value = maxValue * (1 - i / gridLines);

      // Grid line
      ctx.strokeStyle = '#1e293b';
      ctx.beginPath();
      ctx.moveTo(padding.left, y);
      ctx.lineTo(w - padding.right, y);
      ctx.stroke();

      // Label
      ctx.fillStyle = '#64748b';
      ctx.textAlign = 'right';
      ctx.fillText(
        value > 1000000 ? `${(value / 1000000).toFixed(1)}M` :
        value > 1000 ? `${(value / 1000).toFixed(0)}K` :
        value.toFixed(0),
        padding.left - 10,
        y + 4
      );
    }

    // Centerline (zero)
    const zeroY = padding.top + chartHeight;
    ctx.strokeStyle = '#475569';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(padding.left, zeroY);
    ctx.lineTo(w - padding.right, zeroY);
    ctx.stroke();

    // X-axis label
    ctx.fillStyle = '#64748b';
    ctx.textAlign = 'center';
    ctx.font = '11px monospace';
    ctx.fillText('Date', w / 2, h - 10);

    // Draw bars
    const totalBarWidth = (barWidth + barGap) * 2; // inflow + outflow pairs
    const xSpacing = (chartWidth - totalBarWidth) / Math.max(dataCount - 1, 1);

    data.forEach((day, idx) => {
      const x = padding.left + (xSpacing * idx);

      // Inflow bar (positive, goes up)
      const inflowHeight = (day.inflow / maxValue) * chartHeight;
      ctx.fillStyle = hoveredIndex === idx ? '#4ade80' : INFLOW_COLOR;
      ctx.globalAlpha = hoveredIndex === null || hoveredIndex === idx ? 1 : 0.3;
      ctx.fillRect(x, zeroY - inflowHeight, barWidth, inflowHeight);

      // Outflow bar (negative, goes down)
      const outflowHeight = (day.outflow / maxValue) * chartHeight;
      ctx.fillStyle = hoveredIndex === idx ? '#f87171' : OUTFLOW_COLOR;
      ctx.globalAlpha = hoveredIndex === null || hoveredIndex === idx ? 1 : 0.3;
      ctx.fillRect(x + barWidth + barGap, zeroY, barWidth, outflowHeight);

      ctx.globalAlpha = 1;

      // X-axis date labels (every nth label to avoid crowding)
      if (idx % Math.ceil(dataCount / 6) === 0 || idx === dataCount - 1) {
        ctx.fillStyle = '#64748b';
        ctx.textAlign = 'center';
        ctx.font = '11px monospace';
        const dateObj = new Date(day.date);
        const label = dateObj.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        ctx.fillText(label, x + barWidth / 2 + barGap / 2, zeroY + 15);
      }

      // Hover highlight box
      if (hoveredIndex === idx) {
        ctx.strokeStyle = '#38bdf8';
        ctx.lineWidth = 2;
        ctx.globalAlpha = 0.4;
        ctx.fillStyle = '#0284c7';
        ctx.fillRect(x - 5, padding.top - 5, totalBarWidth + 10, chartHeight + 10);
        ctx.globalAlpha = 1;
        ctx.strokeRect(x - 5, padding.top - 5, totalBarWidth + 10, chartHeight + 10);
      }
    });

    ctx.restore();
  }, [data, chartConfig, height, hoveredIndex]);

  // Mouse interaction for hover
  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!chartConfig || data.length === 0) return;

    const canvas = canvasRef.current;
    if (!canvas) return;

    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    const { padding, barWidth, barGap } = chartConfig;
    const chartWidth = canvas.clientWidth - padding.left - padding.right;
    const dataCount = data.length;
    const totalBarWidth = (barWidth + barGap) * 2;
    const xSpacing = (chartWidth - totalBarWidth) / Math.max(dataCount - 1, 1);

    let hoveredIdx: number | null = null;
    for (let idx = 0; idx < dataCount; idx++) {
      const barX = padding.left + xSpacing * idx;
      if (x >= barX - 5 && x <= barX + totalBarWidth + 5) {
        hoveredIdx = idx;
        setTooltipPos({ x: e.clientX - rect.left, y: e.clientY - rect.top });
        break;
      }
    }

    setHoveredIndex(hoveredIdx);
  };

  const handleMouseLeave = () => {
    setHoveredIndex(null);
    setTooltipPos(null);
  };

  const hoveredDay = hoveredIndex !== null ? data[hoveredIndex] : null;

  return (
    <div
      ref={containerRef}
      className="relative w-full rounded-xl border border-slate-800 bg-slate-950 overflow-hidden shadow-lg"
      style={{ height }}
    >
      <canvas
        ref={canvasRef}
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
        className="w-full h-full cursor-crosshair"
      />

      {/* Legend */}
      <div className="absolute top-4 left-4 z-10 flex gap-6 bg-slate-900/80 backdrop-blur-md px-4 py-2.5 rounded-lg border border-slate-800">
        <div className="flex items-center gap-2">
          <div className="w-3 h-3 rounded-sm" style={{ backgroundColor: INFLOW_COLOR }} />
          <span className="text-xs font-medium text-slate-300">Inflow</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-3 h-3 rounded-sm" style={{ backgroundColor: OUTFLOW_COLOR }} />
          <span className="text-xs font-medium text-slate-300">Outflow</span>
        </div>
      </div>

      {/* Crosshair Tooltip */}
      {hoveredDay && tooltipPos && (
        <div
          className="absolute z-20 pointer-events-none"
          style={{
            left: tooltipPos.x,
            top: tooltipPos.y,
          }}
        >
          {/* Vertical line */}
          <div
            className="absolute top-0 w-px h-screen bg-sky-400/30"
            style={{
              left: 0,
              bottom: 0,
            }}
          />
          {/* Horizontal line */}
          <div
            className="absolute left-0 h-px w-screen bg-sky-400/30"
            style={{
              top: 0,
              right: 0,
            }}
          />

          {/* Tooltip box */}
          <div className="absolute top-2 left-2 bg-slate-900/95 border border-slate-700 rounded-lg p-3 shadow-xl backdrop-blur-md whitespace-nowrap">
            <div className="text-xs font-semibold text-slate-200 mb-2">
              {new Date(hoveredDay.date).toLocaleDateString('en-US', {
                month: 'short',
                day: 'numeric',
                year: 'numeric',
              })}
            </div>
            <div className="flex flex-col gap-1 text-xs text-slate-300">
              <div className="flex justify-between gap-4">
                <span className="text-emerald-400">Inflow:</span>
                <span className="font-mono font-semibold">
                  {hoveredDay.inflow.toLocaleString()}
                </span>
              </div>
              <div className="flex justify-between gap-4">
                <span className="text-red-400">Outflow:</span>
                <span className="font-mono font-semibold">
                  {hoveredDay.outflow.toLocaleString()}
                </span>
              </div>
              <div className="border-t border-slate-700 mt-1 pt-1 flex justify-between gap-4">
                <span className="text-slate-400">Net:</span>
                <span
                  className="font-mono font-semibold"
                  style={{
                    color: hoveredDay.netChange >= 0 ? NET_POSITIVE_COLOR : NET_NEGATIVE_COLOR,
                  }}
                >
                  {hoveredDay.netChange >= 0 ? '+' : ''}{hoveredDay.netChange.toLocaleString()}
                </span>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default NetFlowChart;
