-- oxy:deploy-phase=post
--
-- Cut `failed` from the curation job status vocabulary (#704).
--
-- NARROWING, which is what makes this `post` rather than `pre`: both CHECKs lose
-- a member, so any write of `failed` the previously serving image performed
-- would start failing the moment this applies. It is `post` on the CATEGORY
-- (drops/renames/narrows), not on a measurement that such a write exists —
-- nothing in the serving image writes `failed`, which is the whole reason the
-- value is being cut.
--
-- ## Why the value is going
--
-- `failed` was a member of `CATALOG_JOB_STATUSES` that NOTHING wrote. The
-- complete set of status writes is `db/curation/jobRepository.ts`, twelve sites
-- producing six values: `processing` (claim), `completed` (complete), `blocked`
-- (block), `dead_letter` or `pending` (release), `pending` (unblock) and
-- `cancelled` (cancel, #680). There is no failure mode that is not either a
-- retryable release or an exhausted one, so a third had no meaning to carry.
--
-- It was not inert. `mergeJobBlockingState` renders a child job's CURRENT status
-- into an operator-facing refusal — "Child merge job <id> is <status> and must be
-- completed before this merge may commit" — so the codepath could produce a
-- sentence naming a state the system never enters, which reads as a real
-- diagnosis to whoever meets it.
--
-- ## Rows
--
-- This applies cleanly only if no row holds `failed`. Nothing can have written
-- one through the application; a hand-written `psql` update is the only way one
-- could exist. Verify before deploying:
--
--     select count(*) from catalog_merge_jobs where status = 'failed';
--     select count(*) from catalog_split_jobs where status = 'failed';
--
-- Both must be 0. If either is not, the row is a state no code produced and
-- needs an operator decision (`dead_letter` is the retry-exhausted meaning)
-- BEFORE this migration runs — it does not guess.

ALTER TABLE "catalog_merge_jobs" DROP CONSTRAINT "catalog_merge_jobs_status_check";--> statement-breakpoint
ALTER TABLE "catalog_split_jobs" DROP CONSTRAINT "catalog_split_jobs_status_check";--> statement-breakpoint
ALTER TABLE "catalog_merge_jobs" ADD CONSTRAINT "catalog_merge_jobs_status_check" CHECK ("catalog_merge_jobs"."status" in ('pending', 'processing', 'blocked', 'completed', 'dead_letter', 'cancelled'));--> statement-breakpoint
ALTER TABLE "catalog_split_jobs" ADD CONSTRAINT "catalog_split_jobs_status_check" CHECK ("catalog_split_jobs"."status" in ('pending', 'processing', 'blocked', 'completed', 'dead_letter', 'cancelled'));