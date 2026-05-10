/**
 * Provably-fair pack sampler — Part B §12.
 *
 * One module, two callers: the server uses it inside the buy transaction to
 * roll cards, and the verify page (`/verify/[packId]`) imports the same code
 * and re-runs it client-side under Web Crypto. Same input → same output, byte
 * for byte. The brief's invariant: "The browser is the only oracle."
 *
 * Determinism rules (every choice here exists to keep Node and browser
 * agreeing on the last decimal):
 *
 * 1. HMAC primitive: WebCrypto SubtleCrypto, available on Node 18+ via
 *    `globalThis.crypto.subtle` and on every modern browser. We never touch
 *    `node:crypto` directly — that would silently use Buffer semantics that
 *    don't exist in the browser.
 *
 * 2. Byte layout: `Uint8Array` everywhere. No `Buffer`. The hex serializer
 *    walks bytes as numbers and emits two lowercase hex chars per byte.
 *
 * 3. Fraction extraction: take the first 8 bytes of the digest as a 64-bit
 *    big-endian unsigned integer (via BigInt for exactness), then divide by
 *    2^64 to land in [0, 1). The BigInt → Number conversion is spec-defined
 *    (round to nearest, ties to even) so both runtimes round identically.
 *
 * 4. Two fractions per slot: bytes [0..8) drive the rarity-bucket pick; bytes
 *    [8..16) drive the within-bucket card pick. Tail bytes [16..32) stay
 *    unused — reserved for future per-slot signals (e.g. a signed-bonus draw)
 *    without rewiring the byte layout.
 *
 * 5. Card-pool ordering: groups by rarity, then sorts each bucket by id
 *    ascending (lexicographic compare on the JS string). Both the server roll
 *    and the verify page sort the same way, so the same `cardFraction` picks
 *    the same card on both sides — independent of insertion order in the DB.
 *
 * 6. Sparse-bucket fallback mirrors `pack-roller.ts`: if the rolled rarity has
 *    zero eligible cards (trial-scale pool with thin L bucket), walk down to
 *    the next populated bucket, then up. Verify page does the same walk —
 *    bucket reported is the *resolved* bucket, not the originally-rolled one.
 */

export type Rarity = 'C' | 'U' | 'R' | 'E' | 'L';

export const RARITY_ORDER: readonly Rarity[] = ['C', 'U', 'R', 'E', 'L'];

export interface SlotConfig {
  readonly count: number;
  readonly weights: Readonly<Record<Rarity, number>>;
}

export interface PoolEntry {
  readonly id: string;
  readonly rarity: Rarity;
}

export interface SampleInput {
  /** Hex-encoded server seed; treated as a UTF-8 string for the HMAC key. */
  readonly serverSeed: string;
  /** Caller-provided client seed; 32–128 hex chars by API contract. */
  readonly clientSeed: string;
  readonly packId: string;
  readonly slots: readonly SlotConfig[];
  /** Eligible card pool snapshotted at purchase (`packs.eligible_card_ids`). */
  readonly pool: readonly PoolEntry[];
}

export interface SampledSlot {
  readonly slotIndex: number;
  readonly payload: string;
  readonly digestHex: string;
  /** Fraction in [0, 1) used to pick the rarity bucket. */
  readonly bucketFraction: number;
  /** Fraction in [0, 1) used to pick the card within the bucket. */
  readonly cardFraction: number;
  /** Resolved bucket (after the sparse-pool fallback walk). */
  readonly bucket: Rarity;
  /** Originally-rolled bucket from the slot's weight CDF, before fallback. */
  readonly bucketWanted: Rarity;
  readonly cardId: string;
}

const TEXT_ENCODER = new TextEncoder();
const TWO_POW_64 = 18446744073709551616; // exact: 2^64 in IEEE-754 double

function getSubtle(): SubtleCrypto {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error(
      'provably-fair sampler: globalThis.crypto.subtle unavailable — Node 18+ or modern browser required',
    );
  }
  return subtle;
}

