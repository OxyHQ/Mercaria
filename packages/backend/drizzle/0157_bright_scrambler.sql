-- oxy:deploy-phase=pre
-- oxy:rollback=replay: every statement here is additive except one - "suppliers_supplier_type_check" is DROPPED and re-added one member wider ('digital_distributor'), and its previous definition lives in the migration that created it rather than here. The inverse is therefore not readable off this file alone, and re-adding the narrower form FAILS LOUDLY while a supplier row carries the new value, which is correct behaviour. Nothing is lost: the ten new tables invert to drops, and the widened CHECK re-derives from the shared-types tuple by a forward path
--
-- #1016 / ADR 0011 - authorized digital retail.
--
-- Ten new tables (the supply rider and its per-capability rows, private
-- procurement offers, the retail pricing policy, the digital purchase order and
-- its attempt log, and the buyer-facing fulfilment with its sealed artifacts,
-- reveal audit and incident record), plus ONE widened CHECK on `suppliers`.
--
-- ## Why `pre`
--
-- Every statement is additive in effect against both images. The ten tables are
-- new, so the image still serving reads and writes none of them. The widened
-- CHECK admits one extra `supplier_type` value that the serving image never
-- writes. There is no drop, no rename and no narrowing anywhere in the file.
--
-- ## The five hand-written triggers at the bottom
--
-- drizzle-kit models no trigger, so a regeneration DROPS them silently. They are
-- anchored with `-- oxy:handwritten-begin=` / `-- oxy:handwritten-end=` markers
-- and `migration-handwritten-markers.test.ts` fails the build if one loses its
-- anchor. REAPPLY them after any regeneration of this domain.
--
-- What they hold is the half of ADR 0011 D11/D12 that a CHECK cannot: nothing in
-- this domain is ever deleted, the attempt log and the reveal audit refuse UPDATE
-- as well, and a sealed artifact's ciphertext cannot be swapped for another after
-- the fact. This is the evidence a chargeback over a used key is answered from.
--
-- The purchase-order TRANSITION table is deliberately NOT encoded here. It lives
-- in `DIGITAL_PURCHASE_ORDER_TRANSITIONS` and is enforced by the compare-and-swap
-- in `digitalPurchaseOrderRepository`; a second copy in plpgsql would be a second
-- authority over one fact, and the two would disagree exactly once.
CREATE TABLE "digital_fulfilment_artifacts" (
	"id" text PRIMARY KEY NOT NULL,
	"fulfilment_id" text NOT NULL,
	"capability" text NOT NULL,
	"source" text NOT NULL,
	"state" text DEFAULT 'active' NOT NULL,
	"sealed_secret" text,
	"key_reference" text,
	"seal_algorithm" text,
	"plaintext_sha256" text,
	"masked_hint" text,
	"instructions" text,
	"provider_artifact_id" text,
	"redemption_state" text DEFAULT 'unknown' NOT NULL,
	"redemption_checked_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"replaces_artifact_id" text,
	"incident_id" text,
	"operator_oxy_user_id" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "digital_fulfilment_artifacts_capability_check" CHECK ("digital_fulfilment_artifacts"."capability" in ('activation_key', 'redemption_code', 'licence_token', 'licence_file', 'direct_account_activation', 'external_account_link_activation')),
	CONSTRAINT "digital_fulfilment_artifacts_source_check" CHECK ("digital_fulfilment_artifacts"."source" in ('supplier_api', 'supplier_callback', 'operator_manual')),
	CONSTRAINT "digital_fulfilment_artifacts_state_check" CHECK ("digital_fulfilment_artifacts"."state" in ('active', 'replaced', 'revoked', 'expired')),
	CONSTRAINT "digital_fulfilment_artifacts_redemption_check" CHECK ("digital_fulfilment_artifacts"."redemption_state" in ('unknown', 'unredeemed', 'redeemed', 'invalid')),
	CONSTRAINT "digital_fulfilment_artifacts_secret_presence_check" CHECK (("digital_fulfilment_artifacts"."capability" in ('activation_key', 'redemption_code', 'licence_token'))
          = ("digital_fulfilment_artifacts"."sealed_secret" is not null)),
	CONSTRAINT "digital_fulfilment_artifacts_seal_shape_check" CHECK (num_nonnulls("digital_fulfilment_artifacts"."sealed_secret", "digital_fulfilment_artifacts"."key_reference", "digital_fulfilment_artifacts"."seal_algorithm") in (0, 3)),
	CONSTRAINT "digital_fulfilment_artifacts_key_reference_check" CHECK ("digital_fulfilment_artifacts"."key_reference" is null
          or ("digital_fulfilment_artifacts"."key_reference" ~ '^/[A-Za-z0-9/_.-]+$' and length("digital_fulfilment_artifacts"."key_reference") <= 512)),
	CONSTRAINT "digital_fulfilment_artifacts_digest_check" CHECK ("digital_fulfilment_artifacts"."plaintext_sha256" is null or "digital_fulfilment_artifacts"."plaintext_sha256" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "digital_fulfilment_artifacts_hint_check" CHECK ("digital_fulfilment_artifacts"."masked_hint" is null
          or (length("digital_fulfilment_artifacts"."masked_hint") between 1 and 4 and "digital_fulfilment_artifacts"."masked_hint" = btrim("digital_fulfilment_artifacts"."masked_hint"))),
	CONSTRAINT "digital_fulfilment_artifacts_hint_pairing_check" CHECK ("digital_fulfilment_artifacts"."masked_hint" is null or "digital_fulfilment_artifacts"."sealed_secret" is not null),
	CONSTRAINT "digital_fulfilment_artifacts_operator_check" CHECK (("digital_fulfilment_artifacts"."source" = 'operator_manual')
          = ("digital_fulfilment_artifacts"."operator_oxy_user_id" is not null and "digital_fulfilment_artifacts"."incident_id" is not null)),
	CONSTRAINT "digital_fulfilment_artifacts_redemption_clock_check" CHECK ("digital_fulfilment_artifacts"."redemption_state" = 'unknown' or "digital_fulfilment_artifacts"."redemption_checked_at" is not null),
	CONSTRAINT "digital_fulfilment_artifacts_replacement_check" CHECK ("digital_fulfilment_artifacts"."replaces_artifact_id" is distinct from "digital_fulfilment_artifacts"."id"
          and ("digital_fulfilment_artifacts"."replaces_artifact_id" is null or "digital_fulfilment_artifacts"."incident_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "digital_fulfilment_incidents" (
	"id" text PRIMARY KEY NOT NULL,
	"fulfilment_id" text NOT NULL,
	"artifact_id" text,
	"kind" text NOT NULL,
	"state" text DEFAULT 'open' NOT NULL,
	"report_note" text,
	"buyer_key" text,
	"operator_oxy_user_id" text,
	"supplier_case_ref" text,
	"replacement_artifact_id" text,
	"resolution_note" text,
	"reported_at" timestamp with time zone NOT NULL,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "digital_fulfilment_incidents_kind_check" CHECK ("digital_fulfilment_incidents"."kind" in ('buyer_reported_invalid', 'buyer_reported_used', 'buyer_reported_wrong_region', 'supplier_reported_invalid', 'provider_incident', 'operator_escalation')),
	CONSTRAINT "digital_fulfilment_incidents_state_check" CHECK ("digital_fulfilment_incidents"."state" in ('open', 'supplier_escalated', 'replacement_issued', 'refunded', 'credited', 'closed_no_action')),
	CONSTRAINT "digital_fulfilment_incidents_buyer_key_check" CHECK ("digital_fulfilment_incidents"."buyer_key" is null or "digital_fulfilment_incidents"."buyer_key" ~ '^(oxy|guest):[^[:space:]]+$'),
	CONSTRAINT "digital_fulfilment_incidents_operator_check" CHECK ("digital_fulfilment_incidents"."kind" not in ('provider_incident', 'operator_escalation')
          or "digital_fulfilment_incidents"."operator_oxy_user_id" is not null),
	CONSTRAINT "digital_fulfilment_incidents_replacement_check" CHECK (("digital_fulfilment_incidents"."state" = 'replacement_issued') = ("digital_fulfilment_incidents"."replacement_artifact_id" is not null)),
	CONSTRAINT "digital_fulfilment_incidents_resolved_check" CHECK (("digital_fulfilment_incidents"."state" in ('open', 'supplier_escalated')) = ("digital_fulfilment_incidents"."resolved_at" is null))
);
--> statement-breakpoint
CREATE TABLE "digital_fulfilment_reveals" (
	"id" text PRIMARY KEY NOT NULL,
	"fulfilment_id" text NOT NULL,
	"artifact_id" text NOT NULL,
	"actor_kind" text NOT NULL,
	"buyer_key" text,
	"operator_oxy_user_id" text,
	"reason" text,
	"revealed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "digital_fulfilment_reveals_actor_check" CHECK ("digital_fulfilment_reveals"."actor_kind" in ('buyer', 'operator')),
	CONSTRAINT "digital_fulfilment_reveals_buyer_key_check" CHECK ("digital_fulfilment_reveals"."buyer_key" is null or "digital_fulfilment_reveals"."buyer_key" ~ '^(oxy|guest):[^[:space:]]+$'),
	CONSTRAINT "digital_fulfilment_reveals_actor_shape_check" CHECK (("digital_fulfilment_reveals"."actor_kind" = 'buyer') = ("digital_fulfilment_reveals"."buyer_key" is not null)
          and ("digital_fulfilment_reveals"."actor_kind" = 'operator')
              = ("digital_fulfilment_reveals"."operator_oxy_user_id" is not null and "digital_fulfilment_reveals"."reason" is not null))
);
--> statement-breakpoint
CREATE TABLE "digital_fulfilments" (
	"id" text PRIMARY KEY NOT NULL,
	"purchase_order_id" text NOT NULL,
	"order_id" text NOT NULL,
	"order_item_id" text NOT NULL,
	"buyer_key" text NOT NULL,
	"capability" text NOT NULL,
	"product_class" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"canonical_variant_id" text,
	"display_title" text NOT NULL,
	"platform" text NOT NULL,
	"activation_ecosystem" text NOT NULL,
	"edition" text NOT NULL,
	"delivered_at" timestamp with time zone,
	"first_revealed_at" timestamp with time zone,
	"reveal_count" integer DEFAULT 0 NOT NULL,
	"refunded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "digital_fulfilments_capability_check" CHECK ("digital_fulfilments"."capability" in ('activation_key', 'redemption_code', 'licence_token', 'licence_file', 'direct_account_activation', 'external_account_link_activation')),
	CONSTRAINT "digital_fulfilments_product_class_check" CHECK ("digital_fulfilments"."product_class" in ('digital_game', 'game_expansion', 'software_licence', 'subscription_activation_code')),
	CONSTRAINT "digital_fulfilments_status_check" CHECK ("digital_fulfilments"."status" in ('pending', 'delivered', 'refunded', 'revoked')),
	CONSTRAINT "digital_fulfilments_buyer_key_check" CHECK ("digital_fulfilments"."buyer_key" ~ '^(oxy|guest):[^[:space:]]+$'),
	CONSTRAINT "digital_fulfilments_order_refs_check" CHECK (length(btrim("digital_fulfilments"."order_id")) > 0 and length(btrim("digital_fulfilments"."order_item_id")) > 0),
	CONSTRAINT "digital_fulfilments_title_check" CHECK (length(btrim("digital_fulfilments"."display_title")) > 0),
	CONSTRAINT "digital_fulfilments_slugs_check" CHECK ("digital_fulfilments"."platform" ~ '^[a-z0-9][a-z0-9_-]*$'
          and "digital_fulfilments"."activation_ecosystem" ~ '^[a-z0-9][a-z0-9_-]*$'
          and "digital_fulfilments"."edition" ~ '^[a-z0-9][a-z0-9_-]*$'),
	CONSTRAINT "digital_fulfilments_delivered_check" CHECK (("digital_fulfilments"."status" = 'pending') = ("digital_fulfilments"."delivered_at" is null)),
	CONSTRAINT "digital_fulfilments_refunded_check" CHECK (("digital_fulfilments"."status" = 'refunded') = ("digital_fulfilments"."refunded_at" is not null)),
	CONSTRAINT "digital_fulfilments_reveal_check" CHECK ("digital_fulfilments"."reveal_count" >= 0
          and ("digital_fulfilments"."reveal_count" = 0) = ("digital_fulfilments"."first_revealed_at" is null))
);
--> statement-breakpoint
CREATE TABLE "digital_procurement_offers" (
	"id" text PRIMARY KEY NOT NULL,
	"supplier_id" text NOT NULL,
	"supplier_account_id" text NOT NULL,
	"digital_supply_terms_id" text,
	"canonical_product_id" text,
	"canonical_variant_id" text,
	"supplier_sku" text NOT NULL,
	"supplier_external_id" text,
	"supplier_native_title" text NOT NULL,
	"brand_slug" text,
	"product_class" text NOT NULL,
	"fulfilment_capability" text NOT NULL,
	"tax_class" text NOT NULL,
	"platform" text NOT NULL,
	"activation_ecosystem" text NOT NULL,
	"edition" text NOT NULL,
	"activation_territories" text[] DEFAULT '{}' NOT NULL,
	"language_restrictions" text[] DEFAULT '{}' NOT NULL,
	"cost_amount" bigint NOT NULL,
	"cost_currency" text NOT NULL,
	"availability" text DEFAULT 'unknown' NOT NULL,
	"available_quantity" integer,
	"mapping_status" text DEFAULT 'unmapped' NOT NULL,
	"mapping_note" text,
	"status" text DEFAULT 'active' NOT NULL,
	"source_provenance" text DEFAULT 'api' NOT NULL,
	"quote_ttl_seconds" integer,
	"expires_at" timestamp with time zone,
	"expected_fulfilment_seconds" integer,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_confirmed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "digital_procurement_offers_product_class_check" CHECK ("digital_procurement_offers"."product_class" in ('digital_game', 'game_expansion', 'software_licence', 'subscription_activation_code')),
	CONSTRAINT "digital_procurement_offers_capability_check" CHECK ("digital_procurement_offers"."fulfilment_capability" in ('activation_key', 'redemption_code', 'licence_token', 'licence_file', 'direct_account_activation', 'external_account_link_activation')),
	CONSTRAINT "digital_procurement_offers_tax_class_check" CHECK ("digital_procurement_offers"."tax_class" in ('electronically_supplied_service', 'software_licence_supply', 'content_licence_supply')),
	CONSTRAINT "digital_procurement_offers_availability_check" CHECK ("digital_procurement_offers"."availability" in ('in_stock', 'out_of_stock', 'limited', 'discontinued', 'unknown')),
	CONSTRAINT "digital_procurement_offers_mapping_status_check" CHECK ("digital_procurement_offers"."mapping_status" in ('exact', 'ambiguous', 'unmapped')),
	CONSTRAINT "digital_procurement_offers_status_check" CHECK ("digital_procurement_offers"."status" in ('active', 'retired')),
	CONSTRAINT "digital_procurement_offers_source_provenance_check" CHECK ("digital_procurement_offers"."source_provenance" in ('feed', 'api', 'manual', 'import')),
	CONSTRAINT "digital_procurement_offers_cost_currency_check" CHECK ("digital_procurement_offers"."cost_currency" in ('FAIR', 'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF', 'CNY', 'SEK', 'NOK', 'DKK', 'PLN', 'MXN', 'BRL', 'INR', 'NZD', 'ZAR', 'SGD', 'HKD', 'AED')),
	CONSTRAINT "digital_procurement_offers_sku_check" CHECK (length(btrim("digital_procurement_offers"."supplier_sku")) > 0),
	CONSTRAINT "digital_procurement_offers_native_title_check" CHECK (length(btrim("digital_procurement_offers"."supplier_native_title")) > 0),
	CONSTRAINT "digital_procurement_offers_slugs_check" CHECK ("digital_procurement_offers"."platform" ~ '^[a-z0-9][a-z0-9_-]*$'
          and "digital_procurement_offers"."activation_ecosystem" ~ '^[a-z0-9][a-z0-9_-]*$'
          and "digital_procurement_offers"."edition" ~ '^[a-z0-9][a-z0-9_-]*$'
          and ("digital_procurement_offers"."brand_slug" is null or "digital_procurement_offers"."brand_slug" ~ '^[a-z0-9][a-z0-9_-]*$')),
	CONSTRAINT "digital_procurement_offers_territories_check" CHECK (not ('' = any("digital_procurement_offers"."activation_territories"))
          and not ('' = any("digital_procurement_offers"."language_restrictions"))),
	CONSTRAINT "digital_procurement_offers_cost_check" CHECK ("digital_procurement_offers"."cost_amount" > 0),
	CONSTRAINT "digital_procurement_offers_quantity_check" CHECK ("digital_procurement_offers"."available_quantity" is null or "digital_procurement_offers"."available_quantity" >= 0),
	CONSTRAINT "digital_procurement_offers_ttl_check" CHECK (("digital_procurement_offers"."quote_ttl_seconds" is null or "digital_procurement_offers"."quote_ttl_seconds" >= 1)
          and ("digital_procurement_offers"."expected_fulfilment_seconds" is null or "digital_procurement_offers"."expected_fulfilment_seconds" >= 0)),
	CONSTRAINT "digital_procurement_offers_mapping_shape_check" CHECK ((("digital_procurement_offers"."mapping_status" = 'unmapped') = ("digital_procurement_offers"."canonical_variant_id" is null))
          and ("digital_procurement_offers"."mapping_status" <> 'exact' or "digital_procurement_offers"."canonical_product_id" is not null)),
	CONSTRAINT "digital_procurement_offers_mapping_note_check" CHECK (("digital_procurement_offers"."mapping_status" = 'ambiguous') = ("digital_procurement_offers"."mapping_note" is not null)),
	CONSTRAINT "digital_procurement_offers_first_seen_check" CHECK ("digital_procurement_offers"."last_confirmed_at" >= "digital_procurement_offers"."first_seen_at")
);
--> statement-breakpoint
CREATE TABLE "digital_purchase_order_attempts" (
	"id" text PRIMARY KEY NOT NULL,
	"purchase_order_id" text NOT NULL,
	"attempt_number" integer NOT NULL,
	"operation" text NOT NULL,
	"outcome" text NOT NULL,
	"error_kind" text,
	"error_message_redacted" text,
	"provider_request_id" text,
	"provider_reference" text,
	"duration_ms" integer,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "digital_purchase_order_attempts_operation_check" CHECK ("digital_purchase_order_attempts"."operation" in ('catalog_sync', 'product_lookup', 'stock_query', 'quote', 'preflight', 'purchase', 'purchase_recovery', 'fulfilment_fetch', 'order_status', 'cancel', 'credit_status', 'callback_events', 'health')),
	CONSTRAINT "digital_purchase_order_attempts_outcome_check" CHECK ("digital_purchase_order_attempts"."outcome" in ('succeeded', 'failed', 'ambiguous')),
	CONSTRAINT "digital_purchase_order_attempts_error_kind_check" CHECK ("digital_purchase_order_attempts"."error_kind" in ('out_of_stock', 'price_changed', 'sku_unknown', 'region_not_served', 'rights_restricted', 'rate_limited', 'authentication_failed', 'insufficient_funding', 'provider_unavailable', 'provider_rejected', 'invalid_request', 'duplicate_request', 'timeout', 'other')),
	CONSTRAINT "digital_purchase_order_attempts_number_check" CHECK ("digital_purchase_order_attempts"."attempt_number" >= 1),
	CONSTRAINT "digital_purchase_order_attempts_error_shape_check" CHECK (("digital_purchase_order_attempts"."outcome" = 'succeeded') = ("digital_purchase_order_attempts"."error_kind" is null)
          and ("digital_purchase_order_attempts"."error_message_redacted" is null or "digital_purchase_order_attempts"."error_kind" is not null)),
	CONSTRAINT "digital_purchase_order_attempts_clock_check" CHECK ("digital_purchase_order_attempts"."finished_at" >= "digital_purchase_order_attempts"."started_at"
          and ("digital_purchase_order_attempts"."duration_ms" is null or "digital_purchase_order_attempts"."duration_ms" >= 0))
);
--> statement-breakpoint
CREATE TABLE "digital_purchase_orders" (
	"id" text PRIMARY KEY NOT NULL,
	"idempotency_key" text NOT NULL,
	"attempt_ordinal" integer DEFAULT 1 NOT NULL,
	"order_id" text NOT NULL,
	"order_item_id" text NOT NULL,
	"supplier_id" text NOT NULL,
	"supplier_account_id" text NOT NULL,
	"digital_supply_terms_id" text NOT NULL,
	"digital_procurement_offer_id" text,
	"canonical_variant_id" text,
	"supplier_sku" text NOT NULL,
	"product_class" text NOT NULL,
	"fulfilment_capability" text NOT NULL,
	"platform" text NOT NULL,
	"activation_ecosystem" text NOT NULL,
	"edition" text NOT NULL,
	"quoted_cost_amount" bigint NOT NULL,
	"quoted_cost_currency" text NOT NULL,
	"max_accepted_cost_amount" bigint NOT NULL,
	"max_accepted_cost_currency" text NOT NULL,
	"final_cost_amount" bigint,
	"final_cost_currency" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"status_changed_at" timestamp with time zone NOT NULL,
	"provider_order_id" text,
	"provider_reference" text,
	"error_kind" text,
	"error_message_redacted" text,
	"preflighted_at" timestamp with time zone,
	"submitted_at" timestamp with time zone,
	"ambiguous_since" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"previous_purchase_order_id" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "digital_purchase_orders_status_check" CHECK ("digital_purchase_orders"."status" in ('pending', 'preflighted', 'submitting', 'ambiguous', 'accepted', 'fulfilled', 'rejected', 'cancelled', 'credited', 'failed')),
	CONSTRAINT "digital_purchase_orders_product_class_check" CHECK ("digital_purchase_orders"."product_class" in ('digital_game', 'game_expansion', 'software_licence', 'subscription_activation_code')),
	CONSTRAINT "digital_purchase_orders_capability_check" CHECK ("digital_purchase_orders"."fulfilment_capability" in ('activation_key', 'redemption_code', 'licence_token', 'licence_file', 'direct_account_activation', 'external_account_link_activation')),
	CONSTRAINT "digital_purchase_orders_error_kind_check" CHECK ("digital_purchase_orders"."error_kind" in ('out_of_stock', 'price_changed', 'sku_unknown', 'region_not_served', 'rights_restricted', 'rate_limited', 'authentication_failed', 'insufficient_funding', 'provider_unavailable', 'provider_rejected', 'invalid_request', 'duplicate_request', 'timeout', 'other')),
	CONSTRAINT "digital_purchase_orders_quoted_cost_currency_check" CHECK ("digital_purchase_orders"."quoted_cost_currency" in ('FAIR', 'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF', 'CNY', 'SEK', 'NOK', 'DKK', 'PLN', 'MXN', 'BRL', 'INR', 'NZD', 'ZAR', 'SGD', 'HKD', 'AED')),
	CONSTRAINT "digital_purchase_orders_max_accepted_cost_currency_check" CHECK ("digital_purchase_orders"."max_accepted_cost_currency" in ('FAIR', 'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF', 'CNY', 'SEK', 'NOK', 'DKK', 'PLN', 'MXN', 'BRL', 'INR', 'NZD', 'ZAR', 'SGD', 'HKD', 'AED')),
	CONSTRAINT "digital_purchase_orders_final_cost_currency_check" CHECK ("digital_purchase_orders"."final_cost_currency" in ('FAIR', 'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF', 'CNY', 'SEK', 'NOK', 'DKK', 'PLN', 'MXN', 'BRL', 'INR', 'NZD', 'ZAR', 'SGD', 'HKD', 'AED')),
	CONSTRAINT "digital_purchase_orders_idempotency_key_check" CHECK ("digital_purchase_orders"."idempotency_key" ~ '^dpo:[A-Za-z0-9_-]+:[0-9]+$'),
	CONSTRAINT "digital_purchase_orders_attempt_check" CHECK ("digital_purchase_orders"."attempt_ordinal" >= 1),
	CONSTRAINT "digital_purchase_orders_chain_check" CHECK (("digital_purchase_orders"."attempt_ordinal" = 1) = ("digital_purchase_orders"."previous_purchase_order_id" is null)),
	CONSTRAINT "digital_purchase_orders_order_refs_check" CHECK (length(btrim("digital_purchase_orders"."order_id")) > 0 and length(btrim("digital_purchase_orders"."order_item_id")) > 0),
	CONSTRAINT "digital_purchase_orders_slugs_check" CHECK ("digital_purchase_orders"."platform" ~ '^[a-z0-9][a-z0-9_-]*$'
          and "digital_purchase_orders"."activation_ecosystem" ~ '^[a-z0-9][a-z0-9_-]*$'
          and "digital_purchase_orders"."edition" ~ '^[a-z0-9][a-z0-9_-]*$'),
	CONSTRAINT "digital_purchase_orders_cost_bound_check" CHECK ("digital_purchase_orders"."quoted_cost_currency" = "digital_purchase_orders"."max_accepted_cost_currency"
          and "digital_purchase_orders"."max_accepted_cost_amount" >= "digital_purchase_orders"."quoted_cost_amount"
          and "digital_purchase_orders"."quoted_cost_amount" > 0),
	CONSTRAINT "digital_purchase_orders_final_cost_check" CHECK (num_nonnulls("digital_purchase_orders"."final_cost_amount", "digital_purchase_orders"."final_cost_currency") in (0, 2)
          and ("digital_purchase_orders"."final_cost_currency" is null or "digital_purchase_orders"."final_cost_currency" = "digital_purchase_orders"."quoted_cost_currency")
          and ("digital_purchase_orders"."final_cost_amount" is null or "digital_purchase_orders"."final_cost_amount" <= "digital_purchase_orders"."max_accepted_cost_amount")),
	CONSTRAINT "digital_purchase_orders_clock_check" CHECK (("digital_purchase_orders"."submitted_at" is null or "digital_purchase_orders"."preflighted_at" is not null)
          and ("digital_purchase_orders"."status" <> 'ambiguous' or "digital_purchase_orders"."ambiguous_since" is not null)),
	CONSTRAINT "digital_purchase_orders_resolved_check" CHECK ("digital_purchase_orders"."status" not in ('fulfilled', 'rejected', 'cancelled', 'credited', 'failed')
          or "digital_purchase_orders"."resolved_at" is not null),
	CONSTRAINT "digital_purchase_orders_error_pairing_check" CHECK ("digital_purchase_orders"."error_message_redacted" is null or "digital_purchase_orders"."error_kind" is not null)
);
--> statement-breakpoint
CREATE TABLE "digital_retail_pricing_policies" (
	"id" text PRIMARY KEY NOT NULL,
	"policy_key" text NOT NULL,
	"version" integer NOT NULL,
	"name" text NOT NULL,
	"summary" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"market" text NOT NULL,
	"product_class" text NOT NULL,
	"currency" text NOT NULL,
	"margin_floor_bps" integer NOT NULL,
	"margin_ceiling_bps" integer NOT NULL,
	"payment_cost_bps" integer DEFAULT 0 NOT NULL,
	"payment_cost_fixed_minor" bigint DEFAULT 0 NOT NULL,
	"rounding_mode" text DEFAULT 'minor_unit' NOT NULL,
	"price_ceiling_minor" bigint,
	"effective_start" timestamp with time zone NOT NULL,
	"effective_end" timestamp with time zone,
	"created_by_oxy_user_id" text NOT NULL,
	"approved_by_oxy_user_id" text,
	"activated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "digital_retail_pricing_policies_status_check" CHECK ("digital_retail_pricing_policies"."status" in ('draft', 'active', 'superseded', 'retired')),
	CONSTRAINT "digital_retail_pricing_policies_product_class_check" CHECK ("digital_retail_pricing_policies"."product_class" in ('digital_game', 'game_expansion', 'software_licence', 'subscription_activation_code')),
	CONSTRAINT "digital_retail_pricing_policies_rounding_check" CHECK ("digital_retail_pricing_policies"."rounding_mode" in ('minor_unit', 'end_99', 'nearest_major')),
	CONSTRAINT "digital_retail_pricing_policies_currency_check" CHECK ("digital_retail_pricing_policies"."currency" in ('FAIR', 'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF', 'CNY', 'SEK', 'NOK', 'DKK', 'PLN', 'MXN', 'BRL', 'INR', 'NZD', 'ZAR', 'SGD', 'HKD', 'AED')),
	CONSTRAINT "digital_retail_pricing_policies_version_check" CHECK ("digital_retail_pricing_policies"."version" >= 1),
	CONSTRAINT "digital_retail_pricing_policies_market_check" CHECK ("digital_retail_pricing_policies"."market" ~ '^[A-Z]{2}$'),
	CONSTRAINT "digital_retail_pricing_policies_margin_check" CHECK ("digital_retail_pricing_policies"."margin_floor_bps" >= 0
          and "digital_retail_pricing_policies"."margin_ceiling_bps" >= "digital_retail_pricing_policies"."margin_floor_bps"
          and "digital_retail_pricing_policies"."margin_ceiling_bps" < 10000
          and "digital_retail_pricing_policies"."payment_cost_bps" >= 0
          and "digital_retail_pricing_policies"."payment_cost_bps" < 10000
          and "digital_retail_pricing_policies"."payment_cost_fixed_minor" >= 0),
	CONSTRAINT "digital_retail_pricing_policies_ceiling_check" CHECK ("digital_retail_pricing_policies"."price_ceiling_minor" is null or "digital_retail_pricing_policies"."price_ceiling_minor" > 0),
	CONSTRAINT "digital_retail_pricing_policies_window_check" CHECK ("digital_retail_pricing_policies"."effective_end" is null or "digital_retail_pricing_policies"."effective_end" > "digital_retail_pricing_policies"."effective_start"),
	CONSTRAINT "digital_retail_pricing_policies_activation_check" CHECK ("digital_retail_pricing_policies"."status" <> 'active'
          or ("digital_retail_pricing_policies"."activated_at" is not null and "digital_retail_pricing_policies"."approved_by_oxy_user_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "digital_supplier_capabilities" (
	"id" text PRIMARY KEY NOT NULL,
	"supplier_account_id" text NOT NULL,
	"capability" text NOT NULL,
	"state" text DEFAULT 'unavailable' NOT NULL,
	"adapter_version" text,
	"last_health_check_at" timestamp with time zone,
	"last_health_check_ok" boolean,
	"rate_limit_per_minute" integer,
	"paused_at" timestamp with time zone,
	"pause_reason" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "digital_supplier_capabilities_capability_check" CHECK ("digital_supplier_capabilities"."capability" in ('catalog_sync', 'product_lookup', 'stock_query', 'quote', 'preflight', 'purchase', 'purchase_recovery', 'fulfilment_fetch', 'order_status', 'cancel', 'credit_status', 'callback_events', 'health')),
	CONSTRAINT "digital_supplier_capabilities_state_check" CHECK ("digital_supplier_capabilities"."state" in ('enabled', 'paused', 'unavailable')),
	CONSTRAINT "digital_supplier_capabilities_pause_check" CHECK ((("digital_supplier_capabilities"."state" = 'paused') = ("digital_supplier_capabilities"."paused_at" is not null))
          and num_nonnulls("digital_supplier_capabilities"."paused_at", "digital_supplier_capabilities"."pause_reason") in (0, 2)),
	CONSTRAINT "digital_supplier_capabilities_rate_limit_check" CHECK ("digital_supplier_capabilities"."rate_limit_per_minute" is null or "digital_supplier_capabilities"."rate_limit_per_minute" >= 1)
);
--> statement-breakpoint
CREATE TABLE "digital_supply_terms" (
	"id" text PRIMARY KEY NOT NULL,
	"agreement_id" text NOT NULL,
	"supplier_id" text NOT NULL,
	"provenance" text NOT NULL,
	"permitted_product_classes" text[] DEFAULT '{}' NOT NULL,
	"permitted_fulfilment_capabilities" text[] DEFAULT '{}' NOT NULL,
	"permitted_territories" text[] DEFAULT '{}' NOT NULL,
	"excluded_brands" text[] DEFAULT '{}' NOT NULL,
	"excluded_product_refs" text[] DEFAULT '{}' NOT NULL,
	"resale_rights_granted" boolean DEFAULT false NOT NULL,
	"catalog_data_rights_granted" boolean DEFAULT false NOT NULL,
	"replacement_supported" boolean DEFAULT false NOT NULL,
	"credit_supported" boolean DEFAULT false NOT NULL,
	"cancellation_supported" boolean DEFAULT false NOT NULL,
	"max_order_cost_amount" bigint,
	"max_order_cost_currency" text,
	"evidence_location" text NOT NULL,
	"approved_by_oxy_user_id" text NOT NULL,
	"approved_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone,
	"support_escalation_note" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "digital_supply_terms_provenance_check" CHECK ("digital_supply_terms"."provenance" in ('publisher_direct', 'authorized_distributor', 'authorized_wholesaler', 'approved_marketplace_supply')),
	CONSTRAINT "digital_supply_terms_product_classes_check" CHECK ("digital_supply_terms"."permitted_product_classes" <@ array['digital_game', 'game_expansion', 'software_licence', 'subscription_activation_code']::text[]),
	CONSTRAINT "digital_supply_terms_capabilities_check" CHECK ("digital_supply_terms"."permitted_fulfilment_capabilities" <@ array['activation_key', 'redemption_code', 'licence_token', 'licence_file', 'direct_account_activation', 'external_account_link_activation']::text[]),
	CONSTRAINT "digital_supply_terms_territories_check" CHECK (not ('' = any("digital_supply_terms"."permitted_territories"))),
	CONSTRAINT "digital_supply_terms_brands_check" CHECK (not ('' = any("digital_supply_terms"."excluded_brands"))),
	CONSTRAINT "digital_supply_terms_product_refs_check" CHECK (not ('' = any("digital_supply_terms"."excluded_product_refs"))),
	CONSTRAINT "digital_supply_terms_evidence_check" CHECK (length(btrim("digital_supply_terms"."evidence_location")) > 0),
	CONSTRAINT "digital_supply_terms_max_order_cost_currency_check" CHECK ("digital_supply_terms"."max_order_cost_currency" in ('FAIR', 'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF', 'CNY', 'SEK', 'NOK', 'DKK', 'PLN', 'MXN', 'BRL', 'INR', 'NZD', 'ZAR', 'SGD', 'HKD', 'AED')),
	CONSTRAINT "digital_supply_terms_max_order_cost_check" CHECK (num_nonnulls("digital_supply_terms"."max_order_cost_amount", "digital_supply_terms"."max_order_cost_currency") in (0, 2)
          and ("digital_supply_terms"."max_order_cost_amount" is null or "digital_supply_terms"."max_order_cost_amount" > 0))
);
--> statement-breakpoint
ALTER TABLE "suppliers" DROP CONSTRAINT "suppliers_supplier_type_check";--> statement-breakpoint
ALTER TABLE "digital_fulfilment_artifacts" ADD CONSTRAINT "digital_fulfilment_artifacts_fulfilment_id_digital_fulfilments_id_fk" FOREIGN KEY ("fulfilment_id") REFERENCES "public"."digital_fulfilments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "digital_fulfilment_artifacts" ADD CONSTRAINT "digital_fulfilment_artifacts_replaces_artifact_id_digital_fulfilment_artifacts_id_fk" FOREIGN KEY ("replaces_artifact_id") REFERENCES "public"."digital_fulfilment_artifacts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "digital_fulfilment_incidents" ADD CONSTRAINT "digital_fulfilment_incidents_fulfilment_id_digital_fulfilments_id_fk" FOREIGN KEY ("fulfilment_id") REFERENCES "public"."digital_fulfilments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "digital_fulfilment_incidents" ADD CONSTRAINT "digital_fulfilment_incidents_artifact_id_digital_fulfilment_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."digital_fulfilment_artifacts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "digital_fulfilment_incidents" ADD CONSTRAINT "digital_fulfilment_incidents_replacement_artifact_id_digital_fulfilment_artifacts_id_fk" FOREIGN KEY ("replacement_artifact_id") REFERENCES "public"."digital_fulfilment_artifacts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "digital_fulfilment_reveals" ADD CONSTRAINT "digital_fulfilment_reveals_fulfilment_id_digital_fulfilments_id_fk" FOREIGN KEY ("fulfilment_id") REFERENCES "public"."digital_fulfilments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "digital_fulfilment_reveals" ADD CONSTRAINT "digital_fulfilment_reveals_artifact_id_digital_fulfilment_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."digital_fulfilment_artifacts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "digital_fulfilments" ADD CONSTRAINT "digital_fulfilments_purchase_order_id_digital_purchase_orders_id_fk" FOREIGN KEY ("purchase_order_id") REFERENCES "public"."digital_purchase_orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "digital_procurement_offers" ADD CONSTRAINT "digital_procurement_offers_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "digital_procurement_offers" ADD CONSTRAINT "digital_procurement_offers_supplier_account_id_supplier_accounts_id_fk" FOREIGN KEY ("supplier_account_id") REFERENCES "public"."supplier_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "digital_procurement_offers" ADD CONSTRAINT "digital_procurement_offers_digital_supply_terms_id_digital_supply_terms_id_fk" FOREIGN KEY ("digital_supply_terms_id") REFERENCES "public"."digital_supply_terms"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "digital_procurement_offers" ADD CONSTRAINT "digital_procurement_offers_canonical_product_id_canonical_products_id_fk" FOREIGN KEY ("canonical_product_id") REFERENCES "public"."canonical_products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "digital_procurement_offers" ADD CONSTRAINT "digital_procurement_offers_canonical_variant_id_canonical_variants_id_fk" FOREIGN KEY ("canonical_variant_id") REFERENCES "public"."canonical_variants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "digital_purchase_order_attempts" ADD CONSTRAINT "digital_purchase_order_attempts_purchase_order_id_digital_purchase_orders_id_fk" FOREIGN KEY ("purchase_order_id") REFERENCES "public"."digital_purchase_orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "digital_purchase_orders" ADD CONSTRAINT "digital_purchase_orders_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "digital_purchase_orders" ADD CONSTRAINT "digital_purchase_orders_supplier_account_id_supplier_accounts_id_fk" FOREIGN KEY ("supplier_account_id") REFERENCES "public"."supplier_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "digital_purchase_orders" ADD CONSTRAINT "digital_purchase_orders_digital_supply_terms_id_digital_supply_terms_id_fk" FOREIGN KEY ("digital_supply_terms_id") REFERENCES "public"."digital_supply_terms"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "digital_purchase_orders" ADD CONSTRAINT "digital_purchase_orders_previous_purchase_order_id_digital_purchase_orders_id_fk" FOREIGN KEY ("previous_purchase_order_id") REFERENCES "public"."digital_purchase_orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "digital_supplier_capabilities" ADD CONSTRAINT "digital_supplier_capabilities_supplier_account_id_supplier_accounts_id_fk" FOREIGN KEY ("supplier_account_id") REFERENCES "public"."supplier_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "digital_supply_terms" ADD CONSTRAINT "digital_supply_terms_agreement_id_supplier_agreements_id_fk" FOREIGN KEY ("agreement_id") REFERENCES "public"."supplier_agreements"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "digital_supply_terms" ADD CONSTRAINT "digital_supply_terms_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "digital_fulfilment_artifacts_active_key" ON "digital_fulfilment_artifacts" USING btree ("fulfilment_id") WHERE "digital_fulfilment_artifacts"."state" = 'active';--> statement-breakpoint
CREATE INDEX "digital_fulfilment_artifacts_fulfilment_idx" ON "digital_fulfilment_artifacts" USING btree ("fulfilment_id","created_at");--> statement-breakpoint
CREATE INDEX "digital_fulfilment_artifacts_incident_idx" ON "digital_fulfilment_artifacts" USING btree ("incident_id");--> statement-breakpoint
CREATE INDEX "digital_fulfilment_incidents_fulfilment_idx" ON "digital_fulfilment_incidents" USING btree ("fulfilment_id","reported_at");--> statement-breakpoint
CREATE INDEX "digital_fulfilment_incidents_open_idx" ON "digital_fulfilment_incidents" USING btree ("reported_at") WHERE "digital_fulfilment_incidents"."state" in ('open', 'supplier_escalated');--> statement-breakpoint
CREATE INDEX "digital_fulfilment_reveals_fulfilment_idx" ON "digital_fulfilment_reveals" USING btree ("fulfilment_id","revealed_at");--> statement-breakpoint
CREATE INDEX "digital_fulfilment_reveals_artifact_idx" ON "digital_fulfilment_reveals" USING btree ("artifact_id");--> statement-breakpoint
CREATE UNIQUE INDEX "digital_fulfilments_order_item_key" ON "digital_fulfilments" USING btree ("order_item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "digital_fulfilments_purchase_order_key" ON "digital_fulfilments" USING btree ("purchase_order_id");--> statement-breakpoint
CREATE INDEX "digital_fulfilments_buyer_idx" ON "digital_fulfilments" USING btree ("buyer_key","created_at");--> statement-breakpoint
CREATE INDEX "digital_fulfilments_order_idx" ON "digital_fulfilments" USING btree ("order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "digital_procurement_offers_account_sku_key" ON "digital_procurement_offers" USING btree ("supplier_account_id","supplier_sku");--> statement-breakpoint
CREATE INDEX "digital_procurement_offers_variant_idx" ON "digital_procurement_offers" USING btree ("canonical_variant_id","fulfilment_capability") WHERE "digital_procurement_offers"."status" = 'active' and "digital_procurement_offers"."mapping_status" = 'exact';--> statement-breakpoint
CREATE INDEX "digital_procurement_offers_review_idx" ON "digital_procurement_offers" USING btree ("supplier_account_id","last_confirmed_at") WHERE "digital_procurement_offers"."mapping_status" = 'ambiguous';--> statement-breakpoint
CREATE INDEX "digital_procurement_offers_freshness_idx" ON "digital_procurement_offers" USING btree ("last_confirmed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "digital_purchase_order_attempts_number_key" ON "digital_purchase_order_attempts" USING btree ("purchase_order_id","attempt_number");--> statement-breakpoint
CREATE INDEX "digital_purchase_order_attempts_operation_idx" ON "digital_purchase_order_attempts" USING btree ("operation","outcome","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "digital_purchase_orders_idempotency_key" ON "digital_purchase_orders" USING btree ("idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "digital_purchase_orders_live_line_key" ON "digital_purchase_orders" USING btree ("order_item_id") WHERE "digital_purchase_orders"."status" in ('pending', 'preflighted', 'submitting', 'ambiguous', 'accepted');--> statement-breakpoint
CREATE INDEX "digital_purchase_orders_order_idx" ON "digital_purchase_orders" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "digital_purchase_orders_account_idx" ON "digital_purchase_orders" USING btree ("supplier_account_id","status");--> statement-breakpoint
CREATE INDEX "digital_purchase_orders_ambiguous_idx" ON "digital_purchase_orders" USING btree ("ambiguous_since") WHERE "digital_purchase_orders"."status" = 'ambiguous';--> statement-breakpoint
CREATE UNIQUE INDEX "digital_retail_pricing_policies_key_version_key" ON "digital_retail_pricing_policies" USING btree ("policy_key","version");--> statement-breakpoint
CREATE UNIQUE INDEX "digital_retail_pricing_policies_active_key" ON "digital_retail_pricing_policies" USING btree ("market","product_class") WHERE "digital_retail_pricing_policies"."status" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "digital_supplier_capabilities_account_capability_key" ON "digital_supplier_capabilities" USING btree ("supplier_account_id","capability");--> statement-breakpoint
CREATE INDEX "digital_supplier_capabilities_state_idx" ON "digital_supplier_capabilities" USING btree ("capability","state");--> statement-breakpoint
CREATE UNIQUE INDEX "digital_supply_terms_agreement_key" ON "digital_supply_terms" USING btree ("agreement_id");--> statement-breakpoint
CREATE INDEX "digital_supply_terms_supplier_idx" ON "digital_supply_terms" USING btree ("supplier_id","provenance");--> statement-breakpoint
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_supplier_type_check" CHECK ("suppliers"."supplier_type" in ('wholesaler', 'dropship_distributor', 'manufacturer_direct', 'print_on_demand', 'fulfilment_partner', 'digital_distributor'));--> statement-breakpoint
-- oxy:handwritten-begin=digital_retail_append_only
--
-- The attempt log and the reveal audit refuse UPDATE and DELETE outright. Both
-- are append-only by construction (no `updated_at`), and both are evidence: the
-- attempt log is how a duplicate-procurement incident is reconstructed, and the
-- reveal audit is how "the buyer had already seen this key" is established in a
-- dispute. An edit path would destroy the only account of what happened.
CREATE OR REPLACE FUNCTION mercaria_digital_retail_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    '% is append-only: % is refused. Append a new row instead.',
    TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER digital_purchase_order_attempts_append_only
  BEFORE UPDATE OR DELETE ON "digital_purchase_order_attempts"
  FOR EACH ROW EXECUTE FUNCTION mercaria_digital_retail_append_only();
--> statement-breakpoint
CREATE TRIGGER digital_fulfilment_reveals_append_only
  BEFORE UPDATE OR DELETE ON "digital_fulfilment_reveals"
  FOR EACH ROW EXECUTE FUNCTION mercaria_digital_retail_append_only();
-- oxy:handwritten-end=digital_retail_append_only
--> statement-breakpoint
-- oxy:handwritten-begin=digital_retail_no_delete
--
-- A fulfilment, its artifacts and its incidents are never deleted (ADR 0011
-- D11). A refund moves a status and appends a row; a replacement supersedes an
-- artifact and keeps it. UPDATE stays legal on all three - a status moves, a
-- redemption state is learned, an incident is resolved.
CREATE OR REPLACE FUNCTION mercaria_digital_retail_no_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    '% rows are never deleted: this is the evidence a dispute is answered from.',
    TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER digital_fulfilments_no_delete
  BEFORE DELETE ON "digital_fulfilments"
  FOR EACH ROW EXECUTE FUNCTION mercaria_digital_retail_no_delete();
--> statement-breakpoint
CREATE TRIGGER digital_fulfilment_artifacts_no_delete
  BEFORE DELETE ON "digital_fulfilment_artifacts"
  FOR EACH ROW EXECUTE FUNCTION mercaria_digital_retail_no_delete();
--> statement-breakpoint
CREATE TRIGGER digital_fulfilment_incidents_no_delete
  BEFORE DELETE ON "digital_fulfilment_incidents"
  FOR EACH ROW EXECUTE FUNCTION mercaria_digital_retail_no_delete();
-- oxy:handwritten-end=digital_retail_no_delete
--> statement-breakpoint
-- oxy:handwritten-begin=digital_fulfilment_artifact_seal_immutable
--
-- A sealed artifact's SEAL is written once. Which fulfilment it belongs to, which
-- capability it is, what was sealed, which key sealed it and the digest of the
-- plaintext may never change - swapping a ciphertext after delivery would make
-- the reveal audit describe a key nobody was given, and the digest is what a
-- support case matches against.
--
-- Everything else stays mutable on purpose: `state` moves to `replaced`,
-- `redemption_state` is learned from provider truth, and `instructions` are
-- corrected when a publisher changes their redemption page.
CREATE OR REPLACE FUNCTION mercaria_digital_artifact_seal_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.fulfilment_id IS DISTINCT FROM OLD.fulfilment_id
     OR NEW.capability IS DISTINCT FROM OLD.capability
     OR NEW.source IS DISTINCT FROM OLD.source
     OR NEW.sealed_secret IS DISTINCT FROM OLD.sealed_secret
     OR NEW.key_reference IS DISTINCT FROM OLD.key_reference
     OR NEW.seal_algorithm IS DISTINCT FROM OLD.seal_algorithm
     OR NEW.plaintext_sha256 IS DISTINCT FROM OLD.plaintext_sha256
     OR NEW.masked_hint IS DISTINCT FROM OLD.masked_hint
     OR NEW.replaces_artifact_id IS DISTINCT FROM OLD.replaces_artifact_id THEN
    RAISE EXCEPTION
      'digital_fulfilment_artifacts.% is immutable once written: issue a replacement artifact instead of editing this one.',
      'seal'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER digital_fulfilment_artifacts_seal_immutable
  BEFORE UPDATE ON "digital_fulfilment_artifacts"
  FOR EACH ROW EXECUTE FUNCTION mercaria_digital_artifact_seal_immutable();
-- oxy:handwritten-end=digital_fulfilment_artifact_seal_immutable
--> statement-breakpoint
-- oxy:handwritten-begin=digital_purchase_order_snapshot_immutable
--
-- A digital purchase order's IDENTITY and its cost SNAPSHOT are frozen at
-- creation. The idempotency key is what both sides of the wire dedupe on; the
-- order line, supplier account, rider and SKU are what was bought from whom; and
-- the quoted cost and the ceiling are the terms the customer's price was set
-- against.
--
-- This is the digital counterpart of `purchase_orders`' own identity trigger, and
-- it is what makes "a catalogue refresh cannot silently change a submitted
-- order's cost snapshot" a property of the database rather than of whoever writes
-- the next service.
CREATE OR REPLACE FUNCTION mercaria_digital_purchase_order_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR NEW.attempt_ordinal IS DISTINCT FROM OLD.attempt_ordinal
     OR NEW.order_id IS DISTINCT FROM OLD.order_id
     OR NEW.order_item_id IS DISTINCT FROM OLD.order_item_id
     OR NEW.supplier_id IS DISTINCT FROM OLD.supplier_id
     OR NEW.supplier_account_id IS DISTINCT FROM OLD.supplier_account_id
     OR NEW.digital_supply_terms_id IS DISTINCT FROM OLD.digital_supply_terms_id
     OR NEW.supplier_sku IS DISTINCT FROM OLD.supplier_sku
     OR NEW.fulfilment_capability IS DISTINCT FROM OLD.fulfilment_capability
     OR NEW.product_class IS DISTINCT FROM OLD.product_class
     OR NEW.platform IS DISTINCT FROM OLD.platform
     OR NEW.activation_ecosystem IS DISTINCT FROM OLD.activation_ecosystem
     OR NEW.edition IS DISTINCT FROM OLD.edition
     OR NEW.quoted_cost_amount IS DISTINCT FROM OLD.quoted_cost_amount
     OR NEW.quoted_cost_currency IS DISTINCT FROM OLD.quoted_cost_currency
     OR NEW.max_accepted_cost_amount IS DISTINCT FROM OLD.max_accepted_cost_amount
     OR NEW.max_accepted_cost_currency IS DISTINCT FROM OLD.max_accepted_cost_currency
     OR NEW.previous_purchase_order_id IS DISTINCT FROM OLD.previous_purchase_order_id THEN
    RAISE EXCEPTION
      'digital_purchase_orders identity and cost snapshot are immutable: open a new attempt instead of editing this one.'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER digital_purchase_orders_snapshot_immutable
  BEFORE UPDATE ON "digital_purchase_orders"
  FOR EACH ROW EXECUTE FUNCTION mercaria_digital_purchase_order_immutable();
-- oxy:handwritten-end=digital_purchase_order_snapshot_immutable
