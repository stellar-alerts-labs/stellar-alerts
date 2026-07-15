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
      <div className="min-h-screen flex items-center justify-center bg-[#0a0a0a]">
        <div className="relative flex items-center justify-center">
          <div className="absolute inset-0 rounded-full blur-xl bg-gradient-to-tr from-cyan-500 to-blue-500 opacity-50 animate-pulse"></div>
          <div className="animate-spin rounded-full h-14 w-14 border-t-2 border-b-2 border-white relative z-10"></div>
        </div>
      </div>
    );
  }

  if (session) {
    return (
      <div className="min-h-screen bg-[#050505] text-gray-100 font-sans selection:bg-cyan-500/30 overflow-x-hidden relative">
        {/* Dynamic Background */}
        <div className="fixed inset-0 z-0 pointer-events-none">
          <div className="absolute top-[-20%] left-[-10%] w-[50vw] h-[50vw] rounded-full bg-cyan-900/20 blur-[150px] mix-blend-screen"></div>
          <div className="absolute bottom-[-20%] right-[-10%] w-[60vw] h-[60vw] rounded-full bg-blue-900/20 blur-[150px] mix-blend-screen"></div>
        </div>

        {/* Navigation Bar */}
        <header className="sticky top-0 z-50 bg-[#0a0a0a]/60 backdrop-blur-xl border-b border-white/5 shadow-[0_4px_30px_rgba(0,0,0,0.1)]">
          <div className="max-w-7xl mx-auto px-6 h-20 flex items-center justify-between">
            <div className="flex items-center gap-3 group cursor-pointer">
              <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-cyan-400 to-blue-600 flex items-center justify-center text-white font-bold shadow-[0_0_20px_rgba(6,182,212,0.4)] group-hover:scale-105 transition-transform duration-300">
                <svg className="w-5 h-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                </svg>
              </div>
              <span className="text-2xl font-extrabold tracking-tight bg-clip-text text-transparent bg-gradient-to-r from-white to-gray-400">
                Stellar<span className="text-cyan-400">Alerts</span>
              </span>
            </div>
            
            <div className="flex items-center gap-6">
              <div className="hidden sm:flex flex-col items-end">
                <p className="font-semibold text-sm text-gray-200">{session.user?.name || 'Explorer'}</p>
                <p className="text-xs text-gray-500 font-medium">{session.user?.email}</p>
              </div>
              <button 
                onClick={() => signOut()}
                className="group relative px-5 py-2.5 rounded-full bg-white/5 hover:bg-white/10 border border-white/10 hover:border-red-500/50 transition-all duration-300 overflow-hidden"
              >
                <span className="relative z-10 text-sm font-medium text-gray-300 group-hover:text-red-400 transition-colors">Sign Out</span>
              </button>
            </div>
          </div>
        </header>

        {/* Main Content */}
        <main className="relative z-10 max-w-7xl mx-auto px-6 py-12 space-y-8">
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
            
            {/* Left Column (Forms & Lists) */}
            <div className="lg:col-span-4 space-y-8">
              {/* Watcher Form Card */}
              <div className="bg-[#111111]/80 backdrop-blur-md rounded-3xl border border-white/5 p-7 shadow-2xl hover:border-cyan-500/20 transition-all duration-500 group relative overflow-hidden">
                <div className="absolute top-0 right-0 w-32 h-32 bg-cyan-500/10 rounded-full blur-3xl -mr-16 -mt-16 group-hover:bg-cyan-500/20 transition-colors duration-500"></div>
                <h2 className="text-xl font-semibold mb-6 flex items-center gap-3 text-white">
                  <div className="p-2 rounded-lg bg-cyan-500/10 text-cyan-400">
                    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                    </svg>
                  </div>
                  Add Watcher
                </h2>
                <div className="relative z-10">
                  <WatcherForm />
                </div>
              </div>

              {/* Wallets Card */}
              <div className="bg-[#111111]/80 backdrop-blur-md rounded-3xl border border-white/5 p-7 shadow-2xl hover:border-blue-500/20 transition-all duration-500 group relative overflow-hidden">
                <div className="absolute bottom-0 left-0 w-32 h-32 bg-blue-500/10 rounded-full blur-3xl -ml-16 -mb-16 group-hover:bg-blue-500/20 transition-colors duration-500"></div>
                <h2 className="text-xl font-semibold mb-6 flex items-center gap-3 text-white">
                  <div className="p-2 rounded-lg bg-blue-500/10 text-blue-400">
                    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z" />
                    </svg>
                  </div>
                  Your Wallets
                </h2>
                <div className="relative z-10">
                  <WatchList onSelect={setSelectedWallet} />
                </div>
              </div>
            </div>

            {/* Right Column (History) */}
            <div className="lg:col-span-8 h-full">
              <div className="bg-[#111111]/80 backdrop-blur-md rounded-3xl border border-white/5 p-8 shadow-2xl h-full min-h-[600px] flex flex-col relative overflow-hidden hover:border-white/10 transition-all duration-500">
                <div className="absolute top-0 right-1/4 w-64 h-64 bg-purple-500/5 rounded-full blur-3xl"></div>
                
                <div className="flex items-center justify-between mb-8 relative z-10">
                  <h2 className="text-2xl font-bold flex items-center gap-3 text-white">
                    <div className="p-2.5 rounded-xl bg-purple-500/10 text-purple-400">
                      <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                      </svg>
                    </div>
                    Payment Ledger
                  </h2>
                </div>

                {selectedWallet ? (
                  <div className="animate-in fade-in slide-in-from-bottom-4 duration-700 flex-1 relative z-10">
                    <PaymentHistory walletId={selectedWallet} />
                  </div>
                ) : (
                  <div className="flex flex-col items-center justify-center flex-1 text-gray-500 space-y-6 relative z-10">
                    <div className="relative">
                      <div className="absolute inset-0 bg-blue-500/20 blur-xl rounded-full animate-pulse"></div>
                      <div className="w-24 h-24 rounded-full bg-[#1a1a1a] border border-white/5 flex items-center justify-center relative z-10">
                        <svg className="w-10 h-10 text-gray-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 15l-2 5L9 9l11 4-5 2zm0 0l5 5M7.188 2.239l.777 2.897M5.136 7.965l-2.898-.777M13.95 4.05l-2.122 2.122m-5.657 5.656l-2.12 2.122" />
                        </svg>
                      </div>
                    </div>
                    <div className="text-center">
                      <h3 className="text-xl font-medium text-gray-300 mb-2">No Wallet Selected</h3>
                      <p className="text-sm max-w-sm mx-auto">Select a wallet from your dashboard to view its real-time transaction history.</p>
                    </div>
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
    <div className="min-h-screen flex items-center justify-center bg-[#030303] text-white p-6 relative overflow-hidden font-sans">
      {/* Immersive Background */}
      <div className="absolute inset-0 z-0">
        <div className="absolute top-[20%] left-[20%] w-[40vw] h-[40vw] rounded-full bg-cyan-600/20 blur-[120px] mix-blend-screen animate-pulse duration-[8000ms]"></div>
        <div className="absolute bottom-[10%] right-[20%] w-[30vw] h-[30vw] rounded-full bg-blue-600/20 blur-[100px] mix-blend-screen animate-pulse duration-[6000ms]"></div>
        <div className="absolute top-[40%] left-[50%] w-[50vw] h-[50vw] rounded-full bg-purple-600/10 blur-[150px] mix-blend-screen -translate-x-1/2 -translate-y-1/2 pointer-events-none"></div>
      </div>

      <div className="w-full max-w-lg bg-[#0a0a0a]/60 backdrop-blur-2xl rounded-[2.5rem] shadow-[0_0_80px_rgba(0,0,0,0.8)] border border-white/10 p-10 z-10 animate-in fade-in zoom-in-95 duration-700">
        <div className="flex justify-center mb-10">
          <div className="relative group cursor-pointer">
            <div className="absolute inset-0 bg-gradient-to-r from-cyan-400 to-blue-500 blur-lg opacity-60 group-hover:opacity-100 transition-opacity duration-500 rounded-2xl"></div>
            <div className="relative w-16 h-16 rounded-2xl bg-[#050505] border border-white/20 flex items-center justify-center text-white font-extrabold text-3xl shadow-xl">
              <svg className="w-8 h-8 text-cyan-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
              </svg>
            </div>
          </div>
        </div>
        
        <div className="text-center mb-10">
          <h1 className="text-4xl font-extrabold tracking-tight mb-3 text-transparent bg-clip-text bg-gradient-to-r from-white via-gray-200 to-gray-400">
            Welcome to StellarAlerts
          </h1>
          <p className="text-gray-400 text-sm font-medium">Authenticate to access your real-time dashboard.</p>
        </div>
        
        <div className="space-y-6">
          <div className="space-y-2">
            <label className="block text-xs font-bold text-gray-500 uppercase tracking-wider ml-1">
              Authentication Token
            </label>
            <div className="relative group">
              <div className="absolute -inset-0.5 bg-gradient-to-r from-cyan-500 to-blue-500 rounded-2xl blur opacity-0 group-hover:opacity-20 transition duration-500"></div>
              <input 
                type="text" 
                value={token}
                onChange={e => setToken(e.target.value)}
                className="relative w-full px-5 py-4 rounded-2xl border border-white/10 bg-[#111111] text-white placeholder-gray-600 focus:ring-2 focus:ring-cyan-500 focus:border-transparent transition-all outline-none font-mono text-sm"
                placeholder="Paste your magic link token here..."
              />
            </div>
          </div>
          
          <button 
            onClick={() => signIn('credentials', { token, callbackUrl: '/' })}
            className="group relative w-full py-4 rounded-2xl font-bold text-white shadow-[0_0_40px_rgba(6,182,212,0.3)] hover:shadow-[0_0_60px_rgba(6,182,212,0.5)] transition-all duration-300 transform hover:-translate-y-1 active:translate-y-0 overflow-hidden"
          >
            <div className="absolute inset-0 w-full h-full bg-gradient-to-r from-cyan-500 to-blue-600"></div>
            <div className="absolute inset-0 w-full h-full opacity-0 group-hover:opacity-100 bg-gradient-to-r from-cyan-400 to-blue-500 transition-opacity duration-300"></div>
            <span className="relative flex items-center justify-center gap-2">
              Verify Token
              <svg className="w-5 h-5 group-hover:translate-x-1 transition-transform" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7l5 5m0 0l-5 5m5-5H6" />
              </svg>
            </span>
          </button>
        </div>
      </div>
      
      <p className="absolute bottom-8 text-gray-600 text-xs font-medium">
        Secured by Magic Link Authentication
      </p>
    </div>
  );
}
