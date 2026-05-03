import type { PriceSource } from './types';

/**
 * Stub. TCGplayer's developer API is closed to new applicants
 * (https://docs.tcgplayer.com/docs/getting-started). Until a key is granted,
 * this adapter must throw if invoked. Production reads pokemontcg.io's mirror,
 * which serves TCGplayer prices through its own feed.
 *
 * If access is ever granted (e.g. via affiliate program), implement the OAuth
 * client-credentials flow and the response-shape mapping in this file. The
 * rest of the pipeline does not need to change — see ARCHITECTURE §9.6.
 */
export const tcgplayerSource: PriceSource = {
  name: 'tcgplayer',

  async fetchCards() {
    throw new Error(
      'tcgplayerSource is not implemented. TCGplayer\'s developer API is closed ' +
        'to new applicants. PRICE_SOURCE=tcgplayer requires this adapter to be ' +
        'filled in (~3h: OAuth client-credentials + response mapping). See ' +
        'ARCHITECTURE §9.6.',
    );
  },

  extractPrice() {
    return null;
  },
};
