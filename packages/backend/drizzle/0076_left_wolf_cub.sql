-- oxy:deploy-phase=pre
-- oxy:rollback=derived
--
-- #93 — location publication, nearby discovery and collection.
--
-- ENTIRELY ADDITIVE: eight new tables and nothing touched on any existing one.
-- The operational `locations` row, its `inventory_levels` and every order the
-- serving image writes are unchanged, which is what makes this a `pre`
-- migration and what makes the previous image keep working beside it — it
-- writes to none of these tables and reads none of them.
--
-- ## The hand-written statements, and where they go on a regeneration
--
-- `drizzle-kit generate` DROPS everything below the generated section. On a
-- rebase: delete this file and its snapshot, restore `meta/_journal.json`,
-- rebuild shared-types, re-run `db:generate`, then re-apply BOTH blocks below
-- verbatim and grep the regenerated file for each trigger and function name.
-- There are TWO functions and THREE triggers: two enforce APPEND-ONLY trails
-- and the third freezes an order's collection snapshot. All three would apply
-- cleanly and enforce nothing if they were lost.
--
-- ## PostGIS
--
-- `location_publications.geo_point` is a STORED generated column over
-- `st_setsrid(st_makepoint(...))::geography`. `db/migrate.ts` ensures the
-- `postgis` extension BEFORE any migration runs, so this file may name the type
-- without a `CREATE EXTENSION` of its own — and a database where PostGIS is
-- absent fails at that precondition with a message about privileges rather than
-- here with a message about an unknown type.
--
-- The GiST index on that column is what makes `ST_DWithin` an index scan. An
-- index is the one thing a functional test can never detect the absence of, so
-- `pickup.realdb.test.ts` asserts it EXISTS in `pg_indexes` after migration.

