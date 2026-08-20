-- oxy:deploy-phase=pre
--
-- The attribute-claim settlement act and its audit subject (#576).
--
-- ADDITIVE, despite the three DROP CONSTRAINT lines — each is drizzle-kit's
-- rendering of a CHECK CHANGE and every one of them WIDENS. Verified rather than
-- eyeballed, by diffing each new tuple against the constraint on a real server:
-- `action` gains `attribute_claim_settle`, `subject_kind` gains
-- `native_attribute_claim` on both tables, and NOTHING is removed from any of
-- the three. The previously serving image writes only the old values, which the
-- new CHECKs still admit, so no write it performs is broken. The drops are
-- momentary and inside the same transaction as their re-adds. (Same rendering
-- and same reasoning as `0121`, and the precedent AGENTS.md states for adding a
-- CurrencyCode.)
--
-- ## Why the surface needed a new subject kind rather than reusing one
--
-- The subject of a settlement is a CLAIM — a row in
-- `native_variant_attribute_claims` or `native_listing_attribute_claims` —
-- and the closest existing kind, `attribute_definition`, is a different thing
-- entirely: the definition is what the claim RESOLVES TO. Filing settlements
-- under it would put "somebody re-settled a seller's colour claim" into the
-- trail an operator reads when an attribute definition went wrong.
--
-- ONE kind covers both grains. The grain is carried in the audit `before`/`after`
-- and `subject_id` is the claim's own id, so "every settlement of a claim" stays
-- a one-value query — which is how the trail is actually read.
--
-- The companion `post` migration (`0124`) adds the clause that refuses a
-- settlement contradicting a published typed value; it is separate because it
-- NARROWS.

ALTER TABLE "catalog_governance_audit_events" DROP CONSTRAINT "catalog_governance_audit_events_action_check";--> statement-breakpoint
ALTER TABLE "catalog_governance_audit_events" DROP CONSTRAINT "catalog_governance_audit_events_subject_kind_check";--> statement-breakpoint
ALTER TABLE "catalog_governance_change_requests" DROP CONSTRAINT "catalog_governance_change_requests_subject_kind_check";--> statement-breakpoint
ALTER TABLE "catalog_governance_audit_events" ADD CONSTRAINT "catalog_governance_audit_events_action_check" CHECK ("catalog_governance_audit_events"."action" in ('taxonomy_rename', 'taxonomy_move', 'taxonomy_merge', 'taxonomy_redirect', 'taxonomy_publish', 'taxonomy_deprecate', 'taxonomy_suppress', 'taxonomy_restore', 'product_type_publish', 'product_type_deprecate', 'attribute_publish', 'attribute_deprecate', 'attribute_retire', 'navigation_publish', 'navigation_archive', 'definition_snapshot_restore', 'vertical_package_apply', 'localization_review', 'external_mapping_approve', 'external_mapping_reject', 'external_mapping_fan_out_approve', 'compatibility_claim_review', 'compatibility_claim_promote', 'attribute_claim_settle', 'proposal_approve', 'proposal_merge', 'proposal_reject', 'proposal_request_information', 'proposal_defer', 'proposal_redirect', 'change_requested', 'change_approved', 'change_applied', 'change_rejected', 'change_withdrawn', 'change_failed', 'role_granted', 'role_revoked', 'snapshot_exported'));--> statement-breakpoint
ALTER TABLE "catalog_governance_audit_events" ADD CONSTRAINT "catalog_governance_audit_events_subject_kind_check" CHECK ("catalog_governance_audit_events"."subject_kind" in ('category', 'product_type_definition', 'attribute_definition', 'navigation_tree', 'definition_snapshot', 'vertical_package', 'operator_role', 'external_mapping', 'compatibility_claim', 'native_attribute_claim'));--> statement-breakpoint
ALTER TABLE "catalog_governance_change_requests" ADD CONSTRAINT "catalog_governance_change_requests_subject_kind_check" CHECK ("catalog_governance_change_requests"."subject_kind" in ('category', 'product_type_definition', 'attribute_definition', 'navigation_tree', 'definition_snapshot', 'vertical_package', 'operator_role', 'external_mapping', 'compatibility_claim', 'native_attribute_claim'));