-- oxy:deploy-phase=pre
--
-- Tags reach `listings.search_vector` through the SAME `english` analyzer the
-- title and description already use, instead of `array_to_tsvector`.
--
-- ## What was wrong
--
-- `array_to_tsvector` is IMMUTABLE, which is why the first cut of the generated
-- column reached for it — a generated column accepts nothing else. But it stores
-- each element as a lexeme VERBATIM: no stemming, no case folding. Measured on
-- PostgreSQL 17, `array_to_tsvector(array['handmade','Bikes'])` is
-- `'Bikes' 'handmade'`, while `to_tsvector('english','handmade Bikes')` is
-- `'bike':2 'handmad':1`. So a listing tagged `Handmade` was NOT findable by
-- "handmade" (the query stems to `handmad`), and `Bikes` was not findable by
-- "bikes" at all. Mongo's `$text` index DID stem array elements, so this was a
-- real narrowing of tag search introduced by the port, pinned as known-wrong by
-- `catalog.realdb.test.ts` rather than left to be discovered by a seller.
--
-- ## Why a function, when two shorter spellings exist
--
-- Neither is allowed. `array_to_string(anyarray, text)` is STABLE — its
-- element→text conversion is not immutable for every type `anyarray` admits —
-- and `tags::text` is refused outright with `generation expression is not
-- immutable`. Narrowed to `text[]`, where the conversion genuinely IS immutable,
-- the wrapper below can be declared immutable honestly rather than by assertion.
-- `STRICT` matches `array_to_string`'s own null behaviour; the column coalesces
-- its input anyway.
--
-- ## The table rewrite, and the index the diff did not mention
--
-- Postgres has no `ALTER COLUMN … SET EXPRESSION` for a stored generated column
-- before 17.0's restricted form, so the column is dropped and re-added, which
-- rewrites the table. Cheap here: `listings` is EMPTY until the Fase 4 backfill.
-- On a populated table this would be a full rewrite under an ACCESS EXCLUSIVE
-- lock and would need a different plan.
--
-- `DROP COLUMN` also drops `listings_search_vector_idx`, and `drizzle-kit
-- generate` did NOT re-emit it: the index's own definition is textually
-- unchanged, so the diff sees nothing to do and the snapshot still records an
-- index the database no longer has. Recreating it here is the only thing that
-- brings it back — without this line, catalogue search silently falls back to a
-- sequential scan with every test still green.
--
-- `pre`: the column keeps its name and its type, so the image still serving
-- reads it exactly as before. Only which lexemes it contains changes.

CREATE OR REPLACE FUNCTION mercaria_immutable_array_to_string(text[], text) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT
  AS $$ SELECT array_to_string($1, $2) $$;--> statement-breakpoint
ALTER TABLE "listings" drop column "search_vector";--> statement-breakpoint
ALTER TABLE "listings" ADD COLUMN "search_vector" "tsvector" GENERATED ALWAYS AS (to_tsvector('english', coalesce("listings"."title", '')) ||
            to_tsvector('english', coalesce("listings"."description", '')) ||
            to_tsvector('english', mercaria_immutable_array_to_string(coalesce("listings"."tags", '{}'::text[]), ' '))) STORED;--> statement-breakpoint
CREATE INDEX "listings_search_vector_idx" ON "listings" USING gin ("search_vector");
