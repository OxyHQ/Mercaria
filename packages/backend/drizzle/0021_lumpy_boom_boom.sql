-- oxy:deploy-phase=pre
--
-- Guest cart ownership and the merge audit (#104, ADR 0003 D8).
--
-- WHY THIS IS `pre`, in full, because the phase is the one thing here that
-- cannot be recovered from by reading the diff:
--
--   * `carts.guest_session_id`, `cart_items.merge_review_reason` and the whole
--     `cart_merges` table are ADDITIVE. The image still serving selects columns
--     by NAME and never mentions them, so it is unaffected.
--   * `ALTER COLUMN carts.oxy_user_id DROP NOT NULL` is a WIDENING. The serving
--     image always writes that column, so no NULL can appear before the new
--     code is live — the ADR states this staging as M1 verbatim.
--   * The `carts_oxy_user_id_key` swap DROPs the full unique and recreates it
--     under the SAME NAME as a partial on `oxy_user_id IS NOT NULL`. Every row
--     that exists satisfies the predicate, so the index covers exactly the same
--     set it did a statement earlier and the serving image's lookup keeps the
--     same plan. Both statements run inside the migrator's transaction, so
--     there is no moment at which a duplicate could be inserted. (ADR M5 stages
--     this as create-temp / drop / rename for a CONCURRENTLY world; at the
--     current table age an in-transaction swap is the simpler correct form, and
--     the `CONCURRENTLY` discipline is noted for when it no longer is.)
--
-- `carts_owner_exclusivity_check` is added VALIDATED, not `NOT VALID`. The ADR
-- stages the `orders` identity CHECK as `NOT VALID` because legacy `ext:` rows
-- genuinely violate its final shape until M4 backfills them; `carts` has no
-- such rows. Every existing cart has `oxy_user_id NOT NULL` and
-- `guest_session_id NULL`, i.e. `num_nonnulls(...) = 1` already, so validation
-- is immediate and the "backfill existing carts to authenticated ownership"
-- requirement is satisfied by rewriting ZERO rows: no item id, quantity or
-- pending discount code is touched by this migration.
--
-- The FK on `carts.guest_session_id` is `ON DELETE CASCADE` deliberately: it is
-- what makes guest retention correct by construction. The expiry sweep hard-
-- deletes an expired `guest_sessions` row, the cart goes with it, and the
-- existing `cart_items.cart_id` cascade takes the lines — no sweep code to keep
-- honest. An Oxy id can never carry a foreign key (Oxy owns identity), which is
-- exactly why ownership is two columns plus a CHECK and not one polymorphic
-- pair.
CREATE TABLE "cart_merges" (
	"id" text PRIMARY KEY NOT NULL,
	"guest_session_id" text NOT NULL,
	"oxy_user_id" text NOT NULL,
	"target_cart_id" text NOT NULL,
	"lines_added" integer DEFAULT 0 NOT NULL,
	"lines_combined" integer DEFAULT 0 NOT NULL,
	"lines_clamped" integer DEFAULT 0 NOT NULL,
	"lines_flagged" integer DEFAULT 0 NOT NULL,
	"discount_codes_added" integer DEFAULT 0 NOT NULL,
	"discount_codes_dropped" integer DEFAULT 0 NOT NULL,
	"reasons" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "cart_merges_reasons_check" CHECK ("cart_merges"."reasons" <@ array['quantity_clamped_to_stock', 'quantity_clamped_to_limit', 'listing_unavailable', 'listing_remapped', 'already_converted', 'no_guest_cart', 'guest_cart_empty', 'discount_code_dropped']::text[]),
	CONSTRAINT "cart_merges_counts_check" CHECK ("cart_merges"."lines_added" >= 0 and "cart_merges"."lines_combined" >= 0 and "cart_merges"."lines_clamped" >= 0
          and "cart_merges"."lines_flagged" >= 0 and "cart_merges"."discount_codes_added" >= 0
          and "cart_merges"."discount_codes_dropped" >= 0)
);
--> statement-breakpoint
DROP INDEX "carts_oxy_user_id_key";--> statement-breakpoint
ALTER TABLE "carts" ALTER COLUMN "oxy_user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "cart_items" ADD COLUMN "merge_review_reason" text;--> statement-breakpoint
ALTER TABLE "carts" ADD COLUMN "guest_session_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX "cart_merges_guest_session_id_key" ON "cart_merges" USING btree ("guest_session_id");--> statement-breakpoint
CREATE INDEX "cart_merges_oxy_user_id_created_at_idx" ON "cart_merges" USING btree ("oxy_user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "carts" ADD CONSTRAINT "carts_guest_session_id_guest_sessions_id_fk" FOREIGN KEY ("guest_session_id") REFERENCES "public"."guest_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "carts_guest_session_id_key" ON "carts" USING btree ("guest_session_id") WHERE "carts"."guest_session_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "carts_oxy_user_id_key" ON "carts" USING btree ("oxy_user_id") WHERE "carts"."oxy_user_id" is not null;--> statement-breakpoint
ALTER TABLE "cart_items" ADD CONSTRAINT "cart_items_merge_review_reason_check" CHECK ("cart_items"."merge_review_reason" in ('quantity_clamped_to_stock', 'quantity_clamped_to_limit', 'listing_unavailable', 'listing_remapped'));--> statement-breakpoint
ALTER TABLE "carts" ADD CONSTRAINT "carts_owner_exclusivity_check" CHECK (num_nonnulls("carts"."oxy_user_id", "carts"."guest_session_id") = 1);--> statement-breakpoint
-- `cart_merges` is APPEND-ONLY, the `mercaria_ledger_append_only` /
-- `mercaria_fee_record_append_only` posture applied to the merge audit. Every
-- counter is written ONCE, inside the merge transaction, computed from what
-- that transaction actually did — so a crashed merge leaves no half-counted row
-- to correct, and an aggregate anyone wants is a QUERY over these rows rather
-- than a stored total someone could patch. That is precisely what makes the
-- counters repairable: recompute from the events, never edit them.
--
-- A separate function rather than reusing the ledger's: the message names the
-- domain, and one shared "everything append-only" function would make a future
-- decision to relax one table's rule impossible to express.
CREATE FUNCTION mercaria_cart_merge_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'cart_merges is append-only: % on %.% is refused. A merge audit row is the record of one guest session''s single conversion; correct a mistaken merge by an operator-audited action, never by editing history.',
    TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME
    USING ERRCODE = 'check_violation';
END;
$$;--> statement-breakpoint
CREATE TRIGGER cart_merges_append_only
  BEFORE UPDATE OR DELETE ON "cart_merges"
  FOR EACH ROW EXECUTE FUNCTION mercaria_cart_merge_append_only();
