-- oxy:deploy-phase=pre
-- oxy:rollback=restore: seven provider/event-type CHECKs including orders_payment_provider_check and payments_provider_check are in 0002 and 0003; re-adding the narrower forms fails against any row already naming stripe
--
-- The Stripe event ingress (#48): a new provider id, the columns that turn the
-- event store into its own job queue, and one new outbox event type.
--
-- `pre`, and every statement earns it — nothing here narrows:
--
--   * the six `*_provider_check` constraints (and `orders_payment_provider_check`)
--     are dropped and re-added over a STRICT SUPERSET, gaining 'stripe'. The
--     image still serving cannot produce the new value, so widening ahead of it
--     is invisible to it; the reverse order would reject the first Stripe event
--     the new image stored.
--   * `payment_outboxes_event_type_check` gains 'payment_succeeded_after_release'
--     the same way — the exception raised when a capture arrives for a payment
--     whose reservation already timed out.
--   * four nullable columns on `payment_provider_events`. `next_attempt_at`,
--     `lease_owner` and `lease_until` are the claim shape `payment_outboxes`
--     already uses, which is what makes the event row the JOB rather than a
--     record of one; `processing_note` is where a handler deferred to a later
--     issue says so, so a seam is visibly a seam in the operator trace instead
--     of being indistinguishable from real handling.
--   * two partial indexes matching the two claim branches (due work, and work
--     whose lease died with its task). Plain CREATE INDEX rather than
--     CONCURRENTLY: drizzle's migrator runs each migration in a transaction and
--     CONCURRENTLY cannot run inside one. The table is small — it is 90-day
--     retained inbound events, swept by `db/expiryTargets.ts` — so the brief
--     ACCESS EXCLUSIVE lock is not a rollout hazard.
--
-- `next_attempt_at` is left NULL on any row already present rather than
-- backfilled: the claim treats NULL as "due now" (`coalesce(next_attempt_at,
-- received_at)`), so pre-existing events become claimable immediately, which is
-- the correct answer for a row that was received and never interpreted.
--
ALTER TABLE "orders" DROP CONSTRAINT "orders_payment_provider_check";--> statement-breakpoint
ALTER TABLE "payment_attempts" DROP CONSTRAINT "payment_attempts_provider_check";--> statement-breakpoint
ALTER TABLE "payment_outboxes" DROP CONSTRAINT "payment_outboxes_event_type_check";--> statement-breakpoint
ALTER TABLE "payment_provider_events" DROP CONSTRAINT "payment_provider_events_provider_check";--> statement-breakpoint
ALTER TABLE "payments" DROP CONSTRAINT "payments_provider_check";--> statement-breakpoint
ALTER TABLE "payouts" DROP CONSTRAINT "payouts_provider_check";--> statement-breakpoint
ALTER TABLE "transfers" DROP CONSTRAINT "transfers_provider_check";--> statement-breakpoint
ALTER TABLE "payment_provider_events" ADD COLUMN "next_attempt_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "payment_provider_events" ADD COLUMN "lease_owner" text;--> statement-breakpoint
ALTER TABLE "payment_provider_events" ADD COLUMN "lease_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "payment_provider_events" ADD COLUMN "processing_note" text;--> statement-breakpoint
CREATE INDEX "payment_provider_events_claimable_idx" ON "payment_provider_events" USING btree ("next_attempt_at","received_at") WHERE "payment_provider_events"."status" in ('received', 'failed');--> statement-breakpoint
CREATE INDEX "payment_provider_events_reclaim_idx" ON "payment_provider_events" USING btree ("lease_until","received_at") WHERE "payment_provider_events"."status" = 'processing';--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_payment_provider_check" CHECK ("orders"."payment_provider" in ('external', 'manual_pos', 'mock', 'stripe'));--> statement-breakpoint
ALTER TABLE "payment_attempts" ADD CONSTRAINT "payment_attempts_provider_check" CHECK ("payment_attempts"."provider" in ('external', 'manual_pos', 'mock', 'stripe'));--> statement-breakpoint
ALTER TABLE "payment_outboxes" ADD CONSTRAINT "payment_outboxes_event_type_check" CHECK ("payment_outboxes"."event_type" in ('payment_succeeded', 'payment_failed', 'payment_succeeded_after_release', 'payment_refunded', 'payment_disputed', 'transfer_changed', 'payout_changed'));--> statement-breakpoint
ALTER TABLE "payment_provider_events" ADD CONSTRAINT "payment_provider_events_processing_note_length_check" CHECK ("payment_provider_events"."processing_note" is null or length("payment_provider_events"."processing_note") <= 2000);--> statement-breakpoint
ALTER TABLE "payment_provider_events" ADD CONSTRAINT "payment_provider_events_provider_check" CHECK ("payment_provider_events"."provider" in ('external', 'manual_pos', 'mock', 'stripe'));--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_provider_check" CHECK ("payments"."provider" in ('external', 'manual_pos', 'mock', 'stripe'));--> statement-breakpoint
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_provider_check" CHECK ("payouts"."provider" in ('external', 'manual_pos', 'mock', 'stripe'));--> statement-breakpoint
ALTER TABLE "transfers" ADD CONSTRAINT "transfers_provider_check" CHECK ("transfers"."provider" in ('external', 'manual_pos', 'mock', 'stripe'));