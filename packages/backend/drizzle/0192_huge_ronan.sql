-- oxy:deploy-phase=pre
-- oxy:rollback=restore: order_fee_snapshots_result_check as 0016 last rendered it (without 'faircoin_exempt'); re-adding the narrower form fails against any order already priced for a FairCoin payment
-- Mercaria ADR 0020: the marketplace fee follows the payment method; an order the buyer pays in FairCoin is 'faircoin_exempt' (a real zero decided by the method), whatever currency it is priced in.
ALTER TABLE "order_fee_snapshots" DROP CONSTRAINT "order_fee_snapshots_result_check";--> statement-breakpoint
ALTER TABLE "order_fee_snapshots" ADD CONSTRAINT "order_fee_snapshots_result_check" CHECK ("order_fee_snapshots"."result" in ('calculated', 'no_active_schedule', 'not_applicable', 'faircoin_exempt'));