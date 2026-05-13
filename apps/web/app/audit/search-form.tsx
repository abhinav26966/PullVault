'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default function PackSearchForm() {
  const router = useRouter();
  const [packId, setPackId] = useState('');
  const [error, setError] = useState<string | null>(null);

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    const trimmed = packId.trim();
    if (!UUID_REGEX.test(trimmed)) {
      setError('Enter a valid pack ID (UUID format).');
      return;
    }
    router.push(`/verify/${trimmed}`);
  }

  return (
    <div>
      <form onSubmit={onSubmit} className="flex gap-2">
        <label className="flex-1">
          <span className="sr-only">Pack ID</span>
          <input
            type="text"
            value={packId}
            onChange={(e) => {
              setPackId(e.target.value);
              if (error) setError(null);
            }}
            placeholder="Paste any pack ID — e.g. 84f0f6e9-41de-492e-891e-2c6287b0bed8"
            spellCheck={false}
            className="w-full font-mono text-sm border border-zinc-300 rounded px-3 py-2 focus:outline-none focus:ring-2 focus:ring-zinc-500"
          />
        </label>
        <button
          type="submit"
          className="bg-zinc-900 text-white rounded px-4 py-2 text-sm hover:bg-zinc-800 whitespace-nowrap"
        >
          Verify →
        </button>
      </form>
      {error ? <p className="text-sm text-red-600 mt-2">{error}</p> : null}
    </div>
  );
}
