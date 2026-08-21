-- oxy:deploy-phase=pre
-- oxy:rollback=restore: catalog_review_items_detector_check and catalog_review_items_reason_codes_check are widened; the previous forms are in the migration that created the table and re-adding either fails against any review item carrying an added detector or reason code
--
-- #72 widens two of #59's closed value sets so a READER can dispute a published
-- catalogue fact: the detector `public_correction` and the reason code
-- `public_correction_submitted`. Both are strict SUPERSETS of what the serving
-- image writes, which is what makes this `pre` — the previous image only ever
-- writes values the widened CHECKs still admit, so it keeps running against
-- this schema unchanged.
--
-- The DROP/ADD pair is how every closed-set widening in this schema is
-- rendered (drizzle-kit emits no ALTER CONSTRAINT), and the momentary absence
-- of the constraint inside one transaction is not a window anything can write
-- through.

ALTER TABLE "catalog_review_items" DROP CONSTRAINT "catalog_review_items_detector_check";--> statement-breakpoint
ALTER TABLE "catalog_review_items" DROP CONSTRAINT "catalog_review_items_reason_codes_check";--> statement-breakpoint
ALTER TABLE "catalog_review_items" ADD CONSTRAINT "catalog_review_items_detector_check" CHECK ("catalog_review_items"."detector" in ('match_pipeline', 'identifier_collision_gate', 'duplicate_scan', 'relationship_intake', 'attribute_conflict_scan', 'orphan_scan', 'policy_regression_scan', 'operator', 'public_correction'));--> statement-breakpoint
ALTER TABLE "catalog_review_items" ADD CONSTRAINT "catalog_review_items_reason_codes_check" CHECK ("catalog_review_items"."reason_codes" <@ array['ambiguous_candidates', 'conflicting_identifier', 'brand_disagreement', 'no_deterministic_support', 'normalized_name_collision', 'shared_domain', 'shared_identifier', 'variant_signature_collision', 'awaiting_evidence', 'insufficient_evidence', 'sources_disagree', 'no_selected_value', 'unattached_source_record', 'unattached_offer', 'lost_automatic_match', 'gained_blocker', 'operator_referred', 'public_correction_submitted']::text[]);