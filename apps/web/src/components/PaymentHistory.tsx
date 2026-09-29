'use client';

import { PaymentTable } from './dashboard/PaymentTable';
import { usePayments } from '@/lib/hooks/useDashboardQueries';

export function PaymentHistory({ walletId }: { walletId: string }) {
  const { data: payments = [], error, isLoading } = usePayments({ walletId });

  if (!walletId) return null;

  return (
    <>
      {error && <p className="text-sm text-red-400" role="alert">{error.message}</p>}
      <PaymentTable payments={payments} isLoading={isLoading} />
    </>
  );
}

