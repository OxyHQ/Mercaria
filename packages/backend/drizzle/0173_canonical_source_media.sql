-- oxy:deploy-phase=pre
-- oxy:rollback=derived
CREATE TABLE "canonical_source_media_imports" (
	"id" text PRIMARY KEY NOT NULL,
	"canonical_product_id" text NOT NULL,
	"source_record_id" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone NOT NULL,
	"lease_owner" text,
	"lease_until" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "canonical_source_media_imports_status_check" CHECK ("canonical_source_media_imports"."status" in ('pending', 'processing', 'dead_letter')),
	CONSTRAINT "canonical_source_media_imports_attempts_check" CHECK ("canonical_source_media_imports"."attempts" >= 0),
	CONSTRAINT "canonical_source_media_imports_last_error_length_check" CHECK ("canonical_source_media_imports"."last_error" is null or length("canonical_source_media_imports"."last_error") <= 2000)
);
--> statement-breakpoint
ALTER TABLE "canonical_source_media_imports" ADD CONSTRAINT "canonical_source_media_imports_canonical_product_id_canonical_products_id_fk" FOREIGN KEY ("canonical_product_id") REFERENCES "public"."canonical_products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canonical_source_media_imports" ADD CONSTRAINT "canonical_source_media_imports_source_record_id_source_records_id_fk" FOREIGN KEY ("source_record_id") REFERENCES "public"."source_records"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "canonical_source_media_imports_product_record_key" ON "canonical_source_media_imports" USING btree ("canonical_product_id","source_record_id");--> statement-breakpoint
CREATE INDEX "canonical_source_media_imports_pending_idx" ON "canonical_source_media_imports" USING btree ("available_at","created_at") WHERE "canonical_source_media_imports"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "canonical_source_media_imports_reclaim_idx" ON "canonical_source_media_imports" USING btree ("lease_until","created_at") WHERE "canonical_source_media_imports"."status" = 'processing';--> statement-breakpoint
CREATE INDEX "canonical_source_media_imports_record_idx" ON "canonical_source_media_imports" USING btree ("source_record_id");
--> statement-breakpoint
-- Every path that attaches a source observation to a canonical product writes
-- an ACTIVE canonical_product_source_links row (the ingestion matcher, #60's
-- backfill, an operator's observation). This trigger is the one place that
-- sees all three, in the writer's own transaction, and queues the observation's
-- stored imagery to be copied into canonical_images as files the Mercaria
-- application owns (Oxy ADR 0043). Only an observation whose stored payload
-- names media queues anything; the import is bounded by the dispatcher
-- (`services/catalog-media/source-media-import.ts`), never done here.
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
    ("id", "canonical_product_id", "source_record_id", "status", "attempts", "available_at")
  SELECT gen_random_uuid()::text, NEW.product_id, NEW.source_record_id, 'pending', 0,
         date_trunc('milliseconds', now())
    FROM "source_records" r
   WHERE r.id = NEW.source_record_id
     AND jsonb_typeof(r.payload -> 'media') = 'array'
     AND jsonb_array_length(r.payload -> 'media') > 0
  ON CONFLICT ("canonical_product_id", "source_record_id") DO NOTHING;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER mercaria_canonical_source_media_enqueue
  AFTER INSERT OR UPDATE OF "status", "product_id" ON "canonical_product_source_links"
  FOR EACH ROW EXECUTE FUNCTION mercaria_canonical_source_media_enqueue();
--> statement-breakpoint
-- oxy:handwritten-end=canonical_source_media_enqueue
