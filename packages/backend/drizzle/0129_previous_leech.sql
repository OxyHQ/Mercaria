-- oxy:deploy-phase=pre
-- oxy:rollback=derived
--
-- Give the price-alert block-reason vocabulary a READER (#752).
--
-- ADDITIVE, which is what makes this `pre`: two new columns, both defaulted so
-- every existing row satisfies the CHECKs, and three new CONSTRAINTs that
-- constrain only columns the previously serving image never writes. That image
-- keeps updating `price_alerts` (it stamps `last_evaluated_at`) without
-- touching either new column, and the defaults `'{}'` / NULL satisfy all three
-- constraints, so nothing it does can fail while this is applied.
--
-- ## Why the columns exist
--
-- `qualifyAlert` composed a real verdict -- `{ outcome: 'blocked', reasons }`
-- -- and its ONE production consumer dropped it four lines later with a bare
-- `continue`. No column stored a reason, no DTO carried one, no route returned
-- one. So an operator asking "why did my alert not fire" got silence for EVERY
-- member of the vocabulary, not only the two #744 measured as unproduced.
--
-- One row per alert, overwritten each evaluation, written by the SAME statement
-- that stamps `last_evaluated_at`. A per-evaluation history table was the
-- alternative and was refused on write volume: an evaluation is enqueued by
-- every offer write on a watched product, so it would grow with catalogue churn
-- times watchers and need its own retention sweep, to answer a question that
-- only ever wants the latest answer.
--
-- ## The CHECKs
--
-- `..._shape_check` is the biconditional: reasons non-empty exactly when
-- `last_blocked_at` is set. It spells `cardinality(...) > 0` and NOT
-- `array_length(..., 1) >= 1`, because `array_length` is NULL on an empty array
-- and a CHECK rejects only FALSE -- the obvious spelling ADMITS precisely the
-- row this refuses. Recorded twice in `offerFreshness.ts` and once in
-- `guestPortal.ts`; same trap, same spelling.
--
-- `..._evaluated_check` is one-directional on purpose: a blocked verdict
-- implies the evaluation happened, while a QUALIFYING evaluation stamps
-- `last_evaluated_at` and leaves the reasons empty, which is the ordinary
-- success state and must stay representable.
--
-- ## Rows
--
-- Applies to any existing data: both columns are defaulted and no backfill is
-- needed or wanted. An alert evaluated before this lands reports no reasons
-- until its next evaluation, which is honest -- nobody recorded why it did not
-- fire, and inventing a reason for it is exactly the failure the whole issue is
-- about.

ALTER TABLE "price_alerts" ADD COLUMN "last_block_reasons" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "price_alerts" ADD COLUMN "last_blocked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "price_alerts" ADD CONSTRAINT "price_alerts_last_block_reasons_check" CHECK ("price_alerts"."last_block_reasons" <@ array['no_eligible_offer', 'no_offer_in_scope', 'above_target', 'delivery_cost_unknown', 'currency_not_convertible', 'no_observed_price_version', 'repeat_policy_not_satisfied', 'proximity_scope_unsupported']::text[]);--> statement-breakpoint
ALTER TABLE "price_alerts" ADD CONSTRAINT "price_alerts_last_block_shape_check" CHECK ((cardinality("price_alerts"."last_block_reasons") > 0) = ("price_alerts"."last_blocked_at" is not null));--> statement-breakpoint
ALTER TABLE "price_alerts" ADD CONSTRAINT "price_alerts_last_block_evaluated_check" CHECK ("price_alerts"."last_blocked_at" is null or "price_alerts"."last_evaluated_at" is not null);