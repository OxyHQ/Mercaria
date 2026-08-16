-- oxy:deploy-phase=pre
--
-- #146 increment 1: the referral partner TAX QUESTIONNAIRE (ADR 0005 D15 gate 2)
-- plus the two `referral_events` actions it and the readiness sync append.
--
-- Additive throughout, which is why the phase is `pre`: one new table, and a
-- WIDENING of `referral_events_action_check` by exactly two members (verified
-- element by element against the built `REFERRAL_EVENT_ACTIONS` — nothing was
-- removed). No statement here breaks a write the serving image performs.
--
-- There is NO withholding column, account or rate anywhere in this migration,
-- and that is the ruling recorded on #146 rather than an omission: ADR 0005 D15
-- has Mercaria withhold nothing and issue an annual earnings statement, so a
-- withheld-tax account would put a remittance obligation in a book nobody
-- reconciles against a tax authority. `referral_payout_batches.withholding_minor`
-- stays where #145 put it and `withholding_not_supported` stays the refusal.
--
-- HAND-WRITTEN BLOCK BELOW. `drizzle-kit generate` models no trigger, so a
-- regeneration DROPS it. On regeneration, re-append the block delimited by the
-- two anchored marker lines below, verbatim, and re-read this file afterwards.

CREATE TABLE "referral_tax_profiles" (
	"id" text PRIMARY KEY NOT NULL,
	"partner_id" text NOT NULL,
	"revision" integer NOT NULL,
	"questionnaire_version" text NOT NULL,
	"participant_type" text NOT NULL,
	"residency_country" text NOT NULL,
	"vat_status" text NOT NULL,
	"declared_at" timestamp with time zone NOT NULL,
	"declared_by_oxy_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "referral_tax_profiles_questionnaire_version_check" CHECK ("referral_tax_profiles"."questionnaire_version" in ('tax-2026-08')),
	CONSTRAINT "referral_tax_profiles_participant_type_check" CHECK ("referral_tax_profiles"."participant_type" in ('individual', 'business')),
	CONSTRAINT "referral_tax_profiles_vat_status_check" CHECK ("referral_tax_profiles"."vat_status" in ('not_registered', 'registered', 'exempt')),
	CONSTRAINT "referral_tax_profiles_residency_country_check" CHECK ("referral_tax_profiles"."residency_country" ~ '^[A-Z]{2}$'),
	CONSTRAINT "referral_tax_profiles_revision_check" CHECK ("referral_tax_profiles"."revision" >= 1),
	CONSTRAINT "referral_tax_profiles_declared_by_check" CHECK (length("referral_tax_profiles"."declared_by_oxy_user_id") > 0)
);
--> statement-breakpoint
ALTER TABLE "referral_events" DROP CONSTRAINT "referral_events_action_check";--> statement-breakpoint
ALTER TABLE "referral_tax_profiles" ADD CONSTRAINT "referral_tax_profiles_partner_id_referral_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."referral_partners"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "referral_tax_profiles_partner_revision_key" ON "referral_tax_profiles" USING btree ("partner_id","revision");--> statement-breakpoint
ALTER TABLE "referral_events" ADD CONSTRAINT "referral_events_action_check" CHECK ("referral_events"."action" in ('program_drafted', 'program_published', 'program_paused', 'program_resumed', 'program_ended', 'program_retired', 'program_controls_set', 'partner_applied', 'partner_invited', 'partner_approved', 'partner_suspended', 'partner_reinstated', 'partner_terminated', 'appeal_opened', 'appeal_resolved', 'code_issued', 'code_retired', 'link_issued', 'link_revoked', 'attribution_created', 'attribution_superseded', 'attribution_refused', 'attribution_invalidated', 'attribution_corrected', 'subject_merge_redirected', 'conversion_recorded', 'conversion_verified', 'conversion_rejected', 'conversion_reversed', 'conversion_corrected', 'reward_rule_drafted', 'reward_rule_activated', 'reward_rule_superseded', 'reward_rule_retired', 'reward_accrued', 'reward_accrual_refused', 'reward_reversed', 'reward_voided', 'reward_vested', 'reward_frozen', 'reward_unfrozen', 'reward_payout_settled', 'reward_clawback_recorded', 'payout_batch_opened', 'payout_batch_approved', 'payout_batch_settled', 'payout_batch_failed', 'payout_batch_cancelled', 'partner_recovery_recorded', 'earnings_discrepancy_recorded', 'earnings_discrepancy_resolved', 'partner_tax_profile_declared', 'partner_readiness_synced'));
--> statement-breakpoint
-- oxy:handwritten-begin=referral_tax_profiles_append_only
-- `referral_tax_profiles` is APPEND-ONLY against UPDATE *and* DELETE.
--
-- A declaration is what an earnings statement is issued against and what a
-- payout gate turned on, so "what did this partner declare when we paid them"
-- has to stay answerable — and an UPDATE is exactly what would make it not. A
-- correction is a NEW revision; the derivation reads the highest.
--
-- DELETE is refused too, unlike `analytics_events` and `offer_price_snapshots`,
-- because nothing sweeps this table: there is no retention deadline on a tax
-- declaration, so a permitted DELETE would be a capability with no legitimate
-- caller rather than a policy a trigger would break.
CREATE OR REPLACE FUNCTION mercaria_referral_tax_profiles_append_only()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'referral_tax_profiles is append-only (%)', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER mercaria_referral_tax_profiles_append_only
BEFORE UPDATE OR DELETE ON "referral_tax_profiles"
FOR EACH ROW EXECUTE FUNCTION mercaria_referral_tax_profiles_append_only();
-- oxy:handwritten-end=referral_tax_profiles_append_only
