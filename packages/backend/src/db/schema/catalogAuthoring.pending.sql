-- The catalog authoring domain (#367 step 5, ADR 0007 D10) — the hand-written
-- statements drizzle-kit cannot model.
--
-- NOT APPLIED. This file is plain text held for the migration slot: ADR 0007 D11
-- serialises `db:generate` across the parallel #367 branches. When the slot
-- arrives, everything between the first `-- oxy:handwritten-begin=` and the last
-- `-- oxy:handwritten-end=` below is appended to the generated `.sql` BELOW the
-- drizzle output, under the single `-- oxy:deploy-phase=pre` marker that file
-- already carries. Every statement here is additive: three trigger functions and
-- four triggers.
--
-- ## What the GENERATED half must contain, and how to check it
--
-- Four `CREATE TABLE`s — `catalog_authoring_drafts`,
-- `catalog_authoring_draft_variants`, `catalog_authoring_draft_values`,
-- `catalog_authoring_schema_invalidations` — with every CHECK and index the
-- drizzle definitions declare, plus ONE statement that is NOT in this domain's
-- own tables and is the easiest thing in the whole change to lose:
--
--   ALTER TABLE "native_listing_links" DROP CONSTRAINT "native_listing_links_method_check";
--   ALTER TABLE "native_listing_links" ADD CONSTRAINT "native_listing_links_method_check"
--     CHECK ("method" in (…, 'seller_declared', 'merchant_declared'));
--
-- That pair comes from `NATIVE_LISTING_LINK_METHODS` gaining `merchant_declared`
-- (ADR 0007 D10's link method) and drizzle-kit renders it from the BUILT
-- `@mercaria/shared-types`. So `bun run build:shared-types` BEFORE `db:generate`
-- is not advice here, it is the difference between a widening and a silent
-- NARROWING that would refuse the one write this whole issue exists to perform.
-- Read the regenerated file for that pair by name; a green build does not
-- contain it.
--
-- ## Two mechanics that make the paste correct rather than plausible
--
-- 1. **Every block is wrapped in a marker pair.**
--    `-- oxy:handwritten-begin=<name>` … `-- oxy:handwritten-end=<name>`, matching
--    by NAME, and no name is reused. `mercaria_catalog_authoring_children_frozen`
--    is ONE function mounted on TWO tables, so it is ONE block containing all
--    three statements rather than two blocks sharing a name.
-- 2. **`--> statement-breakpoint` separates statements and NEVER appears inside a
--    `$$ … $$` body.** Each breakpoint below sits on the terminating `;` of a
--    COMPLETE statement — for a function that is the `$$;` closing the body, never
--    a semicolon inside it. With three function bodies, "one after every `;`" is
--    exactly the wrong heuristic.
--
-- Self-check after the paste:
--   grep -c '^-- oxy:handwritten-begin=' <migration>  -> 3
--   grep -c '^-- oxy:handwritten-end='   <migration>  -> 3
--   grep -c '^CREATE TRIGGER '           <migration>  -> 4
--   grep -c '^-- oxy:deploy-phase='      <migration>  -> 1
--   grep -c 'merchant_declared'          <migration>  -> at least 1
--
-- REGENERATION DROPS EVERY STATEMENT IN THIS FILE. That is the measured failure
-- three of four branches hit in one rebase batch (`~/Oxy/AGENTS.md`), and all
-- three would have applied cleanly and enforced nothing.

-- oxy:handwritten-begin=mercaria_catalog_authoring_draft_pins_frozen
--
-- ADR 0007 D5's pin, and D14's immutable snapshot, as a constraint rather than
-- as care taken by a service.
--
-- TWO rules in one function, because they are one fact at two lifetimes:
--
--  1. The IDENTITY of a draft is frozen from INSERT — the store that owns it,
--     the account that created it, the category, the flow, the locale and the
--     market. `updateDraftIfVersion` has no column for any of them, and this is
--     what makes that a property of the table rather than of the one caller
--     anybody has written. Moving a draft's category would silently reinterpret
--     every answer already in it, which is exactly the reinterpretation the
--     version pin exists to prevent.
--
--  2. The SCHEMA PIN — `product_type_definition_id`, `schema_hash`,
--     `schema_snapshot` — is frozen once the draft leaves `open`. It is NOT
--     frozen while open, deliberately: ADR 0007 D10's upgrade re-pins a draft to
--     a newer published version after the author saw a preview, which is a
--     deliberate act with its own endpoint. What must never change is the pin a
--     PUBLISHED draft records, because that row is the audit answer to "what was
--     this product authored against".
--
-- `is distinct from` throughout rather than `<>`: `schema_snapshot` is nullable
-- and `NULL <> NULL` is NULL, which a trigger's `if` reads as false — so the
-- naive spelling would permit exactly the write that clears a snapshot.
CREATE OR REPLACE FUNCTION mercaria_catalog_authoring_draft_pins_frozen()
RETURNS trigger AS $$
BEGIN
  IF NEW.store_id IS DISTINCT FROM OLD.store_id
     OR NEW.created_by_oxy_user_id IS DISTINCT FROM OLD.created_by_oxy_user_id
     OR NEW.category_id IS DISTINCT FROM OLD.category_id
     OR NEW.flow IS DISTINCT FROM OLD.flow
     OR NEW.locale IS DISTINCT FROM OLD.locale
     OR NEW.market IS DISTINCT FROM OLD.market THEN
    RAISE EXCEPTION
      'catalog_authoring_drafts: a draft''s store, author, category, flow, locale and market are frozen at creation (ADR 0007 D5); start a new draft instead'
      USING ERRCODE = 'raise_exception';
  END IF;

  IF OLD.status <> 'open'
     AND (NEW.product_type_definition_id IS DISTINCT FROM OLD.product_type_definition_id
          OR NEW.schema_hash IS DISTINCT FROM OLD.schema_hash
          OR NEW.schema_snapshot IS DISTINCT FROM OLD.schema_snapshot) THEN
    RAISE EXCEPTION
      'catalog_authoring_drafts: the schema pin of a % draft is immutable (ADR 0007 D10/D14) — it is the record of what this product was authored against', OLD.status
      USING ERRCODE = 'raise_exception';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS catalog_authoring_drafts_pins_frozen ON catalog_authoring_drafts;
--> statement-breakpoint
CREATE TRIGGER catalog_authoring_drafts_pins_frozen
BEFORE UPDATE ON catalog_authoring_drafts
FOR EACH ROW EXECUTE FUNCTION mercaria_catalog_authoring_draft_pins_frozen();
-- oxy:handwritten-end=mercaria_catalog_authoring_draft_pins_frozen
--> statement-breakpoint

-- oxy:handwritten-begin=mercaria_catalog_authoring_value_citation
--
-- The guarded denormalization on `catalog_authoring_draft_values`, exactly the
-- device `mercaria_product_type_field_citation()` already uses one table over.
--
-- `attribute_key` and `attribute_definition_version` are a COPY of the row
-- `attribute_definition_id` points at, and they exist because the upgrade
-- preview and the validation compare versions without joining the registry on
-- every answer. A copy that can disagree with its source is a second authority,
-- and the direction it disagrees in is never the safe one: a stale version here
-- would make an upgrade preview report `unchanged` for an answer whose meaning
-- had moved.
--
-- The THIRD check is the one a reviewer will not expect and is the reason this
-- is a trigger rather than three CHECKs: the value's `field_id` must cite the
-- SAME attribute definition. Without it a draft could store an answer against
-- "colour" under the schema field for "storage capacity" — both rows valid, both
-- CHECKs satisfied, and every surface reporting success. A CHECK cannot express
-- it because it must read another table.
CREATE OR REPLACE FUNCTION mercaria_catalog_authoring_value_citation()
RETURNS trigger AS $$
DECLARE
  definition_key text;
  definition_version integer;
  field_definition_id text;
BEGIN
  SELECT d.key, d.version INTO definition_key, definition_version
  FROM attribute_definitions d
  WHERE d.id = NEW.attribute_definition_id;

  IF definition_key IS NULL THEN
    RAISE EXCEPTION
      'catalog_authoring_draft_values: attribute definition % does not exist', NEW.attribute_definition_id
      USING ERRCODE = 'raise_exception';
  END IF;

  IF NEW.attribute_key IS DISTINCT FROM definition_key
     OR NEW.attribute_definition_version IS DISTINCT FROM definition_version THEN
    RAISE EXCEPTION
      'catalog_authoring_draft_values: the citation (%, v%) disagrees with attribute definition % (%, v%)',
      NEW.attribute_key, NEW.attribute_definition_version,
      NEW.attribute_definition_id, definition_key, definition_version
      USING ERRCODE = 'raise_exception';
  END IF;

  SELECT f.attribute_definition_id INTO field_definition_id
  FROM product_type_fields f
  WHERE f.id = NEW.field_id;

  IF field_definition_id IS DISTINCT FROM NEW.attribute_definition_id THEN
    RAISE EXCEPTION
      'catalog_authoring_draft_values: schema field % cites attribute definition %, not %',
      NEW.field_id, field_definition_id, NEW.attribute_definition_id
      USING ERRCODE = 'raise_exception';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS catalog_authoring_draft_values_citation ON catalog_authoring_draft_values;
--> statement-breakpoint
CREATE TRIGGER catalog_authoring_draft_values_citation
BEFORE INSERT OR UPDATE ON catalog_authoring_draft_values
FOR EACH ROW EXECUTE FUNCTION mercaria_catalog_authoring_value_citation();
-- oxy:handwritten-end=mercaria_catalog_authoring_value_citation
--> statement-breakpoint

-- oxy:handwritten-begin=mercaria_catalog_authoring_children_frozen
--
-- A published or discarded draft's answers are the record of what was authored,
-- and nothing may edit them.
--
-- ONE function mounted on BOTH child tables, so the two cannot drift.
--
-- ## INSERT and UPDATE only, and the omission is deliberate
--
-- DELETE is NOT refused, and refusing it would break two things that must work:
-- the `ON DELETE CASCADE` from the draft (which the store cascade and the expiry
-- sweep both rely on), and the sweep itself, whose population is exactly the
-- non-published drafts. A trigger refusing DELETE would make the retention this
-- domain owes fail SILENTLY on every row it was obliged to remove — the
-- `analytics_events` reasoning, and the same conclusion.
--
-- What that leaves reachable is a direct DELETE of a published draft's answers,
-- and it is reachable by `psql` alone: no service issues one (the only deletes
-- are inside `patchDraft`, which the pins trigger and the CAS both hold to an
-- open draft), and no route exists that could. Recorded here rather than left
-- for a reader to notice.
CREATE OR REPLACE FUNCTION mercaria_catalog_authoring_children_frozen()
RETURNS trigger AS $$
DECLARE
  parent_status text;
BEGIN
  SELECT d.status INTO parent_status
  FROM catalog_authoring_drafts d
  WHERE d.id = NEW.draft_id;

  IF parent_status IS NULL THEN
    RAISE EXCEPTION
      'catalog_authoring: draft % does not exist', NEW.draft_id
      USING ERRCODE = 'raise_exception';
  END IF;

  IF parent_status <> 'open' THEN
    RAISE EXCEPTION
      'catalog_authoring: draft % is %, so its answers are the record of what was authored and cannot be changed (ADR 0007 D10)', NEW.draft_id, parent_status
      USING ERRCODE = 'raise_exception';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS catalog_authoring_draft_variants_frozen ON catalog_authoring_draft_variants;
--> statement-breakpoint
CREATE TRIGGER catalog_authoring_draft_variants_frozen
BEFORE INSERT OR UPDATE ON catalog_authoring_draft_variants
FOR EACH ROW EXECUTE FUNCTION mercaria_catalog_authoring_children_frozen();
--> statement-breakpoint
DROP TRIGGER IF EXISTS catalog_authoring_draft_values_frozen ON catalog_authoring_draft_values;
--> statement-breakpoint
CREATE TRIGGER catalog_authoring_draft_values_frozen
BEFORE INSERT OR UPDATE ON catalog_authoring_draft_values
FOR EACH ROW EXECUTE FUNCTION mercaria_catalog_authoring_children_frozen();
-- oxy:handwritten-end=mercaria_catalog_authoring_children_frozen
