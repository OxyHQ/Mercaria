-- oxy:deploy-phase=pre
-- oxy:rollback=derived
ALTER TABLE "catalog_source_objects" ADD COLUMN "product_group_key" text;--> statement-breakpoint
CREATE INDEX "catalog_source_objects_product_group_idx" ON "catalog_source_objects" USING btree ("source_id","product_group_key") WHERE "catalog_source_objects"."product_group_key" is not null;--> statement-breakpoint
ALTER TABLE "catalog_source_objects" ADD CONSTRAINT "catalog_source_objects_product_group_key_check" CHECK ("catalog_source_objects"."product_group_key" is null or (btrim("catalog_source_objects"."product_group_key") <> '' and length("catalog_source_objects"."product_group_key") <= 200));
