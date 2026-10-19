-- oxy:deploy-phase=pre
-- oxy:rollback=replay: mercaria_canonical_source_media_enqueue — migration 0173's CREATE OR REPLACE FUNCTION re-creates the previous body
DROP INDEX "canonical_source_media_imports_pending_idx";--> statement-breakpoint
ALTER TABLE "canonical_source_media_imports" ADD COLUMN "priority" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
CREATE INDEX "canonical_source_media_imports_pending_idx" ON "canonical_source_media_imports" USING btree ("priority","available_at","created_at") WHERE "canonical_source_media_imports"."status" = 'pending';--> statement-breakpoint
ALTER TABLE "canonical_source_media_imports" ADD CONSTRAINT "canonical_source_media_imports_priority_check" CHECK ("canonical_source_media_imports"."priority" in (0, 1));
--> statement-breakpoint
-- A product that shows no image is drained first: the jobs already queued for
-- one take priority 0 (the column defaults the rest to 1).
UPDATE "canonical_source_media_imports" q
   SET "priority" = 0
 WHERE q."status" = 'pending'
   AND NOT EXISTS (
     SELECT 1 FROM "canonical_images" ci
      WHERE ci."product_id" = q."canonical_product_id"
        AND ci."status" = 'active'
        AND ci."file_id" IS NOT NULL
   );
--> statement-breakpoint
-- The enqueue trigger (0173) queued every observation that names media — and
-- ingestion re-observes every offer on every run, so 149,000 jobs piled up for
-- images their products already held, ahead of the products that had none. It
-- now queues nothing when the product already holds every image the
-- observation names, and queues at priority 0 when the product shows none.
-- oxy:handwritten-begin=canonical_source_media_enqueue
CREATE OR REPLACE FUNCTION mercaria_canonical_source_media_enqueue()
RETURNS trigger AS $$
BEGIN
  IF NEW.status <> 'active' THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.status = 'active'
     AND OLD.product_id IS NOT DISTINCT FROM NEW.product_id THEN
    RETURN NULL;
  END IF;
  INSERT INTO "canonical_source_media_imports"
    ("id", "canonical_product_id", "source_record_id", "status", "attempts", "priority", "available_at")
  SELECT gen_random_uuid()::text, NEW.product_id, NEW.source_record_id, 'pending', 0,
         CASE WHEN EXISTS (
           SELECT 1 FROM "canonical_images" ci
            WHERE ci."product_id" = NEW.product_id
              AND ci."status" = 'active'
              AND ci."file_id" IS NOT NULL
         ) THEN 1 ELSE 0 END,
         date_trunc('milliseconds', now())
    FROM "source_records" r
   WHERE r.id = NEW.source_record_id
     AND jsonb_typeof(r.payload -> 'media') = 'array'
     AND jsonb_array_length(r.payload -> 'media') > 0
     AND EXISTS (
       SELECT 1 FROM jsonb_array_elements_text(r.payload -> 'media') AS m(url)
        WHERE NOT EXISTS (
          SELECT 1 FROM "canonical_images" ci
           WHERE ci."product_id" = NEW.product_id
             AND ci."source_url" = m.url
        )
     )
  ON CONFLICT ("canonical_product_id", "source_record_id") DO NOTHING;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
-- oxy:handwritten-end=canonical_source_media_enqueue
