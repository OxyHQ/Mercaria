-- oxy:deploy-phase=pre
-- oxy:rollback=derived
--
-- #367 box 11, ADR 0007 D5/D10/D13: `listings` pins the EXACT product-type
-- version it was authored under, so a published record can still be read under
-- the rules it was recorded under.
--
-- `pre`, and additive in all three statements: a nullable column, a foreign key
-- over a column that is NULL on every existing row, and a PARTIAL index on the
-- same predicate. Nothing here breaks a write the previously serving image
-- performs — that image simply never sets the column.
--
-- ## There is deliberately NO BACKFILL
--
-- Nothing distinguishes a listing that was authored under a product type from
-- one that never had a schema: connector imports, P2P listings and every
-- pre-#367 row were all written with no authoring contract at all. A guessed pin
-- would be a false claim about HOW a record was authored, and it would be
-- indistinguishable from a real one forever. This is the `listings.published_at`
-- ruling (#261), which declined a backfill for the same reason and recorded it
-- rather than leaving the absence to be read as an oversight.
--
-- ## The circular foreign key WAS verified, not assumed
--
-- `db/schema/productTypes.ts` imports `categories` from `db/schema/catalog.ts`,
-- so this reference makes a circular module import. This repository has a
-- measured case of drizzle-kit emitting NO `ADD CONSTRAINT` and NO snapshot
-- entry for exactly that shape (`awin_advertisers.activating_sample_id`), which
-- type-checks and enforces nothing. Both were checked here by constraint NAME
-- against the emitted SQL above and against `meta/0109_snapshot.json`, where the
-- entry reads `-> product_type_definitions ['product_type_definition_id'] ['id']
-- onDelete=restrict`.
--
-- ## On a regeneration
--
-- The trigger below is hand-written and `db:generate` DROPS it. Re-apply it,
-- keep it between its markers, and re-read the regenerated file for statements
-- nobody intended.
ALTER TABLE "listings" ADD COLUMN "product_type_definition_id" text;--> statement-breakpoint
ALTER TABLE "listings" ADD CONSTRAINT "listings_product_type_definition_id_product_type_definitions_id_fk" FOREIGN KEY ("product_type_definition_id") REFERENCES "public"."product_type_definitions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "listings_product_type_definition_idx" ON "listings" USING btree ("product_type_definition_id") WHERE "listings"."product_type_definition_id" is not null;
--> statement-breakpoint
-- oxy:handwritten-begin=mercaria_listing_product_type_pin_not_cleared
-- A pin may be SET and may be MOVED. It may never be erased.
--
-- NULL -> a value is a first pin, and value -> value IS the deliberate migration
-- ADR 0007 D10 describes: a newer version never reinterprets an older record
-- silently, but an operator may move a record forward on purpose. Those two are
-- permitted precisely so #367 box 12's published-listing migration has somewhere
-- to land.
--
-- value -> NULL is refused, because a pin that can be erased is not a pin: the
-- column is the only evidence of which rules a stored answer was recorded under,
-- and clearing it destroys that evidence while leaving a plausible-looking row.
-- It is the direction a well-meant "tidy up the nulls" migration or a serializer
-- round-trip that omits the field would take, which is exactly why it is enforced
-- at the row rather than in the one service that writes it today.
CREATE OR REPLACE FUNCTION mercaria_listing_product_type_pin_not_cleared()
RETURNS trigger
LANGUAGE plpgsql
AS $$
begin
  if old.product_type_definition_id is not null
     and new.product_type_definition_id is null then
    raise exception
      'listings.product_type_definition_id cannot be cleared once set (listing %)',
      old.id
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS mercaria_listing_product_type_pin_not_cleared ON "listings";--> statement-breakpoint
CREATE TRIGGER mercaria_listing_product_type_pin_not_cleared
  BEFORE UPDATE ON "listings"
  FOR EACH ROW
  EXECUTE FUNCTION mercaria_listing_product_type_pin_not_cleared();
-- oxy:handwritten-end=mercaria_listing_product_type_pin_not_cleared
