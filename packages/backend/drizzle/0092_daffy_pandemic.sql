-- oxy:deploy-phase=pre
--
-- #390 — the status PROVENANCE of an archive.
--
-- Additive in the strict sense the phase marker asks about: two NULLABLE
-- columns the serving image never writes, and three CHECKs every row already
-- in the table satisfies. `x in (…)` is NULL — and therefore ACCEPTED by a
-- CHECK — for a NULL `x`, and the third constraint is written `is null or …`,
-- so no statement the previous image performs is broken by any of them.
--
-- There is deliberately NO backfill and no biconditional tying these columns
-- to `status = 'archived'`. Every listing already `archived` was archived by
-- something no surviving evidence names — that indistinguishability IS the
-- issue — so a biconditional would need a value invented for each of them,
-- and inventing the connector half is precisely the wrong guess: it would
-- republish listings their merchants deleted. NULL is read as UNKNOWN by
-- `restoreListingArchivedByThisConnector`, which refuses it, so those rows
-- keep exactly today's behaviour and the unknowable set is frozen here rather
-- than growing (the repository THROWS on an archive with no cause).

ALTER TABLE "listings" ADD COLUMN "archived_by" text;--> statement-breakpoint
ALTER TABLE "listings" ADD COLUMN "archived_from_status" text;--> statement-breakpoint
ALTER TABLE "listings" ADD CONSTRAINT "listings_archived_by_check" CHECK ("listings"."archived_by" in ('merchant_delete', 'merchant_status_change', 'channel_disconnect', 'connector_product_deleted', 'connector_unseen_in_backfill', 'connector_unpublished', 'moderation_restore'));--> statement-breakpoint
ALTER TABLE "listings" ADD CONSTRAINT "listings_archived_from_status_check" CHECK ("listings"."archived_from_status" in ('draft', 'active', 'sold', 'archived', 'restricted'));--> statement-breakpoint
ALTER TABLE "listings" ADD CONSTRAINT "listings_archived_from_status_needs_cause_check" CHECK ("listings"."archived_from_status" is null or "listings"."archived_by" is not null);
