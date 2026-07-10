'use client';

import { useState } from 'react';

export function WatcherForm() {
  const [address, setAddress] = useState('');
  const [status, setStatus] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setStatus('Submitting...');
    
    // Stub API call
    console.log('Stub API Call to /payments/watch with data:', { address });
    
    setTimeout(() => {
      setStatus('Successfully submitted! (Stub)');
      setAddress('');
    }, 500);
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4 border p-6 rounded shadow-md max-w-md mt-6">
      <h2 className="text-xl font-bold">Add Stellar Watcher</h2>
      
      <div className="flex flex-col gap-2">
        <label htmlFor="address" className="text-sm font-semibold">
          Stellar Public Key
        </label>
        <input
          id="address"
          type="text"
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          placeholder="G..."
          className="border p-2 rounded text-black"
          required
        />
      </div>

      <button
        type="submit"
        className="bg-green-600 hover:bg-green-700 text-white font-bold py-2 px-4 rounded w-full"
      >
        Watch Address
      </button>

      {status && <p className="text-sm mt-2 text-gray-600 dark:text-gray-300">{status}</p>}
    </form>
  );
}
