-- oxy:deploy-phase=pre
-- Guest buyers and immutable contact snapshots on orders (#106, ADR 0003
-- D6/D16). Purely ADDITIVE: no column is dropped, renamed or narrowed, and no
-- existing value is rewritten except the two backfills below, both of which
-- move a row from a default that was already correct to the value the previous
-- image would have written had the column existed.
--
-- Safe against BOTH images. The serving image never writes `actor_kind`,
-- `claimed_by_oxy_user_id` or `claimed_at`, so their defaults and NULLs are the
-- honest values for everything it produces; the arriving image writes all
-- three. The widened `orders_buyer_identity_check` replaces the #105 one and is
-- strictly a SUPERSET of the shapes the serving image can produce (it only
-- constrains the two new columns, which that image leaves NULL), so it is added
-- VALIDATED rather than NOT VALID — no row in this database violates it. ADR
-- 0003 M1 stages it NOT VALID expecting `ext:` rows to break the final shape;
-- they do not, exactly as #105's own migration recorded, because the `'oxy'`
-- and `'external'` disjuncts both admit them.
--
-- ORDER IS LOAD-BEARING and a regeneration will destroy it. `drizzle-kit`
-- emits the column adds and the CHECKs and cannot model an UPDATE, so the two
-- backfills below are hand-written and MUST stay between them:
-- `order_status_history_actor_check` refuses `actor_kind = 'system'` on a row
-- carrying `by_oxy_user_id`, which is every historical row with a real actor,
-- so adding the CHECK before the backfill fails the migration outright. Same
-- for `mercaria_order_buyer_origin_immutable`, whose new body drizzle cannot
-- see at all. If you regenerate this file, re-apply everything under the two
-- "hand-written" banners and re-read `AGENTS.md` §"Rebasing a migration behind
-- another branch's".

ALTER TABLE "orders" DROP CONSTRAINT "orders_buyer_identity_check";--> statement-breakpoint
ALTER TABLE "order_status_history" ADD COLUMN "actor_kind" text DEFAULT 'system' NOT NULL;--> statement-breakpoint
ALTER TABLE "order_status_history" ADD COLUMN "actor_guest_session_id" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "claimed_by_oxy_user_id" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "claimed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "guest_checkouts" ADD COLUMN "contact_verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "guest_checkouts" ADD COLUMN "contact_policy_version" text DEFAULT 'v1' NOT NULL;--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────────
-- HAND-WRITTEN 1/2: the backfills. Must run BEFORE the CHECKs below.
-- ─────────────────────────────────────────────────────────────────────────────

-- ADR 0003 M4, half one: every historical status event that names an Oxy actor
-- IS an Oxy actor event. The `'system'` fast default is correct for the rest —
-- an event with no actor was written by the expire-reservations sweep, the
-- payment outbox handler or the connector, all of which are the system.
--
-- Unbatched, deliberately. `order_status_history` is days old (the Postgres
-- cutover was 2026-08-08) and this is one indexless pass over a small table; the
-- keyed-batch discipline M4 describes is for when it no longer is, and adding it
-- now would be machinery for a size this table does not have.
UPDATE "order_status_history"
   SET "actor_kind" = 'oxy'
 WHERE "by_oxy_user_id" IS NOT NULL
   AND "actor_kind" = 'system';--> statement-breakpoint

-- ADR 0003 M4, half two: connector-imported orders are `'external'`, not `'oxy'`.
--
-- Keyed on `source_connection_id IS NOT NULL` and NOT on the `ext:` prefix of
-- `buyer_oxy_user_id`, which is a string convention nothing enforces — a buyer
-- who happens to have an Oxy id starting `ext:` would be reclassified by the
-- prefix test, and a connector row whose importer wrote a bare external id
-- would be missed by it. The connection foreign key is the fact.
--
-- `buyer_oxy_user_id` is deliberately LEFT ALONE: it holds the legacy
-- `ext:<provider>:<externalId>` provenance and the `'external'` disjunct of the
-- identity CHECK leaves that column unconstrained precisely so these rows keep
-- it. ADR 0003 M9 stops NEW imports writing it; nothing rewrites the old ones.
UPDATE "orders"
   SET "buyer_origin" = 'external'
 WHERE "source_connection_id" IS NOT NULL
   AND "buyer_origin" = 'oxy';--> statement-breakpoint

