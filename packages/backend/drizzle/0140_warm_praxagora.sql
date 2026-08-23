-- oxy:deploy-phase=pre
-- oxy:rollback=derived
ALTER TABLE "catalog_authoring_drafts" ADD COLUMN "create_idempotency_key" text;--> statement-breakpoint
CREATE UNIQUE INDEX "catalog_authoring_drafts_create_idempotency_key" ON "catalog_authoring_drafts" USING btree ("store_id","create_idempotency_key") WHERE "catalog_authoring_drafts"."create_idempotency_key" is not null;