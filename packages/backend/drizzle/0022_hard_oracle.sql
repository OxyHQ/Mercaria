-- oxy:deploy-phase=pre
-- oxy:rollback=derived
CREATE TABLE "native_listing_links" (
	"id" text PRIMARY KEY NOT NULL,
	"product_variant_id" text NOT NULL,
	"listing_id" text NOT NULL,
	"canonical_variant_id" text NOT NULL,
	"method" text NOT NULL,
	"match_rule" text NOT NULL,
	"confidence" double precision,
	"status" text DEFAULT 'active' NOT NULL,
	"source_record_id" text,
	"decided_by_oxy_user_id" text,
	"revoked_at" timestamp with time zone,
	"revoked_by_oxy_user_id" text,
	"revoke_reason" text,
	"note" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "native_listing_links_method_check" CHECK ("native_listing_links"."method" in ('barcode_gtin', 'connector_declared', 'operator', 'matcher')),
	CONSTRAINT "native_listing_links_status_check" CHECK ("native_listing_links"."status" in ('active', 'superseded', 'revoked')),
	CONSTRAINT "native_listing_links_confidence_check" CHECK ("native_listing_links"."confidence" is null
          or ("native_listing_links"."confidence" >= 0 and "native_listing_links"."confidence" <= 1 and "native_listing_links"."method" = 'matcher')),
	CONSTRAINT "native_listing_links_revoked_state_check" CHECK ("native_listing_links"."status" <> 'revoked' or ("native_listing_links"."revoked_at" is not null and "native_listing_links"."revoked_by_oxy_user_id" is not null)),
	CONSTRAINT "native_listing_links_match_rule_check" CHECK (btrim("native_listing_links"."match_rule") <> '')
);
--> statement-breakpoint
CREATE TABLE "offer_outboxes" (
	"id" text PRIMARY KEY NOT NULL,
	"listing_id" text NOT NULL,
	"requested_revision" bigint DEFAULT 1 NOT NULL,
	"claimed_revision" bigint,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone NOT NULL,
	"lease_owner" text,
	"lease_until" timestamp with time zone,
	"last_error" text,
	"processed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "offer_outboxes_status_check" CHECK ("offer_outboxes"."status" in ('pending', 'processing', 'done', 'dead_letter')),
	CONSTRAINT "offer_outboxes_attempts_check" CHECK ("offer_outboxes"."attempts" >= 0),
	CONSTRAINT "offer_outboxes_requested_revision_check" CHECK ("offer_outboxes"."requested_revision" >= 1),
	CONSTRAINT "offer_outboxes_claimed_revision_check" CHECK ("offer_outboxes"."claimed_revision" is null or "offer_outboxes"."claimed_revision" <= "offer_outboxes"."requested_revision"),
	CONSTRAINT "offer_outboxes_last_error_length_check" CHECK ("offer_outboxes"."last_error" is null or length("offer_outboxes"."last_error") <= 2000)
);
--> statement-breakpoint
CREATE TABLE "offers" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"retirement_reason" text,
	"retired_at" timestamp with time zone,
	"canonical_variant_id" text NOT NULL,
	"merchant_id" text,
	"storefront_id" text,
	"product_variant_id" text,
	"listing_id" text,
	"source_record_id" text,
	"provider" text,
	"source_account_ref" text,
	"external_offer_id" text,
	"price_amount" bigint,
	"price_currency" text,
	"compare_at_price_amount" bigint,
	"compare_at_price_currency" text,
	"availability" text DEFAULT 'unknown' NOT NULL,
	"available_quantity" integer,
	"condition" text DEFAULT 'unknown' NOT NULL,
	"seller_sku" text,
	"merchant_title" text,
	"merchant_variant_text" text,
	"destination_url" text,
	"affiliate_network" text,
	"affiliate_program_ref" text,
	"affiliate_publisher_ref" text,
	"affiliate_tracking_template" text,
	"country" text,
	"region" text,
	"language" text,
	"customer_eligibility" text DEFAULT 'unknown' NOT NULL,
	"delivery_cost_amount" bigint,
	"delivery_cost_currency" text,
	"delivery_free_over_amount" bigint,
	"delivery_free_over_currency" text,
	"delivery_min_days" integer,
	"delivery_max_days" integer,
	"pickup_state" text DEFAULT 'unknown' NOT NULL,
	"return_policy_url" text,
	"return_policy_window_days" integer,
	"return_policy_ref" text,
	"observed_at" timestamp with time zone NOT NULL,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"last_confirmed_at" timestamp with time zone,
	"stale_at" timestamp with time zone NOT NULL,
	"source_confidence" double precision,
	"quality_signals" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"source_key" text GENERATED ALWAYS AS (coalesce("provider", '') || '|' || coalesce("source_account_ref", '') || '|' ||
            coalesce("external_offer_id", '')) STORED NOT NULL,
	"commercial_key" text GENERATED ALWAYS AS (coalesce("canonical_variant_id", '') || '|' || coalesce("merchant_id", '') || '|' ||
            coalesce("storefront_id", '') || '|' || coalesce("condition", '')) STORED NOT NULL,
	CONSTRAINT "offers_kind_check" CHECK ("offers"."kind" in ('native', 'external', 'affiliate', 'informational')),
	CONSTRAINT "offers_status_check" CHECK ("offers"."status" in ('active', 'retired')),
	CONSTRAINT "offers_retirement_reason_check" CHECK ("offers"."retirement_reason" in ('source_disappeared', 'source_expired', 'listing_unpublished', 'variant_removed', 'superseded', 'operator')),
	CONSTRAINT "offers_availability_check" CHECK ("offers"."availability" in ('in_stock', 'out_of_stock', 'preorder', 'unavailable', 'unknown')),
	CONSTRAINT "offers_condition_check" CHECK ("offers"."condition" in ('new', 'used', 'unknown')),
	CONSTRAINT "offers_pickup_state_check" CHECK ("offers"."pickup_state" in ('unknown', 'available', 'unavailable')),
	CONSTRAINT "offers_customer_eligibility_check" CHECK ("offers"."customer_eligibility" in ('unknown', 'anyone', 'members_only', 'business_only', 'age_restricted')),
	CONSTRAINT "offers_quality_signals_check" CHECK ("offers"."quality_signals" <@ array['missing_price', 'missing_availability', 'unmapped_condition', 'unknown_delivery', 'stale_observation', 'heuristic_match', 'unclaimed_merchant']::text[]),
	CONSTRAINT "offers_kind_shape_check" CHECK (case "offers"."kind"
        when 'native' then
          "offers"."product_variant_id" is not null and "offers"."listing_id" is not null
          and "offers"."merchant_id" is null and "offers"."storefront_id" is null
          and "offers"."source_record_id" is null and "offers"."destination_url" is null
        when 'external' then
          "offers"."merchant_id" is not null and "offers"."source_record_id" is not null
          and "offers"."destination_url" is not null
          and "offers"."product_variant_id" is null and "offers"."listing_id" is null
        when 'affiliate' then
          "offers"."merchant_id" is not null and "offers"."source_record_id" is not null
          and "offers"."destination_url" is not null
          and "offers"."product_variant_id" is null and "offers"."listing_id" is null
        when 'informational' then
          "offers"."merchant_id" is not null and "offers"."source_record_id" is not null
          and "offers"."destination_url" is null
          and "offers"."product_variant_id" is null and "offers"."listing_id" is null
        else false
      end),
	CONSTRAINT "offers_retired_state_check" CHECK (("offers"."status" = 'retired') = ("offers"."retirement_reason" is not null and "offers"."retired_at" is not null)),
	CONSTRAINT "offers_price_paired_check" CHECK (("offers"."price_amount" is null) = ("offers"."price_currency" is null)),
	CONSTRAINT "offers_compare_at_price_paired_check" CHECK (("offers"."compare_at_price_amount" is null) = ("offers"."compare_at_price_currency" is null)),
	CONSTRAINT "offers_delivery_cost_paired_check" CHECK (("offers"."delivery_cost_amount" is null) = ("offers"."delivery_cost_currency" is null)),
	CONSTRAINT "offers_delivery_free_over_paired_check" CHECK (("offers"."delivery_free_over_amount" is null) = ("offers"."delivery_free_over_currency" is null)),
	CONSTRAINT "offers_delivery_free_over_requires_cost_check" CHECK ("offers"."delivery_free_over_amount" is null or "offers"."delivery_cost_amount" is not null),
	CONSTRAINT "offers_price_currency_check" CHECK ("offers"."price_currency" is null or "offers"."price_currency" ~ '^[A-Z]{3,4}$'),
	CONSTRAINT "offers_compare_at_price_currency_check" CHECK ("offers"."compare_at_price_currency" is null or "offers"."compare_at_price_currency" ~ '^[A-Z]{3,4}$'),
	CONSTRAINT "offers_delivery_cost_currency_check" CHECK ("offers"."delivery_cost_currency" is null or "offers"."delivery_cost_currency" ~ '^[A-Z]{3,4}$'),
	CONSTRAINT "offers_delivery_free_over_currency_check" CHECK ("offers"."delivery_free_over_currency" is null or "offers"."delivery_free_over_currency" ~ '^[A-Z]{3,4}$'),
	CONSTRAINT "offers_non_negative_money_check" CHECK (coalesce("offers"."price_amount", 0) >= 0 and coalesce("offers"."compare_at_price_amount", 0) >= 0
          and coalesce("offers"."delivery_cost_amount", 0) >= 0 and coalesce("offers"."delivery_free_over_amount", 0) >= 0),
	CONSTRAINT "offers_available_quantity_check" CHECK ("offers"."available_quantity" is null or "offers"."available_quantity" >= 0),
	CONSTRAINT "offers_delivery_days_check" CHECK (("offers"."delivery_min_days" is null or "offers"."delivery_min_days" >= 0)
          and ("offers"."delivery_max_days" is null or "offers"."delivery_max_days" >= 0)
          and ("offers"."delivery_min_days" is null or "offers"."delivery_max_days" is null
               or "offers"."delivery_max_days" >= "offers"."delivery_min_days")),
	CONSTRAINT "offers_return_window_check" CHECK ("offers"."return_policy_window_days" is null or "offers"."return_policy_window_days" >= 0),
	CONSTRAINT "offers_country_check" CHECK ("offers"."country" ~ '^[A-Z]{2}$'),
	CONSTRAINT "offers_provider_shape_check" CHECK ("offers"."provider" is null or "offers"."provider" ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
	CONSTRAINT "offers_confidence_check" CHECK ("offers"."source_confidence" is null
          or ("offers"."source_confidence" >= 0 and "offers"."source_confidence" <= 1 and "offers"."kind" <> 'native')),
	CONSTRAINT "offers_native_source_key_check" CHECK ("offers"."kind" <> 'native'
          or ("offers"."provider" is null and "offers"."source_account_ref" is null and "offers"."external_offer_id" is null)),
	CONSTRAINT "offers_seen_order_check" CHECK ("offers"."last_seen_at" >= "offers"."first_seen_at"),
	CONSTRAINT "offers_confirmed_order_check" CHECK ("offers"."last_confirmed_at" is null or "offers"."last_confirmed_at" >= "offers"."first_seen_at")
);
--> statement-breakpoint
ALTER TABLE "native_listing_links" ADD CONSTRAINT "native_listing_links_product_variant_id_product_variants_id_fk" FOREIGN KEY ("product_variant_id") REFERENCES "public"."product_variants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "native_listing_links" ADD CONSTRAINT "native_listing_links_listing_id_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."listings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "native_listing_links" ADD CONSTRAINT "native_listing_links_canonical_variant_id_canonical_variants_id_fk" FOREIGN KEY ("canonical_variant_id") REFERENCES "public"."canonical_variants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "native_listing_links" ADD CONSTRAINT "native_listing_links_source_record_id_source_records_id_fk" FOREIGN KEY ("source_record_id") REFERENCES "public"."source_records"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offer_outboxes" ADD CONSTRAINT "offer_outboxes_listing_id_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."listings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offers" ADD CONSTRAINT "offers_canonical_variant_id_canonical_variants_id_fk" FOREIGN KEY ("canonical_variant_id") REFERENCES "public"."canonical_variants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offers" ADD CONSTRAINT "offers_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offers" ADD CONSTRAINT "offers_storefront_id_storefronts_id_fk" FOREIGN KEY ("storefront_id") REFERENCES "public"."storefronts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offers" ADD CONSTRAINT "offers_product_variant_id_product_variants_id_fk" FOREIGN KEY ("product_variant_id") REFERENCES "public"."product_variants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offers" ADD CONSTRAINT "offers_listing_id_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."listings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offers" ADD CONSTRAINT "offers_source_record_id_source_records_id_fk" FOREIGN KEY ("source_record_id") REFERENCES "public"."source_records"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "native_listing_links_active_variant_key" ON "native_listing_links" USING btree ("product_variant_id") WHERE "native_listing_links"."status" = 'active';--> statement-breakpoint
CREATE INDEX "native_listing_links_canonical_variant_idx" ON "native_listing_links" USING btree ("canonical_variant_id","status");--> statement-breakpoint
CREATE INDEX "native_listing_links_listing_idx" ON "native_listing_links" USING btree ("listing_id","status");--> statement-breakpoint
CREATE INDEX "native_listing_links_source_record_idx" ON "native_listing_links" USING btree ("source_record_id") WHERE "native_listing_links"."source_record_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "offer_outboxes_listing_key" ON "offer_outboxes" USING btree ("listing_id");--> statement-breakpoint
CREATE INDEX "offer_outboxes_pending_idx" ON "offer_outboxes" USING btree ("available_at","created_at") WHERE "offer_outboxes"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "offer_outboxes_reclaim_idx" ON "offer_outboxes" USING btree ("lease_until","created_at") WHERE "offer_outboxes"."status" = 'processing';--> statement-breakpoint
CREATE UNIQUE INDEX "offers_active_source_key" ON "offers" USING btree ("source_key") WHERE "offers"."status" = 'active' and "offers"."external_offer_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "offers_active_native_variant_key" ON "offers" USING btree ("product_variant_id") WHERE "offers"."kind" = 'native' and "offers"."status" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "offers_active_commercial_key" ON "offers" USING btree ("commercial_key") WHERE "offers"."status" = 'active' and "offers"."kind" <> 'native';--> statement-breakpoint
CREATE INDEX "offers_variant_comparison_idx" ON "offers" USING btree ("canonical_variant_id","price_amount","id") WHERE "offers"."status" = 'active';--> statement-breakpoint
CREATE INDEX "offers_variant_country_idx" ON "offers" USING btree ("canonical_variant_id","country","price_amount") WHERE "offers"."status" = 'active';--> statement-breakpoint
CREATE INDEX "offers_merchant_browse_idx" ON "offers" USING btree ("merchant_id","status","last_seen_at") WHERE "offers"."merchant_id" is not null;--> statement-breakpoint
CREATE INDEX "offers_storefront_browse_idx" ON "offers" USING btree ("storefront_id","status","last_seen_at") WHERE "offers"."storefront_id" is not null;--> statement-breakpoint
CREATE INDEX "offers_native_listing_idx" ON "offers" USING btree ("listing_id") WHERE "offers"."listing_id" is not null;--> statement-breakpoint
CREATE INDEX "offers_freshness_idx" ON "offers" USING btree ("status","stale_at");--> statement-breakpoint
CREATE INDEX "offers_source_record_idx" ON "offers" USING btree ("source_record_id") WHERE "offers"."source_record_id" is not null;