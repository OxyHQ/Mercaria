-- oxy:deploy-phase=pre
-- oxy:rollback=restore: ledger_entries_account_check and ledger_transactions_kind_check are widened again; the previous forms are in 0063 and re-adding either fails against a posting using the added account or kind
--
-- Merchant plans, entitlements and subscription billing (#89).
--
-- Additive throughout: ten new tables, plus two CHECK WIDENINGS on the ledger
-- (`subscription_revenue` joins the chart of accounts and
-- `subscription_invoice_paid` joins the transaction kinds). The serving image
-- writes neither value, and every row it can write still satisfies the new
-- constraints, which is what makes the drop-and-re-add safe in a `pre` phase.
--
-- HAND-WRITTEN STATEMENTS BELOW THE GENERATED BLOCK. `drizzle-kit generate`
-- emits no triggers, so a REGENERATION DROPS ALL SIX. They are anchored at the
-- end of this file under the marker comment; after regenerating, re-append the
-- block and confirm with:
--
--   grep -c '^CREATE TRIGGER' packages/backend/drizzle/0066_clear_slapstick.sql   -> 6
--   grep -c '^CREATE FUNCTION' packages/backend/drizzle/0066_clear_slapstick.sql  -> 4
--   grep -c '^-- oxy:deploy-phase' packages/backend/drizzle/0066_clear_slapstick.sql -> 1
--
CREATE TABLE "billing_customers" (
	"id" text PRIMARY KEY NOT NULL,
	"store_id" text NOT NULL,
	"provider" text NOT NULL,
	"livemode" boolean NOT NULL,
	"provider_customer_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "billing_customers_provider_check" CHECK ("billing_customers"."provider" in ('stripe'))
);
--> statement-breakpoint
CREATE TABLE "entitlement_definitions" (
	"id" text PRIMARY KEY NOT NULL,
	"capability_key" text NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"limit_kind" text NOT NULL,
	"enforcement_point" text DEFAULT 'create_or_extend' NOT NULL,
	"availability" text DEFAULT 'postponed' NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "entitlement_definitions_capability_key_unique" UNIQUE("capability_key"),
	CONSTRAINT "entitlement_definitions_capability_limit_kind_unique" UNIQUE("capability_key","limit_kind"),
	CONSTRAINT "entitlement_definitions_capability_key_check" CHECK ("entitlement_definitions"."capability_key" in ('advanced_demand_analytics', 'competitive_price_analytics', 'automation_rules', 'replenishment_planning', 'advanced_merchandising_rules', 'expanded_pos_registers', 'scheduled_exports', 'ai_catalog_assistance')),
	CONSTRAINT "entitlement_definitions_limit_kind_check" CHECK ("entitlement_definitions"."limit_kind" in ('flag', 'total', 'per_period')),
	CONSTRAINT "entitlement_definitions_enforcement_point_check" CHECK ("entitlement_definitions"."enforcement_point" in ('create_or_extend')),
	CONSTRAINT "entitlement_definitions_availability_check" CHECK ("entitlement_definitions"."availability" in ('available', 'postponed'))
);
--> statement-breakpoint
CREATE TABLE "entitlement_grants" (
	"id" text PRIMARY KEY NOT NULL,
	"store_id" text NOT NULL,
	"grant_key" text NOT NULL,
	"capability_key" text NOT NULL,
	"limit_kind" text NOT NULL,
	"limit_value" integer,
	"reason" text NOT NULL,
	"note" text NOT NULL,
	"granted_by_oxy_user_id" text NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_by_oxy_user_id" text,
	"revocation_reason" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "entitlement_grants_capability_key_check" CHECK ("entitlement_grants"."capability_key" in ('advanced_demand_analytics', 'competitive_price_analytics', 'automation_rules', 'replenishment_planning', 'advanced_merchandising_rules', 'expanded_pos_registers', 'scheduled_exports', 'ai_catalog_assistance')),
	CONSTRAINT "entitlement_grants_limit_kind_check" CHECK ("entitlement_grants"."limit_kind" in ('flag', 'total', 'per_period')),
	CONSTRAINT "entitlement_grants_reason_check" CHECK ("entitlement_grants"."reason" in ('trial', 'migration', 'partnership', 'operator_exception', 'compensation')),
	CONSTRAINT "entitlement_grants_flag_has_no_limit_check" CHECK ("entitlement_grants"."limit_kind" <> 'flag' or "entitlement_grants"."limit_value" is null),
	CONSTRAINT "entitlement_grants_limit_value_check" CHECK ("entitlement_grants"."limit_value" is null or "entitlement_grants"."limit_value" >= 0),
	CONSTRAINT "entitlement_grants_window_check" CHECK ("entitlement_grants"."expires_at" is null or "entitlement_grants"."expires_at" > "entitlement_grants"."starts_at"),
	CONSTRAINT "entitlement_grants_revocation_complete_check" CHECK (num_nonnulls("entitlement_grants"."revoked_at", "entitlement_grants"."revoked_by_oxy_user_id", "entitlement_grants"."revocation_reason") in (0, 3))
);
--> statement-breakpoint
CREATE TABLE "entitlement_usage_counters" (
	"id" text PRIMARY KEY NOT NULL,
	"store_id" text NOT NULL,
	"capability_key" text NOT NULL,
	"period_key" text NOT NULL,
	"used" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "entitlement_usage_counters_capability_key_check" CHECK ("entitlement_usage_counters"."capability_key" in ('advanced_demand_analytics', 'competitive_price_analytics', 'automation_rules', 'replenishment_planning', 'advanced_merchandising_rules', 'expanded_pos_registers', 'scheduled_exports', 'ai_catalog_assistance')),
	CONSTRAINT "entitlement_usage_counters_used_check" CHECK ("entitlement_usage_counters"."used" >= 0)
);
--> statement-breakpoint
CREATE TABLE "merchant_plan_acceptances" (
	"id" text PRIMARY KEY NOT NULL,
	"store_id" text NOT NULL,
	"plan_key" text NOT NULL,
	"plan_version" integer NOT NULL,
	"terms_version" text NOT NULL,
	"accepted_by_oxy_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "merchant_plan_acceptances_version_check" CHECK ("merchant_plan_acceptances"."plan_version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "merchant_plan_prices" (
	"id" text PRIMARY KEY NOT NULL,
	"plan_id" text NOT NULL,
	"provider" text NOT NULL,
	"livemode" boolean NOT NULL,
	"interval" text NOT NULL,
	"unit_price_amount" bigint NOT NULL,
	"unit_price_currency" text NOT NULL,
	"provider_price_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "merchant_plan_prices_provider_check" CHECK ("merchant_plan_prices"."provider" in ('stripe')),
	CONSTRAINT "merchant_plan_prices_interval_check" CHECK ("merchant_plan_prices"."interval" in ('monthly', 'annual')),
	CONSTRAINT "merchant_plan_prices_unit_price_currency_check" CHECK ("merchant_plan_prices"."unit_price_currency" in ('FAIR', 'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF', 'CNY', 'SEK', 'NOK', 'DKK', 'PLN', 'MXN', 'BRL', 'INR', 'NZD', 'ZAR', 'SGD', 'HKD', 'AED')),
	CONSTRAINT "merchant_plan_prices_amount_check" CHECK ("merchant_plan_prices"."unit_price_amount" >= 0)
);
--> statement-breakpoint
CREATE TABLE "merchant_plans" (
	"id" text PRIMARY KEY NOT NULL,
	"plan_key" text NOT NULL,
	"version" integer NOT NULL,
	"tier" text NOT NULL,
	"name" text NOT NULL,
	"summary" text NOT NULL,
	"terms_version" text NOT NULL,
	"trial_days" integer DEFAULT 0 NOT NULL,
	"grace_period_days" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"created_by_oxy_user_id" text NOT NULL,
	"approved_by_oxy_user_id" text,
	"activated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "merchant_plans_status_check" CHECK ("merchant_plans"."status" in ('draft', 'active', 'superseded', 'retired')),
	CONSTRAINT "merchant_plans_tier_check" CHECK ("merchant_plans"."tier" in ('free', 'paid')),
	CONSTRAINT "merchant_plans_version_check" CHECK ("merchant_plans"."version" >= 1),
	CONSTRAINT "merchant_plans_trial_days_check" CHECK ("merchant_plans"."trial_days" between 0 and 365),
	CONSTRAINT "merchant_plans_grace_period_days_check" CHECK ("merchant_plans"."grace_period_days" between 0 and 365),
	CONSTRAINT "merchant_plans_activation_audit_check" CHECK ("merchant_plans"."status" not in ('active', 'superseded')
          or ("merchant_plans"."approved_by_oxy_user_id" is not null and "merchant_plans"."activated_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "merchant_subscription_events" (
	"id" text PRIMARY KEY NOT NULL,
	"subscription_id" text NOT NULL,
	"kind" text NOT NULL,
	"from_status" text,
	"to_status" text,
	"plan_id" text,
	"actor_oxy_user_id" text,
	"provider_event_id" text,
	"provider_invoice_id" text,
	"amount_amount" bigint,
	"amount_currency" text,
	"ledger_transaction_id" text,
	"note" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "merchant_subscription_events_kind_check" CHECK ("merchant_subscription_events"."kind" in ('created', 'terms_accepted', 'trial_started', 'activated', 'invoice_paid', 'payment_failed', 'past_due', 'grace_expired', 'paused', 'resumed', 'plan_changed', 'cancellation_scheduled', 'cancelled', 'expired', 'reconciled')),
	CONSTRAINT "merchant_subscription_events_from_status_check" CHECK ("merchant_subscription_events"."from_status" in ('trialing', 'active', 'past_due', 'paused', 'cancelled', 'expired')),
	CONSTRAINT "merchant_subscription_events_to_status_check" CHECK ("merchant_subscription_events"."to_status" in ('trialing', 'active', 'past_due', 'paused', 'cancelled', 'expired')),
	CONSTRAINT "merchant_subscription_events_amount_currency_check" CHECK ("merchant_subscription_events"."amount_currency" in ('FAIR', 'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF', 'CNY', 'SEK', 'NOK', 'DKK', 'PLN', 'MXN', 'BRL', 'INR', 'NZD', 'ZAR', 'SGD', 'HKD', 'AED')),
	CONSTRAINT "merchant_subscription_events_amount_complete_check" CHECK (num_nonnulls("merchant_subscription_events"."amount_amount", "merchant_subscription_events"."amount_currency") in (0, 2)),
	CONSTRAINT "merchant_subscription_events_ledger_kind_check" CHECK ("merchant_subscription_events"."ledger_transaction_id" is null or "merchant_subscription_events"."kind" = 'invoice_paid')
);
--> statement-breakpoint
CREATE TABLE "merchant_subscriptions" (
	"id" text PRIMARY KEY NOT NULL,
	"store_id" text NOT NULL,
	"plan_id" text NOT NULL,
	"billing_customer_id" text NOT NULL,
	"provider" text NOT NULL,
	"livemode" boolean NOT NULL,
	"provider_subscription_id" text NOT NULL,
	"status" text NOT NULL,
	"interval" text NOT NULL,
	"current_period_start" timestamp with time zone,
	"current_period_end" timestamp with time zone,
	"trial_ends_at" timestamp with time zone,
	"grace_expires_at" timestamp with time zone,
	"cancellation_behavior" text,
	"cancel_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"accepted_terms_version" text NOT NULL,
	"accepted_by_oxy_user_id" text NOT NULL,
	"accepted_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "merchant_subscriptions_provider_check" CHECK ("merchant_subscriptions"."provider" in ('stripe')),
	CONSTRAINT "merchant_subscriptions_status_check" CHECK ("merchant_subscriptions"."status" in ('trialing', 'active', 'past_due', 'paused', 'cancelled', 'expired')),
	CONSTRAINT "merchant_subscriptions_interval_check" CHECK ("merchant_subscriptions"."interval" in ('monthly', 'annual')),
	CONSTRAINT "merchant_subscriptions_cancellation_behavior_check" CHECK ("merchant_subscriptions"."cancellation_behavior" in ('at_period_end', 'immediate')),
	CONSTRAINT "merchant_subscriptions_grace_deadline_check" CHECK ("merchant_subscriptions"."status" <> 'past_due' or "merchant_subscriptions"."grace_expires_at" is not null),
	CONSTRAINT "merchant_subscriptions_cancellation_complete_check" CHECK (num_nonnulls("merchant_subscriptions"."cancellation_behavior", "merchant_subscriptions"."cancel_at") in (0, 2)),
	CONSTRAINT "merchant_subscriptions_period_order_check" CHECK ("merchant_subscriptions"."current_period_start" is null
          or "merchant_subscriptions"."current_period_end" is null
          or "merchant_subscriptions"."current_period_end" > "merchant_subscriptions"."current_period_start")
);
--> statement-breakpoint
CREATE TABLE "plan_entitlements" (
	"id" text PRIMARY KEY NOT NULL,
	"plan_id" text NOT NULL,
	"capability_key" text NOT NULL,
	"limit_kind" text NOT NULL,
	"limit_value" integer,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "plan_entitlements_capability_key_check" CHECK ("plan_entitlements"."capability_key" in ('advanced_demand_analytics', 'competitive_price_analytics', 'automation_rules', 'replenishment_planning', 'advanced_merchandising_rules', 'expanded_pos_registers', 'scheduled_exports', 'ai_catalog_assistance')),
	CONSTRAINT "plan_entitlements_limit_kind_check" CHECK ("plan_entitlements"."limit_kind" in ('flag', 'total', 'per_period')),
	CONSTRAINT "plan_entitlements_flag_has_no_limit_check" CHECK ("plan_entitlements"."limit_kind" <> 'flag' or "plan_entitlements"."limit_value" is null),
	CONSTRAINT "plan_entitlements_limit_value_check" CHECK ("plan_entitlements"."limit_value" is null or "plan_entitlements"."limit_value" >= 0)
);
--> statement-breakpoint
ALTER TABLE "ledger_entries" DROP CONSTRAINT "ledger_entries_account_check";--> statement-breakpoint
ALTER TABLE "ledger_transactions" DROP CONSTRAINT "ledger_transactions_kind_check";--> statement-breakpoint
ALTER TABLE "billing_customers" ADD CONSTRAINT "billing_customers_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entitlement_grants" ADD CONSTRAINT "entitlement_grants_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entitlement_grants" ADD CONSTRAINT "entitlement_grants_capability_fk" FOREIGN KEY ("capability_key","limit_kind") REFERENCES "public"."entitlement_definitions"("capability_key","limit_kind") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entitlement_usage_counters" ADD CONSTRAINT "entitlement_usage_counters_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entitlement_usage_counters" ADD CONSTRAINT "entitlement_usage_counters_capability_key_entitlement_definitions_capability_key_fk" FOREIGN KEY ("capability_key") REFERENCES "public"."entitlement_definitions"("capability_key") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchant_plan_acceptances" ADD CONSTRAINT "merchant_plan_acceptances_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchant_plan_prices" ADD CONSTRAINT "merchant_plan_prices_plan_id_merchant_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."merchant_plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchant_subscription_events" ADD CONSTRAINT "merchant_subscription_events_subscription_id_merchant_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."merchant_subscriptions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchant_subscription_events" ADD CONSTRAINT "merchant_subscription_events_plan_id_merchant_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."merchant_plans"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchant_subscription_events" ADD CONSTRAINT "merchant_subscription_events_ledger_transaction_id_ledger_transactions_id_fk" FOREIGN KEY ("ledger_transaction_id") REFERENCES "public"."ledger_transactions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchant_subscriptions" ADD CONSTRAINT "merchant_subscriptions_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchant_subscriptions" ADD CONSTRAINT "merchant_subscriptions_plan_id_merchant_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."merchant_plans"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchant_subscriptions" ADD CONSTRAINT "merchant_subscriptions_billing_customer_id_billing_customers_id_fk" FOREIGN KEY ("billing_customer_id") REFERENCES "public"."billing_customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_entitlements" ADD CONSTRAINT "plan_entitlements_plan_id_merchant_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."merchant_plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_entitlements" ADD CONSTRAINT "plan_entitlements_capability_fk" FOREIGN KEY ("capability_key","limit_kind") REFERENCES "public"."entitlement_definitions"("capability_key","limit_kind") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "billing_customers_store_scope_key" ON "billing_customers" USING btree ("provider","livemode","store_id");--> statement-breakpoint
CREATE UNIQUE INDEX "billing_customers_provider_customer_key" ON "billing_customers" USING btree ("provider","livemode","provider_customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "entitlement_grants_store_key" ON "entitlement_grants" USING btree ("store_id","grant_key");--> statement-breakpoint
CREATE INDEX "entitlement_grants_store_capability_idx" ON "entitlement_grants" USING btree ("store_id","capability_key");--> statement-breakpoint
CREATE UNIQUE INDEX "entitlement_usage_counters_scope_key" ON "entitlement_usage_counters" USING btree ("store_id","capability_key","period_key");--> statement-breakpoint
CREATE UNIQUE INDEX "merchant_plan_acceptances_store_version_key" ON "merchant_plan_acceptances" USING btree ("store_id","plan_key","plan_version");--> statement-breakpoint
CREATE INDEX "merchant_plan_acceptances_store_created_at_idx" ON "merchant_plan_acceptances" USING btree ("store_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "merchant_plan_prices_scope_key" ON "merchant_plan_prices" USING btree ("plan_id","provider","livemode","interval","unit_price_currency");--> statement-breakpoint
CREATE INDEX "merchant_plan_prices_provider_price_idx" ON "merchant_plan_prices" USING btree ("provider","livemode","provider_price_id");--> statement-breakpoint
CREATE UNIQUE INDEX "merchant_plans_key_version_key" ON "merchant_plans" USING btree ("plan_key","version");--> statement-breakpoint
CREATE UNIQUE INDEX "merchant_plans_one_active_per_key" ON "merchant_plans" USING btree ("plan_key") WHERE "merchant_plans"."status" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "merchant_plans_one_active_free_plan" ON "merchant_plans" USING btree ("tier") WHERE "merchant_plans"."tier" = 'free' and "merchant_plans"."status" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "merchant_subscription_events_provider_event_key" ON "merchant_subscription_events" USING btree ("provider_event_id") WHERE "merchant_subscription_events"."provider_event_id" is not null;--> statement-breakpoint
CREATE INDEX "merchant_subscription_events_subscription_created_at_idx" ON "merchant_subscription_events" USING btree ("subscription_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "merchant_subscriptions_store_key" ON "merchant_subscriptions" USING btree ("store_id");--> statement-breakpoint
CREATE UNIQUE INDEX "merchant_subscriptions_provider_subscription_key" ON "merchant_subscriptions" USING btree ("provider","livemode","provider_subscription_id");--> statement-breakpoint
CREATE INDEX "merchant_subscriptions_status_updated_at_idx" ON "merchant_subscriptions" USING btree ("status","updated_at");--> statement-breakpoint
CREATE INDEX "merchant_subscriptions_grace_expires_at_idx" ON "merchant_subscriptions" USING btree ("grace_expires_at") WHERE "merchant_subscriptions"."grace_expires_at" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "plan_entitlements_plan_capability_key" ON "plan_entitlements" USING btree ("plan_id","capability_key");--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_account_check" CHECK ("ledger_entries"."account" in ('provider_clearing', 'merchant_payable', 'commission_revenue', 'processor_expense', 'refunds', 'disputes', 'reserves', 'retail_cost_recovery', 'supplier_prepaid', 'platform_funds', 'procurement_expense', 'customer_adjustment', 'subscription_revenue'));--> statement-breakpoint
ALTER TABLE "ledger_transactions" ADD CONSTRAINT "ledger_transactions_kind_check" CHECK ("ledger_transactions"."kind" in ('charge_succeeded', 'transfer_created', 'refund', 'transfer_reversal', 'dispute_created', 'dispute_won', 'dispute_lost', 'subscription_invoice_paid', 'adjustment', 'prefund_top_up', 'procurement_settled', 'retail_variance', 'supplier_credit'));

--> statement-breakpoint
-- ─── #89 hand-written statements: SIX TRIGGERS, FOUR FUNCTIONS ───────────────
-- Everything below this marker is invisible to `drizzle-kit generate` and is
-- DROPPED by a regeneration. See the header.
CREATE FUNCTION mercaria_merchant_plan_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN
      RAISE EXCEPTION
        'merchant plan %.% is %, not draft: published plan versions are never deleted. Retire it, or publish a new version.',
        OLD.plan_key, OLD.version, OLD.status
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.status <> 'draft' AND (
    NEW.plan_key IS DISTINCT FROM OLD.plan_key OR
    NEW.version IS DISTINCT FROM OLD.version OR
    NEW.tier IS DISTINCT FROM OLD.tier OR
    NEW.name IS DISTINCT FROM OLD.name OR
    NEW.summary IS DISTINCT FROM OLD.summary OR
    NEW.terms_version IS DISTINCT FROM OLD.terms_version OR
    NEW.trial_days IS DISTINCT FROM OLD.trial_days OR
    NEW.grace_period_days IS DISTINCT FROM OLD.grace_period_days OR
    NEW.created_by_oxy_user_id IS DISTINCT FROM OLD.created_by_oxy_user_id OR
    NEW.created_at IS DISTINCT FROM OLD.created_at
  ) THEN
    RAISE EXCEPTION
      'merchant plan %.% is %, not draft: its policy is immutable, and a subscription names this row. Publish a new version instead of editing this one.',
      OLD.plan_key, OLD.version, OLD.status
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER merchant_plans_immutable_once_active
  BEFORE UPDATE OR DELETE ON "merchant_plans"
  FOR EACH ROW EXECUTE FUNCTION mercaria_merchant_plan_immutable();--> statement-breakpoint
CREATE FUNCTION mercaria_merchant_plan_child_frozen() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  target_plan text;
  plan_status text;
BEGIN
  -- `NEW` is UNASSIGNED in a DELETE trigger and referencing it raises, so the
  -- branch is on TG_OP rather than on a COALESCE over two records.
  IF TG_OP = 'DELETE' THEN
    target_plan := OLD.plan_id;
  ELSE
    target_plan := NEW.plan_id;
  END IF;
  SELECT status INTO plan_status FROM merchant_plans WHERE id = target_plan;
  -- A draft plan being deleted takes its children with it by CASCADE, and the
  -- parent's own trigger has already refused anything but a draft — so a NULL
  -- here is that cascade, not a missing parent.
  IF plan_status IS NOT NULL AND plan_status <> 'draft' THEN
    RAISE EXCEPTION
      'plan version % is %, not draft: its prices and entitlements are frozen. Publish a new version instead of editing this one.',
      target_plan, plan_status
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER merchant_plan_prices_frozen_once_active
  BEFORE INSERT OR UPDATE OR DELETE ON "merchant_plan_prices"
  FOR EACH ROW EXECUTE FUNCTION mercaria_merchant_plan_child_frozen();--> statement-breakpoint
CREATE TRIGGER plan_entitlements_frozen_once_active
  BEFORE INSERT OR UPDATE OR DELETE ON "plan_entitlements"
  FOR EACH ROW EXECUTE FUNCTION mercaria_merchant_plan_child_frozen();--> statement-breakpoint
CREATE FUNCTION mercaria_entitlement_definition_contract_frozen() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.capability_key IS DISTINCT FROM OLD.capability_key
     OR NEW.limit_kind IS DISTINCT FROM OLD.limit_kind
     OR NEW.enforcement_point IS DISTINCT FROM OLD.enforcement_point THEN
    RAISE EXCEPTION
      'entitlement definition % has a frozen contract: its key, limit kind and enforcement point are what every plan entitlement and grant was written against. Product copy and availability may change; these may not.',
      OLD.capability_key
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER entitlement_definitions_immutable_contract
  BEFORE UPDATE ON "entitlement_definitions"
  FOR EACH ROW EXECUTE FUNCTION mercaria_entitlement_definition_contract_frozen();--> statement-breakpoint
CREATE FUNCTION mercaria_merchant_billing_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'merchant billing records are append-only: % on %.% is refused. A terms acceptance and a subscription audit row are immutable once written.',
    TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME
    USING ERRCODE = 'check_violation';
END;
$$;--> statement-breakpoint
CREATE TRIGGER merchant_plan_acceptances_append_only
  BEFORE UPDATE OR DELETE ON "merchant_plan_acceptances"
  FOR EACH ROW EXECUTE FUNCTION mercaria_merchant_billing_append_only();--> statement-breakpoint
CREATE TRIGGER merchant_subscription_events_append_only
  BEFORE UPDATE OR DELETE ON "merchant_subscription_events"
  FOR EACH ROW EXECUTE FUNCTION mercaria_merchant_billing_append_only();
