-- oxy:deploy-phase=pre
--
-- Trustworthy price signals and merchant competitiveness (#82).
--
-- Purely ADDITIVE. Four new tables and NOT ONE column on a table this issue does
-- not own: a signal is DERIVED at read time from #78's immutable observations and
-- #74's eligible offers, so there is nothing to denormalize onto them.
--
-- HAND-WRITTEN STATEMENTS BELOW THE GENERATED BLOCK. `db:generate` DROPS them on
-- a regeneration; re-apply them at the END of the file and confirm with:
--
--   grep -c '^CREATE TRIGGER'             drizzle/0056_*.sql   # 2
--   grep -c '^CREATE OR REPLACE FUNCTION' drizzle/0056_*.sql   # 2
--   grep -c '^-- oxy:deploy-phase'        drizzle/0056_*.sql   # 1
--
-- A regeneration that keeps the CHECKs and loses these two triggers applies
-- perfectly cleanly and enforces NOTHING: every threshold of a policy version
-- that has already served becomes editable, and every evaluation recorded under
-- it starts citing a definition it was not produced by — which is exactly the
-- shape acceptance 4 ("reproducible from immutable observations and a policy
-- version") exists to make impossible.

CREATE TABLE "price_signal_evaluations" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"policy_version_id" text NOT NULL,
	"scope_kind" text NOT NULL,
	"canonical_product_id" text,
	"canonical_variant_id" text,
	"segment" text NOT NULL,
	"market" text,
	"display_currency" text NOT NULL,
	"signal_kind" text NOT NULL,
	"state" text NOT NULL,
	"unmeasured_reason" text,
	"value_amount" bigint,
	"value_low_amount" bigint,
	"value_high_amount" bigint,
	"delta_bps" integer,
	"label" text,
	"position" text,
	"confidence" text,
	"sample_observations" integer NOT NULL,
	"sample_distinct_sellers" integer NOT NULL,
	"sample_distinct_offers" integer NOT NULL,
	"sample_coverage_days" integer NOT NULL,
	"sample_outliers_excluded" integer NOT NULL,
	"sample_deduplicated" integer NOT NULL,
	"evidence_observation_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"evidence_offer_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"excluded_outlier_observation_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"evaluated_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"subject_key" text GENERATED ALWAYS AS (coalesce("canonical_product_id", '') || '|' || coalesce("canonical_variant_id", '') || '|' ||
            "segment" || '|' || coalesce("market", '') || '|' || "display_currency") STORED NOT NULL,
	CONSTRAINT "price_signal_evaluations_scope_kind_check" CHECK ("price_signal_evaluations"."scope_kind" in ('canonical_product', 'canonical_variant')),
	CONSTRAINT "price_signal_evaluations_segment_check" CHECK ("price_signal_evaluations"."segment" in ('new', 'open_box', 'refurbished', 'used', 'for_parts')),
	CONSTRAINT "price_signal_evaluations_signal_kind_check" CHECK ("price_signal_evaluations"."signal_kind" in ('lowest_observed_item_price', 'lowest_observed_known_total', 'current_vs_recent_median', 'material_price_drop', 'typical_recent_range', 'official_store_position', 'price_quality_label')),
	CONSTRAINT "price_signal_evaluations_state_check" CHECK ("price_signal_evaluations"."state" in ('measured', 'not_present', 'unmeasured')),
	CONSTRAINT "price_signal_evaluations_unmeasured_reason_check" CHECK ("price_signal_evaluations"."unmeasured_reason" in ('no_active_policy', 'insufficient_observations', 'insufficient_distinct_sellers', 'insufficient_distinct_offers', 'insufficient_time_coverage', 'no_eligible_current_offer', 'no_comparable_history', 'currency_not_convertible', 'segment_not_applicable', 'measure_not_applicable', 'demand_measurement_unavailable')),
	CONSTRAINT "price_signal_evaluations_label_check" CHECK ("price_signal_evaluations"."label" in ('good_price', 'typical_price', 'above_typical')),
	CONSTRAINT "price_signal_evaluations_position_check" CHECK ("price_signal_evaluations"."position" in ('below', 'near', 'above')),
	CONSTRAINT "price_signal_evaluations_confidence_check" CHECK ("price_signal_evaluations"."confidence" in ('sufficient', 'strong')),
	CONSTRAINT "price_signal_evaluations_display_currency_check" CHECK ("price_signal_evaluations"."display_currency" in ('FAIR', 'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF', 'CNY', 'SEK', 'NOK', 'DKK', 'PLN', 'MXN', 'BRL', 'INR', 'NZD', 'ZAR', 'SGD', 'HKD', 'AED')),
	CONSTRAINT "price_signal_evaluations_market_check" CHECK ("price_signal_evaluations"."market" ~ '^[A-Z]{2}$'),
	CONSTRAINT "price_signal_evaluations_scope_shape_check" CHECK (case "price_signal_evaluations"."scope_kind"
        when 'canonical_product' then "price_signal_evaluations"."canonical_product_id" is not null and "price_signal_evaluations"."canonical_variant_id" is null
        when 'canonical_variant' then "price_signal_evaluations"."canonical_variant_id" is not null and "price_signal_evaluations"."canonical_product_id" is null
        else false
      end),
	CONSTRAINT "price_signal_evaluations_unmeasured_shape_check" CHECK (("price_signal_evaluations"."state" = 'unmeasured') = ("price_signal_evaluations"."unmeasured_reason" is not null)),
	CONSTRAINT "price_signal_evaluations_value_shape_check" CHECK (("price_signal_evaluations"."state" = 'measured'
             or ("price_signal_evaluations"."value_amount" is null and "price_signal_evaluations"."value_low_amount" is null
                 and "price_signal_evaluations"."value_high_amount" is null and "price_signal_evaluations"."delta_bps" is null
                 and "price_signal_evaluations"."label" is null and "price_signal_evaluations"."position" is null and "price_signal_evaluations"."confidence" is null))
          and ("price_signal_evaluations"."state" <> 'measured'
             or "price_signal_evaluations"."value_amount" is not null or "price_signal_evaluations"."value_low_amount" is not null
             or "price_signal_evaluations"."label" is not null or "price_signal_evaluations"."position" is not null)),
	CONSTRAINT "price_signal_evaluations_range_shape_check" CHECK (("price_signal_evaluations"."value_low_amount" is null) = ("price_signal_evaluations"."value_high_amount" is null)
          and ("price_signal_evaluations"."value_low_amount" is null or "price_signal_evaluations"."value_low_amount" <= "price_signal_evaluations"."value_high_amount")),
	CONSTRAINT "price_signal_evaluations_confidence_shape_check" CHECK (("price_signal_evaluations"."confidence" is not null) = ("price_signal_evaluations"."label" is not null)),
	CONSTRAINT "price_signal_evaluations_sample_check" CHECK ("price_signal_evaluations"."sample_observations" >= 0 and "price_signal_evaluations"."sample_distinct_sellers" >= 0
          and "price_signal_evaluations"."sample_distinct_offers" >= 0 and "price_signal_evaluations"."sample_coverage_days" >= 0
          and "price_signal_evaluations"."sample_outliers_excluded" >= 0 and "price_signal_evaluations"."sample_deduplicated" >= 0),
	CONSTRAINT "price_signal_evaluations_amounts_check" CHECK (("price_signal_evaluations"."value_amount" is null or "price_signal_evaluations"."value_amount" >= 0)
          and ("price_signal_evaluations"."value_low_amount" is null or "price_signal_evaluations"."value_low_amount" >= 0)
          and ("price_signal_evaluations"."value_high_amount" is null or "price_signal_evaluations"."value_high_amount" >= 0)),
	CONSTRAINT "price_signal_evaluations_evidence_bound_check" CHECK (cardinality("price_signal_evaluations"."evidence_observation_ids") <= 200
          and cardinality("price_signal_evaluations"."evidence_offer_ids") <= 200
          and cardinality("price_signal_evaluations"."excluded_outlier_observation_ids") <= 200)
);
--> statement-breakpoint
CREATE TABLE "price_signal_feedback" (
	"id" text PRIMARY KEY NOT NULL,
	"merchant_id" text NOT NULL,
	"reported_by_oxy_user_id" text NOT NULL,
	"scope_kind" text NOT NULL,
	"canonical_product_id" text,
	"canonical_variant_id" text,
	"segment" text NOT NULL,
	"market" text,
	"display_currency" text NOT NULL,
	"signal_kind" text NOT NULL,
	"reason" text NOT NULL,
	"note" text,
	"status" text DEFAULT 'open' NOT NULL,
	"resolved_by_oxy_user_id" text,
	"resolved_at" timestamp with time zone,
	"resolution_note" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"subject_key" text GENERATED ALWAYS AS (coalesce("canonical_product_id", '') || '|' || coalesce("canonical_variant_id", '') || '|' ||
            "segment" || '|' || coalesce("market", '') || '|' || "display_currency") STORED NOT NULL,
	CONSTRAINT "price_signal_feedback_scope_kind_check" CHECK ("price_signal_feedback"."scope_kind" in ('canonical_product', 'canonical_variant')),
	CONSTRAINT "price_signal_feedback_segment_check" CHECK ("price_signal_feedback"."segment" in ('new', 'open_box', 'refurbished', 'used', 'for_parts')),
	CONSTRAINT "price_signal_feedback_signal_kind_check" CHECK ("price_signal_feedback"."signal_kind" in ('lowest_observed_item_price', 'lowest_observed_known_total', 'current_vs_recent_median', 'material_price_drop', 'typical_recent_range', 'official_store_position', 'price_quality_label')),
	CONSTRAINT "price_signal_feedback_reason_check" CHECK ("price_signal_feedback"."reason" in ('stale_observation', 'wrong_condition', 'wrong_currency', 'duplicate_offer', 'scale_error', 'not_our_offer', 'outdated_delivery_cost')),
	CONSTRAINT "price_signal_feedback_status_check" CHECK ("price_signal_feedback"."status" in ('open', 'resolved', 'rejected')),
	CONSTRAINT "price_signal_feedback_display_currency_check" CHECK ("price_signal_feedback"."display_currency" in ('FAIR', 'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF', 'CNY', 'SEK', 'NOK', 'DKK', 'PLN', 'MXN', 'BRL', 'INR', 'NZD', 'ZAR', 'SGD', 'HKD', 'AED')),
	CONSTRAINT "price_signal_feedback_market_check" CHECK ("price_signal_feedback"."market" ~ '^[A-Z]{2}$'),
	CONSTRAINT "price_signal_feedback_reporter_check" CHECK (btrim("price_signal_feedback"."reported_by_oxy_user_id") <> ''),
	CONSTRAINT "price_signal_feedback_scope_shape_check" CHECK (case "price_signal_feedback"."scope_kind"
        when 'canonical_product' then "price_signal_feedback"."canonical_product_id" is not null and "price_signal_feedback"."canonical_variant_id" is null
        when 'canonical_variant' then "price_signal_feedback"."canonical_variant_id" is not null and "price_signal_feedback"."canonical_product_id" is null
        else false
      end),
	CONSTRAINT "price_signal_feedback_note_length_check" CHECK (("price_signal_feedback"."note" is null or length("price_signal_feedback"."note") <= 500)
          and ("price_signal_feedback"."resolution_note" is null
               or length("price_signal_feedback"."resolution_note") <= 500)),
	CONSTRAINT "price_signal_feedback_resolution_shape_check" CHECK ((("price_signal_feedback"."status" = 'open') = ("price_signal_feedback"."resolved_at" is null))
          and (("price_signal_feedback"."resolved_at" is null) = ("price_signal_feedback"."resolved_by_oxy_user_id" is null)))
);
--> statement-breakpoint
CREATE TABLE "price_signal_policy_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"policy_key" text NOT NULL,
	"version" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"description" text NOT NULL,
	"min_observations" integer DEFAULT 8 NOT NULL,
	"min_distinct_sellers" integer DEFAULT 3 NOT NULL,
	"min_distinct_offers" integer DEFAULT 3 NOT NULL,
	"min_coverage_days" integer DEFAULT 7 NOT NULL,
	"recent_window_days" integer DEFAULT 30 NOT NULL,
	"outlier_modified_z_threshold" double precision DEFAULT 3.5 NOT NULL,
	"outlier_min_deviation_bps" integer DEFAULT 7500 NOT NULL,
	"material_drop_bps" integer DEFAULT 500 NOT NULL,
	"typical_band_bps" integer DEFAULT 300 NOT NULL,
	"good_price_below_median_bps" integer DEFAULT 800 NOT NULL,
	"strong_sample_multiplier" double precision DEFAULT 2 NOT NULL,
	"objective_metric_keys" text[] DEFAULT '{}'::text[] NOT NULL,
	"guardrail_metric_keys" text[] DEFAULT '{}'::text[] NOT NULL,
	"activated_at" timestamp with time zone,
	"superseded_at" timestamp with time zone,
	"archived_at" timestamp with time zone,
	"created_by_oxy_user_id" text NOT NULL,
	"approved_by_oxy_user_id" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "price_signal_policy_versions_status_check" CHECK ("price_signal_policy_versions"."status" in ('draft', 'active', 'superseded', 'archived')),
	CONSTRAINT "price_signal_policy_versions_version_check" CHECK (btrim("price_signal_policy_versions"."version") <> ''),
	CONSTRAINT "price_signal_policy_versions_description_check" CHECK (btrim("price_signal_policy_versions"."description") <> ''),
	CONSTRAINT "price_signal_policy_versions_actor_check" CHECK (btrim("price_signal_policy_versions"."created_by_oxy_user_id") <> ''),
	CONSTRAINT "price_signal_policy_versions_sample_floor_check" CHECK ("price_signal_policy_versions"."min_observations" >= 1
          and "price_signal_policy_versions"."min_distinct_sellers" >= 3
          and "price_signal_policy_versions"."min_distinct_offers" >= 1
          and "price_signal_policy_versions"."min_coverage_days" >= 1
          and "price_signal_policy_versions"."recent_window_days" >= 1),
	CONSTRAINT "price_signal_policy_versions_outlier_threshold_check" CHECK ("price_signal_policy_versions"."outlier_modified_z_threshold" > 0 and "price_signal_policy_versions"."outlier_min_deviation_bps" > 0),
	CONSTRAINT "price_signal_policy_versions_thresholds_check" CHECK ("price_signal_policy_versions"."material_drop_bps" > 0 and "price_signal_policy_versions"."typical_band_bps" > 0
          and "price_signal_policy_versions"."good_price_below_median_bps" >= "price_signal_policy_versions"."typical_band_bps"
          and "price_signal_policy_versions"."strong_sample_multiplier" >= 1),
	CONSTRAINT "price_signal_policy_versions_activation_audit_check" CHECK ("price_signal_policy_versions"."status" in ('draft', 'archived')
          or ("price_signal_policy_versions"."approved_by_oxy_user_id" is not null and "price_signal_policy_versions"."activated_at" is not null)),
	CONSTRAINT "price_signal_policy_versions_superseded_check" CHECK ("price_signal_policy_versions"."status" <> 'superseded' or "price_signal_policy_versions"."superseded_at" is not null),
	CONSTRAINT "price_signal_policy_versions_archived_check" CHECK (("price_signal_policy_versions"."status" = 'archived') = ("price_signal_policy_versions"."archived_at" is not null)),
	CONSTRAINT "price_signal_policy_versions_objective_metrics_check" CHECK ("price_signal_policy_versions"."objective_metric_keys" <@ array['search_success_rate', 'zero_result_rate', 'duplicate_product_rate', 'search_to_product_click_rate', 'product_to_offer_selection_rate', 'external_click_through_rate', 'native_add_to_cart_rate', 'native_checkout_conversion', 'authenticated_checkout_funnel', 'guest_checkout_funnel', 'guest_verified_payment_conversion', 'order_portal_delivery_success', 'oxy_claim_funnel', 'saved_intent_return_rate', 'source_coverage_gap', 'query_latency_and_freshness', 'merchant_claim_funnel', 'native_gmv', 'marketplace_revenue', 'affiliate_commission', 'guest_post_purchase_demand', 'guest_eligibility_coverage']::text[]),
	CONSTRAINT "price_signal_policy_versions_guardrail_metrics_check" CHECK ("price_signal_policy_versions"."guardrail_metric_keys" <@ array['search_success_rate', 'zero_result_rate', 'duplicate_product_rate', 'search_to_product_click_rate', 'product_to_offer_selection_rate', 'external_click_through_rate', 'native_add_to_cart_rate', 'native_checkout_conversion', 'authenticated_checkout_funnel', 'guest_checkout_funnel', 'guest_verified_payment_conversion', 'order_portal_delivery_success', 'oxy_claim_funnel', 'saved_intent_return_rate', 'source_coverage_gap', 'query_latency_and_freshness', 'merchant_claim_funnel', 'native_gmv', 'marketplace_revenue', 'affiliate_commission', 'guest_post_purchase_demand', 'guest_eligibility_coverage']::text[]),
	CONSTRAINT "price_signal_policy_versions_evaluation_plan_check" CHECK (cardinality("price_signal_policy_versions"."guardrail_metric_keys") >= 1)
);
--> statement-breakpoint
CREATE TABLE "price_signal_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"policy_version_id" text NOT NULL,
	"mode" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"display_currency" text NOT NULL,
	"market" text,
	"cursor_canonical_product_id" text,
	"subjects_scanned" integer DEFAULT 0 NOT NULL,
	"subjects_measured" integer DEFAULT 0 NOT NULL,
	"subjects_unmeasured" integer DEFAULT 0 NOT NULL,
	"subjects_failed" integer DEFAULT 0 NOT NULL,
	"signals_evaluated" integer DEFAULT 0 NOT NULL,
	"signals_measured" integer DEFAULT 0 NOT NULL,
	"signals_not_present" integer DEFAULT 0 NOT NULL,
	"signals_unmeasured" integer DEFAULT 0 NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"lease_owner" text,
	"lease_until" timestamp with time zone,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "price_signal_runs_identity_key" UNIQUE("id","policy_version_id"),
	CONSTRAINT "price_signal_runs_mode_check" CHECK ("price_signal_runs"."mode" in ('monitor', 'candidate_comparison')),
	CONSTRAINT "price_signal_runs_status_check" CHECK ("price_signal_runs"."status" in ('pending', 'processing', 'done', 'failed')),
	CONSTRAINT "price_signal_runs_display_currency_check" CHECK ("price_signal_runs"."display_currency" in ('FAIR', 'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF', 'CNY', 'SEK', 'NOK', 'DKK', 'PLN', 'MXN', 'BRL', 'INR', 'NZD', 'ZAR', 'SGD', 'HKD', 'AED')),
	CONSTRAINT "price_signal_runs_market_check" CHECK ("price_signal_runs"."market" ~ '^[A-Z]{2}$'),
	CONSTRAINT "price_signal_runs_subject_counters_check" CHECK ("price_signal_runs"."subjects_scanned" >= 0 and "price_signal_runs"."subjects_measured" >= 0
          and "price_signal_runs"."subjects_unmeasured" >= 0 and "price_signal_runs"."subjects_failed" >= 0
          and "price_signal_runs"."subjects_measured" + "price_signal_runs"."subjects_unmeasured" + "price_signal_runs"."subjects_failed"
              = "price_signal_runs"."subjects_scanned"),
	CONSTRAINT "price_signal_runs_signal_counters_check" CHECK ("price_signal_runs"."signals_evaluated" >= 0 and "price_signal_runs"."signals_measured" >= 0
          and "price_signal_runs"."signals_not_present" >= 0 and "price_signal_runs"."signals_unmeasured" >= 0
          and "price_signal_runs"."signals_measured" + "price_signal_runs"."signals_not_present" + "price_signal_runs"."signals_unmeasured"
              = "price_signal_runs"."signals_evaluated"),
	CONSTRAINT "price_signal_runs_attempts_check" CHECK ("price_signal_runs"."attempts" >= 0),
	CONSTRAINT "price_signal_runs_last_error_length_check" CHECK ("price_signal_runs"."last_error" is null or length("price_signal_runs"."last_error") <= 500)
);
--> statement-breakpoint
ALTER TABLE "price_signal_evaluations" ADD CONSTRAINT "price_signal_evaluations_run_id_price_signal_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."price_signal_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_signal_evaluations" ADD CONSTRAINT "price_signal_evaluations_policy_version_id_price_signal_policy_versions_id_fk" FOREIGN KEY ("policy_version_id") REFERENCES "public"."price_signal_policy_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_signal_evaluations" ADD CONSTRAINT "price_signal_evaluations_canonical_product_id_canonical_products_id_fk" FOREIGN KEY ("canonical_product_id") REFERENCES "public"."canonical_products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_signal_evaluations" ADD CONSTRAINT "price_signal_evaluations_canonical_variant_id_canonical_variants_id_fk" FOREIGN KEY ("canonical_variant_id") REFERENCES "public"."canonical_variants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_signal_evaluations" ADD CONSTRAINT "price_signal_evaluations_run_policy_fk" FOREIGN KEY ("run_id","policy_version_id") REFERENCES "public"."price_signal_runs"("id","policy_version_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_signal_feedback" ADD CONSTRAINT "price_signal_feedback_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_signal_feedback" ADD CONSTRAINT "price_signal_feedback_canonical_product_id_canonical_products_id_fk" FOREIGN KEY ("canonical_product_id") REFERENCES "public"."canonical_products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_signal_feedback" ADD CONSTRAINT "price_signal_feedback_canonical_variant_id_canonical_variants_id_fk" FOREIGN KEY ("canonical_variant_id") REFERENCES "public"."canonical_variants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_signal_runs" ADD CONSTRAINT "price_signal_runs_policy_version_id_price_signal_policy_versions_id_fk" FOREIGN KEY ("policy_version_id") REFERENCES "public"."price_signal_policy_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "price_signal_evaluations_run_subject_key" ON "price_signal_evaluations" USING btree ("run_id","subject_key","signal_kind");--> statement-breakpoint
CREATE INDEX "price_signal_evaluations_run_kind_idx" ON "price_signal_evaluations" USING btree ("run_id","signal_kind","state");--> statement-breakpoint
CREATE INDEX "price_signal_evaluations_subject_idx" ON "price_signal_evaluations" USING btree ("subject_key","signal_kind","evaluated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "price_signal_feedback_open_key" ON "price_signal_feedback" USING btree ("merchant_id","subject_key","signal_kind") WHERE "price_signal_feedback"."resolved_at" is null;--> statement-breakpoint
CREATE INDEX "price_signal_feedback_merchant_created_at_idx" ON "price_signal_feedback" USING btree ("merchant_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "price_signal_feedback_open_idx" ON "price_signal_feedback" USING btree ("created_at" DESC NULLS LAST) WHERE "price_signal_feedback"."resolved_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "price_signal_policy_versions_key_version_key" ON "price_signal_policy_versions" USING btree ("policy_key","version");--> statement-breakpoint
CREATE UNIQUE INDEX "price_signal_policy_versions_one_active_per_key" ON "price_signal_policy_versions" USING btree ("policy_key") WHERE "price_signal_policy_versions"."status" = 'active';--> statement-breakpoint
CREATE INDEX "price_signal_policy_versions_key_created_at_idx" ON "price_signal_policy_versions" USING btree ("policy_key","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "price_signal_runs_pending_idx" ON "price_signal_runs" USING btree ("created_at") WHERE "price_signal_runs"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "price_signal_runs_reclaim_idx" ON "price_signal_runs" USING btree ("lease_until") WHERE "price_signal_runs"."status" = 'processing';--> statement-breakpoint
CREATE INDEX "price_signal_runs_policy_created_at_idx" ON "price_signal_runs" USING btree ("policy_version_id","created_at" DESC NULLS LAST);
--> statement-breakpoint
--
-- ── HAND-WRITTEN: the two triggers ──────────────────────────────────────────
--

--
-- A policy version is frozen once it leaves `draft`.
--
-- Every column that decides what a claim MEANS, plus the audit columns that say
-- who published it. `status`, `activated_at`, `superseded_at`, `archived_at` and
-- `approved_by_oxy_user_id` are deliberately NOT frozen — those are the
-- lifecycle, and freezing them would make activation and rollback impossible.
--
CREATE OR REPLACE FUNCTION mercaria_price_signal_policy_immutable()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.status = 'draft' THEN
    RETURN NEW;
  END IF;

  IF NEW.policy_key IS DISTINCT FROM OLD.policy_key
     OR NEW.version IS DISTINCT FROM OLD.version
     OR NEW.description IS DISTINCT FROM OLD.description
     OR NEW.created_by_oxy_user_id IS DISTINCT FROM OLD.created_by_oxy_user_id
     OR NEW.min_observations IS DISTINCT FROM OLD.min_observations
     OR NEW.min_distinct_sellers IS DISTINCT FROM OLD.min_distinct_sellers
     OR NEW.min_distinct_offers IS DISTINCT FROM OLD.min_distinct_offers
     OR NEW.min_coverage_days IS DISTINCT FROM OLD.min_coverage_days
     OR NEW.recent_window_days IS DISTINCT FROM OLD.recent_window_days
     OR NEW.outlier_modified_z_threshold IS DISTINCT FROM OLD.outlier_modified_z_threshold
     OR NEW.material_drop_bps IS DISTINCT FROM OLD.material_drop_bps
     OR NEW.typical_band_bps IS DISTINCT FROM OLD.typical_band_bps
     OR NEW.good_price_below_median_bps IS DISTINCT FROM OLD.good_price_below_median_bps
     OR NEW.strong_sample_multiplier IS DISTINCT FROM OLD.strong_sample_multiplier
     OR NEW.objective_metric_keys IS DISTINCT FROM OLD.objective_metric_keys
     OR NEW.guardrail_metric_keys IS DISTINCT FROM OLD.guardrail_metric_keys
  THEN
    RAISE EXCEPTION
      'price_signal_policy_versions % (%, v%) is % and has served; publish a new version instead of editing this one',
      OLD.id, OLD.policy_key, OLD.version, OLD.status
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS price_signal_policy_versions_immutable_once_serving ON "price_signal_policy_versions";--> statement-breakpoint
CREATE TRIGGER price_signal_policy_versions_immutable_once_serving
BEFORE UPDATE ON "price_signal_policy_versions"
FOR EACH ROW EXECUTE FUNCTION mercaria_price_signal_policy_immutable();--> statement-breakpoint

--
-- An evaluation is EVIDENCE: no UPDATE, ever.
--
-- DELETE is deliberately PERMITTED, inverting the ledger's posture and matching
-- `analytics_events` and #78's snapshots: retention on a schedule is an operator
-- decision, and a trigger refusing DELETE would make it fail silently on every
-- row it was asked to remove. What must never happen is a measurement being
-- rewritten to say something the sweep did not find.
--
CREATE OR REPLACE FUNCTION mercaria_price_signal_evaluation_append_only()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION
    'price_signal_evaluations % is append-only; a measurement is evidence and cannot be rewritten',
    OLD.id
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS price_signal_evaluations_append_only ON "price_signal_evaluations";--> statement-breakpoint
CREATE TRIGGER price_signal_evaluations_append_only
BEFORE UPDATE ON "price_signal_evaluations"
FOR EACH ROW EXECUTE FUNCTION mercaria_price_signal_evaluation_append_only();
