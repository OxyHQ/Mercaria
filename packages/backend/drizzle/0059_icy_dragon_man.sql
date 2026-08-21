-- oxy:deploy-phase=pre
-- oxy:rollback=restore: guest_portal_messages_kind_check is widened again; the previous form is in 0054 and re-adding it fails against any queued message of the added kind
--
-- Retail cancellations, returns, warranties, supplier RMAs and customer refunds
-- (#127).
--
-- Purely ADDITIVE. Twelve new tables, and one WIDENING of
-- `guest_portal_messages_kind_check` for the eight message kinds #127 adds — a
-- drop-and-re-add whose new tuple is a strict superset of the old, so every
-- write the serving image performs still passes.
--
-- ## Hand-written statements, and where they go on a regeneration
--
-- `drizzle-kit generate` models no trigger, so everything below the
-- `-- BEGIN #127 hand-written triggers` anchor is re-applied BY HAND after any
-- regeneration of this file. Six pairs, and each one holds a property no CHECK
-- can:
--
--   * `retail_service_request_events` and `retail_return_line_dispositions` are
--     APPEND-ONLY against UPDATE *and* DELETE. Their foreign keys are RESTRICT
--     rather than CASCADE so the declaration and the trigger agree — a cascade
--     would be a way to delete the audit by deleting its parent, which is the
--     one deletion somebody covering something up would reach for.
--   * `retail_service_request_lines` freezes what the buyer ASKED FOR and lets
--     only `approved_quantity` move. A mutable requested quantity is how a
--     request approved for two units refunds five.
--   * `retail_return_case_lines` freezes the authorization, which is the
--     denominator every disposition sums against.
--   * `retail_service_policy_exceptions` is immutable once published except for
--     its withdrawal. An exception is snapshotted onto real requests as the
--     reason somebody was refused, and editing it afterwards rewrites what those
--     buyers were told.
--   * `retail_service_requests` freezes the order, the kind, the origin, the
--     requester triple and the whole policy snapshot, and refuses a value→value
--     change of `outcome`. The last one is #106's claim-trigger device: a
--     service bug cannot silently re-decide a remedy a buyer was already told
--     about, and re-deciding is a NEW request.
--
CREATE TABLE "retail_dispute_coordinations" (
	"id" text PRIMARY KEY NOT NULL,
	"dispute_id" text NOT NULL,
	"order_id" text NOT NULL,
	"service_request_id" text,
	"suspension" text DEFAULT 'suspended' NOT NULL,
	"suspension_reason" text,
	"released_by_oxy_user_id" text,
	"released_at" timestamp with time zone,
	"evidence_assembled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "retail_dispute_coordinations_suspension_check" CHECK ("retail_dispute_coordinations"."suspension" in ('suspended', 'released')),
	CONSTRAINT "retail_dispute_coordinations_release_shape_check" CHECK (("retail_dispute_coordinations"."suspension" = 'released')
          = ("retail_dispute_coordinations"."suspension_reason" is not null
             and "retail_dispute_coordinations"."released_by_oxy_user_id" is not null
             and "retail_dispute_coordinations"."released_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "retail_return_case_lines" (
	"id" text PRIMARY KEY NOT NULL,
	"return_case_id" text NOT NULL,
	"order_item_id" text NOT NULL,
	"authorized_quantity" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "retail_return_case_lines_quantity_check" CHECK ("retail_return_case_lines"."authorized_quantity" >= 1)
);
--> statement-breakpoint
CREATE TABLE "retail_return_cases" (
	"id" text PRIMARY KEY NOT NULL,
	"request_id" text NOT NULL,
	"state" text DEFAULT 'authorization_pending' NOT NULL,
	"destination" text NOT NULL,
	"supplier_return_authorization_id" text,
	"label_source" text DEFAULT 'unavailable' NOT NULL,
	"label_reference" text,
	"instructions_key" text,
	"ship_back_deadline_at" timestamp with time zone,
	"inspection_outcome" text,
	"inspected_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "retail_return_cases_state_check" CHECK ("retail_return_cases"."state" in ('authorization_pending', 'authorization_unavailable', 'authorized', 'in_transit', 'partially_received', 'received', 'inspected', 'closed', 'cancelled')),
	CONSTRAINT "retail_return_cases_destination_check" CHECK ("retail_return_cases"."destination" in ('supplier', 'mercaria', 'manufacturer', 'other_approved')),
	CONSTRAINT "retail_return_cases_label_source_check" CHECK ("retail_return_cases"."label_source" in ('supplier_rma', 'moovo', 'unavailable')),
	CONSTRAINT "retail_return_cases_label_shape_check" CHECK (("retail_return_cases"."label_reference" is null) or ("retail_return_cases"."label_source" <> 'unavailable')),
	CONSTRAINT "retail_return_cases_rma_destination_check" CHECK ("retail_return_cases"."supplier_return_authorization_id" is null or "retail_return_cases"."destination" = 'supplier'),
	CONSTRAINT "retail_return_cases_inspection_shape_check" CHECK (("retail_return_cases"."inspected_at" is null) = ("retail_return_cases"."inspection_outcome" is null)),
	CONSTRAINT "retail_return_cases_deadline_shape_check" CHECK ("retail_return_cases"."ship_back_deadline_at" is null or "retail_return_cases"."instructions_key" is not null)
);
--> statement-breakpoint
CREATE TABLE "retail_return_line_dispositions" (
	"id" text PRIMARY KEY NOT NULL,
	"return_case_line_id" text NOT NULL,
	"disposition" text NOT NULL,
	"quantity" integer NOT NULL,
	"actor_kind" text NOT NULL,
	"actor_oxy_user_id" text,
	"actor_grant_id" text,
	"observed_at" timestamp with time zone NOT NULL,
	"idempotency_key" text NOT NULL,
	"detail" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "retail_return_line_dispositions_disposition_check" CHECK ("retail_return_line_dispositions"."disposition" in ('shipped', 'received', 'inspected', 'accepted', 'rejected', 'credited', 'lost_in_transit')),
	CONSTRAINT "retail_return_line_dispositions_actor_kind_check" CHECK ("retail_return_line_dispositions"."actor_kind" in ('oxy', 'guest', 'operator', 'system')),
	CONSTRAINT "retail_return_line_dispositions_actor_check" CHECK (("retail_return_line_dispositions"."actor_kind" = 'oxy' and "retail_return_line_dispositions"."actor_oxy_user_id" is not null and "retail_return_line_dispositions"."actor_grant_id" is null)
        or ("retail_return_line_dispositions"."actor_kind" = 'operator' and "retail_return_line_dispositions"."actor_oxy_user_id" is not null and "retail_return_line_dispositions"."actor_grant_id" is null)
        or ("retail_return_line_dispositions"."actor_kind" = 'guest' and "retail_return_line_dispositions"."actor_oxy_user_id" is null)
        or ("retail_return_line_dispositions"."actor_kind" = 'system' and "retail_return_line_dispositions"."actor_oxy_user_id" is null and "retail_return_line_dispositions"."actor_grant_id" is null)),
	CONSTRAINT "retail_return_line_dispositions_quantity_check" CHECK ("retail_return_line_dispositions"."quantity" >= 1),
	CONSTRAINT "retail_return_line_dispositions_key_check" CHECK (length(btrim("retail_return_line_dispositions"."idempotency_key")) > 0)
);
--> statement-breakpoint
CREATE TABLE "retail_service_policy_exceptions" (
	"id" text PRIMARY KEY NOT NULL,
	"market" text NOT NULL,
	"category_id" text NOT NULL,
	"excluded_kinds" text[] NOT NULL,
	"source" text NOT NULL,
	"legal_basis" text NOT NULL,
	"requested_by_oxy_user_id" text NOT NULL,
	"reviewed_by_oxy_user_id" text NOT NULL,
	"reviewed_at" timestamp with time zone NOT NULL,
	"withdrawn_at" timestamp with time zone,
	"withdrawn_by_oxy_user_id" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "retail_service_policy_exceptions_source_check" CHECK ("retail_service_policy_exceptions"."source" in ('statutory_instrument', 'mercaria_policy')),
	CONSTRAINT "retail_service_policy_exceptions_market_check" CHECK ("retail_service_policy_exceptions"."market" ~ '^[A-Z]{2}$'),
	CONSTRAINT "retail_service_policy_exceptions_kinds_check" CHECK (cardinality("retail_service_policy_exceptions"."excluded_kinds") >= 1
          and "retail_service_policy_exceptions"."excluded_kinds" <@ array['pre_acceptance_cancellation', 'pre_dispatch_cancellation', 'withdrawal_return', 'damaged_on_arrival', 'wrong_item', 'missing_item', 'defective_product', 'delivery_failure', 'return_to_sender', 'warranty_claim', 'safety_recall', 'chargeback_coordination']::text[]),
	CONSTRAINT "retail_service_policy_exceptions_basis_check" CHECK (length(btrim("retail_service_policy_exceptions"."legal_basis")) > 0),
	CONSTRAINT "retail_service_policy_exceptions_four_eyes_check" CHECK ("retail_service_policy_exceptions"."reviewed_by_oxy_user_id" <> "retail_service_policy_exceptions"."requested_by_oxy_user_id"),
	CONSTRAINT "retail_service_policy_exceptions_withdrawn_shape_check" CHECK (("retail_service_policy_exceptions"."withdrawn_at" is null) = ("retail_service_policy_exceptions"."withdrawn_by_oxy_user_id" is null))
);
--> statement-breakpoint
CREATE TABLE "retail_service_request_events" (
	"id" text PRIMARY KEY NOT NULL,
	"request_id" text NOT NULL,
	"kind" text NOT NULL,
	"resulting_state" text,
	"actor_kind" text NOT NULL,
	"actor_oxy_user_id" text,
	"actor_grant_id" text,
	"detail" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "retail_service_request_events_state_check" CHECK ("retail_service_request_events"."resulting_state" in ('submitted', 'evidence_required', 'accepted', 'rejected', 'in_progress', 'completed', 'withdrawn', 'cancelled')),
	CONSTRAINT "retail_service_request_events_actor_kind_check" CHECK ("retail_service_request_events"."actor_kind" in ('oxy', 'guest', 'operator', 'system')),
	CONSTRAINT "retail_service_request_events_actor_check" CHECK (("retail_service_request_events"."actor_kind" = 'oxy' and "retail_service_request_events"."actor_oxy_user_id" is not null and "retail_service_request_events"."actor_grant_id" is null)
        or ("retail_service_request_events"."actor_kind" = 'operator' and "retail_service_request_events"."actor_oxy_user_id" is not null and "retail_service_request_events"."actor_grant_id" is null)
        or ("retail_service_request_events"."actor_kind" = 'guest' and "retail_service_request_events"."actor_oxy_user_id" is null)
        or ("retail_service_request_events"."actor_kind" = 'system' and "retail_service_request_events"."actor_oxy_user_id" is null and "retail_service_request_events"."actor_grant_id" is null)),
	CONSTRAINT "retail_service_request_events_kind_check" CHECK (length(btrim("retail_service_request_events"."kind")) > 0),
	CONSTRAINT "retail_service_request_events_detail_check" CHECK ("retail_service_request_events"."detail" is null
          or (length("retail_service_request_events"."detail") between 1 and 1000))
);
--> statement-breakpoint
CREATE TABLE "retail_service_request_evidence" (
	"id" text PRIMARY KEY NOT NULL,
	"request_id" text NOT NULL,
	"kind" text NOT NULL,
	"file_id" text NOT NULL,
	"caption" text,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "retail_service_request_evidence_kind_check" CHECK ("retail_service_request_evidence"."kind" in ('photo', 'video', 'document', 'serial_number_photo', 'packaging_photo')),
	CONSTRAINT "retail_service_request_evidence_file_check" CHECK (length(btrim("retail_service_request_evidence"."file_id")) > 0),
	CONSTRAINT "retail_service_request_evidence_bare_id_check" CHECK ("retail_service_request_evidence"."file_id" !~ '^https?://' and "retail_service_request_evidence"."file_id" !~ 'mercaria'),
	CONSTRAINT "retail_service_request_evidence_position_check" CHECK ("retail_service_request_evidence"."position" >= 0)
);
--> statement-breakpoint
CREATE TABLE "retail_service_request_lines" (
	"id" text PRIMARY KEY NOT NULL,
	"request_id" text NOT NULL,
	"order_item_id" text NOT NULL,
	"requested_quantity" integer NOT NULL,
	"approved_quantity" integer,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "retail_service_request_lines_requested_check" CHECK ("retail_service_request_lines"."requested_quantity" >= 1),
	CONSTRAINT "retail_service_request_lines_approved_check" CHECK ("retail_service_request_lines"."approved_quantity" is null
          or ("retail_service_request_lines"."approved_quantity" >= 0 and "retail_service_request_lines"."approved_quantity" <= "retail_service_request_lines"."requested_quantity"))
);
--> statement-breakpoint
CREATE TABLE "retail_service_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"order_id" text NOT NULL,
	"kind" text NOT NULL,
	"state" text DEFAULT 'submitted' NOT NULL,
	"origin" text NOT NULL,
	"requester_kind" text NOT NULL,
	"requester_oxy_user_id" text,
	"requester_grant_id" text,
	"customer_note" text,
	"customer_terms_version" text NOT NULL,
	"policy_market" text NOT NULL,
	"statutory_deadline_at" timestamp with time zone,
	"commercial_deadline_at" timestamp with time zone,
	"supplier_response_due_at" timestamp with time zone,
	"policy_exception_id" text,
	"outcome" text,
	"outcome_note" text,
	"decided_at" timestamp with time zone,
	"decider_kind" text,
	"decider_oxy_user_id" text,
	"refund_id" text,
	"completion_failure" text,
	"completed_at" timestamp with time zone,
	"idempotency_key" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "retail_service_requests_kind_check" CHECK ("retail_service_requests"."kind" in ('pre_acceptance_cancellation', 'pre_dispatch_cancellation', 'withdrawal_return', 'damaged_on_arrival', 'wrong_item', 'missing_item', 'defective_product', 'delivery_failure', 'return_to_sender', 'warranty_claim', 'safety_recall', 'chargeback_coordination')),
	CONSTRAINT "retail_service_requests_state_check" CHECK ("retail_service_requests"."state" in ('submitted', 'evidence_required', 'accepted', 'rejected', 'in_progress', 'completed', 'withdrawn', 'cancelled')),
	CONSTRAINT "retail_service_requests_origin_check" CHECK ("retail_service_requests"."origin" in ('customer', 'operator', 'system')),
	CONSTRAINT "retail_service_requests_outcome_check" CHECK ("retail_service_requests"."outcome" in ('full_refund', 'partial_refund', 'price_reduction', 'cancellation_refund', 'replacement', 'repair', 'redelivery', 'no_remedy')),
	CONSTRAINT "retail_service_requests_failure_check" CHECK ("retail_service_requests"."completion_failure" in ('refund_path_unavailable', 'order_state_changed', 'dispute_suspension', 'remedy_not_supported', 'refund_refused')),
	CONSTRAINT "retail_service_requests_requester_kind_check" CHECK ("retail_service_requests"."requester_kind" in ('oxy', 'guest', 'operator', 'system')),
	CONSTRAINT "retail_service_requests_decider_kind_check" CHECK ("retail_service_requests"."decider_kind" in ('oxy', 'guest', 'operator', 'system')),
	CONSTRAINT "retail_service_requests_requester_check" CHECK (("retail_service_requests"."requester_kind" = 'oxy' and "retail_service_requests"."requester_oxy_user_id" is not null and "retail_service_requests"."requester_grant_id" is null)
        or ("retail_service_requests"."requester_kind" = 'operator' and "retail_service_requests"."requester_oxy_user_id" is not null and "retail_service_requests"."requester_grant_id" is null)
        or ("retail_service_requests"."requester_kind" = 'guest' and "retail_service_requests"."requester_oxy_user_id" is null)
        or ("retail_service_requests"."requester_kind" = 'system' and "retail_service_requests"."requester_oxy_user_id" is null and "retail_service_requests"."requester_grant_id" is null)),
	CONSTRAINT "retail_service_requests_decision_shape_check" CHECK (("retail_service_requests"."decided_at" is null) = ("retail_service_requests"."decider_kind" is null)
          and ("retail_service_requests"."decided_at" is null) = ("retail_service_requests"."outcome" is null)
          and ("retail_service_requests"."decider_kind" <> 'guest' or "retail_service_requests"."decider_kind" is null)),
	CONSTRAINT "retail_service_requests_decider_authority_check" CHECK ("retail_service_requests"."decider_kind" is null or "retail_service_requests"."decider_kind" in ('oxy', 'operator', 'system')),
	CONSTRAINT "retail_service_requests_decider_identity_check" CHECK (("retail_service_requests"."decider_kind" in ('oxy', 'operator')) = ("retail_service_requests"."decider_oxy_user_id" is not null)),
	CONSTRAINT "retail_service_requests_market_check" CHECK ("retail_service_requests"."policy_market" ~ '^[A-Z]{2}$'),
	CONSTRAINT "retail_service_requests_terms_check" CHECK (length(btrim("retail_service_requests"."customer_terms_version")) > 0),
	CONSTRAINT "retail_service_requests_note_check" CHECK ("retail_service_requests"."customer_note" is null
          or (length("retail_service_requests"."customer_note") between 1 and 1000)),
	CONSTRAINT "retail_service_requests_outcome_note_check" CHECK ("retail_service_requests"."outcome_note" is null
          or (length("retail_service_requests"."outcome_note") between 1 and 1000)),
	CONSTRAINT "retail_service_requests_refund_shape_check" CHECK ("retail_service_requests"."refund_id" is null or "retail_service_requests"."outcome" is not null),
	CONSTRAINT "retail_service_requests_completed_shape_check" CHECK (("retail_service_requests"."completed_at" is null)
          = ("retail_service_requests"."state" not in ('completed', 'rejected', 'withdrawn', 'cancelled')))
);
--> statement-breakpoint
CREATE TABLE "retail_warranty_cases" (
	"id" text PRIMARY KEY NOT NULL,
	"request_id" text NOT NULL,
	"state" text DEFAULT 'reported' NOT NULL,
	"basis" text NOT NULL,
	"path" text NOT NULL,
	"reported_at" timestamp with time zone NOT NULL,
	"guarantee_market" text NOT NULL,
	"guarantee_months" integer NOT NULL,
	"guarantee_expires_at" timestamp with time zone NOT NULL,
	"serial_number" text,
	"lot_number" text,
	"instructions_key" text,
	"supplier_response" text,
	"supplier_responded_at" timestamp with time zone,
	"customer_deadline_at" timestamp with time zone,
	"replacement_purchase_order_id" text,
	"repeat_failure_count" integer DEFAULT 0 NOT NULL,
	"safety_escalated_at" timestamp with time zone,
	"safety_escalation_reason" text,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "retail_warranty_cases_state_check" CHECK ("retail_warranty_cases"."state" in ('reported', 'assessing', 'awaiting_item', 'in_repair', 'resolved', 'rejected', 'escalated_safety')),
	CONSTRAINT "retail_warranty_cases_basis_check" CHECK ("retail_warranty_cases"."basis" in ('legal_guarantee', 'commercial_warranty')),
	CONSTRAINT "retail_warranty_cases_path_check" CHECK ("retail_warranty_cases"."path" in ('mercaria', 'supplier', 'manufacturer')),
	CONSTRAINT "retail_warranty_cases_market_check" CHECK ("retail_warranty_cases"."guarantee_market" ~ '^[A-Z]{2}$'),
	CONSTRAINT "retail_warranty_cases_months_check" CHECK ("retail_warranty_cases"."guarantee_months" >= 1),
	CONSTRAINT "retail_warranty_cases_expiry_check" CHECK ("retail_warranty_cases"."guarantee_expires_at" > "retail_warranty_cases"."reported_at"),
	CONSTRAINT "retail_warranty_cases_repeat_check" CHECK ("retail_warranty_cases"."repeat_failure_count" >= 0),
	CONSTRAINT "retail_warranty_cases_supplier_response_shape_check" CHECK (("retail_warranty_cases"."supplier_response" is null) = ("retail_warranty_cases"."supplier_responded_at" is null)),
	CONSTRAINT "retail_warranty_cases_safety_shape_check" CHECK (("retail_warranty_cases"."safety_escalated_at" is null) = ("retail_warranty_cases"."safety_escalation_reason" is null)
          and ("retail_warranty_cases"."safety_escalated_at" is null or "retail_warranty_cases"."state" = 'escalated_safety'))
);
--> statement-breakpoint
CREATE TABLE "supplier_recoveries" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"state" text DEFAULT 'claimed' NOT NULL,
	"purchase_order_id" text NOT NULL,
	"supplier_return_authorization_id" text,
	"service_request_id" text,
	"expected_amount" bigint,
	"expected_currency" text,
	"credited_amount" bigint,
	"credited_currency" text,
	"credit_note_reference" text,
	"rejection_reason" text,
	"opened_at" timestamp with time zone NOT NULL,
	"closed_at" timestamp with time zone,
	"idempotency_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "supplier_recoveries_kind_check" CHECK ("supplier_recoveries"."kind" in ('cancelled_order_refund', 'return_credit', 'defect_allowance', 'lost_parcel_claim', 'shipping_refund', 'warranty_reimbursement', 'replacement_at_no_charge', 'partial_credit', 'rejected_claim', 'credit_note')),
	CONSTRAINT "supplier_recoveries_state_check" CHECK ("supplier_recoveries"."state" in ('claimed', 'acknowledged', 'accepted', 'rejected', 'credited', 'settled', 'abandoned')),
	CONSTRAINT "supplier_recoveries_expected_currency_check" CHECK ("supplier_recoveries"."expected_currency" in ('FAIR', 'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF', 'CNY', 'SEK', 'NOK', 'DKK', 'PLN', 'MXN', 'BRL', 'INR', 'NZD', 'ZAR', 'SGD', 'HKD', 'AED')),
	CONSTRAINT "supplier_recoveries_credited_currency_check" CHECK ("supplier_recoveries"."credited_currency" in ('FAIR', 'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF', 'CNY', 'SEK', 'NOK', 'DKK', 'PLN', 'MXN', 'BRL', 'INR', 'NZD', 'ZAR', 'SGD', 'HKD', 'AED')),
	CONSTRAINT "supplier_recoveries_amounts_check" CHECK (("supplier_recoveries"."expected_amount" is null or "supplier_recoveries"."expected_amount" >= 0)
          and ("supplier_recoveries"."credited_amount" is null or "supplier_recoveries"."credited_amount" >= 0)),
	CONSTRAINT "supplier_recoveries_money_pair_check" CHECK (("supplier_recoveries"."expected_amount" is null) = ("supplier_recoveries"."expected_currency" is null)
          and ("supplier_recoveries"."credited_amount" is null) = ("supplier_recoveries"."credited_currency" is null)),
	CONSTRAINT "supplier_recoveries_credited_shape_check" CHECK ("supplier_recoveries"."state" not in ('credited', 'settled') or "supplier_recoveries"."credited_amount" is not null),
	CONSTRAINT "supplier_recoveries_rejection_shape_check" CHECK (("supplier_recoveries"."state" = 'rejected') = ("supplier_recoveries"."rejection_reason" is not null)),
	CONSTRAINT "supplier_recoveries_closed_shape_check" CHECK (("supplier_recoveries"."closed_at" is null)
          = ("supplier_recoveries"."state" not in ('settled', 'rejected', 'abandoned'))),
	CONSTRAINT "supplier_recoveries_key_check" CHECK (length(btrim("supplier_recoveries"."idempotency_key")) > 0),
	CONSTRAINT "supplier_recoveries_rejected_kind_check" CHECK ("supplier_recoveries"."kind" <> 'rejected_claim' or "supplier_recoveries"."credited_amount" is null)
);
--> statement-breakpoint
CREATE TABLE "supplier_return_authorizations" (
	"id" text PRIMARY KEY NOT NULL,
	"purchase_order_id" text NOT NULL,
	"state" text DEFAULT 'requested' NOT NULL,
	"provider_reference" text,
	"reason_code" text NOT NULL,
	"supplier_deadline_at" timestamp with time zone,
	"unavailable_reason" text,
	"requested_at" timestamp with time zone NOT NULL,
	"authorized_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"idempotency_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "supplier_return_authorizations_state_check" CHECK ("supplier_return_authorizations"."state" in ('requested', 'authorized', 'rejected', 'received', 'closed')),
	CONSTRAINT "supplier_return_authorizations_reason_check" CHECK (length(btrim("supplier_return_authorizations"."reason_code")) > 0),
	CONSTRAINT "supplier_return_authorizations_key_check" CHECK (length(btrim("supplier_return_authorizations"."idempotency_key")) > 0),
	CONSTRAINT "supplier_return_authorizations_authorized_shape_check" CHECK (("supplier_return_authorizations"."state" = 'authorized' or "supplier_return_authorizations"."state" = 'received' or "supplier_return_authorizations"."state" = 'closed')
          = ("supplier_return_authorizations"."authorized_at" is not null)),
	CONSTRAINT "supplier_return_authorizations_unavailable_shape_check" CHECK ("supplier_return_authorizations"."unavailable_reason" is null or "supplier_return_authorizations"."authorized_at" is null)
);
--> statement-breakpoint
ALTER TABLE "guest_portal_messages" DROP CONSTRAINT "guest_portal_messages_kind_check";--> statement-breakpoint
ALTER TABLE "retail_dispute_coordinations" ADD CONSTRAINT "retail_dispute_coordinations_dispute_id_disputes_id_fk" FOREIGN KEY ("dispute_id") REFERENCES "public"."disputes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retail_dispute_coordinations" ADD CONSTRAINT "retail_dispute_coordinations_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retail_dispute_coordinations" ADD CONSTRAINT "retail_dispute_coordinations_service_request_id_retail_service_requests_id_fk" FOREIGN KEY ("service_request_id") REFERENCES "public"."retail_service_requests"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retail_return_case_lines" ADD CONSTRAINT "retail_return_case_lines_return_case_id_retail_return_cases_id_fk" FOREIGN KEY ("return_case_id") REFERENCES "public"."retail_return_cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retail_return_case_lines" ADD CONSTRAINT "retail_return_case_lines_order_item_id_order_items_id_fk" FOREIGN KEY ("order_item_id") REFERENCES "public"."order_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retail_return_cases" ADD CONSTRAINT "retail_return_cases_request_id_retail_service_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."retail_service_requests"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retail_return_cases" ADD CONSTRAINT "retail_return_cases_supplier_return_authorization_id_supplier_return_authorizations_id_fk" FOREIGN KEY ("supplier_return_authorization_id") REFERENCES "public"."supplier_return_authorizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retail_return_line_dispositions" ADD CONSTRAINT "retail_return_line_dispositions_return_case_line_id_retail_return_case_lines_id_fk" FOREIGN KEY ("return_case_line_id") REFERENCES "public"."retail_return_case_lines"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retail_return_line_dispositions" ADD CONSTRAINT "retail_return_line_dispositions_actor_grant_id_guest_order_access_grants_id_fk" FOREIGN KEY ("actor_grant_id") REFERENCES "public"."guest_order_access_grants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retail_service_policy_exceptions" ADD CONSTRAINT "retail_service_policy_exceptions_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retail_service_request_events" ADD CONSTRAINT "retail_service_request_events_request_id_retail_service_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."retail_service_requests"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retail_service_request_events" ADD CONSTRAINT "retail_service_request_events_actor_grant_id_guest_order_access_grants_id_fk" FOREIGN KEY ("actor_grant_id") REFERENCES "public"."guest_order_access_grants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retail_service_request_evidence" ADD CONSTRAINT "retail_service_request_evidence_request_id_retail_service_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."retail_service_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retail_service_request_lines" ADD CONSTRAINT "retail_service_request_lines_request_id_retail_service_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."retail_service_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retail_service_request_lines" ADD CONSTRAINT "retail_service_request_lines_order_item_id_order_items_id_fk" FOREIGN KEY ("order_item_id") REFERENCES "public"."order_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retail_service_requests" ADD CONSTRAINT "retail_service_requests_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retail_service_requests" ADD CONSTRAINT "retail_service_requests_requester_grant_id_guest_order_access_grants_id_fk" FOREIGN KEY ("requester_grant_id") REFERENCES "public"."guest_order_access_grants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retail_service_requests" ADD CONSTRAINT "retail_service_requests_policy_exception_id_retail_service_policy_exceptions_id_fk" FOREIGN KEY ("policy_exception_id") REFERENCES "public"."retail_service_policy_exceptions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retail_service_requests" ADD CONSTRAINT "retail_service_requests_refund_id_refunds_id_fk" FOREIGN KEY ("refund_id") REFERENCES "public"."refunds"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retail_warranty_cases" ADD CONSTRAINT "retail_warranty_cases_request_id_retail_service_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."retail_service_requests"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retail_warranty_cases" ADD CONSTRAINT "retail_warranty_cases_replacement_purchase_order_id_purchase_orders_id_fk" FOREIGN KEY ("replacement_purchase_order_id") REFERENCES "public"."purchase_orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_recoveries" ADD CONSTRAINT "supplier_recoveries_purchase_order_id_purchase_orders_id_fk" FOREIGN KEY ("purchase_order_id") REFERENCES "public"."purchase_orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_recoveries" ADD CONSTRAINT "supplier_recoveries_supplier_return_authorization_id_supplier_return_authorizations_id_fk" FOREIGN KEY ("supplier_return_authorization_id") REFERENCES "public"."supplier_return_authorizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_recoveries" ADD CONSTRAINT "supplier_recoveries_service_request_id_retail_service_requests_id_fk" FOREIGN KEY ("service_request_id") REFERENCES "public"."retail_service_requests"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_return_authorizations" ADD CONSTRAINT "supplier_return_authorizations_purchase_order_id_purchase_orders_id_fk" FOREIGN KEY ("purchase_order_id") REFERENCES "public"."purchase_orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "retail_dispute_coordinations_dispute_key" ON "retail_dispute_coordinations" USING btree ("dispute_id");--> statement-breakpoint
CREATE INDEX "retail_dispute_coordinations_suspended_idx" ON "retail_dispute_coordinations" USING btree ("order_id") WHERE "retail_dispute_coordinations"."suspension" = 'suspended';--> statement-breakpoint
CREATE UNIQUE INDEX "retail_return_case_lines_case_item_key" ON "retail_return_case_lines" USING btree ("return_case_id","order_item_id");--> statement-breakpoint
CREATE INDEX "retail_return_case_lines_item_idx" ON "retail_return_case_lines" USING btree ("order_item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "retail_return_cases_request_key" ON "retail_return_cases" USING btree ("request_id");--> statement-breakpoint
CREATE INDEX "retail_return_cases_open_idx" ON "retail_return_cases" USING btree ("created_at") WHERE "retail_return_cases"."closed_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "retail_return_line_dispositions_key" ON "retail_return_line_dispositions" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "retail_return_line_dispositions_line_idx" ON "retail_return_line_dispositions" USING btree ("return_case_line_id","observed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "retail_service_policy_exceptions_live_key" ON "retail_service_policy_exceptions" USING btree ("market","category_id") WHERE "retail_service_policy_exceptions"."withdrawn_at" is null;--> statement-breakpoint
CREATE INDEX "retail_service_policy_exceptions_category_idx" ON "retail_service_policy_exceptions" USING btree ("category_id");--> statement-breakpoint
CREATE INDEX "retail_service_request_events_request_idx" ON "retail_service_request_events" USING btree ("request_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "retail_service_request_evidence_file_key" ON "retail_service_request_evidence" USING btree ("request_id","file_id");--> statement-breakpoint
CREATE INDEX "retail_service_request_evidence_request_idx" ON "retail_service_request_evidence" USING btree ("request_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "retail_service_request_lines_request_item_key" ON "retail_service_request_lines" USING btree ("request_id","order_item_id");--> statement-breakpoint
CREATE INDEX "retail_service_request_lines_item_idx" ON "retail_service_request_lines" USING btree ("order_item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "retail_service_requests_open_order_kind_key" ON "retail_service_requests" USING btree ("order_id","kind") WHERE state in ('submitted', 'evidence_required', 'accepted', 'in_progress');--> statement-breakpoint
CREATE UNIQUE INDEX "retail_service_requests_idempotency_key" ON "retail_service_requests" USING btree ("idempotency_key") WHERE "retail_service_requests"."idempotency_key" is not null;--> statement-breakpoint
CREATE INDEX "retail_service_requests_order_idx" ON "retail_service_requests" USING btree ("order_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "retail_service_requests_open_idx" ON "retail_service_requests" USING btree ("created_at") WHERE state in ('submitted', 'evidence_required', 'accepted', 'in_progress');--> statement-breakpoint
CREATE INDEX "retail_service_requests_settling_idx" ON "retail_service_requests" USING btree ("updated_at") WHERE "retail_service_requests"."refund_id" is not null and "retail_service_requests"."state" = 'in_progress';--> statement-breakpoint
CREATE UNIQUE INDEX "retail_warranty_cases_request_key" ON "retail_warranty_cases" USING btree ("request_id");--> statement-breakpoint
CREATE INDEX "retail_warranty_cases_open_idx" ON "retail_warranty_cases" USING btree ("reported_at") WHERE "retail_warranty_cases"."resolved_at" is null;--> statement-breakpoint
CREATE INDEX "retail_warranty_cases_safety_idx" ON "retail_warranty_cases" USING btree ("safety_escalated_at" DESC NULLS LAST) WHERE "retail_warranty_cases"."safety_escalated_at" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "supplier_recoveries_key" ON "supplier_recoveries" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "supplier_recoveries_po_idx" ON "supplier_recoveries" USING btree ("purchase_order_id","opened_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "supplier_recoveries_request_idx" ON "supplier_recoveries" USING btree ("service_request_id") WHERE "supplier_recoveries"."service_request_id" is not null;--> statement-breakpoint
CREATE INDEX "supplier_recoveries_open_idx" ON "supplier_recoveries" USING btree ("opened_at") WHERE "supplier_recoveries"."closed_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "supplier_return_authorizations_key" ON "supplier_return_authorizations" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "supplier_return_authorizations_po_idx" ON "supplier_return_authorizations" USING btree ("purchase_order_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "supplier_return_authorizations_open_idx" ON "supplier_return_authorizations" USING btree ("requested_at") WHERE "supplier_return_authorizations"."closed_at" is null;--> statement-breakpoint
ALTER TABLE "guest_portal_messages" ADD CONSTRAINT "guest_portal_messages_kind_check" CHECK ("guest_portal_messages"."kind" in ('order_confirmation', 'payment_pending', 'payment_failed', 'payment_delayed_success', 'order_processing', 'order_shipped', 'tracking_updated', 'order_ready_for_pickup', 'order_delivered', 'order_cancelled', 'refund_pending', 'refund_completed', 'refund_failed', 'cancellation_request_received', 'cancellation_request_approved', 'cancellation_request_rejected', 'return_request_received', 'return_request_updated', 'support_response_available', 'buyer_action_required', 'claim_completed', 'access_link_recovery', 'access_link_step_up', 'access_security_notice', 'retail_service_request_received', 'retail_cancellation_updated', 'retail_return_authorized', 'retail_return_updated', 'retail_warranty_updated', 'retail_service_delayed', 'retail_safety_notice', 'retail_service_request_closed'));

--> statement-breakpoint
-- BEGIN #127 hand-written triggers
CREATE OR REPLACE FUNCTION mercaria_retail_service_events_append_only()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'retail_service_request_events is append-only (%)', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER mercaria_retail_service_events_append_only
BEFORE UPDATE OR DELETE ON "retail_service_request_events"
FOR EACH ROW EXECUTE FUNCTION mercaria_retail_service_events_append_only();--> statement-breakpoint

CREATE OR REPLACE FUNCTION mercaria_retail_return_dispositions_append_only()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'retail_return_line_dispositions is append-only (%)', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER mercaria_retail_return_dispositions_append_only
BEFORE UPDATE OR DELETE ON "retail_return_line_dispositions"
FOR EACH ROW EXECUTE FUNCTION mercaria_retail_return_dispositions_append_only();--> statement-breakpoint

CREATE OR REPLACE FUNCTION mercaria_retail_request_lines_frozen()
RETURNS trigger AS $$
BEGIN
  IF NEW."request_id" IS DISTINCT FROM OLD."request_id"
     OR NEW."order_item_id" IS DISTINCT FROM OLD."order_item_id"
     OR NEW."requested_quantity" IS DISTINCT FROM OLD."requested_quantity" THEN
    RAISE EXCEPTION 'a retail service request line is frozen; only approved_quantity may move'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER mercaria_retail_request_lines_frozen
BEFORE UPDATE ON "retail_service_request_lines"
FOR EACH ROW EXECUTE FUNCTION mercaria_retail_request_lines_frozen();--> statement-breakpoint

CREATE OR REPLACE FUNCTION mercaria_retail_return_case_lines_frozen()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'a retail return case line is frozen once authorized'
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER mercaria_retail_return_case_lines_frozen
BEFORE UPDATE ON "retail_return_case_lines"
FOR EACH ROW EXECUTE FUNCTION mercaria_retail_return_case_lines_frozen();--> statement-breakpoint

CREATE OR REPLACE FUNCTION mercaria_retail_policy_exception_immutable()
RETURNS trigger AS $$
BEGIN
  IF NEW."market" IS DISTINCT FROM OLD."market"
     OR NEW."category_id" IS DISTINCT FROM OLD."category_id"
     OR NEW."excluded_kinds" IS DISTINCT FROM OLD."excluded_kinds"
     OR NEW."source" IS DISTINCT FROM OLD."source"
     OR NEW."legal_basis" IS DISTINCT FROM OLD."legal_basis"
     OR NEW."requested_by_oxy_user_id" IS DISTINCT FROM OLD."requested_by_oxy_user_id"
     OR NEW."reviewed_by_oxy_user_id" IS DISTINCT FROM OLD."reviewed_by_oxy_user_id"
     OR NEW."reviewed_at" IS DISTINCT FROM OLD."reviewed_at" THEN
    RAISE EXCEPTION 'a published retail policy exception is immutable; withdraw it instead'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD."withdrawn_at" IS NOT NULL AND NEW."withdrawn_at" IS DISTINCT FROM OLD."withdrawn_at" THEN
    RAISE EXCEPTION 'a withdrawn retail policy exception cannot be re-withdrawn or revived'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER mercaria_retail_policy_exception_immutable
BEFORE UPDATE ON "retail_service_policy_exceptions"
FOR EACH ROW EXECUTE FUNCTION mercaria_retail_policy_exception_immutable();--> statement-breakpoint

CREATE OR REPLACE FUNCTION mercaria_retail_service_request_frozen()
RETURNS trigger AS $$
BEGIN
  IF NEW."order_id" IS DISTINCT FROM OLD."order_id"
     OR NEW."kind" IS DISTINCT FROM OLD."kind"
     OR NEW."origin" IS DISTINCT FROM OLD."origin"
     OR NEW."requester_kind" IS DISTINCT FROM OLD."requester_kind"
     OR NEW."requester_oxy_user_id" IS DISTINCT FROM OLD."requester_oxy_user_id"
     OR NEW."customer_terms_version" IS DISTINCT FROM OLD."customer_terms_version"
     OR NEW."policy_market" IS DISTINCT FROM OLD."policy_market"
     OR NEW."statutory_deadline_at" IS DISTINCT FROM OLD."statutory_deadline_at"
     OR NEW."commercial_deadline_at" IS DISTINCT FROM OLD."commercial_deadline_at" THEN
    RAISE EXCEPTION 'a retail service request freezes its order, kind, requester and policy snapshot'
      USING ERRCODE = 'restrict_violation';
  END IF;
  -- NULL -> value is a decision; value -> value would be a silent re-decision of
  -- a remedy the buyer was already told about. Re-deciding is a NEW request.
  IF OLD."outcome" IS NOT NULL AND NEW."outcome" IS DISTINCT FROM OLD."outcome" THEN
    RAISE EXCEPTION 'a retail service request outcome cannot be re-decided'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER mercaria_retail_service_request_frozen
BEFORE UPDATE ON "retail_service_requests"
FOR EACH ROW EXECUTE FUNCTION mercaria_retail_service_request_frozen();
-- END #127 hand-written triggers
