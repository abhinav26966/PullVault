/**
 * Pack tier definitions. Numbers come straight from ARCHITECTURE §14.3 and
 * the rarity bucket means from §14.2. Every weight set is verified to sum to
 * 1.0 by tier-config.test.ts.
 */

export type Rarity = 'C' | 'U' | 'R' | 'E' | 'L';
export type Tier = 'BRONZE' | 'SILVER' | 'GOLD';
export type SlotType = 'FILLER' | 'RARE_FLOOR' | 'HIT' | 'JACKPOT';

export const RARITY_ORDER: readonly Rarity[] = ['C', 'U', 'R', 'E', 'L'];

export interface SlotConfig {
  readonly type: SlotType;
  readonly count: number;
  readonly weights: Readonly<Record<Rarity, number>>;
}

export interface TierConfig {
  readonly priceCents: number;
  readonly cardCount: number;
  readonly slots: readonly SlotConfig[];
}

export const TIER_CONFIG: Readonly<Record<Tier, TierConfig>> = {
  BRONZE: {
    priceCents: 499,
    cardCount: 5,
    slots: [
      { type: 'FILLER', count: 4, weights: { C: 0.7,  U: 0.28, R: 0.02, E: 0,    L: 0    } },
      { type: 'HIT',    count: 1, weights: { C: 0,    U: 0,    R: 0.8,  E: 0.18, L: 0.02 } },
    ],
  },
  SILVER: {
    priceCents: 1499,
    cardCount: 7,
    slots: [
      { type: 'FILLER',     count: 5, weights: { C: 0.65, U: 0.32, R: 0.03, E: 0,    L: 0    } },
      { type: 'RARE_FLOOR', count: 1, weights: { C: 0,    U: 0,    R: 0.9,  E: 0.09, L: 0.01 } },
      { type: 'HIT',        count: 1, weights: { C: 0,    U: 0,    R: 0.55, E: 0.35, L: 0.1  } },
    ],
  },
  GOLD: {
    priceCents: 4999,
    cardCount: 10,
    slots: [
      { type: 'FILLER',     count: 7, weights: { C: 0.55, U: 0.4,  R: 0.05, E: 0,    L: 0    } },
      { type: 'RARE_FLOOR', count: 2, weights: { C: 0,    U: 0,    R: 0.7,  E: 0.22, L: 0.08 } },
      { type: 'JACKPOT',    count: 1, weights: { C: 0,    U: 0,    R: 0.1,  E: 0.5,  L: 0.4  } },
    ],
  },
} as const;

/**
 * Rarity bucket means in cents. Used by computeTierEV for the documented
 * baseline EV calculation, and by the price pipeline as a fallback when a
 * card has no upstream price.
 */
export const RARITY_MEAN_CENTS: Readonly<Record<Rarity, number>> = {
  C: 5,
  U: 15,
  R: 75,
  E: 600,
  L: 5000,
};

/** Sanity helper: verify every slot's weights sum to 1.0 within tolerance. */
export function tierConfigInvariants(tolerance = 1e-9): { ok: boolean; failures: string[] } {
  const failures: string[] = [];
  for (const tier of Object.keys(TIER_CONFIG) as Tier[]) {
    const cfg = TIER_CONFIG[tier];
    let totalSlots = 0;
    for (const slot of cfg.slots) {
      const sum = RARITY_ORDER.reduce((acc, r) => acc + slot.weights[r], 0);
      if (Math.abs(sum - 1) > tolerance) {
        failures.push(`${tier}/${slot.type}: weights sum to ${sum}`);
      }
      totalSlots += slot.count;
    }
    if (totalSlots !== cfg.cardCount) {
      failures.push(`${tier}: slot count ${totalSlots} ≠ cardCount ${cfg.cardCount}`);
    }
  }
  return { ok: failures.length === 0, failures };
}
