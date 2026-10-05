-- oxy:deploy-phase=pre
-- oxy:rollback=restore: mercaria_order_pickup_snapshot_immutable is replaced to freeze order_pickups.go_way_place_id too; its previous body is 0076's hand-written block 2. The four added columns and the index are the derived inverse of their ADDs
--
-- A location's place facts live in GoWay (ADR 0013), first half.
--
-- ADDITIVE, which is why the phase is `pre`: three nullable columns nothing in
-- the serving image reads or writes, one partial unique index over a column
-- that is NULL on every row, and the snapshot-freeze function replaced to cover
-- the new snapshot column as well. Read off the generated half: no DROP, no
-- NOT NULL, no rename.
--
-- - `locations.go_way_place_id` is the opaque GoWay place a location trades
--   from. Unique per store (see `db/schema/stores.ts`), led by the place id so
--   "which locations point at this place" is one probe.
-- - `location_publication_events.previous_go_way_place_id` / `next_…` are what
--   the trail records when a link changes, replacing the coordinate pair `0162`
--   drops.
-- - `order_pickups.go_way_place_id` is the place a collection's snapshot was
--   read from. NULL on every collection placed before this, which is the truth.
--
-- ## The hand-written half: the snapshot freeze covers the new column
--
-- `0076`'s block 2 lists the frozen columns by name, so a column added after it
-- is writable after insert unless the function is replaced. The image serving
-- while this applies never writes `go_way_place_id`, so the narrowing refuses
-- nothing it does. A regeneration drops the block AND the two marker lines; re-add
-- both and confirm
--
--   grep -cE '^-- oxy:(deploy-phase|rollback)=' drizzle/0159_awesome_titania.sql   -> 2
--   grep -cE '^-- oxy:handwritten-(begin|end)=' drizzle/0159_awesome_titania.sql   -> 2
ALTER TABLE "locations" ADD COLUMN "go_way_place_id" text;--> statement-breakpoint
ALTER TABLE "location_publication_events" ADD COLUMN "previous_go_way_place_id" text;--> statement-breakpoint
ALTER TABLE "location_publication_events" ADD COLUMN "next_go_way_place_id" text;--> statement-breakpoint
ALTER TABLE "order_pickups" ADD COLUMN "go_way_place_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX "locations_go_way_place_id_store_id_key" ON "locations" USING btree ("go_way_place_id","store_id") WHERE "locations"."go_way_place_id" is not null;
--> statement-breakpoint
-- oxy:handwritten-begin=mercaria_order_pickup_snapshot_immutable
CREATE OR REPLACE FUNCTION mercaria_order_pickup_snapshot_immutable() RETURNS trigger AS $$
BEGIN
  IF NEW.order_id IS DISTINCT FROM OLD.order_id
     OR NEW.location_id IS DISTINCT FROM OLD.location_id
     OR NEW.publication_id IS DISTINCT FROM OLD.publication_id
     OR NEW.go_way_place_id IS DISTINCT FROM OLD.go_way_place_id
     OR NEW.display_name IS DISTINCT FROM OLD.display_name
     OR NEW.public_line1 IS DISTINCT FROM OLD.public_line1
     OR NEW.public_line2 IS DISTINCT FROM OLD.public_line2
     OR NEW.public_city IS DISTINCT FROM OLD.public_city
     OR NEW.public_region IS DISTINCT FROM OLD.public_region
     OR NEW.public_postal_code IS DISTINCT FROM OLD.public_postal_code
     OR NEW.public_country IS DISTINCT FROM OLD.public_country
     OR NEW.timezone IS DISTINCT FROM OLD.timezone
     OR NEW.pickup_instructions IS DISTINCT FROM OLD.pickup_instructions
     OR NEW.identity_requirement IS DISTINCT FROM OLD.identity_requirement
     OR NEW.payment_requirement IS DISTINCT FROM OLD.payment_requirement THEN
    RAISE EXCEPTION 'order_pickups snapshot columns are immutable (#93 pickup rule 4)';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
-- oxy:handwritten-end=mercaria_order_pickup_snapshot_immutable
