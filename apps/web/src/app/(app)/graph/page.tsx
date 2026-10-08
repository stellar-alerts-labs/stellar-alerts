'use client';

import { useCallback, useEffect, useState } from 'react';
import { useSession } from 'next-auth/react';
import { PaymentDTO, WalletDTO } from '@stellar-alerts/shared';
import TransactionGraphExplorer from '@/components/dashboard/TransactionGraphExplorer';
import { useBatchReader } from '@/lib/hooks/useBatchReader';
import { connectSocket } from '@/lib/socket';

export default function GraphPage() {
  const { data: session } = useSession();
  const batchReader = useBatchReader();
  const [wallets, setWallets] = useState<WalletDTO[]>([]);
  const [payments, setPayments] = useState<PaymentDTO[]>([]);

  const load = useCallback(async () => {
    if (!session) return;
    try {
      const data = await batchReader.fetchUserPortfolioBatched();
      setWallets(data.wallets);
      setPayments(data.payments);
    } catch (err) {
      console.error('Failed to load graph data:', err);
    }
  }, [session, batchReader]);

  useEffect(() => {
    if (session) void load();
  }, [session, load]);

  useEffect(() => {
    const token = (session as { accessToken?: string } | null)?.accessToken;
    if (token) connectSocket(token);
  }, [session]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-extrabold text-white tracking-tight">Transaction Graph Explorer</h1>
        <p className="mt-1 text-slate-400">
          Live map of address clusters, payment hops, DEX pool routes and counterparties around your watched wallets.
        </p>
      </div>
      <TransactionGraphExplorer wallets={wallets} payments={payments} />
    </div>
  );
}
