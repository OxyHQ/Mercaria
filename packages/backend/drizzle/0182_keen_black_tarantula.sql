-- oxy:deploy-phase=post
-- oxy:rollback=restore: `billing_customers_provider_check`, `merchant_plan_prices_provider_check` and `merchant_subscriptions_provider_check` narrow from 'stripe' to 'peable' (merchant billing moved to Peable's native engine); their previous form is in 0066, and re-adding it fails once a 'peable' row exists
ALTER TABLE "billing_customers" DROP CONSTRAINT "billing_customers_provider_check";--> statement-breakpoint
ALTER TABLE "merchant_plan_prices" DROP CONSTRAINT "merchant_plan_prices_provider_check";--> statement-breakpoint
ALTER TABLE "merchant_subscriptions" DROP CONSTRAINT "merchant_subscriptions_provider_check";--> statement-breakpoint
ALTER TABLE "billing_customers" ADD CONSTRAINT "billing_customers_provider_check" CHECK ("billing_customers"."provider" in ('peable'));--> statement-breakpoint
ALTER TABLE "merchant_plan_prices" ADD CONSTRAINT "merchant_plan_prices_provider_check" CHECK ("merchant_plan_prices"."provider" in ('peable'));--> statement-breakpoint
ALTER TABLE "merchant_subscriptions" ADD CONSTRAINT "merchant_subscriptions_provider_check" CHECK ("merchant_subscriptions"."provider" in ('peable'));