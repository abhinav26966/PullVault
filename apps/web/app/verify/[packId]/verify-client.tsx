'use client';

import { useEffect, useState } from 'react';
import {
  samplePack,
  sha256Hex,
  type PfPoolEntry,
  type PfSlotConfig,
  type Rarity,
  type SampledSlot,
} from '@pullvault/domain';

interface VerifyData {
  pack: { id: string; tier: string; purchasedAt: string; openedAt: string | null };
  rarityWeights: { slots: Array<{ count: number; weights: Record<Rarity, number>; type?: string }> } | null;
  serverSeedCommit: string | null;
  serverSeed: string | null;
  clientSeed: string | null;
  eligibleCardIds: string[] | null;
  revealedCards: Array<{
    position: number;
    cardId: string;
    slotType: string;
    rarityAtPull: Rarity;
  }>;
  cards: Array<{ id: string; name: string; rarity: Rarity; imageUrlSmall: string }>;
  prices: Array<{ id: string; price: number }>;
}

/** Pre-PF packs (those purchased before B4 shipped) carry NULL crypto fields.
 *  Computed client-side so the API stays a pure data dump — no server-side
 *  boolean about verifiability. */
function isPreProvablyFair(data: VerifyData): boolean {
  return (
    data.serverSeed === null ||
    data.serverSeedCommit === null ||
    data.clientSeed === null ||
    data.eligibleCardIds === null
  );
}

interface VerifyResult {
  commitOk: boolean;
  computedCommit: string;
  slotResults: Array<{
    slot: SampledSlot;
    revealed: VerifyData['revealedCards'][number] | undefined;
    cardName: string;
    revealedName: string;
    matches: boolean;
  }>;
  allSlotsOk: boolean;
}

