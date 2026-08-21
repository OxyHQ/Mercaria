-- oxy:deploy-phase=pre
-- oxy:rollback=restore: referral_attributions_conflict_reason_check, referral_events_subject_type_check and referral_events_action_check are widened; the previous forms are in 0084 and re-adding any of them fails against a stored attribution or event using the added vocabulary
--
-- #148: referral fraud controls, privacy, disclosures and program enforcement
-- (ADR 0005 D7/D17/D18, R6-R8).
--
-- ADDITIVE THROUGHOUT, which is why the phase is `pre`. Five new tables that
-- nothing yet writes, and three CHECK WIDENINGS on tables the serving image
-- already writes:
--
--   * `referral_attributions_conflict_reason_check` gains `enforcement_suspended`
--   * `referral_events_subject_type_check` gains `conduct_policy` and
--     `disclosure_requirement`
--   * `referral_events_action_check` gains nine #148 verbs
--
-- Each is a DROP + ADD pair of a strictly WIDER tuple, so every value the
-- serving image writes is admitted by both the old constraint and the new one.
-- No statement here breaks a write the previous image performs, which is the
-- test that decides the phase.
--
-- ## Hand-written blocks
--
-- FIVE, each anchored between `-- oxy:handwritten-begin=<name>` and its
-- matching `-- oxy:handwritten-end=<name>` at the END of this file, after every
-- generated statement. A regeneration DROPS all five; re-apply them there, and
-- then READ the regenerated file for statements you did not intend rather than
-- only checking that yours came back.
--
--   1. referral_risk_signals_append_only          (refuses UPDATE, permits DELETE)
--   2. referral_enforcement_actions_decision_freeze
--   3. referral_enforcement_appeals_append_only
--   4. referral_conduct_policies_immutable
--   5. referral_disclosure_requirements_immutable
--
CREATE TABLE "referral_conduct_policies" (
	"id" text PRIMARY KEY NOT NULL,
	"policy_key" text NOT NULL,
	"version" integer NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"prohibited_conduct" text[] NOT NULL,
	"terms_version" text NOT NULL,
	"summary" text NOT NULL,
	"effective_from" timestamp with time zone NOT NULL,
	"published_by_oxy_user_id" text,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "referral_conduct_policies_status_check" CHECK ("referral_conduct_policies"."status" in ('draft', 'active', 'superseded')),
	CONSTRAINT "referral_conduct_policies_conduct_check" CHECK ("referral_conduct_policies"."prohibited_conduct" <@ array['self_or_related_party_referral', 'multi_level_recruitment', 'cookie_stuffing_or_forced_clicks', 'spam_or_unsolicited_messaging', 'misleading_earnings_or_product_claims', 'impersonation', 'unauthorized_trademark_bidding', 'unapproved_incentivized_promotion', 'fake_reviews_or_undisclosed_sponsorship', 'automated_account_or_checkout_creation', 'fraudulent_purchase_or_dispute', 'merchant_event_manipulation', 'disclosure_failure', 'restricted_geography_or_audience', 'partner_account_sharing_or_sale', 'referred_customer_data_access']::text[]),
	CONSTRAINT "referral_conduct_policies_conduct_nonempty_check" CHECK (cardinality("referral_conduct_policies"."prohibited_conduct") >= 1),
	CONSTRAINT "referral_conduct_policies_version_check" CHECK ("referral_conduct_policies"."version" >= 1),
	CONSTRAINT "referral_conduct_policies_identity_check" CHECK (length("referral_conduct_policies"."policy_key") > 0 and length("referral_conduct_policies"."terms_version") > 0
          and length("referral_conduct_policies"."summary") > 0
          and length("referral_conduct_policies"."summary") <= 2000),
	CONSTRAINT "referral_conduct_policies_publication_check" CHECK ((("referral_conduct_policies"."status" = 'draft') = ("referral_conduct_policies"."published_at" is null))
          and (("referral_conduct_policies"."status" = 'draft') = ("referral_conduct_policies"."published_by_oxy_user_id" is null)))
);
--> statement-breakpoint
CREATE TABLE "referral_disclosure_requirements" (
	"id" text PRIMARY KEY NOT NULL,
	"disclosure_key" text NOT NULL,
	"version" integer NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"surface" text NOT NULL,
	"market" text DEFAULT '*' NOT NULL,
	"language" text DEFAULT '*' NOT NULL,
	"copy" text NOT NULL,
	"required" text DEFAULT 'yes' NOT NULL,
	"effective_from" timestamp with time zone NOT NULL,
	"published_by_oxy_user_id" text,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "referral_disclosure_requirements_status_check" CHECK ("referral_disclosure_requirements"."status" in ('draft', 'active', 'superseded')),
	CONSTRAINT "referral_disclosure_requirements_surface_check" CHECK ("referral_disclosure_requirements"."surface" in ('link', 'social_post', 'video', 'livestream', 'email', 'profile_bio', 'checkout')),
	CONSTRAINT "referral_disclosure_requirements_required_check" CHECK ("referral_disclosure_requirements"."required" in ('yes', 'no')),
	CONSTRAINT "referral_disclosure_requirements_version_check" CHECK ("referral_disclosure_requirements"."version" >= 1),
	CONSTRAINT "referral_disclosure_requirements_market_check" CHECK ("referral_disclosure_requirements"."market" = '*' or "referral_disclosure_requirements"."market" ~ '^[A-Z]{2}$'),
	CONSTRAINT "referral_disclosure_requirements_language_check" CHECK ("referral_disclosure_requirements"."language" = '*' or "referral_disclosure_requirements"."language" ~ '^[a-z]{2,3}$'),
	CONSTRAINT "referral_disclosure_requirements_copy_check" CHECK (length("referral_disclosure_requirements"."copy") > 0
          and length("referral_disclosure_requirements"."copy") <= 1000),
	CONSTRAINT "referral_disclosure_requirements_publication_check" CHECK ((("referral_disclosure_requirements"."status" = 'draft') = ("referral_disclosure_requirements"."published_at" is null))
          and (("referral_disclosure_requirements"."status" = 'draft') = ("referral_disclosure_requirements"."published_by_oxy_user_id" is null)))
);
--> statement-breakpoint
CREATE TABLE "referral_enforcement_actions" (
	"id" text PRIMARY KEY NOT NULL,
	"partner_id" text NOT NULL,
	"action" text NOT NULL,
	"scope" text NOT NULL,
	"subject_id" text NOT NULL,
	"program_id" text,
	"basis" text NOT NULL,
	"conduct" text,
	"reason" text NOT NULL,
	"evidence_signal_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone,
	"lifted_at" timestamp with time zone,
	"lifted_by_oxy_user_id" text,
	"lift_reason" text,
	"appeal_state" text DEFAULT 'none' NOT NULL,
	"imposed_by_oxy_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "referral_enforcement_actions_action_check" CHECK ("referral_enforcement_actions"."action" in ('monitoring', 'commission_held', 'attribution_invalidated', 'conversion_rejected', 'partner_warning', 'new_link_suspension', 'new_attribution_suspension', 'payout_hold', 'program_removal', 'partner_termination', 'permanent_restriction', 'cleared')),
	CONSTRAINT "referral_enforcement_actions_scope_check" CHECK ("referral_enforcement_actions"."scope" in ('partner', 'program_partner', 'instrument', 'attribution', 'conversion', 'reward')),
	CONSTRAINT "referral_enforcement_actions_basis_check" CHECK ("referral_enforcement_actions"."basis" in ('risk_signal', 'identity_evidence', 'funding_reversed', 'operator_finding')),
	CONSTRAINT "referral_enforcement_actions_appeal_state_check" CHECK ("referral_enforcement_actions"."appeal_state" in ('none', 'open', 'accepted', 'rejected')),
	CONSTRAINT "referral_enforcement_actions_conduct_check" CHECK ("referral_enforcement_actions"."conduct" in ('self_or_related_party_referral', 'multi_level_recruitment', 'cookie_stuffing_or_forced_clicks', 'spam_or_unsolicited_messaging', 'misleading_earnings_or_product_claims', 'impersonation', 'unauthorized_trademark_bidding', 'unapproved_incentivized_promotion', 'fake_reviews_or_undisclosed_sponsorship', 'automated_account_or_checkout_creation', 'fraudulent_purchase_or_dispute', 'merchant_event_manipulation', 'disclosure_failure', 'restricted_geography_or_audience', 'partner_account_sharing_or_sale', 'referred_customer_data_access')),
	CONSTRAINT "referral_enforcement_actions_forfeiture_basis_check" CHECK ("referral_enforcement_actions"."action" not in ('attribution_invalidated', 'conversion_rejected')
          or "referral_enforcement_actions"."basis" in ('identity_evidence', 'funding_reversed', 'operator_finding')),
	CONSTRAINT "referral_enforcement_actions_signal_evidence_check" CHECK ("referral_enforcement_actions"."basis" <> 'risk_signal' or cardinality("referral_enforcement_actions"."evidence_signal_ids") >= 1),
	CONSTRAINT "referral_enforcement_actions_program_shape_check" CHECK (("referral_enforcement_actions"."scope" = 'program_partner') = ("referral_enforcement_actions"."program_id" is not null)),
	CONSTRAINT "referral_enforcement_actions_lift_shape_check" CHECK (num_nonnulls("referral_enforcement_actions"."lifted_at", "referral_enforcement_actions"."lifted_by_oxy_user_id", "referral_enforcement_actions"."lift_reason") in (0, 3)),
	CONSTRAINT "referral_enforcement_actions_window_check" CHECK (("referral_enforcement_actions"."expires_at" is null or "referral_enforcement_actions"."expires_at" > "referral_enforcement_actions"."starts_at")
          and ("referral_enforcement_actions"."lifted_at" is null or "referral_enforcement_actions"."lifted_at" >= "referral_enforcement_actions"."starts_at")),
	CONSTRAINT "referral_enforcement_actions_reason_check" CHECK (length("referral_enforcement_actions"."reason") > 0 and length("referral_enforcement_actions"."reason") <= 2000
          and ("referral_enforcement_actions"."lift_reason" is null
               or (length("referral_enforcement_actions"."lift_reason") > 0
                   and length("referral_enforcement_actions"."lift_reason") <= 2000))),
	CONSTRAINT "referral_enforcement_actions_identity_check" CHECK (length("referral_enforcement_actions"."imposed_by_oxy_user_id") > 0 and length("referral_enforcement_actions"."subject_id") > 0),
	CONSTRAINT "referral_enforcement_actions_cleared_shape_check" CHECK ("referral_enforcement_actions"."action" <> 'cleared'
          or ("referral_enforcement_actions"."expires_at" is null and "referral_enforcement_actions"."lifted_at" is null))
);
--> statement-breakpoint
CREATE TABLE "referral_enforcement_appeals" (
	"id" text PRIMARY KEY NOT NULL,
	"action_id" text NOT NULL,
	"partner_id" text NOT NULL,
	"state" text DEFAULT 'open' NOT NULL,
	"imposed_by_oxy_user_id" text NOT NULL,
	"submitted_by_oxy_user_id" text NOT NULL,
	"submitted_reason" text NOT NULL,
	"submitted_at" timestamp with time zone NOT NULL,
	"decided_by_oxy_user_id" text,
	"decision_reason" text,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "referral_enforcement_appeals_state_check" CHECK ("referral_enforcement_appeals"."state" in ('none', 'open', 'accepted', 'rejected')),
	CONSTRAINT "referral_enforcement_appeals_live_state_check" CHECK ("referral_enforcement_appeals"."state" <> 'none'),
	CONSTRAINT "referral_enforcement_appeals_independence_check" CHECK ("referral_enforcement_appeals"."decided_by_oxy_user_id" is distinct from "referral_enforcement_appeals"."imposed_by_oxy_user_id"
          and "referral_enforcement_appeals"."decided_by_oxy_user_id" is distinct from "referral_enforcement_appeals"."submitted_by_oxy_user_id"),
	CONSTRAINT "referral_enforcement_appeals_decision_shape_check" CHECK ((("referral_enforcement_appeals"."state" = 'open') = ("referral_enforcement_appeals"."decided_by_oxy_user_id" is null))
          and (("referral_enforcement_appeals"."state" = 'open') = ("referral_enforcement_appeals"."decided_at" is null))),
	CONSTRAINT "referral_enforcement_appeals_reason_check" CHECK (length("referral_enforcement_appeals"."submitted_reason") > 0
          and length("referral_enforcement_appeals"."submitted_reason") <= 2000
          and ("referral_enforcement_appeals"."decision_reason" is null
               or (length("referral_enforcement_appeals"."decision_reason") > 0
                   and length("referral_enforcement_appeals"."decision_reason") <= 2000))),
	CONSTRAINT "referral_enforcement_appeals_identity_check" CHECK (length("referral_enforcement_appeals"."submitted_by_oxy_user_id") > 0 and length("referral_enforcement_appeals"."imposed_by_oxy_user_id") > 0),
	CONSTRAINT "referral_enforcement_appeals_time_check" CHECK ("referral_enforcement_appeals"."decided_at" is null or "referral_enforcement_appeals"."decided_at" >= "referral_enforcement_appeals"."submitted_at")
);
--> statement-breakpoint
CREATE TABLE "referral_risk_signals" (
	"id" text PRIMARY KEY NOT NULL,
	"partner_id" text NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" text NOT NULL,
	"program_id" text,
	"kind" text NOT NULL,
	"severity" text NOT NULL,
	"observed_value" integer NOT NULL,
	"threshold_value" integer,
	"window_start" timestamp with time zone NOT NULL,
	"window_end" timestamp with time zone NOT NULL,
	"evidence_ref" text,
	"recorded_by_kind" text NOT NULL,
	"recorded_by_oxy_user_id" text,
	"note" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "referral_risk_signals_subject_type_check" CHECK ("referral_risk_signals"."subject_type" in ('partner', 'attribution', 'conversion', 'reward')),
	CONSTRAINT "referral_risk_signals_kind_check" CHECK ("referral_risk_signals"."kind" in ('declared_related_party', 'referred_account_maturity', 'repeated_conversion_pattern', 'refund_dispute_concentration', 'merchant_membership_overlap', 'shared_payout_beneficiary', 'provider_risk_outcome', 'instrument_distribution_anomaly', 'click_to_conversion_pattern', 'market_mismatch', 'repeated_cap_attempt', 'source_event_inconsistency', 'prior_confirmed_enforcement', 'manual_evidence')),
	CONSTRAINT "referral_risk_signals_severity_check" CHECK ("referral_risk_signals"."severity" in ('informational', 'elevated', 'high')),
	CONSTRAINT "referral_risk_signals_recorded_by_check" CHECK ("referral_risk_signals"."recorded_by_kind" in ('system', 'operator')
          and (("referral_risk_signals"."recorded_by_kind" = 'operator') = ("referral_risk_signals"."recorded_by_oxy_user_id" is not null))),
	CONSTRAINT "referral_risk_signals_manual_kind_check" CHECK ("referral_risk_signals"."kind" <> 'manual_evidence' or "referral_risk_signals"."recorded_by_kind" = 'operator'),
	CONSTRAINT "referral_risk_signals_window_check" CHECK ("referral_risk_signals"."window_end" >= "referral_risk_signals"."window_start"),
	CONSTRAINT "referral_risk_signals_value_check" CHECK ("referral_risk_signals"."observed_value" >= 0),
	CONSTRAINT "referral_risk_signals_threshold_check" CHECK ("referral_risk_signals"."threshold_value" is null or "referral_risk_signals"."threshold_value" >= 0),
	CONSTRAINT "referral_risk_signals_note_check" CHECK ("referral_risk_signals"."note" is null
          or (length("referral_risk_signals"."note") > 0 and length("referral_risk_signals"."note") <= 2000)),
	CONSTRAINT "referral_risk_signals_expiry_check" CHECK ("referral_risk_signals"."expires_at" > "referral_risk_signals"."window_end")
);
--> statement-breakpoint
ALTER TABLE "referral_attributions" DROP CONSTRAINT "referral_attributions_conflict_reason_check";--> statement-breakpoint
ALTER TABLE "referral_events" DROP CONSTRAINT "referral_events_subject_type_check";--> statement-breakpoint
ALTER TABLE "referral_events" DROP CONSTRAINT "referral_events_action_check";--> statement-breakpoint
ALTER TABLE "referral_enforcement_actions" ADD CONSTRAINT "referral_enforcement_actions_partner_id_referral_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."referral_partners"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referral_enforcement_appeals" ADD CONSTRAINT "referral_enforcement_appeals_action_id_referral_enforcement_actions_id_fk" FOREIGN KEY ("action_id") REFERENCES "public"."referral_enforcement_actions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referral_enforcement_appeals" ADD CONSTRAINT "referral_enforcement_appeals_partner_id_referral_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."referral_partners"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referral_risk_signals" ADD CONSTRAINT "referral_risk_signals_partner_id_referral_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."referral_partners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "referral_conduct_policies_version_key" ON "referral_conduct_policies" USING btree ("policy_key","version");--> statement-breakpoint
CREATE UNIQUE INDEX "referral_conduct_policies_active_key" ON "referral_conduct_policies" USING btree ("policy_key") WHERE "referral_conduct_policies"."status" = 'active';--> statement-breakpoint
CREATE INDEX "referral_conduct_policies_terms_version_idx" ON "referral_conduct_policies" USING btree ("terms_version");--> statement-breakpoint
CREATE UNIQUE INDEX "referral_disclosure_requirements_version_key" ON "referral_disclosure_requirements" USING btree ("disclosure_key","surface","market","language","version");--> statement-breakpoint
CREATE UNIQUE INDEX "referral_disclosure_requirements_active_key" ON "referral_disclosure_requirements" USING btree ("disclosure_key","surface","market","language") WHERE "referral_disclosure_requirements"."status" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "referral_enforcement_actions_live_key" ON "referral_enforcement_actions" USING btree ("scope","subject_id","action") WHERE "referral_enforcement_actions"."lifted_at" is null;--> statement-breakpoint
CREATE INDEX "referral_enforcement_actions_partner_live_idx" ON "referral_enforcement_actions" USING btree ("partner_id","action") WHERE "referral_enforcement_actions"."lifted_at" is null;--> statement-breakpoint
CREATE INDEX "referral_enforcement_actions_partner_created_at_idx" ON "referral_enforcement_actions" USING btree ("partner_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "referral_enforcement_appeals_open_key" ON "referral_enforcement_appeals" USING btree ("action_id") WHERE "referral_enforcement_appeals"."state" = 'open';--> statement-breakpoint
CREATE INDEX "referral_enforcement_appeals_partner_idx" ON "referral_enforcement_appeals" USING btree ("partner_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "referral_enforcement_appeals_open_idx" ON "referral_enforcement_appeals" USING btree ("submitted_at") WHERE "referral_enforcement_appeals"."state" = 'open';--> statement-breakpoint
CREATE INDEX "referral_risk_signals_partner_created_at_idx" ON "referral_risk_signals" USING btree ("partner_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "referral_risk_signals_subject_idx" ON "referral_risk_signals" USING btree ("subject_type","subject_id");--> statement-breakpoint
CREATE INDEX "referral_risk_signals_expires_at_idx" ON "referral_risk_signals" USING btree ("expires_at");--> statement-breakpoint
ALTER TABLE "referral_attributions" ADD CONSTRAINT "referral_attributions_conflict_reason_check" CHECK ("referral_attributions"."conflict_reason" in ('competing_touch', 'duplicate_subject', 'self_referral', 'partner_suspended', 'program_retired', 'operator_correction', 'operator_invalidation', 'enforcement_suspended', 'other'));--> statement-breakpoint
ALTER TABLE "referral_events" ADD CONSTRAINT "referral_events_subject_type_check" CHECK ("referral_events"."subject_type" in ('program', 'partner', 'code', 'link', 'attribution', 'conversion', 'reward_rule', 'reward', 'payout_batch', 'conduct_policy', 'disclosure_requirement'));--> statement-breakpoint
ALTER TABLE "referral_events" ADD CONSTRAINT "referral_events_action_check" CHECK ("referral_events"."action" in ('program_drafted', 'program_published', 'program_paused', 'program_resumed', 'program_ended', 'program_retired', 'program_controls_set', 'partner_applied', 'partner_invited', 'partner_approved', 'partner_suspended', 'partner_reinstated', 'partner_terminated', 'appeal_opened', 'appeal_resolved', 'code_issued', 'code_retired', 'link_issued', 'link_revoked', 'attribution_created', 'attribution_superseded', 'attribution_refused', 'attribution_invalidated', 'attribution_corrected', 'subject_merge_redirected', 'conversion_recorded', 'conversion_verified', 'conversion_rejected', 'conversion_reversed', 'conversion_corrected', 'reward_rule_drafted', 'reward_rule_activated', 'reward_rule_superseded', 'reward_rule_retired', 'reward_accrued', 'reward_accrual_refused', 'reward_reversed', 'reward_voided', 'reward_vested', 'reward_frozen', 'reward_unfrozen', 'reward_payout_settled', 'reward_clawback_recorded', 'payout_batch_opened', 'payout_batch_approved', 'payout_batch_settled', 'payout_batch_failed', 'payout_batch_cancelled', 'partner_recovery_recorded', 'earnings_discrepancy_recorded', 'earnings_discrepancy_resolved', 'partner_tax_profile_declared', 'partner_readiness_synced', 'partner_application_started', 'partner_application_withdrawn', 'partner_application_review_started', 'partner_application_rejected', 'partner_application_changes_requested', 'partner_terms_accepted', 'partner_marketing_consent_set', 'partner_enforcement_imposed', 'partner_enforcement_lifted', 'partner_enforcement_appealed', 'partner_enforcement_appeal_decided', 'partner_risk_signal_recorded', 'conduct_policy_drafted', 'conduct_policy_activated', 'disclosure_requirement_drafted', 'disclosure_requirement_activated'));--> statement-breakpoint
-- oxy:handwritten-begin=referral_risk_signals_append_only
-- `referral_risk_signals` refuses UPDATE and PERMITS DELETE.
--
-- Append-only against UPDATE is what stops a signal being retuned after the
-- fact to justify an action taken on it: the row says what was observed, over
-- which window, against which threshold, and an editable observation is not
-- evidence of anything.
--
-- DELETE is deliberately permitted — the `analytics_events` and
-- `offer_price_snapshots` posture, inverting the ledger's. Erasure on a
-- schedule IS the retention policy here (`REFERRAL_RETENTION_POLICY.risk_signal`,
-- 400 days, driven off `expires_at` through `db/expiryTargets.ts`), and a
-- trigger refusing it would make the shared sweep fail SILENTLY on every row it
-- was contractually obliged to remove.
CREATE OR REPLACE FUNCTION mercaria_referral_risk_signals_append_only()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'referral_risk_signals is append-only (%)', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER mercaria_referral_risk_signals_append_only
BEFORE UPDATE ON "referral_risk_signals"
FOR EACH ROW EXECUTE FUNCTION mercaria_referral_risk_signals_append_only();
-- oxy:handwritten-end=referral_risk_signals_append_only
--> statement-breakpoint
-- oxy:handwritten-begin=referral_enforcement_actions_decision_freeze
-- An enforcement DECISION is frozen; only the lift and the appeal state move.
--
-- #148 acceptance 3 asks that enforcement be "reversible through compensating
-- records", and this is what makes that the ONLY available shape rather than
-- the one somebody chose: lifting appends three columns, it does not rewrite
-- the reason, the basis, the evidence, the scope or the actor. An operator who
-- could edit `basis` from `risk_signal` to `identity_evidence` after the fact
-- would walk straight around
-- `referral_enforcement_actions_forfeiture_basis_check`, since a CHECK is
-- evaluated per statement and the forfeiting action would already be recorded.
--
-- DELETE is refused outright. An enforcement record somebody can remove is not
-- an audit trail, and unlike a risk signal this table has no retention
-- deadline: the decision is retained with the financial record it explains.
--
-- The lift columns are compared with IS DISTINCT FROM rather than <>, because
-- <> against a NULL yields NULL and the whole condition would then be NULL —
-- which `IF NOT (...)` treats as false, silently permitting every edit on a row
-- whose lift columns are still unset. That is every live row.
CREATE OR REPLACE FUNCTION mercaria_referral_enforcement_actions_freeze()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'referral_enforcement_actions rows are never deleted'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.partner_id IS DISTINCT FROM OLD.partner_id
     OR NEW.action IS DISTINCT FROM OLD.action
     OR NEW.scope IS DISTINCT FROM OLD.scope
     OR NEW.subject_id IS DISTINCT FROM OLD.subject_id
     OR NEW.program_id IS DISTINCT FROM OLD.program_id
     OR NEW.basis IS DISTINCT FROM OLD.basis
     OR NEW.conduct IS DISTINCT FROM OLD.conduct
     OR NEW.reason IS DISTINCT FROM OLD.reason
     OR NEW.evidence_signal_ids IS DISTINCT FROM OLD.evidence_signal_ids
     OR NEW.starts_at IS DISTINCT FROM OLD.starts_at
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
     OR NEW.imposed_by_oxy_user_id IS DISTINCT FROM OLD.imposed_by_oxy_user_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'an enforcement decision is frozen; only the lift and the appeal state may move'
      USING ERRCODE = 'restrict_violation';
  END IF;
  -- A lift happens ONCE. Re-lifting would let a second operator replace the
  -- first one's reason, which is the same erasure the freeze above prevents.
  IF OLD.lifted_at IS NOT NULL AND NEW.lifted_at IS DISTINCT FROM OLD.lifted_at THEN
    RAISE EXCEPTION 'an enforcement action is lifted once'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER mercaria_referral_enforcement_actions_freeze
BEFORE UPDATE OR DELETE ON "referral_enforcement_actions"
FOR EACH ROW EXECUTE FUNCTION mercaria_referral_enforcement_actions_freeze();
-- oxy:handwritten-end=referral_enforcement_actions_decision_freeze
--> statement-breakpoint
-- oxy:handwritten-begin=referral_enforcement_appeals_append_only
-- An appeal is append-only with ONE precise exception: the three decision
-- columns moving NULL -> a value exactly once, plus the state leaving `open`.
--
-- An appeal somebody could delete is not an appeal path, it is a suggestion
-- box; an appeal somebody could re-decide is one a second reviewer overturns
-- without the first decision surviving. The submission is frozen outright,
-- including `imposed_by_oxy_user_id`, which is the snapshot the independence
-- CHECK compares against — an editable snapshot would let a decider make
-- themselves independent of an action they imposed.
CREATE OR REPLACE FUNCTION mercaria_referral_enforcement_appeals_append_only()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'referral_enforcement_appeals rows are never deleted'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.action_id IS DISTINCT FROM OLD.action_id
     OR NEW.partner_id IS DISTINCT FROM OLD.partner_id
     OR NEW.imposed_by_oxy_user_id IS DISTINCT FROM OLD.imposed_by_oxy_user_id
     OR NEW.submitted_by_oxy_user_id IS DISTINCT FROM OLD.submitted_by_oxy_user_id
     OR NEW.submitted_reason IS DISTINCT FROM OLD.submitted_reason
     OR NEW.submitted_at IS DISTINCT FROM OLD.submitted_at
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'an appeal submission is frozen'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.state <> 'open' THEN
    RAISE EXCEPTION 'an appeal is decided once (was %)', OLD.state
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER mercaria_referral_enforcement_appeals_append_only
BEFORE UPDATE OR DELETE ON "referral_enforcement_appeals"
FOR EACH ROW EXECUTE FUNCTION mercaria_referral_enforcement_appeals_append_only();
-- oxy:handwritten-end=referral_enforcement_appeals_append_only
--> statement-breakpoint
-- oxy:handwritten-begin=referral_conduct_policies_immutable
-- A conduct-policy version is immutable once it leaves `draft` — the
-- `fee_schedules` / `referral_reward_rules` device.
--
-- A partner accepted the version that was live when they accepted, and their
-- `referral_terms_acceptances` row points at it. Editing it retroactively makes
-- that pointer name something that no longer exists, which is the difference
-- between a rule people are held to and a rule that can be rewritten after they
-- broke it. A policy change is a NEW version.
--
-- The `draft -> active` publication is the ONE permitted transition, and only
-- three columns may move with it.
CREATE OR REPLACE FUNCTION mercaria_referral_conduct_policies_immutable()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN
      RAISE EXCEPTION 'a published conduct policy version is never deleted'
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.status = 'draft' THEN
    RETURN NEW;
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status
     AND OLD.status = 'active' AND NEW.status = 'superseded' THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'a published conduct policy version is immutable (% -> %)', OLD.status, NEW.status
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER mercaria_referral_conduct_policies_immutable
BEFORE UPDATE OR DELETE ON "referral_conduct_policies"
FOR EACH ROW EXECUTE FUNCTION mercaria_referral_conduct_policies_immutable();
-- oxy:handwritten-end=referral_conduct_policies_immutable
--> statement-breakpoint
-- oxy:handwritten-begin=referral_disclosure_requirements_immutable
-- A disclosure version is immutable once it leaves `draft`, for the same reason
-- and by the same shape as the conduct policy above: the copy a partner was
-- asked to render is what they will be judged against, and editing it after the
-- fact makes a `disclosure_failure` finding uncontestable.
CREATE OR REPLACE FUNCTION mercaria_referral_disclosure_requirements_immutable()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN
      RAISE EXCEPTION 'a published disclosure version is never deleted'
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.status = 'draft' THEN
    RETURN NEW;
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status
     AND OLD.status = 'active' AND NEW.status = 'superseded' THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'a published disclosure version is immutable (% -> %)', OLD.status, NEW.status
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER mercaria_referral_disclosure_requirements_immutable
BEFORE UPDATE OR DELETE ON "referral_disclosure_requirements"
FOR EACH ROW EXECUTE FUNCTION mercaria_referral_disclosure_requirements_immutable();
-- oxy:handwritten-end=referral_disclosure_requirements_immutable
