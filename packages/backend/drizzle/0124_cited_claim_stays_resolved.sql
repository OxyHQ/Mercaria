-- oxy:deploy-phase=post
--
-- A cited claim may not leave `resolved` (#576, closing `0104`'s named gap).
--
-- NARROWING, which is what makes this `post`: the clause refuses an UPDATE that
-- was previously accepted. It is `post` on the CATEGORY rather than on a
-- measurement that such an update happens — until this PR nothing could perform
-- it, because `settleVariantAttributeClaim` had no caller at all.
--
-- ## The gap `0104` recorded and could not close
--
-- `native_variant_axis_assignments.normalized_value` is NOT NULL, and
-- `mercaria_native_variant_axis_assignment_scope` (BEFORE INSERT OR UPDATE)
-- refuses an assignment whose cited claim did not resolve. So an assignment
-- always cites a `resolved` claim AT THE MOMENT IT IS WRITTEN, and that covers
-- every write on the assignment side — the INSERT arm covers
-- `replaceVariantAxisAssignments` (DELETE+INSERT) and `writeVariantAxisAssignment`
-- (INSERT … ON CONFLICT DO NOTHING); the UPDATE arm covers repointing an
-- existing row's `source_claim_id`.
--
-- What no trigger on THAT table can see is the claim moving underneath it.
-- Re-settling a claim is an UPDATE to a different table, and `0104` said so:
--
--   "`settleVariantAttributeClaim` would be the other route — a cited claim
--    re-settled to `refused` afterwards — and it has NO caller today, so it
--    cannot run; a trigger on this table could not see it if it did, and that is
--    recorded as the remaining gap rather than fixed here."
--
-- #576 gives that function a caller, which is exactly what makes the gap
-- reachable. So it is closed here, in the same change.
--
-- ## Why the clause JOINS the freeze trigger instead of adding a second one
--
-- `mercaria_native_variant_claim_frozen` is already `BEFORE UPDATE` on this
-- table. Two triggers on one table and one event fire in NAME order and split
-- one invariant across two places; `0104` states the rule while adding its own
-- clause to the scope trigger for the same reason — "so there is one place that
-- answers 'is this citation true' rather than two". The assertion-immutability
-- checks below are reproduced verbatim from the deployed function; only the
-- second `if` is new.
--
-- ## The condition is the TRANSITION, and the obvious spelling is a BUG
--
-- `old.value_resolution = 'resolved' and new.value_resolution is distinct from
-- 'resolved'` — never a bare `new.value_resolution <> 'resolved'`.
--
-- `0104` COUNTED the assignments already citing a non-resolved claim, repaired
-- none deliberately, and left them in place. A guard on the STATE alone FREEZES
-- every one of those rows into "resolve it or never touch it again": any update
-- that does not move the claim to `resolved` is refused, including settling it
-- to `refused`, which is a legitimate decision about a claim whose assignment is
-- already wrong.
--
-- The two forms were enumerated over all sixteen (old, new) pairs on a cited
-- claim; they disagree on NINE, and every one is a pair where `old` and `new`
-- are both non-resolved. Worth stating precisely, because the tempting summary
-- is wrong: the naive form does NOT refuse the repair to `resolved` — that pair
-- passes under both, since it tests `new` alone. What it refuses is a violator
-- moving between non-resolved states, or any other column on one being touched.
--
-- With the transition form: a resolved+cited claim cannot be un-resolved, and a
-- pre-existing violator stays fully updatable. `blocked -> refused` on a cited
-- claim is the pair that tells the two apart, and it is the mutation-tested case
-- in `attribute-claim-settlement.realdb.test.ts`, whose mutation self-test installs
-- the naive form inside a rolled-back transaction and asserts this pair flips.
--
-- ## Only the VARIANT grain
--
-- `native_listing_attribute_claims` gets no such clause, and that is deliberate
-- rather than an omission. Nothing derives a typed value from a listing claim:
-- its only citation is `catalog_proposal_references.listing_claim_id`, which is
-- a proposal WAITING ON the claim. Re-settling one moots that proposal; it
-- contradicts nothing. A symmetric trigger would add a guard with no hazard
-- behind it, and a guard nobody can explain is one somebody later removes.
--
-- ## `--custom` writes the journal and the snapshot, and NOT these markers
--
-- `0104`'s warning, heeded: `drizzle-kit generate --custom` is the right tool
-- for a trigger-body change (there is no schema diff, so `db:generate` emits
-- nothing) and it writes the journal entry and snapshot correctly — but it does
-- NOT write the `-- oxy:handwritten-begin=<name>` / `-end=<name>` anchors that
-- `migration-handwritten-markers.test.ts` requires and that a regeneration needs
-- in order to re-apply a statement drizzle-kit cannot model.
--
-- oxy:handwritten-begin=mercaria_native_variant_claim_frozen
CREATE OR REPLACE FUNCTION mercaria_native_variant_claim_frozen()
RETURNS trigger
LANGUAGE plpgsql
AS $$
begin
  if new.variant_id is distinct from old.variant_id
     or new.raw_name is distinct from old.raw_name
     or new.raw_value is distinct from old.raw_value
     or new.provenance is distinct from old.provenance
     or new.source_connection_id is distinct from old.source_connection_id
     or new.asserted_by_oxy_user_id is distinct from old.asserted_by_oxy_user_id
     or new.asserted_at is distinct from old.asserted_at
  then
    raise exception
      'native_variant_attribute_claims %: what a party asserted is immutable. '
      'Record a new claim; both are retained (ADR 0007 D7).', old.id
      using errcode = 'raise_exception';
  end if;

  -- #576. The TRANSITION, not the state — see the header for why the bare
  -- `new.value_resolution <> 'resolved'` form freezes the rows `0104` counted.
  --
  -- The `exists` is served by `native_variant_axis_assignments_claim_idx`, the
  -- partial index on `source_claim_id WHERE source_claim_id is not null`.
  if old.value_resolution = 'resolved'
     and new.value_resolution is distinct from 'resolved'
     and exists (
       select 1
         from native_variant_axis_assignments a
        where a.source_claim_id = old.id
     )
  then
    raise exception
      'native_variant_attribute_claims %: a typed axis assignment cites this claim, '
      'which this settlement would leave carrying a value the claim contradicts. '
      'Re-run the variant''s axis sync to recompute its assignment set first.', old.id
      using errcode = 'raise_exception';
  end if;

  return new;
end;
$$;
-- oxy:handwritten-end=mercaria_native_variant_claim_frozen