function bytesToHex(bytes: Uint8Array): string {
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i]!.toString(16).padStart(2, '0');
  }
  return hex;
}

export async function sha256Hex(input: string): Promise<string> {
  const buf = await getSubtle().digest('SHA-256', TEXT_ENCODER.encode(input));
  return bytesToHex(new Uint8Array(buf));
}

async function hmacSha256(key: string, message: string): Promise<Uint8Array> {
  const cryptoKey = await getSubtle().importKey(
    'raw',
    TEXT_ENCODER.encode(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await getSubtle().sign('HMAC', cryptoKey, TEXT_ENCODER.encode(message));
  return new Uint8Array(sig);
}

function be8ToFraction(bytes: Uint8Array, offset: number): number {
  let n = 0n;
  for (let i = 0; i < 8; i++) {
    n = (n << 8n) | BigInt(bytes[offset + i]!);
  }
  return Number(n) / TWO_POW_64;
}

function pickRarity(weights: Readonly<Record<Rarity, number>>, fraction: number): Rarity {
  let acc = 0;
  for (const r of RARITY_ORDER) {
    acc += weights[r];
    if (fraction < acc) return r;
  }
  // Float-drift safety: fall back to the last non-zero bucket.
  for (let i = RARITY_ORDER.length - 1; i >= 0; i--) {
    const r = RARITY_ORDER[i]!;
    if (weights[r] > 0) return r;
  }
  throw new Error('sampler: empty rarity weights');
}

export function groupPoolByRarity(
  pool: readonly PoolEntry[],
): Record<Rarity, PoolEntry[]> {
  const out: Record<Rarity, PoolEntry[]> = { C: [], U: [], R: [], E: [], L: [] };
  for (const card of pool) out[card.rarity].push(card);
  for (const r of RARITY_ORDER) {
    out[r].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }
  return out;
}

function pickWithFallback(
  byRarity: Record<Rarity, PoolEntry[]>,
  wanted: Rarity,
  cardFraction: number,
): { card: PoolEntry; bucket: Rarity } {
  let bucket = wanted;
  let pool = byRarity[bucket];
  if (pool.length === 0) {
    const startIdx = RARITY_ORDER.indexOf(wanted);
    for (let j = startIdx - 1; j >= 0; j--) {
      const candidate = byRarity[RARITY_ORDER[j]!];
      if (candidate.length > 0) {
        bucket = RARITY_ORDER[j]!;
        pool = candidate;
        break;
      }
    }
    if (pool.length === 0) {
      for (let j = startIdx + 1; j < RARITY_ORDER.length; j++) {
        const candidate = byRarity[RARITY_ORDER[j]!];
        if (candidate.length > 0) {
          bucket = RARITY_ORDER[j]!;
          pool = candidate;
          break;
        }
      }
    }
    if (pool.length === 0) {
      throw new Error('sampler: pool empty across all rarity buckets');
    }
  }
  const idx = Math.min(pool.length - 1, Math.floor(cardFraction * pool.length));
  return { card: pool[idx]!, bucket };
}

export async function samplePack(input: SampleInput): Promise<SampledSlot[]> {
  const byRarity = groupPoolByRarity(input.pool);
  const out: SampledSlot[] = [];
  let i = 0;
  for (const slot of input.slots) {
    for (let s = 0; s < slot.count; s++) {
      const payload = `${input.clientSeed}:${input.packId}:${i}`;
      const digest = await hmacSha256(input.serverSeed, payload);
      const bucketFraction = be8ToFraction(digest, 0);
      const cardFraction = be8ToFraction(digest, 8);
      const wanted = pickRarity(slot.weights, bucketFraction);
      const { card, bucket } = pickWithFallback(byRarity, wanted, cardFraction);
      out.push({
        slotIndex: i,
        payload,
        digestHex: bytesToHex(digest),
        bucketFraction,
        cardFraction,
        bucket,
        bucketWanted: wanted,
        cardId: card.id,
      });
      i++;
    }
  }
  return out;
}
