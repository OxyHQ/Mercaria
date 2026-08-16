-- oxy:deploy-phase=pre
--
-- #146 increment 2: referral partner ENROLLMENT, application, review and terms
-- acceptance (ADR 0005 D2/D15), plus the tax questionnaire's route reaching a
-- caller for the first time.
--
-- ADDITIVE THROUGHOUT, which is why the phase is `pre`. Three new tables that
-- nothing yet writes; two new columns on `referral_partners`, one of them
-- DEFAULTED so the serving image's INSERT (which names neither) keeps working
-- unchanged; and two CHECK WIDENINGS. Not one statement here breaks a write the
-- previous image performs.
--
-- Both widenings were verified ELEMENT BY ELEMENT against the definitions
-- actually in the chain, not against what the tuples are believed to contain:
--   * `referral_events_action_check`  53 -> 60, previous definition in 0083.
--     Added exactly: partner_application_started, partner_application_withdrawn,
--     partner_application_review_started, partner_application_rejected,
--     partner_application_changes_requested, partner_terms_accepted,
--     partner_marketing_consent_set. Nothing removed.
--   * `referral_partners_state_check`  5 -> 9, previous definition in 0015.
--     Added exactly: draft, under_review, changes_requested, rejected. Nothing
--     removed -- `applied` and `invited` both survive, which matters because
--     `applied` IS #146's "submitted" and every live row carries one of them.
--
-- There is NO withholding column, account or rate anywhere in this migration,
-- and no tax identifier: the D15 ruling recorded on #146 stands unchanged.
--
-- HAND-WRITTEN BLOCKS BELOW. `drizzle-kit generate` models no trigger, so a
-- regeneration DROPS all three. On regeneration, re-append the three blocks
-- delimited by the anchored begin/end marker lines, verbatim and in order, and
-- re-read this whole file afterwards for statements you did not intend. Their
-- names are: referral_partner_application_reviews_append_only,
-- referral_terms_acceptances_append_only, and
-- referral_partner_applications_content_freeze.

