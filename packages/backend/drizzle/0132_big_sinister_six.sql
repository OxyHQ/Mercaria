-- oxy:deploy-phase=pre
-- oxy:rollback=restore: eleven provenance CHECKs including attribute_labels_provenance_check and listing_localizations_provenance_check are widened; the previous forms are in the #367 localization migrations and re-adding any of them fails against a row carrying an added provenance
--
-- `seller` joins the localization provenance vocabulary (#814, ADR 0007 D4).
--
-- ## Why `pre`, when every pair here opens with a DROP
--
-- The phase is decided by what the statement does to the SERVING image, not by
-- which keyword it opens with. Each pair replaces a CHECK with a STRICT
-- SUPERSET of itself, so:
--
--   * it cannot fail on existing rows — every stored value is one of the six the
--     old constraint admitted, and all six are still admitted;
--   * it breaks no write the PREVIOUS image performs — that image never writes
--     `seller`, and everything it does write still passes.
--
-- The reverse assignment is what would break. As `post` this runs AFTER the
-- rollout, so the new image would be serving a seller-authored translation write
-- against the old six-value CHECK and every one of them would fail 23514 — the
-- exact shape `AGENTS.md` records for adding a `CurrencyCode` without its
-- migration: a green build and a first write that fails in production.
--
-- ## Eleven tables, and the eleventh is not a mistake
--
-- Ten render this CHECK from `LOCALIZATION_PROVENANCES`: the eight taking
-- `localizationTextChecks` plus `category_localized_slugs` and
-- `catalog_localization_revisions`. The eleventh, `navigation_node_localizations`,
-- renders from `NAVIGATION_LOCALIZATION_PROVENANCES` — a SECOND copy of the same
-- vocabulary, which `catalog-localization.test.ts` holds equal to the first
-- precisely so the two cannot drift. Widening one and not the other fails that
-- assertion, which is the assertion doing its job. Nobody writes `seller` to a
-- navigation node; a CHECK states what a column MAY hold.
ALTER TABLE "attribute_labels" DROP CONSTRAINT "attribute_labels_provenance_check";--> statement-breakpoint
ALTER TABLE "navigation_node_localizations" DROP CONSTRAINT "navigation_node_localizations_provenance_check";--> statement-breakpoint
ALTER TABLE "attribute_value_localizations" DROP CONSTRAINT "attribute_value_localizations_provenance_check";--> statement-breakpoint
ALTER TABLE "canonical_product_family_localizations" DROP CONSTRAINT "canonical_product_family_localizations_provenance_check";--> statement-breakpoint
ALTER TABLE "canonical_product_localizations" DROP CONSTRAINT "canonical_product_localizations_provenance_check";--> statement-breakpoint
ALTER TABLE "catalog_localization_revisions" DROP CONSTRAINT "catalog_localization_revisions_provenance_check";--> statement-breakpoint
ALTER TABLE "category_localizations" DROP CONSTRAINT "category_localizations_provenance_check";--> statement-breakpoint
ALTER TABLE "category_localized_slugs" DROP CONSTRAINT "category_localized_slugs_provenance_check";--> statement-breakpoint
ALTER TABLE "listing_localizations" DROP CONSTRAINT "listing_localizations_provenance_check";--> statement-breakpoint
ALTER TABLE "product_type_field_localizations" DROP CONSTRAINT "product_type_field_localizations_provenance_check";--> statement-breakpoint
ALTER TABLE "product_type_localizations" DROP CONSTRAINT "product_type_localizations_provenance_check";--> statement-breakpoint
ALTER TABLE "attribute_labels" ADD CONSTRAINT "attribute_labels_provenance_check" CHECK ("attribute_labels"."provenance" in ('mercaria', 'official_brand', 'professional', 'community_reviewed', 'machine', 'imported_source', 'seller'));--> statement-breakpoint
ALTER TABLE "navigation_node_localizations" ADD CONSTRAINT "navigation_node_localizations_provenance_check" CHECK ("navigation_node_localizations"."provenance" in ('mercaria', 'official_brand', 'professional', 'community_reviewed', 'machine', 'imported_source', 'seller'));--> statement-breakpoint
ALTER TABLE "attribute_value_localizations" ADD CONSTRAINT "attribute_value_localizations_provenance_check" CHECK ("attribute_value_localizations"."provenance" in ('mercaria', 'official_brand', 'professional', 'community_reviewed', 'machine', 'imported_source', 'seller'));--> statement-breakpoint
ALTER TABLE "canonical_product_family_localizations" ADD CONSTRAINT "canonical_product_family_localizations_provenance_check" CHECK ("canonical_product_family_localizations"."provenance" in ('mercaria', 'official_brand', 'professional', 'community_reviewed', 'machine', 'imported_source', 'seller'));--> statement-breakpoint
ALTER TABLE "canonical_product_localizations" ADD CONSTRAINT "canonical_product_localizations_provenance_check" CHECK ("canonical_product_localizations"."provenance" in ('mercaria', 'official_brand', 'professional', 'community_reviewed', 'machine', 'imported_source', 'seller'));--> statement-breakpoint
ALTER TABLE "catalog_localization_revisions" ADD CONSTRAINT "catalog_localization_revisions_provenance_check" CHECK ("catalog_localization_revisions"."provenance" in ('mercaria', 'official_brand', 'professional', 'community_reviewed', 'machine', 'imported_source', 'seller'));--> statement-breakpoint
ALTER TABLE "category_localizations" ADD CONSTRAINT "category_localizations_provenance_check" CHECK ("category_localizations"."provenance" in ('mercaria', 'official_brand', 'professional', 'community_reviewed', 'machine', 'imported_source', 'seller'));--> statement-breakpoint
ALTER TABLE "category_localized_slugs" ADD CONSTRAINT "category_localized_slugs_provenance_check" CHECK ("category_localized_slugs"."provenance" in ('mercaria', 'official_brand', 'professional', 'community_reviewed', 'machine', 'imported_source', 'seller'));--> statement-breakpoint
ALTER TABLE "listing_localizations" ADD CONSTRAINT "listing_localizations_provenance_check" CHECK ("listing_localizations"."provenance" in ('mercaria', 'official_brand', 'professional', 'community_reviewed', 'machine', 'imported_source', 'seller'));--> statement-breakpoint
ALTER TABLE "product_type_field_localizations" ADD CONSTRAINT "product_type_field_localizations_provenance_check" CHECK ("product_type_field_localizations"."provenance" in ('mercaria', 'official_brand', 'professional', 'community_reviewed', 'machine', 'imported_source', 'seller'));--> statement-breakpoint
ALTER TABLE "product_type_localizations" ADD CONSTRAINT "product_type_localizations_provenance_check" CHECK ("product_type_localizations"."provenance" in ('mercaria', 'official_brand', 'professional', 'community_reviewed', 'machine', 'imported_source', 'seller'));
