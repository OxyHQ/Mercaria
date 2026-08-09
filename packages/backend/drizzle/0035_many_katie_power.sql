-- oxy:deploy-phase=post
--
-- #90 — the item-condition taxonomy, phase 2 of 2 (THE CLEAN CUT).
--
-- Every statement here BREAKS a write the previous image performs, which is
-- exactly what makes this `post` rather than `pre`:
--
--   * narrowing `listings_condition_check` / `offers_condition_check` refuses
--     the binary `'used'` the pre-#90 image still writes;
--   * dropping `listings.condition_assertion`'s default refuses that image's
--     INSERT outright, since it does not know the column exists;
--   * dropping `offers.condition_mapping_state`'s default does the same to the
--     offer converger.
--
-- The `pre` half already backfilled every row, so nothing here rewrites data —
-- the narrowed CHECKs are validated against a table that has held only taxonomy
-- keys since that migration ran.
--
-- Nothing in this file is hand-written, so a regeneration loses nothing. The
-- hand-written statements all live in the `pre` half.

ALTER TABLE "listings" DROP CONSTRAINT "listings_condition_check";--> statement-breakpoint
ALTER TABLE "offers" DROP CONSTRAINT "offers_condition_check";--> statement-breakpoint
ALTER TABLE "listings" ALTER COLUMN "condition_assertion" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "offers" ALTER COLUMN "condition_mapping_state" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "listings" ADD CONSTRAINT "listings_condition_check" CHECK ("listings"."condition" in ('new', 'open_box', 'refurbished_manufacturer', 'refurbished_seller', 'used_like_new', 'used_good', 'used_fair', 'used_poor', 'for_parts'));--> statement-breakpoint
ALTER TABLE "offers" ADD CONSTRAINT "offers_condition_check" CHECK ("offers"."condition" in ('new', 'open_box', 'refurbished_manufacturer', 'refurbished_seller', 'used_like_new', 'used_good', 'used_fair', 'used_poor', 'for_parts', 'unknown'));