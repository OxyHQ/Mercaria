-- oxy:deploy-phase=pre
--
-- The bounded referral pilots (#149): four additive tables, three trigger
-- pairs, and ONE widening of `referral_attributions_conflict_reason_check` by
-- the single member `pilot_not_admitted` (nine values become ten; nothing is
-- removed, verified element by element against `REFERRAL_CONFLICT_REASONS`).
--
-- `pre`, and the widening is why it stays `pre`: the serving image never writes
-- `pilot_not_admitted`, so the drop-and-re-add pair breaks no write it performs
-- and only admits one the NEXT image will. The four tables are additive and the
-- gate that reads them ships in the same release.
--
-- HAND-WRITTEN STATEMENTS LIVE BELOW THE MARKER AT THE FOOT OF THIS FILE.
-- `db:generate` DROPS them on a regeneration (drizzle-kit cannot model a
-- trigger), so after regenerating: re-append the block, then grep this file for
-- each function/trigger pair and for exactly one deploy-phase marker line.
-- Three branches in one earlier batch lost their triggers here; all three
-- applied cleanly and enforced nothing.
CREATE TABLE "referral_pilot_cohorts" (
	"id" text PRIMARY KEY NOT NULL,
	"cohort_key" text NOT NULL,
	"version" integer NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"subject" text NOT NULL,
	"legal_entity" text NOT NULL,
	"program_owner_oxy_user_id" text NOT NULL,
	"program_id" text NOT NULL,
	"program_version_id" text NOT NULL,
	"markets" text[] DEFAULT '{}' NOT NULL,
	"payout_currency" text NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"max_attributions_per_partner" integer NOT NULL,
	"max_attributions_total" integer NOT NULL,
	"reward_budget_amount" bigint NOT NULL,
	"reward_budget_currency" text NOT NULL,
	"manual_review_required" boolean DEFAULT true NOT NULL,
	"supersedes_cohort_id" text,
	"published_at" timestamp with time zone,
	"published_by_oxy_user_id" text,
	"superseded_at" timestamp with time zone,
	"review_decision" text,
	"reviewed_at" timestamp with time zone,
	"reviewed_by_oxy_user_id" text,
	"review_rationale" text,
	"rationale" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "referral_pilot_cohorts_status_check" CHECK ("referral_pilot_cohorts"."status" in ('draft', 'active', 'superseded', 'closed')),
	CONSTRAINT "referral_pilot_cohorts_subject_check" CHECK ("referral_pilot_cohorts"."subject" in ('customer_acquisition', 'merchant_acquisition')),
	CONSTRAINT "referral_pilot_cohorts_review_decision_check" CHECK ("referral_pilot_cohorts"."review_decision" in ('continue', 'modify', 'expand', 'pause', 'end')),
	CONSTRAINT "referral_pilot_cohorts_payout_currency_check" CHECK ("referral_pilot_cohorts"."payout_currency" in ('FAIR', 'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF', 'CNY', 'SEK', 'NOK', 'DKK', 'PLN', 'MXN', 'BRL', 'INR', 'NZD', 'ZAR', 'SGD', 'HKD', 'AED')),
	CONSTRAINT "referral_pilot_cohorts_reward_budget_currency_check" CHECK ("referral_pilot_cohorts"."reward_budget_currency" in ('FAIR', 'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF', 'CNY', 'SEK', 'NOK', 'DKK', 'PLN', 'MXN', 'BRL', 'INR', 'NZD', 'ZAR', 'SGD', 'HKD', 'AED')),
	CONSTRAINT "referral_pilot_cohorts_version_check" CHECK ("referral_pilot_cohorts"."version" >= 1),
	CONSTRAINT "referral_pilot_cohorts_supersedes_check" CHECK (("referral_pilot_cohorts"."version" = 1) = ("referral_pilot_cohorts"."supersedes_cohort_id" is null)),
	CONSTRAINT "referral_pilot_cohorts_window_check" CHECK ("referral_pilot_cohorts"."ends_at" > "referral_pilot_cohorts"."starts_at"),
	CONSTRAINT "referral_pilot_cohorts_caps_check" CHECK ("referral_pilot_cohorts"."max_attributions_per_partner" >= 1
          and "referral_pilot_cohorts"."max_attributions_total" >= "referral_pilot_cohorts"."max_attributions_per_partner"
          and "referral_pilot_cohorts"."reward_budget_amount" > 0),
	CONSTRAINT "referral_pilot_cohorts_markets_check" CHECK ("referral_pilot_cohorts"."status" = 'draft'
          or (coalesce(cardinality("referral_pilot_cohorts"."markets"), 0) >= 1
              and array_to_string("referral_pilot_cohorts"."markets", ',') ~ '^[A-Z]{2}(,[A-Z]{2})*$')),
	CONSTRAINT "referral_pilot_cohorts_publication_check" CHECK (("referral_pilot_cohorts"."status" = 'draft')
          or ("referral_pilot_cohorts"."published_at" is not null and "referral_pilot_cohorts"."published_by_oxy_user_id" is not null)),
	CONSTRAINT "referral_pilot_cohorts_superseded_check" CHECK (("referral_pilot_cohorts"."status" = 'superseded') = ("referral_pilot_cohorts"."superseded_at" is not null)),
	CONSTRAINT "referral_pilot_cohorts_review_check" CHECK (num_nonnulls("referral_pilot_cohorts"."review_decision", "referral_pilot_cohorts"."reviewed_at", "referral_pilot_cohorts"."reviewed_by_oxy_user_id",
                       "referral_pilot_cohorts"."review_rationale") in (0, 4)),
	CONSTRAINT "referral_pilot_cohorts_closed_check" CHECK ("referral_pilot_cohorts"."status" <> 'closed' or "referral_pilot_cohorts"."reviewed_at" is not null)
);
--> statement-breakpoint
CREATE TABLE "referral_pilot_partners" (
	"id" text PRIMARY KEY NOT NULL,
	"cohort_id" text NOT NULL,
	"partner_id" text NOT NULL,
	"added_by_oxy_user_id" text NOT NULL,
	"note" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "referral_pilot_partners_note_check" CHECK (length("referral_pilot_partners"."note") > 0)
);
--> statement-breakpoint
CREATE TABLE "referral_pilot_stop_thresholds" (
	"id" text PRIMARY KEY NOT NULL,
	"cohort_id" text NOT NULL,
	"metric" text NOT NULL,
	"unit" text NOT NULL,
	"threshold_value" bigint NOT NULL,
	"window_hours" integer NOT NULL,
	"scope" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "referral_pilot_stop_thresholds_metric_check" CHECK ("referral_pilot_stop_thresholds"."metric" in ('negative_net_contribution', 'refund_or_dispute_rate', 'self_referral_or_account_farm_rate', 'attribution_conflict_rate', 'payout_mismatch', 'partner_support_backlog', 'disclosure_complaints', 'privacy_incident', 'provider_or_ledger_reconciliation_failure', 'program_budget_exhaustion', 'merchant_quality_deterioration', 'security_finding')),
	CONSTRAINT "referral_pilot_stop_thresholds_unit_check" CHECK ("referral_pilot_stop_thresholds"."unit" in ('rate_bps', 'count', 'minor_units', 'hours')),
	CONSTRAINT "referral_pilot_stop_thresholds_scope_check" CHECK ("referral_pilot_stop_thresholds"."scope" in ('pilot', 'partner', 'market')),
	CONSTRAINT "referral_pilot_stop_thresholds_value_check" CHECK ("referral_pilot_stop_thresholds"."threshold_value" >= 0 and "referral_pilot_stop_thresholds"."window_hours" >= 0
          and ("referral_pilot_stop_thresholds"."unit" <> 'rate_bps' or "referral_pilot_stop_thresholds"."threshold_value" <= 10000))
);
--> statement-breakpoint
CREATE TABLE "referral_pilot_stops" (
	"id" text PRIMARY KEY NOT NULL,
	"cohort_id" text NOT NULL,
	"metric" text NOT NULL,
	"scope" text NOT NULL,
	"scope_ref" text NOT NULL,
	"origin" text NOT NULL,
	"observed_value" bigint NOT NULL,
	"threshold_value" bigint NOT NULL,
	"raised_at" timestamp with time zone NOT NULL,
	"raised_by_oxy_user_id" text,
	"detail" text NOT NULL,
	"lifted_at" timestamp with time zone,
	"lifted_by_oxy_user_id" text,
	"lift_reason" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "referral_pilot_stops_metric_check" CHECK ("referral_pilot_stops"."metric" in ('negative_net_contribution', 'refund_or_dispute_rate', 'self_referral_or_account_farm_rate', 'attribution_conflict_rate', 'payout_mismatch', 'partner_support_backlog', 'disclosure_complaints', 'privacy_incident', 'provider_or_ledger_reconciliation_failure', 'program_budget_exhaustion', 'merchant_quality_deterioration', 'security_finding')),
	CONSTRAINT "referral_pilot_stops_scope_check" CHECK ("referral_pilot_stops"."scope" in ('pilot', 'partner', 'market')),
	CONSTRAINT "referral_pilot_stops_origin_check" CHECK ("referral_pilot_stops"."origin" in ('automatic', 'operator')),
	CONSTRAINT "referral_pilot_stops_origin_raiser_check" CHECK (("referral_pilot_stops"."origin" = 'operator') = ("referral_pilot_stops"."raised_by_oxy_user_id" is not null)),
	CONSTRAINT "referral_pilot_stops_lift_check" CHECK (num_nonnulls("referral_pilot_stops"."lifted_at", "referral_pilot_stops"."lifted_by_oxy_user_id", "referral_pilot_stops"."lift_reason") in (0, 3)),
	CONSTRAINT "referral_pilot_stops_scope_ref_check" CHECK (("referral_pilot_stops"."scope" = 'pilot') = ("referral_pilot_stops"."scope_ref" = ''))
);
--> statement-breakpoint
ALTER TABLE "referral_attributions" DROP CONSTRAINT "referral_attributions_conflict_reason_check";--> statement-breakpoint
ALTER TABLE "referral_pilot_cohorts" ADD CONSTRAINT "referral_pilot_cohorts_program_version_id_referral_programs_id_fk" FOREIGN KEY ("program_version_id") REFERENCES "public"."referral_programs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referral_pilot_cohorts" ADD CONSTRAINT "referral_pilot_cohorts_supersedes_cohort_id_referral_pilot_cohorts_id_fk" FOREIGN KEY ("supersedes_cohort_id") REFERENCES "public"."referral_pilot_cohorts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referral_pilot_partners" ADD CONSTRAINT "referral_pilot_partners_cohort_id_referral_pilot_cohorts_id_fk" FOREIGN KEY ("cohort_id") REFERENCES "public"."referral_pilot_cohorts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referral_pilot_partners" ADD CONSTRAINT "referral_pilot_partners_partner_id_referral_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."referral_partners"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referral_pilot_stop_thresholds" ADD CONSTRAINT "referral_pilot_stop_thresholds_cohort_id_referral_pilot_cohorts_id_fk" FOREIGN KEY ("cohort_id") REFERENCES "public"."referral_pilot_cohorts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referral_pilot_stops" ADD CONSTRAINT "referral_pilot_stops_cohort_id_referral_pilot_cohorts_id_fk" FOREIGN KEY ("cohort_id") REFERENCES "public"."referral_pilot_cohorts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "referral_pilot_cohorts_key_version_key" ON "referral_pilot_cohorts" USING btree ("cohort_key","version");--> statement-breakpoint
CREATE UNIQUE INDEX "referral_pilot_cohorts_active_program_key" ON "referral_pilot_cohorts" USING btree ("program_id") WHERE "referral_pilot_cohorts"."status" = 'active';--> statement-breakpoint
CREATE INDEX "referral_pilot_cohorts_key_idx" ON "referral_pilot_cohorts" USING btree ("cohort_key","status");--> statement-breakpoint
CREATE UNIQUE INDEX "referral_pilot_partners_cohort_partner_key" ON "referral_pilot_partners" USING btree ("cohort_id","partner_id");--> statement-breakpoint
CREATE INDEX "referral_pilot_partners_partner_idx" ON "referral_pilot_partners" USING btree ("partner_id");--> statement-breakpoint
CREATE UNIQUE INDEX "referral_pilot_stop_thresholds_cohort_metric_key" ON "referral_pilot_stop_thresholds" USING btree ("cohort_id","metric");--> statement-breakpoint
CREATE UNIQUE INDEX "referral_pilot_stops_live_key" ON "referral_pilot_stops" USING btree ("cohort_id","metric","scope","scope_ref") WHERE "referral_pilot_stops"."lifted_at" is null;--> statement-breakpoint
CREATE INDEX "referral_pilot_stops_cohort_idx" ON "referral_pilot_stops" USING btree ("cohort_id","raised_at");--> statement-breakpoint
ALTER TABLE "referral_attributions" ADD CONSTRAINT "referral_attributions_conflict_reason_check" CHECK ("referral_attributions"."conflict_reason" in ('competing_touch', 'duplicate_subject', 'self_referral', 'partner_suspended', 'program_retired', 'operator_correction', 'operator_invalidation', 'enforcement_suspended', 'pilot_not_admitted', 'other'));
--> statement-breakpoint
-- ===========================================================================
-- HAND-WRITTEN: the three freezes. Re-apply after any `db:generate`.
-- ===========================================================================
--> statement-breakpoint
CREATE OR REPLACE FUNCTION mercaria_freeze_active_referral_pilot_cohort()
RETURNS trigger AS $$
BEGIN
  IF OLD.status = 'draft' THEN
    RETURN NEW;
  END IF;
  IF NEW.cohort_key IS DISTINCT FROM OLD.cohort_key
     OR NEW.version IS DISTINCT FROM OLD.version
     OR NEW.subject IS DISTINCT FROM OLD.subject
     OR NEW.legal_entity IS DISTINCT FROM OLD.legal_entity
     OR NEW.program_owner_oxy_user_id IS DISTINCT FROM OLD.program_owner_oxy_user_id
     OR NEW.program_id IS DISTINCT FROM OLD.program_id
     OR NEW.program_version_id IS DISTINCT FROM OLD.program_version_id
     OR NEW.markets IS DISTINCT FROM OLD.markets
     OR NEW.payout_currency IS DISTINCT FROM OLD.payout_currency
     OR NEW.starts_at IS DISTINCT FROM OLD.starts_at
     OR NEW.ends_at IS DISTINCT FROM OLD.ends_at
     OR NEW.max_attributions_per_partner IS DISTINCT FROM OLD.max_attributions_per_partner
     OR NEW.max_attributions_total IS DISTINCT FROM OLD.max_attributions_total
     OR NEW.reward_budget_amount IS DISTINCT FROM OLD.reward_budget_amount
     OR NEW.reward_budget_currency IS DISTINCT FROM OLD.reward_budget_currency
     OR NEW.manual_review_required IS DISTINCT FROM OLD.manual_review_required
     OR NEW.supersedes_cohort_id IS DISTINCT FROM OLD.supersedes_cohort_id
     OR NEW.published_at IS DISTINCT FROM OLD.published_at
     OR NEW.published_by_oxy_user_id IS DISTINCT FROM OLD.published_by_oxy_user_id
     OR NEW.rationale IS DISTINCT FROM OLD.rationale THEN
    RAISE EXCEPTION
      'referral_pilot_cohorts is immutable once published; publish a new version instead'
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.reviewed_at IS NOT NULL
     AND (NEW.review_decision IS DISTINCT FROM OLD.review_decision
          OR NEW.reviewed_at IS DISTINCT FROM OLD.reviewed_at
          OR NEW.reviewed_by_oxy_user_id IS DISTINCT FROM OLD.reviewed_by_oxy_user_id
          OR NEW.review_rationale IS DISTINCT FROM OLD.review_rationale) THEN
    RAISE EXCEPTION
      'a referral pilot expansion review is written once; record a new version instead'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER mercaria_freeze_active_referral_pilot_cohort
BEFORE UPDATE ON referral_pilot_cohorts
FOR EACH ROW EXECUTE FUNCTION mercaria_freeze_active_referral_pilot_cohort();--> statement-breakpoint
CREATE OR REPLACE FUNCTION mercaria_freeze_published_referral_pilot_children()
RETURNS trigger AS $$
DECLARE
  cohort_status text;
BEGIN
  SELECT status INTO cohort_status FROM referral_pilot_cohorts WHERE id = NEW.cohort_id;
  IF cohort_status IS NOT NULL AND cohort_status <> 'draft' THEN
    RAISE EXCEPTION
      'a published referral pilot cohort cannot gain or change % rows; publish a new version',
      TG_TABLE_NAME
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER mercaria_freeze_published_referral_pilot_partners
BEFORE INSERT OR UPDATE ON referral_pilot_partners
FOR EACH ROW EXECUTE FUNCTION mercaria_freeze_published_referral_pilot_children();--> statement-breakpoint
CREATE TRIGGER mercaria_freeze_published_referral_pilot_thresholds
BEFORE INSERT OR UPDATE ON referral_pilot_stop_thresholds
FOR EACH ROW EXECUTE FUNCTION mercaria_freeze_published_referral_pilot_children();--> statement-breakpoint
CREATE OR REPLACE FUNCTION mercaria_referral_pilot_stops_append_only()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'referral_pilot_stops is append-only' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.lifted_at IS NOT NULL THEN
    RAISE EXCEPTION 'a lifted referral pilot stop is immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.cohort_id IS DISTINCT FROM OLD.cohort_id
     OR NEW.metric IS DISTINCT FROM OLD.metric
     OR NEW.scope IS DISTINCT FROM OLD.scope
     OR NEW.scope_ref IS DISTINCT FROM OLD.scope_ref
     OR NEW.origin IS DISTINCT FROM OLD.origin
     OR NEW.observed_value IS DISTINCT FROM OLD.observed_value
     OR NEW.threshold_value IS DISTINCT FROM OLD.threshold_value
     OR NEW.raised_at IS DISTINCT FROM OLD.raised_at
     OR NEW.raised_by_oxy_user_id IS DISTINCT FROM OLD.raised_by_oxy_user_id
     OR NEW.detail IS DISTINCT FROM OLD.detail THEN
    RAISE EXCEPTION 'only the lift columns of referral_pilot_stops may be updated'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER mercaria_referral_pilot_stops_append_only
BEFORE UPDATE OR DELETE ON referral_pilot_stops
FOR EACH ROW EXECUTE FUNCTION mercaria_referral_pilot_stops_append_only();
