-- oxy:deploy-phase=pre
-- oxy:rollback=replay: location_publications.published_at is written by the backfill UPDATE below, whose pre-image (NULL, in a column this same file adds) is not a statement the classifier can derive. Dropping the column - the derived inverse of the ADD COLUMN - removes it whole, and re-applying this file re-derives every value from location_publication_events and publication_state, which this file leaves untouched
--
-- A location's FIRST publication, for the public location reads (#1017,
-- `GET /public/v1/locations/:id`).
--
-- ADDITIVE, which is why the phase is `pre`: one NULLABLE column nothing in the
-- serving image reads or writes, and a backfill of it. Read off the generated
-- half: no DROP, no NOT NULL, no rename.
--
-- `published_at` is what tells the public surface "withdrawn" (410) from "never
-- published" (404) — `listings.published_at` and `collections.published_at`
-- for a shop front. `setPublicationState` stamps it on publish, and also on any
-- move OUT of `published`, so a location the previous image published while
-- this applied still answers 410 once withdrawn by the new one.
--
-- ## The hand-written half: the backfill
--
-- One anchored block, appended below the generated statement. A publication was
-- published when its append-only trail says it entered or left `published`
-- (`location_publication_events.next_state` / `previous_state`, which every
-- state change recorded); the earliest such instant is its first publication.
-- A publication published now with no such entry — a row written outside the
-- service — takes its `updated_at`, the latest instant it can have been
-- published by. Every other row stays NULL: never published.
--
-- ## It runs BEFORE `0162` withdraws anything
--
-- `0158`, `0159` and this file are the release's `pre` phase; `0161` and
-- `0162` its `post` phase. So this backfill reads every publication as the
-- previous image left it, before `0162` withdraws a published location that
-- names no GoWay place: each one it withdraws already carries the
-- `published_at` this computed, and so answers 410, not 404. `0162` re-runs
-- this statement first, verbatim, for the publications the previous image
-- published while the rollout was under way — the same reason `0161` re-runs
-- `0158`'s backfill.
--
-- A regeneration drops the block AND the two marker lines at the top; re-add
-- both and confirm
--
--   grep -cE '^-- oxy:(deploy-phase|rollback)=' drizzle/0160_sad_nova.sql   -> 2
--   grep -cE '^-- oxy:handwritten-(begin|end)=' drizzle/0160_sad_nova.sql   -> 2
ALTER TABLE "location_publications" ADD COLUMN "published_at" timestamp with time zone;--> statement-breakpoint
-- oxy:handwritten-begin=location_publications_published_at_backfill
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
WHERE p."published_at" IS NULL;
-- oxy:handwritten-end=location_publications_published_at_backfill
