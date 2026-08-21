-- oxy:deploy-phase=pre
-- oxy:rollback=derived
--
-- #62 — the external CatalogSource adapter and staged ingestion framework.
--
-- Wholly ADDITIVE: five new tables, four nullable columns on `source_records`,
-- and four trigger pairs. Nothing narrows a CHECK, drops a column or renames
-- anything, so the previous image keeps serving throughout — which is what
-- makes this a single `pre` migration rather than the two-phase split #90 and
-- #94 needed.
--
-- ## The hand-written half, and where it goes on a REGENERATION
--
-- `drizzle-kit generate` cannot model a trigger, so everything below the
-- HAND-WRITTEN marker is lost if this file is regenerated after a rebase.
-- Re-append the whole block verbatim, AFTER the generated statements, then
-- count in the regenerated file: 4 plpgsql function bodies, 6 trigger
-- definitions (3 plain, 3 deferrable constraint triggers) and exactly one
-- deploy-phase marker line. Grep for each of the four function names below by
-- NAME — the counts are the check, and they are what caught a header pasted
-- from the wrong migration during this branch's second rebase.
--
-- The four functions are:
--
--   1. `mercaria_catalog_source_object_monotonic` — an older observation can
--      never overwrite a newer current fact (issue concurrency 3). The upsert
--      carries the same predicate so the ordinary path converges silently; this
--      is what makes the rule true of every OTHER path, including a repair
--      somebody writes in `psql` during the incident that made them want to.
--   2. `mercaria_catalog_source_policy_immutable` — a rights version is frozen
--      once it leaves `draft`. Withdrawing a right is a NEW version, which is
--      how issue acceptance 6 ("disable display/refresh without deleting audit
--      history") is a shape rather than a promise.
--   3. `mercaria_catalog_source_rights_agree` — a DEFERRABLE constraint trigger
--      on three tables. `catalog_sources`' three coarse rights columns are a
--      projection of `resolveSourceRights(config.status, active policy)`, and
--      this refuses any COMMIT in which they disagree. Deferred because a
--      rights change touches three tables and no statement order makes every
--      intermediate state consistent — checking at commit has no opinion about
--      the order, which is what lets it be strict about the outcome.
--   4. `mercaria_catalog_source_run_counters_monotonic` — a run's counters never
--      go DOWN. A pass is many pages adding to one row, so this is what stops a
--      re-written total hiding a page that failed (#60's trigger, ported).

CREATE TABLE "catalog_source_configs" (
	"id" text PRIMARY KEY NOT NULL,
	"source_id" text NOT NULL,
	"provider" text NOT NULL,
	"source_account_ref" text,
	"merchant_id" text,
	"storefront_id" text,
	"territories" text[] DEFAULT '{}'::text[] NOT NULL,
	"credential_ref" text,
	"fetch_cadence_seconds" integer,
	"freshness_ttl_seconds" integer DEFAULT 86400 NOT NULL,
	"rate_limit_per_minute" integer,
	"rate_limit_concurrency" integer,
	"rate_limit_min_interval_ms" integer,
	"page_size" integer DEFAULT 200 NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"status_changed_by_oxy_user_id" text,
	"status_changed_at" timestamp with time zone,
	"status_reason" text,
	"health_state" text DEFAULT 'unknown' NOT NULL,
	"health_changed_at" timestamp with time zone,
	"last_attempt_at" timestamp with time zone,
	"last_success_at" timestamp with time zone,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"last_fetch_duration_ms" integer,
	"last_rate_limit_hits" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"next_run_at" timestamp with time zone,
	"lease_owner" text,
	"lease_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "catalog_source_configs_status_check" CHECK ("catalog_source_configs"."status" in ('draft', 'active', 'paused', 'revoked', 'failed')),
	CONSTRAINT "catalog_source_configs_health_state_check" CHECK ("catalog_source_configs"."health_state" in ('unknown', 'full_feed_success', 'partial_feed', 'auth_failure', 'rate_limit', 'source_outage', 'schema_drift', 'rights_suspended', 'parse_failure', 'matching_ambiguity', 'anomalous_change')),
	CONSTRAINT "catalog_source_configs_provider_shape_check" CHECK ("catalog_source_configs"."provider" ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
	CONSTRAINT "catalog_source_configs_credential_ref_shape_check" CHECK ("catalog_source_configs"."credential_ref" is null
          or "catalog_source_configs"."credential_ref" ~ '^(connection|env|ssm):[A-Za-z0-9_./-]{1,120}$'),
	CONSTRAINT "catalog_source_configs_territories_shape_check" CHECK ("catalog_source_configs"."territories"::text ~ '^[{]([A-Z]{2}(,[A-Z]{2})*)?[}]$'),
	CONSTRAINT "catalog_source_configs_cadence_check" CHECK ("catalog_source_configs"."fetch_cadence_seconds" is null or "catalog_source_configs"."fetch_cadence_seconds" >= 60),
	CONSTRAINT "catalog_source_configs_ttl_check" CHECK ("catalog_source_configs"."freshness_ttl_seconds" >= 60),
	CONSTRAINT "catalog_source_configs_page_size_check" CHECK ("catalog_source_configs"."page_size" between 1 and 1000),
	CONSTRAINT "catalog_source_configs_rate_limits_check" CHECK (("catalog_source_configs"."rate_limit_per_minute" is null or "catalog_source_configs"."rate_limit_per_minute" >= 1)
          and ("catalog_source_configs"."rate_limit_concurrency" is null or "catalog_source_configs"."rate_limit_concurrency" >= 1)
          and ("catalog_source_configs"."rate_limit_min_interval_ms" is null or "catalog_source_configs"."rate_limit_min_interval_ms" >= 0)),
	CONSTRAINT "catalog_source_configs_failures_check" CHECK ("catalog_source_configs"."consecutive_failures" >= 0),
	CONSTRAINT "catalog_source_configs_rate_limit_hits_check" CHECK ("catalog_source_configs"."last_rate_limit_hits" >= 0),
	CONSTRAINT "catalog_source_configs_duration_check" CHECK ("catalog_source_configs"."last_fetch_duration_ms" is null or "catalog_source_configs"."last_fetch_duration_ms" >= 0),
	CONSTRAINT "catalog_source_configs_last_error_length_check" CHECK ("catalog_source_configs"."last_error" is null or length("catalog_source_configs"."last_error") <= 2000),
	CONSTRAINT "catalog_source_configs_status_reason_length_check" CHECK ("catalog_source_configs"."status_reason" is null or length("catalog_source_configs"."status_reason") <= 2000),
	CONSTRAINT "catalog_source_configs_status_attribution_check" CHECK ("catalog_source_configs"."status" in ('draft', 'failed')
          or ("catalog_source_configs"."status_changed_by_oxy_user_id" is not null and "catalog_source_configs"."status_changed_at" is not null)),
	CONSTRAINT "catalog_source_configs_lease_complete_check" CHECK (num_nonnulls("catalog_source_configs"."lease_owner", "catalog_source_configs"."lease_until") in (0, 2))
);
--> statement-breakpoint
CREATE TABLE "catalog_source_objects" (
	"id" text PRIMARY KEY NOT NULL,
	"source_id" text NOT NULL,
	"external_type" text NOT NULL,
	"external_id" text NOT NULL,
	"current_source_record_id" text NOT NULL,
	"last_successful_source_record_id" text,
	"current_observed_at" timestamp with time zone NOT NULL,
	"current_source_updated_at" timestamp with time zone,
	"current_content_hash" text NOT NULL,
	"first_observed_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"stale_at" timestamp with time zone NOT NULL,
	"state" text DEFAULT 'observed' NOT NULL,
	"last_match_decision_id" text,
	"offer_id" text,
	"quarantine_reason" text,
	"quarantined_at" timestamp with time zone,
	"quarantine_detail" text,
	"retired_at" timestamp with time zone,
	"observation_count" integer DEFAULT 1 NOT NULL,
	"last_price_amount" bigint,
	"last_price_currency" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "catalog_source_objects_external_type_check" CHECK ("catalog_source_objects"."external_type" in ('product', 'offer', 'merchant', 'brand', 'category', 'relationship')),
	CONSTRAINT "catalog_source_objects_state_check" CHECK ("catalog_source_objects"."state" in ('observed', 'matched', 'review_required', 'unmatched', 'offer_current', 'quarantined', 'retired')),
	CONSTRAINT "catalog_source_objects_quarantine_reason_check" CHECK ("catalog_source_objects"."quarantine_reason" in ('schema_drift', 'parse_failure', 'rights_withheld', 'anomalous_change')),
	CONSTRAINT "catalog_source_objects_content_hash_shape_check" CHECK ("catalog_source_objects"."current_content_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "catalog_source_objects_external_id_check" CHECK (btrim("catalog_source_objects"."external_id") <> ''),
	CONSTRAINT "catalog_source_objects_observation_count_check" CHECK ("catalog_source_objects"."observation_count" >= 1),
	CONSTRAINT "catalog_source_objects_quarantine_shape_check" CHECK (("catalog_source_objects"."state" = 'quarantined')
          = ("catalog_source_objects"."quarantine_reason" is not null and "catalog_source_objects"."quarantined_at" is not null)),
	CONSTRAINT "catalog_source_objects_retired_shape_check" CHECK (("catalog_source_objects"."state" = 'retired') = ("catalog_source_objects"."retired_at" is not null)),
	CONSTRAINT "catalog_source_objects_offer_state_check" CHECK ("catalog_source_objects"."state" <> 'offer_current' or "catalog_source_objects"."offer_id" is not null),
	CONSTRAINT "catalog_source_objects_decision_shape_check" CHECK ("catalog_source_objects"."state" not in ('matched', 'review_required', 'unmatched', 'offer_current')
          or "catalog_source_objects"."last_match_decision_id" is not null),
	CONSTRAINT "catalog_source_objects_price_paired_check" CHECK (("catalog_source_objects"."last_price_amount" is null) = ("catalog_source_objects"."last_price_currency" is null)),
	CONSTRAINT "catalog_source_objects_price_shape_check" CHECK ("catalog_source_objects"."last_price_amount" is null
          or ("catalog_source_objects"."last_price_amount" >= 0 and "catalog_source_objects"."last_price_currency" ~ '^[A-Z]{3,4}$')),
	CONSTRAINT "catalog_source_objects_quarantine_detail_length_check" CHECK ("catalog_source_objects"."quarantine_detail" is null
          or length("catalog_source_objects"."quarantine_detail") <= 2000),
	CONSTRAINT "catalog_source_objects_seen_order_check" CHECK ("catalog_source_objects"."last_seen_at" >= "catalog_source_objects"."first_observed_at" and "catalog_source_objects"."current_observed_at" >= "catalog_source_objects"."first_observed_at")
);
--> statement-breakpoint
CREATE TABLE "catalog_source_policies" (
	"id" text PRIMARY KEY NOT NULL,
	"source_id" text NOT NULL,
	"version" integer NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"may_display" boolean DEFAULT false NOT NULL,
	"may_store" boolean DEFAULT false NOT NULL,
	"may_cache" boolean DEFAULT false NOT NULL,
	"cache_ttl_seconds" integer,
	"may_display_price" boolean DEFAULT false NOT NULL,
	"may_display_media" boolean DEFAULT false NOT NULL,
	"may_link_out" boolean DEFAULT false NOT NULL,
	"may_append_affiliate_params" boolean DEFAULT false NOT NULL,
	"may_index" boolean DEFAULT false NOT NULL,
	"may_refresh_automatically" boolean DEFAULT false NOT NULL,
	"extraction_mode" text DEFAULT 'disallowed' NOT NULL,
	"extraction_max_requests_per_day" integer,
	"extraction_user_agent" text,
	"attribution_required" boolean DEFAULT true NOT NULL,
	"terms_version" text,
	"terms_url" text,
	"reviewed_at" timestamp with time zone,
	"reviewed_by_oxy_user_id" text,
	"review_note" text,
	"activated_at" timestamp with time zone,
	"superseded_at" timestamp with time zone,
	"supersedes_version" integer,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "catalog_source_policies_status_check" CHECK ("catalog_source_policies"."status" in ('draft', 'active', 'superseded')),
	CONSTRAINT "catalog_source_policies_extraction_mode_check" CHECK ("catalog_source_policies"."extraction_mode" in ('disallowed', 'robots_respecting', 'contracted')),
	CONSTRAINT "catalog_source_policies_version_check" CHECK ("catalog_source_policies"."version" >= 1),
	CONSTRAINT "catalog_source_policies_supersedes_check" CHECK ("catalog_source_policies"."supersedes_version" is null or "catalog_source_policies"."supersedes_version" < "catalog_source_policies"."version"),
	CONSTRAINT "catalog_source_policies_cache_shape_check" CHECK (("catalog_source_policies"."may_cache") = ("catalog_source_policies"."cache_ttl_seconds" is not null)
          and ("catalog_source_policies"."cache_ttl_seconds" is null or "catalog_source_policies"."cache_ttl_seconds" >= 0)),
	CONSTRAINT "catalog_source_policies_display_implication_check" CHECK ("catalog_source_policies"."may_display" or (not "catalog_source_policies"."may_display_price" and not "catalog_source_policies"."may_display_media")),
	CONSTRAINT "catalog_source_policies_affiliate_implication_check" CHECK ("catalog_source_policies"."may_link_out" or not "catalog_source_policies"."may_append_affiliate_params"),
	CONSTRAINT "catalog_source_policies_extraction_shape_check" CHECK ("catalog_source_policies"."extraction_mode" = 'disallowed'
          or ("catalog_source_policies"."extraction_max_requests_per_day" is not null and "catalog_source_policies"."extraction_max_requests_per_day" >= 1
              and "catalog_source_policies"."extraction_user_agent" is not null and btrim("catalog_source_policies"."extraction_user_agent") <> '')),
	CONSTRAINT "catalog_source_policies_active_review_check" CHECK ("catalog_source_policies"."status" = 'draft'
          or ("catalog_source_policies"."reviewed_at" is not null and "catalog_source_policies"."reviewed_by_oxy_user_id" is not null
              and "catalog_source_policies"."activated_at" is not null)),
	CONSTRAINT "catalog_source_policies_superseded_shape_check" CHECK (("catalog_source_policies"."status" = 'superseded') = ("catalog_source_policies"."superseded_at" is not null)),
	CONSTRAINT "catalog_source_policies_review_note_length_check" CHECK ("catalog_source_policies"."review_note" is null or length("catalog_source_policies"."review_note") <= 2000)
);
--> statement-breakpoint
CREATE TABLE "catalog_source_rejections" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"source_id" text NOT NULL,
	"external_type" text,
	"external_id" text,
	"reason_code" text NOT NULL,
	"detail" text,
	"raw_payload_digest" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "catalog_source_rejections_external_type_check" CHECK ("catalog_source_rejections"."external_type" in ('product', 'offer', 'merchant', 'brand', 'category', 'relationship')),
	CONSTRAINT "catalog_source_rejections_reason_check" CHECK ("catalog_source_rejections"."reason_code" in ('missing_external_id', 'missing_title', 'unsupported_object_kind', 'schema_drift', 'parse_failure', 'payload_too_large', 'rights_withheld', 'stale_observation', 'duplicate_in_page', 'anomalous_change')),
	CONSTRAINT "catalog_source_rejections_digest_shape_check" CHECK ("catalog_source_rejections"."raw_payload_digest" is null or "catalog_source_rejections"."raw_payload_digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "catalog_source_rejections_detail_length_check" CHECK ("catalog_source_rejections"."detail" is null or length("catalog_source_rejections"."detail") <= 2000)
);
--> statement-breakpoint
CREATE TABLE "catalog_source_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"source_id" text NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"outcome" text,
	"cursor" text,
	"enumeration_complete" boolean DEFAULT false NOT NULL,
	"since" timestamp with time zone,
	"fetched" integer DEFAULT 0 NOT NULL,
	"stored" integer DEFAULT 0 NOT NULL,
	"unchanged" integer DEFAULT 0 NOT NULL,
	"rejected" integer DEFAULT 0 NOT NULL,
	"quarantined" integer DEFAULT 0 NOT NULL,
	"matched" integer DEFAULT 0 NOT NULL,
	"review_required" integer DEFAULT 0 NOT NULL,
	"unmatched" integer DEFAULT 0 NOT NULL,
	"offers_upserted" integer DEFAULT 0 NOT NULL,
	"offers_retired" integer DEFAULT 0 NOT NULL,
	"fetch_count" integer DEFAULT 0 NOT NULL,
	"fetch_duration_ms" integer DEFAULT 0 NOT NULL,
	"rate_limit_hits" integer DEFAULT 0 NOT NULL,
	"lease_owner" text,
	"lease_until" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"last_error" text,
	"requested_by_oxy_user_id" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "catalog_source_runs_kind_check" CHECK ("catalog_source_runs"."kind" in ('backfill', 'incremental', 'webhook', 'manual')),
	CONSTRAINT "catalog_source_runs_status_check" CHECK ("catalog_source_runs"."status" in ('pending', 'running', 'completed', 'failed')),
	CONSTRAINT "catalog_source_runs_outcome_check" CHECK ("catalog_source_runs"."outcome" in ('unknown', 'full_feed_success', 'partial_feed', 'auth_failure', 'rate_limit', 'source_outage', 'schema_drift', 'rights_suspended', 'parse_failure', 'matching_ambiguity', 'anomalous_change')),
	CONSTRAINT "catalog_source_runs_counters_non_negative_check" CHECK ("catalog_source_runs"."fetched" >= 0 and "catalog_source_runs"."stored" >= 0 and "catalog_source_runs"."unchanged" >= 0 and "catalog_source_runs"."rejected" >= 0
          and "catalog_source_runs"."quarantined" >= 0 and "catalog_source_runs"."matched" >= 0 and "catalog_source_runs"."review_required" >= 0
          and "catalog_source_runs"."unmatched" >= 0 and "catalog_source_runs"."offers_upserted" >= 0 and "catalog_source_runs"."offers_retired" >= 0
          and "catalog_source_runs"."fetch_count" >= 0 and "catalog_source_runs"."fetch_duration_ms" >= 0 and "catalog_source_runs"."rate_limit_hits" >= 0
          and "catalog_source_runs"."attempts" >= 0),
	CONSTRAINT "catalog_source_runs_intake_total_check" CHECK ("catalog_source_runs"."fetched" = "catalog_source_runs"."stored" + "catalog_source_runs"."unchanged" + "catalog_source_runs"."rejected" + "catalog_source_runs"."quarantined"),
	CONSTRAINT "catalog_source_runs_downstream_bound_check" CHECK ("catalog_source_runs"."matched" <= "catalog_source_runs"."fetched" and "catalog_source_runs"."review_required" <= "catalog_source_runs"."fetched"
          and "catalog_source_runs"."unmatched" <= "catalog_source_runs"."fetched" and "catalog_source_runs"."offers_upserted" <= "catalog_source_runs"."fetched"),
	CONSTRAINT "catalog_source_runs_retirement_check" CHECK ("catalog_source_runs"."offers_retired" = 0
          or ("catalog_source_runs"."enumeration_complete"
              and "catalog_source_runs"."outcome" in ('full_feed_success'))),
	CONSTRAINT "catalog_source_runs_outcome_shape_check" CHECK (("catalog_source_runs"."status" in ('completed', 'failed')) = ("catalog_source_runs"."outcome" is not null)),
	CONSTRAINT "catalog_source_runs_finished_shape_check" CHECK (("catalog_source_runs"."status" in ('completed', 'failed')) = ("catalog_source_runs"."finished_at" is not null)),
	CONSTRAINT "catalog_source_runs_started_shape_check" CHECK ("catalog_source_runs"."status" = 'pending' or "catalog_source_runs"."started_at" is not null),
	CONSTRAINT "catalog_source_runs_lease_complete_check" CHECK (num_nonnulls("catalog_source_runs"."lease_owner", "catalog_source_runs"."lease_until") in (0, 2)),
	CONSTRAINT "catalog_source_runs_requested_by_check" CHECK (("catalog_source_runs"."requested_by_oxy_user_id" is not null) = ("catalog_source_runs"."kind" = 'manual')),
	CONSTRAINT "catalog_source_runs_last_error_length_check" CHECK ("catalog_source_runs"."last_error" is null or length("catalog_source_runs"."last_error") <= 2000)
);
--> statement-breakpoint
ALTER TABLE "source_records" ADD COLUMN "source_updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "source_records" ADD COLUMN "raw_payload_digest" text;--> statement-breakpoint
ALTER TABLE "source_records" ADD COLUMN "normalization_version" integer;--> statement-breakpoint
ALTER TABLE "source_records" ADD COLUMN "policy_version" integer;--> statement-breakpoint
ALTER TABLE "catalog_source_configs" ADD CONSTRAINT "catalog_source_configs_source_id_catalog_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."catalog_sources"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_source_configs" ADD CONSTRAINT "catalog_source_configs_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_source_configs" ADD CONSTRAINT "catalog_source_configs_storefront_id_storefronts_id_fk" FOREIGN KEY ("storefront_id") REFERENCES "public"."storefronts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_source_objects" ADD CONSTRAINT "catalog_source_objects_source_id_catalog_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."catalog_sources"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_source_objects" ADD CONSTRAINT "catalog_source_objects_current_source_record_id_source_records_id_fk" FOREIGN KEY ("current_source_record_id") REFERENCES "public"."source_records"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_source_objects" ADD CONSTRAINT "catalog_source_objects_last_successful_source_record_id_source_records_id_fk" FOREIGN KEY ("last_successful_source_record_id") REFERENCES "public"."source_records"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_source_objects" ADD CONSTRAINT "catalog_source_objects_last_match_decision_id_match_decisions_id_fk" FOREIGN KEY ("last_match_decision_id") REFERENCES "public"."match_decisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_source_objects" ADD CONSTRAINT "catalog_source_objects_offer_id_offers_id_fk" FOREIGN KEY ("offer_id") REFERENCES "public"."offers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_source_policies" ADD CONSTRAINT "catalog_source_policies_source_id_catalog_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."catalog_sources"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_source_rejections" ADD CONSTRAINT "catalog_source_rejections_run_id_catalog_source_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."catalog_source_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_source_rejections" ADD CONSTRAINT "catalog_source_rejections_source_id_catalog_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."catalog_sources"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_source_runs" ADD CONSTRAINT "catalog_source_runs_source_id_catalog_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."catalog_sources"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "catalog_source_configs_source_key" ON "catalog_source_configs" USING btree ("source_id");--> statement-breakpoint
CREATE UNIQUE INDEX "catalog_source_configs_provider_account_key" ON "catalog_source_configs" USING btree ("provider","source_account_ref") WHERE "catalog_source_configs"."source_account_ref" is not null and "catalog_source_configs"."status" <> 'revoked';--> statement-breakpoint
CREATE INDEX "catalog_source_configs_due_idx" ON "catalog_source_configs" USING btree ("next_run_at") WHERE "catalog_source_configs"."status" in ('active', 'failed');--> statement-breakpoint
CREATE INDEX "catalog_source_configs_reclaim_idx" ON "catalog_source_configs" USING btree ("lease_until") WHERE "catalog_source_configs"."lease_owner" is not null;--> statement-breakpoint
CREATE INDEX "catalog_source_configs_health_idx" ON "catalog_source_configs" USING btree ("health_state","health_changed_at");--> statement-breakpoint
CREATE INDEX "catalog_source_configs_merchant_idx" ON "catalog_source_configs" USING btree ("merchant_id") WHERE "catalog_source_configs"."merchant_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "catalog_source_objects_identity_key" ON "catalog_source_objects" USING btree ("source_id","external_type","external_id");--> statement-breakpoint
CREATE INDEX "catalog_source_objects_source_seen_idx" ON "catalog_source_objects" USING btree ("source_id","last_seen_at");--> statement-breakpoint
CREATE INDEX "catalog_source_objects_freshness_idx" ON "catalog_source_objects" USING btree ("source_id","stale_at");--> statement-breakpoint
CREATE INDEX "catalog_source_objects_state_idx" ON "catalog_source_objects" USING btree ("source_id","state");--> statement-breakpoint
CREATE INDEX "catalog_source_objects_offer_idx" ON "catalog_source_objects" USING btree ("offer_id") WHERE "catalog_source_objects"."offer_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "catalog_source_policies_version_key" ON "catalog_source_policies" USING btree ("source_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "catalog_source_policies_active_key" ON "catalog_source_policies" USING btree ("source_id") WHERE "catalog_source_policies"."status" = 'active';--> statement-breakpoint
CREATE INDEX "catalog_source_policies_source_idx" ON "catalog_source_policies" USING btree ("source_id","version");--> statement-breakpoint
CREATE INDEX "catalog_source_rejections_source_idx" ON "catalog_source_rejections" USING btree ("source_id","reason_code","created_at");--> statement-breakpoint
CREATE INDEX "catalog_source_rejections_run_idx" ON "catalog_source_rejections" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "catalog_source_rejections_expiry_idx" ON "catalog_source_rejections" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "catalog_source_runs_open_key" ON "catalog_source_runs" USING btree ("source_id") WHERE "catalog_source_runs"."status" in ('pending', 'running');--> statement-breakpoint
CREATE INDEX "catalog_source_runs_pending_idx" ON "catalog_source_runs" USING btree ("available_at","created_at") WHERE "catalog_source_runs"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "catalog_source_runs_reclaim_idx" ON "catalog_source_runs" USING btree ("lease_until","created_at") WHERE "catalog_source_runs"."status" = 'running';--> statement-breakpoint
CREATE INDEX "catalog_source_runs_source_idx" ON "catalog_source_runs" USING btree ("source_id","created_at");--> statement-breakpoint
ALTER TABLE "source_records" ADD CONSTRAINT "source_records_raw_payload_digest_shape_check" CHECK ("source_records"."raw_payload_digest" is null or "source_records"."raw_payload_digest" ~ '^[0-9a-f]{64}$');--> statement-breakpoint
ALTER TABLE "source_records" ADD CONSTRAINT "source_records_normalization_version_check" CHECK ("source_records"."normalization_version" is null or "source_records"."normalization_version" >= 1);--> statement-breakpoint
ALTER TABLE "source_records" ADD CONSTRAINT "source_records_policy_version_check" CHECK ("source_records"."policy_version" is null or "source_records"."policy_version" >= 1);
-- ### HAND-WRITTEN — see the header. A regeneration DROPS everything below.

CREATE OR REPLACE FUNCTION mercaria_catalog_source_object_monotonic()
RETURNS trigger AS $$
BEGIN
  IF NEW.current_observed_at < OLD.current_observed_at THEN
    RAISE EXCEPTION
      'catalog_source_objects % would move current_observed_at backwards (% -> %); an older observation cannot overwrite a newer current fact',
      OLD.id, OLD.current_observed_at, NEW.current_observed_at
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  -- Only when BOTH sides publish one. A source that starts stamping its own
  -- last-modified mid-life would otherwise be refused on every subsequent
  -- delivery, because a comparison against NULL is not false, it is unknown.
  IF OLD.current_source_updated_at IS NOT NULL
     AND NEW.current_source_updated_at IS NOT NULL
     AND NEW.current_source_updated_at < OLD.current_source_updated_at THEN
    RAISE EXCEPTION
      'catalog_source_objects % would move current_source_updated_at backwards (% -> %)',
      OLD.id, OLD.current_source_updated_at, NEW.current_source_updated_at
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  -- `first_observed_at` is what it says: the first time this object was ever
  -- seen. Nothing legitimate moves it after the insert.
  IF NEW.first_observed_at IS DISTINCT FROM OLD.first_observed_at THEN
    RAISE EXCEPTION
      'catalog_source_objects % cannot change first_observed_at', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
DROP TRIGGER IF EXISTS catalog_source_objects_monotonic ON "catalog_source_objects";--> statement-breakpoint
CREATE TRIGGER catalog_source_objects_monotonic
  BEFORE UPDATE ON "catalog_source_objects"
  FOR EACH ROW EXECUTE FUNCTION mercaria_catalog_source_object_monotonic();--> statement-breakpoint

CREATE OR REPLACE FUNCTION mercaria_catalog_source_policy_immutable()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN
      RAISE EXCEPTION
        'catalog_source_policies % (source %, v%) is % and cannot be deleted; observations cite this version',
        OLD.id, OLD.source_id, OLD.version, OLD.status
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.status = 'draft' THEN
    RETURN NEW;
  END IF;

  IF NEW.source_id IS DISTINCT FROM OLD.source_id
     OR NEW.version IS DISTINCT FROM OLD.version
     OR NEW.may_display IS DISTINCT FROM OLD.may_display
     OR NEW.may_store IS DISTINCT FROM OLD.may_store
     OR NEW.may_cache IS DISTINCT FROM OLD.may_cache
     OR NEW.cache_ttl_seconds IS DISTINCT FROM OLD.cache_ttl_seconds
     OR NEW.may_display_price IS DISTINCT FROM OLD.may_display_price
     OR NEW.may_display_media IS DISTINCT FROM OLD.may_display_media
     OR NEW.may_link_out IS DISTINCT FROM OLD.may_link_out
     OR NEW.may_append_affiliate_params IS DISTINCT FROM OLD.may_append_affiliate_params
     OR NEW.may_index IS DISTINCT FROM OLD.may_index
     OR NEW.may_refresh_automatically IS DISTINCT FROM OLD.may_refresh_automatically
     OR NEW.extraction_mode IS DISTINCT FROM OLD.extraction_mode
     OR NEW.extraction_max_requests_per_day IS DISTINCT FROM OLD.extraction_max_requests_per_day
     OR NEW.extraction_user_agent IS DISTINCT FROM OLD.extraction_user_agent
     OR NEW.attribution_required IS DISTINCT FROM OLD.attribution_required
     OR NEW.terms_version IS DISTINCT FROM OLD.terms_version
     OR NEW.terms_url IS DISTINCT FROM OLD.terms_url
     OR NEW.reviewed_at IS DISTINCT FROM OLD.reviewed_at
     OR NEW.reviewed_by_oxy_user_id IS DISTINCT FROM OLD.reviewed_by_oxy_user_id
     OR NEW.review_note IS DISTINCT FROM OLD.review_note
     OR NEW.activated_at IS DISTINCT FROM OLD.activated_at
     OR NEW.supersedes_version IS DISTINCT FROM OLD.supersedes_version THEN
    RAISE EXCEPTION
      'catalog_source_policies % (source %, v%) is % and its rights are frozen; publish a new version instead',
      OLD.id, OLD.source_id, OLD.version, OLD.status
      USING ERRCODE = 'restrict_violation';
  END IF;

  -- The one permitted transition: an active version being superseded by the
  -- one that replaces it. Anything else on `status` would be a rights change
  -- wearing a lifecycle field.
  IF NEW.status IS DISTINCT FROM OLD.status
     AND NOT (OLD.status = 'active' AND NEW.status = 'superseded') THEN
    RAISE EXCEPTION
      'catalog_source_policies % may only move from active to superseded (attempted % -> %)',
      OLD.id, OLD.status, NEW.status
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
DROP TRIGGER IF EXISTS catalog_source_policies_immutable ON "catalog_source_policies";--> statement-breakpoint
CREATE TRIGGER catalog_source_policies_immutable
  BEFORE UPDATE OR DELETE ON "catalog_source_policies"
  FOR EACH ROW EXECUTE FUNCTION mercaria_catalog_source_policy_immutable();--> statement-breakpoint

CREATE OR REPLACE FUNCTION mercaria_catalog_source_rights_agree()
RETURNS trigger AS $$
DECLARE
  target_source_id text;
  config_status text;
  policy_display boolean;
  policy_store boolean;
  policy_attribution boolean;
  has_policy boolean;
  expected_display boolean;
  expected_store boolean;
  expected_attribution boolean;
  actual_display boolean;
  actual_store boolean;
  actual_attribution boolean;
BEGIN
  IF TG_TABLE_NAME = 'catalog_sources' THEN
    target_source_id := NEW.id;
  ELSE
    target_source_id := NEW.source_id;
  END IF;

  SELECT status INTO config_status
  FROM catalog_source_configs WHERE source_id = target_source_id;

  -- A provenance-only source (operator, backfill, and every registry row that
  -- predates #62) states its own coarse rights and nothing derives them.
  IF config_status IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT may_display, may_store, attribution_required
    INTO policy_display, policy_store, policy_attribution
  FROM catalog_source_policies
  WHERE source_id = target_source_id AND status = 'active';
  has_policy := FOUND;

  IF NOT has_policy OR config_status NOT IN ('active', 'paused', 'failed') THEN
    expected_display := false;
    expected_store := false;
    -- The one right whose safe default is TRUE: with display off there is
    -- nothing to attribute, and if that ever changes the conservative answer is
    -- to name the source.
    expected_attribution := true;
  ELSE
    expected_display := policy_display;
    expected_store := policy_store;
    expected_attribution := policy_attribution;
  END IF;

  SELECT may_display, may_store, attribution_required
    INTO actual_display, actual_store, actual_attribution
  FROM catalog_sources WHERE id = target_source_id;
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  IF actual_display IS DISTINCT FROM expected_display
     OR actual_store IS DISTINCT FROM expected_store
     OR actual_attribution IS DISTINCT FROM expected_attribution THEN
    RAISE EXCEPTION
      'catalog_sources % advertises rights (display=%, store=%, attribution=%) that disagree with its policy and status % (expected display=%, store=%, attribution=%)',
      target_source_id, actual_display, actual_store, actual_attribution,
      config_status, expected_display, expected_store, expected_attribution
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
DROP TRIGGER IF EXISTS catalog_sources_rights_agree ON "catalog_sources";--> statement-breakpoint
CREATE CONSTRAINT TRIGGER catalog_sources_rights_agree
  AFTER INSERT OR UPDATE ON "catalog_sources"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION mercaria_catalog_source_rights_agree();--> statement-breakpoint
DROP TRIGGER IF EXISTS catalog_source_configs_rights_agree ON "catalog_source_configs";--> statement-breakpoint
CREATE CONSTRAINT TRIGGER catalog_source_configs_rights_agree
  AFTER INSERT OR UPDATE ON "catalog_source_configs"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION mercaria_catalog_source_rights_agree();--> statement-breakpoint
DROP TRIGGER IF EXISTS catalog_source_policies_rights_agree ON "catalog_source_policies";--> statement-breakpoint
CREATE CONSTRAINT TRIGGER catalog_source_policies_rights_agree
  AFTER INSERT OR UPDATE ON "catalog_source_policies"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION mercaria_catalog_source_rights_agree();--> statement-breakpoint

CREATE OR REPLACE FUNCTION mercaria_catalog_source_run_counters_monotonic()
RETURNS trigger AS $$
BEGIN
  IF NEW.fetched < OLD.fetched
     OR NEW.stored < OLD.stored
     OR NEW.unchanged < OLD.unchanged
     OR NEW.rejected < OLD.rejected
     OR NEW.quarantined < OLD.quarantined
     OR NEW.matched < OLD.matched
     OR NEW.review_required < OLD.review_required
     OR NEW.unmatched < OLD.unmatched
     OR NEW.offers_upserted < OLD.offers_upserted
     OR NEW.offers_retired < OLD.offers_retired
     OR NEW.fetch_count < OLD.fetch_count
     OR NEW.rate_limit_hits < OLD.rate_limit_hits THEN
    RAISE EXCEPTION
      'catalog_source_runs % cannot lower a counter; a pass is many pages adding to one row',
      OLD.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
DROP TRIGGER IF EXISTS catalog_source_runs_counters_monotonic ON "catalog_source_runs";--> statement-breakpoint
CREATE TRIGGER catalog_source_runs_counters_monotonic
  BEFORE UPDATE ON "catalog_source_runs"
  FOR EACH ROW EXECUTE FUNCTION mercaria_catalog_source_run_counters_monotonic();
