-- oxy:deploy-phase=pre
-- oxy:rollback=derived
CREATE TABLE "oxy_file_event_actions" (
	"id" text PRIMARY KEY NOT NULL,
	"oxy_file_event_id" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"action" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "oxy_file_event_actions_entity_type_check" CHECK ("oxy_file_event_actions"."entity_type" in ('listing_image', 'listing_description_image', 'condition_photo', 'store_logo', 'store_cover', 'store_policy_image', 'collection_image', 'seller_draft_image', 'authoring_draft_image', 'canonical_image', 'canonical_description_image', 'category_image', 'brand_logo', 'organization_archive_logo', 'review_media', 'return_request_evidence', 'retail_service_request_evidence', 'supplier_agreement_evidence', 'retail_resale_evidence', 'retail_compliance_evidence', 'merchant_claim_evidence', 'relationship_evidence', 'order_item_image', 'digital_asset_file')),
	CONSTRAINT "oxy_file_event_actions_action_check" CHECK ("oxy_file_event_actions"."action" in ('removed', 'suppressed', 'retained'))
);
--> statement-breakpoint
CREATE TABLE "oxy_file_events" (
	"id" text PRIMARY KEY NOT NULL,
	"event_id" text NOT NULL,
	"type" text NOT NULL,
	"file_id" text NOT NULL,
	"occurred_at" timestamp with time zone,
	"received_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "oxy_file_events_type_check" CHECK ("oxy_file_events"."type" in ('file.deleted', 'file.trashed', 'file.restored', 'file.visibility_changed', 'file.blocked', 'file.unblocked')),
	CONSTRAINT "oxy_file_events_event_id_check" CHECK (length("oxy_file_events"."event_id") between 1 and 256),
	CONSTRAINT "oxy_file_events_file_id_check" CHECK ("oxy_file_events"."file_id" ~ '^[A-Za-z0-9_-]+$' and length("oxy_file_events"."file_id") <= 64)
);
--> statement-breakpoint
CREATE TABLE "oxy_file_reference_outboxes" (
	"id" text PRIMARY KEY NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"requested_revision" bigint DEFAULT 1 NOT NULL,
	"claimed_revision" bigint,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone NOT NULL,
	"lease_owner" text,
	"lease_until" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "oxy_file_reference_outboxes_entity_type_check" CHECK ("oxy_file_reference_outboxes"."entity_type" in ('listing_image', 'listing_description_image', 'condition_photo', 'store_logo', 'store_cover', 'store_policy_image', 'collection_image', 'seller_draft_image', 'authoring_draft_image', 'canonical_image', 'canonical_description_image', 'category_image', 'brand_logo', 'organization_archive_logo', 'review_media', 'return_request_evidence', 'retail_service_request_evidence', 'supplier_agreement_evidence', 'retail_resale_evidence', 'retail_compliance_evidence', 'merchant_claim_evidence', 'relationship_evidence', 'order_item_image', 'digital_asset_file')),
	CONSTRAINT "oxy_file_reference_outboxes_status_check" CHECK ("oxy_file_reference_outboxes"."status" in ('pending', 'processing', 'dead_letter')),
	CONSTRAINT "oxy_file_reference_outboxes_entity_id_check" CHECK (length("oxy_file_reference_outboxes"."entity_id") between 1 and 256),
	CONSTRAINT "oxy_file_reference_outboxes_attempts_check" CHECK ("oxy_file_reference_outboxes"."attempts" >= 0),
	CONSTRAINT "oxy_file_reference_outboxes_requested_revision_check" CHECK ("oxy_file_reference_outboxes"."requested_revision" >= 1),
	CONSTRAINT "oxy_file_reference_outboxes_claimed_revision_check" CHECK ("oxy_file_reference_outboxes"."claimed_revision" is null or "oxy_file_reference_outboxes"."claimed_revision" <= "oxy_file_reference_outboxes"."requested_revision"),
	CONSTRAINT "oxy_file_reference_outboxes_last_error_length_check" CHECK ("oxy_file_reference_outboxes"."last_error" is null or length("oxy_file_reference_outboxes"."last_error") <= 2000)
);
--> statement-breakpoint
CREATE TABLE "oxy_file_reference_reconciliations" (
	"id" text PRIMARY KEY NOT NULL,
	"entity_type" text NOT NULL,
	"next_run_at" timestamp with time zone NOT NULL,
	"lease_owner" text,
	"lease_until" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_started_at" timestamp with time zone,
	"last_completed_at" timestamp with time zone,
	"last_dry_run" boolean,
	"last_added" integer,
	"last_removed" integer,
	"last_unchanged" integer,
	"last_refused" integer,
	"last_inventory" integer,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "oxy_file_reference_reconciliations_entity_type_check" CHECK ("oxy_file_reference_reconciliations"."entity_type" in ('listing_image', 'listing_description_image', 'condition_photo', 'store_logo', 'store_cover', 'store_policy_image', 'collection_image', 'seller_draft_image', 'authoring_draft_image', 'canonical_image', 'canonical_description_image', 'category_image', 'brand_logo', 'organization_archive_logo', 'review_media', 'return_request_evidence', 'retail_service_request_evidence', 'supplier_agreement_evidence', 'retail_resale_evidence', 'retail_compliance_evidence', 'merchant_claim_evidence', 'relationship_evidence', 'order_item_image', 'digital_asset_file')),
	CONSTRAINT "oxy_file_reference_reconciliations_attempts_check" CHECK ("oxy_file_reference_reconciliations"."attempts" >= 0),
	CONSTRAINT "oxy_file_reference_reconciliations_counts_check" CHECK (coalesce("oxy_file_reference_reconciliations"."last_added", 0) >= 0 and coalesce("oxy_file_reference_reconciliations"."last_removed", 0) >= 0
          and coalesce("oxy_file_reference_reconciliations"."last_unchanged", 0) >= 0 and coalesce("oxy_file_reference_reconciliations"."last_refused", 0) >= 0
          and coalesce("oxy_file_reference_reconciliations"."last_inventory", 0) >= 0),
	CONSTRAINT "oxy_file_reference_reconciliations_last_error_length_check" CHECK ("oxy_file_reference_reconciliations"."last_error" is null or length("oxy_file_reference_reconciliations"."last_error") <= 2000)
);
--> statement-breakpoint
CREATE TABLE "oxy_file_references" (
	"id" text PRIMARY KEY NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"file_id" text NOT NULL,
	"state" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "oxy_file_references_entity_type_check" CHECK ("oxy_file_references"."entity_type" in ('listing_image', 'listing_description_image', 'condition_photo', 'store_logo', 'store_cover', 'store_policy_image', 'collection_image', 'seller_draft_image', 'authoring_draft_image', 'canonical_image', 'canonical_description_image', 'category_image', 'brand_logo', 'organization_archive_logo', 'review_media', 'return_request_evidence', 'retail_service_request_evidence', 'supplier_agreement_evidence', 'retail_resale_evidence', 'retail_compliance_evidence', 'merchant_claim_evidence', 'relationship_evidence', 'order_item_image', 'digital_asset_file')),
	CONSTRAINT "oxy_file_references_state_check" CHECK ("oxy_file_references"."state" in ('registered', 'refused')),
	CONSTRAINT "oxy_file_references_entity_id_check" CHECK (length("oxy_file_references"."entity_id") between 1 and 256),
	CONSTRAINT "oxy_file_references_file_id_check" CHECK ("oxy_file_references"."file_id" ~ '^[A-Za-z0-9_-]+$' and length("oxy_file_references"."file_id") <= 64)
);
--> statement-breakpoint
ALTER TABLE "oxy_file_event_actions" ADD CONSTRAINT "oxy_file_event_actions_oxy_file_event_id_oxy_file_events_id_fk" FOREIGN KEY ("oxy_file_event_id") REFERENCES "public"."oxy_file_events"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "oxy_file_event_actions_event_entity_key" ON "oxy_file_event_actions" USING btree ("oxy_file_event_id","entity_type","entity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "oxy_file_events_event_id_key" ON "oxy_file_events" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "oxy_file_events_file_id_idx" ON "oxy_file_events" USING btree ("file_id");--> statement-breakpoint
CREATE UNIQUE INDEX "oxy_file_reference_outboxes_entity_key" ON "oxy_file_reference_outboxes" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "oxy_file_reference_outboxes_pending_idx" ON "oxy_file_reference_outboxes" USING btree ("available_at","created_at") WHERE "oxy_file_reference_outboxes"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "oxy_file_reference_outboxes_reclaim_idx" ON "oxy_file_reference_outboxes" USING btree ("lease_until","created_at") WHERE "oxy_file_reference_outboxes"."status" = 'processing';--> statement-breakpoint
CREATE UNIQUE INDEX "oxy_file_reference_reconciliations_entity_type_key" ON "oxy_file_reference_reconciliations" USING btree ("entity_type");--> statement-breakpoint
CREATE UNIQUE INDEX "oxy_file_references_entity_file_key" ON "oxy_file_references" USING btree ("entity_type","entity_id","file_id");--> statement-breakpoint
CREATE INDEX "oxy_file_references_file_id_idx" ON "oxy_file_references" USING btree ("file_id");
--> statement-breakpoint
-- Every table that holds an Oxy file id asks for its entity's references to be
-- converged, in the writer's own transaction (Oxy ADR 0041 D4; the design is in
-- `db/schema/oxyFiles.ts`). The trigger names the ENTITY, never the file: the
-- worker derives the file set from the live rows, which is what lets one trigger
-- serve a gallery, an HTML description and an array column alike. Absent here on
-- purpose: `order_items.image_url` (a checkout write is never made to depend on
-- this; the nightly reconciliation registers order snapshots) and
-- `asset_files.storage_key` (read in exactly one place; registered at upload).
-- oxy:handwritten-begin=oxy_file_reference_enqueue
CREATE OR REPLACE FUNCTION mercaria_oxy_file_reference_enqueue(p_entity_type text, p_entity_id text)
RETURNS void AS $$
BEGIN
  IF p_entity_id IS NULL OR p_entity_id = '' THEN
    RETURN;
  END IF;
  -- The offer outbox's fixed-point enqueue: a repeat bumps the revision, and a
  -- row a dispatcher holds stays `processing` (its completion reads the bump).
  INSERT INTO "oxy_file_reference_outboxes"
    ("id", "entity_type", "entity_id", "requested_revision", "status", "attempts", "available_at")
  -- Milliseconds, like every timestamp the application writes: the claim
  -- compares against a JS Date, and a microsecond value in the same
  -- millisecond would read as not yet due.
  VALUES (gen_random_uuid()::text, p_entity_type, p_entity_id, 1, 'pending', 0,
          date_trunc('milliseconds', now()))
  ON CONFLICT ("entity_type", "entity_id") DO UPDATE SET
    "requested_revision" = "oxy_file_reference_outboxes"."requested_revision" + 1,
    "status" = CASE WHEN "oxy_file_reference_outboxes"."status" = 'processing'
                    THEN 'processing' ELSE 'pending' END,
    "attempts" = 0,
    "available_at" = date_trunc('milliseconds', now()),
    "last_error" = NULL,
    "updated_at" = date_trunc('milliseconds', now());
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
-- TG_ARGV: [0] entity type, [1] the column whose value is the entity id,
-- [2] 'value' (any non-empty value holds a file) or 'html' (only text carrying
-- an <img> can), [3..] the watched columns. An UPDATE that changes none of them
-- (nor the entity id) enqueues nothing.
CREATE OR REPLACE FUNCTION mercaria_oxy_file_reference_touch()
RETURNS trigger AS $$
DECLARE
  v_entity_type text := TG_ARGV[0];
  v_id_column text := TG_ARGV[1];
  v_mode text := TG_ARGV[2];
  v_old jsonb;
  v_new jsonb;
  v_old_holds boolean := false;
  v_new_holds boolean := false;
  v_changed boolean := false;
  v_value jsonb;
  i integer;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    v_old := to_jsonb(OLD);
  END IF;
  IF TG_OP <> 'DELETE' THEN
    v_new := to_jsonb(NEW);
  END IF;
  FOR i IN 3 .. TG_NARGS - 1 LOOP
    IF TG_OP = 'UPDATE' AND (v_old -> TG_ARGV[i]) IS DISTINCT FROM (v_new -> TG_ARGV[i]) THEN
      v_changed := true;
    END IF;
    v_value := v_old -> TG_ARGV[i];
    IF v_value IS NOT NULL AND v_value NOT IN ('null'::jsonb, '""'::jsonb, '[]'::jsonb)
       AND (v_mode <> 'html' OR (v_value #>> '{}') ILIKE '%<img%') THEN
      v_old_holds := true;
    END IF;
    v_value := v_new -> TG_ARGV[i];
    IF v_value IS NOT NULL AND v_value NOT IN ('null'::jsonb, '""'::jsonb, '[]'::jsonb)
       AND (v_mode <> 'html' OR (v_value #>> '{}') ILIKE '%<img%') THEN
      v_new_holds := true;
    END IF;
  END LOOP;
  IF TG_OP = 'UPDATE' THEN
    IF (v_old ->> v_id_column) IS DISTINCT FROM (v_new ->> v_id_column) THEN
      v_changed := true;
    END IF;
    IF NOT v_changed THEN
      RETURN NULL;
    END IF;
  END IF;
  IF v_old_holds THEN
    PERFORM mercaria_oxy_file_reference_enqueue(v_entity_type, v_old ->> v_id_column);
  END IF;
  IF v_new_holds AND (NOT v_old_holds OR (v_new ->> v_id_column) IS DISTINCT FROM (v_old ->> v_id_column)) THEN
    PERFORM mercaria_oxy_file_reference_enqueue(v_entity_type, v_new ->> v_id_column);
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER mercaria_oxy_file_reference_listing_images
  AFTER INSERT OR DELETE OR UPDATE OF "file_id", "listing_id" ON "listing_images"
  FOR EACH ROW EXECUTE FUNCTION mercaria_oxy_file_reference_touch('listing_image', 'listing_id', 'value', 'file_id');
--> statement-breakpoint
CREATE TRIGGER mercaria_oxy_file_reference_listings_description
  AFTER INSERT OR DELETE OR UPDATE OF "description" ON "listings"
  FOR EACH ROW EXECUTE FUNCTION mercaria_oxy_file_reference_touch('listing_description_image', 'id', 'html', 'description');
--> statement-breakpoint
CREATE TRIGGER mercaria_oxy_file_reference_listing_localizations_description
  AFTER INSERT OR DELETE OR UPDATE OF "description", "listing_id" ON "listing_localizations"
  FOR EACH ROW EXECUTE FUNCTION mercaria_oxy_file_reference_touch('listing_description_image', 'listing_id', 'html', 'description');
--> statement-breakpoint
CREATE TRIGGER mercaria_oxy_file_reference_listing_condition_photos
  AFTER INSERT OR DELETE OR UPDATE OF "file_id" ON "listing_condition_photos"
  FOR EACH ROW EXECUTE FUNCTION mercaria_oxy_file_reference_touch('condition_photo', 'id', 'value', 'file_id');
--> statement-breakpoint
CREATE TRIGGER mercaria_oxy_file_reference_stores_logo
  AFTER INSERT OR DELETE OR UPDATE OF "logo_file_id" ON "stores"
  FOR EACH ROW EXECUTE FUNCTION mercaria_oxy_file_reference_touch('store_logo', 'id', 'value', 'logo_file_id');
--> statement-breakpoint
CREATE TRIGGER mercaria_oxy_file_reference_stores_cover
  AFTER INSERT OR DELETE OR UPDATE OF "cover_file_id" ON "stores"
  FOR EACH ROW EXECUTE FUNCTION mercaria_oxy_file_reference_touch('store_cover', 'id', 'value', 'cover_file_id');
--> statement-breakpoint
CREATE TRIGGER mercaria_oxy_file_reference_stores_policies
  AFTER INSERT OR DELETE OR UPDATE OF "policies_shipping_note", "policies_refund_policy", "policies_privacy_policy", "policies_terms_of_service" ON "stores"
  FOR EACH ROW EXECUTE FUNCTION mercaria_oxy_file_reference_touch('store_policy_image', 'id', 'html', 'policies_shipping_note', 'policies_refund_policy', 'policies_privacy_policy', 'policies_terms_of_service');
--> statement-breakpoint
CREATE TRIGGER mercaria_oxy_file_reference_collections
  AFTER INSERT OR DELETE OR UPDATE OF "image_file_id" ON "collections"
  FOR EACH ROW EXECUTE FUNCTION mercaria_oxy_file_reference_touch('collection_image', 'id', 'value', 'image_file_id');
--> statement-breakpoint
CREATE TRIGGER mercaria_oxy_file_reference_seller_draft_images
  AFTER INSERT OR DELETE OR UPDATE OF "file_id", "draft_id" ON "seller_draft_images"
  FOR EACH ROW EXECUTE FUNCTION mercaria_oxy_file_reference_touch('seller_draft_image', 'draft_id', 'value', 'file_id');
--> statement-breakpoint
CREATE TRIGGER mercaria_oxy_file_reference_catalog_authoring_drafts
  AFTER INSERT OR DELETE OR UPDATE OF "image_file_ids" ON "catalog_authoring_drafts"
  FOR EACH ROW EXECUTE FUNCTION mercaria_oxy_file_reference_touch('authoring_draft_image', 'id', 'value', 'image_file_ids');
--> statement-breakpoint
CREATE TRIGGER mercaria_oxy_file_reference_canonical_images
  AFTER INSERT OR DELETE OR UPDATE OF "file_id" ON "canonical_images"
  FOR EACH ROW EXECUTE FUNCTION mercaria_oxy_file_reference_touch('canonical_image', 'id', 'value', 'file_id');
--> statement-breakpoint
CREATE TRIGGER mercaria_oxy_file_reference_canonical_products_description
  AFTER INSERT OR DELETE OR UPDATE OF "description" ON "canonical_products"
  FOR EACH ROW EXECUTE FUNCTION mercaria_oxy_file_reference_touch('canonical_description_image', 'id', 'html', 'description');
--> statement-breakpoint
CREATE TRIGGER mercaria_oxy_file_reference_canonical_product_localizations_description
  AFTER INSERT OR DELETE OR UPDATE OF "description", "canonical_product_id" ON "canonical_product_localizations"
  FOR EACH ROW EXECUTE FUNCTION mercaria_oxy_file_reference_touch('canonical_description_image', 'canonical_product_id', 'html', 'description');
--> statement-breakpoint
CREATE TRIGGER mercaria_oxy_file_reference_categories
  AFTER INSERT OR DELETE OR UPDATE OF "image_file_id", "image_url" ON "categories"
  FOR EACH ROW EXECUTE FUNCTION mercaria_oxy_file_reference_touch('category_image', 'id', 'value', 'image_file_id', 'image_url');
--> statement-breakpoint
CREATE TRIGGER mercaria_oxy_file_reference_brands
  AFTER INSERT OR DELETE OR UPDATE OF "logo_file_id" ON "brands"
  FOR EACH ROW EXECUTE FUNCTION mercaria_oxy_file_reference_touch('brand_logo', 'id', 'value', 'logo_file_id');
--> statement-breakpoint
CREATE TRIGGER mercaria_oxy_file_reference_organization_identity_archives
  AFTER INSERT OR DELETE OR UPDATE OF "logo_file_id" ON "organization_identity_archives"
  FOR EACH ROW EXECUTE FUNCTION mercaria_oxy_file_reference_touch('organization_archive_logo', 'id', 'value', 'logo_file_id');
--> statement-breakpoint
CREATE TRIGGER mercaria_oxy_file_reference_review_media
  AFTER INSERT OR DELETE OR UPDATE OF "file_id", "review_id" ON "review_media"
  FOR EACH ROW EXECUTE FUNCTION mercaria_oxy_file_reference_touch('review_media', 'review_id', 'value', 'file_id');
--> statement-breakpoint
CREATE TRIGGER mercaria_oxy_file_reference_return_request_evidence
  AFTER INSERT OR DELETE OR UPDATE OF "file_id" ON "return_request_evidence"
  FOR EACH ROW EXECUTE FUNCTION mercaria_oxy_file_reference_touch('return_request_evidence', 'id', 'value', 'file_id');
--> statement-breakpoint
CREATE TRIGGER mercaria_oxy_file_reference_retail_service_request_evidence
  AFTER INSERT OR DELETE OR UPDATE OF "file_id" ON "retail_service_request_evidence"
  FOR EACH ROW EXECUTE FUNCTION mercaria_oxy_file_reference_touch('retail_service_request_evidence', 'id', 'value', 'file_id');
--> statement-breakpoint
CREATE TRIGGER mercaria_oxy_file_reference_supplier_agreement_evidence
  AFTER INSERT OR DELETE OR UPDATE OF "oxy_file_id" ON "supplier_agreement_evidence"
  FOR EACH ROW EXECUTE FUNCTION mercaria_oxy_file_reference_touch('supplier_agreement_evidence', 'id', 'value', 'oxy_file_id');
--> statement-breakpoint
CREATE TRIGGER mercaria_oxy_file_reference_retail_resale_evidence
  AFTER INSERT OR DELETE OR UPDATE OF "oxy_file_id" ON "retail_resale_evidence"
  FOR EACH ROW EXECUTE FUNCTION mercaria_oxy_file_reference_touch('retail_resale_evidence', 'id', 'value', 'oxy_file_id');
--> statement-breakpoint
CREATE TRIGGER mercaria_oxy_file_reference_retail_compliance_evidence
  AFTER INSERT OR DELETE OR UPDATE OF "oxy_file_id" ON "retail_compliance_evidence"
  FOR EACH ROW EXECUTE FUNCTION mercaria_oxy_file_reference_touch('retail_compliance_evidence', 'id', 'value', 'oxy_file_id');
--> statement-breakpoint
CREATE TRIGGER mercaria_oxy_file_reference_merchant_claim_evidence
  AFTER INSERT OR DELETE OR UPDATE OF "oxy_file_id" ON "merchant_claim_evidence"
  FOR EACH ROW EXECUTE FUNCTION mercaria_oxy_file_reference_touch('merchant_claim_evidence', 'id', 'value', 'oxy_file_id');
--> statement-breakpoint
CREATE TRIGGER mercaria_oxy_file_reference_relationship_evidence
  AFTER INSERT OR DELETE OR UPDATE OF "oxy_file_id" ON "relationship_evidence"
  FOR EACH ROW EXECUTE FUNCTION mercaria_oxy_file_reference_touch('relationship_evidence', 'id', 'value', 'oxy_file_id');
--> statement-breakpoint
-- The file-event audit is append-only: what a takedown removed, and from where,
-- is the record somebody asks for after the fact. No retention sweep deletes it.
CREATE OR REPLACE FUNCTION mercaria_oxy_file_events_append_only()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '%: the Oxy file-event audit is append-only', TG_TABLE_NAME
    USING ERRCODE = 'raise_exception';
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER mercaria_oxy_file_events_append_only
  BEFORE UPDATE OR DELETE ON "oxy_file_events"
  FOR EACH ROW EXECUTE FUNCTION mercaria_oxy_file_events_append_only();--> statement-breakpoint
CREATE TRIGGER mercaria_oxy_file_event_actions_append_only
  BEFORE UPDATE OR DELETE ON "oxy_file_event_actions"
  FOR EACH ROW EXECUTE FUNCTION mercaria_oxy_file_events_append_only();
--> statement-breakpoint
-- oxy:handwritten-end=oxy_file_reference_enqueue
