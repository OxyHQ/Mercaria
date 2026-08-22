-- oxy:deploy-phase=pre
-- oxy:rollback=derived
--
-- Epic #367 line 75 — "Keep historical order/payment/refund snapshots
-- immutable". Two functions and ten triggers; no table, column, constraint or
-- index is added, dropped, renamed or narrowed, and no existing row is written.
--
-- ## Why `pre` rather than `post`
--
-- A `post` statement is one that breaks a write the PREVIOUS image performs.
-- None of these does. Every column frozen below is either written by no code
-- path at all, or written exactly once behind a compare-and-swap the repository
-- already issues (`isNull(...)` on `payments.provider_object_id`,
-- `transfers.provider_object_id`, `refunds.provider_refund_id`,
-- `refunds.provider_reversal_id`, `disputes.opened_booked_at`,
-- `provider_accounts.revoked_at`, and a SQL `coalesce` on
-- `provider_accounts.activated_at`). The serving image and the arriving image
-- perform the same writes, so both run cleanly against this schema and the
-- rollout order does not matter.
--
-- ## Why WRITE-ONCE and not a plain freeze
--
-- The guard is `OLD IS NOT NULL AND NEW IS DISTINCT FROM OLD`, so a NULL -> value
-- stamp is permitted and rewriting a recorded fact is not. That is what makes a
-- captured amount freezable at all: `payments.platform_amount` and its five FX
-- companions are NULL until the charge settles and are stamped once, and the
-- reconciliation sweep re-applies the SAME figures through the SAME function a
-- webhook uses — which is not a rewrite and must keep working. On a NOT NULL
-- column the rule degenerates to a plain freeze, which is the intended reading
-- there.
--
-- ## Why NOTHING here refuses a DELETE
--
-- Measured, not conceded. `payment_provider_events` and `payment_outboxes` are
-- DELETE targets of the shared retention sweep (`db/expiryTargets.ts`), so a
-- DELETE trigger would make retention fail SILENTLY; `refund_line_items` is
-- reached by the FK cascade from `refunds`; and five realdb files plus
-- `scripts/seed.ts` delete payments, refunds, disputes and attempts in teardown.
-- The ledger tables can refuse DELETE because nothing deletes them — these
-- cannot. #90's condition photos set the precedent: permit the DELETE so the
-- cascade the foreign key already declares still works.
--
-- ## HAND-WRITTEN, ENTIRELY
--
-- drizzle-kit models no trigger and no function, so `db:generate` will emit NONE
-- of this and a regeneration DESTROYS the file. It was created with
-- `drizzle-kit generate --custom`, which writes `meta/_journal.json` correctly;
-- never hand-edit the journal or rename the file. The declared half lives in
-- `src/db/commerceHistoryDispositions.ts` and
-- `commerce-history-immutability.realdb.test.ts` executes every line of it
-- against a real server, including asserting that each trigger below freezes
-- EXACTLY the columns that file declares.


-- Every statement below is HAND-WRITTEN and anchored between an
-- `-- oxy:handwritten-begin=<name>` and its matching `-- oxy:handwritten-end=`,
-- which `migration-handwritten-markers.test.ts` gates. Verify after any edit:
--   grep -c '^-- oxy:handwritten-begin=' drizzle/0135_commerce_history_snapshot_triggers.sql   # 2
--   grep -c '^-- oxy:handwritten-end='   drizzle/0135_commerce_history_snapshot_triggers.sql   # 2

-- oxy:handwritten-begin=mercaria_commerce_snapshot_append_only
-- Refuse every UPDATE of the row.
--
-- Shared by the two tables nothing updates at all, the way
-- mercaria_ledger_append_only() is shared by the two ledger tables. It names the
-- table in the message so an operator reading the error does not have to work
-- out which append-only record they hit.
CREATE OR REPLACE FUNCTION mercaria_commerce_snapshot_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION
    '% is an append-only commerce snapshot and its rows cannot be rewritten', TG_TABLE_NAME
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

