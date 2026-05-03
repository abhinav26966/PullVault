'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { message?: string };
        setError(j.message ?? `Login failed (${res.status})`);
        return;
      }
      router.replace('/dashboard');
      router.refresh();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-4">
      <form
        onSubmit={onSubmit}
        className="w-full max-w-sm space-y-4 bg-white p-8 rounded-lg border border-zinc-200 shadow-sm"
      >
        <div>
          <h1 className="text-2xl font-semibold">PullVault</h1>
          <p className="text-sm text-zinc-500">Sign in to your account.</p>
        </div>
        <input
          type="email"
          required
          autoComplete="email"
          placeholder="Email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="w-full border border-zinc-300 rounded px-3 py-2 focus:outline-none focus:ring-2 focus:ring-zinc-500"
        />
        <input
          type="password"
          required
          autoComplete="current-password"
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="w-full border border-zinc-300 rounded px-3 py-2 focus:outline-none focus:ring-2 focus:ring-zinc-500"
        />
        {error ? <p className="text-sm text-red-600">{error}</p> : null}
        <button
          type="submit"
          disabled={submitting}
          className="w-full bg-zinc-900 text-white rounded py-2 hover:bg-zinc-800 disabled:opacity-50 inline-flex items-center justify-center"
        >
          {submitting ? (
            <>
              <span className="spinner" />
              Signing in…
            </>
          ) : (
            'Sign in'
          )}
        </button>
        <p className="text-sm text-zinc-500">
          New here?{' '}
          <Link href="/signup" className="underline hover:text-zinc-900">
            Create an account
          </Link>
        </p>
      </form>
    </div>
  );
}