CREATE INDEX "orders_claimed_by_created_at_idx" ON "orders" USING btree ("claimed_by_oxy_user_id","created_at" DESC NULLS LAST) WHERE "orders"."claimed_by_oxy_user_id" is not null;--> statement-breakpoint
ALTER TABLE "order_status_history" ADD CONSTRAINT "order_status_history_actor_kind_check" CHECK ("order_status_history"."actor_kind" in ('oxy', 'guest', 'system', 'operator'));--> statement-breakpoint
ALTER TABLE "order_status_history" ADD CONSTRAINT "order_status_history_actor_check" CHECK (("order_status_history"."actor_kind" in ('oxy', 'operator')
             and "order_status_history"."by_oxy_user_id" is not null
             and "order_status_history"."actor_guest_session_id" is null)
          or ("order_status_history"."actor_kind" = 'guest'
             and "order_status_history"."by_oxy_user_id" is null
             and "order_status_history"."actor_guest_session_id" is not null)
          or ("order_status_history"."actor_kind" = 'system'
             and "order_status_history"."by_oxy_user_id" is null
             and "order_status_history"."actor_guest_session_id" is null));--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_buyer_identity_check" CHECK (("orders"."buyer_origin" = 'oxy'
             and "orders"."buyer_oxy_user_id" is not null
             and "orders"."buyer_guest_checkout_id" is null
             and "orders"."claimed_by_oxy_user_id" is null
             and "orders"."claimed_at" is null)
          or ("orders"."buyer_origin" = 'guest'
             and "orders"."buyer_guest_checkout_id" is not null
             and "orders"."buyer_oxy_user_id" is null
             and num_nonnulls("orders"."claimed_by_oxy_user_id", "orders"."claimed_at") in (0, 2))
          or ("orders"."buyer_origin" = 'external'
             and "orders"."buyer_guest_checkout_id" is null
             and "orders"."claimed_by_oxy_user_id" is null
             and "orders"."claimed_at" is null));--> statement-breakpoint
ALTER TABLE "guest_checkouts" ADD CONSTRAINT "guest_checkouts_contact_verified_at_check" CHECK (("guest_checkouts"."contact_verification_stage" = 'pending') = ("guest_checkouts"."contact_verified_at" is null));--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────────
-- HAND-WRITTEN 2/2: the widened immutability trigger.
-- ─────────────────────────────────────────────────────────────────────────────

-- ADR 0003 D6/I7, extended for the claim pair. `0023` created this function and
-- its own comment says #106 EXTENDS it rather than adding a second trigger:
-- ONE place says what a buyer identity may become. `CREATE OR REPLACE` keeps
-- the existing `orders_buyer_origin_immutable` trigger bound to it, so there is
-- no window in which the table is unguarded.
--
-- The three original rules are unchanged and repeated verbatim, because a
-- replacement is a whole body and a rule dropped here would be a rule silently
-- retired. What is added is the claim pair's transition rule:
--
--   NULL  -> value   a claim (#109). Permitted.
--   value -> NULL    an audited operator unclaim (D6). Permitted.
--   value -> value   REFUSED — a mis-claim is corrected by unclaim + re-claim,
--                    two audited steps, never by editing history in place.
--
-- That last refusal is what makes ADR 0003 D14's conflict resolution real: a
-- second Oxy account claiming an already-claimed group is answered 409 by the
-- service, and the trigger is why a service bug cannot answer it any other way.
--
-- Every comparison is `IS DISTINCT FROM`, never `<>`: with a NULL on either
-- side `<>` evaluates to NULL, which is not TRUE, which would let exactly the
-- transitions being guarded slip past. The claim pair is checked as a PAIR (the
-- claimant decides, and `orders_buyer_identity_check` already forces the
-- timestamp to travel with it) so an UPDATE moving only `claimed_at` is refused
-- by the CHECK rather than being silently permitted here.
CREATE OR REPLACE FUNCTION mercaria_order_buyer_origin_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.buyer_origin IS DISTINCT FROM OLD.buyer_origin THEN
    RAISE EXCEPTION 'orders.buyer_origin is immutable after insert (ADR 0003 D6/I7)';
  END IF;
  IF NEW.buyer_guest_checkout_id IS DISTINCT FROM OLD.buyer_guest_checkout_id THEN
    RAISE EXCEPTION 'orders.buyer_guest_checkout_id is immutable after insert (ADR 0003 D6/I7)';
  END IF;
  IF OLD.buyer_oxy_user_id IS NOT NULL
     AND NEW.buyer_oxy_user_id IS DISTINCT FROM OLD.buyer_oxy_user_id THEN
    RAISE EXCEPTION 'orders.buyer_oxy_user_id cannot be reassigned (ADR 0003 D6/I7)';
  END IF;
  IF OLD.claimed_by_oxy_user_id IS NOT NULL
     AND NEW.claimed_by_oxy_user_id IS NOT NULL
     AND NEW.claimed_by_oxy_user_id IS DISTINCT FROM OLD.claimed_by_oxy_user_id THEN
    RAISE EXCEPTION 'orders.claimed_by_oxy_user_id cannot be reassigned; unclaim first (ADR 0003 D6/D14)';
  END IF;
  RETURN NEW;
END;
$$;
