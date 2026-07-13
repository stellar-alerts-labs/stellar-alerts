'use client';

import { signIn, signOut, useSession } from 'next-auth/react';
import { useState } from 'react';
import { WatcherForm } from '@/components/WatcherForm';
import { WatchList } from '@/components/WatchList';
import { PaymentHistory } from '@/components/PaymentHistory';

export default function Home() {
  const { data: session, status } = useSession();
  const [token, setToken] = useState('');
  const [selectedWallet, setSelectedWallet] = useState<string | null>(null);

  if (status === 'loading') {
    return <div className="p-8">Loading session...</div>;
  }

  if (session) {
    return (
      <div className="p-8 space-y-8">
        <div className="space-y-2">
          <h1 className="text-2xl font-bold">Welcome, {session.user?.name}</h1>
          <p>Email: {session.user?.email}</p>
          <button 
            onClick={() => signOut()}
            className="bg-red-500 hover:bg-red-600 text-white px-4 py-2 rounded"
          >
            Sign Out
          </button>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
          <div>
            <WatcherForm />
          </div>
          <div>
            <WatchList onSelect={setSelectedWallet} />
          </div>
        </div>

        {selectedWallet && (
          <div className="mt-8">
            <PaymentHistory walletId={selectedWallet} />
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="p-8 space-y-4">
      <h1 className="text-2xl font-bold">Login</h1>
      <div className="flex gap-2">
        <input 
          type="text" 
          value={token}
          onChange={e => setToken(e.target.value)}
          className="border p-2 rounded text-black"
          placeholder="Magic Link Token"
        />
        <button 
          onClick={() => signIn('credentials', { token, callbackUrl: '/' })}
          className="bg-blue-500 text-white px-4 py-2 rounded"
        >
          Sign In
        </button>
      </div>
    </div>
  );
}
