-- oxy:deploy-phase=pre
-- oxy:rollback=restore: the narrower orders_payment_provider_check and the dropped orders_fx_rate_complete_check are in 0000, as is payment_provider's old default and NOT NULL; re-tightening fails against any order written with a NULL provider
--
-- The payment domain and the internal ledger: eight new tables, plus the
-- columns on `orders` that point at them.
--
-- `pre` because every statement below is additive or WIDENING, so it is correct
-- against the image still serving AND the one arriving:
--
--   * eight tables the old image does not know about and cannot read;
--   * `orders.payment_id`, a new nullable column nothing yet writes;
--   * `orders.payment_provider` losing its NOT NULL and its `oxy_pay` default —
--     the old image always sets the column explicitly, so relaxing it takes
--     nothing away from it;
--   * `orders_payment_provider_check` re-created over the UNION of the old and
--     new provider sets, so both images' values pass. Narrowing it to the new
--     set alone is the `post` migration beside this one, applied once no image
--     that writes `oxy_pay` is still running.
--
-- The one statement that is not purely additive is
-- `orders_fx_rate_complete_check`, which #44 widened from four columns to five
-- by adding `fx_rate_provider` to the snapshot's identity. Against DATA that is
-- a tightening — a row carrying the other four and no provider would now be
-- refused. It is safe here because there are no such rows anywhere: the
-- Postgres `orders` table has never been a write path in any environment, and
-- the image that will write it sets `fx_rate_provider` from the same commit
-- that added the column.
--
-- ## The ledger triggers at the bottom are hand-written, and have to be
--
-- drizzle-kit does not model triggers, so the append-only enforcement on
-- `ledger_transactions` and `ledger_entries` is appended here by hand — the same
-- precedent `0001_counter_sequences.sql` set for the sequences drizzle-kit
-- likewise does not model. Keeping it in THIS migration rather than a later one
-- matters: a window in which the tables exist and the trigger does not is a
-- window in which an UPDATE would succeed.

