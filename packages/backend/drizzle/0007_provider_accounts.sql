-- oxy:deploy-phase=pre
--
-- Connected-account onboarding (#46): the `provider_accounts` table and one new
-- outbox event type.
--
-- `pre`, and both halves earn it — nothing here narrows:
--
--   * `provider_accounts` is a brand-new table. The image still serving does not
--     select from it, so creating it early is invisible to that image; creating
--     it late would 500 every read the NEW image performs, which is every
--     checkout once the rail is on (the readiness gate reads this table).
--
--   * `payment_outboxes_event_type_check` is dropped and re-added over a STRICT
--     SUPERSET, gaining `provider_account_changed` — the same shape #48 used to
--     add `stripe` to the provider checks. The old image cannot produce the new
--     value, so widening ahead of it changes nothing for it; the reverse order
--     would reject the first account transition the new image recorded, and that
--     row is the audit trail of a seller becoming able to sell.
--
-- The re-add revalidates every existing row against the wider set, which is
-- trivially satisfied: the new set contains all seven previous values.

CREATE TABLE "provider_accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"owner_type" text NOT NULL,
	"owner_id" text NOT NULL,
	"provider_account_id" text NOT NULL,
	"country" text NOT NULL,
	"default_currency" text,
	"onboarding_state" text DEFAULT 'not_connected' NOT NULL,
	"charges_enabled" boolean DEFAULT false NOT NULL,
	"payouts_enabled" boolean DEFAULT false NOT NULL,
	"transfers_capability" text,
	"requirements_currently_due" integer DEFAULT 0 NOT NULL,
	"requirements_eventually_due" integer DEFAULT 0 NOT NULL,
	"requirements_past_due" integer DEFAULT 0 NOT NULL,
	"requirements_pending_verification" integer DEFAULT 0 NOT NULL,
	"requirements_deadline_at" timestamp with time zone,
	"disabled_reason_codes" text[] DEFAULT '{}' NOT NULL,
	"payout_schedule_interval" text,
	"payout_schedule_delay_days" integer,
	"last_synced_at" timestamp with time zone,
	"activated_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "provider_accounts_provider_check" CHECK ("provider_accounts"."provider" in ('external', 'manual_pos', 'mock', 'stripe')),
	CONSTRAINT "provider_accounts_owner_type_check" CHECK ("provider_accounts"."owner_type" in ('store', 'user')),
	CONSTRAINT "provider_accounts_onboarding_state_check" CHECK ("provider_accounts"."onboarding_state" in ('not_connected', 'action_required', 'under_review', 'ready', 'restricted', 'disabled')),
	CONSTRAINT "provider_accounts_transfers_capability_check" CHECK ("provider_accounts"."transfers_capability" in ('active', 'inactive', 'pending')),
	CONSTRAINT "provider_accounts_owner_id_check" CHECK (length("provider_accounts"."owner_id") > 0),
	CONSTRAINT "provider_accounts_provider_account_id_check" CHECK (length("provider_accounts"."provider_account_id") > 0),
	CONSTRAINT "provider_accounts_country_check" CHECK ("provider_accounts"."country" = upper("provider_accounts"."country") and length("provider_accounts"."country") = 2),
	CONSTRAINT "provider_accounts_requirements_check" CHECK ("provider_accounts"."requirements_currently_due" >= 0 and "provider_accounts"."requirements_eventually_due" >= 0
          and "provider_accounts"."requirements_past_due" >= 0 and "provider_accounts"."requirements_pending_verification" >= 0),
	CONSTRAINT "provider_accounts_payout_delay_days_check" CHECK ("provider_accounts"."payout_schedule_delay_days" is null or "provider_accounts"."payout_schedule_delay_days" >= 0),
	CONSTRAINT "provider_accounts_disabled_reason_codes_check" CHECK (not ('' = any("provider_accounts"."disabled_reason_codes")))
);
--> statement-breakpoint
ALTER TABLE "payment_outboxes" DROP CONSTRAINT "payment_outboxes_event_type_check";--> statement-breakpoint
CREATE UNIQUE INDEX "provider_accounts_owner_key" ON "provider_accounts" USING btree ("provider","owner_type","owner_id");--> statement-breakpoint
CREATE UNIQUE INDEX "provider_accounts_provider_account_id_key" ON "provider_accounts" USING btree ("provider","provider_account_id");--> statement-breakpoint
CREATE INDEX "provider_accounts_sync_idx" ON "provider_accounts" USING btree ("provider","last_synced_at");--> statement-breakpoint
CREATE INDEX "provider_accounts_state_idx" ON "provider_accounts" USING btree ("provider","onboarding_state");--> statement-breakpoint
ALTER TABLE "payment_outboxes" ADD CONSTRAINT "payment_outboxes_event_type_check" CHECK ("payment_outboxes"."event_type" in ('payment_succeeded', 'payment_failed', 'payment_succeeded_after_release', 'payment_refunded', 'payment_disputed', 'transfer_changed', 'payout_changed', 'provider_account_changed'));