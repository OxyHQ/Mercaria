-- oxy:deploy-phase=pre
-- oxy:rollback=derived
--
-- Allowed value subsets per product-type field (#367 W7, epic line 235).
--
-- Every statement below CREATES something. Nothing is dropped, renamed or
-- narrowed, so the image still serving is unaffected by all of it: it selects
-- from no table here, and a field with no subset row keeps offering its cited
-- definition's full value set, which is the only behaviour that exists today.
--
--   * `product_type_field_allowed_values` is a brand-new table. It stores a
--     JOIN onto `attribute_enum_values.id` and never a value STRING — a subset
--     of spellings would be #56's `allowed_values text[]` again, which was
--     REMOVED rather than kept beside the rows precisely because two
--     representations of the permitted set disagree the moment one is edited.
--
--   * The two UNIQUE constraints on EXISTING tables CANNOT FAIL TO APPLY, and
--     that is worth stating because "adds a UNIQUE to two live tables" reads as
--     a migration hazard and this instance is not one. Both are
--     `(id, <other column>)` where `id` is already the PRIMARY KEY, so the pair
--     is unique BY CONSTRUCTION for every row that exists or could ever exist.
--     No duplicate can be present, no scan can find one, and no backfill is
--     owed. Neither adds a new invariant: they exist solely so the composite
--     foreign keys below have a legal target, because Postgres accepts a unique
--     CONSTRAINT or a primary key as an FK target and refuses a unique INDEX.
--
--   * The two composite foreign keys are the invariant. They share
--     `attribute_definition_id`, so a subset row naming a value that belongs to
--     a different attribute than its field cites is UNREPRESENTABLE rather than
--     refused by a service — the `match_category_gates` device. Verify both
--     against `pg_constraint` after applying, never against the drizzle
--     declaration: drizzle-kit has silently dropped a composite key it modelled.
--
--   * `on delete no action` on the value key, not `restrict`, is the
--     measurement already recorded on `product_type_fields_group_fk`: `restrict`
--     is checked immediately, so a delete cascading to both a subset row and its
--     enum value in ONE statement raises on whichever cascade ran first, while
--     `no action` resolves at statement end. Deleting an enum value a LIVE
--     subset still names raises either way, which is the protection it is for.
--
--   * STATEMENT ORDER IS HAND-CORRECTED, AND A REGENERATION WILL UNDO IT.
--     drizzle-kit emitted both `ADD CONSTRAINT … FOREIGN KEY` statements BEFORE
--     the two `ADD CONSTRAINT … UNIQUE` statements they reference, which
--     generates cleanly, reads plausibly and FAILS AT APPLY TIME with
--     `there is no unique constraint matching given keys for referenced table
--     "product_type_fields"` — measured, on the throwaway test database. The two
--     UNIQUEs are therefore moved to the top by hand. If this file is ever
--     regenerated, move them back before the foreign keys and re-read the whole
--     file, exactly as the trigger and backfill protocol requires.
--
--   * A HAND-WRITTEN FUNCTION AND TRIGGER follow the DDL, and a regeneration
--     DROPS them silently. `mercaria_product_type_allowed_value_frozen` freezes
--     a published version's permitted values with the rest of its contract —
--     without it the subset is the one piece of a published schema that can
--     still move. Re-apply it after any regeneration and grep the result for the
--     `CREATE OR REPLACE FUNCTION` / `CREATE TRIGGER` pair.
ALTER TABLE "attribute_enum_values" ADD CONSTRAINT "attribute_enum_values_definition_id_key" UNIQUE("attribute_definition_id","id");--> statement-breakpoint
ALTER TABLE "product_type_fields" ADD CONSTRAINT "product_type_fields_id_attribute_definition_key" UNIQUE("id","attribute_definition_id");--> statement-breakpoint
CREATE TABLE "product_type_field_allowed_values" (
	"id" text PRIMARY KEY NOT NULL,
	"product_type_field_id" text NOT NULL,
	"attribute_definition_id" text NOT NULL,
	"attribute_enum_value_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL
);--> statement-breakpoint
ALTER TABLE "product_type_field_allowed_values" ADD CONSTRAINT "product_type_field_allowed_values_field_fk" FOREIGN KEY ("product_type_field_id","attribute_definition_id") REFERENCES "public"."product_type_fields"("id","attribute_definition_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_type_field_allowed_values" ADD CONSTRAINT "product_type_field_allowed_values_value_fk" FOREIGN KEY ("attribute_definition_id","attribute_enum_value_id") REFERENCES "public"."attribute_enum_values"("attribute_definition_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "product_type_field_allowed_values_key" ON "product_type_field_allowed_values" USING btree ("product_type_field_id","attribute_enum_value_id");--> statement-breakpoint
CREATE INDEX "product_type_field_allowed_values_field_idx" ON "product_type_field_allowed_values" USING btree ("product_type_field_id");
--> statement-breakpoint

-- oxy:handwritten-begin=mercaria_product_type_allowed_value_frozen
-- A published version's PERMITTED VALUES are frozen with the rest of its
-- contract, and this is the third trigger in the family rather than a fourth
-- trigger on the existing function.
--
-- `mercaria_product_type_child_frozen` states the reason and it applies here
-- word for word: *"a schema whose field list, groups or category eligibility
-- could change after publication is not a version, it is a mutable document
-- wearing a version number."* Which storage capacities a phone form offers is
-- part of that contract; without this, the subset is the one piece of a
-- published schema that could still move underneath a merchant.
--
-- It needs its OWN function because the existing one reads
-- `NEW.product_type_definition_id`, and this table is one hop further out: its
-- parent is a FIELD, and the lifecycle lives on the field's definition.
--
-- The NULL tolerance is the existing function's, for the existing reason: a
-- cascade from `product_type_fields` deletes these rows after the field is
-- already gone, so the lookup finds nothing — and the field's own trigger has
-- already refused that cascade for anything published. A NULL therefore means
-- "the parent is going away legitimately", not "no check ran".
CREATE OR REPLACE FUNCTION mercaria_product_type_allowed_value_frozen()
RETURNS trigger AS $$
DECLARE
  parent_state text;
  parent_definition_id text;
BEGIN
  SELECT d.lifecycle, d.id INTO parent_state, parent_definition_id
  FROM product_type_fields f
  JOIN product_type_definitions d ON d.id = f.product_type_definition_id
  WHERE f.id = COALESCE(NEW.product_type_field_id, OLD.product_type_field_id);

  IF parent_state IS NOT NULL AND parent_state NOT IN ('draft', 'review') THEN
    RAISE EXCEPTION
      'product type definition % is % and its authoring contract is frozen; publish a new version instead',
      parent_definition_id, parent_state
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
DROP TRIGGER IF EXISTS product_type_field_allowed_values_frozen ON "product_type_field_allowed_values";--> statement-breakpoint
CREATE TRIGGER product_type_field_allowed_values_frozen
  BEFORE INSERT OR UPDATE OR DELETE ON "product_type_field_allowed_values"
  FOR EACH ROW EXECUTE FUNCTION mercaria_product_type_allowed_value_frozen();
-- oxy:handwritten-end=mercaria_product_type_allowed_value_frozen
