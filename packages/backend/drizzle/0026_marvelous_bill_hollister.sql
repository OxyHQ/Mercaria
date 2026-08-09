-- oxy:deploy-phase=pre
--
-- Merchant → native `Store` linkage (#84, ADR 0002 D4/D9): four new tables, two
-- triggers, no change to anything that already exists.
--
-- WHY `pre`, in full, because the phase is the one thing here that cannot be
-- recovered from by reading the diff: every statement below is ADDITIVE. Four
-- CREATE TABLEs, their constraints, their indexes and two trigger functions on
-- tables this migration itself creates. Nothing is dropped, renamed or narrowed,
-- and no column of any pre-existing table is touched — `stores`, `merchants`,
-- `native_store_links`, `merchant_claims`, `canonical_variants` and `offers` are
-- all referenced and none is altered, which is ADR 0002 D4's "the graph attaches
-- to native tables, never absorbs them" holding one layer further out. So the
-- old image runs happily against the new schema and this applies before the
-- rollout.
--
-- The two triggers at the end are the halves a CHECK constraint cannot express,
-- because both are statements about a TRANSITION rather than about a row.

CREATE TABLE "store_linkage_candidates" (
	"id" text PRIMARY KEY NOT NULL,
	"request_id" text NOT NULL,
	"store_id" text NOT NULL,
	"source" text NOT NULL,
	"evidence_ref" text,
	"disposition" text DEFAULT 'proposed' NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "store_linkage_candidates_source_check" CHECK ("store_linkage_candidates"."source" in ('claimant_named', 'claim_native_store_intent', 'claimant_store_membership', 'claim_verified_domain', 'claim_platform_connection', 'operator')),
	CONSTRAINT "store_linkage_candidates_disposition_check" CHECK ("store_linkage_candidates"."disposition" in ('proposed', 'selected', 'rejected'))
);
--> statement-breakpoint
CREATE TABLE "store_linkage_offer_overlaps" (
	"id" text PRIMARY KEY NOT NULL,
	"request_id" text NOT NULL,
	"merchant_id" text NOT NULL,
	"canonical_variant_id" text NOT NULL,
	"primary_offer_id" text NOT NULL,
	"duplicate_offer_id" text NOT NULL,
	"rule" text NOT NULL,
	"detected_at" timestamp with time zone NOT NULL,
	CONSTRAINT "store_linkage_offer_overlaps_rule_check" CHECK ("store_linkage_offer_overlaps"."rule" in ('native_supersedes_external', 'operated_channel_supersedes_marketplace', 'most_recently_seen', 'lowest_offer_id')),
	CONSTRAINT "store_linkage_offer_overlaps_distinct_check" CHECK ("store_linkage_offer_overlaps"."primary_offer_id" <> "store_linkage_offer_overlaps"."duplicate_offer_id")
);
--> statement-breakpoint
CREATE TABLE "store_linkage_profile_adoptions" (
	"id" text PRIMARY KEY NOT NULL,
	"request_id" text NOT NULL,
	"store_id" text NOT NULL,
	"field" text NOT NULL,
	"source" text NOT NULL,
	"previous_value" text,
	"adopted_value" text NOT NULL,
	"actor_oxy_user_id" text NOT NULL,
	"at" timestamp with time zone NOT NULL,
	CONSTRAINT "store_linkage_profile_adoptions_field_check" CHECK ("store_linkage_profile_adoptions"."field" in ('name', 'description')),
	CONSTRAINT "store_linkage_profile_adoptions_source_check" CHECK ("store_linkage_profile_adoptions"."source" in ('canonical_merchant')),
	CONSTRAINT "store_linkage_profile_adoptions_value_check" CHECK (btrim("store_linkage_profile_adoptions"."adopted_value") <> '')
);
--> statement-breakpoint
CREATE TABLE "store_linkage_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"merchant_id" text NOT NULL,
	"claim_id" text NOT NULL,
	"claimant_oxy_user_id" text NOT NULL,
	"mode" text NOT NULL,
	"state" text DEFAULT 'draft' NOT NULL,
	"step" text DEFAULT 'opened' NOT NULL,
	"requested_store_id" text,
	"resolved_store_id" text,
	"native_store_link_id" text,
	"supersedes_link_id" text,
	"block_reason" text,
	"reason" text NOT NULL,
	"match_state" text,
	"decided_by_oxy_user_id" text,
	"decided_at" timestamp with time zone,
	"decision_reason" text,
	"impact_active_listings" integer DEFAULT 0 NOT NULL,
	"impact_native_offers" integer DEFAULT 0 NOT NULL,
	"impact_external_offers" integer DEFAULT 0 NOT NULL,
	"impact_storefronts" integer DEFAULT 0 NOT NULL,
	"impact_placed_orders" integer DEFAULT 0 NOT NULL,
	"impact_store_members" integer DEFAULT 0 NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"lease_owner" text,
	"lease_until" timestamp with time zone,
	"last_error" text,
	"applied_at" timestamp with time zone,
	"request_key" text GENERATED ALWAYS AS (coalesce("claim_id", '') || '|' || coalesce("mode", '') || '|' ||
              coalesce("requested_store_id", '') || '|' || coalesce("supersedes_link_id", '')) STORED NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "store_linkage_requests_mode_check" CHECK ("store_linkage_requests"."mode" in ('create_store', 'link_existing', 'correct_link', 'unlink')),
	CONSTRAINT "store_linkage_requests_state_check" CHECK ("store_linkage_requests"."state" in ('draft', 'awaiting_review', 'applying', 'applied', 'blocked', 'rejected', 'abandoned')),
	CONSTRAINT "store_linkage_requests_step_check" CHECK ("store_linkage_requests"."step" in ('opened', 'store_ready', 'link_written', 'profile_applied', 'catalog_matching_requested', 'offers_reconciled', 'completed')),
	CONSTRAINT "store_linkage_requests_block_reason_check" CHECK ("store_linkage_requests"."block_reason" in ('store_linked_to_other_merchant', 'merchant_linked_to_other_store', 'claim_not_verified', 'claim_scope_missing', 'multiple_candidates', 'store_permission_missing', 'no_active_link', 'merchant_not_active')),
	CONSTRAINT "store_linkage_requests_match_state_check" CHECK ("store_linkage_requests"."match_state" in ('matched', 'partial', 'matcher_unavailable', 'nothing_to_match')),
	CONSTRAINT "store_linkage_requests_reason_check" CHECK (btrim("store_linkage_requests"."reason") <> ''),
	CONSTRAINT "store_linkage_requests_requested_store_check" CHECK (("store_linkage_requests"."mode" = 'create_store') = ("store_linkage_requests"."requested_store_id" is null)),
	CONSTRAINT "store_linkage_requests_blocked_state_check" CHECK (("store_linkage_requests"."state" = 'blocked') = ("store_linkage_requests"."block_reason" is not null)),
	CONSTRAINT "store_linkage_requests_applied_state_check" CHECK ("store_linkage_requests"."state" <> 'applied'
          or ("store_linkage_requests"."resolved_store_id" is not null and "store_linkage_requests"."applied_at" is not null
              and "store_linkage_requests"."step" = 'completed')),
	CONSTRAINT "store_linkage_requests_applied_link_check" CHECK ("store_linkage_requests"."state" <> 'applied' or "store_linkage_requests"."mode" = 'unlink' or "store_linkage_requests"."native_store_link_id" is not null),
	CONSTRAINT "store_linkage_requests_supersedes_check" CHECK (("store_linkage_requests"."supersedes_link_id" is not null) = ("store_linkage_requests"."mode" in ('correct_link', 'unlink'))),
	CONSTRAINT "store_linkage_requests_resolved_matches_requested_check" CHECK ("store_linkage_requests"."requested_store_id" is null or "store_linkage_requests"."resolved_store_id" is null
          or "store_linkage_requests"."resolved_store_id" = "store_linkage_requests"."requested_store_id"),
	CONSTRAINT "store_linkage_requests_decision_check" CHECK (num_nonnulls("store_linkage_requests"."decided_by_oxy_user_id", "store_linkage_requests"."decided_at") in (0, 2)),
	CONSTRAINT "store_linkage_requests_attempts_check" CHECK ("store_linkage_requests"."attempts" >= 0),
	CONSTRAINT "store_linkage_requests_impact_check" CHECK ("store_linkage_requests"."impact_active_listings" >= 0 and "store_linkage_requests"."impact_native_offers" >= 0
          and "store_linkage_requests"."impact_external_offers" >= 0 and "store_linkage_requests"."impact_storefronts" >= 0
          and "store_linkage_requests"."impact_placed_orders" >= 0 and "store_linkage_requests"."impact_store_members" >= 0),
	CONSTRAINT "store_linkage_requests_last_error_length_check" CHECK ("store_linkage_requests"."last_error" is null or length("store_linkage_requests"."last_error") <= 2000)
);
--> statement-breakpoint
ALTER TABLE "store_linkage_candidates" ADD CONSTRAINT "store_linkage_candidates_request_id_store_linkage_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."store_linkage_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_linkage_candidates" ADD CONSTRAINT "store_linkage_candidates_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_linkage_offer_overlaps" ADD CONSTRAINT "store_linkage_offer_overlaps_request_id_store_linkage_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."store_linkage_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_linkage_offer_overlaps" ADD CONSTRAINT "store_linkage_offer_overlaps_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_linkage_offer_overlaps" ADD CONSTRAINT "store_linkage_offer_overlaps_canonical_variant_id_canonical_variants_id_fk" FOREIGN KEY ("canonical_variant_id") REFERENCES "public"."canonical_variants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_linkage_offer_overlaps" ADD CONSTRAINT "store_linkage_offer_overlaps_primary_offer_id_offers_id_fk" FOREIGN KEY ("primary_offer_id") REFERENCES "public"."offers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_linkage_offer_overlaps" ADD CONSTRAINT "store_linkage_offer_overlaps_duplicate_offer_id_offers_id_fk" FOREIGN KEY ("duplicate_offer_id") REFERENCES "public"."offers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_linkage_profile_adoptions" ADD CONSTRAINT "store_linkage_profile_adoptions_request_id_store_linkage_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."store_linkage_requests"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_linkage_profile_adoptions" ADD CONSTRAINT "store_linkage_profile_adoptions_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_linkage_requests" ADD CONSTRAINT "store_linkage_requests_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_linkage_requests" ADD CONSTRAINT "store_linkage_requests_claim_id_merchant_claims_id_fk" FOREIGN KEY ("claim_id") REFERENCES "public"."merchant_claims"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_linkage_requests" ADD CONSTRAINT "store_linkage_requests_requested_store_id_stores_id_fk" FOREIGN KEY ("requested_store_id") REFERENCES "public"."stores"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_linkage_requests" ADD CONSTRAINT "store_linkage_requests_resolved_store_id_stores_id_fk" FOREIGN KEY ("resolved_store_id") REFERENCES "public"."stores"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_linkage_requests" ADD CONSTRAINT "store_linkage_requests_native_store_link_id_native_store_links_id_fk" FOREIGN KEY ("native_store_link_id") REFERENCES "public"."native_store_links"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_linkage_requests" ADD CONSTRAINT "store_linkage_requests_supersedes_link_id_native_store_links_id_fk" FOREIGN KEY ("supersedes_link_id") REFERENCES "public"."native_store_links"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "store_linkage_candidates_request_store_key" ON "store_linkage_candidates" USING btree ("request_id","store_id");--> statement-breakpoint
CREATE UNIQUE INDEX "store_linkage_candidates_selected_key" ON "store_linkage_candidates" USING btree ("request_id") WHERE "store_linkage_candidates"."disposition" = 'selected';--> statement-breakpoint
CREATE INDEX "store_linkage_candidates_store_idx" ON "store_linkage_candidates" USING btree ("store_id");--> statement-breakpoint
CREATE UNIQUE INDEX "store_linkage_offer_overlaps_request_duplicate_key" ON "store_linkage_offer_overlaps" USING btree ("request_id","duplicate_offer_id");--> statement-breakpoint
CREATE INDEX "store_linkage_offer_overlaps_merchant_idx" ON "store_linkage_offer_overlaps" USING btree ("merchant_id","detected_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "store_linkage_offer_overlaps_variant_idx" ON "store_linkage_offer_overlaps" USING btree ("canonical_variant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "store_linkage_profile_adoptions_request_field_key" ON "store_linkage_profile_adoptions" USING btree ("request_id","field");--> statement-breakpoint
CREATE INDEX "store_linkage_profile_adoptions_store_idx" ON "store_linkage_profile_adoptions" USING btree ("store_id","at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "store_linkage_requests_open_key" ON "store_linkage_requests" USING btree ("request_key") WHERE "store_linkage_requests"."state" in ('draft', 'awaiting_review', 'applying', 'applied');--> statement-breakpoint
CREATE INDEX "store_linkage_requests_merchant_idx" ON "store_linkage_requests" USING btree ("merchant_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "store_linkage_requests_claimant_idx" ON "store_linkage_requests" USING btree ("claimant_oxy_user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "store_linkage_requests_claim_idx" ON "store_linkage_requests" USING btree ("claim_id");--> statement-breakpoint
CREATE INDEX "store_linkage_requests_state_idx" ON "store_linkage_requests" USING btree ("state","created_at");--> statement-breakpoint
CREATE INDEX "store_linkage_requests_resume_idx" ON "store_linkage_requests" USING btree ("lease_until","created_at") WHERE "store_linkage_requests"."state" = 'applying';--> statement-breakpoint
CREATE INDEX "store_linkage_requests_resolved_store_idx" ON "store_linkage_requests" USING btree ("resolved_store_id") WHERE "store_linkage_requests"."resolved_store_id" is not null;--> statement-breakpoint
--
-- ── The generated idempotency key's inputs are IMMUTABLE ──────────────────────
--
-- `store_linkage_requests_open_key` is a partial unique on the GENERATED
-- `request_key`, which is built from `claim_id`, `mode`, `requested_store_id`
-- and `supersedes_link_id`. A generated unique key whose inputs can be edited is
-- not a unique key: an UPDATE that moved any of the four would change the key,
-- release the one the row was holding, and admit the second `create_store`
-- request — and therefore the second STORE, and the second follow target — that
-- issue #84 acceptance 4 exists to refuse. No CHECK can see this, because a
-- CHECK evaluates one row and cannot compare it to its own previous version.
--
-- The same trigger enforces the other transition rule the workflow rests on:
-- `resolved_store_id` moves NULL → a value exactly once and never moves again
-- (the `retail_cost_quote_acceptances.order_id` contract). The service takes it
-- with a compare-and-swap; this is what makes the CAS a guarantee rather than a
-- convention, for a backfill script, a `psql` prompt or a future service that
-- never passes through it.
--
-- `BEFORE`, not `AFTER`, so the exception is raised before the row version is
-- written; SQLSTATE 23514 so a caller can classify it as the constraint failure
-- it is instead of parsing English.
CREATE FUNCTION mercaria_store_linkage_request_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.claim_id IS DISTINCT FROM OLD.claim_id
     OR NEW.mode IS DISTINCT FROM OLD.mode
     OR NEW.merchant_id IS DISTINCT FROM OLD.merchant_id
     OR NEW.requested_store_id IS DISTINCT FROM OLD.requested_store_id
     OR NEW.supersedes_link_id IS DISTINCT FROM OLD.supersedes_link_id THEN
    RAISE EXCEPTION
      'store_linkage_requests identity is immutable: claim_id, mode, merchant_id, '
      'requested_store_id and supersedes_link_id generate the idempotency key and '
      'cannot be edited. Open a new request instead.'
      USING ERRCODE = 'check_violation';
  END IF;

  IF OLD.resolved_store_id IS NOT NULL
     AND NEW.resolved_store_id IS DISTINCT FROM OLD.resolved_store_id THEN
    RAISE EXCEPTION
      'store_linkage_requests.resolved_store_id is write-once: it moves from '
      'NULL to a value exactly once. A different store is a different request.'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER store_linkage_requests_guard
  BEFORE UPDATE ON "store_linkage_requests"
  FOR EACH ROW EXECUTE FUNCTION mercaria_store_linkage_request_guard();--> statement-breakpoint
--
-- ── Profile adoptions are APPEND-ONLY ────────────────────────────────────────
--
-- `previous_value` is the provenance half of issue #84 existing-store rule 3: an
-- adoption that overwrote a store's own name must be able to say what it
-- overwrote. A record of what a value USED to be, which itself can be edited,
-- answers no question anybody would ask it — so the same reasoning that makes
-- `ledger_entries`, `order_fee_snapshots` and `relationship_reviews`
-- append-only applies here, and by the same mechanism rather than by a
-- convention in the repository.
CREATE FUNCTION mercaria_store_linkage_adoption_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'store_linkage_profile_adoptions rows are append-only: % is refused. The '
    'previous value they record is provenance, and provenance that can be '
    'rewritten is not provenance.',
    TG_OP
    USING ERRCODE = 'check_violation';
END;
$$;--> statement-breakpoint
CREATE TRIGGER store_linkage_profile_adoptions_append_only
  BEFORE UPDATE OR DELETE ON "store_linkage_profile_adoptions"
  FOR EACH ROW EXECUTE FUNCTION mercaria_store_linkage_adoption_append_only();
