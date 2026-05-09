import { desc, eq, inArray, sql } from 'drizzle-orm';
import {
  auctionFlags,
  auctions,
  bids,
  cardPrices,
  cards,
  db,
  userCards,
  users,
} from '@pullvault/db';
import { requireAuth } from '@/lib/require-auth';

export const dynamic = 'force-dynamic';

const WINDOW_DAYS = 30;

function fmtUsd(cents: number | null): string {
  if (cents === null) return '—';
  return `$${(cents / 100).toFixed(2)}`;
}

function fmtPct(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return '—';
  return `${(n * 100).toFixed(1)}%`;
}

interface ReasonCode {
  readonly code: string;
  readonly weight: number;
}

export default async function AdminAuctionsPage() {
  await requireAuth(); // trial-scope: any authed user; see /admin/economics for the same convention

  // Settled-auction analytics over a rolling 30-day window.
  const since = sql`now() - interval '${sql.raw(`${WINDOW_DAYS} days`)}'`;

  const [analyticsRow] = await db
    .select({
      total: sql<string>`COUNT(*)`,
      sniped: sql<string>`SUM(CASE WHEN ${auctions.extensionCount} > 0 THEN 1 ELSE 0 END)`,
      avgFinalVsMarket: sql<string>`
        AVG(
          CASE WHEN ${cardPrices.price} > 0
            THEN ${auctions.currentBidAmount}::numeric / ${cardPrices.price}::numeric
            ELSE NULL END
        )
      `,
      medianFinalVsMarket: sql<string>`
        PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY
          CASE WHEN ${cardPrices.price} > 0
            THEN ${auctions.currentBidAmount}::numeric / ${cardPrices.price}::numeric
            ELSE NULL END
        )
      `,
    })
    .from(auctions)
    .innerJoin(userCards, eq(userCards.id, auctions.userCardId))
    .innerJoin(cards, eq(cards.id, userCards.cardId))
    .innerJoin(cardPrices, eq(cardPrices.cardId, cards.id))
    .where(sql`${auctions.state} = 'SETTLED' AND ${auctions.settledAt} > ${since}`);

  // Average distinct bidders per settled auction in the same window.
  const [participationRow] = await db.execute<{ avg_bidders: string }>(sql`
    SELECT AVG(distinct_bidders)::numeric(10,3) AS avg_bidders FROM (
      SELECT a.id, COUNT(DISTINCT b.bidder_id) AS distinct_bidders
      FROM ${auctions} a
      LEFT JOIN ${bids} b ON b.auction_id = a.id
      WHERE a.state = 'SETTLED' AND a.settled_at > ${since}
      GROUP BY a.id
    ) sub
  `).then((r) => {
    const rows = (r as unknown as { rows?: { avg_bidders: string }[] }).rows ?? (r as unknown as { avg_bidders: string }[]);
    return Array.isArray(rows) ? rows : [];
  });

  // Flag rate: flagged settled auctions / total settled, same window.
  const [flagsRow] = await db
    .select({ flagged: sql<string>`COUNT(DISTINCT ${auctionFlags.auctionId})` })
    .from(auctionFlags)
    .innerJoin(auctions, eq(auctions.id, auctionFlags.auctionId))
    .where(sql`${auctions.state} = 'SETTLED' AND ${auctions.settledAt} > ${since}`);

  const total = Number(analyticsRow?.total ?? 0);
  const sniped = Number(analyticsRow?.sniped ?? 0);
  const avgFinalVsMarket = analyticsRow?.avgFinalVsMarket
    ? Number(analyticsRow.avgFinalVsMarket)
    : null;
  const medianFinalVsMarket = analyticsRow?.medianFinalVsMarket
    ? Number(analyticsRow.medianFinalVsMarket)
    : null;
  const avgBidders = participationRow?.avg_bidders
    ? Number(participationRow.avg_bidders)
    : null;
  const flagged = Number(flagsRow?.flagged ?? 0);
  const snipeRate = total > 0 ? sniped / total : null;
  const flagRate = total > 0 ? flagged / total : null;

  // Flag queue — most recent first. Two-step query to sidestep Drizzle's
  // aliased-table inference quirk on twin (seller/winner) joins of `users`.
  const flagBase = await db
    .select({
      id: auctionFlags.id,
      auctionId: auctionFlags.auctionId,
      score: auctionFlags.score,
      reasons: auctionFlags.reasons,
      createdAt: auctionFlags.createdAt,
      reviewedAt: auctionFlags.reviewedAt,
      resolution: auctionFlags.resolution,
      cardName: cards.name,
      finalBid: auctions.currentBidAmount,
      marketCents: cardPrices.price,
      sellerId: auctions.sellerId,
      winnerId: auctions.currentBidUserId,
    })
    .from(auctionFlags)
    .innerJoin(auctions, eq(auctions.id, auctionFlags.auctionId))
    .innerJoin(userCards, eq(userCards.id, auctions.userCardId))
    .innerJoin(cards, eq(cards.id, userCards.cardId))
    .innerJoin(cardPrices, eq(cardPrices.cardId, cards.id))
    .orderBy(desc(auctionFlags.createdAt))
    .limit(50);

  const userIds = Array.from(
    new Set(
      flagBase
        .flatMap((f) => [f.sellerId, f.winnerId])
        .filter((x): x is string => typeof x === 'string'),
    ),
  );
  const userRows = userIds.length
    ? await db
        .select({ id: users.id, email: users.email })
        .from(users)
        .where(inArray(users.id, userIds))
    : [];
  const emailById = new Map(userRows.map((u) => [u.id, u.email]));
  const flagRows = flagBase.map((f) => ({
    ...f,
    sellerEmail: emailById.get(f.sellerId) ?? null,
    winnerEmail: f.winnerId ? emailById.get(f.winnerId) ?? null : null,
  }));

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Auction integrity</h1>
      <p className="text-sm text-zinc-500">
        Settled-auction analytics over the last {WINDOW_DAYS} days, plus the
        wash-trade detector&rsquo;s flag queue. Detection only — auctions are
        never auto-cancelled.
      </p>

      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Settled (30d)" value={String(total)} />
        <Stat label="Avg distinct bidders" value={avgBidders?.toFixed(2) ?? '—'} />
        <Stat label="Snipe rate" value={fmtPct(snipeRate)} />
        <Stat label="Flag rate" value={fmtPct(flagRate)} />
        <Stat
          label="Final / market (mean)"
          value={avgFinalVsMarket != null ? avgFinalVsMarket.toFixed(2) : '—'}
        />
        <Stat
          label="Final / market (median)"
          value={medianFinalVsMarket != null ? medianFinalVsMarket.toFixed(2) : '—'}
        />
      </section>

      <section className="space-y-2">
        <h2 className="text-lg font-medium">Flag queue</h2>
        {flagRows.length === 0 ? (
          <p className="text-sm text-zinc-500">No flags yet.</p>
        ) : (
          <table className="w-full text-sm border border-zinc-200 bg-white rounded">
            <thead className="bg-zinc-50">
              <tr>
                <th className="text-left p-2">When</th>
                <th className="text-left p-2">Card</th>
                <th className="text-left p-2">Final</th>
                <th className="text-left p-2">Market</th>
                <th className="text-left p-2">Score</th>
                <th className="text-left p-2">Reasons</th>
                <th className="text-left p-2">Seller → winner</th>
                <th className="text-left p-2">Status</th>
              </tr>
            </thead>
            <tbody>
              {flagRows.map((f) => {
                const reasonList = Array.isArray(f.reasons)
                  ? (f.reasons as ReasonCode[])
                  : [];
                return (
                  <tr key={f.id} className="border-t border-zinc-100 align-top">
                    <td className="p-2 text-xs text-zinc-500">
                      {f.createdAt.toISOString().slice(0, 16).replace('T', ' ')}
                    </td>
                    <td className="p-2">{f.cardName}</td>
                    <td className="p-2 font-mono">{fmtUsd(f.finalBid)}</td>
                    <td className="p-2 font-mono">{fmtUsd(f.marketCents)}</td>
                    <td className="p-2 font-mono">{f.score}</td>
                    <td className="p-2 text-xs">
                      {reasonList.map((r) => (
                        <span
                          key={r.code}
                          className="inline-block bg-amber-100 text-amber-900 rounded px-1 mr-1 mb-1"
                        >
                          {r.code} +{r.weight}
                        </span>
                      ))}
                    </td>
                    <td className="p-2 text-xs">
                      {f.sellerEmail} → {f.winnerEmail ?? '—'}
                    </td>
                    <td className="p-2 text-xs">
                      {f.reviewedAt
                        ? `${f.resolution ?? 'reviewed'}`
                        : 'pending review'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-white border border-zinc-200 rounded p-3">
      <p className="text-xs text-zinc-500">{label}</p>
      <p className="text-2xl font-mono">{value}</p>
    </div>
  );
}
