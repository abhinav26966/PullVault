import { describe, expect, it } from 'vitest';
import {
  RARITY_ORDER,
  TIER_CONFIG,
  tierConfigInvariants,
  type Tier,
} from '../tier-config';

describe('TIER_CONFIG invariants', () => {
  it('every slot weights sum to 1.0 within float tolerance', () => {
    const result = tierConfigInvariants();
    expect(result.failures).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it.each<[Tier, number]>([
    ['BRONZE', 5],
    ['SILVER', 7],
    ['GOLD', 10],
  ])('%s slot counts sum to documented cardCount %i', (tier, expected) => {
    const cfg = TIER_CONFIG[tier];
    const total = cfg.slots.reduce((acc, s) => acc + s.count, 0);
    expect(total).toBe(expected);
    expect(cfg.cardCount).toBe(expected);
  });

  it.each<[Tier, number]>([
    ['BRONZE', 499],
    ['SILVER', 1499],
    ['GOLD', 4999],
  ])('%s priceCents = %i', (tier, expected) => {
    expect(TIER_CONFIG[tier].priceCents).toBe(expected);
  });

  it('exposes the canonical rarity order C → U → R → E → L', () => {
    expect([...RARITY_ORDER]).toEqual(['C', 'U', 'R', 'E', 'L']);
  });
});
