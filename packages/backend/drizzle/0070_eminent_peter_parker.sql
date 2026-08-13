-- oxy:deploy-phase=post
--
-- #221 — one listing per connector provenance key, enforced by the storage.
--
-- This is `post` and not `pre` because it BREAKS a write the previous image
-- performs. `importProduct`/`upsertProduct` read
-- `findListingBySourceExternalId`, get null, and create — so two concurrent
-- deliveries for one external id (a webhook retried while a backfill is
-- running, two plugin instances pushing the same catalogue) both read null and
-- both create. The serving image has no constraint stopping the second, and the
-- duplicate it leaves is invisible: every later read returns ONE row and no
-- reader can tell which. The narrowing therefore refuses a write today's image
-- genuinely makes, which is the `post` test rather than the "it narrows"
-- paraphrase.
--
-- It is the same identity-index swap #68's `0044` made on `offers`, and it is
-- what the service layer has always assumed: `findListingBySourceExternalId`
-- returns one row and every writer relies on it. The new image handles the
-- resulting `23505` as a retry-by-lookup — it re-reads by provenance and takes
-- the UPDATE branch — so the constraint converges two racers instead of failing
-- one of them.
--
-- The predicate is UNCHANGED (`source_external_id is not null`). An unsourced
-- listing has NULL there and Postgres treats NULLs as distinct anyway, so the
-- partial does not change what is constrained; it keeps the index the size of
-- the real set, exactly as the non-unique version did.
--
-- PRE-EXISTING VIOLATORS ARE RESOLVED HERE, NOT ASSUMED ABSENT.
--
-- `CREATE UNIQUE INDEX` fails at APPLY time on an existing duplicate, and the
-- duplicates that exist are precisely the ones this bug produced — so assuming a
-- clean table is assuming the defect never fired. Refusing instead would abort
-- the `post` migration on exactly the deployments that most need the fix, and a
-- failed `post` does not heal on the next deploy: it blocks every later `pre`
-- behind the ledger's high-water mark until somebody clears it by hand. The
-- resolution runs first, is deterministic, and is idempotent (a second run
-- matches no rows).
--
-- THE RULE: within one `(store_id, source_connection_id, source_external_id)`
-- group the OLDEST row KEEPS the provenance and every other row has its four
-- `source_*` columns CLEARED to NULL, which takes it out of this partial index.
--
--   * Oldest by `created_at asc, id asc`. The id tiebreak is for determinism and
--     NOT for age — a uuid v7 is not monotonic within a millisecond, and two rows
--     from a lost race are very likely to share one. What matters is that two
--     runs, or a rehearsal and production, pick the same winner.
--   * The oldest wins because it has had the longest to accumulate the things
--     that point at a listing — orders, reviews, favourites, offers, canonical
--     links, the merchant's own edits and `overridden_fields`. The duplicate is
--     the later accidental double-create. Nothing is lost by keeping the older
--     one: the next sync updates it from the platform's current state anyway.
--   * CLEARED rather than DELETED, and that is the load-bearing half. Eighteen
--     foreign keys reference `listings` with `ON DELETE CASCADE` (reviews, offers,
--     product saves, condition evidence, images, options, variants, inventory
--     levels …), so deleting a duplicate would destroy commercial history that
--     merely happened to attach to the losing row. Clearing keeps every row and
--     every reference; the loser becomes an ordinary un-sourced store listing the
--     merchant can see and remove themselves.
--   * `status` is deliberately untouched. Archiving the loser would delist
--     something a merchant may be actively selling, which is a product decision
--     and not a migration's to make.
--   * No handle conflict can arise: the two rows already coexist, so they already
--     satisfy `listings_store_id_handle_key`.
--
-- COLLAPSE WHAT A LATER SYNC CAN REBUILD; REFUSE WHAT IT CANNOT.
--
-- That sentence reconciles this migration with #259's variant unique, which
-- resolves its own duplicates the same way and is worth reading beside this one.
-- Both clear a STAMP: four `source_*` columns here, the variant's provenance
-- there, and in each case the next sync re-reads the platform and writes it back,
-- so a cleared row lands in the legacy-unstamped state both matchers already
-- handle. What neither does is pick a row to delete or archive, because the
-- orders, local edits and `overridden_fields` hanging off the loser are exactly
-- what no later sync can rebuild. Same principle, two questions: what may be
-- cleared, and what may never be discarded. (#259 additionally excludes rows with
-- a NULL `source_connection_id`, since NULLs never collide and nulling their
-- stamp would destroy provenance for a constraint that could not have fired.)
--
-- Worth knowing why this state is invisible today: `findListingBySourceExternalId`
-- is `limit(1)` with NO `order by`, so with a duplicate present the sync converges
-- on an ARBITRARY one of the two and may pick differently between calls. That is
-- the half of the defect nothing reports: no error, no log line, and a merchant
-- whose edits appear to move between two listings.
--
-- LOCKING, and why there is no `CONCURRENTLY` here.
--
-- `CREATE INDEX CONCURRENTLY` may not run inside a transaction block, and this
-- migration has no way to leave one: `@oxyhq/db`'s runner delegates to drizzle's
-- `migrate()`, which executes every statement of every pending migration inside
-- ONE `session.transaction(...)` (`drizzle-orm/pg-core/dialect.js`). So the
-- honest statement is not "the index build takes a lock" but the stronger one:
-- `DROP INDEX` takes ACCESS EXCLUSIVE on `listings` and the transaction holds it
-- until COMMIT, so catalogue writes block from the DROP through the index build.
-- That is accepted because the catalogue is pre-launch and this table is small;
-- the cost is proportional to `listings`, so an operator applying this against a
-- large table should measure first:
--
--   SELECT count(*) FROM listings;
--   SELECT count(*) FROM listings WHERE source_external_id IS NOT NULL;
--
-- If that ever becomes a table where a blocking build is unacceptable, the shape
-- that works is a hand-run `CREATE UNIQUE INDEX CONCURRENTLY` outside the
-- migrator followed by a migration that only adopts the existing index — not a
-- change to this file.
--
-- To see what the resolution below WOULD touch, before running it:
--
--   SELECT store_id, source_connection_id, source_external_id,
--          count(*)                                             AS listings,
--          string_agg(id, ', ' ORDER BY created_at ASC, id ASC)  AS listing_ids
--     FROM listings
--    WHERE source_external_id IS NOT NULL
--    GROUP BY 1, 2, 3
--   HAVING count(*) > 1;
--
-- REGENERATION: drizzle-kit emits only the DROP and CREATE below, from
-- `uniqueIndex('listings_store_id_source_key_idx')` in `db/schema/catalog.ts`.
-- This header AND the UPDATE are hand-written and must be re-applied — then grep
-- the file for `^UPDATE "listings"`, for both index statements, and for exactly
-- one anchored `-- oxy:deploy-phase=` line.
-- `services/__tests__/connector-import-atomicity.realdb.test.ts` executes the
-- statements out of THIS file, so a lost UPDATE turns it red.
UPDATE "listings" AS l
   SET "source_connection_id" = NULL,
       "source_provider" = NULL,
       "source_external_id" = NULL,
       "source_external_updated_at" = NULL
  FROM (
        SELECT "id",
               row_number() OVER (
                 PARTITION BY "store_id", "source_connection_id", "source_external_id"
                 ORDER BY "created_at" ASC, "id" ASC
               ) AS rn
          FROM "listings"
         WHERE "source_external_id" IS NOT NULL
       ) ranked
 WHERE l."id" = ranked."id"
   AND ranked.rn > 1;--> statement-breakpoint
DROP INDEX "listings_store_id_source_key_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "listings_store_id_source_key_idx" ON "listings" USING btree ("store_id","source_connection_id","source_external_id") WHERE "listings"."source_external_id" is not null;
