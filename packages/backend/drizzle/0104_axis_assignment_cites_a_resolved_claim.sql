-- oxy:deploy-phase=post
--
-- A typed axis assignment may only cite a claim that RESOLVED (#367).
--
-- ## The bug, and why it is worse than "a value nothing stands behind"
--
-- `native_variant_attribute_claims` carries
--   (value_resolution = 'resolved') = (normalized_value is not null)
-- as a CHECK, and its listing-grain twin carries the same. So a claim that is
-- `unresolved`, `blocked` or `refused` has a NULL `normalized_value` — it
-- resolved to nothing at all.
--
-- `native_variant_axis_assignments.normalized_value` is NOT NULL. Until this
-- migration the scope trigger checked only that the cited claim existed and was
-- about the same variant, so an assignment could carry a typed, normalized,
-- registry-pointing value while citing a claim that carries NONE — including a
-- claim a person explicitly REFUSED. The assignment is not unsupported by its
-- citation; it is CONTRADICTED by it.
--
-- ## How that state is reached, without any manual SQL
--
-- `recordVariantAttributeClaim` is `ON CONFLICT DO NOTHING` on
-- (variant_id, provenance, raw_name_normalized, raw_value_key), and
-- `runVariantAxisBackfill` reads the converged row back with
-- `findVariantAttributeClaim` on those same key columns in order to cite it. So:
--
--   1. backfill run #1, before the attribute definition is published: the value
--      does not resolve, the claim is written `blocked`, the assignment is
--      correctly SKIPPED;
--   2. the definition is published — an ordinary #94 registry act;
--   3. backfill run #2: the value now resolves, the claim insert converges on
--      run #1's `blocked` row and returns nothing, the read-back returns that
--      same `blocked` row, and the assignment is written citing it.
--
-- Nothing in that sequence is a bug on its own. `settleVariantAttributeClaim`
-- would be the other route — a cited claim re-settled to `refused` afterwards —
-- and it has NO caller today, so it cannot run; a trigger on this table could
-- not see it if it did, and that is recorded as the remaining gap rather than
-- fixed here.
--
-- ## Why a trigger and not a CHECK
--
-- The fact is cross-row (it is about the CITED row), and a CHECK may not contain
-- a subquery. The clause joins the trigger that already validates the citation,
-- so there is one place that answers "is this citation true" rather than two.
--
-- ## Why `source_claim_id` stays NULLABLE
--
-- A typed assignment can legitimately come from a merchant's structured input,
-- where the registry answer IS the input and there is no claim to cite.
-- `NOT NULL` would force a caller to invent a claim row to satisfy the schema,
-- which is how a constraint manufactures the fiction it was added to prevent.
--
-- ## The count, recorded here rather than repaired here
--
-- `CREATE OR REPLACE` validates nothing retroactively, so this governs new
-- writes only and leaves any pre-existing violator in place — and now invisible.
-- The `do` block below therefore COUNTS them and raises the number as a warning
-- into the deploy log at the moment the gate lands. Nothing is deleted and no
-- pointer is nulled: nulling `source_claim_id` would destroy a provenance fact
-- to make a count reach zero, and a remediation is a separate decision with its
-- own record. The query, for running by hand:
--
--   select c.value_resolution, count(*)
--     from native_variant_axis_assignments a
--     join native_variant_attribute_claims c on c.id = a.source_claim_id
--    where c.value_resolution <> 'resolved'
--    group by 1 order by 2 desc;
--
do $$
declare
  v_violators bigint;
begin
  select count(*) into v_violators
    from native_variant_axis_assignments a
    join native_variant_attribute_claims c on c.id = a.source_claim_id
   where c.value_resolution <> 'resolved';

  if v_violators > 0 then
    raise warning
      'mercaria #367: % native_variant_axis_assignments row(s) cite a claim that did not resolve. The trigger this migration installs governs NEW writes only and repairs none of them; see the header for the query and the remediation decision.',
      v_violators;
  else
    raise notice
      'mercaria #367: no native_variant_axis_assignments row cites an unresolved claim.';
  end if;
end $$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION mercaria_native_variant_axis_assignment_scope()
RETURNS trigger
LANGUAGE plpgsql
AS $$
declare
  v_axis_listing_id text;
  v_axis_definition_id text;
  v_axis_key text;
  v_variant_listing_id text;
  v_claim_variant_id text;
  v_claim_value_resolution text;
begin
  select a.listing_id, a.attribute_definition_id, a.attribute_key
    into v_axis_listing_id, v_axis_definition_id, v_axis_key
    from native_listing_variant_axes a
   where a.id = new.axis_id;

  select v.listing_id into v_variant_listing_id
    from product_variants v
   where v.id = new.variant_id;

  if v_axis_listing_id is distinct from v_variant_listing_id then
    raise exception
      'native_variant_axis_assignments %: axis % belongs to listing % and variant % to listing %.',
      new.id, new.axis_id, v_axis_listing_id, new.variant_id, v_variant_listing_id
      using errcode = 'raise_exception';
  end if;

  if new.attribute_definition_id is distinct from v_axis_definition_id
     or new.attribute_key is distinct from v_axis_key then
    raise exception
      'native_variant_axis_assignments %: the citation (%, "%") disagrees with axis % (%, "%").',
      new.id, new.attribute_definition_id, new.attribute_key,
      new.axis_id, v_axis_definition_id, v_axis_key
      using errcode = 'raise_exception';
  end if;

  if new.enum_value_id is not null
     and not exists (
       select 1 from attribute_enum_values e
        where e.id = new.enum_value_id
          and e.attribute_definition_id = new.attribute_definition_id
     ) then
    raise exception
      'native_variant_axis_assignments %: controlled value % does not belong to definition %.',
      new.id, new.enum_value_id, new.attribute_definition_id
      using errcode = 'raise_exception';
  end if;

  -- ONE lookup, TWO refusals, deliberately not folded into one `not exists`:
  -- "that claim is about another variant" and "that claim resolved to nothing"
  -- lead an operator to opposite conclusions, and a single message would make
  -- them indistinguishable in the trace. A claim id that does not exist at all
  -- leaves both variables NULL and lands on the first refusal, which is what the
  -- previous `not exists` form did too.
  if new.source_claim_id is not null then
    select c.variant_id, c.value_resolution
      into v_claim_variant_id, v_claim_value_resolution
      from native_variant_attribute_claims c
     where c.id = new.source_claim_id;

    if v_claim_variant_id is distinct from new.variant_id then
      raise exception
        'native_variant_axis_assignments %: claim % is not a claim about variant %.',
        new.id, new.source_claim_id, new.variant_id
        using errcode = 'raise_exception';
    end if;

    if v_claim_value_resolution is distinct from 'resolved' then
      raise exception
        'native_variant_axis_assignments %: claim % resolved to "%" and cannot support a typed value.',
        new.id, new.source_claim_id, v_claim_value_resolution
        using errcode = 'raise_exception';
    end if;
  end if;

  return new;
end;
$$;
