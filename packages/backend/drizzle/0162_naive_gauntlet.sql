-- oxy:deploy-phase=post
-- oxy:rollback=accepted: every place fact Mercaria copied is dropped - location_publications' name, address, timezone, phone, URL, four accessibility flags, coordinate, geocode provenance and generated geo_point; location_opening_hours and location_closures whole; the coordinate pair on location_publication_events - with listings' legacy point (longitude, latitude, geo) and seller_listing_drafts' coarse location. A location's place is the GoWay place locations.go_way_place_id names (0159, ADR 0013), a P2P seller's area is listing_local_discovery's cell, and nothing re-derives a dropped value: export what is needed BEFORE deploying (docs/pickup.md, "Moving to GoWay"). A publication still published without a place is withdrawn by the first block; the previous image cannot run against this schema
--
-- A location's place facts live in GoWay (ADR 0013), second half.
--
-- `post` on every count: it drops columns and tables the previous image reads
-- and writes. `Migrate (post)` runs once the new image is live, and the new
-- image reads none of them.
--
-- ## The hand-written half runs FIRST, above the generated drops
--
-- Two blocks, and their order is the point.
--
-- 1. `0160`'s `published_at` backfill again, verbatim. `0160` ran in this
--    release's `pre` phase; the previous image went on publishing locations
--    without stamping `published_at` until it stopped serving, and those rows
--    are still NULL. Run before block 2, so a publication block 2 withdraws
--    has its first publication recorded and answers 410, not 404 — and so the
--    withdrawal's own trail entry is never what dates its first publication.
--
-- 2. A publication that is still `published` while its location names
--    no GoWay place is WITHDRAWN, with an audit row saying why. The new image
--    would never show it anyway - the trust rule refuses a location with no
--    place (`place_not_set`) - but a `published` row nothing can discover is
--    the state `publishedWithoutPlace` exists to report, and the dashboard
--    would show it as live. Withdrawn is the honest state: the merchant links
--    a place in the dashboard and publishes again, which re-runs the trust
--    rule.
--
-- A location that names a place GoWay does not vouch for stays `published`:
-- whether the link holds is DERIVED on every read and never stored, so it is
-- not this migration's to decide.
--
-- The event is inserted before the state moves, from the same predicate, so
-- exactly the withdrawn rows get one. `actor_oxy_user_id` stays NULL: no
-- person did this.
--
-- ## Inbound references, read before the DROPs
--
-- `drizzle-kit` writes `DROP TABLE ... CASCADE` unconditionally. Read off
-- `meta/0161_snapshot.json`: NO foreign key targets `location_opening_hours`
-- or `location_closures`, and no trigger, function or view in `drizzle/` names
-- them, `listings.geo`, `location_publications.geo_point` or the draft's
-- location columns. The CASCADE takes nothing. `order_pickups` keeps its own
-- frozen snapshot columns, which `0076`'s trigger still names.
--
-- ## One reordering of the generated half
--
-- drizzle-kit emits each table's DROP COLUMNs in declaration order, which puts
-- the two GENERATED points (`listings.geo`, `location_publications.geo_point`)
-- AFTER the coordinate columns they are generated from — and Postgres refuses
-- to drop a column a generated column depends on. Each generated column's DROP
-- is moved up to just before its sources; nothing else is touched. A
-- regeneration restores the refused order, so redo the move.
--
-- A regeneration drops both blocks AND both marker lines; re-add them ABOVE the
-- generated statements and confirm
--
--   grep -cE '^-- oxy:(deploy-phase|rollback)=' drizzle/0162_naive_gauntlet.sql   -> 2
--   grep -cE '^-- oxy:handwritten-(begin|end)=' drizzle/0162_naive_gauntlet.sql   -> 4
-- oxy:handwritten-begin=location_publications_published_at_backfill_after_rollout
UPDATE "location_publications" AS p
SET "published_at" = coalesce(
  (
    SELECT min(e."occurred_at")
    FROM "location_publication_events" AS e
    WHERE e."publication_id" = p."id"
      AND (e."next_state" = 'published' OR e."previous_state" = 'published')
  ),
  CASE WHEN p."publication_state" = 'published' THEN p."updated_at" END
)
WHERE p."published_at" IS NULL;--> statement-breakpoint
-- oxy:handwritten-end=location_publications_published_at_backfill_after_rollout
-- oxy:handwritten-begin=publications_without_place_withdrawn
INSERT INTO "location_publication_events"
  ("id", "publication_id", "kind", "previous_state", "next_state", "note", "occurred_at")
SELECT gen_random_uuid()::text, p."id", 'state_withdrawn', 'published', 'withdrawn',
       'Withdrawn by 0162: the location names no GoWay place (ADR 0013). Link one and publish again.',
       date_trunc('milliseconds', now())
