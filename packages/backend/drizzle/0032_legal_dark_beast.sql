-- oxy:deploy-phase=pre
-- oxy:rollback=derived
CREATE TABLE "retail_category_rules" (
	"id" text PRIMARY KEY NOT NULL,
	"policy_id" text NOT NULL,
	"category_key" text NOT NULL,
	"admissibility" text NOT NULL,
	"required_compliance_evidence_kinds" text[] DEFAULT '{}' NOT NULL,
	"requires_age_assurance" boolean DEFAULT false NOT NULL,
	"dangerous_goods_restricted" boolean DEFAULT false NOT NULL,
	"requires_authorized_dealer" boolean DEFAULT false NOT NULL,
	"requires_batch_traceability" boolean DEFAULT false NOT NULL,
	"reason" text NOT NULL,
	"recorded_by_oxy_user_id" text NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "retail_category_rules_admissibility_check" CHECK ("retail_category_rules"."admissibility" in ('permitted', 'prohibited', 'requires_approval')),
	CONSTRAINT "retail_category_rules_evidence_kinds_check" CHECK ("retail_category_rules"."required_compliance_evidence_kinds" <@ array['ce_marking_declaration', 'eu_declaration_of_conformity', 'gpsr_traceability_pack', 'safety_warnings_and_instructions', 'age_restriction_statement', 'battery_compliance', 'electrical_safety_report', 'radio_equipment_conformity', 'toy_safety_certificate', 'cosmetic_product_information_file', 'food_contact_declaration', 'responsible_person_details', 'dangerous_goods_classification', 'market_language_labelling', 'recall_procedure_confirmation', 'country_of_origin_declaration', 'manufacturer_identity_declaration', 'test_report', 'other_category_specific']::text[]),
	CONSTRAINT "retail_category_rules_category_check" CHECK (btrim("retail_category_rules"."category_key") <> ''),
	CONSTRAINT "retail_category_rules_reason_check" CHECK (btrim("retail_category_rules"."reason") <> '' and length("retail_category_rules"."reason") <= 2000),
	CONSTRAINT "retail_category_rules_actor_check" CHECK (btrim("retail_category_rules"."recorded_by_oxy_user_id") <> ''),
	CONSTRAINT "retail_category_rules_prohibited_shape_check" CHECK ("retail_category_rules"."admissibility" <> 'prohibited'
          or (cardinality("retail_category_rules"."required_compliance_evidence_kinds") = 0
              and not "retail_category_rules"."requires_age_assurance"
              and not "retail_category_rules"."requires_authorized_dealer"
              and not "retail_category_rules"."requires_batch_traceability"))
);
--> statement-breakpoint
CREATE TABLE "retail_compliance_evidence" (
	"id" text PRIMARY KEY NOT NULL,
	"supplier_id" text NOT NULL,
	"canonical_product_id" text,
	"canonical_variant_id" text,
	"supplier_sku" text,
	"kind" text NOT NULL,
	"review_state" text DEFAULT 'unknown' NOT NULL,
	"market_countries" text[] DEFAULT '{}' NOT NULL,
	"document_version" text,
	"issuer" text,
	"issued_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"oxy_file_id" text,
	"document_url" text,
	"sha256" text,
	"note" text,
	"recorded_by_oxy_user_id" text NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	"verified_by_oxy_user_id" text,
	"verified_at" timestamp with time zone,
	"rejection_reason" text,
	"revoked_by_oxy_user_id" text,
	"revoked_at" timestamp with time zone,
	"revocation_reason" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "retail_compliance_evidence_kind_check" CHECK ("retail_compliance_evidence"."kind" in ('ce_marking_declaration', 'eu_declaration_of_conformity', 'gpsr_traceability_pack', 'safety_warnings_and_instructions', 'age_restriction_statement', 'battery_compliance', 'electrical_safety_report', 'radio_equipment_conformity', 'toy_safety_certificate', 'cosmetic_product_information_file', 'food_contact_declaration', 'responsible_person_details', 'dangerous_goods_classification', 'market_language_labelling', 'recall_procedure_confirmation', 'country_of_origin_declaration', 'manufacturer_identity_declaration', 'test_report', 'other_category_specific')),
	CONSTRAINT "retail_compliance_evidence_review_state_check" CHECK ("retail_compliance_evidence"."review_state" in ('unknown', 'pending', 'verified', 'revoked', 'rejected')),
	CONSTRAINT "retail_compliance_evidence_subject_check" CHECK (num_nonnulls("retail_compliance_evidence"."canonical_product_id", "retail_compliance_evidence"."canonical_variant_id", "retail_compliance_evidence"."supplier_sku") >= 1),
	CONSTRAINT "retail_compliance_evidence_target_check" CHECK (num_nonnulls("retail_compliance_evidence"."oxy_file_id", "retail_compliance_evidence"."document_url") >= 1),
	CONSTRAINT "retail_compliance_evidence_markets_check" CHECK (not ('' = any("retail_compliance_evidence"."market_countries"))),
	CONSTRAINT "retail_compliance_evidence_sha256_check" CHECK ("retail_compliance_evidence"."sha256" is null or "retail_compliance_evidence"."sha256" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "retail_compliance_evidence_window_check" CHECK ("retail_compliance_evidence"."issued_at" is null or "retail_compliance_evidence"."expires_at" is null or "retail_compliance_evidence"."expires_at" > "retail_compliance_evidence"."issued_at"),
	CONSTRAINT "retail_compliance_evidence_actor_check" CHECK (btrim("retail_compliance_evidence"."recorded_by_oxy_user_id") <> ''),
	CONSTRAINT "retail_compliance_evidence_verified_complete_check" CHECK (("retail_compliance_evidence"."review_state" = 'verified')
          = ("retail_compliance_evidence"."verified_by_oxy_user_id" is not null and "retail_compliance_evidence"."verified_at" is not null)),
	CONSTRAINT "retail_compliance_evidence_rejected_check" CHECK (("retail_compliance_evidence"."review_state" = 'rejected') = (btrim(coalesce("retail_compliance_evidence"."rejection_reason", '')) <> '')),
	CONSTRAINT "retail_compliance_evidence_revoked_check" CHECK (("retail_compliance_evidence"."review_state" = 'revoked')
          = ("retail_compliance_evidence"."revoked_by_oxy_user_id" is not null and "retail_compliance_evidence"."revoked_at" is not null
             and btrim(coalesce("retail_compliance_evidence"."revocation_reason", '')) <> '')),
	CONSTRAINT "retail_compliance_evidence_note_length_check" CHECK (("retail_compliance_evidence"."note" is null or length("retail_compliance_evidence"."note") <= 2000)
          and ("retail_compliance_evidence"."rejection_reason" is null or length("retail_compliance_evidence"."rejection_reason") <= 2000)
          and ("retail_compliance_evidence"."revocation_reason" is null or length("retail_compliance_evidence"."revocation_reason") <= 2000))
);
--> statement-breakpoint
CREATE TABLE "retail_eligibility_audits" (
	"id" text PRIMARY KEY NOT NULL,
	"action" text NOT NULL,
	"subject_table" text NOT NULL,
	"subject_id" text NOT NULL,
	"outcome" text NOT NULL,
	"reason" text NOT NULL,
	"actor_oxy_user_id" text NOT NULL,
	"detail" text,
	"at" timestamp with time zone NOT NULL,
	CONSTRAINT "retail_eligibility_audits_action_check" CHECK ("retail_eligibility_audits"."action" in ('policy_drafted', 'policy_activated', 'policy_retired', 'category_rule_recorded', 'market_capability_recorded', 'resale_evidence_recorded', 'resale_evidence_verified', 'resale_evidence_rejected', 'resale_evidence_revoked', 'compliance_evidence_recorded', 'compliance_evidence_verified', 'compliance_evidence_rejected', 'compliance_evidence_revoked', 'suppression_raised', 'suppression_lifted', 'exception_requested', 'exception_approved', 'exception_rejected', 'exception_revoked')),
	CONSTRAINT "retail_eligibility_audits_outcome_check" CHECK ("retail_eligibility_audits"."outcome" in ('applied', 'refused')),
	CONSTRAINT "retail_eligibility_audits_subject_check" CHECK (btrim("retail_eligibility_audits"."subject_table") <> '' and btrim("retail_eligibility_audits"."subject_id") <> ''),
	CONSTRAINT "retail_eligibility_audits_reason_check" CHECK (btrim("retail_eligibility_audits"."reason") <> '' and length("retail_eligibility_audits"."reason") <= 2000),
	CONSTRAINT "retail_eligibility_audits_actor_check" CHECK (btrim("retail_eligibility_audits"."actor_oxy_user_id") <> ''),
	CONSTRAINT "retail_eligibility_audits_detail_check" CHECK ("retail_eligibility_audits"."detail" is null or length("retail_eligibility_audits"."detail") <= 2000)
);
--> statement-breakpoint
CREATE TABLE "retail_eligibility_decisions" (
	"id" text PRIMARY KEY NOT NULL,
	"policy_id" text NOT NULL,
	"policy_key" text NOT NULL,
	"policy_version" integer NOT NULL,
	"procurement_offer_id" text NOT NULL,
	"supplier_id" text NOT NULL,
	"canonical_variant_id" text,
	"destination_country" text NOT NULL,
	"fulfilment_origin_country" text,
	"channel" text NOT NULL,
	"currency" text NOT NULL,
	"quantity" integer NOT NULL,
	"fulfilment_method" text NOT NULL,
	"customer_type" text NOT NULL,
	"verdict" text NOT NULL,
	"reasons" text[] DEFAULT '{}' NOT NULL,
	"next_required_action" text NOT NULL,
	"resale_evidence_ids" text[] DEFAULT '{}' NOT NULL,
	"compliance_evidence_ids" text[] DEFAULT '{}' NOT NULL,
	"exception_id" text,
	"content_hash" text NOT NULL,
	"evaluated_at" timestamp with time zone NOT NULL,
	"surface" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "retail_eligibility_decisions_verdict_check" CHECK ("retail_eligibility_decisions"."verdict" in ('eligible', 'ineligible', 'unknown')),
	CONSTRAINT "retail_eligibility_decisions_action_check" CHECK ("retail_eligibility_decisions"."next_required_action" in ('none', 'collect_resale_evidence', 'verify_resale_evidence', 'renew_resale_evidence', 'collect_compliance_evidence', 'verify_compliance_evidence', 'renew_compliance_evidence', 'resolve_product_match', 'record_product_traceability', 'evaluate_category', 'record_market_capability', 'determine_tax_treatment', 'lift_suppression', 'operator_review', 'not_available')),
	CONSTRAINT "retail_eligibility_decisions_method_check" CHECK ("retail_eligibility_decisions"."fulfilment_method" in ('standard_delivery', 'expedited_delivery', 'freight_delivery', 'collection_point')),
	CONSTRAINT "retail_eligibility_decisions_customer_type_check" CHECK ("retail_eligibility_decisions"."customer_type" in ('consumer', 'business')),
	CONSTRAINT "retail_eligibility_decisions_reasons_check" CHECK ("retail_eligibility_decisions"."reasons" <@ array['policy_missing', 'supply_chain_ineligible', 'destination_not_permitted', 'fulfilment_origin_not_permitted', 'channel_not_permitted', 'currency_not_permitted', 'customer_type_not_permitted', 'fulfilment_method_not_permitted', 'quantity_above_limit', 'order_value_above_limit', 'resale_evidence_missing', 'resale_evidence_unverified', 'resale_evidence_expired', 'resale_evidence_revoked', 'resale_evidence_rejected', 'resale_evidence_out_of_scope', 'catalog_data_rights_missing', 'pricing_restriction_unresolved', 'brand_excluded_by_agreement', 'category_excluded_by_agreement', 'sku_excluded_by_agreement', 'product_mapping_missing', 'product_mapping_ambiguous', 'product_identifier_missing', 'brand_identity_missing', 'country_of_origin_missing', 'responsible_operator_missing', 'traceability_capability_missing', 'compliance_evidence_missing', 'compliance_evidence_unverified', 'compliance_evidence_expired', 'compliance_evidence_revoked', 'compliance_evidence_rejected', 'compliance_evidence_market_mismatch', 'category_not_evaluated', 'category_prohibited', 'category_requires_approval', 'age_assurance_unavailable', 'dangerous_goods_restricted', 'product_recalled', 'product_suppressed', 'supplier_suppressed', 'category_suppressed', 'market_suppressed', 'brand_suppressed', 'market_capability_unknown', 'cancellation_unsupported', 'withdrawal_unsupported', 'guarantee_unsupported', 'returns_unsupported', 'defect_handling_unsupported', 'support_language_unavailable', 'refund_rail_unavailable', 'invoice_issuance_unavailable', 'recall_notification_unavailable', 'delivery_estimate_unavailable', 'tax_treatment_unknown', 'tax_registration_missing', 'importer_of_record_unresolved', 'duty_responsibility_unresolved']::text[]),
	CONSTRAINT "retail_eligibility_decisions_channel_check" CHECK ("retail_eligibility_decisions"."channel" in ('mercaria_marketplace', 'mercaria_branded_checkout')),
	CONSTRAINT "retail_eligibility_decisions_currency_check" CHECK ("retail_eligibility_decisions"."currency" in ('FAIR', 'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF', 'CNY', 'SEK', 'NOK', 'DKK', 'PLN', 'MXN', 'BRL', 'INR', 'NZD', 'ZAR', 'SGD', 'HKD', 'AED')),
	CONSTRAINT "retail_eligibility_decisions_policy_version_check" CHECK ("retail_eligibility_decisions"."policy_version" >= 1),
	CONSTRAINT "retail_eligibility_decisions_quantity_check" CHECK ("retail_eligibility_decisions"."quantity" > 0),
	CONSTRAINT "retail_eligibility_decisions_countries_check" CHECK ("retail_eligibility_decisions"."destination_country" ~ '^[A-Z]{2}$'
          and ("retail_eligibility_decisions"."fulfilment_origin_country" is null or "retail_eligibility_decisions"."fulfilment_origin_country" ~ '^[A-Z]{2}$')),
	CONSTRAINT "retail_eligibility_decisions_surface_check" CHECK ("retail_eligibility_decisions"."surface" in ('publication', 'checkout', 'sweep', 'operator')),
	CONSTRAINT "retail_eligibility_decisions_reason_presence_check" CHECK (("retail_eligibility_decisions"."verdict" = 'eligible') = (cardinality("retail_eligibility_decisions"."reasons") = 0)),
	CONSTRAINT "retail_eligibility_decisions_action_presence_check" CHECK (("retail_eligibility_decisions"."verdict" = 'eligible') = ("retail_eligibility_decisions"."next_required_action" = 'none')),
	CONSTRAINT "retail_eligibility_decisions_content_hash_check" CHECK ("retail_eligibility_decisions"."content_hash" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE "retail_eligibility_exceptions" (
	"id" text PRIMARY KEY NOT NULL,
	"policy_id" text NOT NULL,
	"supplier_id" text NOT NULL,
	"canonical_variant_id" text,
	"scope_destination_countries" text[] DEFAULT '{}' NOT NULL,
	"waived_reasons" text[] NOT NULL,
	"state" text DEFAULT 'requested' NOT NULL,
	"justification" text NOT NULL,
	"requested_by_oxy_user_id" text NOT NULL,
	"requested_at" timestamp with time zone NOT NULL,
	"approved_by_oxy_user_id" text,
	"approved_at" timestamp with time zone,
	"second_approved_by_oxy_user_id" text,
	"second_approved_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"rejected_by_oxy_user_id" text,
	"rejected_at" timestamp with time zone,
	"rejection_reason" text,
	"revoked_by_oxy_user_id" text,
	"revoked_at" timestamp with time zone,
	"revocation_reason" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "retail_eligibility_exceptions_state_check" CHECK ("retail_eligibility_exceptions"."state" in ('requested', 'approved', 'rejected', 'revoked')),
	CONSTRAINT "retail_eligibility_exceptions_waived_reasons_check" CHECK ("retail_eligibility_exceptions"."waived_reasons" <@ array['category_requires_approval', 'pricing_restriction_unresolved', 'product_identifier_missing', 'country_of_origin_missing', 'responsible_operator_missing', 'traceability_capability_missing', 'delivery_estimate_unavailable']::text[]),
	CONSTRAINT "retail_eligibility_exceptions_waived_nonempty_check" CHECK (cardinality("retail_eligibility_exceptions"."waived_reasons") >= 1),
	CONSTRAINT "retail_eligibility_exceptions_scope_check" CHECK (not ('' = any("retail_eligibility_exceptions"."scope_destination_countries"))),
	CONSTRAINT "retail_eligibility_exceptions_justification_check" CHECK (btrim("retail_eligibility_exceptions"."justification") <> ''
          and length("retail_eligibility_exceptions"."justification") <= 2000),
	CONSTRAINT "retail_eligibility_exceptions_requested_by_check" CHECK (btrim("retail_eligibility_exceptions"."requested_by_oxy_user_id") <> ''),
	CONSTRAINT "retail_eligibility_exceptions_expiry_check" CHECK ("retail_eligibility_exceptions"."expires_at" > "retail_eligibility_exceptions"."requested_at"),
	CONSTRAINT "retail_eligibility_exceptions_approved_complete_check" CHECK (num_nonnulls("retail_eligibility_exceptions"."approved_by_oxy_user_id", "retail_eligibility_exceptions"."approved_at") in (0, 2)
          and num_nonnulls("retail_eligibility_exceptions"."second_approved_by_oxy_user_id", "retail_eligibility_exceptions"."second_approved_at") in (0, 2)
          and ("retail_eligibility_exceptions"."state" <> 'approved' or "retail_eligibility_exceptions"."approved_by_oxy_user_id" is not null)),
	CONSTRAINT "retail_eligibility_exceptions_four_eyes_check" CHECK (("retail_eligibility_exceptions"."second_approved_by_oxy_user_id" is null
           or "retail_eligibility_exceptions"."second_approved_by_oxy_user_id" <> "retail_eligibility_exceptions"."approved_by_oxy_user_id")
          and ("retail_eligibility_exceptions"."approved_by_oxy_user_id" is null
               or "retail_eligibility_exceptions"."approved_by_oxy_user_id" <> "retail_eligibility_exceptions"."requested_by_oxy_user_id")
          and ("retail_eligibility_exceptions"."second_approved_by_oxy_user_id" is null
               or "retail_eligibility_exceptions"."second_approved_by_oxy_user_id" <> "retail_eligibility_exceptions"."requested_by_oxy_user_id")),
	CONSTRAINT "retail_eligibility_exceptions_approval_order_check" CHECK ("retail_eligibility_exceptions"."second_approved_by_oxy_user_id" is null or "retail_eligibility_exceptions"."approved_by_oxy_user_id" is not null),
	CONSTRAINT "retail_eligibility_exceptions_rejected_check" CHECK (("retail_eligibility_exceptions"."state" = 'rejected')
          = ("retail_eligibility_exceptions"."rejected_by_oxy_user_id" is not null and "retail_eligibility_exceptions"."rejected_at" is not null
             and btrim(coalesce("retail_eligibility_exceptions"."rejection_reason", '')) <> '')),
	CONSTRAINT "retail_eligibility_exceptions_revoked_check" CHECK (("retail_eligibility_exceptions"."state" = 'revoked')
          = ("retail_eligibility_exceptions"."revoked_by_oxy_user_id" is not null and "retail_eligibility_exceptions"."revoked_at" is not null
             and btrim(coalesce("retail_eligibility_exceptions"."revocation_reason", '')) <> ''))
);
--> statement-breakpoint
CREATE TABLE "retail_eligibility_policies" (
	"id" text PRIMARY KEY NOT NULL,
	"policy_key" text NOT NULL,
	"version" integer NOT NULL,
	"name" text NOT NULL,
	"summary" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"effective_start" timestamp with time zone NOT NULL,
	"effective_end" timestamp with time zone,
	"permitted_destination_countries" text[] DEFAULT '{}' NOT NULL,
	"permitted_fulfilment_origin_countries" text[] DEFAULT '{}' NOT NULL,
	"permitted_channels" text[] DEFAULT '{}' NOT NULL,
	"permitted_currencies" text[] DEFAULT '{}' NOT NULL,
	"permitted_fulfilment_methods" text[] DEFAULT '{}' NOT NULL,
	"permitted_customer_types" text[] DEFAULT '{}' NOT NULL,
	"required_resale_evidence_kinds" text[] DEFAULT '{}' NOT NULL,
	"required_identifier_schemes" text[] DEFAULT '{}' NOT NULL,
	"require_country_of_origin" boolean DEFAULT true NOT NULL,
	"require_responsible_operator" boolean DEFAULT true NOT NULL,
	"require_deterministic_product_match" boolean DEFAULT false NOT NULL,
	"minimum_match_confidence" double precision DEFAULT 0.95 NOT NULL,
	"max_quantity_per_order" integer DEFAULT 10 NOT NULL,
	"max_order_value_amount" bigint,
	"max_order_value_currency" text,
	"manual_exceptions_permitted" boolean DEFAULT false NOT NULL,
	"exception_dual_approval_required" boolean DEFAULT true NOT NULL,
	"created_by_oxy_user_id" text NOT NULL,
	"approved_by_oxy_user_id" text,
	"activated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "retail_eligibility_policies_identity_key" UNIQUE("id","policy_key","version"),
	CONSTRAINT "retail_eligibility_policies_status_check" CHECK ("retail_eligibility_policies"."status" in ('draft', 'active', 'superseded', 'retired')),
	CONSTRAINT "retail_eligibility_policies_channels_check" CHECK ("retail_eligibility_policies"."permitted_channels" <@ array['mercaria_marketplace', 'mercaria_branded_checkout']::text[]),
	CONSTRAINT "retail_eligibility_policies_currencies_check" CHECK ("retail_eligibility_policies"."permitted_currencies" <@ array['FAIR', 'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF', 'CNY', 'SEK', 'NOK', 'DKK', 'PLN', 'MXN', 'BRL', 'INR', 'NZD', 'ZAR', 'SGD', 'HKD', 'AED']::text[]),
	CONSTRAINT "retail_eligibility_policies_methods_check" CHECK ("retail_eligibility_policies"."permitted_fulfilment_methods" <@ array['standard_delivery', 'expedited_delivery', 'freight_delivery', 'collection_point']::text[]),
	CONSTRAINT "retail_eligibility_policies_customer_types_check" CHECK ("retail_eligibility_policies"."permitted_customer_types" <@ array['consumer', 'business']::text[]),
	CONSTRAINT "retail_eligibility_policies_resale_kinds_check" CHECK ("retail_eligibility_policies"."required_resale_evidence_kinds" <@ array['signed_supply_agreement', 'wholesale_account_confirmation', 'distributor_authorization', 'brand_authorization_letter', 'dropship_addendum', 'blind_fulfilment_confirmation', 'marketplace_resale_permission', 'territory_grant', 'brand_category_inclusion_schedule', 'catalog_data_license', 'pricing_policy_acknowledgement', 'white_label_packing_confirmation']::text[]),
	CONSTRAINT "retail_eligibility_policies_max_order_value_currency_check" CHECK ("retail_eligibility_policies"."max_order_value_currency" in ('FAIR', 'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF', 'CNY', 'SEK', 'NOK', 'DKK', 'PLN', 'MXN', 'BRL', 'INR', 'NZD', 'ZAR', 'SGD', 'HKD', 'AED')),
	CONSTRAINT "retail_eligibility_policies_version_check" CHECK ("retail_eligibility_policies"."version" >= 1),
	CONSTRAINT "retail_eligibility_policies_key_check" CHECK ("retail_eligibility_policies"."policy_key" ~ '^[a-z0-9][a-z0-9-]{1,63}$'),
	CONSTRAINT "retail_eligibility_policies_countries_check" CHECK (not ('' = any("retail_eligibility_policies"."permitted_destination_countries"))
          and not ('' = any("retail_eligibility_policies"."permitted_fulfilment_origin_countries"))),
	CONSTRAINT "retail_eligibility_policies_identifier_schemes_check" CHECK (not ('' = any("retail_eligibility_policies"."required_identifier_schemes"))),
	CONSTRAINT "retail_eligibility_policies_match_confidence_check" CHECK ("retail_eligibility_policies"."minimum_match_confidence" >= 0 and "retail_eligibility_policies"."minimum_match_confidence" <= 1),
	CONSTRAINT "retail_eligibility_policies_quantity_check" CHECK ("retail_eligibility_policies"."max_quantity_per_order" >= 1),
	CONSTRAINT "retail_eligibility_policies_max_order_value_check" CHECK (num_nonnulls("retail_eligibility_policies"."max_order_value_amount", "retail_eligibility_policies"."max_order_value_currency") in (0, 2)
          and ("retail_eligibility_policies"."max_order_value_amount" is null or "retail_eligibility_policies"."max_order_value_amount" > 0)
          and ("retail_eligibility_policies"."max_order_value_currency" is null
               or "retail_eligibility_policies"."permitted_currencies" <@ array["retail_eligibility_policies"."max_order_value_currency"])),
	CONSTRAINT "retail_eligibility_policies_effective_window_check" CHECK ("retail_eligibility_policies"."effective_end" is null or "retail_eligibility_policies"."effective_end" > "retail_eligibility_policies"."effective_start"),
	CONSTRAINT "retail_eligibility_policies_exception_shape_check" CHECK ("retail_eligibility_policies"."manual_exceptions_permitted" or "retail_eligibility_policies"."exception_dual_approval_required"),
	CONSTRAINT "retail_eligibility_policies_activation_audit_check" CHECK ("retail_eligibility_policies"."status" not in ('active', 'superseded')
          or ("retail_eligibility_policies"."approved_by_oxy_user_id" is not null and "retail_eligibility_policies"."activated_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "retail_market_capabilities" (
	"id" text PRIMARY KEY NOT NULL,
	"policy_id" text NOT NULL,
	"destination_country" text NOT NULL,
	"fulfilment_origin_country" text NOT NULL,
	"customer_type" text NOT NULL,
	"cancellation_before_fulfilment_supported" boolean DEFAULT false NOT NULL,
	"statutory_withdrawal_supported" boolean DEFAULT false NOT NULL,
	"legal_guarantee_supported" boolean DEFAULT false NOT NULL,
	"returns_supported" boolean DEFAULT false NOT NULL,
	"defect_handling_supported" boolean DEFAULT false NOT NULL,
	"refund_through_original_rail_supported" boolean DEFAULT false NOT NULL,
	"invoice_issuance_supported" boolean DEFAULT false NOT NULL,
	"recall_notification_supported" boolean DEFAULT false NOT NULL,
	"delivery_estimate_available" boolean DEFAULT false NOT NULL,
	"support_languages" text[] DEFAULT '{}' NOT NULL,
	"vat_treatment" text DEFAULT 'not_determined' NOT NULL,
	"seller_registration_recorded" boolean DEFAULT false NOT NULL,
	"seller_registration_ref" text,
	"oss_relevant" boolean DEFAULT false NOT NULL,
	"ioss_relevant" boolean DEFAULT false NOT NULL,
	"importer_of_record" text DEFAULT 'undetermined' NOT NULL,
	"duty_responsibility" text DEFAULT 'undetermined' NOT NULL,
	"price_finality" text DEFAULT 'undetermined' NOT NULL,
	"order_value_threshold_minor" bigint,
	"order_value_threshold_currency" text,
	"supplier_invoice_tax_note" text,
	"customer_invoice_note" text,
	"reason" text NOT NULL,
	"recorded_by_oxy_user_id" text NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "retail_market_capabilities_customer_type_check" CHECK ("retail_market_capabilities"."customer_type" in ('consumer', 'business')),
	CONSTRAINT "retail_market_capabilities_vat_check" CHECK ("retail_market_capabilities"."vat_treatment" in ('destination_vat_oss', 'domestic_vat', 'reverse_charge', 'zero_rated', 'not_determined')),
	CONSTRAINT "retail_market_capabilities_importer_check" CHECK ("retail_market_capabilities"."importer_of_record" in ('not_applicable', 'mercaria', 'customer', 'supplier', 'undetermined')),
	CONSTRAINT "retail_market_capabilities_duty_check" CHECK ("retail_market_capabilities"."duty_responsibility" in ('not_applicable', 'mercaria', 'customer', 'supplier', 'undetermined')),
	CONSTRAINT "retail_market_capabilities_price_finality_check" CHECK ("retail_market_capabilities"."price_finality" in ('final', 'additional_charges_possible', 'undetermined')),
	CONSTRAINT "retail_market_capabilities_order_value_threshold_currency_check" CHECK ("retail_market_capabilities"."order_value_threshold_currency" in ('FAIR', 'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF', 'CNY', 'SEK', 'NOK', 'DKK', 'PLN', 'MXN', 'BRL', 'INR', 'NZD', 'ZAR', 'SGD', 'HKD', 'AED')),
	CONSTRAINT "retail_market_capabilities_countries_check" CHECK ("retail_market_capabilities"."destination_country" ~ '^[A-Z]{2}$' and "retail_market_capabilities"."fulfilment_origin_country" ~ '^[A-Z]{2}$'),
	CONSTRAINT "retail_market_capabilities_languages_check" CHECK (not ('' = any("retail_market_capabilities"."support_languages"))),
	CONSTRAINT "retail_market_capabilities_threshold_check" CHECK (num_nonnulls("retail_market_capabilities"."order_value_threshold_minor", "retail_market_capabilities"."order_value_threshold_currency") in (0, 2)
          and ("retail_market_capabilities"."order_value_threshold_minor" is null or "retail_market_capabilities"."order_value_threshold_minor" > 0)),
	CONSTRAINT "retail_market_capabilities_registration_check" CHECK (not "retail_market_capabilities"."seller_registration_recorded" or btrim(coalesce("retail_market_capabilities"."seller_registration_ref", '')) <> ''),
	CONSTRAINT "retail_market_capabilities_price_finality_shape_check" CHECK ("retail_market_capabilities"."price_finality" <> 'final'
          or ("retail_market_capabilities"."duty_responsibility" <> 'undetermined'
              and "retail_market_capabilities"."importer_of_record" <> 'undetermined'
              and "retail_market_capabilities"."vat_treatment" <> 'not_determined')),
	CONSTRAINT "retail_market_capabilities_reason_check" CHECK (btrim("retail_market_capabilities"."reason") <> '' and length("retail_market_capabilities"."reason") <= 2000),
	CONSTRAINT "retail_market_capabilities_actor_check" CHECK (btrim("retail_market_capabilities"."recorded_by_oxy_user_id") <> '')
);
--> statement-breakpoint
CREATE TABLE "retail_resale_evidence" (
	"id" text PRIMARY KEY NOT NULL,
	"supplier_id" text NOT NULL,
	"agreement_id" text,
	"supplier_account_id" text,
	"kind" text NOT NULL,
	"review_state" text DEFAULT 'unknown' NOT NULL,
	"scope_brand_keys" text[] DEFAULT '{}' NOT NULL,
	"scope_category_keys" text[] DEFAULT '{}' NOT NULL,
	"scope_supplier_skus" text[] DEFAULT '{}' NOT NULL,
	"scope_destination_countries" text[] DEFAULT '{}' NOT NULL,
	"issued_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"oxy_file_id" text,
	"document_url" text,
	"sha256" text,
	"issuer" text,
	"note" text,
	"recorded_by_oxy_user_id" text NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	"verified_by_oxy_user_id" text,
	"verified_at" timestamp with time zone,
	"rejection_reason" text,
	"revoked_by_oxy_user_id" text,
	"revoked_at" timestamp with time zone,
	"revocation_reason" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "retail_resale_evidence_kind_check" CHECK ("retail_resale_evidence"."kind" in ('signed_supply_agreement', 'wholesale_account_confirmation', 'distributor_authorization', 'brand_authorization_letter', 'dropship_addendum', 'blind_fulfilment_confirmation', 'marketplace_resale_permission', 'territory_grant', 'brand_category_inclusion_schedule', 'catalog_data_license', 'pricing_policy_acknowledgement', 'white_label_packing_confirmation')),
	CONSTRAINT "retail_resale_evidence_review_state_check" CHECK ("retail_resale_evidence"."review_state" in ('unknown', 'pending', 'verified', 'revoked', 'rejected')),
	CONSTRAINT "retail_resale_evidence_scope_check" CHECK (not ('' = any("retail_resale_evidence"."scope_brand_keys"))
          and not ('' = any("retail_resale_evidence"."scope_category_keys"))
          and not ('' = any("retail_resale_evidence"."scope_supplier_skus"))
          and not ('' = any("retail_resale_evidence"."scope_destination_countries"))),
	CONSTRAINT "retail_resale_evidence_target_check" CHECK (num_nonnulls("retail_resale_evidence"."oxy_file_id", "retail_resale_evidence"."document_url") >= 1),
	CONSTRAINT "retail_resale_evidence_sha256_check" CHECK ("retail_resale_evidence"."sha256" is null or "retail_resale_evidence"."sha256" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "retail_resale_evidence_window_check" CHECK ("retail_resale_evidence"."issued_at" is null or "retail_resale_evidence"."expires_at" is null or "retail_resale_evidence"."expires_at" > "retail_resale_evidence"."issued_at"),
	CONSTRAINT "retail_resale_evidence_actor_check" CHECK (btrim("retail_resale_evidence"."recorded_by_oxy_user_id") <> ''),
	CONSTRAINT "retail_resale_evidence_verified_complete_check" CHECK (("retail_resale_evidence"."review_state" = 'verified')
          = ("retail_resale_evidence"."verified_by_oxy_user_id" is not null and "retail_resale_evidence"."verified_at" is not null)),
	CONSTRAINT "retail_resale_evidence_rejected_check" CHECK (("retail_resale_evidence"."review_state" = 'rejected') = (btrim(coalesce("retail_resale_evidence"."rejection_reason", '')) <> '')),
	CONSTRAINT "retail_resale_evidence_revoked_check" CHECK (("retail_resale_evidence"."review_state" = 'revoked')
          = ("retail_resale_evidence"."revoked_by_oxy_user_id" is not null and "retail_resale_evidence"."revoked_at" is not null
             and btrim(coalesce("retail_resale_evidence"."revocation_reason", '')) <> '')),
	CONSTRAINT "retail_resale_evidence_note_length_check" CHECK (("retail_resale_evidence"."note" is null or length("retail_resale_evidence"."note") <= 2000)
          and ("retail_resale_evidence"."rejection_reason" is null or length("retail_resale_evidence"."rejection_reason") <= 2000)
          and ("retail_resale_evidence"."revocation_reason" is null or length("retail_resale_evidence"."revocation_reason") <= 2000))
);
--> statement-breakpoint
CREATE TABLE "retail_suppressions" (
	"id" text PRIMARY KEY NOT NULL,
	"scope" text NOT NULL,
	"scope_ref" text NOT NULL,
	"supplier_id" text,
	"supplier_account_id" text,
	"canonical_product_id" text,
	"canonical_variant_id" text,
	"brand_id" text,
	"kind" text NOT NULL,
	"severity" text NOT NULL,
	"source" text NOT NULL,
	"external_reference" text,
	"reason" text NOT NULL,
	"effective_from" timestamp with time zone NOT NULL,
	"raised_by_oxy_user_id" text NOT NULL,
	"lifted_at" timestamp with time zone,
	"lifted_by_oxy_user_id" text,
	"lift_reason" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "retail_suppressions_scope_check" CHECK ("retail_suppressions"."scope" in ('supplier', 'supplier_account', 'canonical_product', 'canonical_variant', 'supplier_sku', 'category', 'market', 'brand')),
	CONSTRAINT "retail_suppressions_kind_check" CHECK ("retail_suppressions"."kind" in ('recall', 'safety_notice', 'kill_switch', 'policy_exclusion')),
	CONSTRAINT "retail_suppressions_severity_check" CHECK ("retail_suppressions"."severity" in ('advisory', 'stop_sale', 'stop_sale_and_recover')),
	CONSTRAINT "retail_suppressions_source_check" CHECK ("retail_suppressions"."source" in ('supplier', 'authority', 'operator', 'internal_monitoring')),
	CONSTRAINT "retail_suppressions_scope_ref_check" CHECK (btrim("retail_suppressions"."scope_ref") <> ''),
	CONSTRAINT "retail_suppressions_market_shape_check" CHECK ("retail_suppressions"."scope" <> 'market' or "retail_suppressions"."scope_ref" ~ '^[A-Z]{2}$'),
	CONSTRAINT "retail_suppressions_reference_check" CHECK (("retail_suppressions"."scope" = 'supplier') = ("retail_suppressions"."supplier_id" is not null)
          and ("retail_suppressions"."scope" = 'supplier_account') = ("retail_suppressions"."supplier_account_id" is not null)
          and ("retail_suppressions"."scope" = 'canonical_product') = ("retail_suppressions"."canonical_product_id" is not null)
          and ("retail_suppressions"."scope" = 'canonical_variant') = ("retail_suppressions"."canonical_variant_id" is not null)
          and ("retail_suppressions"."scope" = 'brand') = ("retail_suppressions"."brand_id" is not null)),
	CONSTRAINT "retail_suppressions_reference_agreement_check" CHECK (("retail_suppressions"."supplier_id" is null or "retail_suppressions"."scope_ref" = "retail_suppressions"."supplier_id")
          and ("retail_suppressions"."supplier_account_id" is null or "retail_suppressions"."scope_ref" = "retail_suppressions"."supplier_account_id")
          and ("retail_suppressions"."canonical_product_id" is null or "retail_suppressions"."scope_ref" = "retail_suppressions"."canonical_product_id")
          and ("retail_suppressions"."canonical_variant_id" is null or "retail_suppressions"."scope_ref" = "retail_suppressions"."canonical_variant_id")
          and ("retail_suppressions"."brand_id" is null or "retail_suppressions"."scope_ref" = "retail_suppressions"."brand_id")),
	CONSTRAINT "retail_suppressions_recall_severity_check" CHECK ("retail_suppressions"."kind" <> 'recall' or "retail_suppressions"."severity" <> 'advisory'),
	CONSTRAINT "retail_suppressions_reason_check" CHECK (btrim("retail_suppressions"."reason") <> '' and length("retail_suppressions"."reason") <= 2000),
	CONSTRAINT "retail_suppressions_actor_check" CHECK (btrim("retail_suppressions"."raised_by_oxy_user_id") <> ''),
	CONSTRAINT "retail_suppressions_lift_check" CHECK ("retail_suppressions"."lifted_at" is null
          or ("retail_suppressions"."lifted_by_oxy_user_id" is not null and btrim(coalesce("retail_suppressions"."lift_reason", '')) <> ''))
);
--> statement-breakpoint
ALTER TABLE "retail_category_rules" ADD CONSTRAINT "retail_category_rules_policy_id_retail_eligibility_policies_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."retail_eligibility_policies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retail_compliance_evidence" ADD CONSTRAINT "retail_compliance_evidence_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retail_compliance_evidence" ADD CONSTRAINT "retail_compliance_evidence_canonical_product_id_canonical_products_id_fk" FOREIGN KEY ("canonical_product_id") REFERENCES "public"."canonical_products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retail_compliance_evidence" ADD CONSTRAINT "retail_compliance_evidence_canonical_variant_id_canonical_variants_id_fk" FOREIGN KEY ("canonical_variant_id") REFERENCES "public"."canonical_variants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retail_eligibility_decisions" ADD CONSTRAINT "retail_eligibility_decisions_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retail_eligibility_decisions" ADD CONSTRAINT "retail_eligibility_decisions_exception_id_retail_eligibility_exceptions_id_fk" FOREIGN KEY ("exception_id") REFERENCES "public"."retail_eligibility_exceptions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retail_eligibility_decisions" ADD CONSTRAINT "retail_eligibility_decisions_policy_fk" FOREIGN KEY ("policy_id","policy_key","policy_version") REFERENCES "public"."retail_eligibility_policies"("id","policy_key","version") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retail_eligibility_exceptions" ADD CONSTRAINT "retail_eligibility_exceptions_policy_id_retail_eligibility_policies_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."retail_eligibility_policies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retail_eligibility_exceptions" ADD CONSTRAINT "retail_eligibility_exceptions_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retail_eligibility_exceptions" ADD CONSTRAINT "retail_eligibility_exceptions_canonical_variant_id_canonical_variants_id_fk" FOREIGN KEY ("canonical_variant_id") REFERENCES "public"."canonical_variants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retail_market_capabilities" ADD CONSTRAINT "retail_market_capabilities_policy_id_retail_eligibility_policies_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."retail_eligibility_policies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retail_resale_evidence" ADD CONSTRAINT "retail_resale_evidence_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retail_resale_evidence" ADD CONSTRAINT "retail_resale_evidence_agreement_id_supplier_agreements_id_fk" FOREIGN KEY ("agreement_id") REFERENCES "public"."supplier_agreements"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retail_resale_evidence" ADD CONSTRAINT "retail_resale_evidence_supplier_account_id_supplier_accounts_id_fk" FOREIGN KEY ("supplier_account_id") REFERENCES "public"."supplier_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retail_suppressions" ADD CONSTRAINT "retail_suppressions_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retail_suppressions" ADD CONSTRAINT "retail_suppressions_supplier_account_id_supplier_accounts_id_fk" FOREIGN KEY ("supplier_account_id") REFERENCES "public"."supplier_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retail_suppressions" ADD CONSTRAINT "retail_suppressions_canonical_product_id_canonical_products_id_fk" FOREIGN KEY ("canonical_product_id") REFERENCES "public"."canonical_products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retail_suppressions" ADD CONSTRAINT "retail_suppressions_canonical_variant_id_canonical_variants_id_fk" FOREIGN KEY ("canonical_variant_id") REFERENCES "public"."canonical_variants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retail_suppressions" ADD CONSTRAINT "retail_suppressions_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "retail_category_rules_policy_category_key" ON "retail_category_rules" USING btree ("policy_id","category_key");--> statement-breakpoint
CREATE INDEX "retail_category_rules_category_idx" ON "retail_category_rules" USING btree ("category_key");--> statement-breakpoint
CREATE INDEX "retail_compliance_evidence_variant_idx" ON "retail_compliance_evidence" USING btree ("canonical_variant_id","kind","review_state") WHERE "retail_compliance_evidence"."canonical_variant_id" is not null;--> statement-breakpoint
CREATE INDEX "retail_compliance_evidence_product_idx" ON "retail_compliance_evidence" USING btree ("canonical_product_id","kind","review_state") WHERE "retail_compliance_evidence"."canonical_product_id" is not null;--> statement-breakpoint
CREATE INDEX "retail_compliance_evidence_supplier_sku_idx" ON "retail_compliance_evidence" USING btree ("supplier_id","supplier_sku") WHERE "retail_compliance_evidence"."supplier_sku" is not null;--> statement-breakpoint
CREATE INDEX "retail_compliance_evidence_expiry_idx" ON "retail_compliance_evidence" USING btree ("expires_at") WHERE "retail_compliance_evidence"."review_state" = 'verified' and "retail_compliance_evidence"."expires_at" is not null;--> statement-breakpoint
CREATE INDEX "retail_eligibility_audits_subject_idx" ON "retail_eligibility_audits" USING btree ("subject_table","subject_id","at");--> statement-breakpoint
CREATE INDEX "retail_eligibility_audits_actor_idx" ON "retail_eligibility_audits" USING btree ("actor_oxy_user_id","at");--> statement-breakpoint
CREATE INDEX "retail_eligibility_audits_action_idx" ON "retail_eligibility_audits" USING btree ("action","at");--> statement-breakpoint
CREATE INDEX "retail_eligibility_decisions_offer_idx" ON "retail_eligibility_decisions" USING btree ("procurement_offer_id","destination_country","evaluated_at");--> statement-breakpoint
CREATE INDEX "retail_eligibility_decisions_supplier_idx" ON "retail_eligibility_decisions" USING btree ("supplier_id","evaluated_at");--> statement-breakpoint
CREATE INDEX "retail_eligibility_decisions_verdict_idx" ON "retail_eligibility_decisions" USING btree ("verdict","evaluated_at");--> statement-breakpoint
CREATE INDEX "retail_eligibility_decisions_content_hash_idx" ON "retail_eligibility_decisions" USING btree ("content_hash");--> statement-breakpoint
CREATE INDEX "retail_eligibility_exceptions_live_idx" ON "retail_eligibility_exceptions" USING btree ("supplier_id","canonical_variant_id","expires_at") WHERE "retail_eligibility_exceptions"."state" = 'approved';--> statement-breakpoint
CREATE INDEX "retail_eligibility_exceptions_queue_idx" ON "retail_eligibility_exceptions" USING btree ("requested_at") WHERE "retail_eligibility_exceptions"."state" = 'requested';--> statement-breakpoint
CREATE UNIQUE INDEX "retail_eligibility_policies_key_version_key" ON "retail_eligibility_policies" USING btree ("policy_key","version");--> statement-breakpoint
CREATE UNIQUE INDEX "retail_eligibility_policies_one_active_per_key" ON "retail_eligibility_policies" USING btree ("policy_key") WHERE "retail_eligibility_policies"."status" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "retail_market_capabilities_route_key" ON "retail_market_capabilities" USING btree ("policy_id","destination_country","fulfilment_origin_country","customer_type");--> statement-breakpoint
CREATE INDEX "retail_market_capabilities_destination_idx" ON "retail_market_capabilities" USING btree ("destination_country");--> statement-breakpoint
CREATE INDEX "retail_resale_evidence_supplier_idx" ON "retail_resale_evidence" USING btree ("supplier_id","kind","review_state");--> statement-breakpoint
CREATE INDEX "retail_resale_evidence_agreement_idx" ON "retail_resale_evidence" USING btree ("agreement_id") WHERE "retail_resale_evidence"."agreement_id" is not null;--> statement-breakpoint
CREATE INDEX "retail_resale_evidence_expiry_idx" ON "retail_resale_evidence" USING btree ("expires_at") WHERE "retail_resale_evidence"."review_state" = 'verified' and "retail_resale_evidence"."expires_at" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "retail_suppressions_live_key" ON "retail_suppressions" USING btree ("scope","scope_ref","kind") WHERE "retail_suppressions"."lifted_at" is null;--> statement-breakpoint
CREATE INDEX "retail_suppressions_active_idx" ON "retail_suppressions" USING btree ("scope","scope_ref") WHERE "retail_suppressions"."lifted_at" is null;--> statement-breakpoint
CREATE INDEX "retail_suppressions_raised_idx" ON "retail_suppressions" USING btree ("created_at");--> statement-breakpoint
-- ── Hand-written enforcement (drizzle-kit does not model triggers) ──────────
--
-- Three properties #121 rests on that no CHECK can express, added here the way
-- the ledger, fee, procurement and retail-pricing domains add theirs. A
-- regeneration of this file DROPS these statements: re-apply them and grep for
-- each function/trigger pair before pushing (AGENTS.md §"Rebasing a migration
-- behind another branch's").

-- 1. A policy version is immutable once it leaves `draft`. Acceptance 7 —
-- "every eligibility result is reproducible from versioned policy and
-- evidence" — is false the moment an active version can be edited underneath a
-- decision that cited it. The `fee_schedules` / `retail_pricing_policies`
-- mechanism, applied to the version a decision cites by composite foreign key.
CREATE FUNCTION mercaria_retail_eligibility_policy_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN
      RAISE EXCEPTION
        'retail eligibility policy %.% is %, not draft: published policy versions are never deleted. Retire it, or publish a new version.',
        OLD.policy_key, OLD.version, OLD.status
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.status <> 'draft' AND (
    NEW.policy_key IS DISTINCT FROM OLD.policy_key OR
    NEW.version IS DISTINCT FROM OLD.version OR
    NEW.name IS DISTINCT FROM OLD.name OR
    NEW.summary IS DISTINCT FROM OLD.summary OR
    NEW.effective_start IS DISTINCT FROM OLD.effective_start OR
    NEW.effective_end IS DISTINCT FROM OLD.effective_end OR
    NEW.permitted_destination_countries IS DISTINCT FROM OLD.permitted_destination_countries OR
    NEW.permitted_fulfilment_origin_countries IS DISTINCT FROM OLD.permitted_fulfilment_origin_countries OR
    NEW.permitted_channels IS DISTINCT FROM OLD.permitted_channels OR
    NEW.permitted_currencies IS DISTINCT FROM OLD.permitted_currencies OR
    NEW.permitted_fulfilment_methods IS DISTINCT FROM OLD.permitted_fulfilment_methods OR
    NEW.permitted_customer_types IS DISTINCT FROM OLD.permitted_customer_types OR
    NEW.required_resale_evidence_kinds IS DISTINCT FROM OLD.required_resale_evidence_kinds OR
    NEW.required_identifier_schemes IS DISTINCT FROM OLD.required_identifier_schemes OR
    NEW.require_country_of_origin IS DISTINCT FROM OLD.require_country_of_origin OR
    NEW.require_responsible_operator IS DISTINCT FROM OLD.require_responsible_operator OR
    NEW.require_deterministic_product_match IS DISTINCT FROM OLD.require_deterministic_product_match OR
    NEW.minimum_match_confidence IS DISTINCT FROM OLD.minimum_match_confidence OR
    NEW.max_quantity_per_order IS DISTINCT FROM OLD.max_quantity_per_order OR
    NEW.max_order_value_amount IS DISTINCT FROM OLD.max_order_value_amount OR
    NEW.max_order_value_currency IS DISTINCT FROM OLD.max_order_value_currency OR
    NEW.manual_exceptions_permitted IS DISTINCT FROM OLD.manual_exceptions_permitted OR
    NEW.exception_dual_approval_required IS DISTINCT FROM OLD.exception_dual_approval_required OR
    NEW.created_by_oxy_user_id IS DISTINCT FROM OLD.created_by_oxy_user_id OR
    NEW.created_at IS DISTINCT FROM OLD.created_at
  ) THEN
    RAISE EXCEPTION
      'retail eligibility policy %.% is %, not draft: its scope is immutable. Publish a new version instead of editing this one.',
      OLD.policy_key, OLD.version, OLD.status
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER retail_eligibility_policies_immutable_once_active
  BEFORE UPDATE OR DELETE ON "retail_eligibility_policies"
  FOR EACH ROW EXECUTE FUNCTION mercaria_retail_eligibility_policy_immutable();--> statement-breakpoint

-- 2. A recorded decision is append-only. It is the evidence that Mercaria
-- answered a given question a given way at a given time — including the
-- answers that blocked a sale — so editing one would rewrite the record of a
-- refusal, and deleting one would erase it.
CREATE FUNCTION mercaria_retail_eligibility_decision_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'retail eligibility decisions are append-only: % on %.% is refused. A verdict is re-derived, never edited — record a new decision.',
    TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME
    USING ERRCODE = 'check_violation';
END;
$$;--> statement-breakpoint
CREATE TRIGGER retail_eligibility_decisions_append_only
  BEFORE UPDATE OR DELETE ON "retail_eligibility_decisions"
  FOR EACH ROW EXECUTE FUNCTION mercaria_retail_eligibility_decision_append_only();--> statement-breakpoint

-- 3. The audit trail is append-only, one row per ATTEMPT, refusals included —
-- the `payment_repairs` shape. An audit table whose rows can be edited or
-- deleted answers no question an incident actually asks.
CREATE FUNCTION mercaria_retail_eligibility_audit_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'retail eligibility audits are append-only: % on %.% is refused. Append the correcting act instead.',
    TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME
    USING ERRCODE = 'check_violation';
END;
$$;--> statement-breakpoint
CREATE TRIGGER retail_eligibility_audits_append_only
  BEFORE UPDATE OR DELETE ON "retail_eligibility_audits"
  FOR EACH ROW EXECUTE FUNCTION mercaria_retail_eligibility_audit_append_only();
