-- oxy:deploy-phase=pre
-- oxy:rollback=restore: native_listing_links_method_check is widened here and its previous form is in 0064; re-adding it fails against any link stamped with the added method. The four catalog_authoring_drafts triggers beside it are introduced by this same migration, so their drops are armour rather than a loss
--
-- Additive throughout. The four tables are new, and the one statement that
-- touches an existing table is the `native_listing_links_method_check` pair:
-- it re-adds the CHECK with a strict SUPERSET of its members (six, plus
-- `merchant_declared`), so the previously serving image's writes all still
-- satisfy it. A NARROWING there would be `post` and would refuse the write
-- ADR 0007 D10 exists to perform.
CREATE TABLE "catalog_authoring_draft_values" (
	"id" text PRIMARY KEY NOT NULL,
	"draft_id" text NOT NULL,
	"draft_variant_id" text,
	"field_id" text NOT NULL,
	"attribute_definition_id" text NOT NULL,
	"attribute_key" text NOT NULL,
	"attribute_definition_version" integer NOT NULL,
	"scope" text NOT NULL,
	"ordinal" integer DEFAULT 0 NOT NULL,
	"component_axis" text,
	"kind" text NOT NULL,
	"value_text" text,
	"value_number" double precision,
	"value_boolean" boolean,
	"value_enum_value_id" text,
	"canonical_ref_kind" text,
	"canonical_ref_id" text,
	"unit" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "catalog_authoring_draft_values_scope_check" CHECK ("catalog_authoring_draft_values"."scope" in ('identity', 'product', 'variant', 'compatibility')),
	CONSTRAINT "catalog_authoring_draft_values_kind_check" CHECK ("catalog_authoring_draft_values"."kind" in ('text', 'number', 'boolean', 'controlled_value', 'canonical_reference')),
	CONSTRAINT "catalog_authoring_draft_values_component_axis_check" CHECK ("catalog_authoring_draft_values"."component_axis" in ('width', 'height', 'depth', 'diagonal', 'circumference')),
	CONSTRAINT "catalog_authoring_draft_values_canonical_ref_kind_check" CHECK ("catalog_authoring_draft_values"."canonical_ref_kind" in ('canonical_product', 'canonical_variant', 'canonical_product_family', 'brand')),
	CONSTRAINT "catalog_authoring_draft_values_attribute_key_shape_check" CHECK ("catalog_authoring_draft_values"."attribute_key" ~ '^[a-z][a-z0-9_]*$'),
	CONSTRAINT "catalog_authoring_draft_values_attribute_version_check" CHECK ("catalog_authoring_draft_values"."attribute_definition_version" >= 1),
	CONSTRAINT "catalog_authoring_draft_values_ordinal_check" CHECK ("catalog_authoring_draft_values"."ordinal" >= 0),
	CONSTRAINT "catalog_authoring_draft_values_exactly_one_value_check" CHECK (num_nonnulls("catalog_authoring_draft_values"."value_text", "catalog_authoring_draft_values"."value_number", "catalog_authoring_draft_values"."value_boolean", "catalog_authoring_draft_values"."value_enum_value_id", "catalog_authoring_draft_values"."canonical_ref_id") = 1),
	CONSTRAINT "catalog_authoring_draft_values_text_kind_check" CHECK (("catalog_authoring_draft_values"."kind" = 'text') = ("catalog_authoring_draft_values"."value_text" is not null)),
	CONSTRAINT "catalog_authoring_draft_values_number_kind_check" CHECK (("catalog_authoring_draft_values"."kind" = 'number') = ("catalog_authoring_draft_values"."value_number" is not null)),
	CONSTRAINT "catalog_authoring_draft_values_boolean_kind_check" CHECK (("catalog_authoring_draft_values"."kind" = 'boolean') = ("catalog_authoring_draft_values"."value_boolean" is not null)),
	CONSTRAINT "catalog_authoring_draft_values_controlled_kind_check" CHECK (("catalog_authoring_draft_values"."kind" = 'controlled_value') = ("catalog_authoring_draft_values"."value_enum_value_id" is not null)),
	CONSTRAINT "catalog_authoring_draft_values_canonical_kind_check" CHECK (("catalog_authoring_draft_values"."kind" = 'canonical_reference') = ("catalog_authoring_draft_values"."canonical_ref_id" is not null)),
	CONSTRAINT "catalog_authoring_draft_values_canonical_ref_shape_check" CHECK (("catalog_authoring_draft_values"."canonical_ref_id" is not null) = ("catalog_authoring_draft_values"."canonical_ref_kind" is not null)),
	CONSTRAINT "catalog_authoring_draft_values_variant_scope_check" CHECK (("catalog_authoring_draft_values"."scope" = 'variant') = ("catalog_authoring_draft_values"."draft_variant_id" is not null)),
	CONSTRAINT "catalog_authoring_draft_values_unit_check" CHECK ("catalog_authoring_draft_values"."unit" is null or ("catalog_authoring_draft_values"."kind" = 'number' and btrim("catalog_authoring_draft_values"."unit") <> ''))
);
--> statement-breakpoint
CREATE TABLE "catalog_authoring_draft_variants" (
	"id" text PRIMARY KEY NOT NULL,
	"draft_id" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"title" text,
	"sku" text,
	"barcode" text,
	"price_amount" bigint,
	"price_currency" text,
	"compare_at_price_amount" bigint,
	"compare_at_price_currency" text,
	"inventory_tracked" boolean DEFAULT true NOT NULL,
	"inventory_available" integer DEFAULT 0 NOT NULL,
	"axis_signature" text,
	"selected_canonical_variant_id" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "catalog_authoring_draft_variants_price_currency_check" CHECK ("catalog_authoring_draft_variants"."price_currency" in ('FAIR', 'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF', 'CNY', 'SEK', 'NOK', 'DKK', 'PLN', 'MXN', 'BRL', 'INR', 'NZD', 'ZAR', 'SGD', 'HKD', 'AED')),
	CONSTRAINT "catalog_authoring_draft_variants_compare_at_price_currency_check" CHECK ("catalog_authoring_draft_variants"."compare_at_price_currency" in ('FAIR', 'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF', 'CNY', 'SEK', 'NOK', 'DKK', 'PLN', 'MXN', 'BRL', 'INR', 'NZD', 'ZAR', 'SGD', 'HKD', 'AED')),
	CONSTRAINT "catalog_authoring_draft_variants_position_check" CHECK ("catalog_authoring_draft_variants"."position" >= 0),
	CONSTRAINT "catalog_authoring_draft_variants_inventory_check" CHECK ("catalog_authoring_draft_variants"."inventory_available" >= 0),
	CONSTRAINT "catalog_authoring_draft_variants_price_paired_check" CHECK (("catalog_authoring_draft_variants"."price_amount" is null) = ("catalog_authoring_draft_variants"."price_currency" is null)),
	CONSTRAINT "catalog_authoring_draft_variants_compare_at_paired_check" CHECK (("catalog_authoring_draft_variants"."compare_at_price_amount" is null) = ("catalog_authoring_draft_variants"."compare_at_price_currency" is null)),
	CONSTRAINT "catalog_authoring_draft_variants_sku_not_empty_check" CHECK ("catalog_authoring_draft_variants"."sku" is null or btrim("catalog_authoring_draft_variants"."sku") <> ''),
	CONSTRAINT "catalog_authoring_draft_variants_barcode_not_empty_check" CHECK ("catalog_authoring_draft_variants"."barcode" is null or btrim("catalog_authoring_draft_variants"."barcode") <> '')
);
--> statement-breakpoint
CREATE TABLE "catalog_authoring_drafts" (
	"id" text PRIMARY KEY NOT NULL,
	"store_id" text NOT NULL,
	"created_by_oxy_user_id" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"category_id" text NOT NULL,
	"product_type_definition_id" text NOT NULL,
	"flow" text NOT NULL,
	"locale" text NOT NULL,
	"market" text NOT NULL,
	"schema_hash" text NOT NULL,
	"schema_snapshot" jsonb,
	"version" integer DEFAULT 1 NOT NULL,
	"title" text,
	"description" text,
	"image_file_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"selected_canonical_product_id" text,
	"published_listing_id" text,
	"published_at" timestamp with time zone,
	"publish_idempotency_key" text,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "catalog_authoring_drafts_status_check" CHECK ("catalog_authoring_drafts"."status" in ('open', 'published', 'discarded')),
	CONSTRAINT "catalog_authoring_drafts_flow_check" CHECK ("catalog_authoring_drafts"."flow" in ('merchant', 'p2p', 'operator', 'connector', 'verified_brand')),
	CONSTRAINT "catalog_authoring_drafts_locale_shape_check" CHECK ("catalog_authoring_drafts"."locale" = lower(btrim("catalog_authoring_drafts"."locale")) and "catalog_authoring_drafts"."locale" ~ '^[a-z]{2,3}(-[a-z0-9]{2,8})*$'),
	CONSTRAINT "catalog_authoring_drafts_market_shape_check" CHECK ("catalog_authoring_drafts"."market" ~ '^[A-Z]{2}$'),
	CONSTRAINT "catalog_authoring_drafts_version_check" CHECK ("catalog_authoring_drafts"."version" >= 1),
	CONSTRAINT "catalog_authoring_drafts_schema_hash_check" CHECK (btrim("catalog_authoring_drafts"."schema_hash") <> ''),
	CONSTRAINT "catalog_authoring_drafts_published_listing_check" CHECK (("catalog_authoring_drafts"."status" = 'published') = ("catalog_authoring_drafts"."published_listing_id" is not null)),
	CONSTRAINT "catalog_authoring_drafts_published_at_check" CHECK (("catalog_authoring_drafts"."status" = 'published') = ("catalog_authoring_drafts"."published_at" is not null)),
	CONSTRAINT "catalog_authoring_drafts_expiry_check" CHECK (("catalog_authoring_drafts"."status" = 'published') = ("catalog_authoring_drafts"."expires_at" is null)),
	CONSTRAINT "catalog_authoring_drafts_snapshot_bounded_check" CHECK ("catalog_authoring_drafts"."schema_snapshot" is null
          or (jsonb_typeof("catalog_authoring_drafts"."schema_snapshot") = 'object'
              and octet_length("catalog_authoring_drafts"."schema_snapshot"::text) <= 262144))
);
--> statement-breakpoint
CREATE TABLE "catalog_authoring_schema_invalidations" (
	"id" text PRIMARY KEY NOT NULL,
	"subject" text NOT NULL,
	"subject_id" text NOT NULL,
	"revision" bigint DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "catalog_authoring_schema_invalidations_subject_check" CHECK ("catalog_authoring_schema_invalidations"."subject" in ('attribute_values', 'localization', 'category', 'product_type')),
	CONSTRAINT "catalog_authoring_schema_invalidations_revision_check" CHECK ("catalog_authoring_schema_invalidations"."revision" >= 1),
	CONSTRAINT "catalog_authoring_schema_invalidations_subject_id_check" CHECK (btrim("catalog_authoring_schema_invalidations"."subject_id") <> '')
);
--> statement-breakpoint
ALTER TABLE "native_listing_links" DROP CONSTRAINT "native_listing_links_method_check";--> statement-breakpoint
ALTER TABLE "catalog_authoring_draft_values" ADD CONSTRAINT "catalog_authoring_draft_values_draft_id_catalog_authoring_drafts_id_fk" FOREIGN KEY ("draft_id") REFERENCES "public"."catalog_authoring_drafts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_authoring_draft_values" ADD CONSTRAINT "catalog_authoring_draft_values_draft_variant_id_catalog_authoring_draft_variants_id_fk" FOREIGN KEY ("draft_variant_id") REFERENCES "public"."catalog_authoring_draft_variants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_authoring_draft_values" ADD CONSTRAINT "catalog_authoring_draft_values_field_id_product_type_fields_id_fk" FOREIGN KEY ("field_id") REFERENCES "public"."product_type_fields"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_authoring_draft_values" ADD CONSTRAINT "catalog_authoring_draft_values_attribute_definition_id_attribute_definitions_id_fk" FOREIGN KEY ("attribute_definition_id") REFERENCES "public"."attribute_definitions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_authoring_draft_values" ADD CONSTRAINT "catalog_authoring_draft_values_value_enum_value_id_attribute_enum_values_id_fk" FOREIGN KEY ("value_enum_value_id") REFERENCES "public"."attribute_enum_values"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_authoring_draft_variants" ADD CONSTRAINT "catalog_authoring_draft_variants_draft_id_catalog_authoring_drafts_id_fk" FOREIGN KEY ("draft_id") REFERENCES "public"."catalog_authoring_drafts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_authoring_drafts" ADD CONSTRAINT "catalog_authoring_drafts_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_authoring_drafts" ADD CONSTRAINT "catalog_authoring_drafts_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_authoring_drafts" ADD CONSTRAINT "catalog_authoring_drafts_product_type_definition_id_product_type_definitions_id_fk" FOREIGN KEY ("product_type_definition_id") REFERENCES "public"."product_type_definitions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_authoring_drafts" ADD CONSTRAINT "catalog_authoring_drafts_published_listing_id_listings_id_fk" FOREIGN KEY ("published_listing_id") REFERENCES "public"."listings"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "catalog_authoring_draft_values_product_key" ON "catalog_authoring_draft_values" USING btree ("draft_id","field_id","ordinal") WHERE "catalog_authoring_draft_values"."draft_variant_id" is null and "catalog_authoring_draft_values"."component_axis" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "catalog_authoring_draft_values_product_component_key" ON "catalog_authoring_draft_values" USING btree ("draft_id","field_id","component_axis","ordinal") WHERE "catalog_authoring_draft_values"."draft_variant_id" is null and "catalog_authoring_draft_values"."component_axis" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "catalog_authoring_draft_values_variant_key" ON "catalog_authoring_draft_values" USING btree ("draft_variant_id","field_id","ordinal") WHERE "catalog_authoring_draft_values"."draft_variant_id" is not null and "catalog_authoring_draft_values"."component_axis" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "catalog_authoring_draft_values_variant_component_key" ON "catalog_authoring_draft_values" USING btree ("draft_variant_id","field_id","component_axis","ordinal") WHERE "catalog_authoring_draft_values"."draft_variant_id" is not null and "catalog_authoring_draft_values"."component_axis" is not null;--> statement-breakpoint
CREATE INDEX "catalog_authoring_draft_values_draft_idx" ON "catalog_authoring_draft_values" USING btree ("draft_id","scope");--> statement-breakpoint
CREATE INDEX "catalog_authoring_draft_values_attribute_idx" ON "catalog_authoring_draft_values" USING btree ("attribute_key","attribute_definition_version");--> statement-breakpoint
CREATE UNIQUE INDEX "catalog_authoring_draft_variants_signature_key" ON "catalog_authoring_draft_variants" USING btree ("draft_id","axis_signature") WHERE "catalog_authoring_draft_variants"."axis_signature" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "catalog_authoring_draft_variants_position_key" ON "catalog_authoring_draft_variants" USING btree ("draft_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "catalog_authoring_drafts_idempotency_key" ON "catalog_authoring_drafts" USING btree ("store_id","publish_idempotency_key") WHERE "catalog_authoring_drafts"."publish_idempotency_key" is not null;--> statement-breakpoint
CREATE INDEX "catalog_authoring_drafts_store_idx" ON "catalog_authoring_drafts" USING btree ("store_id","status","updated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "catalog_authoring_drafts_expires_at_idx" ON "catalog_authoring_drafts" USING btree ("expires_at") WHERE "catalog_authoring_drafts"."expires_at" is not null;--> statement-breakpoint
CREATE INDEX "catalog_authoring_drafts_product_type_idx" ON "catalog_authoring_drafts" USING btree ("product_type_definition_id");--> statement-breakpoint
CREATE UNIQUE INDEX "catalog_authoring_schema_invalidations_key" ON "catalog_authoring_schema_invalidations" USING btree ("subject","subject_id");--> statement-breakpoint
ALTER TABLE "native_listing_links" ADD CONSTRAINT "native_listing_links_method_check" CHECK ("native_listing_links"."method" in ('barcode_gtin', 'connector_declared', 'operator', 'matcher', 'backfill', 'seller_declared', 'merchant_declared'));
--> statement-breakpoint
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
