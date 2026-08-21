-- oxy:deploy-phase=pre
-- oxy:rollback=restore: catalog_merge_jobs_phase_check and its two siblings are widened for the saves phase; the previous forms are in 0038 and re-adding them fails against any job that recorded it
--
-- Product and variant price alerts (#79).
--
-- Purely ADDITIVE. Five new tables, and three WIDENINGS of the curation phase
-- CHECKs for the `alerts` phase #79 adds to a merge and to a split — each a
-- drop-and-re-add whose new tuple is a strict SUPERSET of the old, so every
-- write the serving image performs still passes and no in-flight job is
-- invalidated. A merge or split job already running keeps its phase; the new
-- phase is simply one more the next run can reach.
--
-- Nothing here narrows, renames or drops, which is why it is `pre`: the image
-- that applies it can be the one running before the deploy.
--

CREATE TABLE "price_alert_evaluations" (
	"id" text PRIMARY KEY NOT NULL,
	"canonical_product_id" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"requested_revision" integer DEFAULT 1 NOT NULL,
	"claimed_revision" integer,
	"attempts" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone NOT NULL,
	"lease_owner" text,
	"lease_until" timestamp with time zone,
	"last_failure" text,
	"last_evaluated_at" timestamp with time zone,
	"last_evaluated_alerts" integer,
	"last_qualified_alerts" integer,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "price_alert_evaluations_state_check" CHECK ("price_alert_evaluations"."state" in ('pending', 'processing', 'done', 'dead_letter')),
	CONSTRAINT "price_alert_evaluations_attempts_check" CHECK ("price_alert_evaluations"."attempts" >= 0),
	CONSTRAINT "price_alert_evaluations_revision_check" CHECK ("price_alert_evaluations"."requested_revision" >= 1),
	CONSTRAINT "price_alert_evaluations_claimed_revision_check" CHECK ("price_alert_evaluations"."claimed_revision" is null or "price_alert_evaluations"."claimed_revision" <= "price_alert_evaluations"."requested_revision"),
	CONSTRAINT "price_alert_evaluations_counters_check" CHECK (("price_alert_evaluations"."last_evaluated_alerts" is null or "price_alert_evaluations"."last_evaluated_alerts" >= 0)
          and ("price_alert_evaluations"."last_qualified_alerts" is null or "price_alert_evaluations"."last_qualified_alerts" >= 0)
          and coalesce("price_alert_evaluations"."last_qualified_alerts", 0) <= coalesce("price_alert_evaluations"."last_evaluated_alerts", 0))
);
--> statement-breakpoint
CREATE TABLE "price_alert_notifications" (
	"id" text PRIMARY KEY NOT NULL,
	"trigger_id" text NOT NULL,
	"alert_id" text NOT NULL,
	"channel" text NOT NULL,
	"state" text DEFAULT 'queued' NOT NULL,
	"suppression_reason" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone NOT NULL,
	"lease_owner" text,
	"lease_until" timestamp with time zone,
	"failure_reason" text,
	"delivered_at" timestamp with time zone,
	"notification_id" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "price_alert_notifications_channel_check" CHECK ("price_alert_notifications"."channel" in ('oxy_notification', 'email')),
	CONSTRAINT "price_alert_notifications_state_check" CHECK ("price_alert_notifications"."state" in ('queued', 'delivering', 'delivered', 'failed', 'suppressed', 'dead_letter')),
	CONSTRAINT "price_alert_notifications_suppression_reason_check" CHECK ("price_alert_notifications"."suppression_reason" in ('destination_no_longer_eligible', 'alert_deleted', 'alert_paused', 'channel_unavailable')),
	CONSTRAINT "price_alert_notifications_failure_reason_check" CHECK ("price_alert_notifications"."failure_reason" in ('transport_unconfigured', 'transport_rejected', 'transport_unavailable', 'trigger_unreadable', 'unexpected_error')),
	CONSTRAINT "price_alert_notifications_attempts_check" CHECK ("price_alert_notifications"."attempts" >= 0),
	CONSTRAINT "price_alert_notifications_delivered_at_check" CHECK (("price_alert_notifications"."state" = 'delivered') = ("price_alert_notifications"."delivered_at" is not null)),
	CONSTRAINT "price_alert_notifications_suppression_check" CHECK (("price_alert_notifications"."state" = 'suppressed') = ("price_alert_notifications"."suppression_reason" is not null)),
	CONSTRAINT "price_alert_notifications_notification_id_check" CHECK ("price_alert_notifications"."notification_id" is null or "price_alert_notifications"."state" = 'delivered')
);
--> statement-breakpoint
CREATE TABLE "price_alert_trigger_quotes" (
	"id" text PRIMARY KEY NOT NULL,
	"trigger_id" text NOT NULL,
	"component" text NOT NULL,
	"fx_from" text NOT NULL,
	"fx_to" text NOT NULL,
	"fx_rate" double precision NOT NULL,
	"fx_provider" text NOT NULL,
	"fx_as_of" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "price_alert_trigger_quotes_component_check" CHECK ("price_alert_trigger_quotes"."component" in ('item_price', 'delivery_cost')),
	CONSTRAINT "price_alert_trigger_quotes_fx_to_check" CHECK ("price_alert_trigger_quotes"."fx_to" in ('FAIR', 'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF', 'CNY', 'SEK', 'NOK', 'DKK', 'PLN', 'MXN', 'BRL', 'INR', 'NZD', 'ZAR', 'SGD', 'HKD', 'AED')),
	CONSTRAINT "price_alert_trigger_quotes_from_check" CHECK ("price_alert_trigger_quotes"."fx_from" ~ '^[A-Z]{3,4}$'),
	CONSTRAINT "price_alert_trigger_quotes_rate_check" CHECK ("price_alert_trigger_quotes"."fx_rate" > 0),
	CONSTRAINT "price_alert_trigger_quotes_distinct_check" CHECK ("price_alert_trigger_quotes"."fx_from" <> "price_alert_trigger_quotes"."fx_to")
);
--> statement-breakpoint
CREATE TABLE "price_alert_triggers" (
	"id" text PRIMARY KEY NOT NULL,
	"alert_id" text NOT NULL,
	"offer_id" text NOT NULL,
	"observed_price_version" text NOT NULL,
	"alert_policy_version" text NOT NULL,
	"canonical_product_id" text NOT NULL,
	"canonical_variant_id" text NOT NULL,
	"basis" text NOT NULL,
	"amount_amount" bigint NOT NULL,
	"amount_currency" text NOT NULL,
	"target_amount" bigint NOT NULL,
	"target_currency" text NOT NULL,
	"native_item_amount" bigint NOT NULL,
	"native_item_currency" text NOT NULL,
	"native_delivery_amount" bigint,
	"native_delivery_currency" text,
	"condition_group" text,
	"merchant_id" text,
	"offer_kind" text NOT NULL,
	"native_checkout_eligible" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "price_alert_triggers_amount_currency_check" CHECK ("price_alert_triggers"."amount_currency" in ('FAIR', 'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF', 'CNY', 'SEK', 'NOK', 'DKK', 'PLN', 'MXN', 'BRL', 'INR', 'NZD', 'ZAR', 'SGD', 'HKD', 'AED')),
	CONSTRAINT "price_alert_triggers_target_currency_check" CHECK ("price_alert_triggers"."target_currency" in ('FAIR', 'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF', 'CNY', 'SEK', 'NOK', 'DKK', 'PLN', 'MXN', 'BRL', 'INR', 'NZD', 'ZAR', 'SGD', 'HKD', 'AED')),
	CONSTRAINT "price_alert_triggers_basis_check" CHECK ("price_alert_triggers"."basis" in ('item_price', 'known_total')),
	CONSTRAINT "price_alert_triggers_condition_group_check" CHECK ("price_alert_triggers"."condition_group" in ('new', 'open_box', 'refurbished', 'used', 'for_parts')),
	CONSTRAINT "price_alert_triggers_offer_kind_check" CHECK ("price_alert_triggers"."offer_kind" in ('native', 'external', 'affiliate', 'informational')),
	CONSTRAINT "price_alert_triggers_native_currency_check" CHECK ("price_alert_triggers"."native_item_currency" ~ '^[A-Z]{3,4}$'),
	CONSTRAINT "price_alert_triggers_delivery_paired_check" CHECK (("price_alert_triggers"."native_delivery_amount" is null) = ("price_alert_triggers"."native_delivery_currency" is null)),
	CONSTRAINT "price_alert_triggers_delivery_currency_check" CHECK ("price_alert_triggers"."native_delivery_currency" is null or "price_alert_triggers"."native_delivery_currency" ~ '^[A-Z]{3,4}$'),
	CONSTRAINT "price_alert_triggers_basis_shape_check" CHECK ("price_alert_triggers"."basis" = 'known_total' or "price_alert_triggers"."native_delivery_amount" is null),
	CONSTRAINT "price_alert_triggers_amounts_check" CHECK ("price_alert_triggers"."amount_amount" >= 0 and "price_alert_triggers"."native_item_amount" >= 0
          and coalesce("price_alert_triggers"."native_delivery_amount", 0) >= 0),
	CONSTRAINT "price_alert_triggers_satisfies_target_check" CHECK ("price_alert_triggers"."amount_currency" = "price_alert_triggers"."target_currency" and "price_alert_triggers"."amount_amount" <= "price_alert_triggers"."target_amount")
);
--> statement-breakpoint
CREATE TABLE "price_alerts" (
	"id" text PRIMARY KEY NOT NULL,
	"oxy_user_id" text NOT NULL,
	"canonical_product_id" text NOT NULL,
	"canonical_variant_id" text,
	"target_amount" bigint NOT NULL,
	"target_currency" text NOT NULL,
	"basis" text NOT NULL,
	"condition_groups" text[] DEFAULT '{}'::text[] NOT NULL,
	"market" text,
	"seller_scope" text DEFAULT 'any' NOT NULL,
	"proximity_scope" text DEFAULT 'any' NOT NULL,
	"merchant_id" text,
	"storefront_id" text,
	"availability_requirement" text DEFAULT 'any' NOT NULL,
	"minimum_available_quantity" integer,
	"require_pickup_available" boolean DEFAULT false NOT NULL,
	"state" text DEFAULT 'enabled' NOT NULL,
	"repeat_policy" text DEFAULT 'once' NOT NULL,
	"reset_threshold_amount" bigint,
	"cooldown_seconds" integer,
	"rearmed_at" timestamp with time zone,
	"quiet_hours_start_minute" integer,
	"quiet_hours_end_minute" integer,
	"quiet_hours_time_zone" text,
	"locale" text,
	"email_opt_in" boolean DEFAULT false NOT NULL,
	"resolution_state" text DEFAULT 'resolved' NOT NULL,
	"split_job_id" text,
	"split_target_canonical_product_id" text,
	"rehomed_from_canonical_product_id" text,
	"rehomed_at" timestamp with time zone,
	"last_evaluated_at" timestamp with time zone,
	"last_triggered_at" timestamp with time zone,
	"last_delivered_at" timestamp with time zone,
	"last_triggered_amount" bigint,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "price_alerts_target_currency_check" CHECK ("price_alerts"."target_currency" in ('FAIR', 'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF', 'CNY', 'SEK', 'NOK', 'DKK', 'PLN', 'MXN', 'BRL', 'INR', 'NZD', 'ZAR', 'SGD', 'HKD', 'AED')),
	CONSTRAINT "price_alerts_basis_check" CHECK ("price_alerts"."basis" in ('item_price', 'known_total')),
	CONSTRAINT "price_alerts_condition_groups_check" CHECK ("price_alerts"."condition_groups" <@ array['new', 'open_box', 'refurbished', 'used', 'for_parts']::text[]),
	CONSTRAINT "price_alerts_seller_scope_check" CHECK ("price_alerts"."seller_scope" in ('any', 'native_only', 'external_only', 'official_only')),
	CONSTRAINT "price_alerts_proximity_scope_check" CHECK ("price_alerts"."proximity_scope" in ('any', 'nearby_pickup')),
	CONSTRAINT "price_alerts_availability_requirement_check" CHECK ("price_alerts"."availability_requirement" in ('any', 'in_stock')),
	CONSTRAINT "price_alerts_state_check" CHECK ("price_alerts"."state" in ('enabled', 'paused', 'triggered', 'deleted')),
	CONSTRAINT "price_alerts_repeat_policy_check" CHECK ("price_alerts"."repeat_policy" in ('once', 'reset_threshold', 'cooldown_better_low', 'always')),
	CONSTRAINT "price_alerts_resolution_state_check" CHECK ("price_alerts"."resolution_state" in ('resolved', 'ambiguous_after_split')),
	CONSTRAINT "price_alerts_market_check" CHECK ("price_alerts"."market" ~ '^[A-Z]{2}$'),
	CONSTRAINT "price_alerts_target_amount_check" CHECK ("price_alerts"."target_amount" > 0),
	CONSTRAINT "price_alerts_minimum_quantity_check" CHECK ("price_alerts"."minimum_available_quantity" is null or "price_alerts"."minimum_available_quantity" >= 1),
	CONSTRAINT "price_alerts_reset_threshold_check" CHECK (("price_alerts"."repeat_policy" = 'reset_threshold') = ("price_alerts"."reset_threshold_amount" is not null)),
	CONSTRAINT "price_alerts_cooldown_check" CHECK (("price_alerts"."repeat_policy" = 'cooldown_better_low') = ("price_alerts"."cooldown_seconds" is not null)),
	CONSTRAINT "price_alerts_cooldown_seconds_positive_check" CHECK ("price_alerts"."cooldown_seconds" is null or "price_alerts"."cooldown_seconds" > 0),
	CONSTRAINT "price_alerts_reset_above_target_check" CHECK ("price_alerts"."reset_threshold_amount" is null or "price_alerts"."reset_threshold_amount" > "price_alerts"."target_amount"),
	CONSTRAINT "price_alerts_quiet_hours_shape_check" CHECK (("price_alerts"."quiet_hours_start_minute" is null) = ("price_alerts"."quiet_hours_end_minute" is null)
          and ("price_alerts"."quiet_hours_start_minute" is null) = ("price_alerts"."quiet_hours_time_zone" is null)),
	CONSTRAINT "price_alerts_quiet_hours_range_check" CHECK (("price_alerts"."quiet_hours_start_minute" is null
             or ("price_alerts"."quiet_hours_start_minute" >= 0
                 and "price_alerts"."quiet_hours_start_minute" < 1440))
          and ("price_alerts"."quiet_hours_end_minute" is null
             or ("price_alerts"."quiet_hours_end_minute" >= 0
                 and "price_alerts"."quiet_hours_end_minute" < 1440))),
	CONSTRAINT "price_alerts_ambiguity_shape_check" CHECK (("price_alerts"."resolution_state" = 'ambiguous_after_split')
            = ("price_alerts"."split_job_id" is not null)),
	CONSTRAINT "price_alerts_ambiguity_paused_check" CHECK ("price_alerts"."resolution_state" <> 'ambiguous_after_split' or "price_alerts"."state" = 'paused'),
	CONSTRAINT "price_alerts_rehomed_shape_check" CHECK (("price_alerts"."rehomed_from_canonical_product_id" is null) = ("price_alerts"."rehomed_at" is null)),
	CONSTRAINT "price_alerts_last_triggered_shape_check" CHECK ("price_alerts"."last_triggered_amount" is null or "price_alerts"."last_triggered_at" is not null)
);
--> statement-breakpoint
ALTER TABLE "catalog_merge_job_phases" DROP CONSTRAINT "catalog_merge_job_phases_phase_check";--> statement-breakpoint
ALTER TABLE "catalog_merge_jobs" DROP CONSTRAINT "catalog_merge_jobs_phase_check";--> statement-breakpoint
ALTER TABLE "catalog_split_jobs" DROP CONSTRAINT "catalog_split_jobs_phase_check";--> statement-breakpoint
ALTER TABLE "price_alert_evaluations" ADD CONSTRAINT "price_alert_evaluations_canonical_product_id_canonical_products_id_fk" FOREIGN KEY ("canonical_product_id") REFERENCES "public"."canonical_products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_alert_notifications" ADD CONSTRAINT "price_alert_notifications_trigger_id_price_alert_triggers_id_fk" FOREIGN KEY ("trigger_id") REFERENCES "public"."price_alert_triggers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_alert_notifications" ADD CONSTRAINT "price_alert_notifications_alert_id_price_alerts_id_fk" FOREIGN KEY ("alert_id") REFERENCES "public"."price_alerts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_alert_notifications" ADD CONSTRAINT "price_alert_notifications_notification_id_notifications_id_fk" FOREIGN KEY ("notification_id") REFERENCES "public"."notifications"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_alert_trigger_quotes" ADD CONSTRAINT "price_alert_trigger_quotes_trigger_id_price_alert_triggers_id_fk" FOREIGN KEY ("trigger_id") REFERENCES "public"."price_alert_triggers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_alert_triggers" ADD CONSTRAINT "price_alert_triggers_alert_id_price_alerts_id_fk" FOREIGN KEY ("alert_id") REFERENCES "public"."price_alerts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_alert_triggers" ADD CONSTRAINT "price_alert_triggers_offer_id_offers_id_fk" FOREIGN KEY ("offer_id") REFERENCES "public"."offers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_alert_triggers" ADD CONSTRAINT "price_alert_triggers_observed_price_version_offer_price_snapshots_id_fk" FOREIGN KEY ("observed_price_version") REFERENCES "public"."offer_price_snapshots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_alert_triggers" ADD CONSTRAINT "price_alert_triggers_canonical_product_id_canonical_products_id_fk" FOREIGN KEY ("canonical_product_id") REFERENCES "public"."canonical_products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_alert_triggers" ADD CONSTRAINT "price_alert_triggers_canonical_variant_id_canonical_variants_id_fk" FOREIGN KEY ("canonical_variant_id") REFERENCES "public"."canonical_variants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_alert_triggers" ADD CONSTRAINT "price_alert_triggers_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_alerts" ADD CONSTRAINT "price_alerts_canonical_product_id_canonical_products_id_fk" FOREIGN KEY ("canonical_product_id") REFERENCES "public"."canonical_products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_alerts" ADD CONSTRAINT "price_alerts_canonical_variant_id_canonical_variants_id_fk" FOREIGN KEY ("canonical_variant_id") REFERENCES "public"."canonical_variants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_alerts" ADD CONSTRAINT "price_alerts_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_alerts" ADD CONSTRAINT "price_alerts_storefront_id_storefronts_id_fk" FOREIGN KEY ("storefront_id") REFERENCES "public"."storefronts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_alerts" ADD CONSTRAINT "price_alerts_split_job_id_catalog_split_jobs_id_fk" FOREIGN KEY ("split_job_id") REFERENCES "public"."catalog_split_jobs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_alerts" ADD CONSTRAINT "price_alerts_split_target_canonical_product_id_canonical_products_id_fk" FOREIGN KEY ("split_target_canonical_product_id") REFERENCES "public"."canonical_products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "price_alert_evaluations_subject_key" ON "price_alert_evaluations" USING btree ("canonical_product_id");--> statement-breakpoint
CREATE INDEX "price_alert_evaluations_pending_idx" ON "price_alert_evaluations" USING btree ("available_at","created_at") WHERE "price_alert_evaluations"."state" = 'pending';--> statement-breakpoint
CREATE INDEX "price_alert_evaluations_reclaim_idx" ON "price_alert_evaluations" USING btree ("lease_until") WHERE "price_alert_evaluations"."state" = 'processing';--> statement-breakpoint
CREATE INDEX "price_alert_notifications_pending_idx" ON "price_alert_notifications" USING btree ("available_at","created_at") WHERE "price_alert_notifications"."state" in ('queued', 'failed');--> statement-breakpoint
CREATE INDEX "price_alert_notifications_reclaim_idx" ON "price_alert_notifications" USING btree ("lease_until") WHERE "price_alert_notifications"."state" = 'delivering';--> statement-breakpoint
CREATE INDEX "price_alert_notifications_trigger_idx" ON "price_alert_notifications" USING btree ("trigger_id");--> statement-breakpoint
CREATE INDEX "price_alert_notifications_alert_idx" ON "price_alert_notifications" USING btree ("alert_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "price_alert_trigger_quotes_component_key" ON "price_alert_trigger_quotes" USING btree ("trigger_id","component");--> statement-breakpoint
CREATE UNIQUE INDEX "price_alert_triggers_identity_key" ON "price_alert_triggers" USING btree ("alert_id","offer_id","observed_price_version","alert_policy_version");--> statement-breakpoint
CREATE INDEX "price_alert_triggers_alert_idx" ON "price_alert_triggers" USING btree ("alert_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "price_alert_triggers_offer_idx" ON "price_alert_triggers" USING btree ("offer_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "price_alerts_owner_idx" ON "price_alerts" USING btree ("oxy_user_id","created_at" DESC NULLS LAST) WHERE "price_alerts"."state" <> 'deleted';--> statement-breakpoint
CREATE INDEX "price_alerts_subject_idx" ON "price_alerts" USING btree ("canonical_product_id","state") WHERE "price_alerts"."state" = 'enabled';--> statement-breakpoint
CREATE INDEX "price_alerts_split_job_idx" ON "price_alerts" USING btree ("split_job_id") WHERE "price_alerts"."split_job_id" is not null;--> statement-breakpoint
ALTER TABLE "catalog_merge_job_phases" ADD CONSTRAINT "catalog_merge_job_phases_phase_check" CHECK ("catalog_merge_job_phases"."phase" in ('plan', 'awaiting_resolution', 'children', 'identifiers', 'aliases', 'source_links', 'offers', 'relationships', 'reviews', 'saves', 'alerts', 'redirects', 'rollups', 'verify', 'done'));--> statement-breakpoint
ALTER TABLE "catalog_merge_jobs" ADD CONSTRAINT "catalog_merge_jobs_phase_check" CHECK ("catalog_merge_jobs"."phase" in ('plan', 'awaiting_resolution', 'children', 'identifiers', 'aliases', 'source_links', 'offers', 'relationships', 'reviews', 'saves', 'alerts', 'redirects', 'rollups', 'verify', 'done'));--> statement-breakpoint
ALTER TABLE "catalog_split_jobs" ADD CONSTRAINT "catalog_split_jobs_phase_check" CHECK ("catalog_split_jobs"."phase" in ('plan', 'mint', 'assignments', 'saves', 'alerts', 'redirects', 'rollups', 'verify', 'done'));