-- oxy:deploy-phase=pre
-- oxy:rollback=restore: five CHECKs including ledger_entries_account_check, ledger_transactions_kind_check and reconciliation_cursors_id_check are widened; the previous forms are in 0011 and 0046, and re-adding any of them fails against a posting, transaction or cursor using the added vocabulary
--
-- Zero-profit cost reconciliation for `mercaria_retail` (#128, ADR 0004 D7/D8).
--
-- Purely ADDITIVE. Ten new tables, plus five WIDENINGS whose new tuples are
-- strict supersets of the old, so every write the serving image performs still
-- passes:
--
--   * `ledger_entries_account_check`      + supplier_prepaid, platform_funds,
--                                           procurement_expense, customer_adjustment
--   * `ledger_entries_owner_type_check`   + supplier
--   * `ledger_transactions_kind_check`    + prefund_top_up, procurement_settled,
--                                           retail_variance, supplier_credit
--   * `reconciliation_cursors_id_check`   + retail_reconciliation
--   * `guest_portal_messages_kind_check`  + cost_adjustment_issued
--
-- HAND-WRITTEN STATEMENTS BELOW THE GENERATED BLOCK. `db:generate` DROPS them
-- on a regeneration; re-apply them at the END of the file and confirm with:
--
--   grep -c '^CREATE TRIGGER'             drizzle/0063_*.sql   # 8
--   grep -c '^CREATE OR REPLACE FUNCTION'  drizzle/0063_*.sql   # 8
--   grep -c '^-- oxy:deploy-phase'         drizzle/0063_*.sql   # 1
--

CREATE TABLE "retail_customer_adjustments" (
	"id" text PRIMARY KEY NOT NULL,
	"order_id" text NOT NULL,
	"reconciliation_id" text NOT NULL,
	"reconciliation_revision" integer NOT NULL,
	"adjustment_amount" bigint NOT NULL,
	"adjustment_currency" text NOT NULL,
	"method" text NOT NULL,
	"state" text DEFAULT 'owed' NOT NULL,
	"block_reason" text,
	"non_refundable_provider_cost_amount" bigint,
	"non_refundable_provider_cost_currency" text,
	"refund_id" text,
	"notified_at" timestamp with time zone,
	"superseded_by_id" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "retail_customer_adjustments_method_check" CHECK ("retail_customer_adjustments"."method" in ('provider_refund', 'recorded_payable')),
	CONSTRAINT "retail_customer_adjustments_state_check" CHECK ("retail_customer_adjustments"."state" in ('owed', 'refund_committed', 'refund_settled', 'refund_failed', 'payable_recorded', 'closed_at_finality')),
	CONSTRAINT "retail_customer_adjustments_block_reason_check" CHECK ("retail_customer_adjustments"."block_reason" in ('provider_refund_unavailable', 'payment_not_settled', 'dispute_open', 'below_automation_threshold', 'prior_adjustment_exhausts_charge', 'currency_unconvertible')),
	CONSTRAINT "retail_customer_adjustments_adjustment_currency_check" CHECK ("retail_customer_adjustments"."adjustment_currency" in ('FAIR', 'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF', 'CNY', 'SEK', 'NOK', 'DKK', 'PLN', 'MXN', 'BRL', 'INR', 'NZD', 'ZAR', 'SGD', 'HKD', 'AED')),
	CONSTRAINT "retail_customer_adjustments_non_refundable_provider_cost_currency_check" CHECK ("retail_customer_adjustments"."non_refundable_provider_cost_currency" in ('FAIR', 'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF', 'CNY', 'SEK', 'NOK', 'DKK', 'PLN', 'MXN', 'BRL', 'INR', 'NZD', 'ZAR', 'SGD', 'HKD', 'AED')),
	CONSTRAINT "retail_customer_adjustments_amount_check" CHECK ("retail_customer_adjustments"."adjustment_amount" > 0),
	CONSTRAINT "retail_customer_adjustments_provider_cost_check" CHECK (("retail_customer_adjustments"."non_refundable_provider_cost_amount" is null)
            = ("retail_customer_adjustments"."non_refundable_provider_cost_currency" is null)
          and ("retail_customer_adjustments"."non_refundable_provider_cost_amount" is null
               or "retail_customer_adjustments"."non_refundable_provider_cost_amount" >= 0)),
	CONSTRAINT "retail_customer_adjustments_block_shape_check" CHECK (("retail_customer_adjustments"."method" = 'recorded_payable') = ("retail_customer_adjustments"."block_reason" is not null)),
	CONSTRAINT "retail_customer_adjustments_refund_shape_check" CHECK (("retail_customer_adjustments"."state" in ('refund_committed', 'refund_settled', 'refund_failed'))
            = ("retail_customer_adjustments"."refund_id" is not null)),
	CONSTRAINT "retail_customer_adjustments_method_state_check" CHECK (("retail_customer_adjustments"."state" = 'payable_recorded') is not true or "retail_customer_adjustments"."method" = 'recorded_payable')
);
--> statement-breakpoint
CREATE TABLE "retail_ledger_recognitions" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"claim_key" text NOT NULL,
	"ledger_transaction_id" text NOT NULL,
	"order_id" text,
	"purchase_order_id" text,
	"supplier_id" text,
	"booked_amount" bigint NOT NULL,
	"booked_currency" text NOT NULL,
	"booked_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "retail_ledger_recognitions_kind_check" CHECK ("retail_ledger_recognitions"."kind" in ('prefund_top_up', 'procurement_settled', 'direct_fulfilment_cost', 'supplier_credit', 'variance_recognized', 'adjustment_refunded')),
	CONSTRAINT "retail_ledger_recognitions_booked_currency_check" CHECK ("retail_ledger_recognitions"."booked_currency" in ('FAIR', 'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF', 'CNY', 'SEK', 'NOK', 'DKK', 'PLN', 'MXN', 'BRL', 'INR', 'NZD', 'ZAR', 'SGD', 'HKD', 'AED')),
	CONSTRAINT "retail_ledger_recognitions_amount_check" CHECK ("retail_ledger_recognitions"."booked_amount" > 0),
	CONSTRAINT "retail_ledger_recognitions_key_check" CHECK (length(btrim("retail_ledger_recognitions"."claim_key")) > 0)
);
--> statement-breakpoint
CREATE TABLE "retail_reconciliation_components" (
	"id" text PRIMARY KEY NOT NULL,
	"reconciliation_id" text NOT NULL,
	"component" text NOT NULL,
	"source_amount" bigint NOT NULL,
	"source_currency" text NOT NULL,
	"accounting_amount" bigint NOT NULL,
	"accounting_currency" text NOT NULL,
	"fx_rate_from" text,
	"fx_rate_to" text,
	"fx_rate_rate" double precision,
	"fx_rate_provider" text,
	"fx_rate_as_of" text,
	"evidence_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "retail_reconciliation_components_component_check" CHECK ("retail_reconciliation_components"."component" in ('customer_charge', 'supplier_item_cost', 'supplier_handling_cost', 'fulfilment_shipping_cost', 'tax_duty_liability', 'provider_processing_cost', 'mercaria_promotion_subsidy', 'customer_refund', 'supplier_credit', 'customer_adjustment_payable', 'mercaria_absorbed_variance', 'dispute_movement')),
	CONSTRAINT "retail_reconciliation_components_source_currency_check" CHECK ("retail_reconciliation_components"."source_currency" in ('FAIR', 'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF', 'CNY', 'SEK', 'NOK', 'DKK', 'PLN', 'MXN', 'BRL', 'INR', 'NZD', 'ZAR', 'SGD', 'HKD', 'AED')),
	CONSTRAINT "retail_reconciliation_components_accounting_currency_check" CHECK ("retail_reconciliation_components"."accounting_currency" in ('FAIR', 'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF', 'CNY', 'SEK', 'NOK', 'DKK', 'PLN', 'MXN', 'BRL', 'INR', 'NZD', 'ZAR', 'SGD', 'HKD', 'AED')),
	CONSTRAINT "retail_reconciliation_components_fx_rate_from_check" CHECK ("retail_reconciliation_components"."fx_rate_from" in ('FAIR', 'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF', 'CNY', 'SEK', 'NOK', 'DKK', 'PLN', 'MXN', 'BRL', 'INR', 'NZD', 'ZAR', 'SGD', 'HKD', 'AED')),
	CONSTRAINT "retail_reconciliation_components_fx_rate_to_check" CHECK ("retail_reconciliation_components"."fx_rate_to" in ('FAIR', 'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF', 'CNY', 'SEK', 'NOK', 'DKK', 'PLN', 'MXN', 'BRL', 'INR', 'NZD', 'ZAR', 'SGD', 'HKD', 'AED')),
	CONSTRAINT "retail_reconciliation_components_amounts_check" CHECK ("retail_reconciliation_components"."source_amount" >= 0 and "retail_reconciliation_components"."accounting_amount" >= 0 and "retail_reconciliation_components"."evidence_count" >= 0),
	CONSTRAINT "retail_reconciliation_components_fx_presence_check" CHECK (num_nonnulls("retail_reconciliation_components"."fx_rate_from", "retail_reconciliation_components"."fx_rate_to", "retail_reconciliation_components"."fx_rate_rate", "retail_reconciliation_components"."fx_rate_provider", "retail_reconciliation_components"."fx_rate_as_of") in (0, 5)
          and ("retail_reconciliation_components"."source_currency" = "retail_reconciliation_components"."accounting_currency") = ("retail_reconciliation_components"."fx_rate_rate" is null)),
	CONSTRAINT "retail_reconciliation_components_fx_pair_check" CHECK ("retail_reconciliation_components"."fx_rate_rate" is null
          or ("retail_reconciliation_components"."fx_rate_from" = "retail_reconciliation_components"."source_currency"
              and "retail_reconciliation_components"."fx_rate_to" = "retail_reconciliation_components"."accounting_currency"
              and "retail_reconciliation_components"."fx_rate_rate" > 0))
);
--> statement-breakpoint
CREATE TABLE "retail_reconciliation_evidence" (
	"id" text PRIMARY KEY NOT NULL,
	"reconciliation_id" text NOT NULL,
	"kind" text NOT NULL,
	"reference" text NOT NULL,
	"evidence_amount" bigint,
	"evidence_currency" text,
	"observed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "retail_reconciliation_evidence_kind_check" CHECK ("retail_reconciliation_evidence"."kind" in ('stripe_payment', 'stripe_processing_fee', 'stripe_refund', 'stripe_dispute', 'purchase_order', 'supplier_invoice', 'supplier_credit_note', 'fulfilment_charge', 'tax_duty_record', 'retail_cost_quote', 'promotion_subsidy', 'customer_refund_record')),
	CONSTRAINT "retail_reconciliation_evidence_evidence_currency_check" CHECK ("retail_reconciliation_evidence"."evidence_currency" in ('FAIR', 'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF', 'CNY', 'SEK', 'NOK', 'DKK', 'PLN', 'MXN', 'BRL', 'INR', 'NZD', 'ZAR', 'SGD', 'HKD', 'AED')),
	CONSTRAINT "retail_reconciliation_evidence_reference_check" CHECK (length(btrim("retail_reconciliation_evidence"."reference")) > 0),
	CONSTRAINT "retail_reconciliation_evidence_money_pair_check" CHECK (("retail_reconciliation_evidence"."evidence_amount" is null) = ("retail_reconciliation_evidence"."evidence_currency" is null)
          and ("retail_reconciliation_evidence"."evidence_amount" is null or "retail_reconciliation_evidence"."evidence_amount" >= 0))
);
--> statement-breakpoint
CREATE TABLE "retail_reconciliation_exceptions" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"order_id" text NOT NULL,
	"reconciliation_id" text,
	"purchase_order_id" text,
	"detail" text NOT NULL,
	"raised_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"occurrences" integer DEFAULT 1 NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolved_by_oxy_user_id" text,
	"resolution_reason" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "retail_reconciliation_exceptions_kind_check" CHECK ("retail_reconciliation_exceptions"."kind" in ('missing_supplier_invoice', 'missing_provider_fee', 'missing_tax_determination', 'missing_cost_quote', 'missing_customer_refund_record', 'unlinked_supplier_credit', 'duplicate_supplier_charge', 'duplicate_customer_credit', 'currency_unconvertible', 'adjustment_refund_failed', 'absorbed_variance_over_threshold', 'recurring_quote_inaccuracy')),
	CONSTRAINT "retail_reconciliation_exceptions_detail_check" CHECK (length(btrim("retail_reconciliation_exceptions"."detail")) between 1 and 2000),
	CONSTRAINT "retail_reconciliation_exceptions_occurrences_check" CHECK ("retail_reconciliation_exceptions"."occurrences" >= 1),
	CONSTRAINT "retail_reconciliation_exceptions_resolution_check" CHECK (num_nonnulls("retail_reconciliation_exceptions"."resolved_at", "retail_reconciliation_exceptions"."resolved_by_oxy_user_id", "retail_reconciliation_exceptions"."resolution_reason") in (0, 3))
);
--> statement-breakpoint
CREATE TABLE "retail_reconciliation_operator_actions" (
	"id" text PRIMARY KEY NOT NULL,
	"action" text NOT NULL,
	"outcome" text NOT NULL,
	"actor_oxy_user_id" text NOT NULL,
	"reason" text NOT NULL,
	"order_id" text,
	"adjustment_id" text,
	"exception_id" text,
	"refusal_detail" text,
	"attempted_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "retail_reconciliation_operator_actions_action_check" CHECK ("retail_reconciliation_operator_actions"."action" in ('reconcile_order', 'retry_adjustment_refund', 'resolve_exception')),
	CONSTRAINT "retail_reconciliation_operator_actions_outcome_check" CHECK ("retail_reconciliation_operator_actions"."outcome" in ('applied', 'no_op', 'refused')),
	CONSTRAINT "retail_reconciliation_operator_actions_actor_check" CHECK (length(btrim("retail_reconciliation_operator_actions"."actor_oxy_user_id")) > 0
          and length(btrim("retail_reconciliation_operator_actions"."reason")) between 1 and 2000),
	CONSTRAINT "retail_reconciliation_operator_actions_subject_check" CHECK (num_nonnulls("retail_reconciliation_operator_actions"."order_id", "retail_reconciliation_operator_actions"."adjustment_id", "retail_reconciliation_operator_actions"."exception_id") = 1),
	CONSTRAINT "retail_reconciliation_operator_actions_refusal_check" CHECK (("retail_reconciliation_operator_actions"."outcome" = 'refused') = ("retail_reconciliation_operator_actions"."refusal_detail" is not null))
);
--> statement-breakpoint
CREATE TABLE "retail_reconciliation_policies" (
	"id" text PRIMARY KEY NOT NULL,
	"policy_key" text NOT NULL,
	"version" integer NOT NULL,
	"name" text NOT NULL,
	"summary" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"effective_start" timestamp with time zone NOT NULL,
	"effective_end" timestamp with time zone,
	"absorbed_variance_alert_bps" integer DEFAULT 500 NOT NULL,
	"absorbed_variance_alert_floor_amount" bigint NOT NULL,
	"absorbed_variance_alert_floor_currency" text NOT NULL,
	"recurring_variance_count" integer DEFAULT 3 NOT NULL,
	"recurring_variance_window_hours" integer DEFAULT 168 NOT NULL,
	"finality_ceiling_days" integer DEFAULT 180 NOT NULL,
	"sub_threshold_disposition" text DEFAULT 'refund_remaining' NOT NULL,
	"created_by_oxy_user_id" text NOT NULL,
	"approved_by_oxy_user_id" text,
	"activated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "retail_reconciliation_policies_status_check" CHECK ("retail_reconciliation_policies"."status" in ('draft', 'active', 'superseded', 'retired')),
	CONSTRAINT "retail_reconciliation_policies_disposition_check" CHECK ("retail_reconciliation_policies"."sub_threshold_disposition" in ('refund_remaining', 'keep_open')),
	CONSTRAINT "retail_reconciliation_policies_absorbed_variance_alert_floor_currency_check" CHECK ("retail_reconciliation_policies"."absorbed_variance_alert_floor_currency" in ('FAIR', 'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF', 'CNY', 'SEK', 'NOK', 'DKK', 'PLN', 'MXN', 'BRL', 'INR', 'NZD', 'ZAR', 'SGD', 'HKD', 'AED')),
	CONSTRAINT "retail_reconciliation_policies_version_check" CHECK ("retail_reconciliation_policies"."version" >= 1),
	CONSTRAINT "retail_reconciliation_policies_key_check" CHECK ("retail_reconciliation_policies"."policy_key" ~ '^[a-z0-9][a-z0-9-]{1,63}$'),
	CONSTRAINT "retail_reconciliation_policies_alert_check" CHECK ("retail_reconciliation_policies"."absorbed_variance_alert_bps" between 1 and 10000
          and "retail_reconciliation_policies"."absorbed_variance_alert_floor_amount" >= 0),
	CONSTRAINT "retail_reconciliation_policies_recurrence_check" CHECK ("retail_reconciliation_policies"."recurring_variance_count" >= 1 and "retail_reconciliation_policies"."recurring_variance_window_hours" >= 1),
	CONSTRAINT "retail_reconciliation_policies_finality_check" CHECK ("retail_reconciliation_policies"."finality_ceiling_days" between 1 and 180),
	CONSTRAINT "retail_reconciliation_policies_summary_check" CHECK (length(btrim("retail_reconciliation_policies"."summary")) between 1 and 2000),
	CONSTRAINT "retail_reconciliation_policies_effective_window_check" CHECK ("retail_reconciliation_policies"."effective_end" is null or "retail_reconciliation_policies"."effective_end" > "retail_reconciliation_policies"."effective_start"),
	CONSTRAINT "retail_reconciliation_policies_activation_audit_check" CHECK ("retail_reconciliation_policies"."status" not in ('active', 'superseded')
          or ("retail_reconciliation_policies"."approved_by_oxy_user_id" is not null and "retail_reconciliation_policies"."activated_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "retail_reconciliation_tolerances" (
	"id" text PRIMARY KEY NOT NULL,
	"policy_id" text NOT NULL,
	"currency" text NOT NULL,
	"tolerance_minor" bigint NOT NULL,
	"automation_floor_minor" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "retail_reconciliation_tolerances_currency_check" CHECK ("retail_reconciliation_tolerances"."currency" in ('FAIR', 'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF', 'CNY', 'SEK', 'NOK', 'DKK', 'PLN', 'MXN', 'BRL', 'INR', 'NZD', 'ZAR', 'SGD', 'HKD', 'AED')),
	CONSTRAINT "retail_reconciliation_tolerances_bound_check" CHECK ("retail_reconciliation_tolerances"."tolerance_minor" between 0 and (case "retail_reconciliation_tolerances"."currency" when 'FAIR' then 5000000 when 'USD' then 5 when 'EUR' then 5 when 'GBP' then 5 when 'CAD' then 5 when 'AUD' then 5 when 'JPY' then 5 when 'CHF' then 5 when 'CNY' then 5 when 'SEK' then 5 when 'NOK' then 5 when 'DKK' then 5 when 'PLN' then 5 when 'MXN' then 5 when 'BRL' then 5 when 'INR' then 5 when 'NZD' then 5 when 'ZAR' then 5 when 'SGD' then 5 when 'HKD' then 5 when 'AED' then 5 else -1 end)),
	CONSTRAINT "retail_reconciliation_tolerances_floor_check" CHECK ("retail_reconciliation_tolerances"."automation_floor_minor" >= "retail_reconciliation_tolerances"."tolerance_minor"
          and "retail_reconciliation_tolerances"."automation_floor_minor" <= (case "retail_reconciliation_tolerances"."currency" when 'FAIR' then 10000000000 when 'USD' then 10000 when 'EUR' then 10000 when 'GBP' then 10000 when 'CAD' then 10000 when 'AUD' then 10000 when 'JPY' then 100 when 'CHF' then 10000 when 'CNY' then 10000 when 'SEK' then 10000 when 'NOK' then 10000 when 'DKK' then 10000 when 'PLN' then 10000 when 'MXN' then 10000 when 'BRL' then 10000 when 'INR' then 10000 when 'NZD' then 10000 when 'ZAR' then 10000 when 'SGD' then 10000 when 'HKD' then 10000 when 'AED' then 10000 else -1 end))
);
--> statement-breakpoint
CREATE TABLE "retail_reconciliations" (
	"id" text PRIMARY KEY NOT NULL,
	"order_id" text NOT NULL,
	"revision" integer NOT NULL,
	"policy_id" text NOT NULL,
	"policy_key" text NOT NULL,
	"policy_version" integer NOT NULL,
	"completeness" text NOT NULL,
	"outcome" text,
	"accounting_currency" text NOT NULL,
	"customer_amount_before_subsidy_minor" bigint NOT NULL,
	"final_attributable_cost_minor" bigint NOT NULL,
	"cost_variance_minor" bigint NOT NULL,
	"tolerance_minor" bigint NOT NULL,
	"evidence_digest" text NOT NULL,
	"computed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "retail_reconciliations_completeness_check" CHECK ("retail_reconciliations"."completeness" in ('complete', 'missing_evidence')),
	CONSTRAINT "retail_reconciliations_outcome_check" CHECK ("retail_reconciliations"."outcome" in ('cost_recovered_exactly', 'within_rounding_tolerance', 'customer_adjustment_required', 'mercaria_absorbed')),
	CONSTRAINT "retail_reconciliations_accounting_currency_check" CHECK ("retail_reconciliations"."accounting_currency" in ('FAIR', 'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF', 'CNY', 'SEK', 'NOK', 'DKK', 'PLN', 'MXN', 'BRL', 'INR', 'NZD', 'ZAR', 'SGD', 'HKD', 'AED')),
	CONSTRAINT "retail_reconciliations_revision_check" CHECK ("retail_reconciliations"."revision" >= 1),
	CONSTRAINT "retail_reconciliations_digest_check" CHECK ("retail_reconciliations"."evidence_digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "retail_reconciliations_amounts_check" CHECK ("retail_reconciliations"."customer_amount_before_subsidy_minor" >= 0
          and "retail_reconciliations"."final_attributable_cost_minor" >= 0
          and "retail_reconciliations"."tolerance_minor" >= 0),
	CONSTRAINT "retail_reconciliations_outcome_shape_check" CHECK (("retail_reconciliations"."completeness" = 'complete') = ("retail_reconciliations"."outcome" is not null)),
	CONSTRAINT "retail_reconciliations_variance_check" CHECK ("retail_reconciliations"."cost_variance_minor"
            = "retail_reconciliations"."customer_amount_before_subsidy_minor" - "retail_reconciliations"."final_attributable_cost_minor"
          and ("retail_reconciliations"."outcome" is null
               or (
                 (("retail_reconciliations"."outcome" = 'cost_recovered_exactly') = ("retail_reconciliations"."cost_variance_minor" = 0))
                 and (("retail_reconciliations"."outcome" = 'customer_adjustment_required')
                      = ("retail_reconciliations"."cost_variance_minor" > "retail_reconciliations"."tolerance_minor"))
                 and (("retail_reconciliations"."outcome" = 'mercaria_absorbed')
                      = ("retail_reconciliations"."cost_variance_minor" < -"retail_reconciliations"."tolerance_minor"))
                 and (("retail_reconciliations"."outcome" = 'within_rounding_tolerance')
                      = (abs("retail_reconciliations"."cost_variance_minor") <= "retail_reconciliations"."tolerance_minor"
                         and "retail_reconciliations"."cost_variance_minor" <> 0))
               )))
);
--> statement-breakpoint
CREATE TABLE "retail_supplier_credits" (
	"id" text PRIMARY KEY NOT NULL,
	"classification" text NOT NULL,
	"purchase_order_id" text NOT NULL,
	"order_id" text,
	"provider_document_id" text NOT NULL,
	"supplier_invoice_reference" text,
	"supplier_recovery_id" text,
	"credit_amount" bigint NOT NULL,
	"credit_currency" text NOT NULL,
	"accounting_amount" bigint NOT NULL,
	"accounting_currency" text NOT NULL,
	"fx_rate_from" text,
	"fx_rate_to" text,
	"fx_rate_rate" double precision,
	"fx_rate_provider" text,
	"fx_rate_as_of" text,
	"issued_at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	"claim_key" text NOT NULL,
	"ledger_transaction_id" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "retail_supplier_credits_classification_check" CHECK ("retail_supplier_credits"."classification" in ('return_linked', 'cost_reduction', 'unattributable')),
	CONSTRAINT "retail_supplier_credits_credit_currency_check" CHECK ("retail_supplier_credits"."credit_currency" in ('FAIR', 'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF', 'CNY', 'SEK', 'NOK', 'DKK', 'PLN', 'MXN', 'BRL', 'INR', 'NZD', 'ZAR', 'SGD', 'HKD', 'AED')),
	CONSTRAINT "retail_supplier_credits_accounting_currency_check" CHECK ("retail_supplier_credits"."accounting_currency" in ('FAIR', 'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF', 'CNY', 'SEK', 'NOK', 'DKK', 'PLN', 'MXN', 'BRL', 'INR', 'NZD', 'ZAR', 'SGD', 'HKD', 'AED')),
	CONSTRAINT "retail_supplier_credits_fx_rate_from_check" CHECK ("retail_supplier_credits"."fx_rate_from" in ('FAIR', 'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF', 'CNY', 'SEK', 'NOK', 'DKK', 'PLN', 'MXN', 'BRL', 'INR', 'NZD', 'ZAR', 'SGD', 'HKD', 'AED')),
	CONSTRAINT "retail_supplier_credits_fx_rate_to_check" CHECK ("retail_supplier_credits"."fx_rate_to" in ('FAIR', 'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF', 'CNY', 'SEK', 'NOK', 'DKK', 'PLN', 'MXN', 'BRL', 'INR', 'NZD', 'ZAR', 'SGD', 'HKD', 'AED')),
	CONSTRAINT "retail_supplier_credits_amounts_check" CHECK ("retail_supplier_credits"."credit_amount" > 0 and "retail_supplier_credits"."accounting_amount" > 0),
	CONSTRAINT "retail_supplier_credits_document_check" CHECK (length(btrim("retail_supplier_credits"."provider_document_id")) > 0 and length(btrim("retail_supplier_credits"."claim_key")) > 0),
	CONSTRAINT "retail_supplier_credits_order_shape_check" CHECK (("retail_supplier_credits"."classification" = 'unattributable') = ("retail_supplier_credits"."order_id" is null)),
	CONSTRAINT "retail_supplier_credits_return_evidence_check" CHECK ("retail_supplier_credits"."classification" <> 'return_linked' or "retail_supplier_credits"."supplier_recovery_id" is not null),
	CONSTRAINT "retail_supplier_credits_fx_presence_check" CHECK (num_nonnulls("retail_supplier_credits"."fx_rate_from", "retail_supplier_credits"."fx_rate_to", "retail_supplier_credits"."fx_rate_rate", "retail_supplier_credits"."fx_rate_provider", "retail_supplier_credits"."fx_rate_as_of") in (0, 5)
          and ("retail_supplier_credits"."credit_currency" = "retail_supplier_credits"."accounting_currency") = ("retail_supplier_credits"."fx_rate_rate" is null)),
	CONSTRAINT "retail_supplier_credits_fx_pair_check" CHECK ("retail_supplier_credits"."fx_rate_rate" is null
          or ("retail_supplier_credits"."fx_rate_from" = "retail_supplier_credits"."credit_currency"
              and "retail_supplier_credits"."fx_rate_to" = "retail_supplier_credits"."accounting_currency"
              and "retail_supplier_credits"."fx_rate_rate" > 0))
);
--> statement-breakpoint
ALTER TABLE "ledger_entries" DROP CONSTRAINT "ledger_entries_account_check";--> statement-breakpoint
ALTER TABLE "ledger_entries" DROP CONSTRAINT "ledger_entries_owner_type_check";--> statement-breakpoint
ALTER TABLE "ledger_transactions" DROP CONSTRAINT "ledger_transactions_kind_check";--> statement-breakpoint
ALTER TABLE "reconciliation_cursors" DROP CONSTRAINT "reconciliation_cursors_id_check";--> statement-breakpoint
ALTER TABLE "guest_portal_messages" DROP CONSTRAINT "guest_portal_messages_kind_check";--> statement-breakpoint
ALTER TABLE "retail_customer_adjustments" ADD CONSTRAINT "retail_customer_adjustments_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retail_customer_adjustments" ADD CONSTRAINT "retail_customer_adjustments_reconciliation_id_retail_reconciliations_id_fk" FOREIGN KEY ("reconciliation_id") REFERENCES "public"."retail_reconciliations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retail_customer_adjustments" ADD CONSTRAINT "retail_customer_adjustments_refund_id_refunds_id_fk" FOREIGN KEY ("refund_id") REFERENCES "public"."refunds"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retail_ledger_recognitions" ADD CONSTRAINT "retail_ledger_recognitions_ledger_transaction_id_ledger_transactions_id_fk" FOREIGN KEY ("ledger_transaction_id") REFERENCES "public"."ledger_transactions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retail_ledger_recognitions" ADD CONSTRAINT "retail_ledger_recognitions_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retail_ledger_recognitions" ADD CONSTRAINT "retail_ledger_recognitions_purchase_order_id_purchase_orders_id_fk" FOREIGN KEY ("purchase_order_id") REFERENCES "public"."purchase_orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retail_ledger_recognitions" ADD CONSTRAINT "retail_ledger_recognitions_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retail_reconciliation_components" ADD CONSTRAINT "retail_reconciliation_components_reconciliation_id_retail_reconciliations_id_fk" FOREIGN KEY ("reconciliation_id") REFERENCES "public"."retail_reconciliations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retail_reconciliation_evidence" ADD CONSTRAINT "retail_reconciliation_evidence_reconciliation_id_retail_reconciliations_id_fk" FOREIGN KEY ("reconciliation_id") REFERENCES "public"."retail_reconciliations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retail_reconciliation_exceptions" ADD CONSTRAINT "retail_reconciliation_exceptions_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retail_reconciliation_exceptions" ADD CONSTRAINT "retail_reconciliation_exceptions_reconciliation_id_retail_reconciliations_id_fk" FOREIGN KEY ("reconciliation_id") REFERENCES "public"."retail_reconciliations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retail_reconciliation_exceptions" ADD CONSTRAINT "retail_reconciliation_exceptions_purchase_order_id_purchase_orders_id_fk" FOREIGN KEY ("purchase_order_id") REFERENCES "public"."purchase_orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retail_reconciliation_operator_actions" ADD CONSTRAINT "retail_reconciliation_operator_actions_adjustment_id_retail_customer_adjustments_id_fk" FOREIGN KEY ("adjustment_id") REFERENCES "public"."retail_customer_adjustments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retail_reconciliation_operator_actions" ADD CONSTRAINT "retail_reconciliation_operator_actions_exception_id_retail_reconciliation_exceptions_id_fk" FOREIGN KEY ("exception_id") REFERENCES "public"."retail_reconciliation_exceptions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retail_reconciliation_tolerances" ADD CONSTRAINT "retail_reconciliation_tolerances_policy_id_retail_reconciliation_policies_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."retail_reconciliation_policies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retail_reconciliations" ADD CONSTRAINT "retail_reconciliations_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retail_reconciliations" ADD CONSTRAINT "retail_reconciliations_policy_id_retail_reconciliation_policies_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."retail_reconciliation_policies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retail_supplier_credits" ADD CONSTRAINT "retail_supplier_credits_purchase_order_id_purchase_orders_id_fk" FOREIGN KEY ("purchase_order_id") REFERENCES "public"."purchase_orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retail_supplier_credits" ADD CONSTRAINT "retail_supplier_credits_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retail_supplier_credits" ADD CONSTRAINT "retail_supplier_credits_supplier_recovery_id_supplier_recoveries_id_fk" FOREIGN KEY ("supplier_recovery_id") REFERENCES "public"."supplier_recoveries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retail_supplier_credits" ADD CONSTRAINT "retail_supplier_credits_ledger_transaction_id_ledger_transactions_id_fk" FOREIGN KEY ("ledger_transaction_id") REFERENCES "public"."ledger_transactions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "retail_customer_adjustments_reconciliation_key" ON "retail_customer_adjustments" USING btree ("reconciliation_id");--> statement-breakpoint
CREATE INDEX "retail_customer_adjustments_order_idx" ON "retail_customer_adjustments" USING btree ("order_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "retail_customer_adjustments_open_idx" ON "retail_customer_adjustments" USING btree ("created_at") WHERE "retail_customer_adjustments"."state" <> 'refund_settled' and "retail_customer_adjustments"."state" <> 'closed_at_finality';--> statement-breakpoint
CREATE UNIQUE INDEX "retail_ledger_recognitions_kind_key" ON "retail_ledger_recognitions" USING btree ("kind","claim_key");--> statement-breakpoint
CREATE INDEX "retail_ledger_recognitions_order_idx" ON "retail_ledger_recognitions" USING btree ("order_id","booked_at" DESC NULLS LAST) WHERE "retail_ledger_recognitions"."order_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "retail_reconciliation_components_key" ON "retail_reconciliation_components" USING btree ("reconciliation_id","component");--> statement-breakpoint
CREATE UNIQUE INDEX "retail_reconciliation_evidence_key" ON "retail_reconciliation_evidence" USING btree ("reconciliation_id","kind","reference");--> statement-breakpoint
CREATE INDEX "retail_reconciliation_evidence_reference_idx" ON "retail_reconciliation_evidence" USING btree ("kind","reference");--> statement-breakpoint
CREATE UNIQUE INDEX "retail_reconciliation_exceptions_open_key" ON "retail_reconciliation_exceptions" USING btree ("kind","order_id") WHERE "retail_reconciliation_exceptions"."resolved_at" is null;--> statement-breakpoint
CREATE INDEX "retail_reconciliation_exceptions_open_idx" ON "retail_reconciliation_exceptions" USING btree ("raised_at") WHERE "retail_reconciliation_exceptions"."resolved_at" is null;--> statement-breakpoint
CREATE INDEX "retail_reconciliation_exceptions_order_idx" ON "retail_reconciliation_exceptions" USING btree ("order_id","raised_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "retail_reconciliation_operator_actions_attempted_idx" ON "retail_reconciliation_operator_actions" USING btree ("attempted_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "retail_reconciliation_operator_actions_order_idx" ON "retail_reconciliation_operator_actions" USING btree ("order_id","attempted_at" DESC NULLS LAST) WHERE "retail_reconciliation_operator_actions"."order_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "retail_reconciliation_policies_key_version_key" ON "retail_reconciliation_policies" USING btree ("policy_key","version");--> statement-breakpoint
CREATE UNIQUE INDEX "retail_reconciliation_policies_one_active_per_key" ON "retail_reconciliation_policies" USING btree ("policy_key") WHERE "retail_reconciliation_policies"."status" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "retail_reconciliation_tolerances_policy_currency_key" ON "retail_reconciliation_tolerances" USING btree ("policy_id","currency");--> statement-breakpoint
CREATE UNIQUE INDEX "retail_reconciliations_order_revision_key" ON "retail_reconciliations" USING btree ("order_id","revision");--> statement-breakpoint
CREATE INDEX "retail_reconciliations_order_computed_idx" ON "retail_reconciliations" USING btree ("order_id","computed_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "retail_reconciliations_outcome_idx" ON "retail_reconciliations" USING btree ("outcome","computed_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "retail_reconciliations_completeness_idx" ON "retail_reconciliations" USING btree ("completeness","computed_at" DESC NULLS LAST) WHERE "retail_reconciliations"."completeness" = 'missing_evidence';--> statement-breakpoint
CREATE UNIQUE INDEX "retail_supplier_credits_claim_key" ON "retail_supplier_credits" USING btree ("claim_key");--> statement-breakpoint
CREATE INDEX "retail_supplier_credits_po_idx" ON "retail_supplier_credits" USING btree ("purchase_order_id","issued_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "retail_supplier_credits_order_idx" ON "retail_supplier_credits" USING btree ("order_id","issued_at" DESC NULLS LAST) WHERE "retail_supplier_credits"."order_id" is not null;--> statement-breakpoint
CREATE INDEX "retail_supplier_credits_recorded_idx" ON "retail_supplier_credits" USING btree ("recorded_at");--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_account_check" CHECK ("ledger_entries"."account" in ('provider_clearing', 'merchant_payable', 'commission_revenue', 'processor_expense', 'refunds', 'disputes', 'reserves', 'retail_cost_recovery', 'supplier_prepaid', 'platform_funds', 'procurement_expense', 'customer_adjustment'));--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_owner_type_check" CHECK ("ledger_entries"."owner_type" in ('store', 'user', 'supplier'));--> statement-breakpoint
ALTER TABLE "ledger_transactions" ADD CONSTRAINT "ledger_transactions_kind_check" CHECK ("ledger_transactions"."kind" in ('charge_succeeded', 'transfer_created', 'refund', 'transfer_reversal', 'dispute_created', 'dispute_won', 'dispute_lost', 'adjustment', 'prefund_top_up', 'procurement_settled', 'retail_variance', 'supplier_credit'));--> statement-breakpoint
ALTER TABLE "reconciliation_cursors" ADD CONSTRAINT "reconciliation_cursors_id_check" CHECK ("reconciliation_cursors"."id" in ('open_payments', 'provider_objects', 'ledger_audit', 'account_readiness', 'retail_reconciliation'));--> statement-breakpoint
ALTER TABLE "guest_portal_messages" ADD CONSTRAINT "guest_portal_messages_kind_check" CHECK ("guest_portal_messages"."kind" in ('order_confirmation', 'payment_pending', 'payment_failed', 'payment_delayed_success', 'order_processing', 'order_shipped', 'tracking_updated', 'order_ready_for_pickup', 'order_delivered', 'order_cancelled', 'refund_pending', 'refund_completed', 'refund_failed', 'cost_adjustment_issued', 'cancellation_request_received', 'cancellation_request_approved', 'cancellation_request_rejected', 'return_request_received', 'return_request_updated', 'support_response_available', 'buyer_action_required', 'claim_completed', 'access_link_recovery', 'access_link_step_up', 'access_security_notice', 'retail_service_request_received', 'retail_cancellation_updated', 'retail_return_authorized', 'retail_return_updated', 'retail_warranty_updated', 'retail_service_delayed', 'retail_safety_notice', 'retail_service_request_closed'));

--> statement-breakpoint
-- ---------------------------------------------------------------------------
-- Append-only: a correction is a new REVISION, exactly as a ledger correction
-- is a new reversing transaction. Six tables, six triggers, and each names what
-- to do instead — a refusal an operator cannot act on is a refusal they route
-- around.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION mercaria_retail_reconciliations_append_only()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION
    'retail_reconciliations is append-only: % is not permitted. A corrected verdict is a NEW revision.',
    TG_OP;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER mercaria_retail_reconciliations_append_only
  BEFORE UPDATE OR DELETE ON "retail_reconciliations"
  FOR EACH ROW EXECUTE FUNCTION mercaria_retail_reconciliations_append_only();--> statement-breakpoint

CREATE OR REPLACE FUNCTION mercaria_retail_reconciliation_components_append_only()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION
    'retail_reconciliation_components is append-only: % is not permitted. A component belongs to one revision and a changed figure is a new revision.',
    TG_OP;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER mercaria_retail_reconciliation_components_append_only
  BEFORE UPDATE OR DELETE ON "retail_reconciliation_components"
  FOR EACH ROW EXECUTE FUNCTION mercaria_retail_reconciliation_components_append_only();--> statement-breakpoint

CREATE OR REPLACE FUNCTION mercaria_retail_reconciliation_evidence_append_only()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION
    'retail_reconciliation_evidence is append-only: % is not permitted. It records what a revision READ, which cannot change afterwards.',
    TG_OP;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER mercaria_retail_reconciliation_evidence_append_only
  BEFORE UPDATE OR DELETE ON "retail_reconciliation_evidence"
  FOR EACH ROW EXECUTE FUNCTION mercaria_retail_reconciliation_evidence_append_only();--> statement-breakpoint

CREATE OR REPLACE FUNCTION mercaria_retail_supplier_credits_append_only()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION
    'retail_supplier_credits is append-only: % is not permitted. A credit is recorded and booked in ONE transaction, so there is nothing to fill in later.',
    TG_OP;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER mercaria_retail_supplier_credits_append_only
  BEFORE UPDATE OR DELETE ON "retail_supplier_credits"
  FOR EACH ROW EXECUTE FUNCTION mercaria_retail_supplier_credits_append_only();--> statement-breakpoint

CREATE OR REPLACE FUNCTION mercaria_retail_ledger_recognitions_append_only()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION
    'retail_ledger_recognitions is append-only: % is not permitted. Releasing a claim would make a duplicate posting reachable, and the ledger cannot un-post one.',
    TG_OP;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER mercaria_retail_ledger_recognitions_append_only
  BEFORE UPDATE OR DELETE ON "retail_ledger_recognitions"
  FOR EACH ROW EXECUTE FUNCTION mercaria_retail_ledger_recognitions_append_only();--> statement-breakpoint

CREATE OR REPLACE FUNCTION mercaria_retail_reconciliation_actions_append_only()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION
    'retail_reconciliation_operator_actions is append-only: % is not permitted. An audit trail somebody can edit is not one.',
    TG_OP;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER mercaria_retail_reconciliation_actions_append_only
  BEFORE UPDATE OR DELETE ON "retail_reconciliation_operator_actions"
  FOR EACH ROW EXECUTE FUNCTION mercaria_retail_reconciliation_actions_append_only();--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- A published policy version is immutable, and so are its tolerances.
--
-- The `fee_schedules` / `retail_pricing_policies` mechanism: a policy change is
-- a NEW version, never an edit, because orders were reconciled under the old one
-- and a mutable version would silently restate what they were reconciled
-- against. Only the LIFECYCLE columns may move on an active row, which is what
-- lets a version be superseded when the next one is published.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION mercaria_retail_reconciliation_policy_immutable()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION
      'retail_reconciliation_policies is never deleted: revisions cite the version they were made under.';
  END IF;
  IF OLD.status = 'draft' THEN
    RETURN NEW;
  END IF;
  IF NEW.policy_key IS DISTINCT FROM OLD.policy_key
     OR NEW.version IS DISTINCT FROM OLD.version
     OR NEW.absorbed_variance_alert_bps IS DISTINCT FROM OLD.absorbed_variance_alert_bps
     OR NEW.absorbed_variance_alert_floor_amount IS DISTINCT FROM OLD.absorbed_variance_alert_floor_amount
     OR NEW.absorbed_variance_alert_floor_currency IS DISTINCT FROM OLD.absorbed_variance_alert_floor_currency
     OR NEW.recurring_variance_count IS DISTINCT FROM OLD.recurring_variance_count
     OR NEW.recurring_variance_window_hours IS DISTINCT FROM OLD.recurring_variance_window_hours
     OR NEW.finality_ceiling_days IS DISTINCT FROM OLD.finality_ceiling_days
     OR NEW.sub_threshold_disposition IS DISTINCT FROM OLD.sub_threshold_disposition
     OR NEW.effective_start IS DISTINCT FROM OLD.effective_start
  THEN
    RAISE EXCEPTION
      'retail_reconciliation_policies version % of % is % and its terms are frozen. Publish a NEW version.',
      OLD.version, OLD.policy_key, OLD.status;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER mercaria_retail_reconciliation_policy_immutable
  BEFORE UPDATE OR DELETE ON "retail_reconciliation_policies"
  FOR EACH ROW EXECUTE FUNCTION mercaria_retail_reconciliation_policy_immutable();--> statement-breakpoint

CREATE OR REPLACE FUNCTION mercaria_retail_reconciliation_tolerance_frozen()
RETURNS trigger AS $$
DECLARE
  policy_status text;
BEGIN
  SELECT p.status INTO policy_status
  FROM retail_reconciliation_policies p
  WHERE p.id = COALESCE(NEW.policy_id, OLD.policy_id);

  -- A policy CASCADE-deletes its tolerances, and a draft that was never
  -- published is legitimately deletable. Once a version has been active, the
  -- numbers orders were reconciled against cannot move.
  IF policy_status IS NULL OR policy_status = 'draft' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  RAISE EXCEPTION
    'retail_reconciliation_tolerances belongs to a % policy version and is frozen: % is not permitted. Publish a NEW version.',
    policy_status, TG_OP;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER mercaria_retail_reconciliation_tolerance_frozen
  BEFORE INSERT OR UPDATE OR DELETE ON "retail_reconciliation_tolerances"
  FOR EACH ROW EXECUTE FUNCTION mercaria_retail_reconciliation_tolerance_frozen();
