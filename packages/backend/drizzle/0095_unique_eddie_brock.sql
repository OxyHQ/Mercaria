-- oxy:deploy-phase=pre
--
-- #431 — the reward refusal CODE stops being a prefix on free text.
--
-- Additive in every statement: the column is nullable, both CHECKs admit NULL,
-- and the index is partial over rows that carry a code. The previous image
-- knows nothing about the column and writes NULL into it, which every
-- constraint here accepts. Its twin (0096, `post`) adds the half the previous
-- image cannot satisfy: every `reward_accrual_refused` row NAMES its code.
--
-- ON REGENERATION: drizzle-kit models the ALTER/CREATE statements and NOT the
-- backfill, so a regeneration DROPS the anchored block below. Re-apply it
-- verbatim, in the same position — immediately after `ADD COLUMN` and before
-- the CHECKs, so the CHECKs validate against backfilled values rather than
-- against a column of NULLs.
ALTER TABLE "referral_events" ADD COLUMN "reward_refusal_reason" text;--> statement-breakpoint
-- oxy:handwritten-begin=referral_events_reward_refusal_backfill
-- Every historical `reward_accrual_refused` row was written by ONE call site —
-- `refuse()` in `services/referrals/rewards/reward.service.ts` — as
-- `'<code>: <detail>'`, with `<code>` drawn from
-- `REFERRAL_REWARD_REFUSAL_REASONS`. No code contains a colon and none is
-- longer than the writer's 2000-character slice, so `split_part(reason, ':', 1)`
-- recovers it exactly.
--
-- The `in (...)` guard is what makes this safe to run BEFORE the value-set
-- CHECK below: a row whose prose does not parse is left NULL rather than
-- carrying a value the CHECK would refuse. No such row is expected to exist,
-- and 0096's presence CHECK is what would report one — loudly, at deploy time,
-- rather than as a fraud counter quietly under-reading.
UPDATE "referral_events"
SET "reward_refusal_reason" = split_part("reason", ':', 1)
WHERE "action" = 'reward_accrual_refused'
  AND "reward_refusal_reason" IS NULL
  AND split_part("reason", ':', 1) IN ('no_pinned_rule_version', 'rule_version_not_found', 'rule_not_active', 'rule_not_effective', 'conversion_not_eligible', 'conversion_type_mismatch', 'funding_source_unavailable', 'funding_not_reconciled', 'funding_currency_mismatch', 'zero_base', 'insufficient_funding', 'below_min_accrual', 'budget_exhausted', 'cap_reached');
-- oxy:handwritten-end=referral_events_reward_refusal_backfill
--> statement-breakpoint
CREATE INDEX "referral_events_reward_refusal_idx" ON "referral_events" USING btree ("reward_refusal_reason","created_at") WHERE "referral_events"."reward_refusal_reason" is not null;--> statement-breakpoint
ALTER TABLE "referral_events" ADD CONSTRAINT "referral_events_reward_refusal_reason_check" CHECK ("referral_events"."reward_refusal_reason" in ('no_pinned_rule_version', 'rule_version_not_found', 'rule_not_active', 'rule_not_effective', 'conversion_not_eligible', 'conversion_type_mismatch', 'funding_source_unavailable', 'funding_not_reconciled', 'funding_currency_mismatch', 'zero_base', 'insufficient_funding', 'below_min_accrual', 'budget_exhausted', 'cap_reached'));--> statement-breakpoint
ALTER TABLE "referral_events" ADD CONSTRAINT "referral_events_reward_refusal_scope_check" CHECK ("referral_events"."reward_refusal_reason" is null or "referral_events"."action" = 'reward_accrual_refused');
