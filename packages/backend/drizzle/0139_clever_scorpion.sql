-- oxy:deploy-phase=post
-- oxy:rollback=restore: the previous forms of product_type_fields_variant_axis_check and native_listing_variant_axes_forbidden_key_check, neither of which is in this file — a DROP CONSTRAINT carries no definition. The prior forms are in 0089 and 0097 respectively, and both are re-derivable from PRODUCT_TYPE_FORBIDDEN_VARIANT_AXIS_KEYS at the parent commit
--
-- Epic #367 line 144 — "Define how bundles, services, digital goods and
-- non-standard future commerce types fit or are intentionally excluded", the
-- BUNDLE half. ADR 0007 D15.
--
-- No table, column, index or trigger is added or dropped and no existing row is
-- written. Both statements NARROW one CHECK apiece by widening the tuple it is
-- rendered from — hence `post`: the serving image still accepts a
-- `variant_capable` field on a composition key until it is replaced, and a
-- narrowing applied before the rollout would refuse a write the old image
-- performs.
--
-- ## What changed and why it is a narrowing rather than a new rule
--
-- `PRODUCT_TYPE_COMPOSITION_AXIS_KEYS` joins the reserved offer facts and the
-- compatibility targets in `PRODUCT_TYPE_FORBIDDEN_VARIANT_AXIS_KEYS`. ADR 0002
-- D15 makes a bundle its OWN canonical product whose contents are
-- `bundle_components` rows — a relationship between two variants, with its own
-- quantity, its own self-containment CHECK and its own merge-conflict kind. An
-- attribute AXIS spelling the same fact would be a second representation of it,
-- and it would fail in the multiplying direction: one variant per thing the
-- bundle contains, which is the 400-SKU explosion ADR 0007 D8 already refuses
-- for a brake pad's fitment.
--
-- The keys stay DEFINABLE — "what's in the box" is an ordinary product-scope
-- specification. What they may not be is an option row. That is the same
-- asymmetry the compatibility list carries.
--
-- ## The two tables, and the second one was not predicted
--
-- The tuple is read by `product_type_fields_variant_axis_check` (an OPERATOR
-- drafting a schema) and by `native_listing_variant_axes_forbidden_key_check` (a
-- SELLER authoring their own listing). The regenerated file is what surfaced the
-- second, which is the reason the house rule is to read the generated SQL rather
-- than the declaration: the seller-authored side is where a merchant would
-- actually try to make "includes" an axis.
--
-- ## `pack_count` is deliberately NOT in the tuple
--
-- ADR 0002 D15 makes a multipack a variant of the SAME product carrying exactly
-- that axis and its own GTIN, so forbidding it would make every
-- six-pack-and-single pair unrepresentable. The absence is load-bearing and
-- `product-type-composition-axis.test.ts` pins it.
--
-- ## No existing row violates either constraint
--
-- Measured before generating: no `attributeKey` anywhere in the repository — in
-- a seed, a fixture or a vertical package — names any of the twelve keys. Every
-- occurrence of `contains` is a collection-rule OPERATOR, and `bundle_components`
-- appears only as the table's own name.
ALTER TABLE "product_type_fields" DROP CONSTRAINT "product_type_fields_variant_axis_check";--> statement-breakpoint
ALTER TABLE "native_listing_variant_axes" DROP CONSTRAINT "native_listing_variant_axes_forbidden_key_check";--> statement-breakpoint
ALTER TABLE "product_type_fields" ADD CONSTRAINT "product_type_fields_variant_axis_check" CHECK ("product_type_fields"."variant_capable" is false
          or ("product_type_fields"."scope" = 'variant'
              and "product_type_fields"."attribute_key" <> all (array['price', 'sale_price', 'list_price', 'current_price', 'total_price', 'known_total', 'availability', 'in_stock', 'stock', 'stock_level', 'inventory', 'condition', 'shipping_cost', 'shipping_price', 'delivery_cost', 'delivery_days', 'lead_time', 'seller', 'merchant', 'offer_count', 'vehicle_make', 'vehicle_model', 'vehicle_generation', 'vehicle_configuration', 'vehicle_year', 'vehicle_year_range', 'model_year', 'year_range', 'fitment', 'fits_vehicle', 'compatible_with', 'compatible_model', 'compatibility', 'bundle_components', 'bundle_contents', 'bundle_items', 'box_contents', 'in_the_box', 'kit_contents', 'included_items', 'includes', 'contains', 'contents', 'components', 'component_variants']::text[])));--> statement-breakpoint
ALTER TABLE "native_listing_variant_axes" ADD CONSTRAINT "native_listing_variant_axes_forbidden_key_check" CHECK ("native_listing_variant_axes"."attribute_key" <> all (array['price', 'sale_price', 'list_price', 'current_price', 'total_price', 'known_total', 'availability', 'in_stock', 'stock', 'stock_level', 'inventory', 'condition', 'shipping_cost', 'shipping_price', 'delivery_cost', 'delivery_days', 'lead_time', 'seller', 'merchant', 'offer_count', 'vehicle_make', 'vehicle_model', 'vehicle_generation', 'vehicle_configuration', 'vehicle_year', 'vehicle_year_range', 'model_year', 'year_range', 'fitment', 'fits_vehicle', 'compatible_with', 'compatible_model', 'compatibility', 'bundle_components', 'bundle_contents', 'bundle_items', 'box_contents', 'in_the_box', 'kit_contents', 'included_items', 'includes', 'contains', 'contents', 'components', 'component_variants']::text[]));