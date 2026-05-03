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

    for (const setId of setIds) {
      const params = new URLSearchParams({
        q: `set.id:${setId}`,
        pageSize: String(PAGE_SIZE),
      });
      const url = `${BASE}/cards?${params.toString()}`;
      const res = await fetch(url, { headers });
      if (!res.ok) {
        throw new Error(
          `pokemontcg.io fetch failed for set "${setId}": ${res.status} ${res.statusText}`,
        );
      }
      const json = (await res.json()) as CardsResponse;
      const cards = json.data ?? [];
      const limited =
        opts?.perSet && opts.perSet < cards.length
          ? cards.slice(0, opts.perSet)
          : cards;
      out.push(...limited);
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
