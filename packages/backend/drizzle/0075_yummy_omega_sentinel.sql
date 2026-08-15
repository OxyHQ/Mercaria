-- oxy:deploy-phase=pre
--
-- #303: WHICH record a connector sync run refused, and why — durably, per
-- record, instead of a tally plus an elided summary sentence.
--
-- ## Why `pre`
--
-- The real question, not its paraphrase: does any statement here break a write
-- the CURRENTLY SERVING image performs? It does not, and the reason is stronger
-- than "it is additive" — every statement targets a table that does not exist
-- in that image, so there is no write it could break. `CREATE TABLE` with its
-- five CHECKs, one foreign key onto `sync_runs`, and two indexes, all on the new
-- table. Nothing is dropped, renamed or narrowed, and no existing table is
-- altered, so the serving image goes on writing exactly what it wrote before and
-- simply leaves this table empty until it is replaced.
--
-- ## What it is NOT
--
-- It does not touch `sync_runs.error`. #294's summary stays exactly as it is —
-- the at-a-glance line on a run, composed from the same input as these rows
-- inside the same transaction, so the two cannot disagree. #303 explicitly
-- refused widening that column further: it is ONE column for a whole run, and a
-- run that is `completed` with one failure has no honest place to put a growing
-- list.
--
-- ## `ordinal` and its UNIQUE index are one decision
--
-- Every row of a run is written by ONE multi-row insert, so they share
-- `created_at` to the millisecond, and `@oxyhq/db`'s uuid v7 primary key is not
-- monotonic within a millisecond. Ordering on `(created_at, id)` therefore
-- returns a run's refusals SHUFFLED — measured, on this table's own first test
-- run, where the write cap's "first 200 we met" came back starting at record 79.
-- The position is stored, and `sync_run_record_failures_run_ordinal_key` is
-- UNIQUE so two rows cannot claim one position; the writer REPLACES a run's rows
-- inside the transaction that rewrites its summary, so a re-closed run converges
-- rather than colliding.
--
-- ## `expires_at` and its index are load-bearing together
--
-- This is the only table in `connectors.ts` bounded by TRAFFIC rather than by a
-- merchant's channels: a platform publishing a field Mercaria refuses writes one
-- row per product per run, forever. `expiryTargets.ts` sweeps it at 30 days, and
-- `sync_run_record_failures_expiry_idx` is what keeps that sweep from being a
-- sequential scan of the one table here that grows with a broken feed.
-- `findUnsupportedExpiryColumns` fails the build without it.
CREATE TABLE "sync_run_record_failures" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"ordinal" integer NOT NULL,
	"subject_type" text NOT NULL,
	"external_id" text,
	"reason_code" text NOT NULL,
	"detail" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "sync_run_record_failures_subject_type_check" CHECK ("sync_run_record_failures"."subject_type" in ('product', 'order', 'inventory_item')),
	CONSTRAINT "sync_run_record_failures_reason_check" CHECK ("sync_run_record_failures"."reason_code" in ('refused_by_rule', 'duplicate_record', 'database_refused', 'unclassified')),
	CONSTRAINT "sync_run_record_failures_external_id_shape_check" CHECK ("sync_run_record_failures"."external_id" is null or (length("sync_run_record_failures"."external_id") between 1 and 200)),
	CONSTRAINT "sync_run_record_failures_detail_shape_check" CHECK (length("sync_run_record_failures"."detail") between 1 and 500),
	CONSTRAINT "sync_run_record_failures_ordinal_check" CHECK ("sync_run_record_failures"."ordinal" >= 0)
);
--> statement-breakpoint
ALTER TABLE "sync_run_record_failures" ADD CONSTRAINT "sync_run_record_failures_run_id_sync_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."sync_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sync_run_record_failures_run_ordinal_key" ON "sync_run_record_failures" USING btree ("run_id","ordinal");--> statement-breakpoint
CREATE INDEX "sync_run_record_failures_expiry_idx" ON "sync_run_record_failures" USING btree ("expires_at");