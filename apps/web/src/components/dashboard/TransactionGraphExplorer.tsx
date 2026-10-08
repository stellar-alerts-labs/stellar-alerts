'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { PaymentDTO, WalletDTO } from '@stellar-alerts/shared';
import { getSocket } from '@/lib/socket';
import { GraphNode, TransactionGraph, clusterColor, shortAddress } from '@/lib/graph/forceGraph';

interface Props {
  wallets: WalletDTO[];
  payments: PaymentDTO[];
  height?: number;
}

interface View {
  x: number;
  y: number;
  scale: number;
}

const KIND_LABEL: Record<GraphNode['kind'], string> = {
  wallet: 'Watched wallet',
  account: 'Counterparty',
  pool: 'DEX pool / contract',
};

export default function TransactionGraphExplorer({ wallets, payments, height = 560 }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const graph = useMemo(() => new TransactionGraph(400), []);
  const viewRef = useRef<View>({ x: 0, y: 0, scale: 1 });
  const hoverRef = useRef<GraphNode | null>(null);
  const dragRef = useRef<{ node: GraphNode | null; panning: boolean; lastX: number; lastY: number }>({
    node: null,
    panning: false,
    lastX: 0,
    lastY: 0,
  });
  const pulses = useRef<Map<string, number>>(new Map());
  const walletById = useMemo(() => new Map(wallets.map((w) => [w.id, w.publicKey] as const)), [wallets]);
  const walletByIdRef = useRef(walletById);

  const [live, setLive] = useState(false);
  const [paused, setPaused] = useState(false);
  const pausedRef = useRef(false);
  const [stats, setStats] = useState({ nodes: 0, edges: 0, clusters: 0 });
  const [hovered, setHovered] = useState<GraphNode | null>(null);

  useEffect(() => {
    pausedRef.current = paused;
  }, [paused]);

  useEffect(() => {
    walletByIdRef.current = walletById;
  }, [walletById]);

  const ingest = (payment: PaymentDTO, isLive: boolean) => {
    const to = walletByIdRef.current.get(payment.walletId);
    if (!to) return;
    const added = graph.addPayment({
      txHash: payment.txHash,
      from: payment.fromAddress,
      to,
      amount: Number(payment.amount) || 0,
      asset: payment.asset,
      at: new Date(payment.receivedAt).getTime(),
    });
    if (added && isLive) {
      pulses.current.set(payment.fromAddress, performance.now());
      pulses.current.set(to, performance.now());
    }
  };

  // Seed with historical payments.
  useEffect(() => {
    graph.setWalletAddresses(wallets.map((w) => w.publicKey));
    for (const p of payments) ingest(p, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wallets, payments]);

  // Real-time stream.
  useEffect(() => {
    const socket = getSocket();
    setLive(socket.isConnected);
    const offConn = socket.on('connection', (m) => setLive(m.payload?.status === 'connected'));
    const offPay = socket.onPayment((p) => {
      if (!pausedRef.current) ingest(p, true);
    });
    return () => {
      offConn();
      offPay();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graph]);

  // Render + simulation loop.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let raf = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let lastStats = 0;
    let idle = 0;
    let stopped = false;

    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      const rect = canvas.getBoundingClientRect();
      canvas.width = rect.width * dpr;
      canvas.height = rect.height * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    window.addEventListener('resize', resize);

    const radius = (n: GraphNode) =>
      5 + Math.min(12, Math.log10(1 + n.volume) * 2.2) + (n.kind === 'wallet' ? 3 : 0);

    const draw = (now: number) => {
      if (stopped) return;
      const rect = canvas.getBoundingClientRect();
      const { x, y, scale } = viewRef.current;
      const energy = graph.step();
      idle = energy < 0.05 ? idle + 1 : 0;

      ctx.clearRect(0, 0, rect.width, rect.height);
      ctx.save();
      ctx.translate(rect.width / 2 + x, rect.height / 2 + y);
      ctx.scale(scale, scale);

      for (const e of graph.edges.values()) {
        const s = graph.nodes.get(e.source);
        const t = graph.nodes.get(e.target);
        if (!s || !t) continue;
        const age = Math.min(1, (Date.now() - e.lastSeen) / 60000);
        ctx.strokeStyle = `rgba(148,163,184,${0.55 - age * 0.35})`;
        ctx.lineWidth = Math.min(4, 0.8 + Math.log2(1 + e.count)) / scale;
        ctx.beginPath();
        ctx.moveTo(s.x, s.y);
        ctx.lineTo(t.x, t.y);
        ctx.stroke();

        // Direction arrow at the receiving end.
        const dx = t.x - s.x;
        const dy = t.y - s.y;
        const len = Math.hypot(dx, dy) || 1;
        const r = radius(t) + 2;
        const ax = t.x - (dx / len) * r;
        const ay = t.y - (dy / len) * r;
        const ang = Math.atan2(dy, dx);
        const sz = 6 / scale;
        ctx.fillStyle = 'rgba(148,163,184,0.8)';
        ctx.beginPath();
        ctx.moveTo(ax, ay);
        ctx.lineTo(ax - sz * Math.cos(ang - 0.4), ay - sz * Math.sin(ang - 0.4));
        ctx.lineTo(ax - sz * Math.cos(ang + 0.4), ay - sz * Math.sin(ang + 0.4));
        ctx.closePath();
        ctx.fill();
      }

      for (const n of graph.nodes.values()) {
        const r = radius(n);
        const pulseAt = pulses.current.get(n.id);
        if (pulseAt !== undefined) {
          const t = (now - pulseAt) / 1200;
          if (t < 1) {
            ctx.strokeStyle = `rgba(250,250,250,${1 - t})`;
            ctx.lineWidth = 2 / scale;
            ctx.beginPath();
            ctx.arc(n.x, n.y, r + t * 22, 0, Math.PI * 2);
            ctx.stroke();
            idle = 0;
          } else {
            pulses.current.delete(n.id);
          }
        }

        ctx.fillStyle = clusterColor(n.cluster);
        ctx.beginPath();
        if (n.kind === 'pool') {
          ctx.rect(n.x - r, n.y - r, r * 2, r * 2);
        } else {
          ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
        }
        ctx.fill();
        if (n.kind === 'wallet' || hoverRef.current === n) {
          ctx.strokeStyle = '#fff';
          ctx.lineWidth = 2 / scale;
          ctx.stroke();
        }
        if (scale > 0.8 && (n.kind === 'wallet' || hoverRef.current === n)) {
          ctx.fillStyle = '#e2e8f0';
          ctx.font = `${11 / scale}px ui-monospace, monospace`;
          ctx.textAlign = 'center';
          ctx.fillText(shortAddress(n.id), n.x, n.y - r - 5 / scale);
        }
      }
      ctx.restore();

      if (now - lastStats > 500) {
        lastStats = now;
        setStats((prev) => {
          const next = { nodes: graph.nodes.size, edges: graph.edges.size, clusters: graph.clusterCount() };
          return prev.nodes === next.nodes && prev.edges === next.edges && prev.clusters === next.clusters
            ? prev
            : next;
        });
      }

      // Throttle once the layout has settled to save CPU; activity resets `idle`.
      if (idle > 120) {
        timer = setTimeout(() => {
          raf = requestAnimationFrame(draw);
        }, 250);
      } else {
        raf = requestAnimationFrame(draw);
      }
    };
    raf = requestAnimationFrame(draw);

    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
      if (timer) clearTimeout(timer);
      window.removeEventListener('resize', resize);
    };
  }, [graph]);

  const toWorld = (clientX: number, clientY: number) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    const { x, y, scale } = viewRef.current;
    return {
      x: (clientX - rect.left - rect.width / 2 - x) / scale,
      y: (clientY - rect.top - rect.height / 2 - y) / scale,
    };
  };

  const pick = (clientX: number, clientY: number): GraphNode | null => {
    const p = toWorld(clientX, clientY);
    let best: GraphNode | null = null;
    let bestDist = Infinity;
    for (const n of graph.nodes.values()) {
      const d = Math.hypot(n.x - p.x, n.y - p.y);
      if (d < 16 && d < bestDist) {
        best = n;
        bestDist = d;
      }
    }
    return best;
  };

  const onPointerDown = (e: React.PointerEvent) => {
    (e.target as Element).setPointerCapture(e.pointerId);
    const node = pick(e.clientX, e.clientY);
    dragRef.current = { node, panning: !node, lastX: e.clientX, lastY: e.clientY };
    if (node) node.fixed = true;
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const drag = dragRef.current;
    if (drag.node) {
      const p = toWorld(e.clientX, e.clientY);
      drag.node.x = p.x;
      drag.node.y = p.y;
    } else if (drag.panning) {
      viewRef.current.x += e.clientX - drag.lastX;
      viewRef.current.y += e.clientY - drag.lastY;
      drag.lastX = e.clientX;
      drag.lastY = e.clientY;
    } else {
      const node = pick(e.clientX, e.clientY);
      if (node !== hoverRef.current) {
        hoverRef.current = node;
        setHovered(node);
      }
    }
  };

  const onPointerUp = () => {
    if (dragRef.current.node) dragRef.current.node.fixed = false;
    dragRef.current = { node: null, panning: false, lastX: 0, lastY: 0 };
  };

  const onWheel = (e: React.WheelEvent) => {
    const factor = e.deltaY < 0 ? 1.1 : 0.9;
    viewRef.current.scale = Math.min(4, Math.max(0.2, viewRef.current.scale * factor));
  };

  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-950/60 p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3 text-xs text-slate-400">
          <span className="inline-flex items-center gap-1.5">
            <span className={`h-2 w-2 rounded-full ${live ? 'bg-emerald-400' : 'bg-slate-600'}`} />
            {live ? 'Live stream' : 'Stream offline'}
          </span>
          <span>{stats.nodes} nodes</span>
          <span>{stats.edges} hops</span>
          <span>{stats.clusters} clusters</span>
        </div>
        <button
          type="button"
          onClick={() => setPaused((p) => !p)}
          className="rounded-lg border border-slate-700 px-3 py-1 text-xs text-slate-200 hover:bg-slate-800"
        >
          {paused ? 'Resume stream' : 'Pause stream'}
        </button>
      </div>

      <div className="relative">
        <canvas
          ref={canvasRef}
          role="img"
          aria-label="Force-directed transaction graph of watched wallets and counterparties"
          className="w-full cursor-grab touch-none rounded-xl bg-slate-950 active:cursor-grabbing"
          style={{ height }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerLeave={onPointerUp}
          onWheel={onWheel}
        />
        {hovered && (
          <div className="pointer-events-none absolute left-3 top-3 max-w-xs rounded-lg border border-slate-700 bg-slate-900/95 p-3 text-xs text-slate-200">
            <div className="font-mono break-all">{hovered.id}</div>
            <div className="mt-1 text-slate-400">{KIND_LABEL[hovered.kind]}</div>
            <div className="mt-1">Connections: {hovered.degree}</div>
            <div>Volume: {hovered.volume.toLocaleString(undefined, { maximumFractionDigits: 2 })}</div>
          </div>
        )}
      </div>

      <div className="mt-3 flex flex-wrap gap-4 text-xs text-slate-400">
        <span>Circle: account</span>
        <span>Square: DEX pool / contract</span>
        <span>White ring: watched wallet</span>
        <span>Colour: address cluster</span>
        <span>Drag nodes, scroll to zoom, drag background to pan</span>
      </div>
    </div>
  );
}
