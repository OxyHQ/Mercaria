-- oxy:deploy-phase=pre
-- oxy:rollback=restore: ten provider CHECKs — orders_payment_provider_check, payments_provider_check, refunds_provider_check, disputes_provider_check, payment_attempts_provider_check, payment_provider_events_provider_check, payouts_provider_check, provider_accounts_provider_check, transfers_provider_check and payment_discrepancies_provider_check — are in the migrations that last widened them (0004 for the stripe round, 0002 before it); re-adding the narrower forms fails against any row already naming peable
-- Ten CHECK constraints WIDENED to admit `peable` (ADR 0009 D13).
--
-- `pre` and `restore`, which are different properties and both true here. The
-- runbook names this exact shape: widening a CHECK is spelled DROP + ADD, and
-- the definition that was dropped is NOT in the file that dropped it — so the
-- migration is additive going forward and its own inverse is not derivable from
-- it. `0004_stripe_event_ingress.sql` is the same statement for `stripe`, one
-- provider earlier.
--
-- Drop-and-re-add reads destructive and is not: each replacement accepts every
-- value the original did plus one more, so every existing row passes and the
-- RUNNING image — which writes only the four original providers — keeps working
-- unchanged. A rollback to it is safe too: it would run against constraints
-- wider than the ones it knows.
--
-- `pre` for that reason and because the ORDER matters the other way round: the
-- image that writes `peable` rows cannot roll out before the constraints that
-- admit them, or the first card checkout on the new rail fails on a CHECK.
--
-- `stripe` stays in every list. The two rails coexist until the new one is
-- verified end to end (ADR 0009 D13), which is what keeps checkout up across
-- the move and makes a rollback a config change rather than a migration.
ALTER TABLE "orders" DROP CONSTRAINT "orders_payment_provider_check";--> statement-breakpoint
ALTER TABLE "refunds" DROP CONSTRAINT "refunds_provider_check";--> statement-breakpoint
ALTER TABLE "disputes" DROP CONSTRAINT "disputes_provider_check";--> statement-breakpoint
ALTER TABLE "payment_attempts" DROP CONSTRAINT "payment_attempts_provider_check";--> statement-breakpoint
ALTER TABLE "payment_provider_events" DROP CONSTRAINT "payment_provider_events_provider_check";--> statement-breakpoint
ALTER TABLE "payments" DROP CONSTRAINT "payments_provider_check";--> statement-breakpoint
ALTER TABLE "payouts" DROP CONSTRAINT "payouts_provider_check";--> statement-breakpoint
ALTER TABLE "provider_accounts" DROP CONSTRAINT "provider_accounts_provider_check";--> statement-breakpoint
ALTER TABLE "transfers" DROP CONSTRAINT "transfers_provider_check";--> statement-breakpoint
ALTER TABLE "payment_discrepancies" DROP CONSTRAINT "payment_discrepancies_provider_check";--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_payment_provider_check" CHECK ("orders"."payment_provider" in ('external', 'manual_pos', 'mock', 'peable', 'stripe'));--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_provider_check" CHECK ("refunds"."provider" in ('external', 'manual_pos', 'mock', 'peable', 'stripe'));--> statement-breakpoint
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_provider_check" CHECK ("disputes"."provider" in ('external', 'manual_pos', 'mock', 'peable', 'stripe'));--> statement-breakpoint
ALTER TABLE "payment_attempts" ADD CONSTRAINT "payment_attempts_provider_check" CHECK ("payment_attempts"."provider" in ('external', 'manual_pos', 'mock', 'peable', 'stripe'));--> statement-breakpoint
ALTER TABLE "payment_provider_events" ADD CONSTRAINT "payment_provider_events_provider_check" CHECK ("payment_provider_events"."provider" in ('external', 'manual_pos', 'mock', 'peable', 'stripe'));--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_provider_check" CHECK ("payments"."provider" in ('external', 'manual_pos', 'mock', 'peable', 'stripe'));--> statement-breakpoint
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_provider_check" CHECK ("payouts"."provider" in ('external', 'manual_pos', 'mock', 'peable', 'stripe'));--> statement-breakpoint
ALTER TABLE "provider_accounts" ADD CONSTRAINT "provider_accounts_provider_check" CHECK ("provider_accounts"."provider" in ('external', 'manual_pos', 'mock', 'peable', 'stripe'));--> statement-breakpoint
ALTER TABLE "transfers" ADD CONSTRAINT "transfers_provider_check" CHECK ("transfers"."provider" in ('external', 'manual_pos', 'mock', 'peable', 'stripe'));--> statement-breakpoint
ALTER TABLE "payment_discrepancies" ADD CONSTRAINT "payment_discrepancies_provider_check" CHECK ("payment_discrepancies"."provider" in ('external', 'manual_pos', 'mock', 'peable', 'stripe'));