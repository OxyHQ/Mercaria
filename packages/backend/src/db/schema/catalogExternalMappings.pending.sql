-- External taxonomy, attribute and value mappings (#367 Workstream 11) —
-- the hand-written statements drizzle-kit cannot model.
--
-- NOT APPLIED. This file is plain text held for the migration slot: ADR 0007 D11
-- serialises `db:generate` across the parallel #367 branches. When the slot
-- arrives, everything between the first `-- oxy:handwritten-begin=` and the last
-- `-- oxy:handwritten-end=` below is appended to the generated `.sql` BELOW the
-- drizzle output, under the single `-- oxy:deploy-phase=pre` marker that file
-- already carries (every statement here is additive: five trigger functions and
-- seven triggers).
--
-- ## Two mechanics that make the paste correct rather than plausible
--
-- 1. **Every block is wrapped in a marker pair.** `-- oxy:handwritten-begin=<name>`
--    … `-- oxy:handwritten-end=<name>`, matching by NAME, and no name is reused
--    in the file. `mercaria_catalog_external_no_delete` is ONE function mounted
--    on THREE tables, so it is ONE block containing all four statements rather
--    than three blocks sharing a name.
-- 2. **`--> statement-breakpoint` separates statements, and NEVER appears inside
--    a `$$ … $$` body.**
--
--    The separators are ROBUSTNESS, not correctness, and it is worth knowing
--    which before somebody asks in review. An un-separated paste does NOT fail
--    at apply: `migrator.js` runs each chunk through `sql.raw`, which reaches
--    postgres.js as `client.unsafe(query, [])`, and with no parameters
--    postgres.js uses the SIMPLE protocol — which accepts multiple commands in
--    one string. Measured by the compatibility workstream: un-separated applied
--    1/1 green, separated applied 9/9 green. What the separators buy is that a
--    failure names ONE statement instead of a block of twelve, and that the file
--    stops leaning on a fallback which a `prepare: true`, a bound parameter or a
--    different driver would remove.
--
--    The OTHER half is a real defect and is the one this file is exposed to: a
--    separator inside a `$$ … $$` body is cut before anything is parsed, so the
--    function is halved and both halves fail. Each breakpoint here sits on the
--    terminating `;` of a COMPLETE statement — which for a function is the `$$;`
--    that closes the body, never the semicolons inside it. With five function
--    bodies, "one after every `;`" is exactly the wrong heuristic.
--
-- Self-check after the paste:
--   grep -c '^-- oxy:handwritten-begin=' <migration>  -> 5
--   grep -c '^-- oxy:handwritten-end='   <migration>  -> 5
--   grep -c '^CREATE TRIGGER '           <migration>  -> 7
--   grep -c '^-- oxy:deploy-phase='      <migration>  -> 1
-- Then strip comments, markers and breakpoints from both this file and the
-- pasted region and compare byte-for-byte: that is what catches a function body
-- mangled by the annotation, which reading the file will not.
--
-- **The stripper has its own trap.** If it tracks `$$` BEFORE deciding whether a
-- line is a comment, a header comment that merely mentions `$$` flips the quote
-- state, every later comment is read as body text, and the compare reports
-- DIFFERS on a file whose SQL is untouched. Skip `--` lines outside a
-- dollar-quote without reading their `$$`. This is not hypothetical: the gate in
-- `external-mapping-schema.test.ts` hit exactly that shape twice while being
-- written, which is why it walks only the statement region and asserts no
-- comment inside it carries a `$$`.
--
-- REGENERATION DROPS EVERY STATEMENT IN THIS FILE. That is the measured failure
-- three of four branches hit in one rebase batch (`~/Oxy/AGENTS.md`), and all
-- three would have applied cleanly and enforced nothing.
--
-- ── The one trap this file exists to remember ────────────────────────────────
--
-- `external_key_normalized` is a STORED GENERATED column on all three tables
-- that carry an external token. A stored generated column is computed AFTER a
-- `BEFORE UPDATE` trigger runs, so `NEW.external_key_normalized` is NULL inside
-- one of these functions and any comparison against it raises on every update.
-- Every immutability check below therefore compares `external_key`, the column
-- the generation reads. This cost a real bug in #59; it is not a hypothetical.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. A mapping's MEANING is frozen once it leaves `proposed`.
--
-- The `fee_schedules` / `attribute_definitions` mechanism. A change to what a
-- mapping means is a NEW version plus a `valid_to` on the old row, never an
-- UPDATE — an edit in place would silently reinterpret every observation already
-- recorded under the previous meaning, which is the failure ADR 0007 D5 pins
-- version immutability against.
--
-- What may still move on a frozen row is exactly the lifecycle: `state`, the
-- review and approval stamps, the fan-out approval, `valid_to` (NULL → a value,
-- never back), `rejected_reason`, and `updated_at`.
-- ─────────────────────────────────────────────────────────────────────────────
-- oxy:handwritten-begin=mercaria_catalog_external_mapping_freeze
CREATE OR REPLACE FUNCTION mercaria_catalog_external_mapping_freeze()
RETURNS trigger
LANGUAGE plpgsql
AS $$
begin
  if old.state = 'proposed' then
    -- A proposal is still being drafted. Everything is editable.
    return new;
  end if;

  if new.catalog_source_id is distinct from old.catalog_source_id
     or new.dimension is distinct from old.dimension
     -- `external_key`, NOT `external_key_normalized`: see the file header.
     or new.external_key is distinct from old.external_key
     or new.target_product_type_key is distinct from old.target_product_type_key
     or new.target_attribute_key is distinct from old.target_attribute_key
     or new.target_controlled_value is distinct from old.target_controlled_value
     or new.target_unit_family is distinct from old.target_unit_family
     or new.target_unit_code is distinct from old.target_unit_code
     or new.target_size_system_key is distinct from old.target_size_system_key
     -- Provenance, frozen with everything else: "which schema version was I
     -- looking at when I approved this" is worthless if it can be edited after
     -- the approval.
     or new.reviewed_product_type_definition_id
        is distinct from old.reviewed_product_type_definition_id
     or new.transform_rule is distinct from old.transform_rule
     or new.transform_rule_version is distinct from old.transform_rule_version
     or new.provenance is distinct from old.provenance
     or new.confidence is distinct from old.confidence
     or new.version is distinct from old.version
     or new.valid_from is distinct from old.valid_from
     or new.supersedes_mapping_id is distinct from old.supersedes_mapping_id
     -- The audit half, and both were MISSING until the freeze census caught
     -- them. `evidence_source_record_id` is the observation somebody approved
     -- this mapping on the strength of; `proposed_by_oxy_user_id` is who put it
     -- forward. Either one editable after approval means the record of a
     -- decision points at something other than what was decided on.
     or new.evidence_source_record_id is distinct from old.evidence_source_record_id
     or new.proposed_by_oxy_user_id is distinct from old.proposed_by_oxy_user_id
  then
    raise exception
      'catalog_external_mappings %: a mapping past `proposed` is immutable. '
      'Publish a new version and close this one with `valid_to`.', old.id
      using errcode = 'raise_exception';
  end if;

  -- A validity window closes once and never reopens: an observation interpreted
  -- under a closed window must stay interpretable that way.
  if old.valid_to is not null and new.valid_to is distinct from old.valid_to then
    raise exception
      'catalog_external_mappings %: `valid_to` is already set and cannot move.', old.id
      using errcode = 'raise_exception';
  end if;

  return new;
end;
$$;--> statement-breakpoint
CREATE TRIGGER mercaria_catalog_external_mapping_freeze
BEFORE UPDATE ON catalog_external_mappings
FOR EACH ROW EXECUTE FUNCTION mercaria_catalog_external_mapping_freeze();
-- oxy:handwritten-end=mercaria_catalog_external_mapping_freeze
--> statement-breakpoint
-- ─────────────────────────────────────────────────────────────────────────────
-- 2. The state machine. A CHECK cannot see the previous row, so the legal moves
-- are a trigger.
--
-- `approved` → `proposed` would let a mapping somebody refused become live
-- again with no second approval, and `rejected` → `approved` would do it in one
-- statement. Both are the same hole: a decision reversed with no record that it
-- was reversed. The forward path (`rejected` → a NEW proposed version) leaves
-- the rejection standing, which is what stops the re-proposal loop
-- `match_blocked_pairs` exists for.
-- ─────────────────────────────────────────────────────────────────────────────
-- oxy:handwritten-begin=mercaria_catalog_external_mapping_state
CREATE OR REPLACE FUNCTION mercaria_catalog_external_mapping_state()
RETURNS trigger
LANGUAGE plpgsql
AS $$
begin
  if new.state = old.state then
    return new;
  end if;

  if not (
       (old.state = 'proposed'  and new.state in ('in_review', 'approved', 'rejected'))
    or (old.state = 'in_review' and new.state in ('approved', 'rejected'))
    or (old.state = 'approved'  and new.state = 'superseded')
  ) then
    raise exception
      'catalog_external_mappings %: refusing the state move % -> %.', old.id, old.state, new.state
      using errcode = 'raise_exception';
  end if;

  return new;
end;
$$;--> statement-breakpoint
CREATE TRIGGER mercaria_catalog_external_mapping_state
BEFORE UPDATE ON catalog_external_mappings
FOR EACH ROW EXECUTE FUNCTION mercaria_catalog_external_mapping_state();
-- oxy:handwritten-end=mercaria_catalog_external_mapping_state
--> statement-breakpoint
-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Nothing in this domain is ever deleted.
--
-- Every table here is evidence about a decision somebody made, and the whole
-- point of keeping a `rejected` row is that it is still there next crawl. A
-- DELETE would be the one way to remove a rejection without anybody seeing that
-- it was removed.
--
-- ONE function, THREE mounts, ONE marker block. Three blocks would have to share
-- a name, and a name reused within a file is exactly what the marker gate
-- refuses — correctly, since a stack cannot tell which `end` closes which
-- `begin`.
-- ─────────────────────────────────────────────────────────────────────────────
-- oxy:handwritten-begin=mercaria_catalog_external_no_delete
CREATE OR REPLACE FUNCTION mercaria_catalog_external_no_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
begin
  raise exception
    '% is append-only: row % may not be deleted.', tg_table_name, old.id
    using errcode = 'raise_exception';
end;
$$;--> statement-breakpoint
CREATE TRIGGER mercaria_catalog_external_mapping_no_delete
BEFORE DELETE ON catalog_external_mappings
FOR EACH ROW EXECUTE FUNCTION mercaria_catalog_external_no_delete();--> statement-breakpoint
CREATE TRIGGER mercaria_catalog_external_review_no_delete
BEFORE DELETE ON catalog_external_mapping_reviews
FOR EACH ROW EXECUTE FUNCTION mercaria_catalog_external_no_delete();--> statement-breakpoint
CREATE TRIGGER mercaria_catalog_external_run_item_no_delete
BEFORE DELETE ON catalog_external_mapping_run_items
FOR EACH ROW EXECUTE FUNCTION mercaria_catalog_external_no_delete();
-- oxy:handwritten-end=mercaria_catalog_external_no_delete
--> statement-breakpoint
-- ─────────────────────────────────────────────────────────────────────────────
-- 4. A review row's SUBJECT is frozen; only its disposition moves.
--
-- The subject is what a reviewer is answering. If the token, the source, the
-- dimension or the raw observed value could be edited after the fact, the answer
-- in `resolved_mapping_id` would be an answer to a question nobody can see any
-- more. `occurrences`, `last_observed_at`, `priority`, `summary`,
-- `candidate_mapping_ids`, `state` and the resolution stamps are all free to
-- move — the first two on every fresh observation.
-- ─────────────────────────────────────────────────────────────────────────────
-- oxy:handwritten-begin=mercaria_catalog_external_review_subject_frozen
CREATE OR REPLACE FUNCTION mercaria_catalog_external_review_subject_frozen()
RETURNS trigger
LANGUAGE plpgsql
AS $$
begin
  if new.catalog_source_id is distinct from old.catalog_source_id
     -- `external_key`, NOT the generated column: see the file header.
     or new.external_key is distinct from old.external_key
     or new.dimension is distinct from old.dimension
     or new.observed_raw_value is distinct from old.observed_raw_value
     or new.source_record_id is distinct from old.source_record_id
     or new.first_observed_at is distinct from old.first_observed_at
  then
    raise exception
      'catalog_external_mapping_reviews %: the subject of a review is immutable.', old.id
      using errcode = 'raise_exception';
  end if;

  -- A settled review stays settled. Re-opening one would discard the decision
  -- and, with the partial unique on open rows, would do it invisibly.
  if old.state <> 'open' and new.state = 'open' then
    raise exception
      'catalog_external_mapping_reviews %: a settled review cannot be reopened. '
      'Record a new observation instead.', old.id
      using errcode = 'raise_exception';
  end if;

  return new;
end;
$$;--> statement-breakpoint
CREATE TRIGGER mercaria_catalog_external_review_subject_frozen
BEFORE UPDATE ON catalog_external_mapping_reviews
FOR EACH ROW EXECUTE FUNCTION mercaria_catalog_external_review_subject_frozen();
-- oxy:handwritten-end=mercaria_catalog_external_review_subject_frozen
--> statement-breakpoint
-- ─────────────────────────────────────────────────────────────────────────────
-- 5. A run item is append-only against UPDATE.
--
-- A run's conclusions are the thing a dry run and its apply are compared on. If
-- an item could be edited, the comparison would be between two descriptions of
-- one run rather than between a prediction and an outcome. The DELETE half is
-- block 3 above.
-- ─────────────────────────────────────────────────────────────────────────────
-- oxy:handwritten-begin=mercaria_catalog_external_run_item_immutable
CREATE OR REPLACE FUNCTION mercaria_catalog_external_run_item_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
begin
  raise exception
    'catalog_external_mapping_run_items %: a run item is append-only.', old.id
    using errcode = 'raise_exception';
end;
$$;--> statement-breakpoint
CREATE TRIGGER mercaria_catalog_external_run_item_immutable
BEFORE UPDATE ON catalog_external_mapping_run_items
FOR EACH ROW EXECUTE FUNCTION mercaria_catalog_external_run_item_immutable();
-- oxy:handwritten-end=mercaria_catalog_external_run_item_immutable
