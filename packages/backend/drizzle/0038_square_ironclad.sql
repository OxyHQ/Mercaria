-- oxy:deploy-phase=pre
-- oxy:rollback=restore: catalog_merge_jobs_phase_check, catalog_merge_job_phases_phase_check and catalog_split_jobs_phase_check are widened for a new merge phase; the previous forms are in 0032 and re-adding them fails against any job that recorded the added phase
--
-- Canonical product saves (#80) — entirely ADDITIVE, which is what makes this a
-- `pre` migration: three new tables the serving image never reads, one new
-- `favorites` column with a DEFAULT so every existing row is classified without
-- being rewritten, one new index, and three CHECK widenings.
--
-- The three CHECK widenings are a DROP followed by an ADD in one file, and the
-- new predicate is a strict SUPERSET of the old one (`saves` joins the merge and
-- split phase tuples). The previous image writes only values the widened CHECK
-- already admits, so the serving image is never in a state this migration
-- breaks — the property `pre` means, stated rather than assumed.
--
-- ## Where the hand-written statements go on a regeneration
--
-- `bun run db:generate` DROPS everything below the anchor at the bottom of this
-- file. After regenerating, re-append that whole block verbatim and re-check
-- that this header is still the only deploy-phase marker line in the file.

CREATE TABLE "product_save_aggregates" (
	"id" text PRIMARY KEY NOT NULL,
	"canonical_product_id" text NOT NULL,
	"save_count" integer DEFAULT 0 NOT NULL,
	"last_rebuilt_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "product_save_aggregates_save_count_check" CHECK ("product_save_aggregates"."save_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "product_save_sources" (
	"id" text PRIMARY KEY NOT NULL,
	"save_id" text,
	"favorite_id" text NOT NULL,
	"listing_id" text NOT NULL,
	"product_variant_id" text NOT NULL,
	"migration_version" text NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	CONSTRAINT "product_save_sources_migration_version_check" CHECK (btrim("product_save_sources"."migration_version") <> '')
);
--> statement-breakpoint
CREATE TABLE "product_saves" (
	"id" text PRIMARY KEY NOT NULL,
	"oxy_user_id" text NOT NULL,
	"canonical_product_id" text NOT NULL,
	"preferred_canonical_variant_id" text,
	"preferred_condition_group" text,
	"preferred_merchant_id" text,
	"source_context" text NOT NULL,
	"visibility" text DEFAULT 'private' NOT NULL,
	"resolution_state" text DEFAULT 'resolved' NOT NULL,
	"ambiguous_split_job_id" text,
	"reference_price_amount" bigint,
	"reference_price_currency" text,
	"reference_price_observed_at" timestamp with time zone,
	"migration_version" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "product_saves_oxy_user_id_check" CHECK (btrim("product_saves"."oxy_user_id") <> ''),
	CONSTRAINT "product_saves_source_context_check" CHECK ("product_saves"."source_context" in ('product_page', 'product_card', 'offer_comparison', 'search_results', 'listing_page', 'saved_list', 'favorite_migration', 'split_resolution')),
	CONSTRAINT "product_saves_visibility_check" CHECK ("product_saves"."visibility" in ('private')),
	CONSTRAINT "product_saves_resolution_state_check" CHECK ("product_saves"."resolution_state" in ('resolved', 'ambiguous_after_split')),
	CONSTRAINT "product_saves_preferred_condition_group_check" CHECK ("product_saves"."preferred_condition_group" in ('new', 'open_box', 'refurbished', 'used', 'for_parts')),
	CONSTRAINT "product_saves_ambiguity_check" CHECK (("product_saves"."resolution_state" = 'ambiguous_after_split') = ("product_saves"."ambiguous_split_job_id" is not null)),
	CONSTRAINT "product_saves_reference_price_shape_check" CHECK (num_nonnulls("product_saves"."reference_price_amount", "product_saves"."reference_price_currency", "product_saves"."reference_price_observed_at") in (0, 3)),
	CONSTRAINT "product_saves_reference_price_range_check" CHECK ("product_saves"."reference_price_amount" is null
          or ("product_saves"."reference_price_amount" >= 0
              and "product_saves"."reference_price_amount" <= 9007199254740991)),
	CONSTRAINT "product_saves_reference_price_currency_check" CHECK ("product_saves"."reference_price_currency" is null or btrim("product_saves"."reference_price_currency") <> ''),
	CONSTRAINT "product_saves_migration_version_check" CHECK ("product_saves"."migration_version" is null or btrim("product_saves"."migration_version") <> '')
);
--> statement-breakpoint
ALTER TABLE "catalog_merge_job_phases" DROP CONSTRAINT "catalog_merge_job_phases_phase_check";--> statement-breakpoint
ALTER TABLE "catalog_merge_jobs" DROP CONSTRAINT "catalog_merge_jobs_phase_check";--> statement-breakpoint
ALTER TABLE "catalog_split_jobs" DROP CONSTRAINT "catalog_split_jobs_phase_check";--> statement-breakpoint
ALTER TABLE "favorites" ADD COLUMN "save_intent" text DEFAULT 'listing_save' NOT NULL;--> statement-breakpoint
ALTER TABLE "product_save_aggregates" ADD CONSTRAINT "product_save_aggregates_canonical_product_id_canonical_products_id_fk" FOREIGN KEY ("canonical_product_id") REFERENCES "public"."canonical_products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_save_sources" ADD CONSTRAINT "product_save_sources_save_id_product_saves_id_fk" FOREIGN KEY ("save_id") REFERENCES "public"."product_saves"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_save_sources" ADD CONSTRAINT "product_save_sources_favorite_id_favorites_id_fk" FOREIGN KEY ("favorite_id") REFERENCES "public"."favorites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_save_sources" ADD CONSTRAINT "product_save_sources_listing_id_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."listings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_save_sources" ADD CONSTRAINT "product_save_sources_product_variant_id_product_variants_id_fk" FOREIGN KEY ("product_variant_id") REFERENCES "public"."product_variants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_saves" ADD CONSTRAINT "product_saves_canonical_product_id_canonical_products_id_fk" FOREIGN KEY ("canonical_product_id") REFERENCES "public"."canonical_products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_saves" ADD CONSTRAINT "product_saves_preferred_canonical_variant_id_canonical_variants_id_fk" FOREIGN KEY ("preferred_canonical_variant_id") REFERENCES "public"."canonical_variants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_saves" ADD CONSTRAINT "product_saves_preferred_merchant_id_merchants_id_fk" FOREIGN KEY ("preferred_merchant_id") REFERENCES "public"."merchants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_saves" ADD CONSTRAINT "product_saves_ambiguous_split_job_id_catalog_split_jobs_id_fk" FOREIGN KEY ("ambiguous_split_job_id") REFERENCES "public"."catalog_split_jobs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "product_save_aggregates_canonical_product_id_key" ON "product_save_aggregates" USING btree ("canonical_product_id");--> statement-breakpoint
CREATE INDEX "product_save_aggregates_last_rebuilt_at_idx" ON "product_save_aggregates" USING btree ("last_rebuilt_at");--> statement-breakpoint
CREATE UNIQUE INDEX "product_save_sources_favorite_id_migration_version_key" ON "product_save_sources" USING btree ("favorite_id","migration_version");--> statement-breakpoint
CREATE INDEX "product_save_sources_save_id_idx" ON "product_save_sources" USING btree ("save_id");--> statement-breakpoint
CREATE INDEX "product_save_sources_listing_id_idx" ON "product_save_sources" USING btree ("listing_id");--> statement-breakpoint
CREATE UNIQUE INDEX "product_saves_oxy_user_id_canonical_product_id_key" ON "product_saves" USING btree ("oxy_user_id","canonical_product_id");--> statement-breakpoint
CREATE INDEX "product_saves_oxy_user_id_created_at_id_idx" ON "product_saves" USING btree ("oxy_user_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "product_saves_canonical_product_id_idx" ON "product_saves" USING btree ("canonical_product_id");--> statement-breakpoint
CREATE INDEX "product_saves_preferred_canonical_variant_id_idx" ON "product_saves" USING btree ("preferred_canonical_variant_id") WHERE "product_saves"."preferred_canonical_variant_id" is not null;--> statement-breakpoint
CREATE INDEX "product_saves_preferred_merchant_id_idx" ON "product_saves" USING btree ("preferred_merchant_id") WHERE "product_saves"."preferred_merchant_id" is not null;--> statement-breakpoint
CREATE INDEX "product_saves_ambiguous_idx" ON "product_saves" USING btree ("oxy_user_id","created_at" DESC NULLS LAST) WHERE "product_saves"."resolution_state" = 'ambiguous_after_split';--> statement-breakpoint
CREATE INDEX "favorites_oxy_user_id_created_at_id_idx" ON "favorites" USING btree ("oxy_user_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "favorites" ADD CONSTRAINT "favorites_save_intent_check" CHECK ("favorites"."save_intent" in ('listing_save', 'listing_pin'));--> statement-breakpoint
ALTER TABLE "catalog_merge_job_phases" ADD CONSTRAINT "catalog_merge_job_phases_phase_check" CHECK ("catalog_merge_job_phases"."phase" in ('plan', 'awaiting_resolution', 'children', 'identifiers', 'aliases', 'source_links', 'offers', 'relationships', 'reviews', 'saves', 'redirects', 'rollups', 'verify', 'done'));--> statement-breakpoint
ALTER TABLE "catalog_merge_jobs" ADD CONSTRAINT "catalog_merge_jobs_phase_check" CHECK ("catalog_merge_jobs"."phase" in ('plan', 'awaiting_resolution', 'children', 'identifiers', 'aliases', 'source_links', 'offers', 'relationships', 'reviews', 'saves', 'redirects', 'rollups', 'verify', 'done'));--> statement-breakpoint
ALTER TABLE "catalog_split_jobs" ADD CONSTRAINT "catalog_split_jobs_phase_check" CHECK ("catalog_split_jobs"."phase" in ('plan', 'mint', 'assignments', 'saves', 'redirects', 'rollups', 'verify', 'done'));--> statement-breakpoint
-- ── HAND-WRITTEN BLOCK — re-append verbatim after any regeneration ──────────
--
-- `product_save_sources` is APPEND-ONLY, the `mercaria_condition_revisions_append_only`
-- posture with TWO precise exceptions rather than one.
--
-- DELETE is refused only while the favorite it names still EXISTS — that
-- foreign key says `ON DELETE cascade`, so an unconditional refusal would make
-- a buyer unable to un-save a listing, while an unconditional permission would
-- let an operator remove one migration record to hide it. During a cascade the
-- parent row is already gone from the statement's snapshot, so the EXISTS is
-- false and the child row goes with it.
--
-- UPDATE is refused except for the ONE shape a referential action produces:
-- `save_id` moving to NULL and nothing else changing, which is the
-- `ON DELETE SET NULL` fired when a buyer un-saves the product. That record
-- STAYS, deliberately — it is what stops a migration replay resurrecting a save
-- somebody removed on purpose. Every other update, including rewriting the
-- migration version or re-pointing the favorite, is refused.
CREATE OR REPLACE FUNCTION mercaria_product_save_sources_append_only() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.save_id IS NULL
       AND OLD.save_id IS NOT NULL
       AND NEW.id = OLD.id
       AND NEW.favorite_id = OLD.favorite_id
       AND NEW.listing_id = OLD.listing_id
       AND NEW.product_variant_id = OLD.product_variant_id
       AND NEW.migration_version = OLD.migration_version
       AND NEW.recorded_at = OLD.recorded_at THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'product_save_sources is append-only; a new reading is a NEW row'
      USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM favorites WHERE id = OLD.favorite_id) THEN
    RAISE EXCEPTION
      'a product save source can only be removed with the favorite it records'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER product_save_sources_append_only
  BEFORE UPDATE OR DELETE ON product_save_sources
  FOR EACH ROW EXECUTE FUNCTION mercaria_product_save_sources_append_only();--> statement-breakpoint

-- ── The save a migration created is never re-attributed ─────────────────────
--
-- `migration_version` may be written once, at INSERT, and never changed
-- afterwards — neither set on a save a person made themselves nor cleared from
-- one the migration created. It is the answer to "how many of these saves did
-- buyers actually make", and a column an UPDATE could move is not an answer to
-- that question. The buyer's own edits (preferences, split resolution) are
-- untouched, which is why this is a targeted comparison and not an immutability
-- trigger over the row.
CREATE OR REPLACE FUNCTION mercaria_product_save_migration_version_frozen() RETURNS trigger AS $$
BEGIN
  IF NEW.migration_version IS DISTINCT FROM OLD.migration_version THEN
    RAISE EXCEPTION
      'product_saves.migration_version records who created the save and cannot be changed'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER product_saves_migration_version_frozen
  BEFORE UPDATE ON product_saves
  FOR EACH ROW EXECUTE FUNCTION mercaria_product_save_migration_version_frozen();
