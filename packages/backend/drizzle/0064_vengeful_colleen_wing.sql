-- oxy:deploy-phase=pre
-- oxy:rollback=restore: native_listing_links_method_check is widened for the backfill method; the previous form is in 0031 and re-adding it fails against any link stamped by #60's backfill
--
-- #91 — the canonical "Sell yours" flow.
--
-- Four new tables, one new index on `listing_images`, and ONE widening:
-- `native_listing_links_method_check` gains `seller_declared`, a strict SUPERSET,
-- so the serving image keeps writing every method it already writes. Everything
-- else is additive, which is what makes this a `pre` migration.
--
-- ## Regeneration protocol
--
-- The three trigger/function pairs at the FOOT of this file are hand-written and
-- `drizzle-kit generate` DROPS them. After regenerating, re-append the block
-- below the `-- ANCHOR:` marker verbatim, then confirm all three are back — and
-- ANCHOR both greps to start-of-line, or this header's own text inflates them:
--
--     grep -c '^CREATE OR REPLACE FUNCTION mercaria_seller_draft' <file>   # 3
--     grep -c '^-- oxy:deploy-phase' <file>                                # 1
--

CREATE TABLE "seller_draft_condition_details" (
	"id" text PRIMARY KEY NOT NULL,
	"draft_id" text NOT NULL,
	"kind" text NOT NULL,
	"severity" text,
	"note" text,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "seller_draft_condition_details_kind_check" CHECK ("seller_draft_condition_details"."kind" in ('cosmetic_wear', 'functional_defect', 'missing_accessory', 'original_packaging', 'repair_or_refurbishment', 'warranty', 'note')),
	CONSTRAINT "seller_draft_condition_details_severity_value_check" CHECK ("seller_draft_condition_details"."severity" in ('light', 'moderate', 'heavy')),
	CONSTRAINT "seller_draft_condition_details_severity_shape_check" CHECK ("seller_draft_condition_details"."severity" is null or "seller_draft_condition_details"."kind" in ('cosmetic_wear', 'functional_defect'))
);
--> statement-breakpoint
CREATE TABLE "seller_draft_images" (
	"id" text PRIMARY KEY NOT NULL,
	"draft_id" text NOT NULL,
	"file_id" text NOT NULL,
	"alt" text,
	"position" integer DEFAULT 0 NOT NULL,
	"provenance" text NOT NULL,
	"shows_defect" boolean DEFAULT false NOT NULL,
	"condition_detail_id" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "seller_draft_images_provenance_check" CHECK ("seller_draft_images"."provenance" in ('seller_captured', 'seller_uploaded'))
);
--> statement-breakpoint
CREATE TABLE "seller_draft_match_assertions" (
	"id" text PRIMARY KEY NOT NULL,
	"draft_id" text NOT NULL,
	"outcome" text NOT NULL,
	"actor" text NOT NULL,
	"actor_oxy_user_id" text,
	"canonical_product_id" text,
	"canonical_variant_id" text,
	"confidence" double precision,
	"blockers" text[] DEFAULT '{}'::text[] NOT NULL,
	"reason_codes" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "seller_draft_match_assertions_outcome_check" CHECK ("seller_draft_match_assertions"."outcome" in ('declared', 'confirmed', 'rejected', 'gate_refused', 'attached')),
	CONSTRAINT "seller_draft_match_assertions_actor_check" CHECK ("seller_draft_match_assertions"."actor" in ('seller', 'matcher', 'operator')),
	CONSTRAINT "seller_draft_match_assertions_blockers_check" CHECK ("seller_draft_match_assertions"."blockers" <@ array['conflicting_identifier', 'brand_mismatch', 'variant_attribute_mismatch', 'bundle_mismatch', 'multipack_mismatch', 'accessory_mismatch', 'replacement_part_mismatch', 'regional_variant_mismatch', 'category_mismatch', 'blocked_pair', 'category_gate_closed', 'ambiguous_candidates', 'below_auto_threshold', 'missing_required_attributes', 'no_deterministic_support', 'unresolved_product']::text[]),
	CONSTRAINT "seller_draft_match_assertions_actor_identity_check" CHECK (("seller_draft_match_assertions"."actor" = 'matcher') = ("seller_draft_match_assertions"."actor_oxy_user_id" is null)),
	CONSTRAINT "seller_draft_match_assertions_confidence_check" CHECK ("seller_draft_match_assertions"."confidence" is null
          or ("seller_draft_match_assertions"."actor" in ('matcher') and "seller_draft_match_assertions"."confidence" between 0 and 1)),
	CONSTRAINT "seller_draft_match_assertions_refusal_check" CHECK ("seller_draft_match_assertions"."outcome" <> 'gate_refused' or cardinality("seller_draft_match_assertions"."blockers") >= 1),
	CONSTRAINT "seller_draft_match_assertions_attachment_check" CHECK ("seller_draft_match_assertions"."outcome" <> 'attached'
          or ("seller_draft_match_assertions"."canonical_product_id" is not null and "seller_draft_match_assertions"."canonical_variant_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "seller_listing_drafts" (
	"id" text PRIMARY KEY NOT NULL,
	"oxy_user_id" text NOT NULL,
	"client_draft_key" text NOT NULL,
	"entry_path" text NOT NULL,
	"status" text DEFAULT 'in_progress' NOT NULL,
	"current_step" text DEFAULT 'identify' NOT NULL,
	"completed_steps" text[] DEFAULT '{}'::text[] NOT NULL,
	"canonical_product_id" text,
	"canonical_variant_id" text,
	"match_state" text DEFAULT 'unmatched' NOT NULL,
	"match_actor" text,
	"match_confidence" double precision,
	"title" text,
	"description" text,
	"category_id" text,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"condition_key" text,
	"defects_acknowledged_at" timestamp with time zone,
	"included_accessories" text[] DEFAULT '{}'::text[] NOT NULL,
	"quantity" integer DEFAULT 1 NOT NULL,
	"price_amount" bigint,
	"price_currency" text,
	"pickup" text DEFAULT 'not_offered' NOT NULL,
	"location_opt_in" boolean DEFAULT false NOT NULL,
	"location_longitude" double precision,
	"location_latitude" double precision,
	"published_listing_id" text,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "seller_listing_drafts_entry_path_check" CHECK ("seller_listing_drafts"."entry_path" in ('canonical_product', 'canonical_variant', 'identifier_scan', 'catalog_search', 'unmatched')),
	CONSTRAINT "seller_listing_drafts_status_check" CHECK ("seller_listing_drafts"."status" in ('in_progress', 'published', 'discarded')),
	CONSTRAINT "seller_listing_drafts_current_step_check" CHECK ("seller_listing_drafts"."current_step" in ('identify', 'condition', 'photos', 'details', 'price', 'review')),
	CONSTRAINT "seller_listing_drafts_completed_steps_check" CHECK ("seller_listing_drafts"."completed_steps" <@ array['identify', 'condition', 'photos', 'details', 'price', 'review']::text[]),
	CONSTRAINT "seller_listing_drafts_match_state_check" CHECK ("seller_listing_drafts"."match_state" in ('unmatched', 'proposed', 'seller_confirmed', 'seller_rejected', 'review_required')),
	CONSTRAINT "seller_listing_drafts_match_actor_check" CHECK ("seller_listing_drafts"."match_actor" in ('seller', 'matcher', 'operator')),
	CONSTRAINT "seller_listing_drafts_condition_check" CHECK ("seller_listing_drafts"."condition_key" in ('new', 'open_box', 'refurbished_manufacturer', 'refurbished_seller', 'used_like_new', 'used_good', 'used_fair', 'used_poor', 'for_parts')),
	CONSTRAINT "seller_listing_drafts_pickup_check" CHECK ("seller_listing_drafts"."pickup" in ('not_offered', 'offered')),
	CONSTRAINT "seller_listing_drafts_price_currency_check" CHECK ("seller_listing_drafts"."price_currency" in ('FAIR', 'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF', 'CNY', 'SEK', 'NOK', 'DKK', 'PLN', 'MXN', 'BRL', 'INR', 'NZD', 'ZAR', 'SGD', 'HKD', 'AED')),
	CONSTRAINT "seller_listing_drafts_match_shape_check" CHECK (("seller_listing_drafts"."match_state" in ('unmatched', 'seller_rejected')
             and "seller_listing_drafts"."canonical_product_id" is null and "seller_listing_drafts"."canonical_variant_id" is null)
          or ("seller_listing_drafts"."match_state" not in ('unmatched', 'seller_rejected')
             and "seller_listing_drafts"."canonical_product_id" is not null)),
	CONSTRAINT "seller_listing_drafts_variant_implies_product_check" CHECK ("seller_listing_drafts"."canonical_variant_id" is null or "seller_listing_drafts"."canonical_product_id" is not null),
	CONSTRAINT "seller_listing_drafts_match_confidence_check" CHECK ("seller_listing_drafts"."match_confidence" is null
          or ("seller_listing_drafts"."match_actor" in ('matcher') and "seller_listing_drafts"."match_confidence" between 0 and 1)),
	CONSTRAINT "seller_listing_drafts_match_actor_paired_check" CHECK (("seller_listing_drafts"."match_actor" is null) = ("seller_listing_drafts"."canonical_product_id" is null)),
	CONSTRAINT "seller_listing_drafts_quantity_check" CHECK ("seller_listing_drafts"."quantity" >= 1),
	CONSTRAINT "seller_listing_drafts_price_paired_check" CHECK (("seller_listing_drafts"."price_amount" is null) = ("seller_listing_drafts"."price_currency" is null)),
	CONSTRAINT "seller_listing_drafts_coordinates_check" CHECK (("seller_listing_drafts"."location_longitude" is null) = ("seller_listing_drafts"."location_latitude" is null)),
	CONSTRAINT "seller_listing_drafts_location_opt_in_check" CHECK ("seller_listing_drafts"."location_opt_in" or ("seller_listing_drafts"."location_longitude" is null and "seller_listing_drafts"."location_latitude" is null)),
	CONSTRAINT "seller_listing_drafts_published_check" CHECK (("seller_listing_drafts"."status" = 'published') = ("seller_listing_drafts"."published_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "native_listing_links" DROP CONSTRAINT "native_listing_links_method_check";--> statement-breakpoint
ALTER TABLE "seller_draft_condition_details" ADD CONSTRAINT "seller_draft_condition_details_draft_id_seller_listing_drafts_id_fk" FOREIGN KEY ("draft_id") REFERENCES "public"."seller_listing_drafts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seller_draft_images" ADD CONSTRAINT "seller_draft_images_draft_id_seller_listing_drafts_id_fk" FOREIGN KEY ("draft_id") REFERENCES "public"."seller_listing_drafts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seller_draft_images" ADD CONSTRAINT "seller_draft_images_condition_detail_id_seller_draft_condition_details_id_fk" FOREIGN KEY ("condition_detail_id") REFERENCES "public"."seller_draft_condition_details"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seller_draft_match_assertions" ADD CONSTRAINT "seller_draft_match_assertions_draft_id_seller_listing_drafts_id_fk" FOREIGN KEY ("draft_id") REFERENCES "public"."seller_listing_drafts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seller_draft_match_assertions" ADD CONSTRAINT "seller_draft_match_assertions_canonical_product_id_canonical_products_id_fk" FOREIGN KEY ("canonical_product_id") REFERENCES "public"."canonical_products"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seller_draft_match_assertions" ADD CONSTRAINT "seller_draft_match_assertions_canonical_variant_id_canonical_variants_id_fk" FOREIGN KEY ("canonical_variant_id") REFERENCES "public"."canonical_variants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seller_listing_drafts" ADD CONSTRAINT "seller_listing_drafts_canonical_product_id_canonical_products_id_fk" FOREIGN KEY ("canonical_product_id") REFERENCES "public"."canonical_products"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seller_listing_drafts" ADD CONSTRAINT "seller_listing_drafts_canonical_variant_id_canonical_variants_id_fk" FOREIGN KEY ("canonical_variant_id") REFERENCES "public"."canonical_variants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seller_listing_drafts" ADD CONSTRAINT "seller_listing_drafts_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seller_listing_drafts" ADD CONSTRAINT "seller_listing_drafts_published_listing_id_listings_id_fk" FOREIGN KEY ("published_listing_id") REFERENCES "public"."listings"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "seller_draft_condition_details_draft_id_position_idx" ON "seller_draft_condition_details" USING btree ("draft_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "seller_draft_images_draft_id_file_id_key" ON "seller_draft_images" USING btree ("draft_id","file_id");--> statement-breakpoint
CREATE INDEX "seller_draft_images_draft_id_position_idx" ON "seller_draft_images" USING btree ("draft_id","position");--> statement-breakpoint
CREATE INDEX "seller_draft_match_assertions_draft_id_created_at_idx" ON "seller_draft_match_assertions" USING btree ("draft_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "seller_listing_drafts_owner_client_key" ON "seller_listing_drafts" USING btree ("oxy_user_id","client_draft_key");--> statement-breakpoint
CREATE INDEX "seller_listing_drafts_owner_status_updated_at_idx" ON "seller_listing_drafts" USING btree ("oxy_user_id","status","updated_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "seller_listing_drafts_published_listing_key" ON "seller_listing_drafts" USING btree ("published_listing_id") WHERE "seller_listing_drafts"."published_listing_id" is not null;--> statement-breakpoint
CREATE INDEX "seller_listing_drafts_canonical_product_idx" ON "seller_listing_drafts" USING btree ("canonical_product_id") WHERE "seller_listing_drafts"."canonical_product_id" is not null;--> statement-breakpoint
CREATE INDEX "seller_listing_drafts_canonical_variant_idx" ON "seller_listing_drafts" USING btree ("canonical_variant_id") WHERE "seller_listing_drafts"."canonical_variant_id" is not null;--> statement-breakpoint
CREATE INDEX "listing_images_file_id_idx" ON "listing_images" USING btree ("file_id");--> statement-breakpoint
ALTER TABLE "native_listing_links" ADD CONSTRAINT "native_listing_links_method_check" CHECK ("native_listing_links"."method" in ('barcode_gtin', 'connector_declared', 'operator', 'matcher', 'backfill', 'seller_declared'));
-- ANCHOR: hand-written begin (see the regeneration protocol in the header)

-- ── A publication is stamped exactly ONCE ───────────────────────────────────
--
-- NULL → value is a publication. Value → NULL is the `ON DELETE set null` the
-- listing's own foreign key performs when a seller genuinely deletes the
-- listing, and refusing it would make that deletion fail on a finished draft.
-- Value → value is REFUSED, and that refusal is what makes "repeated submits
-- create one listing" (#91 acceptance 3) impossible for a service bug to get
-- wrong rather than merely unlikely — #106's buyer-origin trigger, for its
-- reason.
CREATE OR REPLACE FUNCTION mercaria_seller_draft_publication_once() RETURNS trigger AS $$
BEGIN
  IF OLD.published_listing_id IS NOT NULL
     AND NEW.published_listing_id IS NOT NULL
     AND NEW.published_listing_id <> OLD.published_listing_id THEN
    RAISE EXCEPTION
      'draft % already published listing %; a second publication is not a correction',
      OLD.id, OLD.published_listing_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER seller_listing_drafts_publication_once
  BEFORE UPDATE OF published_listing_id ON seller_listing_drafts
  FOR EACH ROW EXECUTE FUNCTION mercaria_seller_draft_publication_once();--> statement-breakpoint

-- ── The match trail is append-only ──────────────────────────────────────────
--
-- UPDATE is refused outright. The whole value of the table is that a seller who
-- changed their mind about which product they are selling leaves BOTH answers
-- behind; an UPDATE would collapse that into the last one, which is exactly the
-- state that makes a false merge unexplainable afterwards.
--
-- DELETE is refused only while the parent draft still EXISTS — #90's revision
-- trail, verbatim, and the FIRST version of this trigger got it wrong. An
-- unconditional refusal makes the `ON DELETE cascade` on `draft_id` fail, so a
-- draft carrying any assertion becomes undeletable and every erasure request
-- against it fails at the database. During a cascade the parent is already gone
-- from the statement's snapshot, so the EXISTS is false and the children go with
-- it; a direct DELETE against a live draft's trail is still refused, which is
-- the case the rule is actually about.
CREATE OR REPLACE FUNCTION mercaria_seller_draft_assertions_append_only() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION
      'seller_draft_match_assertions is append-only; a changed match is a NEW row'
      USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM seller_listing_drafts WHERE id = OLD.draft_id) THEN
    RAISE EXCEPTION
      'seller_draft_match_assertions is append-only; an assertion can only be removed with the draft it explains'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER seller_draft_match_assertions_append_only
  BEFORE UPDATE OR DELETE ON seller_draft_match_assertions
  FOR EACH ROW EXECUTE FUNCTION mercaria_seller_draft_assertions_append_only();--> statement-breakpoint

-- ── A borrowed photograph is never evidence about YOUR item ─────────────────
--
-- #90 made the same guarantee for `listing_condition_photos` and #91 needs it one
-- step EARLIER, because a draft's gallery is what the publication copies into the
-- listing: catching it only at publication would let a seller complete an entire
-- flow and be refused at the last step.
--
-- Two sources are refused and they are different attacks. A `canonical_images`
-- file id is the catalogue's own picture, which the provenance vocabulary cannot
-- describe and therefore cannot stop. Another ACCOUNT's listing image is the
-- merchant-photo case #91 trust rule 2 names — a seller pasting the file id of a
-- shop's product shot. The seller's OWN listings are deliberately allowed: a
-- person relisting their own item is republishing their own photograph.
CREATE OR REPLACE FUNCTION mercaria_seller_draft_reject_borrowed_photo() RETURNS trigger AS $$
DECLARE
  owner_id text;
BEGIN
  IF EXISTS (SELECT 1 FROM canonical_images WHERE file_id = NEW.file_id) THEN
    RAISE EXCEPTION
      'file % is a canonical catalogue image and cannot evidence the condition of one item',
      NEW.file_id
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT oxy_user_id INTO owner_id FROM seller_listing_drafts WHERE id = NEW.draft_id;
  IF EXISTS (
    SELECT 1
      FROM listing_images li
      JOIN listings l ON l.id = li.listing_id
     WHERE li.file_id = NEW.file_id
       AND (l.owner_type <> 'user' OR l.oxy_user_id IS DISTINCT FROM owner_id)
  ) THEN
    RAISE EXCEPTION
      'file % already belongs to another seller''s listing and cannot evidence your item',
      NEW.file_id
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER seller_draft_images_reject_borrowed
  BEFORE INSERT OR UPDATE OF file_id ON seller_draft_images
  FOR EACH ROW EXECUTE FUNCTION mercaria_seller_draft_reject_borrowed_photo();--> statement-breakpoint

-- The lookup the trigger above performs on every uploaded photograph is served
-- by `listing_images_file_id_idx`, which this migration creates above from the
-- drizzle schema — declared there rather than written here so a regeneration
-- cannot drop it.
-- ANCHOR: hand-written end
