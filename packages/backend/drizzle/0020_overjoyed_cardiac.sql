-- oxy:deploy-phase=pre
-- oxy:rollback=restore: the narrower notifications_type_check is in the migration that defined it; re-adding it fails against any notification carrying a type this file admitted
CREATE TABLE "merchant_claim_challenges" (
	"id" text PRIMARY KEY NOT NULL,
	"claim_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"closed_at" timestamp with time zone,
	"closed_reason" text,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"last_attempt_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "merchant_claim_challenges_closed_reason_check" CHECK ("merchant_claim_challenges"."closed_reason" in ('verified', 'superseded', 'expired', 'abandoned')),
	CONSTRAINT "merchant_claim_challenges_closed_state_check" CHECK (("merchant_claim_challenges"."closed_at" is not null) = ("merchant_claim_challenges"."closed_reason" is not null)),
	CONSTRAINT "merchant_claim_challenges_attempt_count_check" CHECK ("merchant_claim_challenges"."attempt_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "merchant_claim_events" (
	"id" text PRIMARY KEY NOT NULL,
	"claim_id" text NOT NULL,
	"action" text NOT NULL,
	"actor_kind" text NOT NULL,
	"actor_oxy_user_id" text,
	"from_state" text,
	"to_state" text,
	"reason" text,
	"at" timestamp with time zone NOT NULL,
	CONSTRAINT "merchant_claim_events_action_check" CHECK ("merchant_claim_events"."action" in ('created', 'challenge_issued', 'challenge_attempted', 'challenge_verified', 'challenge_failed', 'submitted_for_review', 'evidence_added', 'evidence_accessed', 'verified', 'rejected', 'expired', 'revoked', 'disputed', 'dispute_resolved')),
	CONSTRAINT "merchant_claim_events_actor_kind_check" CHECK ("merchant_claim_events"."actor_kind" in ('claimant', 'operator', 'system')),
	CONSTRAINT "merchant_claim_events_from_state_check" CHECK ("merchant_claim_events"."from_state" in ('draft', 'challenge_pending', 'review_pending', 'verified', 'rejected', 'expired', 'revoked', 'disputed')),
	CONSTRAINT "merchant_claim_events_to_state_check" CHECK ("merchant_claim_events"."to_state" in ('draft', 'challenge_pending', 'review_pending', 'verified', 'rejected', 'expired', 'revoked', 'disputed')),
	CONSTRAINT "merchant_claim_events_actor_presence_check" CHECK (("merchant_claim_events"."actor_kind" = 'system') = ("merchant_claim_events"."actor_oxy_user_id" is null))
);
--> statement-breakpoint
CREATE TABLE "merchant_claim_evidence" (
	"id" text PRIMARY KEY NOT NULL,
	"claim_id" text NOT NULL,
	"kind" text NOT NULL,
	"oxy_file_id" text,
	"sha256" text,
	"note" text,
	"url" text,
	"collected_by_oxy_user_id" text,
	"collected_at" timestamp with time zone NOT NULL,
	CONSTRAINT "merchant_claim_evidence_kind_check" CHECK ("merchant_claim_evidence"."kind" in ('challenge_proof', 'business_document', 'platform_account', 'operator_note', 'contest_statement')),
	CONSTRAINT "merchant_claim_evidence_sha256_check" CHECK ("merchant_claim_evidence"."sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "merchant_claim_evidence_reference_check" CHECK (num_nonnulls("merchant_claim_evidence"."oxy_file_id", "merchant_claim_evidence"."url", "merchant_claim_evidence"."note") > 0)
);
--> statement-breakpoint
CREATE TABLE "merchant_claim_scopes" (
	"id" text PRIMARY KEY NOT NULL,
	"claim_id" text NOT NULL,
	"scope_kind" text NOT NULL,
	"scope_ref" text NOT NULL,
	"state" text DEFAULT 'requested' NOT NULL,
	"verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "merchant_claim_scopes_kind_check" CHECK ("merchant_claim_scopes"."scope_kind" in ('merchant', 'storefront', 'domain')),
	CONSTRAINT "merchant_claim_scopes_state_check" CHECK ("merchant_claim_scopes"."state" in ('requested', 'verified', 'out_of_scope')),
	CONSTRAINT "merchant_claim_scopes_verified_state_check" CHECK ("merchant_claim_scopes"."state" <> 'verified' or "merchant_claim_scopes"."verified_at" is not null),
	CONSTRAINT "merchant_claim_scopes_domain_normalized_check" CHECK ("merchant_claim_scopes"."scope_kind" <> 'domain' or "merchant_claim_scopes"."scope_ref" = lower(btrim("merchant_claim_scopes"."scope_ref")))
);
--> statement-breakpoint
CREATE TABLE "merchant_claims" (
	"id" text PRIMARY KEY NOT NULL,
	"merchant_id" text NOT NULL,
	"claimant_oxy_user_id" text NOT NULL,
	"native_store_id" text,
	"method" text NOT NULL,
	"subject_kind" text,
	"subject_ref" text,
	"state" text DEFAULT 'draft' NOT NULL,
	"expires_at" timestamp with time zone,
	"revalidate_after" timestamp with time zone,
	"reviewed_by_oxy_user_id" text,
	"reviewed_at" timestamp with time zone,
	"decision_reason" text,
	"verified_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_by_oxy_user_id" text,
	"revoke_reason" text,
	"conflicting_claim_id" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "merchant_claims_method_check" CHECK ("merchant_claims"."method" in ('dns_txt', 'well_known_file', 'meta_tag', 'platform_oauth', 'channel_key', 'role_email', 'business_document')),
	CONSTRAINT "merchant_claims_state_check" CHECK ("merchant_claims"."state" in ('draft', 'challenge_pending', 'review_pending', 'verified', 'rejected', 'expired', 'revoked', 'disputed')),
	CONSTRAINT "merchant_claims_subject_kind_check" CHECK ("merchant_claims"."subject_kind" in ('domain', 'connection', 'email')),
	CONSTRAINT "merchant_claims_subject_presence_check" CHECK (num_nonnulls("merchant_claims"."subject_kind", "merchant_claims"."subject_ref") in (0, 2)),
	CONSTRAINT "merchant_claims_document_subject_check" CHECK (("merchant_claims"."method" = 'business_document') = ("merchant_claims"."subject_kind" is null)),
	CONSTRAINT "merchant_claims_subject_domain_normalized_check" CHECK ("merchant_claims"."subject_kind" <> 'domain' or "merchant_claims"."subject_ref" = lower(btrim("merchant_claims"."subject_ref"))),
	CONSTRAINT "merchant_claims_revoke_reason_check" CHECK ("merchant_claims"."revoke_reason" in ('domain_loss', 'platform_disconnect', 'fraud', 'operator_correction', 'claimant_request')),
	CONSTRAINT "merchant_claims_verified_state_check" CHECK ("merchant_claims"."state" <> 'verified' or "merchant_claims"."verified_at" is not null),
	CONSTRAINT "merchant_claims_revoked_state_check" CHECK ("merchant_claims"."state" <> 'revoked' or ("merchant_claims"."revoked_at" is not null and "merchant_claims"."revoked_by_oxy_user_id" is not null and "merchant_claims"."revoke_reason" is not null)),
	CONSTRAINT "merchant_claims_rejected_state_check" CHECK ("merchant_claims"."state" <> 'rejected' or ("merchant_claims"."reviewed_by_oxy_user_id" is not null and "merchant_claims"."reviewed_at" is not null and "merchant_claims"."decision_reason" is not null)),
	CONSTRAINT "merchant_claims_disputed_state_check" CHECK ("merchant_claims"."state" <> 'disputed' or "merchant_claims"."conflicting_claim_id" is not null),
	CONSTRAINT "merchant_claims_conflict_self_check" CHECK ("merchant_claims"."conflicting_claim_id" <> "merchant_claims"."id")
);
--> statement-breakpoint
ALTER TABLE "notifications" DROP CONSTRAINT "notifications_type_check";--> statement-breakpoint
ALTER TABLE "merchant_claim_challenges" ADD CONSTRAINT "merchant_claim_challenges_claim_id_merchant_claims_id_fk" FOREIGN KEY ("claim_id") REFERENCES "public"."merchant_claims"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchant_claim_events" ADD CONSTRAINT "merchant_claim_events_claim_id_merchant_claims_id_fk" FOREIGN KEY ("claim_id") REFERENCES "public"."merchant_claims"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchant_claim_evidence" ADD CONSTRAINT "merchant_claim_evidence_claim_id_merchant_claims_id_fk" FOREIGN KEY ("claim_id") REFERENCES "public"."merchant_claims"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchant_claim_scopes" ADD CONSTRAINT "merchant_claim_scopes_claim_id_merchant_claims_id_fk" FOREIGN KEY ("claim_id") REFERENCES "public"."merchant_claims"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchant_claims" ADD CONSTRAINT "merchant_claims_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchant_claims" ADD CONSTRAINT "merchant_claims_native_store_id_stores_id_fk" FOREIGN KEY ("native_store_id") REFERENCES "public"."stores"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchant_claims" ADD CONSTRAINT "merchant_claims_conflicting_claim_id_merchant_claims_id_fk" FOREIGN KEY ("conflicting_claim_id") REFERENCES "public"."merchant_claims"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "merchant_claim_challenges_token_hash_key" ON "merchant_claim_challenges" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "merchant_claim_challenges_claim_id_open_key" ON "merchant_claim_challenges" USING btree ("claim_id") WHERE "merchant_claim_challenges"."closed_at" is null;--> statement-breakpoint
CREATE INDEX "merchant_claim_challenges_claim_id_idx" ON "merchant_claim_challenges" USING btree ("claim_id");--> statement-breakpoint
CREATE INDEX "merchant_claim_challenges_created_at_idx" ON "merchant_claim_challenges" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "merchant_claim_events_claim_id_at_idx" ON "merchant_claim_events" USING btree ("claim_id","at");--> statement-breakpoint
CREATE INDEX "merchant_claim_evidence_claim_id_idx" ON "merchant_claim_evidence" USING btree ("claim_id");--> statement-breakpoint
CREATE UNIQUE INDEX "merchant_claim_scopes_claim_kind_ref_key" ON "merchant_claim_scopes" USING btree ("claim_id","scope_kind","scope_ref");--> statement-breakpoint
CREATE INDEX "merchant_claim_scopes_ref_idx" ON "merchant_claim_scopes" USING btree ("scope_kind","scope_ref");--> statement-breakpoint
CREATE UNIQUE INDEX "merchant_claims_merchant_verified_key" ON "merchant_claims" USING btree ("merchant_id") WHERE "merchant_claims"."state" = 'verified';--> statement-breakpoint
CREATE UNIQUE INDEX "merchant_claims_merchant_claimant_active_key" ON "merchant_claims" USING btree ("merchant_id","claimant_oxy_user_id") WHERE "merchant_claims"."state" in ('draft', 'challenge_pending', 'review_pending', 'disputed');--> statement-breakpoint
CREATE INDEX "merchant_claims_merchant_id_created_at_idx" ON "merchant_claims" USING btree ("merchant_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "merchant_claims_claimant_created_at_idx" ON "merchant_claims" USING btree ("claimant_oxy_user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "merchant_claims_state_created_at_idx" ON "merchant_claims" USING btree ("state","created_at");--> statement-breakpoint
CREATE INDEX "merchant_claims_expires_at_idx" ON "merchant_claims" USING btree ("expires_at") WHERE "merchant_claims"."expires_at" is not null;--> statement-breakpoint
CREATE INDEX "merchant_claims_subject_idx" ON "merchant_claims" USING btree ("subject_kind","subject_ref") WHERE "merchant_claims"."subject_kind" is not null;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_type_check" CHECK ("notifications"."type" in ('trigger_result', 'proactive_insight', 'daily_briefing', 'price_alert', 'integration_event', 'reminder', 'agent_task_complete', 'chat_response_ready', 'oxy_service', 'order_placed', 'order_paid', 'order_shipped', 'order_delivered', 'order_cancelled', 'listing_sold', 'review_received', 'store_member_invited', 'low_inventory', 'listing_changes_requested', 'merchant_claim_contested', 'merchant_claim_revoked'));