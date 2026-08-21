-- oxy:deploy-phase=pre
-- oxy:rollback=derived
-- #58 — deterministic product and variant matching with explainable confidence.
--
-- Additive: nine new tables, two trigger functions and three triggers, all of
-- them new. Nothing existing is dropped, renamed or narrowed, so the image still
-- serving and the image arriving are both correct against it.

CREATE TABLE "match_benchmark_categories" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"policy_version_id" text NOT NULL,
	"category_key" text NOT NULL,
	"source_key" text NOT NULL,
	"total_cases" integer NOT NULL,
	"true_positives" integer NOT NULL,
	"false_positives" integer NOT NULL,
	"false_negatives" integer NOT NULL,
	"true_negatives" integer NOT NULL,
	"automatic_matches" integer NOT NULL,
	"manual_reviews" integer NOT NULL,
	"create_news" integer NOT NULL,
	"precision" double precision GENERATED ALWAYS AS ("match_benchmark_categories"."true_positives"::double precision
            / nullif("match_benchmark_categories"."true_positives" + "match_benchmark_categories"."false_positives", 0)) STORED,
	"recall" double precision GENERATED ALWAYS AS ("match_benchmark_categories"."true_positives"::double precision
            / nullif("match_benchmark_categories"."true_positives" + "match_benchmark_categories"."false_negatives", 0)) STORED,
	"automatic_match_coverage" double precision GENERATED ALWAYS AS ("match_benchmark_categories"."automatic_matches"::double precision
            / nullif("match_benchmark_categories"."total_cases", 0)) STORED,
	"manual_review_rate" double precision GENERATED ALWAYS AS ("match_benchmark_categories"."manual_reviews"::double precision
            / nullif("match_benchmark_categories"."total_cases", 0)) STORED,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "match_benchmark_categories_identity_key" UNIQUE("id","policy_version_id"),
	CONSTRAINT "match_benchmark_categories_category_check" CHECK (btrim("match_benchmark_categories"."category_key") <> ''),
	CONSTRAINT "match_benchmark_categories_source_check" CHECK (btrim("match_benchmark_categories"."source_key") <> ''),
	CONSTRAINT "match_benchmark_categories_counts_check" CHECK ("match_benchmark_categories"."total_cases" >= 0 and "match_benchmark_categories"."true_positives" >= 0 and "match_benchmark_categories"."false_positives" >= 0
          and "match_benchmark_categories"."false_negatives" >= 0 and "match_benchmark_categories"."true_negatives" >= 0
          and "match_benchmark_categories"."automatic_matches" >= 0 and "match_benchmark_categories"."manual_reviews" >= 0 and "match_benchmark_categories"."create_news" >= 0),
	CONSTRAINT "match_benchmark_categories_partition_check" CHECK ("match_benchmark_categories"."automatic_matches" + "match_benchmark_categories"."manual_reviews" + "match_benchmark_categories"."create_news" = "match_benchmark_categories"."total_cases"),
	CONSTRAINT "match_benchmark_categories_matrix_check" CHECK ("match_benchmark_categories"."true_positives" + "match_benchmark_categories"."false_positives" + "match_benchmark_categories"."false_negatives" + "match_benchmark_categories"."true_negatives"
          = "match_benchmark_categories"."total_cases")
);
--> statement-breakpoint
CREATE TABLE "match_benchmark_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"policy_version_id" text NOT NULL,
	"dataset_version" text NOT NULL,
	"dataset_checksum" text NOT NULL,
	"total_cases" integer NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"started_by_oxy_user_id" text,
	"note" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "match_benchmark_runs_identity_key" UNIQUE("id","policy_version_id"),
	CONSTRAINT "match_benchmark_runs_dataset_version_check" CHECK (btrim("match_benchmark_runs"."dataset_version") <> ''),
	CONSTRAINT "match_benchmark_runs_checksum_check" CHECK ("match_benchmark_runs"."dataset_checksum" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "match_benchmark_runs_total_cases_check" CHECK ("match_benchmark_runs"."total_cases" >= 0),
	CONSTRAINT "match_benchmark_runs_completion_check" CHECK ("match_benchmark_runs"."completed_at" is null or "match_benchmark_runs"."completed_at" >= "match_benchmark_runs"."started_at"),
	CONSTRAINT "match_benchmark_runs_note_check" CHECK ("match_benchmark_runs"."note" is null or length("match_benchmark_runs"."note") <= 2000)
);
--> statement-breakpoint
CREATE TABLE "match_blocked_pairs" (
	"id" text PRIMARY KEY NOT NULL,
	"subject_key" text NOT NULL,
	"subject_kind" text NOT NULL,
	"target_canonical_product_id" text,
	"target_canonical_variant_id" text,
	"decision_id" text,
	"blocked_under_policy_version_id" text NOT NULL,
	"blocked_by_oxy_user_id" text NOT NULL,
	"reason" text NOT NULL,
	"cleared_at" timestamp with time zone,
	"cleared_by_oxy_user_id" text,
	"clear_reason" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"target_key" text GENERATED ALWAYS AS (coalesce('var:' || "match_blocked_pairs"."target_canonical_variant_id", 'prd:' || "match_blocked_pairs"."target_canonical_product_id")) STORED,
	CONSTRAINT "match_blocked_pairs_subject_kind_check" CHECK ("match_blocked_pairs"."subject_kind" in ('native_variant', 'source_record')),
	CONSTRAINT "match_blocked_pairs_subject_key_check" CHECK (btrim("match_blocked_pairs"."subject_key") <> ''),
	CONSTRAINT "match_blocked_pairs_target_check" CHECK (num_nonnulls("match_blocked_pairs"."target_canonical_product_id", "match_blocked_pairs"."target_canonical_variant_id") = 1),
	CONSTRAINT "match_blocked_pairs_actor_check" CHECK (btrim("match_blocked_pairs"."blocked_by_oxy_user_id") <> ''),
	CONSTRAINT "match_blocked_pairs_reason_check" CHECK (btrim("match_blocked_pairs"."reason") <> ''),
	CONSTRAINT "match_blocked_pairs_cleared_state_check" CHECK ("match_blocked_pairs"."cleared_at" is null
          or ("match_blocked_pairs"."cleared_by_oxy_user_id" is not null and btrim("match_blocked_pairs"."clear_reason") <> ''))
);
--> statement-breakpoint
CREATE TABLE "match_category_gates" (
	"id" text PRIMARY KEY NOT NULL,
	"policy_version_id" text NOT NULL,
	"category_key" text NOT NULL,
	"benchmark_category_id" text NOT NULL,
	"observed_precision" double precision NOT NULL,
	"observed_samples" integer NOT NULL,
	"enabled_by_oxy_user_id" text NOT NULL,
	"enabled_at" timestamp with time zone NOT NULL,
	"reason" text NOT NULL,
	"disabled_at" timestamp with time zone,
	"disabled_by_oxy_user_id" text,
	"disable_reason" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "match_category_gates_category_check" CHECK (btrim("match_category_gates"."category_key") <> ''),
	CONSTRAINT "match_category_gates_actor_check" CHECK (btrim("match_category_gates"."enabled_by_oxy_user_id") <> ''),
	CONSTRAINT "match_category_gates_reason_check" CHECK (btrim("match_category_gates"."reason") <> ''),
	CONSTRAINT "match_category_gates_observed_check" CHECK ("match_category_gates"."observed_precision" >= 0 and "match_category_gates"."observed_precision" <= 1 and "match_category_gates"."observed_samples" >= 0),
	CONSTRAINT "match_category_gates_disabled_state_check" CHECK ("match_category_gates"."disabled_at" is null
          or ("match_category_gates"."disabled_by_oxy_user_id" is not null and btrim("match_category_gates"."disable_reason") <> ''))
);
--> statement-breakpoint
CREATE TABLE "match_decision_candidates" (
	"id" text PRIMARY KEY NOT NULL,
	"decision_id" text NOT NULL,
	"canonical_product_id" text,
	"canonical_variant_id" text,
	"rank" integer NOT NULL,
	"score" double precision NOT NULL,
	"selected" boolean DEFAULT false NOT NULL,
	"rejection" text,
	"identifier_agreement" double precision,
	"brand_agreement" double precision,
	"model_agreement" double precision,
	"attribute_agreement" double precision,
	"title_similarity" double precision,
	"category_agreement" double precision,
	"semantic_similarity" double precision,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "match_decision_candidates_target_check" CHECK ("match_decision_candidates"."canonical_product_id" is not null or "match_decision_candidates"."canonical_variant_id" is not null),
	CONSTRAINT "match_decision_candidates_rank_check" CHECK ("match_decision_candidates"."rank" >= 1),
	CONSTRAINT "match_decision_candidates_score_check" CHECK ("match_decision_candidates"."score" >= 0 and "match_decision_candidates"."score" <= 1),
	CONSTRAINT "match_decision_candidates_rejection_check" CHECK ("match_decision_candidates"."rejection" in ('conflicting_identifier', 'brand_mismatch', 'variant_attribute_mismatch', 'bundle_mismatch', 'multipack_mismatch', 'accessory_mismatch', 'replacement_part_mismatch', 'regional_variant_mismatch', 'category_mismatch', 'blocked_pair', 'category_gate_closed', 'ambiguous_candidates', 'below_auto_threshold', 'missing_required_attributes', 'no_deterministic_support', 'unresolved_product')),
	CONSTRAINT "match_decision_candidates_selection_check" CHECK (not "match_decision_candidates"."selected" or "match_decision_candidates"."rejection" is null),
	CONSTRAINT "match_decision_candidates_features_check" CHECK (("match_decision_candidates"."identifier_agreement" is null or ("match_decision_candidates"."identifier_agreement" >= 0 and "match_decision_candidates"."identifier_agreement" <= 1))
          and ("match_decision_candidates"."brand_agreement" is null or ("match_decision_candidates"."brand_agreement" >= 0 and "match_decision_candidates"."brand_agreement" <= 1))
          and ("match_decision_candidates"."model_agreement" is null or ("match_decision_candidates"."model_agreement" >= 0 and "match_decision_candidates"."model_agreement" <= 1))
          and ("match_decision_candidates"."attribute_agreement" is null or ("match_decision_candidates"."attribute_agreement" >= 0 and "match_decision_candidates"."attribute_agreement" <= 1))
          and ("match_decision_candidates"."title_similarity" is null or ("match_decision_candidates"."title_similarity" >= 0 and "match_decision_candidates"."title_similarity" <= 1))
          and ("match_decision_candidates"."category_agreement" is null or ("match_decision_candidates"."category_agreement" >= 0 and "match_decision_candidates"."category_agreement" <= 1))
          and ("match_decision_candidates"."semantic_similarity" is null or ("match_decision_candidates"."semantic_similarity" >= 0 and "match_decision_candidates"."semantic_similarity" <= 1)))
);
--> statement-breakpoint
CREATE TABLE "match_decisions" (
	"id" text PRIMARY KEY NOT NULL,
	"subject_kind" text NOT NULL,
	"subject_key" text NOT NULL,
	"source_record_id" text,
	"product_variant_id" text,
	"policy_version_id" text NOT NULL,
	"outcome" text NOT NULL,
	"decided_stage" text NOT NULL,
	"confidence" double precision,
	"matched_canonical_product_id" text,
	"matched_canonical_variant_id" text,
	"reason_codes" text[] DEFAULT '{}'::text[] NOT NULL,
	"blockers" text[] DEFAULT '{}'::text[] NOT NULL,
	"positive_identifiers" text[] DEFAULT '{}'::text[] NOT NULL,
	"conflicting_identifiers" text[] DEFAULT '{}'::text[] NOT NULL,
	"normalized_brand" text,
	"normalized_model" text,
	"normalized_title" text NOT NULL,
	"category_key" text,
	"candidate_count" integer DEFAULT 0 NOT NULL,
	"review_state" text DEFAULT 'not_required' NOT NULL,
	"reviewed_by_oxy_user_id" text,
	"reviewed_at" timestamp with time zone,
	"review_note" text,
	"evaluation_count" integer DEFAULT 1 NOT NULL,
	"last_evaluated_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"evaluation_key" text GENERATED ALWAYS AS (coalesce('src:' || "match_decisions"."source_record_id", 'var:' || "match_decisions"."product_variant_id")) STORED,
	CONSTRAINT "match_decisions_subject_kind_check" CHECK ("match_decisions"."subject_kind" in ('native_variant', 'source_record')),
	CONSTRAINT "match_decisions_outcome_check" CHECK ("match_decisions"."outcome" in ('automatic_match', 'create_new', 'manual_review')),
	CONSTRAINT "match_decisions_stage_check" CHECK ("match_decisions"."decided_stage" in ('existing_source_link', 'global_identifier', 'brand_scoped_identifier', 'normalized_attributes', 'candidate_retrieval', 'semantic_assist', 'no_candidate')),
	CONSTRAINT "match_decisions_review_state_check" CHECK ("match_decisions"."review_state" in ('not_required', 'pending', 'approved', 'rejected')),
	CONSTRAINT "match_decisions_reason_codes_check" CHECK ("match_decisions"."reason_codes" <@ array['conflicting_identifier', 'brand_mismatch', 'variant_attribute_mismatch', 'bundle_mismatch', 'multipack_mismatch', 'accessory_mismatch', 'replacement_part_mismatch', 'regional_variant_mismatch', 'category_mismatch', 'blocked_pair', 'category_gate_closed', 'ambiguous_candidates', 'below_auto_threshold', 'missing_required_attributes', 'no_deterministic_support', 'unresolved_product', 'existing_link_reused', 'gtin_exact_match', 'mpn_brand_scoped_match', 'brand_agreed', 'all_axes_agreed', 'model_name_exact', 'title_candidate_retrieved', 'semantic_reranked', 'semantic_disabled', 'no_candidate_found', 'brand_unknown', 'no_identifier_present', 'used_condition_preserved', 'sku_scoped_to_source']::text[]),
	CONSTRAINT "match_decisions_blockers_check" CHECK ("match_decisions"."blockers" <@ array['conflicting_identifier', 'brand_mismatch', 'variant_attribute_mismatch', 'bundle_mismatch', 'multipack_mismatch', 'accessory_mismatch', 'replacement_part_mismatch', 'regional_variant_mismatch', 'category_mismatch', 'blocked_pair', 'category_gate_closed', 'ambiguous_candidates', 'below_auto_threshold', 'missing_required_attributes', 'no_deterministic_support', 'unresolved_product']::text[]),
	CONSTRAINT "match_decisions_subject_shape_check" CHECK (case "match_decisions"."subject_kind"
            when 'source_record' then "match_decisions"."source_record_id" is not null and "match_decisions"."product_variant_id" is null
            when 'native_variant' then "match_decisions"."product_variant_id" is not null and "match_decisions"."source_record_id" is null
            else false
          end),
	CONSTRAINT "match_decisions_subject_key_check" CHECK (btrim("match_decisions"."subject_key") <> ''),
	CONSTRAINT "match_decisions_blockers_auto_check" CHECK ("match_decisions"."outcome" <> 'automatic_match' or cardinality("match_decisions"."blockers") = 0),
	CONSTRAINT "match_decisions_conflicting_identifier_check" CHECK (cardinality("match_decisions"."conflicting_identifiers") = 0
          or 'conflicting_identifier' = any("match_decisions"."blockers")),
	CONSTRAINT "match_decisions_blockers_explained_check" CHECK ("match_decisions"."blockers" <@ "match_decisions"."reason_codes"),
	CONSTRAINT "match_decisions_grain_order_check" CHECK ("match_decisions"."matched_canonical_variant_id" is null or "match_decisions"."matched_canonical_product_id" is not null),
	CONSTRAINT "match_decisions_outcome_shape_check" CHECK (case "match_decisions"."outcome"
            when 'automatic_match' then "match_decisions"."matched_canonical_product_id" is not null
            when 'create_new' then "match_decisions"."matched_canonical_product_id" is null and "match_decisions"."matched_canonical_variant_id" is null
            else true
          end),
	CONSTRAINT "match_decisions_confidence_check" CHECK ("match_decisions"."confidence" is null or ("match_decisions"."confidence" >= 0 and "match_decisions"."confidence" <= 1)),
	CONSTRAINT "match_decisions_confidence_stage_check" CHECK (case
            when "match_decisions"."decided_stage" in ('existing_source_link', 'global_identifier', 'brand_scoped_identifier')
              then "match_decisions"."confidence" is null
            when "match_decisions"."decided_stage" = 'no_candidate' then "match_decisions"."confidence" is null
            else true
          end),
	CONSTRAINT "match_decisions_review_attribution_check" CHECK ("match_decisions"."review_state" not in ('approved', 'rejected')
          or ("match_decisions"."reviewed_by_oxy_user_id" is not null and "match_decisions"."reviewed_at" is not null)),
	CONSTRAINT "match_decisions_review_opening_check" CHECK ("match_decisions"."review_state" = 'not_required' or "match_decisions"."outcome" = 'manual_review'),
	CONSTRAINT "match_decisions_counts_check" CHECK ("match_decisions"."evaluation_count" >= 1 and "match_decisions"."candidate_count" >= 0),
	CONSTRAINT "match_decisions_review_note_check" CHECK ("match_decisions"."review_note" is null or length("match_decisions"."review_note") <= 2000)
);
--> statement-breakpoint
CREATE TABLE "match_policy_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"version_key" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"description" text NOT NULL,
	"auto_min_confidence" double precision NOT NULL,
	"review_min_confidence" double precision NOT NULL,
	"min_candidate_separation" double precision NOT NULL,
	"max_candidates" integer NOT NULL,
	"min_title_similarity" double precision NOT NULL,
	"weight_identifier" double precision NOT NULL,
	"weight_brand" double precision NOT NULL,
	"weight_model" double precision NOT NULL,
	"weight_attribute" double precision NOT NULL,
	"weight_title" double precision NOT NULL,
	"weight_category" double precision NOT NULL,
	"weight_semantic" double precision DEFAULT 0 NOT NULL,
	"semantic_enabled" boolean DEFAULT false NOT NULL,
	"min_benchmark_precision" double precision NOT NULL,
	"min_benchmark_samples" integer NOT NULL,
	"activated_at" timestamp with time zone,
	"superseded_at" timestamp with time zone,
	"created_by_oxy_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "match_policy_versions_status_check" CHECK ("match_policy_versions"."status" in ('draft', 'active', 'superseded')),
	CONSTRAINT "match_policy_versions_version_key_check" CHECK (btrim("match_policy_versions"."version_key") <> ''),
	CONSTRAINT "match_policy_versions_description_check" CHECK (btrim("match_policy_versions"."description") <> ''),
	CONSTRAINT "match_policy_versions_actor_check" CHECK (btrim("match_policy_versions"."created_by_oxy_user_id") <> ''),
	CONSTRAINT "match_policy_versions_thresholds_check" CHECK ("match_policy_versions"."auto_min_confidence" > 0 and "match_policy_versions"."auto_min_confidence" <= 1
          and "match_policy_versions"."review_min_confidence" > 0 and "match_policy_versions"."review_min_confidence" <= 1
          and "match_policy_versions"."review_min_confidence" <= "match_policy_versions"."auto_min_confidence"
          and "match_policy_versions"."min_candidate_separation" >= 0 and "match_policy_versions"."min_candidate_separation" <= 1
          and "match_policy_versions"."min_title_similarity" >= 0 and "match_policy_versions"."min_title_similarity" <= 1),
	CONSTRAINT "match_policy_versions_max_candidates_check" CHECK ("match_policy_versions"."max_candidates" between 1 and 500),
	CONSTRAINT "match_policy_versions_weights_check" CHECK ("match_policy_versions"."weight_identifier" >= 0 and "match_policy_versions"."weight_brand" >= 0 and "match_policy_versions"."weight_model" >= 0
          and "match_policy_versions"."weight_attribute" >= 0 and "match_policy_versions"."weight_title" >= 0 and "match_policy_versions"."weight_category" >= 0
          and "match_policy_versions"."weight_semantic" >= 0
          and ("match_policy_versions"."weight_identifier" + "match_policy_versions"."weight_brand" + "match_policy_versions"."weight_model"
               + "match_policy_versions"."weight_attribute" + "match_policy_versions"."weight_title" + "match_policy_versions"."weight_category") > 0),
	CONSTRAINT "match_policy_versions_benchmark_bar_check" CHECK ("match_policy_versions"."min_benchmark_precision" >= 0.95 and "match_policy_versions"."min_benchmark_precision" <= 1
          and "match_policy_versions"."min_benchmark_samples" >= 20),
	CONSTRAINT "match_policy_versions_activation_check" CHECK (("match_policy_versions"."status" = 'draft') = ("match_policy_versions"."activated_at" is null)),
	CONSTRAINT "match_policy_versions_supersession_check" CHECK (("match_policy_versions"."status" = 'superseded') = ("match_policy_versions"."superseded_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "match_queue" (
	"id" text PRIMARY KEY NOT NULL,
	"subject_kind" text NOT NULL,
	"subject_key" text NOT NULL,
	"source_record_id" text,
	"product_variant_id" text,
	"trigger" text NOT NULL,
	"requested_revision" bigint DEFAULT 1 NOT NULL,
	"claimed_revision" bigint,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone NOT NULL,
	"lease_owner" text,
	"lease_until" timestamp with time zone,
	"last_error" text,
	"processed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "match_queue_subject_kind_check" CHECK ("match_queue"."subject_kind" in ('native_variant', 'source_record')),
	CONSTRAINT "match_queue_status_check" CHECK ("match_queue"."status" in ('pending', 'processing', 'done', 'dead_letter')),
	CONSTRAINT "match_queue_trigger_check" CHECK ("match_queue"."trigger" in ('catalog_write', 'source_observation', 'policy_activation', 'operator', 'bulk_sweep')),
	CONSTRAINT "match_queue_subject_key_check" CHECK (btrim("match_queue"."subject_key") <> ''),
	CONSTRAINT "match_queue_subject_shape_check" CHECK (case "match_queue"."subject_kind"
            when 'source_record' then "match_queue"."source_record_id" is not null and "match_queue"."product_variant_id" is null
            when 'native_variant' then "match_queue"."product_variant_id" is not null and "match_queue"."source_record_id" is null
            else false
          end),
	CONSTRAINT "match_queue_attempts_check" CHECK ("match_queue"."attempts" >= 0),
	CONSTRAINT "match_queue_requested_revision_check" CHECK ("match_queue"."requested_revision" >= 1),
	CONSTRAINT "match_queue_claimed_revision_check" CHECK ("match_queue"."claimed_revision" is null or "match_queue"."claimed_revision" <= "match_queue"."requested_revision"),
	CONSTRAINT "match_queue_last_error_length_check" CHECK ("match_queue"."last_error" is null or length("match_queue"."last_error") <= 2000)
);
--> statement-breakpoint
CREATE TABLE "match_sweep_cursors" (
	"id" text PRIMARY KEY NOT NULL,
	"cursor" text,
	"policy_version_id" text,
	"last_run_at" timestamp with time zone,
	"last_completed_at" timestamp with time zone,
	"enqueued_in_pass" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"lease_owner" text,
	"lease_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "match_sweep_cursors_id_check" CHECK ("match_sweep_cursors"."id" in ('native_variants', 'source_records')),
	CONSTRAINT "match_sweep_cursors_enqueued_check" CHECK ("match_sweep_cursors"."enqueued_in_pass" >= 0),
	CONSTRAINT "match_sweep_cursors_last_error_length_check" CHECK ("match_sweep_cursors"."last_error" is null or length("match_sweep_cursors"."last_error") <= 2000),
	CONSTRAINT "match_sweep_cursors_lease_complete_check" CHECK (num_nonnulls("match_sweep_cursors"."lease_owner", "match_sweep_cursors"."lease_until") in (0, 2))
);
--> statement-breakpoint
ALTER TABLE "match_benchmark_categories" ADD CONSTRAINT "match_benchmark_categories_run_id_match_benchmark_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."match_benchmark_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_benchmark_categories" ADD CONSTRAINT "match_benchmark_categories_run_policy_fk" FOREIGN KEY ("run_id","policy_version_id") REFERENCES "public"."match_benchmark_runs"("id","policy_version_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_benchmark_runs" ADD CONSTRAINT "match_benchmark_runs_policy_version_id_match_policy_versions_id_fk" FOREIGN KEY ("policy_version_id") REFERENCES "public"."match_policy_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_blocked_pairs" ADD CONSTRAINT "match_blocked_pairs_target_canonical_product_id_canonical_products_id_fk" FOREIGN KEY ("target_canonical_product_id") REFERENCES "public"."canonical_products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_blocked_pairs" ADD CONSTRAINT "match_blocked_pairs_target_canonical_variant_id_canonical_variants_id_fk" FOREIGN KEY ("target_canonical_variant_id") REFERENCES "public"."canonical_variants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_blocked_pairs" ADD CONSTRAINT "match_blocked_pairs_decision_id_match_decisions_id_fk" FOREIGN KEY ("decision_id") REFERENCES "public"."match_decisions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_blocked_pairs" ADD CONSTRAINT "match_blocked_pairs_blocked_under_policy_version_id_match_policy_versions_id_fk" FOREIGN KEY ("blocked_under_policy_version_id") REFERENCES "public"."match_policy_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_category_gates" ADD CONSTRAINT "match_category_gates_policy_version_id_match_policy_versions_id_fk" FOREIGN KEY ("policy_version_id") REFERENCES "public"."match_policy_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_category_gates" ADD CONSTRAINT "match_category_gates_benchmark_fk" FOREIGN KEY ("benchmark_category_id","policy_version_id") REFERENCES "public"."match_benchmark_categories"("id","policy_version_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_decision_candidates" ADD CONSTRAINT "match_decision_candidates_decision_id_match_decisions_id_fk" FOREIGN KEY ("decision_id") REFERENCES "public"."match_decisions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_decision_candidates" ADD CONSTRAINT "match_decision_candidates_canonical_product_id_canonical_products_id_fk" FOREIGN KEY ("canonical_product_id") REFERENCES "public"."canonical_products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_decision_candidates" ADD CONSTRAINT "match_decision_candidates_canonical_variant_id_canonical_variants_id_fk" FOREIGN KEY ("canonical_variant_id") REFERENCES "public"."canonical_variants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_decisions" ADD CONSTRAINT "match_decisions_source_record_id_source_records_id_fk" FOREIGN KEY ("source_record_id") REFERENCES "public"."source_records"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_decisions" ADD CONSTRAINT "match_decisions_product_variant_id_product_variants_id_fk" FOREIGN KEY ("product_variant_id") REFERENCES "public"."product_variants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_decisions" ADD CONSTRAINT "match_decisions_policy_version_id_match_policy_versions_id_fk" FOREIGN KEY ("policy_version_id") REFERENCES "public"."match_policy_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_decisions" ADD CONSTRAINT "match_decisions_matched_canonical_product_id_canonical_products_id_fk" FOREIGN KEY ("matched_canonical_product_id") REFERENCES "public"."canonical_products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_decisions" ADD CONSTRAINT "match_decisions_matched_canonical_variant_id_canonical_variants_id_fk" FOREIGN KEY ("matched_canonical_variant_id") REFERENCES "public"."canonical_variants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_queue" ADD CONSTRAINT "match_queue_source_record_id_source_records_id_fk" FOREIGN KEY ("source_record_id") REFERENCES "public"."source_records"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_queue" ADD CONSTRAINT "match_queue_product_variant_id_product_variants_id_fk" FOREIGN KEY ("product_variant_id") REFERENCES "public"."product_variants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_sweep_cursors" ADD CONSTRAINT "match_sweep_cursors_policy_version_id_match_policy_versions_id_fk" FOREIGN KEY ("policy_version_id") REFERENCES "public"."match_policy_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "match_benchmark_categories_slice_key" ON "match_benchmark_categories" USING btree ("run_id","category_key","source_key");--> statement-breakpoint
CREATE INDEX "match_benchmark_categories_category_idx" ON "match_benchmark_categories" USING btree ("category_key","source_key");--> statement-breakpoint
CREATE INDEX "match_benchmark_runs_policy_idx" ON "match_benchmark_runs" USING btree ("policy_version_id","started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "match_blocked_pairs_open_key" ON "match_blocked_pairs" USING btree ("subject_key","target_key") WHERE "match_blocked_pairs"."cleared_at" is null;--> statement-breakpoint
CREATE INDEX "match_blocked_pairs_subject_idx" ON "match_blocked_pairs" USING btree ("subject_key") WHERE "match_blocked_pairs"."cleared_at" is null;--> statement-breakpoint
CREATE INDEX "match_blocked_pairs_target_idx" ON "match_blocked_pairs" USING btree ("target_key");--> statement-breakpoint
CREATE UNIQUE INDEX "match_category_gates_open_key" ON "match_category_gates" USING btree ("policy_version_id","category_key") WHERE "match_category_gates"."disabled_at" is null;--> statement-breakpoint
CREATE INDEX "match_category_gates_category_idx" ON "match_category_gates" USING btree ("category_key");--> statement-breakpoint
CREATE UNIQUE INDEX "match_decision_candidates_rank_key" ON "match_decision_candidates" USING btree ("decision_id","rank");--> statement-breakpoint
CREATE UNIQUE INDEX "match_decision_candidates_selected_key" ON "match_decision_candidates" USING btree ("decision_id") WHERE "match_decision_candidates"."selected";--> statement-breakpoint
CREATE INDEX "match_decision_candidates_variant_idx" ON "match_decision_candidates" USING btree ("canonical_variant_id") WHERE "match_decision_candidates"."canonical_variant_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "match_decisions_evaluation_key" ON "match_decisions" USING btree ("evaluation_key","policy_version_id");--> statement-breakpoint
CREATE INDEX "match_decisions_subject_idx" ON "match_decisions" USING btree ("subject_key","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "match_decisions_review_idx" ON "match_decisions" USING btree ("review_state","created_at") WHERE "match_decisions"."review_state" = 'pending';--> statement-breakpoint
CREATE INDEX "match_decisions_policy_outcome_idx" ON "match_decisions" USING btree ("policy_version_id","outcome");--> statement-breakpoint
CREATE INDEX "match_decisions_matched_variant_idx" ON "match_decisions" USING btree ("matched_canonical_variant_id") WHERE "match_decisions"."matched_canonical_variant_id" is not null;--> statement-breakpoint
CREATE INDEX "match_decisions_blockers_idx" ON "match_decisions" USING gin ("blockers");--> statement-breakpoint
CREATE UNIQUE INDEX "match_policy_versions_key_key" ON "match_policy_versions" USING btree ("version_key");--> statement-breakpoint
CREATE UNIQUE INDEX "match_policy_versions_active_key" ON "match_policy_versions" USING btree ("status") WHERE "match_policy_versions"."status" = 'active';--> statement-breakpoint
CREATE INDEX "match_policy_versions_status_idx" ON "match_policy_versions" USING btree ("status","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "match_queue_subject_key_unique" ON "match_queue" USING btree ("subject_key");--> statement-breakpoint
CREATE INDEX "match_queue_pending_idx" ON "match_queue" USING btree ("available_at","created_at") WHERE "match_queue"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "match_queue_reclaim_idx" ON "match_queue" USING btree ("lease_until","created_at") WHERE "match_queue"."status" = 'processing';--> statement-breakpoint
CREATE INDEX "match_queue_age_idx" ON "match_queue" USING btree ("created_at") WHERE "match_queue"."status" = 'pending';
--> statement-breakpoint
-- ── The two guarantees drizzle-kit cannot express ─────────────────────────────
--
-- A CHECK constrains one row against itself. These two constrain a row against
-- its own HISTORY, which is what "immutable once active" and "append-only"
-- actually mean, so they are triggers — the `retail_pricing_policies`,
-- `fee_schedule_versions` and `product_identifiers` precedent.
CREATE FUNCTION mercaria_match_policy_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION
      'match policy version % cannot be deleted: every recorded decision cites it, and a confidence whose policy is gone is a number nobody can reproduce. Supersede it instead.',
      OLD.version_key
      USING ERRCODE = 'check_violation';
  END IF;
  -- A draft is still being written; an ACTIVE or SUPERSEDED version is the rule
  -- a benchmark run measured and a decision was judged by. The ONE permitted
  -- change is the lifecycle itself, so a policy can be activated and later
  -- retired without any of its terms moving underneath the outcomes it produced.
  IF OLD.status <> 'draft' AND (
    NEW.version_key IS DISTINCT FROM OLD.version_key OR
    NEW.description IS DISTINCT FROM OLD.description OR
    NEW.auto_min_confidence IS DISTINCT FROM OLD.auto_min_confidence OR
    NEW.review_min_confidence IS DISTINCT FROM OLD.review_min_confidence OR
    NEW.min_candidate_separation IS DISTINCT FROM OLD.min_candidate_separation OR
    NEW.max_candidates IS DISTINCT FROM OLD.max_candidates OR
    NEW.min_title_similarity IS DISTINCT FROM OLD.min_title_similarity OR
    NEW.weight_identifier IS DISTINCT FROM OLD.weight_identifier OR
    NEW.weight_brand IS DISTINCT FROM OLD.weight_brand OR
    NEW.weight_model IS DISTINCT FROM OLD.weight_model OR
    NEW.weight_attribute IS DISTINCT FROM OLD.weight_attribute OR
    NEW.weight_title IS DISTINCT FROM OLD.weight_title OR
    NEW.weight_category IS DISTINCT FROM OLD.weight_category OR
    NEW.weight_semantic IS DISTINCT FROM OLD.weight_semantic OR
    NEW.semantic_enabled IS DISTINCT FROM OLD.semantic_enabled OR
    NEW.min_benchmark_precision IS DISTINCT FROM OLD.min_benchmark_precision OR
    NEW.min_benchmark_samples IS DISTINCT FROM OLD.min_benchmark_samples OR
    NEW.activated_at IS DISTINCT FROM OLD.activated_at OR
    NEW.created_by_oxy_user_id IS DISTINCT FROM OLD.created_by_oxy_user_id OR
    NEW.created_at IS DISTINCT FROM OLD.created_at
  ) THEN
    RAISE EXCEPTION
      'match policy version % is %, not draft: its terms are immutable. Publish a new version instead of editing this one.',
      OLD.version_key, OLD.status
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER match_policy_versions_immutable
  BEFORE UPDATE OR DELETE ON "match_policy_versions"
  FOR EACH ROW EXECUTE FUNCTION mercaria_match_policy_immutable();--> statement-breakpoint
-- A benchmark run is a MEASUREMENT. `match_category_gates` cites one as its
-- authority to match automatically, so a run that can be edited is a gate that
-- rests on nothing. Re-measure by starting a new run; the dataset checksum on
-- each row is what makes the two comparable.
CREATE FUNCTION mercaria_match_benchmark_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND TG_TABLE_NAME = 'match_benchmark_runs'
     AND OLD.completed_at IS NULL AND NEW.completed_at IS NOT NULL
     AND NEW.id IS NOT DISTINCT FROM OLD.id
     AND NEW.policy_version_id IS NOT DISTINCT FROM OLD.policy_version_id
     AND NEW.dataset_version IS NOT DISTINCT FROM OLD.dataset_version
     AND NEW.dataset_checksum IS NOT DISTINCT FROM OLD.dataset_checksum
     AND NEW.total_cases IS NOT DISTINCT FROM OLD.total_cases
     AND NEW.started_at IS NOT DISTINCT FROM OLD.started_at
     AND NEW.started_by_oxy_user_id IS NOT DISTINCT FROM OLD.started_by_oxy_user_id
     AND NEW.created_at IS NOT DISTINCT FROM OLD.created_at THEN
    -- The ONE permitted update: stamping a run finished, exactly once, with
    -- nothing else moving. A run is opened before its slices are known, so
    -- freezing it from birth would leave every run permanently incomplete.
    RETURN NEW;
  END IF;
  RAISE EXCEPTION
    'match benchmark rows are append-only: % on %.% is refused. A gate cites a run as its authority to match automatically; an editable measurement is not one.',
    TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME
    USING ERRCODE = 'check_violation';
END;
$$;--> statement-breakpoint
CREATE TRIGGER match_benchmark_runs_append_only
  BEFORE UPDATE OR DELETE ON "match_benchmark_runs"
  FOR EACH ROW EXECUTE FUNCTION mercaria_match_benchmark_append_only();--> statement-breakpoint
CREATE TRIGGER match_benchmark_categories_append_only
  BEFORE UPDATE OR DELETE ON "match_benchmark_categories"
  FOR EACH ROW EXECUTE FUNCTION mercaria_match_benchmark_append_only();
