-- oxy:deploy-phase=pre
--
-- Native listing localization (#367 Translation model, ADR 0007 D6/D7).
--
-- One new table, its FK, its two indexes, its machine-write guard, its stale
-- trigger and its revision trigger — plus a re-render of three CHECKs on
-- `catalog_localization_revisions`.
--
-- ## Why `pre` when it contains DROP CONSTRAINT
--
-- The three drops are a RE-RENDER, not a removal. `entity_kind`, `field_key`
-- and `field_pair` are rendered from `LOCALIZED_ENTITY_KINDS`,
-- `LOCALIZED_FIELD_KEYS` and `LOCALIZATION_REVISION_FIELD_PAIRS`, and this
-- change WIDENS all three. Each pair drops the old CHECK and adds one admitting
-- a strict SUPERSET, in one transaction, so the previously serving image writes
-- nothing the new CHECK refuses.
--
-- Verified rather than assumed, by diffing the rendered member lists against
-- their previous render in `0122_panoramic_marvex.sql`: entity kinds 7 -> 8
-- (+`listing`), field keys 16 -> 18 (+`listing.title`, +`listing.description`),
-- field pairs likewise, and NOTHING present in an old tuple is absent from the
-- new one.
--
-- It is also REQUIRED here rather than deferrable: the revision trigger below
-- inserts `entity_kind = 'listing'`, which the pre-existing CHECK refuses.
-- Splitting the widening into a later migration would make every listing
-- localization write fail from the moment this table exists.
--
-- ## Everything below the generated statements is hand written
--
-- drizzle-kit models none of it. On a REGENERATION, re-apply the anchored
-- blocks (`oxy:handwritten-begin`/`-end`) verbatim and confirm all three
-- function/trigger pairs are present.
--
-- **The `-- oxy:deploy-phase=` marker on line 1 goes with them.** drizzle-kit
-- emits none, so a regeneration strips it whatever the file contains, and
-- `migrate.ts` refuses an unmarked file at DEPLOY time rather than in CI
-- (AGENTS.md, #799). Measured on this file's own renumber from 0128: the
-- regenerated body came back with zero markers. Count it after re-applying and
-- confirm the count is exactly 1.
--
-- **Append with an explicit newline between the generated body and the first
-- hand-written line.** The generated file ends WITHOUT a trailing newline, so a
-- plain concatenation joins the last generated statement to the first appended
-- one. Measured on #682: it duplicated a `CREATE INDEX`, generated cleanly, read
-- correctly, and failed only at APPLY time with `relation ... already exists`.
CREATE TABLE "listing_localizations" (
	"id" text PRIMARY KEY NOT NULL,
	"listing_id" text NOT NULL,
	"locale" text NOT NULL,
	"status" text NOT NULL,
	"provenance" text NOT NULL,
	"source_locale" text,
	"source_revision" text,
	"reviewed_by_oxy_user_id" text,
	"reviewed_at" timestamp with time zone,
	"title" text,
	"description" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "listing_localizations_locale_check" CHECK ("listing_localizations"."locale" in ('ar', 'ar-ae', 'ar-eg', 'ar-ma', 'ar-sa', 'bn', 'bn-bd', 'bn-in', 'ca', 'ca-es', 'de', 'de-at', 'de-ch', 'de-de', 'en', 'en-ca', 'en-gb', 'en-us', 'es', 'es-ar', 'es-es', 'es-mx', 'fr', 'fr-be', 'fr-ca', 'fr-ch', 'fr-fr', 'hi', 'hi-in', 'ja', 'ja-jp', 'pt', 'pt-br', 'pt-pt', 'ru', 'ru-ru', 'zh', 'zh-cn', 'zh-hans', 'zh-sg')),
	CONSTRAINT "listing_localizations_locale_not_base_check" CHECK ("listing_localizations"."locale" <> 'en'),
	CONSTRAINT "listing_localizations_status_check" CHECK ("listing_localizations"."status" in ('missing', 'machine_translated', 'reviewed', 'approved', 'stale', 'deprecated')),
	CONSTRAINT "listing_localizations_provenance_check" CHECK ("listing_localizations"."provenance" in ('mercaria', 'official_brand', 'professional', 'community_reviewed', 'machine', 'imported_source')),
	CONSTRAINT "listing_localizations_source_locale_check" CHECK ("listing_localizations"."source_locale" in ('ar', 'ar-ae', 'ar-eg', 'ar-ma', 'ar-sa', 'bn', 'bn-bd', 'bn-in', 'ca', 'ca-es', 'de', 'de-at', 'de-ch', 'de-de', 'en', 'en-ca', 'en-gb', 'en-us', 'es', 'es-ar', 'es-es', 'es-mx', 'fr', 'fr-be', 'fr-ca', 'fr-ch', 'fr-fr', 'hi', 'hi-in', 'ja', 'ja-jp', 'pt', 'pt-br', 'pt-pt', 'ru', 'ru-ru', 'zh', 'zh-cn', 'zh-hans', 'zh-sg')),
	CONSTRAINT "listing_localizations_missing_text_check" CHECK (("listing_localizations"."status" = 'missing') = ("listing_localizations"."title" is null)),
	CONSTRAINT "listing_localizations_text_not_blank_check" CHECK ("listing_localizations"."title" is null or btrim("listing_localizations"."title") <> ''),
	CONSTRAINT "listing_localizations_machine_status_check" CHECK ("listing_localizations"."provenance" <> 'machine' or "listing_localizations"."status" not in ('reviewed', 'approved')),
	CONSTRAINT "listing_localizations_machine_reviewer_check" CHECK ("listing_localizations"."provenance" <> 'machine' or ("listing_localizations"."reviewed_by_oxy_user_id" is null and "listing_localizations"."reviewed_at" is null)),
	CONSTRAINT "listing_localizations_reviewer_pair_check" CHECK (("listing_localizations"."reviewed_by_oxy_user_id" is null) = ("listing_localizations"."reviewed_at" is null)),
	CONSTRAINT "listing_localizations_reviewed_audit_check" CHECK ("listing_localizations"."status" not in ('reviewed', 'approved') or "listing_localizations"."reviewed_by_oxy_user_id" is not null)
);
--> statement-breakpoint
ALTER TABLE "catalog_localization_revisions" DROP CONSTRAINT "catalog_localization_revisions_entity_kind_check";--> statement-breakpoint
ALTER TABLE "catalog_localization_revisions" DROP CONSTRAINT "catalog_localization_revisions_field_key_check";--> statement-breakpoint
ALTER TABLE "catalog_localization_revisions" DROP CONSTRAINT "catalog_localization_revisions_field_pair_check";--> statement-breakpoint
ALTER TABLE "listing_localizations" ADD CONSTRAINT "listing_localizations_listing_id_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."listings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "listing_localizations_locale_key" ON "listing_localizations" USING btree ("listing_id","locale");--> statement-breakpoint
CREATE INDEX "listing_localizations_locale_status_idx" ON "listing_localizations" USING btree ("locale","status");--> statement-breakpoint
ALTER TABLE "catalog_localization_revisions" ADD CONSTRAINT "catalog_localization_revisions_entity_kind_check" CHECK ("catalog_localization_revisions"."entity_kind" in ('category', 'product_type', 'product_type_field', 'attribute_value', 'canonical_product', 'canonical_product_family', 'attribute_definition', 'listing'));--> statement-breakpoint
ALTER TABLE "catalog_localization_revisions" ADD CONSTRAINT "catalog_localization_revisions_field_key_check" CHECK ("catalog_localization_revisions"."field_key" in ('category.name', 'category.description', 'product_type.name', 'product_type.description', 'product_type.help_text', 'product_type_field.label', 'product_type_field.help_text', 'product_type_field.placeholder', 'product_type_field.example', 'canonical_product.name', 'canonical_product.description', 'canonical_product_family.name', 'canonical_product_family.description', 'attribute_value.label', 'attribute_definition.label', 'attribute_definition.description', 'listing.title', 'listing.description'));--> statement-breakpoint
ALTER TABLE "catalog_localization_revisions" ADD CONSTRAINT "catalog_localization_revisions_field_pair_check" CHECK ("catalog_localization_revisions"."entity_kind" || '|' || "catalog_localization_revisions"."field_key" in ('category|category.name', 'category|category.description', 'product_type|product_type.name', 'product_type|product_type.description', 'product_type|product_type.help_text', 'product_type_field|product_type_field.label', 'product_type_field|product_type_field.help_text', 'product_type_field|product_type_field.placeholder', 'product_type_field|product_type_field.example', 'canonical_product|canonical_product.name', 'canonical_product|canonical_product.description', 'canonical_product_family|canonical_product_family.name', 'canonical_product_family|canonical_product_family.description', 'attribute_value|attribute_value.label', 'attribute_definition|attribute_definition.label', 'attribute_definition|attribute_definition.description', 'listing|listing.title', 'listing|listing.description'));
-- ── The machine-write guard, extended to the new member ──────────────────
--
-- `mercaria_localization_machine_write_guard()` already exists (migration 0091)
-- and is rendered from `HUMAN_SETTLED_LOCALIZATION_STATUSES`. It is REUSED by
-- attachment rather than redefined: a second body would be a second answer to
-- "may a machine overwrite human-settled text", and on a from-zero apply the
-- later copy would win and silently revert any correction made to the first.
-- `catalog-localization.test.ts` tells a definition from a mention and would
-- fail on a redeclaration here.
--
-- The guard's population is DERIVED from `CATALOG_LOCALIZATION_TEXT_TABLES`, so
-- this table joined it the moment it joined that tuple — which is why this block
-- is here rather than being remembered.
-- oxy:handwritten-begin=mercaria_listing_localizations_machine_guard
CREATE TRIGGER mercaria_listing_localizations_machine_guard
  BEFORE UPDATE ON "listing_localizations"
  FOR EACH ROW EXECUTE FUNCTION mercaria_localization_machine_write_guard();--> statement-breakpoint
-- oxy:handwritten-end=mercaria_listing_localizations_machine_guard

-- ── D4 rule 2: a source-semantics change marks dependents `stale` ─────────
--
-- Watches `title` AND `description`, and NOT the `name`-alone shape
-- `mercaria_categories_localization_stale` takes. That trigger's blind spot is
-- published as a caveat in `LOCALIZATION_STALENESS_DETECTIONS.unwatched`
-- precisely so it stops being inherited, and a listing DESCRIPTION is the field
-- a seller edits most — a translation of the old one is exactly the stale text a
-- shopper would act on.
--
-- `LOCALIZATION_STALENESS_DETECTIONS` claims this trigger name and these two
-- watched columns, and `catalog-localization-desk.test.ts` reads this SQL back
-- and asserts both directions: every claimed watched column appears in the WHEN
-- clause, and every claimed blind spot does not.
--
-- The WHEN clause is also what keeps this off the hot path. `listings` is
-- updated for stock, status, pins and moderation far more often than for text;
-- an archive (`status = 'archived'`, a soft delete on the same row) changes no
-- localized source column, so it marks NOTHING stale — which is correct, since
-- a restore puts the same row back with its translations still describing it.
-- oxy:handwritten-begin=mercaria_listings_localization_stale
CREATE OR REPLACE FUNCTION mercaria_listings_localization_stale()
RETURNS trigger AS $$
BEGIN
  UPDATE "listing_localizations"
     SET status = 'stale',
         updated_at = date_trunc('milliseconds', now())
   WHERE listing_id = NEW.id
     AND status IN ('machine_translated', 'reviewed', 'approved');
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER mercaria_listings_localization_stale
  AFTER UPDATE ON "listings"
  FOR EACH ROW
  WHEN (OLD.title IS DISTINCT FROM NEW.title
        OR OLD.description IS DISTINCT FROM NEW.description)
  EXECUTE FUNCTION mercaria_listings_localization_stale();--> statement-breakpoint
-- oxy:handwritten-end=mercaria_listings_localization_stale

-- ── The revision trail must cover this table, or rollback lies ───────────
--
-- Not optional consistency. `revisionRepository.liveTargetFor` now returns
-- `listing_localizations`, so `rollbackLocalizationField` will UPDATE it — and
-- if no trigger writes a revision for that UPDATE, the function finds no written
-- row and reports `undefined`, which its contract defines as "the rollback would
-- change nothing". A rollback that DID change the live text while reporting that
-- it changed nothing is the worst answer this domain can give.
-- oxy:handwritten-begin=mercaria_listing_localization_revision
CREATE OR REPLACE FUNCTION mercaria_listing_localization_revision()
RETURNS trigger AS $$
DECLARE
  v_rollback text := nullif(current_setting('mercaria.localization_rollback_of', true), '');
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO "catalog_localization_revisions"
      ("id", "action", "entity_kind", "entity_id", "locale", "field_key", "value",
       "status", "provenance", "credited_oxy_user_id", "rollback_of_revision_id")
    SELECT gen_random_uuid()::text, 'create', 'listing', NEW.listing_id,
           NEW.locale, f.k, f.v, NEW.status, NEW.provenance, NEW.reviewed_by_oxy_user_id, NULL
      FROM (VALUES ('listing.title', NEW.title),
                   ('listing.description', NEW.description)) AS f(k, v);
  ELSE
    INSERT INTO "catalog_localization_revisions"
      ("id", "action", "entity_kind", "entity_id", "locale", "field_key", "value",
       "status", "provenance", "credited_oxy_user_id", "rollback_of_revision_id")
    SELECT gen_random_uuid()::text,
           CASE WHEN v_rollback IS NULL THEN 'update' ELSE 'rollback' END,
           'listing', NEW.listing_id, NEW.locale, f.k, f.v,
           NEW.status, NEW.provenance, NEW.reviewed_by_oxy_user_id, v_rollback
      FROM (VALUES ('listing.title', NEW.title, OLD.title),
                   ('listing.description', NEW.description, OLD.description)) AS f(k, v, o)
     WHERE f.v IS DISTINCT FROM f.o
        OR NEW.status IS DISTINCT FROM OLD.status
        OR NEW.provenance IS DISTINCT FROM OLD.provenance;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER mercaria_listing_localization_revision
  AFTER INSERT OR UPDATE ON "listing_localizations"
  FOR EACH ROW EXECUTE FUNCTION mercaria_listing_localization_revision();
-- oxy:handwritten-end=mercaria_listing_localization_revision
