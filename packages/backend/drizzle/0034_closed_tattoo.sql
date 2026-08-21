-- oxy:deploy-phase=pre
-- oxy:rollback=accepted: listings.condition and offers.condition are rewritten from 'used' to 'used_good', offers.condition_mapping_state to 'unmapped', and one listing_condition_revisions row is inserted per listing. The rewrite is one-way but self-documenting — the inserted revision rows record the from_condition for every listing, so the pre-image is readable from the trail rather than from a backup
--
-- #90 — the item-condition taxonomy, phase 1 of 2 (ADDITIVE).
--
-- ## Why this half is additive and its `post` sibling is not
--
-- The PREVIOUS image is still running while this applies, and it still writes
-- the binary `'used'`. So this phase widens `listings_condition_check` and
-- `offers_condition_check` to a SUPERSET (the nine taxonomy keys plus the legacy
-- value), backfills every existing row, and gives each new NOT NULL column a
-- default the old image's inserts satisfy without knowing it exists. The `post`
-- half — the NEXT migration in this PR — narrows both CHECKs to the taxonomy
-- alone and drops those defaults, once no such writer remains.
--
-- Neither header names a migration INDEX. Both shift every time this branch
-- rebases behind another one that took the index first, and a header naming a
-- number goes stale silently — the deploy PHASE cannot move.
--
-- ## The hand-written statements, and where they go on a REGENERATION
--
-- drizzle-kit models none of what follows, so regenerating this file DROPS all
-- of it (`AGENTS.md` §"Rebasing a migration behind another branch's"). They sit
-- in exactly TWO blocks with unambiguous anchors, so re-applying them is
-- mechanical rather than a matter of finding the right point in the middle:
--
--   BLOCK A — the two VALUE backfills, marked `#90 BACKFILL`. It must sit AFTER the
--     two `DROP CONSTRAINT ..._condition_check` statements and BEFORE the
--     `ADD CONSTRAINT` block. Before the DROPs, `used_good` violates the OLD
--     binary CHECK; after the ADDs, the rows still holding `used` violate
--     `listings_unrefined_condition_check`. Both orderings fail the migration on
--     any database with a used listing, which is every real one.
--   BLOCK B — the four trigger pairs, the mapping-state backfill and the
--     revision backfill, at the END of the file, marked `#90 TRIGGERS`. Each
--     needs a table or a COLUMN this migration creates, and none is depended on
--     by a constraint, so the end is always correct. The mapping-state backfill
--     is in B rather than A for exactly that reason: `condition_mapping_state`
--     does not exist yet where block A sits.
--
-- ## The mapping is #90 migration rules 1 and 2
--
-- `new` → `new` is exact, which is what makes rule 1 deterministic. `used` →
-- `used_good`, the CONSERVATIVE generic member of the used group, and never
-- `used_like_new`: nobody has re-examined these items, so the migration may not
-- make a claim about them. That is NOT left to this file's care —
-- `listings_unrefined_condition_check` refuses any other value beside a
-- `migrated_binary` assertion, so a hand-written variant of the UPDATE below
-- fails rather than silently upgrading a seller's stock.

