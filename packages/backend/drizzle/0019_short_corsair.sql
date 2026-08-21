-- oxy:deploy-phase=pre
-- oxy:rollback=derived
--
-- The canonical PRODUCT layer of the commerce graph (#56, ADR 0002 D13-D16):
-- product families, products, canonical variants, their alias / source-link /
-- redirect children, the variant-defining option assignments, bundles,
-- identifiers, the typed attribute registry with its category scope, the
-- normalized attribute values, canonical images and per-field provenance.
--
-- Additive only. Nothing here touches an existing table's data or shape; the
-- three ALTERs at the end turn #118's DEFERRED canonical mapping on
-- `procurement_offers` and #55's DEFERRED `commerce_relationships.product_family_id`
-- into the real RESTRICT foreign keys the `deferredForeignKeys.ts` gate forces
-- the moment these tables exist.
--
CREATE TABLE "attribute_definition_categories" (
	"id" text PRIMARY KEY NOT NULL,
	"attribute_definition_id" text NOT NULL,
	"category_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "attribute_definitions" (
	"id" text PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"label" text NOT NULL,
	"value_type" text NOT NULL,
	"unit_family" text,
	"base_unit" text,
	"allowed_values" text[] DEFAULT '{}'::text[] NOT NULL,
	"description" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "attribute_definitions_value_type_check" CHECK ("attribute_definitions"."value_type" in ('text', 'number', 'boolean', 'enum', 'quantity')),
	CONSTRAINT "attribute_definitions_unit_family_check" CHECK ("attribute_definitions"."unit_family" in ('length', 'mass', 'volume', 'digital_storage', 'duration', 'power', 'energy', 'count')),
	CONSTRAINT "attribute_definitions_key_shape_check" CHECK ("attribute_definitions"."key" ~ '^[a-z][a-z0-9_]*$'),
	CONSTRAINT "attribute_definitions_quantity_unit_check" CHECK (("attribute_definitions"."value_type" = 'quantity') = ("attribute_definitions"."unit_family" is not null)),
	CONSTRAINT "attribute_definitions_base_unit_check" CHECK (("attribute_definitions"."unit_family" is null) = ("attribute_definitions"."base_unit" is null))
);
--> statement-breakpoint
CREATE TABLE "bundle_components" (
	"id" text PRIMARY KEY NOT NULL,
	"bundle_variant_id" text NOT NULL,
	"component_variant_id" text NOT NULL,
	"quantity" integer DEFAULT 1 NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "bundle_components_quantity_check" CHECK ("bundle_components"."quantity" > 0),
	CONSTRAINT "bundle_components_self_check" CHECK ("bundle_components"."bundle_variant_id" <> "bundle_components"."component_variant_id")
);
--> statement-breakpoint
CREATE TABLE "canonical_attribute_values" (
	"id" text PRIMARY KEY NOT NULL,
	"product_id" text,
	"variant_id" text,
	"attribute_definition_id" text,
	"attribute_key" text NOT NULL,
	"source_display_value" text NOT NULL,
	"normalized_text" text,
	"normalized_number" double precision,
	"normalized_unit" text,
	"normalized_boolean" boolean,
	"normalization_state" text NOT NULL,
	"selected" boolean DEFAULT false NOT NULL,
	"source_record_id" text NOT NULL,
	"confidence" double precision,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "canonical_attribute_values_state_check" CHECK ("canonical_attribute_values"."normalization_state" in ('normalized', 'unknown_unit', 'unparsed', 'conflicting')),
	CONSTRAINT "canonical_attribute_values_grain_check" CHECK (("canonical_attribute_values"."product_id" is not null)::int + ("canonical_attribute_values"."variant_id" is not null)::int = 1),
	CONSTRAINT "canonical_attribute_values_key_shape_check" CHECK ("canonical_attribute_values"."attribute_key" = lower(btrim("canonical_attribute_values"."attribute_key")) and "canonical_attribute_values"."attribute_key" <> ''),
	CONSTRAINT "canonical_attribute_values_parsed_check" CHECK ("canonical_attribute_values"."normalization_state" = 'normalized' or ("canonical_attribute_values"."normalized_text" is null and "canonical_attribute_values"."normalized_number" is null and "canonical_attribute_values"."normalized_unit" is null and "canonical_attribute_values"."normalized_boolean" is null)),
	CONSTRAINT "canonical_attribute_values_unit_check" CHECK ("canonical_attribute_values"."normalized_unit" is null or "canonical_attribute_values"."normalized_number" is not null),
	CONSTRAINT "canonical_attribute_values_confidence_check" CHECK ("canonical_attribute_values"."confidence" is null or ("canonical_attribute_values"."confidence" >= 0 and "canonical_attribute_values"."confidence" <= 1))
);
--> statement-breakpoint
CREATE TABLE "canonical_field_provenance" (
	"id" text PRIMARY KEY NOT NULL,
	"family_id" text,
	"product_id" text,
	"variant_id" text,
	"field" text NOT NULL,
	"source_record_id" text NOT NULL,
	"method" text NOT NULL,
	"confidence" double precision,
	"decided_by_oxy_user_id" text,
	"selected_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "canonical_field_provenance_method_check" CHECK ("canonical_field_provenance"."method" in ('deterministic_identifier', 'connector_declared', 'operator', 'heuristic')),
	CONSTRAINT "canonical_field_provenance_grain_check" CHECK (("canonical_field_provenance"."family_id" is not null)::int + ("canonical_field_provenance"."product_id" is not null)::int + ("canonical_field_provenance"."variant_id" is not null)::int = 1),
	CONSTRAINT "canonical_field_provenance_confidence_check" CHECK ("canonical_field_provenance"."confidence" is null or ("canonical_field_provenance"."confidence" >= 0 and "canonical_field_provenance"."confidence" <= 1))
);
--> statement-breakpoint
CREATE TABLE "canonical_images" (
	"id" text PRIMARY KEY NOT NULL,
	"product_id" text,
	"variant_id" text,
	"file_id" text,
	"source_url" text,
	"image_ref" text GENERATED ALWAYS AS (coalesce("file_id", "source_url")) STORED NOT NULL,
	"source_record_id" text NOT NULL,
	"alt" text,
	"locale" text,
	"position" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "canonical_images_status_check" CHECK ("canonical_images"."status" in ('active', 'suppressed')),
	CONSTRAINT "canonical_images_grain_check" CHECK (("canonical_images"."product_id" is not null)::int + ("canonical_images"."variant_id" is not null)::int = 1),
	CONSTRAINT "canonical_images_address_check" CHECK ("canonical_images"."file_id" is not null or "canonical_images"."source_url" is not null)
);
--> statement-breakpoint
CREATE TABLE "canonical_product_aliases" (
	"id" text PRIMARY KEY NOT NULL,
	"product_id" text NOT NULL,
	"alias" text NOT NULL,
	"normalized_alias" text GENERATED ALWAYS AS (lower(btrim("alias"))) STORED NOT NULL,
	"kind" text NOT NULL,
	"language" text,
	"source_record_id" text,
	"created_by_oxy_user_id" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "canonical_product_aliases_kind_check" CHECK ("canonical_product_aliases"."kind" in ('name_variant', 'former_name', 'localized_name', 'marketing_name', 'misspelling'))
);
--> statement-breakpoint
CREATE TABLE "canonical_product_families" (
	"id" text PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"normalized_name" text NOT NULL,
	"description" text,
	"brand_id" text,
	"category_id" text,
	"product_count" integer DEFAULT 0 NOT NULL,
	"merged_into_id" text,
	"status" text DEFAULT 'active' NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"last_seen_at" timestamp with time zone,
	"last_reviewed_at" timestamp with time zone,
	"pinned_fields" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"search_vector" "tsvector" GENERATED ALWAYS AS (to_tsvector('simple', "canonical_product_families"."name")) STORED,
	CONSTRAINT "canonical_product_families_status_check" CHECK ("canonical_product_families"."status" in ('draft', 'active', 'discontinued', 'merged', 'suppressed')),
	CONSTRAINT "canonical_product_families_merged_state_check" CHECK (("canonical_product_families"."status" = 'merged') = ("canonical_product_families"."merged_into_id" is not null)),
	CONSTRAINT "canonical_product_families_merged_self_check" CHECK ("canonical_product_families"."merged_into_id" is null or "canonical_product_families"."merged_into_id" <> "canonical_product_families"."id")
);
--> statement-breakpoint
CREATE TABLE "canonical_product_family_aliases" (
	"id" text PRIMARY KEY NOT NULL,
	"family_id" text NOT NULL,
	"alias" text NOT NULL,
	"normalized_alias" text GENERATED ALWAYS AS (lower(btrim("alias"))) STORED NOT NULL,
	"kind" text NOT NULL,
	"language" text,
	"source_record_id" text,
	"created_by_oxy_user_id" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "canonical_family_aliases_kind_check" CHECK ("canonical_product_family_aliases"."kind" in ('name_variant', 'former_name', 'localized_name', 'marketing_name', 'misspelling'))
);
--> statement-breakpoint
CREATE TABLE "canonical_product_family_redirects" (
	"id" text PRIMARY KEY NOT NULL,
	"from_id" text NOT NULL,
	"to_id" text NOT NULL,
	"reason" text NOT NULL,
	"actor_oxy_user_id" text,
	"note" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "canonical_family_redirects_reason_check" CHECK ("canonical_product_family_redirects"."reason" in ('merge', 'flatten')),
	CONSTRAINT "canonical_family_redirects_self_check" CHECK ("canonical_product_family_redirects"."from_id" <> "canonical_product_family_redirects"."to_id")
);
--> statement-breakpoint
CREATE TABLE "canonical_product_family_source_links" (
	"id" text PRIMARY KEY NOT NULL,
	"family_id" text NOT NULL,
	"source_record_id" text NOT NULL,
	"method" text NOT NULL,
	"match_rule" text NOT NULL,
	"confidence" double precision,
	"status" text DEFAULT 'active' NOT NULL,
	"decided_by_oxy_user_id" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "canonical_family_source_links_method_check" CHECK ("canonical_product_family_source_links"."method" in ('deterministic_identifier', 'connector_declared', 'operator', 'heuristic')),
	CONSTRAINT "canonical_family_source_links_status_check" CHECK ("canonical_product_family_source_links"."status" in ('active', 'superseded', 'rejected')),
	CONSTRAINT "canonical_family_source_links_confidence_check" CHECK ("canonical_product_family_source_links"."confidence" is null or ("canonical_product_family_source_links"."confidence" >= 0 and "canonical_product_family_source_links"."confidence" <= 1))
);
--> statement-breakpoint
CREATE TABLE "canonical_product_redirects" (
	"id" text PRIMARY KEY NOT NULL,
	"from_id" text NOT NULL,
	"to_id" text NOT NULL,
	"reason" text NOT NULL,
	"actor_oxy_user_id" text,
	"note" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "canonical_product_redirects_reason_check" CHECK ("canonical_product_redirects"."reason" in ('merge', 'flatten')),
	CONSTRAINT "canonical_product_redirects_self_check" CHECK ("canonical_product_redirects"."from_id" <> "canonical_product_redirects"."to_id")
);
--> statement-breakpoint
CREATE TABLE "canonical_product_source_links" (
	"id" text PRIMARY KEY NOT NULL,
	"product_id" text NOT NULL,
	"source_record_id" text NOT NULL,
	"method" text NOT NULL,
	"match_rule" text NOT NULL,
	"confidence" double precision,
	"status" text DEFAULT 'active' NOT NULL,
	"decided_by_oxy_user_id" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "canonical_product_source_links_method_check" CHECK ("canonical_product_source_links"."method" in ('deterministic_identifier', 'connector_declared', 'operator', 'heuristic')),
	CONSTRAINT "canonical_product_source_links_status_check" CHECK ("canonical_product_source_links"."status" in ('active', 'superseded', 'rejected')),
	CONSTRAINT "canonical_product_source_links_confidence_check" CHECK ("canonical_product_source_links"."confidence" is null or ("canonical_product_source_links"."confidence" >= 0 and "canonical_product_source_links"."confidence" <= 1))
);
--> statement-breakpoint
CREATE TABLE "canonical_products" (
	"id" text PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"normalized_name" text NOT NULL,
	"description" text,
	"brand_id" text,
	"family_id" text,
	"category_id" text,
	"released_at" timestamp with time zone,
	"discontinued_at" timestamp with time zone,
	"model_year" integer,
	"model_code" text,
	"search_tokens" text[] DEFAULT '{}'::text[] NOT NULL,
	"variant_defining_attribute_keys" text[] DEFAULT '{}'::text[] NOT NULL,
	"rating" double precision DEFAULT 0 NOT NULL,
	"rating_count" integer DEFAULT 0 NOT NULL,
	"variant_count" integer DEFAULT 0 NOT NULL,
	"merged_into_id" text,
	"status" text DEFAULT 'active' NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"last_seen_at" timestamp with time zone,
	"last_reviewed_at" timestamp with time zone,
	"pinned_fields" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"search_vector" "tsvector" GENERATED ALWAYS AS (to_tsvector('simple', "canonical_products"."name")) STORED,
	CONSTRAINT "canonical_products_status_check" CHECK ("canonical_products"."status" in ('draft', 'active', 'discontinued', 'merged', 'suppressed')),
	CONSTRAINT "canonical_products_merged_state_check" CHECK (("canonical_products"."status" = 'merged') = ("canonical_products"."merged_into_id" is not null)),
	CONSTRAINT "canonical_products_merged_self_check" CHECK ("canonical_products"."merged_into_id" is null or "canonical_products"."merged_into_id" <> "canonical_products"."id"),
	CONSTRAINT "canonical_products_model_year_check" CHECK ("canonical_products"."model_year" is null or ("canonical_products"."model_year" >= 1800 and "canonical_products"."model_year" <= 2200)),
	CONSTRAINT "canonical_products_rating_check" CHECK ("canonical_products"."rating" >= 0 and "canonical_products"."rating" <= 5 and "canonical_products"."rating_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "canonical_variant_aliases" (
	"id" text PRIMARY KEY NOT NULL,
	"variant_id" text NOT NULL,
	"alias" text NOT NULL,
	"normalized_alias" text GENERATED ALWAYS AS (lower(btrim("alias"))) STORED NOT NULL,
	"kind" text NOT NULL,
	"language" text,
	"source_record_id" text,
	"created_by_oxy_user_id" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "canonical_variant_aliases_kind_check" CHECK ("canonical_variant_aliases"."kind" in ('name_variant', 'former_name', 'localized_name', 'marketing_name', 'misspelling'))
);
--> statement-breakpoint
CREATE TABLE "canonical_variant_attributes" (
	"id" text PRIMARY KEY NOT NULL,
	"variant_id" text NOT NULL,
	"attribute_definition_id" text,
	"attribute_key" text NOT NULL,
	"display_value" text NOT NULL,
	"normalized_value" text NOT NULL,
	"normalized_number" double precision,
	"normalized_unit" text,
	"normalization_state" text DEFAULT 'normalized' NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "canonical_variant_attrs_state_check" CHECK ("canonical_variant_attributes"."normalization_state" in ('normalized', 'unknown_unit', 'unparsed', 'conflicting')),
	CONSTRAINT "canonical_variant_attrs_key_shape_check" CHECK ("canonical_variant_attributes"."attribute_key" = lower(btrim("canonical_variant_attributes"."attribute_key")) and "canonical_variant_attributes"."attribute_key" <> ''),
	CONSTRAINT "canonical_variant_attrs_parsed_check" CHECK ("canonical_variant_attributes"."normalization_state" = 'normalized' or ("canonical_variant_attributes"."normalized_number" is null and "canonical_variant_attributes"."normalized_unit" is null)),
	CONSTRAINT "canonical_variant_attrs_unit_check" CHECK ("canonical_variant_attributes"."normalized_unit" is null or "canonical_variant_attributes"."normalized_number" is not null)
);
--> statement-breakpoint
CREATE TABLE "canonical_variant_source_links" (
	"id" text PRIMARY KEY NOT NULL,
	"variant_id" text NOT NULL,
	"source_record_id" text NOT NULL,
	"method" text NOT NULL,
	"match_rule" text NOT NULL,
	"confidence" double precision,
	"status" text DEFAULT 'active' NOT NULL,
	"decided_by_oxy_user_id" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "canonical_variant_source_links_method_check" CHECK ("canonical_variant_source_links"."method" in ('deterministic_identifier', 'connector_declared', 'operator', 'heuristic')),
	CONSTRAINT "canonical_variant_source_links_status_check" CHECK ("canonical_variant_source_links"."status" in ('active', 'superseded', 'rejected')),
	CONSTRAINT "canonical_variant_source_links_confidence_check" CHECK ("canonical_variant_source_links"."confidence" is null or ("canonical_variant_source_links"."confidence" >= 0 and "canonical_variant_source_links"."confidence" <= 1))
);
--> statement-breakpoint
CREATE TABLE "canonical_variants" (
	"id" text PRIMARY KEY NOT NULL,
	"product_id" text NOT NULL,
	"name" text,
	"signature" text NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"released_at" timestamp with time zone,
	"discontinued_at" timestamp with time zone,
	"merged_into_id" text,
	"status" text DEFAULT 'active' NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"last_seen_at" timestamp with time zone,
	"last_reviewed_at" timestamp with time zone,
	"pinned_fields" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "canonical_variants_status_check" CHECK ("canonical_variants"."status" in ('draft', 'active', 'discontinued', 'merged', 'suppressed')),
	CONSTRAINT "canonical_variants_merged_state_check" CHECK (("canonical_variants"."status" = 'merged') = ("canonical_variants"."merged_into_id" is not null)),
	CONSTRAINT "canonical_variants_merged_self_check" CHECK ("canonical_variants"."merged_into_id" is null or "canonical_variants"."merged_into_id" <> "canonical_variants"."id"),
	CONSTRAINT "canonical_variants_signature_shape_check" CHECK ("canonical_variants"."signature" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "product_identifiers" (
	"id" text PRIMARY KEY NOT NULL,
	"product_id" text,
	"variant_id" text,
	"scheme" text NOT NULL,
	"raw_value" text NOT NULL,
	"normalized_value" text NOT NULL,
	"canonical_scheme" text,
	"canonical_value" text,
	"status" text DEFAULT 'active' NOT NULL,
	"conflicts_with_identifier_id" text,
	"supersedes_identifier_id" text,
	"source_record_id" text,
	"assigned_by_oxy_user_id" text,
	"note" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "product_identifiers_scheme_check" CHECK ("product_identifiers"."scheme" in ('gtin8', 'upc', 'ean', 'gtin14', 'isbn10', 'isbn13', 'mpn', 'brand_model')),
	CONSTRAINT "product_identifiers_status_check" CHECK ("product_identifiers"."status" in ('active', 'disputed', 'corrected', 'retired')),
	CONSTRAINT "product_identifiers_canonical_scheme_check" CHECK ("product_identifiers"."canonical_scheme" in ('gtin')),
	CONSTRAINT "product_identifiers_grain_check" CHECK (("product_identifiers"."product_id" is not null)::int + ("product_identifiers"."variant_id" is not null)::int = 1),
	CONSTRAINT "product_identifiers_canonical_pair_check" CHECK (("product_identifiers"."canonical_scheme" is null) = ("product_identifiers"."canonical_value" is null)),
	CONSTRAINT "product_identifiers_canonical_value_shape_check" CHECK ("product_identifiers"."canonical_value" is null or "product_identifiers"."canonical_value" ~ '^[0-9]{14}$'),
	CONSTRAINT "product_identifiers_dispute_check" CHECK (("product_identifiers"."status" = 'disputed') = ("product_identifiers"."conflicts_with_identifier_id" is not null)),
	CONSTRAINT "product_identifiers_normalized_value_check" CHECK ("product_identifiers"."normalized_value" <> '')
);
--> statement-breakpoint
ALTER TABLE "attribute_definition_categories" ADD CONSTRAINT "attribute_definition_categories_attribute_definition_id_attribute_definitions_id_fk" FOREIGN KEY ("attribute_definition_id") REFERENCES "public"."attribute_definitions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attribute_definition_categories" ADD CONSTRAINT "attribute_definition_categories_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bundle_components" ADD CONSTRAINT "bundle_components_bundle_variant_id_canonical_variants_id_fk" FOREIGN KEY ("bundle_variant_id") REFERENCES "public"."canonical_variants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bundle_components" ADD CONSTRAINT "bundle_components_component_variant_id_canonical_variants_id_fk" FOREIGN KEY ("component_variant_id") REFERENCES "public"."canonical_variants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canonical_attribute_values" ADD CONSTRAINT "canonical_attribute_values_product_id_canonical_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."canonical_products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canonical_attribute_values" ADD CONSTRAINT "canonical_attribute_values_variant_id_canonical_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."canonical_variants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canonical_attribute_values" ADD CONSTRAINT "canonical_attribute_values_attribute_definition_id_attribute_definitions_id_fk" FOREIGN KEY ("attribute_definition_id") REFERENCES "public"."attribute_definitions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canonical_attribute_values" ADD CONSTRAINT "canonical_attribute_values_source_record_id_source_records_id_fk" FOREIGN KEY ("source_record_id") REFERENCES "public"."source_records"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canonical_field_provenance" ADD CONSTRAINT "canonical_field_provenance_family_id_canonical_product_families_id_fk" FOREIGN KEY ("family_id") REFERENCES "public"."canonical_product_families"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canonical_field_provenance" ADD CONSTRAINT "canonical_field_provenance_product_id_canonical_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."canonical_products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canonical_field_provenance" ADD CONSTRAINT "canonical_field_provenance_variant_id_canonical_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."canonical_variants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canonical_field_provenance" ADD CONSTRAINT "canonical_field_provenance_source_record_id_source_records_id_fk" FOREIGN KEY ("source_record_id") REFERENCES "public"."source_records"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canonical_images" ADD CONSTRAINT "canonical_images_product_id_canonical_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."canonical_products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canonical_images" ADD CONSTRAINT "canonical_images_variant_id_canonical_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."canonical_variants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canonical_images" ADD CONSTRAINT "canonical_images_source_record_id_source_records_id_fk" FOREIGN KEY ("source_record_id") REFERENCES "public"."source_records"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canonical_product_aliases" ADD CONSTRAINT "canonical_product_aliases_product_id_canonical_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."canonical_products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canonical_product_aliases" ADD CONSTRAINT "canonical_product_aliases_source_record_id_source_records_id_fk" FOREIGN KEY ("source_record_id") REFERENCES "public"."source_records"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canonical_product_families" ADD CONSTRAINT "canonical_product_families_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canonical_product_families" ADD CONSTRAINT "canonical_product_families_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canonical_product_families" ADD CONSTRAINT "canonical_product_families_merged_into_id_canonical_product_families_id_fk" FOREIGN KEY ("merged_into_id") REFERENCES "public"."canonical_product_families"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canonical_product_family_aliases" ADD CONSTRAINT "canonical_product_family_aliases_family_id_canonical_product_families_id_fk" FOREIGN KEY ("family_id") REFERENCES "public"."canonical_product_families"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canonical_product_family_aliases" ADD CONSTRAINT "canonical_product_family_aliases_source_record_id_source_records_id_fk" FOREIGN KEY ("source_record_id") REFERENCES "public"."source_records"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canonical_product_family_redirects" ADD CONSTRAINT "canonical_product_family_redirects_from_id_canonical_product_families_id_fk" FOREIGN KEY ("from_id") REFERENCES "public"."canonical_product_families"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canonical_product_family_redirects" ADD CONSTRAINT "canonical_product_family_redirects_to_id_canonical_product_families_id_fk" FOREIGN KEY ("to_id") REFERENCES "public"."canonical_product_families"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canonical_product_family_source_links" ADD CONSTRAINT "canonical_product_family_source_links_family_id_canonical_product_families_id_fk" FOREIGN KEY ("family_id") REFERENCES "public"."canonical_product_families"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canonical_product_family_source_links" ADD CONSTRAINT "canonical_product_family_source_links_source_record_id_source_records_id_fk" FOREIGN KEY ("source_record_id") REFERENCES "public"."source_records"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canonical_product_redirects" ADD CONSTRAINT "canonical_product_redirects_from_id_canonical_products_id_fk" FOREIGN KEY ("from_id") REFERENCES "public"."canonical_products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canonical_product_redirects" ADD CONSTRAINT "canonical_product_redirects_to_id_canonical_products_id_fk" FOREIGN KEY ("to_id") REFERENCES "public"."canonical_products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canonical_product_source_links" ADD CONSTRAINT "canonical_product_source_links_product_id_canonical_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."canonical_products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canonical_product_source_links" ADD CONSTRAINT "canonical_product_source_links_source_record_id_source_records_id_fk" FOREIGN KEY ("source_record_id") REFERENCES "public"."source_records"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canonical_products" ADD CONSTRAINT "canonical_products_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canonical_products" ADD CONSTRAINT "canonical_products_family_id_canonical_product_families_id_fk" FOREIGN KEY ("family_id") REFERENCES "public"."canonical_product_families"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canonical_products" ADD CONSTRAINT "canonical_products_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canonical_products" ADD CONSTRAINT "canonical_products_merged_into_id_canonical_products_id_fk" FOREIGN KEY ("merged_into_id") REFERENCES "public"."canonical_products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canonical_variant_aliases" ADD CONSTRAINT "canonical_variant_aliases_variant_id_canonical_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."canonical_variants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canonical_variant_aliases" ADD CONSTRAINT "canonical_variant_aliases_source_record_id_source_records_id_fk" FOREIGN KEY ("source_record_id") REFERENCES "public"."source_records"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canonical_variant_attributes" ADD CONSTRAINT "canonical_variant_attributes_variant_id_canonical_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."canonical_variants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canonical_variant_attributes" ADD CONSTRAINT "canonical_variant_attributes_attribute_definition_id_attribute_definitions_id_fk" FOREIGN KEY ("attribute_definition_id") REFERENCES "public"."attribute_definitions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canonical_variant_source_links" ADD CONSTRAINT "canonical_variant_source_links_variant_id_canonical_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."canonical_variants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canonical_variant_source_links" ADD CONSTRAINT "canonical_variant_source_links_source_record_id_source_records_id_fk" FOREIGN KEY ("source_record_id") REFERENCES "public"."source_records"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canonical_variants" ADD CONSTRAINT "canonical_variants_product_id_canonical_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."canonical_products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canonical_variants" ADD CONSTRAINT "canonical_variants_merged_into_id_canonical_variants_id_fk" FOREIGN KEY ("merged_into_id") REFERENCES "public"."canonical_variants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_identifiers" ADD CONSTRAINT "product_identifiers_product_id_canonical_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."canonical_products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_identifiers" ADD CONSTRAINT "product_identifiers_variant_id_canonical_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."canonical_variants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_identifiers" ADD CONSTRAINT "product_identifiers_conflicts_with_identifier_id_product_identifiers_id_fk" FOREIGN KEY ("conflicts_with_identifier_id") REFERENCES "public"."product_identifiers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_identifiers" ADD CONSTRAINT "product_identifiers_supersedes_identifier_id_product_identifiers_id_fk" FOREIGN KEY ("supersedes_identifier_id") REFERENCES "public"."product_identifiers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_identifiers" ADD CONSTRAINT "product_identifiers_source_record_id_source_records_id_fk" FOREIGN KEY ("source_record_id") REFERENCES "public"."source_records"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "attribute_definition_categories_key" ON "attribute_definition_categories" USING btree ("attribute_definition_id","category_id");--> statement-breakpoint
CREATE INDEX "attribute_definition_categories_category_idx" ON "attribute_definition_categories" USING btree ("category_id");--> statement-breakpoint
CREATE UNIQUE INDEX "attribute_definitions_key_key" ON "attribute_definitions" USING btree ("key");--> statement-breakpoint
CREATE UNIQUE INDEX "bundle_components_pair_key" ON "bundle_components" USING btree ("bundle_variant_id","component_variant_id");--> statement-breakpoint
CREATE INDEX "bundle_components_component_idx" ON "bundle_components" USING btree ("component_variant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "canonical_attribute_values_product_key" ON "canonical_attribute_values" USING btree ("product_id","attribute_key","source_record_id") WHERE "canonical_attribute_values"."product_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "canonical_attribute_values_variant_key" ON "canonical_attribute_values" USING btree ("variant_id","attribute_key","source_record_id") WHERE "canonical_attribute_values"."variant_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "canonical_attribute_values_product_selected_key" ON "canonical_attribute_values" USING btree ("product_id","attribute_key") WHERE "canonical_attribute_values"."selected" and "canonical_attribute_values"."product_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "canonical_attribute_values_variant_selected_key" ON "canonical_attribute_values" USING btree ("variant_id","attribute_key") WHERE "canonical_attribute_values"."selected" and "canonical_attribute_values"."variant_id" is not null;--> statement-breakpoint
CREATE INDEX "canonical_attribute_values_key_idx" ON "canonical_attribute_values" USING btree ("attribute_key","normalized_text");--> statement-breakpoint
CREATE INDEX "canonical_attribute_values_record_idx" ON "canonical_attribute_values" USING btree ("source_record_id");--> statement-breakpoint
CREATE UNIQUE INDEX "canonical_field_provenance_family_key" ON "canonical_field_provenance" USING btree ("family_id","field") WHERE "canonical_field_provenance"."family_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "canonical_field_provenance_product_key" ON "canonical_field_provenance" USING btree ("product_id","field") WHERE "canonical_field_provenance"."product_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "canonical_field_provenance_variant_key" ON "canonical_field_provenance" USING btree ("variant_id","field") WHERE "canonical_field_provenance"."variant_id" is not null;--> statement-breakpoint
CREATE INDEX "canonical_field_provenance_record_idx" ON "canonical_field_provenance" USING btree ("source_record_id");--> statement-breakpoint
CREATE UNIQUE INDEX "canonical_images_product_ref_key" ON "canonical_images" USING btree ("product_id","image_ref") WHERE "canonical_images"."product_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "canonical_images_variant_ref_key" ON "canonical_images" USING btree ("variant_id","image_ref") WHERE "canonical_images"."variant_id" is not null;--> statement-breakpoint
CREATE INDEX "canonical_images_product_position_idx" ON "canonical_images" USING btree ("product_id","position");--> statement-breakpoint
CREATE INDEX "canonical_images_variant_position_idx" ON "canonical_images" USING btree ("variant_id","position");--> statement-breakpoint
CREATE INDEX "canonical_images_source_record_idx" ON "canonical_images" USING btree ("source_record_id");--> statement-breakpoint
CREATE UNIQUE INDEX "canonical_product_aliases_alias_key" ON "canonical_product_aliases" USING btree ("product_id","normalized_alias");--> statement-breakpoint
CREATE INDEX "canonical_product_aliases_alias_idx" ON "canonical_product_aliases" USING btree ("normalized_alias");--> statement-breakpoint
CREATE INDEX "canonical_product_aliases_alias_trgm_idx" ON "canonical_product_aliases" USING gin ("normalized_alias" gin_trgm_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "canonical_product_families_slug_key" ON "canonical_product_families" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "canonical_family_normalized_name_idx" ON "canonical_product_families" USING btree ("normalized_name");--> statement-breakpoint
CREATE INDEX "canonical_family_normalized_name_trgm_idx" ON "canonical_product_families" USING gin ("normalized_name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "canonical_family_brand_id_idx" ON "canonical_product_families" USING btree ("brand_id");--> statement-breakpoint
CREATE INDEX "canonical_family_search_vector_idx" ON "canonical_product_families" USING gin ("search_vector");--> statement-breakpoint
CREATE UNIQUE INDEX "canonical_family_aliases_alias_key" ON "canonical_product_family_aliases" USING btree ("family_id","normalized_alias");--> statement-breakpoint
CREATE INDEX "canonical_family_aliases_alias_idx" ON "canonical_product_family_aliases" USING btree ("normalized_alias");--> statement-breakpoint
CREATE INDEX "canonical_family_aliases_alias_trgm_idx" ON "canonical_product_family_aliases" USING gin ("normalized_alias" gin_trgm_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "canonical_family_redirects_from_to_key" ON "canonical_product_family_redirects" USING btree ("from_id","to_id");--> statement-breakpoint
CREATE INDEX "canonical_family_redirects_from_idx" ON "canonical_product_family_redirects" USING btree ("from_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "canonical_family_source_links_active_key" ON "canonical_product_family_source_links" USING btree ("family_id","source_record_id") WHERE "canonical_product_family_source_links"."status" = 'active';--> statement-breakpoint
CREATE INDEX "canonical_family_source_links_record_idx" ON "canonical_product_family_source_links" USING btree ("source_record_id");--> statement-breakpoint
CREATE UNIQUE INDEX "canonical_product_redirects_from_to_key" ON "canonical_product_redirects" USING btree ("from_id","to_id");--> statement-breakpoint
CREATE INDEX "canonical_product_redirects_from_idx" ON "canonical_product_redirects" USING btree ("from_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "canonical_product_source_links_active_key" ON "canonical_product_source_links" USING btree ("product_id","source_record_id") WHERE "canonical_product_source_links"."status" = 'active';--> statement-breakpoint
CREATE INDEX "canonical_product_source_links_record_idx" ON "canonical_product_source_links" USING btree ("source_record_id");--> statement-breakpoint
CREATE UNIQUE INDEX "canonical_products_slug_key" ON "canonical_products" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "canonical_products_normalized_name_idx" ON "canonical_products" USING btree ("normalized_name");--> statement-breakpoint
CREATE INDEX "canonical_products_normalized_name_trgm_idx" ON "canonical_products" USING gin ("normalized_name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "canonical_products_brand_id_idx" ON "canonical_products" USING btree ("brand_id");--> statement-breakpoint
CREATE INDEX "canonical_products_family_id_idx" ON "canonical_products" USING btree ("family_id");--> statement-breakpoint
CREATE INDEX "canonical_products_category_id_idx" ON "canonical_products" USING btree ("category_id");--> statement-breakpoint
CREATE INDEX "canonical_products_search_tokens_idx" ON "canonical_products" USING gin ("search_tokens");--> statement-breakpoint
CREATE INDEX "canonical_products_search_vector_idx" ON "canonical_products" USING gin ("search_vector");--> statement-breakpoint
CREATE INDEX "canonical_products_status_created_at_idx" ON "canonical_products" USING btree ("status","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "canonical_variant_aliases_alias_key" ON "canonical_variant_aliases" USING btree ("variant_id","normalized_alias");--> statement-breakpoint
CREATE INDEX "canonical_variant_aliases_alias_idx" ON "canonical_variant_aliases" USING btree ("normalized_alias");--> statement-breakpoint
CREATE INDEX "canonical_variant_aliases_alias_trgm_idx" ON "canonical_variant_aliases" USING gin ("normalized_alias" gin_trgm_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "canonical_variant_attrs_key_unique" ON "canonical_variant_attributes" USING btree ("variant_id","attribute_key");--> statement-breakpoint
CREATE INDEX "canonical_variant_attrs_value_idx" ON "canonical_variant_attributes" USING btree ("attribute_key","normalized_value");--> statement-breakpoint
CREATE UNIQUE INDEX "canonical_variant_source_links_active_key" ON "canonical_variant_source_links" USING btree ("variant_id","source_record_id") WHERE "canonical_variant_source_links"."status" = 'active';--> statement-breakpoint
CREATE INDEX "canonical_variant_source_links_record_idx" ON "canonical_variant_source_links" USING btree ("source_record_id");--> statement-breakpoint
CREATE UNIQUE INDEX "canonical_variants_product_signature_key" ON "canonical_variants" USING btree ("product_id","signature");--> statement-breakpoint
CREATE UNIQUE INDEX "canonical_variants_product_default_key" ON "canonical_variants" USING btree ("product_id") WHERE "canonical_variants"."is_default";--> statement-breakpoint
CREATE INDEX "canonical_variants_product_id_idx" ON "canonical_variants" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "canonical_variants_status_idx" ON "canonical_variants" USING btree ("status","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "product_identifiers_canonical_active_key" ON "product_identifiers" USING btree ("canonical_scheme","canonical_value") WHERE "product_identifiers"."status" = 'active' and "product_identifiers"."canonical_value" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "product_identifiers_variant_active_key" ON "product_identifiers" USING btree ("variant_id","scheme","normalized_value") WHERE "product_identifiers"."status" = 'active' and "product_identifiers"."variant_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "product_identifiers_product_active_key" ON "product_identifiers" USING btree ("product_id","scheme","normalized_value") WHERE "product_identifiers"."status" = 'active' and "product_identifiers"."product_id" is not null;--> statement-breakpoint
CREATE INDEX "product_identifiers_scheme_value_idx" ON "product_identifiers" USING btree ("scheme","normalized_value");--> statement-breakpoint
CREATE INDEX "product_identifiers_canonical_value_idx" ON "product_identifiers" USING btree ("canonical_value");--> statement-breakpoint
CREATE INDEX "product_identifiers_variant_id_idx" ON "product_identifiers" USING btree ("variant_id");--> statement-breakpoint
CREATE INDEX "product_identifiers_product_id_idx" ON "product_identifiers" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "product_identifiers_source_record_idx" ON "product_identifiers" USING btree ("source_record_id");--> statement-breakpoint
ALTER TABLE "commerce_relationships" ADD CONSTRAINT "commerce_relationships_product_family_id_canonical_product_families_id_fk" FOREIGN KEY ("product_family_id") REFERENCES "public"."canonical_product_families"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "procurement_offers" ADD CONSTRAINT "procurement_offers_canonical_product_id_canonical_products_id_fk" FOREIGN KEY ("canonical_product_id") REFERENCES "public"."canonical_products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "procurement_offers" ADD CONSTRAINT "procurement_offers_canonical_variant_id_canonical_variants_id_fk" FOREIGN KEY ("canonical_variant_id") REFERENCES "public"."canonical_variants"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
-- ## Identifier values are immutable, enforced where it cannot be bypassed
--
-- ADR 0002 D14: "Corrections append, never edit -- `raw_value`/`canonical_value`
-- are immutable after insert." `services/canonical/product-identifier.service.ts`
-- is the only writer that honours that, and it protects only callers who go
-- through it: a backfill script, an operator at a `psql` prompt and #58's
-- matcher all reach this table directly.
--
-- The property at stake is not tidiness. `raw_value` is the only record of what
-- a source actually said, so an in-place edit destroys the evidence a dispute is
-- reviewed from; and `canonical_value` sits inside the one-active-owner partial
-- unique, so editing it silently moves ownership of a GTIN from one variant to
-- another without any row recording that it moved.
--
-- The `purchase_order_lines` shape (0014): BEFORE, SQLSTATE 23514, a message
-- that says what to do instead. Two kinds of UPDATE stay permitted, and both
-- are deliberate: STATUS transitions, because retiring, correcting and
-- disputing a row is exactly how a correction is recorded; and OWNER changes
-- (`product_id` / `variant_id`), because ADR 0002 D16's merge repoints the
-- loser's identifiers onto the winner, and an identifier that could not change
-- owner would make a merge either destroy history or fail.
CREATE FUNCTION mercaria_product_identifiers_values_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.raw_value IS DISTINCT FROM OLD.raw_value
     OR NEW.normalized_value IS DISTINCT FROM OLD.normalized_value
     OR NEW.canonical_scheme IS DISTINCT FROM OLD.canonical_scheme
     OR NEW.canonical_value IS DISTINCT FROM OLD.canonical_value
     OR NEW.scheme IS DISTINCT FROM OLD.scheme
  THEN
    RAISE EXCEPTION
      'product_identifiers values are immutable: change the value or scheme by '
      'retiring this row (status = corrected) and inserting a new one that names '
      'it through supersedes_identifier_id.'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER product_identifiers_values_immutable
  BEFORE UPDATE ON "product_identifiers"
  FOR EACH ROW EXECUTE FUNCTION mercaria_product_identifiers_values_immutable();