CREATE TABLE "payment_attempts" (
	"id" text PRIMARY KEY NOT NULL,
	"payment_id" text NOT NULL,
	"sequence" integer NOT NULL,
	"provider" text NOT NULL,
	"provider_object_id" text,
	"status" text NOT NULL,
	"error_code" text,
	"error_message" text,
	"idempotency_key" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "payment_attempts_provider_check" CHECK ("payment_attempts"."provider" in ('external', 'manual_pos', 'mock')),
	CONSTRAINT "payment_attempts_status_check" CHECK ("payment_attempts"."status" in ('pending', 'succeeded', 'failed')),
	CONSTRAINT "payment_attempts_sequence_check" CHECK ("payment_attempts"."sequence" >= 1),
	CONSTRAINT "payment_attempts_error_message_length_check" CHECK ("payment_attempts"."error_message" is null or length("payment_attempts"."error_message") <= 2000)
);
--> statement-breakpoint
CREATE TABLE "payment_outboxes" (
	"id" text PRIMARY KEY NOT NULL,
	"event_type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone NOT NULL,
	"lease_owner" text,
	"lease_until" timestamp with time zone,
	"last_error" text,
	"processed_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "payment_outboxes_event_type_check" CHECK ("payment_outboxes"."event_type" in ('payment_succeeded', 'payment_failed', 'payment_refunded', 'payment_disputed', 'transfer_changed', 'payout_changed')),
	CONSTRAINT "payment_outboxes_status_check" CHECK ("payment_outboxes"."status" in ('pending', 'processing', 'processed', 'dead_letter')),
	CONSTRAINT "payment_outboxes_attempts_check" CHECK ("payment_outboxes"."attempts" >= 0),
	CONSTRAINT "payment_outboxes_last_error_length_check" CHECK ("payment_outboxes"."last_error" is null or length("payment_outboxes"."last_error") <= 2000)
);
--> statement-breakpoint
CREATE TABLE "payment_provider_events" (
	"id" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"provider_account_id" text,
	"provider_event_id" text NOT NULL,
	"type" text NOT NULL,
	"livemode" boolean NOT NULL,
	"api_version" text,
	"object_ids" jsonb NOT NULL,
	"payload_summary" jsonb NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'received' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"processed_at" timestamp with time zone,
	"payment_id" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "payment_provider_events_provider_event_key" UNIQUE NULLS NOT DISTINCT("provider","provider_account_id","provider_event_id"),
	CONSTRAINT "payment_provider_events_provider_check" CHECK ("payment_provider_events"."provider" in ('external', 'manual_pos', 'mock')),
	CONSTRAINT "payment_provider_events_status_check" CHECK ("payment_provider_events"."status" in ('received', 'processing', 'processed', 'failed', 'dead_letter')),
	CONSTRAINT "payment_provider_events_attempts_check" CHECK ("payment_provider_events"."attempts" >= 0),
	CONSTRAINT "payment_provider_events_last_error_length_check" CHECK ("payment_provider_events"."last_error" is null or length("payment_provider_events"."last_error") <= 2000)
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" text PRIMARY KEY NOT NULL,
	"checkout_group_id" text NOT NULL,
	"buyer_oxy_user_id" text,
	"provider" text NOT NULL,
	"order_id" text,
	"status" text DEFAULT 'created' NOT NULL,
	"presentment_amount" bigint NOT NULL,
	"presentment_currency" text NOT NULL,
	"platform_amount" bigint,
	"platform_currency" text,
	"platform_rate_from" text,
	"platform_rate_to" text,
	"platform_rate_rate" double precision,
	"platform_rate_provider" text,
	"platform_rate_as_of" text,
	"provider_object_id" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "payments_provider_check" CHECK ("payments"."provider" in ('external', 'manual_pos', 'mock')),
	CONSTRAINT "payments_status_check" CHECK ("payments"."status" in ('created', 'requires_action', 'processing', 'succeeded', 'failed', 'canceled', 'refunded', 'partially_refunded')),
	CONSTRAINT "payments_presentment_currency_check" CHECK ("payments"."presentment_currency" in ('FAIR', 'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF', 'CNY', 'SEK', 'NOK', 'DKK', 'PLN', 'MXN', 'BRL', 'INR', 'NZD', 'ZAR', 'SGD', 'HKD', 'AED')),
	CONSTRAINT "payments_platform_currency_check" CHECK ("payments"."platform_currency" in ('FAIR', 'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF', 'CNY', 'SEK', 'NOK', 'DKK', 'PLN', 'MXN', 'BRL', 'INR', 'NZD', 'ZAR', 'SGD', 'HKD', 'AED')),
	CONSTRAINT "payments_platform_conversion_complete_check" CHECK (num_nonnulls("payments"."platform_amount", "payments"."platform_currency", "payments"."platform_rate_from", "payments"."platform_rate_to", "payments"."platform_rate_rate", "payments"."platform_rate_provider", "payments"."platform_rate_as_of") in (0, 7)),
	CONSTRAINT "payments_external_order_check" CHECK (("payments"."provider" = 'external') = ("payments"."order_id" is not null)),
	CONSTRAINT "payments_presentment_amount_check" CHECK ("payments"."presentment_amount" >= 0)
);
--> statement-breakpoint
CREATE TABLE "payouts" (
	"id" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"provider_account_ref" text NOT NULL,
	"provider_object_id" text NOT NULL,
	"amount_amount" bigint NOT NULL,
	"amount_currency" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"arrival_at" timestamp with time zone,
	"failure_code" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "payouts_provider_check" CHECK ("payouts"."provider" in ('external', 'manual_pos', 'mock')),
	CONSTRAINT "payouts_status_check" CHECK ("payouts"."status" in ('pending', 'in_transit', 'paid', 'failed', 'canceled')),
	CONSTRAINT "payouts_amount_currency_check" CHECK ("payouts"."amount_currency" in ('FAIR', 'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF', 'CNY', 'SEK', 'NOK', 'DKK', 'PLN', 'MXN', 'BRL', 'INR', 'NZD', 'ZAR', 'SGD', 'HKD', 'AED')),
	CONSTRAINT "payouts_amount_check" CHECK ("payouts"."amount_amount" >= 0)
);
--> statement-breakpoint
CREATE TABLE "transfers" (
	"id" text PRIMARY KEY NOT NULL,
	"payment_id" text NOT NULL,
	"order_id" text NOT NULL,
	"provider" text NOT NULL,
	"provider_object_id" text,
	"amount_amount" bigint NOT NULL,
	"amount_currency" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"reversed_amount" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "transfers_provider_check" CHECK ("transfers"."provider" in ('external', 'manual_pos', 'mock')),
	CONSTRAINT "transfers_status_check" CHECK ("transfers"."status" in ('pending', 'paid', 'failed', 'reversed', 'canceled')),
	CONSTRAINT "transfers_amount_currency_check" CHECK ("transfers"."amount_currency" in ('FAIR', 'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF', 'CNY', 'SEK', 'NOK', 'DKK', 'PLN', 'MXN', 'BRL', 'INR', 'NZD', 'ZAR', 'SGD', 'HKD', 'AED')),
	CONSTRAINT "transfers_amount_check" CHECK ("transfers"."amount_amount" >= 0),
	CONSTRAINT "transfers_reversed_amount_check" CHECK ("transfers"."reversed_amount" >= 0 and "transfers"."reversed_amount" <= "transfers"."amount_amount")
);
--> statement-breakpoint
CREATE TABLE "ledger_entries" (
	"id" text PRIMARY KEY NOT NULL,
	"transaction_id" text NOT NULL,
	"account" text NOT NULL,
	"owner_type" text,
	"owner_id" text,
	"currency" text NOT NULL,
	"amount_minor" bigint NOT NULL,
	"order_id" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "ledger_entries_account_check" CHECK ("ledger_entries"."account" in ('provider_clearing', 'merchant_payable', 'commission_revenue', 'processor_expense', 'refunds', 'disputes', 'reserves')),
	CONSTRAINT "ledger_entries_owner_type_check" CHECK ("ledger_entries"."owner_type" in ('store', 'user')),
	CONSTRAINT "ledger_entries_currency_check" CHECK ("ledger_entries"."currency" in ('FAIR', 'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF', 'CNY', 'SEK', 'NOK', 'DKK', 'PLN', 'MXN', 'BRL', 'INR', 'NZD', 'ZAR', 'SGD', 'HKD', 'AED')),
	CONSTRAINT "ledger_entries_amount_nonzero_check" CHECK ("ledger_entries"."amount_minor" <> 0),
	CONSTRAINT "ledger_entries_owner_complete_check" CHECK (num_nonnulls("ledger_entries"."owner_type", "ledger_entries"."owner_id") in (0, 2))
);
--> statement-breakpoint
CREATE TABLE "ledger_transactions" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"payment_id" text,
	"order_id" text,
	"refund_id" text,
	"dispute_ref" text,
	"description" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "ledger_transactions_kind_check" CHECK ("ledger_transactions"."kind" in ('charge_succeeded', 'transfer_created', 'refund', 'transfer_reversal', 'dispute_created', 'dispute_won', 'dispute_lost', 'adjustment'))
);
--> statement-breakpoint
ALTER TABLE "orders" DROP CONSTRAINT "orders_payment_provider_check";--> statement-breakpoint
ALTER TABLE "orders" DROP CONSTRAINT "orders_fx_rate_complete_check";--> statement-breakpoint
ALTER TABLE "orders" ALTER COLUMN "payment_provider" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "orders" ALTER COLUMN "payment_provider" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "fx_rate_provider" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "payment_id" text;--> statement-breakpoint
ALTER TABLE "payment_attempts" ADD CONSTRAINT "payment_attempts_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_provider_events" ADD CONSTRAINT "payment_provider_events_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfers" ADD CONSTRAINT "transfers_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_transaction_id_ledger_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."ledger_transactions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_transactions" ADD CONSTRAINT "ledger_transactions_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "payment_attempts_payment_id_sequence_key" ON "payment_attempts" USING btree ("payment_id","sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_attempts_idempotency_key_key" ON "payment_attempts" USING btree ("idempotency_key") WHERE "payment_attempts"."idempotency_key" is not null;--> statement-breakpoint
CREATE INDEX "payment_attempts_payment_id_created_at_idx" ON "payment_attempts" USING btree ("payment_id","created_at");--> statement-breakpoint
CREATE INDEX "payment_outboxes_pending_idx" ON "payment_outboxes" USING btree ("available_at","created_at") WHERE "payment_outboxes"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "payment_outboxes_reclaim_idx" ON "payment_outboxes" USING btree ("lease_until","created_at") WHERE "payment_outboxes"."status" = 'processing';--> statement-breakpoint
CREATE INDEX "payment_outboxes_expires_at_idx" ON "payment_outboxes" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "payment_provider_events_status_received_at_idx" ON "payment_provider_events" USING btree ("status","received_at");--> statement-breakpoint
CREATE INDEX "payment_provider_events_payment_id_received_at_idx" ON "payment_provider_events" USING btree ("payment_id","received_at" DESC NULLS LAST) WHERE "payment_provider_events"."payment_id" is not null;--> statement-breakpoint
CREATE INDEX "payment_provider_events_expires_at_idx" ON "payment_provider_events" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "payments_checkout_group_id_key" ON "payments" USING btree ("checkout_group_id") WHERE "payments"."provider" <> 'external';--> statement-breakpoint
CREATE UNIQUE INDEX "payments_external_order_id_key" ON "payments" USING btree ("order_id") WHERE "payments"."provider" = 'external';--> statement-breakpoint
CREATE INDEX "payments_provider_object_id_idx" ON "payments" USING btree ("provider","provider_object_id") WHERE "payments"."provider_object_id" is not null;--> statement-breakpoint
CREATE INDEX "payments_buyer_created_at_idx" ON "payments" USING btree ("buyer_oxy_user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "payments_status_created_at_idx" ON "payments" USING btree ("status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "payouts_provider_object_id_key" ON "payouts" USING btree ("provider","provider_object_id");--> statement-breakpoint
CREATE INDEX "payouts_account_created_at_idx" ON "payouts" USING btree ("provider_account_ref","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "payouts_status_created_at_idx" ON "payouts" USING btree ("status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "transfers_payment_id_order_id_key" ON "transfers" USING btree ("payment_id","order_id");--> statement-breakpoint
CREATE INDEX "transfers_order_id_created_at_idx" ON "transfers" USING btree ("order_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "transfers_provider_object_id_idx" ON "transfers" USING btree ("provider","provider_object_id") WHERE "transfers"."provider_object_id" is not null;--> statement-breakpoint
CREATE INDEX "transfers_status_created_at_idx" ON "transfers" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "ledger_entries_transaction_id_idx" ON "ledger_entries" USING btree ("transaction_id");--> statement-breakpoint
CREATE INDEX "ledger_entries_account_currency_created_at_idx" ON "ledger_entries" USING btree ("account","currency","created_at");--> statement-breakpoint
CREATE INDEX "ledger_entries_owner_created_at_idx" ON "ledger_entries" USING btree ("owner_type","owner_id","created_at" DESC NULLS LAST) WHERE "ledger_entries"."owner_id" is not null;--> statement-breakpoint
CREATE INDEX "ledger_entries_order_id_idx" ON "ledger_entries" USING btree ("order_id") WHERE "ledger_entries"."order_id" is not null;--> statement-breakpoint
CREATE INDEX "ledger_transactions_payment_id_created_at_idx" ON "ledger_transactions" USING btree ("payment_id","created_at") WHERE "ledger_transactions"."payment_id" is not null;--> statement-breakpoint
CREATE INDEX "ledger_transactions_order_id_created_at_idx" ON "ledger_transactions" USING btree ("order_id","created_at") WHERE "ledger_transactions"."order_id" is not null;--> statement-breakpoint
CREATE INDEX "ledger_transactions_refund_id_idx" ON "ledger_transactions" USING btree ("refund_id") WHERE "ledger_transactions"."refund_id" is not null;--> statement-breakpoint
CREATE INDEX "ledger_transactions_kind_created_at_idx" ON "ledger_transactions" USING btree ("kind","created_at");--> statement-breakpoint
CREATE INDEX "orders_payment_id_idx" ON "orders" USING btree ("payment_id") WHERE "orders"."payment_id" is not null;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_payment_provider_check" CHECK ("orders"."payment_provider" in ('oxy_pay', 'external', 'manual_pos', 'mock'));--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_fx_rate_complete_check" CHECK (num_nonnulls("orders"."fx_rate_from", "orders"."fx_rate_to", "orders"."fx_rate_rate", "orders"."fx_rate_provider", "orders"."fx_rate_as_of") in (0, 5));
--> statement-breakpoint
-- ── The ledger is append-only, and the database is what enforces it ──────────
--
-- `db/payments/ledgerRepository.ts` is the only writer and refuses an
-- unbalanced transaction before issuing any SQL. That is the check with the good
-- error message, and it is not the one that matters here: it protects only the
-- callers that go through it. A backfill script, an operator at a `psql`
-- prompt, a future service and an ORM feature nobody remembered all reach these
-- tables without passing that function, and each of them can turn an auditable
-- book of record into an editable one in a single statement.
--
-- Hence a trigger. It cannot be bypassed by any client, it is visible in
-- `\d ledger_entries`, and it fails LOUDLY with a message that says what to do
-- instead — a correction is a new transaction whose entries reverse the wrong
-- ones (#45 invariant 2), never an edit.
--
-- `BEFORE`, not `AFTER`: the exception must be raised before the row version is
-- written, so nothing is left half-done inside the transaction that tried.
-- SQLSTATE 23514 (`check_violation`) rather than a bare `RAISE`, so a caller can
-- classify it as the constraint failure it is instead of parsing English.
CREATE FUNCTION mercaria_ledger_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'ledger rows are append-only: % on %.% is refused. Correct a mistake with a '
    'reversing transaction, never by editing history.',
    TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME
    USING ERRCODE = 'check_violation';
END;
$$;--> statement-breakpoint
CREATE TRIGGER ledger_transactions_append_only
  BEFORE UPDATE OR DELETE ON "ledger_transactions"
  FOR EACH ROW EXECUTE FUNCTION mercaria_ledger_append_only();--> statement-breakpoint
CREATE TRIGGER ledger_entries_append_only
  BEFORE UPDATE OR DELETE ON "ledger_entries"
  FOR EACH ROW EXECUTE FUNCTION mercaria_ledger_append_only();
