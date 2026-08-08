-- oxy:deploy-phase=pre
--
-- `pre`, and the reasoning is worth stating because the CHECK here is NOT a
-- plain widening: it moves from `in (0, 4)` to `in (0, 5)`, which the old shape
-- (four non-null fx columns, no provider) fails and the new shape (five) passes.
-- A row written by either image violates the other's constraint, so on a table
-- with a previous image serving it this would need the usual two steps — widen
-- to accept both shapes `pre`, narrow to `in (0, 5)` `post`.
--
-- It does not need them here: the Postgres `orders` table has never served
-- traffic. Migrations 0000-0004 are one never-yet-deployed batch that applies
-- together at the Mongo->Postgres cutover, and at that moment no image is
-- writing four-column fx snapshots for the narrowed check to reject.
--
-- If this table is ever live before the cutover, this file must be split in two
-- before it is applied.
ALTER TABLE "orders" DROP CONSTRAINT "orders_fx_rate_complete_check";--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "fx_rate_provider" text;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_fx_rate_complete_check" CHECK (num_nonnulls("orders"."fx_rate_from", "orders"."fx_rate_to", "orders"."fx_rate_rate", "orders"."fx_rate_provider", "orders"."fx_rate_as_of") in (0, 5));
