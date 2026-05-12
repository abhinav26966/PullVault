'use client';

import { useEffect } from 'react';
import Link from 'next/link';

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('[app/error.tsx]', error);
  }, [error]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-white px-4">
      <div className="max-w-md text-center space-y-4">
        <p className="text-xs uppercase tracking-widest text-zinc-500">Error</p>
        <h1 className="text-2xl font-semibold text-zinc-900">
          Something went wrong.
        </h1>
        <p className="text-sm text-zinc-600">
          {error.message || 'An unexpected error occurred. Try again, or head home.'}
        </p>
        <div className="flex gap-3 justify-center pt-2">
          <button
            type="button"
            onClick={reset}
            className="text-sm bg-zinc-900 text-white rounded-md px-4 py-2 hover:bg-zinc-800"
          >
            Try again
          </button>
          <Link
            href="/dashboard"
            className="text-sm px-4 py-2 underline hover:no-underline"
          >
            Go home
          </Link>
        </div>
      </div>
    </div>
  );
}
