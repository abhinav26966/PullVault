import type { PriceSource, RawCard } from './types';

const BASE = 'https://api.pokemontcg.io/v2';
const PAGE_SIZE = 250;
const USD_PER_EUR = 1.07;

// Priority for picking a price out of `tcgplayer.prices`. Holofoil first
// because hits typically come as holofoil; falls through to non-holo and
// the rarer foil printings as a last resort.
const TCGPLAYER_VARIANT_PRIORITY = [
  'holofoil',
  'normal',
  'reverseHolofoil',
  '1stEditionHolofoil',
  '1stEditionNormal',
] as const;

interface CardsResponse {
  data: RawCard[];
  page: number;
  pageSize: number;
  count: number;
  totalCount: number;
}

export const pokemonTcgSource: PriceSource = {
  name: 'pokemontcg',

  async fetchCards(setIds, opts) {
    const apiKey = process.env.POKEMON_TCG_API_KEY;
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (apiKey) headers['X-Api-Key'] = apiKey;

    const out: RawCard[] = [];

    // Per-set fault isolation: pokemontcg.io is a free public API and its
    // /v2/cards endpoint occasionally returns 504/404 for valid set ids
    // (Cloudflare timeouts, transient origin failures). A single bad set
    // should NOT abort the whole pipeline tick — the surviving sets still
    // carry useful price updates, and the next hourly tick will retry the
    // bad one. We log a warning so the failure is visible in the cron logs
    // but don't propagate.
    for (const setId of setIds) {
      try {
        const params = new URLSearchParams({
          q: `set.id:${setId}`,
          pageSize: String(PAGE_SIZE),
        });
        const url = `${BASE}/cards?${params.toString()}`;
        const res = await fetch(url, { headers });
        if (!res.ok) {
          console.warn(
            `[pokemontcg] skipping set "${setId}": ${res.status} ${res.statusText}`,
          );
          continue;
        }
        const json = (await res.json()) as CardsResponse;
        const cards = json.data ?? [];
        const limited =
          opts?.perSet && opts.perSet < cards.length
            ? cards.slice(0, opts.perSet)
            : cards;
        out.push(...limited);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[pokemontcg] skipping set "${setId}": ${msg}`);
      }
    }

    return out;
  },

  extractPrice(card) {
    const tcgPrices = card.tcgplayer?.prices;
    if (tcgPrices) {
      for (const variant of TCGPLAYER_VARIANT_PRIORITY) {
        const market = tcgPrices[variant]?.market;
        if (typeof market === 'number' && market > 0 && Number.isFinite(market)) {
          return Math.round(market * 100);
        }
      }
    }
    const cmAvg = card.cardmarket?.prices?.averageSellPrice;
    if (typeof cmAvg === 'number' && cmAvg > 0 && Number.isFinite(cmAvg)) {
      return Math.round(cmAvg * USD_PER_EUR * 100);
    }
    return null;
  },
};
