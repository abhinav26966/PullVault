import { describe, expect, it } from 'vitest';
import {
  groupPoolByRarity,
  RARITY_ORDER,
  samplePack,
  sha256Hex,
  type PoolEntry,
  type Rarity,
  type SlotConfig,
} from '../provably-fair/sampler';

/**
 * Locked HMAC-SHA256 byte-layout vectors. These are the digests for
 *
 *   server_seed = "a".repeat(64)        (UTF-8 ASCII bytes, treated as the HMAC key)
 *   payload     = `client-seed-fixed:test-pack:${i}`
 *
 * computed by `globalThis.crypto.subtle` on Node 22. The verify-page tests
 * exercise the same sampler in a browser; if the layout ever drifts (Buffer
 * vs Uint8Array, big- vs little-endian extraction, key-encoding change), one
 * of these vectors will flip and the test will fail loudly. That is
 * intentional — the build plan calls these "test vectors locked before
 * shipping" and the risk register flags HMAC determinism mismatch as the
 * highest-impact failure mode for B4.
 */
const LOCKED_DIGESTS: readonly string[] = [
  '8e554c5674b995d147ea665ab1371df6acc168cbe2ef73ea10ac8e3c2174aad4',
  '046d3ed82c32d7ab5985c96abd23d902acd57d68d002669954d9aae4bb5f0c79',
  'c6a48b9e26b765248edfe70ec9ec95df72f72e42187edb8f9b39b0ddccca6e9b',
  'fea260f7e75dc1846225020c59c3e329da5de698fe5099c14545ee9c97c0fda0',
  '5b432a89c08a988ba83d247b00c5bcd76ca6ef7b32a990f6b94a2b74fdde7ab1',
];

const FIXED_SEED = 'a'.repeat(64);
const FIXED_CLIENT_SEED = 'client-seed-fixed';
const FIXED_PACK_ID = 'test-pack';

function makePool(perBucket = 5): PoolEntry[] {
  const out: PoolEntry[] = [];
  for (const r of RARITY_ORDER) {
    for (let i = 0; i < perBucket; i++) out.push({ id: `${r}-${i}`, rarity: r });
  }
  return out;
}

const FIVE_SLOT_BRONZE: readonly SlotConfig[] = [
  { count: 4, weights: { C: 0.7, U: 0.28, R: 0.02, E: 0, L: 0 } },
  { count: 1, weights: { C: 0, U: 0, R: 0.8, E: 0.18, L: 0.02 } },
];

describe('sha256Hex — commit derivation', () => {
  it('hashes a 64-char server seed to a stable 64-char hex commit', async () => {
    const out = await sha256Hex(FIXED_SEED);
    expect(out).toHaveLength(64);
    // Locked vector — sha256("aaaa...64 chars").
    expect(out).toBe(
      'ffe054fe7ae0cb6dc65c3af9b61d5209f439851db43d0ba5997337df154668eb',
    );
  });

  it('flips by an arbitrary byte if the seed changes by one char', async () => {
    const a = await sha256Hex(FIXED_SEED);
    const b = await sha256Hex('b' + FIXED_SEED.slice(1));
    expect(a).not.toBe(b);
  });
});

