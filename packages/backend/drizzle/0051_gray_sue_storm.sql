-- oxy:deploy-phase=pre
-- oxy:rollback=derived
--
-- #109 — claiming a guest checkout group into an Oxy account (ADR 0003 D14).
-- ADDITIVE, entirely: three new tables, no column dropped, renamed or narrowed
-- on any table that already exists. The serving image writes none of them, so
-- there is no statement below that breaks a write the previous image performs.
--
-- The claim COLUMNS this domain writes (`orders.claimed_by_oxy_user_id` /
-- `claimed_at`), the CHECK that admits them and the trigger that permits
-- NULL -> value all shipped with #106's `0030`. #109 adds no `orders` DDL at
-- all — it adds the only writer.
--
-- There are no hand-written statements in this file, so a regeneration is safe:
-- every constraint and index below is declared in
-- `src/db/schema/guestClaims.ts` and drizzle-kit reproduces all of them.

CREATE TABLE "guest_order_claim_outbox" (
	"id" text PRIMARY KEY NOT NULL,
	"claim_id" text NOT NULL,
	"checkout_group_id" text NOT NULL,
	"type" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone NOT NULL,
	"lease_owner" text,
	"lease_until" timestamp with time zone,
	"last_error" text,
	"completed_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "guest_order_claim_outbox_type_check" CHECK ("guest_order_claim_outbox"."type" in ('review_eligibility', 'claim_notification')),
	CONSTRAINT "guest_order_claim_outbox_state_check" CHECK ("guest_order_claim_outbox"."state" in ('pending', 'processing', 'completed', 'failed', 'dead_letter')),
	CONSTRAINT "guest_order_claim_outbox_attempts_check" CHECK ("guest_order_claim_outbox"."attempts" >= 0),
	CONSTRAINT "guest_order_claim_outbox_last_error_length_check" CHECK ("guest_order_claim_outbox"."last_error" is null
          or length("guest_order_claim_outbox"."last_error") <= 500),
	CONSTRAINT "guest_order_claim_outbox_completed_check" CHECK (("guest_order_claim_outbox"."state" = 'completed') = ("guest_order_claim_outbox"."completed_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "guest_order_claim_revocations" (
	"id" text PRIMARY KEY NOT NULL,
	"claim_id" text NOT NULL,
	"state" text DEFAULT 'pending_approval' NOT NULL,
	"reason" text NOT NULL,
	"evidence_ref" text NOT NULL,
	"requested_by_oxy_user_id" text NOT NULL,
	"four_eyes_required" boolean NOT NULL,
	"approved_by_oxy_user_id" text,
	"executed_at" timestamp with time zone,
	"withdrawn_at" timestamp with time zone,
	"withdrawn_by_oxy_user_id" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "guest_order_claim_revocations_state_check" CHECK ("guest_order_claim_revocations"."state" in ('pending_approval', 'executed', 'withdrawn')),
	CONSTRAINT "guest_order_claim_revocations_reason_check" CHECK ("guest_order_claim_revocations"."reason" in ('wrong_account', 'account_compromise', 'contested_ownership', 'buyer_request', 'legal_or_compliance')),
	CONSTRAINT "guest_order_claim_revocations_evidence_ref_check" CHECK (length("guest_order_claim_revocations"."evidence_ref") between 1 and 200),
	CONSTRAINT "guest_order_claim_revocations_four_eyes_check" CHECK ("guest_order_claim_revocations"."approved_by_oxy_user_id" is null
          or "guest_order_claim_revocations"."approved_by_oxy_user_id" <> "guest_order_claim_revocations"."requested_by_oxy_user_id"),
	CONSTRAINT "guest_order_claim_revocations_state_shape_check" CHECK (("guest_order_claim_revocations"."state" = 'pending_approval'
             and num_nonnulls("guest_order_claim_revocations"."executed_at", "guest_order_claim_revocations"."withdrawn_at", "guest_order_claim_revocations"."withdrawn_by_oxy_user_id") = 0
             and "guest_order_claim_revocations"."approved_by_oxy_user_id" is null)
          or ("guest_order_claim_revocations"."state" = 'executed'
             and "guest_order_claim_revocations"."executed_at" is not null
             and num_nonnulls("guest_order_claim_revocations"."withdrawn_at", "guest_order_claim_revocations"."withdrawn_by_oxy_user_id") = 0
             and ("guest_order_claim_revocations"."four_eyes_required" = false or "guest_order_claim_revocations"."approved_by_oxy_user_id" is not null))
          or ("guest_order_claim_revocations"."state" = 'withdrawn'
             and "guest_order_claim_revocations"."executed_at" is null
             and num_nonnulls("guest_order_claim_revocations"."withdrawn_at", "guest_order_claim_revocations"."withdrawn_by_oxy_user_id") = 2))
);
--> statement-breakpoint
CREATE TABLE "guest_order_claims" (
	"id" text PRIMARY KEY NOT NULL,
	"checkout_group_id" text NOT NULL,
	"guest_checkout_id" text NOT NULL,
	"claimed_by_oxy_user_id" text NOT NULL,
	"source_grant_id" text NOT NULL,
	"state" text NOT NULL,
	"policy_version" text DEFAULT '2026-08-10.1' NOT NULL,
	"order_count" integer NOT NULL,
	"conflict_reason" text,
	"completed_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_by_oxy_user_id" text,
	"revocation_reason" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "guest_order_claims_state_check" CHECK ("guest_order_claims"."state" in ('completed', 'conflicted', 'revoked')),
	CONSTRAINT "guest_order_claims_conflict_reason_check" CHECK ("guest_order_claims"."conflict_reason" in ('already_claimed_by_another_account')),
	CONSTRAINT "guest_order_claims_revocation_reason_check" CHECK ("guest_order_claims"."revocation_reason" in ('wrong_account', 'account_compromise', 'contested_ownership', 'buyer_request', 'legal_or_compliance')),
	CONSTRAINT "guest_order_claims_order_count_check" CHECK ("guest_order_claims"."order_count" >= 1),
	CONSTRAINT "guest_order_claims_state_shape_check" CHECK (("guest_order_claims"."state" = 'completed'
             and "guest_order_claims"."completed_at" is not null
             and "guest_order_claims"."conflict_reason" is null
             and num_nonnulls("guest_order_claims"."revoked_at", "guest_order_claims"."revoked_by_oxy_user_id", "guest_order_claims"."revocation_reason") = 0)
          or ("guest_order_claims"."state" = 'conflicted'
             and "guest_order_claims"."completed_at" is null
             and "guest_order_claims"."conflict_reason" is not null
             and num_nonnulls("guest_order_claims"."revoked_at", "guest_order_claims"."revoked_by_oxy_user_id", "guest_order_claims"."revocation_reason") = 0)
          or ("guest_order_claims"."state" = 'revoked'
             and "guest_order_claims"."completed_at" is not null
             and "guest_order_claims"."conflict_reason" is null
             and num_nonnulls("guest_order_claims"."revoked_at", "guest_order_claims"."revoked_by_oxy_user_id", "guest_order_claims"."revocation_reason") = 3))
);
--> statement-breakpoint
ALTER TABLE "guest_order_claim_outbox" ADD CONSTRAINT "guest_order_claim_outbox_claim_id_guest_order_claims_id_fk" FOREIGN KEY ("claim_id") REFERENCES "public"."guest_order_claims"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guest_order_claim_revocations" ADD CONSTRAINT "guest_order_claim_revocations_claim_id_guest_order_claims_id_fk" FOREIGN KEY ("claim_id") REFERENCES "public"."guest_order_claims"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guest_order_claims" ADD CONSTRAINT "guest_order_claims_guest_checkout_id_guest_checkouts_id_fk" FOREIGN KEY ("guest_checkout_id") REFERENCES "public"."guest_checkouts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "guest_order_claim_outbox_pending_idx" ON "guest_order_claim_outbox" USING btree ("available_at","created_at") WHERE "guest_order_claim_outbox"."state" = 'pending';--> statement-breakpoint
CREATE INDEX "guest_order_claim_outbox_reclaim_idx" ON "guest_order_claim_outbox" USING btree ("lease_until","created_at") WHERE "guest_order_claim_outbox"."state" = 'processing';--> statement-breakpoint
CREATE INDEX "guest_order_claim_outbox_claim_idx" ON "guest_order_claim_outbox" USING btree ("claim_id");--> statement-breakpoint
CREATE INDEX "guest_order_claim_outbox_expires_at_idx" ON "guest_order_claim_outbox" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "guest_order_claim_revocations_open_key" ON "guest_order_claim_revocations" USING btree ("claim_id") WHERE "guest_order_claim_revocations"."state" = 'pending_approval';--> statement-breakpoint
CREATE INDEX "guest_order_claim_revocations_claim_created_at_idx" ON "guest_order_claim_revocations" USING btree ("claim_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "guest_order_claims_active_group_key" ON "guest_order_claims" USING btree ("checkout_group_id") WHERE "guest_order_claims"."state" = 'completed';--> statement-breakpoint
CREATE INDEX "guest_order_claims_group_created_at_idx" ON "guest_order_claims" USING btree ("checkout_group_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "guest_order_claims_account_created_at_idx" ON "guest_order_claims" USING btree ("claimed_by_oxy_user_id","created_at" DESC NULLS LAST);