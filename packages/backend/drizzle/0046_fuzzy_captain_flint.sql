-- oxy:deploy-phase=pre
-- oxy:rollback=restore: five CHECKs including orders_seller_type_check and ledger_entries_account_check are widened for mercaria_retail; the previous forms are in 0000, 0002 and 0036, and re-adding any of them fails against a retail order or a retail_cost_recovery entry
--
-- Mercaria-retail native checkout (#123, ADR 0004 D1/D4/D5/D8).
--
-- ADDITIVE throughout, which is why it is `pre` even though it contains five
-- `DROP CONSTRAINT` statements: every one of them is immediately followed by a
-- WIDER version of the same CHECK, so the image serving traffic while this runs
-- writes only values the new constraint already admits. ADR 0004 D13 requires
-- additive-only migrations for this domain, and nothing here narrows anything.
--
--  - `orders.commercial_role`, NOT NULL with a `connected_marketplace` default,
--    which is what fills the existing table without a rewrite. `sellerType`
--    gains `platform`, the seller-exclusivity CHECK gains its third disjunct
--    (both owner columns NULL), and `orders_commercial_role_seller_check` ties
--    the two together as the biconditional D1 states.
--  - `ledger_entries.account` gains `retail_cost_recovery` — the ONE retail
--    account #123 writes; D7's other four arrive with #128, with the code that
--    writes them.
--  - `payment_outboxes.event_type` gains `procurement_requested` and
--    `retail_procurement_failed` (D4 steps 4–5).
--  - `analytics_events.reason_code` gains `retail_line_ineligible`.
--  - Four new tables, and two triggers below that drizzle-kit cannot model.
--
-- ON A REGENERATION: the two anchored blocks at the END of this file are
-- hand-written and drizzle-kit will DROP them. Re-apply both, and verify by
-- grepping for `mercaria_retail_variance_append_only` and
-- `mercaria_retail_intent_lines_append_only` plus exactly one
-- `-- oxy:deploy-phase=` line.

CREATE TABLE "retail_cost_variance_records" (
	"id" text PRIMARY KEY NOT NULL,
	"order_id" text NOT NULL,
	"purchase_order_id" text,
	"intent_id" text NOT NULL,
	"source" text NOT NULL,
	"direction" text NOT NULL,
	"locked_amount" bigint NOT NULL,
	"locked_currency" text NOT NULL,
	"actual_amount" integer NOT NULL,
	"delta_amount" integer NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "retail_cost_variance_records_source_check" CHECK ("retail_cost_variance_records"."source" in ('supplier_acceptance', 'purchase_order_cancelled')),
	CONSTRAINT "retail_cost_variance_records_direction_check" CHECK ("retail_cost_variance_records"."direction" in ('none', 'customer_owed', 'absorbed')),
	CONSTRAINT "retail_cost_variance_records_locked_currency_check" CHECK ("retail_cost_variance_records"."locked_currency" in ('FAIR', 'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF', 'CNY', 'SEK', 'NOK', 'DKK', 'PLN', 'MXN', 'BRL', 'INR', 'NZD', 'ZAR', 'SGD', 'HKD', 'AED')),
	CONSTRAINT "retail_cost_variance_records_amounts_check" CHECK ("retail_cost_variance_records"."locked_amount" >= 0 and "retail_cost_variance_records"."actual_amount" >= 0),
	CONSTRAINT "retail_cost_variance_records_delta_check" CHECK ("retail_cost_variance_records"."delta_amount" = "retail_cost_variance_records"."locked_amount" - "retail_cost_variance_records"."actual_amount"
          and ("retail_cost_variance_records"."direction" = 'customer_owed') = ("retail_cost_variance_records"."delta_amount" > 0)
          and ("retail_cost_variance_records"."direction" = 'absorbed') = ("retail_cost_variance_records"."delta_amount" < 0)
          and ("retail_cost_variance_records"."direction" = 'none') = ("retail_cost_variance_records"."delta_amount" = 0))
);
--> statement-breakpoint
CREATE TABLE "retail_offer_bindings" (
	"id" text PRIMARY KEY NOT NULL,
	"product_variant_id" text NOT NULL,
	"procurement_offer_id" text NOT NULL,
	"supplier_id" text NOT NULL,
	"supplier_account_id" text NOT NULL,
	"agreement_id" text NOT NULL,
	"bound_by_oxy_user_id" text NOT NULL,
	"bound_reason" text NOT NULL,
	"retired_at" timestamp with time zone,
	"retired_by_oxy_user_id" text,
	"retired_reason" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "retail_offer_bindings_bound_reason_check" CHECK (length(btrim("retail_offer_bindings"."bound_reason")) > 0),
	CONSTRAINT "retail_offer_bindings_retirement_check" CHECK (num_nonnulls("retail_offer_bindings"."retired_at", "retail_offer_bindings"."retired_by_oxy_user_id", "retail_offer_bindings"."retired_reason") in (0, 3))
);
--> statement-breakpoint
CREATE TABLE "retail_procurement_intent_lines" (
	"id" text PRIMARY KEY NOT NULL,
	"intent_id" text NOT NULL,
	"procurement_offer_id" text NOT NULL,
	"binding_id" text NOT NULL,
	"acceptance_id" text NOT NULL,
	"quote_id" text NOT NULL,
	"supplier_quote_ref" text,
	"supplier_sku" text NOT NULL,
	"canonical_product_id" text,
	"canonical_variant_id" text,
	"quantity" integer NOT NULL,
	"supplier_unit_cost_amount" bigint NOT NULL,
	"supplier_unit_cost_currency" text NOT NULL,
	"supplier_line_total_amount" bigint NOT NULL,
	"supplier_line_total_currency" text NOT NULL,
	"buyer_accepted_total_amount" bigint NOT NULL,
	"buyer_accepted_total_currency" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "retail_procurement_intent_lines_supplier_unit_cost_currency_check" CHECK ("retail_procurement_intent_lines"."supplier_unit_cost_currency" in ('FAIR', 'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF', 'CNY', 'SEK', 'NOK', 'DKK', 'PLN', 'MXN', 'BRL', 'INR', 'NZD', 'ZAR', 'SGD', 'HKD', 'AED')),
	CONSTRAINT "retail_procurement_intent_lines_supplier_line_total_currency_check" CHECK ("retail_procurement_intent_lines"."supplier_line_total_currency" in ('FAIR', 'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF', 'CNY', 'SEK', 'NOK', 'DKK', 'PLN', 'MXN', 'BRL', 'INR', 'NZD', 'ZAR', 'SGD', 'HKD', 'AED')),
	CONSTRAINT "retail_procurement_intent_lines_buyer_accepted_total_currency_check" CHECK ("retail_procurement_intent_lines"."buyer_accepted_total_currency" in ('FAIR', 'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF', 'CNY', 'SEK', 'NOK', 'DKK', 'PLN', 'MXN', 'BRL', 'INR', 'NZD', 'ZAR', 'SGD', 'HKD', 'AED')),
	CONSTRAINT "retail_procurement_intent_lines_quantity_check" CHECK ("retail_procurement_intent_lines"."quantity" >= 1),
	CONSTRAINT "retail_procurement_intent_lines_amounts_check" CHECK ("retail_procurement_intent_lines"."supplier_unit_cost_amount" >= 0 and "retail_procurement_intent_lines"."supplier_line_total_amount" >= 0
          and "retail_procurement_intent_lines"."buyer_accepted_total_amount" >= 0),
	CONSTRAINT "retail_procurement_intent_lines_sku_check" CHECK (length(btrim("retail_procurement_intent_lines"."supplier_sku")) > 0)
);
--> statement-breakpoint
CREATE TABLE "retail_procurement_intents" (
	"id" text PRIMARY KEY NOT NULL,
	"order_id" text NOT NULL,
	"checkout_group_id" text NOT NULL,
	"supplier_id" text NOT NULL,
	"supplier_account_id" text NOT NULL,
	"agreement_id" text NOT NULL,
	"purchase_order_id" text,
	"status" text DEFAULT 'recorded' NOT NULL,
	"failure_kind" text,
	"failure_detail" text,
	"supplier_cost_amount" bigint NOT NULL,
	"supplier_cost_currency" text NOT NULL,
	"buyer_locked_total_amount" bigint NOT NULL,
	"buyer_locked_total_currency" text NOT NULL,
	"requested_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "retail_procurement_intents_status_check" CHECK ("retail_procurement_intents"."status" in ('recorded', 'requested', 'purchase_order_created', 'failed', 'cancelled')),
	CONSTRAINT "retail_procurement_intents_failure_kind_check" CHECK ("retail_procurement_intents"."failure_kind" in ('supplier_rejected', 'acceptance_expired', 'cost_increase_over_cap', 'supply_side_ineligible', 'operator_cancelled')),
	CONSTRAINT "retail_procurement_intents_supplier_cost_currency_check" CHECK ("retail_procurement_intents"."supplier_cost_currency" in ('FAIR', 'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF', 'CNY', 'SEK', 'NOK', 'DKK', 'PLN', 'MXN', 'BRL', 'INR', 'NZD', 'ZAR', 'SGD', 'HKD', 'AED')),
	CONSTRAINT "retail_procurement_intents_buyer_locked_total_currency_check" CHECK ("retail_procurement_intents"."buyer_locked_total_currency" in ('FAIR', 'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF', 'CNY', 'SEK', 'NOK', 'DKK', 'PLN', 'MXN', 'BRL', 'INR', 'NZD', 'ZAR', 'SGD', 'HKD', 'AED')),
	CONSTRAINT "retail_procurement_intents_cost_check" CHECK ("retail_procurement_intents"."supplier_cost_amount" >= 0 and "retail_procurement_intents"."buyer_locked_total_amount" >= 0),
	CONSTRAINT "retail_procurement_intents_group_check" CHECK (length(btrim("retail_procurement_intents"."checkout_group_id")) > 0),
	CONSTRAINT "retail_procurement_intents_failure_shape_check" CHECK (("retail_procurement_intents"."status" = 'failed') = ("retail_procurement_intents"."failure_kind" is not null)),
	CONSTRAINT "retail_procurement_intents_purchase_order_shape_check" CHECK (("retail_procurement_intents"."status" = 'purchase_order_created') = ("retail_procurement_intents"."purchase_order_id" is not null))
);
--> statement-breakpoint
ALTER TABLE "orders" DROP CONSTRAINT "orders_seller_type_check";--> statement-breakpoint
ALTER TABLE "orders" DROP CONSTRAINT "orders_seller_exclusivity_check";--> statement-breakpoint
ALTER TABLE "payment_outboxes" DROP CONSTRAINT "payment_outboxes_event_type_check";--> statement-breakpoint
ALTER TABLE "ledger_entries" DROP CONSTRAINT "ledger_entries_account_check";--> statement-breakpoint
ALTER TABLE "analytics_events" DROP CONSTRAINT "analytics_events_reason_code_check";--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "commercial_role" text DEFAULT 'connected_marketplace' NOT NULL;--> statement-breakpoint
ALTER TABLE "retail_cost_variance_records" ADD CONSTRAINT "retail_cost_variance_records_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retail_cost_variance_records" ADD CONSTRAINT "retail_cost_variance_records_purchase_order_id_purchase_orders_id_fk" FOREIGN KEY ("purchase_order_id") REFERENCES "public"."purchase_orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retail_cost_variance_records" ADD CONSTRAINT "retail_cost_variance_records_intent_id_retail_procurement_intents_id_fk" FOREIGN KEY ("intent_id") REFERENCES "public"."retail_procurement_intents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retail_offer_bindings" ADD CONSTRAINT "retail_offer_bindings_product_variant_id_product_variants_id_fk" FOREIGN KEY ("product_variant_id") REFERENCES "public"."product_variants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retail_offer_bindings" ADD CONSTRAINT "retail_offer_bindings_procurement_offer_id_procurement_offers_id_fk" FOREIGN KEY ("procurement_offer_id") REFERENCES "public"."procurement_offers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retail_offer_bindings" ADD CONSTRAINT "retail_offer_bindings_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retail_offer_bindings" ADD CONSTRAINT "retail_offer_bindings_supplier_account_id_supplier_accounts_id_fk" FOREIGN KEY ("supplier_account_id") REFERENCES "public"."supplier_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retail_offer_bindings" ADD CONSTRAINT "retail_offer_bindings_agreement_id_supplier_agreements_id_fk" FOREIGN KEY ("agreement_id") REFERENCES "public"."supplier_agreements"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retail_procurement_intent_lines" ADD CONSTRAINT "retail_procurement_intent_lines_intent_id_retail_procurement_intents_id_fk" FOREIGN KEY ("intent_id") REFERENCES "public"."retail_procurement_intents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retail_procurement_intent_lines" ADD CONSTRAINT "retail_procurement_intent_lines_procurement_offer_id_procurement_offers_id_fk" FOREIGN KEY ("procurement_offer_id") REFERENCES "public"."procurement_offers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retail_procurement_intent_lines" ADD CONSTRAINT "retail_procurement_intent_lines_binding_id_retail_offer_bindings_id_fk" FOREIGN KEY ("binding_id") REFERENCES "public"."retail_offer_bindings"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retail_procurement_intent_lines" ADD CONSTRAINT "retail_procurement_intent_lines_acceptance_id_retail_cost_quote_acceptances_id_fk" FOREIGN KEY ("acceptance_id") REFERENCES "public"."retail_cost_quote_acceptances"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retail_procurement_intent_lines" ADD CONSTRAINT "retail_procurement_intent_lines_quote_id_retail_cost_quotes_id_fk" FOREIGN KEY ("quote_id") REFERENCES "public"."retail_cost_quotes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retail_procurement_intents" ADD CONSTRAINT "retail_procurement_intents_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retail_procurement_intents" ADD CONSTRAINT "retail_procurement_intents_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retail_procurement_intents" ADD CONSTRAINT "retail_procurement_intents_supplier_account_id_supplier_accounts_id_fk" FOREIGN KEY ("supplier_account_id") REFERENCES "public"."supplier_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retail_procurement_intents" ADD CONSTRAINT "retail_procurement_intents_agreement_id_supplier_agreements_id_fk" FOREIGN KEY ("agreement_id") REFERENCES "public"."supplier_agreements"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retail_procurement_intents" ADD CONSTRAINT "retail_procurement_intents_purchase_order_id_purchase_orders_id_fk" FOREIGN KEY ("purchase_order_id") REFERENCES "public"."purchase_orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "retail_cost_variance_records_order_idx" ON "retail_cost_variance_records" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "retail_cost_variance_records_direction_idx" ON "retail_cost_variance_records" USING btree ("direction","observed_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "retail_cost_variance_records_intent_source_key" ON "retail_cost_variance_records" USING btree ("intent_id","source");--> statement-breakpoint
CREATE UNIQUE INDEX "retail_offer_bindings_variant_live_key" ON "retail_offer_bindings" USING btree ("product_variant_id") WHERE "retail_offer_bindings"."retired_at" is null;--> statement-breakpoint
CREATE INDEX "retail_offer_bindings_offer_idx" ON "retail_offer_bindings" USING btree ("procurement_offer_id");--> statement-breakpoint
CREATE INDEX "retail_offer_bindings_supplier_idx" ON "retail_offer_bindings" USING btree ("supplier_id");--> statement-breakpoint
CREATE UNIQUE INDEX "retail_procurement_intent_lines_acceptance_key" ON "retail_procurement_intent_lines" USING btree ("acceptance_id");--> statement-breakpoint
CREATE INDEX "retail_procurement_intent_lines_intent_idx" ON "retail_procurement_intent_lines" USING btree ("intent_id");--> statement-breakpoint
CREATE INDEX "retail_procurement_intent_lines_offer_idx" ON "retail_procurement_intent_lines" USING btree ("procurement_offer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "retail_procurement_intents_order_supplier_key" ON "retail_procurement_intents" USING btree ("order_id","supplier_id");--> statement-breakpoint
CREATE INDEX "retail_procurement_intents_group_idx" ON "retail_procurement_intents" USING btree ("checkout_group_id");--> statement-breakpoint
CREATE INDEX "retail_procurement_intents_status_idx" ON "retail_procurement_intents" USING btree ("status");--> statement-breakpoint
CREATE INDEX "retail_procurement_intents_purchase_order_idx" ON "retail_procurement_intents" USING btree ("purchase_order_id") WHERE "retail_procurement_intents"."purchase_order_id" is not null;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_commercial_role_check" CHECK ("orders"."commercial_role" in ('connected_marketplace', 'mercaria_retail'));--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_commercial_role_seller_check" CHECK (("orders"."seller_type" = 'platform') = ("orders"."commercial_role" = 'mercaria_retail'));--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_seller_type_check" CHECK ("orders"."seller_type" in ('user', 'store', 'platform'));--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_seller_exclusivity_check" CHECK (("orders"."seller_type" = 'user' and "orders"."seller_oxy_user_id" is not null and "orders"."store_id" is null)
          or ("orders"."seller_type" = 'store' and "orders"."store_id" is not null and "orders"."seller_oxy_user_id" is null)
          or ("orders"."seller_type" = 'platform' and "orders"."seller_oxy_user_id" is null and "orders"."store_id" is null));--> statement-breakpoint
ALTER TABLE "payment_outboxes" ADD CONSTRAINT "payment_outboxes_event_type_check" CHECK ("payment_outboxes"."event_type" in ('payment_succeeded', 'payment_failed', 'payment_succeeded_after_release', 'transfer_withheld', 'payment_refunded', 'payment_disputed', 'transfer_changed', 'payout_changed', 'provider_account_changed', 'refund_failed', 'reversal_failed', 'refund_unmatched', 'guest_portal_initialization', 'procurement_requested', 'retail_procurement_failed'));--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_account_check" CHECK ("ledger_entries"."account" in ('provider_clearing', 'merchant_payable', 'commission_revenue', 'processor_expense', 'refunds', 'disputes', 'reserves', 'retail_cost_recovery'));--> statement-breakpoint
ALTER TABLE "analytics_events" ADD CONSTRAINT "analytics_events_reason_code_check" CHECK ("analytics_events"."reason_code" in ('not_found', 'unavailable', 'rate_limited', 'upstream_timeout', 'upstream_error', 'validation_failed', 'forbidden', 'stale_offer', 'out_of_stock', 'listing_restricted', 'seller_not_payment_ready', 'p2p_seller_excluded', 'market_not_supported', 'currency_not_supported', 'guest_commerce_disabled', 'guest_cart_disabled', 'guest_issuance_disabled', 'guest_checkout_disabled', 'guest_rollout_blocked', 'guest_seller_not_activated', 'retail_line_ineligible', 'merge_completed', 'merge_already_done', 'merge_nothing_to_move', 'merge_quantity_clamped', 'merge_line_flagged', 'merge_discount_dropped', 'contact_malformed', 'contact_undeliverable', 'destination_incomplete', 'destination_unsupported', 'claim_offered', 'claim_completed', 'claim_declined', 'claim_conflicted', 'other'));
--> statement-breakpoint
-- ####### HAND-WRITTEN: append-only triggers (re-apply after any regeneration) #######
--
-- `retail_cost_variance_records` is the reconciliation input #128 BOOKS from,
-- so a row that could be edited would let an operator move a surplus owed to a
-- buyer after the fact — silently, since the ledger entry #128 derives from it
-- is append-only and would go on describing the old figure. DELETE is refused
-- for the same reason: a variance that was recorded and then removed is
-- indistinguishable from one that was never observed.
--
-- A correction is a NEW record with a later `observed_at` and a different
-- source, which is the ledger's own "a correction is a reversing transaction"
-- one layer up.
CREATE OR REPLACE FUNCTION mercaria_retail_variance_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'retail_cost_variance_records is append-only (#123, ADR 0004 D8): record a new observation instead of editing %', OLD.id
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER mercaria_retail_variance_append_only
  BEFORE UPDATE OR DELETE ON retail_cost_variance_records
  FOR EACH ROW EXECUTE FUNCTION mercaria_retail_variance_append_only();--> statement-breakpoint
-- `retail_procurement_intent_lines` is the FROZEN snapshot a purchase order is
-- composed from (ADR 0004 D4 step 1). An editable line would mean the supplier
-- Mercaria actually orders from, the SKU it orders, or the cost it agrees to
-- pay could all change after the buyer's amount was locked — which is precisely
-- how a locked amount and an actual cost stop describing the same purchase.
--
-- DELETE is PERMITTED, unlike the variance trigger above, and the difference is
-- deliberate: `intent_id` cascades from `retail_procurement_intents`, which
-- cascades from `orders`, so refusing DELETE here would break a cascade the
-- foreign keys already declare rather than protect anything. Nothing in this
-- codebase deletes an order.
CREATE OR REPLACE FUNCTION mercaria_retail_intent_lines_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'retail_procurement_intent_lines is frozen at checkout (#123, ADR 0004 D4): a revised total is a new quote and a new acceptance, never an edited line (%)', OLD.id
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER mercaria_retail_intent_lines_append_only
  BEFORE UPDATE ON retail_procurement_intent_lines
  FOR EACH ROW EXECUTE FUNCTION mercaria_retail_intent_lines_append_only();
