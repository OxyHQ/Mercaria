-- oxy:deploy-phase=pre
-- oxy:rollback=restore: payment_outboxes_event_type_check and payouts_amount_currency_check are widened here and their previous forms are in 0007 and 0002; re-adding either fails against rows written under the wider tuple
--
-- Refund, dispute and payout lifecycle (#49). Every statement below is additive
-- or WIDENS, so the image still serving is unaffected by all of it:
--
--   * `disputes` is a brand-new table. The old image never selects from it.
--
--   * `refunds` gains nine nullable columns and their CHECKs. A row the old
--     image writes leaves all nine NULL, which every new CHECK accepts by
--     construction (`num_nonnulls(...) in (0, 2)` is satisfied by the 0 case).
--     Adding them late would instead 500 the first refund the NEW image takes —
--     and a refund that fails after its inventory has been restocked is the one
--     write in this domain that cannot simply be retried.
--
--   * `payment_outboxes_event_type_check` is dropped and re-added over a STRICT
--     SUPERSET, gaining `refund_failed`, `reversal_failed` and
--     `refund_unmatched` — the same shape #46 and #47 used. The old image cannot
--     produce the new values; the reverse order would reject the first
--     operator exception the new image recorded, and each of those rows IS the
--     record of money that moved wrongly.
--
--   * `payouts_amount_currency_check` is DROPPED and not replaced, which only
--     widens what the column accepts. A payout is denominated in the SELLER's
--     own settlement currency, which the provider chooses from the account's
--     country — several EEA currencies a seller may legitimately be paid in
--     (RON, CZK, HUF, BGN) are not in `ALL_CURRENCY_CODES`, and the CHECK would
--     have rejected the RECORD of a payout that has already happened. It is the
--     third such exemption, beside `provider_accounts.default_currency` and
--     `connections.shop_currency`, and for the same reason: Mercaria neither
--     prices nor converts this figure. A length bound replaces it, which is all
--     a code Mercaria does not interpret can honestly be held to.
--
-- The re-added event-type CHECK revalidates every existing row against the
-- wider set, which the nine previous values trivially satisfy.

CREATE TABLE "disputes" (
	"id" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"provider_dispute_id" text NOT NULL,
	"payment_id" text NOT NULL,
	"order_id" text,
	"amount_amount" bigint NOT NULL,
	"amount_currency" text NOT NULL,
	"fee_amount" bigint DEFAULT 0 NOT NULL,
	"reason" text,
	"status" text NOT NULL,
	"evidence_due_by" timestamp with time zone,
	"opened_booked_at" timestamp with time zone,
	"outcome" text,
	"closed_at" timestamp with time zone,
	"recovery_state" text,
	"provider_reversal_id" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "disputes_provider_check" CHECK ("disputes"."provider" in ('external', 'manual_pos', 'mock', 'stripe')),
	CONSTRAINT "disputes_status_check" CHECK ("disputes"."status" in ('warning', 'needs_response', 'under_review', 'won', 'lost')),
	CONSTRAINT "disputes_outcome_check" CHECK ("disputes"."outcome" in ('won', 'lost')),
	CONSTRAINT "disputes_recovery_state_check" CHECK ("disputes"."recovery_state" in ('not_required', 'pending', 'succeeded', 'failed')),
	CONSTRAINT "disputes_amount_currency_check" CHECK ("disputes"."amount_currency" in ('FAIR', 'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF', 'CNY', 'SEK', 'NOK', 'DKK', 'PLN', 'MXN', 'BRL', 'INR', 'NZD', 'ZAR', 'SGD', 'HKD', 'AED')),
	CONSTRAINT "disputes_amount_check" CHECK ("disputes"."amount_amount" >= 0 and "disputes"."fee_amount" >= 0),
	CONSTRAINT "disputes_outcome_closed_check" CHECK (("disputes"."outcome" is null) = ("disputes"."closed_at" is null))
);
--> statement-breakpoint
ALTER TABLE "payment_outboxes" DROP CONSTRAINT "payment_outboxes_event_type_check";--> statement-breakpoint
ALTER TABLE "payouts" DROP CONSTRAINT "payouts_amount_currency_check";--> statement-breakpoint
ALTER TABLE "refunds" ADD COLUMN "provider" text;--> statement-breakpoint
ALTER TABLE "refunds" ADD COLUMN "payment_id" text;--> statement-breakpoint
ALTER TABLE "refunds" ADD COLUMN "provider_refund_id" text;--> statement-breakpoint
ALTER TABLE "refunds" ADD COLUMN "provider_state" text;--> statement-breakpoint
ALTER TABLE "refunds" ADD COLUMN "provider_failure_code" text;--> statement-breakpoint
ALTER TABLE "refunds" ADD COLUMN "reversal_state" text;--> statement-breakpoint
ALTER TABLE "refunds" ADD COLUMN "provider_reversal_id" text;--> statement-breakpoint
ALTER TABLE "refunds" ADD COLUMN "reversal_amount_amount" bigint;--> statement-breakpoint
ALTER TABLE "refunds" ADD COLUMN "reversal_amount_currency" text;--> statement-breakpoint
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "disputes_provider_dispute_id_key" ON "disputes" USING btree ("provider","provider_dispute_id");--> statement-breakpoint
CREATE INDEX "disputes_payment_id_created_at_idx" ON "disputes" USING btree ("payment_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "disputes_order_id_created_at_idx" ON "disputes" USING btree ("order_id","created_at" DESC NULLS LAST) WHERE "disputes"."order_id" is not null;--> statement-breakpoint
CREATE INDEX "disputes_open_evidence_due_idx" ON "disputes" USING btree ("evidence_due_by") WHERE "disputes"."closed_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "refunds_provider_refund_id_key" ON "refunds" USING btree ("provider","provider_refund_id") WHERE "refunds"."provider_refund_id" is not null;--> statement-breakpoint
CREATE INDEX "refunds_provider_state_created_at_idx" ON "refunds" USING btree ("provider_state","created_at") WHERE "refunds"."provider_state" is not null;--> statement-breakpoint
CREATE INDEX "refunds_payment_id_created_at_idx" ON "refunds" USING btree ("payment_id","created_at" DESC NULLS LAST) WHERE "refunds"."payment_id" is not null;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_provider_check" CHECK ("refunds"."provider" in ('external', 'manual_pos', 'mock', 'stripe'));--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_provider_state_check" CHECK ("refunds"."provider_state" in ('pending', 'succeeded', 'failed', 'canceled'));--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_reversal_state_check" CHECK ("refunds"."reversal_state" in ('not_required', 'pending', 'succeeded', 'failed'));--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_reversal_amount_currency_check" CHECK ("refunds"."reversal_amount_currency" in ('FAIR', 'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF', 'CNY', 'SEK', 'NOK', 'DKK', 'PLN', 'MXN', 'BRL', 'INR', 'NZD', 'ZAR', 'SGD', 'HKD', 'AED'));--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_provider_operation_complete_check" CHECK (num_nonnulls("refunds"."provider", "refunds"."provider_state") in (0, 2));--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_reversal_complete_check" CHECK (num_nonnulls("refunds"."reversal_amount_amount", "refunds"."reversal_amount_currency") in (0, 2));--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_reversal_amount_check" CHECK ("refunds"."reversal_amount_amount" is null or "refunds"."reversal_amount_amount" >= 0);--> statement-breakpoint
ALTER TABLE "payment_outboxes" ADD CONSTRAINT "payment_outboxes_event_type_check" CHECK ("payment_outboxes"."event_type" in ('payment_succeeded', 'payment_failed', 'payment_succeeded_after_release', 'transfer_withheld', 'payment_refunded', 'payment_disputed', 'transfer_changed', 'payout_changed', 'provider_account_changed', 'refund_failed', 'reversal_failed', 'refund_unmatched'));--> statement-breakpoint
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_amount_currency_length_check" CHECK (length("payouts"."amount_currency") between 3 and 8);