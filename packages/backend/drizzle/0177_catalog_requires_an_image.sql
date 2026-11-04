-- oxy:deploy-phase=pre
-- oxy:rollback=replay: canonical_products.status — the demoted products are reference_products drafts; reference_promotion re-promotes each once it shows an image
ALTER TABLE "catalog_backfill_records" DROP CONSTRAINT "catalog_backfill_records_reason_check";--> statement-breakpoint
ALTER TABLE "catalog_backfill_records" DROP CONSTRAINT "catalog_backfill_records_reason_outcome_check";--> statement-breakpoint
ALTER TABLE "catalog_backfill_records" ADD CONSTRAINT "catalog_backfill_records_reason_check" CHECK ("catalog_backfill_records"."reason_code" in ('merchant_minted', 'store_already_linked', 'store_not_active', 'store_owner_unresolved', 'store_link_conflict', 'vendor_candidate_recorded', 'vendor_candidate_unchanged', 'vendor_candidate_ambiguous', 'match_enqueued', 'provisional_product_minted', 'variant_attached', 'attachment_exists', 'blocked_by_decision', 'awaiting_match_decision', 'p2p_left_unattached', 'identifier_disputed', 'offer_convergence_enqueued', 'no_active_attachment', 'projection_refreshed', 'projection_current', 'reindex_requested', 'reindex_disabled', 'consistent', 'offer_missing_for_attachment', 'offer_listing_not_active', 'offer_link_missing', 'offer_variant_mismatch', 'reference_product_minted', 'reference_no_identifier', 'reference_no_image', 'identifier_already_owned', 'readvance_matched', 'readvance_unmatched', 'readvance_review_required', 'readvance_requested', 'reference_product_promoted', 'promotion_awaiting_offer', 'promotion_awaiting_image', 'out_of_cohort', 'write_publication_disabled', 'record_error'));--> statement-breakpoint
ALTER TABLE "catalog_backfill_records" ADD CONSTRAINT "catalog_backfill_records_reason_outcome_check" CHECK (case "catalog_backfill_records"."reason_code" when 'merchant_minted' then "catalog_backfill_records"."outcome" in ('created') when 'store_already_linked' then "catalog_backfill_records"."outcome" in ('unchanged') when 'store_not_active' then "catalog_backfill_records"."outcome" in ('skipped') when 'store_owner_unresolved' then "catalog_backfill_records"."outcome" in ('skipped') when 'store_link_conflict' then "catalog_backfill_records"."outcome" in ('failed') when 'vendor_candidate_recorded' then "catalog_backfill_records"."outcome" in ('created') when 'vendor_candidate_unchanged' then "catalog_backfill_records"."outcome" in ('unchanged') when 'vendor_candidate_ambiguous' then "catalog_backfill_records"."outcome" in ('review_required') when 'match_enqueued' then "catalog_backfill_records"."outcome" in ('enqueued') when 'provisional_product_minted' then "catalog_backfill_records"."outcome" in ('created') when 'variant_attached' then "catalog_backfill_records"."outcome" in ('matched') when 'attachment_exists' then "catalog_backfill_records"."outcome" in ('unchanged') when 'blocked_by_decision' then "catalog_backfill_records"."outcome" in ('review_required') when 'awaiting_match_decision' then "catalog_backfill_records"."outcome" in ('skipped') when 'p2p_left_unattached' then "catalog_backfill_records"."outcome" in ('unmatched') when 'identifier_disputed' then "catalog_backfill_records"."outcome" in ('review_required') when 'offer_convergence_enqueued' then "catalog_backfill_records"."outcome" in ('enqueued') when 'no_active_attachment' then "catalog_backfill_records"."outcome" in ('unmatched') when 'projection_refreshed' then "catalog_backfill_records"."outcome" in ('created') when 'projection_current' then "catalog_backfill_records"."outcome" in ('unchanged') when 'reindex_requested' then "catalog_backfill_records"."outcome" in ('enqueued') when 'reindex_disabled' then "catalog_backfill_records"."outcome" in ('skipped') when 'consistent' then "catalog_backfill_records"."outcome" in ('unchanged') when 'offer_missing_for_attachment' then "catalog_backfill_records"."outcome" in ('review_required') when 'offer_listing_not_active' then "catalog_backfill_records"."outcome" in ('review_required') when 'offer_link_missing' then "catalog_backfill_records"."outcome" in ('review_required') when 'offer_variant_mismatch' then "catalog_backfill_records"."outcome" in ('review_required') when 'reference_product_minted' then "catalog_backfill_records"."outcome" in ('created') when 'reference_no_identifier' then "catalog_backfill_records"."outcome" in ('skipped') when 'reference_no_image' then "catalog_backfill_records"."outcome" in ('skipped') when 'identifier_already_owned' then "catalog_backfill_records"."outcome" in ('skipped') when 'readvance_matched' then "catalog_backfill_records"."outcome" in ('matched') when 'readvance_unmatched' then "catalog_backfill_records"."outcome" in ('unmatched') when 'readvance_review_required' then "catalog_backfill_records"."outcome" in ('review_required') when 'readvance_requested' then "catalog_backfill_records"."outcome" in ('enqueued') when 'reference_product_promoted' then "catalog_backfill_records"."outcome" in ('created') when 'promotion_awaiting_offer' then "catalog_backfill_records"."outcome" in ('skipped') when 'promotion_awaiting_image' then "catalog_backfill_records"."outcome" in ('skipped') when 'out_of_cohort' then "catalog_backfill_records"."outcome" in ('skipped') when 'write_publication_disabled' then "catalog_backfill_records"."outcome" in ('skipped') when 'record_error' then "catalog_backfill_records"."outcome" in ('failed') else false end);
--> statement-breakpoint
-- Mercaria accepts no product without at least one image (the owner,
-- 2026-10-20). `reference_products` now mints none (`reference_no_image`) and
-- `reference_promotion` promotes none (`promotion_awaiting_image`); the products
-- already active with no image — every one of them minted by
-- `reference_products`, whose sources published none — go back to draft, the
-- status no shopper sees. Should one come to show an image, `reference_promotion`
-- promotes it again. A product a Mercaria store sells (an active native offer)
-- is never touched here.
-- oxy:handwritten-begin=catalog_requires_an_image
UPDATE "canonical_products" p
   SET "status" = 'draft', "updated_at" = date_trunc('milliseconds', now())
 WHERE p."status" = 'active'
   AND NOT EXISTS (
     SELECT 1 FROM "canonical_images" ci
      WHERE ci."product_id" = p."id" AND ci."status" = 'active' AND ci."file_id" IS NOT NULL
   )
   AND NOT EXISTS (
     SELECT 1 FROM "canonical_variants" v
       JOIN "offers" o ON o."canonical_variant_id" = v."id"
      WHERE v."product_id" = p."id" AND o."status" = 'active' AND o."kind" = 'native'
   )
   AND EXISTS (
     SELECT 1 FROM "catalog_backfill_records" r
      WHERE r."canonical_product_id" = p."id"
        AND r."stage" = 'reference_products' AND r."mode" = 'apply'
        AND r."reason_code" = 'reference_product_minted'
   );
-- oxy:handwritten-end=catalog_requires_an_image
