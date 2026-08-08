-- oxy:deploy-phase=pre
--
-- Mercaria's initial Postgres schema — 49 tables, created from nothing.
--
-- `pre` because it is purely additive: it creates tables the image currently
-- serving does not know about and cannot read, so applying it before the
-- rollout is correct against both images. Nothing here drops, renames or
-- narrows anything, because there is nothing yet to take away.
--
-- PostGIS is NOT created here. `db/migrate.ts` declares it as a required
-- EXTENSION and ensures it before any migration runs, so the ordering cannot be
-- got wrong by renumbering, squashing or regenerating this file. A new database
-- still needs a privileged role to install it once — `CREATE EXTENSION IF NOT
-- EXISTS` short-circuits before the privilege check, so it is a no-op for the
-- application role afterwards and a hard failure on an unprepared database.

CREATE TABLE "customers" (
	"id" text PRIMARY KEY NOT NULL,
	"store_id" text NOT NULL,
	"oxy_user_id" text,
	"is_walk_in" boolean DEFAULT false NOT NULL,
	"display_name" text,
	"email" text,
	"phone" text,
	"default_address_label" text,
	"default_address_recipient_name" text,
	"default_address_line1" text,
	"default_address_line2" text,
	"default_address_city" text,
	"default_address_region" text,
	"default_address_postal_code" text,
	"default_address_country" text,
	"default_address_phone" text,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"group_tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"stats_order_count" integer DEFAULT 0 NOT NULL,
	"stats_total_spent_amount" bigint NOT NULL,
	"stats_total_spent_currency" text NOT NULL,
	"stats_last_order_at" timestamp with time zone,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "customers_stats_total_spent_currency_check" CHECK ("customers"."stats_total_spent_currency" in ('FAIR', 'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF', 'CNY', 'SEK', 'NOK', 'DKK', 'PLN', 'MXN', 'BRL', 'INR', 'NZD', 'ZAR', 'SGD', 'HKD', 'AED'))
);
--> statement-breakpoint
CREATE TABLE "locations" (
	"id" text PRIMARY KEY NOT NULL,
	"store_id" text NOT NULL,
	"name" text NOT NULL,
	"type" text DEFAULT 'warehouse' NOT NULL,
	"address_label" text,
	"address_recipient_name" text,
	"address_line1" text,
	"address_line2" text,
	"address_city" text,
	"address_region" text,
	"address_postal_code" text,
	"address_country" text,
	"address_phone" text,
	"is_default" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"fulfills_online_orders" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "locations_type_check" CHECK ("locations"."type" in ('warehouse', 'retail', 'pop_up', 'virtual'))
);
--> statement-breakpoint
CREATE TABLE "store_members" (
	"id" text PRIMARY KEY NOT NULL,
	"store_id" text NOT NULL,
	"oxy_user_id" text NOT NULL,
	"role" text NOT NULL,
	"permissions" text[] DEFAULT '{}'::text[] NOT NULL,
	"invited_by" text,
	"joined_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "store_members_role_check" CHECK ("store_members"."role" in ('owner', 'admin', 'staff')),
	CONSTRAINT "store_members_permissions_check" CHECK ("store_members"."permissions" <@ array['store:manage', 'members:manage', 'products:read', 'products:write', 'inventory:write', 'locations:write', 'collections:write', 'discounts:write', 'settings:write', 'orders:read', 'orders:fulfill', 'stats:read', 'customers:read', 'customers:write', 'draft_orders:write', 'refunds:write', 'channels:write']::text[])
);
--> statement-breakpoint
CREATE TABLE "stores" (
	"id" text PRIMARY KEY NOT NULL,
	"handle" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"logo_file_id" text,
	"cover_file_id" text,
	"brand_color" text NOT NULL,
	"text_tone" text DEFAULT 'light' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"policies_return_window_days" integer DEFAULT 30 NOT NULL,
	"policies_shipping_note" text,
	"policies_refund_policy" text,
	"policies_privacy_policy" text,
	"policies_terms_of_service" text,
	"default_currency" text DEFAULT 'FAIR' NOT NULL,
	"tax_settings_prices_include_tax" boolean DEFAULT false NOT NULL,
	"tax_settings_tax_registration_id" text,
	"tax_settings_charge_tax_on_products" boolean DEFAULT true NOT NULL,
	"notification_settings_low_stock_alerts" boolean DEFAULT true NOT NULL,
	"notification_settings_order_emails" boolean DEFAULT true NOT NULL,
	"notification_settings_low_stock_threshold" integer,
	"rating" double precision DEFAULT 0 NOT NULL,
	"review_count" integer DEFAULT 0 NOT NULL,
	"product_count" integer DEFAULT 0 NOT NULL,
	"sales_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "stores_text_tone_check" CHECK ("stores"."text_tone" in ('light', 'dark')),
	CONSTRAINT "stores_status_check" CHECK ("stores"."status" in ('active', 'suspended', 'closed')),
	CONSTRAINT "stores_default_currency_check" CHECK ("stores"."default_currency" in ('FAIR', 'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF', 'CNY', 'SEK', 'NOK', 'DKK', 'PLN', 'MXN', 'BRL', 'INR', 'NZD', 'ZAR', 'SGD', 'HKD', 'AED'))
);
--> statement-breakpoint
CREATE TABLE "tax_rates" (
	"id" text PRIMARY KEY NOT NULL,
	"store_id" text NOT NULL,
	"name" text NOT NULL,
	"rate_bps" integer NOT NULL,
	"region_country" text,
	"region_region" text,
	"region_postal_code_pattern" text,
	"applies_to_shipping" boolean DEFAULT false NOT NULL,
	"product_type_scope" text[],
	"priority" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "channel_api_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"store_id" text NOT NULL,
	"connection_id" text,
	"hash" text NOT NULL,
	"prefix" text NOT NULL,
	"label" text NOT NULL,
	"scopes" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_by" text NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "channel_api_keys_scopes_check" CHECK ("channel_api_keys"."scopes" <@ array['channels:write']::text[])
);
--> statement-breakpoint
CREATE TABLE "connections" (
	"id" text PRIMARY KEY NOT NULL,
	"store_id" text NOT NULL,
	"provider" text NOT NULL,
	"mode" text NOT NULL,
	"status" text DEFAULT 'disconnected' NOT NULL,
	"credentials_ciphertext" text,
	"credentials_iv" text,
	"credentials_tag" text,
	"webhook_secret_ciphertext" text,
	"webhook_secret_iv" text,
	"webhook_secret_tag" text,
	"external_shop_id" text,
	"shop_domain" text,
	"shop_currency" text,
	"scopes" text[] DEFAULT '{}'::text[] NOT NULL,
	"sync_settings_products" text DEFAULT 'off' NOT NULL,
	"sync_settings_inventory" text DEFAULT 'off' NOT NULL,
	"sync_settings_orders" text DEFAULT 'off' NOT NULL,
	"sync_settings_auto_publish" boolean DEFAULT false NOT NULL,
	"sync_settings_target_location_id" text,
	"sync_settings_price_rules_markup_percent" double precision,
	"sync_settings_price_rules_rounding" text,
	"sync_settings_conflict_policy" text DEFAULT 'respect_overrides' NOT NULL,
	"sync_settings_collection_mapping" jsonb,
	"webhook_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"connected_at" timestamp with time zone NOT NULL,
	"last_sync_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "connections_provider_check" CHECK ("connections"."provider" in ('shopify', 'woocommerce', 'etsy', 'prestashop', 'magento')),
	CONSTRAINT "connections_mode_check" CHECK ("connections"."mode" in ('pull', 'push_in')),
	CONSTRAINT "connections_status_check" CHECK ("connections"."status" in ('connected', 'error', 'disconnected')),
	CONSTRAINT "connections_sync_products_check" CHECK ("connections"."sync_settings_products" in ('pull', 'push', 'bidirectional', 'off')),
	CONSTRAINT "connections_sync_inventory_check" CHECK ("connections"."sync_settings_inventory" in ('pull', 'push', 'bidirectional', 'off')),
	CONSTRAINT "connections_sync_orders_check" CHECK ("connections"."sync_settings_orders" in ('pull', 'push', 'bidirectional', 'off')),
	CONSTRAINT "connections_rounding_check" CHECK ("connections"."sync_settings_price_rules_rounding" in ('none', 'nearest', 'charm')),
	CONSTRAINT "connections_conflict_policy_check" CHECK ("connections"."sync_settings_conflict_policy" in ('connector_wins', 'respect_overrides')),
	CONSTRAINT "connections_credentials_complete_check" CHECK (num_nonnulls("connections"."credentials_ciphertext", "connections"."credentials_iv", "connections"."credentials_tag") in (0, 3)),
	CONSTRAINT "connections_webhook_secret_complete_check" CHECK (num_nonnulls("connections"."webhook_secret_ciphertext", "connections"."webhook_secret_iv", "connections"."webhook_secret_tag") in (0, 3))
);
--> statement-breakpoint
CREATE TABLE "sync_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"connection_id" text NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"counts_created" integer DEFAULT 0 NOT NULL,
	"counts_updated" integer DEFAULT 0 NOT NULL,
	"counts_skipped" integer DEFAULT 0 NOT NULL,
	"counts_failed" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	"error" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "sync_runs_kind_check" CHECK ("sync_runs"."kind" in ('backfill', 'product_pull', 'product_push', 'inventory_sync', 'order_sync', 'fulfillment_push', 'webhook', 'ingest')),
	CONSTRAINT "sync_runs_status_check" CHECK ("sync_runs"."status" in ('running', 'completed', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "categories" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"parent_id" text,
	"ancestor_slugs" text[] DEFAULT '{}'::text[] NOT NULL,
	"image_url" text,
	"image_file_id" text,
	"position" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inventory_levels" (
	"id" text PRIMARY KEY NOT NULL,
	"variant_id" text NOT NULL,
	"listing_id" text NOT NULL,
	"location_id" text NOT NULL,
	"available" integer DEFAULT 0 NOT NULL,
	"committed" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "listing_external_refs" (
	"id" text PRIMARY KEY NOT NULL,
	"listing_id" text NOT NULL,
	"connection_id" text NOT NULL,
	"provider" text NOT NULL,
	"external_id" text NOT NULL,
	"pushed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "listing_external_refs_provider_check" CHECK ("listing_external_refs"."provider" in ('shopify', 'woocommerce', 'etsy', 'prestashop', 'magento'))
);
--> statement-breakpoint
CREATE TABLE "listing_images" (
	"id" text PRIMARY KEY NOT NULL,
	"listing_id" text NOT NULL,
	"file_id" text NOT NULL,
	"alt" text,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "listing_options" (
	"id" text PRIMARY KEY NOT NULL,
	"listing_id" text NOT NULL,
	"name" text NOT NULL,
	"values" text[] DEFAULT '{}'::text[] NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "listings" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_type" text NOT NULL,
	"oxy_user_id" text,
	"store_id" text,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"condition" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"category_id" text,
	"category_slugs" text[] DEFAULT '{}'::text[] NOT NULL,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"price_range_min_amount" bigint,
	"price_range_min_currency" text,
	"price_range_max_amount" bigint,
	"price_range_max_currency" text,
	"has_inventory" boolean DEFAULT false NOT NULL,
	"variant_count" integer DEFAULT 0 NOT NULL,
	"longitude" double precision,
	"latitude" double precision,
	"geo" "geography" GENERATED ALWAYS AS (case when "listings"."longitude" is null or "listings"."latitude" is null then null
             else st_makepoint("listings"."longitude", "listings"."latitude")::geography end) STORED,
	"vendor" text,
	"product_type" text,
	"handle" text,
	"seo_title" text,
	"seo_description" text,
	"source_connection_id" text,
	"source_provider" text,
	"source_external_id" text,
	"source_external_updated_at" timestamp with time zone,
	"overridden_fields" text[] DEFAULT '{}'::text[] NOT NULL,
	"rating" double precision DEFAULT 0 NOT NULL,
	"review_count" integer DEFAULT 0 NOT NULL,
	"favorite_count" integer DEFAULT 0 NOT NULL,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"search_vector" "tsvector" GENERATED ALWAYS AS (to_tsvector('english', coalesce("listings"."title", '')) ||
            to_tsvector('english', coalesce("listings"."description", '')) ||
            array_to_tsvector(coalesce("listings"."tags", '{}'::text[]))) STORED,
	CONSTRAINT "listings_owner_type_check" CHECK ("listings"."owner_type" in ('user', 'store')),
	CONSTRAINT "listings_condition_check" CHECK ("listings"."condition" in ('new', 'used')),
	CONSTRAINT "listings_status_check" CHECK ("listings"."status" in ('draft', 'active', 'sold', 'archived', 'restricted')),
	CONSTRAINT "listings_source_provider_check" CHECK ("listings"."source_provider" in ('shopify', 'woocommerce', 'etsy', 'prestashop', 'magento')),
	CONSTRAINT "listings_price_range_min_currency_check" CHECK ("listings"."price_range_min_currency" in ('FAIR', 'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF', 'CNY', 'SEK', 'NOK', 'DKK', 'PLN', 'MXN', 'BRL', 'INR', 'NZD', 'ZAR', 'SGD', 'HKD', 'AED')),
	CONSTRAINT "listings_price_range_max_currency_check" CHECK ("listings"."price_range_max_currency" in ('FAIR', 'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF', 'CNY', 'SEK', 'NOK', 'DKK', 'PLN', 'MXN', 'BRL', 'INR', 'NZD', 'ZAR', 'SGD', 'HKD', 'AED')),
	CONSTRAINT "listings_owner_exclusivity_check" CHECK (("listings"."owner_type" = 'user' and "listings"."oxy_user_id" is not null and "listings"."store_id" is null)
          or ("listings"."owner_type" = 'store' and "listings"."store_id" is not null and "listings"."oxy_user_id" is null)),
	CONSTRAINT "listings_coordinates_check" CHECK (("listings"."longitude" is null) = ("listings"."latitude" is null))
);
--> statement-breakpoint
CREATE TABLE "product_variant_option_values" (
	"id" text PRIMARY KEY NOT NULL,
	"variant_id" text NOT NULL,
	"name" text NOT NULL,
	"value" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "product_variants" (
	"id" text PRIMARY KEY NOT NULL,
	"listing_id" text NOT NULL,
	"title" text DEFAULT 'Default Title' NOT NULL,
	"sku" text,
	"barcode" text,
	"price_amount" bigint,
	"price_currency" text,
	"compare_at_price_amount" bigint,
	"compare_at_price_currency" text,
	"inventory_tracked" boolean DEFAULT true NOT NULL,
	"inventory_available" integer DEFAULT 0 NOT NULL,
	"inventory_committed" integer DEFAULT 0 NOT NULL,
	"source_connection_id" text,
	"source_provider" text,
	"source_external_variant_id" text,
	"source_external_inventory_item_id" text,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "product_variants_source_provider_check" CHECK ("product_variants"."source_provider" in ('shopify', 'woocommerce', 'etsy', 'prestashop', 'magento')),
	CONSTRAINT "product_variants_price_currency_check" CHECK ("product_variants"."price_currency" in ('FAIR', 'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF', 'CNY', 'SEK', 'NOK', 'DKK', 'PLN', 'MXN', 'BRL', 'INR', 'NZD', 'ZAR', 'SGD', 'HKD', 'AED')),
	CONSTRAINT "product_variants_compare_at_price_currency_check" CHECK ("product_variants"."compare_at_price_currency" in ('FAIR', 'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF', 'CNY', 'SEK', 'NOK', 'DKK', 'PLN', 'MXN', 'BRL', 'INR', 'NZD', 'ZAR', 'SGD', 'HKD', 'AED')),
	CONSTRAINT "product_variants_price_paired_check" CHECK (("product_variants"."price_amount" is null) = ("product_variants"."price_currency" is null)),
	CONSTRAINT "product_variants_compare_at_price_paired_check" CHECK (("product_variants"."compare_at_price_amount" is null) = ("product_variants"."compare_at_price_currency" is null))
);
--> statement-breakpoint
CREATE TABLE "collection_rules" (
	"id" text PRIMARY KEY NOT NULL,
	"collection_id" text NOT NULL,
	"field" text NOT NULL,
	"operator" text NOT NULL,
	"value" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "collection_rules_field_check" CHECK ("collection_rules"."field" in ('title', 'productType', 'vendor', 'tag', 'price', 'categorySlug', 'compareAtPrice', 'inventory')),
	CONSTRAINT "collection_rules_operator_check" CHECK ("collection_rules"."operator" in ('equals', 'not_equals', 'contains', 'starts_with', 'ends_with', 'gt', 'lt', 'gte', 'lte'))
);
--> statement-breakpoint
CREATE TABLE "collections" (
	"id" text PRIMARY KEY NOT NULL,
	"store_id" text NOT NULL,
	"title" text NOT NULL,
	"handle" text NOT NULL,
	"description" text,
	"image_file_id" text,
	"type" text NOT NULL,
	"rules_applies_disjunctively" boolean DEFAULT false NOT NULL,
	"sort_order" text DEFAULT 'manual' NOT NULL,
	"seo_title" text,
	"seo_description" text,
	"is_published" boolean DEFAULT true NOT NULL,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "collections_type_check" CHECK ("collections"."type" in ('manual', 'automated')),
	CONSTRAINT "collections_sort_order_check" CHECK ("collections"."sort_order" in ('manual', 'best_selling', 'price_asc', 'price_desc', 'created_desc', 'title_asc'))
);
--> statement-breakpoint
CREATE TABLE "discount_codes" (
	"id" text PRIMARY KEY NOT NULL,
	"discount_id" text NOT NULL,
	"store_id" text NOT NULL,
	"code" text NOT NULL,
	"usage_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "discount_codes_usage_count_check" CHECK ("discount_codes"."usage_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "discounts" (
	"id" text PRIMARY KEY NOT NULL,
	"store_id" text NOT NULL,
	"title" text NOT NULL,
	"method" text NOT NULL,
	"value_type" text NOT NULL,
	"value" bigint NOT NULL,
	"applies_to_scope" text NOT NULL,
	"applies_to_product_ids" text[],
	"applies_to_collection_ids" text[],
	"buy_quantity" integer,
	"buy_scope" text,
	"buy_product_ids" text[],
	"buy_collection_ids" text[],
	"buy_discount_percent" integer,
	"get_quantity" integer,
	"get_scope" text,
	"get_product_ids" text[],
	"get_collection_ids" text[],
	"get_discount_percent" integer,
	"minimum_requirement_type" text,
	"minimum_requirement_value" bigint,
	"customer_eligibility_type" text,
	"customer_eligibility_customer_ids" text[],
	"customer_eligibility_group_tags" text[],
	"usage_limits_total_max" integer,
	"usage_limits_per_customer_max" integer,
	"combines_with_order_discounts" boolean DEFAULT false NOT NULL,
	"combines_with_product_discounts" boolean DEFAULT false NOT NULL,
	"combines_with_shipping_discounts" boolean DEFAULT false NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "discounts_id_store_id_key" UNIQUE("id","store_id"),
	CONSTRAINT "discounts_method_check" CHECK ("discounts"."method" in ('code', 'automatic')),
	CONSTRAINT "discounts_value_type_check" CHECK ("discounts"."value_type" in ('percentage', 'fixed_amount', 'bogo', 'free_item')),
	CONSTRAINT "discounts_applies_to_scope_check" CHECK ("discounts"."applies_to_scope" in ('order', 'products', 'collections')),
	CONSTRAINT "discounts_buy_scope_check" CHECK ("discounts"."buy_scope" in ('products', 'collections')),
	CONSTRAINT "discounts_get_scope_check" CHECK ("discounts"."get_scope" in ('products', 'collections')),
	CONSTRAINT "discounts_minimum_requirement_type_check" CHECK ("discounts"."minimum_requirement_type" in ('none', 'subtotal', 'quantity')),
	CONSTRAINT "discounts_customer_eligibility_type_check" CHECK ("discounts"."customer_eligibility_type" in ('all', 'groups', 'customers')),
	CONSTRAINT "discounts_window_check" CHECK ("discounts"."ends_at" is null or "discounts"."ends_at" >= "discounts"."starts_at")
);
--> statement-breakpoint
CREATE TABLE "listing_collections" (
	"listing_id" text NOT NULL,
	"collection_id" text NOT NULL,
	"position" integer,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "listing_collections_pkey" PRIMARY KEY("listing_id","collection_id")
);
--> statement-breakpoint
CREATE TABLE "order_applied_discounts" (
	"id" text PRIMARY KEY NOT NULL,
	"order_id" text NOT NULL,
	"discount_id" text NOT NULL,
	"code" text,
	"title" text NOT NULL,
	"value_type" text NOT NULL,
	"amount_amount" bigint NOT NULL,
	"amount_currency" text NOT NULL,
	"target" text NOT NULL,
	"target_line_index" integer,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "order_applied_discounts_value_type_check" CHECK ("order_applied_discounts"."value_type" in ('percentage', 'fixed_amount', 'bogo', 'free_item')),
	CONSTRAINT "order_applied_discounts_target_check" CHECK ("order_applied_discounts"."target" in ('order', 'line')),
	CONSTRAINT "order_applied_discounts_amount_currency_check" CHECK ("order_applied_discounts"."amount_currency" in ('FAIR', 'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF', 'CNY', 'SEK', 'NOK', 'DKK', 'PLN', 'MXN', 'BRL', 'INR', 'NZD', 'ZAR', 'SGD', 'HKD', 'AED')),
	CONSTRAINT "order_applied_discounts_target_line_check" CHECK (("order_applied_discounts"."target" = 'line') = ("order_applied_discounts"."target_line_index" is not null))
);
--> statement-breakpoint
CREATE TABLE "order_item_option_values" (
	"id" text PRIMARY KEY NOT NULL,
	"order_item_id" text NOT NULL,
	"name" text NOT NULL,
	"value" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "order_items" (
	"id" text PRIMARY KEY NOT NULL,
	"order_id" text NOT NULL,
	"listing_id" text NOT NULL,
	"variant_id" text NOT NULL,
	"title" text NOT NULL,
	"variant_title" text NOT NULL,
	"image_url" text,
	"unit_price_shop_amount" bigint NOT NULL,
	"unit_price_shop_currency" text NOT NULL,
	"unit_price_presentment_amount" bigint NOT NULL,
	"unit_price_presentment_currency" text NOT NULL,
	"quantity" integer NOT NULL,
	"line_total_shop_amount" bigint NOT NULL,
	"line_total_shop_currency" text NOT NULL,
	"line_total_presentment_amount" bigint NOT NULL,
	"line_total_presentment_currency" text NOT NULL,
	"discount_total_shop_amount" bigint,
	"discount_total_shop_currency" text,
	"discount_total_presentment_amount" bigint,
	"discount_total_presentment_currency" text,
	"location_id" text,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "order_items_unit_price_shop_currency_check" CHECK ("order_items"."unit_price_shop_currency" in ('FAIR', 'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF', 'CNY', 'SEK', 'NOK', 'DKK', 'PLN', 'MXN', 'BRL', 'INR', 'NZD', 'ZAR', 'SGD', 'HKD', 'AED')),
	CONSTRAINT "order_items_unit_price_presentment_currency_check" CHECK ("order_items"."unit_price_presentment_currency" in ('FAIR', 'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF', 'CNY', 'SEK', 'NOK', 'DKK', 'PLN', 'MXN', 'BRL', 'INR', 'NZD', 'ZAR', 'SGD', 'HKD', 'AED')),
	CONSTRAINT "order_items_line_total_shop_currency_check" CHECK ("order_items"."line_total_shop_currency" in ('FAIR', 'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF', 'CNY', 'SEK', 'NOK', 'DKK', 'PLN', 'MXN', 'BRL', 'INR', 'NZD', 'ZAR', 'SGD', 'HKD', 'AED')),
	CONSTRAINT "order_items_line_total_presentment_currency_check" CHECK ("order_items"."line_total_presentment_currency" in ('FAIR', 'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF', 'CNY', 'SEK', 'NOK', 'DKK', 'PLN', 'MXN', 'BRL', 'INR', 'NZD', 'ZAR', 'SGD', 'HKD', 'AED')),
	CONSTRAINT "order_items_discount_total_shop_currency_check" CHECK ("order_items"."discount_total_shop_currency" in ('FAIR', 'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF', 'CNY', 'SEK', 'NOK', 'DKK', 'PLN', 'MXN', 'BRL', 'INR', 'NZD', 'ZAR', 'SGD', 'HKD', 'AED')),
	CONSTRAINT "order_items_discount_total_presentment_currency_check" CHECK ("order_items"."discount_total_presentment_currency" in ('FAIR', 'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF', 'CNY', 'SEK', 'NOK', 'DKK', 'PLN', 'MXN', 'BRL', 'INR', 'NZD', 'ZAR', 'SGD', 'HKD', 'AED')),
	CONSTRAINT "order_items_quantity_check" CHECK ("order_items"."quantity" > 0),
	CONSTRAINT "order_items_discount_total_complete_check" CHECK (num_nonnulls("order_items"."discount_total_shop_amount", "order_items"."discount_total_shop_currency", "order_items"."discount_total_presentment_amount", "order_items"."discount_total_presentment_currency") in (0, 4))
);
--> statement-breakpoint
CREATE TABLE "order_status_history" (
	"id" text PRIMARY KEY NOT NULL,
	"order_id" text NOT NULL,
	"status" text NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"by_oxy_user_id" text,
	"note" text,
	CONSTRAINT "order_status_history_status_check" CHECK ("order_status_history"."status" in ('pending_payment', 'paid', 'processing', 'shipped', 'delivered', 'cancelled', 'refunded', 'partially_refunded'))
);
--> statement-breakpoint
CREATE TABLE "order_tax_lines" (
	"id" text PRIMARY KEY NOT NULL,
	"order_id" text NOT NULL,
	"name" text NOT NULL,
	"rate_bps" integer NOT NULL,
	"amount_amount" bigint NOT NULL,
	"amount_currency" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "order_tax_lines_amount_currency_check" CHECK ("order_tax_lines"."amount_currency" in ('FAIR', 'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF', 'CNY', 'SEK', 'NOK', 'DKK', 'PLN', 'MXN', 'BRL', 'INR', 'NZD', 'ZAR', 'SGD', 'HKD', 'AED'))
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" text PRIMARY KEY NOT NULL,
	"order_number" text NOT NULL,
	"buyer_oxy_user_id" text NOT NULL,
	"seller_type" text NOT NULL,
	"seller_oxy_user_id" text,
	"store_id" text,
	"customer_id" text,
	"source_channel" text DEFAULT 'storefront' NOT NULL,
	"source_connection_id" text,
	"source_provider" text,
	"source_external_id" text,
	"source_external_updated_at" timestamp with time zone,
	"shipping_address_label" text,
	"shipping_address_recipient_name" text NOT NULL,
	"shipping_address_line1" text NOT NULL,
	"shipping_address_line2" text,
	"shipping_address_city" text NOT NULL,
	"shipping_address_region" text,
	"shipping_address_postal_code" text NOT NULL,
	"shipping_address_country" text NOT NULL,
	"shipping_address_phone" text,
	"shipping_method" text NOT NULL,
	"shipping_label" text NOT NULL,
	"shipping_cost_shop_amount" bigint NOT NULL,
	"shipping_cost_shop_currency" text NOT NULL,
	"shipping_cost_presentment_amount" bigint NOT NULL,
	"shipping_cost_presentment_currency" text NOT NULL,
	"shipping_tracking_number" text,
	"totals_subtotal_shop_amount" bigint NOT NULL,
	"totals_subtotal_shop_currency" text NOT NULL,
	"totals_subtotal_presentment_amount" bigint NOT NULL,
	"totals_subtotal_presentment_currency" text NOT NULL,
	"totals_discount_total_shop_amount" bigint NOT NULL,
	"totals_discount_total_shop_currency" text NOT NULL,
	"totals_discount_total_presentment_amount" bigint NOT NULL,
	"totals_discount_total_presentment_currency" text NOT NULL,
	"totals_shipping_shop_amount" bigint NOT NULL,
	"totals_shipping_shop_currency" text NOT NULL,
	"totals_shipping_presentment_amount" bigint NOT NULL,
	"totals_shipping_presentment_currency" text NOT NULL,
	"totals_tax_shop_amount" bigint NOT NULL,
	"totals_tax_shop_currency" text NOT NULL,
	"totals_tax_presentment_amount" bigint NOT NULL,
	"totals_tax_presentment_currency" text NOT NULL,
	"totals_grand_total_shop_amount" bigint NOT NULL,
	"totals_grand_total_shop_currency" text NOT NULL,
	"totals_grand_total_presentment_amount" bigint NOT NULL,
	"totals_grand_total_presentment_currency" text NOT NULL,
	"fx_rate_from" text,
	"fx_rate_to" text,
	"fx_rate_rate" double precision,
	"fx_rate_as_of" text,
	"settlement_amount" bigint,
	"settlement_currency" text,
	"settlement_rate" double precision,
	"settlement_as_of" text,
	"status" text DEFAULT 'pending_payment' NOT NULL,
	"payment_status" text DEFAULT 'unpaid' NOT NULL,
	"payment_provider" text DEFAULT 'oxy_pay' NOT NULL,
	"payment_reference" text,
	"payment_paid_at" timestamp with time zone,
	"checkout_group_id" text,
	"idempotency_key" text,
	"moderation_hold" boolean,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "orders_seller_type_check" CHECK ("orders"."seller_type" in ('user', 'store')),
	CONSTRAINT "orders_source_channel_check" CHECK ("orders"."source_channel" in ('storefront', 'pos', 'draft')),
	CONSTRAINT "orders_source_provider_check" CHECK ("orders"."source_provider" in ('shopify', 'woocommerce', 'etsy', 'prestashop', 'magento')),
	CONSTRAINT "orders_shipping_method_check" CHECK ("orders"."shipping_method" in ('standard', 'express', 'pickup')),
	CONSTRAINT "orders_status_check" CHECK ("orders"."status" in ('pending_payment', 'paid', 'processing', 'shipped', 'delivered', 'cancelled', 'refunded', 'partially_refunded')),
	CONSTRAINT "orders_payment_status_check" CHECK ("orders"."payment_status" in ('unpaid', 'authorized', 'paid', 'refunded', 'failed')),
	CONSTRAINT "orders_payment_provider_check" CHECK ("orders"."payment_provider" in ('oxy_pay', 'external')),
	CONSTRAINT "orders_shipping_cost_shop_currency_check" CHECK ("orders"."shipping_cost_shop_currency" in ('FAIR', 'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF', 'CNY', 'SEK', 'NOK', 'DKK', 'PLN', 'MXN', 'BRL', 'INR', 'NZD', 'ZAR', 'SGD', 'HKD', 'AED')),
	CONSTRAINT "orders_shipping_cost_presentment_currency_check" CHECK ("orders"."shipping_cost_presentment_currency" in ('FAIR', 'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF', 'CNY', 'SEK', 'NOK', 'DKK', 'PLN', 'MXN', 'BRL', 'INR', 'NZD', 'ZAR', 'SGD', 'HKD', 'AED')),
	CONSTRAINT "orders_totals_subtotal_shop_currency_check" CHECK ("orders"."totals_subtotal_shop_currency" in ('FAIR', 'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF', 'CNY', 'SEK', 'NOK', 'DKK', 'PLN', 'MXN', 'BRL', 'INR', 'NZD', 'ZAR', 'SGD', 'HKD', 'AED')),
	CONSTRAINT "orders_totals_subtotal_presentment_currency_check" CHECK ("orders"."totals_subtotal_presentment_currency" in ('FAIR', 'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF', 'CNY', 'SEK', 'NOK', 'DKK', 'PLN', 'MXN', 'BRL', 'INR', 'NZD', 'ZAR', 'SGD', 'HKD', 'AED')),
	CONSTRAINT "orders_totals_discount_total_shop_currency_check" CHECK ("orders"."totals_discount_total_shop_currency" in ('FAIR', 'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF', 'CNY', 'SEK', 'NOK', 'DKK', 'PLN', 'MXN', 'BRL', 'INR', 'NZD', 'ZAR', 'SGD', 'HKD', 'AED')),
	CONSTRAINT "orders_totals_discount_total_presentment_currency_check" CHECK ("orders"."totals_discount_total_presentment_currency" in ('FAIR', 'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF', 'CNY', 'SEK', 'NOK', 'DKK', 'PLN', 'MXN', 'BRL', 'INR', 'NZD', 'ZAR', 'SGD', 'HKD', 'AED')),
	CONSTRAINT "orders_totals_shipping_shop_currency_check" CHECK ("orders"."totals_shipping_shop_currency" in ('FAIR', 'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF', 'CNY', 'SEK', 'NOK', 'DKK', 'PLN', 'MXN', 'BRL', 'INR', 'NZD', 'ZAR', 'SGD', 'HKD', 'AED')),
	CONSTRAINT "orders_totals_shipping_presentment_currency_check" CHECK ("orders"."totals_shipping_presentment_currency" in ('FAIR', 'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF', 'CNY', 'SEK', 'NOK', 'DKK', 'PLN', 'MXN', 'BRL', 'INR', 'NZD', 'ZAR', 'SGD', 'HKD', 'AED')),
	CONSTRAINT "orders_totals_tax_shop_currency_check" CHECK ("orders"."totals_tax_shop_currency" in ('FAIR', 'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF', 'CNY', 'SEK', 'NOK', 'DKK', 'PLN', 'MXN', 'BRL', 'INR', 'NZD', 'ZAR', 'SGD', 'HKD', 'AED')),
	CONSTRAINT "orders_totals_tax_presentment_currency_check" CHECK ("orders"."totals_tax_presentment_currency" in ('FAIR', 'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF', 'CNY', 'SEK', 'NOK', 'DKK', 'PLN', 'MXN', 'BRL', 'INR', 'NZD', 'ZAR', 'SGD', 'HKD', 'AED')),
	CONSTRAINT "orders_totals_grand_total_shop_currency_check" CHECK ("orders"."totals_grand_total_shop_currency" in ('FAIR', 'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF', 'CNY', 'SEK', 'NOK', 'DKK', 'PLN', 'MXN', 'BRL', 'INR', 'NZD', 'ZAR', 'SGD', 'HKD', 'AED')),
	CONSTRAINT "orders_totals_grand_total_presentment_currency_check" CHECK ("orders"."totals_grand_total_presentment_currency" in ('FAIR', 'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF', 'CNY', 'SEK', 'NOK', 'DKK', 'PLN', 'MXN', 'BRL', 'INR', 'NZD', 'ZAR', 'SGD', 'HKD', 'AED')),
	CONSTRAINT "orders_settlement_currency_check" CHECK ("orders"."settlement_currency" in ('FAIR', 'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF', 'CNY', 'SEK', 'NOK', 'DKK', 'PLN', 'MXN', 'BRL', 'INR', 'NZD', 'ZAR', 'SGD', 'HKD', 'AED')),
	CONSTRAINT "orders_fx_rate_from_check" CHECK ("orders"."fx_rate_from" in ('FAIR', 'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF', 'CNY', 'SEK', 'NOK', 'DKK', 'PLN', 'MXN', 'BRL', 'INR', 'NZD', 'ZAR', 'SGD', 'HKD', 'AED')),
	CONSTRAINT "orders_fx_rate_to_check" CHECK ("orders"."fx_rate_to" in ('FAIR', 'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF', 'CNY', 'SEK', 'NOK', 'DKK', 'PLN', 'MXN', 'BRL', 'INR', 'NZD', 'ZAR', 'SGD', 'HKD', 'AED')),
	CONSTRAINT "orders_seller_exclusivity_check" CHECK (("orders"."seller_type" = 'user' and "orders"."seller_oxy_user_id" is not null and "orders"."store_id" is null)
          or ("orders"."seller_type" = 'store' and "orders"."store_id" is not null and "orders"."seller_oxy_user_id" is null)),
	CONSTRAINT "orders_settlement_complete_check" CHECK (num_nonnulls("orders"."settlement_amount", "orders"."settlement_currency", "orders"."settlement_rate", "orders"."settlement_as_of") in (0, 4)),
	CONSTRAINT "orders_fx_rate_complete_check" CHECK (num_nonnulls("orders"."fx_rate_from", "orders"."fx_rate_to", "orders"."fx_rate_rate", "orders"."fx_rate_as_of") in (0, 4))
);
--> statement-breakpoint
CREATE TABLE "refund_line_items" (
	"id" text PRIMARY KEY NOT NULL,
	"refund_id" text NOT NULL,
	"variant_id" text NOT NULL,
	"quantity" integer NOT NULL,
	"amount_shop_amount" bigint NOT NULL,
	"amount_shop_currency" text NOT NULL,
	"amount_presentment_amount" bigint NOT NULL,
	"amount_presentment_currency" text NOT NULL,
	"restock" boolean DEFAULT false NOT NULL,
	"location_id" text,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "refund_line_items_amount_shop_currency_check" CHECK ("refund_line_items"."amount_shop_currency" in ('FAIR', 'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF', 'CNY', 'SEK', 'NOK', 'DKK', 'PLN', 'MXN', 'BRL', 'INR', 'NZD', 'ZAR', 'SGD', 'HKD', 'AED')),
	CONSTRAINT "refund_line_items_amount_presentment_currency_check" CHECK ("refund_line_items"."amount_presentment_currency" in ('FAIR', 'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF', 'CNY', 'SEK', 'NOK', 'DKK', 'PLN', 'MXN', 'BRL', 'INR', 'NZD', 'ZAR', 'SGD', 'HKD', 'AED')),
	CONSTRAINT "refund_line_items_quantity_check" CHECK ("refund_line_items"."quantity" > 0)
);
--> statement-breakpoint
CREATE TABLE "refunds" (
	"id" text PRIMARY KEY NOT NULL,
	"order_id" text NOT NULL,
	"store_id" text,
	"seller_oxy_user_id" text,
	"type" text DEFAULT 'refund' NOT NULL,
	"status" text DEFAULT 'refunded' NOT NULL,
	"reason" text,
	"refund_shipping_shop_amount" bigint,
	"refund_shipping_shop_currency" text,
	"refund_shipping_presentment_amount" bigint,
	"refund_shipping_presentment_currency" text,
	"total_refunded_shop_amount" bigint NOT NULL,
	"total_refunded_shop_currency" text NOT NULL,
	"total_refunded_presentment_amount" bigint NOT NULL,
	"total_refunded_presentment_currency" text NOT NULL,
	"restocked_at" timestamp with time zone,
	"processed_by_oxy_user_id" text,
	"rma_number" text,
	"idempotency_key" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "refunds_type_check" CHECK ("refunds"."type" in ('refund', 'return')),
	CONSTRAINT "refunds_status_check" CHECK ("refunds"."status" in ('requested', 'approved', 'restocked', 'refunded', 'rejected', 'cancelled')),
	CONSTRAINT "refunds_refund_shipping_shop_currency_check" CHECK ("refunds"."refund_shipping_shop_currency" in ('FAIR', 'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF', 'CNY', 'SEK', 'NOK', 'DKK', 'PLN', 'MXN', 'BRL', 'INR', 'NZD', 'ZAR', 'SGD', 'HKD', 'AED')),
	CONSTRAINT "refunds_refund_shipping_presentment_currency_check" CHECK ("refunds"."refund_shipping_presentment_currency" in ('FAIR', 'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF', 'CNY', 'SEK', 'NOK', 'DKK', 'PLN', 'MXN', 'BRL', 'INR', 'NZD', 'ZAR', 'SGD', 'HKD', 'AED')),
	CONSTRAINT "refunds_total_refunded_shop_currency_check" CHECK ("refunds"."total_refunded_shop_currency" in ('FAIR', 'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF', 'CNY', 'SEK', 'NOK', 'DKK', 'PLN', 'MXN', 'BRL', 'INR', 'NZD', 'ZAR', 'SGD', 'HKD', 'AED')),
	CONSTRAINT "refunds_total_refunded_presentment_currency_check" CHECK ("refunds"."total_refunded_presentment_currency" in ('FAIR', 'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF', 'CNY', 'SEK', 'NOK', 'DKK', 'PLN', 'MXN', 'BRL', 'INR', 'NZD', 'ZAR', 'SGD', 'HKD', 'AED')),
	CONSTRAINT "refunds_refund_shipping_complete_check" CHECK (num_nonnulls("refunds"."refund_shipping_shop_amount", "refunds"."refund_shipping_shop_currency", "refunds"."refund_shipping_presentment_amount", "refunds"."refund_shipping_presentment_currency") in (0, 4))
);
--> statement-breakpoint
CREATE TABLE "draft_order_applied_discounts" (
	"id" text PRIMARY KEY NOT NULL,
	"draft_order_id" text NOT NULL,
	"discount_id" text NOT NULL,
	"code" text,
	"title" text NOT NULL,
	"value_type" text NOT NULL,
	"amount_amount" bigint NOT NULL,
	"amount_currency" text NOT NULL,
	"target" text NOT NULL,
	"target_line_index" integer,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "draft_order_applied_discounts_value_type_check" CHECK ("draft_order_applied_discounts"."value_type" in ('percentage', 'fixed_amount', 'bogo', 'free_item')),
	CONSTRAINT "draft_order_applied_discounts_target_check" CHECK ("draft_order_applied_discounts"."target" in ('order', 'line')),
	CONSTRAINT "draft_order_applied_discounts_amount_currency_check" CHECK ("draft_order_applied_discounts"."amount_currency" in ('FAIR', 'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF', 'CNY', 'SEK', 'NOK', 'DKK', 'PLN', 'MXN', 'BRL', 'INR', 'NZD', 'ZAR', 'SGD', 'HKD', 'AED')),
	CONSTRAINT "draft_order_applied_discounts_target_line_check" CHECK (("draft_order_applied_discounts"."target" = 'line') = ("draft_order_applied_discounts"."target_line_index" is not null))
);
--> statement-breakpoint
CREATE TABLE "draft_order_line_item_option_values" (
	"id" text PRIMARY KEY NOT NULL,
	"draft_order_line_item_id" text NOT NULL,
	"name" text NOT NULL,
	"value" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "draft_order_line_items" (
	"id" text PRIMARY KEY NOT NULL,
	"draft_order_id" text NOT NULL,
	"listing_id" text NOT NULL,
	"variant_id" text NOT NULL,
	"title" text NOT NULL,
	"variant_title" text NOT NULL,
	"unit_price_amount" bigint NOT NULL,
	"unit_price_currency" text NOT NULL,
	"quantity" integer NOT NULL,
	"discount_total_amount" bigint,
	"discount_total_currency" text,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "draft_order_line_items_unit_price_currency_check" CHECK ("draft_order_line_items"."unit_price_currency" in ('FAIR', 'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF', 'CNY', 'SEK', 'NOK', 'DKK', 'PLN', 'MXN', 'BRL', 'INR', 'NZD', 'ZAR', 'SGD', 'HKD', 'AED')),
	CONSTRAINT "draft_order_line_items_discount_total_currency_check" CHECK ("draft_order_line_items"."discount_total_currency" in ('FAIR', 'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF', 'CNY', 'SEK', 'NOK', 'DKK', 'PLN', 'MXN', 'BRL', 'INR', 'NZD', 'ZAR', 'SGD', 'HKD', 'AED')),
	CONSTRAINT "draft_order_line_items_quantity_check" CHECK ("draft_order_line_items"."quantity" > 0),
	CONSTRAINT "draft_order_line_items_discount_total_complete_check" CHECK (num_nonnulls("draft_order_line_items"."discount_total_amount", "draft_order_line_items"."discount_total_currency") in (0, 2))
);
--> statement-breakpoint
CREATE TABLE "draft_order_tax_lines" (
	"id" text PRIMARY KEY NOT NULL,
	"draft_order_id" text NOT NULL,
	"name" text NOT NULL,
	"rate_bps" integer NOT NULL,
	"amount_amount" bigint NOT NULL,
	"amount_currency" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "draft_order_tax_lines_amount_currency_check" CHECK ("draft_order_tax_lines"."amount_currency" in ('FAIR', 'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF', 'CNY', 'SEK', 'NOK', 'DKK', 'PLN', 'MXN', 'BRL', 'INR', 'NZD', 'ZAR', 'SGD', 'HKD', 'AED'))
);
--> statement-breakpoint
CREATE TABLE "draft_orders" (
	"id" text PRIMARY KEY NOT NULL,
	"store_id" text NOT NULL,
	"location_id" text,
	"customer_id" text,
	"created_by_oxy_user_id" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"discount_codes" text[] DEFAULT '{}'::text[] NOT NULL,
	"shipping_address_label" text,
	"shipping_address_recipient_name" text,
	"shipping_address_line1" text,
	"shipping_address_line2" text,
	"shipping_address_city" text,
	"shipping_address_region" text,
	"shipping_address_postal_code" text,
	"shipping_address_country" text,
	"shipping_address_phone" text,
	"totals_subtotal_amount" bigint NOT NULL,
	"totals_subtotal_currency" text NOT NULL,
	"totals_discount_total_amount" bigint NOT NULL,
	"totals_discount_total_currency" text NOT NULL,
	"totals_tax_amount" bigint NOT NULL,
	"totals_tax_currency" text NOT NULL,
	"totals_shipping_amount" bigint NOT NULL,
	"totals_shipping_currency" text NOT NULL,
	"totals_grand_total_amount" bigint NOT NULL,
	"totals_grand_total_currency" text NOT NULL,
	"currency" text NOT NULL,
	"note" text,
	"converted_order_id" text,
	"idempotency_key" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "draft_orders_status_check" CHECK ("draft_orders"."status" in ('open', 'completed', 'cancelled')),
	CONSTRAINT "draft_orders_currency_check" CHECK ("draft_orders"."currency" in ('FAIR', 'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF', 'CNY', 'SEK', 'NOK', 'DKK', 'PLN', 'MXN', 'BRL', 'INR', 'NZD', 'ZAR', 'SGD', 'HKD', 'AED')),
	CONSTRAINT "draft_orders_totals_subtotal_currency_check" CHECK ("draft_orders"."totals_subtotal_currency" in ('FAIR', 'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF', 'CNY', 'SEK', 'NOK', 'DKK', 'PLN', 'MXN', 'BRL', 'INR', 'NZD', 'ZAR', 'SGD', 'HKD', 'AED')),
	CONSTRAINT "draft_orders_totals_discount_total_currency_check" CHECK ("draft_orders"."totals_discount_total_currency" in ('FAIR', 'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF', 'CNY', 'SEK', 'NOK', 'DKK', 'PLN', 'MXN', 'BRL', 'INR', 'NZD', 'ZAR', 'SGD', 'HKD', 'AED')),
	CONSTRAINT "draft_orders_totals_tax_currency_check" CHECK ("draft_orders"."totals_tax_currency" in ('FAIR', 'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF', 'CNY', 'SEK', 'NOK', 'DKK', 'PLN', 'MXN', 'BRL', 'INR', 'NZD', 'ZAR', 'SGD', 'HKD', 'AED')),
	CONSTRAINT "draft_orders_totals_shipping_currency_check" CHECK ("draft_orders"."totals_shipping_currency" in ('FAIR', 'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF', 'CNY', 'SEK', 'NOK', 'DKK', 'PLN', 'MXN', 'BRL', 'INR', 'NZD', 'ZAR', 'SGD', 'HKD', 'AED')),
	CONSTRAINT "draft_orders_totals_grand_total_currency_check" CHECK ("draft_orders"."totals_grand_total_currency" in ('FAIR', 'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF', 'CNY', 'SEK', 'NOK', 'DKK', 'PLN', 'MXN', 'BRL', 'INR', 'NZD', 'ZAR', 'SGD', 'HKD', 'AED')),
	CONSTRAINT "draft_orders_converted_order_check" CHECK (("draft_orders"."status" = 'completed') = ("draft_orders"."converted_order_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "addresses" (
	"id" text PRIMARY KEY NOT NULL,
	"oxy_user_id" text NOT NULL,
	"label" text,
	"recipient_name" text NOT NULL,
	"line1" text NOT NULL,
	"line2" text,
	"city" text NOT NULL,
	"region" text,
	"postal_code" text NOT NULL,
	"country" text NOT NULL,
	"phone" text,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cart_items" (
	"id" text PRIMARY KEY NOT NULL,
	"cart_id" text NOT NULL,
	"listing_id" text NOT NULL,
	"variant_id" text NOT NULL,
	"quantity" integer NOT NULL,
	"added_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "cart_items_quantity_check" CHECK ("cart_items"."quantity" > 0)
);
--> statement-breakpoint
CREATE TABLE "carts" (
	"id" text PRIMARY KEY NOT NULL,
	"oxy_user_id" text NOT NULL,
	"pending_discount_codes" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "favorites" (
	"id" text PRIMARY KEY NOT NULL,
	"oxy_user_id" text NOT NULL,
	"listing_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "feedback" (
	"id" text PRIMARY KEY NOT NULL,
	"oxy_user_id" text NOT NULL,
	"type" text NOT NULL,
	"rating" integer,
	"message" text NOT NULL,
	"email" text,
	"metadata_platform" text,
	"metadata_app_version" text,
	"metadata_device_info" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "feedback_type_check" CHECK ("feedback"."type" in ('bug', 'feature', 'improvement', 'other')),
	CONSTRAINT "feedback_status_check" CHECK ("feedback"."status" in ('pending', 'reviewed', 'resolved')),
	CONSTRAINT "feedback_rating_check" CHECK ("feedback"."rating" is null or "feedback"."rating" between 1 and 5)
);
--> statement-breakpoint
CREATE TABLE "reviews" (
	"id" text PRIMARY KEY NOT NULL,
	"author_oxy_user_id" text NOT NULL,
	"target_type" text NOT NULL,
	"listing_id" text,
	"store_id" text,
	"seller_oxy_user_id" text,
	"order_id" text,
	"rating" integer NOT NULL,
	"title" text,
	"body" text,
	"status" text DEFAULT 'published' NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "reviews_target_type_check" CHECK ("reviews"."target_type" in ('listing', 'store', 'seller')),
	CONSTRAINT "reviews_status_check" CHECK ("reviews"."status" in ('published', 'hidden')),
	CONSTRAINT "reviews_rating_check" CHECK ("reviews"."rating" between 1 and 5),
	CONSTRAINT "reviews_target_exclusivity_check" CHECK (("reviews"."target_type" = 'listing' and "reviews"."listing_id" is not null and "reviews"."store_id" is null and "reviews"."seller_oxy_user_id" is null)
          or ("reviews"."target_type" = 'store' and "reviews"."store_id" is not null and "reviews"."listing_id" is null and "reviews"."seller_oxy_user_id" is null)
          or ("reviews"."target_type" = 'seller' and "reviews"."seller_oxy_user_id" is not null and "reviews"."listing_id" is null and "reviews"."store_id" is null))
);
--> statement-breakpoint
CREATE TABLE "seller_profiles" (
	"id" text PRIMARY KEY NOT NULL,
	"oxy_user_id" text NOT NULL,
	"is_verified" boolean DEFAULT false NOT NULL,
	"rating" double precision DEFAULT 0 NOT NULL,
	"review_count" integer DEFAULT 0 NOT NULL,
	"sales_count" integer DEFAULT 0 NOT NULL,
	"shipping_prefs_note" text,
	"shipping_prefs_handling_days" integer,
	"return_prefs_accepts" boolean,
	"return_prefs_window_days" integer,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_preferences" (
	"id" text PRIMARY KEY NOT NULL,
	"oxy_user_id" text NOT NULL,
	"preferred_currency" text,
	"secondary_currency" text,
	"dual_display_enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "user_preferences_preferred_currency_check" CHECK ("user_preferences"."preferred_currency" in ('FAIR', 'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF', 'CNY', 'SEK', 'NOK', 'DKK', 'PLN', 'MXN', 'BRL', 'INR', 'NZD', 'ZAR', 'SGD', 'HKD', 'AED')),
	CONSTRAINT "user_preferences_secondary_currency_check" CHECK ("user_preferences"."secondary_currency" in ('FAIR', 'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF', 'CNY', 'SEK', 'NOK', 'DKK', 'PLN', 'MXN', 'BRL', 'INR', 'NZD', 'ZAR', 'SGD', 'HKD', 'AED'))
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" text PRIMARY KEY NOT NULL,
	"oxy_user_id" text NOT NULL,
	"type" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"data" jsonb,
	"channels" text[] DEFAULT '{}'::text[] NOT NULL,
	"delivery_status" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"priority" text DEFAULT 'normal' NOT NULL,
	"conversation_id" text,
	"expires_at" timestamp with time zone,
	"read_at" timestamp with time zone,
	"dismissed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "notifications_type_check" CHECK ("notifications"."type" in ('trigger_result', 'proactive_insight', 'daily_briefing', 'price_alert', 'integration_event', 'reminder', 'agent_task_complete', 'chat_response_ready', 'oxy_service', 'order_placed', 'order_paid', 'order_shipped', 'order_delivered', 'order_cancelled', 'listing_sold', 'review_received', 'store_member_invited', 'low_inventory', 'listing_changes_requested')),
	CONSTRAINT "notifications_status_check" CHECK ("notifications"."status" in ('pending', 'sent', 'read', 'dismissed')),
	CONSTRAINT "notifications_priority_check" CHECK ("notifications"."priority" in ('low', 'normal', 'high', 'urgent')),
	CONSTRAINT "notifications_channels_check" CHECK ("notifications"."channels" <@ array['push', 'telegram', 'discord', 'whatsapp', 'slack', 'in_app']::text[]),
	CONSTRAINT "notifications_dismissed_at_check" CHECK (("notifications"."status" = 'dismissed') = ("notifications"."dismissed_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "push_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"oxy_user_id" text NOT NULL,
	"token" text NOT NULL,
	"device_id" text,
	"platform" text,
	"active" boolean DEFAULT true NOT NULL,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "push_tokens_platform_check" CHECK ("push_tokens"."platform" in ('ios', 'android', 'web'))
);
--> statement-breakpoint
CREATE TABLE "web_push_subscriptions" (
	"id" text PRIMARY KEY NOT NULL,
	"oxy_user_id" text NOT NULL,
	"endpoint" text NOT NULL,
	"keys_p_256dh" text NOT NULL,
	"keys_auth" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "abuse_reports" (
	"id" text PRIMARY KEY NOT NULL,
	"reported_type" text NOT NULL,
	"reported_id" text NOT NULL,
	"reporter_oxy_user_id" text NOT NULL,
	"categories" text[] NOT NULL,
	"details" text,
	"local_status" text DEFAULT 'received' NOT NULL,
	"local_status_reason" text,
	"crowd_source_report_id" text,
	"crowd_source_case_id" text,
	"snapshot_hash" text,
	"delivered_at" timestamp with time zone,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "abuse_reports_reported_type_check" CHECK ("abuse_reports"."reported_type" in ('listing', 'review', 'seller', 'store')),
	CONSTRAINT "abuse_reports_local_status_check" CHECK ("abuse_reports"."local_status" in ('received', 'queued', 'delivered', 'delivery_failed', 'decided')),
	CONSTRAINT "abuse_reports_categories_check" CHECK ("abuse_reports"."categories" <@ array['counterfeit', 'prohibited_item', 'misleading_listing', 'unsafe_product', 'stolen_goods', 'scam', 'impersonation', 'spam', 'hateful_content', 'other']::text[]),
	CONSTRAINT "abuse_reports_categories_present_check" CHECK (array_length("abuse_reports"."categories", 1) >= 1),
	CONSTRAINT "abuse_reports_details_length_check" CHECK ("abuse_reports"."details" is null or length("abuse_reports"."details") <= 2000),
	CONSTRAINT "abuse_reports_local_status_reason_length_check" CHECK ("abuse_reports"."local_status_reason" is null or length("abuse_reports"."local_status_reason") <= 300)
);
--> statement-breakpoint
CREATE TABLE "moderation_enforcements" (
	"id" text PRIMARY KEY NOT NULL,
	"decision_id" text NOT NULL,
	"revision" integer NOT NULL,
	"action" text NOT NULL,
	"case_id" text,
	"subject_type" text NOT NULL,
	"subject_id" text NOT NULL,
	"applied" boolean NOT NULL,
	"reason" text NOT NULL,
	"recommended_action" text,
	"previous_state_listing_status" text,
	"previous_state_review_status" text,
	"previous_state_held_order_ids" text[],
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "moderation_enforcements_action_check" CHECK ("moderation_enforcements"."action" in ('restrict', 'request_changes', 'freeze_transaction', 'restore', 'manual_review', 'none')),
	CONSTRAINT "moderation_enforcements_subject_type_check" CHECK ("moderation_enforcements"."subject_type" in ('listing', 'review', 'seller', 'store')),
	CONSTRAINT "moderation_enforcements_previous_listing_status_check" CHECK ("moderation_enforcements"."previous_state_listing_status" in ('draft', 'active', 'sold', 'archived', 'restricted')),
	CONSTRAINT "moderation_enforcements_previous_review_status_check" CHECK ("moderation_enforcements"."previous_state_review_status" in ('published', 'hidden')),
	CONSTRAINT "moderation_enforcements_revision_check" CHECK ("moderation_enforcements"."revision" >= 0)
);
--> statement-breakpoint
CREATE TABLE "moderation_events" (
	"id" text PRIMARY KEY NOT NULL,
	"event_type" text NOT NULL,
	"claimed_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "moderation_outboxes" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone NOT NULL,
	"lease_owner" text,
	"lease_until" timestamp with time zone,
	"last_error" text,
	"processed_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "moderation_outboxes_kind_check" CHECK ("moderation_outboxes"."kind" in ('report.submit', 'decision.apply')),
	CONSTRAINT "moderation_outboxes_status_check" CHECK ("moderation_outboxes"."status" in ('pending', 'processing', 'processed', 'dead_letter')),
	CONSTRAINT "moderation_outboxes_attempts_check" CHECK ("moderation_outboxes"."attempts" >= 0),
	CONSTRAINT "moderation_outboxes_last_error_length_check" CHECK ("moderation_outboxes"."last_error" is null or length("moderation_outboxes"."last_error") <= 2000)
);
--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "locations" ADD CONSTRAINT "locations_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_members" ADD CONSTRAINT "store_members_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_rates" ADD CONSTRAINT "tax_rates_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_api_keys" ADD CONSTRAINT "channel_api_keys_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_api_keys" ADD CONSTRAINT "channel_api_keys_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_sync_settings_target_location_id_locations_id_fk" FOREIGN KEY ("sync_settings_target_location_id") REFERENCES "public"."locations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_runs" ADD CONSTRAINT "sync_runs_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "categories" ADD CONSTRAINT "categories_parent_id_categories_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."categories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_levels" ADD CONSTRAINT "inventory_levels_variant_id_product_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."product_variants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_levels" ADD CONSTRAINT "inventory_levels_listing_id_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."listings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_levels" ADD CONSTRAINT "inventory_levels_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listing_external_refs" ADD CONSTRAINT "listing_external_refs_listing_id_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."listings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listing_external_refs" ADD CONSTRAINT "listing_external_refs_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listing_images" ADD CONSTRAINT "listing_images_listing_id_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."listings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listing_options" ADD CONSTRAINT "listing_options_listing_id_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."listings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listings" ADD CONSTRAINT "listings_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listings" ADD CONSTRAINT "listings_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listings" ADD CONSTRAINT "listings_source_connection_id_connections_id_fk" FOREIGN KEY ("source_connection_id") REFERENCES "public"."connections"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_variant_option_values" ADD CONSTRAINT "product_variant_option_values_variant_id_product_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."product_variants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_variants" ADD CONSTRAINT "product_variants_listing_id_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."listings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_variants" ADD CONSTRAINT "product_variants_source_connection_id_connections_id_fk" FOREIGN KEY ("source_connection_id") REFERENCES "public"."connections"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collection_rules" ADD CONSTRAINT "collection_rules_collection_id_collections_id_fk" FOREIGN KEY ("collection_id") REFERENCES "public"."collections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collections" ADD CONSTRAINT "collections_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discount_codes" ADD CONSTRAINT "discount_codes_discount_id_store_id_fkey" FOREIGN KEY ("discount_id","store_id") REFERENCES "public"."discounts"("id","store_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discounts" ADD CONSTRAINT "discounts_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listing_collections" ADD CONSTRAINT "listing_collections_listing_id_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."listings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listing_collections" ADD CONSTRAINT "listing_collections_collection_id_collections_id_fk" FOREIGN KEY ("collection_id") REFERENCES "public"."collections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_applied_discounts" ADD CONSTRAINT "order_applied_discounts_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_item_option_values" ADD CONSTRAINT "order_item_option_values_order_item_id_order_items_id_fk" FOREIGN KEY ("order_item_id") REFERENCES "public"."order_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_status_history" ADD CONSTRAINT "order_status_history_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_tax_lines" ADD CONSTRAINT "order_tax_lines_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_source_connection_id_connections_id_fk" FOREIGN KEY ("source_connection_id") REFERENCES "public"."connections"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refund_line_items" ADD CONSTRAINT "refund_line_items_refund_id_refunds_id_fk" FOREIGN KEY ("refund_id") REFERENCES "public"."refunds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "draft_order_applied_discounts" ADD CONSTRAINT "draft_order_applied_discounts_draft_order_id_draft_orders_id_fk" FOREIGN KEY ("draft_order_id") REFERENCES "public"."draft_orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "draft_order_line_item_option_values" ADD CONSTRAINT "draft_order_line_item_option_values_draft_order_line_item_id_draft_order_line_items_id_fk" FOREIGN KEY ("draft_order_line_item_id") REFERENCES "public"."draft_order_line_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "draft_order_line_items" ADD CONSTRAINT "draft_order_line_items_draft_order_id_draft_orders_id_fk" FOREIGN KEY ("draft_order_id") REFERENCES "public"."draft_orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "draft_order_tax_lines" ADD CONSTRAINT "draft_order_tax_lines_draft_order_id_draft_orders_id_fk" FOREIGN KEY ("draft_order_id") REFERENCES "public"."draft_orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "draft_orders" ADD CONSTRAINT "draft_orders_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "draft_orders" ADD CONSTRAINT "draft_orders_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "draft_orders" ADD CONSTRAINT "draft_orders_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "draft_orders" ADD CONSTRAINT "draft_orders_converted_order_id_orders_id_fk" FOREIGN KEY ("converted_order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cart_items" ADD CONSTRAINT "cart_items_cart_id_carts_id_fk" FOREIGN KEY ("cart_id") REFERENCES "public"."carts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cart_items" ADD CONSTRAINT "cart_items_listing_id_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."listings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cart_items" ADD CONSTRAINT "cart_items_variant_id_product_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."product_variants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "favorites" ADD CONSTRAINT "favorites_listing_id_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."listings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_listing_id_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."listings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "customers_store_id_oxy_user_id_key" ON "customers" USING btree ("store_id","oxy_user_id") WHERE "customers"."oxy_user_id" is not null;--> statement-breakpoint
CREATE INDEX "customers_store_id_email_idx" ON "customers" USING btree ("store_id","email") WHERE "customers"."email" is not null;--> statement-breakpoint
CREATE INDEX "customers_tags_idx" ON "customers" USING gin ("tags");--> statement-breakpoint
CREATE INDEX "customers_store_id_created_at_idx" ON "customers" USING btree ("store_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "locations_store_id_is_default_idx" ON "locations" USING btree ("store_id","is_default" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "locations_store_id_is_active_idx" ON "locations" USING btree ("store_id","is_active");--> statement-breakpoint
CREATE UNIQUE INDEX "locations_store_id_default_key" ON "locations" USING btree ("store_id") WHERE "locations"."is_default";--> statement-breakpoint
CREATE UNIQUE INDEX "store_members_store_id_oxy_user_id_key" ON "store_members" USING btree ("store_id","oxy_user_id");--> statement-breakpoint
CREATE INDEX "store_members_oxy_user_id_idx" ON "store_members" USING btree ("oxy_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "stores_handle_key" ON "stores" USING btree ("handle");--> statement-breakpoint
CREATE INDEX "stores_status_created_at_idx" ON "stores" USING btree ("status","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "tax_rates_store_id_is_active_idx" ON "tax_rates" USING btree ("store_id","is_active");--> statement-breakpoint
CREATE INDEX "tax_rates_store_id_region_idx" ON "tax_rates" USING btree ("store_id","region_country","region_region");--> statement-breakpoint
CREATE INDEX "channel_api_keys_store_id_idx" ON "channel_api_keys" USING btree ("store_id");--> statement-breakpoint
CREATE UNIQUE INDEX "channel_api_keys_hash_key" ON "channel_api_keys" USING btree ("hash");--> statement-breakpoint
CREATE INDEX "channel_api_keys_prefix_idx" ON "channel_api_keys" USING btree ("prefix");--> statement-breakpoint
CREATE UNIQUE INDEX "connections_store_id_provider_key" ON "connections" USING btree ("store_id","provider");--> statement-breakpoint
CREATE INDEX "sync_runs_connection_id_started_at_idx" ON "sync_runs" USING btree ("connection_id","started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "categories_slug_key" ON "categories" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "categories_parent_id_position_idx" ON "categories" USING btree ("parent_id","position");--> statement-breakpoint
CREATE INDEX "categories_ancestor_slugs_idx" ON "categories" USING gin ("ancestor_slugs");--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_levels_variant_id_location_id_key" ON "inventory_levels" USING btree ("variant_id","location_id");--> statement-breakpoint
CREATE INDEX "inventory_levels_location_id_available_idx" ON "inventory_levels" USING btree ("location_id","available");--> statement-breakpoint
CREATE INDEX "inventory_levels_listing_id_idx" ON "inventory_levels" USING btree ("listing_id");--> statement-breakpoint
CREATE INDEX "listing_external_refs_listing_id_idx" ON "listing_external_refs" USING btree ("listing_id");--> statement-breakpoint
CREATE UNIQUE INDEX "listing_external_refs_connection_id_external_id_key" ON "listing_external_refs" USING btree ("connection_id","external_id");--> statement-breakpoint
CREATE INDEX "listing_images_listing_id_position_idx" ON "listing_images" USING btree ("listing_id","position");--> statement-breakpoint
CREATE INDEX "listing_options_listing_id_position_idx" ON "listing_options" USING btree ("listing_id","position");--> statement-breakpoint
CREATE INDEX "listings_status_published_at_id_idx" ON "listings" USING btree ("status","published_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "listings_status_category_id_published_at_id_idx" ON "listings" USING btree ("status","category_id","published_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "listings_status_price_published_at_idx" ON "listings" USING btree ("status","price_range_min_amount","published_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "listings_owner_store_status_published_at_id_idx" ON "listings" USING btree ("owner_type","store_id","status","published_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "listings_owner_user_status_published_at_id_idx" ON "listings" USING btree ("owner_type","oxy_user_id","status","published_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "listings_category_slugs_idx" ON "listings" USING gin ("category_slugs");--> statement-breakpoint
CREATE INDEX "listings_tags_idx" ON "listings" USING gin ("tags");--> statement-breakpoint
CREATE INDEX "listings_search_vector_idx" ON "listings" USING gin ("search_vector");--> statement-breakpoint
CREATE INDEX "listings_geo_idx" ON "listings" USING gist ("geo");--> statement-breakpoint
CREATE INDEX "listings_store_id_vendor_idx" ON "listings" USING btree ("store_id","vendor");--> statement-breakpoint
CREATE INDEX "listings_store_id_product_type_idx" ON "listings" USING btree ("store_id","product_type");--> statement-breakpoint
CREATE UNIQUE INDEX "listings_store_id_handle_key" ON "listings" USING btree ("store_id","handle") WHERE "listings"."handle" is not null;--> statement-breakpoint
CREATE INDEX "listings_store_id_source_key_idx" ON "listings" USING btree ("store_id","source_connection_id","source_external_id") WHERE "listings"."source_external_id" is not null;--> statement-breakpoint
CREATE INDEX "product_variant_option_values_variant_id_position_idx" ON "product_variant_option_values" USING btree ("variant_id","position");--> statement-breakpoint
CREATE INDEX "product_variants_listing_id_position_idx" ON "product_variants" USING btree ("listing_id","position");--> statement-breakpoint
CREATE INDEX "product_variants_listing_id_available_idx" ON "product_variants" USING btree ("listing_id","inventory_available");--> statement-breakpoint
CREATE UNIQUE INDEX "product_variants_sku_key" ON "product_variants" USING btree ("sku") WHERE "product_variants"."sku" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "product_variants_barcode_key" ON "product_variants" USING btree ("barcode") WHERE "product_variants"."barcode" is not null;--> statement-breakpoint
CREATE INDEX "product_variants_source_inventory_item_idx" ON "product_variants" USING btree ("source_connection_id","source_external_inventory_item_id") WHERE "product_variants"."source_external_inventory_item_id" is not null;--> statement-breakpoint
CREATE INDEX "collection_rules_collection_id_position_idx" ON "collection_rules" USING btree ("collection_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "collections_store_id_handle_key" ON "collections" USING btree ("store_id","handle");--> statement-breakpoint
CREATE INDEX "collections_store_id_is_published_idx" ON "collections" USING btree ("store_id","is_published");--> statement-breakpoint
CREATE UNIQUE INDEX "discount_codes_store_id_code_key" ON "discount_codes" USING btree ("store_id","code");--> statement-breakpoint
CREATE INDEX "discount_codes_discount_id_idx" ON "discount_codes" USING btree ("discount_id");--> statement-breakpoint
CREATE INDEX "discounts_store_id_is_active_method_idx" ON "discounts" USING btree ("store_id","is_active","method");--> statement-breakpoint
CREATE INDEX "discounts_store_id_method_window_idx" ON "discounts" USING btree ("store_id","method","starts_at","ends_at");--> statement-breakpoint
CREATE INDEX "listing_collections_collection_id_position_idx" ON "listing_collections" USING btree ("collection_id","position");--> statement-breakpoint
CREATE INDEX "listing_collections_listing_id_idx" ON "listing_collections" USING btree ("listing_id");--> statement-breakpoint
CREATE INDEX "order_applied_discounts_order_id_position_idx" ON "order_applied_discounts" USING btree ("order_id","position");--> statement-breakpoint
CREATE INDEX "order_item_option_values_order_item_id_position_idx" ON "order_item_option_values" USING btree ("order_item_id","position");--> statement-breakpoint
CREATE INDEX "order_items_order_id_position_idx" ON "order_items" USING btree ("order_id","position");--> statement-breakpoint
CREATE INDEX "order_items_listing_id_idx" ON "order_items" USING btree ("listing_id");--> statement-breakpoint
CREATE INDEX "order_items_variant_id_idx" ON "order_items" USING btree ("variant_id");--> statement-breakpoint
CREATE INDEX "order_status_history_order_id_at_idx" ON "order_status_history" USING btree ("order_id","at");--> statement-breakpoint
CREATE INDEX "order_tax_lines_order_id_position_idx" ON "order_tax_lines" USING btree ("order_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "orders_order_number_key" ON "orders" USING btree ("order_number");--> statement-breakpoint
CREATE INDEX "orders_buyer_created_at_idx" ON "orders" USING btree ("buyer_oxy_user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "orders_store_id_status_created_at_idx" ON "orders" USING btree ("store_id","status","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "orders_store_id_customer_id_created_at_idx" ON "orders" USING btree ("store_id","customer_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "orders_seller_oxy_user_id_status_created_at_idx" ON "orders" USING btree ("seller_oxy_user_id","status","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "orders_checkout_group_id_idx" ON "orders" USING btree ("checkout_group_id");--> statement-breakpoint
CREATE INDEX "orders_payment_status_created_at_idx" ON "orders" USING btree ("payment_status","created_at");--> statement-breakpoint
CREATE INDEX "orders_status_created_at_idx" ON "orders" USING btree ("status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "orders_idempotency_key_key" ON "orders" USING btree ("idempotency_key") WHERE "orders"."idempotency_key" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "orders_store_id_source_key" ON "orders" USING btree ("store_id","source_connection_id","source_external_id") WHERE "orders"."source_external_id" is not null;--> statement-breakpoint
CREATE INDEX "refund_line_items_refund_id_position_idx" ON "refund_line_items" USING btree ("refund_id","position");--> statement-breakpoint
CREATE INDEX "refunds_order_id_created_at_idx" ON "refunds" USING btree ("order_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "refunds_store_id_status_created_at_idx" ON "refunds" USING btree ("store_id","status","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "refunds_rma_number_key" ON "refunds" USING btree ("rma_number") WHERE "refunds"."rma_number" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "refunds_idempotency_key_key" ON "refunds" USING btree ("idempotency_key") WHERE "refunds"."idempotency_key" is not null;--> statement-breakpoint
CREATE INDEX "draft_order_applied_discounts_draft_order_id_position_idx" ON "draft_order_applied_discounts" USING btree ("draft_order_id","position");--> statement-breakpoint
CREATE INDEX "draft_order_line_item_option_values_line_item_id_position_idx" ON "draft_order_line_item_option_values" USING btree ("draft_order_line_item_id","position");--> statement-breakpoint
CREATE INDEX "draft_order_line_items_draft_order_id_position_idx" ON "draft_order_line_items" USING btree ("draft_order_id","position");--> statement-breakpoint
CREATE INDEX "draft_order_tax_lines_draft_order_id_position_idx" ON "draft_order_tax_lines" USING btree ("draft_order_id","position");--> statement-breakpoint
CREATE INDEX "draft_orders_store_id_status_created_at_idx" ON "draft_orders" USING btree ("store_id","status","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "draft_orders_converted_order_id_key" ON "draft_orders" USING btree ("converted_order_id") WHERE "draft_orders"."converted_order_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "draft_orders_idempotency_key_key" ON "draft_orders" USING btree ("idempotency_key") WHERE "draft_orders"."idempotency_key" is not null;--> statement-breakpoint
CREATE INDEX "addresses_oxy_user_id_default_created_at_idx" ON "addresses" USING btree ("oxy_user_id","is_default" DESC NULLS LAST,"created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "addresses_oxy_user_id_default_key" ON "addresses" USING btree ("oxy_user_id") WHERE "addresses"."is_default";--> statement-breakpoint
CREATE UNIQUE INDEX "cart_items_cart_id_variant_id_key" ON "cart_items" USING btree ("cart_id","variant_id");--> statement-breakpoint
CREATE INDEX "cart_items_variant_id_idx" ON "cart_items" USING btree ("variant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "carts_oxy_user_id_key" ON "carts" USING btree ("oxy_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "favorites_oxy_user_id_listing_id_key" ON "favorites" USING btree ("oxy_user_id","listing_id");--> statement-breakpoint
CREATE INDEX "favorites_oxy_user_id_created_at_idx" ON "favorites" USING btree ("oxy_user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "favorites_listing_id_idx" ON "favorites" USING btree ("listing_id");--> statement-breakpoint
CREATE INDEX "feedback_oxy_user_id_created_at_idx" ON "feedback" USING btree ("oxy_user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "feedback_status_idx" ON "feedback" USING btree ("status");--> statement-breakpoint
CREATE INDEX "feedback_type_idx" ON "feedback" USING btree ("type");--> statement-breakpoint
CREATE INDEX "reviews_listing_id_status_created_at_idx" ON "reviews" USING btree ("listing_id","status","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "reviews_store_id_status_created_at_idx" ON "reviews" USING btree ("store_id","status","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "reviews_seller_oxy_user_id_status_created_at_idx" ON "reviews" USING btree ("seller_oxy_user_id","status","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "reviews_author_oxy_user_id_listing_id_key" ON "reviews" USING btree ("author_oxy_user_id","listing_id") WHERE "reviews"."listing_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "seller_profiles_oxy_user_id_key" ON "seller_profiles" USING btree ("oxy_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "user_preferences_oxy_user_id_key" ON "user_preferences" USING btree ("oxy_user_id");--> statement-breakpoint
CREATE INDEX "notifications_oxy_user_id_status_created_at_idx" ON "notifications" USING btree ("oxy_user_id","status","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "notifications_oxy_user_id_unread_idx" ON "notifications" USING btree ("oxy_user_id","created_at" DESC NULLS LAST) WHERE "notifications"."status" in ('pending', 'sent');--> statement-breakpoint
CREATE INDEX "notifications_dismissed_at_idx" ON "notifications" USING btree ("dismissed_at") WHERE "notifications"."dismissed_at" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "push_tokens_oxy_user_id_token_key" ON "push_tokens" USING btree ("oxy_user_id","token");--> statement-breakpoint
CREATE INDEX "push_tokens_token_idx" ON "push_tokens" USING btree ("token");--> statement-breakpoint
CREATE UNIQUE INDEX "web_push_subscriptions_oxy_user_id_endpoint_key" ON "web_push_subscriptions" USING btree ("oxy_user_id","endpoint");--> statement-breakpoint
CREATE UNIQUE INDEX "abuse_reports_reporter_reported_key" ON "abuse_reports" USING btree ("reporter_oxy_user_id","reported_type","reported_id");--> statement-breakpoint
CREATE INDEX "abuse_reports_local_status_created_at_idx" ON "abuse_reports" USING btree ("local_status","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "abuse_reports_reported_created_at_idx" ON "abuse_reports" USING btree ("reported_type","reported_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "abuse_reports_crowd_source_case_id_idx" ON "abuse_reports" USING btree ("crowd_source_case_id") WHERE "abuse_reports"."crowd_source_case_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "moderation_enforcements_decision_revision_action_key" ON "moderation_enforcements" USING btree ("decision_id","revision","action");--> statement-breakpoint
CREATE INDEX "moderation_enforcements_subject_created_at_idx" ON "moderation_enforcements" USING btree ("subject_type","subject_id","created_at" DESC NULLS LAST) WHERE "moderation_enforcements"."applied";--> statement-breakpoint
CREATE INDEX "moderation_events_expires_at_idx" ON "moderation_events" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "moderation_outboxes_pending_idx" ON "moderation_outboxes" USING btree ("available_at","created_at") WHERE "moderation_outboxes"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "moderation_outboxes_reclaim_idx" ON "moderation_outboxes" USING btree ("lease_until","created_at") WHERE "moderation_outboxes"."status" = 'processing';--> statement-breakpoint
CREATE INDEX "moderation_outboxes_expires_at_idx" ON "moderation_outboxes" USING btree ("expires_at");