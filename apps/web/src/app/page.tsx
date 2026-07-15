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
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-zinc-950">
        <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-indigo-600"></div>
      </div>
    );
  }

  if (session) {
    return (
      <div className="min-h-screen bg-gray-50 dark:bg-zinc-950 text-gray-900 dark:text-gray-100 transition-colors duration-300">
        {/* Navigation Bar */}
        <header className="bg-white/70 dark:bg-zinc-900/70 backdrop-blur-md border-b border-gray-200 dark:border-zinc-800 sticky top-0 z-50">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-lg bg-gradient-to-tr from-indigo-600 to-purple-600 flex items-center justify-center text-white font-bold shadow-lg">
                S
              </div>
              <span className="text-xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-indigo-600 to-purple-600">
                StellarAlerts
              </span>
            </div>
            
            <div className="flex items-center gap-6">
              <div className="text-sm hidden sm:block">
                <p className="font-medium">{session.user?.name || 'User'}</p>
                <p className="text-gray-500 dark:text-gray-400 text-xs">{session.user?.email}</p>
              </div>
              <button 
                onClick={() => signOut()}
                className="text-sm font-medium px-4 py-2 rounded-full bg-gray-100 dark:bg-zinc-800 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-500/10 dark:hover:text-red-400 transition-all duration-200"
              >
                Sign Out
              </button>
            </div>
          </div>
        </header>

        {/* Main Content */}
        <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-8">
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
            
            {/* Left Column (Forms & Lists) */}
            <div className="lg:col-span-4 space-y-8">
              <div className="bg-white dark:bg-zinc-900 rounded-2xl shadow-sm border border-gray-200 dark:border-zinc-800 p-6 transition-all hover:shadow-md">
                <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-indigo-500"></span>
                  Add Watcher
                </h2>
                <WatcherForm />
              </div>

              <div className="bg-white dark:bg-zinc-900 rounded-2xl shadow-sm border border-gray-200 dark:border-zinc-800 p-6 transition-all hover:shadow-md">
                <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-purple-500"></span>
                  Your Wallets
                </h2>
                <WatchList onSelect={setSelectedWallet} />
              </div>
            </div>

            {/* Right Column (History) */}
            <div className="lg:col-span-8">
              <div className="bg-white dark:bg-zinc-900 rounded-2xl shadow-sm border border-gray-200 dark:border-zinc-800 p-6 h-full min-h-[500px] transition-all hover:shadow-md flex flex-col">
                <h2 className="text-lg font-semibold mb-6 flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-green-500"></span>
                  Payment History
                </h2>
                {selectedWallet ? (
                  <div className="animate-in fade-in slide-in-from-bottom-4 duration-500 flex-1">
                    <PaymentHistory walletId={selectedWallet} />
                  </div>
                ) : (
                  <div className="flex flex-col items-center justify-center flex-1 text-gray-400 dark:text-zinc-600 space-y-4">
                    <div className="w-16 h-16 rounded-full bg-gray-100 dark:bg-zinc-800 flex items-center justify-center">
                      <svg className="w-8 h-8" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z" />
                      </svg>
                    </div>
                    <p>Select a wallet from your list to view its payment history.</p>
                  </div>
                )}
              </div>
            </div>
            
          </div>
        </main>
      </div>
    );
  }

  // Unauthenticated State
  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-zinc-950 p-4 relative overflow-hidden">
      {/* Background decorations */}
      <div className="absolute top-[-10%] left-[-10%] w-[40%] h-[40%] rounded-full bg-indigo-500/20 blur-[120px] mix-blend-multiply dark:mix-blend-lighten pointer-events-none"></div>
      <div className="absolute bottom-[-10%] right-[-10%] w-[40%] h-[40%] rounded-full bg-purple-500/20 blur-[120px] mix-blend-multiply dark:mix-blend-lighten pointer-events-none"></div>

      <div className="w-full max-w-md bg-white/80 dark:bg-zinc-900/80 backdrop-blur-xl rounded-3xl shadow-2xl border border-gray-200 dark:border-zinc-800 p-8 z-10 animate-in fade-in zoom-in-95 duration-500">
        <div className="flex justify-center mb-8">
          <div className="w-12 h-12 rounded-xl bg-gradient-to-tr from-indigo-600 to-purple-600 flex items-center justify-center text-white font-bold text-xl shadow-lg">
            S
          </div>
        </div>
        
        <h1 className="text-3xl font-bold text-center mb-2 text-gray-900 dark:text-white">Welcome Back</h1>
        <p className="text-center text-gray-500 dark:text-gray-400 mb-8">Enter your magic link token to continue.</p>
        
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              Authentication Token
            </label>
            <input 
              type="text" 
              value={token}
              onChange={e => setToken(e.target.value)}
              className="w-full px-4 py-3 rounded-xl border border-gray-300 dark:border-zinc-700 bg-white dark:bg-zinc-950 text-gray-900 dark:text-gray-100 focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 transition-all outline-none"
              placeholder="Paste your magic link token..."
            />
          </div>
          <button 
            onClick={() => signIn('credentials', { token, callbackUrl: '/' })}
            className="w-full bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-700 hover:to-purple-700 text-white font-medium py-3 rounded-xl shadow-md hover:shadow-lg transition-all transform hover:-translate-y-0.5 active:translate-y-0"
          >
            Sign In Securely
          </button>
        </div>
      </div>
    </div>
  );
}
