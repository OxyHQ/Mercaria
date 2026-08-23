-- oxy:deploy-phase=pre
-- oxy:rollback=accepted: attribute_definitions.searchable is added and backfilled from display_policy, which is still there, so re-running reproduces the result exactly. Nothing reads a pre-image because the column did not exist before this migration; the mercaria_attribute_definition_immutable body it replaces is in 0024
--
-- Epic #367 line 277 — "Support capability metadata: filterable, sortable,
-- comparable, searchable, displayable, hard-constraint-capable and
-- variant-capable". Six of the seven were already columns; this adds the
-- seventh.
--
-- REGENERATED from `0140` to `0141` after #894 took the 0140 index. Regenerated
-- with `db:generate` rather than renamed: a renamed migration keeps a snapshot
-- that diffs against the wrong parent, and the damage lands on whoever generates
-- next. The two DDL statements below came back byte-identical, which is what
-- makes re-applying this header a re-application rather than a re-description.
--
-- `pre`, and additively so: the column is defaulted and the CHECK constrains a
-- combination the serving image cannot write, since that image knows no
-- `searchable` column at all. The serving image reads `select *` through
-- drizzle's inferred row type and ignores a column it has no property for.
--
-- ## The statement ORDER is load-bearing, in two places
--
-- 1. The BACKFILL runs between the ADD COLUMN and the ADD CONSTRAINT. drizzle
--    generates the column with `DEFAULT true`, which would set every existing
--    row — including any `operator_only` one — to `true`, and the CHECK below
--    would then abort the deploy on rows nobody has looked at. Backfilling from
--    `display_policy` first is what lets the constraint be added VALIDATED with
--    a proof rather than a hope: after the UPDATE, no stored row can violate it.
--
-- 2. The BACKFILL runs before the `CREATE OR REPLACE FUNCTION`. The replacement
--    adds `searchable` to the frozen column list, and once it is there an UPDATE
--    of that column on any row that has left `draft` raises `restrict_violation`
--    — so the same backfill run after it would fail on every published version.
--    The current body does not name the column, so the UPDATE is invisible to it.
--
-- The two SIBLING implications a reader will look for — `filterable ⇒ public`
-- and `comparable ⇒ public` — are deliberately NOT stated as CHECKs, and are
-- enforced at the READ instead (`facets/metadata.ts`, `comparison.service.ts`).
-- Those columns already hold values this branch cannot count, and the repair
-- available here would be to rewrite the frozen meaning of a published version,
-- which is the one edit the freeze exists to refuse. What is owed is a count of
-- the rows that would fail, then the two checks — the `attribute_labels` locale
-- decision one table over, for the same reason.
--
-- ## On a regeneration
--
-- `db:generate` emits statements 1 and 3 and DROPS the two anchored blocks below
-- along with this header and the phase marker. The backfill block goes back
-- BETWEEN them; the function block goes at the end. Grep the regenerated file
-- for `mercaria_attribute_definition_immutable`, for
-- `update "attribute_definitions"`, and for exactly one deploy-phase line.
ALTER TABLE "attribute_definitions" ADD COLUMN "searchable" boolean DEFAULT true NOT NULL;--> statement-breakpoint
-- oxy:handwritten-begin=searchable_display_backfill
-- Backfill. See note 1 above for why this is not left to the column default.
UPDATE "attribute_definitions" SET "searchable" = false WHERE "display_policy" <> 'public';--> statement-breakpoint
-- oxy:handwritten-end=searchable_display_backfill
ALTER TABLE "attribute_definitions" ADD CONSTRAINT "attribute_definitions_searchable_display_check" CHECK ("attribute_definitions"."searchable" is false or "attribute_definitions"."display_policy" = 'public');--> statement-breakpoint
-- `searchable` joins the frozen column list. A capability that can be flipped on
-- a live version is a capability whose version stamp means nothing: a stored
-- value cites the version it was read under, and "was this attribute reachable
-- from a shopper's words under v3" has to stay answerable from v3.
--
-- CREATE OR REPLACE under the SAME name, so the trigger keeps pointing at it and
-- nothing is dropped. Every other line is 0024's body verbatim.
-- oxy:handwritten-begin=mercaria_attribute_definition_immutable
CREATE OR REPLACE FUNCTION mercaria_attribute_definition_immutable()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.lifecycle_state <> 'draft' THEN
      RAISE EXCEPTION
        'attribute_definitions % (%, v%) is % and cannot be deleted; stored values cite this version',
        OLD.id, OLD.key, OLD.version, OLD.lifecycle_state
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.lifecycle_state = 'draft' THEN
    RETURN NEW;
  END IF;

  IF NEW.key IS DISTINCT FROM OLD.key
     OR NEW.version IS DISTINCT FROM OLD.version
     OR NEW.value_type IS DISTINCT FROM OLD.value_type
     OR NEW.cardinality IS DISTINCT FROM OLD.cardinality
     OR NEW.objectivity IS DISTINCT FROM OLD.objectivity
     OR NEW.unit_family IS DISTINCT FROM OLD.unit_family
     OR NEW.base_unit IS DISTINCT FROM OLD.base_unit
     OR NEW.rating_scale_max IS DISTINCT FROM OLD.rating_scale_max
     OR NEW.currency IS DISTINCT FROM OLD.currency
     OR NEW.component_axes IS DISTINCT FROM OLD.component_axes
     OR NEW.min_value IS DISTINCT FROM OLD.min_value
     OR NEW.max_value IS DISTINCT FROM OLD.max_value
     OR NEW.decimal_places IS DISTINCT FROM OLD.decimal_places
     OR NEW.max_length IS DISTINCT FROM OLD.max_length
     OR NEW.implausible_above IS DISTINCT FROM OLD.implausible_above
     OR NEW.implausible_below IS DISTINCT FROM OLD.implausible_below
     OR NEW.variant_defining IS DISTINCT FROM OLD.variant_defining
     OR NEW.filterable IS DISTINCT FROM OLD.filterable
     OR NEW.sortable IS DISTINCT FROM OLD.sortable
     OR NEW.comparable IS DISTINCT FROM OLD.comparable
     OR NEW.searchable IS DISTINCT FROM OLD.searchable
     OR NEW.hard_constraint_capable IS DISTINCT FROM OLD.hard_constraint_capable
     OR NEW.display_policy IS DISTINCT FROM OLD.display_policy
     OR NEW.evidence_policy IS DISTINCT FROM OLD.evidence_policy
     OR NEW.created_by_oxy_user_id IS DISTINCT FROM OLD.created_by_oxy_user_id
  THEN
    RAISE EXCEPTION
      'attribute_definitions % (%, v%) is % and its meaning is frozen; publish a new version instead',
      OLD.id, OLD.key, OLD.version, OLD.lifecycle_state
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
-- oxy:handwritten-end=mercaria_attribute_definition_immutable
