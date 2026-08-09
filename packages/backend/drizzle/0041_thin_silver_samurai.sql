-- oxy:deploy-phase=pre
--
-- The guest order portal (#108, ADR 0003 D5/D11/D17) — five new tables and
-- nothing else. Purely ADDITIVE: no column is dropped, renamed or narrowed, no
-- existing CHECK is rewritten, and the serving image writes none of these
-- tables, so applying this before the rollout leaves the previous image exactly
-- as correct as it was.
--
--   guest_order_access_grants      — every credential that can reach a placed
--                                    guest order. ONE table for both the
--                                    15-minute single-use `mgx_` exchange token
--                                    and the 30-day `mgp_` portal credential.
--   guest_portal_messages          — the durable transactional-message queue,
--                                    the moderation outbox ported once more.
--   guest_contact_suppressions     — inboxes Mercaria has stopped writing to,
--                                    keyed on the email HMAC and never on an
--                                    address.
--   guest_recovery_attempts        — the durable, cross-task recovery throttle.
--   guest_portal_operator_actions  — append-only audit of operator-assisted
--                                    recovery, the `payment_repairs` shape.
--
-- Two CHECKs on `guest_order_access_grants` carry the verification model and
-- are worth reading before editing either:
--
--   `…_verification_origin_check` refuses a verification instant on a
--   `post_checkout` row, which makes "paying does not prove an inbox" (#108
--   email-verification rules 2 and 3) structural rather than procedural.
--
--   `…_unverified_scope_check` holds an unproven PORTAL credential to
--   `tracking:read`, so possession of the paying device can never buy a
--   retrospective read of stored detail whatever a service does. It exempts
--   `exchange` rows deliberately: their scopes are a PROMISE of what the
--   credential they mint will carry, and an exchange token can read nothing —
--   the only statement that accepts one CONSUMES it.
--
-- No trigger and no hand-written statement, so a regeneration behind another
-- branch's migration loses nothing: delete the `.sql` and the snapshot, restore
-- `_journal.json`, rebuild `@mercaria/shared-types`, and re-run `db:generate`.

CREATE TABLE "guest_contact_suppressions" (
	"id" text PRIMARY KEY NOT NULL,
	"email_hash" text NOT NULL,
	"reason" text NOT NULL,
	"lifted_by_oxy_user_id" text,
	"lifted_at" timestamp with time zone,
	"lift_reason" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "guest_contact_suppressions_reason_check" CHECK ("guest_contact_suppressions"."reason" in ('hard_bounce', 'complaint', 'permanent_failure', 'operator')),
	CONSTRAINT "guest_contact_suppressions_lift_check" CHECK (num_nonnulls("guest_contact_suppressions"."lifted_at", "guest_contact_suppressions"."lifted_by_oxy_user_id", "guest_contact_suppressions"."lift_reason") in (0, 3))
);
--> statement-breakpoint
CREATE TABLE "guest_order_access_grants" (
	"id" text PRIMARY KEY NOT NULL,
	"checkout_group_id" text NOT NULL,
	"guest_checkout_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"purpose" text NOT NULL,
	"created_via" text NOT NULL,
	"exchange_reason" text,
	"scopes" text[] NOT NULL,
	"email_verified_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"purge_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "guest_order_access_grants_purpose_check" CHECK ("guest_order_access_grants"."purpose" in ('exchange', 'portal')),
	CONSTRAINT "guest_order_access_grants_created_via_check" CHECK ("guest_order_access_grants"."created_via" in ('post_checkout', 'magic_link')),
	CONSTRAINT "guest_order_access_grants_exchange_reason_check" CHECK ("guest_order_access_grants"."exchange_reason" in ('initial_confirmation', 'recovery', 'sensitive_action')),
	CONSTRAINT "guest_order_access_grants_scopes_check" CHECK ("guest_order_access_grants"."scopes" <@ array['orders:read', 'tracking:read', 'documents:read', 'cancellations:request', 'returns:request', 'support:write', 'claim:write', 'contact_change:request']::text[]),
	CONSTRAINT "guest_order_access_grants_scopes_present_check" CHECK (cardinality("guest_order_access_grants"."scopes") >= 1),
	CONSTRAINT "guest_order_access_grants_exchange_reason_shape_check" CHECK (("guest_order_access_grants"."purpose" = 'exchange') = ("guest_order_access_grants"."exchange_reason" is not null)),
	CONSTRAINT "guest_order_access_grants_exchange_origin_check" CHECK ("guest_order_access_grants"."purpose" = 'portal' or "guest_order_access_grants"."created_via" = 'magic_link'),
	CONSTRAINT "guest_order_access_grants_consumed_shape_check" CHECK ("guest_order_access_grants"."consumed_at" is null or "guest_order_access_grants"."purpose" = 'exchange'),
	CONSTRAINT "guest_order_access_grants_verification_origin_check" CHECK ("guest_order_access_grants"."email_verified_at" is null or "guest_order_access_grants"."created_via" = 'magic_link'),
	CONSTRAINT "guest_order_access_grants_unverified_scope_check" CHECK ("guest_order_access_grants"."purpose" = 'exchange'
          or "guest_order_access_grants"."email_verified_at" is not null
          or "guest_order_access_grants"."scopes" <@ array['tracking:read']::text[]),
	CONSTRAINT "guest_order_access_grants_purge_after_expiry_check" CHECK ("guest_order_access_grants"."purge_at" > "guest_order_access_grants"."expires_at")
);
--> statement-breakpoint
CREATE TABLE "guest_portal_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"checkout_group_id" text NOT NULL,
	"guest_checkout_id" text NOT NULL,
	"kind" text NOT NULL,
	"order_id" text,
	"locale" text,
	"state" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone NOT NULL,
	"lease_owner" text,
	"lease_until" timestamp with time zone,
	"last_failure" text,
	"sent_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "guest_portal_messages_kind_check" CHECK ("guest_portal_messages"."kind" in ('order_confirmation', 'payment_pending', 'payment_failed', 'payment_delayed_success', 'order_processing', 'order_shipped', 'tracking_updated', 'order_ready_for_pickup', 'order_delivered', 'order_cancelled', 'refund_pending', 'refund_completed', 'return_request_updated', 'claim_completed', 'access_link_recovery', 'access_link_step_up', 'access_security_notice')),
	CONSTRAINT "guest_portal_messages_state_check" CHECK ("guest_portal_messages"."state" in ('pending', 'sending', 'sent', 'failed', 'dead_letter', 'suppressed')),
	CONSTRAINT "guest_portal_messages_last_failure_check" CHECK ("guest_portal_messages"."last_failure" in ('transport_unconfigured', 'contact_anonymized', 'contact_suppressed', 'transport_rejected', 'transport_unavailable', 'contact_unreadable')),
	CONSTRAINT "guest_portal_messages_attempts_check" CHECK ("guest_portal_messages"."attempts" >= 0),
	CONSTRAINT "guest_portal_messages_sent_at_check" CHECK (("guest_portal_messages"."state" = 'sent') = ("guest_portal_messages"."sent_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "guest_portal_operator_actions" (
	"id" text PRIMARY KEY NOT NULL,
	"checkout_group_id" text NOT NULL,
	"action" text NOT NULL,
	"actor_oxy_user_id" text NOT NULL,
	"reason" text NOT NULL,
	"outcome" text NOT NULL,
	"refusal_code" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "guest_portal_operator_actions_action_check" CHECK ("guest_portal_operator_actions"."action" in ('resend_access_link', 'revoke_group_access')),
	CONSTRAINT "guest_portal_operator_actions_outcome_check" CHECK ("guest_portal_operator_actions"."outcome" in ('performed', 'refused', 'failed')),
	CONSTRAINT "guest_portal_operator_actions_refusal_check" CHECK (("guest_portal_operator_actions"."outcome" = 'refused') = ("guest_portal_operator_actions"."refusal_code" is not null)),
	CONSTRAINT "guest_portal_operator_actions_reason_check" CHECK (length(btrim("guest_portal_operator_actions"."reason")) >= 3)
);
--> statement-breakpoint
CREATE TABLE "guest_recovery_attempts" (
	"id" text PRIMARY KEY NOT NULL,
	"axis" text NOT NULL,
	"subject_hash" text NOT NULL,
	"window_started_at" timestamp with time zone NOT NULL,
	"attempts" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "guest_recovery_attempts_axis_check" CHECK ("guest_recovery_attempts"."axis" in ('email_hash', 'order_reference', 'network')),
	CONSTRAINT "guest_recovery_attempts_attempts_check" CHECK ("guest_recovery_attempts"."attempts" >= 1)
);
--> statement-breakpoint
ALTER TABLE "guest_order_access_grants" ADD CONSTRAINT "guest_order_access_grants_guest_checkout_id_guest_checkouts_id_fk" FOREIGN KEY ("guest_checkout_id") REFERENCES "public"."guest_checkouts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guest_portal_messages" ADD CONSTRAINT "guest_portal_messages_guest_checkout_id_guest_checkouts_id_fk" FOREIGN KEY ("guest_checkout_id") REFERENCES "public"."guest_checkouts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "guest_contact_suppressions_email_hash_key" ON "guest_contact_suppressions" USING btree ("email_hash") WHERE "guest_contact_suppressions"."lifted_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "guest_order_access_grants_token_hash_key" ON "guest_order_access_grants" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "guest_order_access_grants_group_idx" ON "guest_order_access_grants" USING btree ("checkout_group_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "guest_order_access_grants_purge_at_idx" ON "guest_order_access_grants" USING btree ("purge_at");--> statement-breakpoint
CREATE INDEX "guest_portal_messages_pending_idx" ON "guest_portal_messages" USING btree ("available_at","created_at") WHERE "guest_portal_messages"."state" = 'pending';--> statement-breakpoint
CREATE INDEX "guest_portal_messages_reclaim_idx" ON "guest_portal_messages" USING btree ("lease_until","created_at") WHERE "guest_portal_messages"."state" = 'sending';--> statement-breakpoint
CREATE INDEX "guest_portal_messages_group_idx" ON "guest_portal_messages" USING btree ("checkout_group_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "guest_portal_messages_expires_at_idx" ON "guest_portal_messages" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "guest_portal_operator_actions_group_idx" ON "guest_portal_operator_actions" USING btree ("checkout_group_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "guest_recovery_attempts_window_key" ON "guest_recovery_attempts" USING btree ("axis","subject_hash","window_started_at");--> statement-breakpoint
CREATE INDEX "guest_recovery_attempts_window_started_at_idx" ON "guest_recovery_attempts" USING btree ("window_started_at");