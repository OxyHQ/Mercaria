-- oxy:deploy-phase=pre
--
-- #68 — source-aware offer refresh, expiry and catalogue health. PHASE 1 of 2.
--
-- Everything here is ADDITIVE and every statement is safe against the image
-- that is still serving: five new tables, four new columns, two backfills, the
-- widened `offers_retirement_reason_check`, and the CHECKs whose predicate is
-- NULL-tolerant on the rows that image writes.
--
-- `catalog_source_runs.refresh_mode` is added NULLABLE here on purpose. It is
-- NOT NULL in the schema and `0044` (`post`) makes it so — adding it NOT NULL
-- with no default would break every run the serving image opens, which is what
-- the deploy-phase split exists to prevent. The two mode CHECKs added below are
-- deliberately tolerant of that NULL: `(null = 'targeted')` is NULL and a CHECK
-- rejects only FALSE, so a run the previous image opens still commits.
--
-- ON A REGENERATION: three hand-written blocks below are dropped by
-- drizzle-kit. Re-apply the two backfill `UPDATE`s between the `ADD COLUMN`
-- block and the first `ADD CONSTRAINT`, in that order — the `refresh_mode`
-- backfill must precede `catalog_source_runs_complete_mode_check`, which it is
-- written to satisfy — and re-apply the
-- `catalog_source_freshness_policies_immutable` trigger at the END. A
-- regeneration that keeps the CHECKs and loses the trigger applies perfectly
-- cleanly and freezes nothing.

