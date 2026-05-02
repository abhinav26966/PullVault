CREATE TYPE "public"."pullvault_acquired_via" AS ENUM('PACK', 'LISTING', 'AUCTION');--> statement-breakpoint
CREATE TYPE "public"."pullvault_auction_state" AS ENUM('OPEN', 'CLOSED', 'SETTLED');--> statement-breakpoint
CREATE TYPE "public"."pullvault_drop_state" AS ENUM('SCHEDULED', 'OPEN', 'SOLD_OUT', 'CLOSED');--> statement-breakpoint
CREATE TYPE "public"."pullvault_ledger_type" AS ENUM('SIGNUP_BONUS', 'PACK_PURCHASE', 'LISTING_PURCHASE', 'LISTING_SALE', 'LISTING_FEE', 'AUCTION_HOLD', 'AUCTION_RELEASE', 'AUCTION_SETTLE_BUYER', 'AUCTION_SETTLE_SELLER', 'AUCTION_FEE');--> statement-breakpoint
CREATE TYPE "public"."pullvault_listing_state" AS ENUM('ACTIVE', 'SOLD', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."pullvault_rarity" AS ENUM('C', 'U', 'R', 'E', 'L');--> statement-breakpoint
CREATE TYPE "public"."pullvault_slot_type" AS ENUM('FILLER', 'RARE_FLOOR', 'HIT', 'JACKPOT');--> statement-breakpoint
CREATE TYPE "public"."pullvault_tier" AS ENUM('BRONZE', 'SILVER', 'GOLD');--> statement-breakpoint
CREATE TYPE "public"."pullvault_user_card_state" AS ENUM('OWNED', 'LISTED', 'AUCTIONED', 'TRANSFERRED');--> statement-breakpoint
CREATE TABLE "auctions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"seller_id" uuid NOT NULL,
	"user_card_id" uuid NOT NULL,
	"starting_bid" bigint NOT NULL,
	"current_bid_amount" bigint,
	"current_bid_user_id" uuid,
	"starts_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"state" "pullvault_auction_state" DEFAULT 'OPEN' NOT NULL,
	"settled_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "bids" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"auction_id" uuid NOT NULL,
	"bidder_id" uuid NOT NULL,
	"amount" bigint NOT NULL,
	"placed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "card_prices" (
	"card_id" text PRIMARY KEY NOT NULL,
	"price" bigint NOT NULL,
	"baseline" bigint NOT NULL,
	"last_real_poll_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cards" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"set_id" text NOT NULL,
	"set_name" text NOT NULL,
	"number" text NOT NULL,
	"rarity_raw" text NOT NULL,
	"rarity" "pullvault_rarity" NOT NULL,
	"image_url" text NOT NULL,
	"image_url_small" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "listings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"seller_id" uuid NOT NULL,
	"user_card_id" uuid NOT NULL,
	"price" bigint NOT NULL,
	"state" "pullvault_listing_state" DEFAULT 'ACTIVE' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sold_at" timestamp with time zone,
	"buyer_id" uuid
);
--> statement-breakpoint
CREATE TABLE "pack_cards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pack_id" uuid NOT NULL,
	"card_id" text NOT NULL,
	"position" integer NOT NULL,
	"slot_type" "pullvault_slot_type" NOT NULL,
	"rarity_at_pull" "pullvault_rarity" NOT NULL,
	"revealed" boolean DEFAULT false NOT NULL,
	"revealed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "pack_drops" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tier" "pullvault_tier" NOT NULL,
	"price_cents" bigint NOT NULL,
	"inventory_total" integer NOT NULL,
	"inventory_remaining" integer NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"state" "pullvault_drop_state" DEFAULT 'SCHEDULED' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pack_drops_inventory_remaining_nonneg" CHECK ("pack_drops"."inventory_remaining" >= 0)
);
--> statement-breakpoint
CREATE TABLE "packs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"drop_id" uuid NOT NULL,
	"tier" "pullvault_tier" NOT NULL,
	"price_paid" bigint NOT NULL,
	"purchased_at" timestamp with time zone DEFAULT now() NOT NULL,
	"opened_at" timestamp with time zone,
	"pack_ev_at_purchase" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_cards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"card_id" text NOT NULL,
	"acquired_at" timestamp with time zone DEFAULT now() NOT NULL,
	"acquired_price" bigint NOT NULL,
	"acquired_via" "pullvault_acquired_via" NOT NULL,
	"state" "pullvault_user_card_state" DEFAULT 'OWNED' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"display_name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email"),
	CONSTRAINT "users_display_name_unique" UNIQUE("display_name")
);
--> statement-breakpoint
CREATE TABLE "wallet_ledger" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"type" "pullvault_ledger_type" NOT NULL,
	"amount" bigint NOT NULL,
	"pack_id" uuid,
	"listing_id" uuid,
	"auction_id" uuid,
	"bid_id" uuid,
	"meta" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wallets" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"balance_available" bigint DEFAULT 0 NOT NULL,
	"balance_held" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wallets_balance_available_nonneg" CHECK ("wallets"."balance_available" >= 0),
	CONSTRAINT "wallets_balance_held_nonneg" CHECK ("wallets"."balance_held" >= 0)
);
--> statement-breakpoint
ALTER TABLE "auctions" ADD CONSTRAINT "auctions_seller_id_users_id_fk" FOREIGN KEY ("seller_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auctions" ADD CONSTRAINT "auctions_user_card_id_user_cards_id_fk" FOREIGN KEY ("user_card_id") REFERENCES "public"."user_cards"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auctions" ADD CONSTRAINT "auctions_current_bid_user_id_users_id_fk" FOREIGN KEY ("current_bid_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bids" ADD CONSTRAINT "bids_auction_id_auctions_id_fk" FOREIGN KEY ("auction_id") REFERENCES "public"."auctions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bids" ADD CONSTRAINT "bids_bidder_id_users_id_fk" FOREIGN KEY ("bidder_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_prices" ADD CONSTRAINT "card_prices_card_id_cards_id_fk" FOREIGN KEY ("card_id") REFERENCES "public"."cards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listings" ADD CONSTRAINT "listings_seller_id_users_id_fk" FOREIGN KEY ("seller_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listings" ADD CONSTRAINT "listings_user_card_id_user_cards_id_fk" FOREIGN KEY ("user_card_id") REFERENCES "public"."user_cards"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listings" ADD CONSTRAINT "listings_buyer_id_users_id_fk" FOREIGN KEY ("buyer_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pack_cards" ADD CONSTRAINT "pack_cards_pack_id_packs_id_fk" FOREIGN KEY ("pack_id") REFERENCES "public"."packs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pack_cards" ADD CONSTRAINT "pack_cards_card_id_cards_id_fk" FOREIGN KEY ("card_id") REFERENCES "public"."cards"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "packs" ADD CONSTRAINT "packs_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "packs" ADD CONSTRAINT "packs_drop_id_pack_drops_id_fk" FOREIGN KEY ("drop_id") REFERENCES "public"."pack_drops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_cards" ADD CONSTRAINT "user_cards_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_cards" ADD CONSTRAINT "user_cards_card_id_cards_id_fk" FOREIGN KEY ("card_id") REFERENCES "public"."cards"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_ledger" ADD CONSTRAINT "wallet_ledger_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_ledger" ADD CONSTRAINT "wallet_ledger_pack_id_packs_id_fk" FOREIGN KEY ("pack_id") REFERENCES "public"."packs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_ledger" ADD CONSTRAINT "wallet_ledger_listing_id_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."listings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_ledger" ADD CONSTRAINT "wallet_ledger_auction_id_auctions_id_fk" FOREIGN KEY ("auction_id") REFERENCES "public"."auctions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_ledger" ADD CONSTRAINT "wallet_ledger_bid_id_bids_id_fk" FOREIGN KEY ("bid_id") REFERENCES "public"."bids"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallets" ADD CONSTRAINT "wallets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "auctions_open_user_card_uq" ON "auctions" USING btree ("user_card_id") WHERE "auctions"."state" = 'OPEN';--> statement-breakpoint
CREATE INDEX "auctions_state_ends_at_idx" ON "auctions" USING btree ("state","ends_at");--> statement-breakpoint
CREATE INDEX "auctions_seller_idx" ON "auctions" USING btree ("seller_id");--> statement-breakpoint
CREATE INDEX "bids_auction_placed_idx" ON "bids" USING btree ("auction_id","placed_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "cards_rarity_idx" ON "cards" USING btree ("rarity");--> statement-breakpoint
CREATE INDEX "cards_set_id_idx" ON "cards" USING btree ("set_id");--> statement-breakpoint
CREATE UNIQUE INDEX "listings_active_user_card_uq" ON "listings" USING btree ("user_card_id") WHERE "listings"."state" = 'ACTIVE';--> statement-breakpoint
CREATE INDEX "listings_state_created_idx" ON "listings" USING btree ("state","created_at");--> statement-breakpoint
CREATE INDEX "listings_seller_idx" ON "listings" USING btree ("seller_id");--> statement-breakpoint
CREATE INDEX "pack_cards_pack_position_idx" ON "pack_cards" USING btree ("pack_id","position");--> statement-breakpoint
CREATE INDEX "pack_drops_state_starts_at_idx" ON "pack_drops" USING btree ("state","starts_at");--> statement-breakpoint
CREATE INDEX "packs_owner_idx" ON "packs" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "packs_drop_id_idx" ON "packs" USING btree ("drop_id");--> statement-breakpoint
CREATE INDEX "user_cards_owner_state_idx" ON "user_cards" USING btree ("owner_id","state");--> statement-breakpoint
CREATE INDEX "user_cards_card_id_idx" ON "user_cards" USING btree ("card_id");--> statement-breakpoint
CREATE INDEX "wallet_ledger_user_created_idx" ON "wallet_ledger" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "wallet_ledger_type_created_idx" ON "wallet_ledger" USING btree ("type","created_at");--> statement-breakpoint
CREATE INDEX "wallet_ledger_auction_idx" ON "wallet_ledger" USING btree ("auction_id");--> statement-breakpoint
CREATE INDEX "wallet_ledger_listing_idx" ON "wallet_ledger" USING btree ("listing_id");