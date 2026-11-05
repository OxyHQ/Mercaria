-- oxy:deploy-phase=pre
-- oxy:rollback=restore: drop data_export_runs and data_export_schedules; oxy_file_event_actions_entity_type_check, oxy_file_reference_outboxes_entity_type_check, oxy_file_reference_reconciliations_entity_type_check and oxy_file_references_entity_type_check are widened with `data_export_file`, their previous form is in 0180, and re-adding it fails once an export file has been referenced
--
-- Store data exports (`docs/data-exports.md`): the free on-demand CSV every
-- store may take of its own orders, products and customers, and the paid
-- `scheduled_exports` capability that takes the same file on a cadence.
--
-- - `data_export_schedules`: a store's recurring exports.
-- - `data_export_runs`: one export, on demand or one scheduled occurrence
--   (unique per schedule and occurrence), leased by the export worker.
-- - `data_export_file` joins the Oxy file reference vocabulary, and
--   `data_export_runs` gets the reference trigger of 0172, so Oxy keeps an
--   export file while its run holds it and collects it once the column clears.
--
-- Purely ADDITIVE against the serving image: two new tables and four CHECKs
-- widened to a strict superset.
CREATE TABLE "data_export_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"store_id" text NOT NULL,
	"schedule_id" text,
	"trigger" text NOT NULL,
	"dataset" text NOT NULL,
	"format" text DEFAULT 'csv' NOT NULL,
	"occurrence_at" timestamp with time zone,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone NOT NULL,
	"lease_owner" text,
	"lease_until" timestamp with time zone,
	"row_count" integer,
	"byte_size" bigint,
	"truncated" boolean DEFAULT false NOT NULL,
	"file_id" text,
	"file_expires_at" timestamp with time zone,
	"failure" text,
	"last_error" text,
	"requested_by_oxy_user_id" text,
	"completed_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "data_export_runs_trigger_check" CHECK ("data_export_runs"."trigger" in ('on_demand', 'schedule')),
	CONSTRAINT "data_export_runs_dataset_check" CHECK ("data_export_runs"."dataset" in ('orders', 'products', 'customers')),
	CONSTRAINT "data_export_runs_format_check" CHECK ("data_export_runs"."format" in ('csv')),
	CONSTRAINT "data_export_runs_status_check" CHECK ("data_export_runs"."status" in ('pending', 'running', 'succeeded', 'failed', 'skipped_limit', 'skipped_not_entitled')),
	CONSTRAINT "data_export_runs_failure_check" CHECK ("data_export_runs"."failure" in ('generation_failed', 'storage_unavailable')),
	CONSTRAINT "data_export_runs_attempts_check" CHECK ("data_export_runs"."attempts" >= 0),
	CONSTRAINT "data_export_runs_figures_check" CHECK (("data_export_runs"."row_count" is null or "data_export_runs"."row_count" >= 0)
          and ("data_export_runs"."byte_size" is null or "data_export_runs"."byte_size" >= 0)),
	CONSTRAINT "data_export_runs_trigger_shape_check" CHECK (("data_export_runs"."trigger" = 'schedule') = ("data_export_runs"."occurrence_at" is not null)
          and ("data_export_runs"."trigger" = 'on_demand') = ("data_export_runs"."requested_by_oxy_user_id" is not null)
          and ("data_export_runs"."trigger" <> 'on_demand' or "data_export_runs"."schedule_id" is null)),
	CONSTRAINT "data_export_runs_lease_shape_check" CHECK (("data_export_runs"."status" = 'running') = ("data_export_runs"."lease_owner" is not null)
          and ("data_export_runs"."lease_owner" is null) = ("data_export_runs"."lease_until" is null)),
	CONSTRAINT "data_export_runs_succeeded_shape_check" CHECK (("data_export_runs"."status" = 'succeeded') = ("data_export_runs"."row_count" is not null
            and "data_export_runs"."byte_size" is not null and "data_export_runs"."file_expires_at" is not null)),
	CONSTRAINT "data_export_runs_failed_shape_check" CHECK (("data_export_runs"."status" = 'failed') = ("data_export_runs"."failure" is not null)),
	CONSTRAINT "data_export_runs_file_shape_check" CHECK ("data_export_runs"."file_id" is null or "data_export_runs"."status" = 'succeeded'),
	CONSTRAINT "data_export_runs_completed_shape_check" CHECK (("data_export_runs"."status" in ('pending', 'running')) = ("data_export_runs"."completed_at" is null)),
	CONSTRAINT "data_export_runs_last_error_length_check" CHECK ("data_export_runs"."last_error" is null or length("data_export_runs"."last_error") <= 512)
);
--> statement-breakpoint
CREATE TABLE "data_export_schedules" (
	"id" text PRIMARY KEY NOT NULL,
	"store_id" text NOT NULL,
	"dataset" text NOT NULL,
	"format" text DEFAULT 'csv' NOT NULL,
	"cadence" text NOT NULL,
	"hour" integer NOT NULL,
	"weekday" integer,
	"day_of_month" integer,
	"time_zone" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"next_run_at" timestamp with time zone,
	"created_by_oxy_user_id" text NOT NULL,
	"updated_by_oxy_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "data_export_schedules_dataset_check" CHECK ("data_export_schedules"."dataset" in ('orders', 'products', 'customers')),
	CONSTRAINT "data_export_schedules_format_check" CHECK ("data_export_schedules"."format" in ('csv')),
	CONSTRAINT "data_export_schedules_cadence_check" CHECK ("data_export_schedules"."cadence" in ('daily', 'weekly', 'monthly')),
	CONSTRAINT "data_export_schedules_hour_check" CHECK ("data_export_schedules"."hour" between 0 and 23),
	CONSTRAINT "data_export_schedules_weekday_shape_check" CHECK (("data_export_schedules"."cadence" = 'weekly') = ("data_export_schedules"."weekday" is not null)
          and ("data_export_schedules"."weekday" is null or "data_export_schedules"."weekday" between 0 and 6)),
	CONSTRAINT "data_export_schedules_day_of_month_shape_check" CHECK (("data_export_schedules"."cadence" = 'monthly') = ("data_export_schedules"."day_of_month" is not null)
          and ("data_export_schedules"."day_of_month" is null
               or "data_export_schedules"."day_of_month" between 1 and 28)),
	CONSTRAINT "data_export_schedules_time_zone_shape_check" CHECK (length("data_export_schedules"."time_zone") between 1 and 64),
	CONSTRAINT "data_export_schedules_enabled_shape_check" CHECK ("data_export_schedules"."enabled" = ("data_export_schedules"."next_run_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "oxy_file_event_actions" DROP CONSTRAINT "oxy_file_event_actions_entity_type_check";--> statement-breakpoint
ALTER TABLE "oxy_file_reference_outboxes" DROP CONSTRAINT "oxy_file_reference_outboxes_entity_type_check";--> statement-breakpoint
ALTER TABLE "oxy_file_reference_reconciliations" DROP CONSTRAINT "oxy_file_reference_reconciliations_entity_type_check";--> statement-breakpoint
ALTER TABLE "oxy_file_references" DROP CONSTRAINT "oxy_file_references_entity_type_check";--> statement-breakpoint
ALTER TABLE "data_export_runs" ADD CONSTRAINT "data_export_runs_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_export_runs" ADD CONSTRAINT "data_export_runs_schedule_id_data_export_schedules_id_fk" FOREIGN KEY ("schedule_id") REFERENCES "public"."data_export_schedules"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_export_schedules" ADD CONSTRAINT "data_export_schedules_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "data_export_runs_schedule_occurrence_key" ON "data_export_runs" USING btree ("schedule_id","occurrence_at") WHERE "data_export_runs"."schedule_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "data_export_runs_open_on_demand_key" ON "data_export_runs" USING btree ("store_id","dataset") WHERE "data_export_runs"."trigger" = 'on_demand' and "data_export_runs"."status" in ('pending', 'running');--> statement-breakpoint
CREATE INDEX "data_export_runs_store_idx" ON "data_export_runs" USING btree ("store_id","created_at");--> statement-breakpoint
CREATE INDEX "data_export_runs_claim_idx" ON "data_export_runs" USING btree ("status","available_at") WHERE "data_export_runs"."status" in ('pending', 'running');--> statement-breakpoint
CREATE INDEX "data_export_runs_file_expiry_idx" ON "data_export_runs" USING btree ("file_expires_at") WHERE "data_export_runs"."file_id" is not null;--> statement-breakpoint
CREATE INDEX "data_export_runs_schedule_id_idx" ON "data_export_runs" USING btree ("schedule_id") WHERE "data_export_runs"."schedule_id" is not null;--> statement-breakpoint
CREATE INDEX "data_export_runs_expiry_idx" ON "data_export_runs" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "data_export_schedules_store_idx" ON "data_export_schedules" USING btree ("store_id","created_at");--> statement-breakpoint
CREATE INDEX "data_export_schedules_due_idx" ON "data_export_schedules" USING btree ("next_run_at") WHERE "data_export_schedules"."next_run_at" is not null;--> statement-breakpoint
ALTER TABLE "oxy_file_event_actions" ADD CONSTRAINT "oxy_file_event_actions_entity_type_check" CHECK ("oxy_file_event_actions"."entity_type" in ('listing_image', 'listing_description_image', 'condition_photo', 'store_logo', 'store_cover', 'store_policy_image', 'collection_image', 'seller_draft_image', 'authoring_draft_image', 'canonical_image', 'canonical_description_image', 'category_image', 'brand_logo', 'organization_archive_logo', 'review_media', 'return_request_evidence', 'retail_service_request_evidence', 'supplier_agreement_evidence', 'retail_resale_evidence', 'retail_compliance_evidence', 'merchant_claim_evidence', 'relationship_evidence', 'order_item_image', 'digital_asset_file', 'feed_upload', 'data_export_file'));--> statement-breakpoint
ALTER TABLE "oxy_file_reference_outboxes" ADD CONSTRAINT "oxy_file_reference_outboxes_entity_type_check" CHECK ("oxy_file_reference_outboxes"."entity_type" in ('listing_image', 'listing_description_image', 'condition_photo', 'store_logo', 'store_cover', 'store_policy_image', 'collection_image', 'seller_draft_image', 'authoring_draft_image', 'canonical_image', 'canonical_description_image', 'category_image', 'brand_logo', 'organization_archive_logo', 'review_media', 'return_request_evidence', 'retail_service_request_evidence', 'supplier_agreement_evidence', 'retail_resale_evidence', 'retail_compliance_evidence', 'merchant_claim_evidence', 'relationship_evidence', 'order_item_image', 'digital_asset_file', 'feed_upload', 'data_export_file'));--> statement-breakpoint
ALTER TABLE "oxy_file_reference_reconciliations" ADD CONSTRAINT "oxy_file_reference_reconciliations_entity_type_check" CHECK ("oxy_file_reference_reconciliations"."entity_type" in ('listing_image', 'listing_description_image', 'condition_photo', 'store_logo', 'store_cover', 'store_policy_image', 'collection_image', 'seller_draft_image', 'authoring_draft_image', 'canonical_image', 'canonical_description_image', 'category_image', 'brand_logo', 'organization_archive_logo', 'review_media', 'return_request_evidence', 'retail_service_request_evidence', 'supplier_agreement_evidence', 'retail_resale_evidence', 'retail_compliance_evidence', 'merchant_claim_evidence', 'relationship_evidence', 'order_item_image', 'digital_asset_file', 'feed_upload', 'data_export_file'));--> statement-breakpoint
ALTER TABLE "oxy_file_references" ADD CONSTRAINT "oxy_file_references_entity_type_check" CHECK ("oxy_file_references"."entity_type" in ('listing_image', 'listing_description_image', 'condition_photo', 'store_logo', 'store_cover', 'store_policy_image', 'collection_image', 'seller_draft_image', 'authoring_draft_image', 'canonical_image', 'canonical_description_image', 'category_image', 'brand_logo', 'organization_archive_logo', 'review_media', 'return_request_evidence', 'retail_service_request_evidence', 'supplier_agreement_evidence', 'retail_resale_evidence', 'retail_compliance_evidence', 'merchant_claim_evidence', 'relationship_evidence', 'order_item_image', 'digital_asset_file', 'feed_upload', 'data_export_file'));
--> statement-breakpoint
-- oxy:handwritten-begin=mercaria_oxy_file_reference_data_export_runs
CREATE TRIGGER mercaria_oxy_file_reference_data_export_runs
  AFTER INSERT OR DELETE OR UPDATE OF "file_id" ON "data_export_runs"
  FOR EACH ROW EXECUTE FUNCTION mercaria_oxy_file_reference_touch('data_export_file', 'id', 'value', 'file_id');
-- oxy:handwritten-end=mercaria_oxy_file_reference_data_export_runs
