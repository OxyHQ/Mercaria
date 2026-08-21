-- oxy:deploy-phase=post
-- oxy:rollback=restore: offers_active_source_key is replaced by offers_source_identity_key and any duplicate that accumulated under the old predicate is collapsed by retiring the loser (offers.status, retirement_reason, retired_at rewritten). Re-creating the old index is in this file's own header; the collapsed rows keep their ids and are not deleted, so the collapse is visible rather than lost
--
-- #68 — source-aware offer refresh, expiry and catalogue health. PHASE 2 of 2.
--
-- Every statement here BREAKS a write the previous image performs, which is
-- what makes it `post` rather than `pre`:
--
--  * `refresh_mode` becomes NOT NULL — the image before #68 opens runs without
--    one (`0043` added it nullable and backfilled it).
--  * `offers_source_identity_key` REPLACES `offers_active_source_key`, dropping
--    `status = 'active'` from the predicate. The old image's `upsertExternalOffer`
--    names the old predicate in its `ON CONFLICT`, and after this it must name
--    the new one — which is exactly the revival #68 acceptance 5 asks for: an
--    external offer is now one row for its whole life, so a source republishing
--    an object it stopped publishing brings the SAME offer back rather than
--    minting a second row and splitting its observed history.
--  * `catalog_source_objects_retirement_evidence_check` is a biconditional the
--    previous image's `retireSourceObject` violates: it writes `retired_at` and
--    no kind (`0043` backfilled the existing rows).
--
-- ON A REGENERATION: the hand-written duplicate-collapse `UPDATE` below is
-- dropped by drizzle-kit. Re-apply it BEFORE the `CREATE UNIQUE INDEX`, or the
-- index creation fails on any database that accumulated a duplicate under the
-- old predicate.

DROP INDEX "offers_active_source_key";--> statement-breakpoint
ALTER TABLE "catalog_source_runs" ALTER COLUMN "refresh_mode" SET NOT NULL;--> statement-breakpoint
-- #68 — collapse any duplicate that accumulated under the OLD predicate.
--
-- Before this migration a retired offer did not occupy its source key, so a
-- source republishing an object inserted a second row for it. Those duplicates
-- would fail `offers_source_identity_key` outright, so the older copies are
-- retired with `superseded` — the reason #57 already defines as "a newer offer
-- took this one's active source mapping" — which is exactly the value the new
-- index's predicate excludes.
--
-- Nothing is deleted and no provenance is blanked: every row keeps its
-- `source_record_id`, its observation chain and its own external identity, and
-- an operator reading the trace afterwards sees a decision rather than a gap.
-- On a database with no duplicates (which is every deployment today, since no
-- ingestion adapter is registered) this updates zero rows.
UPDATE "offers" AS o
SET "status" = 'retired',
    "retirement_reason" = 'superseded',
    "retired_at" = COALESCE(o."retired_at", now())
FROM (
  SELECT "id",
         row_number() OVER (
           PARTITION BY "source_key"
           ORDER BY ("status" = 'active') DESC, "last_seen_at" DESC, "id" DESC
         ) AS rank
  FROM "offers"
  WHERE "external_offer_id" IS NOT NULL
    AND ("retirement_reason" IS NULL OR "retirement_reason" <> 'superseded')
) ranked
WHERE o."id" = ranked."id" AND ranked.rank > 1;--> statement-breakpoint
CREATE UNIQUE INDEX "offers_source_identity_key" ON "offers" USING btree ("source_key") WHERE "offers"."external_offer_id" is not null
            and ("offers"."retirement_reason" is null or "offers"."retirement_reason" <> 'superseded');--> statement-breakpoint
ALTER TABLE "catalog_source_objects" ADD CONSTRAINT "catalog_source_objects_retirement_evidence_check" CHECK (("catalog_source_objects"."retired_at" is not null) = ("catalog_source_objects"."retirement_kind" is not null));