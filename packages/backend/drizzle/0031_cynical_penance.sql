-- oxy:deploy-phase=pre
-- oxy:rollback=restore: attribute_reindex_requests_reason_check and native_listing_links_method_check are widened here; the previous forms are in 0024 and 0019 and re-adding either fails against rows carrying the values this file admitted
-- The native-catalogue backfill (#60, ADR 0002 D23/D24): three new tables and
-- two WIDENED value sets. Purely additive, so it is safe against the image still
-- serving AND the one about to.
--
-- The two widenings are `DROP CONSTRAINT` + `ADD CONSTRAINT` on a STRICTLY
-- LARGER value set, which is why they belong in `pre` rather than `post`: the
-- previous image never writes `backfill` for either column, so nothing it does
-- can fail against the new CHECK, and the new image cannot write it until this
-- has run.
--
--  * `native_listing_links.method` gains `backfill` — an attachment whose
--    canonical side was MINTED from the native side by the migration, which is
--    different provenance from a connector declaring its own product identity.
--  * `attribute_reindex_requests.reason` gains `backfill` — #61's drain has to
--    be able to tell a migration wave from ordinary editorial churn.
--
-- Two triggers are appended at the end (drizzle-kit cannot model them). Both
-- protect the honesty of the report rather than its shape:
--   * a run's counters may never go DOWN;
--   * a record's IDENTITY may never move.

CREATE TABLE "catalog_backfill_records" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"stage" text NOT NULL,
	"mode" text NOT NULL,
	"mapping_version" integer NOT NULL,
	"subject_kind" text NOT NULL,
	"subject_key" text NOT NULL,
	"outcome" text NOT NULL,
	"reason_code" text NOT NULL,
	"detail" text,
	"canonical_product_id" text,
	"canonical_variant_id" text,
	"attempts" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "catalog_backfill_records_stage_check" CHECK ("catalog_backfill_records"."stage" in ('store_merchants', 'vendor_brand_candidates', 'variant_matching', 'provisional_products', 'native_offers', 'rebuild_projections', 'search_reindex', 'consistency')),
	CONSTRAINT "catalog_backfill_records_mode_check" CHECK ("catalog_backfill_records"."mode" in ('dry_run', 'apply')),
	CONSTRAINT "catalog_backfill_records_subject_kind_check" CHECK ("catalog_backfill_records"."subject_kind" in ('store', 'listing', 'product_variant', 'vendor_value', 'canonical_product', 'native_offer')),
	CONSTRAINT "catalog_backfill_records_outcome_check" CHECK ("catalog_backfill_records"."outcome" in ('unchanged', 'matched', 'created', 'enqueued', 'review_required', 'unmatched', 'skipped', 'failed')),
	CONSTRAINT "catalog_backfill_records_reason_check" CHECK ("catalog_backfill_records"."reason_code" in ('merchant_minted', 'store_already_linked', 'store_not_active', 'store_owner_unresolved', 'store_link_conflict', 'vendor_candidate_recorded', 'vendor_candidate_unchanged', 'vendor_candidate_ambiguous', 'match_enqueued', 'provisional_product_minted', 'variant_attached', 'attachment_exists', 'blocked_by_decision', 'awaiting_match_decision', 'p2p_left_unattached', 'identifier_disputed', 'offer_convergence_enqueued', 'no_active_attachment', 'projection_refreshed', 'projection_current', 'reindex_requested', 'reindex_disabled', 'consistent', 'offer_missing_for_attachment', 'offer_listing_not_active', 'offer_link_missing', 'offer_variant_mismatch', 'out_of_cohort', 'write_publication_disabled', 'record_error')),
	CONSTRAINT "catalog_backfill_records_mapping_version_check" CHECK ("catalog_backfill_records"."mapping_version" >= 1),
	CONSTRAINT "catalog_backfill_records_attempts_check" CHECK ("catalog_backfill_records"."attempts" >= 1),
	CONSTRAINT "catalog_backfill_records_subject_key_check" CHECK (btrim("catalog_backfill_records"."subject_key") <> ''),
	CONSTRAINT "catalog_backfill_records_detail_length_check" CHECK ("catalog_backfill_records"."detail" is null or length("catalog_backfill_records"."detail") <= 2000),
	CONSTRAINT "catalog_backfill_records_canonical_shape_check" CHECK ("catalog_backfill_records"."canonical_variant_id" is null or "catalog_backfill_records"."canonical_product_id" is not null),
	CONSTRAINT "catalog_backfill_records_reason_outcome_check" CHECK (case "catalog_backfill_records"."reason_code" when 'merchant_minted' then "catalog_backfill_records"."outcome" in ('created') when 'store_already_linked' then "catalog_backfill_records"."outcome" in ('unchanged') when 'store_not_active' then "catalog_backfill_records"."outcome" in ('skipped') when 'store_owner_unresolved' then "catalog_backfill_records"."outcome" in ('skipped') when 'store_link_conflict' then "catalog_backfill_records"."outcome" in ('failed') when 'vendor_candidate_recorded' then "catalog_backfill_records"."outcome" in ('created') when 'vendor_candidate_unchanged' then "catalog_backfill_records"."outcome" in ('unchanged') when 'vendor_candidate_ambiguous' then "catalog_backfill_records"."outcome" in ('review_required') when 'match_enqueued' then "catalog_backfill_records"."outcome" in ('enqueued') when 'provisional_product_minted' then "catalog_backfill_records"."outcome" in ('created') when 'variant_attached' then "catalog_backfill_records"."outcome" in ('matched') when 'attachment_exists' then "catalog_backfill_records"."outcome" in ('unchanged') when 'blocked_by_decision' then "catalog_backfill_records"."outcome" in ('review_required') when 'awaiting_match_decision' then "catalog_backfill_records"."outcome" in ('skipped') when 'p2p_left_unattached' then "catalog_backfill_records"."outcome" in ('unmatched') when 'identifier_disputed' then "catalog_backfill_records"."outcome" in ('review_required') when 'offer_convergence_enqueued' then "catalog_backfill_records"."outcome" in ('enqueued') when 'no_active_attachment' then "catalog_backfill_records"."outcome" in ('unmatched') when 'projection_refreshed' then "catalog_backfill_records"."outcome" in ('created') when 'projection_current' then "catalog_backfill_records"."outcome" in ('unchanged') when 'reindex_requested' then "catalog_backfill_records"."outcome" in ('enqueued') when 'reindex_disabled' then "catalog_backfill_records"."outcome" in ('skipped') when 'consistent' then "catalog_backfill_records"."outcome" in ('unchanged') when 'offer_missing_for_attachment' then "catalog_backfill_records"."outcome" in ('review_required') when 'offer_listing_not_active' then "catalog_backfill_records"."outcome" in ('review_required') when 'offer_link_missing' then "catalog_backfill_records"."outcome" in ('review_required') when 'offer_variant_mismatch' then "catalog_backfill_records"."outcome" in ('review_required') when 'out_of_cohort' then "catalog_backfill_records"."outcome" in ('skipped') when 'write_publication_disabled' then "catalog_backfill_records"."outcome" in ('skipped') when 'record_error' then "catalog_backfill_records"."outcome" in ('failed') else false end)
);
--> statement-breakpoint
CREATE TABLE "catalog_backfill_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"stage" text NOT NULL,
	"mode" text NOT NULL,
	"mapping_version" integer NOT NULL,
	"cohort_kind" text NOT NULL,
	"cohort_value" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"cursor" text,
	"scanned" integer DEFAULT 0 NOT NULL,
	"unchanged" integer DEFAULT 0 NOT NULL,
	"matched" integer DEFAULT 0 NOT NULL,
	"created" integer DEFAULT 0 NOT NULL,
	"enqueued" integer DEFAULT 0 NOT NULL,
	"review_required" integer DEFAULT 0 NOT NULL,
	"unmatched" integer DEFAULT 0 NOT NULL,
	"skipped" integer DEFAULT 0 NOT NULL,
	"failed" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"last_run_at" timestamp with time zone,
	"last_error" text,
	"lease_owner" text,
	"lease_until" timestamp with time zone,
	"requested_by_oxy_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "catalog_backfill_runs_stage_check" CHECK ("catalog_backfill_runs"."stage" in ('store_merchants', 'vendor_brand_candidates', 'variant_matching', 'provisional_products', 'native_offers', 'rebuild_projections', 'search_reindex', 'consistency')),
	CONSTRAINT "catalog_backfill_runs_mode_check" CHECK ("catalog_backfill_runs"."mode" in ('dry_run', 'apply')),
	CONSTRAINT "catalog_backfill_runs_status_check" CHECK ("catalog_backfill_runs"."status" in ('pending', 'running', 'paused', 'completed', 'failed')),
	CONSTRAINT "catalog_backfill_runs_cohort_kind_check" CHECK ("catalog_backfill_runs"."cohort_kind" in ('all', 'store', 'category', 'owner_type', 'connector_provider')),
	CONSTRAINT "catalog_backfill_runs_mapping_version_check" CHECK ("catalog_backfill_runs"."mapping_version" >= 1),
	CONSTRAINT "catalog_backfill_runs_cohort_shape_check" CHECK (("catalog_backfill_runs"."cohort_kind" = 'all') = ("catalog_backfill_runs"."cohort_value" is null)),
	CONSTRAINT "catalog_backfill_runs_counters_non_negative_check" CHECK ("catalog_backfill_runs"."scanned" >= 0 and "catalog_backfill_runs"."unchanged" >= 0 and "catalog_backfill_runs"."matched" >= 0 and "catalog_backfill_runs"."created" >= 0
          and "catalog_backfill_runs"."enqueued" >= 0 and "catalog_backfill_runs"."review_required" >= 0 and "catalog_backfill_runs"."unmatched" >= 0
          and "catalog_backfill_runs"."skipped" >= 0 and "catalog_backfill_runs"."failed" >= 0),
	CONSTRAINT "catalog_backfill_runs_counters_total_check" CHECK ("catalog_backfill_runs"."scanned" = "catalog_backfill_runs"."unchanged" + "catalog_backfill_runs"."matched" + "catalog_backfill_runs"."created" + "catalog_backfill_runs"."enqueued"
          + "catalog_backfill_runs"."review_required" + "catalog_backfill_runs"."unmatched" + "catalog_backfill_runs"."skipped" + "catalog_backfill_runs"."failed"),
	CONSTRAINT "catalog_backfill_runs_completed_shape_check" CHECK ("catalog_backfill_runs"."status" <> 'completed' or ("catalog_backfill_runs"."completed_at" is not null and "catalog_backfill_runs"."cursor" is null)),
	CONSTRAINT "catalog_backfill_runs_started_shape_check" CHECK (("catalog_backfill_runs"."status" = 'pending') = ("catalog_backfill_runs"."started_at" is null)),
	CONSTRAINT "catalog_backfill_runs_lease_complete_check" CHECK (num_nonnulls("catalog_backfill_runs"."lease_owner", "catalog_backfill_runs"."lease_until") in (0, 2)),
	CONSTRAINT "catalog_backfill_runs_last_error_length_check" CHECK ("catalog_backfill_runs"."last_error" is null or length("catalog_backfill_runs"."last_error") <= 2000),
	CONSTRAINT "catalog_backfill_runs_requested_by_check" CHECK (btrim("catalog_backfill_runs"."requested_by_oxy_user_id") <> '')
);
--> statement-breakpoint
CREATE TABLE "catalog_consistency_findings" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"subject_kind" text NOT NULL,
	"subject_key" text NOT NULL,
	"detail" text,
	"last_run_id" text,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "catalog_consistency_findings_kind_check" CHECK ("catalog_consistency_findings"."kind" in ('attached_variant_without_offer', 'offer_without_active_listing', 'offer_without_active_link', 'offer_canonical_variant_mismatch')),
	CONSTRAINT "catalog_consistency_findings_subject_kind_check" CHECK ("catalog_consistency_findings"."subject_kind" in ('store', 'listing', 'product_variant', 'vendor_value', 'canonical_product', 'native_offer')),
	CONSTRAINT "catalog_consistency_findings_subject_key_check" CHECK (btrim("catalog_consistency_findings"."subject_key") <> ''),
	CONSTRAINT "catalog_consistency_findings_detail_length_check" CHECK ("catalog_consistency_findings"."detail" is null or length("catalog_consistency_findings"."detail") <= 2000),
	CONSTRAINT "catalog_consistency_findings_seen_order_check" CHECK ("catalog_consistency_findings"."last_seen_at" >= "catalog_consistency_findings"."first_seen_at"),
	CONSTRAINT "catalog_consistency_findings_resolved_order_check" CHECK ("catalog_consistency_findings"."resolved_at" is null or "catalog_consistency_findings"."resolved_at" >= "catalog_consistency_findings"."first_seen_at")
);
--> statement-breakpoint
ALTER TABLE "attribute_reindex_requests" DROP CONSTRAINT "attribute_reindex_requests_reason_check";--> statement-breakpoint
ALTER TABLE "native_listing_links" DROP CONSTRAINT "native_listing_links_method_check";--> statement-breakpoint
ALTER TABLE "catalog_backfill_records" ADD CONSTRAINT "catalog_backfill_records_run_id_catalog_backfill_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."catalog_backfill_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_backfill_records" ADD CONSTRAINT "catalog_backfill_records_canonical_product_id_canonical_products_id_fk" FOREIGN KEY ("canonical_product_id") REFERENCES "public"."canonical_products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_backfill_records" ADD CONSTRAINT "catalog_backfill_records_canonical_variant_id_canonical_variants_id_fk" FOREIGN KEY ("canonical_variant_id") REFERENCES "public"."canonical_variants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_consistency_findings" ADD CONSTRAINT "catalog_consistency_findings_last_run_id_catalog_backfill_runs_id_fk" FOREIGN KEY ("last_run_id") REFERENCES "public"."catalog_backfill_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "catalog_backfill_records_subject_key" ON "catalog_backfill_records" USING btree ("mapping_version","mode","stage","subject_key");--> statement-breakpoint
CREATE INDEX "catalog_backfill_records_run_idx" ON "catalog_backfill_records" USING btree ("run_id","outcome");--> statement-breakpoint
CREATE INDEX "catalog_backfill_records_subject_idx" ON "catalog_backfill_records" USING btree ("subject_key");--> statement-breakpoint
CREATE INDEX "catalog_backfill_records_outcome_idx" ON "catalog_backfill_records" USING btree ("mapping_version","mode","outcome");--> statement-breakpoint
CREATE UNIQUE INDEX "catalog_backfill_runs_open_key" ON "catalog_backfill_runs" USING btree ("stage","mode","mapping_version","cohort_kind","cohort_value") WHERE "catalog_backfill_runs"."status" in ('pending', 'running', 'paused');--> statement-breakpoint
CREATE INDEX "catalog_backfill_runs_claimable_idx" ON "catalog_backfill_runs" USING btree ("created_at") WHERE "catalog_backfill_runs"."status" in ('pending', 'paused');--> statement-breakpoint
CREATE INDEX "catalog_backfill_runs_reclaim_idx" ON "catalog_backfill_runs" USING btree ("lease_until") WHERE "catalog_backfill_runs"."status" = 'running';--> statement-breakpoint
CREATE INDEX "catalog_backfill_runs_mapping_idx" ON "catalog_backfill_runs" USING btree ("mapping_version","stage");--> statement-breakpoint
CREATE UNIQUE INDEX "catalog_consistency_findings_open_key" ON "catalog_consistency_findings" USING btree ("kind","subject_key") WHERE "catalog_consistency_findings"."resolved_at" is null;--> statement-breakpoint
CREATE INDEX "catalog_consistency_findings_open_idx" ON "catalog_consistency_findings" USING btree ("kind","last_seen_at") WHERE "catalog_consistency_findings"."resolved_at" is null;--> statement-breakpoint
CREATE INDEX "catalog_consistency_findings_subject_idx" ON "catalog_consistency_findings" USING btree ("subject_key");--> statement-breakpoint
ALTER TABLE "attribute_reindex_requests" ADD CONSTRAINT "attribute_reindex_requests_reason_check" CHECK ("attribute_reindex_requests"."reason" in ('selected_value_changed', 'definition_published', 'definition_deprecated', 'normalization_rules_changed', 'operator_correction', 'backfill'));--> statement-breakpoint
ALTER TABLE "native_listing_links" ADD CONSTRAINT "native_listing_links_method_check" CHECK ("native_listing_links"."method" in ('barcode_gtin', 'connector_declared', 'operator', 'matcher', 'backfill'));

