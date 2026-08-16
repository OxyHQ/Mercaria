-- PENDING, NOT APPLIED. The hand-written half of #367 step 3's migration
-- (ADR 0007 D5). It is held here rather than in `drizzle/` because ADR 0007 D11
-- serializes the migration slot across the epic's parallel branches: the branch
-- that holds the slot rebases on `origin/main`, runs `bun run build:shared-types`
-- then `bun run db:generate`, and appends these statements to the generated file
-- BEFORE pushing.
--
-- Two things about that append, both of which have cost this repository before:
--
--  * regeneration DROPS every hand-written statement, so after any regenerate,
--    re-apply this whole file and grep the result for each function/trigger pair
--    below plus exactly one `-- oxy:deploy-phase=` line;
--  * these statements are all ADDITIVE (functions, triggers, one constraint on a
--    brand-new table), so they belong in a `-- oxy:deploy-phase=pre` file. No
--    statement here breaks a write the previous image performs, because the
--    previous image does not know these four tables exist.
--
-- Placement inside the generated file: AFTER the four `CREATE TABLE` statements
-- and after every `ADD CONSTRAINT`, because each trigger references a table and
-- `mercaria_product_type_field_citation` reads `attribute_definitions`.

--> statement-breakpoint
-- A published product-type VERSION is frozen (ADR 0007 D5), by the mechanism
-- `fee_schedules_immutable_once_active` (#88) and
-- `attribute_definitions_immutable_once_published` (#94) already use. Third use,
-- deliberately not a new idiom.
--
-- The reason is stronger here than for either precedent: an authored listing
-- PINS the product type version it was made under, so editing a published
-- version does not correct those listings, it silently reinterprets them — and
-- the evidence that they ever meant anything else is gone. Changing a schema is
-- publishing a NEW version, which is what makes a migration of existing records
-- a deliberate, previewable act (ADR 0007 D5, closing paragraph).
--
-- `key` and `version` are frozen from INSERT and not merely from publication.
-- ADR 0007 D1 rule 2 is explicit: a renamed key is indistinguishable from a
-- different concept to every seed, fixture, external mapping and export that
-- cited it — and a DRAFT's key is exactly what a seed cites while a schema is
-- still being built.
--
-- What stays movable is bookkeeping about the version rather than part of its
-- meaning: `lifecycle`, `published_by_oxy_user_id`, `published_at`,
-- `deprecated_at`, and `updated_at` which drizzle maintains. `name` and
-- `description` are deliberately NOT frozen — the stored KEY is what has to stay
-- stable, and a promise that a label can never be corrected is worth nothing to
-- anybody.
--
-- DELETE is refused for anything that has ever been published: a stored record
-- names its version, and deleting the version leaves that record uninterpretable.
CREATE OR REPLACE FUNCTION mercaria_product_type_definition_immutable()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.lifecycle NOT IN ('draft', 'review') THEN
      RAISE EXCEPTION
        'product_type_definitions % (%, v%) is % and cannot be deleted; authored records cite this version',
        OLD.id, OLD.key, OLD.version, OLD.lifecycle
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
  END IF;

  -- ADR 0007 D1 rule 2, at every lifecycle state including draft.
  IF NEW.key IS DISTINCT FROM OLD.key OR NEW.version IS DISTINCT FROM OLD.version THEN
    RAISE EXCEPTION
      'product_type_definitions % identity (%, v%) is frozen; deprecate and supersede instead of renaming',
      OLD.id, OLD.key, OLD.version
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF OLD.lifecycle IN ('draft', 'review') THEN
    RETURN NEW;
  END IF;

  IF NEW.pending_proposal_policy IS DISTINCT FROM OLD.pending_proposal_policy
     OR NEW.created_by_oxy_user_id IS DISTINCT FROM OLD.created_by_oxy_user_id
  THEN
    RAISE EXCEPTION
      'product_type_definitions % (%, v%) is % and its policy is frozen; publish a new version instead',
      OLD.id, OLD.key, OLD.version, OLD.lifecycle
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
DROP TRIGGER IF EXISTS product_type_definitions_immutable_once_published ON "product_type_definitions";--> statement-breakpoint
CREATE TRIGGER product_type_definitions_immutable_once_published
  BEFORE UPDATE OR DELETE ON "product_type_definitions"
  FOR EACH ROW EXECUTE FUNCTION mercaria_product_type_definition_immutable();--> statement-breakpoint

-- The CHILDREN of a published version are frozen too, and for the same reason:
-- a schema whose field list, groups or category eligibility could change after
-- publication is not a version, it is a mutable document wearing a version
-- number. The child tables carry no lifecycle of their own, so the guard reads
-- the parent's — `mercaria_attribute_enum_frozen`'s shape (#94), one domain over.
--
-- The DELETE branch reads the parent through OLD and deliberately tolerates the
-- parent being gone: a cascade from `product_type_definitions` deletes these
-- rows, and the definition trigger above has already refused that cascade for
-- anything published. A NULL `parent_state` therefore means "the parent is going
-- away legitimately", not "no check ran".
CREATE OR REPLACE FUNCTION mercaria_product_type_child_frozen()
RETURNS trigger AS $$
DECLARE
  parent_state text;
  parent_id text;
BEGIN
  parent_id := COALESCE(NEW.product_type_definition_id, OLD.product_type_definition_id);
  SELECT lifecycle INTO parent_state
  FROM product_type_definitions WHERE id = parent_id;

  IF parent_state IS NOT NULL AND parent_state NOT IN ('draft', 'review') THEN
    RAISE EXCEPTION
      'product type definition % is % and its authoring contract is frozen; publish a new version instead',
      parent_id, parent_state
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
DROP TRIGGER IF EXISTS product_type_field_groups_frozen ON "product_type_field_groups";--> statement-breakpoint
CREATE TRIGGER product_type_field_groups_frozen
  BEFORE INSERT OR UPDATE OR DELETE ON "product_type_field_groups"
  FOR EACH ROW EXECUTE FUNCTION mercaria_product_type_child_frozen();--> statement-breakpoint
DROP TRIGGER IF EXISTS product_type_category_scopes_frozen ON "product_type_category_scopes";--> statement-breakpoint
CREATE TRIGGER product_type_category_scopes_frozen
  BEFORE INSERT OR UPDATE OR DELETE ON "product_type_category_scopes"
  FOR EACH ROW EXECUTE FUNCTION mercaria_product_type_child_frozen();--> statement-breakpoint
DROP TRIGGER IF EXISTS product_type_fields_frozen ON "product_type_fields";--> statement-breakpoint
CREATE TRIGGER product_type_fields_frozen
  BEFORE INSERT OR UPDATE OR DELETE ON "product_type_fields"
  FOR EACH ROW EXECUTE FUNCTION mercaria_product_type_child_frozen();--> statement-breakpoint

-- The two CROSS-ROW rules on `product_type_fields`. Both are triggers rather
-- than CHECKs because a CHECK may not contain a subquery, and both are here
-- rather than in a service because a rule that lives only in a service is one
-- forgotten call site from being no rule at all.
--
-- 1. THE CITATION AGREES WITH WHAT IT CITES. `attribute_key` and
--    `attribute_definition_version` are a denormalization of the row
--    `attribute_definition_id` points at, and they exist only so that
--    `product_type_fields_variant_axis_check` can be a real CHECK — the
--    variant-axis prohibition (ADR 0007 D6/D8) is the one rule in this domain
--    that must hold against `psql`. Guarding them here is what stops the
--    denormalization becoming a second authority.
--
-- 2. THE FLOWS OF ONE ATTRIBUTE AGREE ABOUT WHAT IT IS. A field row is per
--    (version, flow, attribute), so `scope`, `variant_capable` and
--    `value_policy` are repeated across the five flows of one attribute. WHO is
--    asked and in what order legitimately varies per flow; whether colour
--    defines variants does not, and two flows disagreeing about it is a schema
--    that answers one question two ways.
CREATE OR REPLACE FUNCTION mercaria_product_type_field_citation()
RETURNS trigger AS $$
DECLARE
  cited_key text;
  cited_version integer;
  sibling record;
BEGIN
  SELECT key, version INTO cited_key, cited_version
  FROM attribute_definitions WHERE id = NEW.attribute_definition_id;

  IF cited_key IS NULL THEN
    RAISE EXCEPTION
      'product_type_fields % cites attribute definition % which does not exist',
      NEW.id, NEW.attribute_definition_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF NEW.attribute_key IS DISTINCT FROM cited_key
     OR NEW.attribute_definition_version IS DISTINCT FROM cited_version
  THEN
    RAISE EXCEPTION
      'product_type_fields % cites (%, v%) but names (%, v%); the citation must match the definition it points at',
      NEW.id, cited_key, cited_version, NEW.attribute_key, NEW.attribute_definition_version
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  SELECT f.flow, f.scope, f.variant_capable, f.value_policy INTO sibling
  FROM product_type_fields f
  WHERE f.product_type_definition_id = NEW.product_type_definition_id
    AND f.attribute_definition_id = NEW.attribute_definition_id
    AND f.id <> NEW.id
    AND (f.scope IS DISTINCT FROM NEW.scope
         OR f.variant_capable IS DISTINCT FROM NEW.variant_capable
         OR f.value_policy IS DISTINCT FROM NEW.value_policy)
  LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION
      'product_type_fields % (flow %) disagrees with flow % about attribute %: scope/variant_capable/value_policy are facts about the attribute, not about who is authoring',
      NEW.id, NEW.flow, sibling.flow, NEW.attribute_key
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
DROP TRIGGER IF EXISTS product_type_fields_citation ON "product_type_fields";--> statement-breakpoint
CREATE TRIGGER product_type_fields_citation
  BEFORE INSERT OR UPDATE ON "product_type_fields"
  FOR EACH ROW EXECUTE FUNCTION mercaria_product_type_field_citation();
