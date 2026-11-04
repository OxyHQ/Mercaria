-- oxy:deploy-phase=pre
-- oxy:rollback=restore: guest_data_class_dispositions_reason_check, guest_data_requests_retained_reasons_check and guest_legal_holds_reason_check are widened for expires_on_schedule (M8-01); the previous forms are in 0065 and re-adding any of them fails against a stored erasure receipt carrying the added reason
-- M8-01: an erasure receipt names the classes it cannot reach any sooner than their own
-- published expiry (pseudonymous analytics, cohort aggregates, a recipient-less message queue)
-- with a bounded reason instead of claiming they were deleted. Widening only; nothing is rewritten.
ALTER TABLE "guest_data_class_dispositions" DROP CONSTRAINT "guest_data_class_dispositions_reason_check";--> statement-breakpoint
ALTER TABLE "guest_data_requests" DROP CONSTRAINT "guest_data_requests_retained_reasons_check";--> statement-breakpoint
ALTER TABLE "guest_legal_holds" DROP CONSTRAINT "guest_legal_holds_reason_check";--> statement-breakpoint
ALTER TABLE "guest_data_class_dispositions" ADD CONSTRAINT "guest_data_class_dispositions_reason_check" CHECK ("guest_data_class_dispositions"."retained_reason" in ('financial_record', 'open_dispute', 'fraud_investigation', 'legal_hold', 'merchant_fulfilment_copy', 'security_audit', 'provider_record', 'expires_on_schedule'));--> statement-breakpoint
ALTER TABLE "guest_data_requests" ADD CONSTRAINT "guest_data_requests_retained_reasons_check" CHECK ("guest_data_requests"."retained_reasons" <@ array['financial_record', 'open_dispute', 'fraud_investigation', 'legal_hold', 'merchant_fulfilment_copy', 'security_audit', 'provider_record', 'expires_on_schedule']::text[]);--> statement-breakpoint
ALTER TABLE "guest_legal_holds" ADD CONSTRAINT "guest_legal_holds_reason_check" CHECK ("guest_legal_holds"."reason" in ('financial_record', 'open_dispute', 'fraud_investigation', 'legal_hold', 'merchant_fulfilment_copy', 'security_audit', 'provider_record', 'expires_on_schedule'));