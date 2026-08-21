-- oxy:deploy-phase=pre
-- oxy:rollback=derived
--
-- Payment reconciliation, discrepancies and operator repairs (#50). Every
-- statement below creates something new; nothing is dropped, renamed or
-- narrowed, so the image still serving is unaffected by all of it.
--
--   * `payment_discrepancies`, `payment_repairs` and `reconciliation_cursors`
--     are three brand-new tables. The old image never selects from any of them,
--     and the only foreign key added is between two of the new tables.
--
--   * No existing CHECK is dropped and re-added. That is worth stating because
--     the four migrations before this one all did: the new value sets here
--     (`PAYMENT_DISCREPANCY_KINDS`, `PAYMENT_REPAIR_ACTIONS`,
--     `RECONCILIATION_JOBS`) belong to tables that did not exist a moment ago,
--     so there is no existing column whose accepted set has to widen and no
--     revalidation of existing rows.
--
-- Ordering within the phase is `payment_discrepancies` first, because
-- `payment_repairs.discrepancy_id` references it — drizzle-kit emits the tables
-- first and the constraint afterwards, so the file is correct in either order,
-- but a reader checking the dependency should not have to work that out.
--
-- The three tables are deliberately NOT registered in `db/expiryTargets.ts` and
-- carry no `expires_at`. A discrepancy is Mercaria's record of having been
-- wrong about money, a repair is the record of a person acting on it, and a
-- cursor is a singleton — none of the three is the bounded, self-renewing kind
-- of row that registry exists for, and sweeping any of them would destroy an
-- audit trail on a timer.

CREATE TABLE "payment_discrepancies" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"severity" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"provider" text NOT NULL,
	"correlation_key" text NOT NULL,
	"payment_id" text,
	"order_id" text,
	"checkout_group_id" text,
	"provider_object_id" text,
	"detail" jsonb NOT NULL,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"occurrences" integer DEFAULT 1 NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolved_by" text,
	"resolved_reason" text,
	"resolution_note" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "payment_discrepancies_kind_check" CHECK ("payment_discrepancies"."kind" in ('payment_provider_paid_local_unpaid', 'payment_local_paid_provider_unpaid', 'payment_missing_locally', 'payment_amount_mismatch', 'transfer_missing_locally', 'transfer_amount_mismatch', 'refund_missing_locally', 'refund_amount_mismatch', 'payout_missing_locally', 'ledger_transaction_missing', 'ledger_unbalanced', 'merchant_payable_unexplained', 'account_state_drift', 'account_sync_failed')),
	CONSTRAINT "payment_discrepancies_severity_check" CHECK ("payment_discrepancies"."severity" in ('info', 'warning', 'critical')),
	CONSTRAINT "payment_discrepancies_status_check" CHECK ("payment_discrepancies"."status" in ('open', 'acknowledged', 'resolved')),
	CONSTRAINT "payment_discrepancies_provider_check" CHECK ("payment_discrepancies"."provider" in ('external', 'manual_pos', 'mock', 'stripe')),
	CONSTRAINT "payment_discrepancies_correlation_key_check" CHECK (length("payment_discrepancies"."correlation_key") > 0),
	CONSTRAINT "payment_discrepancies_occurrences_check" CHECK ("payment_discrepancies"."occurrences" >= 1),
	CONSTRAINT "payment_discrepancies_resolution_complete_check" CHECK (("payment_discrepancies"."status" = 'resolved') = (num_nonnulls("payment_discrepancies"."resolved_at", "payment_discrepancies"."resolved_by", "payment_discrepancies"."resolved_reason") = 3)),
	CONSTRAINT "payment_discrepancies_resolution_note_length_check" CHECK ("payment_discrepancies"."resolution_note" is null or length("payment_discrepancies"."resolution_note") <= 2000)
);
--> statement-breakpoint
CREATE TABLE "payment_repairs" (
	"id" text PRIMARY KEY NOT NULL,
	"action" text NOT NULL,
	"subject_key" text NOT NULL,
	"discrepancy_id" text,
	"actor_oxy_user_id" text NOT NULL,
	"reason" text NOT NULL,
	"outcome" text NOT NULL,
	"detail" jsonb NOT NULL,
	"payment_id" text,
	"order_id" text,
	"ledger_transaction_id" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "payment_repairs_action_check" CHECK ("payment_repairs"."action" in ('retry_withheld_transfer', 'retry_transfer_reversal', 'retry_provider_refund', 'book_reconciling_entry')),
	CONSTRAINT "payment_repairs_outcome_check" CHECK ("payment_repairs"."outcome" in ('applied', 'no_op', 'refused')),
	CONSTRAINT "payment_repairs_subject_key_check" CHECK (length("payment_repairs"."subject_key") > 0),
	CONSTRAINT "payment_repairs_actor_check" CHECK (length("payment_repairs"."actor_oxy_user_id") > 0),
	CONSTRAINT "payment_repairs_reason_check" CHECK (length("payment_repairs"."reason") > 0 and length("payment_repairs"."reason") <= 2000),
	CONSTRAINT "payment_repairs_reconciling_entry_discrepancy_check" CHECK ("payment_repairs"."action" <> 'book_reconciling_entry' or "payment_repairs"."discrepancy_id" is not null)
);
--> statement-breakpoint
CREATE TABLE "reconciliation_cursors" (
	"id" text PRIMARY KEY NOT NULL,
	"cursor" text,
	"window_start_at" timestamp with time zone,
	"last_run_at" timestamp with time zone,
	"last_completed_at" timestamp with time zone,
	"last_error" text,
	"lease_owner" text,
	"lease_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "reconciliation_cursors_id_check" CHECK ("reconciliation_cursors"."id" in ('open_payments', 'provider_objects', 'ledger_audit', 'account_readiness')),
	CONSTRAINT "reconciliation_cursors_last_error_length_check" CHECK ("reconciliation_cursors"."last_error" is null or length("reconciliation_cursors"."last_error") <= 2000),
	CONSTRAINT "reconciliation_cursors_lease_complete_check" CHECK (num_nonnulls("reconciliation_cursors"."lease_owner", "reconciliation_cursors"."lease_until") in (0, 2))
);
--> statement-breakpoint
ALTER TABLE "payment_repairs" ADD CONSTRAINT "payment_repairs_discrepancy_id_payment_discrepancies_id_fk" FOREIGN KEY ("discrepancy_id") REFERENCES "public"."payment_discrepancies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "payment_discrepancies_kind_correlation_key" ON "payment_discrepancies" USING btree ("kind","correlation_key");--> statement-breakpoint
CREATE INDEX "payment_discrepancies_open_idx" ON "payment_discrepancies" USING btree ("status","last_seen_at" DESC NULLS LAST) WHERE "payment_discrepancies"."status" <> 'resolved';--> statement-breakpoint
CREATE INDEX "payment_discrepancies_payment_id_idx" ON "payment_discrepancies" USING btree ("payment_id","last_seen_at" DESC NULLS LAST) WHERE "payment_discrepancies"."payment_id" is not null;--> statement-breakpoint
CREATE INDEX "payment_discrepancies_order_id_idx" ON "payment_discrepancies" USING btree ("order_id","last_seen_at" DESC NULLS LAST) WHERE "payment_discrepancies"."order_id" is not null;--> statement-breakpoint
CREATE INDEX "payment_discrepancies_kind_status_idx" ON "payment_discrepancies" USING btree ("kind","status");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_repairs_reconciling_entry_key" ON "payment_repairs" USING btree ("action","subject_key") WHERE "payment_repairs"."action" = 'book_reconciling_entry' and "payment_repairs"."outcome" = 'applied';--> statement-breakpoint
CREATE INDEX "payment_repairs_discrepancy_id_idx" ON "payment_repairs" USING btree ("discrepancy_id","created_at" DESC NULLS LAST) WHERE "payment_repairs"."discrepancy_id" is not null;--> statement-breakpoint
CREATE INDEX "payment_repairs_payment_id_idx" ON "payment_repairs" USING btree ("payment_id","created_at" DESC NULLS LAST) WHERE "payment_repairs"."payment_id" is not null;--> statement-breakpoint
CREATE INDEX "payment_repairs_action_created_at_idx" ON "payment_repairs" USING btree ("action","created_at" DESC NULLS LAST);