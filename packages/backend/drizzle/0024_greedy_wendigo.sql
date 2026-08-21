-- oxy:deploy-phase=pre
-- oxy:rollback=restore: five indexes including attribute_definitions_key_key and canonical_attribute_values_product_key are dropped and replaced with version-scoped forms, and three CHECKs are widened. Every previous definition is in 0019; re-creating the old unique indexes fails once a second definition version exists
--
-- #94: the versioned attribute registry and the #94 columns on the normalized
-- attribute values. ADDITIVE only, and correct against BOTH the image still
-- serving and the one arriving:
--
--   * six new tables, none of which the previous image reads or writes;
--   * new columns, every one nullable or defaulted;
--   * two CHECK replacements that WIDEN their value set
--     (`attribute_definitions_unit_family_check` gains eight families,
--     `canonical_variant_attrs_state_check` gains three refusal states) — every
--     value either image writes is in the new set;
--   * `canonical_attribute_values_parsed_check`, widened to cover the new typed
--     columns, which the previous image never fills;
--   * index REPLACEMENTS. `attribute_definitions_key_key` is dropped because
--     `(key, version)` supersedes it — the previous image writes one version per
--     key, so it is unaffected, and the new image cannot draft a second version
--     while it stands, which is why the drop belongs here rather than in the
--     `post` file. The value convergence and selection uniques gain
--     `value_slot`, a GENERATED column that reads `#0` for every row the
--     previous image writes, so those keep deduplicating exactly as before.
--
-- The NARROWING half of #94 — dropping `allowed_values`, `is_active` and
-- `selected`, and replacing the value-type CHECK with the new vocabulary — is
-- migration 0025, marked `post`, because each of those breaks a write the
-- previous image still performs.

