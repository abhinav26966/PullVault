/**
 * Read-only ledger consistency verifier.
 *
 * For every user, checks two invariants from ARCHITECTURE §5.2:
 *
 *   1. Per-user wallet sum matches their ledger sum:
 *        wallet.balance_available + wallet.balance_held
 *          == SUM(wallet_ledger.amount WHERE user_id = u)
 *
 *   2. Per-user held column matches their open auction bids:
 *        wallet.balance_held
 *          == SUM(auctions.current_bid_amount
 *                 WHERE current_bid_user_id = u AND state = 'OPEN')
 *
 * If both hold for every user, the system is internally consistent and the
 * `/admin/economics` reconciliation badge will show green. Plus a system-wide
 * cross-check that SUM(ledger) == SUM(wallets).
 *
 * Usage:
 *   pnpm -F @pullvault/web verify-ledger
 *
 * Exit code:
 *   0 — every user PASS and system-wide invariant holds
 *   1 — any user FAIL or system-wide drift detected
 *
 * This script writes nothing. To FIX a detected imbalance, run `reset-ledger`
 * after investigating the root cause (the imbalance usually traces to a
 * direct UPDATE bypassing the ledger; fixing the cause is more important
 * than papering over the symptom).
 */
import { config } from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.resolve(here, '../../../.env.local') });

function fmt(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  return `${sign}$${(Math.abs(cents) / 100).toFixed(2)}`;
}

function fmtSigned(cents: number): string {
  if (cents === 0) return '$0.00';
  return cents > 0 ? `+${fmt(cents)}` : fmt(cents);
}

async function main(): Promise<void> {
  const { db, users, wallets, walletLedger, auctions, queryClient } =
    await import('@pullvault/db');
  const { and, eq, sql } = await import('drizzle-orm');

  const allUsers = await db
    .select({ id: users.id, displayName: users.displayName })
    .from(users)
    .orderBy(users.displayName);

  console.log(`PullVault — wallet/ledger verifier (read-only)`);
  console.log(`Checking ${allUsers.length} users…\n`);

  let passCount = 0;
  let failCount = 0;

  for (const u of allUsers) {
    const [ledgerRow] = await db
      .select({
        total: sql<string>`COALESCE(SUM(${walletLedger.amount}), 0)::bigint`,
      })
      .from(walletLedger)
      .where(eq(walletLedger.userId, u.id));
    const ledgerSum = Number(ledgerRow?.total ?? 0);

    const [heldRow] = await db
      .select({
        total: sql<string>`COALESCE(SUM(${auctions.currentBidAmount}), 0)::bigint`,
      })
      .from(auctions)
      .where(
        and(eq(auctions.currentBidUserId, u.id), eq(auctions.state, 'OPEN')),
      );
    const activeHolds = Number(heldRow?.total ?? 0);

    const expectedAvail = ledgerSum - activeHolds;
    const expectedHeld = activeHolds;

    const [walletRow] = await db
      .select({
        available: wallets.balanceAvailable,
        held: wallets.balanceHeld,
      })
      .from(wallets)
      .where(eq(wallets.userId, u.id));
    const actualAvail = walletRow?.available ?? 0;
    const actualHeld = walletRow?.held ?? 0;

    const availOk = actualAvail === expectedAvail;
    const heldOk = actualHeld === expectedHeld;

    if (availOk && heldOk) {
      passCount++;
      console.log(
        `  ✓  ${u.displayName.padEnd(24)} avail=${fmt(actualAvail).padStart(12)}  held=${fmt(actualHeld).padStart(10)}`,
      );
    } else {
      failCount++;
      console.log(`  ✗  ${u.displayName}  (${u.id})`);
      console.log(`        ledger sum:     ${fmt(ledgerSum)}`);
      console.log(`        active holds:   ${fmt(activeHolds)}`);
      console.log(
        `        expected:       avail=${fmt(expectedAvail)}  held=${fmt(expectedHeld)}`,
      );
      console.log(
        `        actual:         avail=${fmt(actualAvail)}  held=${fmt(actualHeld)}`,
      );
      if (!availOk) {
        const delta = actualAvail - expectedAvail;
        const hint =
          delta > 0
            ? '(wallet exceeds ledger — credit without ledger row?)'
            : '(ledger exceeds wallet — debit without wallet update?)';
        console.log(`        Δ available:    ${fmtSigned(delta)} ${hint}`);
      }
      if (!heldOk) {
        const delta = actualHeld - expectedHeld;
        console.log(`        Δ held:         ${fmtSigned(delta)}`);
      }
      console.log('');
    }
  }

  // System-wide cross-check.
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
  const globalBalanced = lt === wt;

  console.log(`\nSystem-wide invariant (§5.2):`);
  console.log(`  SUM(wallet_ledger.amount)              = ${fmt(lt)}`);
  console.log(`  SUM(wallets.available + wallets.held)  = ${fmt(wt)}`);
  console.log(
    `  Δ                                      = ${fmtSigned(wt - lt)}  ${
      globalBalanced ? '✓ balanced' : '✗ imbalanced'
    }`,
  );

  const allOk = failCount === 0 && globalBalanced;
  console.log(
    `\nResult: ${passCount} PASS, ${failCount} FAIL${
      globalBalanced ? '' : ' · system-wide drift'
    }  ${allOk ? '✓' : '✗'}`,
  );

  await queryClient.end();
  if (!allOk) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
