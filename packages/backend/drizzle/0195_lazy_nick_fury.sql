-- oxy:deploy-phase=pre
-- oxy:rollback=derived
-- Peable ADR 0021 D3: a FairCoin-started plan renews by invoice (`send_invoice`), so the subscription row records how each renewal is collected and the days until a renewal invoice falls due. Every existing row is card-started (FairCoin plans never opened in production), so the default is the truth for them.
ALTER TABLE "merchant_subscriptions" ADD COLUMN "collection_method" text DEFAULT 'charge_automatically' NOT NULL;--> statement-breakpoint
ALTER TABLE "merchant_subscriptions" ADD COLUMN "days_until_due" integer;--> statement-breakpoint
ALTER TABLE "merchant_subscriptions" ADD CONSTRAINT "merchant_subscriptions_collection_method_check" CHECK ("merchant_subscriptions"."collection_method" in ('charge_automatically', 'send_invoice'));--> statement-breakpoint
ALTER TABLE "merchant_subscriptions" ADD CONSTRAINT "merchant_subscriptions_days_until_due_check" CHECK ("merchant_subscriptions"."days_until_due" is null
          or ("merchant_subscriptions"."collection_method" = 'send_invoice' and "merchant_subscriptions"."days_until_due" >= 0));