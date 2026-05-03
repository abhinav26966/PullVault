type Tier = 'BRONZE' | 'SILVER' | 'GOLD';

const TIER_GRADIENT: Record<Tier, string> = {
  BRONZE: 'bg-gradient-to-br from-amber-700 via-orange-800 to-amber-900',
  SILVER: 'bg-gradient-to-br from-zinc-300 via-zinc-400 to-zinc-500',
  GOLD: 'bg-gradient-to-br from-yellow-400 via-amber-500 to-orange-500',
};

const TIER_EMOJI: Record<Tier, string> = {
  BRONZE: '📦',
  SILVER: '🎁',
  GOLD: '👑',
};

const SIZE_CLASSES: Record<'md' | 'lg', { box: string; emoji: string; label: string }> = {
  md: {
    box: 'w-[120px] h-[168px]',
    emoji: 'text-5xl',
    label: 'text-[10px]',
  },
  lg: {
    box: 'w-60 h-[336px]',
    emoji: 'text-7xl',
    label: 'text-xs',
  },
};

/**
 * Tier-themed unopened-pack visual. Used in /collection's "Unopened packs"
 * strip (md) and /packs/[id]'s pre-rip state (lg). Reads as a sealed pack
 * via gradient + emoji + lock icon, not a flat colored chip.
 */
export function PackTile({
  tier,
  size = 'md',
}: {
  tier: Tier;
  size?: 'md' | 'lg';
}) {
  const s = SIZE_CLASSES[size];
  return (
    <div
      className={`${TIER_GRADIENT[tier]} ${s.box} relative rounded-lg ring-1 ring-inset ring-white/20 shadow-md flex flex-col items-center justify-center transition`}
    >
      <span className={s.emoji} aria-hidden>
        {TIER_EMOJI[tier]}
      </span>
      <span
        className={`mt-3 ${s.label} uppercase tracking-widest font-bold text-white/90`}
      >
        {tier}
      </span>
      <span
        className="absolute bottom-2 right-2 text-white/60 text-sm"
        aria-hidden
      >
        🔒
      </span>
    </div>
  );
}
