-- oxy:deploy-phase=pre
CREATE TABLE "retail_cost_quote_acceptances" (
	"id" text PRIMARY KEY NOT NULL,
	"quote_id" text NOT NULL,
	"checkout_group_id" text NOT NULL,
	"order_id" text,
	"accepted_total_amount" bigint NOT NULL,
	"accepted_total_currency" text NOT NULL,
	"quote_content_hash" text NOT NULL,
	"accepted_at" timestamp with time zone NOT NULL,
	"accepted_by_oxy_user_id" text,
	"accepted_guest_session_id" text,
	"supersedes_acceptance_id" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "retail_cost_quote_acceptances_accepted_total_currency_check" CHECK ("retail_cost_quote_acceptances"."accepted_total_currency" in ('FAIR', 'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF', 'CNY', 'SEK', 'NOK', 'DKK', 'PLN', 'MXN', 'BRL', 'INR', 'NZD', 'ZAR', 'SGD', 'HKD', 'AED')),
	CONSTRAINT "retail_cost_quote_acceptances_amount_check" CHECK ("retail_cost_quote_acceptances"."accepted_total_amount" >= 0),
	CONSTRAINT "retail_cost_quote_acceptances_checkout_group_check" CHECK (length(btrim("retail_cost_quote_acceptances"."checkout_group_id")) > 0),
	CONSTRAINT "retail_cost_quote_acceptances_content_hash_check" CHECK ("retail_cost_quote_acceptances"."quote_content_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "retail_cost_quote_acceptances_actor_check" CHECK (num_nonnulls("retail_cost_quote_acceptances"."accepted_by_oxy_user_id", "retail_cost_quote_acceptances"."accepted_guest_session_id") = 1),
	CONSTRAINT "retail_cost_quote_acceptances_supersede_check" CHECK ("retail_cost_quote_acceptances"."supersedes_acceptance_id" is null or "retail_cost_quote_acceptances"."supersedes_acceptance_id" <> "retail_cost_quote_acceptances"."id")
);
--> statement-breakpoint
CREATE TABLE "retail_cost_quote_components" (
	"id" text PRIMARY KEY NOT NULL,
	"quote_id" text NOT NULL,
	"kind" text NOT NULL,
	"source_ref" text NOT NULL,
	"source_amount" bigint NOT NULL,
	"source_currency" text NOT NULL,
	"presentment_amount" bigint NOT NULL,
	"presentment_currency" text NOT NULL,
	"fx_rate_from" text,
	"fx_rate_to" text,
	"fx_rate_rate" double precision,
	"fx_rate_provider" text,
	"fx_rate_as_of" text,
	"fx_basis" text,
	"confidence" text NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"supplier_quote_ref" text,
	"source_observation_ref" text,
	"evidence_ref" text,
	"description" text,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "retail_cost_quote_components_kind_check" CHECK ("retail_cost_quote_components"."kind" in ('supplier_item', 'supplier_variant_surcharge', 'supplier_handling', 'destination_shipping', 'tax_duty', 'fx_cost', 'payment_processing', 'other_direct_fulfilment')),
	CONSTRAINT "retail_cost_quote_components_confidence_check" CHECK ("retail_cost_quote_components"."confidence" in ('quoted', 'guaranteed', 'estimated', 'final')),
	CONSTRAINT "retail_cost_quote_components_fx_basis_check" CHECK ("retail_cost_quote_components"."fx_basis" in ('quoted', 'provider_final')),
	CONSTRAINT "retail_cost_quote_components_source_currency_check" CHECK ("retail_cost_quote_components"."source_currency" in ('FAIR', 'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF', 'CNY', 'SEK', 'NOK', 'DKK', 'PLN', 'MXN', 'BRL', 'INR', 'NZD', 'ZAR', 'SGD', 'HKD', 'AED')),
	CONSTRAINT "retail_cost_quote_components_presentment_currency_check" CHECK ("retail_cost_quote_components"."presentment_currency" in ('FAIR', 'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF', 'CNY', 'SEK', 'NOK', 'DKK', 'PLN', 'MXN', 'BRL', 'INR', 'NZD', 'ZAR', 'SGD', 'HKD', 'AED')),
	CONSTRAINT "retail_cost_quote_components_fx_rate_from_check" CHECK ("retail_cost_quote_components"."fx_rate_from" in ('FAIR', 'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF', 'CNY', 'SEK', 'NOK', 'DKK', 'PLN', 'MXN', 'BRL', 'INR', 'NZD', 'ZAR', 'SGD', 'HKD', 'AED')),
	CONSTRAINT "retail_cost_quote_components_fx_rate_to_check" CHECK ("retail_cost_quote_components"."fx_rate_to" in ('FAIR', 'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF', 'CNY', 'SEK', 'NOK', 'DKK', 'PLN', 'MXN', 'BRL', 'INR', 'NZD', 'ZAR', 'SGD', 'HKD', 'AED')),
	CONSTRAINT "retail_cost_quote_components_source_ref_check" CHECK (length(btrim("retail_cost_quote_components"."source_ref")) > 0),
	CONSTRAINT "retail_cost_quote_components_amounts_check" CHECK ("retail_cost_quote_components"."source_amount" >= 0 and "retail_cost_quote_components"."presentment_amount" >= 0),
	CONSTRAINT "retail_cost_quote_components_fx_presence_check" CHECK (num_nonnulls("retail_cost_quote_components"."fx_rate_from", "retail_cost_quote_components"."fx_rate_to", "retail_cost_quote_components"."fx_rate_rate", "retail_cost_quote_components"."fx_rate_provider", "retail_cost_quote_components"."fx_rate_as_of") in (0, 5)
          and ("retail_cost_quote_components"."source_currency" = "retail_cost_quote_components"."presentment_currency") = ("retail_cost_quote_components"."fx_rate_rate" is null)),
	CONSTRAINT "retail_cost_quote_components_fx_pair_check" CHECK ("retail_cost_quote_components"."fx_rate_rate" is null
          or ("retail_cost_quote_components"."fx_rate_from" = "retail_cost_quote_components"."source_currency"
              and "retail_cost_quote_components"."fx_rate_to" = "retail_cost_quote_components"."presentment_currency"
              and "retail_cost_quote_components"."fx_rate_rate" > 0)),
	CONSTRAINT "retail_cost_quote_components_fx_basis_presence_check" CHECK (("retail_cost_quote_components"."fx_basis" is not null) = ("retail_cost_quote_components"."fx_rate_rate" is not null))
);
--> statement-breakpoint
CREATE TABLE "retail_cost_quotes" (
	"id" text PRIMARY KEY NOT NULL,
	"policy_id" text NOT NULL,
	"policy_key" text NOT NULL,
	"policy_version" integer NOT NULL,
	"supplier_id" text NOT NULL,
	"supplier_account_id" text NOT NULL,
	"agreement_id" text NOT NULL,
	"procurement_offer_id" text,
	"canonical_product_id" text,
	"canonical_variant_id" text,
	"supplier_sku" text NOT NULL,
	"quantity" integer NOT NULL,
	"destination_country" text,
	"destination_region" text,
	"presentment_currency" text NOT NULL,
	"customer_total_amount" bigint NOT NULL,
	"customer_total_currency" text NOT NULL,
	"subsidy_amount" bigint,
	"subsidy_currency" text,
	"subsidy_source" text,
	"subsidy_budget_ref" text,
	"buyer_payable_amount" bigint NOT NULL,
	"buyer_payable_currency" text NOT NULL,
	"completeness" text NOT NULL,
	"presentation" text NOT NULL,
	"block_reasons" text[] DEFAULT '{}' NOT NULL,
	"quoted_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"content_hash" text NOT NULL,
	"supersedes_quote_id" text,
	"supersede_reason" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "retail_cost_quotes_completeness_check" CHECK ("retail_cost_quotes"."completeness" in ('complete', 'awaiting_destination', 'blocked_undocumented_cost', 'blocked_tax_undetermined', 'blocked_unquotable_cost')),
	CONSTRAINT "retail_cost_quotes_presentation_check" CHECK ("retail_cost_quotes"."presentation" in ('exact_cost_only', 'starting_item_cost', 'not_purchasable')),
	CONSTRAINT "retail_cost_quotes_subsidy_source_check" CHECK ("retail_cost_quotes"."subsidy_source" in ('mercaria_marketing_budget')),
	CONSTRAINT "retail_cost_quotes_supersede_reason_check" CHECK ("retail_cost_quotes"."supersede_reason" in ('supplier_cost_changed', 'shipping_quoted', 'tax_determined', 'quote_expired', 'policy_version_changed')),
	CONSTRAINT "retail_cost_quotes_block_reasons_check" CHECK ("retail_cost_quotes"."block_reasons" <@ array['destination_unknown', 'shipping_not_quotable', 'undocumented_supplier_fee', 'tax_undetermined', 'market_not_supported', 'supplier_price_unavailable', 'fx_rate_unavailable', 'payment_cost_undetermined', 'component_not_permitted_by_policy', 'policy_missing']::text[]),
	CONSTRAINT "retail_cost_quotes_presentment_currency_check" CHECK ("retail_cost_quotes"."presentment_currency" in ('FAIR', 'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF', 'CNY', 'SEK', 'NOK', 'DKK', 'PLN', 'MXN', 'BRL', 'INR', 'NZD', 'ZAR', 'SGD', 'HKD', 'AED')),
	CONSTRAINT "retail_cost_quotes_customer_total_currency_check" CHECK ("retail_cost_quotes"."customer_total_currency" in ('FAIR', 'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF', 'CNY', 'SEK', 'NOK', 'DKK', 'PLN', 'MXN', 'BRL', 'INR', 'NZD', 'ZAR', 'SGD', 'HKD', 'AED')),
	CONSTRAINT "retail_cost_quotes_subsidy_currency_check" CHECK ("retail_cost_quotes"."subsidy_currency" in ('FAIR', 'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF', 'CNY', 'SEK', 'NOK', 'DKK', 'PLN', 'MXN', 'BRL', 'INR', 'NZD', 'ZAR', 'SGD', 'HKD', 'AED')),
	CONSTRAINT "retail_cost_quotes_buyer_payable_currency_check" CHECK ("retail_cost_quotes"."buyer_payable_currency" in ('FAIR', 'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF', 'CNY', 'SEK', 'NOK', 'DKK', 'PLN', 'MXN', 'BRL', 'INR', 'NZD', 'ZAR', 'SGD', 'HKD', 'AED')),
	CONSTRAINT "retail_cost_quotes_policy_version_check" CHECK ("retail_cost_quotes"."policy_version" >= 1),
	CONSTRAINT "retail_cost_quotes_supplier_sku_check" CHECK (length("retail_cost_quotes"."supplier_sku") > 0),
	CONSTRAINT "retail_cost_quotes_quantity_check" CHECK ("retail_cost_quotes"."quantity" > 0),
	CONSTRAINT "retail_cost_quotes_currency_coherence_check" CHECK ("retail_cost_quotes"."customer_total_currency" = "retail_cost_quotes"."presentment_currency"
          and "retail_cost_quotes"."buyer_payable_currency" = "retail_cost_quotes"."presentment_currency"
          and ("retail_cost_quotes"."subsidy_currency" is null or "retail_cost_quotes"."subsidy_currency" = "retail_cost_quotes"."presentment_currency")),
	CONSTRAINT "retail_cost_quotes_amounts_check" CHECK ("retail_cost_quotes"."customer_total_amount" >= 0 and "retail_cost_quotes"."buyer_payable_amount" >= 0),
	CONSTRAINT "retail_cost_quotes_subsidy_complete_check" CHECK (num_nonnulls("retail_cost_quotes"."subsidy_amount", "retail_cost_quotes"."subsidy_currency", "retail_cost_quotes"."subsidy_source", "retail_cost_quotes"."subsidy_budget_ref") in (0, 4)),
	CONSTRAINT "retail_cost_quotes_subsidy_bounds_check" CHECK ("retail_cost_quotes"."subsidy_amount" is null
          or ("retail_cost_quotes"."subsidy_amount" >= 0 and "retail_cost_quotes"."subsidy_amount" <= "retail_cost_quotes"."customer_total_amount")),
	CONSTRAINT "retail_cost_quotes_buyer_payable_check" CHECK ("retail_cost_quotes"."buyer_payable_amount" = "retail_cost_quotes"."customer_total_amount" - coalesce("retail_cost_quotes"."subsidy_amount", 0)),
	CONSTRAINT "retail_cost_quotes_presentation_mapping_check" CHECK (("retail_cost_quotes"."completeness" = 'complete') = ("retail_cost_quotes"."presentation" = 'exact_cost_only')
          and ("retail_cost_quotes"."completeness" = 'awaiting_destination') = ("retail_cost_quotes"."presentation" = 'starting_item_cost')),
	CONSTRAINT "retail_cost_quotes_block_reason_presence_check" CHECK (("retail_cost_quotes"."completeness" = 'complete') = (cardinality("retail_cost_quotes"."block_reasons") = 0)),
	CONSTRAINT "retail_cost_quotes_complete_needs_destination_check" CHECK ("retail_cost_quotes"."completeness" <> 'complete' or "retail_cost_quotes"."destination_country" is not null),
	CONSTRAINT "retail_cost_quotes_destination_shape_check" CHECK (("retail_cost_quotes"."destination_country" is null or "retail_cost_quotes"."destination_country" ~ '^[A-Z]{2}$')
          and ("retail_cost_quotes"."destination_region" is null or "retail_cost_quotes"."destination_country" is not null)),
	CONSTRAINT "retail_cost_quotes_validity_window_check" CHECK ("retail_cost_quotes"."expires_at" > "retail_cost_quotes"."quoted_at"),
	CONSTRAINT "retail_cost_quotes_content_hash_check" CHECK ("retail_cost_quotes"."content_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "retail_cost_quotes_supersede_check" CHECK (num_nonnulls("retail_cost_quotes"."supersedes_quote_id", "retail_cost_quotes"."supersede_reason") in (0, 2)
          and ("retail_cost_quotes"."supersedes_quote_id" is null or "retail_cost_quotes"."supersedes_quote_id" <> "retail_cost_quotes"."id"))
);
--> statement-breakpoint
CREATE TABLE "retail_pricing_policies" (
	"id" text PRIMARY KEY NOT NULL,
	"policy_key" text NOT NULL,
	"version" integer NOT NULL,
	"name" text NOT NULL,
	"summary" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"effective_start" timestamp with time zone NOT NULL,
	"effective_end" timestamp with time zone,
	"allowed_component_kinds" text[] DEFAULT '{}' NOT NULL,
	"payment_cost_passthrough_enabled" boolean DEFAULT false NOT NULL,
	"payment_cost_passthrough_basis" text,
	"absorption_cap_bps" integer DEFAULT 1000 NOT NULL,
	"absorption_cap_floor_amount" bigint NOT NULL,
	"absorption_cap_floor_currency" text NOT NULL,
	"rounding_tolerance_minor" bigint DEFAULT 1 NOT NULL,
	"quote_ttl_seconds" integer DEFAULT 900 NOT NULL,
	"created_by_oxy_user_id" text NOT NULL,
	"approved_by_oxy_user_id" text,
	"activated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "retail_pricing_policies_status_check" CHECK ("retail_pricing_policies"."status" in ('draft', 'active', 'superseded', 'retired')),
	CONSTRAINT "retail_pricing_policies_allowed_components_check" CHECK ("retail_pricing_policies"."allowed_component_kinds" <@ array['supplier_item', 'supplier_variant_surcharge', 'supplier_handling', 'destination_shipping', 'tax_duty', 'fx_cost', 'payment_processing', 'other_direct_fulfilment']::text[]),
	CONSTRAINT "retail_pricing_policies_absorption_cap_floor_currency_check" CHECK ("retail_pricing_policies"."absorption_cap_floor_currency" in ('FAIR', 'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF', 'CNY', 'SEK', 'NOK', 'DKK', 'PLN', 'MXN', 'BRL', 'INR', 'NZD', 'ZAR', 'SGD', 'HKD', 'AED')),
	CONSTRAINT "retail_pricing_policies_version_check" CHECK ("retail_pricing_policies"."version" >= 1),
	CONSTRAINT "retail_pricing_policies_key_check" CHECK ("retail_pricing_policies"."policy_key" ~ '^[a-z0-9][a-z0-9-]{1,63}$'),
	CONSTRAINT "retail_pricing_policies_item_cost_required_check" CHECK ('supplier_item' = any("retail_pricing_policies"."allowed_component_kinds")),
	CONSTRAINT "retail_pricing_policies_payment_passthrough_check" CHECK ("retail_pricing_policies"."payment_cost_passthrough_enabled" = ("retail_pricing_policies"."payment_cost_passthrough_basis" is not null)
          and ("retail_pricing_policies"."payment_cost_passthrough_basis" is null
               or length(btrim("retail_pricing_policies"."payment_cost_passthrough_basis")) between 1 and 2000)),
	CONSTRAINT "retail_pricing_policies_payment_component_check" CHECK (not "retail_pricing_policies"."payment_cost_passthrough_enabled"
          or 'payment_processing' = any("retail_pricing_policies"."allowed_component_kinds")),
	CONSTRAINT "retail_pricing_policies_absorption_cap_check" CHECK ("retail_pricing_policies"."absorption_cap_bps" between 0 and 10000 and "retail_pricing_policies"."absorption_cap_floor_amount" >= 0),
	CONSTRAINT "retail_pricing_policies_rounding_tolerance_check" CHECK ("retail_pricing_policies"."rounding_tolerance_minor" between 0 and 5),
	CONSTRAINT "retail_pricing_policies_quote_ttl_check" CHECK ("retail_pricing_policies"."quote_ttl_seconds" >= 1),
	CONSTRAINT "retail_pricing_policies_effective_window_check" CHECK ("retail_pricing_policies"."effective_end" is null or "retail_pricing_policies"."effective_end" > "retail_pricing_policies"."effective_start"),
	CONSTRAINT "retail_pricing_policies_activation_audit_check" CHECK ("retail_pricing_policies"."status" not in ('active', 'superseded')
          or ("retail_pricing_policies"."approved_by_oxy_user_id" is not null and "retail_pricing_policies"."activated_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "retail_cost_quote_acceptances" ADD CONSTRAINT "retail_cost_quote_acceptances_quote_id_retail_cost_quotes_id_fk" FOREIGN KEY ("quote_id") REFERENCES "public"."retail_cost_quotes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retail_cost_quote_acceptances" ADD CONSTRAINT "retail_cost_quote_acceptances_supersedes_acceptance_id_retail_cost_quote_acceptances_id_fk" FOREIGN KEY ("supersedes_acceptance_id") REFERENCES "public"."retail_cost_quote_acceptances"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retail_cost_quote_components" ADD CONSTRAINT "retail_cost_quote_components_quote_id_retail_cost_quotes_id_fk" FOREIGN KEY ("quote_id") REFERENCES "public"."retail_cost_quotes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retail_cost_quotes" ADD CONSTRAINT "retail_cost_quotes_policy_id_retail_pricing_policies_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."retail_pricing_policies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retail_cost_quotes" ADD CONSTRAINT "retail_cost_quotes_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retail_cost_quotes" ADD CONSTRAINT "retail_cost_quotes_supplier_account_id_supplier_accounts_id_fk" FOREIGN KEY ("supplier_account_id") REFERENCES "public"."supplier_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retail_cost_quotes" ADD CONSTRAINT "retail_cost_quotes_agreement_id_supplier_agreements_id_fk" FOREIGN KEY ("agreement_id") REFERENCES "public"."supplier_agreements"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retail_cost_quotes" ADD CONSTRAINT "retail_cost_quotes_supersedes_quote_id_retail_cost_quotes_id_fk" FOREIGN KEY ("supersedes_quote_id") REFERENCES "public"."retail_cost_quotes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "retail_cost_quote_acceptances_group_quote_key" ON "retail_cost_quote_acceptances" USING btree ("checkout_group_id","quote_id");--> statement-breakpoint
CREATE INDEX "retail_cost_quote_acceptances_quote_idx" ON "retail_cost_quote_acceptances" USING btree ("quote_id");--> statement-breakpoint
CREATE INDEX "retail_cost_quote_acceptances_order_idx" ON "retail_cost_quote_acceptances" USING btree ("order_id") WHERE "retail_cost_quote_acceptances"."order_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "retail_cost_quote_components_quote_position_key" ON "retail_cost_quote_components" USING btree ("quote_id","position");--> statement-breakpoint
CREATE INDEX "retail_cost_quote_components_quote_kind_idx" ON "retail_cost_quote_components" USING btree ("quote_id","kind");--> statement-breakpoint
CREATE INDEX "retail_cost_quotes_offer_idx" ON "retail_cost_quotes" USING btree ("procurement_offer_id","created_at") WHERE "retail_cost_quotes"."procurement_offer_id" is not null;--> statement-breakpoint
CREATE INDEX "retail_cost_quotes_supplier_idx" ON "retail_cost_quotes" USING btree ("supplier_id","created_at");--> statement-breakpoint
CREATE INDEX "retail_cost_quotes_variant_market_idx" ON "retail_cost_quotes" USING btree ("canonical_variant_id","destination_country","expires_at") WHERE "retail_cost_quotes"."completeness" = 'complete';--> statement-breakpoint
CREATE INDEX "retail_cost_quotes_content_hash_idx" ON "retail_cost_quotes" USING btree ("content_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "retail_pricing_policies_key_version_key" ON "retail_pricing_policies" USING btree ("policy_key","version");--> statement-breakpoint
CREATE UNIQUE INDEX "retail_pricing_policies_one_active_per_key" ON "retail_pricing_policies" USING btree ("policy_key") WHERE "retail_pricing_policies"."status" = 'active';
--> statement-breakpoint
-- drizzle-kit does not model triggers. Ship the immutability contract with the
-- tables so no interval exists in which a published policy or a frozen cost
-- quote can be edited (the ledger/fee trigger precedent).
CREATE FUNCTION mercaria_retail_policy_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN
      RAISE EXCEPTION
        'retail pricing policy %.% is %, not draft: published policy versions are never deleted. Retire it, or publish a new version.',
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
    NEW.allowed_component_kinds IS DISTINCT FROM OLD.allowed_component_kinds OR
    NEW.payment_cost_passthrough_enabled IS DISTINCT FROM OLD.payment_cost_passthrough_enabled OR
    NEW.payment_cost_passthrough_basis IS DISTINCT FROM OLD.payment_cost_passthrough_basis OR
    NEW.absorption_cap_bps IS DISTINCT FROM OLD.absorption_cap_bps OR
    NEW.absorption_cap_floor_amount IS DISTINCT FROM OLD.absorption_cap_floor_amount OR
    NEW.absorption_cap_floor_currency IS DISTINCT FROM OLD.absorption_cap_floor_currency OR
    NEW.rounding_tolerance_minor IS DISTINCT FROM OLD.rounding_tolerance_minor OR
    NEW.quote_ttl_seconds IS DISTINCT FROM OLD.quote_ttl_seconds OR
    NEW.created_by_oxy_user_id IS DISTINCT FROM OLD.created_by_oxy_user_id OR
    NEW.created_at IS DISTINCT FROM OLD.created_at
  ) THEN
    RAISE EXCEPTION
      'retail pricing policy %.% is %, not draft: its terms are immutable. Publish a new version instead of editing this one.',
      OLD.policy_key, OLD.version, OLD.status
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER retail_pricing_policies_immutable_once_active
  BEFORE UPDATE OR DELETE ON "retail_pricing_policies"
  FOR EACH ROW EXECUTE FUNCTION mercaria_retail_policy_immutable();--> statement-breakpoint
CREATE FUNCTION mercaria_retail_quote_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'retail cost quotes are append-only: % on %.% is refused. The charged amount is a pure function of the frozen quote, so a quote and its components are immutable from birth. Re-quote instead.',
    TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME
    USING ERRCODE = 'check_violation';
END;
$$;--> statement-breakpoint
CREATE TRIGGER retail_cost_quotes_append_only
  BEFORE UPDATE OR DELETE ON "retail_cost_quotes"
  FOR EACH ROW EXECUTE FUNCTION mercaria_retail_quote_append_only();--> statement-breakpoint
CREATE TRIGGER retail_cost_quote_components_append_only
  BEFORE UPDATE OR DELETE ON "retail_cost_quote_components"
  FOR EACH ROW EXECUTE FUNCTION mercaria_retail_quote_append_only();--> statement-breakpoint
-- The acceptance is append-only with ONE narrow, one-way exception: `order_id`
-- moving from NULL to a value, exactly once, with every other column
-- unchanged. The checkout lock is taken BEFORE the retail order row exists
-- (ADR 0004 D4 step 1), so freezing the accepted quote onto the order needs
-- that single write — and nothing else, ever, which is what keeps an accepted
-- amount from being raised after the fact.
CREATE FUNCTION mercaria_retail_acceptance_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION
      'retail cost quote acceptances are append-only: DELETE is refused. An accepted customer amount is a financial record.'
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.order_id IS NOT NULL OR NEW.order_id IS NULL THEN
    RAISE EXCEPTION
      'retail cost quote acceptance % is frozen: the only permitted update attaches order_id once, from NULL. Re-quote and take a new acceptance instead.',
      OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR
     NEW.quote_id IS DISTINCT FROM OLD.quote_id OR
     NEW.checkout_group_id IS DISTINCT FROM OLD.checkout_group_id OR
     NEW.accepted_total_amount IS DISTINCT FROM OLD.accepted_total_amount OR
     NEW.accepted_total_currency IS DISTINCT FROM OLD.accepted_total_currency OR
     NEW.quote_content_hash IS DISTINCT FROM OLD.quote_content_hash OR
     NEW.accepted_at IS DISTINCT FROM OLD.accepted_at OR
     NEW.accepted_by_oxy_user_id IS DISTINCT FROM OLD.accepted_by_oxy_user_id OR
     NEW.accepted_guest_session_id IS DISTINCT FROM OLD.accepted_guest_session_id OR
     NEW.supersedes_acceptance_id IS DISTINCT FROM OLD.supersedes_acceptance_id OR
     NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION
      'retail cost quote acceptance % is frozen: attaching order_id may not change any other column, and an accepted amount never rises.',
      OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER retail_cost_quote_acceptances_append_only
  BEFORE UPDATE OR DELETE ON "retail_cost_quote_acceptances"
  FOR EACH ROW EXECUTE FUNCTION mercaria_retail_acceptance_append_only();
