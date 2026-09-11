-- oxy:deploy-phase=pre
-- oxy:rollback=replay: the three CHECK constraints this file DROPS and re-adds one member wider (orders_status_check, orders_shipping_method_check, order_status_history_status_check) have their previous definitions in the migrations that created them, not here; and the five ALTER COLUMN ... DROP NOT NULL on the orders address columns are re-derivable by SET NOT NULL. Both halves re-derive from a forward path rather than a restore, and both FAIL LOUDLY while rows exist that the old shape cannot represent - a digitally_delivered or digital row for the CHECKs, a digital order with no address for the NOT NULLs. That refusal is correct behaviour and is the reason this is replay rather than derived: nothing is lost, but the inverse is not readable off this file alone
--
-- #1015 / ADR 0010 — the digital-commerce foundation.
--
-- Fifteen new tables (the asset/version/file/package domain, the licence
-- domain, the buyer's `asset_rights`, the download path and the one catalogue
-- join `asset_variant_bindings`), four new columns on
-- `orders`, four on `order_items`, three widened CHECKs, and five NOT NULLs on
-- `orders` replaced by a CHECK that says MORE than they did.
--
-- ## Why `pre`, with the NOT NULL drops in it
--
-- Every statement here is additive IN EFFECT against both images:
--
--   * The three widened CHECKs (`orders_status_check`,
--     `orders_shipping_method_check`, `order_status_history_status_check`) admit
--     one extra value each. The image still serving never writes it.
--   * `ALTER COLUMN … DROP NOT NULL` on the five required `orders` address
--     columns RELAXES a constraint. The serving image writes all five on every
--     order and reads them as non-null, and no row in the database is NULL when
--     this applies, so nothing it does changes.
--   * `orders_shipping_address_digital_check` takes the NOT NULLs' place and is
--     STRICTER: non-digital orders must still have all five, AND a `digital` order
--     must have all NINE address columns NULL. Every existing row is non-digital
--     and complete, so it is satisfied at the instant it is added.
--
-- There is no DROP TABLE and no DROP COLUMN in this file, so the inbound-reference
-- check `CONVENTIONS.md` §"A `DROP … CASCADE` nobody has checked" demands has no
-- subject here. The only DROPs are the three CHECK constraints re-added below at
-- lines the same file carries, and five NOT NULLs.
--
-- ## Rollback is `replay`, and the distinction from `derived` is worth stating
--
-- NOTHING IS LOST: no column is dropped, no row is deleted, no value is rewritten.
-- The first draft of this header therefore said `derived`, and
-- `migration-rollback-posture.test.ts` refused it — correctly, and the refusal is
-- the more precise reading. `derived` means every statement's inverse is readable
-- OFF THIS FILE, and two families here are not:
--
--   * the three widened CHECKs are DROPped and re-ADDed, so the file carries the
--     NEW definition and not the old one, which lives in the migration that
--     created each constraint;
--   * `ALTER COLUMN ... DROP NOT NULL` inverts to `SET NOT NULL`, which is
--     derivable as a STATEMENT but is a claim about the DATA — it succeeds only
--     while no row violates it.
--
-- Both re-derive from a forward path, which is what `replay` means. Both also
-- fail loudly while rows exist that the old shape cannot represent: a
-- `digitally_delivered` order for the CHECKs, an address-less digital order for
-- the NOT NULLs. That refusal is correct behaviour rather than a gap — a rollback
-- that silently discarded those rows is the outcome nobody wants.

