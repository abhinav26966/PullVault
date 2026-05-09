CREATE TABLE "account_clusters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reason" text NOT NULL,
	"user_ids" uuid[] NOT NULL,
	"signal_data" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rate_limit_audit" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "rate_limit_audit_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"scope" text NOT NULL,
	"scope_id" text NOT NULL,
	"endpoint" text NOT NULL,
	"blocked_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pack_drops" ADD COLUMN "lottery_resolved" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "signup_ip" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "signup_ua_hash" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "signup_tz_offset" integer;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "bot_score" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "flag_multi_account" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX "account_clusters_created_idx" ON "account_clusters" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "rate_limit_audit_endpoint_at_idx" ON "rate_limit_audit" USING btree ("endpoint","blocked_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "pack_drops_lottery_pending_idx" ON "pack_drops" USING btree ("starts_at") WHERE "pack_drops"."state" = 'OPEN' AND "pack_drops"."lottery_resolved" = false;--> statement-breakpoint
CREATE INDEX "users_signup_ip_idx" ON "users" USING btree ("signup_ip") WHERE "users"."signup_ip" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "users_bot_score_idx" ON "users" USING btree ("bot_score" DESC NULLS LAST) WHERE "users"."bot_score" > 50;