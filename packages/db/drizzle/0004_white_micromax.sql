ALTER TYPE "public"."pullvault_auction_state" ADD VALUE 'SEALED' BEFORE 'CLOSED';--> statement-breakpoint
CREATE TABLE "auction_flags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"auction_id" uuid NOT NULL,
	"score" integer NOT NULL,
	"reasons" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reviewed_at" timestamp with time zone,
	"reviewed_by" uuid,
	"resolution" text
);
--> statement-breakpoint
DROP INDEX "auctions_open_user_card_uq";--> statement-breakpoint
ALTER TABLE "auctions" ADD COLUMN "extension_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "bids" ADD COLUMN "is_sealed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "auction_flags" ADD CONSTRAINT "auction_flags_auction_id_auctions_id_fk" FOREIGN KEY ("auction_id") REFERENCES "public"."auctions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auction_flags" ADD CONSTRAINT "auction_flags_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "auction_flags_auction_idx" ON "auction_flags" USING btree ("auction_id");--> statement-breakpoint
CREATE INDEX "auction_flags_unreviewed_idx" ON "auction_flags" USING btree ("created_at" DESC NULLS LAST) WHERE "auction_flags"."reviewed_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "auctions_open_user_card_uq" ON "auctions" USING btree ("user_card_id") WHERE "auctions"."state" IN ('OPEN', 'SEALED');