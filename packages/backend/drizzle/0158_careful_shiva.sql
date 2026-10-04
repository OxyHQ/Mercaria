-- oxy:deploy-phase=pre
-- oxy:rollback=replay: stores.oxy_account_id is written by the backfill UPDATE below, whose pre-image (NULL, in a column this same file adds) is not a statement the classifier can derive. Dropping the column - the derived inverse of the ADD COLUMN - removes it whole, and re-applying this file re-derives every value from store_members, which this file leaves untouched
--
-- A store is owned by an Oxy account (ADR 0012), first half.
--
-- ADDITIVE, which is why the phase is `pre`: one new table nothing the serving
-- image reads, one NULLABLE column on `stores` with its index, and a backfill of
-- that column. Nothing narrows, drops or renames anything the serving image
-- touches — read off the generated half: no DROP of any kind, and the only
-- ALTER on an existing table adds a nullable column.
--
-- `stores.oxy_account_id` is NULLABLE here and goes NOT NULL in `0159` (post).
-- The image still serving while this applies creates stores through
-- `store_members` and knows nothing of the column, so a NOT NULL here would
-- fail its every store creation for the length of the rollout.
--
-- ## The hand-written half: the backfill
--
-- One anchored block, appended below the generated statements. A store's owning
-- account is its EARLIEST owner's PERSONAL account — the id spaces are one
-- (an Oxy organization and a person are both `users` rows), so this is a copy,
-- not a lookup. `oxy_user_id` breaks a `joined_at` tie so a rerun picks the same
-- account. `0159` reruns the same statement after the rollout, for the stores
-- the previous image created while this one was being deployed.
--
-- A regeneration drops the block AND the two marker lines at the top; re-add
-- both and confirm
--
--   grep -cE '^-- oxy:(deploy-phase|rollback)=' drizzle/0158_careful_shiva.sql   -> 2
--   grep -cE '^-- oxy:handwritten-(begin|end)=' drizzle/0158_careful_shiva.sql   -> 2
CREATE TABLE "store_permission_overrides" (
	"id" text PRIMARY KEY NOT NULL,
	"store_id" text NOT NULL,
	"oxy_user_id" text NOT NULL,
	"granted" text[] DEFAULT '{}'::text[] NOT NULL,
	"revoked" text[] DEFAULT '{}'::text[] NOT NULL,
	"updated_by_oxy_user_id" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "store_permission_overrides_granted_check" CHECK ("store_permission_overrides"."granted" <@ array['store:manage', 'members:manage', 'products:read', 'products:write', 'inventory:write', 'locations:write', 'collections:write', 'discounts:write', 'settings:write', 'orders:read', 'orders:fulfill', 'stats:read', 'customers:read', 'customers:write', 'draft_orders:write', 'refunds:write', 'channels:write', 'analytics:read']::text[]),
	CONSTRAINT "store_permission_overrides_revoked_check" CHECK ("store_permission_overrides"."revoked" <@ array['store:manage', 'members:manage', 'products:read', 'products:write', 'inventory:write', 'locations:write', 'collections:write', 'discounts:write', 'settings:write', 'orders:read', 'orders:fulfill', 'stats:read', 'customers:read', 'customers:write', 'draft_orders:write', 'refunds:write', 'channels:write', 'analytics:read']::text[]),
	CONSTRAINT "store_permission_overrides_disjoint_check" CHECK (not ("store_permission_overrides"."granted" && "store_permission_overrides"."revoked")),
	CONSTRAINT "store_permission_overrides_nonempty_check" CHECK (cardinality("store_permission_overrides"."granted") + cardinality("store_permission_overrides"."revoked") > 0)
);
--> statement-breakpoint
ALTER TABLE "stores" ADD COLUMN "oxy_account_id" text;--> statement-breakpoint
ALTER TABLE "store_permission_overrides" ADD CONSTRAINT "store_permission_overrides_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "store_permission_overrides_store_id_oxy_user_id_key" ON "store_permission_overrides" USING btree ("store_id","oxy_user_id");--> statement-breakpoint
CREATE INDEX "stores_oxy_account_id_idx" ON "stores" USING btree ("oxy_account_id");--> statement-breakpoint
-- oxy:handwritten-begin=stores_oxy_account_id_backfill
UPDATE "stores" AS s
SET "oxy_account_id" = (
  SELECT m."oxy_user_id"
  FROM "store_members" AS m
  WHERE m."store_id" = s."id" AND m."role" = 'owner'
  ORDER BY m."joined_at", m."oxy_user_id"
  LIMIT 1
)
WHERE s."oxy_account_id" IS NULL;
-- oxy:handwritten-end=stores_oxy_account_id_backfill
