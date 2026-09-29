'use client';

import { useWallets } from '@/lib/hooks/useDashboardQueries';

export function WatchList({ onSelect }: { onSelect?: (walletId: string) => void }) {
  const { data: watches = [], error, isLoading } = useWallets();

  if (isLoading) {
    return <div className="mt-6 text-gray-500">Loading watched addresses...</div>;
  }

  if (error) {
    return <div className="mt-6 text-red-400" role="alert">{error.message}</div>;
  }

  if (watches.length === 0) {
    return <div className="mt-6 text-gray-500">No watched addresses found.</div>;
  }

  return (
    <div className="mt-8 space-y-4 max-w-2xl">
      <h2 className="text-xl font-bold">Your Wallets</h2>
      <div className="bg-white dark:bg-gray-800 shadow overflow-hidden sm:rounded-md border border-gray-200 dark:border-gray-700">
        <ul className="divide-y divide-gray-200 dark:divide-gray-700">
          {watches.map((watch) => (
            <li 
              key={watch.id}
              className={onSelect ? 'cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors' : ''}
              onClick={() => onSelect?.(watch.id)}
            >
              <div className="px-4 py-4 sm:px-6 flex justify-between items-center">
                <div>
                  <p className="text-sm font-medium text-blue-600 dark:text-blue-400 truncate">
                    {watch.label || watch.publicKey}
                  </p>
                  <p className="mt-2 flex items-center text-sm text-gray-500 dark:text-gray-400">
                    Added: {new Date(watch.createdAt).toLocaleDateString()}
                  </p>
                </div>
                <div className="ml-2 flex-shrink-0 flex">
                  <p className="px-2 inline-flex text-xs leading-5 font-semibold rounded-full bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200">
                    active
                  </p>
                </div>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