-- The log of what Mercaria asked a rail and what it answered.
-- recordPaymentAttempt INSERTS and nothing in the tree updates an attempt.
CREATE TRIGGER payment_attempts_append_only
  BEFORE UPDATE ON "payment_attempts"
  FOR EACH ROW EXECUTE FUNCTION mercaria_commerce_snapshot_append_only();--> statement-breakpoint

-- What was refunded, per line. No updater exists and the table carries no
-- updated_at at all, which is the schema already saying this.
CREATE TRIGGER refund_line_items_append_only
  BEFORE UPDATE ON "refund_line_items"
  FOR EACH ROW EXECUTE FUNCTION mercaria_commerce_snapshot_append_only();--> statement-breakpoint
-- oxy:handwritten-end=mercaria_commerce_snapshot_append_only

-- oxy:handwritten-begin=mercaria_commerce_snapshot_columns_immutable
-- Freeze the columns named in the trigger's own arguments.
--
-- One function taking a column LIST rather than eight functions with the column
-- names written into their bodies: the list then lives in the CREATE TRIGGER
-- statement, where it can be read back out of pg_trigger and compared against
-- the declaration. Eight hand-written bodies would each be a separate chance to
-- spell a column wrong, and a misspelled column in a body enforces NOTHING while
-- looking exactly like enforcement.
--
-- to_jsonb(OLD) -> col yields the jsonb null for a SQL NULL, never SQL NULL, so
-- "OLD IS NOT NULL" is <> 'null'::jsonb. The IS NULL check beside it is the
-- different question of whether the key exists at all, which would mean a
-- trigger naming a column its table does not have.
--
-- A NULL TG_ARGV is refused rather than looping zero times: a freeze trigger
-- that freezes nothing is a defect, and FOREACH over a NULL array raises 22004,
-- which reads as a refusal and would make the trigger look like it was working.
CREATE OR REPLACE FUNCTION mercaria_commerce_snapshot_columns_immutable() RETURNS trigger AS $$
DECLARE
  col text;
  old_row jsonb := to_jsonb(OLD);
  new_row jsonb := to_jsonb(NEW);
BEGIN
  IF TG_ARGV IS NULL OR coalesce(array_length(TG_ARGV, 1), 0) = 0 THEN
    RAISE EXCEPTION
      'trigger % on % freezes no columns', TG_NAME, TG_TABLE_NAME
      USING ERRCODE = 'check_violation';
  END IF;
  FOREACH col IN ARRAY TG_ARGV LOOP
    IF old_row -> col IS NULL THEN
      RAISE EXCEPTION
        'trigger % names %.%, which does not exist', TG_NAME, TG_TABLE_NAME, col
        USING ERRCODE = 'check_violation';
    END IF;
    IF old_row -> col <> 'null'::jsonb
       AND new_row -> col IS DISTINCT FROM old_row -> col THEN
      RAISE EXCEPTION
        '%.% is a historical commerce snapshot and cannot be rewritten', TG_TABLE_NAME, col
        USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

-- The lifecycle status moves and is the whole reason the row is not frozen;
-- what the buyer was CHARGED, what actually LANDED, and the FX snapshot that
-- relates them do not.
CREATE TRIGGER payments_snapshot_immutable
  BEFORE UPDATE ON "payments"
  FOR EACH ROW EXECUTE FUNCTION mercaria_commerce_snapshot_columns_immutable(
    'checkout_group_id', 'buyer_oxy_user_id', 'provider', 'order_id',
    'presentment_amount', 'presentment_currency', 'provider_object_id',
    'platform_amount', 'platform_currency', 'platform_rate_from',
    'platform_rate_to', 'platform_rate_rate', 'platform_rate_provider',
    'platform_rate_as_of');--> statement-breakpoint

-- #49 keeps THREE states of one refund on this row and they run on different
-- clocks, so status, provider_state, reversal_state, provider_failure_code and
-- the reversal amount stay open. What the refund WAS FOR does not move.
CREATE TRIGGER refunds_snapshot_immutable
  BEFORE UPDATE ON "refunds"
  FOR EACH ROW EXECUTE FUNCTION mercaria_commerce_snapshot_columns_immutable(
    'order_id', 'store_id', 'seller_oxy_user_id', 'type',
    'refund_shipping_shop_amount', 'refund_shipping_shop_currency',
    'refund_shipping_presentment_amount', 'refund_shipping_presentment_currency',
    'total_refunded_shop_amount', 'total_refunded_shop_currency',
    'total_refunded_presentment_amount', 'total_refunded_presentment_currency',
    'restocked_at', 'processed_by_oxy_user_id', 'idempotency_key', 'provider',
    'payment_id', 'provider_refund_id', 'provider_reversal_id');--> statement-breakpoint