FROM "location_publications" AS p
JOIN "locations" AS l ON l."id" = p."location_id"
WHERE p."publication_state" = 'published' AND l."go_way_place_id" IS NULL;--> statement-breakpoint
UPDATE "location_publications" AS p
SET "publication_state" = 'withdrawn', "updated_at" = date_trunc('milliseconds', now())
FROM "locations" AS l
WHERE l."id" = p."location_id"
  AND p."publication_state" = 'published'
  AND l."go_way_place_id" IS NULL;--> statement-breakpoint
-- oxy:handwritten-end=publications_without_place_withdrawn
ALTER TABLE "location_closures" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "location_opening_hours" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "location_closures" CASCADE;--> statement-breakpoint
DROP TABLE "location_opening_hours" CASCADE;--> statement-breakpoint
ALTER TABLE "listings" DROP CONSTRAINT "listings_coordinates_check";--> statement-breakpoint
ALTER TABLE "seller_listing_drafts" DROP CONSTRAINT "seller_listing_drafts_coordinates_check";--> statement-breakpoint
ALTER TABLE "seller_listing_drafts" DROP CONSTRAINT "seller_listing_drafts_location_opt_in_check";--> statement-breakpoint
ALTER TABLE "location_publications" DROP CONSTRAINT "location_publications_geocode_provenance_check";--> statement-breakpoint
ALTER TABLE "location_publications" DROP CONSTRAINT "location_publications_geocode_shape_check";--> statement-breakpoint
ALTER TABLE "location_publications" DROP CONSTRAINT "location_publications_coordinate_range_check";--> statement-breakpoint
DROP INDEX "listings_geo_idx";--> statement-breakpoint
DROP INDEX "location_publications_published_country_idx";--> statement-breakpoint
DROP INDEX "location_publications_geo_point_idx";--> statement-breakpoint
ALTER TABLE "listings" DROP COLUMN "geo";--> statement-breakpoint
ALTER TABLE "listings" DROP COLUMN "longitude";--> statement-breakpoint
ALTER TABLE "listings" DROP COLUMN "latitude";--> statement-breakpoint
ALTER TABLE "seller_listing_drafts" DROP COLUMN "location_opt_in";--> statement-breakpoint
ALTER TABLE "seller_listing_drafts" DROP COLUMN "location_longitude";--> statement-breakpoint
ALTER TABLE "seller_listing_drafts" DROP COLUMN "location_latitude";--> statement-breakpoint
ALTER TABLE "location_publication_events" DROP COLUMN "previous_latitude";--> statement-breakpoint
ALTER TABLE "location_publication_events" DROP COLUMN "previous_longitude";--> statement-breakpoint
ALTER TABLE "location_publication_events" DROP COLUMN "next_latitude";--> statement-breakpoint
ALTER TABLE "location_publication_events" DROP COLUMN "next_longitude";--> statement-breakpoint
ALTER TABLE "location_publications" DROP COLUMN "display_name";--> statement-breakpoint
ALTER TABLE "location_publications" DROP COLUMN "public_line1";--> statement-breakpoint
ALTER TABLE "location_publications" DROP COLUMN "public_line2";--> statement-breakpoint
ALTER TABLE "location_publications" DROP COLUMN "public_city";--> statement-breakpoint
ALTER TABLE "location_publications" DROP COLUMN "public_region";--> statement-breakpoint
ALTER TABLE "location_publications" DROP COLUMN "public_postal_code";--> statement-breakpoint
ALTER TABLE "location_publications" DROP COLUMN "public_country";--> statement-breakpoint
ALTER TABLE "location_publications" DROP COLUMN "timezone";--> statement-breakpoint
ALTER TABLE "location_publications" DROP COLUMN "public_phone";--> statement-breakpoint
ALTER TABLE "location_publications" DROP COLUMN "public_url";--> statement-breakpoint
ALTER TABLE "location_publications" DROP COLUMN "accessibility_step_free";--> statement-breakpoint
ALTER TABLE "location_publications" DROP COLUMN "accessibility_toilet";--> statement-breakpoint
ALTER TABLE "location_publications" DROP COLUMN "accessibility_parking";--> statement-breakpoint
ALTER TABLE "location_publications" DROP COLUMN "accessibility_hearing_loop";--> statement-breakpoint
ALTER TABLE "location_publications" DROP COLUMN "geo_point";--> statement-breakpoint
ALTER TABLE "location_publications" DROP COLUMN "latitude";--> statement-breakpoint
ALTER TABLE "location_publications" DROP COLUMN "longitude";--> statement-breakpoint
ALTER TABLE "location_publications" DROP COLUMN "geocode_provenance";--> statement-breakpoint
ALTER TABLE "location_publications" DROP COLUMN "geocoded_at";--> statement-breakpoint
ALTER TABLE "location_publications" DROP COLUMN "profile_confirmed_at";