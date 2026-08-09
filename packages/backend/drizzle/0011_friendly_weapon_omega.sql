-- oxy:deploy-phase=pre
CREATE TABLE "catalog_sources" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"connection_id" text,
	"may_display" boolean NOT NULL,
	"may_store" boolean NOT NULL,
	"attribution_required" boolean NOT NULL,
	"rights_note" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "catalog_sources_kind_check" CHECK ("catalog_sources"."kind" in ('connector', 'feed', 'marketplace_api', 'affiliate_network', 'operator', 'backfill'))
);
--> statement-breakpoint
CREATE TABLE "source_records" (
	"id" text PRIMARY KEY NOT NULL,
	"source_id" text NOT NULL,
	"external_type" text NOT NULL,
	"external_id" text NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"stale_at" timestamp with time zone,
	"content_hash" text NOT NULL,
	"payload" jsonb,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "source_records_external_type_check" CHECK ("source_records"."external_type" in ('product', 'offer', 'merchant', 'brand', 'category', 'relationship')),
	CONSTRAINT "source_records_content_hash_shape_check" CHECK ("source_records"."content_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "brand_aliases" (
	"id" text PRIMARY KEY NOT NULL,
	"brand_id" text NOT NULL,
	"alias" text NOT NULL,
	"normalized_alias" text GENERATED ALWAYS AS (lower(btrim("alias"))) STORED NOT NULL,
	"kind" text NOT NULL,
	"language" text,
	"source_record_id" text,
	"created_by_oxy_user_id" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "brand_aliases_kind_check" CHECK ("brand_aliases"."kind" in ('name_variant', 'former_name', 'localized_name', 'marketing_name', 'misspelling'))
);
--> statement-breakpoint
CREATE TABLE "brand_source_links" (
	"id" text PRIMARY KEY NOT NULL,
	"brand_id" text NOT NULL,
	"source_record_id" text NOT NULL,
	"method" text NOT NULL,
	"match_rule" text NOT NULL,
	"confidence" double precision,
	"status" text DEFAULT 'active' NOT NULL,
	"decided_by_oxy_user_id" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "brand_source_links_method_check" CHECK ("brand_source_links"."method" in ('deterministic_identifier', 'connector_declared', 'operator', 'heuristic')),
	CONSTRAINT "brand_source_links_status_check" CHECK ("brand_source_links"."status" in ('active', 'superseded', 'rejected')),
	CONSTRAINT "brand_source_links_confidence_range_check" CHECK ("brand_source_links"."confidence" is null or ("brand_source_links"."confidence" >= 0 and "brand_source_links"."confidence" <= 1))
);
--> statement-breakpoint
CREATE TABLE "brands" (
	"id" text PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"normalized_name" text NOT NULL,
	"description" text,
	"website_url" text,
	"observed_domains" text[] DEFAULT '{}'::text[] NOT NULL,
	"logo_file_id" text,
	"logo_source_record_id" text,
	"product_count" integer DEFAULT 0 NOT NULL,
	"active_offer_count" integer DEFAULT 0 NOT NULL,
	"merged_into_id" text,
	"status" text DEFAULT 'active' NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"last_seen_at" timestamp with time zone,
	"last_reviewed_at" timestamp with time zone,
	"pinned_fields" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"search_vector" "tsvector" GENERATED ALWAYS AS (to_tsvector('simple', coalesce("brands"."name", ''))) STORED,
	CONSTRAINT "brands_status_check" CHECK ("brands"."status" in ('active', 'inactive', 'merged', 'suppressed')),
	CONSTRAINT "brands_merged_state_check" CHECK (("brands"."status" = 'merged') = ("brands"."merged_into_id" is not null)),
	CONSTRAINT "brands_merged_into_self_check" CHECK ("brands"."merged_into_id" is null or "brands"."merged_into_id" <> "brands"."id")
);
--> statement-breakpoint
CREATE TABLE "organization_aliases" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"alias" text NOT NULL,
	"normalized_alias" text GENERATED ALWAYS AS (lower(btrim("alias"))) STORED NOT NULL,
	"kind" text NOT NULL,
	"language" text,
	"source_record_id" text,
	"created_by_oxy_user_id" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "organization_aliases_kind_check" CHECK ("organization_aliases"."kind" in ('name_variant', 'former_name', 'localized_name', 'marketing_name', 'misspelling'))
);
--> statement-breakpoint
CREATE TABLE "organization_source_links" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"source_record_id" text NOT NULL,
	"method" text NOT NULL,
	"match_rule" text NOT NULL,
	"confidence" double precision,
	"status" text DEFAULT 'active' NOT NULL,
	"decided_by_oxy_user_id" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "organization_source_links_method_check" CHECK ("organization_source_links"."method" in ('deterministic_identifier', 'connector_declared', 'operator', 'heuristic')),
	CONSTRAINT "organization_source_links_status_check" CHECK ("organization_source_links"."status" in ('active', 'superseded', 'rejected')),
	CONSTRAINT "organization_source_links_confidence_range_check" CHECK ("organization_source_links"."confidence" is null or ("organization_source_links"."confidence" >= 0 and "organization_source_links"."confidence" <= 1))
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" text PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"normalized_name" text NOT NULL,
	"legal_name" text,
	"website_url" text,
	"verified_domains" text[] DEFAULT '{}'::text[] NOT NULL,
	"country_code" text,
	"logo_file_id" text,
	"logo_source_record_id" text,
	"merged_into_id" text,
	"status" text DEFAULT 'active' NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"last_seen_at" timestamp with time zone,
	"last_reviewed_at" timestamp with time zone,
	"pinned_fields" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"search_vector" "tsvector" GENERATED ALWAYS AS (to_tsvector('simple', coalesce("organizations"."name", ''))) STORED,
	CONSTRAINT "organizations_status_check" CHECK ("organizations"."status" in ('active', 'inactive', 'merged', 'suppressed')),
	CONSTRAINT "organizations_merged_state_check" CHECK (("organizations"."status" = 'merged') = ("organizations"."merged_into_id" is not null)),
	CONSTRAINT "organizations_merged_into_self_check" CHECK ("organizations"."merged_into_id" is null or "organizations"."merged_into_id" <> "organizations"."id"),
	CONSTRAINT "organizations_country_code_check" CHECK ("organizations"."country_code" is null or "organizations"."country_code" ~ '^[A-Z]{2}$')
);
--> statement-breakpoint
ALTER TABLE "catalog_sources" ADD CONSTRAINT "catalog_sources_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_records" ADD CONSTRAINT "source_records_source_id_catalog_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."catalog_sources"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brand_aliases" ADD CONSTRAINT "brand_aliases_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brand_aliases" ADD CONSTRAINT "brand_aliases_source_record_id_source_records_id_fk" FOREIGN KEY ("source_record_id") REFERENCES "public"."source_records"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brand_source_links" ADD CONSTRAINT "brand_source_links_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brand_source_links" ADD CONSTRAINT "brand_source_links_source_record_id_source_records_id_fk" FOREIGN KEY ("source_record_id") REFERENCES "public"."source_records"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brands" ADD CONSTRAINT "brands_logo_source_record_id_source_records_id_fk" FOREIGN KEY ("logo_source_record_id") REFERENCES "public"."source_records"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brands" ADD CONSTRAINT "brands_merged_into_id_brands_id_fk" FOREIGN KEY ("merged_into_id") REFERENCES "public"."brands"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_aliases" ADD CONSTRAINT "organization_aliases_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_aliases" ADD CONSTRAINT "organization_aliases_source_record_id_source_records_id_fk" FOREIGN KEY ("source_record_id") REFERENCES "public"."source_records"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_source_links" ADD CONSTRAINT "organization_source_links_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_source_links" ADD CONSTRAINT "organization_source_links_source_record_id_source_records_id_fk" FOREIGN KEY ("source_record_id") REFERENCES "public"."source_records"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_logo_source_record_id_source_records_id_fk" FOREIGN KEY ("logo_source_record_id") REFERENCES "public"."source_records"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_merged_into_id_organizations_id_fk" FOREIGN KEY ("merged_into_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "catalog_sources_name_key" ON "catalog_sources" USING btree ("name");--> statement-breakpoint
CREATE UNIQUE INDEX "source_records_identity_key" ON "source_records" USING btree ("source_id","external_type","external_id","content_hash");--> statement-breakpoint
CREATE INDEX "source_records_source_object_observed_at_idx" ON "source_records" USING btree ("source_id","external_type","external_id","observed_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "brand_aliases_brand_id_normalized_alias_key" ON "brand_aliases" USING btree ("brand_id","normalized_alias");--> statement-breakpoint
CREATE INDEX "brand_aliases_normalized_alias_idx" ON "brand_aliases" USING btree ("normalized_alias");--> statement-breakpoint
CREATE INDEX "brand_aliases_normalized_alias_trgm_idx" ON "brand_aliases" USING gin ("normalized_alias" gin_trgm_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "brand_source_links_active_key" ON "brand_source_links" USING btree ("brand_id","source_record_id") WHERE "brand_source_links"."status" = 'active';--> statement-breakpoint
CREATE INDEX "brand_source_links_source_record_id_idx" ON "brand_source_links" USING btree ("source_record_id");--> statement-breakpoint
CREATE UNIQUE INDEX "brands_slug_key" ON "brands" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "brands_normalized_name_idx" ON "brands" USING btree ("normalized_name");--> statement-breakpoint
CREATE INDEX "brands_normalized_name_trgm_idx" ON "brands" USING gin ("normalized_name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "brands_observed_domains_idx" ON "brands" USING gin ("observed_domains");--> statement-breakpoint
CREATE INDEX "brands_search_vector_idx" ON "brands" USING gin ("search_vector");--> statement-breakpoint
CREATE UNIQUE INDEX "organization_aliases_organization_id_normalized_alias_key" ON "organization_aliases" USING btree ("organization_id","normalized_alias");--> statement-breakpoint
CREATE INDEX "organization_aliases_normalized_alias_idx" ON "organization_aliases" USING btree ("normalized_alias");--> statement-breakpoint
CREATE INDEX "organization_aliases_normalized_alias_trgm_idx" ON "organization_aliases" USING gin ("normalized_alias" gin_trgm_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "organization_source_links_active_key" ON "organization_source_links" USING btree ("organization_id","source_record_id") WHERE "organization_source_links"."status" = 'active';--> statement-breakpoint
CREATE INDEX "organization_source_links_source_record_id_idx" ON "organization_source_links" USING btree ("source_record_id");--> statement-breakpoint
CREATE UNIQUE INDEX "organizations_slug_key" ON "organizations" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "organizations_normalized_name_idx" ON "organizations" USING btree ("normalized_name");--> statement-breakpoint
CREATE INDEX "organizations_normalized_name_trgm_idx" ON "organizations" USING gin ("normalized_name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "organizations_verified_domains_idx" ON "organizations" USING gin ("verified_domains");--> statement-breakpoint
CREATE INDEX "organizations_search_vector_idx" ON "organizations" USING gin ("search_vector");