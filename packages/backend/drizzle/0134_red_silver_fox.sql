-- oxy:deploy-phase=pre
--
-- Secondary category classification (#367 Workstream 1, ADR 0007 D2/D3/D4).
--
-- Two new tables, four foreign keys, four indexes, six CHECKs, and five
-- hand-written functions with six triggers between them. Entirely ADDITIVE:
-- nothing is dropped, narrowed or renamed, and no column changes type or
-- nullability.
--
-- ## Why this is `pre` and not `post`
--
-- The two triggers this mounts on EXISTING tables (`listings` and
-- `canonical_products`, `BEFORE UPDATE OF category_id`) do not break any write
-- the previously serving image performs. They refuse a primary that collides
-- with one of that subject's own secondary classifications, and until the new
-- image ships there are no secondary rows at all — both new tables are created
-- empty here and the old image has no code that writes them. So every write the
-- serving image makes passes through unchanged, which is the test for `pre`.
--
-- ## What happens to existing rows
--
-- Nothing. No backfill, and deliberately none: a secondary classification is a
-- justified decision with a named accountable author, and there is no rule that
-- could derive one for a listing or a canonical product that already exists. A
-- backfill would have to invent both the reason and the justification, which is
-- exactly the decorative-justification failure this table's NOT NULL CHECKs
-- exist to prevent.
--
-- Existing `listings.category_id` and `canonical_products.category_id` values
-- are untouched and keep their current meaning: they ARE the primary category,
-- and this migration adds no second place to say so.
--
-- ## The hand-written statements, and where they go on a regeneration
--
-- `db:generate` models tables, columns, CHECKs and indexes and models no
-- trigger or function, so a regeneration DROPS everything below the generated
-- DDL. Each block is anchored between a matching begin/end marker pair and
-- `src/db/__tests__/migration-handwritten-markers.test.ts` gates them.
-- Re-apply all five blocks after any regeneration of this file:
--
--   1. mercaria_category_kinship                            (a shared helper)
--   2. mercaria_listing_secondary_category_guard            (child side)
--   3. mercaria_canonical_product_secondary_category_guard  (child side)
--   4. mercaria_listing_primary_category_guard              (parent side)
--   5. mercaria_canonical_product_primary_category_guard    (parent side)
--   6. mercaria_category_assignment_selectable              (mounts only)
--
-- Self-check after any regeneration, from the repo root:
--   grep -c '^-- oxy:deploy-phase' packages/backend/drizzle/0134_red_silver_fox.sql        -> 1
--   grep -c '^-- oxy:handwritten-begin=' packages/backend/drizzle/0134_red_silver_fox.sql  -> 6
--   grep -c '^-- oxy:handwritten-end=' packages/backend/drizzle/0134_red_silver_fox.sql    -> 6
--
CREATE TABLE "canonical_product_secondary_categories" (
	"id" text PRIMARY KEY NOT NULL,
	"category_id" text NOT NULL,
	"reason" text NOT NULL,
	"justification" text NOT NULL,
	"scheme_ref" text,
	"justified_by" text NOT NULL,
	"justified_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"canonical_product_id" text NOT NULL,
	CONSTRAINT "canonical_product_secondary_categories_reason_check" CHECK ("canonical_product_secondary_categories"."reason" in ('multi_function_product', 'industry_vertical_equivalent', 'regulatory_scheme', 'tax_scheme', 'safety_scheme')),
	CONSTRAINT "canonical_product_secondary_categories_justification_present_check" CHECK (length(btrim("canonical_product_secondary_categories"."justification")) > 0),
	CONSTRAINT "canonical_product_secondary_categories_justified_by_present_check" CHECK (length(btrim("canonical_product_secondary_categories"."justified_by")) > 0),
	CONSTRAINT "canonical_product_secondary_categories_scheme_ref_check" CHECK (("canonical_product_secondary_categories"."scheme_ref" is not null and length(btrim("canonical_product_secondary_categories"."scheme_ref")) > 0)
        = ("canonical_product_secondary_categories"."reason" in ('regulatory_scheme', 'tax_scheme', 'safety_scheme')))
);
--> statement-breakpoint
CREATE TABLE "listing_secondary_categories" (
	"id" text PRIMARY KEY NOT NULL,
	"category_id" text NOT NULL,
	"reason" text NOT NULL,
	"justification" text NOT NULL,
	"scheme_ref" text,
	"justified_by" text NOT NULL,
	"justified_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"listing_id" text NOT NULL,
	CONSTRAINT "listing_secondary_categories_reason_check" CHECK ("listing_secondary_categories"."reason" in ('multi_function_product', 'industry_vertical_equivalent', 'regulatory_scheme', 'tax_scheme', 'safety_scheme')),
	CONSTRAINT "listing_secondary_categories_justification_present_check" CHECK (length(btrim("listing_secondary_categories"."justification")) > 0),
	CONSTRAINT "listing_secondary_categories_justified_by_present_check" CHECK (length(btrim("listing_secondary_categories"."justified_by")) > 0),
	CONSTRAINT "listing_secondary_categories_scheme_ref_check" CHECK (("listing_secondary_categories"."scheme_ref" is not null and length(btrim("listing_secondary_categories"."scheme_ref")) > 0)
        = ("listing_secondary_categories"."reason" in ('regulatory_scheme', 'tax_scheme', 'safety_scheme')))
);
--> statement-breakpoint
ALTER TABLE "canonical_product_secondary_categories" ADD CONSTRAINT "canonical_product_secondary_categories_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canonical_product_secondary_categories" ADD CONSTRAINT "canonical_product_secondary_categories_canonical_product_id_canonical_products_id_fk" FOREIGN KEY ("canonical_product_id") REFERENCES "public"."canonical_products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listing_secondary_categories" ADD CONSTRAINT "listing_secondary_categories_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listing_secondary_categories" ADD CONSTRAINT "listing_secondary_categories_listing_id_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."listings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "canonical_product_secondary_categories_key" ON "canonical_product_secondary_categories" USING btree ("canonical_product_id","category_id");--> statement-breakpoint
CREATE INDEX "canonical_product_secondary_categories_category_idx" ON "canonical_product_secondary_categories" USING btree ("category_id");--> statement-breakpoint
CREATE UNIQUE INDEX "listing_secondary_categories_key" ON "listing_secondary_categories" USING btree ("listing_id","category_id");--> statement-breakpoint
CREATE INDEX "listing_secondary_categories_category_idx" ON "listing_secondary_categories" USING btree ("category_id");--> statement-breakpoint
-- oxy:handwritten-begin=mercaria_category_kinship
-- How two categories are related, read off the ancestry ADR 0007 D2 made the
-- authority.
--
-- `ancestor_ids` is a materialized path of ids, root-first and EXCLUDING the row
-- itself, so each direction is one array membership test and neither needs a
-- recursive read.
--
-- Returns `same`, `ancestor` (the secondary is an ancestor of the primary),
-- `descendant`, or `unrelated`. NULL when either category is absent: that is a
-- missing row rather than a relationship, and reporting it as a kinship would
-- answer a foreign-key error with a misleading message — the reasoning
-- `mercaria_category_assignment_selectable` already applies to its own NULL.
--
-- ONE definition, called by four triggers. The rule is stated once so that a
-- child insert and a parent update cannot disagree about what "related" means,
-- which is how this invariant would otherwise rot: the two sides are written
-- months apart and only one of them is ever in front of the person changing it.
CREATE OR REPLACE FUNCTION mercaria_category_kinship(
  primary_category_id text,
  secondary_category_id text
)
RETURNS text AS $$
DECLARE
  primary_ancestors text[];
  secondary_ancestors text[];
BEGIN
  IF primary_category_id IS NULL OR secondary_category_id IS NULL THEN
    RETURN NULL;
  END IF;

  IF primary_category_id = secondary_category_id THEN
    RETURN 'same';
  END IF;

  SELECT ancestor_ids INTO primary_ancestors FROM categories WHERE id = primary_category_id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  SELECT ancestor_ids INTO secondary_ancestors FROM categories WHERE id = secondary_category_id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  -- `coalesce` because the column is NOT NULL with a `'{}'` default today and a
  -- NULL would make `= ANY(NULL)` evaluate to NULL, which reads as "no kinship"
  -- — the permissive direction, and the one that would admit exactly the row
  -- this function exists to refuse.
  IF secondary_category_id = ANY(coalesce(primary_ancestors, '{}'::text[])) THEN
    RETURN 'ancestor';
  END IF;

  IF primary_category_id = ANY(coalesce(secondary_ancestors, '{}'::text[])) THEN
    RETURN 'descendant';
  END IF;

  RETURN 'unrelated';
END;
$$ LANGUAGE plpgsql STABLE;
-- oxy:handwritten-end=mercaria_category_kinship
--> statement-breakpoint
-- oxy:handwritten-begin=mercaria_listing_secondary_category_guard
-- The CHILD side for `listing_secondary_categories`.
--
-- Three refusals, all of which need a row this one is not:
--
--  1. A secondary with no primary. All three category-assignment columns in
--     this schema are nullable, so "no primary, two secondaries" is
--     representable — and it fails SILENTLY, because every reader that resolves
--     "the category" gets NULL and takes its unclassified path while the row
--     visibly carries filings. Refused here.
--  2. A secondary that is the primary, its ancestor or its descendant. All
--     three are already implied by the primary filing plus the tree, so
--     recording one claims a decision where the hierarchy already answered.
--  3. A category whose lifecycle is not assignable. Stricter than the primary
--     column, which has no lifecycle rule at all — deliberately, because
--     tightening that one would refuse a write the serving image performs. A
--     new table has no legacy rows, so it is strict from its first row.
--
-- The lifecycle tuple is spelled literally here because hand-written SQL cannot
-- read `SECONDARY_CLASSIFICATION_ASSIGNABLE_LIFECYCLES`. That is bound instead
-- by a real-server test that drives ALL FIVE lifecycles through this trigger
-- and asserts accept/reject against the shared-types tuple, so the two cannot
-- drift without a red suite.
CREATE OR REPLACE FUNCTION mercaria_listing_secondary_category_guard()
RETURNS trigger AS $$
DECLARE
  primary_category_id text;
  kinship text;
  target_lifecycle text;
BEGIN
  SELECT category_id INTO primary_category_id FROM listings WHERE id = NEW.listing_id;
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  IF primary_category_id IS NULL THEN
    RAISE EXCEPTION
      'listing % has no primary category, so it cannot carry a secondary classification (#367 Workstream 1).',
      NEW.listing_id
      USING ERRCODE = 'restrict_violation';
  END IF;

  kinship := mercaria_category_kinship(primary_category_id, NEW.category_id);
  IF kinship IN ('same', 'ancestor', 'descendant') THEN
    RAISE EXCEPTION
      'category % cannot be a secondary classification of listing %: it is the % of the primary category %, which the tree already implies (#367 Workstream 1).',
      NEW.category_id, NEW.listing_id, kinship, primary_category_id
      USING ERRCODE = 'restrict_violation';
  END IF;

  SELECT lifecycle INTO target_lifecycle FROM categories WHERE id = NEW.category_id;
  IF target_lifecycle IS NOT NULL AND target_lifecycle NOT IN ('published', 'suppressed') THEN
    RAISE EXCEPTION
      'category % cannot take a new secondary classification: its lifecycle is % (ADR 0007 D2).',
      NEW.category_id, target_lifecycle
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER mercaria_listing_secondary_category_guard
BEFORE INSERT OR UPDATE ON "listing_secondary_categories"
FOR EACH ROW
EXECUTE FUNCTION mercaria_listing_secondary_category_guard();
-- oxy:handwritten-end=mercaria_listing_secondary_category_guard
--> statement-breakpoint
-- oxy:handwritten-begin=mercaria_canonical_product_secondary_category_guard
-- The CHILD side for `canonical_product_secondary_categories`.
--
-- The same three refusals as its listing sibling, against the canonical
-- product's own primary. Two concrete functions rather than one parameterised
-- by `TG_ARGV`, because the alternative is `EXECUTE format(...)` and this
-- repository has no dynamic SQL in any trigger — the KINSHIP rule, which is the
-- part that could disagree, is shared in `mercaria_category_kinship` instead.
CREATE OR REPLACE FUNCTION mercaria_canonical_product_secondary_category_guard()
RETURNS trigger AS $$
DECLARE
  primary_category_id text;
  kinship text;
  target_lifecycle text;
BEGIN
  SELECT category_id INTO primary_category_id
    FROM canonical_products WHERE id = NEW.canonical_product_id;
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  IF primary_category_id IS NULL THEN
    RAISE EXCEPTION
      'canonical product % has no primary category, so it cannot carry a secondary classification (#367 Workstream 1).',
      NEW.canonical_product_id
      USING ERRCODE = 'restrict_violation';
  END IF;

  kinship := mercaria_category_kinship(primary_category_id, NEW.category_id);
  IF kinship IN ('same', 'ancestor', 'descendant') THEN
    RAISE EXCEPTION
      'category % cannot be a secondary classification of canonical product %: it is the % of the primary category %, which the tree already implies (#367 Workstream 1).',
      NEW.category_id, NEW.canonical_product_id, kinship, primary_category_id
      USING ERRCODE = 'restrict_violation';
  END IF;

  SELECT lifecycle INTO target_lifecycle FROM categories WHERE id = NEW.category_id;
  IF target_lifecycle IS NOT NULL AND target_lifecycle NOT IN ('published', 'suppressed') THEN
    RAISE EXCEPTION
      'category % cannot take a new secondary classification: its lifecycle is % (ADR 0007 D2).',
      NEW.category_id, target_lifecycle
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER mercaria_canonical_product_secondary_category_guard
BEFORE INSERT OR UPDATE ON "canonical_product_secondary_categories"
FOR EACH ROW
EXECUTE FUNCTION mercaria_canonical_product_secondary_category_guard();
-- oxy:handwritten-end=mercaria_canonical_product_secondary_category_guard
--> statement-breakpoint
-- oxy:handwritten-begin=mercaria_listing_primary_category_guard
-- The PARENT side, and it is the half that gets forgotten.
--
-- Guarding only the child makes the invariant hold at insert and then break the
-- first time somebody re-points `listings.category_id` at a node one of that
-- listing's own secondaries already names. That is not a corner case: it is
-- literally "a secondary silently becoming the primary", which is the state the
-- requirement names. It is also invisible afterwards — the two rows are
-- individually valid and only their combination is wrong.
--
-- It REFUSES rather than deleting the collided secondary. Deleting one would
-- destroy a justification with a named accountable author as a side effect of an
-- unrelated edit; the remedy is to remove the secondary first, deliberately.
--
-- Clearing the primary to NULL while secondaries exist is refused for the same
-- reason the child side refuses a secondary with no primary — same state, other
-- door.
--
-- `UPDATE OF category_id` plus a `WHEN`, so an ordinary listing write — a status
-- change, a price change, a facet resync — never reaches this at all. It reads
-- only `NEW.id` and `NEW.category_id`, never `geo` or `search_vector`: those are
-- STORED GENERATED and are computed AFTER a `BEFORE` trigger, so `NEW.<col>`
-- would be NULL and any comparison against one would raise on every update.
CREATE OR REPLACE FUNCTION mercaria_listing_primary_category_guard()
RETURNS trigger AS $$
DECLARE
  offending_category_id text;
  offending_kinship text;
BEGIN
  IF NEW.category_id IS NULL THEN
    IF EXISTS (SELECT 1 FROM listing_secondary_categories WHERE listing_id = NEW.id) THEN
      RAISE EXCEPTION
        'listing % cannot clear its primary category while it carries secondary classifications (#367 Workstream 1).',
        NEW.id
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
  END IF;

  SELECT s.category_id, mercaria_category_kinship(NEW.category_id, s.category_id)
    INTO offending_category_id, offending_kinship
    FROM listing_secondary_categories s
    WHERE s.listing_id = NEW.id
      AND mercaria_category_kinship(NEW.category_id, s.category_id)
          IN ('same', 'ancestor', 'descendant')
    LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION
      'listing % cannot take primary category %: its secondary classification % is the % of it. Remove the secondary first (#367 Workstream 1).',
      NEW.id, NEW.category_id, offending_category_id, offending_kinship
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER mercaria_listing_primary_category_guard
BEFORE UPDATE OF category_id ON "listings"
FOR EACH ROW WHEN (NEW.category_id IS DISTINCT FROM OLD.category_id)
EXECUTE FUNCTION mercaria_listing_primary_category_guard();
-- oxy:handwritten-end=mercaria_listing_primary_category_guard
--> statement-breakpoint
-- oxy:handwritten-begin=mercaria_canonical_product_primary_category_guard
-- The PARENT side for `canonical_products`. Same reasoning as its listing
-- sibling, against that table's own secondary classifications.
CREATE OR REPLACE FUNCTION mercaria_canonical_product_primary_category_guard()
RETURNS trigger AS $$
DECLARE
  offending_category_id text;
  offending_kinship text;
BEGIN
  IF NEW.category_id IS NULL THEN
    IF EXISTS (
      SELECT 1 FROM canonical_product_secondary_categories WHERE canonical_product_id = NEW.id
    ) THEN
      RAISE EXCEPTION
        'canonical product % cannot clear its primary category while it carries secondary classifications (#367 Workstream 1).',
        NEW.id
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
  END IF;

  SELECT s.category_id, mercaria_category_kinship(NEW.category_id, s.category_id)
    INTO offending_category_id, offending_kinship
    FROM canonical_product_secondary_categories s
    WHERE s.canonical_product_id = NEW.id
      AND mercaria_category_kinship(NEW.category_id, s.category_id)
          IN ('same', 'ancestor', 'descendant')
    LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION
      'canonical product % cannot take primary category %: its secondary classification % is the % of it. Remove the secondary first (#367 Workstream 1).',
      NEW.id, NEW.category_id, offending_category_id, offending_kinship
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER mercaria_canonical_product_primary_category_guard
BEFORE UPDATE OF category_id ON "canonical_products"
FOR EACH ROW WHEN (NEW.category_id IS DISTINCT FROM OLD.category_id)
EXECUTE FUNCTION mercaria_canonical_product_primary_category_guard();
-- oxy:handwritten-end=mercaria_canonical_product_primary_category_guard
--> statement-breakpoint
-- oxy:handwritten-begin=mercaria_category_assignment_selectable
-- Mount the EXISTING selectability function on the two new tables.
--
-- No function is defined here — `0088_redundant_korvac.sql` created
-- `mercaria_category_assignment_selectable()` and this adds two more mount
-- points for it. A structural node is not a valid product assignment (ADR 0007
-- D2), and that is as true of a second filing as of the first; writing a second
-- function that read `categories.selectable` again would be a second authority
-- over one fact, and the two would eventually disagree.
--
-- The existing function reports through `TG_TABLE_NAME`, so it names the right
-- table here with no change: "listing_secondary_categories.category_id cannot
-- name category X: it is a structural node and is not selectable".
--
-- The `WHEN` clause is kept identical to the two existing mounts even though
-- `category_id` is NOT NULL on both of these tables, so the four mounts read the
-- same and a later reader does not have to work out whether the difference
-- meant something.
CREATE TRIGGER mercaria_category_assignment_selectable
BEFORE INSERT OR UPDATE OF category_id ON "listing_secondary_categories"
FOR EACH ROW WHEN (NEW.category_id IS NOT NULL)
EXECUTE FUNCTION mercaria_category_assignment_selectable();--> statement-breakpoint
CREATE TRIGGER mercaria_category_assignment_selectable
BEFORE INSERT OR UPDATE OF category_id ON "canonical_product_secondary_categories"
FOR EACH ROW WHEN (NEW.category_id IS NOT NULL)
EXECUTE FUNCTION mercaria_category_assignment_selectable();
-- oxy:handwritten-end=mercaria_category_assignment_selectable
