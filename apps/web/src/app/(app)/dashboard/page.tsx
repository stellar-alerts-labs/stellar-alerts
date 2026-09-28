'use client';

import { useEffect, useRef, useState } from 'react';
import NetworkVisualizer3D from '@/components/dashboard/NetworkVisualizer3D';
import AuditWorkspace from '@/components/dashboard/AuditWorkspace';
import { useSession } from 'next-auth/react';
import type { DeliveryEventDTO } from '@stellar-alerts/shared';
import { WatcherForm } from '@/components/WatcherForm';
import {
  DashboardGrid,
  SummaryStats,
  VolumeChart,
  WebhookSandbox,
  WalletList,
  PaymentTable,
  ActivityHeatmap,
  EmailTemplatePreview,
  type EmailTemplateConfig,
} from '@/components/dashboard';
import {
  useAlertPreferences,
  usePaymentSummary,
  usePayments,
  useWallets,
} from '@/lib/hooks/useDashboardQueries';
import { getSocket } from '@/lib/socket';

export default function DashboardPage() {
  const { data: session } = useSession();
  const [selectedWalletId, setSelectedWalletId] = useState<string | null>(null);
  const [crossLedgerAnalytics] = useState<any>(null);
  const [isStreamConnected, setIsStreamConnected] = useState<boolean>(false);
  const [latestDelivery, setLatestDelivery] = useState<DeliveryEventDTO | null>(null);
  const {
    data: wallets = [],
    error: walletError,
    mutate: mutateWallets,
    removeWallet,
  } = useWallets();
  const {
    data: payments = [],
    error: paymentError,
    isLoading: isLoadingPayments,
    mutate: mutatePayments,
    addPayment,
  } = usePayments(selectedWalletId ? { walletId: selectedWalletId } : undefined);
  const {
    data: summary,
    error: summaryError,
    mutate: mutateSummary,
  } = usePaymentSummary();
  const { updateAlertPreferences } = useAlertPreferences();
  const totalVolumeXLM = summary?.totalVolumeXLM ?? 0;
  const totalPaymentsCount = summary?.totalPayments ?? 0;
  const dashboardError = walletError ?? paymentError ?? summaryError;
  const paymentsRef = useRef(payments);
  const addPaymentRef = useRef(addPayment);

  useEffect(() => {
    paymentsRef.current = payments;
    addPaymentRef.current = addPayment;
  }, [payments, addPayment]);

  const refreshAfterMutation = () => {
    void mutateWallets();
    void mutatePayments();
    void mutateSummary();
  };

  // Kept in a ref (not a dependency) so the payment handler below always
  // reads the current filter without tearing down/reconnecting the socket
  // every time the user switches the selected wallet.
  const selectedWalletIdRef = useRef(selectedWalletId);
  useEffect(() => {
    selectedWalletIdRef.current = selectedWalletId;
  }, [selectedWalletId]);

  // Live payment stream: relays persisted payment events for the signed-in
  // user's own wallets over the authenticated WebSocket (server enforces
  // tenant isolation — see apps/api/src/plugins/websocket.ts).
  useEffect(() => {
    const accessToken = session?.accessToken;
    if (!accessToken) return;

    const socket = getSocket();
    socket.connect(accessToken);

    const unsubscribeConnection = socket.on('connection', (msg) => {
      setIsStreamConnected(msg.payload?.status === 'connected');
    });

    const unsubscribePayment = socket.onPayment((payment) => {
      const currentWalletId = selectedWalletIdRef.current;
      if (currentWalletId && payment.walletId !== currentWalletId) return;
      if (paymentsRef.current.some((existing) => existing.id === payment.id)) return;
      paymentsRef.current = [payment, ...paymentsRef.current];
      void addPaymentRef.current(payment);
      void mutateSummary((current) => current && ({
        totalPayments: current.totalPayments + 1,
        totalVolumeXLM: current.totalVolumeXLM + Number(payment.amount || 0),
      }), { revalidate: false });
    });

    const unsubscribeDelivery = socket.onDelivery((delivery) => {
      setLatestDelivery(delivery);
    });

    return () => {
      unsubscribeConnection();
      unsubscribePayment();
      unsubscribeDelivery();
      socket.disconnect();
      setIsStreamConnected(false);
    };
  }, [session]);

  // Auto-dismiss the live delivery toast after a few seconds.
  useEffect(() => {
    if (!latestDelivery) return;
    const timer = setTimeout(() => setLatestDelivery(null), 6000);
    return () => clearTimeout(timer);
  }, [latestDelivery]);

  const handleRemoveWallet = async (id: string) => {
    try {
      await removeWallet(id);
      if (selectedWalletId === id) setSelectedWalletId(null);
      void mutatePayments();
      void mutateSummary();
    } catch (err) {
      console.error('Failed to remove wallet:', err);
    }
  };

  const handleSaveEmailTemplate = async (template: EmailTemplateConfig) => {
    try {
      await updateAlertPreferences({ emailTemplate: template });
    } catch (err) {
      console.error('Failed to save email template preferences:', err);
    }
  };

  return (
    <div className="space-y-8">
      {dashboardError && (
        <p className="text-sm text-red-400" role="alert">{dashboardError.message}</p>
      )}
      {/* Live webhook delivery toast (populated over the authenticated WebSocket) */}
      {latestDelivery && (
        <div
          data-testid="delivery-toast"
          className="fixed bottom-4 right-4 left-4 sm:left-auto z-[60] max-w-sm px-4 py-3 rounded-xl bg-slate-900/90 border border-slate-700 backdrop-blur-xl shadow-2xl"
        >
          <p className="text-xs font-semibold text-white flex items-center gap-2">
            <span>📬</span> Webhook Delivery
          </p>
          <p className="text-xs text-slate-400 mt-1">
            {latestDelivery.error
              ? `Failed: ${latestDelivery.error}`
              : `Status ${latestDelivery.statusCode ?? 'unknown'}`}
          </p>
        </div>
      )}

      {/* Header Banner */}
      <div className="p-8 rounded-3xl bg-gradient-to-r from-cyan-950/40 via-blue-950/30 to-purple-950/20 border border-cyan-500/20 flex flex-col md:flex-row items-start md:items-center justify-between gap-6 relative overflow-hidden">
        <div className="absolute top-0 right-0 w-96 h-96 bg-cyan-500/10 rounded-full blur-3xl -mr-32 -mt-32 pointer-events-none"></div>
        <div>
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 text-xs font-semibold mb-3">
            <span className="w-2 h-2 rounded-full bg-emerald-400 animate-ping"></span>
            Watcher Service Active
          </div>
          <h1 className="text-3xl font-extrabold text-white tracking-tight">Your Real-Time Wallet Dashboard</h1>
          <p className="text-gray-400 text-sm mt-1 max-w-xl">
            Monitor connected Stellar Testnet addresses, track live incoming transactions, and export recorded payment history.
          </p>
        </div>
      </div>

      {/* Customizable Dashboard Grid */}
      <DashboardGrid
        items={[
          {
            id: 'summary',
            label: 'Summary Overview',
            content: (
              <SummaryStats
                totalPaymentsCount={totalPaymentsCount || payments.length}
                totalVolumeXLM={totalVolumeXLM || payments.reduce((acc, p) => acc + Number(p.amount || 0), 0)}
                activeWalletsCount={wallets.length}
                crossLedgerAnalytics={crossLedgerAnalytics}
              />
            ),
          },
          {
            id: 'volume-chart',
            label: 'Currency Volume',
            content: (
              <VolumeChart
                payments={payments}
                totalVolumeXLM={totalVolumeXLM || payments.reduce((acc, p) => acc + Number(p.amount || 0), 0)}
              />
            ),
          },
          {
            id: 'activity-heatmap',
            label: 'Activity Heatmap',
            content: <ActivityHeatmap payments={payments} />,
          },
          {
            id: 'email-template-preview',
            label: 'Email Receipt Template',
            content: <EmailTemplatePreview onSaveTemplate={handleSaveEmailTemplate} />,
          },
          {
            id: 'webhook-sandbox',
            label: 'Webhook Sandbox',
            content: <WebhookSandbox />,
          },
          {
            id: 'wallets',
            label: 'Monitored Wallets',
            content: (
              <WalletList
                wallets={wallets}
                selectedWalletId={selectedWalletId}
                onSelectWallet={(id) => setSelectedWalletId(id)}
                onRemoveWallet={handleRemoveWallet}
                onOpenAddModal={() => {
                  const el = document.getElementById('add-wallet-section');
                  if (el) el.scrollIntoView({ behavior: 'smooth' });
                }}
              />
            ),
          },
          {
            id: 'watcher-and-payments',
            label: 'Watcher & Payment Ledger',
            content: (
              <div id="add-wallet-section" className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
                <div className="lg:col-span-4 bg-[#0c0c14]/80 backdrop-blur-md rounded-3xl border border-white/10 p-7 shadow-2xl hover:border-cyan-500/30 transition-all duration-500">
                  <WatcherForm onWalletAdded={refreshAfterMutation} isStreamConnected={isStreamConnected} />
                </div>
                <div className="lg:col-span-8">
                  <PaymentTable payments={payments} isLoading={isLoadingPayments} />
                </div>
              </div>
            ),
          },
          {
            id: 'network-visualizer',
            label: 'Live Payment Stream Network',
            content: <NetworkVisualizer3D payments={payments} />,
          },
          {
            id: 'audit-workspace',
            label: 'Collaborative Audit Workspace',
            content: (
              <AuditWorkspace
                payments={payments}
                currentUser={{
                  id: session?.user?.id || session?.user?.email || 'anonymous',
                  name: session?.user?.name || session?.user?.email || 'Auditor',
                }}
              />
            ),
          },
        ]}
      />
    </div>
  );
}