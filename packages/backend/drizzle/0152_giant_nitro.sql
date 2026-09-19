-- oxy:deploy-phase=pre
-- oxy:rollback=derived
--
-- WHO decided a fee schedule, without requiring that it be a PERSON.
--
-- Mercaria's commission is a policy and a policy needs an author on the record.
-- It does not need a named administrator: `PAYMENT_OPERATOR_OXY_USER_IDS`, an
-- allow-list of Oxy user ids in an env var, was the stand-in that this pair
-- replaces. A rate is authored by a REVIEWED CHANGE — defined in the repository,
-- published by `scripts/provision-fee-schedule.ts` — so the authority is
-- `deployment` and the reference is the commit. `crowdsource_decision` is the
-- same column answering a jury id when fee policy moves there.
--
-- ADDITIVE half of a two-phase change; the drops are the `post` migration that
-- immediately follows. Nothing reads these columns until it lands, so dropping
-- them restores the previous shape exactly — hence `derived`.
-- Generated in two passes rather than one so drizzle-kit never had to GUESS
-- whether `created_by_oxy_user_id` -> `drafted_by_ref` was a rename. It is not —
-- a user id is not a commit sha — and answering that prompt blind is how a
-- migration silently preserves the wrong thing.
--
-- ## `ADD COLUMN ... NOT NULL` with no DEFAULT, and why it is safe here
--
-- It fails on a table with rows. `fee_schedules` has none, and that is provable
-- by REACHABILITY rather than by a count: `insertFeeSchedule` is its only
-- writer, it is reachable only through `/internal/payments/fee-schedules`, and
-- that router is not mounted at all while `PAYMENT_OPERATOR_OXY_USER_IDS` is
-- empty (404, never 401). `seed.ts` writes none either. So no schedule has ever
-- existed on any deployment.
--
ALTER TABLE "fee_schedules" ADD COLUMN "drafted_by_authority" text NOT NULL;--> statement-breakpoint
ALTER TABLE "fee_schedules" ADD COLUMN "drafted_by_ref" text NOT NULL;--> statement-breakpoint
ALTER TABLE "fee_schedules" ADD COLUMN "approved_by_authority" text;--> statement-breakpoint
ALTER TABLE "fee_schedules" ADD COLUMN "approved_by_ref" text;--> statement-breakpoint
ALTER TABLE "fee_schedules" ADD CONSTRAINT "fee_schedules_drafted_by_authority_check" CHECK ("fee_schedules"."drafted_by_authority" in ('deployment', 'crowdsource_decision', 'oxy_user'));--> statement-breakpoint
ALTER TABLE "fee_schedules" ADD CONSTRAINT "fee_schedules_approved_by_authority_check" CHECK ("fee_schedules"."approved_by_authority" in ('deployment', 'crowdsource_decision', 'oxy_user'));--> statement-breakpoint
ALTER TABLE "fee_schedules" ADD CONSTRAINT "fee_schedules_approved_by_pair_check" CHECK (("fee_schedules"."approved_by_authority" is null) = ("fee_schedules"."approved_by_ref" is null));