CREATE TABLE "asset_file_inspections" (
	"id" text PRIMARY KEY NOT NULL,
	"file_id" text NOT NULL,
	"verdict" text NOT NULL,
	"processor_name" text NOT NULL,
	"processor_version" text NOT NULL,
	"triangle_count" bigint,
	"vertex_count" bigint,
	"mesh_count" integer,
	"bounding_box_x_mm" integer,
	"bounding_box_y_mm" integer,
	"bounding_box_z_mm" integer,
	"watertight" boolean,
	"has_uv_mapping" boolean,
	"has_rig" boolean,
	"animation_count" integer,
	"missing_resource_count" integer,
	"failure_detail" text,
	"measured_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "asset_file_inspections_verdict_check" CHECK ("asset_file_inspections"."verdict" in ('pending', 'measured', 'unsupported', 'corrupt', 'missing_resources', 'failed', 'refused_too_large')),
	CONSTRAINT "asset_file_inspections_bbox_check" CHECK (("asset_file_inspections"."bounding_box_x_mm" is null) = ("asset_file_inspections"."bounding_box_y_mm" is null)
          and ("asset_file_inspections"."bounding_box_y_mm" is null) = ("asset_file_inspections"."bounding_box_z_mm" is null)),
	CONSTRAINT "asset_file_inspections_counts_check" CHECK (coalesce("asset_file_inspections"."triangle_count", 0) >= 0 and coalesce("asset_file_inspections"."vertex_count", 0) >= 0
          and coalesce("asset_file_inspections"."mesh_count", 0) >= 0 and coalesce("asset_file_inspections"."animation_count", 0) >= 0
          and coalesce("asset_file_inspections"."missing_resource_count", 0) >= 0)
);
--> statement-breakpoint
CREATE TABLE "asset_files" (
	"id" text PRIMARY KEY NOT NULL,
	"version_id" text NOT NULL,
	"file_name" text NOT NULL,
	"format" text NOT NULL,
	"media_type" text NOT NULL,
	"role" text NOT NULL,
	"visibility" text NOT NULL,
	"byte_size" bigint NOT NULL,
	"content_hash" text NOT NULL,
	"storage_key" text NOT NULL,
	"scan_verdict" text DEFAULT 'pending' NOT NULL,
	"scan_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "asset_files_format_check" CHECK ("asset_files"."format" in ('stl', '3mf', 'obj', 'gltf', 'glb', 'fbx', 'blend', 'png', 'jpeg', 'zip', 'pdf')),
	CONSTRAINT "asset_files_role_check" CHECK ("asset_files"."role" in ('source', 'mesh', 'texture', 'preview', 'web_derivative', 'documentation', 'profile', 'archive')),
	CONSTRAINT "asset_files_visibility_check" CHECK ("asset_files"."visibility" in ('preview_only', 'rightful_download_only', 'public_download')),
	CONSTRAINT "asset_files_scan_verdict_check" CHECK ("asset_files"."scan_verdict" in ('pending', 'clean', 'infected', 'error')),
	CONSTRAINT "asset_files_byte_size_check" CHECK ("asset_files"."byte_size" > 0 and "asset_files"."byte_size" <= 8589934592),
	CONSTRAINT "asset_files_content_hash_check" CHECK ("asset_files"."content_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "asset_files_scan_at_check" CHECK (("asset_files"."scan_verdict" = 'pending') = ("asset_files"."scan_at" is null))
);
--> statement-breakpoint
CREATE TABLE "asset_package_files" (
	"id" text PRIMARY KEY NOT NULL,
	"package_id" text NOT NULL,
	"version_id" text NOT NULL,
	"file_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "asset_packages" (
	"id" text PRIMARY KEY NOT NULL,
	"asset_id" text NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"summary" text,
	"acquirable" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "asset_provenance_signals" (
	"id" text PRIMARY KEY NOT NULL,
	"version_id" text NOT NULL,
	"file_id" text,
	"kind" text NOT NULL,
	"value" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "asset_provenance_signals_kind_check" CHECK ("asset_provenance_signals"."kind" in ('content_hash', 'geometry_fingerprint', 'preview_phash', 'creator_declaration', 'prior_publication'))
);
--> statement-breakpoint
CREATE TABLE "asset_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"asset_id" text NOT NULL,
	"label" text NOT NULL,
	"major_version" integer DEFAULT 0 NOT NULL,
	"state" text DEFAULT 'draft' NOT NULL,
	"changelog" text,
	"published_at" timestamp with time zone,
	"canonical_variant_id" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "asset_versions_state_check" CHECK ("asset_versions"."state" in ('draft', 'processing', 'review', 'published', 'superseded', 'restricted', 'withdrawn')),
	CONSTRAINT "asset_versions_major_check" CHECK ("asset_versions"."major_version" >= 0),
	CONSTRAINT "asset_versions_published_at_check" CHECK (("asset_versions"."state" in ('draft', 'processing', 'review')) = ("asset_versions"."published_at" is null))
);
--> statement-breakpoint
CREATE TABLE "digital_assets" (
	"id" text PRIMARY KEY NOT NULL,
	"store_id" text NOT NULL,
	"canonical_product_id" text,
	"vertical" text NOT NULL,
	"title" text NOT NULL,
	"state" text DEFAULT 'draft' NOT NULL,
	"current_version_id" text,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "digital_assets_state_check" CHECK ("digital_assets"."state" in ('draft', 'listed', 'unlisted', 'restricted', 'withdrawn')),
	CONSTRAINT "digital_assets_vertical_check" CHECK ("digital_assets"."vertical" in ('three_d', 'game_asset', 'font', 'icon_pack', 'design_template', 'audio', 'document', 'software'))
);
--> statement-breakpoint
CREATE TABLE "asset_download_events" (
	"id" text PRIMARY KEY NOT NULL,
	"right_id" text,
	"grant_id" text,
	"file_id" text,
	"requester_key" text NOT NULL,
	"kind" text NOT NULL,
	"refusal_reason" text,
	"bytes_transferred" bigint,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "asset_download_events_kind_check" CHECK ("asset_download_events"."kind" in ('authorized', 'started', 'completed', 'refused')),
	CONSTRAINT "asset_download_events_refusal_check" CHECK ("asset_download_events"."refusal_reason" in ('no_right', 'right_not_active', 'version_not_covered', 'version_not_downloadable', 'file_not_in_package', 'file_not_downloadable', 'grant_expired', 'grant_exhausted', 'downloads_disabled')),
	CONSTRAINT "asset_download_events_refusal_pairing_check" CHECK (("asset_download_events"."kind" = 'refused') = ("asset_download_events"."refusal_reason" is not null)),
	CONSTRAINT "asset_download_events_bytes_check" CHECK (coalesce("asset_download_events"."bytes_transferred", 0) >= 0),
	CONSTRAINT "asset_download_events_requester_check" CHECK ("asset_download_events"."requester_key" ~ '^(oxy:|guest:|anonymous$)')
);
--> statement-breakpoint
CREATE TABLE "asset_download_grants" (
	"id" text PRIMARY KEY NOT NULL,
	"right_id" text NOT NULL,
	"file_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"redemptions" integer DEFAULT 0 NOT NULL,
	"max_redemptions" integer NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "asset_download_grants_token_hash_check" CHECK ("asset_download_grants"."token_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "asset_download_grants_redemptions_check" CHECK ("asset_download_grants"."redemptions" >= 0 and "asset_download_grants"."max_redemptions" >= 1
          and "asset_download_grants"."redemptions" <= "asset_download_grants"."max_redemptions")
);
--> statement-breakpoint
CREATE TABLE "asset_licence_options" (
	"id" text PRIMARY KEY NOT NULL,
	"asset_id" text NOT NULL,
	"package_id" text NOT NULL,
	"licence_version_id" text NOT NULL,
	"update_policy" text NOT NULL,
	"acquirable" boolean DEFAULT true NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "asset_licence_options_update_policy_check" CHECK ("asset_licence_options"."update_policy" in ('purchased_version_only', 'same_major_version', 'all_future_versions'))
);
--> statement-breakpoint
CREATE TABLE "asset_licence_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"licence_id" text NOT NULL,
	"version" integer NOT NULL,
	"state" text DEFAULT 'draft' NOT NULL,
	"summary" text NOT NULL,
	"rights" text[] NOT NULL,
	"attribution" text NOT NULL,
	"seat_limit" integer,
	"revenue_limit_amount" bigint,
	"revenue_limit_currency" text,
	"project_limit" integer,
	"additional_terms" text,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "asset_licence_versions_state_check" CHECK ("asset_licence_versions"."state" in ('draft', 'published', 'retired')),
	CONSTRAINT "asset_licence_versions_attribution_check" CHECK ("asset_licence_versions"."attribution" in ('required', 'optional', 'not_required')),
	CONSTRAINT "asset_licence_versions_rights_check" CHECK ("asset_licence_versions"."rights" <@ array['personal_use', 'commercial_project_use', 'commercial_physical_production', 'modification', 'derivative_redistribution', 'source_redistribution', 'sublicensing', 'extended_enterprise_use']::text[]),
	CONSTRAINT "asset_licence_versions_rights_nonempty_check" CHECK (array_length("asset_licence_versions"."rights", 1) >= 1),
	CONSTRAINT "asset_licence_versions_version_check" CHECK ("asset_licence_versions"."version" >= 1),
	CONSTRAINT "asset_licence_versions_limits_check" CHECK (coalesce("asset_licence_versions"."seat_limit", 1) >= 1 and coalesce("asset_licence_versions"."project_limit", 1) >= 1),
	CONSTRAINT "asset_licence_versions_published_at_check" CHECK (("asset_licence_versions"."state" = 'draft') = ("asset_licence_versions"."published_at" is null)),
	CONSTRAINT "asset_licence_versions_revenue_limit_currency_check" CHECK ("asset_licence_versions"."revenue_limit_currency" in ('FAIR', 'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF', 'CNY', 'SEK', 'NOK', 'DKK', 'PLN', 'MXN', 'BRL', 'INR', 'NZD', 'ZAR', 'SGD', 'HKD', 'AED'))
);
--> statement-breakpoint
CREATE TABLE "asset_licences" (
	"id" text PRIMARY KEY NOT NULL,
	"store_id" text,
	"authorship" text NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "asset_licences_authorship_check" CHECK ("asset_licences"."authorship" in ('mercaria_reference', 'creator')),
	CONSTRAINT "asset_licences_authorship_store_check" CHECK (("asset_licences"."authorship" = 'mercaria_reference') = ("asset_licences"."store_id" is null))
);
--> statement-breakpoint
CREATE TABLE "asset_right_events" (
	"id" text PRIMARY KEY NOT NULL,
	"right_id" text NOT NULL,
	"kind" text NOT NULL,
	"resulting_status" text,
	"actor" text NOT NULL,
	"detail" text,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "asset_right_events_kind_check" CHECK ("asset_right_events"."kind" in ('granted', 'refunded', 'dispute_opened', 'dispute_resolved_buyer', 'dispute_resolved_seller', 'revoked', 'reinstated', 'superseded', 'version_became_available')),
	CONSTRAINT "asset_right_events_status_check" CHECK ("asset_right_events"."resulting_status" in ('active', 'refunded', 'disputed_hold', 'revoked_for_policy', 'superseded')),
	CONSTRAINT "asset_right_events_actor_check" CHECK ("asset_right_events"."actor" ~ '^(oxy:|guest:|operator:|system$)')
);
--> statement-breakpoint
CREATE TABLE "asset_rights" (
	"id" text PRIMARY KEY NOT NULL,
	"buyer_key" text NOT NULL,
	"asset_id" text NOT NULL,
	"package_id" text NOT NULL,
	"purchased_version_id" text NOT NULL,
	"licence_version_id" text NOT NULL,
	"update_policy" text NOT NULL,
	"source" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"revocation_basis" text,
	"order_item_id" text,
	"order_id" text,
	"granted_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "asset_rights_status_check" CHECK ("asset_rights"."status" in ('active', 'refunded', 'disputed_hold', 'revoked_for_policy', 'superseded')),
	CONSTRAINT "asset_rights_source_check" CHECK ("asset_rights"."source" in ('purchase', 'free_claim', 'operator_grant', 'migration')),
	CONSTRAINT "asset_rights_update_policy_check" CHECK ("asset_rights"."update_policy" in ('purchased_version_only', 'same_major_version', 'all_future_versions')),
	CONSTRAINT "asset_rights_revocation_basis_check" CHECK ("asset_rights"."revocation_basis" in ('upheld_intellectual_property_claim', 'legal_order', 'fraudulent_acquisition', 'security_withdrawal')),
	CONSTRAINT "asset_rights_revocation_pairing_check" CHECK (("asset_rights"."status" = 'revoked_for_policy') = ("asset_rights"."revocation_basis" is not null)),
	CONSTRAINT "asset_rights_purchase_order_check" CHECK (("asset_rights"."source" = 'purchase') = ("asset_rights"."order_item_id" is not null)),
	CONSTRAINT "asset_rights_order_pairing_check" CHECK (("asset_rights"."order_item_id" is null) = ("asset_rights"."order_id" is null)),
	CONSTRAINT "asset_rights_buyer_key_check" CHECK ("asset_rights"."buyer_key" ~ '^(oxy|guest):[^[:space:]]+$')
);
--> statement-breakpoint
CREATE TABLE "asset_variant_bindings" (
	"id" text PRIMARY KEY NOT NULL,
	"variant_id" text NOT NULL,
	"licence_option_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL
);
--> statement-breakpoint
ALTER TABLE "order_status_history" DROP CONSTRAINT "order_status_history_status_check";--> statement-breakpoint
ALTER TABLE "orders" DROP CONSTRAINT "orders_shipping_method_check";--> statement-breakpoint
ALTER TABLE "orders" DROP CONSTRAINT "orders_status_check";--> statement-breakpoint
ALTER TABLE "orders" ALTER COLUMN "shipping_address_recipient_name" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ALTER COLUMN "shipping_address_line1" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ALTER COLUMN "shipping_address_city" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ALTER COLUMN "shipping_address_postal_code" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ALTER COLUMN "shipping_address_country" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "order_items" ADD COLUMN "digital_package_id" text;--> statement-breakpoint
ALTER TABLE "order_items" ADD COLUMN "digital_asset_version_id" text;--> statement-breakpoint
ALTER TABLE "order_items" ADD COLUMN "digital_licence_version_id" text;--> statement-breakpoint
ALTER TABLE "order_items" ADD COLUMN "digital_update_policy" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "digital_supply_country" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "digital_supply_evidence" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "digital_withdrawal_basis" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "digital_supply_consent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "asset_file_inspections" ADD CONSTRAINT "asset_file_inspections_file_id_asset_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."asset_files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_files" ADD CONSTRAINT "asset_files_version_id_asset_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."asset_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_package_files" ADD CONSTRAINT "asset_package_files_package_id_asset_packages_id_fk" FOREIGN KEY ("package_id") REFERENCES "public"."asset_packages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_package_files" ADD CONSTRAINT "asset_package_files_version_id_asset_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."asset_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_package_files" ADD CONSTRAINT "asset_package_files_file_id_asset_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."asset_files"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_packages" ADD CONSTRAINT "asset_packages_asset_id_digital_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."digital_assets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_provenance_signals" ADD CONSTRAINT "asset_provenance_signals_version_id_asset_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."asset_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_provenance_signals" ADD CONSTRAINT "asset_provenance_signals_file_id_asset_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."asset_files"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_versions" ADD CONSTRAINT "asset_versions_asset_id_digital_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."digital_assets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_versions" ADD CONSTRAINT "asset_versions_canonical_variant_id_canonical_variants_id_fk" FOREIGN KEY ("canonical_variant_id") REFERENCES "public"."canonical_variants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "digital_assets" ADD CONSTRAINT "digital_assets_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "digital_assets" ADD CONSTRAINT "digital_assets_canonical_product_id_canonical_products_id_fk" FOREIGN KEY ("canonical_product_id") REFERENCES "public"."canonical_products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_download_events" ADD CONSTRAINT "asset_download_events_right_id_asset_rights_id_fk" FOREIGN KEY ("right_id") REFERENCES "public"."asset_rights"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_download_events" ADD CONSTRAINT "asset_download_events_grant_id_asset_download_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."asset_download_grants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_download_events" ADD CONSTRAINT "asset_download_events_file_id_asset_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."asset_files"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_download_grants" ADD CONSTRAINT "asset_download_grants_right_id_asset_rights_id_fk" FOREIGN KEY ("right_id") REFERENCES "public"."asset_rights"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_download_grants" ADD CONSTRAINT "asset_download_grants_file_id_asset_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."asset_files"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_licence_options" ADD CONSTRAINT "asset_licence_options_asset_id_digital_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."digital_assets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_licence_options" ADD CONSTRAINT "asset_licence_options_package_id_asset_packages_id_fk" FOREIGN KEY ("package_id") REFERENCES "public"."asset_packages"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_licence_options" ADD CONSTRAINT "asset_licence_options_licence_version_id_asset_licence_versions_id_fk" FOREIGN KEY ("licence_version_id") REFERENCES "public"."asset_licence_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_licence_versions" ADD CONSTRAINT "asset_licence_versions_licence_id_asset_licences_id_fk" FOREIGN KEY ("licence_id") REFERENCES "public"."asset_licences"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_licences" ADD CONSTRAINT "asset_licences_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_right_events" ADD CONSTRAINT "asset_right_events_right_id_asset_rights_id_fk" FOREIGN KEY ("right_id") REFERENCES "public"."asset_rights"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_rights" ADD CONSTRAINT "asset_rights_asset_id_digital_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."digital_assets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_rights" ADD CONSTRAINT "asset_rights_package_id_asset_packages_id_fk" FOREIGN KEY ("package_id") REFERENCES "public"."asset_packages"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_rights" ADD CONSTRAINT "asset_rights_purchased_version_id_asset_versions_id_fk" FOREIGN KEY ("purchased_version_id") REFERENCES "public"."asset_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_rights" ADD CONSTRAINT "asset_rights_licence_version_id_asset_licence_versions_id_fk" FOREIGN KEY ("licence_version_id") REFERENCES "public"."asset_licence_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_rights" ADD CONSTRAINT "asset_rights_order_item_id_order_items_id_fk" FOREIGN KEY ("order_item_id") REFERENCES "public"."order_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_rights" ADD CONSTRAINT "asset_rights_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_variant_bindings" ADD CONSTRAINT "asset_variant_bindings_licence_option_id_asset_licence_options_id_fk" FOREIGN KEY ("licence_option_id") REFERENCES "public"."asset_licence_options"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "asset_file_inspections_file_processor_key" ON "asset_file_inspections" USING btree ("file_id","processor_name","processor_version");--> statement-breakpoint
CREATE UNIQUE INDEX "asset_files_version_name_key" ON "asset_files" USING btree ("version_id","file_name");--> statement-breakpoint
CREATE INDEX "asset_files_version_role_idx" ON "asset_files" USING btree ("version_id","role");--> statement-breakpoint
CREATE INDEX "asset_files_content_hash_idx" ON "asset_files" USING btree ("content_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "asset_package_files_package_file_key" ON "asset_package_files" USING btree ("package_id","file_id");--> statement-breakpoint
CREATE INDEX "asset_package_files_package_version_idx" ON "asset_package_files" USING btree ("package_id","version_id");--> statement-breakpoint
CREATE UNIQUE INDEX "asset_packages_asset_key_key" ON "asset_packages" USING btree ("asset_id","key");--> statement-breakpoint
CREATE INDEX "asset_packages_asset_idx" ON "asset_packages" USING btree ("asset_id");--> statement-breakpoint
CREATE UNIQUE INDEX "asset_provenance_signals_scope_key" ON "asset_provenance_signals" USING btree ("version_id","file_id","kind","value");--> statement-breakpoint
CREATE INDEX "asset_provenance_signals_kind_value_idx" ON "asset_provenance_signals" USING btree ("kind","value");--> statement-breakpoint
CREATE UNIQUE INDEX "asset_versions_asset_label_key" ON "asset_versions" USING btree ("asset_id","label");--> statement-breakpoint
CREATE INDEX "asset_versions_asset_state_idx" ON "asset_versions" USING btree ("asset_id","state");--> statement-breakpoint
CREATE INDEX "digital_assets_store_state_idx" ON "digital_assets" USING btree ("store_id","state");--> statement-breakpoint
CREATE INDEX "digital_assets_canonical_product_idx" ON "digital_assets" USING btree ("canonical_product_id");--> statement-breakpoint
CREATE INDEX "asset_download_events_right_idx" ON "asset_download_events" USING btree ("right_id","occurred_at");--> statement-breakpoint
CREATE INDEX "asset_download_events_kind_idx" ON "asset_download_events" USING btree ("kind","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "asset_download_grants_token_hash_key" ON "asset_download_grants" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "asset_download_grants_right_idx" ON "asset_download_grants" USING btree ("right_id");--> statement-breakpoint
CREATE INDEX "asset_download_grants_expires_idx" ON "asset_download_grants" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "asset_licence_options_identity_key" ON "asset_licence_options" USING btree ("package_id","licence_version_id","update_policy");--> statement-breakpoint
CREATE INDEX "asset_licence_options_asset_idx" ON "asset_licence_options" USING btree ("asset_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "asset_licence_versions_licence_version_key" ON "asset_licence_versions" USING btree ("licence_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "asset_licences_store_slug_key" ON "asset_licences" USING btree ("store_id","slug") WHERE store_id is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "asset_licences_reference_slug_key" ON "asset_licences" USING btree ("slug") WHERE store_id is null;--> statement-breakpoint
CREATE INDEX "asset_right_events_right_idx" ON "asset_right_events" USING btree ("right_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "asset_rights_order_item_package_key" ON "asset_rights" USING btree ("order_item_id","package_id") WHERE order_item_id is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "asset_rights_free_claim_key" ON "asset_rights" USING btree ("buyer_key","package_id") WHERE order_item_id is null;--> statement-breakpoint
CREATE INDEX "asset_rights_buyer_status_idx" ON "asset_rights" USING btree ("buyer_key","status");--> statement-breakpoint
CREATE INDEX "asset_rights_asset_idx" ON "asset_rights" USING btree ("asset_id");--> statement-breakpoint
CREATE INDEX "asset_rights_order_idx" ON "asset_rights" USING btree ("order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "asset_variant_bindings_variant_key" ON "asset_variant_bindings" USING btree ("variant_id");--> statement-breakpoint
CREATE INDEX "asset_variant_bindings_option_idx" ON "asset_variant_bindings" USING btree ("licence_option_id");--> statement-breakpoint
CREATE INDEX "order_items_digital_version_idx" ON "order_items" USING btree ("digital_asset_version_id") WHERE digital_asset_version_id is not null;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_digital_update_policy_check" CHECK ("order_items"."digital_update_policy" in ('purchased_version_only', 'same_major_version', 'all_future_versions'));--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_digital_snapshot_complete_check" CHECK (num_nonnulls("order_items"."digital_package_id", "order_items"."digital_asset_version_id", "order_items"."digital_licence_version_id", "order_items"."digital_update_policy") in (0, 4));--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_digital_no_condition_check" CHECK ("order_items"."digital_asset_version_id" is null or "order_items"."condition_key" is null);--> statement-breakpoint
ALTER TABLE "order_status_history" ADD CONSTRAINT "order_status_history_status_check" CHECK ("order_status_history"."status" in ('pending_payment', 'paid', 'processing', 'shipped', 'delivered', 'digitally_delivered', 'cancelled', 'refunded', 'partially_refunded'));--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_digital_supply_evidence_check" CHECK ("orders"."digital_supply_evidence" in ('buyer_declared', 'billing_country', 'saved_address_country', 'operator_corrected'));--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_digital_withdrawal_basis_check" CHECK ("orders"."digital_withdrawal_basis" in ('statutory_cooling_off', 'waived_on_immediate_supply', 'not_applicable_trader_buyer'));--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_shipping_address_digital_check" CHECK (case when "orders"."shipping_method" = 'digital'
            then "orders"."shipping_address_recipient_name" is null
             and "orders"."shipping_address_line1" is null
             and "orders"."shipping_address_city" is null
             and "orders"."shipping_address_postal_code" is null
             and "orders"."shipping_address_country" is null
             and "orders"."shipping_address_line2" is null
             and "orders"."shipping_address_region" is null
             and "orders"."shipping_address_phone" is null
             and "orders"."shipping_address_label" is null
            else "orders"."shipping_address_recipient_name" is not null
             and "orders"."shipping_address_line1" is not null
             and "orders"."shipping_address_city" is not null
             and "orders"."shipping_address_postal_code" is not null
             and "orders"."shipping_address_country" is not null
          end);--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_digital_supply_pairing_check" CHECK (("orders"."digital_supply_country" is null) = ("orders"."digital_supply_evidence" is null)
          and ("orders"."digital_supply_country" is null) = ("orders"."digital_withdrawal_basis" is null));--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_digital_supply_country_check" CHECK ("orders"."digital_supply_country" is null or "orders"."digital_supply_country" ~ '^[A-Z]{2}$');--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_digital_withdrawal_consent_check" CHECK (coalesce("orders"."digital_withdrawal_basis" in ('waived_on_immediate_supply'), false)
          = ("orders"."digital_supply_consent_at" is not null));--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_digital_method_supply_check" CHECK ("orders"."shipping_method" <> 'digital' or "orders"."digital_supply_country" is not null);--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_shipping_method_check" CHECK ("orders"."shipping_method" in ('standard', 'express', 'pickup', 'digital'));--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_status_check" CHECK ("orders"."status" in ('pending_payment', 'paid', 'processing', 'shipped', 'delivered', 'digitally_delivered', 'cancelled', 'refunded', 'partially_refunded'));
--> statement-breakpoint
-- oxy:handwritten-begin=digital_immutability_triggers
--
-- Four immutability guards. Each one closes a hole that a SERVICE-level check
-- cannot: #402 is the precedent in this repository — two ordinary calls laundered
-- a moderation decision because the guard lived in one service and the second
-- call reached the row another way.

-- 1. A published asset version is immutable in its identity and its content.
--    #1015 boundary 8: uploading v2 must never silently mutate what v1 was. The
--    STATE may still move (published -> superseded / restricted / withdrawn) and
--    `updated_at` with it; nothing else may.
CREATE OR REPLACE FUNCTION mercaria_asset_version_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.published_at IS NOT NULL THEN
      RAISE EXCEPTION
        'asset version %.% was published at % and is never deleted: withdraw it instead, so every buyer who holds a right to it keeps their download.',
        OLD.asset_id, OLD.label, OLD.published_at
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.published_at IS NOT NULL AND (
    NEW.asset_id IS DISTINCT FROM OLD.asset_id OR
    NEW.label IS DISTINCT FROM OLD.label OR
    NEW.major_version IS DISTINCT FROM OLD.major_version OR
    NEW.canonical_variant_id IS DISTINCT FROM OLD.canonical_variant_id OR
    NEW.changelog IS DISTINCT FROM OLD.changelog OR
    NEW.published_at IS DISTINCT FROM OLD.published_at OR
    NEW.created_at IS DISTINCT FROM OLD.created_at
  ) THEN
    RAISE EXCEPTION
      'asset version %.% is published: its identity and changelog are immutable. Publish a new version instead of editing this one.',
      OLD.asset_id, OLD.label
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER asset_versions_immutable_once_published
  BEFORE UPDATE OR DELETE ON "asset_versions"
  FOR EACH ROW EXECUTE FUNCTION mercaria_asset_version_immutable();--> statement-breakpoint

-- 2. A file belonging to a published version cannot be swapped.
--    #1015 W12 threat 8: "creator replaces a file after purchase without
--    versioning". The scan columns stay writable, because a security withdrawal
--    discovered after publication has to be recordable on the row it is about;
--    `visibility` does NOT, because widening it would hand every existing
--    right-holder a file their licence never covered.
CREATE OR REPLACE FUNCTION mercaria_asset_file_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  published_at_value timestamptz;
BEGIN
  SELECT v.published_at INTO published_at_value
    FROM asset_versions v
   WHERE v.id = COALESCE(OLD.version_id, NEW.version_id);
  IF published_at_value IS NULL THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION
      'asset file % belongs to a published version and is never deleted: a buyer holding a right to it would lose the bytes they paid for.',
      OLD.file_name
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.version_id IS DISTINCT FROM OLD.version_id OR
     NEW.file_name IS DISTINCT FROM OLD.file_name OR
     NEW.format IS DISTINCT FROM OLD.format OR
     NEW.media_type IS DISTINCT FROM OLD.media_type OR
     NEW.role IS DISTINCT FROM OLD.role OR
     NEW.visibility IS DISTINCT FROM OLD.visibility OR
     NEW.byte_size IS DISTINCT FROM OLD.byte_size OR
     NEW.content_hash IS DISTINCT FROM OLD.content_hash OR
     NEW.storage_key IS DISTINCT FROM OLD.storage_key OR
     NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION
      'asset file % belongs to a published version: its contents and visibility are immutable. Publish a new version instead.',
      OLD.file_name
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER asset_files_immutable_once_published
  BEFORE UPDATE OR DELETE ON "asset_files"
  FOR EACH ROW EXECUTE FUNCTION mercaria_asset_file_immutable();--> statement-breakpoint

-- 3. Published licence terms are immutable, and a right's commercial half is too.
--    ADR 0010 D3: editing a licence tomorrow cannot change yesterday's purchase.
--    Two tables, one function, because the statement is identical and a second
--    copy is a second thing to keep in lockstep.
CREATE OR REPLACE FUNCTION mercaria_asset_licence_version_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.published_at IS NOT NULL THEN
      RAISE EXCEPTION
        'licence version %.% was published and is never deleted: it is the terms somebody bought under. Retire it instead.',
        OLD.licence_id, OLD.version
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.published_at IS NOT NULL AND (
    NEW.licence_id IS DISTINCT FROM OLD.licence_id OR
    NEW.version IS DISTINCT FROM OLD.version OR
    NEW.summary IS DISTINCT FROM OLD.summary OR
    NEW.rights IS DISTINCT FROM OLD.rights OR
    NEW.attribution IS DISTINCT FROM OLD.attribution OR
    NEW.seat_limit IS DISTINCT FROM OLD.seat_limit OR
    NEW.revenue_limit_amount IS DISTINCT FROM OLD.revenue_limit_amount OR
    NEW.revenue_limit_currency IS DISTINCT FROM OLD.revenue_limit_currency OR
    NEW.project_limit IS DISTINCT FROM OLD.project_limit OR
    NEW.additional_terms IS DISTINCT FROM OLD.additional_terms OR
    NEW.published_at IS DISTINCT FROM OLD.published_at OR
    NEW.created_at IS DISTINCT FROM OLD.created_at
  ) THEN
    RAISE EXCEPTION
      'licence version %.% is published: its terms are immutable. Publish a new version instead of editing this one.',
      OLD.licence_id, OLD.version
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER asset_licence_versions_immutable_once_published
  BEFORE UPDATE OR DELETE ON "asset_licence_versions"
  FOR EACH ROW EXECUTE FUNCTION mercaria_asset_licence_version_immutable();--> statement-breakpoint

-- 4. A right's commercial half cannot be rewritten, and its history cannot be
--    erased. #1015 W12 threat 9 is "buyer claims a higher license than
--    purchased"; the shape that would make the claim TRUE is an UPDATE of
--    `licence_version_id`, and this is what refuses it. Only the status, the
--    revocation basis and `updated_at` may move (ADR 0010 D6).
CREATE OR REPLACE FUNCTION mercaria_asset_right_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION
      'asset right % is never deleted: a refund, a dispute or a revocation moves its status and appends an event, so the history survives.',
      OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.buyer_key IS DISTINCT FROM OLD.buyer_key OR
     NEW.asset_id IS DISTINCT FROM OLD.asset_id OR
     NEW.package_id IS DISTINCT FROM OLD.package_id OR
     NEW.purchased_version_id IS DISTINCT FROM OLD.purchased_version_id OR
     NEW.licence_version_id IS DISTINCT FROM OLD.licence_version_id OR
     NEW.update_policy IS DISTINCT FROM OLD.update_policy OR
     NEW.source IS DISTINCT FROM OLD.source OR
     NEW.order_item_id IS DISTINCT FROM OLD.order_item_id OR
     NEW.order_id IS DISTINCT FROM OLD.order_id OR
     NEW.granted_at IS DISTINCT FROM OLD.granted_at OR
     NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION
      'asset right % is immutable except for its status: what was bought cannot be rewritten. Grant a new right instead.',
      OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER asset_rights_commercial_half_immutable
  BEFORE UPDATE OR DELETE ON "asset_rights"
  FOR EACH ROW EXECUTE FUNCTION mercaria_asset_right_immutable();--> statement-breakpoint

-- 5. Append-only tables. One function, three triggers.
--    `asset_right_events` is what a chargeback and a takedown dispute are
--    answered from; `asset_download_events` is the access audit; the digital
--    snapshot on `order_items` is what the buyer is owed. None of the three may be
--    edited after the fact, which is `ledger_transactions`' treatment and is taken
--    for the same reason.
CREATE OR REPLACE FUNCTION mercaria_digital_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'table %.% is append-only: a row recorded here is evidence and is never % .',
    TG_TABLE_SCHEMA, TG_TABLE_NAME, lower(TG_OP)
    USING ERRCODE = 'check_violation';
END;
$$;--> statement-breakpoint
CREATE TRIGGER asset_right_events_append_only
  BEFORE UPDATE OR DELETE ON "asset_right_events"
  FOR EACH ROW EXECUTE FUNCTION mercaria_digital_append_only();--> statement-breakpoint
CREATE TRIGGER asset_download_events_append_only
  BEFORE UPDATE ON "asset_download_events"
  FOR EACH ROW EXECUTE FUNCTION mercaria_digital_append_only();--> statement-breakpoint

-- 6. Published provenance is permanent; a draft's is not.
--    #1015 W8: "historical evidence remains auditable". A creator may clean up a
--    draft they abandoned — which is why the DELETE half is conditional — and may
--    never remove the fingerprint of something they published, because that
--    fingerprint is what the next creator who gets copied needs.
CREATE OR REPLACE FUNCTION mercaria_asset_provenance_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  published_at_value timestamptz;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION
      'asset provenance signals are append-only: a fingerprint recorded at upload is never edited.'
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT v.published_at INTO published_at_value
    FROM asset_versions v WHERE v.id = OLD.version_id;
  IF published_at_value IS NOT NULL THEN
    RAISE EXCEPTION
      'provenance signal % belongs to a published version and is never deleted: it is the evidence a later claimant is answered with.',
      OLD.kind
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN OLD;
END;
$$;--> statement-breakpoint
CREATE TRIGGER asset_provenance_signals_append_only
  BEFORE UPDATE OR DELETE ON "asset_provenance_signals"
  FOR EACH ROW EXECUTE FUNCTION mercaria_asset_provenance_append_only();--> statement-breakpoint

-- 7. The digital snapshot on an order line is immutable, like the condition
--    snapshot beside it. #1015 boundary 9: historical orders snapshot the exact
--    asset/version/licence terms purchased, and a snapshot an UPDATE can move is
--    not one.
CREATE OR REPLACE FUNCTION mercaria_order_item_digital_snapshot_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.digital_package_id IS DISTINCT FROM OLD.digital_package_id OR
     NEW.digital_asset_version_id IS DISTINCT FROM OLD.digital_asset_version_id OR
     NEW.digital_licence_version_id IS DISTINCT FROM OLD.digital_licence_version_id OR
     NEW.digital_update_policy IS DISTINCT FROM OLD.digital_update_policy
  THEN
    RAISE EXCEPTION
      'order item % carries a digital snapshot: the package, version, licence and update policy it was sold under are immutable.',
      OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER order_items_digital_snapshot_immutable
  BEFORE UPDATE ON "order_items"
  FOR EACH ROW EXECUTE FUNCTION mercaria_order_item_digital_snapshot_immutable();
-- oxy:handwritten-end=digital_immutability_triggers
