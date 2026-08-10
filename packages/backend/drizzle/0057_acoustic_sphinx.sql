-- oxy:deploy-phase=pre
--
-- Private watchlists and currency-safe basket tracking (#81).
--
-- Purely ADDITIVE. Four new tables and nothing else — no column of another
-- domain moves, no CHECK is narrowed, and the serving image writes none of
-- these tables, so this applies cleanly ahead of the rollout.
--
-- HAND-WRITTEN STATEMENTS BELOW THE GENERATED BLOCK. `db:generate` DROPS them
-- on a regeneration; re-apply them at the END of the file and confirm with:
--
--   grep -c '^CREATE TRIGGER'  drizzle/0057_*.sql       # 2
--   grep -c '^CREATE FUNCTION' drizzle/0057_*.sql       # 2
--   grep -c '^-- oxy:deploy-phase' drizzle/0057_*.sql   # 1
--

CREATE TABLE "watchlist_items" (
	"id" text PRIMARY KEY NOT NULL,
	"watchlist_id" text NOT NULL,
	"canonical_product_id" text NOT NULL,
	"preferred_canonical_variant_id" text,
	"preferred_condition_group" text,
	"preferred_merchant_id" text,
	"quantity" integer DEFAULT 1 NOT NULL,
	"position" integer NOT NULL,
	"target_amount" bigint,
	"target_currency" text,
	"note" text,
	"resolution_state" text DEFAULT 'resolved' NOT NULL,
	"ambiguous_split_job_id" text,
	"added_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "watchlist_items_quantity_check" CHECK ("watchlist_items"."quantity" >= 1 and "watchlist_items"."quantity" <= 999),
	CONSTRAINT "watchlist_items_position_check" CHECK ("watchlist_items"."position" >= 0),
	CONSTRAINT "watchlist_items_preferred_condition_group_check" CHECK ("watchlist_items"."preferred_condition_group" in ('new', 'open_box', 'refurbished', 'used', 'for_parts')),
	CONSTRAINT "watchlist_items_resolution_state_check" CHECK ("watchlist_items"."resolution_state" in ('resolved', 'ambiguous_after_split')),
	CONSTRAINT "watchlist_items_ambiguity_check" CHECK (("watchlist_items"."resolution_state" = 'ambiguous_after_split') = ("watchlist_items"."ambiguous_split_job_id" is not null)),
	CONSTRAINT "watchlist_items_target_shape_check" CHECK (num_nonnulls("watchlist_items"."target_amount", "watchlist_items"."target_currency") in (0, 2)),
	CONSTRAINT "watchlist_items_target_range_check" CHECK ("watchlist_items"."target_amount" is null
          or ("watchlist_items"."target_amount" >= 0
              and "watchlist_items"."target_amount" <= 9007199254740991)),
	CONSTRAINT "watchlist_items_target_currency_check" CHECK ("watchlist_items"."target_currency" in ('FAIR', 'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF', 'CNY', 'SEK', 'NOK', 'DKK', 'PLN', 'MXN', 'BRL', 'INR', 'NZD', 'ZAR', 'SGD', 'HKD', 'AED')),
	CONSTRAINT "watchlist_items_note_check" CHECK ("watchlist_items"."note" is null
          or (btrim("watchlist_items"."note") <> ''
              and length("watchlist_items"."note") <= 2000))
);
--> statement-breakpoint
CREATE TABLE "watchlist_snapshot_items" (
	"id" text PRIMARY KEY NOT NULL,
	"snapshot_id" text NOT NULL,
	"watchlist_item_id" text,
	"canonical_product_id" text NOT NULL,
	"preferred_canonical_variant_id" text,
	"quantity" integer NOT NULL,
	"position" integer NOT NULL,
	"state" text NOT NULL,
	"unresolved_reason" text,
	"selected_offer_id" text,
	"selected_canonical_variant_id" text,
	"selected_availability" text,
	"ranking_policy_version" text,
	"unit_item_price_amount" bigint,
	"unit_item_price_currency" text,
	"line_item_price_amount" bigint,
	"unit_delivery_amount" bigint,
	"line_delivery_amount" bigint,
	"native_currency" text,
	"fx_rate" double precision,
	"fx_from" text,
	"fx_to" text,
	"fx_provider" text,
	"fx_as_of" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "watchlist_snapshot_items_quantity_check" CHECK ("watchlist_snapshot_items"."quantity" >= 1),
	CONSTRAINT "watchlist_snapshot_items_position_check" CHECK ("watchlist_snapshot_items"."position" >= 0),
	CONSTRAINT "watchlist_snapshot_items_state_check" CHECK ("watchlist_snapshot_items"."state" in ('priced', 'unresolved')),
	CONSTRAINT "watchlist_snapshot_items_unresolved_reason_check" CHECK ("watchlist_snapshot_items"."unresolved_reason" in ('ambiguous_after_split', 'preferred_variant_retired', 'product_merged_into_existing_item', 'product_unavailable', 'no_offers_recorded', 'all_offers_retired', 'no_eligible_offer', 'price_not_convertible', 'evaluation_failed')),
	CONSTRAINT "watchlist_snapshot_items_unit_item_price_currency_check" CHECK ("watchlist_snapshot_items"."unit_item_price_currency" in ('FAIR', 'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF', 'CNY', 'SEK', 'NOK', 'DKK', 'PLN', 'MXN', 'BRL', 'INR', 'NZD', 'ZAR', 'SGD', 'HKD', 'AED')),
	CONSTRAINT "watchlist_snapshot_items_native_currency_check" CHECK ("watchlist_snapshot_items"."native_currency" in ('FAIR', 'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF', 'CNY', 'SEK', 'NOK', 'DKK', 'PLN', 'MXN', 'BRL', 'INR', 'NZD', 'ZAR', 'SGD', 'HKD', 'AED')),
	CONSTRAINT "watchlist_snapshot_items_fx_from_check" CHECK ("watchlist_snapshot_items"."fx_from" in ('FAIR', 'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF', 'CNY', 'SEK', 'NOK', 'DKK', 'PLN', 'MXN', 'BRL', 'INR', 'NZD', 'ZAR', 'SGD', 'HKD', 'AED')),
	CONSTRAINT "watchlist_snapshot_items_fx_to_check" CHECK ("watchlist_snapshot_items"."fx_to" in ('FAIR', 'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF', 'CNY', 'SEK', 'NOK', 'DKK', 'PLN', 'MXN', 'BRL', 'INR', 'NZD', 'ZAR', 'SGD', 'HKD', 'AED')),
	CONSTRAINT "watchlist_snapshot_items_availability_check" CHECK ("watchlist_snapshot_items"."selected_availability" in ('in_stock', 'out_of_stock', 'preorder', 'unavailable', 'unknown')),
	CONSTRAINT "watchlist_snapshot_items_priced_shape_check" CHECK (("watchlist_snapshot_items"."state" = 'priced')
          = ("watchlist_snapshot_items"."selected_offer_id" is not null
             and "watchlist_snapshot_items"."selected_availability" is not null
             and "watchlist_snapshot_items"."ranking_policy_version" is not null
             and "watchlist_snapshot_items"."unit_item_price_amount" is not null
             and "watchlist_snapshot_items"."unit_item_price_currency" is not null
             and "watchlist_snapshot_items"."line_item_price_amount" is not null
             and "watchlist_snapshot_items"."native_currency" is not null)),
	CONSTRAINT "watchlist_snapshot_items_unresolved_shape_check" CHECK (("watchlist_snapshot_items"."state" = 'unresolved') = ("watchlist_snapshot_items"."unresolved_reason" is not null)),
	CONSTRAINT "watchlist_snapshot_items_unresolved_empty_check" CHECK ("watchlist_snapshot_items"."state" <> 'unresolved'
          or num_nonnulls("watchlist_snapshot_items"."selected_offer_id", "watchlist_snapshot_items"."selected_canonical_variant_id",
                          "watchlist_snapshot_items"."selected_availability", "watchlist_snapshot_items"."ranking_policy_version",
                          "watchlist_snapshot_items"."unit_item_price_amount", "watchlist_snapshot_items"."unit_item_price_currency",
                          "watchlist_snapshot_items"."line_item_price_amount", "watchlist_snapshot_items"."unit_delivery_amount",
                          "watchlist_snapshot_items"."line_delivery_amount", "watchlist_snapshot_items"."native_currency",
                          "watchlist_snapshot_items"."fx_rate", "watchlist_snapshot_items"."fx_from", "watchlist_snapshot_items"."fx_to", "watchlist_snapshot_items"."fx_provider",
                          "watchlist_snapshot_items"."fx_as_of") = 0),
	CONSTRAINT "watchlist_snapshot_items_delivery_shape_check" CHECK (num_nonnulls("watchlist_snapshot_items"."unit_delivery_amount", "watchlist_snapshot_items"."line_delivery_amount") in (0, 2)),
	CONSTRAINT "watchlist_snapshot_items_amount_range_check" CHECK (("watchlist_snapshot_items"."unit_item_price_amount" is null
           or ("watchlist_snapshot_items"."unit_item_price_amount" >= 0
               and "watchlist_snapshot_items"."unit_item_price_amount" <= 9007199254740991))
          and ("watchlist_snapshot_items"."line_item_price_amount" is null
               or ("watchlist_snapshot_items"."line_item_price_amount" >= 0
                   and "watchlist_snapshot_items"."line_item_price_amount" <= 9007199254740991))
          and ("watchlist_snapshot_items"."unit_delivery_amount" is null
               or ("watchlist_snapshot_items"."unit_delivery_amount" >= 0
                   and "watchlist_snapshot_items"."unit_delivery_amount" <= 9007199254740991))
          and ("watchlist_snapshot_items"."line_delivery_amount" is null
               or ("watchlist_snapshot_items"."line_delivery_amount" >= 0
                   and "watchlist_snapshot_items"."line_delivery_amount" <= 9007199254740991))),
	CONSTRAINT "watchlist_snapshot_items_fx_shape_check" CHECK (case
        when "watchlist_snapshot_items"."fx_rate" is null then
          "watchlist_snapshot_items"."fx_from" is null and "watchlist_snapshot_items"."fx_to" is null
          and "watchlist_snapshot_items"."fx_provider" is null and "watchlist_snapshot_items"."fx_as_of" is null
          and ("watchlist_snapshot_items"."native_currency" is null
               or "watchlist_snapshot_items"."native_currency" = "watchlist_snapshot_items"."unit_item_price_currency")
        else
          "watchlist_snapshot_items"."fx_from" is not null and "watchlist_snapshot_items"."fx_to" is not null
          and "watchlist_snapshot_items"."fx_provider" is not null and "watchlist_snapshot_items"."fx_as_of" is not null
          and "watchlist_snapshot_items"."fx_rate" > 0
          and "watchlist_snapshot_items"."fx_from" = "watchlist_snapshot_items"."native_currency"
          and "watchlist_snapshot_items"."fx_to" = "watchlist_snapshot_items"."unit_item_price_currency"
          and "watchlist_snapshot_items"."fx_from" <> "watchlist_snapshot_items"."fx_to"
      end)
);
--> statement-breakpoint
CREATE TABLE "watchlist_snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"watchlist_id" text NOT NULL,
	"list_version" integer NOT NULL,
	"ranking_policy_versions" text[] NOT NULL,
	"display_currency" text NOT NULL,
	"market" text,
	"completeness" text NOT NULL,
	"basis" text,
	"total_amount" bigint,
	"item_count" integer NOT NULL,
	"priced_item_count" integer NOT NULL,
	"unresolved_item_count" integer NOT NULL,
	"material_changes" text[] NOT NULL,
	"previous_snapshot_id" text,
	"content_digest" text NOT NULL,
	"evaluated_at" timestamp with time zone NOT NULL,
	"retention_expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "watchlist_snapshots_list_version_check" CHECK ("watchlist_snapshots"."list_version" >= 1),
	CONSTRAINT "watchlist_snapshots_display_currency_check" CHECK ("watchlist_snapshots"."display_currency" in ('FAIR', 'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF', 'CNY', 'SEK', 'NOK', 'DKK', 'PLN', 'MXN', 'BRL', 'INR', 'NZD', 'ZAR', 'SGD', 'HKD', 'AED')),
	CONSTRAINT "watchlist_snapshots_market_check" CHECK ("watchlist_snapshots"."market" is null or "watchlist_snapshots"."market" ~ '^[A-Z]{2}$'),
	CONSTRAINT "watchlist_snapshots_completeness_check" CHECK ("watchlist_snapshots"."completeness" in ('complete', 'partial', 'unknown')),
	CONSTRAINT "watchlist_snapshots_basis_check" CHECK ("watchlist_snapshots"."basis" in ('delivered_total', 'item_price')),
	CONSTRAINT "watchlist_snapshots_total_shape_check" CHECK (("watchlist_snapshots"."completeness" <> 'unknown')
          = ("watchlist_snapshots"."total_amount" is not null and "watchlist_snapshots"."basis" is not null)),
	CONSTRAINT "watchlist_snapshots_total_range_check" CHECK ("watchlist_snapshots"."total_amount" is null
          or ("watchlist_snapshots"."total_amount" >= 0
              and "watchlist_snapshots"."total_amount" <= 9007199254740991)),
	CONSTRAINT "watchlist_snapshots_item_counts_check" CHECK ("watchlist_snapshots"."item_count" = "watchlist_snapshots"."priced_item_count" + "watchlist_snapshots"."unresolved_item_count"
          and "watchlist_snapshots"."priced_item_count" >= 0
          and "watchlist_snapshots"."unresolved_item_count" >= 0),
	CONSTRAINT "watchlist_snapshots_material_changes_check" CHECK (cardinality("watchlist_snapshots"."material_changes") >= 1),
	CONSTRAINT "watchlist_snapshots_material_changes_values_check" CHECK ("watchlist_snapshots"."material_changes" <@ array['first_snapshot', 'membership_changed', 'total_decreased', 'total_increased', 'basis_changed', 'completeness_changed', 'availability_changed', 'selection_changed', 'item_price_moved', 'currency_changed', 'policy_version_changed']::text[]),
	CONSTRAINT "watchlist_snapshots_content_digest_check" CHECK (btrim("watchlist_snapshots"."content_digest") <> '')
);
--> statement-breakpoint
CREATE TABLE "watchlists" (
	"id" text PRIMARY KEY NOT NULL,
	"oxy_user_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"icon" text,
	"visibility" text DEFAULT 'private' NOT NULL,
	"display_currency" text NOT NULL,
	"market" text,
	"template_key" text,
	"version" integer DEFAULT 1 NOT NULL,
	"last_evaluated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "watchlists_oxy_user_id_check" CHECK (btrim("watchlists"."oxy_user_id") <> ''),
	CONSTRAINT "watchlists_name_check" CHECK (btrim("watchlists"."name") <> '' and length("watchlists"."name") <= 120),
	CONSTRAINT "watchlists_description_check" CHECK ("watchlists"."description" is null
          or (btrim("watchlists"."description") <> ''
              and length("watchlists"."description") <= 2000)),
	CONSTRAINT "watchlists_icon_check" CHECK ("watchlists"."icon" is null
          or (btrim("watchlists"."icon") <> ''
              and length("watchlists"."icon") <= 16)),
	CONSTRAINT "watchlists_visibility_check" CHECK ("watchlists"."visibility" in ('private')),
	CONSTRAINT "watchlists_template_key_check" CHECK ("watchlists"."template_key" in ('pc_build', 'home_office', 'nursery', 'kitchen_restock', 'travel_kit')),
	CONSTRAINT "watchlists_display_currency_check" CHECK ("watchlists"."display_currency" in ('FAIR', 'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF', 'CNY', 'SEK', 'NOK', 'DKK', 'PLN', 'MXN', 'BRL', 'INR', 'NZD', 'ZAR', 'SGD', 'HKD', 'AED')),
	CONSTRAINT "watchlists_market_check" CHECK ("watchlists"."market" is null or "watchlists"."market" ~ '^[A-Z]{2}$'),
	CONSTRAINT "watchlists_version_check" CHECK ("watchlists"."version" >= 1)
);
--> statement-breakpoint
ALTER TABLE "watchlist_items" ADD CONSTRAINT "watchlist_items_watchlist_id_watchlists_id_fk" FOREIGN KEY ("watchlist_id") REFERENCES "public"."watchlists"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watchlist_items" ADD CONSTRAINT "watchlist_items_canonical_product_id_canonical_products_id_fk" FOREIGN KEY ("canonical_product_id") REFERENCES "public"."canonical_products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watchlist_items" ADD CONSTRAINT "watchlist_items_preferred_canonical_variant_id_canonical_variants_id_fk" FOREIGN KEY ("preferred_canonical_variant_id") REFERENCES "public"."canonical_variants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watchlist_items" ADD CONSTRAINT "watchlist_items_preferred_merchant_id_merchants_id_fk" FOREIGN KEY ("preferred_merchant_id") REFERENCES "public"."merchants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watchlist_items" ADD CONSTRAINT "watchlist_items_ambiguous_split_job_id_catalog_split_jobs_id_fk" FOREIGN KEY ("ambiguous_split_job_id") REFERENCES "public"."catalog_split_jobs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watchlist_snapshot_items" ADD CONSTRAINT "watchlist_snapshot_items_snapshot_id_watchlist_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."watchlist_snapshots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watchlist_snapshot_items" ADD CONSTRAINT "watchlist_snapshot_items_watchlist_item_id_watchlist_items_id_fk" FOREIGN KEY ("watchlist_item_id") REFERENCES "public"."watchlist_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watchlist_snapshot_items" ADD CONSTRAINT "watchlist_snapshot_items_canonical_product_id_canonical_products_id_fk" FOREIGN KEY ("canonical_product_id") REFERENCES "public"."canonical_products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watchlist_snapshot_items" ADD CONSTRAINT "watchlist_snapshot_items_preferred_canonical_variant_id_canonical_variants_id_fk" FOREIGN KEY ("preferred_canonical_variant_id") REFERENCES "public"."canonical_variants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watchlist_snapshots" ADD CONSTRAINT "watchlist_snapshots_watchlist_id_watchlists_id_fk" FOREIGN KEY ("watchlist_id") REFERENCES "public"."watchlists"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watchlist_snapshots" ADD CONSTRAINT "watchlist_snapshots_previous_snapshot_id_watchlist_snapshots_id_fk" FOREIGN KEY ("previous_snapshot_id") REFERENCES "public"."watchlist_snapshots"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "watchlist_items_watchlist_id_canonical_product_id_key" ON "watchlist_items" USING btree ("watchlist_id","canonical_product_id");--> statement-breakpoint
CREATE INDEX "watchlist_items_watchlist_id_position_idx" ON "watchlist_items" USING btree ("watchlist_id","position","added_at","id");--> statement-breakpoint
CREATE INDEX "watchlist_items_canonical_product_id_idx" ON "watchlist_items" USING btree ("canonical_product_id");--> statement-breakpoint
CREATE INDEX "watchlist_items_preferred_canonical_variant_id_idx" ON "watchlist_items" USING btree ("preferred_canonical_variant_id") WHERE "watchlist_items"."preferred_canonical_variant_id" is not null;--> statement-breakpoint
CREATE INDEX "watchlist_items_preferred_merchant_id_idx" ON "watchlist_items" USING btree ("preferred_merchant_id") WHERE "watchlist_items"."preferred_merchant_id" is not null;--> statement-breakpoint
CREATE INDEX "watchlist_items_ambiguous_idx" ON "watchlist_items" USING btree ("watchlist_id","added_at") WHERE "watchlist_items"."resolution_state" = 'ambiguous_after_split';--> statement-breakpoint
CREATE UNIQUE INDEX "watchlist_snapshot_items_snapshot_id_position_key" ON "watchlist_snapshot_items" USING btree ("snapshot_id","position");--> statement-breakpoint
CREATE INDEX "watchlist_snapshot_items_watchlist_item_id_idx" ON "watchlist_snapshot_items" USING btree ("watchlist_item_id") WHERE "watchlist_snapshot_items"."watchlist_item_id" is not null;--> statement-breakpoint
CREATE INDEX "watchlist_snapshot_items_canonical_product_id_idx" ON "watchlist_snapshot_items" USING btree ("canonical_product_id");--> statement-breakpoint
CREATE INDEX "watchlist_snapshots_watchlist_id_evaluated_at_id_idx" ON "watchlist_snapshots" USING btree ("watchlist_id","evaluated_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "watchlist_snapshots_retention_expires_at_idx" ON "watchlist_snapshots" USING btree ("retention_expires_at");--> statement-breakpoint
CREATE INDEX "watchlists_oxy_user_id_created_at_id_idx" ON "watchlists" USING btree ("oxy_user_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);
--> statement-breakpoint
-- ── HAND-WRITTEN: the snapshot append-only triggers ───────────────────────────
--
-- A recorded evaluation is what a buyer was SHOWN. Rewriting one is how a price
-- history stops being evidence, so UPDATE is refused outright at the row —
-- visible in `\d watchlist_snapshots` rather than only in a repository nobody
-- reads before writing a one-off fix.
--
-- DELETE is deliberately PERMITTED, which inverts the ledger's posture and
-- matches `analytics_events` and `offer_price_snapshots`: erasure on a schedule
-- IS the retention policy here (`retention_expires_at`, swept by
-- `expiryTargets`), and a trigger refusing DELETE would make that sweep fail
-- SILENTLY on every row it was contractually meant to remove. The snapshot's
-- lines CASCADE with it, so a line can never outlive the evaluation it
-- describes.
--
-- `BEFORE`, not `AFTER`: the exception must be raised before the row version is
-- written, so nothing is left half-done inside the transaction that tried.
-- SQLSTATE 23514 (`check_violation`) rather than a bare `RAISE`, so a caller can
-- classify it as the constraint failure it is instead of parsing English.
CREATE FUNCTION mercaria_watchlist_snapshot_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'watchlist snapshot rows are immutable: % on %.% is refused. A new measurement is a '
    'NEW snapshot, never an edit of one somebody was already shown.',
    TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME
    USING ERRCODE = 'check_violation';
END;
$$;--> statement-breakpoint
CREATE TRIGGER watchlist_snapshots_immutable
  BEFORE UPDATE ON "watchlist_snapshots"
  FOR EACH ROW EXECUTE FUNCTION mercaria_watchlist_snapshot_immutable();--> statement-breakpoint
-- The LINE trigger has one precise exception, and it is the referential action
-- the schema already declares: `watchlist_item_id` moving to NULL when the
-- buyer removes the entry (`ON DELETE SET NULL`). Refusing that would make
-- removing an item impossible while its history exists — which is every item
-- that was ever measured. Every OTHER update is refused, so an operator cannot
-- quietly correct an amount, an offer id or a quote.
CREATE FUNCTION mercaria_watchlist_snapshot_line_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.watchlist_item_id IS NULL
     AND OLD.watchlist_item_id IS NOT NULL
     AND NEW.snapshot_id IS NOT DISTINCT FROM OLD.snapshot_id
     AND NEW.canonical_product_id IS NOT DISTINCT FROM OLD.canonical_product_id
     AND NEW.quantity IS NOT DISTINCT FROM OLD.quantity
     AND NEW.position IS NOT DISTINCT FROM OLD.position
     AND NEW.state IS NOT DISTINCT FROM OLD.state
     AND NEW.selected_offer_id IS NOT DISTINCT FROM OLD.selected_offer_id
     AND NEW.unit_item_price_amount IS NOT DISTINCT FROM OLD.unit_item_price_amount
     AND NEW.line_item_price_amount IS NOT DISTINCT FROM OLD.line_item_price_amount
     AND NEW.fx_rate IS NOT DISTINCT FROM OLD.fx_rate THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION
    'watchlist snapshot lines are immutable: % on %.% is refused. The only permitted change '
    'is `watchlist_item_id` becoming NULL when the entry it named is removed.',
    TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME
    USING ERRCODE = 'check_violation';
END;
$$;--> statement-breakpoint
CREATE TRIGGER watchlist_snapshot_items_immutable
  BEFORE UPDATE ON "watchlist_snapshot_items"
  FOR EACH ROW EXECUTE FUNCTION mercaria_watchlist_snapshot_line_immutable();
