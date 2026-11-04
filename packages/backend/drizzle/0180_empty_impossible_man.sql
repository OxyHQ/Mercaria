-- oxy:deploy-phase=pre
-- oxy:rollback=restore: the four oxy_file_*_entity_type_check constraints are widened with `feed_upload`; their previous form is in 0172, and re-adding it fails once a feed upload has been referenced. feed_uploads.expires_at loses NOT NULL; SET NOT NULL fails once an upload has been consumed
--
-- Feed files go straight to storage, and a whole-feed validation runs in the
-- background (`docs/feed-importer.md`). Every Oxy API hostname sits behind a
-- proxy that refuses a request body over 100 MB and an origin that answers
-- after 100 s, so the importer stops taking a feed as a request body and stops
-- reading one inside a request.
--
-- - `feed_upload_sessions`: a client opens one, PUTs presigned parts to Oxy
--   Files' storage itself and completes; Mercaria accepts the stored object
--   into `feed_uploads`, whose `storage_key` is now an Oxy file id.
-- - `feed_validation_jobs`: the validation outbox the 202 answer polls.
-- - `feed_uploads.expires_at` becomes NULL once a version cites the upload, so
--   the sweep never meets the `restrict` key from `feed_configuration_versions`.
-- - `feed_upload` joins the Oxy file reference vocabulary, and `feed_uploads`
--   gets the reference trigger of 0172, so Oxy keeps the file while the row
--   lives and collects it once the row is gone.
--
-- Purely ADDITIVE against the serving image: two new tables, a dropped NOT NULL,
-- a CHECK the serving image's writes already satisfy (it never consumes an
-- upload, so every row it writes has `consumed_at` NULL and `expires_at` set),
-- and four CHECKs widened to a strict superset. Production holds no feed upload.
CREATE TABLE "feed_upload_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"configuration_id" text NOT NULL,
	"filename" text NOT NULL,
	"compression" text NOT NULL,
	"byte_size" bigint NOT NULL,
	"content_digest" text NOT NULL,
	"oxy_upload_id" text,
	"oxy_file_id" text,
	"status" text DEFAULT 'uploading' NOT NULL,
	"proof_offset" bigint,
	"proof_length" integer,
	"feed_upload_id" text,
	"failure" text,
	"opened_by_oxy_user_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "feed_upload_sessions_status_check" CHECK ("feed_upload_sessions"."status" in ('uploading', 'proof_required', 'verifying', 'completed', 'failed')),
	CONSTRAINT "feed_upload_sessions_compression_check" CHECK ("feed_upload_sessions"."compression" in ('none', 'gzip')),
	CONSTRAINT "feed_upload_sessions_failure_check" CHECK ("feed_upload_sessions"."failure" in ('checksum_mismatch', 'size_mismatch', 'forbidden_container', 'compression_mismatch', 'content_blocked', 'storage_refused', 'expired', 'proof_failed')),
	CONSTRAINT "feed_upload_sessions_filename_shape_check" CHECK ("feed_upload_sessions"."filename" ~ '^[A-Za-z0-9][A-Za-z0-9 _.-]{0,199}$' and "feed_upload_sessions"."filename" !~ '\.\.'),
	CONSTRAINT "feed_upload_sessions_digest_shape_check" CHECK ("feed_upload_sessions"."content_digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "feed_upload_sessions_byte_size_check" CHECK ("feed_upload_sessions"."byte_size" > 0),
	CONSTRAINT "feed_upload_sessions_completed_shape_check" CHECK (("feed_upload_sessions"."status" = 'completed') = ("feed_upload_sessions"."feed_upload_id" is not null)),
	CONSTRAINT "feed_upload_sessions_failed_shape_check" CHECK (("feed_upload_sessions"."status" = 'failed') = ("feed_upload_sessions"."failure" is not null)),
	CONSTRAINT "feed_upload_sessions_upload_shape_check" CHECK ("feed_upload_sessions"."status" not in ('uploading', 'verifying') or "feed_upload_sessions"."oxy_upload_id" is not null),
	CONSTRAINT "feed_upload_sessions_file_shape_check" CHECK ("feed_upload_sessions"."status" not in ('proof_required', 'completed') or "feed_upload_sessions"."oxy_file_id" is not null),
	CONSTRAINT "feed_upload_sessions_proof_shape_check" CHECK (("feed_upload_sessions"."proof_offset" is null) = ("feed_upload_sessions"."proof_length" is null)
          and ("feed_upload_sessions"."status" <> 'proof_required' or "feed_upload_sessions"."proof_offset" is not null)
          and ("feed_upload_sessions"."proof_offset" is null or ("feed_upload_sessions"."proof_offset" >= 0 and "feed_upload_sessions"."proof_length" > 0
               and "feed_upload_sessions"."proof_length" <= 65536
               and "feed_upload_sessions"."proof_offset" + "feed_upload_sessions"."proof_length" <= "feed_upload_sessions"."byte_size")))
);
--> statement-breakpoint
CREATE TABLE "feed_validation_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"configuration_id" text NOT NULL,
	"version_id" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone NOT NULL,
	"lease_owner" text,
	"lease_until" timestamp with time zone,
	"report_id" text,
	"failure_reason" text,
	"last_error" text,
	"requested_by_oxy_user_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "feed_validation_jobs_status_check" CHECK ("feed_validation_jobs"."status" in ('pending', 'processing', 'completed', 'failed', 'dead_letter')),
	CONSTRAINT "feed_validation_jobs_failure_reason_check" CHECK ("feed_validation_jobs"."failure_reason" in ('configuration_missing', 'configuration_incomplete', 'unsupported_format', 'forbidden_container', 'insecure_url', 'blocked_address', 'upstream_unavailable', 'upstream_status', 'unauthorized', 'download_too_large', 'decompressed_too_large', 'compression_ratio_exceeded', 'too_many_records', 'record_too_large', 'malformed_feed', 'entity_declaration_refused', 'record_path_not_found', 'no_records_mapped', 'upload_missing', 'stage_unavailable')),
	CONSTRAINT "feed_validation_jobs_attempts_check" CHECK ("feed_validation_jobs"."attempts" >= 0),
	CONSTRAINT "feed_validation_jobs_completed_shape_check" CHECK (("feed_validation_jobs"."status" = 'completed') = ("feed_validation_jobs"."report_id" is not null)),
	CONSTRAINT "feed_validation_jobs_failed_shape_check" CHECK (("feed_validation_jobs"."status" = 'failed') = ("feed_validation_jobs"."failure_reason" is not null)),
	CONSTRAINT "feed_validation_jobs_lease_shape_check" CHECK (("feed_validation_jobs"."status" = 'processing') = ("feed_validation_jobs"."lease_owner" is not null)
          and ("feed_validation_jobs"."lease_owner" is null) = ("feed_validation_jobs"."lease_until" is null)),
	CONSTRAINT "feed_validation_jobs_last_error_length_check" CHECK ("feed_validation_jobs"."last_error" is null
          or length("feed_validation_jobs"."last_error") <= 512)
);
--> statement-breakpoint
ALTER TABLE "oxy_file_event_actions" DROP CONSTRAINT "oxy_file_event_actions_entity_type_check";--> statement-breakpoint
ALTER TABLE "oxy_file_reference_outboxes" DROP CONSTRAINT "oxy_file_reference_outboxes_entity_type_check";--> statement-breakpoint
ALTER TABLE "oxy_file_reference_reconciliations" DROP CONSTRAINT "oxy_file_reference_reconciliations_entity_type_check";--> statement-breakpoint
ALTER TABLE "oxy_file_references" DROP CONSTRAINT "oxy_file_references_entity_type_check";--> statement-breakpoint
ALTER TABLE "feed_uploads" ALTER COLUMN "expires_at" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "feed_upload_sessions" ADD CONSTRAINT "feed_upload_sessions_configuration_id_feed_configurations_id_fk" FOREIGN KEY ("configuration_id") REFERENCES "public"."feed_configurations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feed_upload_sessions" ADD CONSTRAINT "feed_upload_sessions_feed_upload_id_feed_uploads_id_fk" FOREIGN KEY ("feed_upload_id") REFERENCES "public"."feed_uploads"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feed_validation_jobs" ADD CONSTRAINT "feed_validation_jobs_configuration_id_feed_configurations_id_fk" FOREIGN KEY ("configuration_id") REFERENCES "public"."feed_configurations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feed_validation_jobs" ADD CONSTRAINT "feed_validation_jobs_version_id_feed_configuration_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."feed_configuration_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feed_validation_jobs" ADD CONSTRAINT "feed_validation_jobs_report_id_feed_import_reports_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."feed_import_reports"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "feed_upload_sessions_open_upload_key" ON "feed_upload_sessions" USING btree ("oxy_upload_id") WHERE "feed_upload_sessions"."status" in ('uploading', 'verifying') and "feed_upload_sessions"."oxy_upload_id" is not null;--> statement-breakpoint
CREATE INDEX "feed_upload_sessions_configuration_idx" ON "feed_upload_sessions" USING btree ("configuration_id","created_at");--> statement-breakpoint
CREATE INDEX "feed_upload_sessions_feed_upload_id_idx" ON "feed_upload_sessions" USING btree ("feed_upload_id") WHERE "feed_upload_sessions"."feed_upload_id" is not null;--> statement-breakpoint
CREATE INDEX "feed_upload_sessions_expiry_idx" ON "feed_upload_sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "feed_validation_jobs_open_version_key" ON "feed_validation_jobs" USING btree ("version_id") WHERE "feed_validation_jobs"."status" in ('pending', 'processing');--> statement-breakpoint
CREATE INDEX "feed_validation_jobs_claim_idx" ON "feed_validation_jobs" USING btree ("status","available_at");--> statement-breakpoint
CREATE INDEX "feed_validation_jobs_configuration_idx" ON "feed_validation_jobs" USING btree ("configuration_id","created_at");--> statement-breakpoint
CREATE INDEX "feed_validation_jobs_report_id_idx" ON "feed_validation_jobs" USING btree ("report_id") WHERE "feed_validation_jobs"."report_id" is not null;--> statement-breakpoint
CREATE INDEX "feed_validation_jobs_expiry_idx" ON "feed_validation_jobs" USING btree ("expires_at");--> statement-breakpoint
ALTER TABLE "feed_uploads" ADD CONSTRAINT "feed_uploads_retention_shape_check" CHECK (("feed_uploads"."consumed_at" is null) = ("feed_uploads"."expires_at" is not null));--> statement-breakpoint
ALTER TABLE "oxy_file_event_actions" ADD CONSTRAINT "oxy_file_event_actions_entity_type_check" CHECK ("oxy_file_event_actions"."entity_type" in ('listing_image', 'listing_description_image', 'condition_photo', 'store_logo', 'store_cover', 'store_policy_image', 'collection_image', 'seller_draft_image', 'authoring_draft_image', 'canonical_image', 'canonical_description_image', 'category_image', 'brand_logo', 'organization_archive_logo', 'review_media', 'return_request_evidence', 'retail_service_request_evidence', 'supplier_agreement_evidence', 'retail_resale_evidence', 'retail_compliance_evidence', 'merchant_claim_evidence', 'relationship_evidence', 'order_item_image', 'digital_asset_file', 'feed_upload'));--> statement-breakpoint
ALTER TABLE "oxy_file_reference_outboxes" ADD CONSTRAINT "oxy_file_reference_outboxes_entity_type_check" CHECK ("oxy_file_reference_outboxes"."entity_type" in ('listing_image', 'listing_description_image', 'condition_photo', 'store_logo', 'store_cover', 'store_policy_image', 'collection_image', 'seller_draft_image', 'authoring_draft_image', 'canonical_image', 'canonical_description_image', 'category_image', 'brand_logo', 'organization_archive_logo', 'review_media', 'return_request_evidence', 'retail_service_request_evidence', 'supplier_agreement_evidence', 'retail_resale_evidence', 'retail_compliance_evidence', 'merchant_claim_evidence', 'relationship_evidence', 'order_item_image', 'digital_asset_file', 'feed_upload'));--> statement-breakpoint
ALTER TABLE "oxy_file_reference_reconciliations" ADD CONSTRAINT "oxy_file_reference_reconciliations_entity_type_check" CHECK ("oxy_file_reference_reconciliations"."entity_type" in ('listing_image', 'listing_description_image', 'condition_photo', 'store_logo', 'store_cover', 'store_policy_image', 'collection_image', 'seller_draft_image', 'authoring_draft_image', 'canonical_image', 'canonical_description_image', 'category_image', 'brand_logo', 'organization_archive_logo', 'review_media', 'return_request_evidence', 'retail_service_request_evidence', 'supplier_agreement_evidence', 'retail_resale_evidence', 'retail_compliance_evidence', 'merchant_claim_evidence', 'relationship_evidence', 'order_item_image', 'digital_asset_file', 'feed_upload'));--> statement-breakpoint
ALTER TABLE "oxy_file_references" ADD CONSTRAINT "oxy_file_references_entity_type_check" CHECK ("oxy_file_references"."entity_type" in ('listing_image', 'listing_description_image', 'condition_photo', 'store_logo', 'store_cover', 'store_policy_image', 'collection_image', 'seller_draft_image', 'authoring_draft_image', 'canonical_image', 'canonical_description_image', 'category_image', 'brand_logo', 'organization_archive_logo', 'review_media', 'return_request_evidence', 'retail_service_request_evidence', 'supplier_agreement_evidence', 'retail_resale_evidence', 'retail_compliance_evidence', 'merchant_claim_evidence', 'relationship_evidence', 'order_item_image', 'digital_asset_file', 'feed_upload'));
--> statement-breakpoint
-- oxy:handwritten-begin=mercaria_oxy_file_reference_feed_uploads
CREATE TRIGGER mercaria_oxy_file_reference_feed_uploads
  AFTER INSERT OR DELETE OR UPDATE OF "storage_key" ON "feed_uploads"
  FOR EACH ROW EXECUTE FUNCTION mercaria_oxy_file_reference_touch('feed_upload', 'id', 'value', 'storage_key');
-- oxy:handwritten-end=mercaria_oxy_file_reference_feed_uploads
