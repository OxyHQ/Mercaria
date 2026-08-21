-- oxy:deploy-phase=pre
-- oxy:rollback=accepted: attribute_labels.status and provenance are backfilled to 'stale' and 'mercaria' where NULL. Both columns were added by this migration, so nothing reads a pre-image and re-running reproduces the result exactly
--
-- `attribute_labels` joins the ADR 0007 D4 localization family (#94).
--
-- ## Why the generated shape could not be applied as generated
--
-- `db:generate` emitted `ADD COLUMN "status" text NOT NULL` with no DEFAULT.
-- PostgreSQL refuses that on a table that already holds rows, so the migration
-- would have aborted on any deployment with a single attribute label — which is
-- every deployment that has ever drafted an attribute. The three-step form below
-- (nullable, backfill, SET NOT NULL) is the same end state the snapshot records
-- and is the only one that can reach it.
--
-- The ORDER is load-bearing for the second reason too: every CHECK is added
-- AFTER the backfill, or `attribute_labels_reviewed_audit_check` fails on every
-- historical row the moment it is created. The #106 ruling, one table over.
--
-- ## What existing rows become, and why it is not a default
--
-- `status = 'stale'`, `provenance = 'mercaria'`, no reviewer.
--
-- The provenance is measured rather than assumed: `upsertAttributeLabel` has
-- exactly ONE non-test caller — `draftAttributeDefinition`, an operator
-- authoring through `/internal/catalog-attributes` — so every existing row is
-- Mercaria's own copy. `imported_source` means "a claim by somebody outside
-- Mercaria" and would be false in the other direction.
--
-- The status is what the vocabulary leaves once the lies are removed:
-- `reviewed`/`approved` are refused by `attribute_labels_reviewed_audit_check`
-- without a reviewer, and inventing one is a fabrication; `machine_translated`
-- is false; `missing` is unrepresentable beside a NOT NULL label; and `missing`
-- and `deprecated` are both OUTSIDE `SERVABLE_LOCALIZATION_STATUSES`, so either
-- would silently withdraw every localized attribute label the authoring schema
-- serves today — a data-loss-shaped outcome from a backfill.
--
-- `stale` is what remains and it is honest rather than merely surviving: no
-- reviewer, no provenance trail, still the best text available, and it does NOT
-- count in `HUMAN_SETTLED_LOCALIZATION_STATUSES`. That last part is the point of
-- the whole change — a locale must not read as complete on the back of rows
-- nobody reviewed.
--
-- ## What this migration deliberately does NOT add
--
-- `localizationLocaleChecks` — the narrowing of `locale` to `SUPPORTED_LOCALES`
-- and away from the base locale. A narrowing CHECK is validated against every
-- existing row when it is added, so on a populated table it can abort the
-- deploy on data nobody has looked at (measured on #632, where redefining a
-- generated expression aborted an index rebuild). It is owed, and it is one
-- counting query away:
--
--   select count(*) filter (where locale = 'en')            as base_locale_rows,
--          count(*) filter (where locale not in (…tuple…))  as unsupported_rows
--     from attribute_labels;
--
ALTER TABLE "attribute_labels" ADD COLUMN "status" text;--> statement-breakpoint
ALTER TABLE "attribute_labels" ADD COLUMN "provenance" text;--> statement-breakpoint
ALTER TABLE "attribute_labels" ADD COLUMN "source_locale" text;--> statement-breakpoint
ALTER TABLE "attribute_labels" ADD COLUMN "source_revision" text;--> statement-breakpoint
ALTER TABLE "attribute_labels" ADD COLUMN "reviewed_by_oxy_user_id" text;--> statement-breakpoint
ALTER TABLE "attribute_labels" ADD COLUMN "reviewed_at" timestamp with time zone;--> statement-breakpoint
UPDATE "attribute_labels" SET "status" = 'stale' WHERE "status" IS NULL;--> statement-breakpoint
UPDATE "attribute_labels" SET "provenance" = 'mercaria' WHERE "provenance" IS NULL;--> statement-breakpoint
ALTER TABLE "attribute_labels" ALTER COLUMN "status" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "attribute_labels" ALTER COLUMN "provenance" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "attribute_labels" ADD CONSTRAINT "attribute_labels_status_check" CHECK ("attribute_labels"."status" in ('missing', 'machine_translated', 'reviewed', 'approved', 'stale', 'deprecated'));--> statement-breakpoint
ALTER TABLE "attribute_labels" ADD CONSTRAINT "attribute_labels_provenance_check" CHECK ("attribute_labels"."provenance" in ('mercaria', 'official_brand', 'professional', 'community_reviewed', 'machine', 'imported_source'));--> statement-breakpoint
ALTER TABLE "attribute_labels" ADD CONSTRAINT "attribute_labels_source_locale_check" CHECK ("attribute_labels"."source_locale" in ('ar', 'ar-ae', 'ar-eg', 'ar-ma', 'ar-sa', 'bn', 'bn-bd', 'bn-in', 'ca', 'ca-es', 'de', 'de-at', 'de-ch', 'de-de', 'en', 'en-ca', 'en-gb', 'en-us', 'es', 'es-ar', 'es-es', 'es-mx', 'fr', 'fr-be', 'fr-ca', 'fr-ch', 'fr-fr', 'hi', 'hi-in', 'ja', 'ja-jp', 'pt', 'pt-br', 'pt-pt', 'ru', 'ru-ru', 'zh', 'zh-cn', 'zh-hans', 'zh-sg'));--> statement-breakpoint
ALTER TABLE "attribute_labels" ADD CONSTRAINT "attribute_labels_missing_text_check" CHECK (("attribute_labels"."status" = 'missing') = ("attribute_labels"."label" is null));--> statement-breakpoint
ALTER TABLE "attribute_labels" ADD CONSTRAINT "attribute_labels_text_not_blank_check" CHECK ("attribute_labels"."label" is null or btrim("attribute_labels"."label") <> '');--> statement-breakpoint
ALTER TABLE "attribute_labels" ADD CONSTRAINT "attribute_labels_machine_status_check" CHECK ("attribute_labels"."provenance" <> 'machine' or "attribute_labels"."status" not in ('reviewed', 'approved'));--> statement-breakpoint
ALTER TABLE "attribute_labels" ADD CONSTRAINT "attribute_labels_machine_reviewer_check" CHECK ("attribute_labels"."provenance" <> 'machine' or ("attribute_labels"."reviewed_by_oxy_user_id" is null and "attribute_labels"."reviewed_at" is null));--> statement-breakpoint
ALTER TABLE "attribute_labels" ADD CONSTRAINT "attribute_labels_reviewer_pair_check" CHECK (("attribute_labels"."reviewed_by_oxy_user_id" is null) = ("attribute_labels"."reviewed_at" is null));--> statement-breakpoint
ALTER TABLE "attribute_labels" ADD CONSTRAINT "attribute_labels_reviewed_audit_check" CHECK ("attribute_labels"."status" not in ('reviewed', 'approved') or "attribute_labels"."reviewed_by_oxy_user_id" is not null);--> statement-breakpoint

-- ── The machine-write guard, which this table could not execute before ───────
--
-- `mercaria_localization_machine_write_guard()` is created by 0091 and refuses
-- a machine write landing on `reviewed` or `approved` text. Four tables execute
-- it; `attribute_labels` could not, because the function reads `NEW.provenance`
-- and `OLD.status` and this table had neither column. So "prevent machine
-- translation from overwriting reviewed or approved human content" was FALSE
-- for this member, structurally rather than by oversight — the guard had
-- nothing to read.
--
-- The function is not redefined here. One body, five triggers.
-- oxy:handwritten-begin=mercaria_attribute_labels_machine_guard
CREATE TRIGGER mercaria_attribute_labels_machine_guard
  BEFORE UPDATE ON "attribute_labels"
  FOR EACH ROW EXECUTE FUNCTION mercaria_localization_machine_write_guard();
-- oxy:handwritten-end=mercaria_attribute_labels_machine_guard
--> statement-breakpoint

-- ── D4 rule 2: a source-semantics change marks dependents `stale` ────────────
--
-- The second of the two triggers the exemption promised. `attribute_labels`
-- rows are translations OF `attribute_definitions.label`, so an edit to that
-- label leaves every translation describing something else — and until now
-- nothing said so, exactly as nothing said so for categories before 0091.
--
-- It watches BOTH `label` and `description`, and that is a deliberate departure
-- from `mercaria_categories_localization_stale`, which watches `name` alone.
--
-- That sibling's `description` blind spot is real, is declared in
-- LOCALIZATION_STALENESS_DETECTIONS' `unwatched` list, and the completeness desk
-- has been publishing it as a caveat ever since. Copying the WHEN clause across
-- would have created a second one — which is how a blind spot becomes a family
-- trait. `attribute_labels` carries a `description` column and it translates
-- `attribute_definitions.description`, so an edit to the source description
-- leaves that translation describing something else exactly as a label edit
-- does. There is no reason for the two columns to be treated differently here.
--
-- `IS DISTINCT FROM` on both, so a NULL description becoming text (and the
-- reverse) counts as a change — `<>` would read either as no change at all.
--
-- `STALE_ON_SOURCE_CHANGE_STATUSES` verbatim: `missing` has nothing to make
-- stale and `deprecated` is text somebody withdrew, so rewriting either would
-- turn a source edit into a status a reviewer has to undo.
-- oxy:handwritten-begin=mercaria_attribute_definitions_localization_stale
CREATE OR REPLACE FUNCTION mercaria_attribute_definitions_localization_stale()
RETURNS trigger AS $$
BEGIN
  UPDATE "attribute_labels"
     SET status = 'stale',
         updated_at = date_trunc('milliseconds', now())
   WHERE attribute_definition_id = NEW.id
     AND status IN ('machine_translated', 'reviewed', 'approved');
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER mercaria_attribute_definitions_localization_stale
  AFTER UPDATE ON "attribute_definitions"
  FOR EACH ROW
  WHEN (OLD.label IS DISTINCT FROM NEW.label
        OR OLD.description IS DISTINCT FROM NEW.description)
  EXECUTE FUNCTION mercaria_attribute_definitions_localization_stale();
-- oxy:handwritten-end=mercaria_attribute_definitions_localization_stale
