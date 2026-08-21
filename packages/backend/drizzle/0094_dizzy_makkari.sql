-- oxy:deploy-phase=pre
-- oxy:rollback=derived
-- Five new tables plus their triggers. Every statement is additive: the
-- serving image performs no write these constrain, because it has no code
-- that touches these tables at all.
CREATE TABLE "catalog_external_mapping_reviews" (
	"id" text PRIMARY KEY NOT NULL,
	"catalog_source_id" text NOT NULL,
	"dimension" text NOT NULL,
	"external_key" text NOT NULL,
	"external_key_normalized" text GENERATED ALWAYS AS (lower(btrim("external_key"))) STORED NOT NULL,
	"external_label" text,
	"external_path" text[] DEFAULT '{}'::text[] NOT NULL,
	"observed_raw_value" text,
	"source_record_id" text,
	"reason" text NOT NULL,
	"state" text DEFAULT 'open' NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"occurrences" integer DEFAULT 1 NOT NULL,
	"first_observed_at" timestamp with time zone NOT NULL,
	"last_observed_at" timestamp with time zone NOT NULL,
	"candidate_mapping_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"summary" text NOT NULL,
	"resolved_mapping_id" text,
	"resolved_by_oxy_user_id" text,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "catalog_external_mapping_reviews_dimension_check" CHECK ("catalog_external_mapping_reviews"."dimension" in ('product_type', 'attribute', 'controlled_value', 'unit', 'size_system')),
	CONSTRAINT "catalog_external_mapping_reviews_reason_check" CHECK ("catalog_external_mapping_reviews"."reason" in ('unmapped', 'ambiguous_candidates', 'fan_out_unapproved', 'target_unresolvable', 'legacy_disagreement', 'transform_refused', 'registry_unavailable')),
	CONSTRAINT "catalog_external_mapping_reviews_state_check" CHECK ("catalog_external_mapping_reviews"."state" in ('open', 'resolved', 'dismissed')),
	CONSTRAINT "catalog_external_mapping_reviews_external_key_shape_check" CHECK (btrim("catalog_external_mapping_reviews"."external_key") <> '' and length("catalog_external_mapping_reviews"."external_key") <= 512),
	CONSTRAINT "catalog_external_mapping_reviews_resolution_check" CHECK (("catalog_external_mapping_reviews"."state" = 'open') = ("catalog_external_mapping_reviews"."resolved_at" is null and "catalog_external_mapping_reviews"."resolved_by_oxy_user_id" is null)),
	CONSTRAINT "catalog_external_mapping_reviews_resolved_mapping_check" CHECK (("catalog_external_mapping_reviews"."state" = 'resolved') = ("catalog_external_mapping_reviews"."resolved_mapping_id" is not null)),
	CONSTRAINT "catalog_external_mapping_reviews_occurrences_check" CHECK ("catalog_external_mapping_reviews"."occurrences" >= 1),
	CONSTRAINT "catalog_external_mapping_reviews_priority_check" CHECK ("catalog_external_mapping_reviews"."priority" >= 0),
	CONSTRAINT "catalog_external_mapping_reviews_observed_order_check" CHECK ("catalog_external_mapping_reviews"."last_observed_at" >= "catalog_external_mapping_reviews"."first_observed_at"),
	CONSTRAINT "catalog_external_mapping_reviews_candidates_check" CHECK (cardinality("catalog_external_mapping_reviews"."candidate_mapping_ids") = 0 or "catalog_external_mapping_reviews"."reason" = 'ambiguous_candidates'),
	CONSTRAINT "catalog_external_mapping_reviews_path_bound_check" CHECK (cardinality("catalog_external_mapping_reviews"."external_path") <= 32)
);
--> statement-breakpoint
CREATE TABLE "catalog_external_mapping_run_items" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"subject_kind" text NOT NULL,
	"subject_key" text NOT NULL,
	"external_key" text NOT NULL,
	"outcome" text NOT NULL,
	"previous_mapping_id" text,
	"next_mapping_id" text,
	"detail" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "catalog_external_mapping_run_items_subject_kind_check" CHECK ("catalog_external_mapping_run_items"."subject_kind" in ('catalog_source_object', 'source_record', 'operator_probe')),
	CONSTRAINT "catalog_external_mapping_run_items_outcome_check" CHECK ("catalog_external_mapping_run_items"."outcome" in ('unchanged', 'retargeted', 'newly_mapped', 'unmapped_now', 'refused', 'skipped')),
	CONSTRAINT "catalog_external_mapping_run_items_outcome_shape_check" CHECK (case "catalog_external_mapping_run_items"."outcome"
        when 'unchanged' then "catalog_external_mapping_run_items"."previous_mapping_id" is not distinct from "catalog_external_mapping_run_items"."next_mapping_id"
        when 'retargeted' then "catalog_external_mapping_run_items"."previous_mapping_id" is not null and "catalog_external_mapping_run_items"."next_mapping_id" is not null
                              and "catalog_external_mapping_run_items"."previous_mapping_id" <> "catalog_external_mapping_run_items"."next_mapping_id"
        when 'newly_mapped' then "catalog_external_mapping_run_items"."previous_mapping_id" is null and "catalog_external_mapping_run_items"."next_mapping_id" is not null
        when 'unmapped_now' then "catalog_external_mapping_run_items"."previous_mapping_id" is not null and "catalog_external_mapping_run_items"."next_mapping_id" is null
        when 'refused' then "catalog_external_mapping_run_items"."next_mapping_id" is null and "catalog_external_mapping_run_items"."detail" is not null
        when 'skipped' then "catalog_external_mapping_run_items"."next_mapping_id" is null and "catalog_external_mapping_run_items"."detail" is not null
        else false
      end)
);
--> statement-breakpoint
CREATE TABLE "catalog_external_mapping_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"catalog_source_id" text NOT NULL,
	"dimension" text,
	"mapping_id" text,
	"mapping_version" integer,
	"mode" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"requested_by_oxy_user_id" text NOT NULL,
	"cursor_external_key" text,
	"scanned" integer DEFAULT 0 NOT NULL,
	"unchanged" integer DEFAULT 0 NOT NULL,
	"retargeted" integer DEFAULT 0 NOT NULL,
	"newly_mapped" integer DEFAULT 0 NOT NULL,
	"unmapped_now" integer DEFAULT 0 NOT NULL,
	"refused" integer DEFAULT 0 NOT NULL,
	"skipped" integer DEFAULT 0 NOT NULL,
	"claimed_at" timestamp with time zone,
	"claimed_by" text,
	"claim_expires_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "catalog_external_mapping_runs_dimension_check" CHECK ("catalog_external_mapping_runs"."dimension" in ('product_type', 'attribute', 'controlled_value', 'unit', 'size_system')),
	CONSTRAINT "catalog_external_mapping_runs_mode_check" CHECK ("catalog_external_mapping_runs"."mode" in ('dry_run', 'apply')),
	CONSTRAINT "catalog_external_mapping_runs_state_check" CHECK ("catalog_external_mapping_runs"."state" in ('pending', 'running', 'completed', 'failed')),
	CONSTRAINT "catalog_external_mapping_runs_counters_total_check" CHECK ("catalog_external_mapping_runs"."scanned" = "catalog_external_mapping_runs"."unchanged" + "catalog_external_mapping_runs"."retargeted" + "catalog_external_mapping_runs"."newly_mapped" + "catalog_external_mapping_runs"."unmapped_now" + "catalog_external_mapping_runs"."refused" + "catalog_external_mapping_runs"."skipped"),
	CONSTRAINT "catalog_external_mapping_runs_counters_sign_check" CHECK ("catalog_external_mapping_runs"."scanned" >= 0 and "catalog_external_mapping_runs"."unchanged" >= 0 and "catalog_external_mapping_runs"."retargeted" >= 0
        and "catalog_external_mapping_runs"."newly_mapped" >= 0 and "catalog_external_mapping_runs"."unmapped_now" >= 0 and "catalog_external_mapping_runs"."refused" >= 0
        and "catalog_external_mapping_runs"."skipped" >= 0),
	CONSTRAINT "catalog_external_mapping_runs_claim_check" CHECK (num_nonnulls("catalog_external_mapping_runs"."claimed_at", "catalog_external_mapping_runs"."claimed_by", "catalog_external_mapping_runs"."claim_expires_at") in (0, 3)),
	CONSTRAINT "catalog_external_mapping_runs_finished_check" CHECK (("catalog_external_mapping_runs"."state" in ('completed', 'failed')) = ("catalog_external_mapping_runs"."finished_at" is not null)),
	CONSTRAINT "catalog_external_mapping_runs_failure_check" CHECK ("catalog_external_mapping_runs"."state" <> 'failed' or "catalog_external_mapping_runs"."last_error" is not null),
	CONSTRAINT "catalog_external_mapping_runs_mapping_version_check" CHECK ("catalog_external_mapping_runs"."mapping_version" is null or "catalog_external_mapping_runs"."mapping_version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "catalog_external_mappings" (
	"id" text PRIMARY KEY NOT NULL,
	"catalog_source_id" text NOT NULL,
	"dimension" text NOT NULL,
	"external_key" text NOT NULL,
	"external_key_normalized" text GENERATED ALWAYS AS (lower(btrim("external_key"))) STORED NOT NULL,
	"external_label" text,
	"external_path" text[] DEFAULT '{}'::text[] NOT NULL,
	"external_locale" text,
	"target_product_type_key" text,
	"target_attribute_key" text,
	"target_controlled_value" text,
	"target_unit_family" text,
	"target_unit_code" text,
	"target_size_system_key" text,
	"reviewed_product_type_definition_id" text,
	"transform_rule" text DEFAULT 'identity' NOT NULL,
	"transform_rule_version" integer DEFAULT 1 NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"supersedes_mapping_id" text,
	"state" text DEFAULT 'proposed' NOT NULL,
	"provenance" text NOT NULL,
	"confidence" double precision NOT NULL,
	"evidence_source_record_id" text,
	"evidence_note" text,
	"valid_from" timestamp with time zone NOT NULL,
	"valid_to" timestamp with time zone,
	"proposed_by_oxy_user_id" text,
	"reviewed_by_oxy_user_id" text,
	"reviewed_at" timestamp with time zone,
	"approved_by_oxy_user_id" text,
	"approved_at" timestamp with time zone,
	"rejected_reason" text,
	"fan_out_approved_by_oxy_user_id" text,
	"fan_out_approved_at" timestamp with time zone,
	"fan_out_rationale" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "catalog_external_mappings_dimension_check" CHECK ("catalog_external_mappings"."dimension" in ('product_type', 'attribute', 'controlled_value', 'unit', 'size_system')),
	CONSTRAINT "catalog_external_mappings_state_check" CHECK ("catalog_external_mappings"."state" in ('proposed', 'in_review', 'approved', 'rejected', 'superseded')),
	CONSTRAINT "catalog_external_mappings_provenance_check" CHECK ("catalog_external_mappings"."provenance" in ('operator', 'source_declared', 'official_crosswalk', 'imported_legacy', 'heuristic_suggestion')),
	CONSTRAINT "catalog_external_mappings_transform_rule_check" CHECK ("catalog_external_mappings"."transform_rule" in ('identity', 'trim', 'case_fold', 'collapse_whitespace', 'strip_diacritics', 'path_leaf', 'unit_magnitude_to_base', 'decimal_separator_normalize')),
	CONSTRAINT "catalog_external_mappings_unit_family_check" CHECK ("catalog_external_mappings"."target_unit_family" in ('length', 'mass', 'volume', 'digital_storage', 'duration', 'power', 'energy', 'frequency', 'data_rate', 'pixel_count', 'luminance', 'electric_charge', 'count', 'percentage', 'ratio', 'rating')),
	CONSTRAINT "catalog_external_mappings_target_shape_check" CHECK (case "catalog_external_mappings"."dimension"
        when 'product_type' then
          "catalog_external_mappings"."target_product_type_key" is not null
          and num_nonnulls("catalog_external_mappings"."target_attribute_key", "catalog_external_mappings"."target_controlled_value",
                           "catalog_external_mappings"."target_unit_family", "catalog_external_mappings"."target_unit_code",
                           "catalog_external_mappings"."target_size_system_key") = 0
        when 'attribute' then
          "catalog_external_mappings"."target_attribute_key" is not null
          and num_nonnulls("catalog_external_mappings"."target_product_type_key", "catalog_external_mappings"."target_controlled_value",
                           "catalog_external_mappings"."target_unit_family", "catalog_external_mappings"."target_unit_code",
                           "catalog_external_mappings"."target_size_system_key") = 0
        when 'controlled_value' then
          "catalog_external_mappings"."target_attribute_key" is not null and "catalog_external_mappings"."target_controlled_value" is not null
          and num_nonnulls("catalog_external_mappings"."target_product_type_key", "catalog_external_mappings"."target_unit_family",
                           "catalog_external_mappings"."target_unit_code", "catalog_external_mappings"."target_size_system_key") = 0
        when 'unit' then
          "catalog_external_mappings"."target_unit_family" is not null and "catalog_external_mappings"."target_unit_code" is not null
          and num_nonnulls("catalog_external_mappings"."target_product_type_key", "catalog_external_mappings"."target_attribute_key",
                           "catalog_external_mappings"."target_controlled_value", "catalog_external_mappings"."target_size_system_key") = 0
        when 'size_system' then
          "catalog_external_mappings"."target_size_system_key" is not null
          and num_nonnulls("catalog_external_mappings"."target_product_type_key", "catalog_external_mappings"."target_attribute_key",
                           "catalog_external_mappings"."target_controlled_value", "catalog_external_mappings"."target_unit_family",
                           "catalog_external_mappings"."target_unit_code") = 0
        else false
      end),
	CONSTRAINT "catalog_external_mappings_external_key_shape_check" CHECK (btrim("catalog_external_mappings"."external_key") <> '' and length("catalog_external_mappings"."external_key") <= 512),
	CONSTRAINT "catalog_external_mappings_external_path_bound_check" CHECK (cardinality("catalog_external_mappings"."external_path") <= 32),
	CONSTRAINT "catalog_external_mappings_external_locale_shape_check" CHECK ("catalog_external_mappings"."external_locale" is null or "catalog_external_mappings"."external_locale" ~ '^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$'),
	CONSTRAINT "catalog_external_mappings_attribute_key_shape_check" CHECK ("catalog_external_mappings"."target_attribute_key" is null or "catalog_external_mappings"."target_attribute_key" ~ '^[a-z][a-z0-9_]*$'),
	CONSTRAINT "catalog_external_mappings_product_type_key_shape_check" CHECK ("catalog_external_mappings"."target_product_type_key" is null or "catalog_external_mappings"."target_product_type_key" ~ '^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$'),
	CONSTRAINT "catalog_external_mappings_size_system_key_shape_check" CHECK ("catalog_external_mappings"."target_size_system_key" is null or "catalog_external_mappings"."target_size_system_key" ~ '^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$'),
	CONSTRAINT "catalog_external_mappings_controlled_value_shape_check" CHECK ("catalog_external_mappings"."target_controlled_value" is null
        or ("catalog_external_mappings"."target_controlled_value" = lower(btrim("catalog_external_mappings"."target_controlled_value"))
            and "catalog_external_mappings"."target_controlled_value" <> '')),
	CONSTRAINT "catalog_external_mappings_unit_code_shape_check" CHECK ("catalog_external_mappings"."target_unit_code" is null or "catalog_external_mappings"."target_unit_code" ~ '^[A-Za-z][A-Za-z0-9_/%]*$'),
	CONSTRAINT "catalog_external_mappings_confidence_range_check" CHECK ("catalog_external_mappings"."confidence" >= 0 and "catalog_external_mappings"."confidence" <= 1),
	CONSTRAINT "catalog_external_mappings_version_check" CHECK ("catalog_external_mappings"."version" >= 1),
	CONSTRAINT "catalog_external_mappings_transform_version_check" CHECK ("catalog_external_mappings"."transform_rule_version" >= 1),
	CONSTRAINT "catalog_external_mappings_reviewed_definition_scope_check" CHECK ("catalog_external_mappings"."reviewed_product_type_definition_id" is null or "catalog_external_mappings"."dimension" = 'product_type'),
	CONSTRAINT "catalog_external_mappings_validity_order_check" CHECK ("catalog_external_mappings"."valid_to" is null or "catalog_external_mappings"."valid_to" > "catalog_external_mappings"."valid_from"),
	CONSTRAINT "catalog_external_mappings_approval_pair_check" CHECK (num_nonnulls("catalog_external_mappings"."approved_at", "catalog_external_mappings"."approved_by_oxy_user_id") in (0, 2)),
	CONSTRAINT "catalog_external_mappings_approved_audited_check" CHECK ("catalog_external_mappings"."state" <> 'approved'
        or ("catalog_external_mappings"."approved_at" is not null and "catalog_external_mappings"."approved_by_oxy_user_id" is not null)),
	CONSTRAINT "catalog_external_mappings_unapproved_clean_check" CHECK ("catalog_external_mappings"."state" in ('approved', 'superseded') or "catalog_external_mappings"."approved_at" is null),
	CONSTRAINT "catalog_external_mappings_rejection_check" CHECK ("catalog_external_mappings"."state" <> 'rejected'
        or ("catalog_external_mappings"."rejected_reason" is not null and "catalog_external_mappings"."reviewed_by_oxy_user_id" is not null
            and "catalog_external_mappings"."reviewed_at" is not null)),
	CONSTRAINT "catalog_external_mappings_review_pair_check" CHECK (num_nonnulls("catalog_external_mappings"."reviewed_at", "catalog_external_mappings"."reviewed_by_oxy_user_id") in (0, 2)),
	CONSTRAINT "catalog_external_mappings_fan_out_triple_check" CHECK (num_nonnulls("catalog_external_mappings"."fan_out_approved_by_oxy_user_id", "catalog_external_mappings"."fan_out_approved_at", "catalog_external_mappings"."fan_out_rationale") in (0, 3)),
	CONSTRAINT "catalog_external_mappings_fan_out_four_eyes_check" CHECK ("catalog_external_mappings"."fan_out_approved_by_oxy_user_id" is null
        or ("catalog_external_mappings"."approved_by_oxy_user_id" is not null
            and "catalog_external_mappings"."fan_out_approved_by_oxy_user_id" <> "catalog_external_mappings"."approved_by_oxy_user_id"))
);
--> statement-breakpoint
CREATE TABLE "catalog_external_token_observations" (
	"id" text PRIMARY KEY NOT NULL,
	"catalog_source_id" text NOT NULL,
	"dimension" text NOT NULL,
	"external_key" text NOT NULL,
	"external_key_normalized" text GENERATED ALWAYS AS (lower(btrim("external_key"))) STORED NOT NULL,
	"subject_kind" text NOT NULL,
	"subject_key" text NOT NULL,
	"observed_raw_value" text,
	"resolved_mapping_id" text,
	"resolution_outcome" text NOT NULL,
	"unresolved_reason" text,
	"first_observed_at" timestamp with time zone NOT NULL,
	"last_observed_at" timestamp with time zone NOT NULL,
	"occurrences" integer DEFAULT 1 NOT NULL,
	"reprocess_requested_at" timestamp with time zone,
	"reprocess_claimed_at" timestamp with time zone,
	"reprocess_claimed_by" text,
	"reprocess_claim_expires_at" timestamp with time zone,
	"reprocessed_at" timestamp with time zone,
	"reprocess_attempts" integer DEFAULT 0 NOT NULL,
	"reprocess_last_error" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "catalog_external_token_observations_dimension_check" CHECK ("catalog_external_token_observations"."dimension" in ('product_type', 'attribute', 'controlled_value', 'unit', 'size_system')),
	CONSTRAINT "catalog_external_token_observations_subject_kind_check" CHECK ("catalog_external_token_observations"."subject_kind" in ('catalog_source_object', 'source_record', 'operator_probe')),
	CONSTRAINT "catalog_external_token_observations_unresolved_reason_check" CHECK ("catalog_external_token_observations"."unresolved_reason" in ('unmapped', 'ambiguous', 'mapping_not_approved', 'mapping_expired', 'target_unresolvable', 'registry_unavailable', 'transform_refused')),
	CONSTRAINT "catalog_external_token_observations_outcome_check" CHECK ("catalog_external_token_observations"."resolution_outcome" in ('resolved', 'unresolved')),
	CONSTRAINT "catalog_external_token_observations_resolved_shape_check" CHECK (("catalog_external_token_observations"."resolution_outcome" = 'resolved') = ("catalog_external_token_observations"."resolved_mapping_id" is not null)),
	CONSTRAINT "catalog_external_token_observations_unresolved_shape_check" CHECK (("catalog_external_token_observations"."resolution_outcome" = 'unresolved') = ("catalog_external_token_observations"."unresolved_reason" is not null)),
	CONSTRAINT "catalog_external_token_observations_external_key_shape_check" CHECK (btrim("catalog_external_token_observations"."external_key") <> '' and length("catalog_external_token_observations"."external_key") <= 512),
	CONSTRAINT "catalog_external_token_observations_occurrences_check" CHECK ("catalog_external_token_observations"."occurrences" >= 1),
	CONSTRAINT "catalog_external_token_observations_observed_order_check" CHECK ("catalog_external_token_observations"."last_observed_at" >= "catalog_external_token_observations"."first_observed_at"),
	CONSTRAINT "catalog_external_token_observations_attempts_check" CHECK ("catalog_external_token_observations"."reprocess_attempts" >= 0),
	CONSTRAINT "catalog_external_token_observations_claim_check" CHECK (num_nonnulls("catalog_external_token_observations"."reprocess_claimed_at", "catalog_external_token_observations"."reprocess_claimed_by", "catalog_external_token_observations"."reprocess_claim_expires_at") in (0, 3)),
	CONSTRAINT "catalog_external_token_observations_reprocess_order_check" CHECK ("catalog_external_token_observations"."reprocessed_at" is null or "catalog_external_token_observations"."reprocess_requested_at" is not null)
);
--> statement-breakpoint
ALTER TABLE "catalog_external_mapping_reviews" ADD CONSTRAINT "catalog_external_mapping_reviews_catalog_source_id_catalog_sources_id_fk" FOREIGN KEY ("catalog_source_id") REFERENCES "public"."catalog_sources"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_external_mapping_reviews" ADD CONSTRAINT "catalog_external_mapping_reviews_source_record_id_source_records_id_fk" FOREIGN KEY ("source_record_id") REFERENCES "public"."source_records"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_external_mapping_reviews" ADD CONSTRAINT "catalog_external_mapping_reviews_resolved_mapping_id_catalog_external_mappings_id_fk" FOREIGN KEY ("resolved_mapping_id") REFERENCES "public"."catalog_external_mappings"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_external_mapping_run_items" ADD CONSTRAINT "catalog_external_mapping_run_items_run_id_catalog_external_mapping_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."catalog_external_mapping_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_external_mapping_run_items" ADD CONSTRAINT "catalog_external_mapping_run_items_previous_mapping_id_catalog_external_mappings_id_fk" FOREIGN KEY ("previous_mapping_id") REFERENCES "public"."catalog_external_mappings"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_external_mapping_run_items" ADD CONSTRAINT "catalog_external_mapping_run_items_next_mapping_id_catalog_external_mappings_id_fk" FOREIGN KEY ("next_mapping_id") REFERENCES "public"."catalog_external_mappings"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_external_mapping_runs" ADD CONSTRAINT "catalog_external_mapping_runs_catalog_source_id_catalog_sources_id_fk" FOREIGN KEY ("catalog_source_id") REFERENCES "public"."catalog_sources"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_external_mapping_runs" ADD CONSTRAINT "catalog_external_mapping_runs_mapping_id_catalog_external_mappings_id_fk" FOREIGN KEY ("mapping_id") REFERENCES "public"."catalog_external_mappings"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_external_mappings" ADD CONSTRAINT "catalog_external_mappings_catalog_source_id_catalog_sources_id_fk" FOREIGN KEY ("catalog_source_id") REFERENCES "public"."catalog_sources"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_external_mappings" ADD CONSTRAINT "catalog_external_mappings_reviewed_product_type_definition_id_product_type_definitions_id_fk" FOREIGN KEY ("reviewed_product_type_definition_id") REFERENCES "public"."product_type_definitions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_external_mappings" ADD CONSTRAINT "catalog_external_mappings_supersedes_mapping_id_catalog_external_mappings_id_fk" FOREIGN KEY ("supersedes_mapping_id") REFERENCES "public"."catalog_external_mappings"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_external_mappings" ADD CONSTRAINT "catalog_external_mappings_evidence_source_record_id_source_records_id_fk" FOREIGN KEY ("evidence_source_record_id") REFERENCES "public"."source_records"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_external_token_observations" ADD CONSTRAINT "catalog_external_token_observations_catalog_source_id_catalog_sources_id_fk" FOREIGN KEY ("catalog_source_id") REFERENCES "public"."catalog_sources"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_external_token_observations" ADD CONSTRAINT "catalog_external_token_observations_resolved_mapping_id_catalog_external_mappings_id_fk" FOREIGN KEY ("resolved_mapping_id") REFERENCES "public"."catalog_external_mappings"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "catalog_external_mapping_reviews_open_key" ON "catalog_external_mapping_reviews" USING btree ("catalog_source_id","dimension","external_key_normalized") WHERE "catalog_external_mapping_reviews"."state" = 'open';--> statement-breakpoint
CREATE INDEX "catalog_external_mapping_reviews_queue_idx" ON "catalog_external_mapping_reviews" USING btree ("state","priority" DESC NULLS LAST,"occurrences" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "catalog_external_mapping_reviews_source_idx" ON "catalog_external_mapping_reviews" USING btree ("catalog_source_id","dimension","state");--> statement-breakpoint
CREATE UNIQUE INDEX "catalog_external_mapping_run_items_subject_key" ON "catalog_external_mapping_run_items" USING btree ("run_id","subject_key");--> statement-breakpoint
CREATE INDEX "catalog_external_mapping_run_items_outcome_idx" ON "catalog_external_mapping_run_items" USING btree ("run_id","outcome");--> statement-breakpoint
CREATE UNIQUE INDEX "catalog_external_mapping_runs_active_key" ON "catalog_external_mapping_runs" USING btree ("catalog_source_id","mode") WHERE "catalog_external_mapping_runs"."state" in ('pending', 'running');--> statement-breakpoint
CREATE INDEX "catalog_external_mapping_runs_source_idx" ON "catalog_external_mapping_runs" USING btree ("catalog_source_id","mode","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "catalog_external_mappings_live_primary_key" ON "catalog_external_mappings" USING btree ("catalog_source_id","dimension","external_key_normalized") WHERE "catalog_external_mappings"."state" = 'approved' and "catalog_external_mappings"."valid_to" is null and "catalog_external_mappings"."fan_out_approved_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "catalog_external_mappings_version_key" ON "catalog_external_mappings" USING btree ("catalog_source_id","dimension","external_key_normalized","version");--> statement-breakpoint
CREATE INDEX "catalog_external_mappings_lookup_idx" ON "catalog_external_mappings" USING btree ("catalog_source_id","dimension","external_key_normalized") WHERE "catalog_external_mappings"."state" = 'approved';--> statement-breakpoint
CREATE INDEX "catalog_external_mappings_target_attribute_idx" ON "catalog_external_mappings" USING btree ("target_attribute_key") WHERE "catalog_external_mappings"."target_attribute_key" is not null;--> statement-breakpoint
CREATE INDEX "catalog_external_mappings_queue_idx" ON "catalog_external_mappings" USING btree ("state","dimension","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "catalog_external_token_observations_subject_key" ON "catalog_external_token_observations" USING btree ("catalog_source_id","dimension","external_key_normalized","subject_kind","subject_key");--> statement-breakpoint
CREATE INDEX "catalog_external_token_observations_token_idx" ON "catalog_external_token_observations" USING btree ("catalog_source_id","dimension","external_key_normalized");--> statement-breakpoint
CREATE INDEX "catalog_external_token_observations_pending_idx" ON "catalog_external_token_observations" USING btree ("reprocess_requested_at") WHERE "catalog_external_token_observations"."reprocess_requested_at" is not null and "catalog_external_token_observations"."reprocessed_at" is null;
--> statement-breakpoint
-- oxy:handwritten-begin=mercaria_catalog_external_mapping_freeze
CREATE OR REPLACE FUNCTION mercaria_catalog_external_mapping_freeze()
RETURNS trigger
LANGUAGE plpgsql
AS $$
begin
  if old.state = 'proposed' then
    -- A proposal is still being drafted. Everything is editable.
    return new;
  end if;

  if new.catalog_source_id is distinct from old.catalog_source_id
     or new.dimension is distinct from old.dimension
     -- `external_key`, NOT `external_key_normalized`: see the file header.
     or new.external_key is distinct from old.external_key
     or new.target_product_type_key is distinct from old.target_product_type_key
     or new.target_attribute_key is distinct from old.target_attribute_key
     or new.target_controlled_value is distinct from old.target_controlled_value
     or new.target_unit_family is distinct from old.target_unit_family
     or new.target_unit_code is distinct from old.target_unit_code
     or new.target_size_system_key is distinct from old.target_size_system_key
     -- Provenance, frozen with everything else: "which schema version was I
     -- looking at when I approved this" is worthless if it can be edited after
     -- the approval.
     or new.reviewed_product_type_definition_id
        is distinct from old.reviewed_product_type_definition_id
     or new.transform_rule is distinct from old.transform_rule
     or new.transform_rule_version is distinct from old.transform_rule_version
     or new.provenance is distinct from old.provenance
     or new.confidence is distinct from old.confidence
     or new.version is distinct from old.version
     or new.valid_from is distinct from old.valid_from
     or new.supersedes_mapping_id is distinct from old.supersedes_mapping_id
     -- The audit half, and both were MISSING until the freeze census caught
     -- them. `evidence_source_record_id` is the observation somebody approved
     -- this mapping on the strength of; `proposed_by_oxy_user_id` is who put it
     -- forward. Either one editable after approval means the record of a
     -- decision points at something other than what was decided on.
     or new.evidence_source_record_id is distinct from old.evidence_source_record_id
     or new.proposed_by_oxy_user_id is distinct from old.proposed_by_oxy_user_id
  then
    raise exception
      'catalog_external_mappings %: a mapping past `proposed` is immutable. '
      'Publish a new version and close this one with `valid_to`.', old.id
      using errcode = 'raise_exception';
  end if;

  -- A validity window closes once and never reopens: an observation interpreted
  -- under a closed window must stay interpretable that way.
  if old.valid_to is not null and new.valid_to is distinct from old.valid_to then
    raise exception
      'catalog_external_mappings %: `valid_to` is already set and cannot move.', old.id
      using errcode = 'raise_exception';
  end if;

  return new;
end;
$$;--> statement-breakpoint
CREATE TRIGGER mercaria_catalog_external_mapping_freeze
BEFORE UPDATE ON catalog_external_mappings
FOR EACH ROW EXECUTE FUNCTION mercaria_catalog_external_mapping_freeze();
-- oxy:handwritten-end=mercaria_catalog_external_mapping_freeze
--> statement-breakpoint
-- ─────────────────────────────────────────────────────────────────────────────
-- 2. The state machine. A CHECK cannot see the previous row, so the legal moves
-- are a trigger.
--
-- `approved` → `proposed` would let a mapping somebody refused become live
-- again with no second approval, and `rejected` → `approved` would do it in one
-- statement. Both are the same hole: a decision reversed with no record that it
-- was reversed. The forward path (`rejected` → a NEW proposed version) leaves
-- the rejection standing, which is what stops the re-proposal loop
-- `match_blocked_pairs` exists for.
-- ─────────────────────────────────────────────────────────────────────────────
-- oxy:handwritten-begin=mercaria_catalog_external_mapping_state
CREATE OR REPLACE FUNCTION mercaria_catalog_external_mapping_state()
RETURNS trigger
LANGUAGE plpgsql
AS $$
begin
  if new.state = old.state then
    return new;
  end if;

  if not (
       (old.state = 'proposed'  and new.state in ('in_review', 'approved', 'rejected'))
    or (old.state = 'in_review' and new.state in ('approved', 'rejected'))
    or (old.state = 'approved'  and new.state = 'superseded')
  ) then
    raise exception
      'catalog_external_mappings %: refusing the state move % -> %.', old.id, old.state, new.state
      using errcode = 'raise_exception';
  end if;

  return new;
end;
$$;--> statement-breakpoint
CREATE TRIGGER mercaria_catalog_external_mapping_state
BEFORE UPDATE ON catalog_external_mappings
FOR EACH ROW EXECUTE FUNCTION mercaria_catalog_external_mapping_state();
-- oxy:handwritten-end=mercaria_catalog_external_mapping_state
--> statement-breakpoint
-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Nothing in this domain is ever deleted.
--
-- Every table here is evidence about a decision somebody made, and the whole
-- point of keeping a `rejected` row is that it is still there next crawl. A
-- DELETE would be the one way to remove a rejection without anybody seeing that
-- it was removed.
--
-- ONE function, THREE mounts, ONE marker block. Three blocks would have to share
-- a name, and a name reused within a file is exactly what the marker gate
-- refuses — correctly, since a stack cannot tell which `end` closes which
-- `begin`.
-- ─────────────────────────────────────────────────────────────────────────────
-- oxy:handwritten-begin=mercaria_catalog_external_no_delete
CREATE OR REPLACE FUNCTION mercaria_catalog_external_no_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
begin
  raise exception
    '% is append-only: row % may not be deleted.', tg_table_name, old.id
    using errcode = 'raise_exception';
end;
$$;--> statement-breakpoint
CREATE TRIGGER mercaria_catalog_external_mapping_no_delete
BEFORE DELETE ON catalog_external_mappings
FOR EACH ROW EXECUTE FUNCTION mercaria_catalog_external_no_delete();--> statement-breakpoint
CREATE TRIGGER mercaria_catalog_external_review_no_delete
BEFORE DELETE ON catalog_external_mapping_reviews
FOR EACH ROW EXECUTE FUNCTION mercaria_catalog_external_no_delete();--> statement-breakpoint
CREATE TRIGGER mercaria_catalog_external_run_item_no_delete
BEFORE DELETE ON catalog_external_mapping_run_items
FOR EACH ROW EXECUTE FUNCTION mercaria_catalog_external_no_delete();
-- oxy:handwritten-end=mercaria_catalog_external_no_delete
--> statement-breakpoint
-- ─────────────────────────────────────────────────────────────────────────────
-- 4. A review row's SUBJECT is frozen; only its disposition moves.
--
-- The subject is what a reviewer is answering. If the token, the source, the
-- dimension or the raw observed value could be edited after the fact, the answer
-- in `resolved_mapping_id` would be an answer to a question nobody can see any
-- more. `occurrences`, `last_observed_at`, `priority`, `summary`,
-- `candidate_mapping_ids`, `state` and the resolution stamps are all free to
-- move — the first two on every fresh observation.
-- ─────────────────────────────────────────────────────────────────────────────
-- oxy:handwritten-begin=mercaria_catalog_external_review_subject_frozen
CREATE OR REPLACE FUNCTION mercaria_catalog_external_review_subject_frozen()
RETURNS trigger
LANGUAGE plpgsql
AS $$
begin
  if new.catalog_source_id is distinct from old.catalog_source_id
     -- `external_key`, NOT the generated column: see the file header.
     or new.external_key is distinct from old.external_key
     or new.dimension is distinct from old.dimension
     or new.observed_raw_value is distinct from old.observed_raw_value
     or new.source_record_id is distinct from old.source_record_id
     or new.first_observed_at is distinct from old.first_observed_at
  then
    raise exception
      'catalog_external_mapping_reviews %: the subject of a review is immutable.', old.id
      using errcode = 'raise_exception';
  end if;

  -- A settled review stays settled. Re-opening one would discard the decision
  -- and, with the partial unique on open rows, would do it invisibly.
  if old.state <> 'open' and new.state = 'open' then
    raise exception
      'catalog_external_mapping_reviews %: a settled review cannot be reopened. '
      'Record a new observation instead.', old.id
      using errcode = 'raise_exception';
  end if;

  return new;
end;
$$;--> statement-breakpoint
CREATE TRIGGER mercaria_catalog_external_review_subject_frozen
BEFORE UPDATE ON catalog_external_mapping_reviews
FOR EACH ROW EXECUTE FUNCTION mercaria_catalog_external_review_subject_frozen();
-- oxy:handwritten-end=mercaria_catalog_external_review_subject_frozen
--> statement-breakpoint
-- ─────────────────────────────────────────────────────────────────────────────
-- 5. A run item is append-only against UPDATE.
--
-- A run's conclusions are the thing a dry run and its apply are compared on. If
-- an item could be edited, the comparison would be between two descriptions of
-- one run rather than between a prediction and an outcome. The DELETE half is
-- block 3 above.
-- ─────────────────────────────────────────────────────────────────────────────
-- oxy:handwritten-begin=mercaria_catalog_external_run_item_immutable
CREATE OR REPLACE FUNCTION mercaria_catalog_external_run_item_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
begin
  raise exception
    'catalog_external_mapping_run_items %: a run item is append-only.', old.id
    using errcode = 'raise_exception';
end;
$$;--> statement-breakpoint
CREATE TRIGGER mercaria_catalog_external_run_item_immutable
BEFORE UPDATE ON catalog_external_mapping_run_items
FOR EACH ROW EXECUTE FUNCTION mercaria_catalog_external_run_item_immutable();
-- oxy:handwritten-end=mercaria_catalog_external_run_item_immutable
