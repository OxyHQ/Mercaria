-- oxy:deploy-phase=pre
--
-- Canonical product and family localization (#367 Translation model L2).
--
-- Two new tables, their indexes, their machine-write guards, their stale
-- triggers and their revision triggers — plus a re-render of three CHECKs on
-- `catalog_localization_revisions`.
--
-- ## Why `pre` when it contains DROP CONSTRAINT
--
-- The three drops are a re-render, not a removal. `catalog_localization_revisions`'
-- `entity_kind`, `field_key` and `field_pair` CHECKs are rendered from
-- `LOCALIZED_ENTITY_KINDS`, `LOCALIZED_FIELD_KEYS` and
-- `LOCALIZATION_REVISION_FIELD_PAIRS`, and this change WIDENS all three. Each
-- pair drops the old CHECK and adds one admitting a strict SUPERSET, in one
-- transaction, so the previously serving image writes nothing the new CHECK
-- refuses. Verified rather than assumed: entity kinds 4 -> 6 and field keys
-- 10 -> 14, with `comm` showing no member of either old tuple absent from the
-- new one.
--
-- It is also REQUIRED here rather than deferrable: the revision triggers below
-- insert `entity_kind = 'canonical_product'`, which the pre-existing CHECK
-- refuses. Splitting the widening into a later migration would make every
-- canonical localization write fail from the moment these tables exist.
--
-- ## Everything below the generated statements is hand written
--
-- drizzle-kit models none of it. On a REGENERATION, re-apply the anchored
-- blocks (`oxy:handwritten-begin`/`-end`) verbatim and confirm all six function
-- and trigger pairs are present.
--
-- **Append with an explicit newline between the generated body and the first
-- hand-written line.** The generated file ends WITHOUT a trailing newline, so a
-- plain concatenation joins the last generated statement to the first appended
-- one. Measured on #682: it duplicated a `CREATE INDEX`, generated cleanly, read
-- correctly, and failed only at APPLY time with `relation ... already exists`.
--
-- ## Why the merge plan had to land in THIS migration
--
-- `MERGE_REHOMING_PLAN` is EXECUTED, not merely censused — the merge runner
-- issues real SQL against the entry the census forces you to write. Landing the
-- plan entry before these tables exist produces 17 failures across four files
-- whose single cause is `relation "canonical_product_localizations" does not
-- exist`. The pending-SQL convention does not cover it: that convention is for
-- SQL the gates only READ, and anything the runtime EXECUTES against is on the
-- other side of that boundary.
CREATE TABLE "canonical_product_family_localizations" (
	"id" text PRIMARY KEY NOT NULL,
	"canonical_product_family_id" text NOT NULL,
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
	CONSTRAINT "canonical_product_family_localizations_locale_check" CHECK ("canonical_product_family_localizations"."locale" in ('ar', 'ar-ae', 'ar-eg', 'ar-ma', 'ar-sa', 'bn', 'bn-bd', 'bn-in', 'ca', 'ca-es', 'de', 'de-at', 'de-ch', 'de-de', 'en', 'en-ca', 'en-gb', 'en-us', 'es', 'es-ar', 'es-es', 'es-mx', 'fr', 'fr-be', 'fr-ca', 'fr-ch', 'fr-fr', 'hi', 'hi-in', 'ja', 'ja-jp', 'pt', 'pt-br', 'pt-pt', 'ru', 'ru-ru', 'zh', 'zh-cn', 'zh-hans', 'zh-sg')),
	CONSTRAINT "canonical_product_family_localizations_locale_not_base_check" CHECK ("canonical_product_family_localizations"."locale" <> 'en'),
	CONSTRAINT "canonical_product_family_localizations_status_check" CHECK ("canonical_product_family_localizations"."status" in ('missing', 'machine_translated', 'reviewed', 'approved', 'stale', 'deprecated')),
	CONSTRAINT "canonical_product_family_localizations_provenance_check" CHECK ("canonical_product_family_localizations"."provenance" in ('mercaria', 'official_brand', 'professional', 'community_reviewed', 'machine', 'imported_source')),
	CONSTRAINT "canonical_product_family_localizations_source_locale_check" CHECK ("canonical_product_family_localizations"."source_locale" in ('ar', 'ar-ae', 'ar-eg', 'ar-ma', 'ar-sa', 'bn', 'bn-bd', 'bn-in', 'ca', 'ca-es', 'de', 'de-at', 'de-ch', 'de-de', 'en', 'en-ca', 'en-gb', 'en-us', 'es', 'es-ar', 'es-es', 'es-mx', 'fr', 'fr-be', 'fr-ca', 'fr-ch', 'fr-fr', 'hi', 'hi-in', 'ja', 'ja-jp', 'pt', 'pt-br', 'pt-pt', 'ru', 'ru-ru', 'zh', 'zh-cn', 'zh-hans', 'zh-sg')),
	CONSTRAINT "canonical_product_family_localizations_missing_text_check" CHECK (("canonical_product_family_localizations"."status" = 'missing') = ("canonical_product_family_localizations"."name" is null)),
	CONSTRAINT "canonical_product_family_localizations_text_not_blank_check" CHECK ("canonical_product_family_localizations"."name" is null or btrim("canonical_product_family_localizations"."name") <> ''),
	CONSTRAINT "canonical_product_family_localizations_machine_status_check" CHECK ("canonical_product_family_localizations"."provenance" <> 'machine' or "canonical_product_family_localizations"."status" not in ('reviewed', 'approved')),
	CONSTRAINT "canonical_product_family_localizations_machine_reviewer_check" CHECK ("canonical_product_family_localizations"."provenance" <> 'machine' or ("canonical_product_family_localizations"."reviewed_by_oxy_user_id" is null and "canonical_product_family_localizations"."reviewed_at" is null)),
	CONSTRAINT "canonical_product_family_localizations_reviewer_pair_check" CHECK (("canonical_product_family_localizations"."reviewed_by_oxy_user_id" is null) = ("canonical_product_family_localizations"."reviewed_at" is null)),
	CONSTRAINT "canonical_product_family_localizations_reviewed_audit_check" CHECK ("canonical_product_family_localizations"."status" not in ('reviewed', 'approved') or "canonical_product_family_localizations"."reviewed_by_oxy_user_id" is not null)
);
--> statement-breakpoint
CREATE TABLE "canonical_product_localizations" (
	"id" text PRIMARY KEY NOT NULL,
	"canonical_product_id" text NOT NULL,
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
	CONSTRAINT "canonical_product_localizations_locale_check" CHECK ("canonical_product_localizations"."locale" in ('ar', 'ar-ae', 'ar-eg', 'ar-ma', 'ar-sa', 'bn', 'bn-bd', 'bn-in', 'ca', 'ca-es', 'de', 'de-at', 'de-ch', 'de-de', 'en', 'en-ca', 'en-gb', 'en-us', 'es', 'es-ar', 'es-es', 'es-mx', 'fr', 'fr-be', 'fr-ca', 'fr-ch', 'fr-fr', 'hi', 'hi-in', 'ja', 'ja-jp', 'pt', 'pt-br', 'pt-pt', 'ru', 'ru-ru', 'zh', 'zh-cn', 'zh-hans', 'zh-sg')),
	CONSTRAINT "canonical_product_localizations_locale_not_base_check" CHECK ("canonical_product_localizations"."locale" <> 'en'),
	CONSTRAINT "canonical_product_localizations_status_check" CHECK ("canonical_product_localizations"."status" in ('missing', 'machine_translated', 'reviewed', 'approved', 'stale', 'deprecated')),
	CONSTRAINT "canonical_product_localizations_provenance_check" CHECK ("canonical_product_localizations"."provenance" in ('mercaria', 'official_brand', 'professional', 'community_reviewed', 'machine', 'imported_source')),
	CONSTRAINT "canonical_product_localizations_source_locale_check" CHECK ("canonical_product_localizations"."source_locale" in ('ar', 'ar-ae', 'ar-eg', 'ar-ma', 'ar-sa', 'bn', 'bn-bd', 'bn-in', 'ca', 'ca-es', 'de', 'de-at', 'de-ch', 'de-de', 'en', 'en-ca', 'en-gb', 'en-us', 'es', 'es-ar', 'es-es', 'es-mx', 'fr', 'fr-be', 'fr-ca', 'fr-ch', 'fr-fr', 'hi', 'hi-in', 'ja', 'ja-jp', 'pt', 'pt-br', 'pt-pt', 'ru', 'ru-ru', 'zh', 'zh-cn', 'zh-hans', 'zh-sg')),
	CONSTRAINT "canonical_product_localizations_missing_text_check" CHECK (("canonical_product_localizations"."status" = 'missing') = ("canonical_product_localizations"."name" is null)),
	CONSTRAINT "canonical_product_localizations_text_not_blank_check" CHECK ("canonical_product_localizations"."name" is null or btrim("canonical_product_localizations"."name") <> ''),
	CONSTRAINT "canonical_product_localizations_machine_status_check" CHECK ("canonical_product_localizations"."provenance" <> 'machine' or "canonical_product_localizations"."status" not in ('reviewed', 'approved')),
	CONSTRAINT "canonical_product_localizations_machine_reviewer_check" CHECK ("canonical_product_localizations"."provenance" <> 'machine' or ("canonical_product_localizations"."reviewed_by_oxy_user_id" is null and "canonical_product_localizations"."reviewed_at" is null)),
	CONSTRAINT "canonical_product_localizations_reviewer_pair_check" CHECK (("canonical_product_localizations"."reviewed_by_oxy_user_id" is null) = ("canonical_product_localizations"."reviewed_at" is null)),
	CONSTRAINT "canonical_product_localizations_reviewed_audit_check" CHECK ("canonical_product_localizations"."status" not in ('reviewed', 'approved') or "canonical_product_localizations"."reviewed_by_oxy_user_id" is not null)
);
--> statement-breakpoint
ALTER TABLE "catalog_localization_revisions" DROP CONSTRAINT "catalog_localization_revisions_entity_kind_check";--> statement-breakpoint
ALTER TABLE "catalog_localization_revisions" DROP CONSTRAINT "catalog_localization_revisions_field_key_check";--> statement-breakpoint
ALTER TABLE "catalog_localization_revisions" DROP CONSTRAINT "catalog_localization_revisions_field_pair_check";--> statement-breakpoint
ALTER TABLE "canonical_product_family_localizations" ADD CONSTRAINT "canonical_product_family_localizations_canonical_product_family_id_canonical_product_families_id_fk" FOREIGN KEY ("canonical_product_family_id") REFERENCES "public"."canonical_product_families"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canonical_product_localizations" ADD CONSTRAINT "canonical_product_localizations_canonical_product_id_canonical_products_id_fk" FOREIGN KEY ("canonical_product_id") REFERENCES "public"."canonical_products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "canonical_product_family_localizations_locale_key" ON "canonical_product_family_localizations" USING btree ("canonical_product_family_id","locale");--> statement-breakpoint
CREATE INDEX "canonical_product_family_localizations_locale_status_idx" ON "canonical_product_family_localizations" USING btree ("locale","status");--> statement-breakpoint
CREATE UNIQUE INDEX "canonical_product_localizations_locale_key" ON "canonical_product_localizations" USING btree ("canonical_product_id","locale");--> statement-breakpoint
CREATE INDEX "canonical_product_localizations_locale_status_idx" ON "canonical_product_localizations" USING btree ("locale","status");--> statement-breakpoint
ALTER TABLE "catalog_localization_revisions" ADD CONSTRAINT "catalog_localization_revisions_entity_kind_check" CHECK ("catalog_localization_revisions"."entity_kind" in ('category', 'product_type', 'product_type_field', 'attribute_value', 'canonical_product', 'canonical_product_family'));--> statement-breakpoint
ALTER TABLE "catalog_localization_revisions" ADD CONSTRAINT "catalog_localization_revisions_field_key_check" CHECK ("catalog_localization_revisions"."field_key" in ('category.name', 'category.description', 'product_type.name', 'product_type.description', 'product_type.help_text', 'product_type_field.label', 'product_type_field.help_text', 'product_type_field.placeholder', 'product_type_field.example', 'canonical_product.name', 'canonical_product.description', 'canonical_product_family.name', 'canonical_product_family.description', 'attribute_value.label'));--> statement-breakpoint
ALTER TABLE "catalog_localization_revisions" ADD CONSTRAINT "catalog_localization_revisions_field_pair_check" CHECK ("catalog_localization_revisions"."entity_kind" || '|' || "catalog_localization_revisions"."field_key" in ('category|category.name', 'category|category.description', 'product_type|product_type.name', 'product_type|product_type.description', 'product_type|product_type.help_text', 'product_type_field|product_type_field.label', 'product_type_field|product_type_field.help_text', 'product_type_field|product_type_field.placeholder', 'product_type_field|product_type_field.example', 'canonical_product|canonical_product.name', 'canonical_product|canonical_product.description', 'canonical_product_family|canonical_product_family.name', 'canonical_product_family|canonical_product_family.description', 'attribute_value|attribute_value.label'));
-- ── The machine-write guard, extended to the two new members ───────────────
--
-- `mercaria_localization_machine_write_guard()` already exists (migration 0091)
-- and is rendered from `HUMAN_SETTLED_LOCALIZATION_STATUSES`. It is reused
-- rather than redefined: a second function body would be a second answer to
-- "may a machine overwrite human-settled text", and the two could drift.
--
-- `catalog-localization.test.ts` derives the guarded population from
-- `CATALOG_LOCALIZATION_TEXT_TABLES` rather than a hand list, so these two
-- tables joined that population the moment they joined the tuple — which is why
-- this block is here rather than being remembered.
-- oxy:handwritten-begin=mercaria_canonical_localization_machine_guards
CREATE TRIGGER mercaria_canonical_product_localizations_machine_guard
  BEFORE UPDATE ON "canonical_product_localizations"
  FOR EACH ROW EXECUTE FUNCTION mercaria_localization_machine_write_guard();--> statement-breakpoint
CREATE TRIGGER mercaria_canonical_product_family_localizations_machine_guard
  BEFORE UPDATE ON "canonical_product_family_localizations"
  FOR EACH ROW EXECUTE FUNCTION mercaria_localization_machine_write_guard();--> statement-breakpoint
-- oxy:handwritten-end=mercaria_canonical_localization_machine_guards

-- ── D4 rule 2: a source-semantics change marks dependents `stale` ───────────
--
-- Both triggers watch `name` AND `description`, and that is deliberate. The
-- category trigger (`mercaria_categories_localization_stale`) watches `name`
-- ALONE, which is the blind spot the translation desk has had to publish as a
-- caveat ever since: an edit to `categories.description` — a registered
-- localized field — marks nothing stale. These two do not repeat it.
--
-- `LOCALIZATION_STALENESS_DETECTIONS` claims exactly these two trigger names and
-- exactly these watched columns, and `catalog-localization-desk.test.ts` reads
-- this SQL back and asserts both directions: every claimed watched column
-- appears in the WHEN clause, and every claimed blind spot does not. So the
-- descriptor and the trigger cannot drift apart.
-- oxy:handwritten-begin=mercaria_canonical_products_localization_stale
CREATE OR REPLACE FUNCTION mercaria_canonical_products_localization_stale()
RETURNS trigger AS $$
BEGIN
  UPDATE "canonical_product_localizations"
     SET status = 'stale',
         updated_at = date_trunc('milliseconds', now())
   WHERE canonical_product_id = NEW.id
     AND status IN ('machine_translated', 'reviewed', 'approved');
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER mercaria_canonical_products_localization_stale
  AFTER UPDATE ON "canonical_products"
  FOR EACH ROW
  WHEN (OLD.name IS DISTINCT FROM NEW.name
        OR OLD.description IS DISTINCT FROM NEW.description)
  EXECUTE FUNCTION mercaria_canonical_products_localization_stale();--> statement-breakpoint
-- oxy:handwritten-end=mercaria_canonical_products_localization_stale

-- oxy:handwritten-begin=mercaria_canonical_product_families_localization_stale
CREATE OR REPLACE FUNCTION mercaria_canonical_product_families_localization_stale()
RETURNS trigger AS $$
BEGIN
  UPDATE "canonical_product_family_localizations"
     SET status = 'stale',
         updated_at = date_trunc('milliseconds', now())
   WHERE canonical_product_family_id = NEW.id
     AND status IN ('machine_translated', 'reviewed', 'approved');
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER mercaria_canonical_product_families_localization_stale
  AFTER UPDATE ON "canonical_product_families"
  FOR EACH ROW
  WHEN (OLD.name IS DISTINCT FROM NEW.name
        OR OLD.description IS DISTINCT FROM NEW.description)
  EXECUTE FUNCTION mercaria_canonical_product_families_localization_stale();--> statement-breakpoint
-- oxy:handwritten-end=mercaria_canonical_product_families_localization_stale

-- ── The revision trail must cover these tables, or rollback lies ────────────
--
-- Not optional consistency. `revisionRepository.liveTargetFor` now returns these
-- two tables, so `rollbackLocalizationField` will UPDATE one of them — and if no
-- trigger writes a revision for that UPDATE, the function finds no written row
-- and reports `undefined`, which its contract defines as "the rollback would
-- change nothing". A rollback that DID change the live text while reporting that
-- it changed nothing is the worst answer this domain can give, and it would be
-- produced by omitting these two blocks.
-- oxy:handwritten-begin=mercaria_canonical_product_localization_revision
CREATE OR REPLACE FUNCTION mercaria_canonical_product_localization_revision()
RETURNS trigger AS $$
DECLARE
  v_rollback text := nullif(current_setting('mercaria.localization_rollback_of', true), '');
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO "catalog_localization_revisions"
      ("id", "action", "entity_kind", "entity_id", "locale", "field_key", "value",
       "status", "provenance", "credited_oxy_user_id", "rollback_of_revision_id")
    SELECT gen_random_uuid()::text, 'create', 'canonical_product', NEW.canonical_product_id,
           NEW.locale, f.k, f.v, NEW.status, NEW.provenance, NEW.reviewed_by_oxy_user_id, NULL
      FROM (VALUES ('canonical_product.name', NEW.name),
                   ('canonical_product.description', NEW.description)) AS f(k, v);
  ELSE
    INSERT INTO "catalog_localization_revisions"
      ("id", "action", "entity_kind", "entity_id", "locale", "field_key", "value",
       "status", "provenance", "credited_oxy_user_id", "rollback_of_revision_id")
    SELECT gen_random_uuid()::text,
           CASE WHEN v_rollback IS NULL THEN 'update' ELSE 'rollback' END,
           'canonical_product', NEW.canonical_product_id, NEW.locale, f.k, f.v,
           NEW.status, NEW.provenance, NEW.reviewed_by_oxy_user_id, v_rollback
      FROM (VALUES ('canonical_product.name', NEW.name, OLD.name),
                   ('canonical_product.description', NEW.description, OLD.description)) AS f(k, v, o)
     WHERE f.v IS DISTINCT FROM f.o
        OR NEW.status IS DISTINCT FROM OLD.status
        OR NEW.provenance IS DISTINCT FROM OLD.provenance;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER mercaria_canonical_product_localization_revision
  AFTER INSERT OR UPDATE ON "canonical_product_localizations"
  FOR EACH ROW EXECUTE FUNCTION mercaria_canonical_product_localization_revision();--> statement-breakpoint
-- oxy:handwritten-end=mercaria_canonical_product_localization_revision

-- oxy:handwritten-begin=mercaria_canonical_product_family_localization_revision
CREATE OR REPLACE FUNCTION mercaria_canonical_product_family_localization_revision()
RETURNS trigger AS $$
DECLARE
  v_rollback text := nullif(current_setting('mercaria.localization_rollback_of', true), '');
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO "catalog_localization_revisions"
      ("id", "action", "entity_kind", "entity_id", "locale", "field_key", "value",
       "status", "provenance", "credited_oxy_user_id", "rollback_of_revision_id")
    SELECT gen_random_uuid()::text, 'create', 'canonical_product_family',
           NEW.canonical_product_family_id, NEW.locale, f.k, f.v, NEW.status, NEW.provenance,
           NEW.reviewed_by_oxy_user_id, NULL
      FROM (VALUES ('canonical_product_family.name', NEW.name),
                   ('canonical_product_family.description', NEW.description)) AS f(k, v);
  ELSE
    INSERT INTO "catalog_localization_revisions"
      ("id", "action", "entity_kind", "entity_id", "locale", "field_key", "value",
       "status", "provenance", "credited_oxy_user_id", "rollback_of_revision_id")
    SELECT gen_random_uuid()::text,
           CASE WHEN v_rollback IS NULL THEN 'update' ELSE 'rollback' END,
           'canonical_product_family', NEW.canonical_product_family_id, NEW.locale, f.k, f.v,
           NEW.status, NEW.provenance, NEW.reviewed_by_oxy_user_id, v_rollback
      FROM (VALUES ('canonical_product_family.name', NEW.name, OLD.name),
                   ('canonical_product_family.description', NEW.description, OLD.description))
             AS f(k, v, o)
     WHERE f.v IS DISTINCT FROM f.o
        OR NEW.status IS DISTINCT FROM OLD.status
        OR NEW.provenance IS DISTINCT FROM OLD.provenance;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER mercaria_canonical_product_family_localization_revision
  AFTER INSERT OR UPDATE ON "canonical_product_family_localizations"
  FOR EACH ROW EXECUTE FUNCTION mercaria_canonical_product_family_localization_revision();
-- oxy:handwritten-end=mercaria_canonical_product_family_localization_revision
