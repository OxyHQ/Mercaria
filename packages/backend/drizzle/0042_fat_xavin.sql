-- oxy:deploy-phase=pre
-- oxy:rollback=restore: supplier_quotes_declared_capabilities_check and its two siblings are widened for #124's order capabilities; the previous forms are in the #122 migration and re-adding them fails against any quote declaring one of the added capabilities
--
-- #124 — the supplier ORDER orchestration. Entirely ADDITIVE: seven new tables,
-- three new nullable columns on `purchase_orders` with their shape CHECKs, and
-- three capability-array CHECKs WIDENED from twelve members to twenty-four
-- (#122's preflight set plus #124's order set). Nothing is dropped, narrowed or
-- renamed, so the serving image keeps working throughout.
--
-- ## HAND-WRITTEN STATEMENTS RIDE THIS FILE
--
-- drizzle-kit does not model triggers. The four enforcement functions below are
-- added by hand at the END of this file, and a regeneration DROPS them — if you
-- regenerate this migration, re-append the block between the two anchors and
-- verify with:
--
--   grep -cE '^CREATE OR REPLACE FUNCTION mercaria_' 0042_*.sql   # expect 4
--   grep -cE '^CREATE TRIGGER' 0042_*.sql                          # expect 4
--   grep -cE '^-- oxy:deploy-phase=' 0042_*.sql                    # expect 1
--
-- Each pattern is ANCHORED on purpose: an unanchored one also matches these
-- very lines, so it answers 5 / 4 / 2 and reads as a broken check to whoever
-- runs it next.
--
CREATE TABLE "procurement_exceptions" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"purchase_order_id" text,
	"supplier_id" text,
	"supplier_account_id" text,
	"provider_event_id" text,
	"detail" text NOT NULL,
	"detected_at" timestamp with time zone NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolution" text,
	"resolved_by_oxy_user_id" text,
	"resolution_note" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "procurement_exceptions_kind_check" CHECK ("procurement_exceptions"."kind" in ('ambiguous_submission', 'unconverged_submission', 'duplicate_external_order', 'provider_state_regression', 'unmapped_provider_state', 'late_acceptance_after_cancellation', 'shipment_after_cancellation', 'webhook_poll_disagreement', 'event_lag_sla_breach', 'stuck_purchase_order', 'credential_rejected', 'quota_exhausted', 'substitution_detected', 'capability_not_declared', 'cost_mismatch')),
	CONSTRAINT "procurement_exceptions_resolution_check" CHECK ("procurement_exceptions"."resolution" in ('converged', 'duplicate_confirmed', 'operator_cancelled', 'operator_accepted', 'provider_corrected', 'no_action_required', 'escalated')),
	CONSTRAINT "procurement_exceptions_detail_length_check" CHECK (length("procurement_exceptions"."detail") > 0 and length("procurement_exceptions"."detail") <= 2000),
	CONSTRAINT "procurement_exceptions_note_length_check" CHECK ("procurement_exceptions"."resolution_note" is null
          or length("procurement_exceptions"."resolution_note") <= 2000),
	CONSTRAINT "procurement_exceptions_resolution_shape_check" CHECK (num_nonnulls("procurement_exceptions"."resolved_at", "procurement_exceptions"."resolution", "procurement_exceptions"."resolved_by_oxy_user_id") in (0, 3)),
	CONSTRAINT "procurement_exceptions_subject_check" CHECK (num_nonnulls("procurement_exceptions"."purchase_order_id", "procurement_exceptions"."supplier_account_id", "procurement_exceptions"."provider_event_id") >= 1)
);
--> statement-breakpoint
CREATE TABLE "procurement_outboxes" (
	"id" text PRIMARY KEY NOT NULL,
	"event_type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone NOT NULL,
	"lease_owner" text,
	"lease_until" timestamp with time zone,
	"last_error" text,
	"processed_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "procurement_outboxes_event_type_check" CHECK ("procurement_outboxes"."event_type" in ('purchase_order_submission', 'purchase_order_cancellation', 'purchase_order_status_poll', 'purchase_order_convergence', 'purchase_order_accepted', 'purchase_order_rejected', 'purchase_order_exception')),
	CONSTRAINT "procurement_outboxes_status_check" CHECK ("procurement_outboxes"."status" in ('pending', 'processing', 'processed', 'dead_letter')),
	CONSTRAINT "procurement_outboxes_attempts_check" CHECK ("procurement_outboxes"."attempts" >= 0),
	CONSTRAINT "procurement_outboxes_last_error_length_check" CHECK ("procurement_outboxes"."last_error" is null or length("procurement_outboxes"."last_error") <= 2000)
);
--> statement-breakpoint
CREATE TABLE "purchase_order_documents" (
	"id" text PRIMARY KEY NOT NULL,
	"purchase_order_id" text NOT NULL,
	"kind" text NOT NULL,
	"provider_document_id" text NOT NULL,
	"document_number" text,
	"currency" text NOT NULL,
	"total_amount" bigint NOT NULL,
	"tax_amount" bigint,
	"issued_at" timestamp with time zone NOT NULL,
	"retrieved_at" timestamp with time zone NOT NULL,
	"related_provider_document_id" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "purchase_order_documents_kind_check" CHECK ("purchase_order_documents"."kind" in ('invoice', 'credit_note')),
	CONSTRAINT "purchase_order_documents_currency_check" CHECK ("purchase_order_documents"."currency" in ('FAIR', 'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF', 'CNY', 'SEK', 'NOK', 'DKK', 'PLN', 'MXN', 'BRL', 'INR', 'NZD', 'ZAR', 'SGD', 'HKD', 'AED')),
	CONSTRAINT "purchase_order_documents_provider_id_check" CHECK (length("purchase_order_documents"."provider_document_id") > 0),
	CONSTRAINT "purchase_order_documents_amounts_check" CHECK ("purchase_order_documents"."total_amount" >= 0 and ("purchase_order_documents"."tax_amount" is null or "purchase_order_documents"."tax_amount" >= 0)),
	CONSTRAINT "purchase_order_documents_related_shape_check" CHECK ("purchase_order_documents"."related_provider_document_id" is null or "purchase_order_documents"."kind" = 'credit_note')
);
--> statement-breakpoint
CREATE TABLE "purchase_order_line_outcomes" (
	"id" text PRIMARY KEY NOT NULL,
	"purchase_order_id" text NOT NULL,
	"purchase_order_line_id" text NOT NULL,
	"kind" text NOT NULL,
	"quantity" integer NOT NULL,
	"reason_code" text,
	"provider_event_id" text,
	"observed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "purchase_order_line_outcomes_kind_check" CHECK ("purchase_order_line_outcomes"."kind" in ('accepted', 'rejected', 'shipped', 'cancelled', 'returned')),
	CONSTRAINT "purchase_order_line_outcomes_reason_code_check" CHECK ("purchase_order_line_outcomes"."reason_code" in ('out_of_stock', 'price_changed', 'moq_not_met', 'sku_unknown', 'destination_not_served', 'address_invalid', 'acceptance_timeout', 'supplier_error', 'customer_cancelled', 'supplier_cancelled', 'operator_cancelled', 'other')),
	CONSTRAINT "purchase_order_line_outcomes_quantity_check" CHECK ("purchase_order_line_outcomes"."quantity" > 0)
);
--> statement-breakpoint
CREATE TABLE "purchase_order_tracking_events" (
	"id" text PRIMARY KEY NOT NULL,
	"purchase_order_id" text NOT NULL,
	"shipment_id" text,
	"tracking_number" text NOT NULL,
	"status" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"description" text,
	"location_country" text,
	"location_region" text,
	"provider_event_id" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "purchase_order_tracking_events_status_check" CHECK ("purchase_order_tracking_events"."status" in ('label_created', 'in_transit', 'out_for_delivery', 'delivered', 'delivery_exception', 'returned_to_sender')),
	CONSTRAINT "purchase_order_tracking_events_tracking_number_check" CHECK (length("purchase_order_tracking_events"."tracking_number") > 0),
	CONSTRAINT "purchase_order_tracking_events_description_length_check" CHECK ("purchase_order_tracking_events"."description" is null
          or length("purchase_order_tracking_events"."description") <= 512),
	CONSTRAINT "purchase_order_tracking_events_country_check" CHECK ("purchase_order_tracking_events"."location_country" is null or "purchase_order_tracking_events"."location_country" ~ '^[A-Z]{2}$')
);
--> statement-breakpoint
CREATE TABLE "supplier_order_attempts" (
	"id" text PRIMARY KEY NOT NULL,
	"purchase_order_id" text NOT NULL,
	"supplier_account_id" text NOT NULL,
	"operation" text NOT NULL,
	"attempt_number" integer NOT NULL,
	"outcome" text DEFAULT 'in_flight' NOT NULL,
	"refusal_reason" text,
	"request_hash" text NOT NULL,
	"provider_object_id" text,
	"provider_error_class" text,
	"provider_error_after_write" text,
	"provider_error_code" text,
	"provider_message" text,
	"reason_code" text,
	"state_mapping_version" integer,
	"started_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"latency_ms" integer,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "supplier_order_attempts_operation_check" CHECK ("supplier_order_attempts"."operation" in ('draft_validate', 'submit', 'reference_lookup', 'read', 'cancel', 'shipments', 'invoice', 'credit_note', 'return_create', 'return_read')),
	CONSTRAINT "supplier_order_attempts_outcome_check" CHECK ("supplier_order_attempts"."outcome" in ('in_flight', 'succeeded', 'failed', 'ambiguous', 'converged', 'refused')),
	CONSTRAINT "supplier_order_attempts_refusal_reason_check" CHECK ("supplier_order_attempts"."refusal_reason" in ('provider_unconfigured', 'capability_not_declared', 'account_not_active', 'account_kill_switched', 'supplier_suppressed', 'credential_not_valid', 'provider_fetch_disabled', 'provider_lease_unavailable', 'payment_not_authorized', 'environment_refused')),
	CONSTRAINT "supplier_order_attempts_error_class_check" CHECK ("supplier_order_attempts"."provider_error_class" in ('retryable', 'terminal', 'auth', 'quota', 'validation', 'unknown')),
	CONSTRAINT "supplier_order_attempts_reason_code_check" CHECK ("supplier_order_attempts"."reason_code" in ('out_of_stock', 'price_changed', 'moq_not_met', 'sku_unknown', 'destination_not_served', 'address_invalid', 'acceptance_timeout', 'supplier_error', 'customer_cancelled', 'supplier_cancelled', 'operator_cancelled', 'other')),
	CONSTRAINT "supplier_order_attempts_attempt_number_check" CHECK ("supplier_order_attempts"."attempt_number" >= 1),
	CONSTRAINT "supplier_order_attempts_request_hash_check" CHECK (length("supplier_order_attempts"."request_hash") = 64),
	CONSTRAINT "supplier_order_attempts_latency_check" CHECK ("supplier_order_attempts"."latency_ms" is null or "supplier_order_attempts"."latency_ms" >= 0),
	CONSTRAINT "supplier_order_attempts_message_length_check" CHECK ("supplier_order_attempts"."provider_message" is null
          or length("supplier_order_attempts"."provider_message") <= 512),
	CONSTRAINT "supplier_order_attempts_refusal_shape_check" CHECK (("supplier_order_attempts"."outcome" = 'refused') = ("supplier_order_attempts"."refusal_reason" is not null)),
	CONSTRAINT "supplier_order_attempts_ambiguity_shape_check" CHECK ("supplier_order_attempts"."outcome" <> 'ambiguous' or "supplier_order_attempts"."provider_error_after_write" = 'yes'),
	CONSTRAINT "supplier_order_attempts_completion_shape_check" CHECK (("supplier_order_attempts"."outcome" = 'in_flight') = ("supplier_order_attempts"."completed_at" is null))
);
--> statement-breakpoint
CREATE TABLE "supplier_provider_events" (
	"id" text PRIMARY KEY NOT NULL,
	"supplier_account_id" text NOT NULL,
	"provider" text NOT NULL,
	"delivery" text NOT NULL,
	"verification" text NOT NULL,
	"provider_event_id" text,
	"content_hash" text NOT NULL,
	"event_type" text NOT NULL,
	"provider_order_id" text,
	"purchase_order_id" text,
	"normalized_state" text NOT NULL,
	"provider_state" text,
	"state_mapping_version" integer NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"payload_summary" jsonb NOT NULL,
	"status" text DEFAULT 'received' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"processed_at" timestamp with time zone,
	"next_attempt_at" timestamp with time zone,
	"lease_owner" text,
	"lease_until" timestamp with time zone,
	"processing_note" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "supplier_provider_events_delivery_check" CHECK ("supplier_provider_events"."delivery" in ('webhook', 'poll', 'operator_probe')),
	CONSTRAINT "supplier_provider_events_verification_check" CHECK ("supplier_provider_events"."verification" in ('signature', 'shared_secret', 'mutual_tls', 'authenticated_poll')),
	CONSTRAINT "supplier_provider_events_status_check" CHECK ("supplier_provider_events"."status" in ('received', 'processing', 'processed', 'failed', 'dead_letter')),
	CONSTRAINT "supplier_provider_events_state_check" CHECK ("supplier_provider_events"."normalized_state" in ('unknown', 'received', 'accepted', 'partially_accepted', 'processing', 'partially_shipped', 'shipped', 'delivered', 'rejected', 'cancelled')),
	CONSTRAINT "supplier_provider_events_provider_check" CHECK ("supplier_provider_events"."provider" ~ '^[a-z0-9][a-z0-9_-]*$'),
	CONSTRAINT "supplier_provider_events_content_hash_check" CHECK (length("supplier_provider_events"."content_hash") = 64),
	CONSTRAINT "supplier_provider_events_attempts_check" CHECK ("supplier_provider_events"."attempts" >= 0),
	CONSTRAINT "supplier_provider_events_last_error_length_check" CHECK ("supplier_provider_events"."last_error" is null or length("supplier_provider_events"."last_error") <= 2000),
	CONSTRAINT "supplier_provider_events_processing_note_length_check" CHECK ("supplier_provider_events"."processing_note" is null
          or length("supplier_provider_events"."processing_note") <= 2000),
	CONSTRAINT "supplier_provider_events_delivery_identity_check" CHECK (("supplier_provider_events"."delivery" = 'webhook') = ("supplier_provider_events"."provider_event_id" is not null))
);
--> statement-breakpoint
ALTER TABLE "supplier_quotes" DROP CONSTRAINT "supplier_quotes_declared_capabilities_check";--> statement-breakpoint
ALTER TABLE "supplier_reservations" DROP CONSTRAINT "supplier_reservations_declared_capabilities_check";--> statement-breakpoint
ALTER TABLE "supplier_sourcing_policies" DROP CONSTRAINT "supplier_sourcing_policies_required_capabilities_check";--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD COLUMN "provider_state" text;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD COLUMN "provider_state_observed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD COLUMN "state_mapping_version" integer;--> statement-breakpoint
ALTER TABLE "procurement_exceptions" ADD CONSTRAINT "procurement_exceptions_purchase_order_id_purchase_orders_id_fk" FOREIGN KEY ("purchase_order_id") REFERENCES "public"."purchase_orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "procurement_exceptions" ADD CONSTRAINT "procurement_exceptions_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "procurement_exceptions" ADD CONSTRAINT "procurement_exceptions_supplier_account_id_supplier_accounts_id_fk" FOREIGN KEY ("supplier_account_id") REFERENCES "public"."supplier_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "procurement_exceptions" ADD CONSTRAINT "procurement_exceptions_provider_event_id_supplier_provider_events_id_fk" FOREIGN KEY ("provider_event_id") REFERENCES "public"."supplier_provider_events"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_documents" ADD CONSTRAINT "purchase_order_documents_purchase_order_id_purchase_orders_id_fk" FOREIGN KEY ("purchase_order_id") REFERENCES "public"."purchase_orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_line_outcomes" ADD CONSTRAINT "purchase_order_line_outcomes_purchase_order_id_purchase_orders_id_fk" FOREIGN KEY ("purchase_order_id") REFERENCES "public"."purchase_orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_line_outcomes" ADD CONSTRAINT "purchase_order_line_outcomes_purchase_order_line_id_purchase_order_lines_id_fk" FOREIGN KEY ("purchase_order_line_id") REFERENCES "public"."purchase_order_lines"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_line_outcomes" ADD CONSTRAINT "purchase_order_line_outcomes_provider_event_id_supplier_provider_events_id_fk" FOREIGN KEY ("provider_event_id") REFERENCES "public"."supplier_provider_events"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_tracking_events" ADD CONSTRAINT "purchase_order_tracking_events_purchase_order_id_purchase_orders_id_fk" FOREIGN KEY ("purchase_order_id") REFERENCES "public"."purchase_orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_tracking_events" ADD CONSTRAINT "purchase_order_tracking_events_shipment_id_purchase_order_shipments_id_fk" FOREIGN KEY ("shipment_id") REFERENCES "public"."purchase_order_shipments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_tracking_events" ADD CONSTRAINT "purchase_order_tracking_events_provider_event_id_supplier_provider_events_id_fk" FOREIGN KEY ("provider_event_id") REFERENCES "public"."supplier_provider_events"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_order_attempts" ADD CONSTRAINT "supplier_order_attempts_purchase_order_id_purchase_orders_id_fk" FOREIGN KEY ("purchase_order_id") REFERENCES "public"."purchase_orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_order_attempts" ADD CONSTRAINT "supplier_order_attempts_supplier_account_id_supplier_accounts_id_fk" FOREIGN KEY ("supplier_account_id") REFERENCES "public"."supplier_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_provider_events" ADD CONSTRAINT "supplier_provider_events_supplier_account_id_supplier_accounts_id_fk" FOREIGN KEY ("supplier_account_id") REFERENCES "public"."supplier_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_provider_events" ADD CONSTRAINT "supplier_provider_events_purchase_order_id_purchase_orders_id_fk" FOREIGN KEY ("purchase_order_id") REFERENCES "public"."purchase_orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "procurement_exceptions_open_purchase_order_key" ON "procurement_exceptions" USING btree ("kind","purchase_order_id") WHERE "procurement_exceptions"."resolved_at" is null and "procurement_exceptions"."purchase_order_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "procurement_exceptions_open_account_key" ON "procurement_exceptions" USING btree ("kind","supplier_account_id") WHERE "procurement_exceptions"."resolved_at" is null and "procurement_exceptions"."purchase_order_id" is null
                 and "procurement_exceptions"."supplier_account_id" is not null;--> statement-breakpoint