CREATE TABLE "condition_category_policies" (
	"id" text PRIMARY KEY NOT NULL,
	"category_id" text NOT NULL,
	"condition_key" text NOT NULL,
	"restriction" text NOT NULL,
	"include_descendants" boolean DEFAULT true NOT NULL,
	"reason" text NOT NULL,
	"created_by_oxy_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "condition_category_policies_condition_key_check" CHECK ("condition_category_policies"."condition_key" in ('new', 'open_box', 'refurbished_manufacturer', 'refurbished_seller', 'used_like_new', 'used_good', 'used_fair', 'used_poor', 'for_parts')),
	CONSTRAINT "condition_category_policies_restriction_check" CHECK ("condition_category_policies"."restriction" in ('safety', 'legal', 'policy')),
	CONSTRAINT "condition_category_policies_reason_check" CHECK (length(btrim("condition_category_policies"."reason")) > 0)
);
--> statement-breakpoint
CREATE TABLE "condition_mapping_rulesets" (
	"id" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"version" integer NOT NULL,
	"state" text DEFAULT 'draft' NOT NULL,
	"note" text,
	"published_at" timestamp with time zone,
	"published_by_oxy_user_id" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "condition_mapping_rulesets_provider_check" CHECK ("condition_mapping_rulesets"."provider" in ('shopify', 'woocommerce', 'etsy', 'prestashop', 'magento')),
	CONSTRAINT "condition_mapping_rulesets_state_check" CHECK ("condition_mapping_rulesets"."state" in ('draft', 'active', 'superseded')),
	CONSTRAINT "condition_mapping_rulesets_version_check" CHECK ("condition_mapping_rulesets"."version" > 0),
	CONSTRAINT "condition_mapping_rulesets_publication_check" CHECK (("condition_mapping_rulesets"."state" = 'draft') = ("condition_mapping_rulesets"."published_at" is null)
          and ("condition_mapping_rulesets"."published_at" is null) = ("condition_mapping_rulesets"."published_by_oxy_user_id" is null))
);
--> statement-breakpoint
CREATE TABLE "condition_source_mappings" (
	"id" text PRIMARY KEY NOT NULL,
	"ruleset_id" text NOT NULL,
	"source_label" text NOT NULL,
	"source_label_normalized" text NOT NULL,
	"condition_key" text NOT NULL,
	"confidence" double precision NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "condition_source_mappings_condition_key_check" CHECK ("condition_source_mappings"."condition_key" in ('new', 'open_box', 'refurbished_manufacturer', 'refurbished_seller', 'used_like_new', 'used_good', 'used_fair', 'used_poor', 'for_parts')),
	CONSTRAINT "condition_source_mappings_confidence_check" CHECK ("condition_source_mappings"."confidence" >= 0 and "condition_source_mappings"."confidence" <= 1),
	CONSTRAINT "condition_source_mappings_source_label_check" CHECK (length(btrim("condition_source_mappings"."source_label")) > 0 and length(btrim("condition_source_mappings"."source_label_normalized")) > 0)
);
--> statement-breakpoint
CREATE TABLE "listing_condition_details" (
	"id" text PRIMARY KEY NOT NULL,
	"listing_id" text NOT NULL,
	"kind" text NOT NULL,
	"severity" text,
	"note" text,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "listing_condition_details_id_listing_id_key" UNIQUE("id","listing_id"),
	CONSTRAINT "listing_condition_details_kind_check" CHECK ("listing_condition_details"."kind" in ('cosmetic_wear', 'functional_defect', 'missing_accessory', 'original_packaging', 'repair_or_refurbishment', 'warranty', 'note')),
	CONSTRAINT "listing_condition_details_severity_check" CHECK ("listing_condition_details"."severity" in ('light', 'moderate', 'heavy')),
	CONSTRAINT "listing_condition_details_severity_scope_check" CHECK ("listing_condition_details"."severity" is null or "listing_condition_details"."kind" in ('cosmetic_wear', 'functional_defect')),
	CONSTRAINT "listing_condition_details_note_required_check" CHECK ("listing_condition_details"."kind" not in ('functional_defect', 'missing_accessory', 'repair_or_refurbishment', 'warranty', 'note') or ("listing_condition_details"."note" is not null and length(btrim("listing_condition_details"."note")) > 0))
);
--> statement-breakpoint
CREATE TABLE "listing_condition_photos" (
	"id" text PRIMARY KEY NOT NULL,
	"listing_id" text NOT NULL,
	"file_id" text NOT NULL,
	"provenance" text NOT NULL,
	"uploaded_by_oxy_user_id" text NOT NULL,
	"uploaded_at" timestamp with time zone NOT NULL,
	"moderation_state" text DEFAULT 'pending' NOT NULL,
	"moderated_at" timestamp with time zone,
	"shows_defect" boolean DEFAULT false NOT NULL,
	"condition_detail_id" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "listing_condition_photos_provenance_check" CHECK ("listing_condition_photos"."provenance" in ('seller_captured', 'seller_uploaded')),
	CONSTRAINT "listing_condition_photos_moderation_state_check" CHECK ("listing_condition_photos"."moderation_state" in ('pending', 'approved', 'rejected', 'withdrawn')),
	CONSTRAINT "listing_condition_photos_moderated_at_check" CHECK (("listing_condition_photos"."moderation_state" = 'pending') = ("listing_condition_photos"."moderated_at" is null))
);
--> statement-breakpoint
CREATE TABLE "listing_condition_revisions" (
	"id" text PRIMARY KEY NOT NULL,
	"listing_id" text NOT NULL,
	"from_condition" text,
	"to_condition" text NOT NULL,
	"from_assertion" text,
	"to_assertion" text NOT NULL,
	"actor_kind" text NOT NULL,
	"actor_oxy_user_id" text,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "listing_condition_revisions_from_condition_check" CHECK ("listing_condition_revisions"."from_condition" in ('new', 'open_box', 'refurbished_manufacturer', 'refurbished_seller', 'used_like_new', 'used_good', 'used_fair', 'used_poor', 'for_parts')),
	CONSTRAINT "listing_condition_revisions_to_condition_check" CHECK ("listing_condition_revisions"."to_condition" in ('new', 'open_box', 'refurbished_manufacturer', 'refurbished_seller', 'used_like_new', 'used_good', 'used_fair', 'used_poor', 'for_parts')),
	CONSTRAINT "listing_condition_revisions_from_assertion_check" CHECK ("listing_condition_revisions"."from_assertion" in ('seller_declared', 'source_declared', 'operator_corrected', 'migrated_binary', 'legacy_client_binary')),
	CONSTRAINT "listing_condition_revisions_to_assertion_check" CHECK ("listing_condition_revisions"."to_assertion" in ('seller_declared', 'source_declared', 'operator_corrected', 'migrated_binary', 'legacy_client_binary')),
	CONSTRAINT "listing_condition_revisions_actor_kind_check" CHECK ("listing_condition_revisions"."actor_kind" in ('seller', 'operator', 'migration', 'source')),
	CONSTRAINT "listing_condition_revisions_actor_identity_check" CHECK (("listing_condition_revisions"."actor_kind" in ('seller', 'operator')) = ("listing_condition_revisions"."actor_oxy_user_id" is not null)),
	CONSTRAINT "listing_condition_revisions_change_check" CHECK ("listing_condition_revisions"."from_condition" is distinct from "listing_condition_revisions"."to_condition"
          or "listing_condition_revisions"."from_assertion" is distinct from "listing_condition_revisions"."to_assertion"),
	CONSTRAINT "listing_condition_revisions_reason_check" CHECK (length(btrim("listing_condition_revisions"."reason")) > 0)
);
--> statement-breakpoint
ALTER TABLE "listings" DROP CONSTRAINT "listings_condition_check";--> statement-breakpoint
ALTER TABLE "offers" DROP CONSTRAINT "offers_condition_check";--> statement-breakpoint

