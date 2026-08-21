-- oxy:deploy-phase=pre
--
-- Variant-scoped images on the NATIVE listing side (#850, epic #367).
--
-- Wholly ADDITIVE, so `pre`: one new table plus two new UNIQUE constraints on
-- existing tables. Nothing is dropped, narrowed or renamed, and the serving
-- image performs no write this breaks -- it cannot write
-- `product_variant_images` at all, and the two uniques constrain
-- (id, listing_id) pairs that are already unique because `id` alone is a
-- primary key. That last point is what makes them safe to add VALIDATED against
-- a populated table: the constraint cannot fail on an existing row, because a
-- duplicate would already have violated the primary key.
--
-- ## The statement ORDER below is hand-corrected. Re-apply it after any
-- ## regeneration, or this migration fails at APPLY time.
--
-- `product_variant_images` carries two COMPOSITE foreign keys -- the pair that
-- makes "an image belonging to another listing" unrepresentable rather than
-- refused. PostgreSQL resolves a composite foreign key against `pg_constraint`,
-- so each one needs its target's UNIQUE CONSTRAINT to exist FIRST.
--
-- drizzle-kit emits both `ADD CONSTRAINT ... UNIQUE` statements LAST, after the
-- foreign keys that depend on them. That generates cleanly, type-checks, and
-- dies on a real server with:
--
--     there is no unique constraint matching given keys for referenced table
--     "product_variants"
--
-- Measured here on 2026-08-21 by applying the whole chain from zero against
-- postgis/postgis:17-3.5 -- which is the only thing that catches it. No
-- functional test can: the failure is in DDL nothing exercises until deploy.
-- The two uniques are therefore moved ABOVE the foreign keys.
--
-- This header and that reordering were BOTH dropped by a regeneration once
-- already, exactly as the warning above says they would be. If you regenerate,
-- read the emitted file and put them back.

CREATE TABLE "product_variant_images" (
	"id" text PRIMARY KEY NOT NULL,
	"listing_id" text NOT NULL,
	"variant_id" text NOT NULL,
	"listing_image_id" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "product_variant_images_variant_id_listing_image_id_key" UNIQUE("variant_id","listing_image_id")
);
--> statement-breakpoint
ALTER TABLE "listing_images" ADD CONSTRAINT "listing_images_id_listing_id_key" UNIQUE("id","listing_id");--> statement-breakpoint
ALTER TABLE "product_variants" ADD CONSTRAINT "product_variants_id_listing_id_key" UNIQUE("id","listing_id");--> statement-breakpoint
ALTER TABLE "product_variant_images" ADD CONSTRAINT "product_variant_images_listing_id_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."listings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_variant_images" ADD CONSTRAINT "product_variant_images_variant_fk" FOREIGN KEY ("variant_id","listing_id") REFERENCES "public"."product_variants"("id","listing_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_variant_images" ADD CONSTRAINT "product_variant_images_listing_image_fk" FOREIGN KEY ("listing_image_id","listing_id") REFERENCES "public"."listing_images"("id","listing_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "product_variant_images_variant_id_position_idx" ON "product_variant_images" USING btree ("variant_id","position");--> statement-breakpoint
CREATE INDEX "product_variant_images_listing_image_id_idx" ON "product_variant_images" USING btree ("listing_image_id");--> statement-breakpoint
CREATE INDEX "product_variant_images_listing_id_idx" ON "product_variant_images" USING btree ("listing_id");
