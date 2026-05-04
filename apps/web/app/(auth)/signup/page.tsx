'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useTransition, type FormEvent } from 'react';

export default function SignupPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // useTransition keeps the button in pending state through the post-signup
  // navigation to /dashboard, not just through the POST. See login/page.tsx
  // for the full rationale.
  const [navigating, startNavigating] = useTransition();
  const busy = submitting || navigating;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);

    let res: Response;
    try {
      res = await fetch('/api/auth/signup', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, displayName, password }),
      });
    } catch {
      setError('Network error — try again.');
      setSubmitting(false);
      return;
    }

    if (!res.ok) {
      const j = (await res.json().catch(() => ({}))) as { message?: string };
      setError(j.message ?? `Signup failed (${res.status})`);
      setSubmitting(false);
      return;
    }

    setSubmitting(false);
    startNavigating(() => {
      router.replace('/dashboard');
      router.refresh();
    });
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-4">
      <form
        onSubmit={onSubmit}
        className="w-full max-w-sm space-y-4 bg-white p-8 rounded-lg border border-zinc-200 shadow-sm"
      >
        <div>
          <h1 className="text-2xl font-semibold">PullVault</h1>
          <p className="text-sm text-zinc-500">Create an account. $1,000 starting balance.</p>
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
          type="text"
          required
          autoComplete="username"
          placeholder="Display name"
          minLength={2}
          maxLength={40}
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          className="w-full border border-zinc-300 rounded px-3 py-2 focus:outline-none focus:ring-2 focus:ring-zinc-500"
        />
        <input
          type="password"
          required
          autoComplete="new-password"
          placeholder="Password (min 8 chars)"
          minLength={8}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="w-full border border-zinc-300 rounded px-3 py-2 focus:outline-none focus:ring-2 focus:ring-zinc-500"
        />
        {error ? <p className="text-sm text-red-600">{error}</p> : null}
        <button
          type="submit"
          disabled={busy}
          className="w-full bg-zinc-900 text-white rounded py-2 hover:bg-zinc-800 disabled:opacity-50 inline-flex items-center justify-center"
        >
          {busy ? (
            <>
              <span className="spinner" />
              Creating account…
            </>
          ) : (
            'Create account'
          )}
        </button>
        <p className="text-sm text-zinc-500">
          Have an account?{' '}
          <Link href="/login" className="underline hover:text-zinc-900">
            Sign in
          </Link>
        </p>
      </form>
    </div>
  );
}
