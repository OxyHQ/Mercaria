-- oxy:deploy-phase=pre
-- oxy:rollback=restore: the three catalog_localization_revisions CHECKs are widened again; the previous forms are in 0120 and re-adding any of them fails against a stored revision using the added vocabulary
--
-- `attribute_definition` becomes a localized entity kind (#94, #367).
--
-- ## Why `pre` when the first three statements are DROPs
--
-- They drop three CHECKs and re-add them WIDER. Every re-added tuple retains
-- every member it had and adds `attribute_definition` beside them, so the
-- serving image — which writes none of the new values — is unaffected by the
-- change, and both halves run in one transaction so there is no window where
-- the constraint is absent. A `post` marker is for a statement that BREAKS a
-- write the previous image performs; nothing here does.
--
-- Verified against the emitted SQL rather than assumed, because the failure mode
-- runs the other way: drizzle-kit renders these tuples from the BUILT
-- `@mercaria/shared-types`, so a `dist/` predating a rebase emits the same three
-- DROP/ADD pairs NARROWING a sibling's tuple back, in a diff that looks entirely
-- plausible. `bun run build:shared-types` was run immediately before generating
-- (exit 0) and all three ADDs were read for the members they retain.
--
ALTER TABLE "catalog_localization_revisions" DROP CONSTRAINT "catalog_localization_revisions_entity_kind_check";--> statement-breakpoint
ALTER TABLE "catalog_localization_revisions" DROP CONSTRAINT "catalog_localization_revisions_field_key_check";--> statement-breakpoint
ALTER TABLE "catalog_localization_revisions" DROP CONSTRAINT "catalog_localization_revisions_field_pair_check";--> statement-breakpoint
ALTER TABLE "catalog_localization_revisions" ADD CONSTRAINT "catalog_localization_revisions_entity_kind_check" CHECK ("catalog_localization_revisions"."entity_kind" in ('category', 'product_type', 'product_type_field', 'attribute_value', 'canonical_product', 'canonical_product_family', 'attribute_definition'));--> statement-breakpoint
ALTER TABLE "catalog_localization_revisions" ADD CONSTRAINT "catalog_localization_revisions_field_key_check" CHECK ("catalog_localization_revisions"."field_key" in ('category.name', 'category.description', 'product_type.name', 'product_type.description', 'product_type.help_text', 'product_type_field.label', 'product_type_field.help_text', 'product_type_field.placeholder', 'product_type_field.example', 'canonical_product.name', 'canonical_product.description', 'canonical_product_family.name', 'canonical_product_family.description', 'attribute_value.label', 'attribute_definition.label', 'attribute_definition.description'));--> statement-breakpoint
ALTER TABLE "catalog_localization_revisions" ADD CONSTRAINT "catalog_localization_revisions_field_pair_check" CHECK ("catalog_localization_revisions"."entity_kind" || '|' || "catalog_localization_revisions"."field_key" in ('category|category.name', 'category|category.description', 'product_type|product_type.name', 'product_type|product_type.description', 'product_type|product_type.help_text', 'product_type_field|product_type_field.label', 'product_type_field|product_type_field.help_text', 'product_type_field|product_type_field.placeholder', 'product_type_field|product_type_field.example', 'canonical_product|canonical_product.name', 'canonical_product|canonical_product.description', 'canonical_product_family|canonical_product_family.name', 'canonical_product_family|canonical_product_family.description', 'attribute_value|attribute_value.label', 'attribute_definition|attribute_definition.label', 'attribute_definition|attribute_definition.description'));

-- ── The revision trail for the family's late joiner ─────────────────────────
--
-- `attribute_labels` gained the family columns in 0119 and the kind in this
-- migration; this is the trigger that makes its edits appear in
-- `catalog_localization_revisions` like every other member's.
--
-- Without it the table is a member that keeps no history, and the failure is
-- specifically nasty rather than merely absent: `rollbackLocalizationRevision`
-- reads the revision written for an UPDATE, and with no trigger it finds none
-- and reports `undefined` — whose contract means "the rollback would change
-- nothing". A rollback that DID change the live text while reporting that it
-- changed nothing is the worst answer this domain can give.
--
-- A function with no `CREATE TRIGGER` beside it is INERT — created, readable,
-- never run. `catalog-localization.test.ts` now counts `RETURNS trigger`
-- functions against `EXECUTE FUNCTION`/`PROCEDURE` references for exactly that
-- reason, so this block is covered by a census rather than by review.
-- oxy:handwritten-begin=mercaria_attribute_labels_localization_revision
CREATE OR REPLACE FUNCTION mercaria_attribute_labels_localization_revision()
RETURNS trigger AS $$
DECLARE
  v_rollback text := nullif(current_setting('mercaria.localization_rollback_of', true), '');
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO "catalog_localization_revisions"
      ("id", "action", "entity_kind", "entity_id", "locale", "field_key", "value",
       "status", "provenance", "credited_oxy_user_id", "rollback_of_revision_id")
    SELECT gen_random_uuid()::text, 'create', 'attribute_definition',
           NEW.attribute_definition_id, NEW.locale, f.k, f.v,
           NEW.status, NEW.provenance, NEW.reviewed_by_oxy_user_id, NULL
      FROM (VALUES ('attribute_definition.label', NEW.label),
                   ('attribute_definition.description', NEW.description)) AS f(k, v);
  ELSE
    INSERT INTO "catalog_localization_revisions"
      ("id", "action", "entity_kind", "entity_id", "locale", "field_key", "value",
       "status", "provenance", "credited_oxy_user_id", "rollback_of_revision_id")
    SELECT gen_random_uuid()::text,
           CASE WHEN v_rollback IS NULL THEN 'update' ELSE 'rollback' END,
           'attribute_definition', NEW.attribute_definition_id, NEW.locale, f.k, f.v,
           NEW.status, NEW.provenance, NEW.reviewed_by_oxy_user_id, v_rollback
      FROM (VALUES ('attribute_definition.label', NEW.label, OLD.label),
                   ('attribute_definition.description', NEW.description, OLD.description)) AS f(k, v, o)
     WHERE f.v IS DISTINCT FROM f.o
        OR NEW.status IS DISTINCT FROM OLD.status
        OR NEW.provenance IS DISTINCT FROM OLD.provenance;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER mercaria_attribute_labels_localization_revision
  AFTER INSERT OR UPDATE ON "attribute_labels"
  FOR EACH ROW EXECUTE FUNCTION mercaria_attribute_labels_localization_revision();
-- oxy:handwritten-end=mercaria_attribute_labels_localization_revision
