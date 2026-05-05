/**
 * Dev-only utility. Recomputes every wallet's balance from the wallet_ledger
 * audit trail so §5.2's reconciliation invariant holds again after manual
 * `UPDATE wallets` interventions during testing.
 *
 *   balance_held       = SUM(auctions.current_bid_amount)
 *                        WHERE current_bid_user_id = user AND state = 'OPEN'
 *   balance_available  = SUM(wallet_ledger.amount) - balance_held
 *
 * Usage:
 *   pnpm -F @pullvault/web reset-ledger
 *
 * Refuses to set a negative balance_available (which would also fail the
 * Postgres CHECK constraint) — that case implies a real data integrity
 * problem that needs investigation, not a balance reset.
 */
import { config } from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.resolve(here, '../../../.env.local') });

async function main(): Promise<void> {
  const { db, users, wallets, walletLedger, auctions, queryClient } = await import(
    '@pullvault/db'
  );
  const { and, eq, sql } = await import('drizzle-orm');

  const allUsers = await db
    .select({ id: users.id, displayName: users.displayName })
    .from(users);

  console.log(`Resetting balances for ${allUsers.length} users…`);

  let resetCount = 0;
  let skipCount = 0;
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
        and(
          eq(auctions.currentBidUserId, u.id),
          eq(auctions.state, 'OPEN'),
        ),
      );
    const computedHeld = Number(heldRow?.total ?? 0);
    const computedAvailable = ledgerSum - computedHeld;

    if (computedAvailable < 0) {
      console.warn(
        `  SKIP ${u.displayName} (${u.id}): would compute available=${computedAvailable} (ledger=${ledgerSum}, held=${computedHeld}). Investigate.`,
      );
      skipCount++;
      continue;
    }

    await db
      .update(wallets)
      .set({
        balanceAvailable: computedAvailable,
        balanceHeld: computedHeld,
        updatedAt: new Date(),
      })
      .where(eq(wallets.userId, u.id));

    console.log(
      `  RESET ${u.displayName}: available=${computedAvailable} held=${computedHeld}`,
    );
    resetCount++;
  }

  // Verify the system-wide invariant.
  const [ledgerTotal] = await db
    .select({
      total: sql<string>`COALESCE(SUM(${walletLedger.amount}), 0)::bigint`,
    })
    .from(walletLedger);
  const [walletTotal] = await db
    .select({
      total: sql<string>`COALESCE(SUM(${wallets.balanceAvailable} + ${wallets.balanceHeld}), 0)::bigint`,
    })
    .from(wallets);
  const lt = Number(ledgerTotal?.total ?? 0);
  const wt = Number(walletTotal?.total ?? 0);
  console.log(
    `\nReset ${resetCount}, skipped ${skipCount}.\nSUM(ledger)=${lt} cents\nSUM(wallets)=${wt} cents\nΔ=${wt - lt} cents${lt === wt ? ' ✓ balanced' : ' ✗ still imbalanced — investigate'}`,
  );

  await queryClient.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
