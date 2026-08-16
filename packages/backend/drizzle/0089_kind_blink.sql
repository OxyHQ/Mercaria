-- oxy:deploy-phase=pre
--
-- #367 step 3: versioned product types, fields, groups and category scopes
-- (ADR 0007 D5/D6/D8/D14, following D11's migration protocol).
--
-- ADDITIVE THROUGHOUT, which is why the phase is `pre`. Four new tables that
-- nothing yet writes, four functions and five triggers that fire only on those
-- tables, and NOT ONE statement that narrows, drops or renames anything the
-- previously serving image reads or writes. There is no column added to any
-- existing table: `categories` and `attribute_definitions` are REFERENCED by
-- foreign key and are not touched.
--
-- ## The hand-written half, and what a regeneration does to it
--
-- Everything below the DDL — `mercaria_product_type_definition_immutable`,
-- `mercaria_product_type_child_frozen`, `mercaria_product_type_field_citation`
-- and their five triggers — is hand-written and drizzle-kit cannot model any of
-- it. **A regeneration DROPS all of it silently.** If this file is ever
-- regenerated, re-apply every function and trigger below and then grep the
-- result for each `CREATE OR REPLACE FUNCTION` / `CREATE TRIGGER` pair and for
-- exactly one `-- oxy:deploy-phase=` line. A migration that applies cleanly and
-- enforces nothing is the failure this note exists to prevent; it has cost this
-- repository three branches' triggers already.
--
-- The triggers are what make the schema's central promise true rather than
-- merely intended: a published version is frozen, its children are frozen with
-- it, and a field's denormalized citation cannot disagree with the attribute
-- definition its foreign key names. The last one is why the citation columns are
-- safe to exist at all — `product_type_fields_variant_axis_check` has to be a
-- CHECK, and a CHECK admits no subquery.

CREATE TABLE "product_type_category_scopes" (
	"id" text PRIMARY KEY NOT NULL,
	"product_type_definition_id" text NOT NULL,
	"category_id" text NOT NULL,
	"include_descendants" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "product_type_definitions" (
	"id" text PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"lifecycle" text DEFAULT 'draft' NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"pending_proposal_policy" text DEFAULT 'block_publication' NOT NULL,
	"created_by_oxy_user_id" text,
	"published_by_oxy_user_id" text,
	"published_at" timestamp with time zone,
	"deprecated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "product_type_definitions_lifecycle_check" CHECK ("product_type_definitions"."lifecycle" in ('draft', 'review', 'published', 'deprecated')),
	CONSTRAINT "product_type_definitions_pending_proposal_policy_check" CHECK ("product_type_definitions"."pending_proposal_policy" in ('block_publication', 'allow_local_claim')),
	CONSTRAINT "product_type_definitions_key_shape_check" CHECK ("product_type_definitions"."key" ~ '^[a-z][a-z0-9_]*(.[a-z][a-z0-9_]*)*$'),
	CONSTRAINT "product_type_definitions_version_check" CHECK ("product_type_definitions"."version" >= 1),
	CONSTRAINT "product_type_definitions_published_audit_check" CHECK (("product_type_definitions"."lifecycle" in ('draft', 'review'))
          = ("product_type_definitions"."published_at" is null and "product_type_definitions"."published_by_oxy_user_id" is null)),
	CONSTRAINT "product_type_definitions_deprecated_at_check" CHECK (("product_type_definitions"."lifecycle" = 'deprecated') = ("product_type_definitions"."deprecated_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "product_type_field_groups" (
	"id" text PRIMARY KEY NOT NULL,
	"product_type_definition_id" text NOT NULL,
	"key" text NOT NULL,
	"label" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "product_type_field_groups_identity_key" UNIQUE("id","product_type_definition_id"),
	CONSTRAINT "product_type_field_groups_key_shape_check" CHECK ("product_type_field_groups"."key" ~ '^[a-z][a-z0-9_]*$'),
	CONSTRAINT "product_type_field_groups_position_check" CHECK ("product_type_field_groups"."position" >= 0)
);
--> statement-breakpoint
CREATE TABLE "product_type_fields" (
	"id" text PRIMARY KEY NOT NULL,
	"product_type_definition_id" text NOT NULL,
	"group_id" text,
	"attribute_definition_id" text NOT NULL,
	"attribute_key" text NOT NULL,
	"attribute_definition_version" integer NOT NULL,
	"scope" text NOT NULL,
	"flow" text NOT NULL,
	"requirement" text NOT NULL,
	"value_policy" text NOT NULL,
	"variant_capable" boolean DEFAULT false NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"visibility_rule" jsonb,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "product_type_fields_scope_check" CHECK ("product_type_fields"."scope" in ('identity', 'product', 'variant', 'compatibility')),
	CONSTRAINT "product_type_fields_flow_check" CHECK ("product_type_fields"."flow" in ('merchant', 'p2p', 'operator', 'connector', 'verified_brand')),
	CONSTRAINT "product_type_fields_requirement_check" CHECK ("product_type_fields"."requirement" in ('required', 'recommended', 'optional', 'hidden', 'forbidden')),
	CONSTRAINT "product_type_fields_value_policy_check" CHECK ("product_type_fields"."value_policy" in ('controlled_value', 'canonical_reference', 'typed_scalar', 'typed_structured', 'proposal_enabled')),
	CONSTRAINT "product_type_fields_attribute_key_shape_check" CHECK ("product_type_fields"."attribute_key" ~ '^[a-z][a-z0-9_]*$'),
	CONSTRAINT "product_type_fields_attribute_version_check" CHECK ("product_type_fields"."attribute_definition_version" >= 1),
	CONSTRAINT "product_type_fields_position_check" CHECK ("product_type_fields"."position" >= 0),
	CONSTRAINT "product_type_fields_variant_axis_check" CHECK ("product_type_fields"."variant_capable" is false
          or ("product_type_fields"."scope" = 'variant'
              and "product_type_fields"."attribute_key" <> all (array['price', 'sale_price', 'list_price', 'current_price', 'total_price', 'known_total', 'availability', 'in_stock', 'stock', 'stock_level', 'inventory', 'condition', 'shipping_cost', 'shipping_price', 'delivery_cost', 'delivery_days', 'lead_time', 'seller', 'merchant', 'offer_count', 'vehicle_make', 'vehicle_model', 'vehicle_generation', 'vehicle_configuration', 'vehicle_year', 'vehicle_year_range', 'model_year', 'year_range', 'fitment', 'fits_vehicle', 'compatible_with', 'compatible_model', 'compatibility']::text[]))),
	CONSTRAINT "product_type_fields_forbidden_shape_check" CHECK ("product_type_fields"."requirement" <> 'forbidden'
          or ("product_type_fields"."visibility_rule" is null and "product_type_fields"."variant_capable" is false)),
	CONSTRAINT "product_type_fields_visibility_rule_bounded_check" CHECK ("product_type_fields"."visibility_rule" is null
          or (jsonb_typeof("product_type_fields"."visibility_rule") = 'object'
              and octet_length("product_type_fields"."visibility_rule"::text) <= 4096))
);
--> statement-breakpoint
ALTER TABLE "product_type_category_scopes" ADD CONSTRAINT "product_type_category_scopes_product_type_definition_id_product_type_definitions_id_fk" FOREIGN KEY ("product_type_definition_id") REFERENCES "public"."product_type_definitions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_type_category_scopes" ADD CONSTRAINT "product_type_category_scopes_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_type_field_groups" ADD CONSTRAINT "product_type_field_groups_product_type_definition_id_product_type_definitions_id_fk" FOREIGN KEY ("product_type_definition_id") REFERENCES "public"."product_type_definitions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_type_fields" ADD CONSTRAINT "product_type_fields_product_type_definition_id_product_type_definitions_id_fk" FOREIGN KEY ("product_type_definition_id") REFERENCES "public"."product_type_definitions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_type_fields" ADD CONSTRAINT "product_type_fields_attribute_definition_id_attribute_definitions_id_fk" FOREIGN KEY ("attribute_definition_id") REFERENCES "public"."attribute_definitions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_type_fields" ADD CONSTRAINT "product_type_fields_group_fk" FOREIGN KEY ("group_id","product_type_definition_id") REFERENCES "public"."product_type_field_groups"("id","product_type_definition_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "product_type_category_scopes_key" ON "product_type_category_scopes" USING btree ("product_type_definition_id","category_id");--> statement-breakpoint
CREATE INDEX "product_type_category_scopes_category_idx" ON "product_type_category_scopes" USING btree ("category_id");--> statement-breakpoint
CREATE UNIQUE INDEX "product_type_definitions_key_version_key" ON "product_type_definitions" USING btree ("key","version");--> statement-breakpoint
CREATE UNIQUE INDEX "product_type_definitions_one_published_per_key" ON "product_type_definitions" USING btree ("key") WHERE "product_type_definitions"."lifecycle" = 'published';--> statement-breakpoint
CREATE INDEX "product_type_definitions_lifecycle_idx" ON "product_type_definitions" USING btree ("lifecycle","key");--> statement-breakpoint
CREATE UNIQUE INDEX "product_type_field_groups_key_key" ON "product_type_field_groups" USING btree ("product_type_definition_id","key");--> statement-breakpoint
CREATE INDEX "product_type_field_groups_position_idx" ON "product_type_field_groups" USING btree ("product_type_definition_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "product_type_fields_flow_attribute_key" ON "product_type_fields" USING btree ("product_type_definition_id","flow","attribute_definition_id");--> statement-breakpoint
CREATE INDEX "product_type_fields_layout_idx" ON "product_type_fields" USING btree ("product_type_definition_id","flow","position");--> statement-breakpoint
CREATE INDEX "product_type_fields_attribute_idx" ON "product_type_fields" USING btree ("attribute_key","attribute_definition_version");

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
