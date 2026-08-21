-- oxy:deploy-phase=pre
-- oxy:rollback=derived
--
-- Catalog localization (#367 merge-order step 2, ADR 0007 D4).
--
-- Purely ADDITIVE: four new tables, five foreign keys, six indexes, four
-- functions and six triggers. Nothing is dropped, narrowed or renamed, so no
-- statement here breaks a write the previously serving image performs.
--
-- The hand-written block below is anchored by begin/end markers, because
-- `db:generate` emits no trigger and no function and DROPS every one it finds
-- on a regeneration. `migration-handwritten-markers.test.ts` fails the build on
-- an unmarked one. Counts, verifiable with an anchored grep:
--
--   6 CREATE TRIGGER, 4 CREATE OR REPLACE FUNCTION
--   4 begin markers, 4 end markers, 1 deploy-phase line
--

CREATE TABLE "attribute_value_localizations" (
	"id" text PRIMARY KEY NOT NULL,
	"attribute_enum_value_id" text NOT NULL,
	"locale" text NOT NULL,
	"status" text NOT NULL,
	"provenance" text NOT NULL,
	"source_locale" text,
	"source_revision" text,
	"reviewed_by_oxy_user_id" text,
	"reviewed_at" timestamp with time zone,
	"label" text,
	"description" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "attribute_value_localizations_locale_check" CHECK ("attribute_value_localizations"."locale" in ('ar', 'ar-ae', 'ar-eg', 'ar-ma', 'ar-sa', 'bn', 'bn-bd', 'bn-in', 'ca', 'ca-es', 'de', 'de-at', 'de-ch', 'de-de', 'en', 'en-ca', 'en-gb', 'en-us', 'es', 'es-ar', 'es-es', 'es-mx', 'fr', 'fr-be', 'fr-ca', 'fr-ch', 'fr-fr', 'hi', 'hi-in', 'ja', 'ja-jp', 'pt', 'pt-br', 'pt-pt', 'ru', 'ru-ru', 'zh', 'zh-cn', 'zh-hans', 'zh-sg')),
	CONSTRAINT "attribute_value_localizations_source_locale_check" CHECK ("attribute_value_localizations"."source_locale" in ('ar', 'ar-ae', 'ar-eg', 'ar-ma', 'ar-sa', 'bn', 'bn-bd', 'bn-in', 'ca', 'ca-es', 'de', 'de-at', 'de-ch', 'de-de', 'en', 'en-ca', 'en-gb', 'en-us', 'es', 'es-ar', 'es-es', 'es-mx', 'fr', 'fr-be', 'fr-ca', 'fr-ch', 'fr-fr', 'hi', 'hi-in', 'ja', 'ja-jp', 'pt', 'pt-br', 'pt-pt', 'ru', 'ru-ru', 'zh', 'zh-cn', 'zh-hans', 'zh-sg')),
	CONSTRAINT "attribute_value_localizations_status_check" CHECK ("attribute_value_localizations"."status" in ('missing', 'machine_translated', 'reviewed', 'approved', 'stale', 'deprecated')),
	CONSTRAINT "attribute_value_localizations_provenance_check" CHECK ("attribute_value_localizations"."provenance" in ('mercaria', 'official_brand', 'professional', 'community_reviewed', 'machine', 'imported_source')),
	CONSTRAINT "attribute_value_localizations_locale_not_base_check" CHECK ("attribute_value_localizations"."locale" <> 'en'),
	CONSTRAINT "attribute_value_localizations_missing_text_check" CHECK (("attribute_value_localizations"."status" = 'missing') = ("attribute_value_localizations"."label" is null)),
	CONSTRAINT "attribute_value_localizations_text_not_blank_check" CHECK ("attribute_value_localizations"."label" is null or btrim("attribute_value_localizations"."label") <> ''),
	CONSTRAINT "attribute_value_localizations_machine_status_check" CHECK ("attribute_value_localizations"."provenance" <> 'machine' or "attribute_value_localizations"."status" not in ('reviewed', 'approved')),
	CONSTRAINT "attribute_value_localizations_machine_reviewer_check" CHECK ("attribute_value_localizations"."provenance" <> 'machine' or ("attribute_value_localizations"."reviewed_by_oxy_user_id" is null and "attribute_value_localizations"."reviewed_at" is null)),
	CONSTRAINT "attribute_value_localizations_reviewer_pair_check" CHECK (("attribute_value_localizations"."reviewed_by_oxy_user_id" is null) = ("attribute_value_localizations"."reviewed_at" is null)),
	CONSTRAINT "attribute_value_localizations_reviewed_audit_check" CHECK ("attribute_value_localizations"."status" not in ('reviewed', 'approved') or "attribute_value_localizations"."reviewed_by_oxy_user_id" is not null)
);
--> statement-breakpoint
CREATE TABLE "category_localizations" (
	"id" text PRIMARY KEY NOT NULL,
	"category_id" text NOT NULL,
	"locale" text NOT NULL,
	"status" text NOT NULL,
	"provenance" text NOT NULL,
	"source_locale" text,
	"source_revision" text,
	"reviewed_by_oxy_user_id" text,
	"reviewed_at" timestamp with time zone,
	"name" text,
	"description" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "category_localizations_locale_check" CHECK ("category_localizations"."locale" in ('ar', 'ar-ae', 'ar-eg', 'ar-ma', 'ar-sa', 'bn', 'bn-bd', 'bn-in', 'ca', 'ca-es', 'de', 'de-at', 'de-ch', 'de-de', 'en', 'en-ca', 'en-gb', 'en-us', 'es', 'es-ar', 'es-es', 'es-mx', 'fr', 'fr-be', 'fr-ca', 'fr-ch', 'fr-fr', 'hi', 'hi-in', 'ja', 'ja-jp', 'pt', 'pt-br', 'pt-pt', 'ru', 'ru-ru', 'zh', 'zh-cn', 'zh-hans', 'zh-sg')),
	CONSTRAINT "category_localizations_source_locale_check" CHECK ("category_localizations"."source_locale" in ('ar', 'ar-ae', 'ar-eg', 'ar-ma', 'ar-sa', 'bn', 'bn-bd', 'bn-in', 'ca', 'ca-es', 'de', 'de-at', 'de-ch', 'de-de', 'en', 'en-ca', 'en-gb', 'en-us', 'es', 'es-ar', 'es-es', 'es-mx', 'fr', 'fr-be', 'fr-ca', 'fr-ch', 'fr-fr', 'hi', 'hi-in', 'ja', 'ja-jp', 'pt', 'pt-br', 'pt-pt', 'ru', 'ru-ru', 'zh', 'zh-cn', 'zh-hans', 'zh-sg')),
	CONSTRAINT "category_localizations_status_check" CHECK ("category_localizations"."status" in ('missing', 'machine_translated', 'reviewed', 'approved', 'stale', 'deprecated')),
	CONSTRAINT "category_localizations_provenance_check" CHECK ("category_localizations"."provenance" in ('mercaria', 'official_brand', 'professional', 'community_reviewed', 'machine', 'imported_source')),
	CONSTRAINT "category_localizations_locale_not_base_check" CHECK ("category_localizations"."locale" <> 'en'),
	CONSTRAINT "category_localizations_missing_text_check" CHECK (("category_localizations"."status" = 'missing') = ("category_localizations"."name" is null)),
	CONSTRAINT "category_localizations_text_not_blank_check" CHECK ("category_localizations"."name" is null or btrim("category_localizations"."name") <> ''),
	CONSTRAINT "category_localizations_machine_status_check" CHECK ("category_localizations"."provenance" <> 'machine' or "category_localizations"."status" not in ('reviewed', 'approved')),
	CONSTRAINT "category_localizations_machine_reviewer_check" CHECK ("category_localizations"."provenance" <> 'machine' or ("category_localizations"."reviewed_by_oxy_user_id" is null and "category_localizations"."reviewed_at" is null)),
	CONSTRAINT "category_localizations_reviewer_pair_check" CHECK (("category_localizations"."reviewed_by_oxy_user_id" is null) = ("category_localizations"."reviewed_at" is null)),
	CONSTRAINT "category_localizations_reviewed_audit_check" CHECK ("category_localizations"."status" not in ('reviewed', 'approved') or "category_localizations"."reviewed_by_oxy_user_id" is not null)
);
--> statement-breakpoint
CREATE TABLE "category_localized_slugs" (
	"id" text PRIMARY KEY NOT NULL,
	"category_id" text NOT NULL,
	"locale" text NOT NULL,
	"slug" text NOT NULL,
	"provenance" text NOT NULL,
	"issued_by_oxy_user_id" text,
	"superseded_at" timestamp with time zone,
	"superseded_by_slug_id" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "category_localized_slugs_locale_check" CHECK ("category_localized_slugs"."locale" in ('ar', 'ar-ae', 'ar-eg', 'ar-ma', 'ar-sa', 'bn', 'bn-bd', 'bn-in', 'ca', 'ca-es', 'de', 'de-at', 'de-ch', 'de-de', 'en', 'en-ca', 'en-gb', 'en-us', 'es', 'es-ar', 'es-es', 'es-mx', 'fr', 'fr-be', 'fr-ca', 'fr-ch', 'fr-fr', 'hi', 'hi-in', 'ja', 'ja-jp', 'pt', 'pt-br', 'pt-pt', 'ru', 'ru-ru', 'zh', 'zh-cn', 'zh-hans', 'zh-sg')),
	CONSTRAINT "category_localized_slugs_provenance_check" CHECK ("category_localized_slugs"."provenance" in ('mercaria', 'official_brand', 'professional', 'community_reviewed', 'machine', 'imported_source')),
	CONSTRAINT "category_localized_slugs_locale_not_base_check" CHECK ("category_localized_slugs"."locale" <> 'en'),
	CONSTRAINT "category_localized_slugs_shape_check" CHECK ("category_localized_slugs"."slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
	CONSTRAINT "category_localized_slugs_supersede_check" CHECK ("category_localized_slugs"."superseded_by_slug_id" is null or "category_localized_slugs"."superseded_at" is not null),
	CONSTRAINT "category_localized_slugs_self_supersede_check" CHECK ("category_localized_slugs"."superseded_by_slug_id" is null or "category_localized_slugs"."superseded_by_slug_id" <> "category_localized_slugs"."id")
);
--> statement-breakpoint
CREATE TABLE "product_type_localizations" (
	"id" text PRIMARY KEY NOT NULL,
	"product_type_definition_id" text NOT NULL,
	"locale" text NOT NULL,
	"status" text NOT NULL,
	"provenance" text NOT NULL,
	"source_locale" text,
	"source_revision" text,
	"reviewed_by_oxy_user_id" text,
	"reviewed_at" timestamp with time zone,
	"name" text,
	"description" text,
	"help_text" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "product_type_localizations_locale_check" CHECK ("product_type_localizations"."locale" in ('ar', 'ar-ae', 'ar-eg', 'ar-ma', 'ar-sa', 'bn', 'bn-bd', 'bn-in', 'ca', 'ca-es', 'de', 'de-at', 'de-ch', 'de-de', 'en', 'en-ca', 'en-gb', 'en-us', 'es', 'es-ar', 'es-es', 'es-mx', 'fr', 'fr-be', 'fr-ca', 'fr-ch', 'fr-fr', 'hi', 'hi-in', 'ja', 'ja-jp', 'pt', 'pt-br', 'pt-pt', 'ru', 'ru-ru', 'zh', 'zh-cn', 'zh-hans', 'zh-sg')),
	CONSTRAINT "product_type_localizations_source_locale_check" CHECK ("product_type_localizations"."source_locale" in ('ar', 'ar-ae', 'ar-eg', 'ar-ma', 'ar-sa', 'bn', 'bn-bd', 'bn-in', 'ca', 'ca-es', 'de', 'de-at', 'de-ch', 'de-de', 'en', 'en-ca', 'en-gb', 'en-us', 'es', 'es-ar', 'es-es', 'es-mx', 'fr', 'fr-be', 'fr-ca', 'fr-ch', 'fr-fr', 'hi', 'hi-in', 'ja', 'ja-jp', 'pt', 'pt-br', 'pt-pt', 'ru', 'ru-ru', 'zh', 'zh-cn', 'zh-hans', 'zh-sg')),
	CONSTRAINT "product_type_localizations_status_check" CHECK ("product_type_localizations"."status" in ('missing', 'machine_translated', 'reviewed', 'approved', 'stale', 'deprecated')),
	CONSTRAINT "product_type_localizations_provenance_check" CHECK ("product_type_localizations"."provenance" in ('mercaria', 'official_brand', 'professional', 'community_reviewed', 'machine', 'imported_source')),
	CONSTRAINT "product_type_localizations_locale_not_base_check" CHECK ("product_type_localizations"."locale" <> 'en'),
	CONSTRAINT "product_type_localizations_missing_text_check" CHECK (("product_type_localizations"."status" = 'missing') = ("product_type_localizations"."name" is null)),
	CONSTRAINT "product_type_localizations_text_not_blank_check" CHECK ("product_type_localizations"."name" is null or btrim("product_type_localizations"."name") <> ''),
	CONSTRAINT "product_type_localizations_machine_status_check" CHECK ("product_type_localizations"."provenance" <> 'machine' or "product_type_localizations"."status" not in ('reviewed', 'approved')),
	CONSTRAINT "product_type_localizations_machine_reviewer_check" CHECK ("product_type_localizations"."provenance" <> 'machine' or ("product_type_localizations"."reviewed_by_oxy_user_id" is null and "product_type_localizations"."reviewed_at" is null)),
	CONSTRAINT "product_type_localizations_reviewer_pair_check" CHECK (("product_type_localizations"."reviewed_by_oxy_user_id" is null) = ("product_type_localizations"."reviewed_at" is null)),
	CONSTRAINT "product_type_localizations_reviewed_audit_check" CHECK ("product_type_localizations"."status" not in ('reviewed', 'approved') or "product_type_localizations"."reviewed_by_oxy_user_id" is not null)
);
--> statement-breakpoint
ALTER TABLE "attribute_value_localizations" ADD CONSTRAINT "attribute_value_localizations_attribute_enum_value_id_attribute_enum_values_id_fk" FOREIGN KEY ("attribute_enum_value_id") REFERENCES "public"."attribute_enum_values"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "category_localizations" ADD CONSTRAINT "category_localizations_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "category_localized_slugs" ADD CONSTRAINT "category_localized_slugs_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "category_localized_slugs" ADD CONSTRAINT "category_localized_slugs_superseded_by_slug_id_category_localized_slugs_id_fk" FOREIGN KEY ("superseded_by_slug_id") REFERENCES "public"."category_localized_slugs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_type_localizations" ADD CONSTRAINT "product_type_localizations_product_type_definition_id_product_type_definitions_id_fk" FOREIGN KEY ("product_type_definition_id") REFERENCES "public"."product_type_definitions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "attribute_value_localizations_locale_key" ON "attribute_value_localizations" USING btree ("attribute_enum_value_id","locale");--> statement-breakpoint
CREATE UNIQUE INDEX "category_localizations_locale_key" ON "category_localizations" USING btree ("category_id","locale");--> statement-breakpoint
CREATE UNIQUE INDEX "category_localized_slugs_locale_slug_key" ON "category_localized_slugs" USING btree ("locale","slug");--> statement-breakpoint
CREATE UNIQUE INDEX "category_localized_slugs_current_key" ON "category_localized_slugs" USING btree ("category_id","locale") WHERE "category_localized_slugs"."superseded_at" is null;--> statement-breakpoint
CREATE INDEX "category_localized_slugs_category_idx" ON "category_localized_slugs" USING btree ("category_id","locale");--> statement-breakpoint
CREATE UNIQUE INDEX "product_type_localizations_locale_key" ON "product_type_localizations" USING btree ("product_type_definition_id","locale");

-- oxy:handwritten-begin=mercaria_localization_machine_write_guard
CREATE OR REPLACE FUNCTION mercaria_localization_machine_write_guard()
RETURNS trigger AS $$
BEGIN
  IF NEW.provenance = 'machine' AND OLD.status IN ('reviewed', 'approved') THEN
    RAISE EXCEPTION
      'Machine translation may not replace % text on %.% (locale %). A machine suggestion is refused here, never stored over human work.',
      OLD.status, TG_TABLE_SCHEMA, TG_TABLE_NAME, OLD.locale;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER mercaria_category_localizations_machine_guard
  BEFORE UPDATE ON "category_localizations"
  FOR EACH ROW EXECUTE FUNCTION mercaria_localization_machine_write_guard();--> statement-breakpoint
CREATE TRIGGER mercaria_product_type_localizations_machine_guard
  BEFORE UPDATE ON "product_type_localizations"
  FOR EACH ROW EXECUTE FUNCTION mercaria_localization_machine_write_guard();--> statement-breakpoint
CREATE TRIGGER mercaria_attribute_value_localizations_machine_guard
  BEFORE UPDATE ON "attribute_value_localizations"
  FOR EACH ROW EXECUTE FUNCTION mercaria_localization_machine_write_guard();--> statement-breakpoint
-- oxy:handwritten-end=mercaria_localization_machine_write_guard

-- ── D4 rule 2: a source-semantics change marks dependents `stale` ───────────
--
-- It does NOT blank them. A stale translation is still the best text available,
-- and withdrawing it would show raw keys to shoppers — which is the failure the
-- whole family exists to prevent.
--
-- `missing` and `deprecated` are excluded from the rewrite: one has nothing to
-- make stale and the other is text somebody withdrew, so restating either as
-- `stale` would turn a source edit into a status a reviewer has to undo.
--
-- AFTER UPDATE with a `WHEN` clause rather than a BEFORE trigger comparing
-- columns in its body: the comparison is the cheapest possible filter and it is
-- evaluated by the executor, and nothing here needs to change the source row.
-- The house rule about a BEFORE trigger and a STORED GENERATED column does not
-- arise — `categories.name` is an ordinary column.
-- oxy:handwritten-begin=mercaria_categories_localization_stale
CREATE OR REPLACE FUNCTION mercaria_categories_localization_stale()
RETURNS trigger AS $$
BEGIN
  UPDATE "category_localizations"
     SET status = 'stale',
         updated_at = date_trunc('milliseconds', now())
   WHERE category_id = NEW.id
     AND status IN ('machine_translated', 'reviewed', 'approved');
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER mercaria_categories_localization_stale
  AFTER UPDATE ON "categories"
  FOR EACH ROW
  WHEN (OLD.name IS DISTINCT FROM NEW.name)
  EXECUTE FUNCTION mercaria_categories_localization_stale();--> statement-breakpoint
-- oxy:handwritten-end=mercaria_categories_localization_stale

-- The same rule for #94's controlled values, and it watches TWO columns for two
-- different reasons. `value` is the canonical normalized string every
-- assignment stores, so a change to it is a change of meaning; `label` is the
-- base-locale text every translation was made FROM, so a change to it is a
-- change of source. Either one leaves the translations describing something
-- else.
-- oxy:handwritten-begin=mercaria_attribute_enum_values_localization_stale
CREATE OR REPLACE FUNCTION mercaria_attribute_enum_values_localization_stale()
RETURNS trigger AS $$
BEGIN
  UPDATE "attribute_value_localizations"
     SET status = 'stale',
         updated_at = date_trunc('milliseconds', now())
   WHERE attribute_enum_value_id = NEW.id
     AND status IN ('machine_translated', 'reviewed', 'approved');
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER mercaria_attribute_enum_values_localization_stale
  AFTER UPDATE ON "attribute_enum_values"
  FOR EACH ROW
  WHEN (OLD.label IS DISTINCT FROM NEW.label OR OLD.value IS DISTINCT FROM NEW.value)
  EXECUTE FUNCTION mercaria_attribute_enum_values_localization_stale();--> statement-breakpoint
-- oxy:handwritten-end=mercaria_attribute_enum_values_localization_stale

-- ── A localized slug is issued once and retired, never edited ───────────────
--
-- The identity of the row — which category, which locale, which URL — is frozen;
-- only the retirement columns move. That is what makes "a slug change is a new
-- row plus a redirect, never an UPDATE that breaks a shared link" a property of
-- the table rather than of whoever wrote the update, and it is what makes
-- reviving a category's own retired slug (clearing `superseded_at`) the one
-- permitted mutation.
-- oxy:handwritten-begin=mercaria_category_localized_slug_frozen
CREATE OR REPLACE FUNCTION mercaria_category_localized_slug_frozen()
RETURNS trigger AS $$
BEGIN
  IF NEW.category_id IS DISTINCT FROM OLD.category_id
     OR NEW.locale IS DISTINCT FROM OLD.locale
     OR NEW.slug IS DISTINCT FROM OLD.slug THEN
    RAISE EXCEPTION
      'A localized slug is frozen: category, locale and slug may not change. Issue a NEW slug and let this row be superseded, so every link that carries it still resolves.';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER mercaria_category_localized_slug_frozen
  BEFORE UPDATE ON "category_localized_slugs"
  FOR EACH ROW EXECUTE FUNCTION mercaria_category_localized_slug_frozen();
-- oxy:handwritten-end=mercaria_category_localized_slug_frozen
