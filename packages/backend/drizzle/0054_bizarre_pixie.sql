-- oxy:deploy-phase=pre
-- oxy:rollback=restore: guest_portal_messages_kind_check is widened for a new message kind; the previous form is in the #108 migration and re-adding it fails against any queued message of the added kind
--
-- Buyer post-purchase requests (#110): cancellations, returns and support.
--
-- Purely ADDITIVE. Eight new tables, and one WIDENING of
-- `guest_portal_messages_kind_check` for the seven message kinds #110 adds —
-- a drop-and-re-add whose new tuple is a strict superset of the old, so the
-- serving image's writes all still pass.
--
-- HAND-WRITTEN STATEMENTS BELOW THE GENERATED BLOCK. `db:generate` DROPS them
-- on a regeneration; re-apply them at the END of the file and confirm with:
--
--   grep -c '^CREATE TRIGGER'            drizzle/0054_*.sql   # 5
--   grep -c '^CREATE OR REPLACE FUNCTION' drizzle/0054_*.sql   # 4
--   grep -c '^-- oxy:deploy-phase'        drizzle/0054_*.sql   # 1
--

CREATE TABLE "buyer_request_events" (
	"id" text PRIMARY KEY NOT NULL,
	"cancellation_request_id" text,
	"return_request_id" text,
	"kind" text NOT NULL,
	"actor_kind" text NOT NULL,
	"actor_oxy_user_id" text,
	"actor_grant_id" text,
	"detail" text,
	"at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "buyer_request_events_kind_check" CHECK ("buyer_request_events"."kind" in ('submitted', 'withdrawn', 'accepted', 'rejected', 'instructions_issued', 'item_received', 'refund_committed', 'refund_settled', 'completed', 'cancelled', 'completion_failed', 'decision_refused')),
	CONSTRAINT "buyer_request_events_actor_kind_check" CHECK ("buyer_request_events"."actor_kind" in ('oxy', 'guest', 'operator', 'system')),
	CONSTRAINT "buyer_request_events_actor_shape_check" CHECK (("buyer_request_events"."actor_kind" = 'oxy' and "buyer_request_events"."actor_oxy_user_id" is not null and "buyer_request_events"."actor_grant_id" is null)
        or ("buyer_request_events"."actor_kind" = 'operator' and "buyer_request_events"."actor_oxy_user_id" is not null and "buyer_request_events"."actor_grant_id" is null)
        or ("buyer_request_events"."actor_kind" = 'guest' and "buyer_request_events"."actor_oxy_user_id" is null)
        or ("buyer_request_events"."actor_kind" = 'system' and "buyer_request_events"."actor_oxy_user_id" is null and "buyer_request_events"."actor_grant_id" is null)),
	CONSTRAINT "buyer_request_events_subject_check" CHECK (num_nonnulls("buyer_request_events"."cancellation_request_id", "buyer_request_events"."return_request_id") = 1),
	CONSTRAINT "buyer_request_events_detail_length_check" CHECK ("buyer_request_events"."detail" is null or length("buyer_request_events"."detail") <= 120)
);
--> statement-breakpoint
CREATE TABLE "cancellation_request_lines" (
	"id" text PRIMARY KEY NOT NULL,
	"request_id" text NOT NULL,
	"variant_id" text NOT NULL,
	"requested_quantity" integer NOT NULL,
	"approved_quantity" integer,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "cancellation_request_lines_requested_quantity_check" CHECK ("cancellation_request_lines"."requested_quantity" >= 1),
	CONSTRAINT "cancellation_request_lines_approved_quantity_check" CHECK ("cancellation_request_lines"."approved_quantity" is null
          or ("cancellation_request_lines"."approved_quantity" >= 0 and "cancellation_request_lines"."approved_quantity" <= "cancellation_request_lines"."requested_quantity"))
);
--> statement-breakpoint
CREATE TABLE "cancellation_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"order_id" text NOT NULL,
	"state" text DEFAULT 'submitted' NOT NULL,
	"reason" text NOT NULL,
	"note" text,
	"completion_mode" text NOT NULL,
	"whole_order" boolean DEFAULT true NOT NULL,
	"requested_by_actor_kind" text NOT NULL,
	"requested_by_oxy_user_id" text,
	"requested_by_grant_id" text,
	"decided_by_actor_kind" text,
	"decided_by_oxy_user_id" text,
	"decided_at" timestamp with time zone,
	"decision_note" text,
	"refund_id" text,
	"completed_at" timestamp with time zone,
	"completion_failure" text,
	"idempotency_key" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "cancellation_requests_state_check" CHECK ("cancellation_requests"."state" in ('submitted', 'accepted', 'rejected', 'withdrawn', 'completed')),
	CONSTRAINT "cancellation_requests_reason_check" CHECK ("cancellation_requests"."reason" in ('ordered_by_mistake', 'found_better_price', 'changed_my_mind', 'delivery_too_slow', 'wrong_item_selected', 'wrong_delivery_details', 'no_longer_needed', 'other')),
	CONSTRAINT "cancellation_requests_completion_mode_check" CHECK ("cancellation_requests"."completion_mode" in ('release', 'refund')),
	CONSTRAINT "cancellation_requests_requested_actor_check" CHECK ("cancellation_requests"."requested_by_actor_kind" in ('oxy', 'guest', 'operator', 'system')),
	CONSTRAINT "cancellation_requests_decided_actor_check" CHECK ("cancellation_requests"."decided_by_actor_kind" in ('oxy', 'guest', 'operator', 'system')),
	CONSTRAINT "cancellation_requests_completion_failure_check" CHECK ("cancellation_requests"."completion_failure" in ('order_state_changed', 'refund_refused', 'refund_path_unavailable', 'unexpected_error')),
	CONSTRAINT "cancellation_requests_requester_shape_check" CHECK (("cancellation_requests"."requested_by_actor_kind" = 'oxy' and "cancellation_requests"."requested_by_oxy_user_id" is not null and "cancellation_requests"."requested_by_grant_id" is null)
        or ("cancellation_requests"."requested_by_actor_kind" = 'operator' and "cancellation_requests"."requested_by_oxy_user_id" is not null and "cancellation_requests"."requested_by_grant_id" is null)
        or ("cancellation_requests"."requested_by_actor_kind" = 'guest' and "cancellation_requests"."requested_by_oxy_user_id" is null)
        or ("cancellation_requests"."requested_by_actor_kind" = 'system' and "cancellation_requests"."requested_by_oxy_user_id" is null and "cancellation_requests"."requested_by_grant_id" is null)),
	CONSTRAINT "cancellation_requests_decider_shape_check" CHECK ("cancellation_requests"."decided_by_actor_kind" is null
          or ("cancellation_requests"."decided_by_actor_kind" in ('oxy', 'operator') and "cancellation_requests"."decided_by_oxy_user_id" is not null)),
	CONSTRAINT "cancellation_requests_decision_complete_check" CHECK (num_nonnulls("cancellation_requests"."decided_by_actor_kind", "cancellation_requests"."decided_by_oxy_user_id", "cancellation_requests"."decided_at") in (0, 3)),
	CONSTRAINT "cancellation_requests_decided_state_check" CHECK (("cancellation_requests"."state" in ('accepted', 'rejected', 'completed')) = ("cancellation_requests"."decided_at" is not null)),
	CONSTRAINT "cancellation_requests_rejection_note_check" CHECK (("cancellation_requests"."state" = 'rejected') = ("cancellation_requests"."decision_note" is not null)),
	CONSTRAINT "cancellation_requests_completed_at_check" CHECK (("cancellation_requests"."state" = 'completed') = ("cancellation_requests"."completed_at" is not null)),
	CONSTRAINT "cancellation_requests_completion_failure_state_check" CHECK ("cancellation_requests"."completion_failure" is null or "cancellation_requests"."state" = 'accepted'),
	CONSTRAINT "cancellation_requests_refund_mode_check" CHECK ("cancellation_requests"."refund_id" is null or "cancellation_requests"."completion_mode" = 'refund'),
	CONSTRAINT "cancellation_requests_note_length_check" CHECK ("cancellation_requests"."note" is null or length("cancellation_requests"."note") <= 1000),
	CONSTRAINT "cancellation_requests_decision_note_length_check" CHECK ("cancellation_requests"."decision_note" is null
          or (length(btrim("cancellation_requests"."decision_note")) >= 3
              and length("cancellation_requests"."decision_note") <= 1000))
);
--> statement-breakpoint
CREATE TABLE "return_request_evidence" (
	"id" text PRIMARY KEY NOT NULL,
	"request_id" text NOT NULL,
	"file_id" text NOT NULL,
	"kind" text NOT NULL,
	"position" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "return_request_evidence_kind_check" CHECK ("return_request_evidence"."kind" in ('damage_photo', 'packaging_photo', 'item_photo', 'label_photo', 'other_photo')),
	CONSTRAINT "return_request_evidence_position_check" CHECK ("return_request_evidence"."position" >= 0)
);
--> statement-breakpoint
CREATE TABLE "return_request_lines" (
	"id" text PRIMARY KEY NOT NULL,
	"request_id" text NOT NULL,
	"variant_id" text NOT NULL,
	"requested_quantity" integer NOT NULL,
	"approved_quantity" integer,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "return_request_lines_requested_quantity_check" CHECK ("return_request_lines"."requested_quantity" >= 1),
	CONSTRAINT "return_request_lines_approved_quantity_check" CHECK ("return_request_lines"."approved_quantity" is null
          or ("return_request_lines"."approved_quantity" >= 0 and "return_request_lines"."approved_quantity" <= "return_request_lines"."requested_quantity"))
);
--> statement-breakpoint
CREATE TABLE "return_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"order_id" text NOT NULL,
	"state" text DEFAULT 'requested' NOT NULL,
	"reason" text NOT NULL,
	"resolution" text NOT NULL,
	"note" text,
	"requested_by_actor_kind" text NOT NULL,
	"requested_by_oxy_user_id" text,
	"requested_by_grant_id" text,
	"decided_by_actor_kind" text,
	"decided_by_oxy_user_id" text,
	"decided_at" timestamp with time zone,
	"decision_note" text,
	"return_instructions" text,
	"return_window_ends_at" timestamp with time zone NOT NULL,
	"ship_back_deadline_at" timestamp with time zone,
	"received_at" timestamp with time zone,
	"refund_id" text,
	"completed_at" timestamp with time zone,
	"completion_failure" text,
	"idempotency_key" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "return_requests_state_check" CHECK ("return_requests"."state" in ('requested', 'approved', 'awaiting_item', 'received', 'refund_pending', 'completed', 'rejected', 'withdrawn', 'cancelled')),
	CONSTRAINT "return_requests_reason_check" CHECK ("return_requests"."reason" in ('arrived_damaged', 'arrived_faulty', 'wrong_item_sent', 'not_as_described', 'missing_parts', 'wrong_size_or_fit', 'changed_my_mind', 'arrived_late', 'other')),
	CONSTRAINT "return_requests_resolution_check" CHECK ("return_requests"."resolution" in ('refund', 'replacement')),
	CONSTRAINT "return_requests_requested_actor_check" CHECK ("return_requests"."requested_by_actor_kind" in ('oxy', 'guest', 'operator', 'system')),
	CONSTRAINT "return_requests_decided_actor_check" CHECK ("return_requests"."decided_by_actor_kind" in ('oxy', 'guest', 'operator', 'system')),
	CONSTRAINT "return_requests_completion_failure_check" CHECK ("return_requests"."completion_failure" in ('order_state_changed', 'refund_refused', 'refund_path_unavailable', 'unexpected_error')),
	CONSTRAINT "return_requests_requester_shape_check" CHECK (("return_requests"."requested_by_actor_kind" = 'oxy' and "return_requests"."requested_by_oxy_user_id" is not null and "return_requests"."requested_by_grant_id" is null)
        or ("return_requests"."requested_by_actor_kind" = 'operator' and "return_requests"."requested_by_oxy_user_id" is not null and "return_requests"."requested_by_grant_id" is null)
        or ("return_requests"."requested_by_actor_kind" = 'guest' and "return_requests"."requested_by_oxy_user_id" is null)
        or ("return_requests"."requested_by_actor_kind" = 'system' and "return_requests"."requested_by_oxy_user_id" is null and "return_requests"."requested_by_grant_id" is null)),
	CONSTRAINT "return_requests_decider_shape_check" CHECK ("return_requests"."decided_by_actor_kind" is null
          or ("return_requests"."decided_by_actor_kind" in ('oxy', 'operator') and "return_requests"."decided_by_oxy_user_id" is not null)),
	CONSTRAINT "return_requests_decision_complete_check" CHECK (num_nonnulls("return_requests"."decided_by_actor_kind", "return_requests"."decided_by_oxy_user_id", "return_requests"."decided_at") in (0, 3)),
	CONSTRAINT "return_requests_decided_state_check" CHECK (("return_requests"."state" in ('approved', 'awaiting_item', 'received', 'refund_pending',
                          'completed', 'rejected', 'cancelled'))
          = ("return_requests"."decided_at" is not null)),
	CONSTRAINT "return_requests_rejection_note_check" CHECK ("return_requests"."decision_note" is null or "return_requests"."state" in ('rejected', 'cancelled')),
	CONSTRAINT "return_requests_rejected_requires_note_check" CHECK ("return_requests"."state" <> 'rejected' or "return_requests"."decision_note" is not null),
	CONSTRAINT "return_requests_instructions_state_check" CHECK ("return_requests"."return_instructions" is null
          or "return_requests"."state" in ('awaiting_item', 'received', 'refund_pending', 'completed', 'cancelled')),
	CONSTRAINT "return_requests_ship_back_deadline_check" CHECK ("return_requests"."ship_back_deadline_at" is null or "return_requests"."return_instructions" is not null),
	CONSTRAINT "return_requests_received_state_check" CHECK (("return_requests"."state" in ('received', 'refund_pending', 'completed')) = ("return_requests"."received_at" is not null)),
	CONSTRAINT "return_requests_refund_state_check" CHECK ("return_requests"."refund_id" is null or "return_requests"."state" in ('refund_pending', 'completed')),
	CONSTRAINT "return_requests_completed_at_check" CHECK (("return_requests"."state" = 'completed') = ("return_requests"."completed_at" is not null)),
	CONSTRAINT "return_requests_completion_failure_state_check" CHECK ("return_requests"."completion_failure" is null or "return_requests"."state" in ('received', 'refund_pending')),
	CONSTRAINT "return_requests_note_length_check" CHECK ("return_requests"."note" is null or length("return_requests"."note") <= 1000),
	CONSTRAINT "return_requests_decision_note_length_check" CHECK ("return_requests"."decision_note" is null
          or (length(btrim("return_requests"."decision_note")) >= 3
              and length("return_requests"."decision_note") <= 1000)),
	CONSTRAINT "return_requests_instructions_length_check" CHECK ("return_requests"."return_instructions" is null
          or (length(btrim("return_requests"."return_instructions")) >= 3
              and length("return_requests"."return_instructions") <= 1000))
);
--> statement-breakpoint
CREATE TABLE "support_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"thread_id" text NOT NULL,
	"author_kind" text NOT NULL,
	"author_oxy_user_id" text,
	"author_grant_id" text,
	"body" text NOT NULL,
	"redactions" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "support_messages_author_kind_check" CHECK ("support_messages"."author_kind" in ('buyer', 'seller', 'operator')),
	CONSTRAINT "support_messages_redactions_check" CHECK ("support_messages"."redactions" <@ array['payment_card', 'iban', 'email_address', 'phone_number', 'access_token']::text[]),
	CONSTRAINT "support_messages_author_shape_check" CHECK (("support_messages"."author_kind" in ('seller', 'operator')
           and "support_messages"."author_oxy_user_id" is not null and "support_messages"."author_grant_id" is null)
          or "support_messages"."author_kind" = 'buyer'),
	CONSTRAINT "support_messages_body_length_check" CHECK (length(btrim("support_messages"."body")) >= 1
          and length("support_messages"."body") <= 4000)
);
--> statement-breakpoint
CREATE TABLE "support_threads" (
	"id" text PRIMARY KEY NOT NULL,
	"order_id" text NOT NULL,
	"return_request_id" text,
	"state" text DEFAULT 'open' NOT NULL,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "support_threads_state_check" CHECK ("support_threads"."state" in ('open', 'closed')),
	CONSTRAINT "support_threads_closed_at_check" CHECK (("support_threads"."state" = 'closed') = ("support_threads"."closed_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "guest_portal_messages" DROP CONSTRAINT "guest_portal_messages_kind_check";--> statement-breakpoint
ALTER TABLE "buyer_request_events" ADD CONSTRAINT "buyer_request_events_cancellation_request_id_cancellation_requests_id_fk" FOREIGN KEY ("cancellation_request_id") REFERENCES "public"."cancellation_requests"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "buyer_request_events" ADD CONSTRAINT "buyer_request_events_return_request_id_return_requests_id_fk" FOREIGN KEY ("return_request_id") REFERENCES "public"."return_requests"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "buyer_request_events" ADD CONSTRAINT "buyer_request_events_actor_grant_id_guest_order_access_grants_id_fk" FOREIGN KEY ("actor_grant_id") REFERENCES "public"."guest_order_access_grants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cancellation_request_lines" ADD CONSTRAINT "cancellation_request_lines_request_id_cancellation_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."cancellation_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cancellation_requests" ADD CONSTRAINT "cancellation_requests_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cancellation_requests" ADD CONSTRAINT "cancellation_requests_requested_by_grant_id_guest_order_access_grants_id_fk" FOREIGN KEY ("requested_by_grant_id") REFERENCES "public"."guest_order_access_grants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cancellation_requests" ADD CONSTRAINT "cancellation_requests_refund_id_refunds_id_fk" FOREIGN KEY ("refund_id") REFERENCES "public"."refunds"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "return_request_evidence" ADD CONSTRAINT "return_request_evidence_request_id_return_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."return_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "return_request_lines" ADD CONSTRAINT "return_request_lines_request_id_return_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."return_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "return_requests" ADD CONSTRAINT "return_requests_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "return_requests" ADD CONSTRAINT "return_requests_requested_by_grant_id_guest_order_access_grants_id_fk" FOREIGN KEY ("requested_by_grant_id") REFERENCES "public"."guest_order_access_grants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "return_requests" ADD CONSTRAINT "return_requests_refund_id_refunds_id_fk" FOREIGN KEY ("refund_id") REFERENCES "public"."refunds"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_messages" ADD CONSTRAINT "support_messages_thread_id_support_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."support_threads"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_messages" ADD CONSTRAINT "support_messages_author_grant_id_guest_order_access_grants_id_fk" FOREIGN KEY ("author_grant_id") REFERENCES "public"."guest_order_access_grants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_threads" ADD CONSTRAINT "support_threads_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_threads" ADD CONSTRAINT "support_threads_return_request_id_return_requests_id_fk" FOREIGN KEY ("return_request_id") REFERENCES "public"."return_requests"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "buyer_request_events_cancellation_idx" ON "buyer_request_events" USING btree ("cancellation_request_id","at") WHERE "buyer_request_events"."cancellation_request_id" is not null;--> statement-breakpoint
CREATE INDEX "buyer_request_events_return_idx" ON "buyer_request_events" USING btree ("return_request_id","at") WHERE "buyer_request_events"."return_request_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "cancellation_request_lines_request_variant_key" ON "cancellation_request_lines" USING btree ("request_id","variant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "cancellation_requests_open_order_key" ON "cancellation_requests" USING btree ("order_id") WHERE "cancellation_requests"."state" in ('submitted', 'accepted');--> statement-breakpoint
CREATE UNIQUE INDEX "cancellation_requests_idempotency_key_key" ON "cancellation_requests" USING btree ("idempotency_key") WHERE "cancellation_requests"."idempotency_key" is not null;--> statement-breakpoint
CREATE INDEX "cancellation_requests_order_idx" ON "cancellation_requests" USING btree ("order_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "cancellation_requests_open_idx" ON "cancellation_requests" USING btree ("created_at") WHERE "cancellation_requests"."state" in ('submitted', 'accepted');--> statement-breakpoint
CREATE UNIQUE INDEX "return_request_evidence_request_file_key" ON "return_request_evidence" USING btree ("request_id","file_id");--> statement-breakpoint
CREATE INDEX "return_request_evidence_request_position_idx" ON "return_request_evidence" USING btree ("request_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "return_request_lines_request_variant_key" ON "return_request_lines" USING btree ("request_id","variant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "return_requests_open_order_key" ON "return_requests" USING btree ("order_id") WHERE "return_requests"."state" in ('requested', 'approved', 'awaiting_item', 'received', 'refund_pending');--> statement-breakpoint
CREATE UNIQUE INDEX "return_requests_idempotency_key_key" ON "return_requests" USING btree ("idempotency_key") WHERE "return_requests"."idempotency_key" is not null;--> statement-breakpoint
CREATE INDEX "return_requests_order_idx" ON "return_requests" USING btree ("order_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "return_requests_open_idx" ON "return_requests" USING btree ("created_at") WHERE "return_requests"."state" in ('requested', 'approved', 'awaiting_item', 'received', 'refund_pending');--> statement-breakpoint
CREATE INDEX "return_requests_refund_pending_idx" ON "return_requests" USING btree ("updated_at") WHERE "return_requests"."state" = 'refund_pending';--> statement-breakpoint
CREATE INDEX "support_messages_thread_idx" ON "support_messages" USING btree ("thread_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "support_threads_order_key" ON "support_threads" USING btree ("order_id") WHERE "support_threads"."return_request_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "support_threads_return_request_key" ON "support_threads" USING btree ("return_request_id") WHERE "support_threads"."return_request_id" is not null;--> statement-breakpoint
CREATE INDEX "support_threads_order_idx" ON "support_threads" USING btree ("order_id","created_at" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "guest_portal_messages" ADD CONSTRAINT "guest_portal_messages_kind_check" CHECK ("guest_portal_messages"."kind" in ('order_confirmation', 'payment_pending', 'payment_failed', 'payment_delayed_success', 'order_processing', 'order_shipped', 'tracking_updated', 'order_ready_for_pickup', 'order_delivered', 'order_cancelled', 'refund_pending', 'refund_completed', 'refund_failed', 'cancellation_request_received', 'cancellation_request_approved', 'cancellation_request_rejected', 'return_request_received', 'return_request_updated', 'support_response_available', 'buyer_action_required', 'claim_completed', 'access_link_recovery', 'access_link_step_up', 'access_security_notice'));

--> statement-breakpoint
-- APPEND-ONLY, against UPDATE *and* DELETE (#110).
--
-- The audit trail and the support thread are the two places in this domain
-- whose value is that nobody can revise them: an operator reconstructing what
-- happened to a refund reads the first, and a dispute reads the second. A
-- column-level "immutable once set" rule would still admit a backfill writing
-- NULL over a value, so both verbs are refused outright — the #90 order-item
-- decision, and the reason both foreign keys are declared `RESTRICT` rather
-- than `CASCADE`: a cascade would be a way to delete rows by deleting their
-- parent, and the trigger would then either break the delete or be walked
-- around by it. Declaring RESTRICT makes the declaration and the trigger agree.
CREATE OR REPLACE FUNCTION mercaria_buyer_request_events_append_only()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION
    'buyer_request_events is append-only: % is not permitted. A correction is a NEW event.',
    TG_OP;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER mercaria_buyer_request_events_append_only
  BEFORE UPDATE OR DELETE ON "buyer_request_events"
  FOR EACH ROW EXECUTE FUNCTION mercaria_buyer_request_events_append_only();--> statement-breakpoint

CREATE OR REPLACE FUNCTION mercaria_support_messages_append_only()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION
    'support_messages is append-only: % is not permitted. Neither side may edit or remove what was said.',
    TG_OP;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER mercaria_support_messages_append_only
  BEFORE UPDATE OR DELETE ON "support_messages"
  FOR EACH ROW EXECUTE FUNCTION mercaria_support_messages_append_only();--> statement-breakpoint

-- A request line's IDENTITY is frozen; only the seller's agreed quantity moves.
--
-- `approved_quantity` is the one column a decision writes, and it is what the
-- refund reads. Letting `requested_quantity` or `variant_id` change afterwards
-- would let a decision rewrite what the buyer asked for and then refund against
-- it — the difference between "you asked for three and we agreed two" and a
-- record that says you only ever asked for two.
CREATE OR REPLACE FUNCTION mercaria_buyer_request_line_identity_frozen()
RETURNS trigger AS $$
BEGIN
  IF NEW.variant_id IS DISTINCT FROM OLD.variant_id
     OR NEW.requested_quantity IS DISTINCT FROM OLD.requested_quantity THEN
    RAISE EXCEPTION
      'A buyer request line''s variant and requested quantity are frozen; only approved_quantity may change.';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER mercaria_cancellation_request_lines_identity_frozen
  BEFORE UPDATE ON "cancellation_request_lines"
  FOR EACH ROW EXECUTE FUNCTION mercaria_buyer_request_line_identity_frozen();--> statement-breakpoint
CREATE TRIGGER mercaria_return_request_lines_identity_frozen
  BEFORE UPDATE ON "return_request_lines"
  FOR EACH ROW EXECUTE FUNCTION mercaria_buyer_request_line_identity_frozen();--> statement-breakpoint

-- Declared return evidence is append-only against UPDATE.
--
-- DELETE is deliberately PERMITTED, unlike the two above: the foreign key is
-- `CASCADE` because evidence is part of the request's own body rather than an
-- audit of it, and refusing DELETE would break that cascade in a state nobody
-- intends. What must not happen is a file id being SWAPPED after a seller
-- decided on it.
CREATE OR REPLACE FUNCTION mercaria_return_request_evidence_immutable()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION
    'return_request_evidence is immutable: a declared file reference cannot be rewritten.';
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER mercaria_return_request_evidence_immutable
  BEFORE UPDATE ON "return_request_evidence"
  FOR EACH ROW EXECUTE FUNCTION mercaria_return_request_evidence_immutable();
