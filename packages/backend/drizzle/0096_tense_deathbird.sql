-- oxy:deploy-phase=post
--
-- #431, half two: every `reward_accrual_refused` row NAMES its refusal code.
--
-- `post` because it BREAKS a write the previous image performs — that image
-- appends refusals with `reward_refusal_reason` NULL, so adding this while it
-- still serves would make every refused accrual raise. 0095 (`pre`) carries the
-- additive half.
--
-- The backfill below is not 0095's repeated for its own sake: 0095 runs BEFORE
-- the rollout, so the previous image goes on appending code-less refusals for
-- the length of the rollout window. Those rows are exactly what this statement
-- catches, and it must run in the SAME migration as the CHECK and immediately
-- before it — that ordering is why the constraint can be added VALIDATED rather
-- than `NOT VALID`.
--
-- ON REGENERATION: drizzle-kit emits only the `ADD CONSTRAINT`. Re-apply the
-- anchored block above it, verbatim.
-- oxy:handwritten-begin=referral_events_reward_refusal_rollout_backfill
UPDATE "referral_events"
SET "reward_refusal_reason" = split_part("reason", ':', 1)
WHERE "action" = 'reward_accrual_refused'
  AND "reward_refusal_reason" IS NULL
  AND split_part("reason", ':', 1) IN ('no_pinned_rule_version', 'rule_version_not_found', 'rule_not_active', 'rule_not_effective', 'conversion_not_eligible', 'conversion_type_mismatch', 'funding_source_unavailable', 'funding_not_reconciled', 'funding_currency_mismatch', 'zero_base', 'insufficient_funding', 'below_min_accrual', 'budget_exhausted', 'cap_reached');
-- oxy:handwritten-end=referral_events_reward_refusal_rollout_backfill
--> statement-breakpoint
ALTER TABLE "referral_events" ADD CONSTRAINT "referral_events_reward_refusal_present_check" CHECK ("referral_events"."action" <> 'reward_accrual_refused' or "referral_events"."reward_refusal_reason" is not null);