--> statement-breakpoint
-- A run's counters may only ever GO UP.
--
-- A pass is many bounded pages and every page ADDS to the same row
-- (`advanceBackfillRun` is `scanned = scanned + $n`), so no legitimate write ever
-- lowers one. A rewrite that did would hide a page that failed — and the report
-- is the only durable evidence of what a migration touched, which is exactly the
-- thing that must not be quietly editable after the fact.
--
-- `catalog_backfill_runs_counters_total_check` already forces the outcome
-- counters to SUM to `scanned`, so between the two a page cannot swallow a
-- record and cannot erase one either.
CREATE OR REPLACE FUNCTION mercaria_backfill_run_counters_monotonic()
RETURNS trigger AS $$
BEGIN
  IF NEW.scanned < OLD.scanned
     OR NEW.unchanged < OLD.unchanged
     OR NEW.matched < OLD.matched
     OR NEW.created < OLD.created
     OR NEW.enqueued < OLD.enqueued
     OR NEW.review_required < OLD.review_required
     OR NEW.unmatched < OLD.unmatched
     OR NEW.skipped < OLD.skipped
     OR NEW.failed < OLD.failed THEN
    RAISE EXCEPTION 'catalog_backfill_runs counters are monotonic: run % may not lower a counter', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER mercaria_backfill_run_counters_monotonic
