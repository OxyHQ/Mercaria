-- oxy:deploy-phase=pre
-- oxy:rollback=derived
--
-- Unified sales-channel onboarding (#87).
--
-- Purely ADDITIVE. Two new tables and four nullable columns on `connections`,
-- so every statement the serving image performs keeps passing: it writes none
-- of the new columns, and both new CHECKs are satisfied by the NULLs it leaves.
--
-- ## Hand-written statements this file carries, and where they go on a
-- ## regeneration
--
-- `drizzle-kit generate` models no trigger, so a regeneration DROPS the block
-- at the END of this file. Re-append it verbatim after regenerating, and grep
-- for `mercaria_channel_audit_append_only` (one function, one trigger) plus
-- exactly one `^-- oxy:deploy-phase` line before pushing.
--
-- ## Why `channel_audit_events` is append-only and `channel_onboarding_sessions`
-- ## is not
--
-- An audit trail somebody can edit says whatever the last person to touch it
-- wanted, so both UPDATE and DELETE raise — `payment_repairs`' posture, and
-- deliberately NOT `analytics_events`', which permits DELETE because a
-- retention schedule needs it. There is no retention schedule here.
--
-- A session, by contrast, is mutable by design: it is a wizard's live state and
-- every step writes to it. Its immutability is narrower and lives in the
-- repository's CAS on `state = 'in_progress'`, which is what stops an activated
-- session being rewritten.

CREATE TABLE "channel_audit_events" (
	"id" text PRIMARY KEY NOT NULL,
	"store_id" text NOT NULL,
	"action" text NOT NULL,
	"channel_type" text,
	"connection_id" text,
	"feed_configuration_id" text,
	"actor_oxy_user_id" text NOT NULL,
	"changed_fields" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "channel_audit_events_action_check" CHECK ("channel_audit_events"."action" in ('connection_created', 'connection_reconnected', 'credentials_rotated', 'settings_updated', 'fetch_paused', 'fetch_resumed', 'publication_paused', 'publication_resumed', 'sync_requested', 'disconnected', 'channel_key_minted', 'channel_key_revoked', 'onboarding_started', 'onboarding_activated', 'onboarding_abandoned')),
	CONSTRAINT "channel_audit_events_channel_type_check" CHECK ("channel_audit_events"."channel_type" in ('shopify', 'woocommerce', 'woocommerce_plugin', 'etsy', 'prestashop', 'magento', 'product_feed', 'native'))
);
--> statement-breakpoint
CREATE TABLE "channel_onboarding_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"store_id" text NOT NULL,
	"channel_type" text NOT NULL,
	"state" text DEFAULT 'in_progress' NOT NULL,
	"step" text DEFAULT 'scope' NOT NULL,
	"connection_id" text,
	"feed_configuration_id" text,
	"merchant_id" text,
	"storefront_id" text,
	"preview_scanned" integer,
	"preview_matched" integer,
	"preview_created" integer,
	"preview_review" integer,
	"preview_invalid" integer,
	"preview_duplicate" integer,
	"previewed_at" timestamp with time zone,
	"activation_blockers" text[] DEFAULT '{}'::text[] NOT NULL,
	"started_by_oxy_user_id" text NOT NULL,
	"activated_at" timestamp with time zone,
	"abandoned_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "channel_onboarding_sessions_channel_type_check" CHECK ("channel_onboarding_sessions"."channel_type" in ('shopify', 'woocommerce', 'woocommerce_plugin', 'etsy', 'prestashop', 'magento', 'product_feed', 'native')),
	CONSTRAINT "channel_onboarding_sessions_state_check" CHECK ("channel_onboarding_sessions"."state" in ('in_progress', 'activated', 'abandoned')),
	CONSTRAINT "channel_onboarding_sessions_step_check" CHECK ("channel_onboarding_sessions"."step" in ('scope', 'select_channel', 'connect', 'configure', 'map', 'preview', 'activate')),
	CONSTRAINT "channel_onboarding_sessions_blockers_check" CHECK ("channel_onboarding_sessions"."activation_blockers" <@ array['no_preview', 'preview_scanned_nothing', 'preview_all_invalid', 'channel_limitation', 'unsupported_direction', 'connection_not_connected']::text[]),
	CONSTRAINT "channel_onboarding_sessions_preview_complete_check" CHECK (num_nonnulls("channel_onboarding_sessions"."preview_scanned", "channel_onboarding_sessions"."preview_matched", "channel_onboarding_sessions"."preview_created", "channel_onboarding_sessions"."preview_review", "channel_onboarding_sessions"."preview_invalid", "channel_onboarding_sessions"."preview_duplicate", "channel_onboarding_sessions"."previewed_at") in (0, 7)),
	CONSTRAINT "channel_onboarding_sessions_preview_total_check" CHECK ("channel_onboarding_sessions"."preview_scanned" is null or "channel_onboarding_sessions"."preview_scanned" = "channel_onboarding_sessions"."preview_matched" + "channel_onboarding_sessions"."preview_created" + "channel_onboarding_sessions"."preview_review" + "channel_onboarding_sessions"."preview_invalid" + "channel_onboarding_sessions"."preview_duplicate"),
	CONSTRAINT "channel_onboarding_sessions_terminal_check" CHECK (("channel_onboarding_sessions"."state" = 'activated' and "channel_onboarding_sessions"."activated_at" is not null and "channel_onboarding_sessions"."abandoned_at" is null)
       or ("channel_onboarding_sessions"."state" = 'abandoned' and "channel_onboarding_sessions"."abandoned_at" is not null and "channel_onboarding_sessions"."activated_at" is null)
       or ("channel_onboarding_sessions"."state" = 'in_progress' and "channel_onboarding_sessions"."activated_at" is null and "channel_onboarding_sessions"."abandoned_at" is null)),
	CONSTRAINT "channel_onboarding_sessions_activated_target_check" CHECK ("channel_onboarding_sessions"."state" <> 'activated' or num_nonnulls("channel_onboarding_sessions"."connection_id", "channel_onboarding_sessions"."feed_configuration_id") = 1)
);
--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "fetch_paused_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "publication_paused_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "disconnect_policy" text;--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "disconnected_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "channel_audit_events" ADD CONSTRAINT "channel_audit_events_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_audit_events" ADD CONSTRAINT "channel_audit_events_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_audit_events" ADD CONSTRAINT "channel_audit_events_feed_configuration_id_feed_configurations_id_fk" FOREIGN KEY ("feed_configuration_id") REFERENCES "public"."feed_configurations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_onboarding_sessions" ADD CONSTRAINT "channel_onboarding_sessions_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_onboarding_sessions" ADD CONSTRAINT "channel_onboarding_sessions_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_onboarding_sessions" ADD CONSTRAINT "channel_onboarding_sessions_feed_configuration_id_feed_configurations_id_fk" FOREIGN KEY ("feed_configuration_id") REFERENCES "public"."feed_configurations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_onboarding_sessions" ADD CONSTRAINT "channel_onboarding_sessions_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_onboarding_sessions" ADD CONSTRAINT "channel_onboarding_sessions_storefront_id_storefronts_id_fk" FOREIGN KEY ("storefront_id") REFERENCES "public"."storefronts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "channel_audit_events_store_id_created_at_idx" ON "channel_audit_events" USING btree ("store_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "channel_onboarding_sessions_live_key" ON "channel_onboarding_sessions" USING btree ("store_id","channel_type") WHERE state = 'in_progress';--> statement-breakpoint
CREATE INDEX "channel_onboarding_sessions_store_id_created_at_idx" ON "channel_onboarding_sessions" USING btree ("store_id","created_at" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_disconnect_policy_check" CHECK ("connections"."disconnect_policy" in ('keep_listings', 'unpublish_listings', 'archive_listings'));--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_disconnect_record_check" CHECK (num_nonnulls("connections"."disconnect_policy", "connections"."disconnected_at") in (0, 2));
--> statement-breakpoint
-- ── Hand-written: re-apply after any regeneration ──────────────────────────
CREATE FUNCTION mercaria_channel_audit_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION
      'channel_audit_events is append-only: an audit trail somebody can edit records whatever the last person to touch it wanted'
      USING ERRCODE = 'check_violation';
  END IF;
  -- The PRECISE delete exception, #90's `listing_condition_revisions` device.
  --
  -- A blanket DELETE refusal reads as the stricter choice and is the wrong one:
  -- `channel_audit_events.store_id` is `ON DELETE CASCADE`, so refusing every
  -- delete makes a store with any channel history undeletable forever — the
  -- cascade the foreign key declares can never run. Found by
  -- `channels.realdb.test.ts` on its first run, which is the whole reason a
  -- trigger needs a real server behind it.
  --
  -- So the exception is exactly as wide as the cascade and no wider: an entry
  -- may go WITH the store it describes, and never on its own. An operator
  -- removing one line to hide it is still refused, because the store is still
  -- there when they try.
  IF EXISTS (SELECT 1 FROM stores WHERE id = OLD.store_id) THEN
    RAISE EXCEPTION
      'a channel audit event can only be removed with the store it belongs to'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN OLD;
END;
$$;--> statement-breakpoint
CREATE TRIGGER channel_audit_events_append_only
  BEFORE UPDATE OR DELETE ON "channel_audit_events"
  FOR EACH ROW EXECUTE FUNCTION mercaria_channel_audit_append_only();

