'use client';

import { useEffect, useState } from 'react';

type WatchItem = {
  id: string;
  address: string;
  status: string;
  createdAt: string;
};

export function WatchList() {
  const [watches, setWatches] = useState<WatchItem[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchWatches = async () => {
      setLoading(true);
      try {
        const res = await fetch('http://localhost:3001/payments/watches');
        if (res.ok) {
          const data = await res.json();
          if (data.success && data.watches) {
            setWatches(data.watches);
          }
        }
      } catch (e) {
        console.error('Failed to fetch watches', e);
      } finally {
        setLoading(false);
      }
    };

    fetchWatches();
  }, []);

  if (loading) {
    return <div className="mt-6 text-gray-500">Loading watched addresses...</div>;
  }

  if (watches.length === 0) {
    return <div className="mt-6 text-gray-500">No watched addresses found.</div>;
  }

  return (
    <div className="mt-8 space-y-4 max-w-2xl">
      <h2 className="text-xl font-bold">Currently Watching</h2>
      <div className="bg-white dark:bg-gray-800 shadow overflow-hidden sm:rounded-md border border-gray-200 dark:border-gray-700">
        <ul className="divide-y divide-gray-200 dark:divide-gray-700">
          {watches.map((watch) => (
            <li key={watch.id}>
              <div className="px-4 py-4 sm:px-6 flex justify-between items-center">
                <div>
                  <p className="text-sm font-medium text-blue-600 dark:text-blue-400 truncate">
                    {watch.address}
                  </p>
                  <p className="mt-2 flex items-center text-sm text-gray-500 dark:text-gray-400">
                    Added: {new Date(watch.createdAt).toLocaleDateString()}
                  </p>
                </div>
                <div className="ml-2 flex-shrink-0 flex">
                  <p className={`px-2 inline-flex text-xs leading-5 font-semibold rounded-full ${
                    watch.status === 'active' 
                      ? 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200' 
                      : 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200'
                  }`}>
                    {watch.status}
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
