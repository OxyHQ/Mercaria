-- oxy:deploy-phase=pre
-- oxy:rollback=restore: ten provider CHECKs — orders_payment_provider_check, payments_provider_check, refunds_provider_check, disputes_provider_check, payment_attempts_provider_check, payment_provider_events_provider_check, payouts_provider_check, provider_accounts_provider_check, transfers_provider_check and payment_discrepancies_provider_check — are in 0154, which last widened them; re-adding those narrower forms, or provider_accounts.country NOT NULL, fails against any row already naming peable_faircoin or a FairCoin-only seller. The four provider_accounts faircoin_* columns are additive and dropping them loses each seller's FairCoin half, which the next account read restores from Peable
-- ADR 0019: `peable_faircoin`, the FairCoin rail on behalf of one seller, and the FairCoin half of a seller's connected account.
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
ALTER TABLE "provider_accounts" ALTER COLUMN "country" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "provider_accounts" ADD COLUMN "faircoin_state" text DEFAULT 'not_connected' NOT NULL;--> statement-breakpoint
ALTER TABLE "provider_accounts" ADD COLUMN "faircoin_network" text;--> statement-breakpoint
ALTER TABLE "provider_accounts" ADD COLUMN "faircoin_oxy_account_id" text;--> statement-breakpoint
ALTER TABLE "provider_accounts" ADD COLUMN "faircoin_confirmed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_payment_provider_check" CHECK ("orders"."payment_provider" in ('external', 'manual_pos', 'mock', 'peable', 'peable_faircoin'));--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_provider_check" CHECK ("refunds"."provider" in ('external', 'manual_pos', 'mock', 'peable', 'peable_faircoin'));--> statement-breakpoint
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_provider_check" CHECK ("disputes"."provider" in ('external', 'manual_pos', 'mock', 'peable', 'peable_faircoin'));--> statement-breakpoint
ALTER TABLE "payment_attempts" ADD CONSTRAINT "payment_attempts_provider_check" CHECK ("payment_attempts"."provider" in ('external', 'manual_pos', 'mock', 'peable', 'peable_faircoin'));--> statement-breakpoint
ALTER TABLE "payment_provider_events" ADD CONSTRAINT "payment_provider_events_provider_check" CHECK ("payment_provider_events"."provider" in ('external', 'manual_pos', 'mock', 'peable', 'peable_faircoin'));--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_provider_check" CHECK ("payments"."provider" in ('external', 'manual_pos', 'mock', 'peable', 'peable_faircoin'));--> statement-breakpoint
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_provider_check" CHECK ("payouts"."provider" in ('external', 'manual_pos', 'mock', 'peable', 'peable_faircoin'));--> statement-breakpoint
ALTER TABLE "provider_accounts" ADD CONSTRAINT "provider_accounts_faircoin_state_check" CHECK ("provider_accounts"."faircoin_state" in ('not_connected', 'pending', 'active'));--> statement-breakpoint
ALTER TABLE "provider_accounts" ADD CONSTRAINT "provider_accounts_faircoin_network_check" CHECK ("provider_accounts"."faircoin_network" in ('mainnet', 'testnet'));--> statement-breakpoint
ALTER TABLE "provider_accounts" ADD CONSTRAINT "provider_accounts_faircoin_half_check" CHECK (("provider_accounts"."faircoin_state" = 'not_connected') = ("provider_accounts"."faircoin_network" is null and "provider_accounts"."faircoin_oxy_account_id" is null));--> statement-breakpoint
ALTER TABLE "provider_accounts" ADD CONSTRAINT "provider_accounts_provider_check" CHECK ("provider_accounts"."provider" in ('external', 'manual_pos', 'mock', 'peable', 'peable_faircoin'));--> statement-breakpoint
ALTER TABLE "transfers" ADD CONSTRAINT "transfers_provider_check" CHECK ("transfers"."provider" in ('external', 'manual_pos', 'mock', 'peable', 'peable_faircoin'));--> statement-breakpoint
ALTER TABLE "payment_discrepancies" ADD CONSTRAINT "payment_discrepancies_provider_check" CHECK ("payment_discrepancies"."provider" in ('external', 'manual_pos', 'mock', 'peable', 'peable_faircoin'));