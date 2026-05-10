import { notFound } from 'next/navigation';
import { headers } from 'next/headers';
import VerifyClient from './verify-client';

export const dynamic = 'force-dynamic';

/**
 * Public verification page — Part B §12.
 *
 * No auth required: the server seed is intentionally revealed post-purchase
 * so a third-party reviewer (or another user) can audit any pack. The server
 * component does only one thing — fetch the dumb data dump from
 * `/api/packs/[id]/verify-data` and hand it to the client. All SHA-256 +
 * HMAC work runs in the browser. The brief's invariant: the server tells
 * the client *what* the inputs were, never *whether* the recomputation
 * succeeds.
 */
export default async function VerifyPackPage({
  params,
}: {
  params: { packId: string };
}) {
  // Build an absolute URL so this works under both `next dev` and production.
  // The headers() shape gives us the actual host the request came in on.
  const h = await headers();
  const host = h.get('host') ?? 'localhost:3000';
  const proto = h.get('x-forwarded-proto') ?? 'http';
  const url = `${proto}://${host}/api/packs/${params.packId}/verify-data`;

  const res = await fetch(url, { cache: 'no-store' });
  if (res.status === 404) notFound();
  if (!res.ok) {
    return (
      <div className="max-w-3xl mx-auto p-6 space-y-3">
        <h1 className="text-2xl font-semibold">Verify pack</h1>
        <p className="text-red-600">
          Failed to load pack data ({res.status}). The pack may not exist or the
          server is unreachable.
        </p>
      </div>
    );
  }
  const data = await res.json();

  return (
    <div className="max-w-5xl mx-auto p-6 space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold">Verify pack</h1>
        <p className="text-sm text-zinc-600">
          Pack <span className="font-mono">{params.packId}</span> · Tier{' '}
          <span className="font-mono">{data.pack?.tier}</span>
        </p>
      </header>
      <p className="text-xs text-zinc-500 max-w-prose">
        All SHA-256 and HMAC-SHA256 work runs in <em>your</em> browser via Web
        Crypto. The server hands over raw inputs only. If you tamper with{' '}
        <span className="font-mono">packs.server_seed</span> in the database
        and refresh, this page will flip to MISMATCH without the server's
        consent — that&apos;s the verification primitive.
      </p>
      <VerifyClient data={data} />
    </div>
  );
}
