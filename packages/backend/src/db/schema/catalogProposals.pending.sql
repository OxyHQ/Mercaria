-- Catalog proposals and operator review (#367 step 6, ADR 0007 D9) — the
-- hand-written statements drizzle-kit cannot model.
--
-- NOT APPLIED. This file is plain text held for the migration slot: ADR 0007 D11
-- serialises `db:generate` across the parallel #367 branches. When the slot
-- arrives, everything between the first `-- oxy:handwritten-begin=` and the last
-- `-- oxy:handwritten-end=` below is appended to the generated `.sql` BELOW the
-- drizzle output, under the single `-- oxy:deploy-phase=pre` marker that file
-- already carries (every statement here is additive: five trigger functions and
-- five triggers).
--
-- ## The mechanics that make the paste correct rather than plausible
--
-- 1. **Every block is wrapped in a marker pair.** `-- oxy:handwritten-begin=<name>`
--    … `-- oxy:handwritten-end=<name>`, matching by NAME, and no name is reused.
-- 2. **`--> statement-breakpoint` separates statements and NEVER appears inside a
--    `$$ … $$` body.** Each breakpoint here sits on the terminating `;` of a
--    COMPLETE statement — which for a function is the `$$;` that closes the body,
--    never the semicolons inside it. With five function bodies, "one after every
--    `;`" is exactly the wrong heuristic.
-- 3. **Slice the blocks out with a COLUMN-0 anchor** on
--    `-- oxy:handwritten-begin=`, never a substring search: this header mentions
--    both markers in prose, and an unanchored slice drags it in — carrying a
--    prose copy of the separator token, which fails silently.
--
-- Self-check after the paste:
--   grep -c '^-- oxy:handwritten-begin=' <migration>  -> 5
--   grep -c '^-- oxy:handwritten-end='   <migration>  -> 5
--   grep -c '^CREATE TRIGGER '           <migration>  -> 5
--   grep -c '^-- oxy:deploy-phase='      <migration>  -> 1
--
-- REGENERATION DROPS EVERY STATEMENT IN THIS FILE, and the PRESERVE-BEFORE-YOU-
-- DELETE order in `CONVENTIONS.md` §Migrations is the one that matters on a
-- rebase: preserve the marked blocks FIRST, then delete your `.sql` and
-- snapshot, then restore the journal, then `build:shared-types`, then
-- `db:generate`, then re-paste. Done in the other order the delete removes the
-- only copy of these triggers, the regeneration emits a file without them, and
-- that file applies cleanly and enforces nothing.
--
-- ── The one trap this file exists to remember ────────────────────────────────
--
-- `catalog_proposals.convergence_key` is a STORED GENERATED column. A stored
-- generated column is computed AFTER a `BEFORE UPDATE` trigger runs, so
-- `NEW.convergence_key` is NULL inside one of these functions and any comparison
-- against it raises on every update. The freeze below therefore names the FIVE
-- RAW COMPONENTS the generation reads (`type`, `attribute_definition_id`,
-- `category_id`, `product_type_definition_id`, `normalized_label`) and never the
-- generated column itself. This cost a real bug in #59 and again in Workstream
-- 11; it is not a hypothetical.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. The REQUEST is frozen from the moment it is submitted.
--
-- ADR 0007 D9's binding sentence is that a merchant proposal never becomes
-- globally trusted data by being submitted, and the half of that a CHECK cannot
-- express is that the request itself does not CHANGE afterwards. An editable
-- label would let a submitter (or a service bug) turn an approved request for
-- one concept into a record of a request for another — with the operator's
-- reason, decider and timestamp still attached to it, describing a decision
-- nobody made.
--
-- What may still move is exactly the disposition: `state`, the four decision
-- stamps, `resolved_entity_id`, `redirected_to_proposal_id`, `deferred_until`
-- and `updated_at`. Every one of those is guarded further by
-- `mercaria_catalog_proposal_state` below and by the row's own CHECKs.
--
-- The column list is a DECLARED PARTITION: `catalog-proposal-schema.test.ts`
-- walks the real drizzle table and asserts every column is either named here or
-- declared mutable with a reason. A hand-maintained list beside a real table has
-- nothing measuring the two, and finding fewer columns and there BEING fewer
-- look identical without it.
-- ─────────────────────────────────────────────────────────────────────────────
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
$$;--> statement-breakpoint
CREATE TRIGGER mercaria_catalog_proposal_freeze
BEFORE UPDATE ON catalog_proposals
FOR EACH ROW EXECUTE FUNCTION mercaria_catalog_proposal_freeze();
-- oxy:handwritten-end=mercaria_catalog_proposal_freeze
--> statement-breakpoint
-- ─────────────────────────────────────────────────────────────────────────────
-- 2. The state machine. A CHECK cannot see the previous row, so the legal moves
-- are a trigger.
--
-- The moves that must not exist, and what each would be:
--
--   `approved` -> anything          a minted value un-minted with no record
--   `rejected` -> `submitted`       a refusal reopened with no second decision
--   `withdrawn` -> anything         somebody's closed request re-opened for them
--   `merged` -> `approved`          a link rewritten as a mint
--   `redirected` -> anything        the continuation orphaned
--
-- Every terminal state is terminal, in one place. The forward path from a
-- rejection is a NEW proposal, which leaves the rejection standing — the
-- `match_blocked_pairs` posture, and what stops a re-proposal loop being
-- indistinguishable from a reconsideration.
--
-- `deferred` -> `submitted` IS legal and is how a deferral comes back; the
-- service clears `deferred_until` in the same statement, because
-- `catalog_proposals_deferred_check` refuses a non-deferred row that still
-- carries a date.
-- ─────────────────────────────────────────────────────────────────────────────
-- oxy:handwritten-begin=mercaria_catalog_proposal_state
CREATE OR REPLACE FUNCTION mercaria_catalog_proposal_state()
RETURNS trigger
LANGUAGE plpgsql
AS $$
begin
  if new.state = old.state then
    return new;
  end if;

  if not (
       (old.state = 'submitted'
          and new.state in ('needs_information', 'deferred', 'approved', 'merged',
                            'redirected', 'rejected', 'withdrawn'))
    or (old.state = 'needs_information'
          and new.state in ('submitted', 'deferred', 'approved', 'merged',
                            'redirected', 'rejected', 'withdrawn'))
    or (old.state = 'deferred'
          and new.state in ('submitted', 'needs_information', 'approved', 'merged',
                            'redirected', 'rejected', 'withdrawn'))
  ) then
    raise exception
      'catalog_proposals %: refusing the state move % -> %. A decided proposal is '
      'not re-decided; submit a new one.', old.id, old.state, new.state
      using errcode = 'raise_exception';
  end if;

  return new;
end;
$$;--> statement-breakpoint
CREATE TRIGGER mercaria_catalog_proposal_state
BEFORE UPDATE ON catalog_proposals
FOR EACH ROW EXECUTE FUNCTION mercaria_catalog_proposal_state();
-- oxy:handwritten-end=mercaria_catalog_proposal_state
--> statement-breakpoint
-- ─────────────────────────────────────────────────────────────────────────────
-- 3. `catalog_review_events` is append-only against UPDATE *and* DELETE.
--
-- The `merchant_claim_events` / `order_status_history` contract. One row per
-- ACTION, refusals included, and nothing may rewrite one afterwards — which is
-- what makes "who decided this and why" answerable rather than merely usually
-- recorded.
--
-- The DELETE half is why `catalog_review_events.proposal_id` is declared
-- `restrict` and not `cascade`: a cascade beside a no-delete trigger is a way to
-- remove the audit trail by removing its parent, and the two would disagree with
-- the trigger winning in the confusing direction (the delete of the PROPOSAL
-- fails, naming a table the operator did not touch). The declaration agreeing
-- with the trigger is what makes the refusal legible.
-- ─────────────────────────────────────────────────────────────────────────────
-- oxy:handwritten-begin=mercaria_catalog_review_event_append_only
CREATE OR REPLACE FUNCTION mercaria_catalog_review_event_append_only()
RETURNS trigger
LANGUAGE plpgsql
AS $$
begin
  raise exception
    'catalog_review_events is append-only: % is refused.', tg_op
    using errcode = 'raise_exception';
end;
$$;--> statement-breakpoint
CREATE TRIGGER mercaria_catalog_review_event_append_only
BEFORE UPDATE OR DELETE ON catalog_review_events
FOR EACH ROW EXECUTE FUNCTION mercaria_catalog_review_event_append_only();
-- oxy:handwritten-end=mercaria_catalog_review_event_append_only
--> statement-breakpoint
-- ─────────────────────────────────────────────────────────────────────────────
-- 4. A duplicate-scan candidate is what the detector SAW at one instant.
--
-- UPDATE refused; DELETE permitted. The delete exception is the
-- `analytics_events` posture and is deliberate in both directions: these rows
-- cascade from their proposal and are the natural target of a retention sweep,
-- and a trigger refusing that would make the sweep fail SILENTLY on exactly the
-- rows it was meant to remove.
--
-- What UPDATE would allow is the thing worth refusing: a candidate's label or
-- score edited after the fact, so the evidence an operator approved a proposal
-- ON THE STRENGTH OF says something other than what it said.
-- ─────────────────────────────────────────────────────────────────────────────
-- oxy:handwritten-begin=mercaria_catalog_proposal_candidate_immutable
CREATE OR REPLACE FUNCTION mercaria_catalog_proposal_candidate_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
begin
  raise exception
    'catalog_proposal_duplicate_candidates %: a recorded scan result is immutable.', old.id
    using errcode = 'raise_exception';
end;
$$;--> statement-breakpoint
CREATE TRIGGER mercaria_catalog_proposal_candidate_immutable
BEFORE UPDATE ON catalog_proposal_duplicate_candidates
FOR EACH ROW EXECUTE FUNCTION mercaria_catalog_proposal_candidate_immutable();
-- oxy:handwritten-end=mercaria_catalog_proposal_candidate_immutable
--> statement-breakpoint
-- ─────────────────────────────────────────────────────────────────────────────
-- 5. A reference is backfilled ONCE, and its subject never moves.
--
-- `backfilled_at` is the idempotency of ADR 0007 D9's "backfilled idempotently":
-- the service claims a reference with `UPDATE … WHERE backfilled_at IS NULL`,
-- whose empty result set IS the "already applied" answer. That CAS is correct on
-- its own against two concurrent passes — and it is not what stops a LATER write
-- clearing the stamp and letting the same answer be rewritten a second time,
-- which is what this refuses.
--
-- The subject columns are frozen for the reason the proposal's are: a reference
-- repointed at a different draft answer after being stamped would report work
-- applied to a row nothing ever touched.
--
-- The column list is a DECLARED PARTITION, gated the same way the freeze above
-- is.
-- ─────────────────────────────────────────────────────────────────────────────
-- oxy:handwritten-begin=mercaria_catalog_proposal_reference_backfill_once
CREATE OR REPLACE FUNCTION mercaria_catalog_proposal_reference_backfill_once()
RETURNS trigger
LANGUAGE plpgsql
AS $$
begin
  if new.proposal_id is distinct from old.proposal_id
     or new.kind is distinct from old.kind
     or new.draft_id is distinct from old.draft_id
     or new.draft_value_id is distinct from old.draft_value_id
     or new.listing_claim_id is distinct from old.listing_claim_id
  then
    raise exception
      'catalog_proposal_references %: what a reference is ABOUT is immutable.', old.id
      using errcode = 'raise_exception';
  end if;

  -- NULL -> a value exactly once. A stamp that could be cleared would let the
  -- same draft answer be rewritten a second time by a later pass, over a value
  -- the author may have changed in between.
  if old.backfilled_at is not null and new.backfilled_at is distinct from old.backfilled_at then
    raise exception
      'catalog_proposal_references %: `backfilled_at` is already set and cannot move.', old.id
      using errcode = 'raise_exception';
  end if;

  return new;
end;
$$;--> statement-breakpoint
CREATE TRIGGER mercaria_catalog_proposal_reference_backfill_once
BEFORE UPDATE ON catalog_proposal_references
FOR EACH ROW EXECUTE FUNCTION mercaria_catalog_proposal_reference_backfill_once();
-- oxy:handwritten-end=mercaria_catalog_proposal_reference_backfill_once
