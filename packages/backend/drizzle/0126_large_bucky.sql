-- oxy:deploy-phase=pre
-- oxy:rollback=restore: catalog_review_events.sequence gains a nextval default over a new sequence. The column's previous default is in 0062; dropping the new one leaves the sequence behind, so drop it too or the next re-apply collides
-- #775: the review trail could not express its own order. Two events are written
-- from ONE `now` in one transaction, and the uuid v7 tiebreak is not monotonic
-- within a millisecond, so the operator timeline's order was decided by random
-- low bits.
--
-- Additive, and `pre` for the ordinary reason: the serving image writes no
-- `sequence` and is unaffected by the column existing.
--
-- THE COLUMN IS DELIBERATELY ADDED WITHOUT A DEFAULT, and the two statements
-- after it are HAND-WRITTEN — drizzle-kit models neither a sequence nor a
-- SET DEFAULT, so a regeneration DROPS them and new rows go back to NULL
-- silently. Re-apply them and check for `nextval` before pushing.
--
-- The split is the whole point. `ADD COLUMN … bigserial` would have REWRITTEN
-- the table and called `nextval` per existing row, giving history distinct
-- values in HEAP order — measured on a real server: rows inserted `c, a, b`
-- came out `1, 2, 3` by physical position. That is an invented order
-- indistinguishable from a real one afterwards. `SET DEFAULT` applied AFTER the
-- column exists touches no existing row, so history stays NULL and says so.
ALTER TABLE "catalog_review_events" ADD COLUMN "sequence" bigint;

--> statement-breakpoint
CREATE SEQUENCE IF NOT EXISTS "catalog_review_events_sequence_seq";--> statement-breakpoint
ALTER TABLE "catalog_review_events" ALTER COLUMN "sequence" SET DEFAULT nextval('catalog_review_events_sequence_seq');
