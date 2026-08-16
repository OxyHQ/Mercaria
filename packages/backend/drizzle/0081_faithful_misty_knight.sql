-- oxy:deploy-phase=pre
--
-- The referral EARNINGS ledger (#145, ADR 0005 "Ledger representability").
--
-- Additive throughout, which is why it is the additive phase:
--   * five new tables;
--   * one new column with a default (`referral_program_controls.payout_enabled`);
--   * five CHECK re-creations, every one a STRICT SUPERSET — the two ledger
--     accounts, the fourth ledger owner type, the four ledger transaction kinds,
--     the ninth referral event subject and thirteen referral event actions. A
--     re-created CHECK that admits everything the old one did breaks no write
--     the serving image performs;
--   * one `CREATE OR REPLACE FUNCTION` that WIDENS an existing trigger rather
--     than narrowing it (it lets a freeze push `hold_until_at` FORWARD, and
--     only forward — ADR 0005 D12's stopped clock).
--
-- ── The hand-written half, and how to put it back ──────────────────────────
--
-- `db:generate` emits no triggers, so everything below the banner near the end
-- of this file is hand-written and must be re-appended verbatim after any
-- regeneration.
--
-- That banner is LINE-ANCHORED and this sentence deliberately does not quote
-- it. A first-occurrence search for a marker whose own explanation names it
-- verbatim lands on the explanation — and doing exactly that duplicated this
-- file's entire body during a rebase, which the migrator caught as
-- `relation already exists`. Match on a line start, or on the last occurrence,
-- never the first.
--
-- After a regeneration, verify: one deploy-phase line (the first line here);
-- five `mercaria_referral_*` functions with four triggers (the fifth is a
-- replacement of #144's, which keeps its own); no bound-parameter placeholder
-- anywhere; and exactly one `CREATE TABLE` per new table.

CREATE TABLE "referral_earning_discrepancies" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"partner_id" text NOT NULL,
	"reward_id" text,
	"payout_batch_id" text,
	"currency" text NOT NULL,
	"expected_minor" bigint NOT NULL,
	"observed_minor" bigint NOT NULL,
	"detail" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"dedupe_key" text NOT NULL,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolved_by_oxy_user_id" text,
	"resolution_note" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "referral_earning_discrepancies_kind_check" CHECK ("referral_earning_discrepancies"."kind" in ('reward_net_disagrees_with_ledger', 'ledger_posting_missing', 'payout_without_ledger_posting', 'paid_reward_without_batch_item', 'batch_total_disagrees_with_items', 'partner_balance_negative_without_liability', 'vested_reward_past_payout_horizon')),
	CONSTRAINT "referral_earning_discrepancies_status_check" CHECK ("referral_earning_discrepancies"."status" in ('open', 'acknowledged', 'resolved')),
	CONSTRAINT "referral_earning_discrepancies_currency_check" CHECK ("referral_earning_discrepancies"."currency" in ('FAIR', 'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF', 'CNY', 'SEK', 'NOK', 'DKK', 'PLN', 'MXN', 'BRL', 'INR', 'NZD', 'ZAR', 'SGD', 'HKD', 'AED')),
	CONSTRAINT "referral_earning_discrepancies_identity_check" CHECK (length("referral_earning_discrepancies"."dedupe_key") > 0 and length("referral_earning_discrepancies"."detail") > 0
          and length("referral_earning_discrepancies"."detail") <= 2000),
	CONSTRAINT "referral_earning_discrepancies_resolution_check" CHECK (("referral_earning_discrepancies"."status" = 'resolved') = ("referral_earning_discrepancies"."resolved_at" is not null)
          and ("referral_earning_discrepancies"."resolved_at" is null
               or ("referral_earning_discrepancies"."resolved_by_oxy_user_id" is not null and "referral_earning_discrepancies"."resolution_note" is not null
                   and length("referral_earning_discrepancies"."resolution_note") > 0))),
	CONSTRAINT "referral_earning_discrepancies_seen_order_check" CHECK ("referral_earning_discrepancies"."last_seen_at" >= "referral_earning_discrepancies"."first_seen_at")
);
--> statement-breakpoint
CREATE TABLE "referral_ledger_postings" (
	"id" text PRIMARY KEY NOT NULL,
	"partner_id" text NOT NULL,
	"kind" text NOT NULL,
	"reward_id" text,
	"adjustment_id" text,
	"payout_batch_id" text,
	"ledger_transaction_id" text NOT NULL,
	"amount_minor" bigint NOT NULL,
	"currency" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "referral_ledger_postings_kind_check" CHECK ("referral_ledger_postings"."kind" in ('reward_accrued', 'reward_reversed', 'payout_settled', 'recovery_received')),
	CONSTRAINT "referral_ledger_postings_currency_check" CHECK ("referral_ledger_postings"."currency" in ('FAIR', 'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF', 'CNY', 'SEK', 'NOK', 'DKK', 'PLN', 'MXN', 'BRL', 'INR', 'NZD', 'ZAR', 'SGD', 'HKD', 'AED')),
	CONSTRAINT "referral_ledger_postings_identity_check" CHECK (length("referral_ledger_postings"."idempotency_key") > 0),
	CONSTRAINT "referral_ledger_postings_amount_check" CHECK ("referral_ledger_postings"."amount_minor" > 0),
	CONSTRAINT "referral_ledger_postings_subject_shape_check" CHECK (("referral_ledger_postings"."kind" = 'reward_accrued' and "referral_ledger_postings"."reward_id" is not null
             and "referral_ledger_postings"."adjustment_id" is null and "referral_ledger_postings"."payout_batch_id" is null)
          or ("referral_ledger_postings"."kind" = 'reward_reversed' and "referral_ledger_postings"."reward_id" is not null
             and "referral_ledger_postings"."adjustment_id" is not null and "referral_ledger_postings"."payout_batch_id" is null)
          or ("referral_ledger_postings"."kind" = 'payout_settled' and "referral_ledger_postings"."payout_batch_id" is not null
             and "referral_ledger_postings"."reward_id" is null and "referral_ledger_postings"."adjustment_id" is null)
          or ("referral_ledger_postings"."kind" = 'recovery_received' and "referral_ledger_postings"."reward_id" is null
             and "referral_ledger_postings"."adjustment_id" is null and "referral_ledger_postings"."payout_batch_id" is null))
);
--> statement-breakpoint
CREATE TABLE "referral_payout_batch_items" (
	"id" text PRIMARY KEY NOT NULL,
	"batch_id" text NOT NULL,
	"reward_id" text NOT NULL,
	"net_amount_minor" bigint NOT NULL,
	"currency" text NOT NULL,
	"released_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "referral_payout_batch_items_currency_check" CHECK ("referral_payout_batch_items"."currency" in ('FAIR', 'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF', 'CNY', 'SEK', 'NOK', 'DKK', 'PLN', 'MXN', 'BRL', 'INR', 'NZD', 'ZAR', 'SGD', 'HKD', 'AED')),
	CONSTRAINT "referral_payout_batch_items_amount_check" CHECK ("referral_payout_batch_items"."net_amount_minor" > 0)
);
--> statement-breakpoint
CREATE TABLE "referral_payout_batches" (
	"id" text PRIMARY KEY NOT NULL,
	"partner_id" text NOT NULL,
	"program_id" text NOT NULL,
	"currency" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"gross_eligible_minor" bigint NOT NULL,
	"withholding_minor" bigint DEFAULT 0 NOT NULL,
	"net_payout_minor" bigint NOT NULL,
	"provider_reference" text,
	"failure_reason" text,
	"failure_detail" text,
	"idempotency_key" text NOT NULL,
	"created_by_oxy_user_id" text NOT NULL,
	"approved_by_oxy_user_id" text,
	"cancelled_by_oxy_user_id" text,
	"approved_at" timestamp with time zone,
	"paid_at" timestamp with time zone,
	"failed_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "referral_payout_batches_status_check" CHECK ("referral_payout_batches"."status" in ('draft', 'approved', 'processing', 'paid', 'failed', 'cancelled')),
	CONSTRAINT "referral_payout_batches_failure_reason_check" CHECK ("referral_payout_batches"."failure_reason" in ('rail_not_configured', 'rail_rejected', 'rail_unavailable', 'beneficiary_not_payable', 'amount_no_longer_payable', 'withholding_not_supported', 'operator_cancelled')),
	CONSTRAINT "referral_payout_batches_currency_check" CHECK ("referral_payout_batches"."currency" in ('FAIR', 'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF', 'CNY', 'SEK', 'NOK', 'DKK', 'PLN', 'MXN', 'BRL', 'INR', 'NZD', 'ZAR', 'SGD', 'HKD', 'AED')),
	CONSTRAINT "referral_payout_batches_identity_check" CHECK (length("referral_payout_batches"."program_id") > 0 and length("referral_payout_batches"."idempotency_key") > 0
          and length("referral_payout_batches"."created_by_oxy_user_id") > 0),
	CONSTRAINT "referral_payout_batches_amounts_check" CHECK ("referral_payout_batches"."gross_eligible_minor" > 0 and "referral_payout_batches"."withholding_minor" >= 0
          and "referral_payout_batches"."net_payout_minor" >= 0
          and "referral_payout_batches"."net_payout_minor" = "referral_payout_batches"."gross_eligible_minor" - "referral_payout_batches"."withholding_minor"),
	CONSTRAINT "referral_payout_batches_four_eyes_check" CHECK ("referral_payout_batches"."approved_by_oxy_user_id" is null
          or "referral_payout_batches"."approved_by_oxy_user_id" <> "referral_payout_batches"."created_by_oxy_user_id"),
	CONSTRAINT "referral_payout_batches_status_times_check" CHECK (("referral_payout_batches"."status" <> 'approved' or ("referral_payout_batches"."approved_at" is not null
              and "referral_payout_batches"."approved_by_oxy_user_id" is not null))
          and ("referral_payout_batches"."status" <> 'processing' or "referral_payout_batches"."approved_at" is not null)
          and ("referral_payout_batches"."status" <> 'paid' or ("referral_payout_batches"."paid_at" is not null
              and "referral_payout_batches"."provider_reference" is not null))
          and ("referral_payout_batches"."status" <> 'failed' or ("referral_payout_batches"."failed_at" is not null
              and "referral_payout_batches"."failure_reason" is not null))
          and ("referral_payout_batches"."status" <> 'cancelled' or ("referral_payout_batches"."cancelled_at" is not null
              and "referral_payout_batches"."cancelled_by_oxy_user_id" is not null
              and "referral_payout_batches"."failure_reason" = 'operator_cancelled'))),
	CONSTRAINT "referral_payout_batches_failure_detail_check" CHECK ("referral_payout_batches"."failure_detail" is null
          or ("referral_payout_batches"."failure_reason" is not null
              and length("referral_payout_batches"."failure_detail") > 0
              and length("referral_payout_batches"."failure_detail") <= 2000))
);
--> statement-breakpoint
CREATE TABLE "referral_reward_transitions" (
	"id" text PRIMARY KEY NOT NULL,
	"reward_id" text NOT NULL,
	"from_state" text NOT NULL,
	"to_state" text NOT NULL,
	"cause" text NOT NULL,
	"actor_kind" text NOT NULL,
	"actor_ref" text,
	"reason" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "referral_reward_transitions_from_state_check" CHECK ("referral_reward_transitions"."from_state" in ('held', 'vested', 'frozen', 'paid', 'voided')),
	CONSTRAINT "referral_reward_transitions_to_state_check" CHECK ("referral_reward_transitions"."to_state" in ('held', 'vested', 'frozen', 'paid', 'voided')),
	CONSTRAINT "referral_reward_transitions_cause_check" CHECK ("referral_reward_transitions"."cause" in ('hold_elapsed', 'frozen_for_review', 'partner_suspended', 'freeze_lifted', 'payout_settled', 'funding_reversed', 'fraud_invalidated', 'budget_invalidated')),
	CONSTRAINT "referral_reward_transitions_actor_kind_check" CHECK ("referral_reward_transitions"."actor_kind" in ('partner', 'operator', 'system')),
	CONSTRAINT "referral_reward_transitions_moves_check" CHECK ("referral_reward_transitions"."from_state" <> "referral_reward_transitions"."to_state"),
	CONSTRAINT "referral_reward_transitions_actor_check" CHECK (("referral_reward_transitions"."actor_kind" = 'system') = ("referral_reward_transitions"."actor_ref" is null)),
	CONSTRAINT "referral_reward_transitions_reason_check" CHECK (length("referral_reward_transitions"."reason") > 0 and length("referral_reward_transitions"."reason") <= 2000
          and length("referral_reward_transitions"."idempotency_key") > 0)
);
--> statement-breakpoint
ALTER TABLE "ledger_entries" DROP CONSTRAINT "ledger_entries_account_check";--> statement-breakpoint
ALTER TABLE "ledger_entries" DROP CONSTRAINT "ledger_entries_owner_type_check";--> statement-breakpoint
ALTER TABLE "ledger_transactions" DROP CONSTRAINT "ledger_transactions_kind_check";--> statement-breakpoint
ALTER TABLE "referral_events" DROP CONSTRAINT "referral_events_subject_type_check";--> statement-breakpoint
ALTER TABLE "referral_events" DROP CONSTRAINT "referral_events_action_check";--> statement-breakpoint
ALTER TABLE "referral_program_controls" ADD COLUMN "payout_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "referral_earning_discrepancies" ADD CONSTRAINT "referral_earning_discrepancies_partner_id_referral_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."referral_partners"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referral_earning_discrepancies" ADD CONSTRAINT "referral_earning_discrepancies_reward_id_referral_rewards_id_fk" FOREIGN KEY ("reward_id") REFERENCES "public"."referral_rewards"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referral_earning_discrepancies" ADD CONSTRAINT "referral_earning_discrepancies_payout_batch_id_referral_payout_batches_id_fk" FOREIGN KEY ("payout_batch_id") REFERENCES "public"."referral_payout_batches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referral_ledger_postings" ADD CONSTRAINT "referral_ledger_postings_partner_id_referral_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."referral_partners"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referral_ledger_postings" ADD CONSTRAINT "referral_ledger_postings_reward_id_referral_rewards_id_fk" FOREIGN KEY ("reward_id") REFERENCES "public"."referral_rewards"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referral_ledger_postings" ADD CONSTRAINT "referral_ledger_postings_adjustment_id_referral_reward_adjustments_id_fk" FOREIGN KEY ("adjustment_id") REFERENCES "public"."referral_reward_adjustments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referral_ledger_postings" ADD CONSTRAINT "referral_ledger_postings_payout_batch_id_referral_payout_batches_id_fk" FOREIGN KEY ("payout_batch_id") REFERENCES "public"."referral_payout_batches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referral_ledger_postings" ADD CONSTRAINT "referral_ledger_postings_ledger_transaction_id_ledger_transactions_id_fk" FOREIGN KEY ("ledger_transaction_id") REFERENCES "public"."ledger_transactions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referral_payout_batch_items" ADD CONSTRAINT "referral_payout_batch_items_batch_id_referral_payout_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."referral_payout_batches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referral_payout_batch_items" ADD CONSTRAINT "referral_payout_batch_items_reward_id_referral_rewards_id_fk" FOREIGN KEY ("reward_id") REFERENCES "public"."referral_rewards"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referral_payout_batches" ADD CONSTRAINT "referral_payout_batches_partner_id_referral_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."referral_partners"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referral_reward_transitions" ADD CONSTRAINT "referral_reward_transitions_reward_id_referral_rewards_id_fk" FOREIGN KEY ("reward_id") REFERENCES "public"."referral_rewards"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "referral_earning_discrepancies_dedupe_key_key" ON "referral_earning_discrepancies" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "referral_earning_discrepancies_status_last_seen_idx" ON "referral_earning_discrepancies" USING btree ("status","last_seen_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "referral_earning_discrepancies_partner_id_idx" ON "referral_earning_discrepancies" USING btree ("partner_id");--> statement-breakpoint
CREATE UNIQUE INDEX "referral_ledger_postings_idempotency_key_key" ON "referral_ledger_postings" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "referral_ledger_postings_partner_occurred_at_idx" ON "referral_ledger_postings" USING btree ("partner_id","occurred_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "referral_ledger_postings_reward_id_idx" ON "referral_ledger_postings" USING btree ("reward_id") WHERE "referral_ledger_postings"."reward_id" is not null;--> statement-breakpoint
CREATE INDEX "referral_ledger_postings_batch_id_idx" ON "referral_ledger_postings" USING btree ("payout_batch_id") WHERE "referral_ledger_postings"."payout_batch_id" is not null;--> statement-breakpoint
CREATE INDEX "referral_ledger_postings_ledger_transaction_id_idx" ON "referral_ledger_postings" USING btree ("ledger_transaction_id");--> statement-breakpoint
CREATE UNIQUE INDEX "referral_payout_batch_items_batch_reward_key" ON "referral_payout_batch_items" USING btree ("batch_id","reward_id");--> statement-breakpoint
CREATE UNIQUE INDEX "referral_payout_batch_items_live_reward_key" ON "referral_payout_batch_items" USING btree ("reward_id") WHERE "referral_payout_batch_items"."released_at" is null;--> statement-breakpoint
CREATE INDEX "referral_payout_batch_items_batch_id_idx" ON "referral_payout_batch_items" USING btree ("batch_id");--> statement-breakpoint
CREATE UNIQUE INDEX "referral_payout_batches_idempotency_key_key" ON "referral_payout_batches" USING btree ("idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "referral_payout_batches_open_key" ON "referral_payout_batches" USING btree ("partner_id","currency") WHERE "referral_payout_batches"."status" in ('draft', 'approved', 'processing', 'failed');--> statement-breakpoint
CREATE INDEX "referral_payout_batches_partner_created_at_idx" ON "referral_payout_batches" USING btree ("partner_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "referral_payout_batches_status_created_at_idx" ON "referral_payout_batches" USING btree ("status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "referral_reward_transitions_idempotency_key_key" ON "referral_reward_transitions" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "referral_reward_transitions_reward_id_idx" ON "referral_reward_transitions" USING btree ("reward_id","occurred_at");--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_account_check" CHECK ("ledger_entries"."account" in ('provider_clearing', 'merchant_payable', 'commission_revenue', 'processor_expense', 'refunds', 'disputes', 'reserves', 'retail_cost_recovery', 'supplier_prepaid', 'platform_funds', 'procurement_expense', 'customer_adjustment', 'subscription_revenue', 'referral_expense', 'referral_payable'));--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_owner_type_check" CHECK ("ledger_entries"."owner_type" in ('store', 'user', 'supplier', 'referral_partner'));--> statement-breakpoint
ALTER TABLE "ledger_transactions" ADD CONSTRAINT "ledger_transactions_kind_check" CHECK ("ledger_transactions"."kind" in ('charge_succeeded', 'transfer_created', 'refund', 'transfer_reversal', 'dispute_created', 'dispute_won', 'dispute_lost', 'subscription_invoice_paid', 'adjustment', 'prefund_top_up', 'procurement_settled', 'retail_variance', 'supplier_credit', 'referral_reward_accrued', 'referral_reward_reversed', 'referral_payout', 'referral_recovery'));--> statement-breakpoint
ALTER TABLE "referral_events" ADD CONSTRAINT "referral_events_subject_type_check" CHECK ("referral_events"."subject_type" in ('program', 'partner', 'code', 'link', 'attribution', 'conversion', 'reward_rule', 'reward', 'payout_batch'));--> statement-breakpoint
ALTER TABLE "referral_events" ADD CONSTRAINT "referral_events_action_check" CHECK ("referral_events"."action" in ('program_drafted', 'program_published', 'program_paused', 'program_resumed', 'program_ended', 'program_retired', 'program_controls_set', 'partner_applied', 'partner_invited', 'partner_approved', 'partner_suspended', 'partner_reinstated', 'partner_terminated', 'appeal_opened', 'appeal_resolved', 'code_issued', 'code_retired', 'link_issued', 'link_revoked', 'attribution_created', 'attribution_superseded', 'attribution_refused', 'attribution_invalidated', 'attribution_corrected', 'subject_merge_redirected', 'conversion_recorded', 'conversion_verified', 'conversion_rejected', 'conversion_reversed', 'conversion_corrected', 'reward_rule_drafted', 'reward_rule_activated', 'reward_rule_superseded', 'reward_rule_retired', 'reward_accrued', 'reward_accrual_refused', 'reward_reversed', 'reward_voided', 'reward_vested', 'reward_frozen', 'reward_unfrozen', 'reward_payout_settled', 'reward_clawback_recorded', 'payout_batch_opened', 'payout_batch_approved', 'payout_batch_settled', 'payout_batch_failed', 'payout_batch_cancelled', 'partner_recovery_recorded', 'earnings_discrepancy_recorded', 'earnings_discrepancy_resolved'));--> statement-breakpoint
-- ===== #145 HAND-WRITTEN TRIGGERS =====
--
-- 1. `referral_ledger_postings` is append-only, against UPDATE and DELETE both.
--    It is the claim that makes a booking idempotent, so a row that could be
--    edited or removed would make a second posting of the same money possible —
--    into a ledger that itself refuses to un-book anything.
CREATE FUNCTION mercaria_referral_ledger_posting_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'referral ledger postings are append-only: % on %.% is refused. A correction is a REVERSING transaction booked through the same repository, never an edit.',
    TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME
    USING ERRCODE = 'check_violation';
END;
$$;--> statement-breakpoint
CREATE TRIGGER referral_ledger_postings_append_only
  BEFORE UPDATE OR DELETE ON "referral_ledger_postings"
  FOR EACH ROW EXECUTE FUNCTION mercaria_referral_ledger_posting_append_only();--> statement-breakpoint

-- 2. The reward state trail is append-only too. "State changes are durable,
--    idempotent and auditable" (#145) is only true if the record of one cannot
--    be rewritten afterwards.
CREATE FUNCTION mercaria_referral_reward_transition_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'referral reward transitions are append-only: % on %.% is refused. A reward that moved back is a FURTHER transition, naming its own cause.',
    TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME
    USING ERRCODE = 'check_violation';
END;
$$;--> statement-breakpoint
CREATE TRIGGER referral_reward_transitions_append_only
  BEFORE UPDATE OR DELETE ON "referral_reward_transitions"
  FOR EACH ROW EXECUTE FUNCTION mercaria_referral_reward_transition_append_only();--> statement-breakpoint

-- 3. A batch ITEM is frozen with ONE precise exception: `released_at` moving
--    NULL -> a value exactly once, which is how a cancelled batch hands its
--    rewards back for a later one. Not "immutable once set", which would still
--    admit a write taking it back to NULL — and that write is precisely how one
--    reward would end up live in two batches.
CREATE FUNCTION mercaria_referral_payout_batch_item_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION
      'referral payout batch item % is never deleted: it is the record of which batch held which reward, which is what makes a duplicate payout detectable.',
      OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR
     NEW.batch_id IS DISTINCT FROM OLD.batch_id OR
     NEW.reward_id IS DISTINCT FROM OLD.reward_id OR
     NEW.net_amount_minor IS DISTINCT FROM OLD.net_amount_minor OR
     NEW.currency IS DISTINCT FROM OLD.currency OR
     NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION
      'referral payout batch item % is frozen: the only permitted update is releasing it. A batch that must pay a different amount is a NEW batch, approved by somebody.',
      OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.released_at IS NOT NULL OR NEW.released_at IS NULL THEN
    RAISE EXCEPTION
      'referral payout batch item % may be released exactly once: % -> % is refused. Taking a release back would put one reward in two live batches.',
      OLD.id, OLD.released_at, NEW.released_at
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER referral_payout_batch_items_guard
  BEFORE UPDATE OR DELETE ON "referral_payout_batch_items"
  FOR EACH ROW EXECUTE FUNCTION mercaria_referral_payout_batch_item_guard();--> statement-breakpoint

-- 4. A batch's IDENTITY and its AMOUNTS are frozen once it exists, and it is
--    never deleted. The status machine, the provider reference and the failure
--    pair are what move; the figure an operator approved is not. That is #59's
--    ruling ("the set an operator approved is the set that executes") as a
--    trigger, and it is why the settlement FAILS on a shrunken payable set
--    rather than quietly paying less.
--
--    The five stamps are write-once, so a second approval or a second
--    settlement cannot rewrite who did it or when.
CREATE FUNCTION mercaria_referral_payout_batch_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION
      'referral payout batch % is never deleted: it is the record of money Mercaria paid a partner. Cancel it, which releases its claims and leaves the trail.',
      OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR
     NEW.partner_id IS DISTINCT FROM OLD.partner_id OR
     NEW.program_id IS DISTINCT FROM OLD.program_id OR
     NEW.currency IS DISTINCT FROM OLD.currency OR
     NEW.gross_eligible_minor IS DISTINCT FROM OLD.gross_eligible_minor OR
     NEW.withholding_minor IS DISTINCT FROM OLD.withholding_minor OR
     NEW.net_payout_minor IS DISTINCT FROM OLD.net_payout_minor OR
     NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key OR
     NEW.created_by_oxy_user_id IS DISTINCT FROM OLD.created_by_oxy_user_id OR
     NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION
      'referral payout batch % is frozen on its identity and its amounts: % is refused. A different figure is a NEW batch, approved by somebody.',
      OLD.id, TG_OP
      USING ERRCODE = 'check_violation';
  END IF;
  IF (OLD.approved_at IS NOT NULL AND NEW.approved_at IS DISTINCT FROM OLD.approved_at) OR
     (OLD.approved_by_oxy_user_id IS NOT NULL
        AND NEW.approved_by_oxy_user_id IS DISTINCT FROM OLD.approved_by_oxy_user_id) OR
     (OLD.paid_at IS NOT NULL AND NEW.paid_at IS DISTINCT FROM OLD.paid_at) OR
     (OLD.cancelled_at IS NOT NULL AND NEW.cancelled_at IS DISTINCT FROM OLD.cancelled_at) OR
     (OLD.provider_reference IS NOT NULL
        AND NEW.provider_reference IS DISTINCT FROM OLD.provider_reference)
  THEN
    RAISE EXCEPTION
      'referral payout batch % has stamps that are written once: an approval, a settlement and a cancellation each happen at one moment, by one actor, against one provider reference.',
      OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER referral_payout_batches_guard
  BEFORE UPDATE OR DELETE ON "referral_payout_batches"
  FOR EACH ROW EXECUTE FUNCTION mercaria_referral_payout_batch_guard();--> statement-breakpoint

-- 5. WIDEN #144's reward guard so a freeze can stop the hold clock.
--
--    ADR 0005 D12: "a freeze stops the hold clock; vesting requires 60 (or 30)
--    elapsed UNFROZEN days". Lifting a freeze therefore pushes `hold_until_at`
--    forward by exactly the frozen duration, and #144's trigger pinned that
--    column outright. `CREATE OR REPLACE` rather than a second trigger (#106's
--    device), and FORWARD ONLY: the backwards direction is the one that would
--    vest a reward early, which is what the pin was protecting.
--
--    Every other clause is #144's, verbatim.
CREATE OR REPLACE FUNCTION mercaria_referral_reward_frozen() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION
      'referral reward % is never deleted: a historical reward row is the record of money Mercaria owed. A reversal is an append-only adjustment, not a deletion.',
      OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR
     NEW.conversion_id IS DISTINCT FROM OLD.conversion_id OR
     NEW.attribution_id IS DISTINCT FROM OLD.attribution_id OR
     NEW.partner_id IS DISTINCT FROM OLD.partner_id OR
     NEW.program_version_id IS DISTINCT FROM OLD.program_version_id OR
     NEW.rule_version_id IS DISTINCT FROM OLD.rule_version_id OR
     NEW.funding_source_id IS DISTINCT FROM OLD.funding_source_id OR
     NEW.funding_record_ref IS DISTINCT FROM OLD.funding_record_ref OR
     NEW.funding_record_version IS DISTINCT FROM OLD.funding_record_version OR
     NEW.funding_amount_minor IS DISTINCT FROM OLD.funding_amount_minor OR
     NEW.funding_observed_at IS DISTINCT FROM OLD.funding_observed_at OR
     NEW.campaign_budget_id IS DISTINCT FROM OLD.campaign_budget_id OR
     NEW.gross_amount_minor IS DISTINCT FROM OLD.gross_amount_minor OR
     NEW.currency IS DISTINCT FROM OLD.currency OR
     NEW.accrued_at IS DISTINCT FROM OLD.accrued_at OR
     NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION
      'referral reward % is pinned to one immutable rule version and one funding record: % is refused. A rule change is a new version and a base change is an adjustment row.',
      OLD.id, TG_OP
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.hold_until_at < OLD.hold_until_at THEN
    RAISE EXCEPTION
      'referral reward % cannot vest earlier: hold_until_at % -> %. A freeze may push the deadline FORWARD (ADR 0005 D12 stops the clock); nothing may pull it back.',
      OLD.id, OLD.hold_until_at, NEW.hold_until_at
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.net_amount_minor > OLD.net_amount_minor THEN
    RAISE EXCEPTION
      'referral reward % cannot grow: net % -> %. A reward is a bounded fraction of funding already realized, and every adjustment only ever reduces it.',
      OLD.id, OLD.net_amount_minor, NEW.net_amount_minor
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
