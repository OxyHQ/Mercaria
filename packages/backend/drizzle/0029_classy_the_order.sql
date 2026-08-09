-- oxy:deploy-phase=pre
-- Discovery analytics (#77): eight new tables, no change to any existing one.
-- Purely additive, so it is safe against the image still serving AND the one
-- arriving: nothing reads these tables until the new code is live.

CREATE TABLE "analytics_events" (
	"id" text PRIMARY KEY NOT NULL,
	"envelope_version" text NOT NULL,
	"event_type" text NOT NULL,
	"event_class" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"actor_kind" text NOT NULL,
	"oxy_user_id" text,
	"pseudonymous_session_id" text,
	"pseudonym_epoch" integer,
	"checkout_group_id" text,
	"order_id" text,
	"client_surface" text NOT NULL,
	"app_version" text,
	"market" text,
	"query_event_id" text,
	"listing_id" text,
	"product_variant_id" text,
	"canonical_product_id" text,
	"canonical_variant_id" text,
	"offer_id" text,
	"merchant_id" text,
	"storefront_id" text,
	"category_id" text,
	"store_id" text,
	"search_policy_version" text,
	"ranking_policy_version" text,
	"experiment_key" text,
	"experiment_version" integer,
	"experiment_variant" text,
	"traffic_class" text NOT NULL,
	"consent_state" text NOT NULL,
	"collection_mode" text NOT NULL,
	"buyer_origin" text,
	"reason_code" text,
	"position" integer,
	"result_count" integer,
	"latency_ms" integer,
	"quantity" integer,
	"item_count" integer,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "analytics_events_event_type_check" CHECK ("analytics_events"."event_type" in ('search_submitted', 'search_results_returned', 'search_zero_results', 'search_result_impression', 'search_result_click', 'entity_suggestion_click', 'product_page_view', 'variant_selected', 'offer_impression', 'offer_expanded', 'offer_selected', 'external_outbound_click', 'native_add_to_cart', 'checkout_started', 'save_action', 'alert_action', 'watchlist_action', 'merchant_claim_entry', 'sell_yours_entry', 'surface_error', 'guest_session_issued', 'guest_cart_created', 'guest_cart_item_added', 'guest_cart_item_updated', 'guest_cart_item_removed', 'guest_cart_merged', 'guest_checkout_started', 'guest_feature_gate_blocked', 'guest_contact_validated', 'guest_contact_validation_failed', 'guest_destination_validated', 'guest_destination_validation_failed', 'guest_eligibility_accepted', 'guest_eligibility_rejected', 'guest_payment_methods_shown', 'guest_payment_method_selected', 'guest_payment_action_required', 'guest_payment_client_failed', 'guest_payment_verified', 'guest_order_portal_opened', 'guest_recovery_requested', 'guest_recovery_exchanged', 'guest_claim_offered', 'guest_claim_started', 'guest_claim_completed', 'guest_claim_declined', 'guest_claim_conflicted', 'guest_cancellation_requested', 'guest_return_requested', 'guest_support_request_created', 'experiment_exposed')),
	CONSTRAINT "analytics_events_event_class_check" CHECK ("analytics_events"."event_class" in ('discovery', 'commerce_funnel', 'experiment', 'operational')),
	CONSTRAINT "analytics_events_actor_kind_check" CHECK ("analytics_events"."actor_kind" in ('oxy', 'guest', 'anonymous')),
	CONSTRAINT "analytics_events_client_surface_check" CHECK ("analytics_events"."client_surface" in ('storefront_web', 'storefront_native', 'dashboard_web', 'dashboard_native', 'pos_web', 'pos_native', 'api')),
	CONSTRAINT "analytics_events_traffic_class_check" CHECK ("analytics_events"."traffic_class" in ('human', 'internal', 'crawler', 'link_preview', 'email_scanner', 'automated_client', 'unknown')),
	CONSTRAINT "analytics_events_consent_state_check" CHECK ("analytics_events"."consent_state" in ('granted', 'denied', 'not_required', 'unknown')),
	CONSTRAINT "analytics_events_collection_mode_check" CHECK ("analytics_events"."collection_mode" in ('off', 'essential', 'full')),
	CONSTRAINT "analytics_events_buyer_origin_check" CHECK ("analytics_events"."buyer_origin" in ('authenticated', 'guest')),
	CONSTRAINT "analytics_events_reason_code_check" CHECK ("analytics_events"."reason_code" in ('not_found', 'unavailable', 'rate_limited', 'upstream_timeout', 'upstream_error', 'validation_failed', 'forbidden', 'stale_offer', 'out_of_stock', 'listing_restricted', 'seller_not_payment_ready', 'p2p_seller_excluded', 'market_not_supported', 'currency_not_supported', 'guest_commerce_disabled', 'guest_cart_disabled', 'guest_issuance_disabled', 'guest_checkout_disabled', 'merge_completed', 'merge_already_done', 'merge_nothing_to_move', 'merge_quantity_clamped', 'merge_line_flagged', 'merge_discount_dropped', 'contact_malformed', 'contact_undeliverable', 'destination_incomplete', 'destination_unsupported', 'claim_offered', 'claim_completed', 'claim_declined', 'claim_conflicted', 'other')),
	CONSTRAINT "analytics_events_identity_exclusivity_check" CHECK (num_nonnulls("analytics_events"."oxy_user_id", "analytics_events"."pseudonymous_session_id") <= 1
          and ("analytics_events"."oxy_user_id" is null or "analytics_events"."actor_kind" = 'oxy')
          and ("analytics_events"."pseudonymous_session_id" is null or "analytics_events"."actor_kind" <> 'oxy')),
	CONSTRAINT "analytics_events_pseudonym_epoch_check" CHECK (num_nonnulls("analytics_events"."pseudonymous_session_id", "analytics_events"."pseudonym_epoch") in (0, 2)),
	CONSTRAINT "analytics_events_consent_identity_check" CHECK ("analytics_events"."oxy_user_id" is null or "analytics_events"."consent_state" <> 'denied'),
	CONSTRAINT "analytics_events_collection_mode_stored_check" CHECK ("analytics_events"."collection_mode" <> 'off'),
	CONSTRAINT "analytics_events_commerce_correlation_check" CHECK (("analytics_events"."checkout_group_id" is null and "analytics_events"."order_id" is null)
          or "analytics_events"."event_type" in ('checkout_started', 'guest_checkout_started', 'guest_contact_validated', 'guest_contact_validation_failed', 'guest_destination_validated', 'guest_destination_validation_failed', 'guest_eligibility_accepted', 'guest_eligibility_rejected', 'guest_payment_methods_shown', 'guest_payment_method_selected', 'guest_payment_action_required', 'guest_payment_client_failed', 'guest_payment_verified', 'guest_order_portal_opened', 'guest_recovery_exchanged', 'guest_claim_offered', 'guest_claim_started', 'guest_claim_completed', 'guest_claim_declined', 'guest_claim_conflicted', 'guest_cancellation_requested', 'guest_return_requested', 'guest_support_request_created')),
	CONSTRAINT "analytics_events_buyer_origin_scope_check" CHECK ("analytics_events"."buyer_origin" is null
          or "analytics_events"."event_type" in ('native_add_to_cart', 'checkout_started', 'guest_checkout_started', 'guest_eligibility_accepted', 'guest_eligibility_rejected', 'guest_payment_verified')),
	CONSTRAINT "analytics_events_experiment_check" CHECK (num_nonnulls("analytics_events"."experiment_key", "analytics_events"."experiment_version", "analytics_events"."experiment_variant") in (0, 3)),
	CONSTRAINT "analytics_events_market_check" CHECK ("analytics_events"."market" is null or "analytics_events"."market" ~ '^[A-Z]{2}$'),
	CONSTRAINT "analytics_events_app_version_check" CHECK ("analytics_events"."app_version" is null or "analytics_events"."app_version" ~ '^[A-Za-z0-9._+-]{1,64}$'),
	CONSTRAINT "analytics_events_measures_check" CHECK (coalesce("analytics_events"."position", 0) >= 0
          and coalesce("analytics_events"."result_count", 0) >= 0
          and coalesce("analytics_events"."latency_ms", 0) >= 0
          and coalesce("analytics_events"."quantity", 0) >= 0
          and coalesce("analytics_events"."item_count", 0) >= 0)
);
--> statement-breakpoint
CREATE TABLE "analytics_experiment_exposures" (
	"id" text PRIMARY KEY NOT NULL,
	"experiment_key" text NOT NULL,
	"experiment_version" integer NOT NULL,
	"assignment_unit_ref" text NOT NULL,
	"assignment_unit" text NOT NULL,
	"variant" text NOT NULL,
	"first_exposed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "analytics_experiment_exposures_assignment_unit_check" CHECK ("analytics_experiment_exposures"."assignment_unit" in ('oxy_user', 'pseudonymous_session'))
);
--> statement-breakpoint
CREATE TABLE "analytics_experiments" (
	"id" text PRIMARY KEY NOT NULL,
	"experiment_key" text NOT NULL,
	"version" integer NOT NULL,
	"status" text NOT NULL,
	"treatment_kind" text NOT NULL,
	"hypothesis" text NOT NULL,
	"primary_metric_key" text NOT NULL,
	"guardrail_metric_keys" text[] DEFAULT '{}'::text[] NOT NULL,
	"stop_conditions" text[] DEFAULT '{}'::text[] NOT NULL,
	"assignment_unit" text NOT NULL,
	"assignment_salt" text NOT NULL,
	"variants" text[] NOT NULL,
	"traffic_allocation_bps" integer NOT NULL,
	"ranking_policy_version" text,
	"activated_at" timestamp with time zone,
	"stopped_at" timestamp with time zone,
	"stop_reason" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "analytics_experiments_status_check" CHECK ("analytics_experiments"."status" in ('draft', 'active', 'stopped', 'completed')),
	CONSTRAINT "analytics_experiments_treatment_kind_check" CHECK ("analytics_experiments"."treatment_kind" in ('ranking_policy', 'result_presentation', 'offer_presentation', 'copy_variant', 'checkout_step_order')),
	CONSTRAINT "analytics_experiments_assignment_unit_check" CHECK ("analytics_experiments"."assignment_unit" in ('oxy_user', 'pseudonymous_session')),
	CONSTRAINT "analytics_experiments_primary_metric_check" CHECK ("analytics_experiments"."primary_metric_key" in ('search_success_rate', 'zero_result_rate', 'duplicate_product_rate', 'search_to_product_click_rate', 'product_to_offer_selection_rate', 'external_click_through_rate', 'native_add_to_cart_rate', 'native_checkout_conversion', 'authenticated_checkout_funnel', 'guest_checkout_funnel', 'guest_verified_payment_conversion', 'order_portal_delivery_success', 'oxy_claim_funnel', 'saved_intent_return_rate', 'source_coverage_gap', 'query_latency_and_freshness', 'merchant_claim_funnel', 'native_gmv', 'marketplace_revenue', 'affiliate_commission', 'guest_post_purchase_demand', 'guest_eligibility_coverage')),
	CONSTRAINT "analytics_experiments_guardrails_check" CHECK ("analytics_experiments"."guardrail_metric_keys" <@ array['search_success_rate', 'zero_result_rate', 'duplicate_product_rate', 'search_to_product_click_rate', 'product_to_offer_selection_rate', 'external_click_through_rate', 'native_add_to_cart_rate', 'native_checkout_conversion', 'authenticated_checkout_funnel', 'guest_checkout_funnel', 'guest_verified_payment_conversion', 'order_portal_delivery_success', 'oxy_claim_funnel', 'saved_intent_return_rate', 'source_coverage_gap', 'query_latency_and_freshness', 'merchant_claim_funnel', 'native_gmv', 'marketplace_revenue', 'affiliate_commission', 'guest_post_purchase_demand', 'guest_eligibility_coverage']::text[]),
	CONSTRAINT "analytics_experiments_stop_conditions_check" CHECK ("analytics_experiments"."stop_conditions" <@ array['trust_regression', 'duplicate_rate_regression', 'stale_offer_regression', 'payment_failure_regression', 'portal_access_regression', 'fraud_regression', 'refund_regression', 'support_volume_regression', 'error_rate_regression', 'sample_size_reached', 'operator_stopped']::text[]),
	CONSTRAINT "analytics_experiments_stop_reason_check" CHECK ("analytics_experiments"."stop_reason" in ('trust_regression', 'duplicate_rate_regression', 'stale_offer_regression', 'payment_failure_regression', 'portal_access_regression', 'fraud_regression', 'refund_regression', 'support_volume_regression', 'error_rate_regression', 'sample_size_reached', 'operator_stopped')),
	CONSTRAINT "analytics_experiments_version_check" CHECK ("analytics_experiments"."version" >= 1 and "analytics_experiments"."traffic_allocation_bps" between 0 and 10000),
	CONSTRAINT "analytics_experiments_shape_check" CHECK (coalesce(array_length("analytics_experiments"."variants", 1), 0) >= 2
          and coalesce(array_length("analytics_experiments"."guardrail_metric_keys", 1), 0) >= 1
          and coalesce(array_length("analytics_experiments"."stop_conditions", 1), 0) >= 1),
	CONSTRAINT "analytics_experiments_stopped_check" CHECK (("analytics_experiments"."status" in ('stopped', 'completed')) = ("analytics_experiments"."stopped_at" is not null)
          and ("analytics_experiments"."stop_reason" is null or "analytics_experiments"."stopped_at" is not null)),
	CONSTRAINT "analytics_experiments_activated_check" CHECK (("analytics_experiments"."status" = 'draft') = ("analytics_experiments"."activated_at" is null))
);
--> statement-breakpoint
CREATE TABLE "analytics_pseudonym_salts" (
	"id" text PRIMARY KEY NOT NULL,
	"epoch" integer NOT NULL,
	"salt" text NOT NULL,
	"active_from" timestamp with time zone NOT NULL,
	"active_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "analytics_pseudonym_salts_epoch_check" CHECK ("analytics_pseudonym_salts"."epoch" >= 1),
	CONSTRAINT "analytics_pseudonym_salts_window_check" CHECK ("analytics_pseudonym_salts"."active_until" is null or "analytics_pseudonym_salts"."active_until" > "analytics_pseudonym_salts"."active_from")
);
--> statement-breakpoint
CREATE TABLE "analytics_query_aggregates" (
	"id" text PRIMARY KEY NOT NULL,
	"bucket_date" date NOT NULL,
	"market" text NOT NULL,
	"normalized_query" text NOT NULL,
	"occurrences" integer DEFAULT 0 NOT NULL,
	"zero_result_occurrences" integer DEFAULT 0 NOT NULL,
	"click_occurrences" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "analytics_query_aggregates_counts_check" CHECK ("analytics_query_aggregates"."occurrences" >= 0
          and "analytics_query_aggregates"."zero_result_occurrences" >= 0
          and "analytics_query_aggregates"."click_occurrences" >= 0
          and "analytics_query_aggregates"."zero_result_occurrences" <= "analytics_query_aggregates"."occurrences"),
	CONSTRAINT "analytics_query_aggregates_market_check" CHECK ("analytics_query_aggregates"."market" = '' or "analytics_query_aggregates"."market" ~ '^[A-Z]{2}$')
);
--> statement-breakpoint
CREATE TABLE "analytics_rollup_cursors" (
	"id" text PRIMARY KEY NOT NULL,
	"last_completed_date" date,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"last_run_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "analytics_rollup_cursors_lease_check" CHECK (num_nonnulls("analytics_rollup_cursors"."lease_owner", "analytics_rollup_cursors"."lease_expires_at") in (0, 2))
);
--> statement-breakpoint
CREATE TABLE "analytics_rollups" (
	"id" text PRIMARY KEY NOT NULL,
	"metric_key" text NOT NULL,
	"bucket_date" date NOT NULL,
	"market" text NOT NULL,
	"client_surface" text NOT NULL,
	"actor_kind" text NOT NULL,
	"buyer_origin" text NOT NULL,
	"store_id" text NOT NULL,
	"merchant_id" text NOT NULL,
	"numerator" integer DEFAULT 0 NOT NULL,
	"denominator" integer DEFAULT 0 NOT NULL,
	"source" text NOT NULL,
	"computed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "analytics_rollups_metric_key_check" CHECK ("analytics_rollups"."metric_key" in ('search_success_rate', 'zero_result_rate', 'duplicate_product_rate', 'search_to_product_click_rate', 'product_to_offer_selection_rate', 'external_click_through_rate', 'native_add_to_cart_rate', 'native_checkout_conversion', 'authenticated_checkout_funnel', 'guest_checkout_funnel', 'guest_verified_payment_conversion', 'order_portal_delivery_success', 'oxy_claim_funnel', 'saved_intent_return_rate', 'source_coverage_gap', 'query_latency_and_freshness', 'merchant_claim_funnel', 'native_gmv', 'marketplace_revenue', 'affiliate_commission', 'guest_post_purchase_demand', 'guest_eligibility_coverage')),
	CONSTRAINT "analytics_rollups_source_check" CHECK ("analytics_rollups"."source" in ('analytics_events', 'analytics_search_queries', 'payments', 'orders', 'refunds', 'affiliate_reports')),
	CONSTRAINT "analytics_rollups_counts_check" CHECK ("analytics_rollups"."numerator" >= 0 and "analytics_rollups"."denominator" >= 0)
);
--> statement-breakpoint
CREATE TABLE "analytics_search_queries" (
	"id" text PRIMARY KEY NOT NULL,
	"query_event_id" text NOT NULL,
	"redacted_text" text,
	"redaction_kinds" text[] DEFAULT '{}'::text[] NOT NULL,
	"normalized_tokens" text[] DEFAULT '{}'::text[] NOT NULL,
	"result_count" integer NOT NULL,
	"duplicate_result_count" integer DEFAULT 0 NOT NULL,
	"latency_ms" integer NOT NULL,
	"market" text,
	"category_id" text,
	"search_policy_version" text,
	"ranking_policy_version" text,
	"traffic_class" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"text_expires_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "analytics_search_queries_traffic_class_check" CHECK ("analytics_search_queries"."traffic_class" in ('human', 'internal', 'crawler', 'link_preview', 'email_scanner', 'automated_client', 'unknown')),
	CONSTRAINT "analytics_search_queries_redaction_kinds_check" CHECK ("analytics_search_queries"."redaction_kinds" <@ array['email', 'phone', 'postal_address', 'payment_card', 'iban', 'secret_token', 'long_digit_run', 'url_with_credentials', 'oversized']::text[]),
	CONSTRAINT "analytics_search_queries_counts_check" CHECK ("analytics_search_queries"."result_count" >= 0
          and "analytics_search_queries"."duplicate_result_count" >= 0
          and "analytics_search_queries"."duplicate_result_count" <= "analytics_search_queries"."result_count"
          and "analytics_search_queries"."latency_ms" >= 0),
	CONSTRAINT "analytics_search_queries_market_check" CHECK ("analytics_search_queries"."market" is null or "analytics_search_queries"."market" ~ '^[A-Z]{2}$'),
	CONSTRAINT "analytics_search_queries_retention_order_check" CHECK ("analytics_search_queries"."text_expires_at" <= "analytics_search_queries"."expires_at")
);
--> statement-breakpoint
CREATE INDEX "analytics_events_type_occurred_at_idx" ON "analytics_events" USING btree ("event_type","occurred_at");--> statement-breakpoint
CREATE INDEX "analytics_events_query_event_id_idx" ON "analytics_events" USING btree ("query_event_id","occurred_at") WHERE "analytics_events"."query_event_id" is not null;--> statement-breakpoint
CREATE INDEX "analytics_events_checkout_group_id_idx" ON "analytics_events" USING btree ("checkout_group_id") WHERE "analytics_events"."checkout_group_id" is not null;--> statement-breakpoint
CREATE INDEX "analytics_events_store_id_idx" ON "analytics_events" USING btree ("store_id","occurred_at") WHERE "analytics_events"."store_id" is not null;--> statement-breakpoint
CREATE INDEX "analytics_events_merchant_id_idx" ON "analytics_events" USING btree ("merchant_id","occurred_at") WHERE "analytics_events"."merchant_id" is not null;--> statement-breakpoint
CREATE INDEX "analytics_events_expires_at_idx" ON "analytics_events" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "analytics_experiment_exposures_unit_key" ON "analytics_experiment_exposures" USING btree ("experiment_key","experiment_version","assignment_unit_ref");--> statement-breakpoint
CREATE INDEX "analytics_experiment_exposures_experiment_idx" ON "analytics_experiment_exposures" USING btree ("experiment_key","experiment_version","first_exposed_at");--> statement-breakpoint
CREATE INDEX "analytics_experiment_exposures_expires_at_idx" ON "analytics_experiment_exposures" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "analytics_experiments_key_version_key" ON "analytics_experiments" USING btree ("experiment_key","version");--> statement-breakpoint
CREATE UNIQUE INDEX "analytics_experiments_active_key" ON "analytics_experiments" USING btree ("experiment_key") WHERE "analytics_experiments"."status" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "analytics_pseudonym_salts_epoch_key" ON "analytics_pseudonym_salts" USING btree ("epoch");--> statement-breakpoint
CREATE UNIQUE INDEX "analytics_pseudonym_salts_current_key" ON "analytics_pseudonym_salts" USING btree ("active_until") WHERE "analytics_pseudonym_salts"."active_until" is null;--> statement-breakpoint
CREATE INDEX "analytics_pseudonym_salts_expires_at_idx" ON "analytics_pseudonym_salts" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "analytics_query_aggregates_bucket_key" ON "analytics_query_aggregates" USING btree ("bucket_date","market","normalized_query");--> statement-breakpoint
CREATE INDEX "analytics_query_aggregates_report_idx" ON "analytics_query_aggregates" USING btree ("bucket_date","market","occurrences");--> statement-breakpoint
CREATE INDEX "analytics_query_aggregates_expires_at_idx" ON "analytics_query_aggregates" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "analytics_rollups_bucket_key" ON "analytics_rollups" USING btree ("metric_key","bucket_date","market","client_surface","actor_kind","buyer_origin","store_id","merchant_id");--> statement-breakpoint
CREATE INDEX "analytics_rollups_metric_bucket_idx" ON "analytics_rollups" USING btree ("metric_key","bucket_date");--> statement-breakpoint
CREATE INDEX "analytics_rollups_store_idx" ON "analytics_rollups" USING btree ("store_id","metric_key","bucket_date") WHERE "analytics_rollups"."store_id" <> '';--> statement-breakpoint
CREATE INDEX "analytics_rollups_expires_at_idx" ON "analytics_rollups" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "analytics_search_queries_query_event_id_key" ON "analytics_search_queries" USING btree ("query_event_id");--> statement-breakpoint
CREATE INDEX "analytics_search_queries_text_expires_at_idx" ON "analytics_search_queries" USING btree ("text_expires_at");--> statement-breakpoint
CREATE INDEX "analytics_search_queries_expires_at_idx" ON "analytics_search_queries" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "analytics_search_queries_created_at_idx" ON "analytics_search_queries" USING btree ("created_at");
--> statement-breakpoint
-- drizzle-kit does not model triggers. Ship the immutability contract with the
-- table so no interval exists in which a RUNNING experiment's declaration can
-- be edited.
--
-- This is the `fee_schedules_immutable_once_active` precedent, and the reason it
-- matters here is the same one: an experiment whose hypothesis, primary metric,
-- guardrails, arms, allocation or assignment salt can change while it runs is an
-- experiment whose result cannot be trusted -- and, unlike a fee schedule, the
-- edit that would do it looks entirely innocent ("we widened the rollout").
-- Editing the SALT is the sharpest case: it silently re-buckets every unit
-- mid-flight, so the same person is control on Monday and treatment on Tuesday,
-- and nothing in the data says so.
--
-- Exactly three transitions are permitted after `draft`, and each is a decision
-- rather than an edit: draft -> active, active -> stopped, active -> completed.
CREATE FUNCTION mercaria_analytics_experiment_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN
      RAISE EXCEPTION
        'experiment %.% is %, not draft: a version that has run is never deleted. Stop it, or publish a new version.',
        OLD.experiment_key, OLD.version, OLD.status
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.status <> 'draft' AND (
    NEW.experiment_key IS DISTINCT FROM OLD.experiment_key OR
    NEW.version IS DISTINCT FROM OLD.version OR
    NEW.treatment_kind IS DISTINCT FROM OLD.treatment_kind OR
    NEW.hypothesis IS DISTINCT FROM OLD.hypothesis OR
    NEW.primary_metric_key IS DISTINCT FROM OLD.primary_metric_key OR
    NEW.guardrail_metric_keys IS DISTINCT FROM OLD.guardrail_metric_keys OR
    NEW.stop_conditions IS DISTINCT FROM OLD.stop_conditions OR
    NEW.assignment_unit IS DISTINCT FROM OLD.assignment_unit OR
    NEW.assignment_salt IS DISTINCT FROM OLD.assignment_salt OR
    NEW.variants IS DISTINCT FROM OLD.variants OR
    NEW.traffic_allocation_bps IS DISTINCT FROM OLD.traffic_allocation_bps OR
    NEW.ranking_policy_version IS DISTINCT FROM OLD.ranking_policy_version OR
    NEW.activated_at IS DISTINCT FROM OLD.activated_at OR
    NEW.created_at IS DISTINCT FROM OLD.created_at
  ) THEN
    RAISE EXCEPTION
      'experiment %.% is %, not draft: its declaration is immutable. Publish a new version instead of editing this one.',
      OLD.experiment_key, OLD.version, OLD.status
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER analytics_experiments_immutable_once_active
  BEFORE UPDATE OR DELETE ON "analytics_experiments"
  FOR EACH ROW EXECUTE FUNCTION mercaria_analytics_experiment_immutable();--> statement-breakpoint
-- `analytics_events` is APPEND-ONLY, and this trigger is the whole of #77
-- identity rule 5's "a completed claim cannot retroactively absorb unrelated
-- guest activity".
--
-- The service layer already has no update path -- `db/analytics/eventRepository.ts`
-- exports an insert and two reads -- but "there is no function for it" is a
-- property of today's code, and the rule has to survive whoever adds one. With
-- this trigger, a stored event's actor, its buyer origin and its checkout
-- correlation cannot be rewritten by ANY statement from ANY caller, including a
-- migration, including psql. Retention still works: the sweep DELETEs, which the
-- trigger permits deliberately -- erasure on schedule is the policy, and it is
-- the one operation that must never be blocked.
CREATE FUNCTION mercaria_analytics_event_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'analytics events are append-only: UPDATE on %.% is refused. An event records what was observed; a later claim, sign-in or correction never rewrites it (#77 identity rules 5 and 7).',
    TG_TABLE_SCHEMA, TG_TABLE_NAME
    USING ERRCODE = 'check_violation';
END;
$$;--> statement-breakpoint
CREATE TRIGGER analytics_events_append_only
  BEFORE UPDATE ON "analytics_events"
  FOR EACH ROW EXECUTE FUNCTION mercaria_analytics_event_append_only();
