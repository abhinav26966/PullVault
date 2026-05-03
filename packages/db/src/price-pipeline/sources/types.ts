/**
 * Raw card payload from the upstream provider. We only declare the fields we
 * actually use — providers return many more.
 *
 * The adapter is deliberately narrow: the rest of the pipeline must not depend
 * on provider-specific shapes. If a new field is needed, add it here and let
 * each adapter map it.
 */
export interface RawCard {
  id: string;
  name: string;
  set: { id: string; name: string };
  number: string;
  rarity: string | null;
  images: { small: string; large: string };
  tcgplayer?: {
    prices?: Record<
      string,
      | {
          low?: number | null;
          mid?: number | null;
          high?: number | null;
          market?: number | null;
          directLow?: number | null;
        }
      | undefined
    >;
  };
  cardmarket?: {
    prices?: {
      averageSellPrice?: number | null;
      lowPrice?: number | null;
      trendPrice?: number | null;
    };
  };
}

export interface PriceSource {
  /** Stable identifier, used in logs and the admin economics dashboard. */
  name: 'pokemontcg' | 'tcgplayer';

  /** Fetch raw card data for the configured set IDs. */
  fetchCards(setIds: string[], opts?: { perSet?: number }): Promise<RawCard[]>;

  /** Extract price in cents from a raw card. Returns null if unavailable. */
  extractPrice(card: RawCard): number | null;
}