CREATE TABLE "catalog_source_distributions" (
	"id" text PRIMARY KEY NOT NULL,
	"source_id" text NOT NULL,
	"captured_from_run_id" text,
	"sample_size" integer NOT NULL,
	"priced_count" integer NOT NULL,
	"zero_priced_count" integer NOT NULL,
	"median_price_minor" bigint,
	"dominant_currency" text,
	"dominant_currency_share_bps" integer DEFAULT 0 NOT NULL,
	"object_count" integer DEFAULT 0 NOT NULL,
	"captured_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "catalog_source_distributions_counts_check" CHECK ("catalog_source_distributions"."sample_size" >= 0 and "catalog_source_distributions"."priced_count" >= 0 and "catalog_source_distributions"."zero_priced_count" >= 0
          and "catalog_source_distributions"."object_count" >= 0
          and "catalog_source_distributions"."priced_count" <= "catalog_source_distributions"."sample_size"
          and "catalog_source_distributions"."zero_priced_count" <= "catalog_source_distributions"."priced_count"),
	CONSTRAINT "catalog_source_distributions_share_check" CHECK ("catalog_source_distributions"."dominant_currency_share_bps" between 0 and 10000),
	CONSTRAINT "catalog_source_distributions_median_paired_check" CHECK (("catalog_source_distributions"."median_price_minor" is null) = ("catalog_source_distributions"."dominant_currency" is null)),
	CONSTRAINT "catalog_source_distributions_median_shape_check" CHECK ("catalog_source_distributions"."median_price_minor" is null
          or ("catalog_source_distributions"."median_price_minor" >= 0 and "catalog_source_distributions"."dominant_currency" ~ '^[A-Z]{3,4}$'))
);
--> statement-breakpoint
CREATE TABLE "catalog_source_freshness_policies" (
	"id" text PRIMARY KEY NOT NULL,
	"source_id" text NOT NULL,
	"version" integer NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"expected_refresh_interval_seconds" integer NOT NULL,
	"warning_after_seconds" integer NOT NULL,
	"expiry_after_seconds" integer NOT NULL,
	"outage_grace_seconds" integer NOT NULL,
	"retire_on_source_unavailable" boolean DEFAULT true NOT NULL,
	"permitted_refresh_modes" text[] DEFAULT '{}'::text[] NOT NULL,
	"anomaly_minimum_sample_size" integer DEFAULT 50 NOT NULL,
	"anomaly_zero_price_share_bps" integer DEFAULT 5000 NOT NULL,
	"anomaly_price_scale_factor" integer DEFAULT 10 NOT NULL,
	"anomaly_disappearance_share_bps" integer DEFAULT 5000 NOT NULL,
	"reviewed_at" timestamp with time zone,
	"reviewed_by_oxy_user_id" text,
	"review_note" text,
	"activated_at" timestamp with time zone,
	"superseded_at" timestamp with time zone,
	"supersedes_version" integer,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "catalog_source_freshness_policies_status_check" CHECK ("catalog_source_freshness_policies"."status" in ('draft', 'active', 'superseded')),
	CONSTRAINT "catalog_source_freshness_policies_modes_check" CHECK ("catalog_source_freshness_policies"."permitted_refresh_modes" <@ array['full_snapshot', 'incremental', 'query_driven', 'targeted']::text[]),
	CONSTRAINT "catalog_source_freshness_policies_version_check" CHECK ("catalog_source_freshness_policies"."version" >= 1),
	CONSTRAINT "catalog_source_freshness_policies_supersedes_check" CHECK ("catalog_source_freshness_policies"."supersedes_version" is null or "catalog_source_freshness_policies"."supersedes_version" < "catalog_source_freshness_policies"."version"),
	CONSTRAINT "catalog_source_freshness_policies_durations_check" CHECK ("catalog_source_freshness_policies"."expected_refresh_interval_seconds" >= 60
          and "catalog_source_freshness_policies"."warning_after_seconds" >= 60
          and "catalog_source_freshness_policies"."expiry_after_seconds" >= 60
          and "catalog_source_freshness_policies"."outage_grace_seconds" >= 0
          and "catalog_source_freshness_policies"."warning_after_seconds" < "catalog_source_freshness_policies"."expiry_after_seconds"),
	CONSTRAINT "catalog_source_freshness_policies_thresholds_check" CHECK ("catalog_source_freshness_policies"."anomaly_minimum_sample_size" >= 1
          and "catalog_source_freshness_policies"."anomaly_zero_price_share_bps" between 1 and 10000
          and "catalog_source_freshness_policies"."anomaly_disappearance_share_bps" between 1 and 10000
          and "catalog_source_freshness_policies"."anomaly_price_scale_factor" >= 2),
	CONSTRAINT "catalog_source_freshness_policies_active_review_check" CHECK ("catalog_source_freshness_policies"."status" = 'draft'
          or ("catalog_source_freshness_policies"."reviewed_at" is not null and "catalog_source_freshness_policies"."reviewed_by_oxy_user_id" is not null
              and "catalog_source_freshness_policies"."activated_at" is not null)),
	CONSTRAINT "catalog_source_freshness_policies_superseded_shape_check" CHECK (("catalog_source_freshness_policies"."status" = 'superseded') = ("catalog_source_freshness_policies"."superseded_at" is not null)),
	CONSTRAINT "catalog_source_freshness_policies_note_length_check" CHECK ("catalog_source_freshness_policies"."review_note" is null
          or length("catalog_source_freshness_policies"."review_note") <= 2000)
);
--> statement-breakpoint
CREATE TABLE "catalog_source_refresh_leases" (
	"id" text PRIMARY KEY NOT NULL,
	"source_id" text NOT NULL,
	"slot" integer NOT NULL,
	"lease_owner" text,
	"lease_until" timestamp with time zone,
	"window_start" timestamp with time zone NOT NULL,
	"calls_in_window" integer DEFAULT 0 NOT NULL,
	"window_allowance" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "catalog_source_refresh_leases_slot_check" CHECK ("catalog_source_refresh_leases"."slot" >= 0),
	CONSTRAINT "catalog_source_refresh_leases_lease_shape_check" CHECK (num_nonnulls("catalog_source_refresh_leases"."lease_owner", "catalog_source_refresh_leases"."lease_until") in (0, 2)),
	CONSTRAINT "catalog_source_refresh_leases_window_check" CHECK ("catalog_source_refresh_leases"."calls_in_window" >= 0 and "catalog_source_refresh_leases"."window_allowance" >= 1
          and "catalog_source_refresh_leases"."calls_in_window" <= "catalog_source_refresh_leases"."window_allowance")
);
--> statement-breakpoint
CREATE TABLE "catalog_source_run_quarantines" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"source_id" text NOT NULL,
	"kind" text NOT NULL,
	"observed_value" double precision NOT NULL,
	"baseline_value" double precision,
	"detail" text NOT NULL,
	"held_objects" integer DEFAULT 0 NOT NULL,
	"resolution" text,
	"resolved_at" timestamp with time zone,
	"resolved_by_oxy_user_id" text,
	"resolution_note" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "catalog_source_run_quarantines_kind_check" CHECK ("catalog_source_run_quarantines"."kind" in ('feed_wide_zero_price', 'currency_change', 'price_scale_shift', 'mass_disappearance')),
	CONSTRAINT "catalog_source_run_quarantines_resolution_check" CHECK ("catalog_source_run_quarantines"."resolution" in ('released', 'corrected')),
	CONSTRAINT "catalog_source_run_quarantines_held_check" CHECK ("catalog_source_run_quarantines"."held_objects" >= 0),
	CONSTRAINT "catalog_source_run_quarantines_detail_check" CHECK (btrim("catalog_source_run_quarantines"."detail") <> ''),
	CONSTRAINT "catalog_source_run_quarantines_detail_length_check" CHECK (length("catalog_source_run_quarantines"."detail") <= 2000),
	CONSTRAINT "catalog_source_run_quarantines_resolved_shape_check" CHECK (("catalog_source_run_quarantines"."resolution" is not null) = ("catalog_source_run_quarantines"."resolved_at" is not null)),
	CONSTRAINT "catalog_source_run_quarantines_actor_shape_check" CHECK (("catalog_source_run_quarantines"."resolved_by_oxy_user_id" is not null) = ("catalog_source_run_quarantines"."resolution" = 'released')),
	CONSTRAINT "catalog_source_run_quarantines_note_length_check" CHECK ("catalog_source_run_quarantines"."resolution_note" is null
          or length("catalog_source_run_quarantines"."resolution_note") <= 2000)
);
--> statement-breakpoint
CREATE TABLE "offer_refresh_tasks" (
	"id" text PRIMARY KEY NOT NULL,
	"source_id" text NOT NULL,
	"mode" text NOT NULL,
	"subject_kind" text NOT NULL,
	"subject_key" text NOT NULL,
	"offer_id" text,
	"priority_class" text NOT NULL,
	"priority_reasons" text[] NOT NULL,
	"priority_rank" integer GENERATED ALWAYS AS (case "priority_class" when 'alerted' then 0 when 'clicked' then 1 when 'popular' then 2 when 'comparison' then 3 when 'scheduled' then 4 else 5 end) STORED NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"requested_revision" bigint DEFAULT 1 NOT NULL,
	"claimed_revision" bigint,
	"attempts" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone NOT NULL,
	"lease_owner" text,
	"lease_until" timestamp with time zone,
	"last_error" text,
	"last_refusal" text,
	"processed_at" timestamp with time zone,
	"requested_by_oxy_user_id" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "offer_refresh_tasks_mode_check" CHECK ("offer_refresh_tasks"."mode" in ('full_snapshot', 'incremental', 'query_driven', 'targeted')),
	CONSTRAINT "offer_refresh_tasks_subject_kind_check" CHECK ("offer_refresh_tasks"."subject_kind" in ('source', 'external_object')),
	CONSTRAINT "offer_refresh_tasks_status_check" CHECK ("offer_refresh_tasks"."status" in ('pending', 'processing', 'done', 'dead_letter')),
	CONSTRAINT "offer_refresh_tasks_refusal_check" CHECK ("offer_refresh_tasks"."last_refusal" in ('adapter_missing', 'unsupported_mode', 'rights_suspended', 'source_unconfigured', 'rate_limited', 'all_slots_busy')),
	CONSTRAINT "offer_refresh_tasks_priority_class_check" CHECK ("offer_refresh_tasks"."priority_class" in ('alerted', 'clicked', 'popular', 'comparison', 'scheduled')),
	CONSTRAINT "offer_refresh_tasks_priority_reasons_check" CHECK ("offer_refresh_tasks"."priority_reasons" <@ array['alerted', 'clicked', 'popular', 'comparison', 'scheduled']::text[]),
	CONSTRAINT "offer_refresh_tasks_priority_membership_check" CHECK (coalesce(array_length("offer_refresh_tasks"."priority_reasons", 1), 0) >= 1
          and "offer_refresh_tasks"."priority_class" = any("offer_refresh_tasks"."priority_reasons")),
	CONSTRAINT "offer_refresh_tasks_subject_shape_check" CHECK (case "offer_refresh_tasks"."subject_kind"
        when 'source' then "offer_refresh_tasks"."subject_key" = '*'
        when 'external_object' then
          btrim("offer_refresh_tasks"."subject_key") <> ''
          and "offer_refresh_tasks"."subject_key" <> '*'
        else false
      end),
	CONSTRAINT "offer_refresh_tasks_mode_subject_check" CHECK (("offer_refresh_tasks"."mode" = 'targeted') = ("offer_refresh_tasks"."subject_kind" = 'external_object')),
	CONSTRAINT "offer_refresh_tasks_attempts_check" CHECK ("offer_refresh_tasks"."attempts" >= 0),
	CONSTRAINT "offer_refresh_tasks_requested_revision_check" CHECK ("offer_refresh_tasks"."requested_revision" >= 1),
	CONSTRAINT "offer_refresh_tasks_claimed_revision_check" CHECK ("offer_refresh_tasks"."claimed_revision" is null or "offer_refresh_tasks"."claimed_revision" <= "offer_refresh_tasks"."requested_revision"),
	CONSTRAINT "offer_refresh_tasks_lease_complete_check" CHECK (num_nonnulls("offer_refresh_tasks"."lease_owner", "offer_refresh_tasks"."lease_until") in (0, 2)),
	CONSTRAINT "offer_refresh_tasks_last_error_length_check" CHECK ("offer_refresh_tasks"."last_error" is null
          or length("offer_refresh_tasks"."last_error") <= 2000)
);
--> statement-breakpoint
ALTER TABLE "offers" DROP CONSTRAINT "offers_retirement_reason_check";--> statement-breakpoint
ALTER TABLE "catalog_source_runs" DROP CONSTRAINT "catalog_source_runs_counters_non_negative_check";--> statement-breakpoint
ALTER TABLE "offers" ADD COLUMN "declared_unavailable_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "catalog_source_objects" ADD COLUMN "retirement_kind" text;--> statement-breakpoint
ALTER TABLE "catalog_source_runs" ADD COLUMN "refresh_mode" text;--> statement-breakpoint
ALTER TABLE "catalog_source_runs" ADD COLUMN "target_external_ids" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "catalog_source_runs" ADD COLUMN "offers_removed" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
-- #68 BACKFILL 1 — every existing run states its mode.
--
-- `enumeration_complete` leads the CASE and is not merely a tidier ordering: a
-- historical run that claimed a complete enumeration must land on
-- `full_snapshot`, or `catalog_source_runs_complete_mode_check` (added below)
-- refuses the row. Everything else takes #62's own reading of `since`, whose
-- docblock already says an absent watermark asks for a full enumeration.
UPDATE "catalog_source_runs"
SET "refresh_mode" = CASE
  WHEN "enumeration_complete" THEN 'full_snapshot'
  WHEN "since" IS NULL THEN 'full_snapshot'
  ELSE 'incremental'