describe('samplePack — HMAC determinism', () => {
  it('emits the locked per-slot digest hex (byte-layout vector)', async () => {
    const slots: readonly SlotConfig[] = [
      { count: 5, weights: { C: 1, U: 0, R: 0, E: 0, L: 0 } },
    ];
    const result = await samplePack({
      serverSeed: FIXED_SEED,
      clientSeed: FIXED_CLIENT_SEED,
      packId: FIXED_PACK_ID,
      slots,
      pool: makePool(),
    });
    expect(result).toHaveLength(5);
    for (let i = 0; i < 5; i++) {
      expect(
        result[i]!.digestHex,
        `slot ${i}: digest layout drifted — Node ↔ browser HMAC determinism broken`,
      ).toBe(LOCKED_DIGESTS[i]);
      expect(result[i]!.payload).toBe(`${FIXED_CLIENT_SEED}:${FIXED_PACK_ID}:${i}`);
    }
  });

  it('extracts fractions in [0, 1) from BE 64-bit windows', async () => {
    const slots: readonly SlotConfig[] = [
      { count: 1, weights: { C: 1, U: 0, R: 0, E: 0, L: 0 } },
    ];
    const [s] = await samplePack({
      serverSeed: FIXED_SEED,
      clientSeed: FIXED_CLIENT_SEED,
      packId: FIXED_PACK_ID,
      slots,
      pool: makePool(),
    });
    // Fractions derived from the locked digest vector above.
    expect(s!.bucketFraction).toBeCloseTo(0.5559890471529115, 14);
    expect(s!.cardFraction).toBeCloseTo(0.28092040743032637, 14);
    expect(s!.bucketFraction).toBeGreaterThanOrEqual(0);
    expect(s!.bucketFraction).toBeLessThan(1);
    expect(s!.cardFraction).toBeGreaterThanOrEqual(0);
    expect(s!.cardFraction).toBeLessThan(1);
  });

  it('is deterministic across repeat invocations', async () => {
    const a = await samplePack({
      serverSeed: FIXED_SEED,
      clientSeed: FIXED_CLIENT_SEED,
      packId: FIXED_PACK_ID,
      slots: FIVE_SLOT_BRONZE,
      pool: makePool(),
    });
    const b = await samplePack({
      serverSeed: FIXED_SEED,
      clientSeed: FIXED_CLIENT_SEED,
      packId: FIXED_PACK_ID,
      slots: FIVE_SLOT_BRONZE,
      pool: makePool(),
    });
    expect(b).toEqual(a);
  });

  it('changes every slot when the client seed flips one char', async () => {
    const a = await samplePack({
      serverSeed: FIXED_SEED,
      clientSeed: FIXED_CLIENT_SEED,
      packId: FIXED_PACK_ID,
      slots: FIVE_SLOT_BRONZE,
      pool: makePool(),
    });
    const b = await samplePack({
      serverSeed: FIXED_SEED,
      clientSeed: 'X' + FIXED_CLIENT_SEED.slice(1),
      packId: FIXED_PACK_ID,
      slots: FIVE_SLOT_BRONZE,
      pool: makePool(),
    });
    for (let i = 0; i < a.length; i++) {
      expect(b[i]!.digestHex).not.toBe(a[i]!.digestHex);
    }
  });
});

describe('samplePack — pool ordering', () => {
  it('sorts each rarity bucket by id ascending so insertion order is irrelevant', () => {
    const shuffled: PoolEntry[] = [
      { id: 'C-9', rarity: 'C' },
      { id: 'C-1', rarity: 'C' },
      { id: 'C-3', rarity: 'C' },
    ];
    const grouped = groupPoolByRarity(shuffled);
    expect(grouped.C.map((c) => c.id)).toEqual(['C-1', 'C-3', 'C-9']);
  });

  it('produces the same cardId regardless of input pool order', async () => {
    const poolA = makePool();
    const poolB = [...poolA].reverse();
    const a = await samplePack({
      serverSeed: FIXED_SEED,
      clientSeed: FIXED_CLIENT_SEED,
      packId: FIXED_PACK_ID,
      slots: FIVE_SLOT_BRONZE,
      pool: poolA,
    });
    const b = await samplePack({
      serverSeed: FIXED_SEED,
      clientSeed: FIXED_CLIENT_SEED,
      packId: FIXED_PACK_ID,
      slots: FIVE_SLOT_BRONZE,
      pool: poolB,
    });
    for (let i = 0; i < a.length; i++) {
      expect(b[i]!.cardId).toBe(a[i]!.cardId);
    }
  });
});

describe('samplePack — sparse pool fallback', () => {
  it('walks down to a populated bucket when the rolled rarity is empty', async () => {
    const sparsePool: PoolEntry[] = [];
    for (const r of ['C', 'U', 'R', 'E'] as Rarity[]) {
      for (let i = 0; i < 3; i++) sparsePool.push({ id: `${r}-${i}`, rarity: r });
    }
    const slots: readonly SlotConfig[] = [
      { count: 5, weights: { C: 0, U: 0, R: 0, E: 0, L: 1 } },
    ];
    const result = await samplePack({
      serverSeed: FIXED_SEED,
      clientSeed: FIXED_CLIENT_SEED,
      packId: FIXED_PACK_ID,
      slots,
      pool: sparsePool,
    });
    for (const s of result) {
      expect(s.bucketWanted).toBe('L');
      expect(['C', 'U', 'R', 'E']).toContain(s.bucket);
    }
  });

  it('throws when the pool is empty across every bucket', async () => {
    const slots: readonly SlotConfig[] = [
      { count: 1, weights: { C: 1, U: 0, R: 0, E: 0, L: 0 } },
    ];
    await expect(
      samplePack({
        serverSeed: FIXED_SEED,
        clientSeed: FIXED_CLIENT_SEED,
        packId: FIXED_PACK_ID,
        slots,
        pool: [],
      }),
    ).rejects.toThrow();
  });
});