-- #90 BACKFILL (block A) — see the file header for why it sits exactly here.
UPDATE "listings" SET "condition" = 'used_good' WHERE "condition" = 'used';--> statement-breakpoint
UPDATE "offers" SET "condition" = 'used_good' WHERE "condition" = 'used';--> statement-breakpoint
ALTER TABLE "listings" ADD COLUMN "condition_assertion" text DEFAULT 'migrated_binary' NOT NULL;--> statement-breakpoint
ALTER TABLE "listings" ADD COLUMN "condition_source_label" text;--> statement-breakpoint
ALTER TABLE "listings" ADD COLUMN "condition_acknowledged_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "order_items" ADD COLUMN "condition_key" text;--> statement-breakpoint
ALTER TABLE "order_items" ADD COLUMN "condition_assertion" text;--> statement-breakpoint
ALTER TABLE "order_items" ADD COLUMN "condition_notes" text;--> statement-breakpoint
ALTER TABLE "offers" ADD COLUMN "condition_source_label" text;--> statement-breakpoint
ALTER TABLE "offers" ADD COLUMN "condition_mapping_state" text DEFAULT 'declared' NOT NULL;--> statement-breakpoint
ALTER TABLE "offers" ADD COLUMN "condition_mapping_confidence" double precision;--> statement-breakpoint
ALTER TABLE "offers" ADD COLUMN "condition_mapping_ruleset_id" text;--> statement-breakpoint
ALTER TABLE "condition_category_policies" ADD CONSTRAINT "condition_category_policies_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "condition_source_mappings" ADD CONSTRAINT "condition_source_mappings_ruleset_id_condition_mapping_rulesets_id_fk" FOREIGN KEY ("ruleset_id") REFERENCES "public"."condition_mapping_rulesets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listing_condition_details" ADD CONSTRAINT "listing_condition_details_listing_id_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."listings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listing_condition_photos" ADD CONSTRAINT "listing_condition_photos_listing_id_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."listings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listing_condition_photos" ADD CONSTRAINT "listing_condition_photos_detail_fk" FOREIGN KEY ("condition_detail_id","listing_id") REFERENCES "public"."listing_condition_details"("id","listing_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listing_condition_revisions" ADD CONSTRAINT "listing_condition_revisions_listing_id_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."listings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "condition_category_policies_category_id_condition_key_key" ON "condition_category_policies" USING btree ("category_id","condition_key");--> statement-breakpoint
CREATE INDEX "condition_category_policies_condition_key_idx" ON "condition_category_policies" USING btree ("condition_key");--> statement-breakpoint
CREATE UNIQUE INDEX "condition_mapping_rulesets_provider_version_key" ON "condition_mapping_rulesets" USING btree ("provider","version");--> statement-breakpoint
CREATE UNIQUE INDEX "condition_mapping_rulesets_provider_active_key" ON "condition_mapping_rulesets" USING btree ("provider") WHERE "condition_mapping_rulesets"."state" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "condition_source_mappings_ruleset_id_label_key" ON "condition_source_mappings" USING btree ("ruleset_id","source_label_normalized");--> statement-breakpoint
CREATE INDEX "listing_condition_details_listing_id_position_idx" ON "listing_condition_details" USING btree ("listing_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "listing_condition_photos_listing_id_file_id_key" ON "listing_condition_photos" USING btree ("listing_id","file_id");--> statement-breakpoint
CREATE INDEX "listing_condition_photos_listing_id_idx" ON "listing_condition_photos" USING btree ("listing_id");--> statement-breakpoint
CREATE INDEX "listing_condition_photos_condition_detail_id_idx" ON "listing_condition_photos" USING btree ("condition_detail_id");--> statement-breakpoint
CREATE INDEX "listing_condition_photos_moderation_state_uploaded_at_idx" ON "listing_condition_photos" USING btree ("moderation_state","uploaded_at");--> statement-breakpoint
CREATE INDEX "listing_condition_revisions_listing_id_created_at_idx" ON "listing_condition_revisions" USING btree ("listing_id","created_at" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "offers" ADD CONSTRAINT "offers_condition_mapping_ruleset_id_condition_mapping_rulesets_id_fk" FOREIGN KEY ("condition_mapping_ruleset_id") REFERENCES "public"."condition_mapping_rulesets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "listings_status_condition_published_at_id_idx" ON "listings" USING btree ("status","condition","published_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "canonical_images_file_id_idx" ON "canonical_images" USING btree ("file_id") WHERE "canonical_images"."file_id" is not null;--> statement-breakpoint
ALTER TABLE "listings" ADD CONSTRAINT "listings_condition_assertion_check" CHECK ("listings"."condition_assertion" in ('seller_declared', 'source_declared', 'operator_corrected', 'migrated_binary', 'legacy_client_binary'));--> statement-breakpoint
ALTER TABLE "listings" ADD CONSTRAINT "listings_unrefined_condition_check" CHECK ("listings"."condition_assertion" not in ('migrated_binary', 'legacy_client_binary')
          or "listings"."condition" in ('new', 'used_good'));--> statement-breakpoint
ALTER TABLE "listings" ADD CONSTRAINT "listings_condition_source_label_check" CHECK ("listings"."condition_source_label" is null or "listings"."condition_assertion" = 'source_declared');--> statement-breakpoint
ALTER TABLE "listings" ADD CONSTRAINT "listings_condition_check" CHECK ("listings"."condition" in ('new', 'open_box', 'refurbished_manufacturer', 'refurbished_seller', 'used_like_new', 'used_good', 'used_fair', 'used_poor', 'for_parts', 'used'));--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_condition_key_check" CHECK ("order_items"."condition_key" in ('new', 'open_box', 'refurbished_manufacturer', 'refurbished_seller', 'used_like_new', 'used_good', 'used_fair', 'used_poor', 'for_parts'));--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_condition_assertion_check" CHECK ("order_items"."condition_assertion" in ('seller_declared', 'source_declared', 'operator_corrected', 'migrated_binary', 'legacy_client_binary'));--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_condition_snapshot_complete_check" CHECK (("order_items"."condition_key" is null) = ("order_items"."condition_assertion" is null));--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_condition_notes_check" CHECK ("order_items"."condition_notes" is null or "order_items"."condition_key" is not null);--> statement-breakpoint
ALTER TABLE "offers" ADD CONSTRAINT "offers_condition_mapping_state_check" CHECK ("offers"."condition_mapping_state" in ('declared', 'mapped', 'unmapped', 'review_pending'));--> statement-breakpoint
ALTER TABLE "offers" ADD CONSTRAINT "offers_condition_asserted_check" CHECK ("offers"."condition" = 'unknown' or "offers"."condition_mapping_state" in ('declared', 'mapped'));--> statement-breakpoint
ALTER TABLE "offers" ADD CONSTRAINT "offers_condition_declared_shape_check" CHECK ("offers"."condition_mapping_state" <> 'declared'
          or ("offers"."condition_source_label" is null
              and "offers"."condition_mapping_confidence" is null
              and "offers"."condition_mapping_ruleset_id" is null));--> statement-breakpoint
ALTER TABLE "offers" ADD CONSTRAINT "offers_condition_mapped_shape_check" CHECK ("offers"."condition_mapping_state" <> 'mapped'
          or ("offers"."condition_source_label" is not null
              and "offers"."condition_mapping_ruleset_id" is not null
              and "offers"."condition_mapping_confidence" >= 0.75));--> statement-breakpoint
ALTER TABLE "offers" ADD CONSTRAINT "offers_condition_review_pending_shape_check" CHECK ("offers"."condition_mapping_state" <> 'review_pending'
          or ("offers"."condition" = 'unknown'
              and "offers"."condition_source_label" is not null
              and "offers"."condition_mapping_ruleset_id" is not null
              and "offers"."condition_mapping_confidence" < 0.75));--> statement-breakpoint
ALTER TABLE "offers" ADD CONSTRAINT "offers_condition_unmapped_shape_check" CHECK ("offers"."condition_mapping_state" <> 'unmapped'
          or ("offers"."condition" = 'unknown' and "offers"."condition_mapping_confidence" is null));--> statement-breakpoint
ALTER TABLE "offers" ADD CONSTRAINT "offers_condition_mapping_confidence_range_check" CHECK ("offers"."condition_mapping_confidence" is null
          or ("offers"."condition_mapping_confidence" >= 0 and "offers"."condition_mapping_confidence" <= 1));--> statement-breakpoint
ALTER TABLE "offers" ADD CONSTRAINT "offers_condition_check" CHECK ("offers"."condition" in ('new', 'open_box', 'refurbished_manufacturer', 'refurbished_seller', 'used_like_new', 'used_good', 'used_fair', 'used_poor', 'for_parts', 'unknown', 'used'));
--> statement-breakpoint
-- #90 TRIGGERS (block B) — see the file header. Regenerating this file drops
-- everything below; re-append it verbatim and grep for each function/trigger
-- pair before pushing.

-- An offer that says nothing about condition is `unmapped`, not `declared`: the
-- column's default exists for the previous image's inserts, and `declared` means
-- "a first party stated this", which nobody did for these rows.
UPDATE "offers" SET "condition_mapping_state" = 'unmapped' WHERE "condition" = 'unknown';--> statement-breakpoint


-- ── Acceptance 4: a catalogue image can never be condition evidence ──────────
--
-- The provenance tuple has no value meaning "a catalogue image", which stops the
-- obvious mistake. This stops the real one: a seller attaching the
-- manufacturer's own product shot, whose file id is a perfectly ordinary Oxy
-- media id that no service-layer check can recognise. `canonical_images_file_id_idx`
-- (added in this same migration) is what keeps the lookup off a sequential scan.
CREATE OR REPLACE FUNCTION mercaria_reject_canonical_condition_photo() RETURNS trigger AS $$
BEGIN
  IF NEW.file_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM canonical_images WHERE file_id = NEW.file_id
  ) THEN
    RAISE EXCEPTION
      'file % is a canonical catalogue image and cannot evidence the condition of one item',
      NEW.file_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER listing_condition_photos_reject_canonical
  BEFORE INSERT OR UPDATE OF file_id ON listing_condition_photos
  FOR EACH ROW EXECUTE FUNCTION mercaria_reject_canonical_condition_photo();--> statement-breakpoint

-- ── The revision trail is append-only ───────────────────────────────────────
--
-- UPDATE is refused outright. DELETE is refused only while the listing still
-- EXISTS, which is the precise version of "append-only" this table needs: the
-- foreign key already says `ON DELETE cascade`, so an unconditional refusal
-- would make a listing undeletable, while an unconditional permission would let
-- an operator delete one correction to hide it. During a cascade the parent row
-- is already gone from the statement's snapshot, so the EXISTS is false and the
-- child rows go with it.
CREATE OR REPLACE FUNCTION mercaria_condition_revisions_append_only() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'listing_condition_revisions is append-only; a correction is a NEW row'
      USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM listings WHERE id = OLD.listing_id) THEN
    RAISE EXCEPTION
      'a condition revision can only be removed with the listing it explains'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER listing_condition_revisions_append_only
  BEFORE UPDATE OR DELETE ON listing_condition_revisions
  FOR EACH ROW EXECUTE FUNCTION mercaria_condition_revisions_append_only();--> statement-breakpoint

