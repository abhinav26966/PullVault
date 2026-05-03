/**
 * Pokemon TCG cards have ~25 raw rarity strings. We collapse them into 5
 * buckets so the pack roller in `@pullvault/domain` can weight them cleanly.
 * Mapping per ARCHITECTURE Appendix C "Rarity normalization".
 */
export type RarityBucket = 'C' | 'U' | 'R' | 'E' | 'L';

const RARITY_MAP: Record<string, RarityBucket> = {
  // Commons & uncommons
  Common: 'C',
  Uncommon: 'U',

  // Plain rares
  Rare: 'R',

  // Epic — non-secret holos and ex-class cards
  'Rare Holo': 'E',
  'Rare Holo EX': 'E',
  'Rare Holo GX': 'E',
  'Rare Holo V': 'E',
  'Rare Holo VMAX': 'E',
  'Rare Ultra': 'E',
  'Rare ACE': 'E',
  'Rare BREAK': 'E',
  'Rare Prism Star': 'E',
  'Amazing Rare': 'E',
  'Illustration Rare': 'E',
  'Double Rare': 'E',
  'Ultra Rare': 'E',

  // Legendary — secrets, hyper rares, rainbows, alt arts
  'Rare Rainbow': 'L',
  'Rare Secret': 'L',
  'Rare Shiny': 'L',
  'Rare Shiny GX': 'L',
  'Hyper Rare': 'L',
  'Rare Holo VSTAR': 'L',
  'Trainer Gallery Rare Holo': 'L',
  'Special Illustration Rare': 'L',
  'Shiny Rare': 'L',
  'Shiny Ultra Rare': 'L',
  'Radiant Rare': 'L',
};

/**
 * Mean prices per rarity bucket, used as a fallback when neither
 * tcgplayer.prices nor cardmarket.prices.averageSellPrice is available for a
 * card. Per ARCHITECTURE §14.2.
 */
export const RARITY_MEANS_CENTS: Record<RarityBucket, number> = {
  C: 5,
  U: 15,
  R: 75,
  E: 600,
  L: 5000,
};

export function normalizeRarity(raw: string | null | undefined): {
  bucket: RarityBucket;
  known: boolean;
} {
  if (!raw) return { bucket: 'R', known: false };
  const bucket = RARITY_MAP[raw];
  if (bucket) return { bucket, known: true };
  return { bucket: 'R', known: false };
}

export function rarityBucketMean(raw: string | null | undefined): number {
  const { bucket } = normalizeRarity(raw);
  return RARITY_MEANS_CENTS[bucket];
}
