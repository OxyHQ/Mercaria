-- oxy:deploy-phase=pre
-- oxy:rollback=derived
-- Disable new media writes before application rollback; retain populated media columns.
ALTER TABLE "listing_images" ADD COLUMN "kind" text DEFAULT 'image' NOT NULL;--> statement-breakpoint
ALTER TABLE "product_variant_images" ADD COLUMN "media_kind" text DEFAULT 'image' NOT NULL;--> statement-breakpoint
ALTER TABLE "canonical_images" ADD COLUMN "kind" text DEFAULT 'image' NOT NULL;--> statement-breakpoint
ALTER TABLE "listing_images" ADD CONSTRAINT "listing_images_id_listing_kind_key" UNIQUE("id","listing_id","kind");--> statement-breakpoint
ALTER TABLE "product_variant_images" ADD CONSTRAINT "product_variant_images_media_kind_fk" FOREIGN KEY ("listing_image_id","listing_id","media_kind") REFERENCES "public"."listing_images"("id","listing_id","kind") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listing_images" ADD CONSTRAINT "listing_images_kind_check" CHECK ("listing_images"."kind" in ('image', 'video'));--> statement-breakpoint
ALTER TABLE "product_variant_images" ADD CONSTRAINT "product_variant_images_image_only_check" CHECK ("product_variant_images"."media_kind" = 'image');--> statement-breakpoint
ALTER TABLE "canonical_images" ADD CONSTRAINT "canonical_images_kind_check" CHECK ("canonical_images"."kind" in ('image', 'video'));--> statement-breakpoint
ALTER TABLE "canonical_images" ADD CONSTRAINT "canonical_images_video_grain_check" CHECK ("canonical_images"."kind" = 'image' or ("canonical_images"."product_id" is not null and "canonical_images"."file_id" is not null));
--> statement-breakpoint
-- Keep condition evidence photographic in BOTH write orders. The existing
-- canonical/borrowed-media triggers continue to examine every kind.
-- oxy:handwritten-begin=catalog_media_discriminant_guards
CREATE FUNCTION mercaria_condition_photo_reject_video() RETURNS trigger AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('catalog-media-kind:' || NEW.file_id, 0));
  IF EXISTS (SELECT 1 FROM listing_images WHERE file_id = NEW.file_id AND kind = 'video')
     OR EXISTS (SELECT 1 FROM canonical_images WHERE file_id = NEW.file_id AND kind = 'video') THEN
    RAISE EXCEPTION 'A video cannot serve as condition photographic evidence' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER listing_condition_photos_reject_video
  BEFORE INSERT OR UPDATE OF file_id ON listing_condition_photos
  FOR EACH ROW EXECUTE FUNCTION mercaria_condition_photo_reject_video();--> statement-breakpoint
CREATE FUNCTION mercaria_catalog_video_reject_condition_photo() RETURNS trigger AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('catalog-media-kind:' || NEW.file_id, 0));
  IF NEW.kind = 'video' AND (EXISTS (SELECT 1 FROM listing_condition_photos WHERE file_id = NEW.file_id)
      OR EXISTS (SELECT 1 FROM seller_draft_images WHERE file_id = NEW.file_id)) THEN
    RAISE EXCEPTION 'Condition photographic evidence cannot become catalog video' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER canonical_images_video_reject_condition_photo
  BEFORE INSERT OR UPDATE OF file_id, kind ON canonical_images
  FOR EACH ROW EXECUTE FUNCTION mercaria_catalog_video_reject_condition_photo();--> statement-breakpoint
CREATE TRIGGER listing_images_video_reject_condition_photo
  BEFORE INSERT OR UPDATE OF file_id, kind ON listing_images
  FOR EACH ROW EXECUTE FUNCTION mercaria_catalog_video_reject_condition_photo();
--> statement-breakpoint
-- A durable Oxy file has one MIME. Older image-only writers cannot relabel a
-- known video and accidentally publish it into feed/cart image projections.
CREATE FUNCTION mercaria_catalog_media_kind_consistent() RETURNS trigger AS $$
BEGIN
  IF NEW.file_id IS NULL THEN RETURN NEW; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('catalog-media-kind:' || NEW.file_id, 0));
  IF EXISTS (SELECT 1 FROM listing_images WHERE file_id = NEW.file_id AND kind <> NEW.kind)
     OR EXISTS (SELECT 1 FROM canonical_images WHERE file_id = NEW.file_id AND kind <> NEW.kind) THEN
    RAISE EXCEPTION 'A durable catalog file cannot change media kind' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER listing_images_media_kind_consistent
  BEFORE INSERT OR UPDATE OF file_id, kind ON listing_images
  FOR EACH ROW EXECUTE FUNCTION mercaria_catalog_media_kind_consistent();--> statement-breakpoint
CREATE TRIGGER canonical_images_media_kind_consistent
  BEFORE INSERT OR UPDATE OF file_id, kind ON canonical_images
  FOR EACH ROW EXECUTE FUNCTION mercaria_catalog_media_kind_consistent();

--> statement-breakpoint
CREATE TRIGGER seller_draft_images_reject_video
  BEFORE INSERT OR UPDATE OF file_id ON seller_draft_images
  FOR EACH ROW EXECUTE FUNCTION mercaria_condition_photo_reject_video();
-- oxy:handwritten-end=catalog_media_discriminant_guards
