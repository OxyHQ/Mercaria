-- oxy:deploy-phase=pre
--
-- #65 — the eBay Browse catalog source.
--
-- Wholly ADDITIVE, in every one of its four parts, which is what makes it a
-- single `pre` migration rather than the two-phase split #90 and #94 needed:
--
--  1. Three eBay tables (`ebay_call_budgets`, `ebay_discovery_queries`,
--     `ebay_reconciliation_samples`) that nothing existing references.
--  2. `marketplace_seller_identities`, likewise new, referencing `merchants`,
--     `catalog_sources` and `source_records` — all RESTRICT, since nothing in
--     the graph is ever hard-deleted.
--  3. `catalog_source_configs.seller_identity`, NOT NULL with a
--     `'source_bound'` default. Every existing row therefore gets #62's
--     original behaviour and the previous image, which never writes the
--     column, keeps working unchanged. Its second CHECK only constrains rows
--     that opt IN to `per_record`, which no row does until an operator says
--     so, so it is added VALIDATED rather than `NOT VALID`.
--  4. `condition_mapping_rulesets_provider_check` is dropped and re-added as a
--     strict SUPERSET (the five connector providers plus `ebay_browse`). A
--     widening is safe in both directions: every stored provider still
--     satisfies the new predicate, and the previous image writes only values
--     the new one admits. Nothing narrows.
--
-- There is no hand-written statement in this file: no trigger, no function and
-- no backfill. A regeneration therefore reproduces it exactly, and the only
-- thing that must be re-applied by hand is this header.
--
CREATE TABLE "marketplace_seller_identities" (
	"id" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"external_seller_id" text NOT NULL,
	"merchant_id" text NOT NULL,
	"first_source_id" text,
	"first_source_record_id" text,
	"display_name" text,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "marketplace_seller_identities_provider_shape_check" CHECK ("marketplace_seller_identities"."provider" ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
	CONSTRAINT "marketplace_seller_identities_external_seller_id_check" CHECK (length(btrim("marketplace_seller_identities"."external_seller_id")) between 1 and 128),
	CONSTRAINT "marketplace_seller_identities_seen_order_check" CHECK ("marketplace_seller_identities"."last_seen_at" >= "marketplace_seller_identities"."first_seen_at")
);
--> statement-breakpoint
CREATE TABLE "ebay_call_budgets" (
	"id" text PRIMARY KEY NOT NULL,
	"application_key" text NOT NULL,
	"budget_date" date NOT NULL,
	"daily_limit" integer NOT NULL,
	"calls_used" integer DEFAULT 0 NOT NULL,
	"calls_refused" integer DEFAULT 0 NOT NULL,
	"last_call_at" timestamp with time zone,
	"last_refused_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "ebay_call_budgets_application_key_check" CHECK ("ebay_call_budgets"."application_key" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "ebay_call_budgets_daily_limit_check" CHECK ("ebay_call_budgets"."daily_limit" > 0),
	CONSTRAINT "ebay_call_budgets_calls_used_check" CHECK ("ebay_call_budgets"."calls_used" >= 0),
	CONSTRAINT "ebay_call_budgets_calls_refused_check" CHECK ("ebay_call_budgets"."calls_refused" >= 0),
	CONSTRAINT "ebay_call_budgets_within_limit_check" CHECK ("ebay_call_budgets"."calls_used" <= "ebay_call_budgets"."daily_limit")
);
--> statement-breakpoint
CREATE TABLE "ebay_discovery_queries" (
	"id" text PRIMARY KEY NOT NULL,
	"source_id" text NOT NULL,
	"marketplace_id" text NOT NULL,
	"query_kind" text NOT NULL,
	"query_value" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"max_offset" integer DEFAULT 1000 NOT NULL,
	"last_completed_at" timestamp with time zone,
	"last_item_count" integer,
	"created_by_oxy_user_id" text,
	"note" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "ebay_discovery_queries_marketplace_id_check" CHECK ("ebay_discovery_queries"."marketplace_id" in ('EBAY_ES', 'EBAY_DE', 'EBAY_FR', 'EBAY_IT', 'EBAY_GB')),
	CONSTRAINT "ebay_discovery_queries_query_kind_check" CHECK ("ebay_discovery_queries"."query_kind" in ('category', 'keyword')),
	CONSTRAINT "ebay_discovery_queries_query_value_check" CHECK (length(btrim("ebay_discovery_queries"."query_value")) between 1 and 200),
	CONSTRAINT "ebay_discovery_queries_position_check" CHECK ("ebay_discovery_queries"."position" >= 0),
	CONSTRAINT "ebay_discovery_queries_max_offset_check" CHECK ("max_offset" > 0 and "max_offset" <= 10000),
	CONSTRAINT "ebay_discovery_queries_last_item_count_check" CHECK ("ebay_discovery_queries"."last_item_count" >= 0),
	CONSTRAINT "ebay_discovery_queries_note_length_check" CHECK ("note" is null or length("note") <= 2000)
);
--> statement-breakpoint
CREATE TABLE "ebay_reconciliation_samples" (
	"id" text PRIMARY KEY NOT NULL,
	"source_id" text NOT NULL,
	"external_id" text NOT NULL,
	"finding" text NOT NULL,
	"checked_at" timestamp with time zone NOT NULL,
	"stored_price_amount" integer,
	"stored_price_currency" text,
	"stored_availability" text,
	"stored_condition" text,
	"provider_price_amount" integer,
	"provider_price_currency" text,
	"provider_availability" text,
	"provider_condition" text,
	"provider_affiliate_url_present" boolean,
	"note" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "ebay_reconciliation_samples_finding_check" CHECK ("ebay_reconciliation_samples"."finding" in ('agrees', 'price_drift', 'availability_drift', 'condition_drift', 'affiliate_attribution_missing', 'vanished', 'unreadable')),
	CONSTRAINT "ebay_reconciliation_samples_external_id_check" CHECK (length(btrim("ebay_reconciliation_samples"."external_id")) between 1 and 128),
	CONSTRAINT "ebay_reconciliation_samples_stored_currency_check" CHECK ("ebay_reconciliation_samples"."stored_price_currency" is null or "ebay_reconciliation_samples"."stored_price_currency" ~ '^[A-Z]{3,4}$'),
	CONSTRAINT "ebay_reconciliation_samples_provider_currency_check" CHECK ("ebay_reconciliation_samples"."provider_price_currency" is null or "ebay_reconciliation_samples"."provider_price_currency" ~ '^[A-Z]{3,4}$'),
	CONSTRAINT "ebay_reconciliation_samples_stored_price_paired_check" CHECK (("ebay_reconciliation_samples"."stored_price_amount" is null) = ("ebay_reconciliation_samples"."stored_price_currency" is null)),
	CONSTRAINT "ebay_reconciliation_samples_provider_price_paired_check" CHECK (("ebay_reconciliation_samples"."provider_price_amount" is null) = ("ebay_reconciliation_samples"."provider_price_currency" is null)),
	CONSTRAINT "ebay_reconciliation_samples_note_length_check" CHECK ("note" is null or length("note") <= 2000)
);
--> statement-breakpoint
ALTER TABLE "condition_mapping_rulesets" DROP CONSTRAINT "condition_mapping_rulesets_provider_check";--> statement-breakpoint
ALTER TABLE "catalog_source_configs" ADD COLUMN "seller_identity" text DEFAULT 'source_bound' NOT NULL;--> statement-breakpoint
ALTER TABLE "marketplace_seller_identities" ADD CONSTRAINT "marketplace_seller_identities_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marketplace_seller_identities" ADD CONSTRAINT "marketplace_seller_identities_first_source_id_catalog_sources_id_fk" FOREIGN KEY ("first_source_id") REFERENCES "public"."catalog_sources"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marketplace_seller_identities" ADD CONSTRAINT "marketplace_seller_identities_first_source_record_id_source_records_id_fk" FOREIGN KEY ("first_source_record_id") REFERENCES "public"."source_records"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ebay_discovery_queries" ADD CONSTRAINT "ebay_discovery_queries_source_id_catalog_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."catalog_sources"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ebay_reconciliation_samples" ADD CONSTRAINT "ebay_reconciliation_samples_source_id_catalog_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."catalog_sources"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "marketplace_seller_identities_provider_external_seller_id_key" ON "marketplace_seller_identities" USING btree ("provider","external_seller_id");--> statement-breakpoint
CREATE INDEX "marketplace_seller_identities_merchant_id_idx" ON "marketplace_seller_identities" USING btree ("merchant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ebay_call_budgets_application_key_budget_date_key" ON "ebay_call_budgets" USING btree ("application_key","budget_date");--> statement-breakpoint
CREATE INDEX "ebay_call_budgets_budget_date_idx" ON "ebay_call_budgets" USING btree ("budget_date" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "ebay_discovery_queries_source_marketplace_kind_value_key" ON "ebay_discovery_queries" USING btree ("source_id","marketplace_id","query_kind","query_value");--> statement-breakpoint
CREATE INDEX "ebay_discovery_queries_source_id_position_idx" ON "ebay_discovery_queries" USING btree ("source_id","position","id");--> statement-breakpoint
CREATE INDEX "ebay_reconciliation_samples_source_id_checked_at_idx" ON "ebay_reconciliation_samples" USING btree ("source_id","checked_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "ebay_reconciliation_samples_source_id_external_id_idx" ON "ebay_reconciliation_samples" USING btree ("source_id","external_id");--> statement-breakpoint
ALTER TABLE "condition_mapping_rulesets" ADD CONSTRAINT "condition_mapping_rulesets_provider_check" CHECK ("condition_mapping_rulesets"."provider" in ('shopify', 'woocommerce', 'etsy', 'prestashop', 'magento', 'ebay_browse'));--> statement-breakpoint
ALTER TABLE "catalog_source_configs" ADD CONSTRAINT "catalog_source_configs_seller_identity_value_check" CHECK ("catalog_source_configs"."seller_identity" in ('source_bound', 'per_record'));--> statement-breakpoint
ALTER TABLE "catalog_source_configs" ADD CONSTRAINT "catalog_source_configs_seller_identity_check" CHECK ("catalog_source_configs"."seller_identity" <> 'per_record'
          or ("catalog_source_configs"."merchant_id" is not null and "catalog_source_configs"."storefront_id" is not null));