CREATE INDEX "procurement_exceptions_open_idx" ON "procurement_exceptions" USING btree ("detected_at") WHERE "procurement_exceptions"."resolved_at" is null;--> statement-breakpoint
CREATE INDEX "procurement_exceptions_po_idx" ON "procurement_exceptions" USING btree ("purchase_order_id","detected_at");--> statement-breakpoint
CREATE INDEX "procurement_outboxes_pending_idx" ON "procurement_outboxes" USING btree ("available_at","created_at") WHERE "procurement_outboxes"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "procurement_outboxes_reclaim_idx" ON "procurement_outboxes" USING btree ("lease_until","created_at") WHERE "procurement_outboxes"."status" = 'processing';--> statement-breakpoint
CREATE INDEX "procurement_outboxes_dead_letter_idx" ON "procurement_outboxes" USING btree ("created_at") WHERE "procurement_outboxes"."status" = 'dead_letter';--> statement-breakpoint
CREATE INDEX "procurement_outboxes_expires_at_idx" ON "procurement_outboxes" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "purchase_order_documents_provider_document_key" ON "purchase_order_documents" USING btree ("purchase_order_id","kind","provider_document_id");--> statement-breakpoint
CREATE INDEX "purchase_order_documents_po_issued_idx" ON "purchase_order_documents" USING btree ("purchase_order_id","issued_at");--> statement-breakpoint
CREATE INDEX "purchase_order_line_outcomes_line_idx" ON "purchase_order_line_outcomes" USING btree ("purchase_order_line_id","observed_at");--> statement-breakpoint
CREATE INDEX "purchase_order_line_outcomes_po_idx" ON "purchase_order_line_outcomes" USING btree ("purchase_order_id","observed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "purchase_order_line_outcomes_event_key" ON "purchase_order_line_outcomes" USING btree ("provider_event_id","purchase_order_line_id","kind") WHERE "purchase_order_line_outcomes"."provider_event_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "purchase_order_tracking_events_scan_key" ON "purchase_order_tracking_events" USING btree ("purchase_order_id","tracking_number","status","occurred_at");--> statement-breakpoint
CREATE INDEX "purchase_order_tracking_events_po_occurred_idx" ON "purchase_order_tracking_events" USING btree ("purchase_order_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "supplier_order_attempts_sequence_key" ON "supplier_order_attempts" USING btree ("purchase_order_id","operation","attempt_number");--> statement-breakpoint
CREATE INDEX "supplier_order_attempts_po_started_idx" ON "supplier_order_attempts" USING btree ("purchase_order_id","started_at");--> statement-breakpoint
CREATE INDEX "supplier_order_attempts_unresolved_idx" ON "supplier_order_attempts" USING btree ("started_at") WHERE "supplier_order_attempts"."outcome" in ('ambiguous', 'in_flight');--> statement-breakpoint
CREATE INDEX "supplier_order_attempts_error_class_idx" ON "supplier_order_attempts" USING btree ("supplier_account_id","provider_error_class","started_at") WHERE "supplier_order_attempts"."provider_error_class" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "supplier_provider_events_provider_event_key" ON "supplier_provider_events" USING btree ("supplier_account_id","provider_event_id") WHERE "supplier_provider_events"."provider_event_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "supplier_provider_events_content_key" ON "supplier_provider_events" USING btree ("supplier_account_id","content_hash") WHERE "supplier_provider_events"."provider_event_id" is null;--> statement-breakpoint
CREATE INDEX "supplier_provider_events_claimable_idx" ON "supplier_provider_events" USING btree ("next_attempt_at","received_at") WHERE "supplier_provider_events"."status" in ('received', 'failed');--> statement-breakpoint
CREATE INDEX "supplier_provider_events_reclaim_idx" ON "supplier_provider_events" USING btree ("lease_until","received_at") WHERE "supplier_provider_events"."status" = 'processing';--> statement-breakpoint
CREATE INDEX "supplier_provider_events_po_observed_idx" ON "supplier_provider_events" USING btree ("purchase_order_id","observed_at") WHERE "supplier_provider_events"."purchase_order_id" is not null;--> statement-breakpoint
CREATE INDEX "supplier_provider_events_lag_idx" ON "supplier_provider_events" USING btree ("supplier_account_id","received_at");--> statement-breakpoint
CREATE INDEX "supplier_provider_events_expires_at_idx" ON "supplier_provider_events" USING btree ("expires_at");--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_provider_state_shape_check" CHECK (num_nonnulls("purchase_orders"."provider_state", "purchase_orders"."provider_state_observed_at", "purchase_orders"."state_mapping_version") in (0, 3));--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_state_mapping_version_check" CHECK ("purchase_orders"."state_mapping_version" is null or "purchase_orders"."state_mapping_version" >= 1);--> statement-breakpoint
ALTER TABLE "supplier_quotes" ADD CONSTRAINT "supplier_quotes_declared_capabilities_check" CHECK ("supplier_quotes"."declared_capabilities" <@ array['live_product_lookup', 'live_stock_lookup', 'destination_shipping_quote', 'order_draft_validation', 'inventory_reservation', 'quote_expiry', 'price_guarantee', 'address_validation', 'delivery_estimate', 'tax_duty_estimate', 'cancellation_before_submission', 'update_notifications', 'order_draft_submission', 'order_state_read', 'order_reference_lookup', 'order_cancellation', 'order_partial_acceptance', 'shipment_read', 'tracking_events', 'invoice_retrieval', 'credit_note_retrieval', 'return_authorization', 'order_webhooks', 'order_polling']::text[]);--> statement-breakpoint
ALTER TABLE "supplier_reservations" ADD CONSTRAINT "supplier_reservations_declared_capabilities_check" CHECK ("supplier_reservations"."declared_capabilities" <@ array['live_product_lookup', 'live_stock_lookup', 'destination_shipping_quote', 'order_draft_validation', 'inventory_reservation', 'quote_expiry', 'price_guarantee', 'address_validation', 'delivery_estimate', 'tax_duty_estimate', 'cancellation_before_submission', 'update_notifications', 'order_draft_submission', 'order_state_read', 'order_reference_lookup', 'order_cancellation', 'order_partial_acceptance', 'shipment_read', 'tracking_events', 'invoice_retrieval', 'credit_note_retrieval', 'return_authorization', 'order_webhooks', 'order_polling']::text[]);--> statement-breakpoint
ALTER TABLE "supplier_sourcing_policies" ADD CONSTRAINT "supplier_sourcing_policies_required_capabilities_check" CHECK ("supplier_sourcing_policies"."required_capabilities" <@ array['live_product_lookup', 'live_stock_lookup', 'destination_shipping_quote', 'order_draft_validation', 'inventory_reservation', 'quote_expiry', 'price_guarantee', 'address_validation', 'delivery_estimate', 'tax_duty_estimate', 'cancellation_before_submission', 'update_notifications', 'order_draft_submission', 'order_state_read', 'order_reference_lookup', 'order_cancellation', 'order_partial_acceptance', 'shipment_read', 'tracking_events', 'invoice_retrieval', 'credit_note_retrieval', 'return_authorization', 'order_webhooks', 'order_polling']::text[]);
--> statement-breakpoint
-- ===== BEGIN HAND-WRITTEN ENFORCEMENT (re-append after any regeneration) =====

-- `supplier_order_attempts` is the append-only log of every provider call
-- (#124 idempotency 8). DELETE is refused outright; UPDATE is refused once the
-- row has left `in_flight`, because an attempt necessarily exists before its
-- outcome does and needs exactly ONE write to terminate it. Without this, the
-- evidence that a request may have reached a supplier could be edited away by
-- the same code that would then place a second order.
CREATE OR REPLACE FUNCTION mercaria_supplier_order_attempts_append_only()
RETURNS trigger AS $$
BEGIN
  IF (TG_OP = 'DELETE') THEN
    RAISE EXCEPTION 'supplier_order_attempts is append-only: a provider call attempt may never be deleted';
  END IF;
  IF (OLD.outcome <> 'in_flight') THEN
    RAISE EXCEPTION 'supplier_order_attempts is frozen once terminated: attempt % is already %', OLD.id, OLD.outcome;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER mercaria_supplier_order_attempts_append_only
BEFORE UPDATE OR DELETE ON supplier_order_attempts
FOR EACH ROW EXECUTE FUNCTION mercaria_supplier_order_attempts_append_only();--> statement-breakpoint

-- `purchase_order_line_outcomes` is what a SUPPLIER said happened to one line.
-- Provider evidence is never edited: a correction is a new observation with a
-- later `observed_at`, which is what makes the trail readable as a history
-- rather than as a current opinion.
CREATE OR REPLACE FUNCTION mercaria_purchase_order_line_outcomes_append_only()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'purchase_order_line_outcomes is append-only: provider evidence is never edited or removed';
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER mercaria_purchase_order_line_outcomes_append_only
BEFORE UPDATE OR DELETE ON purchase_order_line_outcomes
FOR EACH ROW EXECUTE FUNCTION mercaria_purchase_order_line_outcomes_append_only();--> statement-breakpoint

-- `purchase_order_tracking_events` is the carrier scan trail. Same rule and the
-- same reason: a scan happened at an instant, and a corrected scan is another
-- scan.
CREATE OR REPLACE FUNCTION mercaria_purchase_order_tracking_events_append_only()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'purchase_order_tracking_events is append-only: a carrier scan is never edited or removed';
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER mercaria_purchase_order_tracking_events_append_only
BEFORE UPDATE OR DELETE ON purchase_order_tracking_events
FOR EACH ROW EXECUTE FUNCTION mercaria_purchase_order_tracking_events_append_only();--> statement-breakpoint

-- #124 security 8: "keep test and production accounts impossible to mix."
--
-- A purchase order, a preflight quote and a provider event all NAME a supplier
-- account rather than snapshotting its environment — which is right, because a
-- snapshot is a second representation of one fact. Freezing the account's own
-- identity is what makes that safe: without this trigger, flipping
-- `environment` from `test` to `live` would silently reinterpret every
-- historical row that points at the account, and a test-mode purchase order
-- would start reading as a live one.
--
-- `provider` and `provider_account_id` are frozen for the same reason: they are
-- the account's identity in a foreign key space, and the adapter registry and
-- every stored provider object id are keyed on them.
CREATE OR REPLACE FUNCTION mercaria_supplier_accounts_identity_frozen()
RETURNS trigger AS $$
BEGIN
  IF (NEW.provider IS DISTINCT FROM OLD.provider
      OR NEW.environment IS DISTINCT FROM OLD.environment
      OR NEW.provider_account_id IS DISTINCT FROM OLD.provider_account_id) THEN
    RAISE EXCEPTION 'supplier_accounts identity is frozen: provider, environment and provider_account_id may never change (account %)', OLD.id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER mercaria_supplier_accounts_identity_frozen
BEFORE UPDATE ON supplier_accounts
FOR EACH ROW EXECUTE FUNCTION mercaria_supplier_accounts_identity_frozen();

-- ===== END HAND-WRITTEN ENFORCEMENT =====
