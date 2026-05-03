import { describe, expect, it } from 'vitest';
import { ANTI_SNIPE_EXTENSION_SECONDS, computeNewEndsAt } from '../anti-snipe';

describe('computeNewEndsAt — soft close anti-snipe', () => {
  const baseEnd = new Date('2026-05-03T12:00:00Z');

  it('extends when bid lands within the snipe window', () => {
    // Bid 5 seconds before close. New end = bid + 30s = T+25s.
    const bid = new Date('2026-05-03T11:59:55Z');
    const result = computeNewEndsAt(baseEnd, bid);
    expect(result.toISOString()).toBe('2026-05-03T12:00:25.000Z');
  });

  it('extends when bid lands AT close (race condition)', () => {
    const result = computeNewEndsAt(baseEnd, baseEnd);
    expect(result.toISOString()).toBe('2026-05-03T12:00:30.000Z');
  });

  it('does not shorten when bid is far from close', () => {
    const bid = new Date('2026-05-03T11:00:00Z');
    const result = computeNewEndsAt(baseEnd, bid);
    expect(result).toEqual(baseEnd);
  });

  it('extension is exactly 30 seconds by default', () => {
    expect(ANTI_SNIPE_EXTENSION_SECONDS).toBe(30);
  });

  it('respects a custom extension if provided', () => {
    const bid = new Date('2026-05-03T11:59:30Z');
    const result = computeNewEndsAt(baseEnd, bid, 60);
    // Bid + 60s = T+30s, > baseEnd (T+0), so extended.
    expect(result.toISOString()).toBe('2026-05-03T12:00:30.000Z');
  });
});
