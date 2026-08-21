-- oxy:deploy-phase=pre
-- oxy:rollback=derived
--
-- Guest sessions (#103, ADR 0003 D3): the `guest_sessions` table, its unique
-- token-hash index, the rotation-grace lookup index and the two purge-sweep
-- indexes.
--
-- `pre`, and it earns it: a brand-new table nothing serving selects from.
-- Creating it early is invisible to the image still serving; creating it late
-- would 500 the first guest issuance the NEW image performs. Nothing here
-- drops, renames or narrows anything.
--
-- (Regenerated as 0013 at integration, after #53's 0011 and #54's 0012.)
CREATE TABLE "guest_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"token_hash" text NOT NULL,
	"previous_token_hash" text,
	"previous_token_expires_at" timestamp with time zone,
	"client_class" text NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"rotated_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"converted_at" timestamp with time zone,
	"converted_to_oxy_user_id" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "guest_sessions_client_class_check" CHECK ("guest_sessions"."client_class" in ('web', 'ios', 'android', 'other')),
	CONSTRAINT "guest_sessions_previous_token_check" CHECK (num_nonnulls("guest_sessions"."previous_token_hash", "guest_sessions"."previous_token_expires_at") in (0, 2)),
	CONSTRAINT "guest_sessions_conversion_check" CHECK (num_nonnulls("guest_sessions"."converted_at", "guest_sessions"."converted_to_oxy_user_id") in (0, 2)),
	CONSTRAINT "guest_sessions_converted_revoked_check" CHECK ("guest_sessions"."converted_at" is null or "guest_sessions"."revoked_at" is not null)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "guest_sessions_token_hash_key" ON "guest_sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "guest_sessions_previous_token_hash_idx" ON "guest_sessions" USING btree ("previous_token_hash") WHERE "guest_sessions"."previous_token_hash" is not null;--> statement-breakpoint
CREATE INDEX "guest_sessions_expires_at_idx" ON "guest_sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "guest_sessions_revoked_at_idx" ON "guest_sessions" USING btree ("revoked_at") WHERE "guest_sessions"."revoked_at" is not null;