-- oxy:deploy-phase=pre
-- oxy:rollback=derived
--
-- Epic #367 line 143 — "Support category-specific overrides only through
-- explicit, versioned rules." One function and one trigger; no table, column,
-- constraint or index is added, dropped, renamed or narrowed, and no existing
-- row is written.
--
-- ## What was open
--
-- `attribute_definition_categories` is the category-level inherited attribute
-- capability of the line above (#367 line 142): one row per (attribute
-- definition VERSION, category), carrying `include_descendants`, which IS the
-- inheritance rule. Its parent is frozen once published — by
-- `mercaria_attribute_definition_immutable` — and its two siblings under that
-- parent, `attribute_enum_values` and `attribute_value_aliases`, are frozen with
-- it by `mercaria_attribute_enum_frozen` (0024). This table was not, and the
-- gap was measured against a real server rather than read off the schema: with
-- the parent `active`, INSERT of a new scope, UPDATE of `include_descendants`,
-- INSERT of a SECOND category and DELETE of a scope were all ACCEPTED, while
-- the same INSERT against a published `product_type_category_scopes` was
-- refused with SQLSTATE 23001.
--
-- That is the hole ADR 0007 D2 names for the product-type twin, in the passage
-- that explains why that table is owned by the product-type domain rather than
-- by taxonomy: "the hole would be exactly where somebody later widens a
-- published version's scope, which is the one edit the immutability guarantee
-- exists to refuse." The product-type side closed it in 0089
-- (`mercaria_product_type_child_frozen`); the attribute side is this file.
--
-- ## Why `pre` rather than `post`
--
-- A `post` statement is one that breaks a write the PREVIOUS image performs.
-- This does not. `db/attributes/definitionRepository.ts`'s
-- `addAttributeDefinitionCategory` is the only writer of this table in
-- non-test code, and all three of its reachable call paths write while the
-- definition is still a DRAFT:
--
--   * `draftAttributeDefinition` (`services/attributes/definition-registry.service.ts`)
--     inserts the scopes inside the same transaction that inserts the row, and
--     that insert states `lifecycleState: 'draft'` explicitly (`:136`);
--   * approving a proposal carries the previous version's scopes into a NEW
--     draft (`services/attributes/version-carry-forward.ts`) and publishes that;
--   * the vertical-package apply (`src/scripts/seed-verticals/apply.ts`) drafts
--     with `categoryScopes` and then publishes.
--
-- No UPDATE and no DELETE of this table exists in non-test code at all. So the
-- serving image and the arriving image perform the same writes, both run
-- cleanly against this schema, and the rollout order does not matter.
--
-- ## Why the DELETE is refused here, unlike 0135
--
-- 0135 permits DELETE throughout because those tables are retention-sweep and
-- cascade targets. This one is neither: `db/expiryTargets.ts` does not name it,
-- and the only cascade that reaches it comes FROM `attribute_definitions`,
-- whose own trigger has already refused the delete for anything published. The
-- DELETE branch therefore reads the parent through OLD and tolerates the parent
-- being gone — a NULL `parent_state` means "the parent is going away
-- legitimately", not "no check ran". That is `mercaria_product_type_child_frozen`'s
-- shape, and permitting DELETE instead would leave the widest edit of the four
-- available: remove the scope and re-add it with `include_descendants` flipped.
--
-- ## Why a new function rather than mounting `mercaria_attribute_enum_frozen`
--
-- That function's body would work unchanged — same parent column, same
-- `<> 'draft'` test — but its message says "its value vocabulary is frozen",
-- and an operator who widens a published attribute's category scope would be
-- told their enum values are the problem. The two functions are deliberately
-- identical in behaviour and differ only in what they say.
--
-- ## HAND-WRITTEN, ENTIRELY
--
-- drizzle-kit models no trigger and no function, so `db:generate` will emit NONE
-- of this and a regeneration DESTROYS the file. It was created with
-- `drizzle-kit generate --custom`, which writes `meta/_journal.json` correctly;
-- never hand-edit the journal or rename the file. The declared half lives in
-- `src/db/categoryScopeFreeze.ts`; `category-scope-freeze-census.test.ts` derives
-- the population it covers from the drizzle schema, and
-- `category-scope-freeze.realdb.test.ts` executes every line of it against a
-- real server.
--
-- Verify after any edit:
--   grep -c '^-- oxy:handwritten-begin=' drizzle/0136_category_scope_stays_with_its_version.sql   # 1
--   grep -c '^-- oxy:handwritten-end='   drizzle/0136_category_scope_stays_with_its_version.sql   # 1
--   grep -c '^-- oxy:deploy-phase='      drizzle/0136_category_scope_stays_with_its_version.sql   # 1

-- oxy:handwritten-begin=mercaria_attribute_definition_scope_frozen
CREATE OR REPLACE FUNCTION mercaria_attribute_definition_scope_frozen()
RETURNS trigger AS $$
DECLARE
  parent_state text;
  parent_id text;
BEGIN
  parent_id := COALESCE(NEW.attribute_definition_id, OLD.attribute_definition_id);
  SELECT lifecycle_state INTO parent_state
  FROM attribute_definitions WHERE id = parent_id;

  IF parent_state IS NOT NULL AND parent_state <> 'draft' THEN
    RAISE EXCEPTION
      'attribute definition % is % and its category scope is frozen; publish a new version instead',
      parent_id, parent_state
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
DROP TRIGGER IF EXISTS attribute_definition_categories_frozen ON "attribute_definition_categories";--> statement-breakpoint
CREATE TRIGGER attribute_definition_categories_frozen
  BEFORE INSERT OR UPDATE OR DELETE ON "attribute_definition_categories"
  FOR EACH ROW EXECUTE FUNCTION mercaria_attribute_definition_scope_frozen();
-- oxy:handwritten-end=mercaria_attribute_definition_scope_frozen
