-- oxy:deploy-phase=post
-- oxy:rollback=restore: payment_outboxes_event_type_check narrows to drop transfer_changed, the outbox type whose only producer was the deleted direct rail's transfer.* handler (Peable sends no transfer events; Mercaria records its own transfer and reversal answers); its wider form is in 0171, and production held no payment_outboxes row of that type when this shipped
-- The CONTRACT half of removing a seam with no producer: no row can carry the
-- narrowed value, so the full-scan CHECK re-add holds its lock for microseconds.
ALTER TABLE "payment_outboxes" DROP CONSTRAINT "payment_outboxes_event_type_check";--> statement-breakpoint
ALTER TABLE "payment_outboxes" ADD CONSTRAINT "payment_outboxes_event_type_check" CHECK ("payment_outboxes"."event_type" in ('payment_succeeded', 'supervised_purchase_cancelled', 'payment_failed', 'payment_succeeded_after_release', 'transfer_withheld', 'payment_refunded', 'payment_disputed', 'payout_changed', 'provider_account_changed', 'refund_failed', 'reversal_failed', 'refund_unmatched', 'guest_portal_initialization', 'procurement_requested', 'retail_procurement_failed'));
