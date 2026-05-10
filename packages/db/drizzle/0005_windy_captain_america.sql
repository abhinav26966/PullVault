CREATE TABLE "pack_audit_aggregates" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "pack_audit_aggregates_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"tier" "pullvault_tier" NOT NULL,
	"rarity" "pullvault_rarity" NOT NULL,
	"observed_count" bigint NOT NULL,
	"expected_weight" numeric(10, 6) NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "seed_pool" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"commit" text NOT NULL,
	"server_seed" text NOT NULL,
	"used" boolean DEFAULT false NOT NULL,
	"used_for_pack_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"used_at" timestamp with time zone,
	CONSTRAINT "seed_pool_commit_unique" UNIQUE("commit")
);
--> statement-breakpoint
ALTER TABLE "packs" ADD COLUMN "server_seed_commit" text;--> statement-breakpoint
ALTER TABLE "packs" ADD COLUMN "server_seed" text;--> statement-breakpoint
ALTER TABLE "packs" ADD COLUMN "client_seed" text;--> statement-breakpoint
ALTER TABLE "packs" ADD COLUMN "eligible_card_ids" text[];--> statement-breakpoint
ALTER TABLE "seed_pool" ADD CONSTRAINT "seed_pool_used_for_pack_id_packs_id_fk" FOREIGN KEY ("used_for_pack_id") REFERENCES "public"."packs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pack_audit_aggregates_tier_at_idx" ON "pack_audit_aggregates" USING btree ("tier","computed_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "seed_pool_unused_idx" ON "seed_pool" USING btree ("created_at") WHERE "seed_pool"."used" = false;--> statement-breakpoint
CREATE INDEX "seed_pool_used_pack_idx" ON "seed_pool" USING btree ("used_for_pack_id") WHERE "seed_pool"."used_for_pack_id" IS NOT NULL;