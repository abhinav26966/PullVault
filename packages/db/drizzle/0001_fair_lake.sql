CREATE TABLE "pack_economics_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tier" "pullvault_tier" NOT NULL,
	"weights" jsonb NOT NULL,
	"target_margin" numeric(5, 4) NOT NULL,
	"ev_cents" integer NOT NULL,
	"win_rate" numeric(5, 4) NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"notes" text
);
--> statement-breakpoint
ALTER TABLE "packs" ADD COLUMN "rarity_weights" jsonb;--> statement-breakpoint
CREATE UNIQUE INDEX "pack_economics_snapshots_active_tier_uq" ON "pack_economics_snapshots" USING btree ("tier") WHERE "pack_economics_snapshots"."is_active" = true;--> statement-breakpoint
CREATE INDEX "pack_economics_snapshots_tier_created_idx" ON "pack_economics_snapshots" USING btree ("tier","created_at" DESC NULLS LAST);