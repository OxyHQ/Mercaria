-- oxy:deploy-phase=pre
-- oxy:rollback=restore: store_members_permissions_check is widened for a new store permission; the previous form is in 0000 and re-adding it fails against any member row already granted the added permission
--
-- Merchant demand analytics and the acquisition pipeline (#86).
--
-- Purely ADDITIVE. Seven new tables and ONE widening -- the
-- `store_members_permissions_check` drop-and-re-add whose new tuple is a strict
-- SUPERSET of the old (it gains `analytics:read`), so every permission set the
-- serving image can write still passes and no membership row is invalidated.
--
-- Nothing here narrows, renames or drops, which is why it is `pre`: the image
-- that applies it can be the one running before the deploy.
--
-- ## Hand-written statements live in ONE anchored block at the END of this file
--
-- `bun run db:generate` DROPS everything drizzle-kit cannot model, so a
-- regeneration after a rebase loses the six triggers below. Re-apply the block
-- verbatim and grep the regenerated file for each `CREATE FUNCTION` /
-- `CREATE TRIGGER` pair and for exactly one deploy-phase marker line.
--

CREATE TABLE "merchant_acquisition_audits" (
	"id" text PRIMARY KEY NOT NULL,
	"merchant_id" text,
	"action" text NOT NULL,
	"outcome" text NOT NULL,
	"refusal_code" text,
	"actor_oxy_user_id" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "merchant_acquisition_audits_action_check" CHECK ("merchant_acquisition_audits"."action" in ('assign', 'set_next_action', 'record_outreach', 'record_contact_source', 'exclude', 'clear_exclusion', 'set_do_not_contact', 'rescore')),
	CONSTRAINT "merchant_acquisition_audits_outcome_check" CHECK ("merchant_acquisition_audits"."outcome" in ('granted', 'refused')),
	CONSTRAINT "merchant_acquisition_audits_refusal_check" CHECK (("merchant_acquisition_audits"."outcome" = 'refused') = ("merchant_acquisition_audits"."refusal_code" is not null)
          and ("merchant_acquisition_audits"."refusal_code" is null or "merchant_acquisition_audits"."refusal_code" ~ '^[a-z_]{3,64}$'))
);
--> statement-breakpoint
CREATE TABLE "merchant_acquisition_candidates" (
	"id" text PRIMARY KEY NOT NULL,
	"merchant_id" text NOT NULL,
	"state" text NOT NULL,
	"score_bps" integer DEFAULT 0 NOT NULL,
	"score_version" text NOT NULL,
	"scored_at" timestamp with time zone,
	"snapshot_id" text,
	"contributing_inputs" text[] DEFAULT '{}'::text[] NOT NULL,
	"unmeasured_inputs" text[] DEFAULT '{}'::text[] NOT NULL,
	"assigned_to_oxy_user_id" text,
	"next_action" text,
	"next_action_due_at" timestamp with time zone,
	"do_not_contact" boolean DEFAULT false NOT NULL,
	"do_not_contact_recorded_at" timestamp with time zone,
	"exclusion_reason" text,
	"excluded_at" timestamp with time zone,
	"excluded_by_oxy_user_id" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "merchant_acquisition_candidates_state_check" CHECK ("merchant_acquisition_candidates"."state" in ('identified', 'queued', 'in_outreach', 'awaiting_response', 'closed_won', 'closed_declined', 'excluded')),
	CONSTRAINT "merchant_acquisition_candidates_exclusion_check" CHECK ("merchant_acquisition_candidates"."exclusion_reason" in ('do_not_contact_requested', 'merchant_suppressed', 'rights_withdrawn', 'duplicate_of_another_candidate', 'out_of_market', 'competitor_conflict', 'legal_review_required', 'operator_judgement')),
	CONSTRAINT "merchant_acquisition_candidates_contributing_check" CHECK ("merchant_acquisition_candidates"."contributing_inputs" <@ array['aggregate_demand', 'catalog_size', 'catalog_freshness', 'source_quality', 'connector_fit', 'unmet_native_demand']::text[]),
	CONSTRAINT "merchant_acquisition_candidates_unmeasured_check" CHECK ("merchant_acquisition_candidates"."unmeasured_inputs" <@ array['aggregate_demand', 'catalog_size', 'catalog_freshness', 'source_quality', 'connector_fit', 'unmet_native_demand']::text[]),
	CONSTRAINT "merchant_acquisition_candidates_score_check" CHECK ("merchant_acquisition_candidates"."score_bps" between 0 and 10000
          and ("merchant_acquisition_candidates"."scored_at" is null) = ("merchant_acquisition_candidates"."snapshot_id" is null)),
	CONSTRAINT "merchant_acquisition_candidates_exclusion_shape_check" CHECK (num_nonnulls("merchant_acquisition_candidates"."exclusion_reason", "merchant_acquisition_candidates"."excluded_at", "merchant_acquisition_candidates"."excluded_by_oxy_user_id") in (0, 3)
          and ("merchant_acquisition_candidates"."state" = 'excluded') = ("merchant_acquisition_candidates"."excluded_at" is not null)),
	CONSTRAINT "merchant_acquisition_candidates_dnc_check" CHECK ("merchant_acquisition_candidates"."do_not_contact" = ("merchant_acquisition_candidates"."do_not_contact_recorded_at" is not null)),
	CONSTRAINT "merchant_acquisition_candidates_next_action_check" CHECK (num_nonnulls("merchant_acquisition_candidates"."next_action", "merchant_acquisition_candidates"."next_action_due_at") in (0, 2)
          and ("merchant_acquisition_candidates"."next_action" is null or length("merchant_acquisition_candidates"."next_action") between 1 and 500))
);
--> statement-breakpoint
CREATE TABLE "merchant_acquisition_contact_sources" (
	"id" text PRIMARY KEY NOT NULL,
	"candidate_id" text NOT NULL,
	"kind" text NOT NULL,
	"source_url" text NOT NULL,
	"locator_note" text NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"recorded_by_oxy_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "merchant_acquisition_contact_sources_kind_check" CHECK ("merchant_acquisition_contact_sources"."kind" in ('merchant_website_imprint', 'merchant_website_contact_page', 'public_feed_contact_field', 'affiliate_network_directory', 'public_business_registry')),
	CONSTRAINT "merchant_acquisition_contact_sources_url_check" CHECK (length("merchant_acquisition_contact_sources"."source_url") between 12 and 500
          and "merchant_acquisition_contact_sources"."source_url" ~ '^https://[^[:space:]]+$'),
	CONSTRAINT "merchant_acquisition_contact_sources_locator_check" CHECK (length("merchant_acquisition_contact_sources"."locator_note") between 1 and 200
          and "merchant_acquisition_contact_sources"."locator_note" !~ '@'
          and "merchant_acquisition_contact_sources"."locator_note" !~ '[0-9]{5}')
);
--> statement-breakpoint
CREATE TABLE "merchant_acquisition_outreach" (
	"id" text PRIMARY KEY NOT NULL,
	"candidate_id" text NOT NULL,
	"channel" text NOT NULL,
	"outcome" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"actor_oxy_user_id" text NOT NULL,
	"contact_source_id" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "merchant_acquisition_outreach_channel_check" CHECK ("merchant_acquisition_outreach"."channel" in ('email', 'phone', 'postal', 'in_person', 'network_intermediary')),
	CONSTRAINT "merchant_acquisition_outreach_outcome_check" CHECK ("merchant_acquisition_outreach"."outcome" in ('sent', 'bounced', 'replied_interested', 'replied_declined', 'no_response'))
);
--> statement-breakpoint
CREATE TABLE "merchant_demand_metrics" (
	"id" text PRIMARY KEY NOT NULL,
	"snapshot_id" text NOT NULL,
	"metric_key" text NOT NULL,
	"kind" text NOT NULL,
	"channel" text NOT NULL,
	"storefront_id" text NOT NULL,
	"source_id" text NOT NULL,
	"count_value" bigint,
	"amount_value" bigint,
	"amount_currency" text,
	"rate_numerator" bigint,
	"rate_denominator" bigint,
	"aggregate_basis" text,
	"suppressed_below" integer,
	"unavailable_reason" text,
	"unavailable_seam" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "merchant_demand_metrics_metric_key_check" CHECK ("merchant_demand_metrics"."metric_key" in ('search_result_impressions', 'product_page_views_with_offer', 'offer_impressions', 'human_outbound_clicks', 'network_reported_conversions', 'affiliate_commission', 'external_order_value', 'native_offer_views', 'native_add_to_cart', 'native_checkout_starts', 'native_paid_orders', 'native_gmv', 'product_save_demand', 'price_alert_demand', 'zero_result_demand', 'demand_without_native_offer', 'subjects_with_a_price_comparison', 'catalog_freshness_rate', 'unavailable_click_rate')),
	CONSTRAINT "merchant_demand_metrics_kind_check" CHECK ("merchant_demand_metrics"."kind" in ('observed_interaction', 'affiliate_conversion', 'affiliate_commission', 'external_order_value', 'native_gmv', 'inferred_demand', 'coverage', 'catalog_health')),
	CONSTRAINT "merchant_demand_metrics_aggregate_basis_check" CHECK ("merchant_demand_metrics"."aggregate_basis" in ('whole_catalogue', 'disclosed_rows_only')),
	CONSTRAINT "merchant_demand_metrics_unavailable_reason_check" CHECK ("merchant_demand_metrics"."unavailable_reason" in ('awaiting_seam', 'collection_disabled', 'merchant_scope_absent_on_event', 'relationship_not_defensible', 'alert_subject_counts_unrepresentable', 'no_native_activation')),
	CONSTRAINT "merchant_demand_metrics_channel_check" CHECK ("merchant_demand_metrics"."channel" = '' or "merchant_demand_metrics"."channel" in ('native', 'external')),
	CONSTRAINT "merchant_demand_metrics_state_check" CHECK (num_nonnulls("merchant_demand_metrics"."suppressed_below", "merchant_demand_metrics"."unavailable_reason") <= 1
          and (
            ("merchant_demand_metrics"."suppressed_below" is null and "merchant_demand_metrics"."unavailable_reason" is null)
            or num_nonnulls("merchant_demand_metrics"."count_value", "merchant_demand_metrics"."amount_value", "merchant_demand_metrics"."rate_numerator") = 0
          )),
	CONSTRAINT "merchant_demand_metrics_money_shape_check" CHECK (num_nonnulls("merchant_demand_metrics"."amount_value", "merchant_demand_metrics"."amount_currency") in (0, 2)
          and ("merchant_demand_metrics"."amount_value" is null
               or "merchant_demand_metrics"."metric_key" in ('affiliate_commission', 'external_order_value', 'native_gmv'))),
	CONSTRAINT "merchant_demand_metrics_rate_shape_check" CHECK (num_nonnulls("merchant_demand_metrics"."rate_numerator", "merchant_demand_metrics"."rate_denominator") in (0, 2)
          and ("merchant_demand_metrics"."rate_numerator" is null
               or "merchant_demand_metrics"."metric_key" in ('subjects_with_a_price_comparison', 'catalog_freshness_rate', 'unavailable_click_rate'))
          and ("merchant_demand_metrics"."rate_denominator" is null or "merchant_demand_metrics"."rate_denominator" >= 0)
          and ("merchant_demand_metrics"."rate_numerator" is null or "merchant_demand_metrics"."rate_numerator" <= "merchant_demand_metrics"."rate_denominator")),
	CONSTRAINT "merchant_demand_metrics_count_shape_check" CHECK (("merchant_demand_metrics"."count_value" is null or "merchant_demand_metrics"."count_value" >= 0)
          and ("merchant_demand_metrics"."count_value" is null
               or "merchant_demand_metrics"."metric_key" not in ('affiliate_commission', 'external_order_value', 'native_gmv'))
          and ("merchant_demand_metrics"."count_value" is null
               or "merchant_demand_metrics"."metric_key" not in ('subjects_with_a_price_comparison', 'catalog_freshness_rate', 'unavailable_click_rate'))),
	CONSTRAINT "merchant_demand_metrics_basis_shape_check" CHECK ("merchant_demand_metrics"."aggregate_basis" is null
          or ("merchant_demand_metrics"."suppressed_below" is null and "merchant_demand_metrics"."unavailable_reason" is null)),
	CONSTRAINT "merchant_demand_metrics_seam_check" CHECK ("merchant_demand_metrics"."unavailable_seam" is null or "merchant_demand_metrics"."unavailable_reason" is not null),
	CONSTRAINT "merchant_demand_metrics_amount_currency_check" CHECK ("merchant_demand_metrics"."amount_currency" in ('FAIR', 'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF', 'CNY', 'SEK', 'NOK', 'DKK', 'PLN', 'MXN', 'BRL', 'INR', 'NZD', 'ZAR', 'SGD', 'HKD', 'AED'))
);
--> statement-breakpoint
CREATE TABLE "merchant_demand_products" (
	"id" text PRIMARY KEY NOT NULL,
	"snapshot_id" text NOT NULL,
	"canonical_product_id" text NOT NULL,
	"product_page_views" bigint NOT NULL,
	"offer_impressions" bigint NOT NULL,
	"has_native_offer" boolean NOT NULL,
	"offer_freshness" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "merchant_demand_products_counts_check" CHECK ("merchant_demand_products"."product_page_views" >= 0 and "merchant_demand_products"."offer_impressions" >= 0),
	CONSTRAINT "merchant_demand_products_freshness_check" CHECK ("merchant_demand_products"."offer_freshness" in ('current', 'warning', 'expired', 'unavailable', 'unknown'))
);
--> statement-breakpoint
CREATE TABLE "merchant_demand_snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"merchant_id" text NOT NULL,
	"market" text NOT NULL,
	"window_from" timestamp with time zone NOT NULL,
	"window_to" timestamp with time zone NOT NULL,
	"data_fresh_as_of" timestamp with time zone NOT NULL,
	"event_policy_version" text NOT NULL,
	"attribution_policy_version" text NOT NULL,
	"collection_mode" text NOT NULL,
	"aggregate_floor" integer NOT NULL,
	"product_floor" integer NOT NULL,
	"products_offered" integer DEFAULT 0 NOT NULL,
	"product_rows_disclosed" integer DEFAULT 0 NOT NULL,
	"product_rows_suppressed" integer DEFAULT 0 NOT NULL,
	"superseded_at" timestamp with time zone,
	"superseded_by_id" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "merchant_demand_snapshots_window_check" CHECK ("merchant_demand_snapshots"."window_to" > "merchant_demand_snapshots"."window_from" and "merchant_demand_snapshots"."data_fresh_as_of" >= "merchant_demand_snapshots"."window_from"),
	CONSTRAINT "merchant_demand_snapshots_market_check" CHECK ("merchant_demand_snapshots"."market" = '' or "merchant_demand_snapshots"."market" ~ '^[A-Z]{2}$'),
	CONSTRAINT "merchant_demand_snapshots_floor_check" CHECK ("merchant_demand_snapshots"."aggregate_floor" >= 1 and "merchant_demand_snapshots"."product_floor" >= "merchant_demand_snapshots"."aggregate_floor"),
	CONSTRAINT "merchant_demand_snapshots_coverage_total_check" CHECK ("merchant_demand_snapshots"."product_rows_disclosed" >= 0
          and "merchant_demand_snapshots"."product_rows_suppressed" >= 0
          and "merchant_demand_snapshots"."products_offered" = "merchant_demand_snapshots"."product_rows_disclosed" + "merchant_demand_snapshots"."product_rows_suppressed"),
	CONSTRAINT "merchant_demand_snapshots_superseded_check" CHECK (num_nonnulls("merchant_demand_snapshots"."superseded_at", "merchant_demand_snapshots"."superseded_by_id") in (0, 2)
          and ("merchant_demand_snapshots"."superseded_by_id" is null or "merchant_demand_snapshots"."superseded_by_id" <> "merchant_demand_snapshots"."id"))
);
--> statement-breakpoint
ALTER TABLE "store_members" DROP CONSTRAINT "store_members_permissions_check";--> statement-breakpoint
ALTER TABLE "merchant_acquisition_candidates" ADD CONSTRAINT "merchant_acquisition_candidates_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchant_acquisition_candidates" ADD CONSTRAINT "merchant_acquisition_candidates_snapshot_id_merchant_demand_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."merchant_demand_snapshots"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchant_acquisition_contact_sources" ADD CONSTRAINT "merchant_acquisition_contact_sources_candidate_id_merchant_acquisition_candidates_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."merchant_acquisition_candidates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchant_acquisition_outreach" ADD CONSTRAINT "merchant_acquisition_outreach_candidate_id_merchant_acquisition_candidates_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."merchant_acquisition_candidates"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchant_acquisition_outreach" ADD CONSTRAINT "merchant_acquisition_outreach_contact_source_id_merchant_acquisition_contact_sources_id_fk" FOREIGN KEY ("contact_source_id") REFERENCES "public"."merchant_acquisition_contact_sources"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchant_demand_metrics" ADD CONSTRAINT "merchant_demand_metrics_snapshot_id_merchant_demand_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."merchant_demand_snapshots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchant_demand_products" ADD CONSTRAINT "merchant_demand_products_snapshot_id_merchant_demand_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."merchant_demand_snapshots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchant_demand_products" ADD CONSTRAINT "merchant_demand_products_canonical_product_id_canonical_products_id_fk" FOREIGN KEY ("canonical_product_id") REFERENCES "public"."canonical_products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchant_demand_snapshots" ADD CONSTRAINT "merchant_demand_snapshots_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "merchant_acquisition_audits_actor_idx" ON "merchant_acquisition_audits" USING btree ("actor_oxy_user_id","occurred_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "merchant_acquisition_audits_merchant_idx" ON "merchant_acquisition_audits" USING btree ("merchant_id","occurred_at" DESC NULLS LAST) WHERE "merchant_acquisition_audits"."merchant_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "merchant_acquisition_candidates_merchant_key" ON "merchant_acquisition_candidates" USING btree ("merchant_id");--> statement-breakpoint
CREATE INDEX "merchant_acquisition_candidates_queue_idx" ON "merchant_acquisition_candidates" USING btree ("state","score_bps" DESC NULLS LAST) WHERE "merchant_acquisition_candidates"."state" in ('identified', 'queued', 'in_outreach', 'awaiting_response');--> statement-breakpoint
CREATE INDEX "merchant_acquisition_candidates_assignee_idx" ON "merchant_acquisition_candidates" USING btree ("assigned_to_oxy_user_id","next_action_due_at") WHERE "merchant_acquisition_candidates"."assigned_to_oxy_user_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "merchant_acquisition_contact_sources_key" ON "merchant_acquisition_contact_sources" USING btree ("candidate_id","kind","source_url");--> statement-breakpoint
CREATE INDEX "merchant_acquisition_contact_sources_candidate_idx" ON "merchant_acquisition_contact_sources" USING btree ("candidate_id","observed_at");--> statement-breakpoint
CREATE INDEX "merchant_acquisition_outreach_candidate_idx" ON "merchant_acquisition_outreach" USING btree ("candidate_id","occurred_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "merchant_demand_metrics_bucket_key" ON "merchant_demand_metrics" USING btree ("snapshot_id","metric_key","channel","storefront_id","source_id");--> statement-breakpoint
CREATE INDEX "merchant_demand_metrics_snapshot_idx" ON "merchant_demand_metrics" USING btree ("snapshot_id","metric_key");--> statement-breakpoint
CREATE UNIQUE INDEX "merchant_demand_products_key" ON "merchant_demand_products" USING btree ("snapshot_id","canonical_product_id");--> statement-breakpoint
CREATE INDEX "merchant_demand_products_snapshot_idx" ON "merchant_demand_products" USING btree ("snapshot_id","product_page_views" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "merchant_demand_snapshots_live_key" ON "merchant_demand_snapshots" USING btree ("merchant_id","market","window_from","window_to") WHERE "merchant_demand_snapshots"."superseded_at" is null;--> statement-breakpoint
CREATE INDEX "merchant_demand_snapshots_merchant_idx" ON "merchant_demand_snapshots" USING btree ("merchant_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "merchant_demand_snapshots_expires_at_idx" ON "merchant_demand_snapshots" USING btree ("expires_at");--> statement-breakpoint
ALTER TABLE "store_members" ADD CONSTRAINT "store_members_permissions_check" CHECK ("store_members"."permissions" <@ array['store:manage', 'members:manage', 'products:read', 'products:write', 'inventory:write', 'locations:write', 'collections:write', 'discounts:write', 'settings:write', 'orders:read', 'orders:fulfill', 'stats:read', 'customers:read', 'customers:write', 'draft_orders:write', 'refunds:write', 'channels:write', 'analytics:read']::text[]);

-- ===========================================================================
-- HAND-WRITTEN -- re-apply this whole block after any regeneration.
-- ===========================================================================
--
-- Six triggers, and the difference between them is the point.
--
-- A SNAPSHOT is immutable except for being superseded: `superseded_at` and
-- `superseded_by_id` may move NULL -> a value exactly once and nothing else may
-- move at all. That is what makes an attribution CORRECTION a new snapshot
-- beside the old one rather than an edit to the number a merchant was already
-- shown. DELETE is permitted -- `expires_at` is registered in
-- `db/expiryTargets.ts` and a trigger refusing DELETE would make the retention
-- sweep fail silently on every row it was obliged to remove.
--
-- Its two CHILD tables refuse UPDATE and permit DELETE, because DELETE is how
-- they leave: they CASCADE from the snapshot the sweep removes.
--
-- A contact SOURCE refuses UPDATE -- a provenance record that can be edited is
-- one that can be made to describe a source it did not come from -- and permits
-- DELETE, because it CASCADEs from its candidate.
--
-- The OUTREACH log and the AUDIT trail refuse both. "Who contacted this
-- merchant, when, and what came of it" and "who tried to do what on this
-- surface" are records whose whole value is that they cannot be tidied, and
-- neither carries a retention clock for a sweep to need.

CREATE FUNCTION mercaria_merchant_demand_snapshot_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.superseded_at IS NOT NULL THEN
    RAISE EXCEPTION
      'merchant demand snapshot % is already superseded: a reporting snapshot is immutable.',
      OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF (
    NEW.id IS DISTINCT FROM OLD.id OR
    NEW.merchant_id IS DISTINCT FROM OLD.merchant_id OR
    NEW.market IS DISTINCT FROM OLD.market OR
    NEW.window_from IS DISTINCT FROM OLD.window_from OR
    NEW.window_to IS DISTINCT FROM OLD.window_to OR
    NEW.data_fresh_as_of IS DISTINCT FROM OLD.data_fresh_as_of OR
    NEW.event_policy_version IS DISTINCT FROM OLD.event_policy_version OR
    NEW.attribution_policy_version IS DISTINCT FROM OLD.attribution_policy_version OR
    NEW.collection_mode IS DISTINCT FROM OLD.collection_mode OR
    NEW.aggregate_floor IS DISTINCT FROM OLD.aggregate_floor OR
    NEW.product_floor IS DISTINCT FROM OLD.product_floor OR
    NEW.products_offered IS DISTINCT FROM OLD.products_offered OR
    NEW.product_rows_disclosed IS DISTINCT FROM OLD.product_rows_disclosed OR
    NEW.product_rows_suppressed IS DISTINCT FROM OLD.product_rows_suppressed OR
    NEW.created_at IS DISTINCT FROM OLD.created_at OR
    NEW.expires_at IS DISTINCT FROM OLD.expires_at
  ) THEN
    RAISE EXCEPTION
      'merchant demand snapshot % is immutable: supersede it with a new snapshot instead of editing it.',
      OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER merchant_demand_snapshots_immutable
  BEFORE UPDATE ON "merchant_demand_snapshots"
  FOR EACH ROW EXECUTE FUNCTION mercaria_merchant_demand_snapshot_immutable();--> statement-breakpoint
CREATE FUNCTION mercaria_merchant_demand_no_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'merchant demand rows are append-only: % on %.% is refused. A correction is a new SNAPSHOT that supersedes this one.',
    TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME
    USING ERRCODE = 'check_violation';
END;
$$;--> statement-breakpoint
CREATE TRIGGER merchant_demand_metrics_no_update
  BEFORE UPDATE ON "merchant_demand_metrics"
  FOR EACH ROW EXECUTE FUNCTION mercaria_merchant_demand_no_update();--> statement-breakpoint
CREATE TRIGGER merchant_demand_products_no_update
  BEFORE UPDATE ON "merchant_demand_products"
  FOR EACH ROW EXECUTE FUNCTION mercaria_merchant_demand_no_update();--> statement-breakpoint
CREATE TRIGGER merchant_acquisition_contact_sources_no_update
  BEFORE UPDATE ON "merchant_acquisition_contact_sources"
  FOR EACH ROW EXECUTE FUNCTION mercaria_merchant_demand_no_update();--> statement-breakpoint
CREATE FUNCTION mercaria_merchant_acquisition_record_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'merchant acquisition records are append-only: % on %.% is refused. An outreach log and an operator audit are the record of what people decided.',
    TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME
    USING ERRCODE = 'check_violation';
END;
$$;--> statement-breakpoint
CREATE TRIGGER merchant_acquisition_outreach_append_only
  BEFORE UPDATE OR DELETE ON "merchant_acquisition_outreach"
  FOR EACH ROW EXECUTE FUNCTION mercaria_merchant_acquisition_record_append_only();--> statement-breakpoint
CREATE TRIGGER merchant_acquisition_audits_append_only
  BEFORE UPDATE OR DELETE ON "merchant_acquisition_audits"
  FOR EACH ROW EXECUTE FUNCTION mercaria_merchant_acquisition_record_append_only();
