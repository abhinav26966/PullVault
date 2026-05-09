import type { InferInsertModel, InferSelectModel } from 'drizzle-orm';

export { db, queryClient, type DB } from './client';
export {
  getActiveSlots,
  getActiveSnapshot,
  recomputeAllTiers,
  type RecomputeOptions,
  type RecomputeResult,
  type TierRecomputeOutcome,
} from './economics/recompute';
export {
  ensurePlatformUser,
  ensureSampleDrops,
  runPipeline,
  type PipelineResult,
} from './price-pipeline/run-pipeline';
export * as schema from './schema';

// Re-export tables and enums directly so callers can `import { users } from
// '@pullvault/db'` without going through the schema namespace.
export {
  accountClusters,
  acquiredViaEnum,
  auctionFlags,
  auctionStateEnum,
  auctions,
  bids,
  cardPrices,
  cards,
  dropStateEnum,
  ledgerTypeEnum,
  listingStateEnum,
  listings,
  packCards,
  packDrops,
  packEconomicsSnapshots,
  packs,
  PLATFORM_USER_ID,
  rarityEnum,
  rateLimitAudit,
  slotTypeEnum,
  tierEnum,
  userCardStateEnum,
  userCards,
  walletLedger,
  wallets,
  users,
} from './schema';

import {
  accountClusters,
  auctionFlags,
  auctions,
  bids,
  cardPrices,
  cards,
  listings,
  packCards,
  packDrops,
  packEconomicsSnapshots,
  packs,
  rateLimitAudit,
  userCards,
  walletLedger,
  wallets,
  users,
} from './schema';

// Per-table row types (select shape) and insert shapes for each table.
export type User = InferSelectModel<typeof users>;
export type NewUser = InferInsertModel<typeof users>;

export type Wallet = InferSelectModel<typeof wallets>;
export type NewWallet = InferInsertModel<typeof wallets>;

export type WalletLedgerEntry = InferSelectModel<typeof walletLedger>;
export type NewWalletLedgerEntry = InferInsertModel<typeof walletLedger>;

export type Card = InferSelectModel<typeof cards>;
export type NewCard = InferInsertModel<typeof cards>;

export type CardPrice = InferSelectModel<typeof cardPrices>;
export type NewCardPrice = InferInsertModel<typeof cardPrices>;

export type UserCard = InferSelectModel<typeof userCards>;
export type NewUserCard = InferInsertModel<typeof userCards>;

export type PackDrop = InferSelectModel<typeof packDrops>;
export type NewPackDrop = InferInsertModel<typeof packDrops>;

export type Pack = InferSelectModel<typeof packs>;
export type NewPack = InferInsertModel<typeof packs>;

export type PackCard = InferSelectModel<typeof packCards>;
export type NewPackCard = InferInsertModel<typeof packCards>;

export type Listing = InferSelectModel<typeof listings>;
export type NewListing = InferInsertModel<typeof listings>;

export type Auction = InferSelectModel<typeof auctions>;
export type NewAuction = InferInsertModel<typeof auctions>;

export type Bid = InferSelectModel<typeof bids>;
export type NewBid = InferInsertModel<typeof bids>;

export type PackEconomicsSnapshot = InferSelectModel<typeof packEconomicsSnapshots>;
export type NewPackEconomicsSnapshot = InferInsertModel<typeof packEconomicsSnapshots>;

export type AccountCluster = InferSelectModel<typeof accountClusters>;
export type NewAccountCluster = InferInsertModel<typeof accountClusters>;

export type RateLimitAudit = InferSelectModel<typeof rateLimitAudit>;
export type NewRateLimitAudit = InferInsertModel<typeof rateLimitAudit>;

export type AuctionFlag = InferSelectModel<typeof auctionFlags>;
export type NewAuctionFlag = InferInsertModel<typeof auctionFlags>;
