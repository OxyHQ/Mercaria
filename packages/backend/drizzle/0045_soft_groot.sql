-- oxy:deploy-phase=pre
--
-- #63 — the universal product-feed importer: seven new tables and no change to
-- any existing one. Purely additive, so it is safe against the image still
-- serving while it applies, which is what makes it a `pre` migration.
--
-- THREE hand-written trigger pairs follow the generated statements. A regeneration
-- DROPS them (drizzle-kit cannot model a trigger), so if this file is ever
-- regenerated after a rebase, re-apply the block below the
-- `-- oxy:hand-written` marker verbatim and verify by grepping for all three
-- function names, for three `CREATE TRIGGER` statements, and for exactly one
-- deploy-phase marker line at the top of the file.
CREATE TABLE "feed_configuration_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"configuration_id" text NOT NULL,
	"version" integer NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"fetch_mode" text NOT NULL,
	"feed_url" text,
	"upload_id" text,
	"format" text NOT NULL,
	"delimiter" text,
	"quote_char" text,
	"encoding" text DEFAULT 'utf-8' NOT NULL,
	"compression" text DEFAULT 'none' NOT NULL,
	"record_path" text,
	"has_header_row" boolean DEFAULT false NOT NULL,
	"list_separator" text DEFAULT ',' NOT NULL,
	"default_currency" text,
	"default_country" text,
	"default_language" text,
	"delivery_mode" text DEFAULT 'delta' NOT NULL,
	"auth_kind" text DEFAULT 'none' NOT NULL,
	"auth_ciphertext" text,
	"auth_param_name" text,
	"validated_report_id" text,
	"activated_at" timestamp with time zone,
	"activated_by_oxy_user_id" text,
	"superseded_at" timestamp with time zone,
	"supersedes_version" integer,
	"mapping_note" text,
	"created_by_oxy_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "feed_configuration_versions_status_check" CHECK ("feed_configuration_versions"."status" in ('draft', 'active', 'superseded')),
	CONSTRAINT "feed_configuration_versions_fetch_mode_check" CHECK ("feed_configuration_versions"."fetch_mode" in ('url', 'upload')),
	CONSTRAINT "feed_configuration_versions_format_check" CHECK ("feed_configuration_versions"."format" in ('csv', 'tsv', 'xml', 'json', 'jsonl')),
	CONSTRAINT "feed_configuration_versions_encoding_check" CHECK ("feed_configuration_versions"."encoding" in ('utf-8', 'utf-16le', 'latin1')),
	CONSTRAINT "feed_configuration_versions_compression_check" CHECK ("feed_configuration_versions"."compression" in ('none', 'gzip')),
	CONSTRAINT "feed_configuration_versions_delivery_mode_check" CHECK ("feed_configuration_versions"."delivery_mode" in ('snapshot', 'delta')),
	CONSTRAINT "feed_configuration_versions_auth_kind_check" CHECK ("feed_configuration_versions"."auth_kind" in ('none', 'basic', 'bearer', 'header', 'query_param')),
	CONSTRAINT "feed_configuration_versions_version_check" CHECK ("feed_configuration_versions"."version" >= 1),
	CONSTRAINT "feed_configuration_versions_supersedes_check" CHECK ("feed_configuration_versions"."supersedes_version" is null or "feed_configuration_versions"."supersedes_version" < "feed_configuration_versions"."version"),
	CONSTRAINT "feed_configuration_versions_fetch_shape_check" CHECK (("feed_configuration_versions"."fetch_mode" = 'url') = ("feed_configuration_versions"."feed_url" is not null)
          and ("feed_configuration_versions"."fetch_mode" = 'upload') = ("feed_configuration_versions"."upload_id" is not null)),
	CONSTRAINT "feed_configuration_versions_url_shape_check" CHECK ("feed_configuration_versions"."feed_url" is null
          or ("feed_configuration_versions"."feed_url" ~ '^https://[^[:space:]]+$'
              and length("feed_configuration_versions"."feed_url") <= 2048)),
	CONSTRAINT "feed_configuration_versions_record_path_check" CHECK (("feed_configuration_versions"."format" in ('xml', 'json')) = ("feed_configuration_versions"."record_path" is not null)),
	CONSTRAINT "feed_configuration_versions_record_path_shape_check" CHECK ("feed_configuration_versions"."record_path" is null or "feed_configuration_versions"."record_path" ~ '^[A-Za-z0-9_:.\[\]-]{1,200}$'),
	CONSTRAINT "feed_configuration_versions_delimiter_check" CHECK (("feed_configuration_versions"."format" in ('csv', 'tsv'))
          = ("feed_configuration_versions"."delimiter" is not null and "feed_configuration_versions"."quote_char" is not null)),
	CONSTRAINT "feed_configuration_versions_delimiter_shape_check" CHECK (("feed_configuration_versions"."delimiter" is null or length("feed_configuration_versions"."delimiter") = 1)
          and ("feed_configuration_versions"."quote_char" is null or length("feed_configuration_versions"."quote_char") = 1)
          and length("feed_configuration_versions"."list_separator") = 1),
	CONSTRAINT "feed_configuration_versions_header_check" CHECK ("feed_configuration_versions"."format" in ('csv', 'tsv') or "feed_configuration_versions"."has_header_row" = false),
	CONSTRAINT "feed_configuration_versions_currency_shape_check" CHECK ("feed_configuration_versions"."default_currency" is null or "feed_configuration_versions"."default_currency" ~ '^[A-Z]{3,4}$'),
	CONSTRAINT "feed_configuration_versions_country_shape_check" CHECK ("feed_configuration_versions"."default_country" is null or "feed_configuration_versions"."default_country" ~ '^[A-Z]{2}$'),
	CONSTRAINT "feed_configuration_versions_language_shape_check" CHECK ("feed_configuration_versions"."default_language" is null or "feed_configuration_versions"."default_language" ~ '^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$'),
	CONSTRAINT "feed_configuration_versions_auth_shape_check" CHECK (("feed_configuration_versions"."auth_kind" = 'none') = ("feed_configuration_versions"."auth_ciphertext" is null)
          and ("feed_configuration_versions"."auth_kind" in ('header', 'query_param')) = ("feed_configuration_versions"."auth_param_name" is not null)),
	CONSTRAINT "feed_configuration_versions_auth_param_shape_check" CHECK ("feed_configuration_versions"."auth_param_name" is null or "feed_configuration_versions"."auth_param_name" ~ '^[A-Za-z0-9_-]{1,64}$'),
	CONSTRAINT "feed_configuration_versions_activation_check" CHECK ("feed_configuration_versions"."status" = 'draft'
          or ("feed_configuration_versions"."activated_at" is not null and "feed_configuration_versions"."activated_by_oxy_user_id" is not null
              and "feed_configuration_versions"."validated_report_id" is not null)),
	CONSTRAINT "feed_configuration_versions_superseded_shape_check" CHECK (("feed_configuration_versions"."status" = 'superseded') = ("feed_configuration_versions"."superseded_at" is not null)),
	CONSTRAINT "feed_configuration_versions_note_length_check" CHECK ("feed_configuration_versions"."mapping_note" is null
          or length("feed_configuration_versions"."mapping_note") <= 512)
);
--> statement-breakpoint
CREATE TABLE "feed_configurations" (
	"id" text PRIMARY KEY NOT NULL,
	"source_id" text NOT NULL,
	"owner_kind" text NOT NULL,
	"store_id" text,
	"label" text NOT NULL,
	"identity_key_fields" text[] NOT NULL,
	"last_etag" text,
	"last_modified_header" text,
	"last_fetched_at" timestamp with time zone,
	"created_by_oxy_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "feed_configurations_owner_kind_check" CHECK ("feed_configurations"."owner_kind" in ('merchant', 'operator')),
	CONSTRAINT "feed_configurations_validator_length_check" CHECK (("feed_configurations"."last_etag" is null or length("feed_configurations"."last_etag") <= 256)
          and ("feed_configurations"."last_modified_header" is null or length("feed_configurations"."last_modified_header") <= 128)),
	CONSTRAINT "feed_configurations_owner_shape_check" CHECK (("feed_configurations"."owner_kind" = 'merchant') = ("feed_configurations"."store_id" is not null)),
	CONSTRAINT "feed_configurations_identity_key_present_check" CHECK (array_length("feed_configurations"."identity_key_fields", 1) between 1 and 4),
	CONSTRAINT "feed_configurations_identity_key_shape_check" CHECK ("feed_configurations"."identity_key_fields"::text ~ '^[{]([A-Za-z0-9_:.-]{1,120}(,[A-Za-z0-9_:.-]{1,120})*)?[}]$'),
	CONSTRAINT "feed_configurations_label_length_check" CHECK (btrim("feed_configurations"."label") <> '' and length("feed_configurations"."label") <= 512)
);
--> statement-breakpoint
CREATE TABLE "feed_field_mappings" (
	"id" text PRIMARY KEY NOT NULL,
	"version_id" text NOT NULL,
	"role" text NOT NULL,
	"source_field" text,
	"constant_value" text,
	"transform" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "feed_field_mappings_role_check" CHECK ("feed_field_mappings"."role" in ('title', 'description', 'brand', 'model', 'category', 'gtin', 'ean', 'upc', 'isbn', 'mpn', 'sku', 'price', 'price_currency', 'sale_price', 'sale_price_currency', 'availability', 'available_quantity', 'condition', 'image', 'additional_images', 'destination_url', 'affiliate_url', 'merchant', 'storefront', 'delivery_cost', 'delivery_cost_currency', 'delivery_min_days', 'delivery_max_days', 'return_window_days', 'return_policy_url', 'country', 'region', 'language', 'option_name_1', 'option_value_1', 'option_name_2', 'option_value_2', 'option_name_3', 'option_value_3', 'source_created_at', 'source_updated_at')),
	CONSTRAINT "feed_field_mappings_transform_check" CHECK ("feed_field_mappings"."transform" in ('trim', 'collapse_whitespace', 'upper', 'lower', 'strip_html', 'strip_identifier_separators', 'split_list', 'first_of_list', 'money_minor_units', 'parse_integer')),
	CONSTRAINT "feed_field_mappings_source_shape_check" CHECK (num_nonnulls("feed_field_mappings"."source_field", "feed_field_mappings"."constant_value") = 1),
	CONSTRAINT "feed_field_mappings_source_field_shape_check" CHECK ("feed_field_mappings"."source_field" is null or "feed_field_mappings"."source_field" ~ '^[A-Za-z0-9_:.\[\] -]{1,200}$'),
	CONSTRAINT "feed_field_mappings_constant_length_check" CHECK ("feed_field_mappings"."constant_value" is null
          or length("feed_field_mappings"."constant_value") <= 512)
);
--> statement-breakpoint
CREATE TABLE "feed_import_report_entries" (
	"id" text PRIMARY KEY NOT NULL,
	"report_id" text NOT NULL,
	"record_index" integer NOT NULL,
	"issue_code" text NOT NULL,
	"severity" text NOT NULL,
	"role" text,
	"source_field" text,
	"external_id" text,
	"observed_token" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "feed_import_report_entries_code_check" CHECK ("feed_import_report_entries"."issue_code" in ('missing_required_field', 'empty_value', 'value_too_long', 'unparseable_number', 'negative_amount', 'amount_out_of_range', 'missing_currency', 'unsupported_currency', 'invalid_url', 'insecure_url', 'invalid_identifier', 'unknown_availability', 'unknown_condition', 'duplicate_external_id', 'record_too_large', 'unmapped_role', 'malformed_record')),
	CONSTRAINT "feed_import_report_entries_severity_check" CHECK ("feed_import_report_entries"."severity" in ('error', 'warning')),
	CONSTRAINT "feed_import_report_entries_role_check" CHECK ("feed_import_report_entries"."role" in ('title', 'description', 'brand', 'model', 'category', 'gtin', 'ean', 'upc', 'isbn', 'mpn', 'sku', 'price', 'price_currency', 'sale_price', 'sale_price_currency', 'availability', 'available_quantity', 'condition', 'image', 'additional_images', 'destination_url', 'affiliate_url', 'merchant', 'storefront', 'delivery_cost', 'delivery_cost_currency', 'delivery_min_days', 'delivery_max_days', 'return_window_days', 'return_policy_url', 'country', 'region', 'language', 'option_name_1', 'option_value_1', 'option_name_2', 'option_value_2', 'option_name_3', 'option_value_3', 'source_created_at', 'source_updated_at')),
	CONSTRAINT "feed_import_report_entries_index_check" CHECK ("feed_import_report_entries"."record_index" >= 0),
	CONSTRAINT "feed_import_report_entries_source_field_shape_check" CHECK ("feed_import_report_entries"."source_field" is null
          or length("feed_import_report_entries"."source_field") <= 512),
	CONSTRAINT "feed_import_report_entries_external_id_shape_check" CHECK ("feed_import_report_entries"."external_id" is null or length("feed_import_report_entries"."external_id") <= 200),
	CONSTRAINT "feed_import_report_entries_token_shape_check" CHECK ("feed_import_report_entries"."observed_token" is null
          or ("feed_import_report_entries"."issue_code" in ('unsupported_currency', 'unknown_availability', 'unknown_condition')
              and length("feed_import_report_entries"."observed_token") <= 16
              and "feed_import_report_entries"."observed_token" ~ '^[A-Za-z0-9 _./-]+$'))
);
--> statement-breakpoint
CREATE TABLE "feed_import_reports" (
	"id" text PRIMARY KEY NOT NULL,
	"configuration_id" text NOT NULL,
	"version_id" text NOT NULL,
	"mode" text NOT NULL,
	"scanned" integer DEFAULT 0 NOT NULL,
	"valid" integer DEFAULT 0 NOT NULL,
	"invalid" integer DEFAULT 0 NOT NULL,
	"changed" integer DEFAULT 0 NOT NULL,
	"unchanged" integer DEFAULT 0 NOT NULL,
	"matched" integer DEFAULT 0 NOT NULL,
	"created" integer DEFAULT 0 NOT NULL,
	"review" integer DEFAULT 0 NOT NULL,
	"warnings" integer DEFAULT 0 NOT NULL,
	"enumeration_complete" boolean DEFAULT false NOT NULL,
	"bytes_read" bigint DEFAULT 0 NOT NULL,
	"duration_ms" integer DEFAULT 0 NOT NULL,
	"failure_note" text,
	"requested_by_oxy_user_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "feed_import_reports_mode_check" CHECK ("feed_import_reports"."mode" in ('preview', 'validation', 'import')),
	CONSTRAINT "feed_import_reports_counters_non_negative_check" CHECK ("feed_import_reports"."scanned" >= 0 and "feed_import_reports"."valid" >= 0 and "feed_import_reports"."invalid" >= 0 and "feed_import_reports"."changed" >= 0
          and "feed_import_reports"."unchanged" >= 0 and "feed_import_reports"."matched" >= 0 and "feed_import_reports"."created" >= 0
          and "feed_import_reports"."review" >= 0 and "feed_import_reports"."warnings" >= 0 and "feed_import_reports"."bytes_read" >= 0
          and "feed_import_reports"."duration_ms" >= 0),
	CONSTRAINT "feed_import_reports_intake_total_check" CHECK ("feed_import_reports"."scanned" = "feed_import_reports"."valid" + "feed_import_reports"."invalid"),
	CONSTRAINT "feed_import_reports_tally_bound_check" CHECK ("feed_import_reports"."changed" + "feed_import_reports"."unchanged" <= "feed_import_reports"."valid"
          and "feed_import_reports"."matched" <= "feed_import_reports"."valid" and "feed_import_reports"."created" <= "feed_import_reports"."valid"
          and "feed_import_reports"."review" <= "feed_import_reports"."valid"),
	CONSTRAINT "feed_import_reports_failure_note_length_check" CHECK ("feed_import_reports"."failure_note" is null
          or length("feed_import_reports"."failure_note") <= 512)
);
--> statement-breakpoint
CREATE TABLE "feed_uploads" (
	"id" text PRIMARY KEY NOT NULL,
	"configuration_id" text NOT NULL,
	"filename" text NOT NULL,
	"byte_size" bigint NOT NULL,
	"content_digest" text NOT NULL,
	"storage_key" text NOT NULL,
	"compression" text NOT NULL,
	"status" text DEFAULT 'staged' NOT NULL,
	"uploaded_by_oxy_user_id" text NOT NULL,
	"consumed_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "feed_uploads_status_check" CHECK ("feed_uploads"."status" in ('staged', 'consumed', 'expired', 'missing')),
	CONSTRAINT "feed_uploads_compression_check" CHECK ("feed_uploads"."compression" in ('none', 'gzip')),
	CONSTRAINT "feed_uploads_filename_shape_check" CHECK ("feed_uploads"."filename" ~ '^[A-Za-z0-9][A-Za-z0-9 _.-]{0,199}$' and "feed_uploads"."filename" !~ '\.\.'),
	CONSTRAINT "feed_uploads_digest_shape_check" CHECK ("feed_uploads"."content_digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "feed_uploads_byte_size_check" CHECK ("feed_uploads"."byte_size" >= 0),
	CONSTRAINT "feed_uploads_storage_key_shape_check" CHECK ("feed_uploads"."storage_key" ~ '^[A-Za-z0-9_-]{8,128}$'),
	CONSTRAINT "feed_uploads_consumed_shape_check" CHECK (("feed_uploads"."status" = 'consumed') = ("feed_uploads"."consumed_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "feed_value_mappings" (
	"id" text PRIMARY KEY NOT NULL,
	"version_id" text NOT NULL,
	"role" text NOT NULL,
	"source_value" text NOT NULL,
	"target_value" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "feed_value_mappings_role_check" CHECK ("feed_value_mappings"."role" in ('availability', 'condition')),
	CONSTRAINT "feed_value_mappings_value_shape_check" CHECK (btrim("feed_value_mappings"."source_value") <> '' and length("feed_value_mappings"."source_value") <= 120
          and btrim("feed_value_mappings"."target_value") <> '' and length("feed_value_mappings"."target_value") <= 120)
);
--> statement-breakpoint
ALTER TABLE "feed_configuration_versions" ADD CONSTRAINT "feed_configuration_versions_configuration_id_feed_configurations_id_fk" FOREIGN KEY ("configuration_id") REFERENCES "public"."feed_configurations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feed_configuration_versions" ADD CONSTRAINT "feed_configuration_versions_upload_id_feed_uploads_id_fk" FOREIGN KEY ("upload_id") REFERENCES "public"."feed_uploads"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feed_configuration_versions" ADD CONSTRAINT "feed_configuration_versions_validated_report_id_feed_import_reports_id_fk" FOREIGN KEY ("validated_report_id") REFERENCES "public"."feed_import_reports"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feed_configurations" ADD CONSTRAINT "feed_configurations_source_id_catalog_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."catalog_sources"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feed_configurations" ADD CONSTRAINT "feed_configurations_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feed_field_mappings" ADD CONSTRAINT "feed_field_mappings_version_id_feed_configuration_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."feed_configuration_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feed_import_report_entries" ADD CONSTRAINT "feed_import_report_entries_report_id_feed_import_reports_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."feed_import_reports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feed_import_reports" ADD CONSTRAINT "feed_import_reports_configuration_id_feed_configurations_id_fk" FOREIGN KEY ("configuration_id") REFERENCES "public"."feed_configurations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feed_import_reports" ADD CONSTRAINT "feed_import_reports_version_id_feed_configuration_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."feed_configuration_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feed_uploads" ADD CONSTRAINT "feed_uploads_configuration_id_feed_configurations_id_fk" FOREIGN KEY ("configuration_id") REFERENCES "public"."feed_configurations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feed_value_mappings" ADD CONSTRAINT "feed_value_mappings_version_id_feed_configuration_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."feed_configuration_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "feed_configuration_versions_version_key" ON "feed_configuration_versions" USING btree ("configuration_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "feed_configuration_versions_active_key" ON "feed_configuration_versions" USING btree ("configuration_id") WHERE "feed_configuration_versions"."status" = 'active';--> statement-breakpoint
CREATE INDEX "feed_configuration_versions_configuration_idx" ON "feed_configuration_versions" USING btree ("configuration_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "feed_configurations_source_key" ON "feed_configurations" USING btree ("source_id");--> statement-breakpoint
CREATE INDEX "feed_configurations_store_idx" ON "feed_configurations" USING btree ("store_id") WHERE "feed_configurations"."store_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "feed_field_mappings_role_key" ON "feed_field_mappings" USING btree ("version_id","role");--> statement-breakpoint
CREATE INDEX "feed_import_report_entries_report_idx" ON "feed_import_report_entries" USING btree ("report_id","record_index");--> statement-breakpoint
CREATE INDEX "feed_import_report_entries_code_idx" ON "feed_import_report_entries" USING btree ("report_id","issue_code");--> statement-breakpoint
CREATE INDEX "feed_import_report_entries_expiry_idx" ON "feed_import_report_entries" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "feed_import_reports_configuration_idx" ON "feed_import_reports" USING btree ("configuration_id","created_at");--> statement-breakpoint
CREATE INDEX "feed_import_reports_version_idx" ON "feed_import_reports" USING btree ("version_id","mode");--> statement-breakpoint
CREATE INDEX "feed_import_reports_expiry_idx" ON "feed_import_reports" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "feed_uploads_configuration_idx" ON "feed_uploads" USING btree ("configuration_id","created_at");--> statement-breakpoint
CREATE INDEX "feed_uploads_expiry_idx" ON "feed_uploads" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "feed_value_mappings_key" ON "feed_value_mappings" USING btree ("version_id","role","source_value");
--> statement-breakpoint
-- oxy:hand-written -----------------------------------------------------------
--
-- 1. `feed_configurations.identity_key_fields` is FROZEN.
--
-- The external id every `catalog_source_objects` row is keyed on is derived from
-- these columns of the merchant's own file. Change the list and every object in
-- the feed gets a new id: the old ones stop being mentioned by a completed
-- enumeration and are RETIRED, the new ones arrive as first-time observations,
-- and the whole thing looks exactly like a seller who replaced their catalogue
-- overnight. There is no repair short of a data migration, and no error anywhere
-- to notice. Re-keying a feed is a NEW configuration, which is honest about what
-- it does.
--
CREATE OR REPLACE FUNCTION mercaria_feed_configuration_identity_frozen()
RETURNS trigger AS $$
BEGIN
  IF NEW.identity_key_fields IS DISTINCT FROM OLD.identity_key_fields THEN
    RAISE EXCEPTION
      'feed_configurations.identity_key_fields is frozen: re-keying a feed re-mints every '
      'source object and retires the catalogue behind the old ids. Create a new configuration.';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER feed_configurations_identity_frozen
BEFORE UPDATE ON feed_configurations
FOR EACH ROW EXECUTE FUNCTION mercaria_feed_configuration_identity_frozen();--> statement-breakpoint

--
-- 2. A mapping VERSION is frozen once it leaves `draft`.
--
-- The `catalog_source_policies` / `fee_schedules` mechanism, and the reason is
-- the same: every stored observation cites the version it was read under, so a
-- version whose meaning could change would silently reinterpret facts already in
-- the catalogue. The lifecycle columns are deliberately EXCLUDED from the freeze
-- — `status`, `activated_at`, `activated_by_oxy_user_id`, `validated_report_id`,
-- `superseded_at` and `updated_at` are how a version moves through draft →
-- active → superseded, and freezing them would make activation impossible.
--
CREATE OR REPLACE FUNCTION mercaria_feed_configuration_version_immutable()
RETURNS trigger AS $$
BEGIN
  IF OLD.status = 'draft' THEN
    RETURN NEW;
  END IF;
  IF NEW.configuration_id IS DISTINCT FROM OLD.configuration_id
     OR NEW.version IS DISTINCT FROM OLD.version
     OR NEW.fetch_mode IS DISTINCT FROM OLD.fetch_mode
     OR NEW.feed_url IS DISTINCT FROM OLD.feed_url
     OR NEW.upload_id IS DISTINCT FROM OLD.upload_id
     OR NEW.format IS DISTINCT FROM OLD.format
     OR NEW.delimiter IS DISTINCT FROM OLD.delimiter
     OR NEW.quote_char IS DISTINCT FROM OLD.quote_char
     OR NEW.encoding IS DISTINCT FROM OLD.encoding
     OR NEW.compression IS DISTINCT FROM OLD.compression
     OR NEW.record_path IS DISTINCT FROM OLD.record_path
     OR NEW.has_header_row IS DISTINCT FROM OLD.has_header_row
     OR NEW.list_separator IS DISTINCT FROM OLD.list_separator
     OR NEW.default_currency IS DISTINCT FROM OLD.default_currency
     OR NEW.default_country IS DISTINCT FROM OLD.default_country
     OR NEW.default_language IS DISTINCT FROM OLD.default_language
     OR NEW.delivery_mode IS DISTINCT FROM OLD.delivery_mode
     OR NEW.auth_kind IS DISTINCT FROM OLD.auth_kind
     OR NEW.auth_ciphertext IS DISTINCT FROM OLD.auth_ciphertext
     OR NEW.auth_param_name IS DISTINCT FROM OLD.auth_param_name THEN
    RAISE EXCEPTION
      'A feed mapping version is frozen once it leaves draft. Every observation cites the '
      'version it was read under; publish a NEW version instead.';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER feed_configuration_versions_immutable
BEFORE UPDATE ON feed_configuration_versions
FOR EACH ROW EXECUTE FUNCTION mercaria_feed_configuration_version_immutable();--> statement-breakpoint

--
-- 3. `feed_import_report_entries` is APPEND-ONLY against UPDATE.
--
-- A report is the evidence an ACTIVE mapping version cites, and an entry that
-- could be edited would let somebody make a validation run look cleaner than it
-- was after the fact. DELETE is deliberately PERMITTED: retention sweeps these
-- rows on their own deadline (`expiryTargets.ts`), and a trigger refusing it
-- would make retention fail silently — the `analytics_events` posture, one
-- domain over.
--
CREATE OR REPLACE FUNCTION mercaria_feed_report_entry_append_only()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'feed_import_report_entries is append-only; a report entry cannot be edited.';
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER feed_import_report_entries_append_only
BEFORE UPDATE ON feed_import_report_entries
FOR EACH ROW EXECUTE FUNCTION mercaria_feed_report_entry_append_only();
