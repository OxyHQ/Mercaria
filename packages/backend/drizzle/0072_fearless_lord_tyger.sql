-- oxy:deploy-phase=pre
--
-- #262: the webhook re-registration bookkeeping on `connections`.
--
-- ADDITIVE, and the three CHECKs are additive too rather than merely narrow: the
-- serving image writes NONE of these five columns, so there is no write any of
-- them could break — which is the test for `post`, not "does it constrain
-- something". The state column carries a NOT NULL DEFAULT so every existing row
-- reads `pending`, which is the correct starting point: a registration that was
-- refused before this deploy has its refusal rows intact and becomes due on the
-- first sweep tick with a full attempt budget.
--
-- Nothing hand-written lives below, so a regeneration reproduces this file
-- exactly; re-apply THIS HEADER after one.

ALTER TABLE "connections" ADD COLUMN "webhook_registration_state" text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "webhook_registration_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "webhook_registration_next_attempt_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "webhook_registration_lease_owner" text;--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "webhook_registration_lease_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_webhook_registration_state_check" CHECK ("connections"."webhook_registration_state" in ('pending', 'dead_letter'));--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_webhook_registration_lease_check" CHECK (num_nonnulls("connections"."webhook_registration_lease_owner", "connections"."webhook_registration_lease_until") in (0, 2));--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_webhook_registration_attempts_check" CHECK ("connections"."webhook_registration_attempts" >= 0);
