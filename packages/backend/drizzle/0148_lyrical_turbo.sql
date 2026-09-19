-- oxy:deploy-phase=pre
-- oxy:rollback=restore: mercaria_catalog_proposal_freeze previous body, carried verbatim by 0100_same_iron_man.sql. Dropping the five columns alone is derivable, but the function is not: left in place it compares new.name_fold_version against a column that no longer exists, so EVERY update to catalog_proposals raises. Replace it with 0100 body FIRST, then drop the columns.
--
-- A fold version on every column normalizeEntityName WRITES (#915, epic #367
-- line 580).
--
-- Five ADD COLUMNs, plus ONE trigger-function replacement whose reasoning sits
-- above it. Each column defaults to 1 and is NOT NULL, so the
-- serving image -- which writes none of them -- keeps working while this is
-- applied.
--
-- ## The default is a TRUTH CLAIM, not a placeholder
--
-- NAME_FOLD_VERSION is 1 and this migration introduces it, so every existing row
-- WAS folded under version 1. Backfilling 1 is therefore correct rather than a
-- convenient zero -- and it is only correct because the constant starts at 1 in
-- the same change. A later migration adding this column would have to decide
-- what the existing rows were folded under, and could not answer it.
--
-- ## Why five tables and not the eight the issue first named
--
-- The eight search_vector columns are STORED GENERATED: their fold lives in the
-- DDL, so changing it is an ALTER that recomputes every row in one statement and
-- staleness is unrepresentable. A version column there would record a fact that
-- cannot vary within the table, written by nothing.
--
-- These five are APP-WRITTEN by one fold, and rows are written individually, so
-- a fold change leaves each row built under whatever the fold was at the time.
--
-- ## Rollback is a RESTORE, and the columns are not the reason
--
-- Dropping the five columns would be derivable on its own: a lost stamp costs
-- only the stamp, the folded VALUE is a different column and is untouched, and
-- such a row is re-foldable rather than stranded.
--
-- The trigger function is what makes it a restore. CREATE OR REPLACE overwrites
-- a body this file does not contain, so the inverse is not derivable from here
-- -- and getting the ORDER wrong is not a cosmetic failure: a function left
-- comparing new.name_fold_version after the column is dropped raises on EVERY
-- update to catalog_proposals, which is a table an operator decision writes.
-- Replace the function with 0100 body FIRST, then drop the columns.

ALTER TABLE "brands" ADD COLUMN "name_fold_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "name_fold_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "canonical_product_families" ADD COLUMN "name_fold_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "canonical_products" ADD COLUMN "name_fold_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "catalog_proposals" ADD COLUMN "name_fold_version" integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
-- The proposal freeze covers the new column, because `normalized_label` is
-- already frozen and the two describe ONE fact.
--
-- `mercaria_catalog_proposal_freeze` is a DECLARED PARTITION: every column of
-- `catalog_proposals` is either named in it or declared mutable with a reason in
-- `catalog-proposal-schema.test.ts`, and the build fails until a new column is
-- one or the other. This one is FROZEN, and that is forced rather than chosen:
-- `normalized_label` is immutable once submitted AND is one of the five raw
-- components the generated `convergence_key` reads, so a proposal's label can
-- never be re-folded in place.
--
-- The consequence, stated rather than discovered: after a bump, existing
-- proposals keep their old fold forever, and since the fold feeds
-- `convergence_key`, a proposal folded under the new version will not converge
-- with an otherwise identical one folded under the old. The stamp is what makes
-- that legible instead of mysterious.
--
-- Body copied from `0100_same_iron_man.sql` with ONE line added, so the frozen
-- list cannot drift by transcription. Only the FUNCTION is replaced.
--
-- Still `pre`: it refuses an UPDATE moving `name_fold_version`, and the serving
-- image does not write that column at all.
-- oxy:handwritten-begin=mercaria_catalog_proposal_freeze
CREATE OR REPLACE FUNCTION mercaria_catalog_proposal_freeze()
RETURNS trigger
LANGUAGE plpgsql
AS $$
begin
  if new.type is distinct from old.type
     or new.origin is distinct from old.origin
     or new.store_id is distinct from old.store_id
     or new.submitted_by_oxy_user_id is distinct from old.submitted_by_oxy_user_id
     or new.proposed_label is distinct from old.proposed_label
     or new.source_locale is distinct from old.source_locale
     -- `normalized_label` and `search_label`, NOT `convergence_key`: see the
     -- file header. These are the raw components the generation reads.
     or new.normalized_label is distinct from old.normalized_label
     -- Frozen WITH the value it describes (#915): a version free to move
     -- while its value cannot is free to drift into the divergence the
     -- column exists to detect.
     or new.name_fold_version is distinct from old.name_fold_version
     or new.search_label is distinct from old.search_label
     or new.proposed_description is distinct from old.proposed_description
     or new.submitter_note is distinct from old.submitter_note
     -- The context PINS. A proposal answered against one product type version's
     -- controlled-value set, repointed at another, is a decision that cannot be
     -- reproduced (ADR 0007 D5).
     or new.category_id is distinct from old.category_id
     or new.product_type_definition_id is distinct from old.product_type_definition_id
     or new.attribute_definition_id is distinct from old.attribute_definition_id
     or new.attribute_definition_version is distinct from old.attribute_definition_version
     -- The duplicate scan's EVIDENCE, frozen with everything else. An editable
     -- population would make the one number that says whether detection actually
     -- looked at anything editable after the fact — which is the whole of what it
     -- is for.
     or new.duplicate_scan_population is distinct from old.duplicate_scan_population
     or new.duplicate_scan_candidates is distinct from old.duplicate_scan_candidates
     or new.duplicate_scan_at is distinct from old.duplicate_scan_at
  then
    raise exception
      'catalog_proposals %: the request is immutable once submitted. '
      'Decide it, or submit a new one.', old.id
      using errcode = 'raise_exception';
  end if;

  return new;
end;
$$;
-- oxy:handwritten-end=mercaria_catalog_proposal_freeze
