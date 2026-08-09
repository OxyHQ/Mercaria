-- oxy:deploy-phase=pre
--
-- The procurement domain (#118): suppliers, supplier contacts and history,
-- supplier platform accounts, versioned supply agreements with evidence,
-- private procurement offers, and supplier-side purchase orders with their
-- immutable line snapshots, append-only transitions and shipments.
--
-- Additive only (ADR 0004 D13). Nothing here touches an existing table;
-- `suppliers.organization_id` references #53's `organizations` (RESTRICT).
--
-- ## The purchase-order triggers at the bottom are hand-written, and have to be
--
-- drizzle-kit does not model triggers, so the immutability enforcement rides
-- IN this migration rather than a separate one — the ledger-trigger precedent
-- (0002), for the same reason: a window in which the tables exist and the
-- triggers do not is a window in which a cost snapshot is editable.
--
CREATE TABLE "procurement_offers" (
	"id" text PRIMARY KEY NOT NULL,
	"supplier_id" text NOT NULL,
	"supplier_account_id" text NOT NULL,
	"agreement_id" text,
	"canonical_product_id" text,
	"canonical_variant_id" text,
	"supplier_sku" text NOT NULL,
	"supplier_external_id" text,
	"unit_cost_amount" bigint NOT NULL,
	"unit_cost_currency" text NOT NULL,
	"minimum_order_quantity" integer DEFAULT 1 NOT NULL,
	"pack_size" integer DEFAULT 1 NOT NULL,
	"availability" text DEFAULT 'unknown' NOT NULL,
	"stock_quantity" integer,
	"fulfilment_origin_countries" text[] DEFAULT '{}' NOT NULL,
	"eligible_destination_countries" text[] DEFAULT '{}' NOT NULL,
	"shipping_quote_supported" boolean DEFAULT false NOT NULL,
	"handling_days_min" integer,
	"handling_days_max" integer,
	"delivery_days_min" integer,
	"delivery_days_max" integer,
	"incoterm" text,
	"tax_note" text,
	"duty_note" text,
	"return_policy_ref" text,
	"warranty_policy_ref" text,
	"compliance_verdict_ref" text,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_confirmed_at" timestamp with time zone NOT NULL,
	"quote_ttl_seconds" integer,
	"expires_at" timestamp with time zone,
	"provenance" text NOT NULL,
	"confidence" double precision,
	"status" text DEFAULT 'active' NOT NULL,
	"retired_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "procurement_offers_availability_check" CHECK ("procurement_offers"."availability" in ('in_stock', 'out_of_stock', 'limited', 'discontinued', 'unknown')),
	CONSTRAINT "procurement_offers_incoterm_check" CHECK ("procurement_offers"."incoterm" in ('EXW', 'FCA', 'CPT', 'CIP', 'DAP', 'DPU', 'DDP', 'FAS', 'FOB', 'CFR', 'CIF')),
	CONSTRAINT "procurement_offers_provenance_check" CHECK ("procurement_offers"."provenance" in ('feed', 'api', 'manual', 'import')),
	CONSTRAINT "procurement_offers_status_check" CHECK ("procurement_offers"."status" in ('active', 'retired')),
	CONSTRAINT "procurement_offers_unit_cost_currency_check" CHECK ("procurement_offers"."unit_cost_currency" in ('FAIR', 'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF', 'CNY', 'SEK', 'NOK', 'DKK', 'PLN', 'MXN', 'BRL', 'INR', 'NZD', 'ZAR', 'SGD', 'HKD', 'AED')),
	CONSTRAINT "procurement_offers_supplier_sku_check" CHECK (length("procurement_offers"."supplier_sku") > 0),
	CONSTRAINT "procurement_offers_unit_cost_check" CHECK ("procurement_offers"."unit_cost_amount" >= 0),
	CONSTRAINT "procurement_offers_quantities_check" CHECK ("procurement_offers"."minimum_order_quantity" >= 1 and "procurement_offers"."pack_size" >= 1
          and ("procurement_offers"."stock_quantity" is null or "procurement_offers"."stock_quantity" >= 0)),
	CONSTRAINT "procurement_offers_mapping_check" CHECK ("procurement_offers"."canonical_variant_id" is null or "procurement_offers"."canonical_product_id" is not null),
	CONSTRAINT "procurement_offers_origins_check" CHECK (not ('' = any("procurement_offers"."fulfilment_origin_countries"))),
	CONSTRAINT "procurement_offers_destinations_check" CHECK (not ('' = any("procurement_offers"."eligible_destination_countries"))),
	CONSTRAINT "procurement_offers_handling_window_check" CHECK (num_nonnulls("procurement_offers"."handling_days_min", "procurement_offers"."handling_days_max") in (0, 2)
          and ("procurement_offers"."handling_days_min" is null
               or ("procurement_offers"."handling_days_min" >= 0 and "procurement_offers"."handling_days_max" >= "procurement_offers"."handling_days_min"))),
	CONSTRAINT "procurement_offers_delivery_window_check" CHECK (num_nonnulls("procurement_offers"."delivery_days_min", "procurement_offers"."delivery_days_max") in (0, 2)
          and ("procurement_offers"."delivery_days_min" is null
               or ("procurement_offers"."delivery_days_min" >= 0 and "procurement_offers"."delivery_days_max" >= "procurement_offers"."delivery_days_min"))),
	CONSTRAINT "procurement_offers_quote_ttl_check" CHECK ("procurement_offers"."quote_ttl_seconds" is null or "procurement_offers"."quote_ttl_seconds" >= 1),
	CONSTRAINT "procurement_offers_confidence_check" CHECK ("procurement_offers"."confidence" is null or ("procurement_offers"."confidence" >= 0 and "procurement_offers"."confidence" <= 1)),
	CONSTRAINT "procurement_offers_retired_check" CHECK (("procurement_offers"."status" = 'retired') = ("procurement_offers"."retired_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "purchase_order_lines" (
	"id" text PRIMARY KEY NOT NULL,
	"purchase_order_id" text NOT NULL,
	"supplier_sku" text NOT NULL,
	"canonical_product_id" text,
	"canonical_variant_id" text,
	"procurement_offer_id" text,
	"description" text,
	"quantity" integer NOT NULL,
	"unit_cost_amount" bigint NOT NULL,
	"line_total_amount" bigint NOT NULL,
	"quote_ref" text,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "purchase_order_lines_supplier_sku_check" CHECK (length("purchase_order_lines"."supplier_sku") > 0),
	CONSTRAINT "purchase_order_lines_quantity_check" CHECK ("purchase_order_lines"."quantity" > 0),
	CONSTRAINT "purchase_order_lines_amounts_check" CHECK ("purchase_order_lines"."unit_cost_amount" >= 0 and "purchase_order_lines"."line_total_amount" >= 0)
);
--> statement-breakpoint
CREATE TABLE "purchase_order_shipments" (
	"id" text PRIMARY KEY NOT NULL,
	"purchase_order_id" text NOT NULL,
	"tracking_number" text NOT NULL,
	"carrier" text,
	"service" text,
	"shipped_at" timestamp with time zone NOT NULL,
	"delivered_at" timestamp with time zone,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "purchase_order_shipments_tracking_number_check" CHECK (length("purchase_order_shipments"."tracking_number") > 0)
);
--> statement-breakpoint
CREATE TABLE "purchase_order_transitions" (
	"id" text PRIMARY KEY NOT NULL,
	"purchase_order_id" text NOT NULL,
	"status" text NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"initiator" text NOT NULL,
	"reason_code" text,
	"supplier_note" text,
	"by_oxy_user_id" text,
	CONSTRAINT "purchase_order_transitions_status_check" CHECK ("purchase_order_transitions"."status" in ('draft', 'submitted', 'accepted', 'cancel_requested', 'shipped', 'delivered', 'rejected', 'expired', 'cancelled')),
	CONSTRAINT "purchase_order_transitions_initiator_check" CHECK ("purchase_order_transitions"."initiator" in ('system', 'customer', 'supplier', 'operator')),
	CONSTRAINT "purchase_order_transitions_reason_code_check" CHECK ("purchase_order_transitions"."reason_code" in ('out_of_stock', 'price_changed', 'moq_not_met', 'sku_unknown', 'destination_not_served', 'address_invalid', 'acceptance_timeout', 'supplier_error', 'customer_cancelled', 'supplier_cancelled', 'operator_cancelled', 'other')),
	CONSTRAINT "purchase_order_transitions_note_length_check" CHECK ("purchase_order_transitions"."supplier_note" is null or length("purchase_order_transitions"."supplier_note") <= 2000)
);
--> statement-breakpoint
CREATE TABLE "purchase_orders" (
	"id" text PRIMARY KEY NOT NULL,
	"supplier_id" text NOT NULL,
	"supplier_account_id" text NOT NULL,
	"agreement_id" text NOT NULL,
	"order_id" text NOT NULL,
	"checkout_group_id" text,
	"supplier_external_order_id" text,
	"idempotency_key" text NOT NULL,
	"currency" text NOT NULL,
	"items_amount" bigint NOT NULL,
	"shipping_amount" bigint DEFAULT 0 NOT NULL,
	"tax_amount" bigint DEFAULT 0 NOT NULL,
	"duty_amount" bigint DEFAULT 0 NOT NULL,
	"total_amount" bigint NOT NULL,
	"fx_rate_from" text,
	"fx_rate_to" text,
	"fx_rate_rate" double precision,
	"fx_rate_provider" text,
	"fx_rate_as_of" text,
	"destination_label" text,
	"destination_recipient_name" text NOT NULL,
	"destination_line1" text NOT NULL,
	"destination_line2" text,
	"destination_city" text NOT NULL,
	"destination_region" text,
	"destination_postal_code" text NOT NULL,
	"destination_country" text NOT NULL,
	"destination_phone" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"reason_code" text,
	"quote_ref" text,
	"acceptance_deadline_at" timestamp with time zone,
	"submitted_at" timestamp with time zone,
	"accepted_at" timestamp with time zone,
	"allocated_at" timestamp with time zone,
	"shipped_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"submission_attempts" integer DEFAULT 0 NOT NULL,
	"last_submission_error" text,
	"operator_intervention_required" boolean DEFAULT false NOT NULL,
	"operator_note" text,
	"supplier_invoice_ref" text,
	"supplier_credit_note_ref" text,
	"reconciled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "purchase_orders_status_check" CHECK ("purchase_orders"."status" in ('draft', 'submitted', 'accepted', 'cancel_requested', 'shipped', 'delivered', 'rejected', 'expired', 'cancelled')),
	CONSTRAINT "purchase_orders_reason_code_check" CHECK ("purchase_orders"."reason_code" in ('out_of_stock', 'price_changed', 'moq_not_met', 'sku_unknown', 'destination_not_served', 'address_invalid', 'acceptance_timeout', 'supplier_error', 'customer_cancelled', 'supplier_cancelled', 'operator_cancelled', 'other')),
	CONSTRAINT "purchase_orders_currency_check" CHECK ("purchase_orders"."currency" in ('FAIR', 'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF', 'CNY', 'SEK', 'NOK', 'DKK', 'PLN', 'MXN', 'BRL', 'INR', 'NZD', 'ZAR', 'SGD', 'HKD', 'AED')),
	CONSTRAINT "purchase_orders_fx_rate_from_check" CHECK ("purchase_orders"."fx_rate_from" in ('FAIR', 'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF', 'CNY', 'SEK', 'NOK', 'DKK', 'PLN', 'MXN', 'BRL', 'INR', 'NZD', 'ZAR', 'SGD', 'HKD', 'AED')),
	CONSTRAINT "purchase_orders_fx_rate_to_check" CHECK ("purchase_orders"."fx_rate_to" in ('FAIR', 'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF', 'CNY', 'SEK', 'NOK', 'DKK', 'PLN', 'MXN', 'BRL', 'INR', 'NZD', 'ZAR', 'SGD', 'HKD', 'AED')),
	CONSTRAINT "purchase_orders_order_id_check" CHECK (length("purchase_orders"."order_id") > 0),
	CONSTRAINT "purchase_orders_idempotency_key_check" CHECK (length("purchase_orders"."idempotency_key") > 0),
	CONSTRAINT "purchase_orders_amounts_check" CHECK ("purchase_orders"."items_amount" >= 0 and "purchase_orders"."shipping_amount" >= 0 and "purchase_orders"."tax_amount" >= 0
          and "purchase_orders"."duty_amount" >= 0 and "purchase_orders"."total_amount" >= 0),
	CONSTRAINT "purchase_orders_fx_rate_complete_check" CHECK (num_nonnulls("purchase_orders"."fx_rate_from", "purchase_orders"."fx_rate_to", "purchase_orders"."fx_rate_rate", "purchase_orders"."fx_rate_provider", "purchase_orders"."fx_rate_as_of") in (0, 5)),
	CONSTRAINT "purchase_orders_attempts_check" CHECK ("purchase_orders"."submission_attempts" >= 0),
	CONSTRAINT "purchase_orders_last_error_length_check" CHECK ("purchase_orders"."last_submission_error" is null or length("purchase_orders"."last_submission_error") <= 2000)
);
--> statement-breakpoint
CREATE TABLE "supplier_accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"supplier_id" text NOT NULL,
	"provider" text NOT NULL,
	"environment" text NOT NULL,
	"provider_account_id" text NOT NULL,
	"credential_reference" text,
	"billing_reference" text,
	"enabled_markets" text[] DEFAULT '{}' NOT NULL,
	"fulfilment_origins" text[] DEFAULT '{}' NOT NULL,
	"api_capabilities" text[] DEFAULT '{}' NOT NULL,
	"credential_status" text DEFAULT 'unconfigured' NOT NULL,
	"last_health_check_at" timestamp with time zone,
	"last_health_check_ok" boolean,
	"rate_limit_per_minute" integer,
	"daily_order_quota" integer,
	"state" text DEFAULT 'inactive' NOT NULL,
	"activated_at" timestamp with time zone,
	"kill_switched_at" timestamp with time zone,
	"kill_switch_reason" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "supplier_accounts_environment_check" CHECK ("supplier_accounts"."environment" in ('test', 'live')),
	CONSTRAINT "supplier_accounts_credential_status_check" CHECK ("supplier_accounts"."credential_status" in ('unconfigured', 'valid', 'invalid', 'expired', 'revoked')),
	CONSTRAINT "supplier_accounts_state_check" CHECK ("supplier_accounts"."state" in ('inactive', 'active', 'killed')),
	CONSTRAINT "supplier_accounts_api_capabilities_check" CHECK ("supplier_accounts"."api_capabilities" <@ array['catalog_feed', 'stock_query', 'shipping_quote', 'order_submit', 'order_cancel', 'order_status', 'callback_events', 'reservation']::text[]),
	CONSTRAINT "supplier_accounts_provider_check" CHECK ("supplier_accounts"."provider" ~ '^[a-z0-9][a-z0-9_-]*$'),
	CONSTRAINT "supplier_accounts_provider_account_id_check" CHECK (length("supplier_accounts"."provider_account_id") > 0),
	CONSTRAINT "supplier_accounts_credential_reference_check" CHECK ("supplier_accounts"."credential_reference" is null
          or ("supplier_accounts"."credential_reference" ~ '^/[A-Za-z0-9/_.-]+$' and length("supplier_accounts"."credential_reference") <= 512)),
	CONSTRAINT "supplier_accounts_credential_configured_check" CHECK ("supplier_accounts"."credential_status" = 'unconfigured' or "supplier_accounts"."credential_reference" is not null),
	CONSTRAINT "supplier_accounts_enabled_markets_check" CHECK (not ('' = any("supplier_accounts"."enabled_markets"))),
	CONSTRAINT "supplier_accounts_fulfilment_origins_check" CHECK (not ('' = any("supplier_accounts"."fulfilment_origins"))),
	CONSTRAINT "supplier_accounts_rate_limit_check" CHECK (("supplier_accounts"."rate_limit_per_minute" is null or "supplier_accounts"."rate_limit_per_minute" >= 1)
          and ("supplier_accounts"."daily_order_quota" is null or "supplier_accounts"."daily_order_quota" >= 1)),
	CONSTRAINT "supplier_accounts_kill_switch_check" CHECK ((("supplier_accounts"."state" = 'killed') = ("supplier_accounts"."kill_switched_at" is not null))
          and num_nonnulls("supplier_accounts"."kill_switched_at", "supplier_accounts"."kill_switch_reason") in (0, 2))
);
--> statement-breakpoint
CREATE TABLE "supplier_agreement_evidence" (
	"id" text PRIMARY KEY NOT NULL,
	"agreement_id" text NOT NULL,
	"kind" text NOT NULL,
	"oxy_file_id" text,
	"url" text,
	"sha256" text,
	"note" text,
	"collected_by_oxy_user_id" text,
	"collected_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "supplier_agreement_evidence_kind_check" CHECK ("supplier_agreement_evidence"."kind" in ('contract_document', 'insurance_certificate', 'compliance_certificate', 'authorization_letter', 'price_list', 'other')),
	CONSTRAINT "supplier_agreement_evidence_target_check" CHECK (num_nonnulls("supplier_agreement_evidence"."oxy_file_id", "supplier_agreement_evidence"."url") >= 1),
	CONSTRAINT "supplier_agreement_evidence_sha256_check" CHECK ("supplier_agreement_evidence"."sha256" is null or "supplier_agreement_evidence"."sha256" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE "supplier_agreements" (
	"id" text PRIMARY KEY NOT NULL,
	"supplier_id" text NOT NULL,
	"version" integer NOT NULL,
	"approval_state" text DEFAULT 'draft' NOT NULL,
	"effective_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"permitted_destination_countries" text[] DEFAULT '{}' NOT NULL,
	"permitted_channels" text[] DEFAULT '{}' NOT NULL,
	"resale_rights_granted" boolean DEFAULT false NOT NULL,
	"dropship_rights_granted" boolean DEFAULT false NOT NULL,
	"white_label_rights_granted" boolean DEFAULT false NOT NULL,
	"blind_dropship_verified" boolean DEFAULT false NOT NULL,
	"catalog_data_rights_granted" boolean DEFAULT false NOT NULL,
	"image_rights_granted" boolean DEFAULT false NOT NULL,
	"pricing_data_rights_granted" boolean DEFAULT false NOT NULL,
	"excluded_brands" text[] DEFAULT '{}' NOT NULL,
	"excluded_categories" text[] DEFAULT '{}' NOT NULL,
	"excluded_product_refs" text[] DEFAULT '{}' NOT NULL,
	"map_restricted" boolean DEFAULT false NOT NULL,
	"pricing_restrictions_note" text,
	"acceptance_sla_hours" integer DEFAULT 48 NOT NULL,
	"shipment_sla_hours" integer,
	"packaging_branding_note" text,
	"returns_responsibility" text,
	"warranty_responsibility" text,
	"recall_responsibility" text,
	"incoterm" text,
	"shipping_terms_note" text,
	"payment_terms_kind" text DEFAULT 'prepaid_balance' NOT NULL,
	"credit_term_days" integer,
	"data_processing_terms_accepted" boolean DEFAULT false NOT NULL,
	"data_processing_note" text,
	"evidence_location" text,
	"reviewed_by_oxy_user_id" text,
	"approved_at" timestamp with time zone,
	"approved_by_oxy_user_id" text,
	"superseded_by_id" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "supplier_agreements_approval_state_check" CHECK ("supplier_agreements"."approval_state" in ('draft', 'under_review', 'approved', 'rejected', 'superseded', 'terminated')),
	CONSTRAINT "supplier_agreements_incoterm_check" CHECK ("supplier_agreements"."incoterm" in ('EXW', 'FCA', 'CPT', 'CIP', 'DAP', 'DPU', 'DDP', 'FAS', 'FOB', 'CFR', 'CIF')),
	CONSTRAINT "supplier_agreements_payment_terms_kind_check" CHECK ("supplier_agreements"."payment_terms_kind" in ('prepaid_balance', 'invoice_net')),
	CONSTRAINT "supplier_agreements_permitted_channels_check" CHECK ("supplier_agreements"."permitted_channels" <@ array['mercaria_marketplace', 'mercaria_branded_checkout']::text[]),
	CONSTRAINT "supplier_agreements_version_check" CHECK ("supplier_agreements"."version" >= 1),
	CONSTRAINT "supplier_agreements_window_check" CHECK ("supplier_agreements"."effective_at" is null or "supplier_agreements"."expires_at" is null or "supplier_agreements"."expires_at" > "supplier_agreements"."effective_at"),
	CONSTRAINT "supplier_agreements_destinations_check" CHECK (not ('' = any("supplier_agreements"."permitted_destination_countries"))),
	CONSTRAINT "supplier_agreements_sla_check" CHECK ("supplier_agreements"."acceptance_sla_hours" >= 1
          and ("supplier_agreements"."shipment_sla_hours" is null or "supplier_agreements"."shipment_sla_hours" >= 1)),
	CONSTRAINT "supplier_agreements_credit_terms_check" CHECK (("supplier_agreements"."payment_terms_kind" = 'invoice_net') = ("supplier_agreements"."credit_term_days" is not null)
          and ("supplier_agreements"."credit_term_days" is null or "supplier_agreements"."credit_term_days" >= 1)),
	CONSTRAINT "supplier_agreements_approved_complete_check" CHECK ("supplier_agreements"."approval_state" <> 'approved'
          or ("supplier_agreements"."approved_at" is not null
              and "supplier_agreements"."approved_by_oxy_user_id" is not null
              and "supplier_agreements"."reviewed_by_oxy_user_id" is not null
              and "supplier_agreements"."evidence_location" is not null
              and "supplier_agreements"."effective_at" is not null
              and "supplier_agreements"."data_processing_terms_accepted")),
	CONSTRAINT "supplier_agreements_superseded_check" CHECK (("supplier_agreements"."approval_state" = 'superseded') = ("supplier_agreements"."superseded_by_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "supplier_contacts" (
	"id" text PRIMARY KEY NOT NULL,
	"supplier_id" text NOT NULL,
	"kind" text NOT NULL,
	"name" text,
	"email" text,
	"phone" text,
	"url" text,
	"note" text,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "supplier_contacts_kind_check" CHECK ("supplier_contacts"."kind" in ('support', 'finance', 'returns', 'compliance')),
	CONSTRAINT "supplier_contacts_reachable_check" CHECK (num_nonnulls("supplier_contacts"."name", "supplier_contacts"."email", "supplier_contacts"."phone", "supplier_contacts"."url") >= 1)
);
--> statement-breakpoint
CREATE TABLE "supplier_events" (
	"id" text PRIMARY KEY NOT NULL,
	"supplier_id" text NOT NULL,
	"kind" text NOT NULL,
	"related_supplier_id" text,
	"by_oxy_user_id" text,
	"note" text,
	"at" timestamp with time zone NOT NULL,
	CONSTRAINT "supplier_events_kind_check" CHECK ("supplier_events"."kind" in ('created', 'updated', 'activated', 'suspended', 'deactivated', 'merged', 'replaced')),
	CONSTRAINT "supplier_events_related_check" CHECK ("supplier_events"."kind" not in ('merged', 'replaced') or "supplier_events"."related_supplier_id" is not null),
	CONSTRAINT "supplier_events_note_length_check" CHECK ("supplier_events"."note" is null or length("supplier_events"."note") <= 2000)
);
--> statement-breakpoint
CREATE TABLE "suppliers" (
	"id" text PRIMARY KEY NOT NULL,
	"status" text DEFAULT 'under_review' NOT NULL,
	"supplier_type" text NOT NULL,
	"canonical_name" text NOT NULL,
	"internal_aliases" text[] DEFAULT '{}' NOT NULL,
	"organization_id" text,
	"organization_verified_at" timestamp with time zone,
	"organization_verification_evidence" text,
	"establishment_countries" text[] DEFAULT '{}' NOT NULL,
	"fulfilment_origin_countries" text[] DEFAULT '{}' NOT NULL,
	"verified_domains" text[] DEFAULT '{}' NOT NULL,
	"risk_level" text DEFAULT 'unassessed' NOT NULL,
	"risk_reviewed_at" timestamp with time zone,
	"risk_review_note" text,
	"internal_notes" text,
	"activated_at" timestamp with time zone,
	"deactivated_at" timestamp with time zone,
	"deactivation_reason" text,
	"merged_into_id" text,
	"merged_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "suppliers_status_check" CHECK ("suppliers"."status" in ('under_review', 'active', 'suspended', 'deactivated', 'merged')),
	CONSTRAINT "suppliers_supplier_type_check" CHECK ("suppliers"."supplier_type" in ('wholesaler', 'dropship_distributor', 'manufacturer_direct', 'print_on_demand', 'fulfilment_partner')),
	CONSTRAINT "suppliers_risk_level_check" CHECK ("suppliers"."risk_level" in ('unassessed', 'low', 'medium', 'high', 'blocked')),
	CONSTRAINT "suppliers_canonical_name_check" CHECK (length(btrim("suppliers"."canonical_name")) > 0),
	CONSTRAINT "suppliers_internal_aliases_check" CHECK (not ('' = any("suppliers"."internal_aliases"))),
	CONSTRAINT "suppliers_establishment_countries_check" CHECK (not ('' = any("suppliers"."establishment_countries"))),
	CONSTRAINT "suppliers_fulfilment_origins_check" CHECK (not ('' = any("suppliers"."fulfilment_origin_countries"))),
	CONSTRAINT "suppliers_verified_domains_check" CHECK (not ('' = any("suppliers"."verified_domains"))),
	CONSTRAINT "suppliers_org_verification_complete_check" CHECK (num_nonnulls("suppliers"."organization_verified_at", "suppliers"."organization_verification_evidence") in (0, 2)),
	CONSTRAINT "suppliers_org_verification_target_check" CHECK ("suppliers"."organization_verified_at" is null or "suppliers"."organization_id" is not null),
	CONSTRAINT "suppliers_merged_check" CHECK (("suppliers"."status" = 'merged') = ("suppliers"."merged_into_id" is not null)
          and ("suppliers"."status" = 'merged') = ("suppliers"."merged_at" is not null)),
	CONSTRAINT "suppliers_deactivated_check" CHECK (("suppliers"."status" = 'deactivated') = ("suppliers"."deactivated_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "procurement_offers" ADD CONSTRAINT "procurement_offers_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "procurement_offers" ADD CONSTRAINT "procurement_offers_supplier_account_id_supplier_accounts_id_fk" FOREIGN KEY ("supplier_account_id") REFERENCES "public"."supplier_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "procurement_offers" ADD CONSTRAINT "procurement_offers_agreement_id_supplier_agreements_id_fk" FOREIGN KEY ("agreement_id") REFERENCES "public"."supplier_agreements"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_purchase_order_id_purchase_orders_id_fk" FOREIGN KEY ("purchase_order_id") REFERENCES "public"."purchase_orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_shipments" ADD CONSTRAINT "purchase_order_shipments_purchase_order_id_purchase_orders_id_fk" FOREIGN KEY ("purchase_order_id") REFERENCES "public"."purchase_orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_transitions" ADD CONSTRAINT "purchase_order_transitions_purchase_order_id_purchase_orders_id_fk" FOREIGN KEY ("purchase_order_id") REFERENCES "public"."purchase_orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_supplier_account_id_supplier_accounts_id_fk" FOREIGN KEY ("supplier_account_id") REFERENCES "public"."supplier_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_agreement_id_supplier_agreements_id_fk" FOREIGN KEY ("agreement_id") REFERENCES "public"."supplier_agreements"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_accounts" ADD CONSTRAINT "supplier_accounts_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_agreement_evidence" ADD CONSTRAINT "supplier_agreement_evidence_agreement_id_supplier_agreements_id_fk" FOREIGN KEY ("agreement_id") REFERENCES "public"."supplier_agreements"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_agreements" ADD CONSTRAINT "supplier_agreements_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_agreements" ADD CONSTRAINT "supplier_agreements_superseded_by_id_supplier_agreements_id_fk" FOREIGN KEY ("superseded_by_id") REFERENCES "public"."supplier_agreements"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_contacts" ADD CONSTRAINT "supplier_contacts_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_events" ADD CONSTRAINT "supplier_events_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_events" ADD CONSTRAINT "supplier_events_related_supplier_id_suppliers_id_fk" FOREIGN KEY ("related_supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_merged_into_id_suppliers_id_fk" FOREIGN KEY ("merged_into_id") REFERENCES "public"."suppliers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "procurement_offers_account_sku_key" ON "procurement_offers" USING btree ("supplier_account_id","supplier_sku");--> statement-breakpoint
CREATE INDEX "procurement_offers_variant_idx" ON "procurement_offers" USING btree ("canonical_variant_id","status") WHERE "procurement_offers"."canonical_variant_id" is not null;--> statement-breakpoint
CREATE INDEX "procurement_offers_supplier_idx" ON "procurement_offers" USING btree ("supplier_id","status");--> statement-breakpoint
CREATE INDEX "procurement_offers_freshness_idx" ON "procurement_offers" USING btree ("status","last_confirmed_at");--> statement-breakpoint
CREATE INDEX "procurement_offers_expires_at_idx" ON "procurement_offers" USING btree ("expires_at") WHERE "procurement_offers"."expires_at" is not null;--> statement-breakpoint
CREATE INDEX "procurement_offers_destinations_gin_idx" ON "procurement_offers" USING gin ("eligible_destination_countries");--> statement-breakpoint
CREATE INDEX "purchase_order_lines_purchase_order_id_idx" ON "purchase_order_lines" USING btree ("purchase_order_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "purchase_order_shipments_po_tracking_key" ON "purchase_order_shipments" USING btree ("purchase_order_id","tracking_number");--> statement-breakpoint
CREATE INDEX "purchase_order_transitions_po_id_at_idx" ON "purchase_order_transitions" USING btree ("purchase_order_id","at");--> statement-breakpoint
CREATE UNIQUE INDEX "purchase_orders_idempotency_key_key" ON "purchase_orders" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "purchase_orders_order_id_idx" ON "purchase_orders" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "purchase_orders_checkout_group_id_idx" ON "purchase_orders" USING btree ("checkout_group_id") WHERE "purchase_orders"."checkout_group_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "purchase_orders_supplier_external_order_key" ON "purchase_orders" USING btree ("supplier_account_id","supplier_external_order_id") WHERE "purchase_orders"."supplier_external_order_id" is not null;--> statement-breakpoint
CREATE INDEX "purchase_orders_supplier_status_idx" ON "purchase_orders" USING btree ("supplier_id","status","created_at");--> statement-breakpoint
CREATE INDEX "purchase_orders_submitted_deadline_idx" ON "purchase_orders" USING btree ("acceptance_deadline_at") WHERE "purchase_orders"."status" = 'submitted';--> statement-breakpoint
CREATE INDEX "purchase_orders_operator_queue_idx" ON "purchase_orders" USING btree ("created_at") WHERE "purchase_orders"."operator_intervention_required";--> statement-breakpoint
CREATE INDEX "purchase_orders_unreconciled_idx" ON "purchase_orders" USING btree ("created_at") WHERE "purchase_orders"."status" = 'delivered' and "purchase_orders"."reconciled_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "supplier_accounts_provider_account_key" ON "supplier_accounts" USING btree ("provider","environment","provider_account_id");--> statement-breakpoint
CREATE INDEX "supplier_accounts_supplier_id_idx" ON "supplier_accounts" USING btree ("supplier_id","state");--> statement-breakpoint
CREATE INDEX "supplier_agreement_evidence_agreement_id_idx" ON "supplier_agreement_evidence" USING btree ("agreement_id");--> statement-breakpoint
CREATE UNIQUE INDEX "supplier_agreements_supplier_version_key" ON "supplier_agreements" USING btree ("supplier_id","version");--> statement-breakpoint
CREATE INDEX "supplier_agreements_active_idx" ON "supplier_agreements" USING btree ("supplier_id","effective_at","expires_at") WHERE "supplier_agreements"."approval_state" = 'approved';--> statement-breakpoint
CREATE INDEX "supplier_agreements_expiry_idx" ON "supplier_agreements" USING btree ("expires_at") WHERE "supplier_agreements"."approval_state" = 'approved' and "supplier_agreements"."expires_at" is not null;--> statement-breakpoint
CREATE INDEX "supplier_contacts_supplier_id_idx" ON "supplier_contacts" USING btree ("supplier_id","kind","position");--> statement-breakpoint
CREATE INDEX "supplier_events_supplier_id_at_idx" ON "supplier_events" USING btree ("supplier_id","at");--> statement-breakpoint
CREATE INDEX "suppliers_status_idx" ON "suppliers" USING btree ("status","created_at");--> statement-breakpoint
-- ## Purchase-order immutability, enforced where it cannot be bypassed
--
-- `db/procurement/purchaseOrderRepository.ts` is the only writer and its
-- transition is a CAS — but that protects only callers that go through it. A
-- backfill script, an operator at a `psql` prompt and a future service all
-- reach these tables without it, and #118's consistency rules 6 and 7 ("a
-- merge cannot rewrite a historical PurchaseOrder"; "source refresh cannot
-- silently change the cost snapshot of an already submitted order") are
-- properties the DATABASE has to hold, not conventions.
--
-- Three enforcements, same shape as the ledger's (0002): BEFORE, SQLSTATE
-- 23514, a message that says what to do instead.
--
-- 1. A PO line is immutable from birth: the line set IS the quote snapshot.
CREATE FUNCTION mercaria_purchase_order_lines_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'purchase_order_lines are an immutable quote snapshot: % is refused. A wrong '
    'order is cancelled and re-created, never edited.',
    TG_OP
    USING ERRCODE = 'check_violation';
END;
$$;--> statement-breakpoint
CREATE TRIGGER purchase_order_lines_immutable
  BEFORE UPDATE OR DELETE ON "purchase_order_lines"
  FOR EACH ROW EXECUTE FUNCTION mercaria_purchase_order_lines_immutable();--> statement-breakpoint
-- 2. A PO's identity never changes (which supplier, which account, which
--    agreement version, which customer order, which idempotency key) — the
--    trigger form of "a merge cannot rewrite a historical PurchaseOrder".
-- 3. A PO's money, fx snapshot and destination snapshot freeze the moment it
--    leaves `draft` — the trigger form of "source refresh cannot silently
--    change the cost snapshot of an already submitted order".
CREATE FUNCTION mercaria_purchase_order_frozen() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.supplier_id IS DISTINCT FROM OLD.supplier_id
     OR NEW.supplier_account_id IS DISTINCT FROM OLD.supplier_account_id
     OR NEW.agreement_id IS DISTINCT FROM OLD.agreement_id
     OR NEW.order_id IS DISTINCT FROM OLD.order_id
     OR NEW.checkout_group_id IS DISTINCT FROM OLD.checkout_group_id
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key THEN
    RAISE EXCEPTION
      'purchase_orders identity columns are immutable: a merge or repoint may never '
      'rewrite which supplier, agreement or customer order a historical PO names.'
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status <> 'draft'
     AND (NEW.currency IS DISTINCT FROM OLD.currency
          OR NEW.items_amount IS DISTINCT FROM OLD.items_amount
          OR NEW.shipping_amount IS DISTINCT FROM OLD.shipping_amount
          OR NEW.tax_amount IS DISTINCT FROM OLD.tax_amount
          OR NEW.duty_amount IS DISTINCT FROM OLD.duty_amount
          OR NEW.total_amount IS DISTINCT FROM OLD.total_amount
          OR NEW.fx_rate_from IS DISTINCT FROM OLD.fx_rate_from
          OR NEW.fx_rate_to IS DISTINCT FROM OLD.fx_rate_to
          OR NEW.fx_rate_rate IS DISTINCT FROM OLD.fx_rate_rate
          OR NEW.fx_rate_provider IS DISTINCT FROM OLD.fx_rate_provider
          OR NEW.fx_rate_as_of IS DISTINCT FROM OLD.fx_rate_as_of
          OR NEW.destination_recipient_name IS DISTINCT FROM OLD.destination_recipient_name
          OR NEW.destination_line1 IS DISTINCT FROM OLD.destination_line1
          OR NEW.destination_line2 IS DISTINCT FROM OLD.destination_line2
          OR NEW.destination_city IS DISTINCT FROM OLD.destination_city
          OR NEW.destination_region IS DISTINCT FROM OLD.destination_region
          OR NEW.destination_postal_code IS DISTINCT FROM OLD.destination_postal_code
          OR NEW.destination_country IS DISTINCT FROM OLD.destination_country
          OR NEW.destination_phone IS DISTINCT FROM OLD.destination_phone) THEN
    RAISE EXCEPTION
      'purchase_orders cost and destination snapshots are frozen after submission: '
      'a cost change is a new customer decision or an absorbed variance (ADR 0004 '
      'D3/D8), never an edit of what was ordered.'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER purchase_orders_frozen
  BEFORE UPDATE ON "purchase_orders"
  FOR EACH ROW EXECUTE FUNCTION mercaria_purchase_order_frozen();