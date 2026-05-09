/**
 * Per-slot-type floor weights — the platform-favorable extreme of each
 * slot's rarity envelope. The solver tilts between these floors and the
 * advertised aspirational weights from TIER_CONFIG.
 *
 * Each row sums to 1 and respects the slot's identity (FILLER stays
 * common-heavy, JACKPOT keeps a non-zero L weight, etc.). Without these
 * floors the solver could degenerate into "100% commons everywhere" at
 * high target margins.
 */

import type { Rarity, SlotType } from '../tier-config';

export const FLOOR_WEIGHTS: Readonly<Record<SlotType, Readonly<Record<Rarity, number>>>> = {
  FILLER:     { C: 0.95, U: 0.05, R: 0,    E: 0,    L: 0    },
  RARE_FLOOR: { C: 0,    U: 0,    R: 0.99, E: 0.01, L: 0    },
  HIT:        { C: 0,    U: 0,    R: 0.99, E: 0.01, L: 0    },
  JACKPOT:    { C: 0,    U: 0,    R: 0.9,  E: 0.09, L: 0.01 },
};
