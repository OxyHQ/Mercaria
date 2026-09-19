-- oxy:deploy-phase=post
-- oxy:rollback=restore: catalog_merge_jobs.status and catalog_split_jobs.status lose the value `failed`, and any row holding it is rewritten to `dead_letter` with a marked catalog_merge_jobs.last_error / catalog_split_jobs.last_error. catalog_merge_jobs_status_check and catalog_split_jobs_status_check are re-added narrowed; both inverses are in this file. The rows keep their ids and nothing is deleted, and the rewrite marks itself, so the pre-image IS recoverable from outside this file: re-add the two CHECKs with `failed` in the tuple, then set status back where last_error starts with `[#704]`. Nothing re-derives it forward, because nothing writes `failed`
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
-- ## The two UPDATEs are a BELT, not a repair
--
-- They are expected to affect ZERO rows, and the point of them is that the
-- deploy no longer depends on that expectation being right.
--
-- No writer of `failed` has ever existed in this domain: `git log -S"'failed'"`
-- over `db/curation/` and `services/curation/` returns no commit, with
-- `dead_letter` as a positive control returning three, and no such writer exists
-- today. So the population these statements can find is only what a census over
-- this repository cannot see — a path renamed out from under the pathspec, a
-- hand-written `psql` update, a writer that lived and was removed.
--
-- Without them, this migration is correct only if a production count says zero,
-- and that count is taken BEFORE the deploy while the answer is needed DURING
-- it. A row appearing in between aborts `Migrate (post)` mid-rollout. Backfilling
-- first removes the question rather than answering it.
--
-- They are in the `post` file, above the narrowing, deliberately. `Migrate (pre)`
-- runs BEFORE the rollout, while the image that could still write `failed` is
-- serving, so a `pre` backfill races it and a row can appear between the
-- backfill and the narrowing. `Migrate (post)` runs after the new image is live
-- and that image cannot write the value, so this ordering cannot race. (See
-- `.github/workflows/deploy-aws.yml`, `Migrate (pre) — before the rollout` and
-- `Migrate (post) — after the new image is live`.)
--
-- ## Why `dead_letter` and not `blocked`
--
-- Such a row's PHASE is unknown, so it may have moved something. `blocked` is
-- the permissive answer and the dangerous one: `mergeJobCancellationState`
-- returns `allowed` for `blocked`, so an operator could cancel a possibly
-- half-applied merge — and that function refuses a `pending` job past `plan`
-- for exactly this reason ("Cancelling is stopping, never reverting").
-- `dead_letter` REFUSES cancellation, is not claimable, and is not in
-- `OPEN_STATUSES`, so it holds no open job for the entity and its refusal tells
-- the operator they can request a fresh merge now.
--
-- The cost, stated rather than hidden: `dead_letter` carries the implication
-- "exhausted its attempts", which is not knowable for such a row, and its
-- `attempts` counter is left as it stands rather than being invented. A
-- slightly false implication behind a safe-failing refusal beats a
-- true-sounding status that admits a dangerous action. The refusal already
-- declines to assert a phase — "It may also have dead-lettered part-way" — so
-- the wording fits a row of unknown phase better than the status name alone
-- suggests.
--
-- `last_error` is written because every real `dead_letter` write sets it
-- (`jobRepository.ts:314`, `:945`); a rewritten row that left it alone would be
-- the only reasonless `dead_letter` in either table, and an operator meeting it
-- would have nothing to act on. Any prior value is PRESERVED after the marker
-- rather than overwritten — it is the only evidence about why the row was that
-- way — and the marker is what makes the rewrite observable afterwards, so
-- "did this belt ever fire?" stays answerable by query.
--
-- These statements are the ONE exception to `jobRepository.ts` being the only
-- writer of these columns, and it is a migration rather than a code path.

UPDATE "catalog_merge_jobs"
SET "status" = 'dead_letter',
    "last_error" = '[#704] status was ''failed'', a value nothing in this codebase wrote; rewritten to ''dead_letter'' by migration 0149 before the narrowed CHECK was applied. Phase and attempts are left as they stood.'
      || coalesce(' Prior last_error: ' || "last_error", '')
WHERE "status" = 'failed';--> statement-breakpoint
UPDATE "catalog_split_jobs"
SET "status" = 'dead_letter',
    "last_error" = '[#704] status was ''failed'', a value nothing in this codebase wrote; rewritten to ''dead_letter'' by migration 0149 before the narrowed CHECK was applied. Phase and attempts are left as they stood.'
      || coalesce(' Prior last_error: ' || "last_error", '')
WHERE "status" = 'failed';--> statement-breakpoint
ALTER TABLE "catalog_merge_jobs" DROP CONSTRAINT "catalog_merge_jobs_status_check";--> statement-breakpoint
ALTER TABLE "catalog_split_jobs" DROP CONSTRAINT "catalog_split_jobs_status_check";--> statement-breakpoint
ALTER TABLE "catalog_merge_jobs" ADD CONSTRAINT "catalog_merge_jobs_status_check" CHECK ("catalog_merge_jobs"."status" in ('pending', 'processing', 'blocked', 'completed', 'dead_letter', 'cancelled'));--> statement-breakpoint
ALTER TABLE "catalog_split_jobs" ADD CONSTRAINT "catalog_split_jobs_status_check" CHECK ("catalog_split_jobs"."status" in ('pending', 'processing', 'blocked', 'completed', 'dead_letter', 'cancelled'));
