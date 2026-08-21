-- oxy:deploy-phase=post
-- oxy:rollback=replay: the losing duplicate product_variants rows have source_connection_id, source_provider, source_external_variant_id and source_external_inventory_item_id set to NULL. Re-derivable by the next connector sync, not restorable; the surviving row per group keeps its provenance
--
-- ONE local variant per external variation, per connection (#259).
--
-- This is a `post` and not a `pre`, and the discriminant is the house one: does
-- the statement break a write the PREVIOUS image performs? It does, on the
-- previous image's ordinary path. Before #259 `convergeVariants` matched an
-- incoming variant by SKU and then by option tuple, so a merchant renaming a SKU
-- on the platform matched nothing, and the sync CREATED a second local variant
-- and stamped it with the same `(source_connection_id, source_external_variant_id)`
-- the original still carried. Creating this index while that image is still
-- serving would turn a working sync into a 23505 mid-rollout; creating it after
-- the rollout meets an image that no longer writes the pair.
--
-- HAND-WRITTEN, and `db:generate` does not know about it: a regeneration emits
-- the `CREATE UNIQUE INDEX` alone. Re-apply the collapse ABOVE it — the index
-- cannot be created over rows the previous image already duplicated.
-- `catalog.realdb.test.ts` reads BOTH statements out of this file and fails if
-- the collapse is missing, so a regeneration that drops it is caught.
--
-- It COLLAPSES where #221's unique on `listings` deliberately FAILS CLOSED, and
-- the two are not inconsistent: a variant's provenance is four columns the next
-- sync re-derives from the platform, so clearing them drops the row into the
-- legacy-unstamped state the matcher already handles, while picking a survivor
-- among duplicate LISTINGS would discard local edits, `overridden_fields` and
-- the orders pointing at the loser. Collapse what a later sync can rebuild;
-- refuse what it cannot.

-- Collapse whatever the previous image left behind. The survivor is the variant
-- that has held the identity longest (lowest position, then lowest id); the rest
-- keep every other column and lose their PROVENANCE ENTIRELY, which puts them
-- back in `convergeVariants`' legacy tier — where they are re-matched by SKU or
-- option tuple and re-stamped, or refused as ambiguous, both of which are
-- answers. Deleting them is not an option: a variant id is what carts, saves,
-- offers and order lines point at.
--
-- ALL FOUR columns, not just the one this index constrains, and that is the
-- whole of the correctness here. `stampVariantSource` writes the four together
-- from ONE normalized variant, so a duplicate the old matcher created carries
-- the same `source_external_inventory_item_id` as its survivor — and NOTHING
-- constrains that pair. Clearing only the variant id would leave the loser
-- half-stamped, which is the state `stampVariantSource`'s own header names as
-- the bad one: "exactly as unfindable as an unstamped one while LOOKING
-- synced". Both readers of that column select on
-- `(source_connection_id, source_external_inventory_item_id)` and neither
-- disambiguates — `findVariantBySourceInventoryItemId` is `limit(1)` with no
-- ORDER BY (the `inventory_levels/update` webhook), and `syncInventory` builds a
-- `Map` whose last writer wins over an unordered read. So a half-collapsed shop
-- routes roughly half its stock updates onto a variant nothing sells: no error,
-- no log, the run reports success. That is the #259 failure arriving through
-- the repair for it.
--
-- Rows with a NULL `source_connection_id` are excluded deliberately: the index
-- below is over both columns and Postgres treats NULLs as distinct, so those rows
-- can never collide and nulling their stamp would destroy provenance to satisfy a
-- constraint that was never going to fire.
UPDATE "product_variants" AS v
SET
  "source_connection_id" = NULL,
  "source_provider" = NULL,
  "source_external_variant_id" = NULL,
  "source_external_inventory_item_id" = NULL
FROM (
  SELECT
    "id",
    row_number() OVER (
      PARTITION BY "source_connection_id", "source_external_variant_id"
      ORDER BY "position", "id"
    ) AS rn
  FROM "product_variants"
  WHERE "source_external_variant_id" IS NOT NULL
    AND "source_connection_id" IS NOT NULL
) AS ranked
WHERE v."id" = ranked."id" AND ranked.rn > 1;
--> statement-breakpoint
CREATE UNIQUE INDEX "product_variants_source_external_variant_key" ON "product_variants" USING btree ("source_connection_id","source_external_variant_id") WHERE "product_variants"."source_external_variant_id" is not null;
