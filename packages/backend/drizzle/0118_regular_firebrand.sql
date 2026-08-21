-- oxy:deploy-phase=pre
-- oxy:rollback=derived
--
-- The translation revision trail (#367 merge-order step 10, box 4).
--
-- Additive: one new table, its indexes, its append-only guard and four writer
-- triggers. The previously serving image performs no write these break — the
-- triggers only ADD rows on writes it already performs.
--
-- ## On a REGENERATION
--
-- Everything below the `ALTER TABLE`/`CREATE INDEX` lines is hand written and
-- drizzle-kit cannot model any of it. Re-apply the anchored blocks
-- (`oxy:handwritten-begin`/`-end`) verbatim and confirm all FIVE function and
-- trigger pairs are present — a regeneration that silently drops them leaves a
-- table that applies cleanly and records nothing, which is indistinguishable
-- from a catalogue nobody has edited.
--
-- Measured on this file's own regeneration behind #660: the five blocks and the
-- deploy-phase marker were dropped and had to be re-applied, while the
-- self-referencing foreign key WAS emitted. Verify that FK against this
-- generated SQL rather than against the declaration — drizzle-kit has silently
-- dropped a circular one before (the Awin case), and a declaration that
-- type-checks while enforcing nothing is the failure shape.
--
-- Re-applying the blocks is also where this file broke once, and the way it
-- broke is worth stating: the generated body ends WITHOUT a trailing newline, so
-- concatenating the hand-written section onto it joined the last `CREATE INDEX`
-- to the first re-applied line and silently duplicated that index. It failed at
-- APPLY time with `relation ... already exists`, not at generation. Re-append
-- with an explicit newline between the two halves, and re-run the migrator
-- against a real database rather than trusting the file to look right.
CREATE TABLE "catalog_localization_revisions" (
	"id" text PRIMARY KEY NOT NULL,
	"action" text NOT NULL,
	"entity_kind" text NOT NULL,
	"entity_id" text NOT NULL,
	"locale" text NOT NULL,
	"field_key" text NOT NULL,
	"value" text,
	"status" text NOT NULL,
	"provenance" text NOT NULL,
	"credited_oxy_user_id" text,
	"rollback_of_revision_id" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "catalog_localization_revisions_action_check" CHECK ("catalog_localization_revisions"."action" in ('create', 'update', 'rollback')),
	CONSTRAINT "catalog_localization_revisions_entity_kind_check" CHECK ("catalog_localization_revisions"."entity_kind" in ('category', 'product_type', 'product_type_field', 'attribute_value')),
	CONSTRAINT "catalog_localization_revisions_locale_check" CHECK ("catalog_localization_revisions"."locale" in ('ar', 'ar-ae', 'ar-eg', 'ar-ma', 'ar-sa', 'bn', 'bn-bd', 'bn-in', 'ca', 'ca-es', 'de', 'de-at', 'de-ch', 'de-de', 'en', 'en-ca', 'en-gb', 'en-us', 'es', 'es-ar', 'es-es', 'es-mx', 'fr', 'fr-be', 'fr-ca', 'fr-ch', 'fr-fr', 'hi', 'hi-in', 'ja', 'ja-jp', 'pt', 'pt-br', 'pt-pt', 'ru', 'ru-ru', 'zh', 'zh-cn', 'zh-hans', 'zh-sg')),
	CONSTRAINT "catalog_localization_revisions_field_key_check" CHECK ("catalog_localization_revisions"."field_key" in ('category.name', 'category.description', 'product_type.name', 'product_type.description', 'product_type.help_text', 'product_type_field.label', 'product_type_field.help_text', 'product_type_field.placeholder', 'product_type_field.example', 'attribute_value.label')),
	CONSTRAINT "catalog_localization_revisions_status_check" CHECK ("catalog_localization_revisions"."status" in ('missing', 'machine_translated', 'reviewed', 'approved', 'stale', 'deprecated')),
	CONSTRAINT "catalog_localization_revisions_provenance_check" CHECK ("catalog_localization_revisions"."provenance" in ('mercaria', 'official_brand', 'professional', 'community_reviewed', 'machine', 'imported_source')),
	CONSTRAINT "catalog_localization_revisions_entity_id_check" CHECK (btrim("catalog_localization_revisions"."entity_id") <> ''),
	CONSTRAINT "catalog_localization_revisions_locale_not_base_check" CHECK ("catalog_localization_revisions"."locale" <> 'en'),
	CONSTRAINT "catalog_localization_revisions_field_pair_check" CHECK ("catalog_localization_revisions"."entity_kind" || '|' || "catalog_localization_revisions"."field_key" in ('category|category.name', 'category|category.description', 'product_type|product_type.name', 'product_type|product_type.description', 'product_type|product_type.help_text', 'product_type_field|product_type_field.label', 'product_type_field|product_type_field.help_text', 'product_type_field|product_type_field.placeholder', 'product_type_field|product_type_field.example', 'attribute_value|attribute_value.label')),
	CONSTRAINT "catalog_localization_revisions_rollback_shape_check" CHECK (("catalog_localization_revisions"."action" = 'rollback') = ("catalog_localization_revisions"."rollback_of_revision_id" is not null)),
	CONSTRAINT "catalog_localization_revisions_rollback_self_check" CHECK ("catalog_localization_revisions"."rollback_of_revision_id" is null or "catalog_localization_revisions"."rollback_of_revision_id" <> "catalog_localization_revisions"."id"),
	CONSTRAINT "catalog_localization_revisions_machine_credit_check" CHECK ("catalog_localization_revisions"."provenance" <> 'machine' or "catalog_localization_revisions"."credited_oxy_user_id" is null)
);
--> statement-breakpoint
ALTER TABLE "catalog_localization_revisions" ADD CONSTRAINT "catalog_localization_revisions_rollback_of_revision_id_catalog_localization_revisions_id_fk" FOREIGN KEY ("rollback_of_revision_id") REFERENCES "public"."catalog_localization_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "catalog_localization_revisions_field_idx" ON "catalog_localization_revisions" USING btree ("entity_kind","entity_id","locale","field_key","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "catalog_localization_revisions_locale_idx" ON "catalog_localization_revisions" USING btree ("locale","created_at" DESC NULLS LAST);
-- ── The trail is append-only, against UPDATE *and* DELETE ──────────────────
--
-- `catalog_revisions`' posture and NOT `analytics_events`'. Analytics permits
-- DELETE because erasure on a schedule IS its policy, and a trigger refusing it
-- would make retention fail silently. Nothing sweeps this table: a translation
-- revision carries no personal data — the only account id on it is the reviewer
-- the row already credits publicly — so there is no retention deadline for a
-- DELETE to serve, and a revision that could be deleted would let the record of
-- a wording disappear along with the reason somebody changed it.
--
-- If a retention sweep is ever introduced here, permit DELETE deliberately and
-- say why, rather than leaving the sweep to fail against this guard.
-- oxy:handwritten-begin=mercaria_catalog_localization_revision_append_only
CREATE OR REPLACE FUNCTION mercaria_catalog_localization_revision_append_only()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION
    'catalog_localization_revisions is append-only: % on %.% is refused. The trail is what a translator and a reviewer are accountable to; a row that can be rewritten is not a record. An earlier wording is restored by a ROLLBACK revision, never by editing this one.',
    TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER catalog_localization_revisions_append_only
  BEFORE UPDATE OR DELETE ON "catalog_localization_revisions"
  FOR EACH ROW EXECUTE FUNCTION mercaria_catalog_localization_revision_append_only();--> statement-breakpoint
-- oxy:handwritten-end=mercaria_catalog_localization_revision_append_only

-- ── The four writers ───────────────────────────────────────────────────────
--
-- One `AFTER INSERT OR UPDATE` trigger per text table, and these are the ONLY
-- writers of the trail. A history written by a repository records what the
-- service did and misses a backfill script, an operator at a `psql` prompt and
-- the stale triggers this same migration chain already installs — and every gap
-- is invisible, because a missing revision looks exactly like a field nobody
-- edited.
--
-- ONE ROW PER FIELD. A save that changes a name and a description writes two,
-- which is what makes a per-field diff a `lag()` over one partition.
--
-- A field is recorded when its VALUE changed, or when the row's `status` or
-- `provenance` did — a translation going `stale` under an unchanged sentence is
-- part of that sentence's history, and it is the transition a reviewer most
-- needs to see. On INSERT every registered field is written, to establish the
-- baseline a later diff is read against.
--
-- Only REGISTERED fields are recorded: the trail's `field_key` CHECK admits
-- exactly `LOCALIZED_FIELD_KEYS`, so `attribute_value_localizations.description`
-- — a real column with no entry in the field registry — has no history here. It
-- gains one in the commit that registers it, with no change to these triggers
-- beyond the `VALUES` list.
--
-- `current_setting('mercaria.localization_rollback_of', true)` is how a rollback
-- names what it undoes without a second writer. The service `set local`s it
-- before its UPDATE; `true` makes the read return NULL when unset, and `set
-- local` means the value dies with the transaction rather than leaking onto the
-- next statement a pooled connection serves.
--
-- `gen_random_uuid()::text` for the id — the `listing_condition_revisions`
-- backfill's precedent. These ids are ordered by `created_at` in every read, so
-- nothing depends on the uuid v7 monotonicity `generatedId()` supplies.

-- oxy:handwritten-begin=mercaria_category_localization_revision
CREATE OR REPLACE FUNCTION mercaria_category_localization_revision()
RETURNS trigger AS $$
DECLARE
  v_rollback text := nullif(current_setting('mercaria.localization_rollback_of', true), '');
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO "catalog_localization_revisions"
      ("id", "action", "entity_kind", "entity_id", "locale", "field_key", "value",
       "status", "provenance", "credited_oxy_user_id", "rollback_of_revision_id")
    SELECT gen_random_uuid()::text, 'create', 'category', NEW.category_id, NEW.locale,
           f.k, f.v, NEW.status, NEW.provenance, NEW.reviewed_by_oxy_user_id, NULL
      FROM (VALUES ('category.name', NEW.name),
                   ('category.description', NEW.description)) AS f(k, v);
  ELSE
    INSERT INTO "catalog_localization_revisions"
      ("id", "action", "entity_kind", "entity_id", "locale", "field_key", "value",
       "status", "provenance", "credited_oxy_user_id", "rollback_of_revision_id")
    SELECT gen_random_uuid()::text,
           CASE WHEN v_rollback IS NULL THEN 'update' ELSE 'rollback' END,
           'category', NEW.category_id, NEW.locale, f.k, f.v, NEW.status, NEW.provenance,
           NEW.reviewed_by_oxy_user_id, v_rollback
      FROM (VALUES ('category.name', NEW.name, OLD.name),
                   ('category.description', NEW.description, OLD.description)) AS f(k, v, o)
     WHERE f.v IS DISTINCT FROM f.o
        OR NEW.status IS DISTINCT FROM OLD.status
        OR NEW.provenance IS DISTINCT FROM OLD.provenance;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER mercaria_category_localization_revision
  AFTER INSERT OR UPDATE ON "category_localizations"
  FOR EACH ROW EXECUTE FUNCTION mercaria_category_localization_revision();--> statement-breakpoint
-- oxy:handwritten-end=mercaria_category_localization_revision

-- oxy:handwritten-begin=mercaria_product_type_localization_revision
CREATE OR REPLACE FUNCTION mercaria_product_type_localization_revision()
RETURNS trigger AS $$
DECLARE
  v_rollback text := nullif(current_setting('mercaria.localization_rollback_of', true), '');
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO "catalog_localization_revisions"
      ("id", "action", "entity_kind", "entity_id", "locale", "field_key", "value",
       "status", "provenance", "credited_oxy_user_id", "rollback_of_revision_id")
    SELECT gen_random_uuid()::text, 'create', 'product_type', NEW.product_type_definition_id,
           NEW.locale, f.k, f.v, NEW.status, NEW.provenance, NEW.reviewed_by_oxy_user_id, NULL
      FROM (VALUES ('product_type.name', NEW.name),
                   ('product_type.description', NEW.description),
                   ('product_type.help_text', NEW.help_text)) AS f(k, v);
  ELSE
    INSERT INTO "catalog_localization_revisions"
      ("id", "action", "entity_kind", "entity_id", "locale", "field_key", "value",
       "status", "provenance", "credited_oxy_user_id", "rollback_of_revision_id")
    SELECT gen_random_uuid()::text,
           CASE WHEN v_rollback IS NULL THEN 'update' ELSE 'rollback' END,
           'product_type', NEW.product_type_definition_id, NEW.locale, f.k, f.v,
           NEW.status, NEW.provenance, NEW.reviewed_by_oxy_user_id, v_rollback
      FROM (VALUES ('product_type.name', NEW.name, OLD.name),
                   ('product_type.description', NEW.description, OLD.description),
                   ('product_type.help_text', NEW.help_text, OLD.help_text)) AS f(k, v, o)
     WHERE f.v IS DISTINCT FROM f.o
        OR NEW.status IS DISTINCT FROM OLD.status
        OR NEW.provenance IS DISTINCT FROM OLD.provenance;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER mercaria_product_type_localization_revision
  AFTER INSERT OR UPDATE ON "product_type_localizations"
  FOR EACH ROW EXECUTE FUNCTION mercaria_product_type_localization_revision();--> statement-breakpoint
-- oxy:handwritten-end=mercaria_product_type_localization_revision

-- oxy:handwritten-begin=mercaria_product_type_field_localization_revision
CREATE OR REPLACE FUNCTION mercaria_product_type_field_localization_revision()
RETURNS trigger AS $$
DECLARE
  v_rollback text := nullif(current_setting('mercaria.localization_rollback_of', true), '');
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO "catalog_localization_revisions"
      ("id", "action", "entity_kind", "entity_id", "locale", "field_key", "value",
       "status", "provenance", "credited_oxy_user_id", "rollback_of_revision_id")
    SELECT gen_random_uuid()::text, 'create', 'product_type_field', NEW.product_type_field_id,
           NEW.locale, f.k, f.v, NEW.status, NEW.provenance, NEW.reviewed_by_oxy_user_id, NULL
      FROM (VALUES ('product_type_field.label', NEW.label),
                   ('product_type_field.help_text', NEW.help_text),
                   ('product_type_field.placeholder', NEW.placeholder),
                   ('product_type_field.example', NEW.example)) AS f(k, v);
  ELSE
    INSERT INTO "catalog_localization_revisions"
      ("id", "action", "entity_kind", "entity_id", "locale", "field_key", "value",
       "status", "provenance", "credited_oxy_user_id", "rollback_of_revision_id")
    SELECT gen_random_uuid()::text,
           CASE WHEN v_rollback IS NULL THEN 'update' ELSE 'rollback' END,
           'product_type_field', NEW.product_type_field_id, NEW.locale, f.k, f.v,
           NEW.status, NEW.provenance, NEW.reviewed_by_oxy_user_id, v_rollback
      FROM (VALUES ('product_type_field.label', NEW.label, OLD.label),
                   ('product_type_field.help_text', NEW.help_text, OLD.help_text),
                   ('product_type_field.placeholder', NEW.placeholder, OLD.placeholder),
                   ('product_type_field.example', NEW.example, OLD.example)) AS f(k, v, o)
     WHERE f.v IS DISTINCT FROM f.o
        OR NEW.status IS DISTINCT FROM OLD.status
        OR NEW.provenance IS DISTINCT FROM OLD.provenance;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER mercaria_product_type_field_localization_revision
  AFTER INSERT OR UPDATE ON "product_type_field_localizations"
  FOR EACH ROW EXECUTE FUNCTION mercaria_product_type_field_localization_revision();--> statement-breakpoint
-- oxy:handwritten-end=mercaria_product_type_field_localization_revision

-- `attribute_value_localizations.description` is deliberately NOT recorded: it
-- is a real column with no entry in the field registry, and the trail's
-- `field_key` CHECK admits only registered fields. Adding it here without
-- registering it would be refused by the constraint, which is the correct order
-- of operations.
-- oxy:handwritten-begin=mercaria_attribute_value_localization_revision
CREATE OR REPLACE FUNCTION mercaria_attribute_value_localization_revision()
RETURNS trigger AS $$
DECLARE
  v_rollback text := nullif(current_setting('mercaria.localization_rollback_of', true), '');
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO "catalog_localization_revisions"
      ("id", "action", "entity_kind", "entity_id", "locale", "field_key", "value",
       "status", "provenance", "credited_oxy_user_id", "rollback_of_revision_id")
    SELECT gen_random_uuid()::text, 'create', 'attribute_value', NEW.attribute_enum_value_id,
           NEW.locale, f.k, f.v, NEW.status, NEW.provenance, NEW.reviewed_by_oxy_user_id, NULL
      FROM (VALUES ('attribute_value.label', NEW.label)) AS f(k, v);
  ELSE
    INSERT INTO "catalog_localization_revisions"
      ("id", "action", "entity_kind", "entity_id", "locale", "field_key", "value",
       "status", "provenance", "credited_oxy_user_id", "rollback_of_revision_id")
    SELECT gen_random_uuid()::text,
           CASE WHEN v_rollback IS NULL THEN 'update' ELSE 'rollback' END,
           'attribute_value', NEW.attribute_enum_value_id, NEW.locale, f.k, f.v,
           NEW.status, NEW.provenance, NEW.reviewed_by_oxy_user_id, v_rollback
      FROM (VALUES ('attribute_value.label', NEW.label, OLD.label)) AS f(k, v, o)
     WHERE f.v IS DISTINCT FROM f.o
        OR NEW.status IS DISTINCT FROM OLD.status
        OR NEW.provenance IS DISTINCT FROM OLD.provenance;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER mercaria_attribute_value_localization_revision
  AFTER INSERT OR UPDATE ON "attribute_value_localizations"
  FOR EACH ROW EXECUTE FUNCTION mercaria_attribute_value_localization_revision();
-- oxy:handwritten-end=mercaria_attribute_value_localization_revision
