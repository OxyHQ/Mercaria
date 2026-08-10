-- oxy:deploy-phase=pre
--
-- #111 — guest-commerce governance: retention, privacy requests, abuse controls,
-- security counters and the staged rollout.
--
-- Everything here is ADDITIVE and every statement is safe against the image
-- that is still serving. Nine new tables, one new nullable column on
-- `analytics_events`, and eight DROP/ADD constraint pairs that WIDEN their
-- tuples (three new reason codes, ten new metric keys) — every one of the
-- eight is a strict superset, so no write the previous image performs becomes
-- invalid. Two of the eight (`price_signal_policy_versions`) were not in this
-- migration's first draft — they exist because #82 landed on `main` between
-- this branch's fork and its rebase, sharing the same metric-key tuple.
--
-- `analytics_events.payment_method_category` is added VALIDATED rather than
-- NOT VALID because the serving image never writes it: the four event types its
-- scope CHECK admits were emitted by NOTHING before this change, so the
-- constraint only ever constrains columns that are NULL on every existing row.
--
-- ON A REGENERATION: three hand-written blocks at the END are dropped by
-- drizzle-kit and must be re-applied — the `guest_retention_policy_versions`
-- immutability trigger and the two append-only triggers on
-- `guest_launch_gate_signoffs` and `guest_rollout_stage_advances`. A
-- regeneration that keeps the tables and loses the triggers applies perfectly
-- cleanly, freezes nothing, and leaves a published retention policy and an
-- append-only sign-off history both silently editable.

