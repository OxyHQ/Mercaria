-- oxy:deploy-phase=pre
-- oxy:rollback=derived
--
-- #367 workstreams 2 and 3: a product-type FIELD gets its own localized
-- authoring copy, and a product type gets search aliases.
--
-- Additive throughout. Four NULLABLE columns on `product_type_fields`, two new
-- tables, and no DROP, no narrowing and no `SET NOT NULL` anywhere -- so the
-- serving image, which writes none of these columns, keeps working unchanged.
--
-- The four base-locale columns are what make the localization table coherent:
-- `product_type_field_localizations_locale_not_base_check` refuses a row
-- carrying the base locale, because family-wide the base string lives on the
-- ENTITY's own column. Without them a field's base-locale placeholder and
-- example would have had no row shape at all.

CREATE TABLE "product_type_aliases" (
	"id" text PRIMARY KEY NOT NULL,
	"product_type_definition_id" text NOT NULL,
	"locale" text NOT NULL,
	"alias" text NOT NULL,
	"normalized_alias" text NOT NULL,
	"kind" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "product_type_aliases_kind_check" CHECK ("product_type_aliases"."kind" in ('synonym', 'search_term', 'legacy_name', 'misspelling', 'transliteration', 'abbreviation', 'regional_term')),
	CONSTRAINT "product_type_aliases_alias_present_check" CHECK (length(btrim("product_type_aliases"."alias")) > 0),
	CONSTRAINT "product_type_aliases_normalized_present_check" CHECK (length(btrim("product_type_aliases"."normalized_alias")) > 0),
	CONSTRAINT "product_type_aliases_locale_present_check" CHECK (length(btrim("product_type_aliases"."locale")) > 0)
);
--> statement-breakpoint
CREATE TABLE "product_type_field_localizations" (
	"id" text PRIMARY KEY NOT NULL,
	"product_type_field_id" text NOT NULL,
	"locale" text NOT NULL,
	"status" text NOT NULL,
	"provenance" text NOT NULL,
	"source_locale" text,
	"source_revision" text,
	"reviewed_by_oxy_user_id" text,
	"reviewed_at" timestamp with time zone,
	"label" text,
	"help_text" text,
	"placeholder" text,
	"example" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "product_type_field_localizations_locale_check" CHECK ("product_type_field_localizations"."locale" in ('ar', 'ar-ae', 'ar-eg', 'ar-ma', 'ar-sa', 'bn', 'bn-bd', 'bn-in', 'ca', 'ca-es', 'de', 'de-at', 'de-ch', 'de-de', 'en', 'en-ca', 'en-gb', 'en-us', 'es', 'es-ar', 'es-es', 'es-mx', 'fr', 'fr-be', 'fr-ca', 'fr-ch', 'fr-fr', 'hi', 'hi-in', 'ja', 'ja-jp', 'pt', 'pt-br', 'pt-pt', 'ru', 'ru-ru', 'zh', 'zh-cn', 'zh-hans', 'zh-sg')),
	CONSTRAINT "product_type_field_localizations_source_locale_check" CHECK ("product_type_field_localizations"."source_locale" in ('ar', 'ar-ae', 'ar-eg', 'ar-ma', 'ar-sa', 'bn', 'bn-bd', 'bn-in', 'ca', 'ca-es', 'de', 'de-at', 'de-ch', 'de-de', 'en', 'en-ca', 'en-gb', 'en-us', 'es', 'es-ar', 'es-es', 'es-mx', 'fr', 'fr-be', 'fr-ca', 'fr-ch', 'fr-fr', 'hi', 'hi-in', 'ja', 'ja-jp', 'pt', 'pt-br', 'pt-pt', 'ru', 'ru-ru', 'zh', 'zh-cn', 'zh-hans', 'zh-sg')),
	CONSTRAINT "product_type_field_localizations_status_check" CHECK ("product_type_field_localizations"."status" in ('missing', 'machine_translated', 'reviewed', 'approved', 'stale', 'deprecated')),
	CONSTRAINT "product_type_field_localizations_provenance_check" CHECK ("product_type_field_localizations"."provenance" in ('mercaria', 'official_brand', 'professional', 'community_reviewed', 'machine', 'imported_source')),
	CONSTRAINT "product_type_field_localizations_locale_not_base_check" CHECK ("product_type_field_localizations"."locale" <> 'en'),
	CONSTRAINT "product_type_field_localizations_missing_text_check" CHECK (("product_type_field_localizations"."status" = 'missing') = ("product_type_field_localizations"."label" is null)),
	CONSTRAINT "product_type_field_localizations_text_not_blank_check" CHECK ("product_type_field_localizations"."label" is null or btrim("product_type_field_localizations"."label") <> ''),
	CONSTRAINT "product_type_field_localizations_machine_status_check" CHECK ("product_type_field_localizations"."provenance" <> 'machine' or "product_type_field_localizations"."status" not in ('reviewed', 'approved')),
	CONSTRAINT "product_type_field_localizations_machine_reviewer_check" CHECK ("product_type_field_localizations"."provenance" <> 'machine' or ("product_type_field_localizations"."reviewed_by_oxy_user_id" is null and "product_type_field_localizations"."reviewed_at" is null)),
	CONSTRAINT "product_type_field_localizations_reviewer_pair_check" CHECK (("product_type_field_localizations"."reviewed_by_oxy_user_id" is null) = ("product_type_field_localizations"."reviewed_at" is null)),
	CONSTRAINT "product_type_field_localizations_reviewed_audit_check" CHECK ("product_type_field_localizations"."status" not in ('reviewed', 'approved') or "product_type_field_localizations"."reviewed_by_oxy_user_id" is not null)
);
--> statement-breakpoint
ALTER TABLE "product_type_fields" ADD COLUMN "label" text;--> statement-breakpoint
ALTER TABLE "product_type_fields" ADD COLUMN "help_text" text;--> statement-breakpoint
ALTER TABLE "product_type_fields" ADD COLUMN "placeholder" text;--> statement-breakpoint
ALTER TABLE "product_type_fields" ADD COLUMN "example" text;--> statement-breakpoint
ALTER TABLE "product_type_aliases" ADD CONSTRAINT "product_type_aliases_product_type_definition_id_product_type_definitions_id_fk" FOREIGN KEY ("product_type_definition_id") REFERENCES "public"."product_type_definitions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_type_field_localizations" ADD CONSTRAINT "product_type_field_localizations_product_type_field_id_product_type_fields_id_fk" FOREIGN KEY ("product_type_field_id") REFERENCES "public"."product_type_fields"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "product_type_aliases_definition_locale_normalized_key" ON "product_type_aliases" USING btree ("product_type_definition_id","locale","normalized_alias");--> statement-breakpoint
CREATE INDEX "product_type_aliases_lookup_idx" ON "product_type_aliases" USING btree ("locale","normalized_alias");--> statement-breakpoint
CREATE UNIQUE INDEX "product_type_field_localizations_locale_key" ON "product_type_field_localizations" USING btree ("product_type_field_id","locale");--> statement-breakpoint
ALTER TABLE "product_type_fields" ADD CONSTRAINT "product_type_fields_label_not_blank_check" CHECK ("product_type_fields"."label" is null or btrim("product_type_fields"."label") <> '');--> statement-breakpoint
ALTER TABLE "product_type_fields" ADD CONSTRAINT "product_type_fields_help_text_not_blank_check" CHECK ("product_type_fields"."help_text" is null or btrim("product_type_fields"."help_text") <> '');--> statement-breakpoint
ALTER TABLE "product_type_fields" ADD CONSTRAINT "product_type_fields_placeholder_not_blank_check" CHECK ("product_type_fields"."placeholder" is null or btrim("product_type_fields"."placeholder") <> '');--> statement-breakpoint
ALTER TABLE "product_type_fields" ADD CONSTRAINT "product_type_fields_example_not_blank_check" CHECK ("product_type_fields"."example" is null or btrim("product_type_fields"."example") <> '');
--> statement-breakpoint

