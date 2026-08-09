-- oxy:deploy-phase=pre
-- Stripe fiat guest checkout (#107, ADR 0006). Two CHECK WIDENINGS, and nothing
-- else: no table, no column, no index, no backfill.
--
-- `pre` despite containing a DROP CONSTRAINT. The phase rule asks what the
-- statement does to the SERVING image, not what verb it uses: each constraint is
-- dropped and immediately re-added in the same migration as a strict SUPERSET of
-- itself, so the old image — which can only ever write a value from the narrower
-- set — is accepted throughout. A `post` phase would be the wrong answer twice
-- over: it would leave the arriving image unable to write
-- `guest_portal_initialization` until a second deploy step ran, which is exactly
-- the write a verified guest payment performs.
--
--  * `payment_outboxes_event_type_check` gains `guest_portal_initialization` —
--    the durable row ADR 0006 G13 has #107 emit and #108 consume. The serving
--    image has no handler for that type, and does not need one: an unknown type
--    THROWS in `runPaymentOutboxEvent` and is retried, so a row written by the
--    arriving image during a rolling deploy is picked up by the next task
--    running the newer code rather than being completed as if it had been dealt
--    with.
--  * `analytics_events_reason_code_check` gains `guest_rollout_blocked` and
--    `guest_seller_not_activated` — the two refusal codes #107's kill switches
--    and the #85 activation seam classify a checkout with. Analytics is
--    fire-and-forget, so the serving image simply never emits them.

ALTER TABLE "payment_outboxes" DROP CONSTRAINT "payment_outboxes_event_type_check";--> statement-breakpoint
ALTER TABLE "analytics_events" DROP CONSTRAINT "analytics_events_reason_code_check";--> statement-breakpoint
ALTER TABLE "payment_outboxes" ADD CONSTRAINT "payment_outboxes_event_type_check" CHECK ("payment_outboxes"."event_type" in ('payment_succeeded', 'payment_failed', 'payment_succeeded_after_release', 'transfer_withheld', 'payment_refunded', 'payment_disputed', 'transfer_changed', 'payout_changed', 'provider_account_changed', 'refund_failed', 'reversal_failed', 'refund_unmatched', 'guest_portal_initialization'));--> statement-breakpoint
ALTER TABLE "analytics_events" ADD CONSTRAINT "analytics_events_reason_code_check" CHECK ("analytics_events"."reason_code" in ('not_found', 'unavailable', 'rate_limited', 'upstream_timeout', 'upstream_error', 'validation_failed', 'forbidden', 'stale_offer', 'out_of_stock', 'listing_restricted', 'seller_not_payment_ready', 'p2p_seller_excluded', 'market_not_supported', 'currency_not_supported', 'guest_commerce_disabled', 'guest_cart_disabled', 'guest_issuance_disabled', 'guest_checkout_disabled', 'guest_rollout_blocked', 'guest_seller_not_activated', 'merge_completed', 'merge_already_done', 'merge_nothing_to_move', 'merge_quantity_clamped', 'merge_line_flagged', 'merge_discount_dropped', 'contact_malformed', 'contact_undeliverable', 'destination_incomplete', 'destination_unsupported', 'claim_offered', 'claim_completed', 'claim_declined', 'claim_conflicted', 'other'));