-- oxy:deploy-phase=pre
--
-- #427: a merchant can release one connector-pinned field, and the release is
-- attributable.
--
-- `pre` because every statement is ADDITIVE — one new table, its foreign key,
-- its index and its append-only trigger. Nothing here breaks a write the
-- serving image performs: that image never inserts into a table it does not
-- know about, and `listings.overridden_fields` is untouched.
--
-- ON REGENERATION: drizzle-kit emits the CREATE TABLE, the ADD CONSTRAINT and
-- the CREATE INDEX and DROPS the anchored block below them. Re-apply that block
-- verbatim, after them. (Regenerated twice already, rebasing behind #367 step
-- 4's own 0097 and step 5's own 0098 — so the number in this filename is not
-- load-bearing and the block below is what has to survive.)
CREATE TABLE "listing_pin_releases" (
	"id" text PRIMARY KEY NOT NULL,
	"listing_id" text NOT NULL,
	"field" text NOT NULL,
	"released_by_oxy_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "listing_pin_releases_field_check" CHECK (length(btrim("listing_pin_releases"."field")) > 0)
);
--> statement-breakpoint
ALTER TABLE "listing_pin_releases" ADD CONSTRAINT "listing_pin_releases_listing_id_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."listings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "listing_pin_releases_listing_id_created_at_idx" ON "listing_pin_releases" USING btree ("listing_id","created_at" DESC NULLS LAST);--> statement-breakpoint

-- ── The release trail is append-only (#427) ─────────────────────────────────
--
-- A pin records itself: the key's presence in `listings.overridden_fields` IS
-- the evidence that a merchant took the field over. A RELEASE removes that key,
-- so it destroys the only trace the pin ever existed — and what a merchant sees
-- afterwards is the platform overwriting a title somebody wrote by hand, with
-- nothing connecting it to a person who pressed a control weeks earlier.
--
-- So the erasing act is the one written down, and a trail that can be edited
-- afterwards is a second mutable copy of the current state rather than a trail.
--
-- DELETE is refused only while the listing still EXISTS, which is the
-- `listing_condition_revisions` exception and is what keeps this table's own
-- `ON DELETE cascade` working. An operator still cannot remove one row to hide
-- one release.
-- oxy:handwritten-begin=mercaria_listing_pin_releases_append_only
CREATE OR REPLACE FUNCTION mercaria_listing_pin_releases_append_only() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'listing_pin_releases is append-only; a re-pin is an EDIT, not a rewrite'
      USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM listings WHERE id = OLD.listing_id) THEN
    RAISE EXCEPTION
      'a pin release can only be removed with the listing it explains'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER mercaria_listing_pin_releases_append_only
  BEFORE UPDATE OR DELETE ON listing_pin_releases
  FOR EACH ROW EXECUTE FUNCTION mercaria_listing_pin_releases_append_only();
-- oxy:handwritten-end=mercaria_listing_pin_releases_append_only