-- oxy:handwritten-begin=mercaria_product_type_field_localizations_machine_guard
-- The function is DELIBERATELY not redeclared here.
--
-- `mercaria_localization_machine_write_guard()` is created by
-- `0091_slimy_the_fury.sql`, which the journal applies before this file. A
-- `CREATE OR REPLACE` of the identical body would look harmless and is not: on
-- a from-zero apply THIS copy runs last and wins, so a later correction to
-- 0091's body would be silently reverted by a stale duplicate sitting in a
-- migration about product types. One body, one file — which is the rule
-- `catalog-localization.test.ts` enforces, and it caught this.
--
-- What this file adds is the ATTACHMENT: the fourth text table in the family
-- gets the same guard the other three already have. The CHECKs on the table
-- refuse the resulting ROW; this refuses the TRANSITION, and neither covers the
-- other — a machine write that also downgrades the status passes every CHECK,
-- and an INSERT claiming `machine` + `approved` never fires an UPDATE trigger.
DROP TRIGGER IF EXISTS mercaria_product_type_field_localizations_machine_guard ON "product_type_field_localizations";--> statement-breakpoint
CREATE TRIGGER mercaria_product_type_field_localizations_machine_guard
  BEFORE UPDATE ON "product_type_field_localizations"
  FOR EACH ROW EXECUTE FUNCTION mercaria_localization_machine_write_guard();
-- oxy:handwritten-end=mercaria_product_type_field_localizations_machine_guard

--> statement-breakpoint

-- oxy:handwritten-begin=mercaria_product_type_fields_localization_stale
CREATE OR REPLACE FUNCTION mercaria_product_type_fields_localization_stale()
RETURNS trigger AS $$
BEGIN
  UPDATE "product_type_field_localizations"
     SET status = 'stale',
         updated_at = date_trunc('milliseconds', now())
   WHERE product_type_field_id = NEW.id
     AND status IN ('machine_translated', 'reviewed', 'approved');
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
DROP TRIGGER IF EXISTS mercaria_product_type_fields_localization_stale ON "product_type_fields";--> statement-breakpoint
CREATE TRIGGER mercaria_product_type_fields_localization_stale
  AFTER UPDATE ON "product_type_fields"
  FOR EACH ROW
  WHEN (OLD.label IS DISTINCT FROM NEW.label
        OR OLD.help_text IS DISTINCT FROM NEW.help_text
        OR OLD.placeholder IS DISTINCT FROM NEW.placeholder
        OR OLD.example IS DISTINCT FROM NEW.example)
  EXECUTE FUNCTION mercaria_product_type_fields_localization_stale();
-- oxy:handwritten-end=mercaria_product_type_fields_localization_stale

