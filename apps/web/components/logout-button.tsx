'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

export default function LogoutButton() {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  // Same pattern as login/signup — useTransition keeps the button label in
  // "Logging out…" state through the route change to /login, not just
  // through the auth fetch.
  const [navigating, startNavigating] = useTransition();
  const busy = submitting || navigating;

  async function logout() {
    setSubmitting(true);
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
    } finally {
      setSubmitting(false);
    }
    startNavigating(() => {
      router.replace('/login');
      router.refresh();
    });
  }

  return (
    <button
      onClick={logout}
      disabled={busy}
      className="text-sm text-zinc-600 underline hover:text-zinc-900 disabled:opacity-50"
    >
      {busy ? 'Logging out…' : 'Log out'}
    </button>
  );
}
