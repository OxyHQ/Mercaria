-- oxy:deploy-phase=post
--
-- The second half of the payment-domain landing: take away what it replaced.
--
-- `post`, and it has to be — every statement here NARROWS. Applied before the
-- new image is live, each one is an outage on the image still serving:
--
--   * the four `settlement_*` columns held a shop→FAIR snapshot from the model
--     in which FAIR was the mandatory settlement currency. `payments.platform_*`
--     plus its rate snapshot replaces them, held per PAYMENT rather than on
--     every order (ADR 0001 D6/D8). `orders.ts` promised this drop would land in
--     the same change that added the tables replacing them, and this is it.
--   * `orders_payment_provider_check` loses `oxy_pay`. The `pre` migration
--     beside this one widened the constraint to accept BOTH sets precisely so
--     this narrowing has somewhere safe to happen: by the time it runs, no
--     running image can produce the value.
--
-- Nothing here can fail on data. `settlement_*` was never written by any image
-- in any environment (the comment in `orders.ts` said so, and the Postgres
-- `orders` table has never been a write path), and `oxy_pay` is unreachable
-- from the new image's type system, so no row can be carrying it.

ALTER TABLE "orders" DROP CONSTRAINT "orders_settlement_currency_check";--> statement-breakpoint
ALTER TABLE "orders" DROP CONSTRAINT "orders_settlement_complete_check";--> statement-breakpoint
ALTER TABLE "orders" DROP CONSTRAINT "orders_payment_provider_check";--> statement-breakpoint
ALTER TABLE "orders" DROP COLUMN "settlement_amount";--> statement-breakpoint
ALTER TABLE "orders" DROP COLUMN "settlement_currency";--> statement-breakpoint
ALTER TABLE "orders" DROP COLUMN "settlement_rate";--> statement-breakpoint
ALTER TABLE "orders" DROP COLUMN "settlement_as_of";--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_payment_provider_check" CHECK ("orders"."payment_provider" in ('external', 'manual_pos', 'mock'));