END
WHERE "refresh_mode" IS NULL;--> statement-breakpoint
-- #68 BACKFILL 2 — every already-retired object states its evidence.
--
-- `snapshot_omission` and not `explicit_removal`: before #68 the ONLY path that
-- retired an object was `retireUnseenForRun`, reached only from a complete
-- enumeration's silence. Recording these as removals would put a claim in the
-- trace that no source ever made.
UPDATE "catalog_source_objects"
SET "retirement_kind" = 'snapshot_omission'
WHERE "retired_at" IS NOT NULL AND "retirement_kind" IS NULL;--> statement-breakpoint
ALTER TABLE "catalog_source_distributions" ADD CONSTRAINT "catalog_source_distributions_source_id_catalog_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."catalog_sources"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_source_distributions" ADD CONSTRAINT "catalog_source_distributions_captured_from_run_id_catalog_source_runs_id_fk" FOREIGN KEY ("captured_from_run_id") REFERENCES "public"."catalog_source_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_source_freshness_policies" ADD CONSTRAINT "catalog_source_freshness_policies_source_id_catalog_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."catalog_sources"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_source_refresh_leases" ADD CONSTRAINT "catalog_source_refresh_leases_source_id_catalog_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."catalog_sources"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_source_run_quarantines" ADD CONSTRAINT "catalog_source_run_quarantines_run_id_catalog_source_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."catalog_source_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_source_run_quarantines" ADD CONSTRAINT "catalog_source_run_quarantines_source_id_catalog_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."catalog_sources"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offer_refresh_tasks" ADD CONSTRAINT "offer_refresh_tasks_source_id_catalog_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."catalog_sources"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offer_refresh_tasks" ADD CONSTRAINT "offer_refresh_tasks_offer_id_offers_id_fk" FOREIGN KEY ("offer_id") REFERENCES "public"."offers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "catalog_source_distributions_source_key" ON "catalog_source_distributions" USING btree ("source_id");--> statement-breakpoint
CREATE UNIQUE INDEX "catalog_source_freshness_policies_version_key" ON "catalog_source_freshness_policies" USING btree ("source_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "catalog_source_freshness_policies_active_key" ON "catalog_source_freshness_policies" USING btree ("source_id") WHERE "catalog_source_freshness_policies"."status" = 'active';--> statement-breakpoint
CREATE INDEX "catalog_source_freshness_policies_source_idx" ON "catalog_source_freshness_policies" USING btree ("source_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "catalog_source_refresh_leases_source_slot_key" ON "catalog_source_refresh_leases" USING btree ("source_id","slot");--> statement-breakpoint
CREATE INDEX "catalog_source_refresh_leases_source_free_idx" ON "catalog_source_refresh_leases" USING btree ("source_id","lease_until");--> statement-breakpoint
CREATE UNIQUE INDEX "catalog_source_run_quarantines_run_kind_key" ON "catalog_source_run_quarantines" USING btree ("run_id","kind");--> statement-breakpoint
CREATE INDEX "catalog_source_run_quarantines_open_idx" ON "catalog_source_run_quarantines" USING btree ("source_id","created_at") WHERE "catalog_source_run_quarantines"."resolution" is null;--> statement-breakpoint
CREATE INDEX "catalog_source_run_quarantines_source_idx" ON "catalog_source_run_quarantines" USING btree ("source_id","kind","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "offer_refresh_tasks_convergence_key" ON "offer_refresh_tasks" USING btree ("source_id","mode","subject_key");--> statement-breakpoint
CREATE INDEX "offer_refresh_tasks_pending_idx" ON "offer_refresh_tasks" USING btree ("priority_rank","available_at","created_at") WHERE "offer_refresh_tasks"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "offer_refresh_tasks_reclaim_idx" ON "offer_refresh_tasks" USING btree ("lease_until","created_at") WHERE "offer_refresh_tasks"."status" = 'processing';--> statement-breakpoint
CREATE INDEX "offer_refresh_tasks_source_idx" ON "offer_refresh_tasks" USING btree ("source_id","status","available_at");--> statement-breakpoint
CREATE INDEX "offer_refresh_tasks_offer_idx" ON "offer_refresh_tasks" USING btree ("offer_id") WHERE "offer_refresh_tasks"."offer_id" is not null;--> statement-breakpoint
ALTER TABLE "offers" ADD CONSTRAINT "offers_declared_unavailable_shape_check" CHECK ("offers"."declared_unavailable_at" is null or "offers"."kind" <> 'native');--> statement-breakpoint
ALTER TABLE "offers" ADD CONSTRAINT "offers_source_unavailable_reason_check" CHECK ("offers"."retirement_reason" is distinct from 'source_unavailable'
          or "offers"."declared_unavailable_at" is not null);--> statement-breakpoint
ALTER TABLE "offers" ADD CONSTRAINT "offers_retirement_reason_check" CHECK ("offers"."retirement_reason" in ('source_disappeared', 'source_expired', 'listing_unpublished', 'variant_removed', 'superseded', 'operator', 'source_unavailable'));--> statement-breakpoint
ALTER TABLE "catalog_source_objects" ADD CONSTRAINT "catalog_source_objects_retirement_kind_check" CHECK ("catalog_source_objects"."retirement_kind" in ('explicit_removal', 'snapshot_omission', 'ttl_expiry'));--> statement-breakpoint
ALTER TABLE "catalog_source_runs" ADD CONSTRAINT "catalog_source_runs_refresh_mode_check" CHECK ("catalog_source_runs"."refresh_mode" in ('full_snapshot', 'incremental', 'query_driven', 'targeted'));--> statement-breakpoint
ALTER TABLE "catalog_source_runs" ADD CONSTRAINT "catalog_source_runs_target_shape_check" CHECK (("catalog_source_runs"."refresh_mode" = 'targeted')
          = (coalesce(array_length("catalog_source_runs"."target_external_ids", 1), 0) >= 1));--> statement-breakpoint
ALTER TABLE "catalog_source_runs" ADD CONSTRAINT "catalog_source_runs_complete_mode_check" CHECK (not "catalog_source_runs"."enumeration_complete"
          or "catalog_source_runs"."refresh_mode" in ('full_snapshot'));--> statement-breakpoint
ALTER TABLE "catalog_source_runs" ADD CONSTRAINT "catalog_source_runs_counters_non_negative_check" CHECK ("catalog_source_runs"."fetched" >= 0 and "catalog_source_runs"."stored" >= 0 and "catalog_source_runs"."unchanged" >= 0 and "catalog_source_runs"."rejected" >= 0
          and "catalog_source_runs"."quarantined" >= 0 and "catalog_source_runs"."matched" >= 0 and "catalog_source_runs"."review_required" >= 0
          and "catalog_source_runs"."unmatched" >= 0 and "catalog_source_runs"."offers_upserted" >= 0 and "catalog_source_runs"."offers_retired" >= 0
          and "catalog_source_runs"."offers_removed" >= 0
          and "catalog_source_runs"."fetch_count" >= 0 and "catalog_source_runs"."fetch_duration_ms" >= 0 and "catalog_source_runs"."rate_limit_hits" >= 0
          and "catalog_source_runs"."attempts" >= 0);--> statement-breakpoint
-- #68 — a published freshness version is FROZEN once it leaves `draft`.
--
-- The `fee_schedules` mechanism, third outing (#88, #62), and the reason it is
-- a trigger rather than a CHECK is that a CHECK cannot see the OLD row: the
-- rule is about a TRANSITION, not about a value. What it protects is not
-- tidiness — these durations encode contractual obligations (a negotiated cache
-- term, a retention rule), so an UPDATE that overwrote them would destroy the
-- only record of what Mercaria had agreed to, and "what were the terms in
-- March" would stop being answerable.
--
-- `status` and `superseded_at` are deliberately NOT frozen: superseding is the
-- supported way a version ends, and `publishFreshnessPolicy` performs exactly
-- that UPDATE before inserting the successor.
--
-- DELETE is refused for anything past `draft`, matching
-- `catalog_source_policies_immutable` one table over.
CREATE OR REPLACE FUNCTION mercaria_catalog_source_freshness_policy_immutable()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN
      RAISE EXCEPTION
        'catalog_source_freshness_policies % (source %, v%) is % and cannot be deleted; offers were assessed under this version',
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
     OR NEW.expected_refresh_interval_seconds IS DISTINCT FROM OLD.expected_refresh_interval_seconds
     OR NEW.warning_after_seconds IS DISTINCT FROM OLD.warning_after_seconds
     OR NEW.expiry_after_seconds IS DISTINCT FROM OLD.expiry_after_seconds
     OR NEW.outage_grace_seconds IS DISTINCT FROM OLD.outage_grace_seconds
     OR NEW.retire_on_source_unavailable IS DISTINCT FROM OLD.retire_on_source_unavailable
     OR NEW.permitted_refresh_modes IS DISTINCT FROM OLD.permitted_refresh_modes
     OR NEW.anomaly_minimum_sample_size IS DISTINCT FROM OLD.anomaly_minimum_sample_size
     OR NEW.anomaly_zero_price_share_bps IS DISTINCT FROM OLD.anomaly_zero_price_share_bps
     OR NEW.anomaly_price_scale_factor IS DISTINCT FROM OLD.anomaly_price_scale_factor
     OR NEW.anomaly_disappearance_share_bps IS DISTINCT FROM OLD.anomaly_disappearance_share_bps
     OR NEW.reviewed_at IS DISTINCT FROM OLD.reviewed_at
     OR NEW.reviewed_by_oxy_user_id IS DISTINCT FROM OLD.reviewed_by_oxy_user_id
     OR NEW.review_note IS DISTINCT FROM OLD.review_note
     OR NEW.activated_at IS DISTINCT FROM OLD.activated_at
     OR NEW.supersedes_version IS DISTINCT FROM OLD.supersedes_version THEN
    RAISE EXCEPTION
      'catalog_source_freshness_policies % (source %, v%) is % and its thresholds are frozen; publish a new version instead',
      OLD.id, OLD.source_id, OLD.version, OLD.status
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
DROP TRIGGER IF EXISTS catalog_source_freshness_policies_immutable ON "catalog_source_freshness_policies";--> statement-breakpoint
CREATE TRIGGER catalog_source_freshness_policies_immutable
  BEFORE UPDATE OR DELETE ON "catalog_source_freshness_policies"
  FOR EACH ROW EXECUTE FUNCTION mercaria_catalog_source_freshness_policy_immutable();
