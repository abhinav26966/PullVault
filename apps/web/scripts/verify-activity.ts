/**
 * Read-only activity-replay verifier.
 *
 * For every user, walks every event in chronological order (oldest first)
 * — exactly the same shape as the /api/me/activity timeline that powers the
 * "Activity history" modal — accumulating a running balance after each event.
 * After the last event, the running total must equal the user's actual
 * wallet (available + held). If the trail diverges from the wallet, the
 * mismatch is surfaced in the diagnostic line at the end of that user's
 * section.
 *
 * Mathematically this is the same invariant that `verify-ledger` checks in
 * one shot (Σ ledger == wallets), but presented as a story: every credit,
 * every debit, every pack open, every bid hold and release, plus a running
 * balance column. Useful as a sanity audit before recording / submitting,
 * because a passing readout is a narrative the reviewer can also follow.
 *
 * Usage:
 *   pnpm -F @pullvault/web verify-activity
 *
 * Exit code:
 *   0 — every user's replay matches their wallet AND system-wide invariant holds
 *   1 — any mismatch detected
 *
 * Read-only. Never writes. To FIX an imbalance after investigating root
 * cause, use `reset-ledger`.
 */
import { config } from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.resolve(here, '../../../.env.local') });

const TIER_CARD_COUNT: Record<'BRONZE' | 'SILVER' | 'GOLD', number> = {
  BRONZE: 5,
  SILVER: 7,
  GOLD: 10,
};

function fmtCents(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  return `${sign}$${(Math.abs(cents) / 100).toFixed(2)}`;
}

function fmtSigned(cents: number): string {
  if (cents === 0) return '$0.00';
  return cents > 0 ? `+${fmtCents(cents)}` : fmtCents(cents);
}

function fmtTimestamp(d: Date): string {
  const pad = (n: number): string => n.toString().padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(
    d.getDate(),
  )} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

interface LedgerRowJoin {
  id: string;
  type: string;
  amount: number;
  createdAt: Date;
  meta: unknown;
  packTier: 'BRONZE' | 'SILVER' | 'GOLD' | null;
  pricePaid: number | null;
  listingPrice: number | null;
  listingCardName: string | null;
  auctionFinalBid: number | null;
  auctionCardName: string | null;
}

function describeLedgerRow(r: LedgerRowJoin): string {
  const meta = r.meta as { newBidAmount?: number } | null;
  const card = r.listingCardName ?? r.auctionCardName ?? 'card';
  switch (r.type) {
    case 'SIGNUP_BONUS':
      return 'Welcome bonus — $1,000 starting balance';
    case 'PACK_PURCHASE':
      return `Bought ${r.packTier ?? ''} pack (${fmtCents(r.pricePaid ?? 0)})`.trim();
    case 'LISTING_PURCHASE':
      return `Bought ${card} from marketplace (${fmtCents(r.listingPrice ?? 0)})`;
    case 'LISTING_SALE':
      return `Sold ${card} (gross ${fmtCents(r.listingPrice ?? 0)})`;
    case 'LISTING_FEE':
      return `Listing fee on ${card}`;
    case 'AUCTION_HOLD':
      return `Placed bid on ${card}${meta?.newBidAmount ? ` (${fmtCents(meta.newBidAmount)} held)` : ''}`;
    case 'AUCTION_RELEASE':
      return `Outbid on ${card} — funds released`;
    case 'AUCTION_SETTLE_BUYER':
      return `Won auction for ${card} (paid ${fmtCents(r.auctionFinalBid ?? 0)})`;
    case 'AUCTION_SETTLE_SELLER':
      return `Auction sold: ${card} (final bid ${fmtCents(r.auctionFinalBid ?? 0)})`;
    case 'AUCTION_FEE':
      return `Auction fee on ${card}`;
    default:
      return r.type;
  }
}

interface ActivityRow {
  type: string;
  description: string;
  amountCents: number;
  createdAt: Date;
}

