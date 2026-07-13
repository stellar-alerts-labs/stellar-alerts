'use client';

import { useState, useEffect } from 'react';

interface Payment {
  id: string;
  txHash: string;
  fromAddress: string;
  amount: string;
  asset: string;
  createdAt: string;
}

export function PaymentHistory({ walletId }: { walletId: string }) {
  const [payments, setPayments] = useState<Payment[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchPayments = async () => {
      setLoading(true);
      try {
        const res = await fetch(`http://localhost:3001/payments?walletId=${encodeURIComponent(walletId)}`);
        if (res.ok) {
          const data = await res.json();
          if (data.success && data.payments) {
            setPayments(data.payments);
          }
        }
      } catch (e) {
        console.error('Failed to fetch payments', e);
      } finally {
        setLoading(false);
      }
    };

    if (walletId) {
      fetchPayments();
    }
  }, [walletId]);

  if (!walletId) return null;

  return (
    <div className="border p-4 rounded-lg bg-gray-50 dark:bg-gray-800">
      <h2 className="text-xl font-semibold mb-4">Payment History</h2>
      {loading ? (
        <p>Loading payments...</p>
      ) : payments.length === 0 ? (
        <p className="text-gray-500">No payments found for this address.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b dark:border-gray-700">
                <th className="p-2">Date</th>
                <th className="p-2">From</th>
                <th className="p-2">Amount</th>
                <th className="p-2">Asset</th>
                <th className="p-2">Tx Hash</th>
              </tr>
            </thead>
            <tbody>
              {payments.map(p => (
                <tr key={p.id} className="border-b dark:border-gray-700">
                  <td className="p-2">{new Date(p.createdAt).toLocaleDateString()}</td>
                  <td className="p-2 truncate max-w-xs" title={p.fromAddress}>{p.fromAddress}</td>
                  <td className="p-2 font-mono text-green-600 dark:text-green-400">+{p.amount}</td>
                  <td className="p-2">{p.asset}</td>
                  <td className="p-2 truncate max-w-xs" title={p.txHash}>{p.txHash}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
