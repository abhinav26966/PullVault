import { NextResponse } from 'next/server';
import { eq, inArray } from 'drizzle-orm';
import { cardPrices, cards, db, packCards, packs } from '@pullvault/db';
import { withErrors } from '@/lib/api-handler';

export const dynamic = 'force-dynamic';

/**
 * /api/packs/[id]/verify-data — Part B §12 dumb data dump.
 *
 * **Hard invariant — DO NOT ADD VALIDATION HERE.**
 *
 * This endpoint MUST remain a raw read of the per-pack provably-fair fields.
 * No server-side recomputation. No `valid: true`. No `{ matches: true }`.
 * No precomputed HMAC. No "this commit hashes to that seed" boolean. The
 * browser is the only oracle that decides whether the pack verifies.
 *
 * If a future maintainer adds a validation flag here, the verify page can
 * silently lie because the server told it to — defeating the entire trust
 * model. The reviewer's first read on this endpoint should look exactly
 * like a database SELECT and nothing more. The verify page (`verify-client
 * .tsx`) imports the same sampler that the server used at mint time and
 * recomputes everything from these raw inputs under Web Crypto.
 *
 * Public (no auth): the server seed is intentionally revealed post-purchase
 * so anyone can audit any user's pack — the audit story relies on it.
 */
export const GET = withErrors<{ id: string }>(async (_req, ctx) => {
  const packId = ctx.params.id;

  const [pack] = await db
    .select({
      id: packs.id,
      tier: packs.tier,
      ownerId: packs.ownerId,
      purchasedAt: packs.purchasedAt,
      openedAt: packs.openedAt,
      rarityWeights: packs.rarityWeights,
      serverSeedCommit: packs.serverSeedCommit,
      serverSeed: packs.serverSeed,
      clientSeed: packs.clientSeed,
      eligibleCardIds: packs.eligibleCardIds,
    })
    .from(packs)
    .where(eq(packs.id, packId))
    .limit(1);

  if (!pack) {
    return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404 });
  }

  // Pre-PF packs (purchased before B4 shipped) have NULL crypto fields. The
  // verify page renders "pre-PF: not verifiable" for them. We still hand
  // back the row so the client can diagnose.
  const isPreProvablyFair =
    pack.serverSeedCommit === null ||
    pack.serverSeed === null ||
    pack.clientSeed === null ||
    pack.eligibleCardIds === null;

  // Revealed cards: the row that was actually written into pack_cards by the
  // mint transaction. Order by position so position N = HMAC slot index N
  // (per the buy route's convention — the verify page compares index by
  // index against its own recomputed sample).
  const revealedRows = await db
    .select({
      position: packCards.position,
      cardId: packCards.cardId,
      slotType: packCards.slotType,
      rarityAtPull: packCards.rarityAtPull,
    })
    .from(packCards)
    .where(eq(packCards.packId, packId))
    .orderBy(packCards.position);

  // Eligibility-set joined with the cards catalog so the browser can render
  // the per-rarity pool and recompute the within-bucket pick. We look up
  // both the eligible set and the revealed cards' catalog rows in a single
  // query to keep the round-trip count tight.
  const lookupIds = new Set<string>(revealedRows.map((r) => r.cardId));
  if (pack.eligibleCardIds) for (const id of pack.eligibleCardIds) lookupIds.add(id);
  const cardRows = lookupIds.size
    ? await db
        .select({
          id: cards.id,
          name: cards.name,
          rarity: cards.rarity,
          imageUrlSmall: cards.imageUrlSmall,
        })
        .from(cards)
        .where(inArray(cards.id, [...lookupIds]))
    : [];

  // Current prices for the revealed cards — handy for the reviewer to see
  // the realised pack value next to the recomputed bucket draw. Not used
  // by the verification step itself.
  const priceRows = lookupIds.size
    ? await db
        .select({ id: cardPrices.cardId, price: cardPrices.price })
        .from(cardPrices)
        .where(inArray(cardPrices.cardId, [...lookupIds]))
    : [];

  return NextResponse.json({
    pack: {
      id: pack.id,
      tier: pack.tier,
      purchasedAt: pack.purchasedAt,
      openedAt: pack.openedAt,
    },
    isPreProvablyFair,
    rarityWeights: pack.rarityWeights,
    serverSeedCommit: pack.serverSeedCommit,
    serverSeed: pack.serverSeed,
    clientSeed: pack.clientSeed,
    eligibleCardIds: pack.eligibleCardIds,
    revealedCards: revealedRows,
    cards: cardRows,
    prices: priceRows,
  });
});
