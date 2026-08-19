-- PENDING SQL for #367 Translation model L2 — canonical product and family
-- localization.
--
-- This file is NOT a migration and is applied by nothing. It exists because the
-- migration slot is held by another lane, and because the localization gates
-- read it: `catalog-localization.test.ts`'s `allSqlFiles()` includes this path
-- precisely so the hand-written trigger bodies can be reviewed and gated BEFORE
-- the slot is granted. `catalogExternalMappings.pending.sql` is a live sibling
-- using the same convention.
--
-- WHEN THE SLOT IS GRANTED: run `bun run build:shared-types` then
-- `bun run --cwd packages/backend db:generate`, append every block below to the
-- generated `.sql` VERBATIM (with an explicit newline between the generated body
-- and the first block — the generated file ends without a trailing newline, and
-- concatenating onto it joins the last statement to the first appended line),
-- add the `-- oxy:deploy-phase=pre` marker, then DELETE this file. Verify by
-- applying the whole chain against a real database and reading the triggers back
-- out of `pg_trigger` by name — a static check cannot tell a trigger that exists
-- from one that was dropped by the regeneration.
--
-- Phase is `pre`: two new tables and their triggers, all additive. The triggers
-- only ADD rows on writes the previously serving image already performs.

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
CREATE TRIGGER mercaria_canonical_product_localizations_machine_guard
  BEFORE UPDATE ON "canonical_product_localizations"
  FOR EACH ROW EXECUTE FUNCTION mercaria_localization_machine_write_guard();--> statement-breakpoint
CREATE TRIGGER mercaria_canonical_product_family_localizations_machine_guard
  BEFORE UPDATE ON "canonical_product_family_localizations"
  FOR EACH ROW EXECUTE FUNCTION mercaria_localization_machine_write_guard();--> statement-breakpoint

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
$$ LANGUAGE plpgsql;
-- oxy:handwritten-end=mercaria_canonical_product_family_localization_revision
