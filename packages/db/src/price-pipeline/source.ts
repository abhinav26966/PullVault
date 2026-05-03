import { pokemonTcgSource } from './sources/pokemontcg';
import { tcgplayerSource } from './sources/tcgplayer';
import type { PriceSource } from './sources/types';

/**
 * Selected at module load. Default is `pokemontcg`. Switching sources is a
 * one-line env change (`PRICE_SOURCE=tcgplayer`) — the rest of the pipeline
 * imports `source` from here and never names a specific provider.
 *
 * See ARCHITECTURE §9.6 for the design rationale.
 */
export const source: PriceSource =
  process.env.PRICE_SOURCE === 'tcgplayer' ? tcgplayerSource : pokemonTcgSource;
