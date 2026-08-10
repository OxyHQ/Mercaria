-- oxy:deploy-phase=pre
--
-- The bounded retail pilot (#125): five additive tables and four trigger pairs.
-- Nothing here narrows, drops or renames, so it is `pre` — the serving image
-- neither reads nor writes any of these tables, and the checkout gate that will
-- read them ships in the same release.
--
-- HAND-WRITTEN STATEMENTS LIVE BELOW THE MARKER AT THE FOOT OF THIS FILE.
-- `db:generate` DROPS them on a regeneration (drizzle-kit cannot model a
-- trigger), so after regenerating: re-append the block, then grep this file for
-- each `CREATE OR REPLACE FUNCTION` / `CREATE TRIGGER` pair and for exactly one
-- deploy-phase marker line below. Three branches in one earlier batch lost their
-- triggers here; all three applied cleanly and enforced nothing.

CREATE TABLE "retail_pilot_cohorts" (
	"id" text PRIMARY KEY NOT NULL,
	"cohort_key" text NOT NULL,
	"version" integer NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"supplier_id" text NOT NULL,
	"supplier_account_id" text NOT NULL,
	"market_country" text NOT NULL,
	"currency" text NOT NULL,
	"audience" text NOT NULL,
	"audience_percentage_bps" integer,
	"max_item_total_amount" bigint NOT NULL,
	"max_item_total_currency" text NOT NULL,
	"max_order_total_amount" bigint NOT NULL,
	"max_order_total_currency" text NOT NULL,
	"min_order_total_amount" bigint NOT NULL,
	"min_order_total_currency" text NOT NULL,
	"max_line_quantity" integer NOT NULL,
	"permitted_shipping_service_codes" text[] DEFAULT '{}' NOT NULL,
	"funding_floor_amount" bigint NOT NULL,
	"funding_floor_currency" text NOT NULL,
	"funding_alert_amount" bigint NOT NULL,
	"funding_alert_currency" text NOT NULL,
	"monthly_spend_cap_amount" bigint NOT NULL,
	"monthly_spend_cap_currency" text NOT NULL,
	"funding_observation_max_age_seconds" integer NOT NULL,
	"published_at" timestamp with time zone,
	"published_by_oxy_user_id" text,
	"superseded_at" timestamp with time zone,
	"rationale" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "retail_pilot_cohorts_status_check" CHECK ("retail_pilot_cohorts"."status" in ('draft', 'active', 'superseded', 'retired')),
	CONSTRAINT "retail_pilot_cohorts_audience_check" CHECK ("retail_pilot_cohorts"."audience" in ('staff', 'invited', 'percentage', 'public')),
	CONSTRAINT "retail_pilot_cohorts_currency_check" CHECK ("retail_pilot_cohorts"."currency" in ('FAIR', 'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF', 'CNY', 'SEK', 'NOK', 'DKK', 'PLN', 'MXN', 'BRL', 'INR', 'NZD', 'ZAR', 'SGD', 'HKD', 'AED')),
	CONSTRAINT "retail_pilot_cohorts_max_item_total_currency_check" CHECK ("retail_pilot_cohorts"."max_item_total_currency" in ('FAIR', 'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF', 'CNY', 'SEK', 'NOK', 'DKK', 'PLN', 'MXN', 'BRL', 'INR', 'NZD', 'ZAR', 'SGD', 'HKD', 'AED')),
	CONSTRAINT "retail_pilot_cohorts_max_order_total_currency_check" CHECK ("retail_pilot_cohorts"."max_order_total_currency" in ('FAIR', 'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF', 'CNY', 'SEK', 'NOK', 'DKK', 'PLN', 'MXN', 'BRL', 'INR', 'NZD', 'ZAR', 'SGD', 'HKD', 'AED')),
	CONSTRAINT "retail_pilot_cohorts_min_order_total_currency_check" CHECK ("retail_pilot_cohorts"."min_order_total_currency" in ('FAIR', 'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF', 'CNY', 'SEK', 'NOK', 'DKK', 'PLN', 'MXN', 'BRL', 'INR', 'NZD', 'ZAR', 'SGD', 'HKD', 'AED')),
	CONSTRAINT "retail_pilot_cohorts_funding_floor_currency_check" CHECK ("retail_pilot_cohorts"."funding_floor_currency" in ('FAIR', 'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF', 'CNY', 'SEK', 'NOK', 'DKK', 'PLN', 'MXN', 'BRL', 'INR', 'NZD', 'ZAR', 'SGD', 'HKD', 'AED')),
	CONSTRAINT "retail_pilot_cohorts_funding_alert_currency_check" CHECK ("retail_pilot_cohorts"."funding_alert_currency" in ('FAIR', 'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF', 'CNY', 'SEK', 'NOK', 'DKK', 'PLN', 'MXN', 'BRL', 'INR', 'NZD', 'ZAR', 'SGD', 'HKD', 'AED')),
	CONSTRAINT "retail_pilot_cohorts_monthly_spend_cap_currency_check" CHECK ("retail_pilot_cohorts"."monthly_spend_cap_currency" in ('FAIR', 'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF', 'CNY', 'SEK', 'NOK', 'DKK', 'PLN', 'MXN', 'BRL', 'INR', 'NZD', 'ZAR', 'SGD', 'HKD', 'AED')),
	CONSTRAINT "retail_pilot_cohorts_version_check" CHECK ("retail_pilot_cohorts"."version" >= 1),
	CONSTRAINT "retail_pilot_cohorts_market_check" CHECK ("retail_pilot_cohorts"."market_country" ~ '^[A-Z]{2}$'),
	CONSTRAINT "retail_pilot_cohorts_audience_percentage_check" CHECK (("retail_pilot_cohorts"."audience" = 'percentage') = ("retail_pilot_cohorts"."audience_percentage_bps" is not null)
          and ("retail_pilot_cohorts"."audience_percentage_bps" is null
               or ("retail_pilot_cohorts"."audience_percentage_bps" > 0 and "retail_pilot_cohorts"."audience_percentage_bps" <= 10000))),
	CONSTRAINT "retail_pilot_cohorts_value_bounds_check" CHECK ("retail_pilot_cohorts"."max_item_total_amount" > 0 and "retail_pilot_cohorts"."max_order_total_amount" > 0
          and "retail_pilot_cohorts"."min_order_total_amount" >= 0
          and "retail_pilot_cohorts"."min_order_total_amount" <= "retail_pilot_cohorts"."max_order_total_amount"
          and "retail_pilot_cohorts"."max_item_total_amount" <= "retail_pilot_cohorts"."max_order_total_amount"
          and "retail_pilot_cohorts"."max_line_quantity" >= 1),
	CONSTRAINT "retail_pilot_cohorts_funding_check" CHECK ("retail_pilot_cohorts"."funding_floor_amount" >= 0
          and "retail_pilot_cohorts"."funding_alert_amount" >= "retail_pilot_cohorts"."funding_floor_amount"
          and "retail_pilot_cohorts"."monthly_spend_cap_amount" > 0
          and "retail_pilot_cohorts"."funding_observation_max_age_seconds" >= 60),
	CONSTRAINT "retail_pilot_cohorts_publication_check" CHECK (("retail_pilot_cohorts"."status" = 'draft')
          or ("retail_pilot_cohorts"."published_at" is not null and "retail_pilot_cohorts"."published_by_oxy_user_id" is not null)),
	CONSTRAINT "retail_pilot_cohorts_superseded_check" CHECK (("retail_pilot_cohorts"."status" = 'superseded') = ("retail_pilot_cohorts"."superseded_at" is not null)),
	CONSTRAINT "retail_pilot_cohorts_shipping_services_check" CHECK ("retail_pilot_cohorts"."status" <> 'active' or coalesce(cardinality("retail_pilot_cohorts"."permitted_shipping_service_codes"), 0) >= 1)
);
--> statement-breakpoint
CREATE TABLE "retail_pilot_skus" (
	"id" text PRIMARY KEY NOT NULL,
	"cohort_id" text NOT NULL,
	"supplier_sku" text NOT NULL,
	"procurement_offer_id" text,
	"added_by_oxy_user_id" text NOT NULL,
	"note" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "retail_pilot_skus_sku_check" CHECK (length("retail_pilot_skus"."supplier_sku") > 0)
);
--> statement-breakpoint
CREATE TABLE "retail_pilot_stop_thresholds" (
	"id" text PRIMARY KEY NOT NULL,
	"cohort_id" text NOT NULL,
	"metric" text NOT NULL,
	"unit" text NOT NULL,
	"threshold_value" bigint NOT NULL,
	"window_hours" integer NOT NULL,
	"scope" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "retail_pilot_stop_thresholds_metric_check" CHECK ("retail_pilot_stop_thresholds"."metric" in ('supplier_stock_rejection', 'checkout_cost_change', 'procurement_timeout_or_ambiguity', 'late_dispatch', 'tracking_failure', 'cancellation_rejection', 'return_or_defect_rate', 'negative_realized_margin', 'supplier_credit_mismatch', 'customer_support_volume', 'payment_refund_or_dispute_rate', 'product_safety_incident', 'non_eu_dispatch_origin')),
	CONSTRAINT "retail_pilot_stop_thresholds_unit_check" CHECK ("retail_pilot_stop_thresholds"."unit" in ('rate_bps', 'count', 'minor_units')),
	CONSTRAINT "retail_pilot_stop_thresholds_scope_check" CHECK ("retail_pilot_stop_thresholds"."scope" in ('pilot', 'supplier', 'market', 'sku')),
	CONSTRAINT "retail_pilot_stop_thresholds_value_check" CHECK ("retail_pilot_stop_thresholds"."threshold_value" >= 0 and "retail_pilot_stop_thresholds"."window_hours" >= 0
          and ("retail_pilot_stop_thresholds"."unit" <> 'rate_bps' or "retail_pilot_stop_thresholds"."threshold_value" <= 10000))
);
--> statement-breakpoint
CREATE TABLE "retail_pilot_stops" (
	"id" text PRIMARY KEY NOT NULL,
	"cohort_id" text NOT NULL,
	"metric" text NOT NULL,
	"scope" text NOT NULL,
	"scope_ref" text NOT NULL,
	"origin" text NOT NULL,
	"observed_value" bigint NOT NULL,
	"threshold_value" bigint NOT NULL,
	"raised_at" timestamp with time zone NOT NULL,
	"raised_by_oxy_user_id" text,
	"detail" text NOT NULL,
	"lifted_at" timestamp with time zone,
	"lifted_by_oxy_user_id" text,
	"lift_reason" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "retail_pilot_stops_metric_check" CHECK ("retail_pilot_stops"."metric" in ('supplier_stock_rejection', 'checkout_cost_change', 'procurement_timeout_or_ambiguity', 'late_dispatch', 'tracking_failure', 'cancellation_rejection', 'return_or_defect_rate', 'negative_realized_margin', 'supplier_credit_mismatch', 'customer_support_volume', 'payment_refund_or_dispute_rate', 'product_safety_incident', 'non_eu_dispatch_origin')),
	CONSTRAINT "retail_pilot_stops_scope_check" CHECK ("retail_pilot_stops"."scope" in ('pilot', 'supplier', 'market', 'sku')),
	CONSTRAINT "retail_pilot_stops_origin_check" CHECK ("retail_pilot_stops"."origin" in ('automatic', 'operator')),
	CONSTRAINT "retail_pilot_stops_origin_raiser_check" CHECK (("retail_pilot_stops"."origin" = 'operator') = ("retail_pilot_stops"."raised_by_oxy_user_id" is not null)),
	CONSTRAINT "retail_pilot_stops_lift_check" CHECK (num_nonnulls("retail_pilot_stops"."lifted_at", "retail_pilot_stops"."lifted_by_oxy_user_id", "retail_pilot_stops"."lift_reason") in (0, 3)),
	CONSTRAINT "retail_pilot_stops_scope_ref_check" CHECK (("retail_pilot_stops"."scope" = 'pilot') = ("retail_pilot_stops"."scope_ref" = ''))
);
--> statement-breakpoint
CREATE TABLE "supplier_funding_observations" (
	"id" text PRIMARY KEY NOT NULL,
	"supplier_account_id" text NOT NULL,
	"balance_amount" bigint NOT NULL,
	"balance_currency" text NOT NULL,
	"source" text NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"recorded_by_oxy_user_id" text,
	"note" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "supplier_funding_observations_source_check" CHECK ("supplier_funding_observations"."source" in ('provider_api', 'operator_entry', 'statement')),
	CONSTRAINT "supplier_funding_observations_balance_currency_check" CHECK ("supplier_funding_observations"."balance_currency" in ('FAIR', 'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF', 'CNY', 'SEK', 'NOK', 'DKK', 'PLN', 'MXN', 'BRL', 'INR', 'NZD', 'ZAR', 'SGD', 'HKD', 'AED')),
	CONSTRAINT "supplier_funding_observations_balance_check" CHECK ("supplier_funding_observations"."balance_amount" >= 0),
	CONSTRAINT "supplier_funding_observations_recorder_check" CHECK (("supplier_funding_observations"."source" = 'operator_entry') = ("supplier_funding_observations"."recorded_by_oxy_user_id" is not null))
);
--> statement-breakpoint
ALTER TABLE "retail_pilot_cohorts" ADD CONSTRAINT "retail_pilot_cohorts_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retail_pilot_cohorts" ADD CONSTRAINT "retail_pilot_cohorts_supplier_account_id_supplier_accounts_id_fk" FOREIGN KEY ("supplier_account_id") REFERENCES "public"."supplier_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retail_pilot_skus" ADD CONSTRAINT "retail_pilot_skus_cohort_id_retail_pilot_cohorts_id_fk" FOREIGN KEY ("cohort_id") REFERENCES "public"."retail_pilot_cohorts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retail_pilot_skus" ADD CONSTRAINT "retail_pilot_skus_procurement_offer_id_procurement_offers_id_fk" FOREIGN KEY ("procurement_offer_id") REFERENCES "public"."procurement_offers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retail_pilot_stop_thresholds" ADD CONSTRAINT "retail_pilot_stop_thresholds_cohort_id_retail_pilot_cohorts_id_fk" FOREIGN KEY ("cohort_id") REFERENCES "public"."retail_pilot_cohorts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retail_pilot_stops" ADD CONSTRAINT "retail_pilot_stops_cohort_id_retail_pilot_cohorts_id_fk" FOREIGN KEY ("cohort_id") REFERENCES "public"."retail_pilot_cohorts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_funding_observations" ADD CONSTRAINT "supplier_funding_observations_supplier_account_id_supplier_accounts_id_fk" FOREIGN KEY ("supplier_account_id") REFERENCES "public"."supplier_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "retail_pilot_cohorts_key_version_key" ON "retail_pilot_cohorts" USING btree ("cohort_key","version");--> statement-breakpoint
CREATE UNIQUE INDEX "retail_pilot_cohorts_active_key" ON "retail_pilot_cohorts" USING btree ("cohort_key") WHERE "retail_pilot_cohorts"."status" = 'active';--> statement-breakpoint
CREATE INDEX "retail_pilot_cohorts_supplier_idx" ON "retail_pilot_cohorts" USING btree ("supplier_account_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "retail_pilot_skus_cohort_sku_key" ON "retail_pilot_skus" USING btree ("cohort_id","supplier_sku");--> statement-breakpoint
CREATE UNIQUE INDEX "retail_pilot_stop_thresholds_cohort_metric_key" ON "retail_pilot_stop_thresholds" USING btree ("cohort_id","metric");--> statement-breakpoint
CREATE UNIQUE INDEX "retail_pilot_stops_live_key" ON "retail_pilot_stops" USING btree ("cohort_id","metric","scope","scope_ref") WHERE "retail_pilot_stops"."lifted_at" is null;--> statement-breakpoint
CREATE INDEX "retail_pilot_stops_cohort_idx" ON "retail_pilot_stops" USING btree ("cohort_id","raised_at");--> statement-breakpoint
CREATE INDEX "supplier_funding_observations_latest_idx" ON "supplier_funding_observations" USING btree ("supplier_account_id","observed_at");
--> statement-breakpoint
-- ===========================================================================
-- HAND-WRITTEN: the four freezes. Re-apply after any `db:generate`.
-- ===========================================================================

-- (1) A cohort version is IMMUTABLE once it leaves `draft`.
--
-- The `fee_schedules` mechanism, and the reason the pilot's bounds are worth
-- storing at all: a bound somebody can edit after orders were placed under it
-- is not a record of what the pilot ran under. The ONLY columns an active row
-- may move are its own lifecycle — `status`, `superseded_at`, `updated_at` —
-- so widening a ceiling means publishing a NEW version, with its own author,
-- its own date and its own rationale.
CREATE OR REPLACE FUNCTION mercaria_freeze_active_retail_pilot_cohort()
RETURNS trigger AS $$
BEGIN
  IF OLD.status = 'draft' THEN
    RETURN NEW;
  END IF;
  IF NEW.cohort_key IS DISTINCT FROM OLD.cohort_key
     OR NEW.version IS DISTINCT FROM OLD.version
     OR NEW.supplier_id IS DISTINCT FROM OLD.supplier_id
     OR NEW.supplier_account_id IS DISTINCT FROM OLD.supplier_account_id
     OR NEW.market_country IS DISTINCT FROM OLD.market_country
     OR NEW.currency IS DISTINCT FROM OLD.currency
     OR NEW.audience IS DISTINCT FROM OLD.audience
     OR NEW.audience_percentage_bps IS DISTINCT FROM OLD.audience_percentage_bps
     OR NEW.max_item_total_amount IS DISTINCT FROM OLD.max_item_total_amount
     OR NEW.max_order_total_amount IS DISTINCT FROM OLD.max_order_total_amount
     OR NEW.min_order_total_amount IS DISTINCT FROM OLD.min_order_total_amount
     OR NEW.max_line_quantity IS DISTINCT FROM OLD.max_line_quantity
     OR NEW.permitted_shipping_service_codes IS DISTINCT FROM OLD.permitted_shipping_service_codes
     OR NEW.funding_floor_amount IS DISTINCT FROM OLD.funding_floor_amount
     OR NEW.funding_alert_amount IS DISTINCT FROM OLD.funding_alert_amount
     OR NEW.monthly_spend_cap_amount IS DISTINCT FROM OLD.monthly_spend_cap_amount
     OR NEW.funding_observation_max_age_seconds IS DISTINCT FROM OLD.funding_observation_max_age_seconds
     OR NEW.published_at IS DISTINCT FROM OLD.published_at
     OR NEW.published_by_oxy_user_id IS DISTINCT FROM OLD.published_by_oxy_user_id
     OR NEW.rationale IS DISTINCT FROM OLD.rationale THEN
    RAISE EXCEPTION
      'retail_pilot_cohorts is immutable once published; publish a new version instead'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER mercaria_freeze_active_retail_pilot_cohort
BEFORE UPDATE ON retail_pilot_cohorts
FOR EACH ROW EXECUTE FUNCTION mercaria_freeze_active_retail_pilot_cohort();--> statement-breakpoint

-- (2) A published cohort's SKU allow-list and thresholds may not GROW.
--
-- This is "no automatic expansion follows from technical success" at the grain
-- it actually gets violated: adding one SKU to a running pilot is the change
-- nobody writes a review for. DELETE is deliberately still permitted — removing
-- a SKU NARROWS the pilot, which is always safe and is what an operator does
-- when a product-safety flag lands at 3am.
CREATE OR REPLACE FUNCTION mercaria_freeze_published_retail_pilot_children()
RETURNS trigger AS $$
DECLARE
  cohort_status text;
BEGIN
  SELECT status INTO cohort_status FROM retail_pilot_cohorts WHERE id = NEW.cohort_id;
  IF cohort_status IS NOT NULL AND cohort_status <> 'draft' THEN
    RAISE EXCEPTION
      'a published retail pilot cohort cannot gain or change % rows; publish a new version',
      TG_TABLE_NAME
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER mercaria_freeze_published_retail_pilot_skus
BEFORE INSERT OR UPDATE ON retail_pilot_skus
FOR EACH ROW EXECUTE FUNCTION mercaria_freeze_published_retail_pilot_children();--> statement-breakpoint

CREATE TRIGGER mercaria_freeze_published_retail_pilot_thresholds
BEFORE INSERT OR UPDATE ON retail_pilot_stop_thresholds
FOR EACH ROW EXECUTE FUNCTION mercaria_freeze_published_retail_pilot_children();--> statement-breakpoint

-- (3) A stop is APPEND-ONLY, and the only update is a LIFT.
--
-- A pilot that stopped and was restarted is the most important thing in its own
-- history. Nothing deletes, and an UPDATE may only move the three lift columns
-- from NULL to a value — so a stop cannot be re-pointed at another metric, have
-- its observed value edited down, or be un-lifted to hide that it was lifted.
CREATE OR REPLACE FUNCTION mercaria_retail_pilot_stops_append_only()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'retail_pilot_stops is append-only'
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.lifted_at IS NOT NULL THEN
    RAISE EXCEPTION 'a lifted retail pilot stop is immutable'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.cohort_id IS DISTINCT FROM OLD.cohort_id
     OR NEW.metric IS DISTINCT FROM OLD.metric
     OR NEW.scope IS DISTINCT FROM OLD.scope
     OR NEW.scope_ref IS DISTINCT FROM OLD.scope_ref
     OR NEW.origin IS DISTINCT FROM OLD.origin
     OR NEW.observed_value IS DISTINCT FROM OLD.observed_value
     OR NEW.threshold_value IS DISTINCT FROM OLD.threshold_value
     OR NEW.raised_at IS DISTINCT FROM OLD.raised_at
     OR NEW.raised_by_oxy_user_id IS DISTINCT FROM OLD.raised_by_oxy_user_id
     OR NEW.detail IS DISTINCT FROM OLD.detail THEN
    RAISE EXCEPTION 'only the lift columns of retail_pilot_stops may be updated'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER mercaria_retail_pilot_stops_append_only
BEFORE UPDATE OR DELETE ON retail_pilot_stops
FOR EACH ROW EXECUTE FUNCTION mercaria_retail_pilot_stops_append_only();--> statement-breakpoint

-- (4) A funding observation is APPEND-ONLY against UPDATE and DELETE.
--
-- What Mercaria believed its supplier balance was at a moment is evidence, and
-- a correction is a NEW observation rather than an edit — the ledger's posture.
-- Editing one would let a checkout that should have been refused look, in
-- hindsight, as though it was correctly admitted.
CREATE OR REPLACE FUNCTION mercaria_supplier_funding_append_only()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'supplier_funding_observations is append-only; record a new observation'
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER mercaria_supplier_funding_append_only
BEFORE UPDATE OR DELETE ON supplier_funding_observations
FOR EACH ROW EXECUTE FUNCTION mercaria_supplier_funding_append_only();
