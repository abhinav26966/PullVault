import Link from 'next/link';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Page not found · PullVault',
};

export default function NotFound() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-white px-4">
      <div className="max-w-md text-center space-y-4">
        <p className="text-xs uppercase tracking-widest text-zinc-500">404</p>
        <h1 className="text-2xl font-semibold text-zinc-900">
          This page doesn&apos;t exist.
        </h1>
        <p className="text-sm text-zinc-600">
          The route you tried may have moved, expired, or never existed.
        </p>
        <Link
          href="/dashboard"
          className="inline-block text-sm text-zinc-900 underline hover:no-underline"
        >
          Back to home →
        </Link>
      </div>
    </div>
  );
}