BEFORE UPDATE ON "catalog_backfill_runs"
FOR EACH ROW EXECUTE FUNCTION mercaria_backfill_run_counters_monotonic();--> statement-breakpoint

-- A report row's IDENTITY is immutable.
--
-- The OUTCOME of a subject may legitimately change on a re-run — that is what
-- `recordBackfillOutcome`'s upsert is for. WHICH subject a row is about may not,
-- or the dry-run report and the apply report stop being comparable, which is the
-- only thing they exist for. `run_id` is deliberately NOT in the list: it names
-- the run that LAST examined the subject and moves with every re-run.
CREATE OR REPLACE FUNCTION mercaria_backfill_record_identity_immutable()
RETURNS trigger AS $$
BEGIN
  IF NEW.mapping_version IS DISTINCT FROM OLD.mapping_version
     OR NEW.mode IS DISTINCT FROM OLD.mode
     OR NEW.stage IS DISTINCT FROM OLD.stage
     OR NEW.subject_kind IS DISTINCT FROM OLD.subject_kind
     OR NEW.subject_key IS DISTINCT FROM OLD.subject_key THEN
    RAISE EXCEPTION 'catalog_backfill_records identity is immutable: record % may not change subject', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER mercaria_backfill_record_identity_immutable
BEFORE UPDATE ON "catalog_backfill_records"
FOR EACH ROW EXECUTE FUNCTION mercaria_backfill_record_identity_immutable();
