-- oxy:deploy-phase=pre
-- oxy:rollback=derived
CREATE TABLE "automotive_fitments" (
	"id" text PRIMARY KEY NOT NULL,
	"subject_product_id" text,
	"subject_variant_id" text,
	"scope" text NOT NULL,
	"vehicle_make_id" text NOT NULL,
	"vehicle_model_id" text,
	"vehicle_generation_id" text,
	"vehicle_configuration_id" text,
	"applicability" text DEFAULT 'unknown' NOT NULL,
	"position" text DEFAULT 'not_applicable' NOT NULL,
	"qualifiers" text[] DEFAULT '{}'::text[] NOT NULL,
	"condition_kinds" text[] DEFAULT '{}'::text[] NOT NULL,
	"condition_note" text,
	"year_from" integer,
	"year_to" integer,
	"quantity_per_vehicle" integer,
	"verification" text DEFAULT 'candidate' NOT NULL,
	"verification_method" text,
	"asserted_by_kind" text NOT NULL,
	"asserted_by_source_id" text,
	"manufacturer_reference" text,
	"manufacturer_publication_url" text,
	"content_sha256" text,
	"source_record_id" text,
	"confidence" double precision,
	"observed_at" timestamp with time zone,
	"verified_at" timestamp with time zone,
	"verified_by_oxy_user_id" text,
	"last_checked_at" timestamp with time zone,
	"valid_from" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"valid_to" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_by_oxy_user_id" text,
	"revoke_reason" text,
	"superseded_by_id" text,
	"note" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"fitment_key" text GENERATED ALWAYS AS (coalesce("subject_product_id", '') || '|' || coalesce("subject_variant_id", '') || '|' ||
            "vehicle_make_id" || '|' || coalesce("vehicle_model_id", '') || '|' ||
            coalesce("vehicle_generation_id", '') || '|' || coalesce("vehicle_configuration_id", '') || '|' ||
            "position") STORED NOT NULL,
	CONSTRAINT "automotive_fitments_scope_check" CHECK ("automotive_fitments"."scope" in ('vehicle_make', 'vehicle_model', 'vehicle_generation', 'vehicle_configuration')),
	CONSTRAINT "automotive_fitments_applicability_check" CHECK ("automotive_fitments"."applicability" in ('applies', 'partially_applies', 'does_not_apply', 'unknown')),
	CONSTRAINT "automotive_fitments_position_check" CHECK ("automotive_fitments"."position" in ('front', 'rear', 'front_left', 'front_right', 'rear_left', 'rear_right', 'left', 'right', 'upper', 'lower', 'interior', 'exterior', 'not_applicable')),
	CONSTRAINT "automotive_fitments_verification_check" CHECK ("automotive_fitments"."verification" in ('candidate', 'verified', 'disputed', 'rejected', 'expired', 'revoked')),
	CONSTRAINT "automotive_fitments_verification_method_check" CHECK ("automotive_fitments"."verification_method" in ('manufacturer_publication', 'oem_part_number_match', 'operator_review', 'physical_test', 'standards_conformance', 'cross_source_corroboration')),
	CONSTRAINT "automotive_fitments_asserted_by_kind_check" CHECK ("automotive_fitments"."asserted_by_kind" in ('manufacturer', 'catalog_source', 'merchant', 'operator', 'matcher')),
	CONSTRAINT "automotive_fitments_qualifiers_check" CHECK ("automotive_fitments"."qualifiers" <@ array['with_sport_suspension', 'without_sport_suspension', 'with_towing_package', 'with_sunroof', 'left_hand_drive_only', 'right_hand_drive_only', 'heavy_duty', 'requires_abs', 'vin_range_restricted', 'production_date_restricted', 'chassis_number_restricted', 'facelift_only', 'pre_facelift_only']::text[]),
	CONSTRAINT "automotive_fitments_condition_kinds_check" CHECK ("automotive_fitments"."condition_kinds" <@ array['requires_adapter', 'requires_firmware_version', 'requires_additional_part', 'requires_professional_installation', 'requires_tool', 'market_restricted', 'quantity_required', 'excludes_configuration', 'production_period_restricted']::text[]),
	CONSTRAINT "automotive_fitments_subject_check" CHECK (num_nonnulls("automotive_fitments"."subject_product_id", "automotive_fitments"."subject_variant_id") = 1),
	CONSTRAINT "automotive_fitments_scope_shape_check" CHECK (case "automotive_fitments"."scope"
        when 'vehicle_make' then
          "automotive_fitments"."vehicle_model_id" is null and "automotive_fitments"."vehicle_generation_id" is null and "automotive_fitments"."vehicle_configuration_id" is null
        when 'vehicle_model' then
          "automotive_fitments"."vehicle_model_id" is not null and "automotive_fitments"."vehicle_generation_id" is null and "automotive_fitments"."vehicle_configuration_id" is null
        when 'vehicle_generation' then
          "automotive_fitments"."vehicle_model_id" is not null and "automotive_fitments"."vehicle_generation_id" is not null and "automotive_fitments"."vehicle_configuration_id" is null
        when 'vehicle_configuration' then
          "automotive_fitments"."vehicle_model_id" is not null and "automotive_fitments"."vehicle_generation_id" is not null and "automotive_fitments"."vehicle_configuration_id" is not null
        else false
      end),
	CONSTRAINT "automotive_fitments_partial_condition_check" CHECK ("automotive_fitments"."applicability" <> 'partially_applies'
        or cardinality("automotive_fitments"."condition_kinds") >= 1
        or cardinality("automotive_fitments"."qualifiers") >= 1
        or "automotive_fitments"."condition_note" is not null),
	CONSTRAINT "automotive_fitments_from_year_check" CHECK ("automotive_fitments"."year_from" is null or ("automotive_fitments"."year_from" >= 1885 and "automotive_fitments"."year_from" <= 2100)),
	CONSTRAINT "automotive_fitments_to_year_check" CHECK ("automotive_fitments"."year_to" is null or ("automotive_fitments"."year_to" >= 1885 and "automotive_fitments"."year_to" <= 2100)),
	CONSTRAINT "automotive_fitments_year_order_check" CHECK ("automotive_fitments"."year_from" is null or "automotive_fitments"."year_to" is null or "automotive_fitments"."year_to" >= "automotive_fitments"."year_from"),
	CONSTRAINT "automotive_fitments_quantity_check" CHECK ("automotive_fitments"."quantity_per_vehicle" is null or ("automotive_fitments"."quantity_per_vehicle" > 0 and "automotive_fitments"."quantity_per_vehicle" <= 64)),
	CONSTRAINT "automotive_fitments_verified_state_check" CHECK ("automotive_fitments"."verification" <> 'verified'
        or ("automotive_fitments"."verification_method" is not null and "automotive_fitments"."verified_at" is not null and "automotive_fitments"."verified_by_oxy_user_id" is not null)),
	CONSTRAINT "automotive_fitments_revoked_state_check" CHECK ("automotive_fitments"."verification" <> 'revoked'
        or ("automotive_fitments"."revoked_at" is not null and "automotive_fitments"."revoked_by_oxy_user_id" is not null and "automotive_fitments"."valid_to" is not null)),
	CONSTRAINT "automotive_fitments_confidence_range_check" CHECK ("automotive_fitments"."confidence" is null or ("automotive_fitments"."confidence" >= 0 and "automotive_fitments"."confidence" <= 1)),
	CONSTRAINT "automotive_fitments_confidence_machine_check" CHECK ("automotive_fitments"."confidence" is null or "automotive_fitments"."asserted_by_kind" in ('catalog_source', 'matcher')),
	CONSTRAINT "automotive_fitments_source_presence_check" CHECK (("automotive_fitments"."asserted_by_kind" = 'catalog_source') = ("automotive_fitments"."asserted_by_source_id" is not null)),
	CONSTRAINT "automotive_fitments_manufacturer_evidence_check" CHECK ("automotive_fitments"."verification_method" <> 'manufacturer_publication'
        or ("automotive_fitments"."manufacturer_publication_url" is not null and "automotive_fitments"."content_sha256" is not null)),
	CONSTRAINT "automotive_fitments_sha256_shape_check" CHECK ("automotive_fitments"."content_sha256" is null or "automotive_fitments"."content_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "automotive_fitments_validity_order_check" CHECK ("automotive_fitments"."valid_to" is null or "automotive_fitments"."valid_to" > "automotive_fitments"."valid_from"),
	CONSTRAINT "automotive_fitments_supersedes_other_check" CHECK ("automotive_fitments"."superseded_by_id" is null or "automotive_fitments"."superseded_by_id" <> "automotive_fitments"."id")
);
--> statement-breakpoint
CREATE TABLE "compatibility_claims" (
	"id" text PRIMARY KEY NOT NULL,
	"subject_product_id" text,
	"subject_variant_id" text,
	"kind" text,
	"raw_target_text" text NOT NULL,
	"raw_qualifier_text" text,
	"state" text DEFAULT 'unresolved' NOT NULL,
	"unresolved_reason" text,
	"relation_id" text,
	"fitment_id" text,
	"asserted_by_kind" text NOT NULL,
	"asserted_by_source_id" text,
	"source_record_id" text,
	"source_url" text,
	"content_sha256" text,
	"observed_at" timestamp with time zone NOT NULL,
	"confidence" double precision,
	"reviewed_by_oxy_user_id" text,
	"reviewed_at" timestamp with time zone,
	"review_note" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "compatibility_claims_kind_check" CHECK ("compatibility_claims"."kind" in ('accessory_for', 'replacement_part_for', 'consumable_for', 'requires', 'works_with', 'software_supports_device', 'mounts_to', 'supersedes')),
	CONSTRAINT "compatibility_claims_state_check" CHECK ("compatibility_claims"."state" in ('unresolved', 'selected', 'corroborating', 'conflicting', 'rejected', 'superseded')),
	CONSTRAINT "compatibility_claims_unresolved_reason_check" CHECK ("compatibility_claims"."unresolved_reason" in ('unknown_target', 'ambiguous_target', 'unparsed_target', 'unsupported_target_class', 'unknown_subject', 'awaiting_review')),
	CONSTRAINT "compatibility_claims_asserted_by_kind_check" CHECK ("compatibility_claims"."asserted_by_kind" in ('manufacturer', 'catalog_source', 'merchant', 'operator', 'matcher')),
	CONSTRAINT "compatibility_claims_subject_check" CHECK (num_nonnulls("compatibility_claims"."subject_product_id", "compatibility_claims"."subject_variant_id") <= 1),
	CONSTRAINT "compatibility_claims_raw_target_check" CHECK (btrim("compatibility_claims"."raw_target_text") <> ''),
	CONSTRAINT "compatibility_claims_target_arity_check" CHECK (num_nonnulls("compatibility_claims"."relation_id", "compatibility_claims"."fitment_id") <= 1),
	CONSTRAINT "compatibility_claims_unresolved_shape_check" CHECK ("compatibility_claims"."state" <> 'unresolved' or num_nonnulls("compatibility_claims"."relation_id", "compatibility_claims"."fitment_id") = 0),
	CONSTRAINT "compatibility_claims_resolved_shape_check" CHECK ("compatibility_claims"."state" not in ('selected', 'corroborating', 'conflicting')
        or num_nonnulls("compatibility_claims"."relation_id", "compatibility_claims"."fitment_id") = 1),
	CONSTRAINT "compatibility_claims_unresolved_reason_presence_check" CHECK (("compatibility_claims"."state" = 'unresolved') = ("compatibility_claims"."unresolved_reason" is not null)),
	CONSTRAINT "compatibility_claims_confidence_range_check" CHECK ("compatibility_claims"."confidence" is null or ("compatibility_claims"."confidence" >= 0 and "compatibility_claims"."confidence" <= 1)),
	CONSTRAINT "compatibility_claims_confidence_machine_check" CHECK ("compatibility_claims"."confidence" is null or "compatibility_claims"."asserted_by_kind" in ('catalog_source', 'matcher')),
	CONSTRAINT "compatibility_claims_source_presence_check" CHECK (("compatibility_claims"."asserted_by_kind" = 'catalog_source') = ("compatibility_claims"."asserted_by_source_id" is not null)),
	CONSTRAINT "compatibility_claims_sha256_shape_check" CHECK ("compatibility_claims"."content_sha256" is null or "compatibility_claims"."content_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "compatibility_claims_rejected_state_check" CHECK ("compatibility_claims"."state" <> 'rejected' or ("compatibility_claims"."reviewed_by_oxy_user_id" is not null and "compatibility_claims"."reviewed_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "generic_compatibility_relations" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"direction" text DEFAULT 'subject_to_target' NOT NULL,
	"subject_product_id" text,
	"subject_variant_id" text,
	"target_kind" text NOT NULL,
	"target_family_id" text,
	"target_product_id" text,
	"target_variant_id" text,
	"target_type" text,
	"target_key" text,
	"applicability" text DEFAULT 'unknown' NOT NULL,
	"condition_kinds" text[] DEFAULT '{}'::text[] NOT NULL,
	"condition_note" text,
	"markets" text[] DEFAULT '{}'::text[] NOT NULL,
	"valid_from" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"valid_to" timestamp with time zone,
	"verification" text DEFAULT 'candidate' NOT NULL,
	"verification_method" text,
	"asserted_by_kind" text NOT NULL,
	"asserted_by_source_id" text,
	"confidence" double precision,
	"verified_at" timestamp with time zone,
	"verified_by_oxy_user_id" text,
	"last_checked_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_by_oxy_user_id" text,
	"revoke_reason" text,
	"superseded_by_id" text,
	"note" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"relation_key" text GENERATED ALWAYS AS (coalesce("subject_product_id", '') || '|' || coalesce("subject_variant_id", '') || '|' ||
            coalesce("target_family_id", '') || '|' || coalesce("target_product_id", '') || '|' ||
            coalesce("target_variant_id", '') || '|' || coalesce("target_type", '') || '|' ||
            coalesce("target_key", '')) STORED NOT NULL,
	CONSTRAINT "generic_compatibility_relations_kind_check" CHECK ("generic_compatibility_relations"."kind" in ('accessory_for', 'replacement_part_for', 'consumable_for', 'requires', 'works_with', 'software_supports_device', 'mounts_to', 'supersedes')),
	CONSTRAINT "generic_compatibility_relations_direction_check" CHECK ("generic_compatibility_relations"."direction" in ('subject_to_target', 'mutual')),
	CONSTRAINT "generic_compatibility_relations_target_kind_check" CHECK ("generic_compatibility_relations"."target_kind" in ('canonical_family', 'canonical_product', 'canonical_variant', 'typed')),
	CONSTRAINT "generic_compatibility_relations_applicability_check" CHECK ("generic_compatibility_relations"."applicability" in ('applies', 'partially_applies', 'does_not_apply', 'unknown')),
	CONSTRAINT "generic_compatibility_relations_verification_check" CHECK ("generic_compatibility_relations"."verification" in ('candidate', 'verified', 'disputed', 'rejected', 'expired', 'revoked')),
	CONSTRAINT "generic_compatibility_relations_verification_method_check" CHECK ("generic_compatibility_relations"."verification_method" in ('manufacturer_publication', 'oem_part_number_match', 'operator_review', 'physical_test', 'standards_conformance', 'cross_source_corroboration')),
	CONSTRAINT "generic_compatibility_relations_asserted_by_kind_check" CHECK ("generic_compatibility_relations"."asserted_by_kind" in ('manufacturer', 'catalog_source', 'merchant', 'operator', 'matcher')),
	CONSTRAINT "generic_compatibility_relations_target_type_check" CHECK ("generic_compatibility_relations"."target_type" in ('connector_standard', 'mounting_standard', 'media_format', 'operating_system', 'socket_type', 'cartridge_system', 'battery_platform', 'filter_standard', 'wireless_standard', 'fastener_standard')),
	CONSTRAINT "generic_compatibility_relations_condition_kinds_check" CHECK ("generic_compatibility_relations"."condition_kinds" <@ array['requires_adapter', 'requires_firmware_version', 'requires_additional_part', 'requires_professional_installation', 'requires_tool', 'market_restricted', 'quantity_required', 'excludes_configuration', 'production_period_restricted']::text[]),
	CONSTRAINT "generic_compatibility_relations_subject_check" CHECK (num_nonnulls("generic_compatibility_relations"."subject_product_id", "generic_compatibility_relations"."subject_variant_id") = 1),
	CONSTRAINT "generic_compatibility_relations_target_check" CHECK (case "generic_compatibility_relations"."target_kind"
        when 'canonical_family' then
          "generic_compatibility_relations"."target_family_id" is not null and "generic_compatibility_relations"."target_product_id" is null
          and "generic_compatibility_relations"."target_variant_id" is null and "generic_compatibility_relations"."target_type" is null and "generic_compatibility_relations"."target_key" is null
        when 'canonical_product' then
          "generic_compatibility_relations"."target_product_id" is not null and "generic_compatibility_relations"."target_family_id" is null
          and "generic_compatibility_relations"."target_variant_id" is null and "generic_compatibility_relations"."target_type" is null and "generic_compatibility_relations"."target_key" is null
        when 'canonical_variant' then
          "generic_compatibility_relations"."target_variant_id" is not null and "generic_compatibility_relations"."target_family_id" is null
          and "generic_compatibility_relations"."target_product_id" is null and "generic_compatibility_relations"."target_type" is null and "generic_compatibility_relations"."target_key" is null
        when 'typed' then
          "generic_compatibility_relations"."target_type" is not null and "generic_compatibility_relations"."target_key" is not null
          and "generic_compatibility_relations"."target_family_id" is null and "generic_compatibility_relations"."target_product_id" is null and "generic_compatibility_relations"."target_variant_id" is null
        else false
      end),
	CONSTRAINT "generic_compatibility_relations_target_key_shape_check" CHECK ("generic_compatibility_relations"."target_key" is null or "generic_compatibility_relations"."target_key" ~ '^[a-z0-9]+(_[a-z0-9]+)*(\.[a-z0-9]+(_[a-z0-9]+)*)+$'),
	CONSTRAINT "generic_compatibility_relations_distinct_endpoints_check" CHECK (("generic_compatibility_relations"."subject_product_id" is null or "generic_compatibility_relations"."target_product_id" is null or "generic_compatibility_relations"."subject_product_id" <> "generic_compatibility_relations"."target_product_id")
        and ("generic_compatibility_relations"."subject_variant_id" is null or "generic_compatibility_relations"."target_variant_id" is null or "generic_compatibility_relations"."subject_variant_id" <> "generic_compatibility_relations"."target_variant_id")),
	CONSTRAINT "generic_compatibility_relations_supersedes_other_check" CHECK ("generic_compatibility_relations"."superseded_by_id" is null or "generic_compatibility_relations"."superseded_by_id" <> "generic_compatibility_relations"."id"),
	CONSTRAINT "generic_compatibility_relations_partial_condition_check" CHECK ("generic_compatibility_relations"."applicability" <> 'partially_applies'
        or cardinality("generic_compatibility_relations"."condition_kinds") >= 1
        or "generic_compatibility_relations"."condition_note" is not null),
	CONSTRAINT "generic_compatibility_relations_verified_state_check" CHECK ("generic_compatibility_relations"."verification" <> 'verified'
        or ("generic_compatibility_relations"."verification_method" is not null and "generic_compatibility_relations"."verified_at" is not null and "generic_compatibility_relations"."verified_by_oxy_user_id" is not null)),
	CONSTRAINT "generic_compatibility_relations_revoked_state_check" CHECK ("generic_compatibility_relations"."verification" <> 'revoked'
        or ("generic_compatibility_relations"."revoked_at" is not null and "generic_compatibility_relations"."revoked_by_oxy_user_id" is not null and "generic_compatibility_relations"."valid_to" is not null)),
	CONSTRAINT "generic_compatibility_relations_confidence_range_check" CHECK ("generic_compatibility_relations"."confidence" is null or ("generic_compatibility_relations"."confidence" >= 0 and "generic_compatibility_relations"."confidence" <= 1)),
	CONSTRAINT "generic_compatibility_relations_confidence_machine_check" CHECK ("generic_compatibility_relations"."confidence" is null or "generic_compatibility_relations"."asserted_by_kind" in ('catalog_source', 'matcher')),
	CONSTRAINT "generic_compatibility_relations_source_presence_check" CHECK (("generic_compatibility_relations"."asserted_by_kind" = 'catalog_source') = ("generic_compatibility_relations"."asserted_by_source_id" is not null)),
	CONSTRAINT "generic_compatibility_relations_validity_order_check" CHECK ("generic_compatibility_relations"."valid_to" is null or "generic_compatibility_relations"."valid_to" > "generic_compatibility_relations"."valid_from"),
	CONSTRAINT "generic_compatibility_relations_markets_shape_check" CHECK (mercaria_immutable_array_to_string("generic_compatibility_relations"."markets", ',') ~ '^([A-Z]{2}(,[A-Z]{2})*)?$')
);
--> statement-breakpoint
CREATE TABLE "vehicle_configurations" (
	"id" text PRIMARY KEY NOT NULL,
	"generation_id" text NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"year_from" integer,
	"year_to" integer,
	"engine_code" text,
	"engine_displacement_cc" integer,
	"power_kw" integer,
	"fuel_type" text,
	"drivetrain" text,
	"transmission" text,
	"body_style" text,
	"doors" integer,
	"trim" text,
	"market" text,
	"status" text DEFAULT 'active' NOT NULL,
	"merged_into_id" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "vehicle_configurations_status_check" CHECK ("vehicle_configurations"."status" in ('active', 'merged', 'retired')),
	CONSTRAINT "vehicle_configurations_fuel_type_check" CHECK ("vehicle_configurations"."fuel_type" in ('petrol', 'diesel', 'hybrid', 'plug_in_hybrid', 'electric', 'hydrogen', 'lpg', 'cng', 'ethanol')),
	CONSTRAINT "vehicle_configurations_drivetrain_check" CHECK ("vehicle_configurations"."drivetrain" in ('fwd', 'rwd', 'awd', 'four_wd')),
	CONSTRAINT "vehicle_configurations_transmission_check" CHECK ("vehicle_configurations"."transmission" in ('manual', 'automatic', 'cvt', 'dual_clutch', 'single_speed')),
	CONSTRAINT "vehicle_configurations_body_style_check" CHECK ("vehicle_configurations"."body_style" in ('hatchback', 'saloon', 'estate', 'coupe', 'convertible', 'suv', 'mpv', 'pickup', 'van', 'roadster')),
	CONSTRAINT "vehicle_configurations_key_shape_check" CHECK ("vehicle_configurations"."key" ~ '^[a-z0-9]+(_[a-z0-9]+)*$'),
	CONSTRAINT "vehicle_configurations_name_check" CHECK (btrim("vehicle_configurations"."name") <> ''),
	CONSTRAINT "vehicle_configurations_from_year_check" CHECK ("vehicle_configurations"."year_from" is null or ("vehicle_configurations"."year_from" >= 1885 and "vehicle_configurations"."year_from" <= 2100)),
	CONSTRAINT "vehicle_configurations_to_year_check" CHECK ("vehicle_configurations"."year_to" is null or ("vehicle_configurations"."year_to" >= 1885 and "vehicle_configurations"."year_to" <= 2100)),
	CONSTRAINT "vehicle_configurations_year_order_check" CHECK ("vehicle_configurations"."year_from" is null or "vehicle_configurations"."year_to" is null or "vehicle_configurations"."year_to" >= "vehicle_configurations"."year_from"),
	CONSTRAINT "vehicle_configurations_displacement_check" CHECK ("vehicle_configurations"."engine_displacement_cc" is null or ("vehicle_configurations"."engine_displacement_cc" > 0 and "vehicle_configurations"."engine_displacement_cc" <= 20000)),
	CONSTRAINT "vehicle_configurations_power_check" CHECK ("vehicle_configurations"."power_kw" is null or ("vehicle_configurations"."power_kw" > 0 and "vehicle_configurations"."power_kw" <= 2000)),
	CONSTRAINT "vehicle_configurations_doors_check" CHECK ("vehicle_configurations"."doors" is null or ("vehicle_configurations"."doors" >= 1 and "vehicle_configurations"."doors" <= 8)),
	CONSTRAINT "vehicle_configurations_market_shape_check" CHECK ("vehicle_configurations"."market" is null or "vehicle_configurations"."market" ~ '^[A-Z]{2}$'),
	CONSTRAINT "vehicle_configurations_merged_state_check" CHECK (("vehicle_configurations"."status" = 'merged') = ("vehicle_configurations"."merged_into_id" is not null)),
	CONSTRAINT "vehicle_configurations_merged_self_check" CHECK ("vehicle_configurations"."merged_into_id" is null or "vehicle_configurations"."merged_into_id" <> "vehicle_configurations"."id")
);
--> statement-breakpoint
CREATE TABLE "vehicle_generations" (
	"id" text PRIMARY KEY NOT NULL,
	"model_id" text NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"chassis_code" text,
	"produced_from_year" integer,
	"produced_to_year" integer,
	"status" text DEFAULT 'active' NOT NULL,
	"merged_into_id" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "vehicle_generations_status_check" CHECK ("vehicle_generations"."status" in ('active', 'merged', 'retired')),
	CONSTRAINT "vehicle_generations_key_shape_check" CHECK ("vehicle_generations"."key" ~ '^[a-z0-9]+(_[a-z0-9]+)*$'),
	CONSTRAINT "vehicle_generations_name_check" CHECK (btrim("vehicle_generations"."name") <> ''),
	CONSTRAINT "vehicle_generations_from_year_check" CHECK ("vehicle_generations"."produced_from_year" is null or ("vehicle_generations"."produced_from_year" >= 1885 and "vehicle_generations"."produced_from_year" <= 2100)),
	CONSTRAINT "vehicle_generations_to_year_check" CHECK ("vehicle_generations"."produced_to_year" is null or ("vehicle_generations"."produced_to_year" >= 1885 and "vehicle_generations"."produced_to_year" <= 2100)),
	CONSTRAINT "vehicle_generations_year_order_check" CHECK ("vehicle_generations"."produced_from_year" is null or "vehicle_generations"."produced_to_year" is null or "vehicle_generations"."produced_to_year" >= "vehicle_generations"."produced_from_year"),
	CONSTRAINT "vehicle_generations_merged_state_check" CHECK (("vehicle_generations"."status" = 'merged') = ("vehicle_generations"."merged_into_id" is not null)),
	CONSTRAINT "vehicle_generations_merged_self_check" CHECK ("vehicle_generations"."merged_into_id" is null or "vehicle_generations"."merged_into_id" <> "vehicle_generations"."id")
);
--> statement-breakpoint
CREATE TABLE "vehicle_makes" (
	"id" text PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"country_code" text,
	"status" text DEFAULT 'active' NOT NULL,
	"merged_into_id" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "vehicle_makes_status_check" CHECK ("vehicle_makes"."status" in ('active', 'merged', 'retired')),
	CONSTRAINT "vehicle_makes_key_shape_check" CHECK ("vehicle_makes"."key" ~ '^[a-z0-9]+(_[a-z0-9]+)*$'),
	CONSTRAINT "vehicle_makes_name_check" CHECK (btrim("vehicle_makes"."name") <> ''),
	CONSTRAINT "vehicle_makes_country_shape_check" CHECK ("vehicle_makes"."country_code" is null or "vehicle_makes"."country_code" ~ '^[A-Z]{2}$'),
	CONSTRAINT "vehicle_makes_merged_state_check" CHECK (("vehicle_makes"."status" = 'merged') = ("vehicle_makes"."merged_into_id" is not null)),
	CONSTRAINT "vehicle_makes_merged_self_check" CHECK ("vehicle_makes"."merged_into_id" is null or "vehicle_makes"."merged_into_id" <> "vehicle_makes"."id")
);
--> statement-breakpoint
CREATE TABLE "vehicle_models" (
	"id" text PRIMARY KEY NOT NULL,
	"make_id" text NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"merged_into_id" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "vehicle_models_status_check" CHECK ("vehicle_models"."status" in ('active', 'merged', 'retired')),
	CONSTRAINT "vehicle_models_key_shape_check" CHECK ("vehicle_models"."key" ~ '^[a-z0-9]+(_[a-z0-9]+)*$'),
	CONSTRAINT "vehicle_models_name_check" CHECK (btrim("vehicle_models"."name") <> ''),
	CONSTRAINT "vehicle_models_merged_state_check" CHECK (("vehicle_models"."status" = 'merged') = ("vehicle_models"."merged_into_id" is not null)),
	CONSTRAINT "vehicle_models_merged_self_check" CHECK ("vehicle_models"."merged_into_id" is null or "vehicle_models"."merged_into_id" <> "vehicle_models"."id")
);
--> statement-breakpoint
ALTER TABLE "automotive_fitments" ADD CONSTRAINT "automotive_fitments_subject_product_id_canonical_products_id_fk" FOREIGN KEY ("subject_product_id") REFERENCES "public"."canonical_products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automotive_fitments" ADD CONSTRAINT "automotive_fitments_subject_variant_id_canonical_variants_id_fk" FOREIGN KEY ("subject_variant_id") REFERENCES "public"."canonical_variants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automotive_fitments" ADD CONSTRAINT "automotive_fitments_vehicle_make_id_vehicle_makes_id_fk" FOREIGN KEY ("vehicle_make_id") REFERENCES "public"."vehicle_makes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automotive_fitments" ADD CONSTRAINT "automotive_fitments_vehicle_model_id_vehicle_models_id_fk" FOREIGN KEY ("vehicle_model_id") REFERENCES "public"."vehicle_models"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automotive_fitments" ADD CONSTRAINT "automotive_fitments_vehicle_generation_id_vehicle_generations_id_fk" FOREIGN KEY ("vehicle_generation_id") REFERENCES "public"."vehicle_generations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automotive_fitments" ADD CONSTRAINT "automotive_fitments_vehicle_configuration_id_vehicle_configurations_id_fk" FOREIGN KEY ("vehicle_configuration_id") REFERENCES "public"."vehicle_configurations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automotive_fitments" ADD CONSTRAINT "automotive_fitments_asserted_by_source_id_catalog_sources_id_fk" FOREIGN KEY ("asserted_by_source_id") REFERENCES "public"."catalog_sources"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automotive_fitments" ADD CONSTRAINT "automotive_fitments_source_record_id_source_records_id_fk" FOREIGN KEY ("source_record_id") REFERENCES "public"."source_records"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automotive_fitments" ADD CONSTRAINT "automotive_fitments_superseded_by_id_automotive_fitments_id_fk" FOREIGN KEY ("superseded_by_id") REFERENCES "public"."automotive_fitments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compatibility_claims" ADD CONSTRAINT "compatibility_claims_subject_product_id_canonical_products_id_fk" FOREIGN KEY ("subject_product_id") REFERENCES "public"."canonical_products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compatibility_claims" ADD CONSTRAINT "compatibility_claims_subject_variant_id_canonical_variants_id_fk" FOREIGN KEY ("subject_variant_id") REFERENCES "public"."canonical_variants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compatibility_claims" ADD CONSTRAINT "compatibility_claims_relation_id_generic_compatibility_relations_id_fk" FOREIGN KEY ("relation_id") REFERENCES "public"."generic_compatibility_relations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compatibility_claims" ADD CONSTRAINT "compatibility_claims_fitment_id_automotive_fitments_id_fk" FOREIGN KEY ("fitment_id") REFERENCES "public"."automotive_fitments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compatibility_claims" ADD CONSTRAINT "compatibility_claims_asserted_by_source_id_catalog_sources_id_fk" FOREIGN KEY ("asserted_by_source_id") REFERENCES "public"."catalog_sources"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compatibility_claims" ADD CONSTRAINT "compatibility_claims_source_record_id_source_records_id_fk" FOREIGN KEY ("source_record_id") REFERENCES "public"."source_records"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generic_compatibility_relations" ADD CONSTRAINT "generic_compatibility_relations_subject_product_id_canonical_products_id_fk" FOREIGN KEY ("subject_product_id") REFERENCES "public"."canonical_products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generic_compatibility_relations" ADD CONSTRAINT "generic_compatibility_relations_subject_variant_id_canonical_variants_id_fk" FOREIGN KEY ("subject_variant_id") REFERENCES "public"."canonical_variants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generic_compatibility_relations" ADD CONSTRAINT "generic_compatibility_relations_target_family_id_canonical_product_families_id_fk" FOREIGN KEY ("target_family_id") REFERENCES "public"."canonical_product_families"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generic_compatibility_relations" ADD CONSTRAINT "generic_compatibility_relations_target_product_id_canonical_products_id_fk" FOREIGN KEY ("target_product_id") REFERENCES "public"."canonical_products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generic_compatibility_relations" ADD CONSTRAINT "generic_compatibility_relations_target_variant_id_canonical_variants_id_fk" FOREIGN KEY ("target_variant_id") REFERENCES "public"."canonical_variants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generic_compatibility_relations" ADD CONSTRAINT "generic_compatibility_relations_asserted_by_source_id_catalog_sources_id_fk" FOREIGN KEY ("asserted_by_source_id") REFERENCES "public"."catalog_sources"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generic_compatibility_relations" ADD CONSTRAINT "generic_compatibility_relations_superseded_by_id_generic_compatibility_relations_id_fk" FOREIGN KEY ("superseded_by_id") REFERENCES "public"."generic_compatibility_relations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicle_configurations" ADD CONSTRAINT "vehicle_configurations_generation_id_vehicle_generations_id_fk" FOREIGN KEY ("generation_id") REFERENCES "public"."vehicle_generations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicle_configurations" ADD CONSTRAINT "vehicle_configurations_merged_into_id_vehicle_configurations_id_fk" FOREIGN KEY ("merged_into_id") REFERENCES "public"."vehicle_configurations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicle_generations" ADD CONSTRAINT "vehicle_generations_model_id_vehicle_models_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."vehicle_models"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicle_generations" ADD CONSTRAINT "vehicle_generations_merged_into_id_vehicle_generations_id_fk" FOREIGN KEY ("merged_into_id") REFERENCES "public"."vehicle_generations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicle_makes" ADD CONSTRAINT "vehicle_makes_merged_into_id_vehicle_makes_id_fk" FOREIGN KEY ("merged_into_id") REFERENCES "public"."vehicle_makes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicle_models" ADD CONSTRAINT "vehicle_models_make_id_vehicle_makes_id_fk" FOREIGN KEY ("make_id") REFERENCES "public"."vehicle_makes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicle_models" ADD CONSTRAINT "vehicle_models_merged_into_id_vehicle_models_id_fk" FOREIGN KEY ("merged_into_id") REFERENCES "public"."vehicle_models"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "automotive_fitments_open_key" ON "automotive_fitments" USING btree ("fitment_key") WHERE "automotive_fitments"."valid_to" is null;--> statement-breakpoint
CREATE INDEX "automotive_fitments_configuration_idx" ON "automotive_fitments" USING btree ("vehicle_configuration_id","applicability","verification") WHERE "automotive_fitments"."vehicle_configuration_id" is not null;--> statement-breakpoint
CREATE INDEX "automotive_fitments_generation_idx" ON "automotive_fitments" USING btree ("vehicle_generation_id","applicability","verification") WHERE "automotive_fitments"."vehicle_generation_id" is not null;--> statement-breakpoint
CREATE INDEX "automotive_fitments_model_idx" ON "automotive_fitments" USING btree ("vehicle_model_id","applicability","verification") WHERE "automotive_fitments"."vehicle_model_id" is not null;--> statement-breakpoint
CREATE INDEX "automotive_fitments_make_idx" ON "automotive_fitments" USING btree ("vehicle_make_id","applicability","verification");--> statement-breakpoint
CREATE INDEX "automotive_fitments_subject_product_idx" ON "automotive_fitments" USING btree ("subject_product_id","applicability") WHERE "automotive_fitments"."subject_product_id" is not null;--> statement-breakpoint
CREATE INDEX "automotive_fitments_subject_variant_idx" ON "automotive_fitments" USING btree ("subject_variant_id","applicability") WHERE "automotive_fitments"."subject_variant_id" is not null;--> statement-breakpoint
CREATE INDEX "automotive_fitments_review_idx" ON "automotive_fitments" USING btree ("verification","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "compatibility_claims_selected_relation_key" ON "compatibility_claims" USING btree ("relation_id") WHERE "compatibility_claims"."state" = 'selected' and "compatibility_claims"."relation_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "compatibility_claims_selected_fitment_key" ON "compatibility_claims" USING btree ("fitment_id") WHERE "compatibility_claims"."state" = 'selected' and "compatibility_claims"."fitment_id" is not null;--> statement-breakpoint
CREATE INDEX "compatibility_claims_relation_idx" ON "compatibility_claims" USING btree ("relation_id","state") WHERE "compatibility_claims"."relation_id" is not null;--> statement-breakpoint
CREATE INDEX "compatibility_claims_fitment_idx" ON "compatibility_claims" USING btree ("fitment_id","state") WHERE "compatibility_claims"."fitment_id" is not null;--> statement-breakpoint
CREATE INDEX "compatibility_claims_subject_product_idx" ON "compatibility_claims" USING btree ("subject_product_id","state") WHERE "compatibility_claims"."subject_product_id" is not null;--> statement-breakpoint
CREATE INDEX "compatibility_claims_subject_variant_idx" ON "compatibility_claims" USING btree ("subject_variant_id","state") WHERE "compatibility_claims"."subject_variant_id" is not null;--> statement-breakpoint
CREATE INDEX "compatibility_claims_unresolved_idx" ON "compatibility_claims" USING btree ("unresolved_reason","asserted_by_source_id","created_at") WHERE "compatibility_claims"."state" = 'unresolved';--> statement-breakpoint
CREATE INDEX "compatibility_claims_source_record_idx" ON "compatibility_claims" USING btree ("source_record_id") WHERE "compatibility_claims"."source_record_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "generic_compatibility_relations_open_key" ON "generic_compatibility_relations" USING btree ("kind","relation_key") WHERE "generic_compatibility_relations"."valid_to" is null;--> statement-breakpoint
CREATE INDEX "generic_compatibility_relations_target_product_idx" ON "generic_compatibility_relations" USING btree ("target_product_id","kind","verification") WHERE "generic_compatibility_relations"."target_product_id" is not null;--> statement-breakpoint
CREATE INDEX "generic_compatibility_relations_target_variant_idx" ON "generic_compatibility_relations" USING btree ("target_variant_id","kind","verification") WHERE "generic_compatibility_relations"."target_variant_id" is not null;--> statement-breakpoint
CREATE INDEX "generic_compatibility_relations_target_family_idx" ON "generic_compatibility_relations" USING btree ("target_family_id","kind","verification") WHERE "generic_compatibility_relations"."target_family_id" is not null;--> statement-breakpoint
CREATE INDEX "generic_compatibility_relations_target_typed_idx" ON "generic_compatibility_relations" USING btree ("target_type","target_key","kind","verification") WHERE "generic_compatibility_relations"."target_type" is not null;--> statement-breakpoint
CREATE INDEX "generic_compatibility_relations_subject_product_idx" ON "generic_compatibility_relations" USING btree ("subject_product_id","kind","verification") WHERE "generic_compatibility_relations"."subject_product_id" is not null;--> statement-breakpoint
CREATE INDEX "generic_compatibility_relations_subject_variant_idx" ON "generic_compatibility_relations" USING btree ("subject_variant_id","kind","verification") WHERE "generic_compatibility_relations"."subject_variant_id" is not null;--> statement-breakpoint
CREATE INDEX "generic_compatibility_relations_review_idx" ON "generic_compatibility_relations" USING btree ("verification","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "vehicle_configurations_generation_key_key" ON "vehicle_configurations" USING btree ("generation_id","key");--> statement-breakpoint
CREATE INDEX "vehicle_configurations_generation_idx" ON "vehicle_configurations" USING btree ("generation_id","status","year_from");--> statement-breakpoint
CREATE INDEX "vehicle_configurations_year_idx" ON "vehicle_configurations" USING btree ("year_from","year_to");--> statement-breakpoint
CREATE UNIQUE INDEX "vehicle_generations_model_key_key" ON "vehicle_generations" USING btree ("model_id","key");--> statement-breakpoint
CREATE INDEX "vehicle_generations_model_idx" ON "vehicle_generations" USING btree ("model_id","status","produced_from_year");--> statement-breakpoint
CREATE UNIQUE INDEX "vehicle_makes_key_key" ON "vehicle_makes" USING btree ("key");--> statement-breakpoint
CREATE INDEX "vehicle_makes_status_idx" ON "vehicle_makes" USING btree ("status","name");--> statement-breakpoint
CREATE UNIQUE INDEX "vehicle_models_make_key_key" ON "vehicle_models" USING btree ("make_id","key");--> statement-breakpoint
CREATE INDEX "vehicle_models_make_idx" ON "vehicle_models" USING btree ("make_id","status","name");
--> statement-breakpoint
-- oxy:handwritten-begin=mercaria_vehicle_key_freeze
-- ---------------------------------------------------------------------------
-- ADR 0007 D1 rule 2: a stable machine key is FROZEN after insert.
--
-- A key exists so seeds, fixtures, external mappings and operator tooling can
-- name a concept without embedding a uuid. Renaming one is therefore not a
-- correction — to every seed and mapping that cited the old key it is
-- indistinguishable from the concept having been deleted and a different one
-- created, and the failure is silent: the mapping stops matching, the import
-- creates a duplicate, and nothing errors. A wrong key is corrected by a MERGE
-- (`status = 'merged'` plus `merged_into_id`), which keeps the loser resolvable.
--
-- One function, four triggers. `TG_TABLE_NAME` is in the message so an operator
-- reading the log knows which of the four ladder levels refused.
CREATE OR REPLACE FUNCTION mercaria_vehicle_key_freeze()
RETURNS trigger AS $$
BEGIN
  IF NEW.key IS DISTINCT FROM OLD.key THEN
    RAISE EXCEPTION 'a vehicle record''s key is frozen (% %): correct it with a merge, never a rename',
      TG_TABLE_NAME, OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER mercaria_vehicle_makes_key_freeze
BEFORE UPDATE ON "vehicle_makes"
FOR EACH ROW EXECUTE FUNCTION mercaria_vehicle_key_freeze();--> statement-breakpoint

CREATE TRIGGER mercaria_vehicle_models_key_freeze
BEFORE UPDATE ON "vehicle_models"
FOR EACH ROW EXECUTE FUNCTION mercaria_vehicle_key_freeze();--> statement-breakpoint

CREATE TRIGGER mercaria_vehicle_generations_key_freeze
BEFORE UPDATE ON "vehicle_generations"
FOR EACH ROW EXECUTE FUNCTION mercaria_vehicle_key_freeze();--> statement-breakpoint

CREATE TRIGGER mercaria_vehicle_configurations_key_freeze
BEFORE UPDATE ON "vehicle_configurations"
FOR EACH ROW EXECUTE FUNCTION mercaria_vehicle_key_freeze();
-- oxy:handwritten-end=mercaria_vehicle_key_freeze
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- oxy:handwritten-begin=mercaria_automotive_fitment_ancestry
-- ---------------------------------------------------------------------------
-- `automotive_fitments` names its make at EVERY scope, and the copy must agree
-- with the tree.
--
-- `vehicle_make_id` is denormalized on purpose — "which makes does this part
-- cover" is the first question a fitment surface asks, and without the column
-- that read is a three-level join per row. The cost of the denormalization is
-- that it can DISAGREE with the narrower target, and a fitment claiming a Ford
-- part fits a Volkswagen generation would render perfectly, sit in the make
-- index under Ford, and answer the vehicle picker under Volkswagen.
--
-- A CHECK cannot express this: it may not read another row. So the agreement is
-- a trigger, and it walks whichever pointers the scope shape has set —
-- `automotive_fitments_scope_shape_check` guarantees the ancestors are present
-- for the scope, so each branch below can rely on the level above it.
--
-- BEFORE INSERT OR UPDATE, and it compares rather than repairs: silently
-- rewriting `vehicle_make_id` to match would make a caller's mistake invisible,
-- and the caller is usually an importer whose mapping is wrong for every row in
-- the batch.
CREATE OR REPLACE FUNCTION mercaria_automotive_fitment_ancestry()
RETURNS trigger AS $$
DECLARE
  expected_model_id text;
  expected_generation_id text;
  expected_make_id text;
BEGIN
  IF NEW.vehicle_configuration_id IS NOT NULL THEN
    SELECT generation_id INTO expected_generation_id
    FROM vehicle_configurations WHERE id = NEW.vehicle_configuration_id;
    IF expected_generation_id IS DISTINCT FROM NEW.vehicle_generation_id THEN
      RAISE EXCEPTION 'fitment names configuration % under generation %, which is not its generation',
        NEW.vehicle_configuration_id, NEW.vehicle_generation_id
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;

  IF NEW.vehicle_generation_id IS NOT NULL THEN
    SELECT model_id INTO expected_model_id
    FROM vehicle_generations WHERE id = NEW.vehicle_generation_id;
    IF expected_model_id IS DISTINCT FROM NEW.vehicle_model_id THEN
      RAISE EXCEPTION 'fitment names generation % under model %, which is not its model',
        NEW.vehicle_generation_id, NEW.vehicle_model_id
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;

  IF NEW.vehicle_model_id IS NOT NULL THEN
    SELECT make_id INTO expected_make_id
    FROM vehicle_models WHERE id = NEW.vehicle_model_id;
    IF expected_make_id IS DISTINCT FROM NEW.vehicle_make_id THEN
      RAISE EXCEPTION 'fitment names model % under make %, which is not its make',
        NEW.vehicle_model_id, NEW.vehicle_make_id
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER mercaria_automotive_fitment_ancestry
BEFORE INSERT OR UPDATE ON "automotive_fitments"
FOR EACH ROW EXECUTE FUNCTION mercaria_automotive_fitment_ancestry();
-- oxy:handwritten-end=mercaria_automotive_fitment_ancestry
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- oxy:handwritten-begin=mercaria_compatibility_claims_raw_freeze
-- ---------------------------------------------------------------------------
-- What a source SAID is frozen; only what Mercaria decided about it moves.
--
-- ADR 0007 D7: "a canonical fact never overwrites the claim that disagreed with
-- it — both are retained, which is what makes a correction auditable." That
-- sentence is only true if the claim cannot be edited afterwards, and the edit
-- that would actually happen is not malice: it is a re-import that finds the row
-- and updates every column, quietly replacing the raw text an operator was about
-- to read with a newer source's wording.
--
-- `state`, `unresolved_reason`, `relation_id`, `fitment_id`, the review columns
-- and `updated_at` are what a selection or a review moves, and they are
-- deliberately NOT frozen. A repeat observation from the same source is a NEW
-- claim row whose predecessor becomes `superseded`, which is what keeps the
-- history readable.
--
-- DELETE is refused outright. An unresolved claim is the only evidence that a
-- source published something Mercaria could not read; removing it makes the next
-- import look like the first, and the count an operator uses to tell an
-- unmappable feed from an unmapped one silently resets to zero.
CREATE OR REPLACE FUNCTION mercaria_compatibility_claims_raw_freeze()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'compatibility claims are never deleted; a superseded claim keeps its row'
      USING ERRCODE = 'restrict_violation';
  END IF;
  -- IS DISTINCT FROM, never <>: `<>` against a NULL yields NULL, and `IF NOT
  -- (...)` treats a NULL condition as false — so the whole guard would silently
  -- permit every edit on any row with a NULL in it, which is most of them.
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.subject_product_id IS DISTINCT FROM OLD.subject_product_id
     OR NEW.subject_variant_id IS DISTINCT FROM OLD.subject_variant_id
     OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.raw_target_text IS DISTINCT FROM OLD.raw_target_text
     OR NEW.raw_qualifier_text IS DISTINCT FROM OLD.raw_qualifier_text
     OR NEW.asserted_by_kind IS DISTINCT FROM OLD.asserted_by_kind
     OR NEW.asserted_by_source_id IS DISTINCT FROM OLD.asserted_by_source_id
     OR NEW.source_record_id IS DISTINCT FROM OLD.source_record_id
     OR NEW.source_url IS DISTINCT FROM OLD.source_url
     OR NEW.content_sha256 IS DISTINCT FROM OLD.content_sha256
     OR NEW.observed_at IS DISTINCT FROM OLD.observed_at
     OR NEW.confidence IS DISTINCT FROM OLD.confidence
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'a compatibility claim records what a source said and is frozen; only its resolution and review may move'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER mercaria_compatibility_claims_raw_freeze
BEFORE UPDATE OR DELETE ON "compatibility_claims"
FOR EACH ROW EXECUTE FUNCTION mercaria_compatibility_claims_raw_freeze();
-- oxy:handwritten-end=mercaria_compatibility_claims_raw_freeze