CREATE TABLE "attribute_enum_values" (
	"id" text PRIMARY KEY NOT NULL,
	"attribute_definition_id" text NOT NULL,
	"value" text NOT NULL,
	"label" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "attribute_enum_values_normalized_check" CHECK ("attribute_enum_values"."value" = lower(btrim("attribute_enum_values"."value")) and "attribute_enum_values"."value" <> '')
);
--> statement-breakpoint
CREATE TABLE "attribute_labels" (
	"id" text PRIMARY KEY NOT NULL,
	"attribute_definition_id" text NOT NULL,
	"locale" text NOT NULL,
	"label" text NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "attribute_labels_locale_shape_check" CHECK ("attribute_labels"."locale" = lower(btrim("attribute_labels"."locale")) and "attribute_labels"."locale" ~ '^[a-z]{2,3}(-[a-z0-9]{2,8})*$')
);
--> statement-breakpoint
CREATE TABLE "attribute_reindex_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"entity_kind" text NOT NULL,
	"entity_id" text NOT NULL,
	"attribute_key" text,
	"definition_version" integer,
	"reason" text NOT NULL,
	"enqueued_at" timestamp with time zone NOT NULL,
	"claimed_at" timestamp with time zone,
	"claimed_by" text,
	"claim_expires_at" timestamp with time zone,
	"processed_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	CONSTRAINT "attribute_reindex_requests_entity_kind_check" CHECK ("attribute_reindex_requests"."entity_kind" in ('product', 'variant')),
	CONSTRAINT "attribute_reindex_requests_reason_check" CHECK ("attribute_reindex_requests"."reason" in ('selected_value_changed', 'definition_published', 'definition_deprecated', 'normalization_rules_changed', 'operator_correction')),
	CONSTRAINT "attribute_reindex_requests_attempts_check" CHECK ("attribute_reindex_requests"."attempts" >= 0),
	CONSTRAINT "attribute_reindex_requests_claim_check" CHECK (num_nonnulls("attribute_reindex_requests"."claimed_at", "attribute_reindex_requests"."claimed_by", "attribute_reindex_requests"."claim_expires_at") in (0, 3))
);
--> statement-breakpoint
CREATE TABLE "attribute_source_mappings" (
	"id" text PRIMARY KEY NOT NULL,
	"catalog_source_id" text NOT NULL,
	"source_field" text NOT NULL,
	"attribute_key" text NOT NULL,
	"assumed_unit" text,
	"component_axis" text,
	"category_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"note" text,
	"created_by_oxy_user_id" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "attribute_source_mappings_axis_check" CHECK ("attribute_source_mappings"."component_axis" in ('width', 'height', 'depth', 'diagonal', 'circumference')),
	CONSTRAINT "attribute_source_mappings_field_shape_check" CHECK ("attribute_source_mappings"."source_field" = lower(btrim("attribute_source_mappings"."source_field")) and "attribute_source_mappings"."source_field" <> ''),
	CONSTRAINT "attribute_source_mappings_key_shape_check" CHECK ("attribute_source_mappings"."attribute_key" ~ '^[a-z][a-z0-9_]*$')
);
--> statement-breakpoint
CREATE TABLE "attribute_value_aliases" (
	"id" text PRIMARY KEY NOT NULL,
	"attribute_definition_id" text NOT NULL,
	"enum_value_id" text NOT NULL,
	"alias" text NOT NULL,
	"normalized_alias" text GENERATED ALWAYS AS (lower(btrim("alias"))) STORED NOT NULL,
	"catalog_source_id" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "attribute_value_reviews" (
	"id" text PRIMARY KEY NOT NULL,
	"entity_kind" text NOT NULL,
	"entity_id" text NOT NULL,
	"attribute_key" text NOT NULL,
	"definition_version" integer NOT NULL,
	"reason" text NOT NULL,
	"state" text DEFAULT 'open' NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"summary" text NOT NULL,
	"resolved_value_id" text,
	"resolved_by_oxy_user_id" text,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "attribute_value_reviews_entity_kind_check" CHECK ("attribute_value_reviews"."entity_kind" in ('product', 'variant')),
	CONSTRAINT "attribute_value_reviews_reason_check" CHECK ("attribute_value_reviews"."reason" in ('conflicting_sources', 'implausible_value', 'unknown_unit', 'marketing_claim', 'invalid_category_attribute', 'definition_deprecated')),
	CONSTRAINT "attribute_value_reviews_state_check" CHECK ("attribute_value_reviews"."state" in ('open', 'resolved', 'dismissed')),
	CONSTRAINT "attribute_value_reviews_resolution_check" CHECK (("attribute_value_reviews"."state" = 'open') = ("attribute_value_reviews"."resolved_at" is null and "attribute_value_reviews"."resolved_by_oxy_user_id" is null)),
	CONSTRAINT "attribute_value_reviews_priority_check" CHECK ("attribute_value_reviews"."priority" >= 0)
);
--> statement-breakpoint
ALTER TABLE "attribute_definitions" DROP CONSTRAINT "attribute_definitions_unit_family_check";--> statement-breakpoint
ALTER TABLE "canonical_attribute_values" DROP CONSTRAINT "canonical_attribute_values_parsed_check";--> statement-breakpoint
ALTER TABLE "canonical_variant_attributes" DROP CONSTRAINT "canonical_variant_attrs_state_check";--> statement-breakpoint
DROP INDEX "attribute_definitions_key_key";--> statement-breakpoint
DROP INDEX "canonical_attribute_values_product_key";--> statement-breakpoint
DROP INDEX "canonical_attribute_values_variant_key";--> statement-breakpoint
DROP INDEX "canonical_attribute_values_product_selected_key";--> statement-breakpoint
DROP INDEX "canonical_attribute_values_variant_selected_key";--> statement-breakpoint
ALTER TABLE "attribute_definition_categories" ADD COLUMN "include_descendants" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "attribute_definitions" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "attribute_definitions" ADD COLUMN "lifecycle_state" text DEFAULT 'draft' NOT NULL;--> statement-breakpoint
ALTER TABLE "attribute_definitions" ADD COLUMN "cardinality" text DEFAULT 'single' NOT NULL;--> statement-breakpoint
ALTER TABLE "attribute_definitions" ADD COLUMN "objectivity" text DEFAULT 'objective' NOT NULL;--> statement-breakpoint
ALTER TABLE "attribute_definitions" ADD COLUMN "rating_scale_max" integer;--> statement-breakpoint
ALTER TABLE "attribute_definitions" ADD COLUMN "currency" text;--> statement-breakpoint
ALTER TABLE "attribute_definitions" ADD COLUMN "component_axes" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "attribute_definitions" ADD COLUMN "min_value" double precision;--> statement-breakpoint
ALTER TABLE "attribute_definitions" ADD COLUMN "max_value" double precision;--> statement-breakpoint
ALTER TABLE "attribute_definitions" ADD COLUMN "decimal_places" integer;--> statement-breakpoint
ALTER TABLE "attribute_definitions" ADD COLUMN "max_length" integer;--> statement-breakpoint
ALTER TABLE "attribute_definitions" ADD COLUMN "implausible_above" double precision;--> statement-breakpoint
ALTER TABLE "attribute_definitions" ADD COLUMN "implausible_below" double precision;--> statement-breakpoint
ALTER TABLE "attribute_definitions" ADD COLUMN "variant_defining" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "attribute_definitions" ADD COLUMN "filterable" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "attribute_definitions" ADD COLUMN "sortable" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "attribute_definitions" ADD COLUMN "comparable" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "attribute_definitions" ADD COLUMN "hard_constraint_capable" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "attribute_definitions" ADD COLUMN "display_policy" text DEFAULT 'public' NOT NULL;--> statement-breakpoint
ALTER TABLE "attribute_definitions" ADD COLUMN "evidence_policy" text DEFAULT 'source_required' NOT NULL;--> statement-breakpoint
ALTER TABLE "attribute_definitions" ADD COLUMN "created_by_oxy_user_id" text;--> statement-breakpoint
ALTER TABLE "attribute_definitions" ADD COLUMN "published_by_oxy_user_id" text;--> statement-breakpoint
ALTER TABLE "attribute_definitions" ADD COLUMN "published_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "attribute_definitions" ADD COLUMN "deprecated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "canonical_attribute_values" ADD COLUMN "definition_version" integer;--> statement-breakpoint
ALTER TABLE "canonical_attribute_values" ADD COLUMN "source_unit" text;--> statement-breakpoint
ALTER TABLE "canonical_attribute_values" ADD COLUMN "normalized_number_max" double precision;--> statement-breakpoint
ALTER TABLE "canonical_attribute_values" ADD COLUMN "range_lower_inclusive" boolean;--> statement-breakpoint
ALTER TABLE "canonical_attribute_values" ADD COLUMN "range_upper_inclusive" boolean;--> statement-breakpoint
ALTER TABLE "canonical_attribute_values" ADD COLUMN "normalized_date" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "canonical_attribute_values" ADD COLUMN "normalized_amount_minor" bigint;--> statement-breakpoint
ALTER TABLE "canonical_attribute_values" ADD COLUMN "normalized_currency" text;--> statement-breakpoint
ALTER TABLE "canonical_attribute_values" ADD COLUMN "component_axis" text;--> statement-breakpoint
ALTER TABLE "canonical_attribute_values" ADD COLUMN "position" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "canonical_attribute_values" ADD COLUMN "value_slot" text GENERATED ALWAYS AS (coalesce("component_axis", '') || '#' || "position"::text) STORED NOT NULL;--> statement-breakpoint
ALTER TABLE "canonical_attribute_values" ADD COLUMN "selection_state" text DEFAULT 'candidate' NOT NULL;--> statement-breakpoint
ALTER TABLE "canonical_attribute_values" ADD COLUMN "verification_state" text DEFAULT 'unverified' NOT NULL;--> statement-breakpoint
ALTER TABLE "canonical_attribute_values" ADD COLUMN "locale" text;--> statement-breakpoint
ALTER TABLE "canonical_attribute_values" ADD COLUMN "observed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "canonical_attribute_values" ADD COLUMN "method" text DEFAULT 'connector_declared' NOT NULL;--> statement-breakpoint
ALTER TABLE "canonical_attribute_values" ADD COLUMN "normalization_rule_version" text DEFAULT 'nr-1' NOT NULL;--> statement-breakpoint
ALTER TABLE "canonical_variant_attributes" ADD COLUMN "definition_version" integer;--> statement-breakpoint
ALTER TABLE "attribute_enum_values" ADD CONSTRAINT "attribute_enum_values_attribute_definition_id_attribute_definitions_id_fk" FOREIGN KEY ("attribute_definition_id") REFERENCES "public"."attribute_definitions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attribute_labels" ADD CONSTRAINT "attribute_labels_attribute_definition_id_attribute_definitions_id_fk" FOREIGN KEY ("attribute_definition_id") REFERENCES "public"."attribute_definitions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attribute_source_mappings" ADD CONSTRAINT "attribute_source_mappings_catalog_source_id_catalog_sources_id_fk" FOREIGN KEY ("catalog_source_id") REFERENCES "public"."catalog_sources"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attribute_value_aliases" ADD CONSTRAINT "attribute_value_aliases_attribute_definition_id_attribute_definitions_id_fk" FOREIGN KEY ("attribute_definition_id") REFERENCES "public"."attribute_definitions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attribute_value_aliases" ADD CONSTRAINT "attribute_value_aliases_enum_value_id_attribute_enum_values_id_fk" FOREIGN KEY ("enum_value_id") REFERENCES "public"."attribute_enum_values"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attribute_value_aliases" ADD CONSTRAINT "attribute_value_aliases_catalog_source_id_catalog_sources_id_fk" FOREIGN KEY ("catalog_source_id") REFERENCES "public"."catalog_sources"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "attribute_enum_values_value_key" ON "attribute_enum_values" USING btree ("attribute_definition_id","value");--> statement-breakpoint
CREATE INDEX "attribute_enum_values_position_idx" ON "attribute_enum_values" USING btree ("attribute_definition_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "attribute_labels_locale_key" ON "attribute_labels" USING btree ("attribute_definition_id","locale");--> statement-breakpoint
CREATE INDEX "attribute_reindex_requests_pending_idx" ON "attribute_reindex_requests" USING btree ("enqueued_at") WHERE "attribute_reindex_requests"."processed_at" is null;--> statement-breakpoint
CREATE INDEX "attribute_reindex_requests_entity_idx" ON "attribute_reindex_requests" USING btree ("entity_kind","entity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "attribute_source_mappings_field_key" ON "attribute_source_mappings" USING btree ("catalog_source_id","source_field");--> statement-breakpoint
CREATE INDEX "attribute_source_mappings_attribute_idx" ON "attribute_source_mappings" USING btree ("attribute_key");--> statement-breakpoint
CREATE UNIQUE INDEX "attribute_value_aliases_alias_key" ON "attribute_value_aliases" USING btree ("attribute_definition_id","normalized_alias");--> statement-breakpoint
CREATE INDEX "attribute_value_aliases_enum_value_idx" ON "attribute_value_aliases" USING btree ("enum_value_id");--> statement-breakpoint
CREATE UNIQUE INDEX "attribute_value_reviews_open_key" ON "attribute_value_reviews" USING btree ("entity_kind","entity_id","attribute_key") WHERE "attribute_value_reviews"."state" = 'open';--> statement-breakpoint
CREATE INDEX "attribute_value_reviews_queue_idx" ON "attribute_value_reviews" USING btree ("state","priority" DESC NULLS LAST,"created_at");--> statement-breakpoint
CREATE INDEX "attribute_value_reviews_attribute_idx" ON "attribute_value_reviews" USING btree ("attribute_key","state");--> statement-breakpoint
CREATE UNIQUE INDEX "attribute_definitions_key_version_key" ON "attribute_definitions" USING btree ("key","version");--> statement-breakpoint
CREATE UNIQUE INDEX "attribute_definitions_one_active_per_key" ON "attribute_definitions" USING btree ("key") WHERE "attribute_definitions"."lifecycle_state" = 'active';--> statement-breakpoint
CREATE INDEX "attribute_definitions_lifecycle_idx" ON "attribute_definitions" USING btree ("lifecycle_state","key");--> statement-breakpoint
CREATE INDEX "canonical_attribute_values_numeric_idx" ON "canonical_attribute_values" USING btree ("attribute_key","normalized_number") WHERE "canonical_attribute_values"."selection_state" = 'selected';--> statement-breakpoint
CREATE INDEX "canonical_attribute_values_review_idx" ON "canonical_attribute_values" USING btree ("attribute_key","selection_state") WHERE "canonical_attribute_values"."selection_state" = 'conflicting';--> statement-breakpoint
CREATE UNIQUE INDEX "canonical_attribute_values_product_key" ON "canonical_attribute_values" USING btree ("product_id","attribute_key","source_record_id","value_slot") WHERE "canonical_attribute_values"."product_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "canonical_attribute_values_variant_key" ON "canonical_attribute_values" USING btree ("variant_id","attribute_key","source_record_id","value_slot") WHERE "canonical_attribute_values"."variant_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "canonical_attribute_values_product_selected_key" ON "canonical_attribute_values" USING btree ("product_id","attribute_key","value_slot") WHERE "canonical_attribute_values"."selection_state" = 'selected' and "canonical_attribute_values"."product_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "canonical_attribute_values_variant_selected_key" ON "canonical_attribute_values" USING btree ("variant_id","attribute_key","value_slot") WHERE "canonical_attribute_values"."selection_state" = 'selected' and "canonical_attribute_values"."variant_id" is not null;--> statement-breakpoint
ALTER TABLE "attribute_definitions" ADD CONSTRAINT "attribute_definitions_lifecycle_check" CHECK ("attribute_definitions"."lifecycle_state" in ('draft', 'active', 'deprecated', 'retired'));--> statement-breakpoint
ALTER TABLE "attribute_definitions" ADD CONSTRAINT "attribute_definitions_cardinality_check" CHECK ("attribute_definitions"."cardinality" in ('single', 'set', 'ordered_list', 'range'));--> statement-breakpoint
ALTER TABLE "attribute_definitions" ADD CONSTRAINT "attribute_definitions_objectivity_check" CHECK ("attribute_definitions"."objectivity" in ('objective', 'subjective'));--> statement-breakpoint
ALTER TABLE "attribute_definitions" ADD CONSTRAINT "attribute_definitions_display_policy_check" CHECK ("attribute_definitions"."display_policy" in ('public', 'operator_only'));--> statement-breakpoint
ALTER TABLE "attribute_definitions" ADD CONSTRAINT "attribute_definitions_evidence_policy_check" CHECK ("attribute_definitions"."evidence_policy" in ('source_required', 'corroboration_required', 'operator_attested'));--> statement-breakpoint
ALTER TABLE "attribute_definitions" ADD CONSTRAINT "attribute_definitions_currency_check" CHECK ("attribute_definitions"."currency" in ('FAIR', 'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF', 'CNY', 'SEK', 'NOK', 'DKK', 'PLN', 'MXN', 'BRL', 'INR', 'NZD', 'ZAR', 'SGD', 'HKD', 'AED'));--> statement-breakpoint
ALTER TABLE "attribute_definitions" ADD CONSTRAINT "attribute_definitions_version_check" CHECK ("attribute_definitions"."version" >= 1);--> statement-breakpoint
ALTER TABLE "attribute_definitions" ADD CONSTRAINT "attribute_definitions_reserved_key_check" CHECK ("attribute_definitions"."key" <> all (array['price', 'sale_price', 'list_price', 'current_price', 'total_price', 'known_total', 'availability', 'in_stock', 'stock', 'stock_level', 'inventory', 'condition', 'shipping_cost', 'shipping_price', 'delivery_cost', 'delivery_days', 'lead_time', 'seller', 'merchant', 'offer_count']::text[]));--> statement-breakpoint
ALTER TABLE "attribute_definitions" ADD CONSTRAINT "attribute_definitions_rating_scale_check" CHECK (("attribute_definitions"."unit_family" is not distinct from 'rating') = ("attribute_definitions"."rating_scale_max" is not null));--> statement-breakpoint
ALTER TABLE "attribute_definitions" ADD CONSTRAINT "attribute_definitions_money_currency_check" CHECK (("attribute_definitions"."value_type" = 'money') = ("attribute_definitions"."currency" is not null));--> statement-breakpoint
ALTER TABLE "attribute_definitions" ADD CONSTRAINT "attribute_definitions_component_axes_check" CHECK (("attribute_definitions"."value_type" = 'structured') = (array_length("attribute_definitions"."component_axes", 1) is not null));--> statement-breakpoint
ALTER TABLE "attribute_definitions" ADD CONSTRAINT "attribute_definitions_axes_domain_check" CHECK ("attribute_definitions"."component_axes" <@ array['width', 'height', 'depth', 'diagonal', 'circumference']::text[]);--> statement-breakpoint
ALTER TABLE "attribute_definitions" ADD CONSTRAINT "attribute_definitions_bounds_order_check" CHECK ("attribute_definitions"."min_value" is null or "attribute_definitions"."max_value" is null or "attribute_definitions"."min_value" <= "attribute_definitions"."max_value");--> statement-breakpoint
ALTER TABLE "attribute_definitions" ADD CONSTRAINT "attribute_definitions_plausible_order_check" CHECK ("attribute_definitions"."implausible_below" is null or "attribute_definitions"."implausible_above" is null or "attribute_definitions"."implausible_below" <= "attribute_definitions"."implausible_above");--> statement-breakpoint
ALTER TABLE "attribute_definitions" ADD CONSTRAINT "attribute_definitions_decimal_places_check" CHECK ("attribute_definitions"."decimal_places" is null or ("attribute_definitions"."decimal_places" >= 0 and "attribute_definitions"."decimal_places" <= 12));--> statement-breakpoint
ALTER TABLE "attribute_definitions" ADD CONSTRAINT "attribute_definitions_max_length_check" CHECK ("attribute_definitions"."max_length" is null or ("attribute_definitions"."max_length" >= 1 and "attribute_definitions"."max_length" <= 4096));--> statement-breakpoint
ALTER TABLE "attribute_definitions" ADD CONSTRAINT "attribute_definitions_hard_constraint_check" CHECK ("attribute_definitions"."hard_constraint_capable" is false or ("attribute_definitions"."objectivity" = 'objective' and "attribute_definitions"."filterable"));--> statement-breakpoint
ALTER TABLE "attribute_definitions" ADD CONSTRAINT "attribute_definitions_published_audit_check" CHECK (("attribute_definitions"."lifecycle_state" = 'draft') = ("attribute_definitions"."published_at" is null));--> statement-breakpoint
ALTER TABLE "attribute_definitions" ADD CONSTRAINT "attribute_definitions_deprecated_at_check" CHECK ("attribute_definitions"."deprecated_at" is null or "attribute_definitions"."lifecycle_state" in ('deprecated', 'retired'));--> statement-breakpoint
ALTER TABLE "attribute_definitions" ADD CONSTRAINT "attribute_definitions_unit_family_check" CHECK ("attribute_definitions"."unit_family" in ('length', 'mass', 'volume', 'digital_storage', 'duration', 'power', 'energy', 'frequency', 'data_rate', 'pixel_count', 'luminance', 'electric_charge', 'count', 'percentage', 'ratio', 'rating'));--> statement-breakpoint
ALTER TABLE "canonical_attribute_values" ADD CONSTRAINT "canonical_attribute_values_selection_check" CHECK ("canonical_attribute_values"."selection_state" in ('selected', 'candidate', 'conflicting', 'superseded', 'rejected'));--> statement-breakpoint
ALTER TABLE "canonical_attribute_values" ADD CONSTRAINT "canonical_attribute_values_verification_check" CHECK ("canonical_attribute_values"."verification_state" in ('unverified', 'corroborated', 'operator_verified'));--> statement-breakpoint
ALTER TABLE "canonical_attribute_values" ADD CONSTRAINT "canonical_attribute_values_axis_check" CHECK ("canonical_attribute_values"."component_axis" in ('width', 'height', 'depth', 'diagonal', 'circumference'));--> statement-breakpoint
ALTER TABLE "canonical_attribute_values" ADD CONSTRAINT "canonical_attribute_values_method_check" CHECK ("canonical_attribute_values"."method" in ('deterministic_identifier', 'connector_declared', 'operator', 'heuristic'));--> statement-breakpoint
ALTER TABLE "canonical_attribute_values" ADD CONSTRAINT "canonical_attribute_values_normalized_currency_check" CHECK ("canonical_attribute_values"."normalized_currency" in ('FAIR', 'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF', 'CNY', 'SEK', 'NOK', 'DKK', 'PLN', 'MXN', 'BRL', 'INR', 'NZD', 'ZAR', 'SGD', 'HKD', 'AED'));--> statement-breakpoint
ALTER TABLE "canonical_attribute_values" ADD CONSTRAINT "canonical_attribute_values_range_check" CHECK (num_nonnulls("canonical_attribute_values"."normalized_number_max", "canonical_attribute_values"."range_lower_inclusive", "canonical_attribute_values"."range_upper_inclusive") in (0, 3));--> statement-breakpoint
ALTER TABLE "canonical_attribute_values" ADD CONSTRAINT "canonical_attribute_values_range_lower_check" CHECK ("canonical_attribute_values"."normalized_number_max" is null or ("canonical_attribute_values"."normalized_number" is not null and "canonical_attribute_values"."normalized_number" <= "canonical_attribute_values"."normalized_number_max"));--> statement-breakpoint
ALTER TABLE "canonical_attribute_values" ADD CONSTRAINT "canonical_attribute_values_money_check" CHECK (num_nonnulls("canonical_attribute_values"."normalized_amount_minor", "canonical_attribute_values"."normalized_currency") in (0, 2));--> statement-breakpoint
ALTER TABLE "canonical_attribute_values" ADD CONSTRAINT "canonical_attribute_values_position_check" CHECK ("canonical_attribute_values"."position" >= 0);--> statement-breakpoint
ALTER TABLE "canonical_attribute_values" ADD CONSTRAINT "canonical_attribute_values_selected_state_check" CHECK ("canonical_attribute_values"."selection_state" <> 'selected' or "canonical_attribute_values"."normalization_state" = 'normalized');--> statement-breakpoint
ALTER TABLE "canonical_attribute_values" ADD CONSTRAINT "canonical_attribute_values_parsed_check" CHECK ("canonical_attribute_values"."normalization_state" = 'normalized' or (
        "canonical_attribute_values"."normalized_text" is null and "canonical_attribute_values"."normalized_number" is null
        and "canonical_attribute_values"."normalized_number_max" is null and "canonical_attribute_values"."normalized_unit" is null
        and "canonical_attribute_values"."normalized_boolean" is null and "canonical_attribute_values"."normalized_date" is null
        and "canonical_attribute_values"."normalized_amount_minor" is null and "canonical_attribute_values"."normalized_currency" is null
      ));--> statement-breakpoint
ALTER TABLE "canonical_variant_attributes" ADD CONSTRAINT "canonical_variant_attrs_state_check" CHECK ("canonical_variant_attributes"."normalization_state" in ('normalized', 'unknown_unit', 'unparsed', 'out_of_range', 'implausible', 'marketing_claim'));

--> statement-breakpoint
-- The immutability trigger (#94 registry rule 12), hand-written like the
-- `fee_schedules_immutable_once_active` and ledger append-only triggers.
--
-- A definition version is editable only while `draft`. From the moment it is
-- published, every SEMANTIC column is frozen: what an attribute MEANS cannot
-- change under values already recorded against it, because those values cite
-- this version and would silently be reinterpreted. Changing the meaning is
-- publishing a NEW version, which is what makes a re-normalization a scheduled,
-- visible act instead of an invisible one.
--
-- Four columns stay movable, and each is bookkeeping about the version rather
-- than part of its meaning: `lifecycle_state`, `published_by_oxy_user_id`,
-- `published_at`, `deprecated_at` — plus `updated_at`, which drizzle maintains.
-- `label` and `description` are deliberately NOT frozen: "stored keys remain
-- stable when labels or descriptions change" is the registry's promise, and it
-- is only worth anything if a label can actually be corrected.
--
-- DELETE is refused outright for a published version: a stored value names its
-- version, and deleting the version would leave that value uninterpretable.
CREATE OR REPLACE FUNCTION mercaria_attribute_definition_immutable()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.lifecycle_state <> 'draft' THEN
      RAISE EXCEPTION
        'attribute_definitions % (%, v%) is % and cannot be deleted; stored values cite this version',
        OLD.id, OLD.key, OLD.version, OLD.lifecycle_state
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.lifecycle_state = 'draft' THEN
    RETURN NEW;
  END IF;

  IF NEW.key IS DISTINCT FROM OLD.key
     OR NEW.version IS DISTINCT FROM OLD.version
     OR NEW.value_type IS DISTINCT FROM OLD.value_type
     OR NEW.cardinality IS DISTINCT FROM OLD.cardinality
     OR NEW.objectivity IS DISTINCT FROM OLD.objectivity
     OR NEW.unit_family IS DISTINCT FROM OLD.unit_family
     OR NEW.base_unit IS DISTINCT FROM OLD.base_unit
     OR NEW.rating_scale_max IS DISTINCT FROM OLD.rating_scale_max
     OR NEW.currency IS DISTINCT FROM OLD.currency
     OR NEW.component_axes IS DISTINCT FROM OLD.component_axes
     OR NEW.min_value IS DISTINCT FROM OLD.min_value
     OR NEW.max_value IS DISTINCT FROM OLD.max_value
     OR NEW.decimal_places IS DISTINCT FROM OLD.decimal_places
     OR NEW.max_length IS DISTINCT FROM OLD.max_length
     OR NEW.implausible_above IS DISTINCT FROM OLD.implausible_above
     OR NEW.implausible_below IS DISTINCT FROM OLD.implausible_below
     OR NEW.variant_defining IS DISTINCT FROM OLD.variant_defining
     OR NEW.filterable IS DISTINCT FROM OLD.filterable
     OR NEW.sortable IS DISTINCT FROM OLD.sortable
     OR NEW.comparable IS DISTINCT FROM OLD.comparable
     OR NEW.hard_constraint_capable IS DISTINCT FROM OLD.hard_constraint_capable
     OR NEW.display_policy IS DISTINCT FROM OLD.display_policy
     OR NEW.evidence_policy IS DISTINCT FROM OLD.evidence_policy
     OR NEW.created_by_oxy_user_id IS DISTINCT FROM OLD.created_by_oxy_user_id
  THEN
    RAISE EXCEPTION
      'attribute_definitions % (%, v%) is % and its meaning is frozen; publish a new version instead',
      OLD.id, OLD.key, OLD.version, OLD.lifecycle_state
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
DROP TRIGGER IF EXISTS attribute_definitions_immutable_once_published ON "attribute_definitions";--> statement-breakpoint
CREATE TRIGGER attribute_definitions_immutable_once_published
  BEFORE UPDATE OR DELETE ON "attribute_definitions"
  FOR EACH ROW EXECUTE FUNCTION mercaria_attribute_definition_immutable();--> statement-breakpoint

-- The enum values and aliases of a PUBLISHED version are frozen too, and for
-- the same reason: an alias table that could change after publication would let
-- "USB C" resolve to a different canonical value than it did when a stored
-- value was normalized. The child tables carry no lifecycle of their own, so
-- the guard reads the parent's.
CREATE OR REPLACE FUNCTION mercaria_attribute_enum_frozen()
RETURNS trigger AS $$
DECLARE
  parent_state text;
  parent_id text;
BEGIN
  parent_id := COALESCE(NEW.attribute_definition_id, OLD.attribute_definition_id);
  SELECT lifecycle_state INTO parent_state
  FROM attribute_definitions WHERE id = parent_id;

  IF parent_state IS NOT NULL AND parent_state <> 'draft' THEN
    RAISE EXCEPTION
      'attribute definition % is % and its value vocabulary is frozen; publish a new version instead',
      parent_id, parent_state
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
DROP TRIGGER IF EXISTS attribute_enum_values_frozen ON "attribute_enum_values";--> statement-breakpoint
CREATE TRIGGER attribute_enum_values_frozen
  BEFORE INSERT OR UPDATE OR DELETE ON "attribute_enum_values"
  FOR EACH ROW EXECUTE FUNCTION mercaria_attribute_enum_frozen();--> statement-breakpoint
DROP TRIGGER IF EXISTS attribute_value_aliases_frozen ON "attribute_value_aliases";--> statement-breakpoint
CREATE TRIGGER attribute_value_aliases_frozen
  BEFORE INSERT OR UPDATE OR DELETE ON "attribute_value_aliases"
  FOR EACH ROW EXECUTE FUNCTION mercaria_attribute_enum_frozen();
