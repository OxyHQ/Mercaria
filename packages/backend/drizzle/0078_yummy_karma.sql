-- oxy:deploy-phase=pre
-- oxy:rollback=restore: referral_events_action_check is widened; the previous form is in 0060 and re-adding it fails against any event carrying an added action
--
-- #143: the two operator levers on a referral program, and the audit action
-- that records somebody pulling one.
--
-- ## Why `pre`
--
-- The real question, not its paraphrase: does any statement here break a write
-- the CURRENTLY SERVING image performs?
--
-- `CREATE TABLE referral_program_controls` cannot — the serving image does not
-- know the table exists, so there is no write to break.
--
-- The `referral_events_action_check` pair is the one worth reading, because a
-- DROP + ADD of a CHECK is the shape a NARROWING takes and a narrowing would be
-- `post`. This one is a strict WIDENING, verified by SET COMPARISON against
-- `origin/main`'s `REFERRAL_EVENT_ACTIONS` rather than by eye: 37 values in,
-- 38 out, removed set EMPTY, added set exactly `{program_controls_set}`. Every
-- row the serving image can write still satisfies it and every row already
-- stored still satisfies it, so it is added VALIDATED rather than `NOT VALID`.
-- Re-run that comparison on any regeneration: the failure direction of getting
-- it wrong is that every existing `referral_events` write starts failing its
-- CHECK in production while the build stays green.
--
-- ## Regeneration note
--
-- Nothing here is hand-written — no trigger, no function body, no backfill — so
-- a regeneration against a later snapshot chain reproduces this file exactly
-- and only this marker block has to be re-applied. It has now survived TWO:
-- this was `0076` until #93 landed, then `0077` until #85/#324 landed, and
-- regenerating behind each against a freshly built `@mercaria/shared-types`
-- produced byte-identical statements both times.

CREATE TABLE "referral_program_controls" (
	"id" text PRIMARY KEY NOT NULL,
	"program_id" text NOT NULL,
	"redirect_enabled" boolean DEFAULT true NOT NULL,
	"attribution_enabled" boolean DEFAULT true NOT NULL,
	"updated_by_oxy_user_id" text NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "referral_program_controls_identity_check" CHECK (length("referral_program_controls"."program_id") > 0 and length("referral_program_controls"."updated_by_oxy_user_id") > 0),
	CONSTRAINT "referral_program_controls_reason_check" CHECK (length("referral_program_controls"."reason") > 0 and length("referral_program_controls"."reason") <= 2000)
);
--> statement-breakpoint
ALTER TABLE "referral_events" DROP CONSTRAINT "referral_events_action_check";--> statement-breakpoint
CREATE UNIQUE INDEX "referral_program_controls_program_id_key" ON "referral_program_controls" USING btree ("program_id");--> statement-breakpoint
ALTER TABLE "referral_events" ADD CONSTRAINT "referral_events_action_check" CHECK ("referral_events"."action" in ('program_drafted', 'program_published', 'program_paused', 'program_resumed', 'program_ended', 'program_retired', 'program_controls_set', 'partner_applied', 'partner_invited', 'partner_approved', 'partner_suspended', 'partner_reinstated', 'partner_terminated', 'appeal_opened', 'appeal_resolved', 'code_issued', 'code_retired', 'link_issued', 'link_revoked', 'attribution_created', 'attribution_superseded', 'attribution_refused', 'attribution_invalidated', 'attribution_corrected', 'subject_merge_redirected', 'conversion_recorded', 'conversion_verified', 'conversion_rejected', 'conversion_reversed', 'conversion_corrected', 'reward_rule_drafted', 'reward_rule_activated', 'reward_rule_superseded', 'reward_rule_retired', 'reward_accrued', 'reward_accrual_refused', 'reward_reversed', 'reward_voided'));