import {
  RARITY_MEAN_CENTS,
  RARITY_ORDER,
  TIER_CONFIG,
  type Rarity,
  type Tier,
} from './tier-config';

export interface TierEv {
  /** Expected pack value, integer cents (rounded from the float computation). */
  readonly evCents: number;
  /** Sticker price minus EV, integer cents. */
  readonly marginCents: number;
  /** marginCents / priceCents, in [0, 1). */
  readonly marginPercent: number;
}

/**
 * Compute the documented expected value of a pack tier given a rarity-mean
 * map. Pure function — used by the economics dashboard live (with current
 * mean prices) and by tests (with the documented means from §14.2).
 */
export function computeTierEV(
  tier: Tier,
  rarityMeanCents: Readonly<Record<Rarity, number>> = RARITY_MEAN_CENTS,
): TierEv {
  const config = TIER_CONFIG[tier];
  let evCentsFloat = 0;
  for (const slot of config.slots) {
    let perSlotEv = 0;
    for (const r of RARITY_ORDER) {
      perSlotEv += slot.weights[r] * rarityMeanCents[r];
    }
    evCentsFloat += perSlotEv * slot.count;
  }
  const evCents = Math.round(evCentsFloat);
  const marginCents = config.priceCents - evCents;
  const marginPercent = marginCents / config.priceCents;
  return { evCents, marginCents, marginPercent };
}
