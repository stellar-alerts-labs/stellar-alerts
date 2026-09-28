'use client';

import { useSession } from 'next-auth/react';
import useSWR from 'swr';
import type {
  DeliveryEventDTO,
  NotificationPreferenceDTO,
  PaymentDTO,
  WalletDTO,
} from '@stellar-alerts/shared';
import { ApiRequestError, fetchApiResponse } from '../adapters/api.adapter';
import { NotificationsAdapter, type UpdatePreferencesInput } from '../adapters/notifications.adapter';
import { PaymentAdapter, type GetPaymentsFilters } from '../adapters/payment.adapter';
import { WalletAdapter } from '../adapters/wallet.adapter';

const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL || 'http://localhost:3001';

export const dashboardSWRConfig = {
  revalidateOnFocus: true,
  revalidateOnReconnect: true,
  shouldRetryOnError: false,
  dedupingInterval: 3000,
} as const;

export interface DeliveryDTO {
  id: string;
  deliveryKey: string | null;
  paymentId: string | null;
  channel: string;
  destination: string | null;
  error: string;
  status: 'pending' | 'retried' | 'suppressed';
  retryCount: number;
  failedAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface DeliveryDetailDTO extends DeliveryDTO {
  auditLogs: Array<{
    id: string;
    deadLetterId: string;
    actorUserId: string | null;
    action: string;
    note: string | null;
    createdAt: string;
  }>;
}

export interface DeliveryListDTO {
  success?: boolean;
  items: DeliveryDTO[];
  pagination: { page: number; pageSize: number; total: number; totalPages: number };
}

export interface DeliveryFilters {
  page?: number;
  pageSize?: number;
  channel?: string;
  status?: string;
  q?: string;
}

function useAccessContext() {
  const { data: session } = useSession();
  return {
    accessToken: session?.accessToken ?? null,
    cacheIdentity: session?.user?.id ?? session?.user?.email ?? null,
  };
}

function apiConfig(accessToken: string) {
  return {
    baseUrl: API_BASE_URL,
    getAuthHeaders: () => ({ Authorization: `Bearer ${accessToken}` }),
  };
}

function queryKey(resource: string, cacheIdentity: string | null, params?: unknown): string | null {
  if (!cacheIdentity) return null;
  return `${resource}:${cacheIdentity}:${params === undefined ? '' : JSON.stringify(params)}`;
}

export const dashboardQueryKeys = {
  wallets: (cacheIdentity: string | null) => queryKey('wallets', cacheIdentity),
  payments: (cacheIdentity: string | null, filters?: GetPaymentsFilters) =>
    queryKey('payments', cacheIdentity, filters ?? {}),
  paymentSummary: (cacheIdentity: string | null) => queryKey('payment-summary', cacheIdentity),
  alertPreferences: (cacheIdentity: string | null) => queryKey('alert-preferences', cacheIdentity),
  deliveries: (cacheIdentity: string | null, filters: DeliveryFilters) =>
    queryKey('deliveries', cacheIdentity, filters),
  delivery: (cacheIdentity: string | null, id: string | null) =>
    id ? queryKey('delivery', cacheIdentity, id) : null,
};

export function useWallets() {
  const { accessToken, cacheIdentity } = useAccessContext();
  const key = dashboardQueryKeys.wallets(cacheIdentity);
  const query = useSWR<WalletDTO[]>(
    key,
    () => new WalletAdapter(apiConfig(accessToken!)).getWallets(),
    dashboardSWRConfig,
  );

  const removeWallet = async (id: string) => {
    if (!accessToken) throw new ApiRequestError('You must be signed in to remove a wallet.', 401);
    await query.mutate(
      async (wallets = []) => {
        await new WalletAdapter(apiConfig(accessToken)).deleteWallet(id);
        return wallets.filter((wallet) => wallet.id !== id);
      },
      {
        optimisticData: (wallets = []) => wallets.filter((wallet) => wallet.id !== id),
        rollbackOnError: true,
        revalidate: false,
      },
    );
  };

  return { ...query, removeWallet };
}

export function usePayments(filters?: GetPaymentsFilters) {
  const { accessToken, cacheIdentity } = useAccessContext();
  const key = dashboardQueryKeys.payments(cacheIdentity, filters);
  const query = useSWR<PaymentDTO[]>(
    key,
    () => new PaymentAdapter(apiConfig(accessToken!)).getPayments(filters),
    { ...dashboardSWRConfig, keepPreviousData: true },
  );

  const addPayment = (payment: PaymentDTO) => query.mutate(
    (payments = []) => payments.some((item) => item.id === payment.id)
      ? payments
      : [payment, ...payments],
    { revalidate: false },
  );

  return { ...query, addPayment };
}

export function usePaymentSummary() {
  const { accessToken, cacheIdentity } = useAccessContext();
  const key = dashboardQueryKeys.paymentSummary(cacheIdentity);
  return useSWR(
    key,
    () => new PaymentAdapter(apiConfig(accessToken!)).getPaymentsSummary(),
    dashboardSWRConfig,
  );
}

type AlertPreferences = NotificationPreferenceDTO | Record<string, never>;

export function useAlertPreferences() {
  const { accessToken, cacheIdentity } = useAccessContext();
  const key = dashboardQueryKeys.alertPreferences(cacheIdentity);
  const query = useSWR<AlertPreferences>(
    key,
    () => new NotificationsAdapter(apiConfig(accessToken!)).getPreferences(),
    dashboardSWRConfig,
  );

  const updateAlertPreferences = async (updates: UpdatePreferencesInput) => {
    if (!accessToken) throw new ApiRequestError('You must be signed in to update alert preferences.', 401);
    await query.mutate(
      async (current) => {
        await new NotificationsAdapter(apiConfig(accessToken)).updatePreferences(updates);
        return { ...current, ...updates } as AlertPreferences;
      },
      {
        optimisticData: (current) => ({ ...current, ...updates }) as AlertPreferences,
        rollbackOnError: true,
      },
    );
  };

  return { ...query, updateAlertPreferences };
}

export function useDeliveries(filters: DeliveryFilters) {
  const { accessToken, cacheIdentity } = useAccessContext();
  const key = dashboardQueryKeys.deliveries(cacheIdentity, filters);
  const query = useSWR<DeliveryListDTO>(
    key,
    async () => {
      const params = new URLSearchParams();
      for (const [name, value] of Object.entries(filters)) {
        if (value !== undefined && value !== '') params.set(name, String(value));
      }
      return fetchApiResponse<DeliveryListDTO>(
        apiConfig(accessToken!),
        `/dead-letters?${params.toString()}`,
      );
    },
    { ...dashboardSWRConfig, keepPreviousData: true },
  );

  const runDeliveryAction = async (id: string, action: 'replay' | 'suppress') => {
    if (!accessToken) throw new ApiRequestError('You must be signed in to update a delivery.', 401);
    await fetchApiResponse<{ success: boolean }>(
      apiConfig(accessToken),
      `/dead-letters/${id}/${action}`,
      { method: 'POST' },
    );
    await query.mutate();
  };

  return { ...query, runDeliveryAction };
}

export function useDelivery(id: string | null) {
  const { accessToken, cacheIdentity } = useAccessContext();
  const key = dashboardQueryKeys.delivery(cacheIdentity, id);
  return useSWR<DeliveryDetailDTO>(
    key,
    () => fetchApiResponse<{ deadLetter: DeliveryDetailDTO }>(
      apiConfig(accessToken!),
      `/dead-letters/${id}`,
    ).then((response) => response.deadLetter),
    dashboardSWRConfig,
  );
}

export type { DeliveryEventDTO };