-- The seller's share as seller-net-shares.ts computed it. status and
-- reversed_amount stay open because reversals are cumulative and their events
-- unordered, so the figure only moves FORWARD under greatest().
CREATE TRIGGER transfers_snapshot_immutable
  BEFORE UPDATE ON "transfers"
  FOR EACH ROW EXECUTE FUNCTION mercaria_commerce_snapshot_columns_immutable(
    'payment_id', 'order_id', 'provider', 'amount_amount', 'amount_currency',
    'provider_object_id');--> statement-breakpoint

-- A payout BOOKS nothing (ADR 0001 D6 settled the receivable at transfer time),
-- so status, arrival and failure code converge from the rail -- but the amount
-- it paid and the account it paid is a fact as it stood.
CREATE TRIGGER payouts_snapshot_immutable
  BEFORE UPDATE ON "payouts"
  FOR EACH ROW EXECUTE FUNCTION mercaria_commerce_snapshot_columns_immutable(
    'provider', 'provider_account_ref', 'provider_object_id', 'amount_amount',
    'amount_currency');--> statement-breakpoint

-- The identity of the dispute and the instant its opening was BOOKED.
--
-- amount_amount, amount_currency and fee_amount are deliberately NOT here:
-- disputeRepository's onConflictDoUpdate restates all three unconditionally on
-- every redelivery, which a real inquiry-to-chargeback escalation needs. That
-- the ledger is booked from them AFTER that upsert, with nothing reconciling a
-- later move, is a defect tracked as #867 -- and its fix is a guard on the
-- upsert, not a freeze here, which would break ingestion outright.
CREATE TRIGGER disputes_snapshot_immutable
  BEFORE UPDATE ON "disputes"
  FOR EACH ROW EXECUTE FUNCTION mercaria_commerce_snapshot_columns_immutable(
    'provider', 'provider_dispute_id', 'payment_id', 'opened_booked_at');--> statement-breakpoint

-- WHOSE account this is. UNIQUE(provider, owner_type, owner_id) is #46's
-- security boundary and a connected account cannot be un-created, so re-pointing
-- the row at another owner is the write that must be impossible rather than
-- merely unusual. Every readiness and requirement column beside it moves at each
-- sync.
CREATE TRIGGER provider_accounts_snapshot_immutable
  BEFORE UPDATE ON "provider_accounts"
  FOR EACH ROW EXECUTE FUNCTION mercaria_commerce_snapshot_columns_immutable(
    'provider', 'owner_type', 'owner_id', 'provider_account_id', 'country',
    'activated_at', 'revoked_at');--> statement-breakpoint

-- What the provider SAID. The claim columns beside it move because the row is
-- also the job. payment_id is frozen write-once, which additionally closes a
-- hole: three writers set it with no compare-and-swap, so a re-resolution to a
-- DIFFERENT payment would silently reattribute a stored event.
CREATE TRIGGER payment_provider_events_snapshot_immutable
  BEFORE UPDATE ON "payment_provider_events"
  FOR EACH ROW EXECUTE FUNCTION mercaria_commerce_snapshot_columns_immutable(
    'provider', 'provider_account_id', 'provider_event_id', 'type', 'livemode',
    'api_version', 'object_ids', 'payload_summary', 'received_at',
    'payment_id');--> statement-breakpoint

-- The ROW IS THE JOB, so the lease, the attempt count and the schedule all move;
-- what the job IS does not.
CREATE TRIGGER payment_outboxes_snapshot_immutable
  BEFORE UPDATE ON "payment_outboxes"
  FOR EACH ROW EXECUTE FUNCTION mercaria_commerce_snapshot_columns_immutable(
    'event_type', 'payload');
-- oxy:handwritten-end=mercaria_commerce_snapshot_columns_immutable