CREATE TABLE "referral_partner_application_reviews" (
	"id" text PRIMARY KEY NOT NULL,
	"application_id" text NOT NULL,
	"revision" integer NOT NULL,
	"decision" text NOT NULL,
	"rejection_code" text,
	"partner_message" text,
	"reviewer_note" text,
	"evidence_refs" text[] DEFAULT '{}' NOT NULL,
	"reviewed_by_oxy_user_id" text NOT NULL,
	"reviewed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "referral_partner_application_reviews_decision_check" CHECK ("referral_partner_application_reviews"."decision" in ('approved', 'rejected', 'changes_requested')),
	CONSTRAINT "referral_partner_application_reviews_rejection_code_check" CHECK ("referral_partner_application_reviews"."rejection_code" in ('incomplete_information', 'ineligible_market', 'ineligible_owner_type', 'prohibited_promotion_method', 'duplicate_partner_identity', 'policy_violation', 'not_accepting_applications', 'other')),
	CONSTRAINT "referral_partner_application_reviews_rejection_shape_check" CHECK (("referral_partner_application_reviews"."decision" in ('rejected', 'changes_requested')) = ("referral_partner_application_reviews"."rejection_code" is not null)),
	CONSTRAINT "referral_partner_application_reviews_message_shape_check" CHECK ("referral_partner_application_reviews"."partner_message" is null or "referral_partner_application_reviews"."rejection_code" is not null),
	CONSTRAINT "referral_partner_application_reviews_revision_check" CHECK ("referral_partner_application_reviews"."revision" >= 1),
	CONSTRAINT "referral_partner_application_reviews_reviewer_check" CHECK (length("referral_partner_application_reviews"."reviewed_by_oxy_user_id") > 0),
	CONSTRAINT "referral_partner_application_reviews_message_check" CHECK (("referral_partner_application_reviews"."partner_message" is null or length("referral_partner_application_reviews"."partner_message") between 1 and 500)
          and ("referral_partner_application_reviews"."reviewer_note" is null
               or length("referral_partner_application_reviews"."reviewer_note") between 1 and 2000)),
	CONSTRAINT "referral_partner_application_reviews_evidence_check" CHECK (cardinality("referral_partner_application_reviews"."evidence_refs") <= 20
          and length(array_to_string("referral_partner_application_reviews"."evidence_refs", ' ')) <= 2000)
);
--> statement-breakpoint
CREATE TABLE "referral_partner_applications" (
	"id" text PRIMARY KEY NOT NULL,
	"partner_id" text NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"state" text DEFAULT 'draft' NOT NULL,
	"enrollment_mode" text NOT NULL,
	"program_id" text,
	"promotion_methods" text[] DEFAULT '{}' NOT NULL,
	"promotion_urls" text[] DEFAULT '{}' NOT NULL,
	"audience_band" text DEFAULT 'not_stated' NOT NULL,
	"markets" text[] DEFAULT '{}' NOT NULL,
	"prohibited_methods_acknowledged" boolean DEFAULT false NOT NULL,
	"has_related_party" boolean DEFAULT false NOT NULL,
	"related_party_disclosure" text,
	"review_consent_at" timestamp with time zone,
	"communication_consent_at" timestamp with time zone,
	"submitted_at" timestamp with time zone,
	"submitted_by_oxy_user_id" text,
	"decided_at" timestamp with time zone,
	"decision_code" text,
	"decision_message" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "referral_partner_applications_state_check" CHECK ("referral_partner_applications"."state" in ('draft', 'submitted', 'under_review', 'approved', 'rejected', 'changes_requested', 'withdrawn')),
	CONSTRAINT "referral_partner_applications_enrollment_mode_check" CHECK ("referral_partner_applications"."enrollment_mode" in ('open_application', 'invite_only', 'oxy_self_enrollment', 'verified_organization', 'creator_community_review', 'merchant_referral', 'staff_test', 'operator_legacy')),
	CONSTRAINT "referral_partner_applications_audience_band_check" CHECK ("referral_partner_applications"."audience_band" in ('under_1k', 'from_1k_to_10k', 'from_10k_to_100k', 'over_100k', 'not_stated')),
	CONSTRAINT "referral_partner_applications_decision_code_check" CHECK ("referral_partner_applications"."decision_code" in ('incomplete_information', 'ineligible_market', 'ineligible_owner_type', 'prohibited_promotion_method', 'duplicate_partner_identity', 'policy_violation', 'not_accepting_applications', 'other')),
	CONSTRAINT "referral_partner_applications_promotion_methods_check" CHECK ("referral_partner_applications"."promotion_methods" <@ array['website', 'blog', 'social_media', 'email', 'video', 'podcast', 'events', 'other']::text[]),
	CONSTRAINT "referral_partner_applications_markets_check" CHECK (array_to_string("referral_partner_applications"."markets", ',') ~ '^([A-Z]{2}(,[A-Z]{2})*)?$'),
	CONSTRAINT "referral_partner_applications_promotion_urls_check" CHECK (cardinality("referral_partner_applications"."promotion_urls") <= 10
          and length(array_to_string("referral_partner_applications"."promotion_urls", ' ')) <= 2000
          and array_to_string("referral_partner_applications"."promotion_urls", ' ') ~ '^(https://[^ ]+( https://[^ ]+)*)?$'),
	CONSTRAINT "referral_partner_applications_related_party_check" CHECK ("referral_partner_applications"."has_related_party" = ("referral_partner_applications"."related_party_disclosure" is not null)),
	CONSTRAINT "referral_partner_applications_revision_check" CHECK ("referral_partner_applications"."revision" >= 1),
	CONSTRAINT "referral_partner_applications_submitted_check" CHECK ("referral_partner_applications"."state" in ('draft', 'withdrawn')
          or ("referral_partner_applications"."submitted_at" is not null and "referral_partner_applications"."submitted_by_oxy_user_id" is not null)),
	CONSTRAINT "referral_partner_applications_consent_check" CHECK ("referral_partner_applications"."state" in ('draft', 'withdrawn')
          or ("referral_partner_applications"."prohibited_methods_acknowledged"
              and "referral_partner_applications"."review_consent_at" is not null
              and "referral_partner_applications"."communication_consent_at" is not null)),
	CONSTRAINT "referral_partner_applications_decided_check" CHECK ("referral_partner_applications"."state" not in ('approved', 'rejected', 'changes_requested')
          or "referral_partner_applications"."decided_at" is not null),
	CONSTRAINT "referral_partner_applications_decision_code_shape_check" CHECK (("referral_partner_applications"."state" in ('rejected', 'changes_requested')) = ("referral_partner_applications"."decision_code" is not null)),
	CONSTRAINT "referral_partner_applications_decision_message_shape_check" CHECK ("referral_partner_applications"."decision_message" is null or "referral_partner_applications"."decision_code" is not null),
	CONSTRAINT "referral_partner_applications_decision_message_length_check" CHECK ("referral_partner_applications"."decision_message" is null or length("referral_partner_applications"."decision_message") between 1 and 500),
	CONSTRAINT "referral_partner_applications_related_party_length_check" CHECK ("referral_partner_applications"."related_party_disclosure" is null
          or length("referral_partner_applications"."related_party_disclosure") between 1 and 2000)
);
--> statement-breakpoint
CREATE TABLE "referral_terms_acceptances" (
	"id" text PRIMARY KEY NOT NULL,
	"partner_id" text NOT NULL,
	"scope" text NOT NULL,
	"program_id" text,
	"terms_version" text NOT NULL,
	"accepted_at" timestamp with time zone NOT NULL,
	"accepted_by_oxy_user_id" text NOT NULL,
	"locale" text NOT NULL,
	"acceptance_key" text GENERATED ALWAYS AS ("scope" || '|' || coalesce("program_id", '') || '|' || "terms_version") STORED NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "referral_terms_acceptances_scope_check" CHECK ("referral_terms_acceptances"."scope" in ('partner_agreement', 'program_terms')),
	CONSTRAINT "referral_terms_acceptances_scope_shape_check" CHECK (("referral_terms_acceptances"."scope" = 'program_terms') = ("referral_terms_acceptances"."program_id" is not null)),
	CONSTRAINT "referral_terms_acceptances_agreement_version_check" CHECK ("referral_terms_acceptances"."scope" <> 'partner_agreement'
          or "referral_terms_acceptances"."terms_version" in ('partner-2026-08')),
	CONSTRAINT "referral_terms_acceptances_identity_check" CHECK (length("referral_terms_acceptances"."terms_version") > 0 and length("referral_terms_acceptances"."accepted_by_oxy_user_id") > 0),
	CONSTRAINT "referral_terms_acceptances_locale_check" CHECK ("referral_terms_acceptances"."locale" ~ '^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$')
);
--> statement-breakpoint
ALTER TABLE "referral_events" DROP CONSTRAINT "referral_events_action_check";--> statement-breakpoint
ALTER TABLE "referral_partners" DROP CONSTRAINT "referral_partners_state_check";--> statement-breakpoint
ALTER TABLE "referral_partners" ADD COLUMN "enrollment_mode" text DEFAULT 'open_application' NOT NULL;--> statement-breakpoint
ALTER TABLE "referral_partners" ADD COLUMN "marketing_consent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "referral_partner_application_reviews" ADD CONSTRAINT "referral_partner_application_reviews_application_id_referral_partner_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."referral_partner_applications"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referral_partner_applications" ADD CONSTRAINT "referral_partner_applications_partner_id_referral_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."referral_partners"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referral_terms_acceptances" ADD CONSTRAINT "referral_terms_acceptances_partner_id_referral_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."referral_partners"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "referral_partner_application_reviews_revision_key" ON "referral_partner_application_reviews" USING btree ("application_id","revision");--> statement-breakpoint
CREATE UNIQUE INDEX "referral_partner_applications_live_key" ON "referral_partner_applications" USING btree ("partner_id") WHERE "referral_partner_applications"."state" in ('draft', 'submitted', 'under_review', 'changes_requested', 'approved');--> statement-breakpoint
CREATE INDEX "referral_partner_applications_state_submitted_idx" ON "referral_partner_applications" USING btree ("state","submitted_at");--> statement-breakpoint
CREATE UNIQUE INDEX "referral_terms_acceptances_partner_key" ON "referral_terms_acceptances" USING btree ("partner_id","acceptance_key");--> statement-breakpoint
CREATE INDEX "referral_terms_acceptances_partner_scope_idx" ON "referral_terms_acceptances" USING btree ("partner_id","scope","accepted_at");--> statement-breakpoint
ALTER TABLE "referral_events" ADD CONSTRAINT "referral_events_action_check" CHECK ("referral_events"."action" in ('program_drafted', 'program_published', 'program_paused', 'program_resumed', 'program_ended', 'program_retired', 'program_controls_set', 'partner_applied', 'partner_invited', 'partner_approved', 'partner_suspended', 'partner_reinstated', 'partner_terminated', 'appeal_opened', 'appeal_resolved', 'code_issued', 'code_retired', 'link_issued', 'link_revoked', 'attribution_created', 'attribution_superseded', 'attribution_refused', 'attribution_invalidated', 'attribution_corrected', 'subject_merge_redirected', 'conversion_recorded', 'conversion_verified', 'conversion_rejected', 'conversion_reversed', 'conversion_corrected', 'reward_rule_drafted', 'reward_rule_activated', 'reward_rule_superseded', 'reward_rule_retired', 'reward_accrued', 'reward_accrual_refused', 'reward_reversed', 'reward_voided', 'reward_vested', 'reward_frozen', 'reward_unfrozen', 'reward_payout_settled', 'reward_clawback_recorded', 'payout_batch_opened', 'payout_batch_approved', 'payout_batch_settled', 'payout_batch_failed', 'payout_batch_cancelled', 'partner_recovery_recorded', 'earnings_discrepancy_recorded', 'earnings_discrepancy_resolved', 'partner_tax_profile_declared', 'partner_readiness_synced', 'partner_application_started', 'partner_application_withdrawn', 'partner_application_review_started', 'partner_application_rejected', 'partner_application_changes_requested', 'partner_terms_accepted', 'partner_marketing_consent_set'));--> statement-breakpoint
ALTER TABLE "referral_partners" ADD CONSTRAINT "referral_partners_enrollment_mode_check" CHECK ("referral_partners"."enrollment_mode" in ('open_application', 'invite_only', 'oxy_self_enrollment', 'verified_organization', 'creator_community_review', 'merchant_referral', 'staff_test', 'operator_legacy'));--> statement-breakpoint
ALTER TABLE "referral_partners" ADD CONSTRAINT "referral_partners_state_check" CHECK ("referral_partners"."state" in ('draft', 'applied', 'invited', 'under_review', 'changes_requested', 'rejected', 'approved', 'suspended', 'terminated'));
--> statement-breakpoint
-- oxy:handwritten-begin=referral_partner_application_reviews_append_only
-- `referral_partner_application_reviews` is APPEND-ONLY against UPDATE *and*
-- DELETE.
--
-- #146 review rule 10 asks that every state transition be audited and rule 2
-- that reviewer, reason and evidence be recorded. A trail whose rows can be
-- edited records none of those things, and the case an audit exists for is
-- precisely a reviewer rewriting their own reason afterwards.
--
-- DELETE is refused too, unlike `analytics_events`: nothing sweeps this table,
-- so a permitted DELETE would be a capability with no legitimate caller rather
-- than a retention policy a trigger would silently break.
CREATE OR REPLACE FUNCTION mercaria_referral_application_reviews_append_only()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'referral_partner_application_reviews is append-only (%)', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER mercaria_referral_application_reviews_append_only
BEFORE UPDATE OR DELETE ON "referral_partner_application_reviews"
FOR EACH ROW EXECUTE FUNCTION mercaria_referral_application_reviews_append_only();
-- oxy:handwritten-end=referral_partner_application_reviews_append_only
--> statement-breakpoint
-- oxy:handwritten-begin=referral_terms_acceptances_append_only
-- `referral_terms_acceptances` is APPEND-ONLY against UPDATE *and* DELETE.
--
-- #146 terms rule 3 asks that time, actor, locale and version be stored, and
-- rule 5 that existing earnings retain their original rule and terms snapshots.
-- Exactly one UPDATE breaks both. A re-acceptance after a version bump, and a
-- withdrawal, are NEW rows.
CREATE OR REPLACE FUNCTION mercaria_referral_terms_acceptances_append_only()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'referral_terms_acceptances is append-only (%)', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER mercaria_referral_terms_acceptances_append_only
BEFORE UPDATE OR DELETE ON "referral_terms_acceptances"
FOR EACH ROW EXECUTE FUNCTION mercaria_referral_terms_acceptances_append_only();
-- oxy:handwritten-end=referral_terms_acceptances_append_only
--> statement-breakpoint
-- oxy:handwritten-begin=referral_partner_applications_content_freeze
-- An application's ANSWERS are frozen once they leave the applicant's hands.
--
-- #59's rule -- the set an operator approved is the set that executes --
-- applied to an application rather than to a merge plan, and it is what makes
-- `revision` mean anything: a review row names the revision it READ, so the
-- answers under that number must not be able to move afterwards.
--
-- The editable states are `draft` and `changes_requested`, which is
-- `REFERRAL_APPLICATION_EDITABLE_STATES` in shared-types. `changes_requested`
-- is editable precisely because that state exists so the applicant can respond;
-- an append-only table would have made the one state requiring a rewrite the
-- one state forbidding it, which is why this is a freeze and not an
-- append-only pair like its two siblings above.
--
-- The predicate reads OLD.state, so the transition INTO a frozen state is
-- permitted (a draft may set `submitted_at` on its way to `submitted`) while
-- every later write is held. `is distinct from` throughout, because a plain
-- `<>` against a NULL yields NULL and the comparison would silently pass.
--
-- No STORED GENERATED column is compared here. A `BEFORE UPDATE` trigger sees
-- NULL in `NEW.<generated>` because it is computed after the trigger runs, and
-- a comparison against one raises on every update -- the bug #59 cost a real
-- incident on.
CREATE OR REPLACE FUNCTION mercaria_referral_application_content_freeze()
RETURNS trigger AS $$
BEGIN
  IF OLD.state IN ('draft', 'changes_requested') THEN
    RETURN NEW;
  END IF;

  IF NEW.revision IS DISTINCT FROM OLD.revision
     OR NEW.enrollment_mode IS DISTINCT FROM OLD.enrollment_mode
     OR NEW.program_id IS DISTINCT FROM OLD.program_id
     OR NEW.promotion_methods IS DISTINCT FROM OLD.promotion_methods
     OR NEW.promotion_urls IS DISTINCT FROM OLD.promotion_urls
     OR NEW.audience_band IS DISTINCT FROM OLD.audience_band
     OR NEW.markets IS DISTINCT FROM OLD.markets
     OR NEW.prohibited_methods_acknowledged IS DISTINCT FROM OLD.prohibited_methods_acknowledged
     OR NEW.has_related_party IS DISTINCT FROM OLD.has_related_party
     OR NEW.related_party_disclosure IS DISTINCT FROM OLD.related_party_disclosure
     OR NEW.review_consent_at IS DISTINCT FROM OLD.review_consent_at
     OR NEW.communication_consent_at IS DISTINCT FROM OLD.communication_consent_at
     OR NEW.submitted_at IS DISTINCT FROM OLD.submitted_at
     OR NEW.submitted_by_oxy_user_id IS DISTINCT FROM OLD.submitted_by_oxy_user_id
  THEN
    RAISE EXCEPTION
      'referral_partner_applications answers are frozen in state % (%)', OLD.state, TG_OP
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER mercaria_referral_application_content_freeze
BEFORE UPDATE ON "referral_partner_applications"
FOR EACH ROW EXECUTE FUNCTION mercaria_referral_application_content_freeze();
-- oxy:handwritten-end=referral_partner_applications_content_freeze