async function main(): Promise<void> {
  const {
    db,
    users,
    wallets,
    walletLedger,
    packs,
    listings,
    userCards,
    auctions,
    cards,
    queryClient,
  } = await import('@pullvault/db');
  const { and, asc, eq, isNotNull, sql } = await import('drizzle-orm');
  const { alias } = await import('drizzle-orm/pg-core');

  const auctionUserCard = alias(userCards, 'auction_user_card');
  const auctionCard = alias(cards, 'auction_card');

  const allUsers = await db
    .select({ id: users.id, displayName: users.displayName })
    .from(users)
    .orderBy(users.displayName);

  console.log(`PullVault — activity replay verifier (read-only)`);
  console.log(
    `For each user, walks every event in chronological order and verifies`,
  );
  console.log(`the running total matches the wallet.\n`);

  let userPass = 0;
  let userFail = 0;
  const sep = '─'.repeat(110);
  const heavySep = '═'.repeat(110);

  for (const u of allUsers) {
    const ledgerRows = (await db
      .select({
        id: walletLedger.id,
        type: walletLedger.type,
        amount: walletLedger.amount,
        createdAt: walletLedger.createdAt,
        meta: walletLedger.meta,
        packTier: packs.tier,
        pricePaid: packs.pricePaid,
        listingPrice: listings.price,
        listingCardName: cards.name,
        auctionFinalBid: auctions.currentBidAmount,
        auctionCardName: auctionCard.name,
      })
      .from(walletLedger)
      .leftJoin(packs, eq(packs.id, walletLedger.packId))
      .leftJoin(listings, eq(listings.id, walletLedger.listingId))
      .leftJoin(userCards, eq(userCards.id, listings.userCardId))
      .leftJoin(cards, eq(cards.id, userCards.cardId))
      .leftJoin(auctions, eq(auctions.id, walletLedger.auctionId))
      .leftJoin(auctionUserCard, eq(auctionUserCard.id, auctions.userCardId))
      .leftJoin(auctionCard, eq(auctionCard.id, auctionUserCard.cardId))
      .where(eq(walletLedger.userId, u.id))
      .orderBy(asc(walletLedger.createdAt))) as LedgerRowJoin[];

    const opens = await db
      .select({
        id: packs.id,
        tier: packs.tier,
        openedAt: packs.openedAt,
        packEvAtPurchase: packs.packEvAtPurchase,
      })
      .from(packs)
      .where(and(eq(packs.ownerId, u.id), isNotNull(packs.openedAt)))
      .orderBy(asc(packs.openedAt));

    const events: ActivityRow[] = [];
    for (const r of ledgerRows) {
      events.push({
        type: r.type,
        description: describeLedgerRow(r),
        amountCents: r.amount,
        createdAt: r.createdAt,
      });
    }
    for (const o of opens) {
      if (!o.openedAt) continue;
      events.push({
        type: 'PACK_OPENED',
        description: `Opened ${o.tier} pack — pulled ${TIER_CARD_COUNT[o.tier]} cards (≈${fmtCents(o.packEvAtPurchase)})`,
        amountCents: 0,
        createdAt: o.openedAt,
      });
    }
    events.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

    const [walletRow] = await db
      .select({
        available: wallets.balanceAvailable,
        held: wallets.balanceHeld,
      })
      .from(wallets)
      .where(eq(wallets.userId, u.id));
    const actualAvail = walletRow?.available ?? 0;
    const actualHeld = walletRow?.held ?? 0;
    const actualTotal = actualAvail + actualHeld;

    console.log(sep);
    console.log(`USER: ${u.displayName}  (${u.id})`);
    console.log(
      `Wallet: avail=${fmtCents(actualAvail)}  held=${fmtCents(actualHeld)}  total=${fmtCents(actualTotal)}`,
    );
    console.log(sep);

    if (events.length === 0) {
      console.log(`  (no activity recorded)`);
    } else {
      console.log(
        `  ${'TIMESTAMP'.padEnd(19)}  ${'EVENT'.padEnd(60)}  ${'AMOUNT'.padStart(11)}  ${'RUNNING'.padStart(11)}`,
      );
      let running = 0;
      let credits = 0;
      let debits = 0;
      for (const e of events) {
        running += e.amountCents;
        if (e.amountCents > 0) credits += e.amountCents;
        if (e.amountCents < 0) debits += e.amountCents;
        const ts = fmtTimestamp(e.createdAt);
        const desc =
          e.description.length > 60
            ? e.description.slice(0, 57) + '...'
            : e.description.padEnd(60);
        const amount = e.amountCents === 0 ? '—' : fmtSigned(e.amountCents);
        console.log(
          `  ${ts}  ${desc}  ${amount.padStart(11)}  ${fmtCents(running).padStart(11)}`,
        );
      }

      console.log('');
      console.log(`  Events: ${events.length}`);
      console.log(`  Credits: ${fmtSigned(credits)}`);
      console.log(`  Debits:  ${fmtSigned(debits)}`);
      console.log(`  Net:     ${fmtSigned(running)}`);
    }

    const replayTotal = events.reduce((s, e) => s + e.amountCents, 0);
    const ok = replayTotal === actualTotal;
    const verdict = ok
      ? '✓ replay matches wallet'
      : `✗ replay diverges from wallet — Δ ${fmtSigned(actualTotal - replayTotal)}`;
    console.log('');
    console.log(`  Replay total: ${fmtCents(replayTotal)}`);
    console.log(`  Wallet total: ${fmtCents(actualTotal)}`);
    console.log(`  ${verdict}`);
    console.log('');

    if (ok) userPass++;
    else userFail++;
  }

  // System-wide cross-check — same as verify-ledger.
  const [globalLedger] = await db
    .select({
      total: sql<string>`COALESCE(SUM(${walletLedger.amount}), 0)::bigint`,
    })
    .from(walletLedger);
  const [globalWallets] = await db
    .select({
      total: sql<string>`COALESCE(SUM(${wallets.balanceAvailable} + ${wallets.balanceHeld}), 0)::bigint`,
    })
    .from(wallets);
  const lt = Number(globalLedger?.total ?? 0);
  const wt = Number(globalWallets?.total ?? 0);
  const balanced = lt === wt;

  console.log(heavySep);
  console.log(`SYSTEM-WIDE INVARIANT (§5.2)`);
  console.log(`  SUM(wallet_ledger.amount)              = ${fmtCents(lt)}`);
  console.log(`  SUM(wallets.available + wallets.held)  = ${fmtCents(wt)}`);
  console.log(
    `  Δ                                      = ${fmtSigned(wt - lt)}  ${balanced ? '✓' : '✗'}`,
  );
  console.log(heavySep);

  const allOk = userFail === 0 && balanced;
  console.log(
    `\nResult: ${userPass} users PASS, ${userFail} users FAIL  ${allOk ? '✓' : '✗'}`,
  );

  await queryClient.end();
  if (!allOk) process.exit(1);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