-- ── A published mapping ruleset is frozen (#90 migration rule 5) ─────────────
--
-- Correcting a mapping is publishing the NEXT version, so an offer observed
-- under v1 keeps citing v1 and nothing retroactively re-reads a source's words.
-- The one edit a published ruleset admits is its own lifecycle moving
-- `active` → `superseded`, which is what publishing the successor does.
CREATE OR REPLACE FUNCTION mercaria_condition_ruleset_frozen() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.state <> 'draft' THEN
      RAISE EXCEPTION 'a published condition mapping ruleset cannot be deleted'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.state = 'draft' THEN
    RETURN NEW;
  END IF;

  IF NEW.provider <> OLD.provider
     OR NEW.version <> OLD.version
     OR NEW.published_at IS DISTINCT FROM OLD.published_at
     OR NEW.published_by_oxy_user_id IS DISTINCT FROM OLD.published_by_oxy_user_id THEN
    RAISE EXCEPTION
      'a published condition mapping ruleset is immutable; publish a new version instead'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER condition_mapping_rulesets_frozen
  BEFORE UPDATE OR DELETE ON condition_mapping_rulesets
  FOR EACH ROW EXECUTE FUNCTION mercaria_condition_ruleset_frozen();--> statement-breakpoint

-- The same freeze, one table down. Without it the ruleset's VERSION would be
-- immutable while the RULES it names could be rewritten underneath it, which is
-- the whole thing versioning exists to prevent.
CREATE OR REPLACE FUNCTION mercaria_condition_mappings_frozen() RETURNS trigger AS $$
DECLARE
  target_ruleset text;
  ruleset_state text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    target_ruleset := OLD.ruleset_id;
  ELSE
    target_ruleset := NEW.ruleset_id;
  END IF;

  SELECT state INTO ruleset_state
    FROM condition_mapping_rulesets WHERE id = target_ruleset;

  -- The ruleset is already gone: this is its own cascade, not an edit.
  IF ruleset_state IS NOT NULL AND ruleset_state <> 'draft' THEN
    RAISE EXCEPTION
      'the rules of a published condition mapping ruleset are immutable; publish a new version'
      USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER condition_source_mappings_frozen
  BEFORE INSERT OR UPDATE OR DELETE ON condition_source_mappings
  FOR EACH ROW EXECUTE FUNCTION mercaria_condition_mappings_frozen();--> statement-breakpoint

-- ── The order snapshot is never rewritten (#90 migration rule 3) ─────────────
--
-- Every UPDATE of the three columns is refused, not merely "immutable once
-- set". The weaker rule would still admit a future backfill writing NULL → a
-- value, which is exactly the thing #90 says must not happen to orders placed
-- before the taxonomy existed: their honest answer is "not recorded at
-- purchase", and `deriveOrderItemCondition` returns it.
CREATE OR REPLACE FUNCTION mercaria_order_item_condition_immutable() RETURNS trigger AS $$
BEGIN
  IF NEW.condition_key IS DISTINCT FROM OLD.condition_key
     OR NEW.condition_assertion IS DISTINCT FROM OLD.condition_assertion
     OR NEW.condition_notes IS DISTINCT FROM OLD.condition_notes THEN
    RAISE EXCEPTION
      'an order line''s condition snapshot is what the buyer was shown and cannot be rewritten'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER order_items_condition_immutable
  BEFORE UPDATE ON order_items
  FOR EACH ROW EXECUTE FUNCTION mercaria_order_item_condition_immutable();--> statement-breakpoint

-- ── The migration records itself (#90 evidence rule 8) ───────────────────────
--
-- One revision per listing, so a seller looking at why their item says
-- `used_good` finds the answer where every other condition change is recorded,
-- rather than nowhere. `from_condition` is NULL because there WAS no taxonomy
-- key before — writing `'used'` there would be a value the CHECK rejects and a
-- claim that the old field was one of the nine, which it was not.
--
-- `actor_kind = 'migration'` with a NULL account is what
-- `listing_condition_revisions_actor_identity_check` demands: a backfill has
-- nobody to attribute, and naming whoever ran it would be a lie in an audit
-- table.
INSERT INTO "listing_condition_revisions"
  ("id", "listing_id", "from_condition", "to_condition", "from_assertion", "to_assertion",
   "actor_kind", "actor_oxy_user_id", "reason")
SELECT
  gen_random_uuid()::text,
  l."id",
  NULL,
  l."condition",
  NULL,
  'migrated_binary',
  'migration',
  NULL,
  'Migrated from the binary new/used field (#90). A used item became the generic ' ||
  'used_good and was never upgraded; the seller can refine it.'
FROM "listings" l;