export default function VerifyClient({ data }: { data: VerifyData }) {
  const [verify, setVerify] = useState<VerifyResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isPreProvablyFair(data)) return;
    if (
      !data.serverSeed ||
      !data.serverSeedCommit ||
      !data.clientSeed ||
      !data.eligibleCardIds ||
      !data.rarityWeights?.slots
    ) {
      setError('Pack is missing one or more provably-fair fields.');
      return;
    }

    let cancelled = false;
    void (async () => {
      try {
        // Step 1: SHA-256(server_seed) must equal the published commit.
        const computedCommit = await sha256Hex(data.serverSeed!);
        const commitOk = computedCommit === data.serverSeedCommit;

        // Step 2: per-slot HMAC recomputation.
        const cardById = new Map(data.cards.map((c) => [c.id, c]));
        const pool: PfPoolEntry[] = data.eligibleCardIds!
          .map((id) => {
            const c = cardById.get(id);
            return c ? { id: c.id, rarity: c.rarity } : null;
          })
          .filter((x): x is PfPoolEntry => x !== null);

        const slots: PfSlotConfig[] = data.rarityWeights!.slots.map((s) => ({
          count: s.count,
          weights: s.weights,
        }));

        const sampled = await samplePack({
          serverSeed: data.serverSeed!,
          clientSeed: data.clientSeed!,
          packId: data.pack.id,
          slots,
          pool,
        });

        const slotResults = sampled.map((s) => {
          const revealed = data.revealedCards.find((r) => r.position === s.slotIndex);
          const cardName = cardById.get(s.cardId)?.name ?? s.cardId;
          const revealedName = revealed
            ? cardById.get(revealed.cardId)?.name ?? revealed.cardId
            : '—';
          return {
            slot: s,
            revealed,
            cardName,
            revealedName,
            matches: revealed ? revealed.cardId === s.cardId : false,
          };
        });

        const allSlotsOk = commitOk && slotResults.every((r) => r.matches);
        if (!cancelled)
          setVerify({ commitOk, computedCommit, slotResults, allSlotsOk });
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [data]);

  if (isPreProvablyFair(data)) {
    return (
      <div className="border border-zinc-200 rounded-lg p-4 bg-zinc-50">
        <p className="font-medium">Pre-provably-fair pack — not verifiable.</p>
        <p className="text-sm text-zinc-600 mt-1">
          This pack was minted before Part B§12 shipped. Packs purchased after
          launch carry a pre-published seed commitment; this one does not.
        </p>
      </div>
    );
  }

  if (error) {
    return <p className="text-red-600">Verification error: {error}</p>;
  }
  if (!verify) {
    return <p className="text-zinc-600">Verifying in browser…</p>;
  }

  return (
    <div className="space-y-6">
      <VerdictBanner verify={verify} />
      <CommitStep verify={verify} data={data} />
      <SlotTable verify={verify} data={data} />
    </div>
  );
}

function VerdictBanner({ verify }: { verify: VerifyResult }) {
  const tone = verify.allSlotsOk
    ? 'bg-green-50 border-green-300 text-green-900'
    : 'bg-red-50 border-red-300 text-red-900';
  const label = verify.allSlotsOk ? 'VERIFIED' : 'MISMATCH';
  const detail = verify.allSlotsOk
    ? 'All slots verified — commit and every HMAC slot matched the revealed cards.'
    : verify.commitOk
      ? `Commit matched, but at least one slot diverged. Walk the per-slot table for the failing row.`
      : `SHA-256 of server_seed does not match the published commit. Either the seed or the commit was tampered with.`;
  return (
    <div className={`border rounded-lg p-4 ${tone}`}>
      <div className="text-2xl font-semibold">{label}</div>
      <p className="text-sm mt-1">{detail}</p>
    </div>
  );
}

function CommitStep({ verify, data }: { verify: VerifyResult; data: VerifyData }) {
  return (
    <section className="space-y-2">
      <h2 className="text-lg font-medium">
        Step 1 — SHA-256(server_seed) ?= commit
      </h2>
      <div className="space-y-1 text-xs font-mono break-all">
        <div>
          <span className="text-zinc-500">server_seed&nbsp;&nbsp;&nbsp;: </span>
          {data.serverSeed}
        </div>
        <div>
          <span className="text-zinc-500">SHA-256(seed) : </span>
          <span className={verify.commitOk ? 'text-green-700' : 'text-red-700'}>
            {verify.computedCommit}
          </span>
        </div>
        <div>
          <span className="text-zinc-500">commit (DB)&nbsp;&nbsp;&nbsp;: </span>
          {data.serverSeedCommit}
        </div>
      </div>
      <p
        className={
          verify.commitOk
            ? 'text-sm text-green-700'
            : 'text-sm text-red-700 font-medium'
        }
      >
        {verify.commitOk ? '✓ Commit matches.' : '✗ Commit mismatch — server_seed or commit was tampered.'}
      </p>
    </section>
  );
}

function SlotTable({ verify, data }: { verify: VerifyResult; data: VerifyData }) {
  return (
    <section className="space-y-3">
      <h2 className="text-lg font-medium">Step 2 — per-slot HMAC recomputation</h2>
      <p className="text-sm text-zinc-600">
        For each slot <code>i</code>, payload is{' '}
        <code className="text-xs">
          {data.clientSeed}:{data.pack.id}:i
        </code>
        . Bytes [0..8) drive the rarity bucket; bytes [8..16) drive the
        within-bucket card pick.
      </p>
      <div className="overflow-x-auto">
        <table className="w-full text-xs font-mono">
          <thead>
            <tr className="border-b border-zinc-300 text-left">
              <th className="px-2 py-2">i</th>
              <th className="px-2 py-2">HMAC digest (first 16 hex)</th>
              <th className="px-2 py-2">bucket frac</th>
              <th className="px-2 py-2">bucket</th>
              <th className="px-2 py-2">card frac</th>
              <th className="px-2 py-2">computed card</th>
              <th className="px-2 py-2">revealed card</th>
              <th className="px-2 py-2">match</th>
            </tr>
          </thead>
          <tbody>
            {verify.slotResults.map(({ slot, revealed, cardName, revealedName, matches }) => (
              <tr
                key={slot.slotIndex}
                className={`border-b border-zinc-100 ${matches ? '' : 'bg-red-50'}`}
              >
                <td className="px-2 py-1.5">{slot.slotIndex}</td>
                <td className="px-2 py-1.5">
                  <span className="font-bold">{slot.digestHex.slice(0, 16)}</span>
                  <span className="text-zinc-400">{slot.digestHex.slice(16)}</span>
                </td>
                <td className="px-2 py-1.5">{slot.bucketFraction.toFixed(6)}</td>
                <td className="px-2 py-1.5">{slot.bucket}</td>
                <td className="px-2 py-1.5">{slot.cardFraction.toFixed(6)}</td>
                <td className="px-2 py-1.5">
                  <div>{cardName}</div>
                  <div className="text-zinc-400">{slot.cardId}</div>
                </td>
                <td className="px-2 py-1.5">
                  <div>{revealedName}</div>
                  <div className="text-zinc-400">{revealed?.cardId ?? '—'}</div>
                </td>
                <td className="px-2 py-1.5">
                  {matches ? (
                    <span className="text-green-700">✓</span>
                  ) : (
                    <span className="text-red-700 font-bold">✗</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
