-- oxy:deploy-phase=pre
-- oxy:rollback=restore: `reconciliation_cursors_id_check` is widened; the previous form is in 0063, and re-adding it fails once the runner has written the `withheld_transfers` cursor row
--
-- The high-value transfer HOLD and the sweep that releases it (#988), one
-- migration because they are one feature: `services/payments/high-value-hold.ts`
-- decides the wait and
-- `services/payments/reconciliation/withheld-transfers.job.ts` ends it. A hold
-- with no releaser is a payout that never arrives.
--
-- Purely ADDITIVE. A nullable column, a partial index, and one widening whose
-- new tuple is a strict superset of the old, so every write the serving image
-- performs still passes:
--
--   * `transfers.held_until`               new, NULL for every existing row
--   * `transfers_held_until_idx`           new, partial
--   * `reconciliation_cursors_id_check`    + withheld_transfers
--
-- ## No CONCURRENTLY, and no lock worth planning around
--
-- `CREATE INDEX CONCURRENTLY` may not run inside a transaction block and
-- `db/migrate.ts` runs the chain in one — `0070`'s header works this through.
-- The build scans `transfers`, which on every deployment that has one is EMPTY:
-- the Stripe rail has never been enabled in production, so no transfer has ever
-- been written. The scan is over zero rows and the lock is held for its
-- duration.
--
ALTER TABLE "reconciliation_cursors" DROP CONSTRAINT "reconciliation_cursors_id_check";--> statement-breakpoint
ALTER TABLE "transfers" ADD COLUMN "held_until" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "transfers_held_until_idx" ON "transfers" USING btree ("held_until") WHERE "transfers"."held_until" is not null and "transfers"."provider_object_id" is null;--> statement-breakpoint
ALTER TABLE "reconciliation_cursors" ADD CONSTRAINT "reconciliation_cursors_id_check" CHECK ("reconciliation_cursors"."id" in ('open_payments', 'provider_objects', 'ledger_audit', 'account_readiness', 'retail_reconciliation', 'withheld_transfers'));