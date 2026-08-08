-- oxy:deploy-phase=pre
--
-- Stripe checkout (#47): the one new outbox event type settlement can produce.
--
-- `pre`, for the same reason #46's widening was: the CHECK is dropped and
-- re-added over a STRICT SUPERSET, gaining `transfer_withheld`. The image still
-- serving cannot produce the new value, so widening ahead of it changes nothing
-- for it; the reverse order would reject the first withheld transfer the new
-- image recorded — and that row IS the record of money Mercaria owes a seller
-- and has not sent, which is the last row in this system that may be lost.
--
-- The re-add revalidates every existing row against the wider set, which the
-- eight previous values trivially satisfy.

ALTER TABLE "payment_outboxes" DROP CONSTRAINT "payment_outboxes_event_type_check";--> statement-breakpoint
ALTER TABLE "payment_outboxes" ADD CONSTRAINT "payment_outboxes_event_type_check" CHECK ("payment_outboxes"."event_type" in ('payment_succeeded', 'payment_failed', 'payment_succeeded_after_release', 'transfer_withheld', 'payment_refunded', 'payment_disputed', 'transfer_changed', 'payout_changed', 'provider_account_changed'));