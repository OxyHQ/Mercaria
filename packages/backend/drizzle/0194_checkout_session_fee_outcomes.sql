-- oxy:deploy-phase=pre
-- oxy:rollback=restore: payments_snapshot_immutable is dropped and recreated without provider and provider_object_id (they move to payments_rail_immutable); its previous definition is in 0135_commerce_history_snapshot_triggers, and order_fee_outcomes plus payments.provider_checkout_session_id are additive — dropping order_fee_outcomes loses which paid orders were paid in FairCoin (fee 0)
-- ADR 0021: one Peable Checkout Session per cart (payments.provider_checkout_session_id) and the marketplace fee decided by the method USED, at the outcome (order_fee_outcomes, append-only like the snapshot beside it).
CREATE TABLE "order_fee_outcomes" (
	"id" text PRIMARY KEY NOT NULL,
	"order_id" text NOT NULL,
	"payment_id" text NOT NULL,
	"method" text NOT NULL,
	"fee_amount" bigint NOT NULL,
	"fee_currency" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "order_fee_outcomes_method_check" CHECK ("order_fee_outcomes"."method" in ('card', 'faircoin')),
	CONSTRAINT "order_fee_outcomes_fee_currency_check" CHECK ("order_fee_outcomes"."fee_currency" in ('FAIR', 'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF', 'CNY', 'SEK', 'NOK', 'DKK', 'PLN', 'MXN', 'BRL', 'INR', 'NZD', 'ZAR', 'SGD', 'HKD', 'AED')),
	CONSTRAINT "order_fee_outcomes_fee_amount_check" CHECK ("order_fee_outcomes"."fee_amount" >= 0),
	CONSTRAINT "order_fee_outcomes_faircoin_no_fee_check" CHECK ("order_fee_outcomes"."method" <> 'faircoin' or "order_fee_outcomes"."fee_amount" = 0)
);
--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "provider_checkout_session_id" text;--> statement-breakpoint
ALTER TABLE "order_fee_outcomes" ADD CONSTRAINT "order_fee_outcomes_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_fee_outcomes" ADD CONSTRAINT "order_fee_outcomes_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "order_fee_outcomes_order_id_key" ON "order_fee_outcomes" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "order_fee_outcomes_payment_id_idx" ON "order_fee_outcomes" USING btree ("payment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payments_provider_checkout_session_id_key" ON "payments" USING btree ("provider_checkout_session_id") WHERE "payments"."provider_checkout_session_id" is not null;--> statement-breakpoint

-- Every statement below is HAND-WRITTEN (drizzle-kit models no trigger) and
-- anchored between `-- oxy:handwritten-begin=<name>` and its matching end marker:
--   grep -c '^-- oxy:handwritten-begin=' drizzle/0193_checkout_session_fee_outcomes.sql   # 2

-- oxy:handwritten-begin=order_fee_outcomes_append_only
-- A fee outcome is a fact about a paid order, append-only like its snapshot.
CREATE TRIGGER order_fee_outcomes_append_only
  BEFORE UPDATE OR DELETE ON "order_fee_outcomes"
  FOR EACH ROW EXECUTE FUNCTION mercaria_fee_record_append_only();--> statement-breakpoint
-- oxy:handwritten-end=order_fee_outcomes_append_only

-- oxy:handwritten-begin=payments_rail_immutable
-- ADR 0020: a cart paid through ONE checkout session learns its rail (`provider`)
-- and its payment (`provider_object_id`) from the payer's choice in Peable's
-- sheet, and the payer may switch method before money moves. Those two columns
-- leave `payments_snapshot_immutable` for this trigger, which freezes them
-- exactly as before EXCEPT on a session payment still `created`,
-- `requires_action` or `failed` — once it is `processing` or settled, they are
-- write-once again. The frozen set of the table is unchanged.
DROP TRIGGER "payments_snapshot_immutable" ON "payments";--> statement-breakpoint
CREATE TRIGGER payments_snapshot_immutable
  BEFORE UPDATE ON "payments"
  FOR EACH ROW EXECUTE FUNCTION mercaria_commerce_snapshot_columns_immutable(
    'checkout_group_id', 'buyer_oxy_user_id', 'order_id',
    'presentment_amount', 'presentment_currency',
    'platform_amount', 'platform_currency', 'platform_rate_from',
    'platform_rate_to', 'platform_rate_rate', 'platform_rate_provider',
    'platform_rate_as_of');--> statement-breakpoint
CREATE TRIGGER payments_rail_immutable
  BEFORE UPDATE ON "payments"
  FOR EACH ROW
  WHEN (OLD.provider_checkout_session_id IS NULL
        OR OLD.status NOT IN ('created', 'requires_action', 'failed'))
  EXECUTE FUNCTION mercaria_commerce_snapshot_columns_immutable('provider', 'provider_object_id');
-- oxy:handwritten-end=payments_rail_immutable
