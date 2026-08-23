-- oxy:deploy-phase=pre
-- oxy:rollback=derived
--
-- A bounded retry for catalog backfill runs (#367 W16, epic line 759).
--
-- Both statements are ADDITIVE. The column defaults to 0 and the CHECK admits
-- every row the default can produce, so the serving image -- which writes
-- neither -- keeps working unchanged while this is applied.
--
-- The CEILING is deliberately NOT in the schema. It is
-- CATALOG_BACKFILL_MAX_ATTEMPTS, applied in
-- services/backfill/backfill.service.ts, because raising a retry ceiling to get
-- a stuck pass through a bad hour is an incident action and a CHECK would make
-- it a migration.
--
-- Rollback is derived: dropping the column loses only the in-flight failure
-- counts, and a run whose count is lost is retried from zero rather than
-- stranded -- the cursor, which is what makes a pass resumable, is a different
-- column and is untouched.

ALTER TABLE "catalog_backfill_runs" ADD COLUMN "consecutive_failures" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "catalog_backfill_runs" ADD CONSTRAINT "catalog_backfill_runs_consecutive_failures_check" CHECK ("catalog_backfill_runs"."consecutive_failures" >= 0);