CREATE TABLE "guest_abuse_counters" (
	"id" text PRIMARY KEY NOT NULL,
	"scope" text NOT NULL,
	"axis" text NOT NULL,
	"subject_hash" text NOT NULL,
	"window_started_at" timestamp with time zone NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "guest_abuse_counters_scope_check" CHECK ("guest_abuse_counters"."scope" in ('session_issuance', 'cart_write', 'checkout_creation', 'payment_attempt', 'magic_link_request', 'token_exchange', 'recovery_request', 'claim_attempt', 'return_request', 'support_message')),
	CONSTRAINT "guest_abuse_counters_axis_check" CHECK ("guest_abuse_counters"."axis" in ('actor', 'guest_checkout', 'email_hash', 'network_range', 'merchant', 'provider_outcome')),
	CONSTRAINT "guest_abuse_counters_count_check" CHECK ("guest_abuse_counters"."attempt_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "guest_abuse_interventions" (
	"id" text PRIMARY KEY NOT NULL,
	"pattern" text NOT NULL,
	"scope" text NOT NULL,
	"axis" text NOT NULL,
	"subject_hash" text NOT NULL,
	"measure" text NOT NULL,
	"observed_count" integer NOT NULL,
	"threshold_count" integer NOT NULL,
	"state" text DEFAULT 'active' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"reviewed_by_oxy_user_id" text,
	"reviewed_at" timestamp with time zone,
	"review_note" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "guest_abuse_interventions_pattern_check" CHECK ("guest_abuse_interventions"."pattern" in ('session_farming', 'abandoned_checkout_flood', 'recovery_spraying', 'repeated_claim_conflict', 'return_or_support_spam', 'payment_attempt_churn')),
	CONSTRAINT "guest_abuse_interventions_scope_check" CHECK ("guest_abuse_interventions"."scope" in ('session_issuance', 'cart_write', 'checkout_creation', 'payment_attempt', 'magic_link_request', 'token_exchange', 'recovery_request', 'claim_attempt', 'return_request', 'support_message')),
	CONSTRAINT "guest_abuse_interventions_axis_check" CHECK ("guest_abuse_interventions"."axis" in ('actor', 'guest_checkout', 'email_hash', 'network_range', 'merchant', 'provider_outcome')),
	CONSTRAINT "guest_abuse_interventions_measure_check" CHECK ("guest_abuse_interventions"."measure" in ('cooldown', 'email_verification_required', 'manual_review')),
	CONSTRAINT "guest_abuse_interventions_state_check" CHECK ("guest_abuse_interventions"."state" in ('active', 'expired', 'lifted', 'false_positive')),
	CONSTRAINT "guest_abuse_interventions_counts_check" CHECK ("guest_abuse_interventions"."observed_count" >= "guest_abuse_interventions"."threshold_count" and "guest_abuse_interventions"."threshold_count" > 0),
	CONSTRAINT "guest_abuse_interventions_review_shape_check" CHECK (("guest_abuse_interventions"."state" in ('lifted', 'false_positive')) = ("guest_abuse_interventions"."reviewed_by_oxy_user_id" is not null) and ("guest_abuse_interventions"."reviewed_by_oxy_user_id" is null) = ("guest_abuse_interventions"."reviewed_at" is null)),
	CONSTRAINT "guest_abuse_interventions_note_length_check" CHECK ("guest_abuse_interventions"."review_note" is null or length("guest_abuse_interventions"."review_note") <= 500)
);
--> statement-breakpoint
CREATE TABLE "guest_data_class_dispositions" (
	"id" text PRIMARY KEY NOT NULL,
	"request_id" text NOT NULL,
	"data_class" text NOT NULL,
	"disposition" text NOT NULL,
	"retained_reason" text,
	"affected_row_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "guest_data_class_dispositions_class_check" CHECK ("guest_data_class_dispositions"."data_class" in ('guest_session_metadata', 'cart_and_discount_intent', 'pending_guest_checkout', 'paid_guest_checkout', 'order_buyer_and_contact_snapshot', 'destination_snapshot', 'access_grants_and_portal_sessions', 'email_verification_and_recovery', 'claim_operations', 'post_purchase_requests', 'transactional_notification_events', 'payment_refund_dispute_ledger_payout', 'security_and_audit_events', 'product_analytics_and_experimentation', 'merchant_facing_aggregates', 'provider_customer_wallet_reference')),
	CONSTRAINT "guest_data_class_dispositions_disposition_check" CHECK ("guest_data_class_dispositions"."disposition" in ('deleted', 'minimized', 'retained_under_obligation', 'not_stored')),
	CONSTRAINT "guest_data_class_dispositions_reason_check" CHECK ("guest_data_class_dispositions"."retained_reason" in ('financial_record', 'open_dispute', 'fraud_investigation', 'legal_hold', 'merchant_fulfilment_copy', 'security_audit', 'provider_record')),
	CONSTRAINT "guest_data_class_dispositions_reason_shape_check" CHECK (("guest_data_class_dispositions"."disposition" = 'retained_under_obligation') = ("guest_data_class_dispositions"."retained_reason" is not null)),
	CONSTRAINT "guest_data_class_dispositions_rows_check" CHECK ("guest_data_class_dispositions"."affected_row_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "guest_data_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"checkout_group_id" text NOT NULL,
	"kind" text NOT NULL,
	"proof" text NOT NULL,
	"source_grant_id" text,
	"requested_by_oxy_user_id" text,
	"state" text DEFAULT 'received' NOT NULL,
	"erased_classes" text[] DEFAULT '{}'::text[] NOT NULL,
	"retained_classes" text[] DEFAULT '{}'::text[] NOT NULL,
	"retained_reasons" text[] DEFAULT '{}'::text[] NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "guest_data_requests_kind_check" CHECK ("guest_data_requests"."kind" in ('export', 'deletion', 'minimization')),
	CONSTRAINT "guest_data_requests_proof_check" CHECK ("guest_data_requests"."proof" in ('verified_portal_grant', 'completed_oxy_claim')),
	CONSTRAINT "guest_data_requests_state_check" CHECK ("guest_data_requests"."state" in ('received', 'completed', 'partially_completed', 'refused')),
	CONSTRAINT "guest_data_requests_erased_classes_check" CHECK ("guest_data_requests"."erased_classes" <@ array['guest_session_metadata', 'cart_and_discount_intent', 'pending_guest_checkout', 'paid_guest_checkout', 'order_buyer_and_contact_snapshot', 'destination_snapshot', 'access_grants_and_portal_sessions', 'email_verification_and_recovery', 'claim_operations', 'post_purchase_requests', 'transactional_notification_events', 'payment_refund_dispute_ledger_payout', 'security_and_audit_events', 'product_analytics_and_experimentation', 'merchant_facing_aggregates', 'provider_customer_wallet_reference']::text[]),
	CONSTRAINT "guest_data_requests_retained_classes_check" CHECK ("guest_data_requests"."retained_classes" <@ array['guest_session_metadata', 'cart_and_discount_intent', 'pending_guest_checkout', 'paid_guest_checkout', 'order_buyer_and_contact_snapshot', 'destination_snapshot', 'access_grants_and_portal_sessions', 'email_verification_and_recovery', 'claim_operations', 'post_purchase_requests', 'transactional_notification_events', 'payment_refund_dispute_ledger_payout', 'security_and_audit_events', 'product_analytics_and_experimentation', 'merchant_facing_aggregates', 'provider_customer_wallet_reference']::text[]),
	CONSTRAINT "guest_data_requests_retained_reasons_check" CHECK ("guest_data_requests"."retained_reasons" <@ array['financial_record', 'open_dispute', 'fraud_investigation', 'legal_hold', 'merchant_fulfilment_copy', 'security_audit', 'provider_record']::text[]),
	CONSTRAINT "guest_data_requests_retained_pairing_check" CHECK (cardinality("guest_data_requests"."retained_classes") = cardinality("guest_data_requests"."retained_reasons")),
	CONSTRAINT "guest_data_requests_proof_shape_check" CHECK (("guest_data_requests"."proof" = 'verified_portal_grant') = ("guest_data_requests"."source_grant_id" is not null) and ("guest_data_requests"."proof" = 'completed_oxy_claim') = ("guest_data_requests"."requested_by_oxy_user_id" is not null)),
	CONSTRAINT "guest_data_requests_completion_check" CHECK (("guest_data_requests"."state" = 'received') = ("guest_data_requests"."completed_at" is null))
);
--> statement-breakpoint
CREATE TABLE "guest_launch_gate_signoffs" (
	"id" text PRIMARY KEY NOT NULL,
	"stage" text NOT NULL,
	"gate" text NOT NULL,
	"discipline" text NOT NULL,
	"satisfied" text NOT NULL,
	"signed_by_oxy_user_id" text NOT NULL,
	"evidence_ref" text,
	"note" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "guest_launch_gate_signoffs_stage_check" CHECK ("guest_launch_gate_signoffs"."stage" in ('stage_0_internal', 'stage_1_staff_canary', 'stage_2_pilot_merchants', 'stage_3_broader_store_checkout', 'stage_4_p2p_decision')),
	CONSTRAINT "guest_launch_gate_signoffs_gate_check" CHECK ("guest_launch_gate_signoffs"."gate" in ('actor_identity_privacy_adr_approved', 'stripe_guest_amendment_approved', 'security_review_complete', 'privacy_and_retention_review_complete', 'stripe_architecture_production_ready', 'webhooks_reconciliation_runbooks_operational', 'transactional_sender_authenticated', 'merchant_readiness_includes_guest', 'support_runbooks_staffed', 'backup_and_restore_validated', 'dashboard_metrics_and_alerts_live', 'feature_flags_and_kill_switches_tested', 'no_unresolved_critical_findings', 'payment_to_portal_tested_under_failure')),
	CONSTRAINT "guest_launch_gate_signoffs_discipline_check" CHECK ("guest_launch_gate_signoffs"."discipline" in ('security', 'privacy', 'operations', 'support', 'engineering')),
	CONSTRAINT "guest_launch_gate_signoffs_evidence_ref_length_check" CHECK ("guest_launch_gate_signoffs"."evidence_ref" is null or length("guest_launch_gate_signoffs"."evidence_ref") <= 200),
	CONSTRAINT "guest_launch_gate_signoffs_note_length_check" CHECK ("guest_launch_gate_signoffs"."note" is null or length("guest_launch_gate_signoffs"."note") <= 500)
);
--> statement-breakpoint
CREATE TABLE "guest_legal_holds" (
	"id" text PRIMARY KEY NOT NULL,
	"checkout_group_id" text NOT NULL,
	"retention_class" text NOT NULL,
	"reason" text NOT NULL,
	"raised_by_oxy_user_id" text NOT NULL,
	"evidence_ref" text,
	"lifted_at" timestamp with time zone,
	"lifted_by_oxy_user_id" text,
	"lift_reason" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "guest_legal_holds_class_check" CHECK ("guest_legal_holds"."retention_class" in ('unused_guest_session', 'abandoned_cart', 'unpaid_pending_checkout', 'failed_or_cancelled_payment_attempt', 'transaction_record', 'plaintext_equivalent_contact', 'lookup_hash', 'access_grant_and_portal_session', 'notification_delivery_log', 'support_and_return_evidence', 'security_audit_event', 'aggregated_analytics', 'provider_side_reference')),
	CONSTRAINT "guest_legal_holds_reason_check" CHECK ("guest_legal_holds"."reason" in ('financial_record', 'open_dispute', 'fraud_investigation', 'legal_hold', 'merchant_fulfilment_copy', 'security_audit', 'provider_record')),
	CONSTRAINT "guest_legal_holds_lift_shape_check" CHECK (("guest_legal_holds"."lifted_at" is null) = ("guest_legal_holds"."lifted_by_oxy_user_id" is null) and ("guest_legal_holds"."lifted_at" is null) = ("guest_legal_holds"."lift_reason" is null)),
	CONSTRAINT "guest_legal_holds_evidence_ref_length_check" CHECK ("guest_legal_holds"."evidence_ref" is null or length("guest_legal_holds"."evidence_ref") <= 200),
	CONSTRAINT "guest_legal_holds_reason_length_check" CHECK ("guest_legal_holds"."lift_reason" is null or length("guest_legal_holds"."lift_reason") <= 500)
);
--> statement-breakpoint
CREATE TABLE "guest_retention_policy_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"policy_key" text DEFAULT 'guest-commerce-retention' NOT NULL,
	"version" text NOT NULL,
	"retention_class" text NOT NULL,
	"retention_seconds" bigint,
	"mechanism" text NOT NULL,
	"pausable_by_legal_hold" text NOT NULL,
	"rationale" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"published_by_oxy_user_id" text,
	"published_at" timestamp with time zone,
	"superseded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "guest_retention_policy_versions_class_check" CHECK ("guest_retention_policy_versions"."retention_class" in ('unused_guest_session', 'abandoned_cart', 'unpaid_pending_checkout', 'failed_or_cancelled_payment_attempt', 'transaction_record', 'plaintext_equivalent_contact', 'lookup_hash', 'access_grant_and_portal_session', 'notification_delivery_log', 'support_and_return_evidence', 'security_audit_event', 'aggregated_analytics', 'provider_side_reference')),
	CONSTRAINT "guest_retention_policy_versions_mechanism_check" CHECK ("guest_retention_policy_versions"."mechanism" in ('expiry_sweep', 'minimization_job', 'none')),
	CONSTRAINT "guest_retention_policy_versions_mechanism_shape_check" CHECK ("guest_retention_policy_versions"."mechanism" <> 'none' or "guest_retention_policy_versions"."retention_seconds" is null),
	CONSTRAINT "guest_retention_policy_versions_seconds_positive_check" CHECK ("guest_retention_policy_versions"."retention_seconds" is null or "guest_retention_policy_versions"."retention_seconds" > 0),
	CONSTRAINT "guest_retention_policy_versions_publication_check" CHECK (("guest_retention_policy_versions"."status" = 'draft') = ("guest_retention_policy_versions"."published_by_oxy_user_id" is null and "guest_retention_policy_versions"."published_at" is null)),
	CONSTRAINT "guest_retention_policy_versions_superseded_check" CHECK (("guest_retention_policy_versions"."status" = 'superseded') = ("guest_retention_policy_versions"."superseded_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "guest_retention_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"retention_class" text NOT NULL,
	"policy_version" text NOT NULL,
	"mode" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"examined_count" integer DEFAULT 0 NOT NULL,
	"minimized_count" integer DEFAULT 0 NOT NULL,
	"deleted_count" integer DEFAULT 0 NOT NULL,
	"skipped_held_count" integer DEFAULT 0 NOT NULL,
	"failed_count" integer DEFAULT 0 NOT NULL,
	"cursor" text,
	"failure_code" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "guest_retention_runs_class_check" CHECK ("guest_retention_runs"."retention_class" in ('unused_guest_session', 'abandoned_cart', 'unpaid_pending_checkout', 'failed_or_cancelled_payment_attempt', 'transaction_record', 'plaintext_equivalent_contact', 'lookup_hash', 'access_grant_and_portal_session', 'notification_delivery_log', 'support_and_return_evidence', 'security_audit_event', 'aggregated_analytics', 'provider_side_reference')),
	CONSTRAINT "guest_retention_runs_counters_total_check" CHECK ("guest_retention_runs"."examined_count" = "guest_retention_runs"."minimized_count" + "guest_retention_runs"."deleted_count" + "guest_retention_runs"."skipped_held_count" + "guest_retention_runs"."failed_count"),
	CONSTRAINT "guest_retention_runs_counters_nonnegative_check" CHECK ("guest_retention_runs"."examined_count" >= 0 and "guest_retention_runs"."minimized_count" >= 0 and "guest_retention_runs"."deleted_count" >= 0 and "guest_retention_runs"."skipped_held_count" >= 0 and "guest_retention_runs"."failed_count" >= 0),
	CONSTRAINT "guest_retention_runs_dry_run_check" CHECK ("guest_retention_runs"."mode" = 'apply' or "guest_retention_runs"."deleted_count" = 0),
	CONSTRAINT "guest_retention_runs_finished_check" CHECK (("guest_retention_runs"."status" = 'running') = ("guest_retention_runs"."finished_at" is null)),
	CONSTRAINT "guest_retention_runs_failure_code_check" CHECK ("guest_retention_runs"."failure_code" is null or ("guest_retention_runs"."status" = 'failed' and length("guest_retention_runs"."failure_code") <= 500))
);
--> statement-breakpoint
CREATE TABLE "guest_rollout_stage_advances" (
	"id" text PRIMARY KEY NOT NULL,
	"stage" text NOT NULL,
	"outcome" text NOT NULL,
	"refusal" text,
	"unsatisfied_gates" text[] DEFAULT '{}'::text[] NOT NULL,
	"requested_by_oxy_user_id" text NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "guest_rollout_stage_advances_stage_check" CHECK ("guest_rollout_stage_advances"."stage" in ('stage_0_internal', 'stage_1_staff_canary', 'stage_2_pilot_merchants', 'stage_3_broader_store_checkout', 'stage_4_p2p_decision')),
	CONSTRAINT "guest_rollout_stage_advances_refusal_check" CHECK ("guest_rollout_stage_advances"."refusal" in ('gate_unsatisfied', 'stage_out_of_order', 'already_at_stage', 'rollback_untested', 'metrics_unmeasured')),
	CONSTRAINT "guest_rollout_stage_advances_gates_check" CHECK ("guest_rollout_stage_advances"."unsatisfied_gates" <@ array['actor_identity_privacy_adr_approved', 'stripe_guest_amendment_approved', 'security_review_complete', 'privacy_and_retention_review_complete', 'stripe_architecture_production_ready', 'webhooks_reconciliation_runbooks_operational', 'transactional_sender_authenticated', 'merchant_readiness_includes_guest', 'support_runbooks_staffed', 'backup_and_restore_validated', 'dashboard_metrics_and_alerts_live', 'feature_flags_and_kill_switches_tested', 'no_unresolved_critical_findings', 'payment_to_portal_tested_under_failure']::text[]),
	CONSTRAINT "guest_rollout_stage_advances_outcome_shape_check" CHECK (("guest_rollout_stage_advances"."outcome" = 'refused') = ("guest_rollout_stage_advances"."refusal" is not null)),
	CONSTRAINT "guest_rollout_stage_advances_permitted_gates_check" CHECK ("guest_rollout_stage_advances"."outcome" = 'refused' or cardinality("guest_rollout_stage_advances"."unsatisfied_gates") = 0),
	CONSTRAINT "guest_rollout_stage_advances_note_length_check" CHECK ("guest_rollout_stage_advances"."note" is null or length("guest_rollout_stage_advances"."note") <= 500)
);
--> statement-breakpoint
CREATE TABLE "guest_security_signal_counters" (
	"id" text PRIMARY KEY NOT NULL,
	"signal" text NOT NULL,
	"window_started_at" timestamp with time zone NOT NULL,
	"observation_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "guest_security_signal_counters_signal_check" CHECK ("guest_security_signal_counters"."signal" in ('guest_token_verification_failure', 'csrf_failure', 'session_issuance_rate', 'recovery_request_spike', 'magic_link_exchange_failure', 'scanner_consumption_anomaly', 'cross_order_authorization_failure', 'duplicate_payment_or_idempotency_conflict', 'claim_conflict', 'cleanup_lag', 'encryption_failure', 'notification_delivery_failure', 'operator_sensitive_access', 'provider_metadata_missing_ids', 'provider_identity_used_as_access', 'payment_verified_portal_initialization_lag')),
	CONSTRAINT "guest_security_signal_counters_count_check" CHECK ("guest_security_signal_counters"."observation_count" >= 0)
);
--> statement-breakpoint
ALTER TABLE "analytics_events" DROP CONSTRAINT "analytics_events_reason_code_check";--> statement-breakpoint
ALTER TABLE "analytics_experiments" DROP CONSTRAINT "analytics_experiments_primary_metric_check";--> statement-breakpoint
ALTER TABLE "analytics_experiments" DROP CONSTRAINT "analytics_experiments_guardrails_check";--> statement-breakpoint
ALTER TABLE "analytics_rollups" DROP CONSTRAINT "analytics_rollups_metric_key_check";--> statement-breakpoint
ALTER TABLE "price_signal_policy_versions" DROP CONSTRAINT "price_signal_policy_versions_objective_metrics_check";--> statement-breakpoint
ALTER TABLE "price_signal_policy_versions" DROP CONSTRAINT "price_signal_policy_versions_guardrail_metrics_check";--> statement-breakpoint
ALTER TABLE "ranking_policy_versions" DROP CONSTRAINT "ranking_policy_versions_objective_metrics_check";--> statement-breakpoint
ALTER TABLE "ranking_policy_versions" DROP CONSTRAINT "ranking_policy_versions_guardrail_metrics_check";--> statement-breakpoint
ALTER TABLE "analytics_events" ADD COLUMN "payment_method_category" text;--> statement-breakpoint
ALTER TABLE "guest_data_class_dispositions" ADD CONSTRAINT "guest_data_class_dispositions_request_id_guest_data_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."guest_data_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "guest_abuse_counters_window_key" ON "guest_abuse_counters" USING btree ("scope","axis","subject_hash","window_started_at");--> statement-breakpoint
CREATE INDEX "guest_abuse_counters_window_started_idx" ON "guest_abuse_counters" USING btree ("window_started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "guest_abuse_interventions_live_key" ON "guest_abuse_interventions" USING btree ("pattern","subject_hash") WHERE state = 'active';--> statement-breakpoint
CREATE INDEX "guest_abuse_interventions_expires_idx" ON "guest_abuse_interventions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "guest_abuse_interventions_state_idx" ON "guest_abuse_interventions" USING btree ("state","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "guest_data_class_dispositions_request_class_key" ON "guest_data_class_dispositions" USING btree ("request_id","data_class");--> statement-breakpoint
CREATE INDEX "guest_data_requests_group_idx" ON "guest_data_requests" USING btree ("checkout_group_id","created_at");--> statement-breakpoint
CREATE INDEX "guest_data_requests_state_idx" ON "guest_data_requests" USING btree ("state","created_at");--> statement-breakpoint
CREATE INDEX "guest_launch_gate_signoffs_stage_gate_idx" ON "guest_launch_gate_signoffs" USING btree ("stage","gate","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "guest_legal_holds_live_key" ON "guest_legal_holds" USING btree ("checkout_group_id","retention_class") WHERE lifted_at is null;--> statement-breakpoint
CREATE INDEX "guest_legal_holds_class_live_idx" ON "guest_legal_holds" USING btree ("retention_class") WHERE lifted_at is null;--> statement-breakpoint
CREATE UNIQUE INDEX "guest_retention_policy_versions_row_key" ON "guest_retention_policy_versions" USING btree ("policy_key","version","retention_class");--> statement-breakpoint
CREATE UNIQUE INDEX "guest_retention_policy_versions_active_key" ON "guest_retention_policy_versions" USING btree ("policy_key","retention_class") WHERE status = 'active';--> statement-breakpoint
CREATE INDEX "guest_retention_policy_versions_version_idx" ON "guest_retention_policy_versions" USING btree ("policy_key","version");--> statement-breakpoint
CREATE INDEX "guest_retention_runs_class_started_idx" ON "guest_retention_runs" USING btree ("retention_class","started_at");--> statement-breakpoint
CREATE INDEX "guest_rollout_stage_advances_outcome_idx" ON "guest_rollout_stage_advances" USING btree ("outcome","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "guest_security_signal_counters_window_key" ON "guest_security_signal_counters" USING btree ("signal","window_started_at");--> statement-breakpoint
CREATE INDEX "guest_security_signal_counters_window_started_idx" ON "guest_security_signal_counters" USING btree ("window_started_at");--> statement-breakpoint
ALTER TABLE "analytics_events" ADD CONSTRAINT "analytics_events_payment_method_category_check" CHECK ("analytics_events"."payment_method_category" in ('card', 'wallet_apple_pay', 'wallet_google_pay', 'bank_redirect', 'bank_transfer', 'buy_now_pay_later', 'other'));--> statement-breakpoint
ALTER TABLE "analytics_events" ADD CONSTRAINT "analytics_events_payment_method_scope_check" CHECK ("analytics_events"."payment_method_category" is null
          or "analytics_events"."event_type" in ('guest_payment_methods_shown', 'guest_payment_method_selected', 'guest_payment_action_required', 'guest_payment_client_failed'));--> statement-breakpoint
ALTER TABLE "analytics_events" ADD CONSTRAINT "analytics_events_reason_code_check" CHECK ("analytics_events"."reason_code" in ('not_found', 'unavailable', 'rate_limited', 'upstream_timeout', 'upstream_error', 'validation_failed', 'forbidden', 'stale_offer', 'out_of_stock', 'listing_restricted', 'seller_not_payment_ready', 'p2p_seller_excluded', 'market_not_supported', 'currency_not_supported', 'guest_commerce_disabled', 'guest_cart_disabled', 'guest_issuance_disabled', 'guest_checkout_disabled', 'guest_rollout_blocked', 'guest_seller_not_activated', 'retail_line_ineligible', 'merge_completed', 'merge_already_done', 'merge_nothing_to_move', 'merge_quantity_clamped', 'merge_line_flagged', 'merge_discount_dropped', 'contact_malformed', 'contact_undeliverable', 'destination_incomplete', 'destination_unsupported', 'claim_offered', 'claim_completed', 'claim_declined', 'claim_conflicted', 'abuse_cooldown', 'abuse_verification_required', 'abuse_manual_review', 'other'));--> statement-breakpoint
ALTER TABLE "analytics_experiments" ADD CONSTRAINT "analytics_experiments_primary_metric_check" CHECK ("analytics_experiments"."primary_metric_key" in ('search_success_rate', 'zero_result_rate', 'duplicate_product_rate', 'search_to_product_click_rate', 'product_to_offer_selection_rate', 'external_click_through_rate', 'native_add_to_cart_rate', 'native_checkout_conversion', 'authenticated_checkout_funnel', 'guest_checkout_funnel', 'guest_verified_payment_conversion', 'order_portal_delivery_success', 'oxy_claim_funnel', 'saved_intent_return_rate', 'source_coverage_gap', 'query_latency_and_freshness', 'merchant_claim_funnel', 'native_gmv', 'marketplace_revenue', 'affiliate_commission', 'guest_post_purchase_demand', 'guest_eligibility_coverage', 'guest_add_to_cart_rate', 'guest_cart_progression_rate', 'guest_funnel_step_failure_rate', 'guest_express_method_usage', 'guest_recovery_success_rate', 'guest_abuse_intervention_rate', 'guest_abuse_false_positive_rate', 'guest_share_of_native_gmv', 'guest_payment_return_recovery', 'guest_portal_initialization_lag'));--> statement-breakpoint
ALTER TABLE "analytics_experiments" ADD CONSTRAINT "analytics_experiments_guardrails_check" CHECK ("analytics_experiments"."guardrail_metric_keys" <@ array['search_success_rate', 'zero_result_rate', 'duplicate_product_rate', 'search_to_product_click_rate', 'product_to_offer_selection_rate', 'external_click_through_rate', 'native_add_to_cart_rate', 'native_checkout_conversion', 'authenticated_checkout_funnel', 'guest_checkout_funnel', 'guest_verified_payment_conversion', 'order_portal_delivery_success', 'oxy_claim_funnel', 'saved_intent_return_rate', 'source_coverage_gap', 'query_latency_and_freshness', 'merchant_claim_funnel', 'native_gmv', 'marketplace_revenue', 'affiliate_commission', 'guest_post_purchase_demand', 'guest_eligibility_coverage', 'guest_add_to_cart_rate', 'guest_cart_progression_rate', 'guest_funnel_step_failure_rate', 'guest_express_method_usage', 'guest_recovery_success_rate', 'guest_abuse_intervention_rate', 'guest_abuse_false_positive_rate', 'guest_share_of_native_gmv', 'guest_payment_return_recovery', 'guest_portal_initialization_lag']::text[]);--> statement-breakpoint
ALTER TABLE "analytics_rollups" ADD CONSTRAINT "analytics_rollups_metric_key_check" CHECK ("analytics_rollups"."metric_key" in ('search_success_rate', 'zero_result_rate', 'duplicate_product_rate', 'search_to_product_click_rate', 'product_to_offer_selection_rate', 'external_click_through_rate', 'native_add_to_cart_rate', 'native_checkout_conversion', 'authenticated_checkout_funnel', 'guest_checkout_funnel', 'guest_verified_payment_conversion', 'order_portal_delivery_success', 'oxy_claim_funnel', 'saved_intent_return_rate', 'source_coverage_gap', 'query_latency_and_freshness', 'merchant_claim_funnel', 'native_gmv', 'marketplace_revenue', 'affiliate_commission', 'guest_post_purchase_demand', 'guest_eligibility_coverage', 'guest_add_to_cart_rate', 'guest_cart_progression_rate', 'guest_funnel_step_failure_rate', 'guest_express_method_usage', 'guest_recovery_success_rate', 'guest_abuse_intervention_rate', 'guest_abuse_false_positive_rate', 'guest_share_of_native_gmv', 'guest_payment_return_recovery', 'guest_portal_initialization_lag'));--> statement-breakpoint
ALTER TABLE "price_signal_policy_versions" ADD CONSTRAINT "price_signal_policy_versions_objective_metrics_check" CHECK ("price_signal_policy_versions"."objective_metric_keys" <@ array['search_success_rate', 'zero_result_rate', 'duplicate_product_rate', 'search_to_product_click_rate', 'product_to_offer_selection_rate', 'external_click_through_rate', 'native_add_to_cart_rate', 'native_checkout_conversion', 'authenticated_checkout_funnel', 'guest_checkout_funnel', 'guest_verified_payment_conversion', 'order_portal_delivery_success', 'oxy_claim_funnel', 'saved_intent_return_rate', 'source_coverage_gap', 'query_latency_and_freshness', 'merchant_claim_funnel', 'native_gmv', 'marketplace_revenue', 'affiliate_commission', 'guest_post_purchase_demand', 'guest_eligibility_coverage', 'guest_add_to_cart_rate', 'guest_cart_progression_rate', 'guest_funnel_step_failure_rate', 'guest_express_method_usage', 'guest_recovery_success_rate', 'guest_abuse_intervention_rate', 'guest_abuse_false_positive_rate', 'guest_share_of_native_gmv', 'guest_payment_return_recovery', 'guest_portal_initialization_lag']::text[]);--> statement-breakpoint
ALTER TABLE "price_signal_policy_versions" ADD CONSTRAINT "price_signal_policy_versions_guardrail_metrics_check" CHECK ("price_signal_policy_versions"."guardrail_metric_keys" <@ array['search_success_rate', 'zero_result_rate', 'duplicate_product_rate', 'search_to_product_click_rate', 'product_to_offer_selection_rate', 'external_click_through_rate', 'native_add_to_cart_rate', 'native_checkout_conversion', 'authenticated_checkout_funnel', 'guest_checkout_funnel', 'guest_verified_payment_conversion', 'order_portal_delivery_success', 'oxy_claim_funnel', 'saved_intent_return_rate', 'source_coverage_gap', 'query_latency_and_freshness', 'merchant_claim_funnel', 'native_gmv', 'marketplace_revenue', 'affiliate_commission', 'guest_post_purchase_demand', 'guest_eligibility_coverage', 'guest_add_to_cart_rate', 'guest_cart_progression_rate', 'guest_funnel_step_failure_rate', 'guest_express_method_usage', 'guest_recovery_success_rate', 'guest_abuse_intervention_rate', 'guest_abuse_false_positive_rate', 'guest_share_of_native_gmv', 'guest_payment_return_recovery', 'guest_portal_initialization_lag']::text[]);--> statement-breakpoint
ALTER TABLE "ranking_policy_versions" ADD CONSTRAINT "ranking_policy_versions_objective_metrics_check" CHECK ("ranking_policy_versions"."objective_metric_keys" <@ array['search_success_rate', 'zero_result_rate', 'duplicate_product_rate', 'search_to_product_click_rate', 'product_to_offer_selection_rate', 'external_click_through_rate', 'native_add_to_cart_rate', 'native_checkout_conversion', 'authenticated_checkout_funnel', 'guest_checkout_funnel', 'guest_verified_payment_conversion', 'order_portal_delivery_success', 'oxy_claim_funnel', 'saved_intent_return_rate', 'source_coverage_gap', 'query_latency_and_freshness', 'merchant_claim_funnel', 'native_gmv', 'marketplace_revenue', 'affiliate_commission', 'guest_post_purchase_demand', 'guest_eligibility_coverage', 'guest_add_to_cart_rate', 'guest_cart_progression_rate', 'guest_funnel_step_failure_rate', 'guest_express_method_usage', 'guest_recovery_success_rate', 'guest_abuse_intervention_rate', 'guest_abuse_false_positive_rate', 'guest_share_of_native_gmv', 'guest_payment_return_recovery', 'guest_portal_initialization_lag']::text[]);--> statement-breakpoint
ALTER TABLE "ranking_policy_versions" ADD CONSTRAINT "ranking_policy_versions_guardrail_metrics_check" CHECK ("ranking_policy_versions"."guardrail_metric_keys" <@ array['search_success_rate', 'zero_result_rate', 'duplicate_product_rate', 'search_to_product_click_rate', 'product_to_offer_selection_rate', 'external_click_through_rate', 'native_add_to_cart_rate', 'native_checkout_conversion', 'authenticated_checkout_funnel', 'guest_checkout_funnel', 'guest_verified_payment_conversion', 'order_portal_delivery_success', 'oxy_claim_funnel', 'saved_intent_return_rate', 'source_coverage_gap', 'query_latency_and_freshness', 'merchant_claim_funnel', 'native_gmv', 'marketplace_revenue', 'affiliate_commission', 'guest_post_purchase_demand', 'guest_eligibility_coverage', 'guest_add_to_cart_rate', 'guest_cart_progression_rate', 'guest_funnel_step_failure_rate', 'guest_express_method_usage', 'guest_recovery_success_rate', 'guest_abuse_intervention_rate', 'guest_abuse_false_positive_rate', 'guest_share_of_native_gmv', 'guest_payment_return_recovery', 'guest_portal_initialization_lag']::text[]);

--> statement-breakpoint
-- A published retention policy version is FROZEN. The `fee_schedules` and
-- `catalog_source_freshness_policies` device: a retention somebody relied on
-- must still be readable after it is superseded, because "how long was this
-- kept, and under what rule" is asked months later about data that has already
-- gone. Only the supersede transition may move, and only in one direction.
CREATE OR REPLACE FUNCTION mercaria_guest_retention_policy_immutable()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN
      RAISE EXCEPTION
        'guest_retention_policy_versions % (%, v%) is % and cannot be deleted; data was retained under this version',
        OLD.id, OLD.retention_class, OLD.version, OLD.status
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.status = 'draft' THEN
    RETURN NEW;
  END IF;

  IF NEW.policy_key IS DISTINCT FROM OLD.policy_key
     OR NEW.version IS DISTINCT FROM OLD.version
     OR NEW.retention_class IS DISTINCT FROM OLD.retention_class
     OR NEW.retention_seconds IS DISTINCT FROM OLD.retention_seconds
     OR NEW.mechanism IS DISTINCT FROM OLD.mechanism
     OR NEW.pausable_by_legal_hold IS DISTINCT FROM OLD.pausable_by_legal_hold
     OR NEW.rationale IS DISTINCT FROM OLD.rationale
     OR NEW.published_by_oxy_user_id IS DISTINCT FROM OLD.published_by_oxy_user_id
     OR NEW.published_at IS DISTINCT FROM OLD.published_at THEN
    RAISE EXCEPTION
      'guest_retention_policy_versions % (%, v%) is % and is frozen; publish a new version instead',
      OLD.id, OLD.retention_class, OLD.version, OLD.status
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF OLD.status = 'superseded' AND NEW.status <> 'superseded' THEN
    RAISE EXCEPTION
      'guest_retention_policy_versions % (%, v%) is superseded and cannot be reactivated',
      OLD.id, OLD.retention_class, OLD.version
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
DROP TRIGGER IF EXISTS guest_retention_policy_versions_immutable ON "guest_retention_policy_versions";--> statement-breakpoint
CREATE TRIGGER guest_retention_policy_versions_immutable
  BEFORE UPDATE OR DELETE ON "guest_retention_policy_versions"
  FOR EACH ROW EXECUTE FUNCTION mercaria_guest_retention_policy_immutable();--> statement-breakpoint

-- The sign-off history and the advance history are APPEND-ONLY against UPDATE
-- *and* DELETE — the `buyer_request_events` posture. A sign-off somebody later
-- edited is not a sign-off, and the whole value of both tables is that they can
-- be read back months afterwards to answer "who said this was ready, and when".
-- A WITHDRAWAL is a new row saying `no`, never an edit.
CREATE OR REPLACE FUNCTION mercaria_guest_rollout_append_only()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION
    '% is append-only; record a new row instead of % an existing one',
    TG_TABLE_NAME, lower(TG_OP)
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
DROP TRIGGER IF EXISTS guest_launch_gate_signoffs_append_only ON "guest_launch_gate_signoffs";--> statement-breakpoint
CREATE TRIGGER guest_launch_gate_signoffs_append_only
  BEFORE UPDATE OR DELETE ON "guest_launch_gate_signoffs"
  FOR EACH ROW EXECUTE FUNCTION mercaria_guest_rollout_append_only();--> statement-breakpoint
DROP TRIGGER IF EXISTS guest_rollout_stage_advances_append_only ON "guest_rollout_stage_advances";--> statement-breakpoint
CREATE TRIGGER guest_rollout_stage_advances_append_only
  BEFORE UPDATE OR DELETE ON "guest_rollout_stage_advances"
  FOR EACH ROW EXECUTE FUNCTION mercaria_guest_rollout_append_only();