CREATE TABLE "listing_local_discovery" (
	"id" text PRIMARY KEY NOT NULL,
	"listing_id" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"cell_lat_index" integer NOT NULL,
	"cell_lon_index" integer NOT NULL,
	"cell_precision_degrees" double precision NOT NULL,
	"area_label" text NOT NULL,
	"country" text NOT NULL,
	"region" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "listing_local_discovery_cell_range_check" CHECK ("listing_local_discovery"."cell_precision_degrees" > 0
          and "listing_local_discovery"."cell_lat_index" between floor(-90 / "listing_local_discovery"."cell_precision_degrees") and ceil(90 / "listing_local_discovery"."cell_precision_degrees")
          and "listing_local_discovery"."cell_lon_index" between floor(-180 / "listing_local_discovery"."cell_precision_degrees") and ceil(180 / "listing_local_discovery"."cell_precision_degrees"))
);
--> statement-breakpoint
CREATE TABLE "location_closures" (
	"id" text PRIMARY KEY NOT NULL,
	"publication_id" text NOT NULL,
	"from_date" date NOT NULL,
	"through_date" date NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "location_closures_range_check" CHECK ("location_closures"."from_date" <= "location_closures"."through_date")
);
--> statement-breakpoint
CREATE TABLE "location_opening_hours" (
	"id" text PRIMARY KEY NOT NULL,
	"publication_id" text NOT NULL,
	"weekday" integer NOT NULL,
	"opens_minute" integer NOT NULL,
	"closes_minute" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "location_opening_hours_weekday_check" CHECK ("location_opening_hours"."weekday" between 0 and 6),
	CONSTRAINT "location_opening_hours_range_check" CHECK ("location_opening_hours"."opens_minute" >= 0 and "location_opening_hours"."closes_minute" <= 1440 and "location_opening_hours"."opens_minute" < "location_opening_hours"."closes_minute")
);
--> statement-breakpoint
CREATE TABLE "location_publication_events" (
	"id" text PRIMARY KEY NOT NULL,
	"publication_id" text NOT NULL,
	"kind" text NOT NULL,
	"actor_oxy_user_id" text,
	"previous_latitude" double precision,
	"previous_longitude" double precision,
	"next_latitude" double precision,
	"next_longitude" double precision,
	"previous_state" text,
	"next_state" text,
	"note" text,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "location_publications" (
	"id" text PRIMARY KEY NOT NULL,
	"location_id" text NOT NULL,
	"store_id" text NOT NULL,
	"storefront_id" text,
	"display_name" text NOT NULL,
	"public_line1" text,
	"public_line2" text,
	"public_city" text,
	"public_region" text,
	"public_postal_code" text,
	"public_country" text NOT NULL,
	"timezone" text NOT NULL,
	"public_phone" text,
	"public_url" text,
	"accessibility_step_free" boolean,
	"accessibility_toilet" boolean,
	"accessibility_parking" boolean,
	"accessibility_hearing_loop" boolean,
	"latitude" double precision,
	"longitude" double precision,
	"geocode_provenance" text,
	"geocoded_at" timestamp with time zone,
	"geo_point" "geography" GENERATED ALWAYS AS (case when "latitude" is null or "longitude" is null then null
          else st_setsrid(st_makepoint("longitude", "latitude"), 4326)::geography end) STORED,
	"publication_state" text DEFAULT 'draft' NOT NULL,
	"pickup_offered" boolean DEFAULT false NOT NULL,
	"pickup_instructions" text,
	"identity_requirement" text DEFAULT 'collection_code' NOT NULL,
	"payment_requirement" text DEFAULT 'prepaid' NOT NULL,
	"pickup_paused_at" timestamp with time zone,
	"pickup_pause_reason" text,
	"restricted_at" timestamp with time zone,
	"restricted_by_oxy_user_id" text,
	"restriction_reason" text,
	"inventory_source" text NOT NULL,
	"stock_confirmation_interval_seconds" integer NOT NULL,
	"discloses_exact_stock" boolean DEFAULT false NOT NULL,
	"low_stock_threshold" integer DEFAULT 3 NOT NULL,
	"profile_confirmed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "location_publications_state_check" CHECK ("location_publications"."publication_state" in ('draft', 'published', 'withdrawn')),
	CONSTRAINT "location_publications_geocode_provenance_check" CHECK ("location_publications"."geocode_provenance" in ('merchant_map_pin', 'merchant_entered', 'operator_corrected')),
	CONSTRAINT "location_publications_inventory_source_check" CHECK ("location_publications"."inventory_source" in ('pos', 'connector', 'manual')),
	CONSTRAINT "location_publications_identity_requirement_check" CHECK ("location_publications"."identity_requirement" in ('order_number_only', 'collection_code', 'collection_code_and_photo_id')),
	CONSTRAINT "location_publications_payment_requirement_check" CHECK ("location_publications"."payment_requirement" in ('prepaid')),
	CONSTRAINT "location_publications_geocode_shape_check" CHECK (("location_publications"."latitude" is null) = ("location_publications"."longitude" is null)
          and ("location_publications"."latitude" is null) = ("location_publications"."geocode_provenance" is null)
          and ("location_publications"."latitude" is null) = ("location_publications"."geocoded_at" is null)),
	CONSTRAINT "location_publications_coordinate_range_check" CHECK ("location_publications"."latitude" is null
          or ("location_publications"."latitude" between -90 and 90
              and "location_publications"."longitude" between -180 and 180
              and not ("location_publications"."latitude" = 0 and "location_publications"."longitude" = 0))),
	CONSTRAINT "location_publications_stock_interval_check" CHECK ("stock_confirmation_interval_seconds" between 60 and 2592000),
	CONSTRAINT "location_publications_low_stock_threshold_check" CHECK ("location_publications"."low_stock_threshold" >= 0),
	CONSTRAINT "location_publications_pause_shape_check" CHECK (("location_publications"."pickup_paused_at" is null) = ("location_publications"."pickup_pause_reason" is null)),
	CONSTRAINT "location_publications_restriction_shape_check" CHECK (("location_publications"."restricted_at" is null) = ("location_publications"."restriction_reason" is null)
          and ("location_publications"."restricted_at" is null) = ("location_publications"."restricted_by_oxy_user_id" is null))
);
--> statement-breakpoint
CREATE TABLE "order_pickups" (
	"id" text PRIMARY KEY NOT NULL,
	"order_id" text NOT NULL,
	"location_id" text NOT NULL,
	"publication_id" text NOT NULL,
	"display_name" text NOT NULL,
	"public_line1" text,
	"public_line2" text,
	"public_city" text,
	"public_region" text,
	"public_postal_code" text,
	"public_country" text NOT NULL,
	"timezone" text NOT NULL,
	"pickup_instructions" text,
	"identity_requirement" text NOT NULL,
	"payment_requirement" text NOT NULL,
	"state" text DEFAULT 'awaiting_preparation' NOT NULL,
	"ready_at" timestamp with time zone,
	"collected_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"cancel_reason" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "order_pickups_state_check" CHECK ("order_pickups"."state" in ('awaiting_preparation', 'ready_for_pickup', 'collected', 'pickup_cancelled')),
	CONSTRAINT "order_pickups_identity_requirement_check" CHECK ("order_pickups"."identity_requirement" in ('order_number_only', 'collection_code', 'collection_code_and_photo_id')),
	CONSTRAINT "order_pickups_payment_requirement_check" CHECK ("order_pickups"."payment_requirement" in ('prepaid')),
	CONSTRAINT "order_pickups_state_instant_check" CHECK (("order_pickups"."state" = 'collected') = ("order_pickups"."collected_at" is not null)
          and ("order_pickups"."state" = 'pickup_cancelled') = ("order_pickups"."cancelled_at" is not null)
          and ("order_pickups"."state" = 'pickup_cancelled') = ("order_pickups"."cancel_reason" is not null)),
	CONSTRAINT "order_pickups_ready_instant_check" CHECK ("order_pickups"."state" <> 'ready_for_pickup' or "order_pickups"."ready_at" is not null)
);
--> statement-breakpoint
CREATE TABLE "pickup_collection_credentials" (
	"id" text PRIMARY KEY NOT NULL,
	"order_id" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"issued_at" timestamp with time zone NOT NULL,
	"rotated_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoke_reason" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "pickup_collection_credentials_version_check" CHECK ("pickup_collection_credentials"."version" >= 1),
	CONSTRAINT "pickup_collection_credentials_revocation_shape_check" CHECK (("pickup_collection_credentials"."revoked_at" is null) = ("pickup_collection_credentials"."revoke_reason" is null)),
	CONSTRAINT "pickup_collection_credentials_rotation_shape_check" CHECK (("pickup_collection_credentials"."version" > 1) = ("pickup_collection_credentials"."rotated_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "pickup_collection_events" (
	"id" text PRIMARY KEY NOT NULL,
	"order_id" text NOT NULL,
	"store_id" text NOT NULL,
	"kind" text NOT NULL,
	"actor_oxy_user_id" text,
	"credential_version" integer,
	"reason" text,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "pickup_collection_events_kind_check" CHECK ("pickup_collection_events"."kind" in ('code_validated', 'code_rejected', 'collected', 'collection_refused', 'code_rotated', 'code_revoked', 'marked_ready', 'pickup_cancelled', 'fallback_override')),
	CONSTRAINT "pickup_collection_events_override_reason_check" CHECK ("pickup_collection_events"."kind" <> 'fallback_override' or "pickup_collection_events"."reason" is not null)
);
--> statement-breakpoint
ALTER TABLE "listing_local_discovery" ADD CONSTRAINT "listing_local_discovery_listing_id_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."listings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "location_closures" ADD CONSTRAINT "location_closures_publication_id_location_publications_id_fk" FOREIGN KEY ("publication_id") REFERENCES "public"."location_publications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "location_opening_hours" ADD CONSTRAINT "location_opening_hours_publication_id_location_publications_id_fk" FOREIGN KEY ("publication_id") REFERENCES "public"."location_publications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "location_publication_events" ADD CONSTRAINT "location_publication_events_publication_id_location_publications_id_fk" FOREIGN KEY ("publication_id") REFERENCES "public"."location_publications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "location_publications" ADD CONSTRAINT "location_publications_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "location_publications" ADD CONSTRAINT "location_publications_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "location_publications" ADD CONSTRAINT "location_publications_storefront_id_storefronts_id_fk" FOREIGN KEY ("storefront_id") REFERENCES "public"."storefronts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_pickups" ADD CONSTRAINT "order_pickups_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_pickups" ADD CONSTRAINT "order_pickups_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_pickups" ADD CONSTRAINT "order_pickups_publication_id_location_publications_id_fk" FOREIGN KEY ("publication_id") REFERENCES "public"."location_publications"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pickup_collection_credentials" ADD CONSTRAINT "pickup_collection_credentials_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pickup_collection_events" ADD CONSTRAINT "pickup_collection_events_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pickup_collection_events" ADD CONSTRAINT "pickup_collection_events_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "listing_local_discovery_listing_id_key" ON "listing_local_discovery" USING btree ("listing_id");--> statement-breakpoint
CREATE INDEX "listing_local_discovery_cell_idx" ON "listing_local_discovery" USING btree ("cell_lat_index","cell_lon_index") WHERE "listing_local_discovery"."enabled";--> statement-breakpoint
CREATE INDEX "location_closures_publication_id_through_idx" ON "location_closures" USING btree ("publication_id","through_date");--> statement-breakpoint
CREATE UNIQUE INDEX "location_opening_hours_publication_weekday_opens_key" ON "location_opening_hours" USING btree ("publication_id","weekday","opens_minute");--> statement-breakpoint
CREATE INDEX "location_opening_hours_publication_id_idx" ON "location_opening_hours" USING btree ("publication_id");--> statement-breakpoint
CREATE INDEX "location_publication_events_publication_id_occurred_idx" ON "location_publication_events" USING btree ("publication_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "location_publications_location_id_key" ON "location_publications" USING btree ("location_id");--> statement-breakpoint
CREATE INDEX "location_publications_store_id_state_idx" ON "location_publications" USING btree ("store_id","publication_state");--> statement-breakpoint
CREATE INDEX "location_publications_published_country_idx" ON "location_publications" USING btree ("public_country") WHERE "location_publications"."publication_state" = 'published';--> statement-breakpoint
CREATE INDEX "location_publications_geo_point_idx" ON "location_publications" USING gist ("geo_point") WHERE "location_publications"."geo_point" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "order_pickups_order_id_key" ON "order_pickups" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "order_pickups_location_id_state_idx" ON "order_pickups" USING btree ("location_id","state");--> statement-breakpoint
CREATE INDEX "order_pickups_publication_id_idx" ON "order_pickups" USING btree ("publication_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pickup_collection_credentials_order_id_key" ON "pickup_collection_credentials" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "pickup_collection_events_order_id_occurred_idx" ON "pickup_collection_events" USING btree ("order_id","occurred_at");--> statement-breakpoint
CREATE INDEX "pickup_collection_events_store_id_occurred_idx" ON "pickup_collection_events" USING btree ("store_id","occurred_at");--> statement-breakpoint

-- ============================================================================
-- HAND-WRITTEN BLOCK 1 — the two append-only trails.
--
-- `location_publication_events` and `pickup_collection_events` refuse UPDATE
-- *and* DELETE. #93 operations rules 5 and 10 ask for publication, geocoding
-- and collection-override changes to be audited, and an audit an operator can
-- edit is not one. The half that matters most is the REFUSAL record: a person
-- turned away at a counter is what a support call is about, and a trail that
-- kept only successes could not answer it.
--
-- `pickup_collection_credentials` is NOT append-only — it is a rotation
-- counter and its whole job is to move.
-- ============================================================================
CREATE OR REPLACE FUNCTION mercaria_pickup_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only (%): #93 audit trails are not editable',
    TG_TABLE_NAME, TG_OP;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER location_publication_events_append_only
  BEFORE UPDATE OR DELETE ON location_publication_events
  FOR EACH ROW EXECUTE FUNCTION mercaria_pickup_append_only();--> statement-breakpoint

CREATE TRIGGER pickup_collection_events_append_only
  BEFORE UPDATE OR DELETE ON pickup_collection_events
  FOR EACH ROW EXECUTE FUNCTION mercaria_pickup_append_only();--> statement-breakpoint

-- ============================================================================
-- HAND-WRITTEN BLOCK 2 — the order's collection snapshot is frozen.
--
-- Every column copied from the publication at checkout refuses to move. #93
-- pickup rule 4 wants the location, address and instructions SNAPSHOTTED onto
-- the order; a snapshot a later edit can rewrite is not one, and the failure is
-- silent — a merchant corrects their shop front and every placed collection
-- quietly starts saying something the buyer never agreed to.
--
-- `state` and its four instants are deliberately OUTSIDE the freeze: they are
-- the operational half of the row and moving them is the whole point.
--
-- `publication_id` is frozen too, which is what keeps the trace honest: the
-- snapshot has to name the version of the profile it was taken from.
-- ============================================================================
CREATE OR REPLACE FUNCTION mercaria_order_pickup_snapshot_immutable() RETURNS trigger AS $$
BEGIN
  IF NEW.order_id IS DISTINCT FROM OLD.order_id
     OR NEW.location_id IS DISTINCT FROM OLD.location_id
     OR NEW.publication_id IS DISTINCT FROM OLD.publication_id
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
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER order_pickups_snapshot_immutable
  BEFORE UPDATE ON order_pickups
  FOR EACH ROW EXECUTE FUNCTION mercaria_order_pickup_snapshot_immutable();
