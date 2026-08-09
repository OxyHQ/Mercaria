-- oxy:deploy-phase=pre
--
-- Guest checkout contact and buyer origin on orders (#105, ADR 0003 D4/D6).
--
-- WHY THIS IS `pre`, in full, because the phase is the one thing here that
-- cannot be recovered from by reading the diff:
--
--   * `guest_checkouts` and the two new `orders` columns are ADDITIVE. The
--     image still serving selects columns by NAME and never mentions them, so
--     it is unaffected.
--   * `ALTER COLUMN orders.buyer_oxy_user_id DROP NOT NULL` is a WIDENING. The
--     serving image always writes that column, so no NULL can appear before the
--     new code is live — ADR 0003 stages this as M1 verbatim.
--   * `orders_buyer_identity_check` is added VALIDATED rather than `NOT VALID`.
--     The ADR stages it `NOT VALID` because it expects the check to reference
--     `claimed_by_oxy_user_id`/`claimed_at` (which are #106's columns and do
--     not exist yet) AND because it expects connector `ext:` rows to violate
--     the final shape. Neither applies to the form landed here: every existing
--     row has `buyer_origin = 'oxy'` (the fast default) with a non-null
--     `buyer_oxy_user_id` and a null `buyer_guest_checkout_id`, which is
--     exactly the first disjunct — including the `ext:` rows, whose value is a
--     string like any other. The backfill below then MOVES those rows to
--     `'external'`, where the constraint deliberately leaves
--     `buyer_oxy_user_id` unconstrained so their provenance survives until
--     ADR 0003 M9 retires it.
--
-- Nothing is dropped, renamed or narrowed, so there is no `post` half.
--
-- ## The two triggers are hand-written and MUST ship with the tables
--
-- drizzle-kit does not model triggers, so ADR 0003 D4's and D6's immutability
-- contracts have to be appended here. They are in the SAME migration as the
-- DDL, and the ordering matters: a window in which `guest_checkouts` exists and
-- its trigger does not is a window in which a placed order's contact can be
-- rewritten, which is the one thing the row exists to prevent.

CREATE TABLE "guest_checkouts" (
	"id" text PRIMARY KEY NOT NULL,
	"checkout_group_id" text NOT NULL,
	"guest_session_id" text NOT NULL,
	"email_ciphertext" text,
	"email_hash" text,
	"email_redacted" text NOT NULL,
	"phone_ciphertext" text,
	"phone_redacted" text,
	"contact_verification_stage" text DEFAULT 'pending' NOT NULL,
	"marketing_opt_in" boolean DEFAULT false NOT NULL,
	"locale" text,
	"anonymized_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "guest_checkouts_contact_verification_stage_check" CHECK ("guest_checkouts"."contact_verification_stage" in ('pending', 'verified_before_payment', 'verified_after_payment')),
	CONSTRAINT "guest_checkouts_email_pair_check" CHECK (num_nonnulls("guest_checkouts"."email_ciphertext", "guest_checkouts"."email_hash") in (0, 2)),
	CONSTRAINT "guest_checkouts_anonymization_check" CHECK (("guest_checkouts"."anonymized_at" is null and "guest_checkouts"."email_ciphertext" is not null)
          or ("guest_checkouts"."anonymized_at" is not null
              and "guest_checkouts"."email_ciphertext" is null
              and "guest_checkouts"."email_hash" is null
              and "guest_checkouts"."phone_ciphertext" is null
              and "guest_checkouts"."email_redacted" = 'deleted')),
	CONSTRAINT "guest_checkouts_phone_pair_check" CHECK (num_nonnulls("guest_checkouts"."phone_ciphertext", "guest_checkouts"."phone_redacted") in (0, 2))
);
--> statement-breakpoint
ALTER TABLE "orders" ALTER COLUMN "buyer_oxy_user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "buyer_origin" text DEFAULT 'oxy' NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "buyer_guest_checkout_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX "guest_checkouts_checkout_group_id_key" ON "guest_checkouts" USING btree ("checkout_group_id");--> statement-breakpoint
CREATE INDEX "guest_checkouts_email_hash_idx" ON "guest_checkouts" USING btree ("email_hash") WHERE "guest_checkouts"."email_hash" is not null;--> statement-breakpoint
CREATE INDEX "guest_checkouts_guest_session_id_idx" ON "guest_checkouts" USING btree ("guest_session_id");--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_buyer_guest_checkout_id_guest_checkouts_id_fk" FOREIGN KEY ("buyer_guest_checkout_id") REFERENCES "public"."guest_checkouts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "orders_buyer_guest_checkout_id_idx" ON "orders" USING btree ("buyer_guest_checkout_id") WHERE "orders"."buyer_guest_checkout_id" is not null;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_buyer_origin_check" CHECK ("orders"."buyer_origin" in ('oxy', 'guest', 'external'));--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_buyer_identity_check" CHECK (("orders"."buyer_origin" = 'oxy'
             and "orders"."buyer_oxy_user_id" is not null
             and "orders"."buyer_guest_checkout_id" is null)
          or ("orders"."buyer_origin" = 'guest'
             and "orders"."buyer_guest_checkout_id" is not null
             and "orders"."buyer_oxy_user_id" is null)
          or ("orders"."buyer_origin" = 'external'
             and "orders"."buyer_guest_checkout_id" is null));--> statement-breakpoint

-- ADR 0003 M4's backfill, in the same migration as the column it fills.
--
-- A connector-imported order is `'external'`, and `source_connection_id IS NOT
-- NULL` is the discriminator the ADR names — not the `ext:` prefix on
-- `buyer_oxy_user_id`, which is a string convention nothing enforces and which
-- M9 will stop writing. Unbatched: the ADR stages this as keyed 5 000-row
-- batches for a table that has grown, and at the current table age (the
-- Postgres cutover was 2026-08-08) one statement inside the migrator's
-- transaction is the simpler correct form. The batching discipline is noted
-- for when it no longer is.
UPDATE "orders"
   SET "buyer_origin" = 'external'
 WHERE "source_connection_id" IS NOT NULL
   AND "buyer_origin" = 'oxy';--> statement-breakpoint

-- ADR 0003 D4: the contact is immutable except for the anonymization
-- transition.
--
-- A CHECK cannot express this — it sees one row, not a change — so the
-- contract needs a trigger. What it forbids is the one edit that would
-- otherwise be reachable from an ordinary UPDATE: re-pointing a placed group's
-- contact at a different inbox, or moving the row to another session. What it
-- PERMITS is deliberately narrow: the contact columns may go to NULL (D15's
-- erasure), the verification stage may move (#108), and `updated_at` moves with
-- either.
--
-- `IS DISTINCT FROM` rather than `<>`, throughout: a NULL on either side makes
-- `<>` NULL, which is not TRUE, which would let exactly the transitions this
-- guards slip past unnoticed.
CREATE FUNCTION mercaria_guest_checkout_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.checkout_group_id IS DISTINCT FROM OLD.checkout_group_id THEN
    RAISE EXCEPTION 'guest_checkouts.checkout_group_id is immutable (ADR 0003 D4)';
  END IF;
  IF NEW.guest_session_id IS DISTINCT FROM OLD.guest_session_id THEN
    RAISE EXCEPTION 'guest_checkouts.guest_session_id is immutable (ADR 0003 D4)';
  END IF;
  IF NEW.email_ciphertext IS DISTINCT FROM OLD.email_ciphertext
     AND NEW.email_ciphertext IS NOT NULL THEN
    RAISE EXCEPTION 'guest_checkouts contact may only change to NULL (ADR 0003 D4/D15)';
  END IF;
  IF NEW.email_hash IS DISTINCT FROM OLD.email_hash AND NEW.email_hash IS NOT NULL THEN
    RAISE EXCEPTION 'guest_checkouts contact may only change to NULL (ADR 0003 D4/D15)';
  END IF;
  IF NEW.phone_ciphertext IS DISTINCT FROM OLD.phone_ciphertext
     AND NEW.phone_ciphertext IS NOT NULL THEN
    RAISE EXCEPTION 'guest_checkouts contact may only change to NULL (ADR 0003 D4/D15)';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER guest_checkouts_immutable
  BEFORE UPDATE ON "guest_checkouts"
  FOR EACH ROW EXECUTE FUNCTION mercaria_guest_checkout_immutable();--> statement-breakpoint

-- ADR 0003 D6/I7: an order's buyer ORIGIN is immutable after insert.
--
-- "Who placed this order" and "who owns it now" are two facts, and a claim
-- (#109) records the second in its own column rather than rewriting the first.
-- The trigger is what makes that structural instead of a rule reviewers have to
-- remember: there is no service path that could rewrite an origin, because the
-- database refuses.
--
-- `buyer_oxy_user_id` is guarded as "may not change once SET" rather than
-- "immutable": #106's claim work does not touch it either, but the column is
-- NULL for every guest order and a future path that legitimately fills a NULL
-- (there is none today) must not be blocked by a rule written for a case that
-- does not exist. Changing a value that is already there is the dangerous
-- direction and is the one refused.
--
-- #106 EXTENDS this function when it adds `claimed_by_oxy_user_id`/`claimed_at`
-- (NULL -> value for a claim, value -> NULL for an audited operator unclaim,
-- never value -> value). It does not add a second trigger: one place says what
-- a buyer identity may become.
CREATE FUNCTION mercaria_order_buyer_origin_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
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
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER orders_buyer_origin_immutable
  BEFORE UPDATE ON "orders"
  FOR EACH ROW EXECUTE FUNCTION mercaria_order_buyer_origin_immutable();
