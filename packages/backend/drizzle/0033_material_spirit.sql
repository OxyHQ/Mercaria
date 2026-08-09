-- oxy:deploy-phase=pre
-- Catalog curation (#59, ADR 0002 D12/D16): eight new tables, no change to any
-- existing one. Purely additive, so it is safe against the image still serving
-- AND the one about to — the previous image simply never reads these tables.
--
-- The hand-written statements at the end are six IMMUTABILITY triggers.
-- drizzle-kit cannot model any of them, so a regeneration of this file DROPS
-- them silently: after any `db:generate` that touches this migration, grep for
-- `mercaria_catalog_` and confirm six CREATE FUNCTION / CREATE TRIGGER pairs
-- are still here. All six would apply cleanly while enforcing nothing.

CREATE TABLE "catalog_entity_suppressions" (
	"id" text PRIMARY KEY NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"scope" text NOT NULL,
	"reason" text NOT NULL,
	"note" text,
	"suppressed_by_oxy_user_id" text NOT NULL,
	"suppressed_at" timestamp with time zone NOT NULL,
	"lifted_at" timestamp with time zone,
	"lifted_by_oxy_user_id" text,
	"lift_reason" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "catalog_entity_suppressions_entity_type_check" CHECK ("catalog_entity_suppressions"."entity_type" in ('organization', 'brand', 'merchant', 'storefront', 'canonical_product_family', 'canonical_product', 'canonical_variant', 'offer')),
	CONSTRAINT "catalog_entity_suppressions_scope_check" CHECK ("catalog_entity_suppressions"."scope" in ('public_discovery')),
	CONSTRAINT "catalog_entity_suppressions_reason_check" CHECK ("catalog_entity_suppressions"."reason" in ('suspected_duplicate', 'unverified_claim', 'data_quality', 'legal_request', 'pending_investigation')),
	CONSTRAINT "catalog_entity_suppressions_entity_id_check" CHECK (btrim("catalog_entity_suppressions"."entity_id") <> ''),
	CONSTRAINT "catalog_entity_suppressions_actor_check" CHECK (btrim("catalog_entity_suppressions"."suppressed_by_oxy_user_id") <> ''),
	CONSTRAINT "catalog_entity_suppressions_lift_state_check" CHECK ("catalog_entity_suppressions"."lifted_at" is null
          or ("catalog_entity_suppressions"."lifted_by_oxy_user_id" is not null and btrim(coalesce("catalog_entity_suppressions"."lift_reason", '')) <> '')),
	CONSTRAINT "catalog_entity_suppressions_note_length_check" CHECK ("catalog_entity_suppressions"."note" is null or length("catalog_entity_suppressions"."note") <= 2000)
);
--> statement-breakpoint
CREATE TABLE "catalog_merge_conflicts" (
	"id" text PRIMARY KEY NOT NULL,
	"job_id" text NOT NULL,
	"kind" text NOT NULL,
	"loser_identifier_id" text,
	"winner_identifier_id" text,
	"loser_variant_id" text,
	"winner_variant_id" text,
	"loser_relationship_id" text,
	"winner_relationship_id" text,
	"loser_offer_id" text,
	"winner_offer_id" text,
	"loser_claim_id" text,
	"winner_claim_id" text,
	"detail" text NOT NULL,
	"resolution" text,
	"resolved_by_oxy_user_id" text,
	"resolved_at" timestamp with time zone,
	"resolution_reason" text,
	"child_job_id" text,
	"applied_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"conflict_key" text GENERATED ALWAYS AS (coalesce("loser_identifier_id", '') || '|' || coalesce("winner_identifier_id", '') || '|' ||
            coalesce("loser_variant_id", '') || '|' || coalesce("winner_variant_id", '') || '|' ||
            coalesce("loser_relationship_id", '') || '|' || coalesce("winner_relationship_id", '') || '|' ||
            coalesce("loser_offer_id", '') || '|' || coalesce("winner_offer_id", '') || '|' ||
            coalesce("loser_claim_id", '') || '|' || coalesce("winner_claim_id", '')) STORED NOT NULL,
	CONSTRAINT "catalog_merge_conflicts_kind_check" CHECK ("catalog_merge_conflicts"."kind" in ('identifier', 'variant_signature', 'default_variant', 'relationship_endpoint', 'active_offer', 'verified_claim')),
	CONSTRAINT "catalog_merge_conflicts_resolution_check" CHECK ("catalog_merge_conflicts"."resolution" in ('keep_winner', 'keep_loser', 'merge_pair')),
	CONSTRAINT "catalog_merge_conflicts_pair_shape_check" CHECK (case "catalog_merge_conflicts"."kind"
            when 'identifier' then
              "catalog_merge_conflicts"."loser_identifier_id" is not null and "catalog_merge_conflicts"."winner_identifier_id" is not null
              and "catalog_merge_conflicts"."loser_variant_id" is null and "catalog_merge_conflicts"."winner_variant_id" is null
              and "catalog_merge_conflicts"."loser_relationship_id" is null and "catalog_merge_conflicts"."winner_relationship_id" is null
              and "catalog_merge_conflicts"."loser_offer_id" is null and "catalog_merge_conflicts"."winner_offer_id" is null
              and "catalog_merge_conflicts"."loser_claim_id" is null and "catalog_merge_conflicts"."winner_claim_id" is null
            when 'variant_signature' then
              "catalog_merge_conflicts"."loser_variant_id" is not null and "catalog_merge_conflicts"."winner_variant_id" is not null
              and "catalog_merge_conflicts"."loser_identifier_id" is null and "catalog_merge_conflicts"."winner_identifier_id" is null
              and "catalog_merge_conflicts"."loser_relationship_id" is null and "catalog_merge_conflicts"."winner_relationship_id" is null
              and "catalog_merge_conflicts"."loser_offer_id" is null and "catalog_merge_conflicts"."winner_offer_id" is null
              and "catalog_merge_conflicts"."loser_claim_id" is null and "catalog_merge_conflicts"."winner_claim_id" is null
            when 'default_variant' then
              "catalog_merge_conflicts"."loser_variant_id" is not null and "catalog_merge_conflicts"."winner_variant_id" is not null
              and "catalog_merge_conflicts"."loser_identifier_id" is null and "catalog_merge_conflicts"."winner_identifier_id" is null
              and "catalog_merge_conflicts"."loser_relationship_id" is null and "catalog_merge_conflicts"."winner_relationship_id" is null
              and "catalog_merge_conflicts"."loser_offer_id" is null and "catalog_merge_conflicts"."winner_offer_id" is null
              and "catalog_merge_conflicts"."loser_claim_id" is null and "catalog_merge_conflicts"."winner_claim_id" is null
            when 'relationship_endpoint' then
              "catalog_merge_conflicts"."loser_relationship_id" is not null and "catalog_merge_conflicts"."winner_relationship_id" is not null
              and "catalog_merge_conflicts"."loser_identifier_id" is null and "catalog_merge_conflicts"."winner_identifier_id" is null
              and "catalog_merge_conflicts"."loser_variant_id" is null and "catalog_merge_conflicts"."winner_variant_id" is null
              and "catalog_merge_conflicts"."loser_offer_id" is null and "catalog_merge_conflicts"."winner_offer_id" is null
              and "catalog_merge_conflicts"."loser_claim_id" is null and "catalog_merge_conflicts"."winner_claim_id" is null
            when 'active_offer' then
              "catalog_merge_conflicts"."loser_offer_id" is not null and "catalog_merge_conflicts"."winner_offer_id" is not null
              and "catalog_merge_conflicts"."loser_identifier_id" is null and "catalog_merge_conflicts"."winner_identifier_id" is null
              and "catalog_merge_conflicts"."loser_variant_id" is null and "catalog_merge_conflicts"."winner_variant_id" is null
              and "catalog_merge_conflicts"."loser_relationship_id" is null and "catalog_merge_conflicts"."winner_relationship_id" is null
              and "catalog_merge_conflicts"."loser_claim_id" is null and "catalog_merge_conflicts"."winner_claim_id" is null
            when 'verified_claim' then
              "catalog_merge_conflicts"."loser_claim_id" is not null and "catalog_merge_conflicts"."winner_claim_id" is not null
              and "catalog_merge_conflicts"."loser_identifier_id" is null and "catalog_merge_conflicts"."winner_identifier_id" is null
              and "catalog_merge_conflicts"."loser_variant_id" is null and "catalog_merge_conflicts"."winner_variant_id" is null
              and "catalog_merge_conflicts"."loser_relationship_id" is null and "catalog_merge_conflicts"."winner_relationship_id" is null
              and "catalog_merge_conflicts"."loser_offer_id" is null and "catalog_merge_conflicts"."winner_offer_id" is null
            else false
          end),
	CONSTRAINT "catalog_merge_conflicts_distinct_pair_check" CHECK (("catalog_merge_conflicts"."loser_identifier_id" is null or "catalog_merge_conflicts"."winner_identifier_id" is null
           or "catalog_merge_conflicts"."loser_identifier_id" <> "catalog_merge_conflicts"."winner_identifier_id")
          and ("catalog_merge_conflicts"."loser_variant_id" is null or "catalog_merge_conflicts"."winner_variant_id" is null
               or "catalog_merge_conflicts"."loser_variant_id" <> "catalog_merge_conflicts"."winner_variant_id")
          and ("catalog_merge_conflicts"."loser_relationship_id" is null or "catalog_merge_conflicts"."winner_relationship_id" is null
               or "catalog_merge_conflicts"."loser_relationship_id" <> "catalog_merge_conflicts"."winner_relationship_id")
          and ("catalog_merge_conflicts"."loser_offer_id" is null or "catalog_merge_conflicts"."winner_offer_id" is null
               or "catalog_merge_conflicts"."loser_offer_id" <> "catalog_merge_conflicts"."winner_offer_id")
          and ("catalog_merge_conflicts"."loser_claim_id" is null or "catalog_merge_conflicts"."winner_claim_id" is null
               or "catalog_merge_conflicts"."loser_claim_id" <> "catalog_merge_conflicts"."winner_claim_id")),
	CONSTRAINT "catalog_merge_conflicts_detail_check" CHECK (btrim("catalog_merge_conflicts"."detail") <> ''),
	CONSTRAINT "catalog_merge_conflicts_resolution_state_check" CHECK ("catalog_merge_conflicts"."resolution" is null
          or ("catalog_merge_conflicts"."resolved_by_oxy_user_id" is not null and "catalog_merge_conflicts"."resolved_at" is not null
              and btrim(coalesce("catalog_merge_conflicts"."resolution_reason", '')) <> '')),
	CONSTRAINT "catalog_merge_conflicts_unresolved_state_check" CHECK ("catalog_merge_conflicts"."resolution" is not null
          or ("catalog_merge_conflicts"."resolved_by_oxy_user_id" is null and "catalog_merge_conflicts"."resolved_at" is null
              and "catalog_merge_conflicts"."resolution_reason" is null and "catalog_merge_conflicts"."child_job_id" is null
              and "catalog_merge_conflicts"."applied_at" is null)),
	CONSTRAINT "catalog_merge_conflicts_merge_pair_kind_check" CHECK ("catalog_merge_conflicts"."resolution" is distinct from 'merge_pair'
          or "catalog_merge_conflicts"."kind" in ('variant_signature')),
	CONSTRAINT "catalog_merge_conflicts_child_job_check" CHECK (("catalog_merge_conflicts"."child_job_id" is not null) = ("catalog_merge_conflicts"."resolution" is not distinct from 'merge_pair')),
	CONSTRAINT "catalog_merge_conflicts_reason_length_check" CHECK ("catalog_merge_conflicts"."resolution_reason" is null or length("catalog_merge_conflicts"."resolution_reason") <= 2000),
	CONSTRAINT "catalog_merge_conflicts_applied_check" CHECK ("catalog_merge_conflicts"."applied_at" is null or "catalog_merge_conflicts"."resolved_at" is not null)
);
--> statement-breakpoint
CREATE TABLE "catalog_merge_job_phases" (
	"id" text PRIMARY KEY NOT NULL,
	"job_id" text NOT NULL,
	"phase" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"rows_affected" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "catalog_merge_job_phases_phase_check" CHECK ("catalog_merge_job_phases"."phase" in ('plan', 'awaiting_resolution', 'children', 'identifiers', 'aliases', 'source_links', 'offers', 'relationships', 'reviews', 'redirects', 'rollups', 'verify', 'done')),
	CONSTRAINT "catalog_merge_job_phases_rows_check" CHECK ("catalog_merge_job_phases"."rows_affected" >= 0),
	CONSTRAINT "catalog_merge_job_phases_completion_check" CHECK ("catalog_merge_job_phases"."completed_at" is null or "catalog_merge_job_phases"."completed_at" >= "catalog_merge_job_phases"."started_at")
);
--> statement-breakpoint
CREATE TABLE "catalog_merge_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"entity_type" text NOT NULL,
	"loser_id" text NOT NULL,
	"winner_id" text NOT NULL,
	"phase" text DEFAULT 'plan' NOT NULL,
	"reason" text NOT NULL,
	"requested_by_oxy_user_id" text NOT NULL,
	"approved_by_oxy_user_id" text,
	"approved_at" timestamp with time zone,
	"requires_second_approval" boolean DEFAULT false NOT NULL,
	"parent_job_id" text,
	"review_item_id" text,
	"impact_source_links" integer DEFAULT 0 NOT NULL,
	"impact_identifiers" integer DEFAULT 0 NOT NULL,
	"impact_aliases" integer DEFAULT 0 NOT NULL,
	"impact_offers" integer DEFAULT 0 NOT NULL,
	"impact_native_listing_links" integer DEFAULT 0 NOT NULL,
	"impact_relationships" integer DEFAULT 0 NOT NULL,
	"impact_reviews" integer DEFAULT 0 NOT NULL,
	"impact_child_entities" integer DEFAULT 0 NOT NULL,
	"impact_attribute_values" integer DEFAULT 0 NOT NULL,
	"impact_images" integer DEFAULT 0 NOT NULL,
	"impact_untouched_order_items" integer DEFAULT 0 NOT NULL,
	"impact_total_moving" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone NOT NULL,
	"lease_owner" text,
	"lease_until" timestamp with time zone,
	"last_error" text,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "catalog_merge_jobs_entity_type_check" CHECK ("catalog_merge_jobs"."entity_type" in ('organization', 'brand', 'merchant', 'storefront', 'canonical_product_family', 'canonical_product', 'canonical_variant')),
	CONSTRAINT "catalog_merge_jobs_phase_check" CHECK ("catalog_merge_jobs"."phase" in ('plan', 'awaiting_resolution', 'children', 'identifiers', 'aliases', 'source_links', 'offers', 'relationships', 'reviews', 'redirects', 'rollups', 'verify', 'done')),
	CONSTRAINT "catalog_merge_jobs_status_check" CHECK ("catalog_merge_jobs"."status" in ('pending', 'processing', 'blocked', 'completed', 'failed', 'dead_letter', 'cancelled')),
	CONSTRAINT "catalog_merge_jobs_attempts_check" CHECK ("catalog_merge_jobs"."attempts" >= 0),
	CONSTRAINT "catalog_merge_jobs_lease_complete_check" CHECK (num_nonnulls("catalog_merge_jobs"."lease_owner", "catalog_merge_jobs"."lease_until") in (0, 2)),
	CONSTRAINT "catalog_merge_jobs_last_error_length_check" CHECK ("catalog_merge_jobs"."last_error" is null or length("catalog_merge_jobs"."last_error") <= 2000),
	CONSTRAINT "catalog_merge_jobs_completion_check" CHECK (("catalog_merge_jobs"."status" = 'completed') = ("catalog_merge_jobs"."completed_at" is not null)),
	CONSTRAINT "catalog_merge_jobs_impact_non_negative_check" CHECK ("catalog_merge_jobs"."impact_source_links" >= 0 and "catalog_merge_jobs"."impact_identifiers" >= 0
          and "catalog_merge_jobs"."impact_aliases" >= 0 and "catalog_merge_jobs"."impact_offers" >= 0
          and "catalog_merge_jobs"."impact_native_listing_links" >= 0 and "catalog_merge_jobs"."impact_relationships" >= 0
          and "catalog_merge_jobs"."impact_reviews" >= 0 and "catalog_merge_jobs"."impact_child_entities" >= 0
          and "catalog_merge_jobs"."impact_attribute_values" >= 0 and "catalog_merge_jobs"."impact_images" >= 0
          and "catalog_merge_jobs"."impact_untouched_order_items" >= 0 and "catalog_merge_jobs"."impact_total_moving" >= 0),
	CONSTRAINT "catalog_merge_jobs_impact_total_check" CHECK ("catalog_merge_jobs"."impact_total_moving" = "catalog_merge_jobs"."impact_source_links" + "catalog_merge_jobs"."impact_identifiers"
          + "catalog_merge_jobs"."impact_aliases" + "catalog_merge_jobs"."impact_offers" + "catalog_merge_jobs"."impact_native_listing_links"
          + "catalog_merge_jobs"."impact_relationships" + "catalog_merge_jobs"."impact_reviews" + "catalog_merge_jobs"."impact_child_entities"
          + "catalog_merge_jobs"."impact_attribute_values" + "catalog_merge_jobs"."impact_images"),
	CONSTRAINT "catalog_merge_jobs_reason_check" CHECK (btrim("catalog_merge_jobs"."reason") <> ''),
	CONSTRAINT "catalog_merge_jobs_reason_length_check" CHECK (length("catalog_merge_jobs"."reason") <= 2000),
	CONSTRAINT "catalog_merge_jobs_actor_check" CHECK (btrim("catalog_merge_jobs"."requested_by_oxy_user_id") <> ''),
	CONSTRAINT "catalog_merge_jobs_distinct_check" CHECK ("catalog_merge_jobs"."loser_id" <> "catalog_merge_jobs"."winner_id"),
	CONSTRAINT "catalog_merge_jobs_parent_self_check" CHECK ("catalog_merge_jobs"."parent_job_id" is null or "catalog_merge_jobs"."parent_job_id" <> "catalog_merge_jobs"."id"),
	CONSTRAINT "catalog_merge_jobs_approver_distinct_check" CHECK ("catalog_merge_jobs"."approved_by_oxy_user_id" is null or "catalog_merge_jobs"."approved_by_oxy_user_id" <> "catalog_merge_jobs"."requested_by_oxy_user_id"),
	CONSTRAINT "catalog_merge_jobs_approval_state_check" CHECK (("catalog_merge_jobs"."approved_by_oxy_user_id" is null) = ("catalog_merge_jobs"."approved_at" is null)),
	CONSTRAINT "catalog_merge_jobs_second_approval_check" CHECK (not "catalog_merge_jobs"."requires_second_approval"
            or "catalog_merge_jobs"."phase" in ('plan', 'awaiting_resolution')
            or "catalog_merge_jobs"."approved_by_oxy_user_id" is not null),
	CONSTRAINT "catalog_merge_jobs_completed_phase_check" CHECK ("catalog_merge_jobs"."status" <> 'completed' or "catalog_merge_jobs"."phase" = 'done')
);
--> statement-breakpoint
CREATE TABLE "catalog_review_items" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"detector" text NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" text NOT NULL,
	"counterpart_type" text,
	"counterpart_id" text,
	"reason_codes" text[] DEFAULT '{}'::text[] NOT NULL,
	"confidence" double precision,
	"state" text DEFAULT 'open' NOT NULL,
	"assigned_to_oxy_user_id" text,
	"assigned_at" timestamp with time zone,
	"resolution" text,
	"resolution_reason" text,
	"resolved_by_oxy_user_id" text,
	"resolved_at" timestamp with time zone,
	"match_decision_id" text,
	"policy_version_id" text,
	"source_record_id" text,
	"detection_count" integer DEFAULT 1 NOT NULL,
	"first_detected_at" timestamp with time zone NOT NULL,
	"last_detected_at" timestamp with time zone NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"dedupe_key" text GENERATED ALWAYS AS ("kind" || '|' || "subject_type" || '|' || "subject_id" || '|' ||
            coalesce("counterpart_type", '') || '|' || coalesce("counterpart_id", '')) STORED NOT NULL,
	CONSTRAINT "catalog_review_items_kind_check" CHECK ("catalog_review_items"."kind" in ('ambiguous_match', 'identifier_conflict', 'entity_collision', 'relationship_candidate', 'source_fact_disagreement', 'suspected_duplicate', 'orphaned_record', 'policy_regression')),
	CONSTRAINT "catalog_review_items_detector_check" CHECK ("catalog_review_items"."detector" in ('match_pipeline', 'identifier_collision_gate', 'duplicate_scan', 'relationship_intake', 'attribute_conflict_scan', 'orphan_scan', 'policy_regression_scan', 'operator')),
	CONSTRAINT "catalog_review_items_subject_type_check" CHECK ("catalog_review_items"."subject_type" in ('organization', 'brand', 'merchant', 'storefront', 'canonical_product_family', 'canonical_product', 'canonical_variant', 'product_identifier', 'commerce_relationship', 'source_record', 'offer', 'match_decision', 'canonical_attribute_value')),
	CONSTRAINT "catalog_review_items_counterpart_type_check" CHECK ("catalog_review_items"."counterpart_type" in ('organization', 'brand', 'merchant', 'storefront', 'canonical_product_family', 'canonical_product', 'canonical_variant', 'product_identifier', 'commerce_relationship', 'source_record', 'offer', 'match_decision', 'canonical_attribute_value')),
	CONSTRAINT "catalog_review_items_state_check" CHECK ("catalog_review_items"."state" in ('open', 'in_review', 'resolved', 'dismissed')),
	CONSTRAINT "catalog_review_items_resolution_check" CHECK ("catalog_review_items"."resolution" in ('matched_to_entity', 'created_entity', 'rejected_candidate', 'merged', 'split', 'reassigned_identifier', 'corrected_value', 'relationship_decided', 'suppressed', 'compensated', 'no_action_needed', 'not_reproducible')),
	CONSTRAINT "catalog_review_items_reason_codes_check" CHECK ("catalog_review_items"."reason_codes" <@ array['ambiguous_candidates', 'conflicting_identifier', 'brand_disagreement', 'no_deterministic_support', 'normalized_name_collision', 'shared_domain', 'shared_identifier', 'variant_signature_collision', 'awaiting_evidence', 'insufficient_evidence', 'sources_disagree', 'no_selected_value', 'unattached_source_record', 'unattached_offer', 'lost_automatic_match', 'gained_blocker', 'operator_referred']::text[]),
	CONSTRAINT "catalog_review_items_subject_id_check" CHECK (btrim("catalog_review_items"."subject_id") <> ''),
	CONSTRAINT "catalog_review_items_counterpart_pair_check" CHECK (num_nonnulls("catalog_review_items"."counterpart_type", "catalog_review_items"."counterpart_id") in (0, 2)),
	CONSTRAINT "catalog_review_items_pair_shape_check" CHECK (("catalog_review_items"."kind" in ('identifier_conflict', 'entity_collision', 'suspected_duplicate'))
          = ("catalog_review_items"."counterpart_id" is not null)),
	CONSTRAINT "catalog_review_items_self_pair_check" CHECK ("catalog_review_items"."counterpart_id" is null
          or "catalog_review_items"."counterpart_id" <> "catalog_review_items"."subject_id"
          or "catalog_review_items"."counterpart_type" <> "catalog_review_items"."subject_type"),
	CONSTRAINT "catalog_review_items_pair_order_check" CHECK ("catalog_review_items"."kind" not in ('entity_collision', 'suspected_duplicate')
          or "catalog_review_items"."subject_id" < "catalog_review_items"."counterpart_id"),
	CONSTRAINT "catalog_review_items_confidence_check" CHECK ("catalog_review_items"."confidence" is null or ("catalog_review_items"."confidence" >= 0 and "catalog_review_items"."confidence" <= 1)),
	CONSTRAINT "catalog_review_items_assignment_check" CHECK (num_nonnulls("catalog_review_items"."assigned_to_oxy_user_id", "catalog_review_items"."assigned_at") in (0, 2)),
	CONSTRAINT "catalog_review_items_closure_check" CHECK (case when "catalog_review_items"."state" in ('resolved', 'dismissed')
                 then "catalog_review_items"."resolution" is not null and "catalog_review_items"."resolved_by_oxy_user_id" is not null
                      and "catalog_review_items"."resolved_at" is not null
                      and btrim(coalesce("catalog_review_items"."resolution_reason", '')) <> ''
                 else "catalog_review_items"."resolution" is null and "catalog_review_items"."resolved_by_oxy_user_id" is null
                      and "catalog_review_items"."resolved_at" is null and "catalog_review_items"."resolution_reason" is null
           end),
	CONSTRAINT "catalog_review_items_dismissal_check" CHECK ("catalog_review_items"."state" <> 'dismissed'
          or "catalog_review_items"."resolution" in ('no_action_needed', 'not_reproducible')),
	CONSTRAINT "catalog_review_items_resolved_action_check" CHECK ("catalog_review_items"."state" <> 'resolved'
          or "catalog_review_items"."resolution" not in ('no_action_needed', 'not_reproducible')),
	CONSTRAINT "catalog_review_items_match_decision_check" CHECK ("catalog_review_items"."match_decision_id" is null or "catalog_review_items"."kind" = 'ambiguous_match'),
	CONSTRAINT "catalog_review_items_counts_check" CHECK ("catalog_review_items"."detection_count" >= 1 and "catalog_review_items"."last_detected_at" >= "catalog_review_items"."first_detected_at"),
	CONSTRAINT "catalog_review_items_note_length_check" CHECK ("catalog_review_items"."note" is null or length("catalog_review_items"."note") <= 2000),
	CONSTRAINT "catalog_review_items_reason_length_check" CHECK ("catalog_review_items"."resolution_reason" is null or length("catalog_review_items"."resolution_reason") <= 2000)
);
--> statement-breakpoint
CREATE TABLE "catalog_revisions" (
	"id" text PRIMARY KEY NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"action" text NOT NULL,
	"actor_kind" text NOT NULL,
	"actor_oxy_user_id" text,
	"reason" text NOT NULL,
	"note" text,
	"source_record_id" text,
	"policy_version_id" text,
	"merge_job_id" text,
	"split_job_id" text,
	"review_item_id" text,
	"compensates_revision_id" text,
	"before" jsonb,
	"after" jsonb,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "catalog_revisions_entity_type_check" CHECK ("catalog_revisions"."entity_type" in ('organization', 'brand', 'merchant', 'storefront', 'canonical_product_family', 'canonical_product', 'canonical_variant', 'product_identifier', 'commerce_relationship', 'source_record', 'offer', 'match_decision', 'canonical_attribute_value')),
	CONSTRAINT "catalog_revisions_action_check" CHECK ("catalog_revisions"."action" in ('create', 'update', 'merge', 'split', 'correct', 'verify', 'revoke', 'redirect', 'link_source', 'reject_candidate', 'reassign_identifier', 'suppress', 'unsuppress', 'compensate')),
	CONSTRAINT "catalog_revisions_actor_kind_check" CHECK ("catalog_revisions"."actor_kind" in ('operator', 'ingestion', 'backfill')),
	CONSTRAINT "catalog_revisions_entity_id_check" CHECK (btrim("catalog_revisions"."entity_id") <> ''),
	CONSTRAINT "catalog_revisions_reason_check" CHECK (btrim("catalog_revisions"."reason") <> ''),
	CONSTRAINT "catalog_revisions_reason_length_check" CHECK (length("catalog_revisions"."reason") <= 2000),
	CONSTRAINT "catalog_revisions_note_length_check" CHECK ("catalog_revisions"."note" is null or length("catalog_revisions"."note") <= 2000),
	CONSTRAINT "catalog_revisions_actor_presence_check" CHECK (("catalog_revisions"."actor_kind" = 'operator') = ("catalog_revisions"."actor_oxy_user_id" is not null)),
	CONSTRAINT "catalog_revisions_actor_shape_check" CHECK ("catalog_revisions"."actor_oxy_user_id" is null or btrim("catalog_revisions"."actor_oxy_user_id") <> ''),
	CONSTRAINT "catalog_revisions_job_check" CHECK (num_nonnulls("catalog_revisions"."merge_job_id", "catalog_revisions"."split_job_id") <= 1),
	CONSTRAINT "catalog_revisions_compensates_self_check" CHECK ("catalog_revisions"."compensates_revision_id" is null or "catalog_revisions"."compensates_revision_id" <> "catalog_revisions"."id"),
	CONSTRAINT "catalog_revisions_compensation_shape_check" CHECK (("catalog_revisions"."action" = 'compensate') = ("catalog_revisions"."compensates_revision_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "catalog_split_assignments" (
	"id" text PRIMARY KEY NOT NULL,
	"job_id" text NOT NULL,
	"item_type" text NOT NULL,
	"item_ref" text NOT NULL,
	"applied_at" timestamp with time zone,
	"skipped_reason" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "catalog_split_assignments_item_type_check" CHECK ("catalog_split_assignments"."item_type" in ('canonical_variant', 'product_identifier', 'source_link', 'offer', 'native_listing_link', 'alias', 'attribute_value', 'image')),
	CONSTRAINT "catalog_split_assignments_item_ref_check" CHECK (btrim("catalog_split_assignments"."item_ref") <> ''),
	CONSTRAINT "catalog_split_assignments_outcome_check" CHECK ("catalog_split_assignments"."applied_at" is null or "catalog_split_assignments"."skipped_reason" is null),
	CONSTRAINT "catalog_split_assignments_skip_length_check" CHECK ("catalog_split_assignments"."skipped_reason" is null or length("catalog_split_assignments"."skipped_reason") <= 2000)
);
--> statement-breakpoint
CREATE TABLE "catalog_split_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"entity_type" text NOT NULL,
	"source_entity_id" text NOT NULL,
	"target_mode" text NOT NULL,
	"target_entity_id" text,
	"target_slug" text,
	"target_name" text,
	"phase" text DEFAULT 'plan' NOT NULL,
	"reason" text NOT NULL,
	"requested_by_oxy_user_id" text NOT NULL,
	"approved_by_oxy_user_id" text,
	"approved_at" timestamp with time zone,
	"requires_second_approval" boolean DEFAULT false NOT NULL,
	"reverses_merge_job_id" text,
	"review_item_id" text,
	"impact_source_links" integer DEFAULT 0 NOT NULL,
	"impact_identifiers" integer DEFAULT 0 NOT NULL,
	"impact_aliases" integer DEFAULT 0 NOT NULL,
	"impact_offers" integer DEFAULT 0 NOT NULL,
	"impact_native_listing_links" integer DEFAULT 0 NOT NULL,
	"impact_relationships" integer DEFAULT 0 NOT NULL,
	"impact_reviews" integer DEFAULT 0 NOT NULL,
	"impact_child_entities" integer DEFAULT 0 NOT NULL,
	"impact_attribute_values" integer DEFAULT 0 NOT NULL,
	"impact_images" integer DEFAULT 0 NOT NULL,
	"impact_untouched_order_items" integer DEFAULT 0 NOT NULL,
	"impact_total_moving" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone NOT NULL,
	"lease_owner" text,
	"lease_until" timestamp with time zone,
	"last_error" text,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "catalog_split_jobs_entity_type_check" CHECK ("catalog_split_jobs"."entity_type" in ('canonical_product', 'canonical_variant')),
	CONSTRAINT "catalog_split_jobs_target_mode_check" CHECK ("catalog_split_jobs"."target_mode" in ('revive_tombstone', 'new_entity')),
	CONSTRAINT "catalog_split_jobs_phase_check" CHECK ("catalog_split_jobs"."phase" in ('plan', 'mint', 'assignments', 'redirects', 'rollups', 'verify', 'done')),
	CONSTRAINT "catalog_split_jobs_status_check" CHECK ("catalog_split_jobs"."status" in ('pending', 'processing', 'blocked', 'completed', 'failed', 'dead_letter', 'cancelled')),
	CONSTRAINT "catalog_split_jobs_attempts_check" CHECK ("catalog_split_jobs"."attempts" >= 0),
	CONSTRAINT "catalog_split_jobs_lease_complete_check" CHECK (num_nonnulls("catalog_split_jobs"."lease_owner", "catalog_split_jobs"."lease_until") in (0, 2)),
	CONSTRAINT "catalog_split_jobs_last_error_length_check" CHECK ("catalog_split_jobs"."last_error" is null or length("catalog_split_jobs"."last_error") <= 2000),
	CONSTRAINT "catalog_split_jobs_completion_check" CHECK (("catalog_split_jobs"."status" = 'completed') = ("catalog_split_jobs"."completed_at" is not null)),
	CONSTRAINT "catalog_split_jobs_impact_non_negative_check" CHECK ("catalog_split_jobs"."impact_source_links" >= 0 and "catalog_split_jobs"."impact_identifiers" >= 0
          and "catalog_split_jobs"."impact_aliases" >= 0 and "catalog_split_jobs"."impact_offers" >= 0
          and "catalog_split_jobs"."impact_native_listing_links" >= 0 and "catalog_split_jobs"."impact_relationships" >= 0
          and "catalog_split_jobs"."impact_reviews" >= 0 and "catalog_split_jobs"."impact_child_entities" >= 0
          and "catalog_split_jobs"."impact_attribute_values" >= 0 and "catalog_split_jobs"."impact_images" >= 0
          and "catalog_split_jobs"."impact_untouched_order_items" >= 0 and "catalog_split_jobs"."impact_total_moving" >= 0),
	CONSTRAINT "catalog_split_jobs_impact_total_check" CHECK ("catalog_split_jobs"."impact_total_moving" = "catalog_split_jobs"."impact_source_links" + "catalog_split_jobs"."impact_identifiers"
          + "catalog_split_jobs"."impact_aliases" + "catalog_split_jobs"."impact_offers" + "catalog_split_jobs"."impact_native_listing_links"
          + "catalog_split_jobs"."impact_relationships" + "catalog_split_jobs"."impact_reviews" + "catalog_split_jobs"."impact_child_entities"
          + "catalog_split_jobs"."impact_attribute_values" + "catalog_split_jobs"."impact_images"),
	CONSTRAINT "catalog_split_jobs_reason_check" CHECK (btrim("catalog_split_jobs"."reason") <> ''),
	CONSTRAINT "catalog_split_jobs_reason_length_check" CHECK (length("catalog_split_jobs"."reason") <= 2000),
	CONSTRAINT "catalog_split_jobs_actor_check" CHECK (btrim("catalog_split_jobs"."requested_by_oxy_user_id") <> ''),
	CONSTRAINT "catalog_split_jobs_target_shape_check" CHECK (case "catalog_split_jobs"."target_mode"
              when 'revive_tombstone' then
                "catalog_split_jobs"."target_entity_id" is not null and "catalog_split_jobs"."target_slug" is null and "catalog_split_jobs"."target_name" is null
              when 'new_entity' then
                btrim(coalesce("catalog_split_jobs"."target_slug", '')) <> '' and btrim(coalesce("catalog_split_jobs"."target_name", '')) <> ''
              else false
            end),
	CONSTRAINT "catalog_split_jobs_new_entity_grain_check" CHECK ("catalog_split_jobs"."target_mode" <> 'new_entity' or "catalog_split_jobs"."entity_type" = 'canonical_product'),
	CONSTRAINT "catalog_split_jobs_distinct_check" CHECK ("catalog_split_jobs"."target_entity_id" is null or "catalog_split_jobs"."target_entity_id" <> "catalog_split_jobs"."source_entity_id"),
	CONSTRAINT "catalog_split_jobs_destination_before_assignment_check" CHECK ("catalog_split_jobs"."phase" in ('plan', 'mint') or "catalog_split_jobs"."target_entity_id" is not null),
	CONSTRAINT "catalog_split_jobs_approver_distinct_check" CHECK ("catalog_split_jobs"."approved_by_oxy_user_id" is null or "catalog_split_jobs"."approved_by_oxy_user_id" <> "catalog_split_jobs"."requested_by_oxy_user_id"),
	CONSTRAINT "catalog_split_jobs_approval_state_check" CHECK (("catalog_split_jobs"."approved_by_oxy_user_id" is null) = ("catalog_split_jobs"."approved_at" is null)),
	CONSTRAINT "catalog_split_jobs_second_approval_check" CHECK (not "catalog_split_jobs"."requires_second_approval" or "catalog_split_jobs"."phase" = 'plan' or "catalog_split_jobs"."approved_by_oxy_user_id" is not null),
	CONSTRAINT "catalog_split_jobs_completed_phase_check" CHECK ("catalog_split_jobs"."status" <> 'completed' or "catalog_split_jobs"."phase" = 'done')
);
--> statement-breakpoint
ALTER TABLE "catalog_merge_conflicts" ADD CONSTRAINT "catalog_merge_conflicts_job_id_catalog_merge_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."catalog_merge_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_merge_conflicts" ADD CONSTRAINT "catalog_merge_conflicts_loser_identifier_id_product_identifiers_id_fk" FOREIGN KEY ("loser_identifier_id") REFERENCES "public"."product_identifiers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_merge_conflicts" ADD CONSTRAINT "catalog_merge_conflicts_winner_identifier_id_product_identifiers_id_fk" FOREIGN KEY ("winner_identifier_id") REFERENCES "public"."product_identifiers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_merge_conflicts" ADD CONSTRAINT "catalog_merge_conflicts_loser_variant_id_canonical_variants_id_fk" FOREIGN KEY ("loser_variant_id") REFERENCES "public"."canonical_variants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_merge_conflicts" ADD CONSTRAINT "catalog_merge_conflicts_winner_variant_id_canonical_variants_id_fk" FOREIGN KEY ("winner_variant_id") REFERENCES "public"."canonical_variants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_merge_conflicts" ADD CONSTRAINT "catalog_merge_conflicts_loser_relationship_id_commerce_relationships_id_fk" FOREIGN KEY ("loser_relationship_id") REFERENCES "public"."commerce_relationships"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_merge_conflicts" ADD CONSTRAINT "catalog_merge_conflicts_winner_relationship_id_commerce_relationships_id_fk" FOREIGN KEY ("winner_relationship_id") REFERENCES "public"."commerce_relationships"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_merge_conflicts" ADD CONSTRAINT "catalog_merge_conflicts_loser_offer_id_offers_id_fk" FOREIGN KEY ("loser_offer_id") REFERENCES "public"."offers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_merge_conflicts" ADD CONSTRAINT "catalog_merge_conflicts_winner_offer_id_offers_id_fk" FOREIGN KEY ("winner_offer_id") REFERENCES "public"."offers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_merge_conflicts" ADD CONSTRAINT "catalog_merge_conflicts_loser_claim_id_merchant_claims_id_fk" FOREIGN KEY ("loser_claim_id") REFERENCES "public"."merchant_claims"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_merge_conflicts" ADD CONSTRAINT "catalog_merge_conflicts_winner_claim_id_merchant_claims_id_fk" FOREIGN KEY ("winner_claim_id") REFERENCES "public"."merchant_claims"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_merge_conflicts" ADD CONSTRAINT "catalog_merge_conflicts_child_job_id_catalog_merge_jobs_id_fk" FOREIGN KEY ("child_job_id") REFERENCES "public"."catalog_merge_jobs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_merge_job_phases" ADD CONSTRAINT "catalog_merge_job_phases_job_id_catalog_merge_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."catalog_merge_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_merge_jobs" ADD CONSTRAINT "catalog_merge_jobs_parent_job_id_catalog_merge_jobs_id_fk" FOREIGN KEY ("parent_job_id") REFERENCES "public"."catalog_merge_jobs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_merge_jobs" ADD CONSTRAINT "catalog_merge_jobs_review_item_id_catalog_review_items_id_fk" FOREIGN KEY ("review_item_id") REFERENCES "public"."catalog_review_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_review_items" ADD CONSTRAINT "catalog_review_items_match_decision_id_match_decisions_id_fk" FOREIGN KEY ("match_decision_id") REFERENCES "public"."match_decisions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_review_items" ADD CONSTRAINT "catalog_review_items_policy_version_id_match_policy_versions_id_fk" FOREIGN KEY ("policy_version_id") REFERENCES "public"."match_policy_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_review_items" ADD CONSTRAINT "catalog_review_items_source_record_id_source_records_id_fk" FOREIGN KEY ("source_record_id") REFERENCES "public"."source_records"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_revisions" ADD CONSTRAINT "catalog_revisions_source_record_id_source_records_id_fk" FOREIGN KEY ("source_record_id") REFERENCES "public"."source_records"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_revisions" ADD CONSTRAINT "catalog_revisions_policy_version_id_match_policy_versions_id_fk" FOREIGN KEY ("policy_version_id") REFERENCES "public"."match_policy_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_revisions" ADD CONSTRAINT "catalog_revisions_merge_job_id_catalog_merge_jobs_id_fk" FOREIGN KEY ("merge_job_id") REFERENCES "public"."catalog_merge_jobs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_revisions" ADD CONSTRAINT "catalog_revisions_split_job_id_catalog_split_jobs_id_fk" FOREIGN KEY ("split_job_id") REFERENCES "public"."catalog_split_jobs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_revisions" ADD CONSTRAINT "catalog_revisions_review_item_id_catalog_review_items_id_fk" FOREIGN KEY ("review_item_id") REFERENCES "public"."catalog_review_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_revisions" ADD CONSTRAINT "catalog_revisions_compensates_revision_id_catalog_revisions_id_fk" FOREIGN KEY ("compensates_revision_id") REFERENCES "public"."catalog_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_split_assignments" ADD CONSTRAINT "catalog_split_assignments_job_id_catalog_split_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."catalog_split_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_split_jobs" ADD CONSTRAINT "catalog_split_jobs_reverses_merge_job_id_catalog_merge_jobs_id_fk" FOREIGN KEY ("reverses_merge_job_id") REFERENCES "public"."catalog_merge_jobs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_split_jobs" ADD CONSTRAINT "catalog_split_jobs_review_item_id_catalog_review_items_id_fk" FOREIGN KEY ("review_item_id") REFERENCES "public"."catalog_review_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "catalog_entity_suppressions_open_key" ON "catalog_entity_suppressions" USING btree ("entity_type","entity_id","scope") WHERE "catalog_entity_suppressions"."lifted_at" is null;--> statement-breakpoint
CREATE INDEX "catalog_entity_suppressions_entity_idx" ON "catalog_entity_suppressions" USING btree ("entity_type","entity_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "catalog_merge_conflicts_identity_key" ON "catalog_merge_conflicts" USING btree ("job_id","kind","conflict_key");--> statement-breakpoint
CREATE UNIQUE INDEX "catalog_merge_conflicts_child_job_key" ON "catalog_merge_conflicts" USING btree ("child_job_id") WHERE "catalog_merge_conflicts"."child_job_id" is not null;--> statement-breakpoint
CREATE INDEX "catalog_merge_conflicts_unresolved_idx" ON "catalog_merge_conflicts" USING btree ("job_id") WHERE "catalog_merge_conflicts"."resolution" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "catalog_merge_job_phases_key" ON "catalog_merge_job_phases" USING btree ("job_id","phase");--> statement-breakpoint
CREATE INDEX "catalog_merge_job_phases_job_idx" ON "catalog_merge_job_phases" USING btree ("job_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "catalog_merge_jobs_open_key" ON "catalog_merge_jobs" USING btree ("entity_type","loser_id") WHERE "catalog_merge_jobs"."status" in ('pending', 'processing', 'blocked');--> statement-breakpoint
CREATE INDEX "catalog_merge_jobs_pending_idx" ON "catalog_merge_jobs" USING btree ("available_at","created_at") WHERE "catalog_merge_jobs"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "catalog_merge_jobs_reclaim_idx" ON "catalog_merge_jobs" USING btree ("lease_until","created_at") WHERE "catalog_merge_jobs"."status" = 'processing';--> statement-breakpoint
CREATE INDEX "catalog_merge_jobs_blocked_idx" ON "catalog_merge_jobs" USING btree ("created_at") WHERE "catalog_merge_jobs"."status" = 'blocked';--> statement-breakpoint
CREATE INDEX "catalog_merge_jobs_winner_idx" ON "catalog_merge_jobs" USING btree ("entity_type","winner_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "catalog_merge_jobs_parent_idx" ON "catalog_merge_jobs" USING btree ("parent_job_id") WHERE "catalog_merge_jobs"."parent_job_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "catalog_review_items_open_key" ON "catalog_review_items" USING btree ("dedupe_key") WHERE "catalog_review_items"."state" in ('open', 'in_review');--> statement-breakpoint
CREATE INDEX "catalog_review_items_inbox_idx" ON "catalog_review_items" USING btree ("kind","first_detected_at") WHERE "catalog_review_items"."state" in ('open', 'in_review');--> statement-breakpoint
CREATE INDEX "catalog_review_items_assignee_idx" ON "catalog_review_items" USING btree ("assigned_to_oxy_user_id","state") WHERE "catalog_review_items"."assigned_to_oxy_user_id" is not null;--> statement-breakpoint
CREATE INDEX "catalog_review_items_subject_idx" ON "catalog_review_items" USING btree ("subject_type","subject_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "catalog_review_items_counterpart_idx" ON "catalog_review_items" USING btree ("counterpart_type","counterpart_id") WHERE "catalog_review_items"."counterpart_id" is not null;--> statement-breakpoint
CREATE INDEX "catalog_review_items_reason_codes_idx" ON "catalog_review_items" USING gin ("reason_codes");--> statement-breakpoint
CREATE INDEX "catalog_review_items_match_decision_idx" ON "catalog_review_items" USING btree ("match_decision_id") WHERE "catalog_review_items"."match_decision_id" is not null;--> statement-breakpoint
CREATE INDEX "catalog_revisions_entity_idx" ON "catalog_revisions" USING btree ("entity_type","entity_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "catalog_revisions_action_idx" ON "catalog_revisions" USING btree ("action","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "catalog_revisions_actor_idx" ON "catalog_revisions" USING btree ("actor_oxy_user_id","created_at" DESC NULLS LAST) WHERE "catalog_revisions"."actor_oxy_user_id" is not null;--> statement-breakpoint
CREATE INDEX "catalog_revisions_merge_job_idx" ON "catalog_revisions" USING btree ("merge_job_id") WHERE "catalog_revisions"."merge_job_id" is not null;--> statement-breakpoint
CREATE INDEX "catalog_revisions_split_job_idx" ON "catalog_revisions" USING btree ("split_job_id") WHERE "catalog_revisions"."split_job_id" is not null;--> statement-breakpoint
CREATE INDEX "catalog_revisions_review_item_idx" ON "catalog_revisions" USING btree ("review_item_id") WHERE "catalog_revisions"."review_item_id" is not null;--> statement-breakpoint
CREATE INDEX "catalog_revisions_compensates_idx" ON "catalog_revisions" USING btree ("compensates_revision_id") WHERE "catalog_revisions"."compensates_revision_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "catalog_split_assignments_key" ON "catalog_split_assignments" USING btree ("job_id","item_type","item_ref");--> statement-breakpoint
CREATE INDEX "catalog_split_assignments_pending_idx" ON "catalog_split_assignments" USING btree ("job_id","item_type") WHERE "catalog_split_assignments"."applied_at" is null and "catalog_split_assignments"."skipped_reason" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "catalog_split_jobs_open_key" ON "catalog_split_jobs" USING btree ("entity_type","source_entity_id") WHERE "catalog_split_jobs"."status" in ('pending', 'processing', 'blocked');--> statement-breakpoint
CREATE INDEX "catalog_split_jobs_pending_idx" ON "catalog_split_jobs" USING btree ("available_at","created_at") WHERE "catalog_split_jobs"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "catalog_split_jobs_reclaim_idx" ON "catalog_split_jobs" USING btree ("lease_until","created_at") WHERE "catalog_split_jobs"."status" = 'processing';--> statement-breakpoint
CREATE INDEX "catalog_split_jobs_blocked_idx" ON "catalog_split_jobs" USING btree ("created_at") WHERE "catalog_split_jobs"."status" = 'blocked';--> statement-breakpoint
CREATE INDEX "catalog_split_jobs_reverses_idx" ON "catalog_split_jobs" USING btree ("reverses_merge_job_id") WHERE "catalog_split_jobs"."reverses_merge_job_id" is not null;
--> statement-breakpoint
-- ── #59's immutability triggers ────────────────────────────────────────────
--
-- Six of them, and each guards a property a CHECK cannot express because it
-- constrains a row against its own HISTORY. The `fee_schedule_versions`,
-- `match_policy_versions` and `analytics_events` precedent, applied to the
-- operator surface: a backfill script and an operator at a `psql` prompt both
-- reach these tables without the service, so "the service never does that" is
-- not a property of the data.

-- 1. The audit timeline cannot be edited or erased (#59 acceptance 4).
-- DELETE is refused too, unlike `analytics_events`, and the inversion is
-- deliberate: analytics permits DELETE because erasure on schedule is its
-- policy, while a revision that could be deleted would let the record of a
-- merge disappear along with the reason somebody performed it.
CREATE FUNCTION mercaria_catalog_revision_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'catalog_revisions is append-only: % on %.% is refused. The audit timeline is what an operator is accountable to (#59 acceptance 4, ADR 0002 D16); a row that can be rewritten is not a record. A mistake is corrected by a compensating revision, never by editing this one.',
    TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME
    USING ERRCODE = 'check_violation';
END;
$$;--> statement-breakpoint
CREATE TRIGGER catalog_revisions_append_only
  BEFORE UPDATE OR DELETE ON "catalog_revisions"
  FOR EACH ROW EXECUTE FUNCTION mercaria_catalog_revision_append_only();--> statement-breakpoint

-- 2. A phase record is written once and stamped complete once (#59 acceptance 3).
-- This is what makes a resumed job trustworthy: the resume decides what to skip
-- by reading these rows, so a phase record somebody could re-open would let a
-- completed phase run twice or an unfinished one be skipped.
CREATE FUNCTION mercaria_catalog_merge_phase_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION
      'catalog_merge_job_phases is append-only: DELETE on %.% is refused. A resumed merge decides what to skip by reading these rows.',
      TG_TABLE_SCHEMA, TG_TABLE_NAME
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.job_id IS DISTINCT FROM OLD.job_id
     OR NEW.phase IS DISTINCT FROM OLD.phase
     OR NEW.started_at IS DISTINCT FROM OLD.started_at
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION
      'catalog_merge_job_phases identity is immutable: only completed_at and rows_affected may be written, and only once.'
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.completed_at IS NOT NULL THEN
    RAISE EXCEPTION
      'catalog_merge_job_phases row for phase % is already complete; re-opening it would let a merge phase run twice.',
      OLD.phase
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER catalog_merge_job_phases_append_only
  BEFORE UPDATE OR DELETE ON "catalog_merge_job_phases"
  FOR EACH ROW EXECUTE FUNCTION mercaria_catalog_merge_phase_append_only();--> statement-breakpoint

-- 3. A merge job's SUBJECT never moves (#59 merge invariants 1-3).
-- Repointing a running job's winner would rehome half a losing entity's
-- children to one survivor and half to another, and no row would say so. The
-- lease, phase, status and impact columns stay writable; the identity does not.
CREATE FUNCTION mercaria_catalog_merge_job_subject_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.entity_type IS DISTINCT FROM OLD.entity_type
     OR NEW.loser_id IS DISTINCT FROM OLD.loser_id
     OR NEW.winner_id IS DISTINCT FROM OLD.winner_id
     OR NEW.requested_by_oxy_user_id IS DISTINCT FROM OLD.requested_by_oxy_user_id THEN
    RAISE EXCEPTION
      'a merge job''s entity type, loser, winner and requester are immutable (#59 merge invariants 1-3): repointing a running merge would rehome one entity''s children to two survivors with no record of the split.'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER catalog_merge_jobs_subject_immutable
  BEFORE UPDATE ON "catalog_merge_jobs"
  FOR EACH ROW EXECUTE FUNCTION mercaria_catalog_merge_job_subject_immutable();--> statement-breakpoint

-- 4. A conflict's identity is immutable, and a decision that was APPLIED cannot
-- be changed (#59 merge invariant 4).
-- The resolution is what the merge acted on; editing it afterwards would make
-- the audit trail describe a decision nobody executed.
CREATE FUNCTION mercaria_catalog_merge_conflict_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- The eight endpoint columns, NOT the generated `conflict_key` that summarises
  -- them. A STORED GENERATED column is computed AFTER every BEFORE trigger has
  -- run, so `NEW.conflict_key` is NULL here while `OLD.conflict_key` holds a
  -- value -- comparing them raises on EVERY update, including the ordinary one
  -- that records an operator's resolution. Caught by the realdb suite; the
  -- comparison below states the same fact from columns that are populated.
  IF NEW.job_id IS DISTINCT FROM OLD.job_id
     OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.loser_identifier_id IS DISTINCT FROM OLD.loser_identifier_id
     OR NEW.winner_identifier_id IS DISTINCT FROM OLD.winner_identifier_id
     OR NEW.loser_variant_id IS DISTINCT FROM OLD.loser_variant_id
     OR NEW.winner_variant_id IS DISTINCT FROM OLD.winner_variant_id
     OR NEW.loser_relationship_id IS DISTINCT FROM OLD.loser_relationship_id
     OR NEW.winner_relationship_id IS DISTINCT FROM OLD.winner_relationship_id
     OR NEW.loser_offer_id IS DISTINCT FROM OLD.loser_offer_id
     OR NEW.winner_offer_id IS DISTINCT FROM OLD.winner_offer_id
     OR NEW.loser_claim_id IS DISTINCT FROM OLD.loser_claim_id
     OR NEW.winner_claim_id IS DISTINCT FROM OLD.winner_claim_id THEN
    RAISE EXCEPTION
      'a merge conflict''s job, kind and colliding pair are immutable; a different collision is a different row.'
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.applied_at IS NOT NULL
     AND (NEW.resolution IS DISTINCT FROM OLD.resolution
          OR NEW.resolved_by_oxy_user_id IS DISTINCT FROM OLD.resolved_by_oxy_user_id
          OR NEW.child_job_id IS DISTINCT FROM OLD.child_job_id) THEN
    RAISE EXCEPTION
      'merge conflict % was already applied; its resolution is what the merge acted on and cannot be rewritten.',
      OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER catalog_merge_conflicts_immutable
  BEFORE UPDATE ON "catalog_merge_conflicts"
  FOR EACH ROW EXECUTE FUNCTION mercaria_catalog_merge_conflict_immutable();--> statement-breakpoint

-- 5. A SPLIT NAMES EXACTLY WHAT MOVES, and the list is fixed before anything
-- does (#59 split invariant 1).
--
-- Two halves, and both are needed. The INSERT half refuses a new assignment
-- once the job has left `plan`, so the set an operator approved with an impact
-- estimate beside it is the set that executes -- this is the ONE cross-table
-- read in the domain's triggers, and it is here because the alternative is a
-- service rule that a `psql` INSERT walks straight past. The UPDATE half makes
-- an applied assignment terminal, so a resumed `assignments` phase can trust
-- `applied_at` as its skip list rather than re-deriving what already moved.
CREATE FUNCTION mercaria_catalog_split_assignment_frozen() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  job_phase text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION
      'catalog_split_assignments is the record of exactly what a split moves (#59 split invariant 1): DELETE on %.% is refused. An item that should not move is recorded with a skipped_reason.',
      TG_TABLE_SCHEMA, TG_TABLE_NAME
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT phase INTO job_phase FROM catalog_split_jobs WHERE id = NEW.job_id;
    IF job_phase IS DISTINCT FROM 'plan' THEN
      RAISE EXCEPTION
        'split job % has left the plan phase (it is in %); its assignment list is frozen, because the impact an operator approved was measured over exactly this set.',
        NEW.job_id, job_phase
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.job_id IS DISTINCT FROM OLD.job_id
     OR NEW.item_type IS DISTINCT FROM OLD.item_type
     OR NEW.item_ref IS DISTINCT FROM OLD.item_ref THEN
    RAISE EXCEPTION
      'a split assignment names one row and never another; retarget it by recording a new assignment.'
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.applied_at IS NOT NULL AND NEW.applied_at IS DISTINCT FROM OLD.applied_at THEN
    RAISE EXCEPTION
      'split assignment % has already been applied; a resumed split reads applied_at as its skip list.',
      OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER catalog_split_assignments_frozen
  BEFORE INSERT OR UPDATE OR DELETE ON "catalog_split_assignments"
  FOR EACH ROW EXECUTE FUNCTION mercaria_catalog_split_assignment_frozen();--> statement-breakpoint

-- 6. A closed review item stays closed.
-- Convergence is scoped to the OPEN states on purpose: a problem that comes
-- back after somebody fixed it is new information and gets a new item. Letting
-- a resolved item be re-opened would bury that recurrence under an old
-- resolution and lose the fact that the fix did not hold.
CREATE FUNCTION mercaria_catalog_review_item_closure() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.state IN ('resolved', 'dismissed') AND NEW.state NOT IN ('resolved', 'dismissed') THEN
    RAISE EXCEPTION
      'review item % is closed (%); a recurrence opens a NEW item so the regression stays visible.',
      OLD.id, OLD.state
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.subject_type IS DISTINCT FROM OLD.subject_type
     OR NEW.subject_id IS DISTINCT FROM OLD.subject_id
     OR NEW.counterpart_type IS DISTINCT FROM OLD.counterpart_type
     OR NEW.counterpart_id IS DISTINCT FROM OLD.counterpart_id THEN
    RAISE EXCEPTION
      'a review item''s kind and subjects are immutable; a different question about a different row is a different item.'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER catalog_review_items_closure
  BEFORE UPDATE ON "catalog_review_items"
  FOR EACH ROW EXECUTE FUNCTION mercaria_catalog_review_item_closure();
