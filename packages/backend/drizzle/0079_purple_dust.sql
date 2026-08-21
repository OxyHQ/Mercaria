-- oxy:deploy-phase=pre
-- oxy:rollback=restore: notifications_type_check plus the three catalog_merge_jobs_phase_check siblings are widened; the previous forms are in 0020 and 0055, and re-adding any of them fails against a stored notification or job using the added vocabulary
--
-- Saved shopping-agent jobs (#97).
--
-- Additive throughout: eight new tables, plus FOUR CHECK WIDENINGS. `agents`
-- joins `CATALOG_MERGE_PHASES` and `CATALOG_SPLIT_PHASES`, so
-- `catalog_merge_jobs.phase`, `catalog_merge_job_phases.phase` and
-- `catalog_split_jobs.phase` each get their CHECK dropped and re-added over a
-- strict SUPERSET; `shopping_agent_finding` joins `NOTIFICATION_TYPES` the same
-- way.
--
-- ## Why `pre`
--
-- The real question, not its paraphrase: does any statement here break a write
-- the CURRENTLY SERVING image performs? It does not. Every `CREATE TABLE`
-- targets a table that image has never heard of, so there is no write to break.
-- The four re-added CHECKs admit every value the old ones did and one more, so
-- every row the serving image can write still satisfies them -- and that image
-- cannot write `agents` or `shopping_agent_finding`, because neither is in the
-- tuples it was compiled against. The drop-and-re-add is invisible to it in
-- both directions.
--
-- The four re-added value lists were compared ELEMENT BY ELEMENT against the
-- live tuples after each regeneration on a rebase (behind #93, #85 and #143):
-- a `dist/` predating the branch you rebased onto emits a NARROWING that looks
-- entirely plausible, and `build:shared-types` before `db:generate` is what
-- stops it.
--
-- HAND-WRITTEN STATEMENTS BELOW THE GENERATED BLOCK. `drizzle-kit generate`
-- emits no triggers, so a REGENERATION DROPS ALL FOUR plus their three
-- functions. They are anchored at the end of this file under the marker
-- comment; after regenerating, re-append the block and confirm with:
--
--   grep -c '^CREATE TRIGGER' packages/backend/drizzle/0079_purple_dust.sql   -> 4
--   grep -c '^CREATE FUNCTION' packages/backend/drizzle/0079_purple_dust.sql  -> 3
--   grep -c '^-- oxy:deploy-phase' packages/backend/drizzle/0079_purple_dust.sql -> 1
--
CREATE TABLE "shopping_agent_audits" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"action" text NOT NULL,
	"actor" text NOT NULL,
	"actor_oxy_user_id" text,
	"agent_revision" integer NOT NULL,
	"detail" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "shopping_agent_audits_action_check" CHECK ("shopping_agent_audits"."action" in ('created', 'authorization_recorded', 'constraints_edited', 'scope_edited', 'policy_edited', 'paused', 'resumed', 'completed', 'deleted', 'manual_run_requested', 'blocked_by_split', 'split_resolved', 'rehomed_by_merge', 'migrated_by_policy_upgrade')),
	CONSTRAINT "shopping_agent_audits_actor_check" CHECK ("shopping_agent_audits"."actor" in ('owner', 'system')),
	CONSTRAINT "shopping_agent_audits_revision_check" CHECK ("shopping_agent_audits"."agent_revision" >= 1),
	CONSTRAINT "shopping_agent_audits_detail_check" CHECK ("shopping_agent_audits"."detail" is null or length("shopping_agent_audits"."detail") <= 200),
	CONSTRAINT "shopping_agent_audits_actor_shape_check" CHECK (("shopping_agent_audits"."actor" = 'owner') = ("shopping_agent_audits"."actor_oxy_user_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "shopping_agent_evaluations" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"trigger_source" text DEFAULT 'offer_change' NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"requested_revision" integer DEFAULT 1 NOT NULL,
	"claimed_revision" integer,
	"attempts" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone NOT NULL,
	"lease_owner" text,
	"lease_until" timestamp with time zone,
	"last_failure" text,
	"last_evaluated_at" timestamp with time zone,
	"last_outcome" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "shopping_agent_evaluations_state_check" CHECK ("shopping_agent_evaluations"."state" in ('pending', 'processing', 'done', 'dead_letter')),
	CONSTRAINT "shopping_agent_evaluations_trigger_source_check" CHECK ("shopping_agent_evaluations"."trigger_source" in ('offer_change', 'scheduled', 'manual')),
	CONSTRAINT "shopping_agent_evaluations_outcome_check" CHECK ("shopping_agent_evaluations"."last_outcome" in ('qualified', 'not_qualified', 'incomplete')),
	CONSTRAINT "shopping_agent_evaluations_attempts_check" CHECK ("shopping_agent_evaluations"."attempts" >= 0),
	CONSTRAINT "shopping_agent_evaluations_revision_check" CHECK ("shopping_agent_evaluations"."requested_revision" >= 1),
	CONSTRAINT "shopping_agent_evaluations_claimed_revision_check" CHECK ("shopping_agent_evaluations"."claimed_revision" is null or "shopping_agent_evaluations"."claimed_revision" <= "shopping_agent_evaluations"."requested_revision")
);
--> statement-breakpoint
CREATE TABLE "shopping_agent_finding_lines" (
	"id" text PRIMARY KEY NOT NULL,
	"finding_id" text NOT NULL,
	"line_id" text NOT NULL,
	"canonical_product_id" text NOT NULL,
	"offer_ref" text NOT NULL,
	"quantity" integer NOT NULL,
	"unit_item_price_amount" bigint,
	"unit_item_price_currency" text,
	"condition_group" text,
	"native_checkout_eligible" boolean NOT NULL,
	"official_channel" boolean NOT NULL,
	"position" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "shopping_agent_finding_lines_unit_item_price_currency_check" CHECK ("shopping_agent_finding_lines"."unit_item_price_currency" in ('FAIR', 'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF', 'CNY', 'SEK', 'NOK', 'DKK', 'PLN', 'MXN', 'BRL', 'INR', 'NZD', 'ZAR', 'SGD', 'HKD', 'AED')),
	CONSTRAINT "shopping_agent_finding_lines_condition_group_check" CHECK ("shopping_agent_finding_lines"."condition_group" in ('new', 'open_box', 'refurbished', 'used', 'for_parts')),
	CONSTRAINT "shopping_agent_finding_lines_quantity_check" CHECK ("shopping_agent_finding_lines"."quantity" >= 1),
	CONSTRAINT "shopping_agent_finding_lines_position_check" CHECK ("shopping_agent_finding_lines"."position" >= 0)
);
--> statement-breakpoint
CREATE TABLE "shopping_agent_findings" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"evaluation_key" text NOT NULL,
	"agent_revision" integer NOT NULL,
	"trigger_source" text NOT NULL,
	"triggered_at" timestamp with time zone NOT NULL,
	"evaluated_at" timestamp with time zone NOT NULL,
	"outcome" text NOT NULL,
	"incomplete_reasons" text[] DEFAULT '{}'::text[] NOT NULL,
	"completeness" text NOT NULL,
	"freshness" text NOT NULL,
	"optimality" text,
	"lifecycle" text DEFAULT 'current' NOT NULL,
	"input_digest" text NOT NULL,
	"agent_policy_version" text NOT NULL,
	"constraint_evaluation_version" text NOT NULL,
	"normalization_rule_version" text NOT NULL,
	"comparison_policy_version" text NOT NULL,
	"ranking_policy_version" text NOT NULL,
	"satisfied_constraint_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"failed_constraint_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"unknown_constraint_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"objective_amount" bigint,
	"objective_currency" text,
	"objective_delta_amount" bigint,
	"record_refs" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "shopping_agent_findings_objective_currency_check" CHECK ("shopping_agent_findings"."objective_currency" in ('FAIR', 'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF', 'CNY', 'SEK', 'NOK', 'DKK', 'PLN', 'MXN', 'BRL', 'INR', 'NZD', 'ZAR', 'SGD', 'HKD', 'AED')),
	CONSTRAINT "shopping_agent_findings_outcome_check" CHECK ("shopping_agent_findings"."outcome" in ('qualified', 'not_qualified', 'incomplete')),
	CONSTRAINT "shopping_agent_findings_trigger_source_check" CHECK ("shopping_agent_findings"."trigger_source" in ('offer_change', 'scheduled', 'manual')),
	CONSTRAINT "shopping_agent_findings_completeness_check" CHECK ("shopping_agent_findings"."completeness" in ('complete', 'partial')),
	CONSTRAINT "shopping_agent_findings_freshness_check" CHECK ("shopping_agent_findings"."freshness" in ('current', 'ageing', 'unknown')),
	CONSTRAINT "shopping_agent_findings_optimality_check" CHECK ("shopping_agent_findings"."optimality" in ('proven_optimal', 'approximate')),
	CONSTRAINT "shopping_agent_findings_lifecycle_check" CHECK ("shopping_agent_findings"."lifecycle" in ('current', 'superseded', 'invalidated')),
	CONSTRAINT "shopping_agent_findings_incomplete_reasons_check" CHECK ("shopping_agent_findings"."incomplete_reasons" <@ array['offer_comparison_unavailable', 'no_eligible_offer', 'price_not_convertible', 'delivery_cost_unknown', 'basket_partially_covered', 'constraint_set_invalid', 'constraint_facts_unavailable', 'agent_ambiguous_after_split', 'no_comparable_prior_finding', 'catalogue_discovery_unavailable']::text[]),
	CONSTRAINT "shopping_agent_findings_revision_check" CHECK ("shopping_agent_findings"."agent_revision" >= 1),
	CONSTRAINT "shopping_agent_findings_digest_check" CHECK (length("shopping_agent_findings"."input_digest") >= 8),
	CONSTRAINT "shopping_agent_findings_incomplete_shape_check" CHECK (("shopping_agent_findings"."outcome" = 'incomplete') = (cardinality("shopping_agent_findings"."incomplete_reasons") >= 1)),
	CONSTRAINT "shopping_agent_findings_objective_shape_check" CHECK ("shopping_agent_findings"."outcome" = 'qualified' or "shopping_agent_findings"."objective_amount" is null),
	CONSTRAINT "shopping_agent_findings_delta_shape_check" CHECK ("shopping_agent_findings"."objective_delta_amount" is null or "shopping_agent_findings"."objective_amount" is not null),
	CONSTRAINT "shopping_agent_findings_evidence_shape_check" CHECK ("shopping_agent_findings"."outcome" <> 'incomplete' or "shopping_agent_findings"."completeness" = 'partial')
);
--> statement-breakpoint
CREATE TABLE "shopping_agent_lines" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"canonical_product_id" text NOT NULL,
	"canonical_variant_id" text,
	"quantity" integer DEFAULT 1 NOT NULL,
	"condition_groups" text[] DEFAULT '{}'::text[] NOT NULL,
	"merchant_id" text,
	"position" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "shopping_agent_lines_condition_groups_check" CHECK ("shopping_agent_lines"."condition_groups" <@ array['new', 'open_box', 'refurbished', 'used', 'for_parts']::text[]),
	CONSTRAINT "shopping_agent_lines_quantity_check" CHECK ("shopping_agent_lines"."quantity" >= 1),
	CONSTRAINT "shopping_agent_lines_position_check" CHECK ("shopping_agent_lines"."position" >= 0)
);
--> statement-breakpoint
CREATE TABLE "shopping_agent_notifications" (
	"id" text PRIMARY KEY NOT NULL,
	"finding_id" text NOT NULL,
	"agent_id" text NOT NULL,
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
	CONSTRAINT "shopping_agent_notifications_channel_check" CHECK ("shopping_agent_notifications"."channel" in ('oxy_notification', 'email')),
	CONSTRAINT "shopping_agent_notifications_state_check" CHECK ("shopping_agent_notifications"."state" in ('queued', 'delivering', 'delivered', 'failed', 'suppressed', 'dead_letter')),
	CONSTRAINT "shopping_agent_notifications_suppression_reason_check" CHECK ("shopping_agent_notifications"."suppression_reason" in ('cooldown_active', 'not_materially_better', 'agent_not_enabled', 'agent_deleted', 'finding_superseded', 'destination_no_longer_eligible', 'channel_unavailable')),
	CONSTRAINT "shopping_agent_notifications_failure_reason_check" CHECK ("shopping_agent_notifications"."failure_reason" in ('transport_unconfigured', 'transport_rejected', 'transport_unavailable', 'finding_unreadable', 'unexpected_error')),
	CONSTRAINT "shopping_agent_notifications_attempts_check" CHECK ("shopping_agent_notifications"."attempts" >= 0),
	CONSTRAINT "shopping_agent_notifications_delivered_at_check" CHECK (("shopping_agent_notifications"."state" = 'delivered') = ("shopping_agent_notifications"."delivered_at" is not null)),
	CONSTRAINT "shopping_agent_notifications_suppression_check" CHECK (("shopping_agent_notifications"."state" = 'suppressed') = ("shopping_agent_notifications"."suppression_reason" is not null)),
	CONSTRAINT "shopping_agent_notifications_notification_id_check" CHECK ("shopping_agent_notifications"."notification_id" is null or "shopping_agent_notifications"."state" = 'delivered')
);
--> statement-breakpoint
CREATE TABLE "shopping_agent_triggers" (
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
	"last_fanned_out_at" timestamp with time zone,
	"last_fanned_out_agents" integer,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "shopping_agent_triggers_state_check" CHECK ("shopping_agent_triggers"."state" in ('pending', 'processing', 'done', 'dead_letter')),
	CONSTRAINT "shopping_agent_triggers_attempts_check" CHECK ("shopping_agent_triggers"."attempts" >= 0),
	CONSTRAINT "shopping_agent_triggers_revision_check" CHECK ("shopping_agent_triggers"."requested_revision" >= 1),
	CONSTRAINT "shopping_agent_triggers_claimed_revision_check" CHECK ("shopping_agent_triggers"."claimed_revision" is null or "shopping_agent_triggers"."claimed_revision" <= "shopping_agent_triggers"."requested_revision"),
	CONSTRAINT "shopping_agent_triggers_counter_check" CHECK ("shopping_agent_triggers"."last_fanned_out_agents" is null or "shopping_agent_triggers"."last_fanned_out_agents" >= 0)
);
--> statement-breakpoint
CREATE TABLE "shopping_agents" (
	"id" text PRIMARY KEY NOT NULL,
	"oxy_user_id" text NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"state" text DEFAULT 'enabled' NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"display_currency" text NOT NULL,
	"price_basis" text DEFAULT 'item_price' NOT NULL,
	"channel_policy" text DEFAULT 'mixed' NOT NULL,
	"market" text,
	"condition_groups" text[] DEFAULT '{}'::text[] NOT NULL,
	"excluded_merchant_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"target_amount" bigint,
	"target_currency" text,
	"constraint_set" jsonb NOT NULL,
	"constraint_digest" text NOT NULL,
	"trigger_sources" text[] NOT NULL,
	"schedule_interval_seconds" integer,
	"next_scheduled_at" timestamp with time zone,
	"notification_channels" text[] NOT NULL,
	"cooldown_seconds" integer NOT NULL,
	"quiet_hours_start_minute" integer,
	"quiet_hours_end_minute" integer,
	"quiet_hours_time_zone" text,
	"locale" text,
	"ambiguity_state" text DEFAULT 'resolved' NOT NULL,
	"split_job_id" text,
	"split_target_canonical_product_id" text,
	"rehomed_from_canonical_product_id" text,
	"rehomed_at" timestamp with time zone,
	"authorized_at" timestamp with time zone NOT NULL,
	"terms_version" text NOT NULL,
	"agent_policy_version" text NOT NULL,
	"constraint_evaluation_version" text NOT NULL,
	"normalization_rule_version" text NOT NULL,
	"comparison_policy_version" text NOT NULL,
	"parser_version" text,
	"last_evaluated_at" timestamp with time zone,
	"last_notified_at" timestamp with time zone,
	"last_notified_amount" bigint,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "shopping_agents_display_currency_check" CHECK ("shopping_agents"."display_currency" in ('FAIR', 'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF', 'CNY', 'SEK', 'NOK', 'DKK', 'PLN', 'MXN', 'BRL', 'INR', 'NZD', 'ZAR', 'SGD', 'HKD', 'AED')),
	CONSTRAINT "shopping_agents_target_currency_check" CHECK ("shopping_agents"."target_currency" in ('FAIR', 'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF', 'CNY', 'SEK', 'NOK', 'DKK', 'PLN', 'MXN', 'BRL', 'INR', 'NZD', 'ZAR', 'SGD', 'HKD', 'AED')),
	CONSTRAINT "shopping_agents_kind_check" CHECK ("shopping_agents"."kind" in ('offer_price_threshold', 'used_or_refurbished_appearance', 'official_channel_availability', 'basket_target_total', 'materially_better_plan', 'constraint_satisfiable')),
	CONSTRAINT "shopping_agents_state_check" CHECK ("shopping_agents"."state" in ('enabled', 'paused', 'blocked', 'completed', 'deleted')),
	CONSTRAINT "shopping_agents_price_basis_check" CHECK ("shopping_agents"."price_basis" in ('item_price', 'delivered_total')),
	CONSTRAINT "shopping_agents_channel_policy_check" CHECK ("shopping_agents"."channel_policy" in ('native_only', 'external_only', 'official_only', 'mixed')),
	CONSTRAINT "shopping_agents_ambiguity_state_check" CHECK ("shopping_agents"."ambiguity_state" in ('resolved', 'ambiguous_after_split')),
	CONSTRAINT "shopping_agents_condition_groups_check" CHECK ("shopping_agents"."condition_groups" <@ array['new', 'open_box', 'refurbished', 'used', 'for_parts']::text[]),
	CONSTRAINT "shopping_agents_trigger_sources_check" CHECK ("shopping_agents"."trigger_sources" <@ array['offer_change', 'scheduled', 'manual']::text[]),
	CONSTRAINT "shopping_agents_notification_channels_check" CHECK ("shopping_agents"."notification_channels" <@ array['oxy_notification', 'email']::text[]),
	CONSTRAINT "shopping_agents_trigger_sources_present_check" CHECK (cardinality("shopping_agents"."trigger_sources") >= 1),
	CONSTRAINT "shopping_agents_notification_channels_present_check" CHECK (cardinality("shopping_agents"."notification_channels") >= 1),
	CONSTRAINT "shopping_agents_market_check" CHECK ("shopping_agents"."market" ~ '^[A-Z]{2}$'),
	CONSTRAINT "shopping_agents_revision_check" CHECK ("shopping_agents"."revision" >= 1),
	CONSTRAINT "shopping_agents_name_check" CHECK (length(btrim("shopping_agents"."name")) between 1 and 120),
	CONSTRAINT "shopping_agents_description_check" CHECK ("shopping_agents"."description" is null or length("shopping_agents"."description") <= 500),
	CONSTRAINT "shopping_agents_cooldown_check" CHECK ("shopping_agents"."cooldown_seconds" > 0),
	CONSTRAINT "shopping_agents_target_shape_check" CHECK (("shopping_agents"."kind" in ('offer_price_threshold', 'basket_target_total'))
            = ("shopping_agents"."target_amount" is not null)),
	CONSTRAINT "shopping_agents_target_amount_check" CHECK ("shopping_agents"."target_amount" is null or "shopping_agents"."target_amount" > 0),
	CONSTRAINT "shopping_agents_schedule_shape_check" CHECK (('scheduled' = any("shopping_agents"."trigger_sources")) = ("shopping_agents"."schedule_interval_seconds" is not null)),
	CONSTRAINT "shopping_agents_schedule_interval_check" CHECK ("shopping_agents"."schedule_interval_seconds" is null or "shopping_agents"."schedule_interval_seconds" >= 900),
	CONSTRAINT "shopping_agents_quiet_hours_shape_check" CHECK (("shopping_agents"."quiet_hours_start_minute" is null) = ("shopping_agents"."quiet_hours_end_minute" is null)
          and ("shopping_agents"."quiet_hours_start_minute" is null) = ("shopping_agents"."quiet_hours_time_zone" is null)),
	CONSTRAINT "shopping_agents_quiet_hours_range_check" CHECK (("shopping_agents"."quiet_hours_start_minute" is null
             or ("shopping_agents"."quiet_hours_start_minute" >= 0
                 and "shopping_agents"."quiet_hours_start_minute" < 1440))
          and ("shopping_agents"."quiet_hours_end_minute" is null
             or ("shopping_agents"."quiet_hours_end_minute" >= 0
                 and "shopping_agents"."quiet_hours_end_minute" < 1440))),
	CONSTRAINT "shopping_agents_ambiguity_shape_check" CHECK (("shopping_agents"."ambiguity_state" = 'ambiguous_after_split') = ("shopping_agents"."split_job_id" is not null)),
	CONSTRAINT "shopping_agents_ambiguity_blocked_check" CHECK ("shopping_agents"."ambiguity_state" <> 'ambiguous_after_split' or "shopping_agents"."state" = 'blocked'),
	CONSTRAINT "shopping_agents_rehomed_shape_check" CHECK (("shopping_agents"."rehomed_from_canonical_product_id" is null) = ("shopping_agents"."rehomed_at" is null)),
	CONSTRAINT "shopping_agents_last_notified_shape_check" CHECK ("shopping_agents"."last_notified_amount" is null or "shopping_agents"."last_notified_at" is not null)
);
--> statement-breakpoint
ALTER TABLE "notifications" DROP CONSTRAINT "notifications_type_check";--> statement-breakpoint
ALTER TABLE "catalog_merge_job_phases" DROP CONSTRAINT "catalog_merge_job_phases_phase_check";--> statement-breakpoint
ALTER TABLE "catalog_merge_jobs" DROP CONSTRAINT "catalog_merge_jobs_phase_check";--> statement-breakpoint
ALTER TABLE "catalog_split_jobs" DROP CONSTRAINT "catalog_split_jobs_phase_check";--> statement-breakpoint
ALTER TABLE "shopping_agent_audits" ADD CONSTRAINT "shopping_agent_audits_agent_id_shopping_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."shopping_agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shopping_agent_evaluations" ADD CONSTRAINT "shopping_agent_evaluations_agent_id_shopping_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."shopping_agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shopping_agent_finding_lines" ADD CONSTRAINT "shopping_agent_finding_lines_finding_id_shopping_agent_findings_id_fk" FOREIGN KEY ("finding_id") REFERENCES "public"."shopping_agent_findings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shopping_agent_finding_lines" ADD CONSTRAINT "shopping_agent_finding_lines_canonical_product_id_canonical_products_id_fk" FOREIGN KEY ("canonical_product_id") REFERENCES "public"."canonical_products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shopping_agent_findings" ADD CONSTRAINT "shopping_agent_findings_agent_id_shopping_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."shopping_agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shopping_agent_lines" ADD CONSTRAINT "shopping_agent_lines_agent_id_shopping_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."shopping_agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shopping_agent_lines" ADD CONSTRAINT "shopping_agent_lines_canonical_product_id_canonical_products_id_fk" FOREIGN KEY ("canonical_product_id") REFERENCES "public"."canonical_products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shopping_agent_lines" ADD CONSTRAINT "shopping_agent_lines_canonical_variant_id_canonical_variants_id_fk" FOREIGN KEY ("canonical_variant_id") REFERENCES "public"."canonical_variants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shopping_agent_lines" ADD CONSTRAINT "shopping_agent_lines_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shopping_agent_notifications" ADD CONSTRAINT "shopping_agent_notifications_finding_id_shopping_agent_findings_id_fk" FOREIGN KEY ("finding_id") REFERENCES "public"."shopping_agent_findings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shopping_agent_notifications" ADD CONSTRAINT "shopping_agent_notifications_agent_id_shopping_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."shopping_agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shopping_agent_notifications" ADD CONSTRAINT "shopping_agent_notifications_notification_id_notifications_id_fk" FOREIGN KEY ("notification_id") REFERENCES "public"."notifications"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shopping_agent_triggers" ADD CONSTRAINT "shopping_agent_triggers_canonical_product_id_canonical_products_id_fk" FOREIGN KEY ("canonical_product_id") REFERENCES "public"."canonical_products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shopping_agents" ADD CONSTRAINT "shopping_agents_split_job_id_catalog_split_jobs_id_fk" FOREIGN KEY ("split_job_id") REFERENCES "public"."catalog_split_jobs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shopping_agents" ADD CONSTRAINT "shopping_agents_split_target_canonical_product_id_canonical_products_id_fk" FOREIGN KEY ("split_target_canonical_product_id") REFERENCES "public"."canonical_products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "shopping_agent_audits_agent_idx" ON "shopping_agent_audits" USING btree ("agent_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "shopping_agent_evaluations_agent_key" ON "shopping_agent_evaluations" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "shopping_agent_evaluations_pending_idx" ON "shopping_agent_evaluations" USING btree ("available_at","created_at") WHERE "shopping_agent_evaluations"."state" = 'pending';--> statement-breakpoint
CREATE INDEX "shopping_agent_evaluations_reclaim_idx" ON "shopping_agent_evaluations" USING btree ("lease_until") WHERE "shopping_agent_evaluations"."state" = 'processing';--> statement-breakpoint
CREATE UNIQUE INDEX "shopping_agent_finding_lines_position_key" ON "shopping_agent_finding_lines" USING btree ("finding_id","position");--> statement-breakpoint
CREATE INDEX "shopping_agent_finding_lines_product_idx" ON "shopping_agent_finding_lines" USING btree ("canonical_product_id");--> statement-breakpoint
CREATE UNIQUE INDEX "shopping_agent_findings_identity_key" ON "shopping_agent_findings" USING btree ("agent_id","evaluation_key");--> statement-breakpoint
CREATE INDEX "shopping_agent_findings_agent_idx" ON "shopping_agent_findings" USING btree ("agent_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "shopping_agent_findings_qualified_idx" ON "shopping_agent_findings" USING btree ("agent_id","created_at" DESC NULLS LAST) WHERE "shopping_agent_findings"."outcome" = 'qualified';--> statement-breakpoint
CREATE UNIQUE INDEX "shopping_agent_lines_position_key" ON "shopping_agent_lines" USING btree ("agent_id","position");--> statement-breakpoint
CREATE INDEX "shopping_agent_lines_subject_idx" ON "shopping_agent_lines" USING btree ("canonical_product_id","agent_id");--> statement-breakpoint
CREATE INDEX "shopping_agent_notifications_pending_idx" ON "shopping_agent_notifications" USING btree ("available_at","created_at") WHERE "shopping_agent_notifications"."state" in ('queued', 'failed');--> statement-breakpoint
CREATE INDEX "shopping_agent_notifications_reclaim_idx" ON "shopping_agent_notifications" USING btree ("lease_until") WHERE "shopping_agent_notifications"."state" = 'delivering';--> statement-breakpoint
CREATE INDEX "shopping_agent_notifications_finding_idx" ON "shopping_agent_notifications" USING btree ("finding_id");--> statement-breakpoint
CREATE INDEX "shopping_agent_notifications_agent_idx" ON "shopping_agent_notifications" USING btree ("agent_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "shopping_agent_triggers_subject_key" ON "shopping_agent_triggers" USING btree ("canonical_product_id");--> statement-breakpoint
CREATE INDEX "shopping_agent_triggers_pending_idx" ON "shopping_agent_triggers" USING btree ("available_at","created_at") WHERE "shopping_agent_triggers"."state" = 'pending';--> statement-breakpoint
CREATE INDEX "shopping_agent_triggers_reclaim_idx" ON "shopping_agent_triggers" USING btree ("lease_until") WHERE "shopping_agent_triggers"."state" = 'processing';--> statement-breakpoint
CREATE INDEX "shopping_agents_owner_idx" ON "shopping_agents" USING btree ("oxy_user_id","created_at" DESC NULLS LAST) WHERE "shopping_agents"."state" <> 'deleted';--> statement-breakpoint
CREATE INDEX "shopping_agents_schedule_idx" ON "shopping_agents" USING btree ("next_scheduled_at") WHERE "shopping_agents"."state" = 'enabled' and "shopping_agents"."next_scheduled_at" is not null;--> statement-breakpoint
CREATE INDEX "shopping_agents_split_job_idx" ON "shopping_agents" USING btree ("split_job_id") WHERE "shopping_agents"."split_job_id" is not null;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_type_check" CHECK ("notifications"."type" in ('trigger_result', 'proactive_insight', 'daily_briefing', 'price_alert', 'integration_event', 'reminder', 'agent_task_complete', 'chat_response_ready', 'oxy_service', 'order_placed', 'order_paid', 'order_shipped', 'order_delivered', 'order_cancelled', 'listing_sold', 'review_received', 'store_member_invited', 'low_inventory', 'listing_changes_requested', 'merchant_claim_contested', 'merchant_claim_revoked', 'shopping_agent_finding'));--> statement-breakpoint
ALTER TABLE "catalog_merge_job_phases" ADD CONSTRAINT "catalog_merge_job_phases_phase_check" CHECK ("catalog_merge_job_phases"."phase" in ('plan', 'awaiting_resolution', 'children', 'identifiers', 'aliases', 'source_links', 'offers', 'relationships', 'reviews', 'saves', 'alerts', 'agents', 'redirects', 'rollups', 'verify', 'done'));--> statement-breakpoint
ALTER TABLE "catalog_merge_jobs" ADD CONSTRAINT "catalog_merge_jobs_phase_check" CHECK ("catalog_merge_jobs"."phase" in ('plan', 'awaiting_resolution', 'children', 'identifiers', 'aliases', 'source_links', 'offers', 'relationships', 'reviews', 'saves', 'alerts', 'agents', 'redirects', 'rollups', 'verify', 'done'));--> statement-breakpoint
ALTER TABLE "catalog_split_jobs" ADD CONSTRAINT "catalog_split_jobs_phase_check" CHECK ("catalog_split_jobs"."phase" in ('plan', 'mint', 'assignments', 'saves', 'alerts', 'agents', 'redirects', 'rollups', 'verify', 'done'));
--> statement-breakpoint
-- HAND-WRITTEN BLOCK -- re-append after any regeneration. See the file header.
--
-- (1) A finding is APPEND-ONLY against UPDATE, with exactly one exception.
--
-- The one update a finding admits is its `lifecycle` moving off `current` --
-- the supersede-or-invalidate #97 finding rule 12 asks for ("corrections
-- supersede rather than mutate history silently"). Every other column must be
-- byte-identical, and that is checked by normalising the incoming row's
-- lifecycle back to the stored one and comparing the WHOLE TUPLE: one
-- comparison, so a column added later is covered without anybody remembering to
-- extend a list. A settled finding is never re-opened, which is the first
-- branch.
--
-- DELETE is deliberately PERMITTED here and on the two tables below. That
-- inverts the ledger's posture and matches `analytics_events` and
-- `offer_price_snapshots`: erasing one account's agents is a scoped DELETE that
-- CASCADES into these tables, and a trigger refusing it would make the erasure
-- fail silently on every row it was obliged to remove.
CREATE FUNCTION mercaria_shopping_agent_finding_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  normalized shopping_agent_findings%ROWTYPE;
BEGIN
  IF OLD.lifecycle <> 'current' THEN
    RAISE EXCEPTION
      'shopping_agent_findings %: lifecycle is already %, and a settled finding is never re-opened.',
      OLD.id, OLD.lifecycle
      USING ERRCODE = 'check_violation';
  END IF;
  normalized := NEW;
  normalized.lifecycle := OLD.lifecycle;
  IF normalized IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION
      'shopping_agent_findings %: a finding is an appended observation. Only `lifecycle` may move, and only off `current`; a correction is a NEW finding.',
      OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER shopping_agent_findings_immutable
  BEFORE UPDATE ON "shopping_agent_findings"
  FOR EACH ROW EXECUTE FUNCTION mercaria_shopping_agent_finding_immutable();--> statement-breakpoint
-- (2) A finding's selected lines and the audit trail admit no update at all.
CREATE FUNCTION mercaria_shopping_agent_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'shopping-agent records are append-only: % on %.% is refused.',
    TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME
    USING ERRCODE = 'check_violation';
END;
$$;--> statement-breakpoint
CREATE TRIGGER shopping_agent_finding_lines_append_only
  BEFORE UPDATE ON "shopping_agent_finding_lines"
  FOR EACH ROW EXECUTE FUNCTION mercaria_shopping_agent_append_only();--> statement-breakpoint
CREATE TRIGGER shopping_agent_audits_append_only
  BEFORE UPDATE ON "shopping_agent_audits"
  FOR EACH ROW EXECUTE FUNCTION mercaria_shopping_agent_append_only();--> statement-breakpoint
-- (3) A notification can only ever belong to a QUALIFIED finding.
--
-- This is #97 evaluation 6 and acceptance 5 -- "missing or stale data produces
-- an incomplete result, not a positive finding" -- as the database's own answer.
-- The row-level CHECKs above already stop an `incomplete` finding carrying an
-- objective value; this stops one being TOLD, and it has to be a trigger because
-- the invariant is CROSS-ROW and a CHECK may not contain a subquery.
--
-- It fires on INSERT only. A notification's own lifecycle (delivering,
-- delivered, suppressed) legitimately updates, and re-reading the finding on
-- every attempt would put a join in the delivery loop's hot path for a fact
-- that cannot have changed: a finding's `outcome` is immutable by (1).
CREATE FUNCTION mercaria_shopping_agent_notification_requires_qualified() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  finding_outcome text;
BEGIN
  SELECT outcome INTO finding_outcome
    FROM shopping_agent_findings
   WHERE id = NEW.finding_id;
  IF finding_outcome IS DISTINCT FROM 'qualified' THEN
    RAISE EXCEPTION
      'shopping_agent_notifications %: finding % is %, and only a qualified finding may be notified.',
      NEW.id, NEW.finding_id, coalesce(finding_outcome, 'missing')
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER shopping_agent_notifications_require_qualified
  BEFORE INSERT ON "shopping_agent_notifications"
  FOR EACH ROW EXECUTE FUNCTION mercaria_shopping_agent_notification_requires_qualified();
