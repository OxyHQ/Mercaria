-- oxy:deploy-phase=pre
-- oxy:rollback=derived
CREATE TABLE "commerce_relationships" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"organization_id" text,
	"brand_id" text,
	"merchant_id" text,
	"product_family_id" text,
	"related_brand_id" text,
	"territories" text[] DEFAULT '{}'::text[] NOT NULL,
	"languages" text[] DEFAULT '{}'::text[] NOT NULL,
	"storefront_id" text,
	"valid_from" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"valid_to" timestamp with time zone,
	"status" text DEFAULT 'candidate' NOT NULL,
	"verification_method" text,
	"confidence" double precision,
	"asserted_by_kind" text NOT NULL,
	"asserted_by_source_id" text,
	"created_by_oxy_user_id" text,
	"review_round" integer DEFAULT 0 NOT NULL,
	"verified_at" timestamp with time zone,
	"verified_by_oxy_user_id" text,
	"last_checked_at" timestamp with time zone,
	"rejected_at" timestamp with time zone,
	"expired_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_by_oxy_user_id" text,
	"revoke_reason" text,
	"superseded_by_id" text,
	"note" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"endpoint_key" text GENERATED ALWAYS AS (coalesce("organization_id", '') || '|' || coalesce("brand_id", '') || '|' ||
            coalesce("merchant_id", '') || '|' || coalesce("product_family_id", '') || '|' ||
            coalesce("related_brand_id", '') || '|' || coalesce("storefront_id", '')) STORED NOT NULL,
	CONSTRAINT "commerce_relationships_kind_check" CHECK ("commerce_relationships"."kind" in ('organization_owns_brand', 'organization_operates_merchant', 'organization_manufactures', 'merchant_official_channel_for_brand', 'merchant_authorized_reseller_for_brand', 'brand_succeeds_brand')),
	CONSTRAINT "commerce_relationships_status_check" CHECK ("commerce_relationships"."status" in ('candidate', 'pending_review', 'verified', 'rejected', 'expired', 'revoked')),
	CONSTRAINT "commerce_relationships_verification_method_check" CHECK ("commerce_relationships"."verification_method" in ('operator_review', 'domain_control', 'platform_verification', 'legal_register', 'brand_statement')),
	CONSTRAINT "commerce_relationships_asserted_by_kind_check" CHECK ("commerce_relationships"."asserted_by_kind" in ('ingestion_source', 'merchant_self_claim', 'platform_verification', 'catalog_operator')),
	CONSTRAINT "commerce_relationships_endpoints_check" CHECK (case "commerce_relationships"."kind"
        when 'organization_owns_brand' then
          "commerce_relationships"."organization_id" is not null and "commerce_relationships"."brand_id" is not null
          and "commerce_relationships"."merchant_id" is null and "commerce_relationships"."product_family_id" is null and "commerce_relationships"."related_brand_id" is null
        when 'organization_operates_merchant' then
          "commerce_relationships"."organization_id" is not null and "commerce_relationships"."merchant_id" is not null
          and "commerce_relationships"."brand_id" is null and "commerce_relationships"."product_family_id" is null and "commerce_relationships"."related_brand_id" is null
        when 'organization_manufactures' then
          "commerce_relationships"."organization_id" is not null and "commerce_relationships"."product_family_id" is not null
          and "commerce_relationships"."brand_id" is null and "commerce_relationships"."merchant_id" is null and "commerce_relationships"."related_brand_id" is null
        when 'merchant_official_channel_for_brand' then
          "commerce_relationships"."merchant_id" is not null and "commerce_relationships"."brand_id" is not null
          and "commerce_relationships"."organization_id" is null and "commerce_relationships"."product_family_id" is null and "commerce_relationships"."related_brand_id" is null
        when 'merchant_authorized_reseller_for_brand' then
          "commerce_relationships"."merchant_id" is not null and "commerce_relationships"."brand_id" is not null
          and "commerce_relationships"."organization_id" is null and "commerce_relationships"."product_family_id" is null and "commerce_relationships"."related_brand_id" is null
        when 'brand_succeeds_brand' then
          "commerce_relationships"."brand_id" is not null and "commerce_relationships"."related_brand_id" is not null
          and "commerce_relationships"."organization_id" is null and "commerce_relationships"."merchant_id" is null and "commerce_relationships"."product_family_id" is null
        else false
      end),
	CONSTRAINT "commerce_relationships_distinct_brands_check" CHECK ("commerce_relationships"."related_brand_id" is null or "commerce_relationships"."related_brand_id" <> "commerce_relationships"."brand_id"),
	CONSTRAINT "commerce_relationships_supersedes_other_check" CHECK ("commerce_relationships"."superseded_by_id" is null or "commerce_relationships"."superseded_by_id" <> "commerce_relationships"."id"),
	CONSTRAINT "commerce_relationships_storefront_scope_check" CHECK ("commerce_relationships"."storefront_id" is null or "commerce_relationships"."kind" in (
        'organization_operates_merchant',
        'merchant_official_channel_for_brand',
        'merchant_authorized_reseller_for_brand'
      )),
	CONSTRAINT "commerce_relationships_verified_state_check" CHECK ("commerce_relationships"."status" <> 'verified' or ("commerce_relationships"."verification_method" is not null and "commerce_relationships"."verified_at" is not null and "commerce_relationships"."verified_by_oxy_user_id" is not null)),
	CONSTRAINT "commerce_relationships_confidence_range_check" CHECK ("commerce_relationships"."confidence" is null or ("commerce_relationships"."confidence" >= 0 and "commerce_relationships"."confidence" <= 1)),
	CONSTRAINT "commerce_relationships_confidence_machine_check" CHECK ("commerce_relationships"."confidence" is null or "commerce_relationships"."asserted_by_kind" = 'ingestion_source'),
	CONSTRAINT "commerce_relationships_source_presence_check" CHECK (("commerce_relationships"."asserted_by_kind" = 'ingestion_source') = ("commerce_relationships"."asserted_by_source_id" is not null)),
	CONSTRAINT "commerce_relationships_validity_order_check" CHECK ("commerce_relationships"."valid_to" is null or "commerce_relationships"."valid_to" > "commerce_relationships"."valid_from"),
	CONSTRAINT "commerce_relationships_expired_state_check" CHECK ("commerce_relationships"."status" <> 'expired' or ("commerce_relationships"."expired_at" is not null and "commerce_relationships"."valid_to" is not null)),
	CONSTRAINT "commerce_relationships_revoked_state_check" CHECK ("commerce_relationships"."status" <> 'revoked' or ("commerce_relationships"."revoked_at" is not null and "commerce_relationships"."revoked_by_oxy_user_id" is not null and "commerce_relationships"."valid_to" is not null)),
	CONSTRAINT "commerce_relationships_rejected_state_check" CHECK ("commerce_relationships"."status" <> 'rejected' or "commerce_relationships"."rejected_at" is not null),
	CONSTRAINT "commerce_relationships_territories_shape_check" CHECK (mercaria_immutable_array_to_string("commerce_relationships"."territories", ',') ~ '^([A-Z]{2}(,[A-Z]{2})*)?$'),
	CONSTRAINT "commerce_relationships_languages_shape_check" CHECK (mercaria_immutable_array_to_string("commerce_relationships"."languages", ',') ~ '^([a-z]{2,3}(-[A-Za-z0-9]{2,8})*(,[a-z]{2,3}(-[A-Za-z0-9]{2,8})*)*)?$'),
	CONSTRAINT "commerce_relationships_review_round_check" CHECK ("commerce_relationships"."review_round" >= 0)
);
--> statement-breakpoint
CREATE TABLE "relationship_evidence" (
	"id" text PRIMARY KEY NOT NULL,
	"relationship_id" text NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"observed_fact" text NOT NULL,
	"subject_domain" text,
	"source_url" text,
	"oxy_file_id" text,
	"content_sha256" text,
	"source_record_id" text,
	"locale" text,
	"observed_at" timestamp with time zone NOT NULL,
	"collected_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"collected_by_oxy_user_id" text,
	"reviewer_note" text,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_by_oxy_user_id" text,
	"revoke_reason" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "relationship_evidence_kind_check" CHECK ("relationship_evidence"."kind" in ('domain_control', 'platform_verification', 'legal_register', 'brand_statement', 'operator_attestation', 'source_document')),
	CONSTRAINT "relationship_evidence_status_check" CHECK ("relationship_evidence"."status" in ('active', 'expired', 'revoked')),
	CONSTRAINT "relationship_evidence_brand_statement_check" CHECK ("relationship_evidence"."kind" <> 'brand_statement' or ("relationship_evidence"."source_url" is not null and "relationship_evidence"."content_sha256" is not null)),
	CONSTRAINT "relationship_evidence_domain_subject_check" CHECK (("relationship_evidence"."kind" = 'domain_control') = ("relationship_evidence"."subject_domain" is not null)),
	CONSTRAINT "relationship_evidence_domain_normalized_check" CHECK ("relationship_evidence"."subject_domain" is null or "relationship_evidence"."subject_domain" = lower(btrim("relationship_evidence"."subject_domain"))),
	CONSTRAINT "relationship_evidence_sha256_shape_check" CHECK ("relationship_evidence"."content_sha256" is null or "relationship_evidence"."content_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "relationship_evidence_locator_check" CHECK ("relationship_evidence"."kind" = 'operator_attestation'
        or "relationship_evidence"."source_url" is not null
        or "relationship_evidence"."oxy_file_id" is not null
        or "relationship_evidence"."source_record_id" is not null
        or "relationship_evidence"."subject_domain" is not null),
	CONSTRAINT "relationship_evidence_revoked_state_check" CHECK ("relationship_evidence"."status" <> 'revoked' or ("relationship_evidence"."revoked_at" is not null and "relationship_evidence"."revoked_by_oxy_user_id" is not null)),
	CONSTRAINT "relationship_evidence_expired_state_check" CHECK ("relationship_evidence"."status" <> 'expired' or "relationship_evidence"."expires_at" is not null),
	CONSTRAINT "relationship_evidence_observed_fact_check" CHECK (btrim("relationship_evidence"."observed_fact") <> '')
);
--> statement-breakpoint
CREATE TABLE "relationship_reviews" (
	"id" text PRIMARY KEY NOT NULL,
	"relationship_id" text NOT NULL,
	"action" text NOT NULL,
	"actor_oxy_user_id" text NOT NULL,
	"reason" text NOT NULL,
	"review_round" integer NOT NULL,
	"from_status" text NOT NULL,
	"to_status" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "relationship_reviews_action_check" CHECK ("relationship_reviews"."action" in ('approve', 'reject', 'request_more_evidence', 'expire', 'revoke', 'correct')),
	CONSTRAINT "relationship_reviews_from_status_check" CHECK ("relationship_reviews"."from_status" in ('candidate', 'pending_review', 'verified', 'rejected', 'expired', 'revoked')),
	CONSTRAINT "relationship_reviews_to_status_check" CHECK ("relationship_reviews"."to_status" in ('candidate', 'pending_review', 'verified', 'rejected', 'expired', 'revoked')),
	CONSTRAINT "relationship_reviews_reason_check" CHECK (btrim("relationship_reviews"."reason") <> ''),
	CONSTRAINT "relationship_reviews_actor_check" CHECK (btrim("relationship_reviews"."actor_oxy_user_id") <> ''),
	CONSTRAINT "relationship_reviews_review_round_check" CHECK ("relationship_reviews"."review_round" >= 0)
);
--> statement-breakpoint
ALTER TABLE "commerce_relationships" ADD CONSTRAINT "commerce_relationships_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_relationships" ADD CONSTRAINT "commerce_relationships_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_relationships" ADD CONSTRAINT "commerce_relationships_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_relationships" ADD CONSTRAINT "commerce_relationships_related_brand_id_brands_id_fk" FOREIGN KEY ("related_brand_id") REFERENCES "public"."brands"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_relationships" ADD CONSTRAINT "commerce_relationships_storefront_id_storefronts_id_fk" FOREIGN KEY ("storefront_id") REFERENCES "public"."storefronts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_relationships" ADD CONSTRAINT "commerce_relationships_asserted_by_source_id_catalog_sources_id_fk" FOREIGN KEY ("asserted_by_source_id") REFERENCES "public"."catalog_sources"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_relationships" ADD CONSTRAINT "commerce_relationships_superseded_by_id_commerce_relationships_id_fk" FOREIGN KEY ("superseded_by_id") REFERENCES "public"."commerce_relationships"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relationship_evidence" ADD CONSTRAINT "relationship_evidence_relationship_id_commerce_relationships_id_fk" FOREIGN KEY ("relationship_id") REFERENCES "public"."commerce_relationships"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relationship_evidence" ADD CONSTRAINT "relationship_evidence_source_record_id_source_records_id_fk" FOREIGN KEY ("source_record_id") REFERENCES "public"."source_records"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relationship_reviews" ADD CONSTRAINT "relationship_reviews_relationship_id_commerce_relationships_id_fk" FOREIGN KEY ("relationship_id") REFERENCES "public"."commerce_relationships"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "commerce_relationships_open_claim_key" ON "commerce_relationships" USING btree ("kind","endpoint_key") WHERE "commerce_relationships"."valid_to" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "commerce_relationships_verified_brand_owner_key" ON "commerce_relationships" USING btree ("brand_id") WHERE "commerce_relationships"."kind" = 'organization_owns_brand' and "commerce_relationships"."status" = 'verified' and "commerce_relationships"."valid_to" is null;--> statement-breakpoint
CREATE INDEX "commerce_relationships_brand_idx" ON "commerce_relationships" USING btree ("brand_id","kind","status");--> statement-breakpoint
CREATE INDEX "commerce_relationships_merchant_idx" ON "commerce_relationships" USING btree ("merchant_id","kind","status");--> statement-breakpoint
CREATE INDEX "commerce_relationships_organization_idx" ON "commerce_relationships" USING btree ("organization_id","kind","status");--> statement-breakpoint
CREATE INDEX "commerce_relationships_product_family_idx" ON "commerce_relationships" USING btree ("product_family_id","kind","status");--> statement-breakpoint
CREATE INDEX "commerce_relationships_review_queue_idx" ON "commerce_relationships" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "relationship_evidence_relationship_idx" ON "relationship_evidence" USING btree ("relationship_id","status");--> statement-breakpoint
CREATE INDEX "relationship_evidence_source_record_idx" ON "relationship_evidence" USING btree ("source_record_id") WHERE "relationship_evidence"."source_record_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "relationship_reviews_approval_key" ON "relationship_reviews" USING btree ("relationship_id","review_round","actor_oxy_user_id") WHERE "relationship_reviews"."action" = 'approve';--> statement-breakpoint
CREATE INDEX "relationship_reviews_relationship_idx" ON "relationship_reviews" USING btree ("relationship_id","created_at");
--> statement-breakpoint
CREATE FUNCTION mercaria_relationship_review_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'relationship reviews are append-only: % on %.% is refused. A correction is a NEW review row, never an edit to the record of what was decided.',
    TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME
    USING ERRCODE = 'check_violation';
END;
$$;--> statement-breakpoint
CREATE TRIGGER relationship_reviews_append_only
  BEFORE UPDATE OR DELETE ON "relationship_reviews"
  FOR EACH ROW EXECUTE FUNCTION mercaria_relationship_review_append_only();
