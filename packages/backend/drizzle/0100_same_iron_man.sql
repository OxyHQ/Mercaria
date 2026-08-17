-- oxy:deploy-phase=pre
--
-- Catalog proposals and operator review (#367 step 6, ADR 0007 D9) — four
-- tables, five trigger functions and five triggers. Every statement is
-- ADDITIVE: nothing here drops, renames or narrows anything, and the previous
-- image simply never reads these tables.
--
-- The generated half was READ before the hand-written half was appended, and
-- it carries NO `DROP CONSTRAINT`: no sibling closed-value-set CHECK was
-- re-rendered from a stale `dist/`, which is the failure #61 measured.
--
-- The statements below the drizzle output come from
-- `db/schema/catalogProposals.pending.sql`, which is DELETED in the same
-- commit under the two-copies rule. If this file is ever regenerated, they are
-- dropped and have to be re-pasted from git history — read
-- `CONVENTIONS.md` §Migrations "Preserve before you delete" first, because the
-- protocol's own step order removes the only copy.
CREATE TABLE "catalog_proposal_duplicate_candidates" (
	"id" text PRIMARY KEY NOT NULL,
	"proposal_id" text NOT NULL,
	"kind" text NOT NULL,
	"detector" text NOT NULL,
	"candidate_ref" text NOT NULL,
	"candidate_label" text NOT NULL,
	"similarity" double precision,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "catalog_proposal_duplicate_candidates_kind_check" CHECK ("catalog_proposal_duplicate_candidates"."kind" in ('existing_entity', 'open_proposal')),
	CONSTRAINT "catalog_proposal_duplicate_candidates_detector_check" CHECK ("catalog_proposal_duplicate_candidates"."detector" in ('exact_normalized', 'recorded_alias', 'trigram_similarity')),
	CONSTRAINT "catalog_proposal_duplicate_candidates_ref_check" CHECK (btrim("catalog_proposal_duplicate_candidates"."candidate_ref") <> '' and btrim("catalog_proposal_duplicate_candidates"."candidate_label") <> ''),
	CONSTRAINT "catalog_proposal_duplicate_candidates_similarity_check" CHECK (("catalog_proposal_duplicate_candidates"."detector" = 'trigram_similarity') = ("catalog_proposal_duplicate_candidates"."similarity" is not null)),
	CONSTRAINT "catalog_proposal_duplicate_candidates_similarity_range_check" CHECK ("catalog_proposal_duplicate_candidates"."similarity" is null or ("catalog_proposal_duplicate_candidates"."similarity" > 0 and "catalog_proposal_duplicate_candidates"."similarity" <= 1))
);
--> statement-breakpoint
CREATE TABLE "catalog_proposal_references" (
	"id" text PRIMARY KEY NOT NULL,
	"proposal_id" text NOT NULL,
	"kind" text NOT NULL,
	"draft_id" text,
	"draft_value_id" text,
	"listing_claim_id" text,
	"backfilled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "catalog_proposal_references_kind_check" CHECK ("catalog_proposal_references"."kind" in ('authoring_draft_value', 'listing_attribute_claim')),
	CONSTRAINT "catalog_proposal_references_draft_shape_check" CHECK (("catalog_proposal_references"."kind" = 'authoring_draft_value') = ("catalog_proposal_references"."draft_value_id" is not null)),
	CONSTRAINT "catalog_proposal_references_claim_shape_check" CHECK (("catalog_proposal_references"."kind" = 'listing_attribute_claim') = ("catalog_proposal_references"."listing_claim_id" is not null)),
	CONSTRAINT "catalog_proposal_references_draft_pair_check" CHECK (("catalog_proposal_references"."draft_value_id" is null) = ("catalog_proposal_references"."draft_id" is null))
);
--> statement-breakpoint
CREATE TABLE "catalog_proposals" (
	"id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"origin" text DEFAULT 'merchant' NOT NULL,
	"state" text DEFAULT 'submitted' NOT NULL,
	"store_id" text,
	"submitted_by_oxy_user_id" text NOT NULL,
	"proposed_label" text NOT NULL,
	"source_locale" text NOT NULL,
	"normalized_label" text NOT NULL,
	"search_label" text NOT NULL,
	"proposed_description" text,
	"submitter_note" text,
	"category_id" text,
	"product_type_definition_id" text,
	"attribute_definition_id" text,
	"attribute_definition_version" integer,
	"resolved_entity_id" text,
	"redirected_to_proposal_id" text,
	"rejection_reason" text,
	"decision_reason" text,
	"decided_by_oxy_user_id" text,
	"decided_at" timestamp with time zone,
	"deferred_until" timestamp with time zone,
	"duplicate_scan_population" integer DEFAULT 0 NOT NULL,
	"duplicate_scan_candidates" integer DEFAULT 0 NOT NULL,
	"duplicate_scan_at" timestamp with time zone,
	"convergence_key" text GENERATED ALWAYS AS ("type" || ':' || coalesce("attribute_definition_id", '') || ':' || coalesce("category_id", '') || ':' || coalesce("product_type_definition_id", '') || ':' || "normalized_label") STORED NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "catalog_proposals_type_check" CHECK ("catalog_proposals"."type" in ('category', 'product_type', 'brand', 'product_family', 'canonical_product', 'canonical_variant', 'attribute', 'controlled_value')),
	CONSTRAINT "catalog_proposals_origin_check" CHECK ("catalog_proposals"."origin" in ('merchant', 'operator')),
	CONSTRAINT "catalog_proposals_state_check" CHECK ("catalog_proposals"."state" in ('submitted', 'needs_information', 'deferred', 'approved', 'merged', 'redirected', 'rejected', 'withdrawn')),
	CONSTRAINT "catalog_proposals_rejection_reason_check" CHECK ("catalog_proposals"."rejection_reason" in ('not_a_distinct_concept', 'out_of_scope', 'insufficient_evidence', 'misclassified', 'prohibited_content', 'other')),
	CONSTRAINT "catalog_proposals_origin_scope_check" CHECK (("catalog_proposals"."origin" = 'merchant') = ("catalog_proposals"."store_id" is not null)),
	CONSTRAINT "catalog_proposals_label_check" CHECK (btrim("catalog_proposals"."proposed_label") <> ''),
	CONSTRAINT "catalog_proposals_normalized_label_check" CHECK (btrim("catalog_proposals"."normalized_label") <> ''),
	CONSTRAINT "catalog_proposals_search_label_check" CHECK (btrim("catalog_proposals"."search_label") <> ''),
	CONSTRAINT "catalog_proposals_normalized_shape_check" CHECK ("catalog_proposals"."normalized_label" = lower(btrim("catalog_proposals"."normalized_label"))),
	CONSTRAINT "catalog_proposals_search_shape_check" CHECK ("catalog_proposals"."search_label" = lower(btrim("catalog_proposals"."search_label"))),
	CONSTRAINT "catalog_proposals_locale_shape_check" CHECK ("catalog_proposals"."source_locale" = lower(btrim("catalog_proposals"."source_locale")) and "catalog_proposals"."source_locale" ~ '^[a-z]{2,3}(-[a-z0-9]{2,8})*$'),
	CONSTRAINT "catalog_proposals_controlled_value_subject_check" CHECK ("catalog_proposals"."type" <> 'controlled_value'
          or ("catalog_proposals"."attribute_definition_id" is not null and "catalog_proposals"."attribute_definition_version" is not null)),
	CONSTRAINT "catalog_proposals_attribute_pin_check" CHECK (("catalog_proposals"."attribute_definition_id" is null) = ("catalog_proposals"."attribute_definition_version" is null)),
	CONSTRAINT "catalog_proposals_attribute_version_check" CHECK ("catalog_proposals"."attribute_definition_version" >= 1),
	CONSTRAINT "catalog_proposals_resolution_check" CHECK (("catalog_proposals"."state" in ('approved', 'merged'))
          = ("catalog_proposals"."resolved_entity_id" is not null)),
	CONSTRAINT "catalog_proposals_redirect_check" CHECK (("catalog_proposals"."state" = 'redirected') = ("catalog_proposals"."redirected_to_proposal_id" is not null)),
	CONSTRAINT "catalog_proposals_redirect_self_check" CHECK ("catalog_proposals"."redirected_to_proposal_id" is distinct from "catalog_proposals"."id"),
	CONSTRAINT "catalog_proposals_rejection_shape_check" CHECK (("catalog_proposals"."state" = 'rejected') = ("catalog_proposals"."rejection_reason" is not null)),
	CONSTRAINT "catalog_proposals_decision_audit_check" CHECK ("catalog_proposals"."state" in ('submitted', 'needs_information', 'deferred', 'withdrawn')
          or ("catalog_proposals"."decided_by_oxy_user_id" is not null
              and "catalog_proposals"."decided_at" is not null
              and btrim(coalesce("catalog_proposals"."decision_reason", '')) <> '')),
	CONSTRAINT "catalog_proposals_decider_distinct_check" CHECK ("catalog_proposals"."decided_by_oxy_user_id" is null
          or "catalog_proposals"."decided_by_oxy_user_id" <> "catalog_proposals"."submitted_by_oxy_user_id"),
	CONSTRAINT "catalog_proposals_deferred_check" CHECK (("catalog_proposals"."state" = 'deferred') = ("catalog_proposals"."deferred_until" is not null)),
	CONSTRAINT "catalog_proposals_scan_population_check" CHECK ("catalog_proposals"."duplicate_scan_population" >= 0),
	CONSTRAINT "catalog_proposals_scan_candidates_check" CHECK ("catalog_proposals"."duplicate_scan_candidates" >= 0
          and "catalog_proposals"."duplicate_scan_candidates" <= "catalog_proposals"."duplicate_scan_population"),
	CONSTRAINT "catalog_proposals_scan_dated_check" CHECK ("catalog_proposals"."duplicate_scan_at" is not null
          or ("catalog_proposals"."duplicate_scan_population" = 0 and "catalog_proposals"."duplicate_scan_candidates" = 0))
);
--> statement-breakpoint
CREATE TABLE "catalog_review_events" (
	"id" text PRIMARY KEY NOT NULL,
	"proposal_id" text NOT NULL,
	"action" text NOT NULL,
	"actor_kind" text NOT NULL,
	"actor_oxy_user_id" text,
	"from_state" text,
	"to_state" text,
	"reason" text,
	"at" timestamp with time zone NOT NULL,
	CONSTRAINT "catalog_review_events_action_check" CHECK ("catalog_review_events"."action" in ('submitted', 'duplicate_scan_recorded', 'information_requested', 'information_supplied', 'approved', 'merged_into_existing', 'redirected', 'deferred', 'rejected', 'withdrawn', 'backfill_applied')),
	CONSTRAINT "catalog_review_events_actor_kind_check" CHECK ("catalog_review_events"."actor_kind" in ('submitter', 'operator', 'system')),
	CONSTRAINT "catalog_review_events_from_state_check" CHECK ("catalog_review_events"."from_state" in ('submitted', 'needs_information', 'deferred', 'approved', 'merged', 'redirected', 'rejected', 'withdrawn')),
	CONSTRAINT "catalog_review_events_to_state_check" CHECK ("catalog_review_events"."to_state" in ('submitted', 'needs_information', 'deferred', 'approved', 'merged', 'redirected', 'rejected', 'withdrawn')),
	CONSTRAINT "catalog_review_events_actor_presence_check" CHECK (("catalog_review_events"."actor_kind" = 'system') = ("catalog_review_events"."actor_oxy_user_id" is null))
);
--> statement-breakpoint
ALTER TABLE "catalog_proposal_duplicate_candidates" ADD CONSTRAINT "catalog_proposal_duplicate_candidates_proposal_id_catalog_proposals_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."catalog_proposals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_proposal_references" ADD CONSTRAINT "catalog_proposal_references_proposal_id_catalog_proposals_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."catalog_proposals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_proposal_references" ADD CONSTRAINT "catalog_proposal_references_draft_id_catalog_authoring_drafts_id_fk" FOREIGN KEY ("draft_id") REFERENCES "public"."catalog_authoring_drafts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_proposal_references" ADD CONSTRAINT "catalog_proposal_references_draft_value_id_catalog_authoring_draft_values_id_fk" FOREIGN KEY ("draft_value_id") REFERENCES "public"."catalog_authoring_draft_values"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_proposal_references" ADD CONSTRAINT "catalog_proposal_references_listing_claim_id_native_listing_attribute_claims_id_fk" FOREIGN KEY ("listing_claim_id") REFERENCES "public"."native_listing_attribute_claims"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_proposals" ADD CONSTRAINT "catalog_proposals_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_proposals" ADD CONSTRAINT "catalog_proposals_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_proposals" ADD CONSTRAINT "catalog_proposals_product_type_definition_id_product_type_definitions_id_fk" FOREIGN KEY ("product_type_definition_id") REFERENCES "public"."product_type_definitions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_proposals" ADD CONSTRAINT "catalog_proposals_attribute_definition_id_attribute_definitions_id_fk" FOREIGN KEY ("attribute_definition_id") REFERENCES "public"."attribute_definitions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_proposals" ADD CONSTRAINT "catalog_proposals_redirected_to_proposal_id_catalog_proposals_id_fk" FOREIGN KEY ("redirected_to_proposal_id") REFERENCES "public"."catalog_proposals"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_review_events" ADD CONSTRAINT "catalog_review_events_proposal_id_catalog_proposals_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."catalog_proposals"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "catalog_proposal_duplicate_candidates_key" ON "catalog_proposal_duplicate_candidates" USING btree ("proposal_id","candidate_ref");--> statement-breakpoint
CREATE INDEX "catalog_proposal_duplicate_candidates_proposal_idx" ON "catalog_proposal_duplicate_candidates" USING btree ("proposal_id");--> statement-breakpoint
CREATE UNIQUE INDEX "catalog_proposal_references_draft_value_key" ON "catalog_proposal_references" USING btree ("proposal_id","draft_value_id") WHERE "catalog_proposal_references"."draft_value_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "catalog_proposal_references_listing_claim_key" ON "catalog_proposal_references" USING btree ("proposal_id","listing_claim_id") WHERE "catalog_proposal_references"."listing_claim_id" is not null;--> statement-breakpoint
CREATE INDEX "catalog_proposal_references_pending_idx" ON "catalog_proposal_references" USING btree ("proposal_id","created_at") WHERE "catalog_proposal_references"."backfilled_at" is null;--> statement-breakpoint
CREATE INDEX "catalog_proposal_references_draft_idx" ON "catalog_proposal_references" USING btree ("draft_id") WHERE "catalog_proposal_references"."draft_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "catalog_proposals_open_convergence_key" ON "catalog_proposals" USING btree ("convergence_key") WHERE "catalog_proposals"."state" in ('submitted', 'needs_information', 'deferred');--> statement-breakpoint
CREATE INDEX "catalog_proposals_state_created_at_idx" ON "catalog_proposals" USING btree ("state","created_at");--> statement-breakpoint
CREATE INDEX "catalog_proposals_store_idx" ON "catalog_proposals" USING btree ("store_id","state","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "catalog_proposals_normalized_label_idx" ON "catalog_proposals" USING btree ("type","attribute_definition_id","normalized_label");--> statement-breakpoint
CREATE INDEX "catalog_proposals_search_label_gist_trgm_idx" ON "catalog_proposals" USING gist ("search_label" gist_trgm_ops);--> statement-breakpoint
CREATE INDEX "catalog_proposals_deferred_until_idx" ON "catalog_proposals" USING btree ("deferred_until") WHERE "catalog_proposals"."deferred_until" is not null;--> statement-breakpoint
CREATE INDEX "catalog_review_events_proposal_at_idx" ON "catalog_review_events" USING btree ("proposal_id","at");--> statement-breakpoint
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
