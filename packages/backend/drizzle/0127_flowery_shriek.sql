-- oxy:deploy-phase=post
--
-- Narrow `attribute_value_reviews_reason_check`: drop `definition_deprecated`
-- (#636).
--
-- POST, and the rule is met literally: this statement breaks a write the
-- PREVIOUS image performs. The previous image's `AttributeReviewReason` still
-- contains the member, so an image that has not rolled forward could in
-- principle insert one; after this, the server refuses it.
--
-- In practice it cannot have: `openAttributeReview` is the only writer of this
-- column, its two callers pass exactly four reasons, and `reviewPriority` is
-- typed to the same four — so no code path has ever produced the value being
-- removed. That is the same fact that motivates the cut, and it is what makes
-- the narrowing safe without a backfill: there can be no existing row to
-- violate it.
--
-- `invalid_category_attribute` is RETAINED, and is not an oversight — it is the
-- record of a capability the catalogue advertises and does not have (#791).

ALTER TABLE "attribute_value_reviews" DROP CONSTRAINT "attribute_value_reviews_reason_check";--> statement-breakpoint
ALTER TABLE "attribute_value_reviews" ADD CONSTRAINT "attribute_value_reviews_reason_check" CHECK ("attribute_value_reviews"."reason" in ('conflicting_sources', 'implausible_value', 'unknown_unit', 'marketing_claim', 'invalid_category_attribute'));