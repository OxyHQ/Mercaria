-- oxy:deploy-phase=post
-- oxy:rollback=accepted: store_members is dropped, and with it every store's member list, roles and explicit grants. The owner became stores.oxy_account_id (0158 and the first block below) and every NON-default grant became a store_permission_overrides row, but a member who held only their role's defaults leaves no trace: who may act for a store is the owning Oxy account's membership from here on (ADR 0012), and a second member list beside Oxy's is exactly what that ADR refuses to keep. store_linkage_requests.impact_store_members is dropped with it - a count of that list on past impact previews, describing a membership model that no longer exists; the preview's other five counts are untouched. Nothing re-derives either, and the previous image cannot run against this schema
--
-- A store is owned by an Oxy account (ADR 0012), second half.
--
-- `post` on every count: it drops a table and a column the previous image
-- reads and writes, and narrows `stores.oxy_account_id` to NOT NULL, which the
-- previous image never writes. `Migrate (post)` runs once the new image is
-- live, so nothing that could still write `store_members` or a store without an
-- owning account is serving when this applies.
--
-- ## The hand-written half runs FIRST, above the generated drops
--
-- Three blocks, and their order is the point:
--
--   1. The `0158` backfill again. `0158` ran in this release's `pre` phase,
--      with `0159` and `0160`, before the rollout; the previous image went on
--      creating stores through `store_members` until it stopped serving, and
--      those rows still have no owning account.
--   2. A refusal, with a count, if any store is STILL without one - a store
--      with no `owner` member at all. `SET NOT NULL` would refuse too, but with
--      no count and nothing to start from.
--   3. The non-default grants of every member who is NOT the owning account,
--      copied into `store_permission_overrides`. "Non-default" is measured
--      against the RETIRED role matrix (`owner` 18, `admin` 17, `staff` 9),
--      frozen here as literals because the code that held it is gone. A row the
--      new image already wrote for the same person wins (`ON CONFLICT DO
--      NOTHING`). `updated_by_oxy_user_id` stays NULL: nobody wrote these
--      exceptions through the override surface.
--
-- What this means for people, stated rather than implied: every member other
-- than the owning account - `admin`, `staff` and any second `owner` - loses
-- access here, until the store's owner converts it to an organization in the
-- dashboard and adds them there (`docs/stores.md`). An override carried over by
-- block 3 takes effect again the moment its holder is a member.
--
-- ## Inbound references, read before the DROP
--
-- `drizzle-kit` writes `DROP TABLE ... CASCADE` unconditionally. Read off
-- `meta/0160_snapshot.json`: NO foreign key targets `store_members`, and no
-- trigger, function or view in `drizzle/` names it. The CASCADE takes nothing.
-- Dropping `impact_store_members` takes `store_linkage_requests_impact_check`,
-- which the generated half drops first and re-adds over the five survivors.
--
-- A regeneration drops the three blocks and both marker lines; re-add them ABOVE
-- the generated statements and confirm
--
--   grep -cE '^-- oxy:(deploy-phase|rollback)=' drizzle/0161_messy_tenebrous.sql   -> 2
--   grep -cE '^-- oxy:handwritten-(begin|end)=' drizzle/0161_messy_tenebrous.sql   -> 6
-- oxy:handwritten-begin=stores_oxy_account_id_backfill_after_rollout
UPDATE "stores" AS s
SET "oxy_account_id" = (
  SELECT m."oxy_user_id"
  FROM "store_members" AS m
  WHERE m."store_id" = s."id" AND m."role" = 'owner'
  ORDER BY m."joined_at", m."oxy_user_id"
  LIMIT 1
)
WHERE s."oxy_account_id" IS NULL;--> statement-breakpoint
-- oxy:handwritten-end=stores_oxy_account_id_backfill_after_rollout
-- oxy:handwritten-begin=stores_without_owner_account_refused
DO $$
DECLARE
  orphaned integer;
BEGIN
  SELECT count(*) INTO orphaned FROM "stores" WHERE "oxy_account_id" IS NULL;
  IF orphaned > 0 THEN
    RAISE EXCEPTION '% store(s) have no owner member and so no owning Oxy account; give each one before 0159 can apply (select id from stores where oxy_account_id is null)', orphaned;
  END IF;
END
$$;--> statement-breakpoint
-- oxy:handwritten-end=stores_without_owner_account_refused
-- oxy:handwritten-begin=store_member_grants_to_overrides
INSERT INTO "store_permission_overrides" ("id", "store_id", "oxy_user_id", "granted")
SELECT gen_random_uuid()::text, m."store_id", m."oxy_user_id", extra."granted"
FROM "store_members" AS m
JOIN "stores" AS s ON s."id" = m."store_id"
CROSS JOIN LATERAL (
  SELECT coalesce(array_agg(p ORDER BY p), '{}'::text[]) AS "granted"
  FROM unnest(m."permissions") AS p
  WHERE NOT p = ANY (
    CASE m."role"
      WHEN 'owner' THEN array['store:manage', 'members:manage', 'products:read', 'products:write', 'inventory:write', 'locations:write', 'collections:write', 'discounts:write', 'settings:write', 'orders:read', 'orders:fulfill', 'stats:read', 'customers:read', 'customers:write', 'draft_orders:write', 'refunds:write', 'channels:write', 'analytics:read']::text[]
      WHEN 'admin' THEN array['members:manage', 'products:read', 'products:write', 'inventory:write', 'locations:write', 'collections:write', 'discounts:write', 'settings:write', 'orders:read', 'orders:fulfill', 'stats:read', 'customers:read', 'customers:write', 'draft_orders:write', 'refunds:write', 'channels:write', 'analytics:read']::text[]
      ELSE array['products:read', 'products:write', 'inventory:write', 'orders:read', 'orders:fulfill', 'stats:read', 'customers:read', 'customers:write', 'draft_orders:write']::text[]
    END
  )
) AS extra
WHERE m."oxy_user_id" <> s."oxy_account_id"
  AND cardinality(extra."granted") > 0
ON CONFLICT ("store_id", "oxy_user_id") DO NOTHING;--> statement-breakpoint
-- oxy:handwritten-end=store_member_grants_to_overrides
ALTER TABLE "store_members" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "store_members" CASCADE;--> statement-breakpoint
ALTER TABLE "store_linkage_requests" DROP CONSTRAINT "store_linkage_requests_impact_check";--> statement-breakpoint
ALTER TABLE "stores" ALTER COLUMN "oxy_account_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "store_linkage_requests" DROP COLUMN "impact_store_members";--> statement-breakpoint
ALTER TABLE "store_linkage_requests" ADD CONSTRAINT "store_linkage_requests_impact_check" CHECK ("store_linkage_requests"."impact_active_listings" >= 0 and "store_linkage_requests"."impact_native_offers" >= 0
          and "store_linkage_requests"."impact_external_offers" >= 0 and "store_linkage_requests"."impact_storefronts" >= 0
          and "store_linkage_requests"."impact_placed_orders" >= 0);