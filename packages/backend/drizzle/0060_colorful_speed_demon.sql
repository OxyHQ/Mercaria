-- oxy:deploy-phase=pre
-- oxy:rollback=restore: referral_events_subject_type_check and referral_events_action_check are widened; the previous forms are in 0015 and re-adding either fails against any event carrying an added subject type or action
--
-- Versioned referral reward rules, campaign budgets, rewards and their
-- append-only reversals (#144, under ADR 0005).
--
-- Purely ADDITIVE. Four new tables, and two WIDENINGS of the `referral_events`
-- CHECKs for the eight reward actions and two reward subject types #144 appends
-- to the domain's one audit trail — each a drop-and-re-add whose new tuple is a
-- strict SUPERSET of the old, so every write the serving image performs still
-- passes and no existing row is invalidated.
--
-- Nothing here narrows, renames or drops, which is why it is `pre`: the image
-- that applies it can be the one running before the deploy.
--
-- ## The hand-written block at the end
--
-- Four trigger pairs `drizzle-kit` cannot model, and every one of them is a
-- rule #144 states as a requirement rather than a preference. A regeneration
-- DROPS them: re-apply this whole block and grep the regenerated file for each
-- `CREATE FUNCTION` / `CREATE TRIGGER` pair and for exactly one
-- `-- oxy:deploy-phase=` line.
--
--  1. `referral_reward_rules` is immutable once it leaves `draft` — the
--     `fee_schedules` device, and what makes "no rule version can be edited
--     after activation" hold against a migration and against `psql`.
--  2. `referral_rewards` freezes its identity and its funding snapshot, refuses
--     DELETE outright, and refuses a net that GROWS — "historical reward rows
--     are never deleted" and "net monotonically decreases", both structural.
--  3. `referral_reward_adjustments` is append-only against UPDATE and DELETE.
--  4. `referral_campaign_budgets` freezes its identity and admits only a budget
--     that grows: cutting a campaign is `status = 'closed'`, which is
--     prospective, where a shrink would be retroactive and could strand claims
--     already made.

CREATE TABLE "referral_campaign_budgets" (
	"id" text PRIMARY KEY NOT NULL,
	"program_id" text NOT NULL,
	"campaign_ref" text NOT NULL,
	"name" text NOT NULL,
	"currency" text NOT NULL,
	"budget_minor" bigint NOT NULL,
	"claimed_minor" bigint DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"created_by_oxy_user_id" text NOT NULL,
	"closed_at" timestamp with time zone,
	"invalidated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "referral_campaign_budgets_status_check" CHECK ("referral_campaign_budgets"."status" in ('open', 'exhausted', 'closed', 'invalidated')),
	CONSTRAINT "referral_campaign_budgets_currency_check" CHECK ("referral_campaign_budgets"."currency" in ('FAIR', 'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF', 'CNY', 'SEK', 'NOK', 'DKK', 'PLN', 'MXN', 'BRL', 'INR', 'NZD', 'ZAR', 'SGD', 'HKD', 'AED')),
	CONSTRAINT "referral_campaign_budgets_identity_check" CHECK (length("referral_campaign_budgets"."program_id") > 0 and length("referral_campaign_budgets"."campaign_ref") > 0 and length("referral_campaign_budgets"."name") > 0
          and length("referral_campaign_budgets"."created_by_oxy_user_id") > 0),
	CONSTRAINT "referral_campaign_budgets_amounts_check" CHECK ("referral_campaign_budgets"."budget_minor" > 0 and "referral_campaign_budgets"."claimed_minor" >= 0 and "referral_campaign_budgets"."claimed_minor" <= "referral_campaign_budgets"."budget_minor"),
	CONSTRAINT "referral_campaign_budgets_status_times_check" CHECK (("referral_campaign_budgets"."status" <> 'closed' or "referral_campaign_budgets"."closed_at" is not null)
          and ("referral_campaign_budgets"."status" <> 'invalidated' or "referral_campaign_budgets"."invalidated_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "referral_reward_adjustments" (
	"id" text PRIMARY KEY NOT NULL,
	"reward_id" text NOT NULL,
	"cause" text NOT NULL,
	"source_ref" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"delta_amount_minor" bigint NOT NULL,
	"resulting_net_minor" bigint NOT NULL,
	"observed_funding_amount_minor" bigint NOT NULL,
	"currency" text NOT NULL,
	"recovery_state" text NOT NULL,
	"liability_amount_minor" bigint DEFAULT 0 NOT NULL,
	"reason" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "referral_reward_adjustments_cause_check" CHECK ("referral_reward_adjustments"."cause" in ('order_partially_refunded', 'order_fully_refunded', 'dispute_lost', 'affiliate_commission_reversed', 'subscription_revenue_reversed', 'fraud_invalidation', 'invalid_budget_allocation')),
	CONSTRAINT "referral_reward_adjustments_recovery_state_check" CHECK ("referral_reward_adjustments"."recovery_state" in ('not_applicable', 'offset_against_balance', 'partner_liability')),
	CONSTRAINT "referral_reward_adjustments_currency_check" CHECK ("referral_reward_adjustments"."currency" in ('FAIR', 'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF', 'CNY', 'SEK', 'NOK', 'DKK', 'PLN', 'MXN', 'BRL', 'INR', 'NZD', 'ZAR', 'SGD', 'HKD', 'AED')),
	CONSTRAINT "referral_reward_adjustments_identity_check" CHECK (length("referral_reward_adjustments"."source_ref") > 0 and length("referral_reward_adjustments"."idempotency_key") > 0),
	CONSTRAINT "referral_reward_adjustments_reason_check" CHECK (length("referral_reward_adjustments"."reason") > 0 and length("referral_reward_adjustments"."reason") <= 2000),
	CONSTRAINT "referral_reward_adjustments_amounts_check" CHECK ("referral_reward_adjustments"."delta_amount_minor" <= 0 and "referral_reward_adjustments"."resulting_net_minor" >= 0
          and "referral_reward_adjustments"."observed_funding_amount_minor" >= 0 and "referral_reward_adjustments"."liability_amount_minor" >= 0),
	CONSTRAINT "referral_reward_adjustments_liability_check" CHECK (("referral_reward_adjustments"."recovery_state" = 'partner_liability') = ("referral_reward_adjustments"."liability_amount_minor" > 0)),
	CONSTRAINT "referral_reward_adjustments_no_op_check" CHECK (("referral_reward_adjustments"."recovery_state" = 'not_applicable') = ("referral_reward_adjustments"."delta_amount_minor" = 0))
);
--> statement-breakpoint
CREATE TABLE "referral_reward_rules" (
	"id" text PRIMARY KEY NOT NULL,
	"rule_id" text NOT NULL,
	"version" integer NOT NULL,
	"name" text NOT NULL,
	"program_id" text NOT NULL,
	"campaign_ref" text,
	"conversion_type" text NOT NULL,
	"funding_source_id" text NOT NULL,
	"formula" text NOT NULL,
	"rate_bps" integer,
	"fixed_amount_minor" bigint,
	"currency_mode" text NOT NULL,
	"reward_currency" text,
	"effective_start_at" timestamp with time zone NOT NULL,
	"effective_end_at" timestamp with time zone,
	"hold_policy_ref" text NOT NULL,
	"hold_days" integer NOT NULL,
	"min_accrual_minor" bigint,
	"max_reward_per_conversion_minor" bigint,
	"max_reward_per_partner_period_minor" bigint,
	"partner_cap_period" text,
	"max_reward_per_campaign_minor" bigint,
	"reversal_policy" text NOT NULL,
	"terms_version" text NOT NULL,
	"created_by_oxy_user_id" text NOT NULL,
	"approved_by_oxy_user_id" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"activated_at" timestamp with time zone,
	"superseded_at" timestamp with time zone,
	"retired_at" timestamp with time zone,
	"supersedes_rule_version_id" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "referral_reward_rules_conversion_type_check" CHECK ("referral_reward_rules"."conversion_type" in ('first_qualifying_paid_order', 'merchant_activation')),
	CONSTRAINT "referral_reward_rules_funding_source_id_check" CHECK ("referral_reward_rules"."funding_source_id" in ('connected_marketplace', 'affiliate', 'subscription', 'fixed_budget')),
	CONSTRAINT "referral_reward_rules_formula_check" CHECK ("referral_reward_rules"."formula" in ('percentage_of_realized_base', 'fixed_amount')),
	CONSTRAINT "referral_reward_rules_currency_mode_check" CHECK ("referral_reward_rules"."currency_mode" in ('funding_currency', 'fixed_currency')),
	CONSTRAINT "referral_reward_rules_partner_cap_period_check" CHECK ("referral_reward_rules"."partner_cap_period" in ('day', 'week', 'month', 'lifetime')),
	CONSTRAINT "referral_reward_rules_reversal_policy_check" CHECK ("referral_reward_rules"."reversal_policy" in ('proportional_to_realized_base', 'void_on_funding_reversal', 'fraud_only')),
	CONSTRAINT "referral_reward_rules_status_check" CHECK ("referral_reward_rules"."status" in ('draft', 'active', 'superseded', 'retired')),
	CONSTRAINT "referral_reward_rules_reward_currency_check" CHECK ("referral_reward_rules"."reward_currency" in ('FAIR', 'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF', 'CNY', 'SEK', 'NOK', 'DKK', 'PLN', 'MXN', 'BRL', 'INR', 'NZD', 'ZAR', 'SGD', 'HKD', 'AED')),
	CONSTRAINT "referral_reward_rules_identity_check" CHECK (length("referral_reward_rules"."rule_id") > 0 and "referral_reward_rules"."version" >= 1 and length("referral_reward_rules"."name") > 0
          and length("referral_reward_rules"."program_id") > 0 and length("referral_reward_rules"."hold_policy_ref") > 0
          and length("referral_reward_rules"."terms_version") > 0 and length("referral_reward_rules"."created_by_oxy_user_id") > 0
          and ("referral_reward_rules"."campaign_ref" is null or length("referral_reward_rules"."campaign_ref") > 0)),
	CONSTRAINT "referral_reward_rules_formula_shape_check" CHECK (("referral_reward_rules"."formula" = 'percentage_of_realized_base') = ("referral_reward_rules"."rate_bps" is not null)
          and ("referral_reward_rules"."formula" = 'fixed_amount') = ("referral_reward_rules"."fixed_amount_minor" is not null)),
	CONSTRAINT "referral_reward_rules_rate_check" CHECK ("referral_reward_rules"."rate_bps" is null
          or ("referral_reward_rules"."rate_bps" > 0 and "referral_reward_rules"."rate_bps" <= 10000)),
	CONSTRAINT "referral_reward_rules_amounts_positive_check" CHECK (("referral_reward_rules"."fixed_amount_minor" is null or "referral_reward_rules"."fixed_amount_minor" > 0)
          and ("referral_reward_rules"."min_accrual_minor" is null or "referral_reward_rules"."min_accrual_minor" > 0)
          and ("referral_reward_rules"."max_reward_per_conversion_minor" is null or "referral_reward_rules"."max_reward_per_conversion_minor" > 0)
          and ("referral_reward_rules"."max_reward_per_partner_period_minor" is null
               or "referral_reward_rules"."max_reward_per_partner_period_minor" > 0)
          and ("referral_reward_rules"."max_reward_per_campaign_minor" is null or "referral_reward_rules"."max_reward_per_campaign_minor" > 0)),
	CONSTRAINT "referral_reward_rules_currency_pin_check" CHECK (("referral_reward_rules"."currency_mode" = 'fixed_currency') = ("referral_reward_rules"."reward_currency" is not null)),
	CONSTRAINT "referral_reward_rules_amount_currency_check" CHECK ("referral_reward_rules"."reward_currency" is not null
          or ("referral_reward_rules"."fixed_amount_minor" is null and "referral_reward_rules"."min_accrual_minor" is null
              and "referral_reward_rules"."max_reward_per_conversion_minor" is null
              and "referral_reward_rules"."max_reward_per_partner_period_minor" is null
              and "referral_reward_rules"."max_reward_per_campaign_minor" is null)),
	CONSTRAINT "referral_reward_rules_partner_cap_check" CHECK (("referral_reward_rules"."max_reward_per_partner_period_minor" is null) = ("referral_reward_rules"."partner_cap_period" is null)),
	CONSTRAINT "referral_reward_rules_campaign_cap_check" CHECK ("referral_reward_rules"."max_reward_per_campaign_minor" is null or "referral_reward_rules"."campaign_ref" is not null),
	CONSTRAINT "referral_reward_rules_budget_shape_check" CHECK ("referral_reward_rules"."funding_source_id" <> 'fixed_budget'
          or ("referral_reward_rules"."formula" = 'fixed_amount' and "referral_reward_rules"."campaign_ref" is not null)),
	CONSTRAINT "referral_reward_rules_hold_check" CHECK ("referral_reward_rules"."hold_days" >= 0),
	CONSTRAINT "referral_reward_rules_effective_window_check" CHECK ("referral_reward_rules"."effective_end_at" is null or "referral_reward_rules"."effective_end_at" > "referral_reward_rules"."effective_start_at"),
	CONSTRAINT "referral_reward_rules_activation_check" CHECK ("referral_reward_rules"."status" = 'draft'
          or ("referral_reward_rules"."approved_by_oxy_user_id" is not null and "referral_reward_rules"."activated_at" is not null)),
	CONSTRAINT "referral_reward_rules_status_times_check" CHECK (("referral_reward_rules"."status" <> 'superseded' or "referral_reward_rules"."superseded_at" is not null)
          and ("referral_reward_rules"."status" <> 'retired' or "referral_reward_rules"."retired_at" is not null)),
	CONSTRAINT "referral_reward_rules_supersedes_check" CHECK ("referral_reward_rules"."supersedes_rule_version_id" is null or "referral_reward_rules"."supersedes_rule_version_id" <> "referral_reward_rules"."id")
);
--> statement-breakpoint
CREATE TABLE "referral_rewards" (
	"id" text PRIMARY KEY NOT NULL,
	"conversion_id" text NOT NULL,
	"attribution_id" text NOT NULL,
	"partner_id" text NOT NULL,
	"program_version_id" text NOT NULL,
	"rule_version_id" text NOT NULL,
	"funding_source_id" text NOT NULL,
	"funding_record_ref" text NOT NULL,
	"funding_record_version" text NOT NULL,
	"funding_amount_minor" bigint NOT NULL,
	"funding_observed_at" timestamp with time zone NOT NULL,
	"campaign_budget_id" text,
	"gross_amount_minor" bigint NOT NULL,
	"net_amount_minor" bigint NOT NULL,
	"currency" text NOT NULL,
	"state" text DEFAULT 'held' NOT NULL,
	"hold_until_at" timestamp with time zone NOT NULL,
	"frozen_from_state" text,
	"accrued_at" timestamp with time zone NOT NULL,
	"vested_at" timestamp with time zone,
	"frozen_at" timestamp with time zone,
	"paid_at" timestamp with time zone,
	"voided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "referral_rewards_funding_source_id_check" CHECK ("referral_rewards"."funding_source_id" in ('connected_marketplace', 'affiliate', 'subscription', 'fixed_budget')),
	CONSTRAINT "referral_rewards_state_check" CHECK ("referral_rewards"."state" in ('held', 'vested', 'frozen', 'paid', 'voided')),
	CONSTRAINT "referral_rewards_frozen_from_state_check" CHECK ("referral_rewards"."frozen_from_state" in ('held', 'vested')),
	CONSTRAINT "referral_rewards_currency_check" CHECK ("referral_rewards"."currency" in ('FAIR', 'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF', 'CNY', 'SEK', 'NOK', 'DKK', 'PLN', 'MXN', 'BRL', 'INR', 'NZD', 'ZAR', 'SGD', 'HKD', 'AED')),
	CONSTRAINT "referral_rewards_identity_check" CHECK (length("referral_rewards"."funding_record_ref") > 0 and length("referral_rewards"."funding_record_version") > 0),
	CONSTRAINT "referral_rewards_amounts_check" CHECK ("referral_rewards"."gross_amount_minor" > 0 and "referral_rewards"."net_amount_minor" >= 0
          and "referral_rewards"."net_amount_minor" <= "referral_rewards"."gross_amount_minor"),
	CONSTRAINT "referral_rewards_funding_bound_check" CHECK ("referral_rewards"."funding_amount_minor" >= 0 and "referral_rewards"."gross_amount_minor" <= "referral_rewards"."funding_amount_minor"),
	CONSTRAINT "referral_rewards_budget_link_check" CHECK (("referral_rewards"."funding_source_id" = 'fixed_budget') = ("referral_rewards"."campaign_budget_id" is not null)),
	CONSTRAINT "referral_rewards_frozen_check" CHECK ((("referral_rewards"."state" = 'frozen') = ("referral_rewards"."frozen_from_state" is not null))
          and ("referral_rewards"."state" <> 'frozen' or "referral_rewards"."frozen_at" is not null)),
	CONSTRAINT "referral_rewards_state_times_check" CHECK (("referral_rewards"."state" <> 'vested' or "referral_rewards"."vested_at" is not null)
          and ("referral_rewards"."state" <> 'paid' or "referral_rewards"."paid_at" is not null)
          and ("referral_rewards"."state" <> 'voided' or "referral_rewards"."voided_at" is not null)),
	CONSTRAINT "referral_rewards_void_net_check" CHECK ("referral_rewards"."state" <> 'voided' or "referral_rewards"."net_amount_minor" = 0),
	CONSTRAINT "referral_rewards_hold_check" CHECK ("referral_rewards"."hold_until_at" >= "referral_rewards"."accrued_at")
);
--> statement-breakpoint
ALTER TABLE "referral_events" DROP CONSTRAINT "referral_events_subject_type_check";--> statement-breakpoint
ALTER TABLE "referral_events" DROP CONSTRAINT "referral_events_action_check";--> statement-breakpoint
ALTER TABLE "referral_reward_adjustments" ADD CONSTRAINT "referral_reward_adjustments_reward_id_referral_rewards_id_fk" FOREIGN KEY ("reward_id") REFERENCES "public"."referral_rewards"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referral_reward_rules" ADD CONSTRAINT "referral_reward_rules_supersedes_rule_version_id_referral_reward_rules_id_fk" FOREIGN KEY ("supersedes_rule_version_id") REFERENCES "public"."referral_reward_rules"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referral_rewards" ADD CONSTRAINT "referral_rewards_conversion_id_referral_conversions_id_fk" FOREIGN KEY ("conversion_id") REFERENCES "public"."referral_conversions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referral_rewards" ADD CONSTRAINT "referral_rewards_attribution_id_referral_attributions_id_fk" FOREIGN KEY ("attribution_id") REFERENCES "public"."referral_attributions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referral_rewards" ADD CONSTRAINT "referral_rewards_partner_id_referral_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."referral_partners"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referral_rewards" ADD CONSTRAINT "referral_rewards_program_version_id_referral_programs_id_fk" FOREIGN KEY ("program_version_id") REFERENCES "public"."referral_programs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referral_rewards" ADD CONSTRAINT "referral_rewards_rule_version_id_referral_reward_rules_id_fk" FOREIGN KEY ("rule_version_id") REFERENCES "public"."referral_reward_rules"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referral_rewards" ADD CONSTRAINT "referral_rewards_campaign_budget_id_referral_campaign_budgets_id_fk" FOREIGN KEY ("campaign_budget_id") REFERENCES "public"."referral_campaign_budgets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "referral_campaign_budgets_campaign_key" ON "referral_campaign_budgets" USING btree ("program_id","campaign_ref");--> statement-breakpoint
CREATE INDEX "referral_campaign_budgets_status_idx" ON "referral_campaign_budgets" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "referral_reward_adjustments_idempotency_key_key" ON "referral_reward_adjustments" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "referral_reward_adjustments_reward_id_idx" ON "referral_reward_adjustments" USING btree ("reward_id","created_at");--> statement-breakpoint
CREATE INDEX "referral_reward_adjustments_recovery_state_idx" ON "referral_reward_adjustments" USING btree ("recovery_state","created_at") WHERE "referral_reward_adjustments"."recovery_state" = 'partner_liability';--> statement-breakpoint
CREATE UNIQUE INDEX "referral_reward_rules_rule_id_version_key" ON "referral_reward_rules" USING btree ("rule_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "referral_reward_rules_one_active_key" ON "referral_reward_rules" USING btree ("rule_id") WHERE "referral_reward_rules"."status" = 'active';--> statement-breakpoint
CREATE INDEX "referral_reward_rules_program_id_idx" ON "referral_reward_rules" USING btree ("program_id","status");--> statement-breakpoint
CREATE INDEX "referral_reward_rules_campaign_ref_idx" ON "referral_reward_rules" USING btree ("campaign_ref") WHERE "referral_reward_rules"."campaign_ref" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "referral_rewards_conversion_id_key" ON "referral_rewards" USING btree ("conversion_id");--> statement-breakpoint
CREATE INDEX "referral_rewards_partner_id_accrued_at_idx" ON "referral_rewards" USING btree ("partner_id","accrued_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "referral_rewards_rule_version_id_idx" ON "referral_rewards" USING btree ("rule_version_id");--> statement-breakpoint
CREATE INDEX "referral_rewards_attribution_id_idx" ON "referral_rewards" USING btree ("attribution_id");--> statement-breakpoint
CREATE INDEX "referral_rewards_state_hold_until_idx" ON "referral_rewards" USING btree ("state","hold_until_at");--> statement-breakpoint
CREATE INDEX "referral_rewards_funding_record_idx" ON "referral_rewards" USING btree ("funding_source_id","funding_record_ref");--> statement-breakpoint
ALTER TABLE "referral_events" ADD CONSTRAINT "referral_events_subject_type_check" CHECK ("referral_events"."subject_type" in ('program', 'partner', 'code', 'link', 'attribution', 'conversion', 'reward_rule', 'reward'));--> statement-breakpoint
ALTER TABLE "referral_events" ADD CONSTRAINT "referral_events_action_check" CHECK ("referral_events"."action" in ('program_drafted', 'program_published', 'program_paused', 'program_resumed', 'program_ended', 'program_retired', 'partner_applied', 'partner_invited', 'partner_approved', 'partner_suspended', 'partner_reinstated', 'partner_terminated', 'appeal_opened', 'appeal_resolved', 'code_issued', 'code_retired', 'link_issued', 'link_revoked', 'attribution_created', 'attribution_superseded', 'attribution_refused', 'attribution_invalidated', 'attribution_corrected', 'subject_merge_redirected', 'conversion_recorded', 'conversion_verified', 'conversion_rejected', 'conversion_reversed', 'conversion_corrected', 'reward_rule_drafted', 'reward_rule_activated', 'reward_rule_superseded', 'reward_rule_retired', 'reward_accrued', 'reward_accrual_refused', 'reward_reversed', 'reward_voided'));--> statement-breakpoint
-- ─── HAND-WRITTEN BLOCK — see the header. A regeneration drops all of it. ────

-- 1. A rule version's terms are immutable once it leaves `draft`. The status
--    lifecycle columns stay writable, because ending and retiring a version are
--    exactly the transitions that must remain possible after activation.
CREATE FUNCTION mercaria_referral_reward_rule_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN
      RAISE EXCEPTION
        'referral reward rule %@v% is %, not draft: a published rule version is never deleted, because rewards were accrued under it. Retire it, or publish a new version.',
        OLD.rule_id, OLD.version, OLD.status
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.status <> 'draft' AND (
    NEW.id IS DISTINCT FROM OLD.id OR
    NEW.rule_id IS DISTINCT FROM OLD.rule_id OR
    NEW.version IS DISTINCT FROM OLD.version OR
    NEW.name IS DISTINCT FROM OLD.name OR
    NEW.program_id IS DISTINCT FROM OLD.program_id OR
    NEW.campaign_ref IS DISTINCT FROM OLD.campaign_ref OR
    NEW.conversion_type IS DISTINCT FROM OLD.conversion_type OR
    NEW.funding_source_id IS DISTINCT FROM OLD.funding_source_id OR
    NEW.formula IS DISTINCT FROM OLD.formula OR
    NEW.rate_bps IS DISTINCT FROM OLD.rate_bps OR
    NEW.fixed_amount_minor IS DISTINCT FROM OLD.fixed_amount_minor OR
    NEW.currency_mode IS DISTINCT FROM OLD.currency_mode OR
    NEW.reward_currency IS DISTINCT FROM OLD.reward_currency OR
    NEW.effective_start_at IS DISTINCT FROM OLD.effective_start_at OR
    NEW.effective_end_at IS DISTINCT FROM OLD.effective_end_at OR
    NEW.hold_policy_ref IS DISTINCT FROM OLD.hold_policy_ref OR
    NEW.hold_days IS DISTINCT FROM OLD.hold_days OR
    NEW.min_accrual_minor IS DISTINCT FROM OLD.min_accrual_minor OR
    NEW.max_reward_per_conversion_minor IS DISTINCT FROM OLD.max_reward_per_conversion_minor OR
    NEW.max_reward_per_partner_period_minor IS DISTINCT FROM OLD.max_reward_per_partner_period_minor OR
    NEW.partner_cap_period IS DISTINCT FROM OLD.partner_cap_period OR
    NEW.max_reward_per_campaign_minor IS DISTINCT FROM OLD.max_reward_per_campaign_minor OR
    NEW.reversal_policy IS DISTINCT FROM OLD.reversal_policy OR
    NEW.terms_version IS DISTINCT FROM OLD.terms_version OR
    NEW.created_by_oxy_user_id IS DISTINCT FROM OLD.created_by_oxy_user_id OR
    NEW.approved_by_oxy_user_id IS DISTINCT FROM OLD.approved_by_oxy_user_id OR
    NEW.activated_at IS DISTINCT FROM OLD.activated_at OR
    NEW.supersedes_rule_version_id IS DISTINCT FROM OLD.supersedes_rule_version_id OR
    NEW.created_at IS DISTINCT FROM OLD.created_at
  ) THEN
    RAISE EXCEPTION
      'referral reward rule %@v% is %, not draft: its terms are immutable, and rewards already point at this exact version. Publish a new version instead of editing this one.',
      OLD.rule_id, OLD.version, OLD.status
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER referral_reward_rules_immutable_once_active
  BEFORE UPDATE OR DELETE ON "referral_reward_rules"
  FOR EACH ROW EXECUTE FUNCTION mercaria_referral_reward_rule_immutable();--> statement-breakpoint

-- 2. A reward's identity, its rule pin and its funding snapshot never change,
--    it is never deleted, and its net never grows. Only the state machine and
--    the net moving DOWN are writable.
CREATE FUNCTION mercaria_referral_reward_frozen() RETURNS trigger LANGUAGE plpgsql AS $$
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
     NEW.hold_until_at IS DISTINCT FROM OLD.hold_until_at OR
     NEW.accrued_at IS DISTINCT FROM OLD.accrued_at OR
     NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION
      'referral reward % is pinned to one immutable rule version and one funding record: % is refused. A rule change is a new version and a base change is an adjustment row.',
      OLD.id, TG_OP
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.net_amount_minor > OLD.net_amount_minor THEN
    RAISE EXCEPTION
      'referral reward % cannot grow: net % → %. A reward is a bounded fraction of funding already realized, and every adjustment only ever reduces it.',
      OLD.id, OLD.net_amount_minor, NEW.net_amount_minor
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER referral_rewards_frozen
  BEFORE UPDATE OR DELETE ON "referral_rewards"
  FOR EACH ROW EXECUTE FUNCTION mercaria_referral_reward_frozen();--> statement-breakpoint

-- 3. The reversal trail is append-only, against UPDATE and DELETE both.
CREATE FUNCTION mercaria_referral_reward_adjustment_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'referral reward adjustments are append-only: % on %.% is refused. A correction is a further adjustment naming its own cause.',
    TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME
    USING ERRCODE = 'check_violation';
END;
$$;--> statement-breakpoint
CREATE TRIGGER referral_reward_adjustments_append_only
  BEFORE UPDATE OR DELETE ON "referral_reward_adjustments"
  FOR EACH ROW EXECUTE FUNCTION mercaria_referral_reward_adjustment_append_only();--> statement-breakpoint

-- 4. A campaign budget's identity is frozen and its allocation only grows.
--    `claimed_minor` moves both ways — a reversal releases what it took back —
--    and the CHECK plus the conditional UPDATE are what bound it.
CREATE FUNCTION mercaria_referral_campaign_budget_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION
      'referral campaign budget % is never deleted: rewards name it as their funding record. Close it, or invalidate it and reverse what it paid.',
      OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR
     NEW.program_id IS DISTINCT FROM OLD.program_id OR
     NEW.campaign_ref IS DISTINCT FROM OLD.campaign_ref OR
     NEW.currency IS DISTINCT FROM OLD.currency OR
     NEW.created_by_oxy_user_id IS DISTINCT FROM OLD.created_by_oxy_user_id OR
     NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION
      'referral campaign budget % has a frozen identity: rewards drawn from it name it by id and were denominated in its currency.',
      OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.budget_minor < OLD.budget_minor THEN
    RAISE EXCEPTION
      'referral campaign budget % cannot shrink: % → %. Stopping a campaign is status = closed, which is prospective; a shrink would be retroactive and could strand claims already made.',
      OLD.id, OLD.budget_minor, NEW.budget_minor
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER referral_campaign_budgets_guard
  BEFORE UPDATE OR DELETE ON "referral_campaign_budgets"
  FOR EACH ROW EXECUTE FUNCTION mercaria_referral_campaign_budget_guard();
