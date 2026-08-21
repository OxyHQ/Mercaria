-- oxy:deploy-phase=pre
-- oxy:rollback=derived
--
-- #78 — currency-safe offer price history. ADDITIVE, entirely.
--
-- Four new tables and no change to any existing one, which is what makes the
-- whole domain a flag flip rather than a data change: `PRICE_HISTORY_ENABLED`
-- gates the rebuild LOOP, `PRICE_HISTORY_PUBLIC_READS_ENABLED` gates the buyer
-- surface, and `PRICE_HISTORY_SERIES_CURRENCIES` is empty by default, so a
-- deployment that applies this migration and changes nothing else records
-- observations and builds no charts.
--
-- The hand-written statement at the END of this file is the immutability
-- trigger drizzle-kit cannot model. A REGENERATION DROPS IT, so re-apply it
-- there and verify by grepping this file for the function/trigger pair and for
-- exactly one deploy-phase marker on the first line.
--

CREATE TABLE "offer_price_points" (
	"id" text PRIMARY KEY NOT NULL,
	"series_id" text NOT NULL,
	"bucket_start" timestamp with time zone NOT NULL,
	"measure" text NOT NULL,
	"segment" text NOT NULL,
	"offer_id" text NOT NULL,
	"snapshot_id" text NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"admitted_freshness" text NOT NULL,
	"contributing_observation_count" integer NOT NULL,
	"native_amount" bigint NOT NULL,
	"native_currency" text NOT NULL,
	"display_amount" bigint NOT NULL,
	"fx_rate" double precision,
	"fx_from" text,
	"fx_to" text,
	"fx_provider" text,
	"fx_as_of" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "offer_price_points_measure_check" CHECK ("offer_price_points"."measure" in ('lowest_item_price', 'lowest_known_total', 'official_store_item_price', 'native_item_price', 'mercaria_retail_item_price')),
	CONSTRAINT "offer_price_points_segment_check" CHECK ("offer_price_points"."segment" in ('new', 'open_box', 'refurbished', 'used', 'for_parts')),
	CONSTRAINT "offer_price_points_admitted_freshness_check" CHECK ("offer_price_points"."admitted_freshness" in ('current', 'warning')),
	CONSTRAINT "offer_price_points_native_currency_check" CHECK ("offer_price_points"."native_currency" in ('FAIR', 'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF', 'CNY', 'SEK', 'NOK', 'DKK', 'PLN', 'MXN', 'BRL', 'INR', 'NZD', 'ZAR', 'SGD', 'HKD', 'AED')),
	CONSTRAINT "offer_price_points_non_negative_money_check" CHECK ("offer_price_points"."native_amount" >= 0 and "offer_price_points"."display_amount" >= 0),
	CONSTRAINT "offer_price_points_contributing_count_check" CHECK ("offer_price_points"."contributing_observation_count" >= 1),
	CONSTRAINT "offer_price_points_fx_shape_check" CHECK (case
        when "offer_price_points"."fx_rate" is null then
          "offer_price_points"."fx_from" is null and "offer_price_points"."fx_to" is null
          and "offer_price_points"."fx_provider" is null and "offer_price_points"."fx_as_of" is null
          and "offer_price_points"."display_amount" = "offer_price_points"."native_amount"
        else
          "offer_price_points"."fx_from" is not null and "offer_price_points"."fx_to" is not null
          and "offer_price_points"."fx_provider" is not null and "offer_price_points"."fx_as_of" is not null
          and "offer_price_points"."fx_rate" > 0
          and "offer_price_points"."fx_from" = "offer_price_points"."native_currency"
          and "offer_price_points"."fx_from" <> "offer_price_points"."fx_to"
      end)
);
--> statement-breakpoint
CREATE TABLE "offer_price_series" (
	"id" text PRIMARY KEY NOT NULL,
	"scope_kind" text NOT NULL,
	"canonical_product_id" text,
	"canonical_variant_id" text,
	"market" text,
	"display_currency" text NOT NULL,
	"granularity" text NOT NULL,
	"policy_version" integer NOT NULL,
	"requested_revision" bigint DEFAULT 1 NOT NULL,
	"claimed_revision" bigint,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone NOT NULL,
	"lease_owner" text,
	"lease_until" timestamp with time zone,
	"last_error" text,
	"covered_from" timestamp with time zone,
	"covered_through" timestamp with time zone,
	"rebuilt_at" timestamp with time zone,
	"point_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"series_key" text GENERATED ALWAYS AS (coalesce("canonical_product_id", '') || '|' || coalesce("canonical_variant_id", '') || '|' ||
            coalesce("market", '') || '|' || "display_currency" || '|' || "granularity") STORED NOT NULL,
	CONSTRAINT "offer_price_series_scope_kind_check" CHECK ("offer_price_series"."scope_kind" in ('canonical_product', 'canonical_variant')),
	CONSTRAINT "offer_price_series_granularity_check" CHECK ("offer_price_series"."granularity" in ('day', 'week', 'month')),
	CONSTRAINT "offer_price_series_status_check" CHECK ("offer_price_series"."status" in ('pending', 'processing', 'done', 'dead_letter')),
	CONSTRAINT "offer_price_series_display_currency_check" CHECK ("offer_price_series"."display_currency" in ('FAIR', 'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF', 'CNY', 'SEK', 'NOK', 'DKK', 'PLN', 'MXN', 'BRL', 'INR', 'NZD', 'ZAR', 'SGD', 'HKD', 'AED')),
	CONSTRAINT "offer_price_series_scope_shape_check" CHECK (case "offer_price_series"."scope_kind"
        when 'canonical_product' then "offer_price_series"."canonical_product_id" is not null and "offer_price_series"."canonical_variant_id" is null
        when 'canonical_variant' then "offer_price_series"."canonical_variant_id" is not null and "offer_price_series"."canonical_product_id" is null
        else false
      end),
	CONSTRAINT "offer_price_series_market_check" CHECK ("offer_price_series"."market" ~ '^[A-Z]{2}$'),
	CONSTRAINT "offer_price_series_policy_version_check" CHECK ("offer_price_series"."policy_version" >= 1),
	CONSTRAINT "offer_price_series_attempts_check" CHECK ("offer_price_series"."attempts" >= 0),
	CONSTRAINT "offer_price_series_point_count_check" CHECK ("offer_price_series"."point_count" >= 0),
	CONSTRAINT "offer_price_series_requested_revision_check" CHECK ("offer_price_series"."requested_revision" >= 1),
	CONSTRAINT "offer_price_series_claimed_revision_check" CHECK ("offer_price_series"."claimed_revision" is null or "offer_price_series"."claimed_revision" <= "offer_price_series"."requested_revision"),
	CONSTRAINT "offer_price_series_coverage_shape_check" CHECK (("offer_price_series"."covered_from" is null) = ("offer_price_series"."covered_through" is null)
          and ("offer_price_series"."covered_from" is null or "offer_price_series"."covered_through" >= "offer_price_series"."covered_from")),
	CONSTRAINT "offer_price_series_last_error_length_check" CHECK ("offer_price_series"."last_error" is null or length("offer_price_series"."last_error") <= 2000)
);
--> statement-breakpoint
CREATE TABLE "offer_price_snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"offer_id" text NOT NULL,
	"source_record_id" text,
	"source_run_id" text,
	"source_id" text,
	"observed_at" timestamp with time zone NOT NULL,
	"item_price_amount" bigint NOT NULL,
	"item_price_currency" text NOT NULL,
	"compare_at_price_amount" bigint,
	"compare_at_price_currency" text,
	"shipping_cost_amount" bigint,
	"shipping_cost_currency" text,
	"tax_inclusion" text DEFAULT 'unknown' NOT NULL,
	"condition_key" text NOT NULL,
	"availability" text NOT NULL,
	"market" text,
	"region" text,
	"language" text,
	"freshness_level" text NOT NULL,
	"observation_hash" text NOT NULL,
	"change_reasons" text[] NOT NULL,
	"anomalies" text[] DEFAULT '{}'::text[] NOT NULL,
	"supersedes_snapshot_id" text,
	"retention_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "offer_price_snapshots_condition_key_check" CHECK ("offer_price_snapshots"."condition_key" in ('new', 'open_box', 'refurbished_manufacturer', 'refurbished_seller', 'used_like_new', 'used_good', 'used_fair', 'used_poor', 'for_parts', 'unknown')),
	CONSTRAINT "offer_price_snapshots_availability_check" CHECK ("offer_price_snapshots"."availability" in ('in_stock', 'out_of_stock', 'preorder', 'unavailable', 'unknown')),
	CONSTRAINT "offer_price_snapshots_tax_inclusion_check" CHECK ("offer_price_snapshots"."tax_inclusion" in ('inclusive', 'exclusive', 'unknown')),
	CONSTRAINT "offer_price_snapshots_freshness_level_check" CHECK ("offer_price_snapshots"."freshness_level" in ('current', 'warning', 'expired', 'unavailable', 'unknown')),
	CONSTRAINT "offer_price_snapshots_change_reasons_check" CHECK ("offer_price_snapshots"."change_reasons" <@ array['initial', 'price', 'compare_at', 'condition', 'availability', 'known_cost', 'anchor', 'correction']::text[]),
	CONSTRAINT "offer_price_snapshots_anomalies_check" CHECK ("offer_price_snapshots"."anomalies" <@ array['currency_changed', 'price_scale_shift', 'compare_at_below_price']::text[]),
	CONSTRAINT "offer_price_snapshots_change_reasons_present_check" CHECK (cardinality("offer_price_snapshots"."change_reasons") >= 1),
	CONSTRAINT "offer_price_snapshots_compare_at_paired_check" CHECK (("offer_price_snapshots"."compare_at_price_amount" is null) = ("offer_price_snapshots"."compare_at_price_currency" is null)),
	CONSTRAINT "offer_price_snapshots_shipping_paired_check" CHECK (("offer_price_snapshots"."shipping_cost_amount" is null) = ("offer_price_snapshots"."shipping_cost_currency" is null)),
	CONSTRAINT "offer_price_snapshots_item_currency_check" CHECK ("offer_price_snapshots"."item_price_currency" ~ '^[A-Z]{3,4}$'),
	CONSTRAINT "offer_price_snapshots_compare_at_currency_check" CHECK ("offer_price_snapshots"."compare_at_price_currency" is null or "offer_price_snapshots"."compare_at_price_currency" ~ '^[A-Z]{3,4}$'),
	CONSTRAINT "offer_price_snapshots_shipping_currency_check" CHECK ("offer_price_snapshots"."shipping_cost_currency" is null or "offer_price_snapshots"."shipping_cost_currency" ~ '^[A-Z]{3,4}$'),
	CONSTRAINT "offer_price_snapshots_non_negative_money_check" CHECK ("offer_price_snapshots"."item_price_amount" >= 0
          and coalesce("offer_price_snapshots"."compare_at_price_amount", 0) >= 0
          and coalesce("offer_price_snapshots"."shipping_cost_amount", 0) >= 0),
	CONSTRAINT "offer_price_snapshots_market_check" CHECK ("offer_price_snapshots"."market" ~ '^[A-Z]{2}$'),
	CONSTRAINT "offer_price_snapshots_supersedes_self_check" CHECK ("offer_price_snapshots"."supersedes_snapshot_id" is distinct from "offer_price_snapshots"."id")
);
--> statement-breakpoint
CREATE TABLE "offer_price_write_metrics" (
	"id" text PRIMARY KEY NOT NULL,
	"bucket_day" text NOT NULL,
	"source_id" text,
	"written" integer DEFAULT 0 NOT NULL,
	"deduplicated" integer DEFAULT 0 NOT NULL,
	"refused" integer DEFAULT 0 NOT NULL,
	"flagged_anomalous" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"metric_key" text GENERATED ALWAYS AS ("bucket_day" || '|' || coalesce("source_id", '')) STORED NOT NULL,
	CONSTRAINT "offer_price_write_metrics_bucket_day_check" CHECK ("offer_price_write_metrics"."bucket_day" ~ '^\d{4}-\d{2}-\d{2}$'),
	CONSTRAINT "offer_price_write_metrics_counters_check" CHECK ("offer_price_write_metrics"."written" >= 0 and "offer_price_write_metrics"."deduplicated" >= 0 and "offer_price_write_metrics"."refused" >= 0
          and "offer_price_write_metrics"."flagged_anomalous" >= 0 and "offer_price_write_metrics"."flagged_anomalous" <= "offer_price_write_metrics"."written")
);
--> statement-breakpoint
ALTER TABLE "offer_price_points" ADD CONSTRAINT "offer_price_points_series_id_offer_price_series_id_fk" FOREIGN KEY ("series_id") REFERENCES "public"."offer_price_series"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offer_price_points" ADD CONSTRAINT "offer_price_points_offer_id_offers_id_fk" FOREIGN KEY ("offer_id") REFERENCES "public"."offers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offer_price_points" ADD CONSTRAINT "offer_price_points_snapshot_id_offer_price_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."offer_price_snapshots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offer_price_series" ADD CONSTRAINT "offer_price_series_canonical_product_id_canonical_products_id_fk" FOREIGN KEY ("canonical_product_id") REFERENCES "public"."canonical_products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offer_price_series" ADD CONSTRAINT "offer_price_series_canonical_variant_id_canonical_variants_id_fk" FOREIGN KEY ("canonical_variant_id") REFERENCES "public"."canonical_variants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offer_price_snapshots" ADD CONSTRAINT "offer_price_snapshots_offer_id_offers_id_fk" FOREIGN KEY ("offer_id") REFERENCES "public"."offers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offer_price_snapshots" ADD CONSTRAINT "offer_price_snapshots_source_record_id_source_records_id_fk" FOREIGN KEY ("source_record_id") REFERENCES "public"."source_records"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offer_price_snapshots" ADD CONSTRAINT "offer_price_snapshots_source_run_id_catalog_source_runs_id_fk" FOREIGN KEY ("source_run_id") REFERENCES "public"."catalog_source_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offer_price_snapshots" ADD CONSTRAINT "offer_price_snapshots_source_id_catalog_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."catalog_sources"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offer_price_snapshots" ADD CONSTRAINT "offer_price_snapshots_supersedes_snapshot_id_offer_price_snapshots_id_fk" FOREIGN KEY ("supersedes_snapshot_id") REFERENCES "public"."offer_price_snapshots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offer_price_write_metrics" ADD CONSTRAINT "offer_price_write_metrics_source_id_catalog_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."catalog_sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "offer_price_points_bucket_key" ON "offer_price_points" USING btree ("series_id","bucket_start","measure","segment");--> statement-breakpoint
CREATE INDEX "offer_price_points_read_idx" ON "offer_price_points" USING btree ("series_id","measure","segment","bucket_start");--> statement-breakpoint
CREATE INDEX "offer_price_points_snapshot_idx" ON "offer_price_points" USING btree ("snapshot_id");--> statement-breakpoint
CREATE INDEX "offer_price_points_offer_idx" ON "offer_price_points" USING btree ("offer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "offer_price_series_key" ON "offer_price_series" USING btree ("series_key");--> statement-breakpoint
CREATE INDEX "offer_price_series_pending_idx" ON "offer_price_series" USING btree ("available_at","created_at") WHERE "offer_price_series"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "offer_price_series_reclaim_idx" ON "offer_price_series" USING btree ("lease_until","created_at") WHERE "offer_price_series"."status" = 'processing';--> statement-breakpoint
CREATE INDEX "offer_price_series_product_idx" ON "offer_price_series" USING btree ("canonical_product_id") WHERE "offer_price_series"."canonical_product_id" is not null;--> statement-breakpoint
CREATE INDEX "offer_price_series_variant_idx" ON "offer_price_series" USING btree ("canonical_variant_id") WHERE "offer_price_series"."canonical_variant_id" is not null;--> statement-breakpoint
CREATE INDEX "offer_price_snapshots_offer_observed_idx" ON "offer_price_snapshots" USING btree ("offer_id","observed_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "offer_price_snapshots_observed_at_idx" ON "offer_price_snapshots" USING btree ("observed_at");--> statement-breakpoint
CREATE INDEX "offer_price_snapshots_source_run_idx" ON "offer_price_snapshots" USING btree ("source_run_id") WHERE "offer_price_snapshots"."source_run_id" is not null;--> statement-breakpoint
CREATE INDEX "offer_price_snapshots_source_observed_idx" ON "offer_price_snapshots" USING btree ("source_id","observed_at") WHERE "offer_price_snapshots"."source_id" is not null;--> statement-breakpoint
CREATE INDEX "offer_price_snapshots_retention_idx" ON "offer_price_snapshots" USING btree ("retention_expires_at") WHERE "offer_price_snapshots"."retention_expires_at" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "offer_price_write_metrics_key" ON "offer_price_write_metrics" USING btree ("metric_key");--> statement-breakpoint
CREATE INDEX "offer_price_write_metrics_day_idx" ON "offer_price_write_metrics" USING btree ("bucket_day");

--> statement-breakpoint
--
-- `offer_price_snapshots` is IMMUTABLE against UPDATE — and DELETE is
-- deliberately PERMITTED.
--
-- An observation is a record of what a source said at an instant. A correction
-- is a SUPERSEDING record naming the one it revises (#78 snapshot policy 7),
-- never an edit, so there is no path — service, replay or `psql` — on which a
-- stored price is rewritten to something nobody published. That is the whole
-- property a price history is worth keeping for.
--
-- DELETE is not refused, which INVERTS the ledger's posture and matches
-- `analytics_events`: erasure on a schedule is the policy here, not an attack.
-- A source's own agreement can cap how long its facts may be cached
-- (`catalog_source_policies.cache_ttl_seconds`), that cap is stamped onto
-- `retention_expires_at` at write time, and the shared expiry sweep is what
-- honours it. A trigger refusing DELETE would make that retention fail
-- SILENTLY — the sweep would raise on every row it was contractually obliged to
-- remove — which is a worse failure than the one the refusal would prevent.
-- `offer_price_points.snapshot_id` CASCADEs, so a deletion takes the chart it
-- backed with it rather than leaving a point asserting a price with nothing
-- behind it. `offer_id` CASCADEs too, so this table never stands in front of a
-- seller deleting their own listing.
--
CREATE OR REPLACE FUNCTION mercaria_offer_price_snapshot_immutable()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION
    'offer_price_snapshots is immutable: an observation records what a source said at an '
    'instant. Write a superseding observation citing supersedes_snapshot_id instead of '
    'editing this one.';
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER offer_price_snapshots_immutable
BEFORE UPDATE ON offer_price_snapshots
FOR EACH ROW EXECUTE FUNCTION mercaria_offer_price_snapshot_immutable();
