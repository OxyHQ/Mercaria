-- oxy:deploy-phase=pre
-- oxy:rollback=derived
CREATE TABLE "fee_schedule_acceptances" (
	"id" text PRIMARY KEY NOT NULL,
	"schedule_key" text NOT NULL,
	"schedule_version" integer NOT NULL,
	"terms_version" text NOT NULL,
	"owner_type" text NOT NULL,
	"owner_id" text NOT NULL,
	"accepted_by_oxy_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "fee_schedule_acceptances_owner_type_check" CHECK ("fee_schedule_acceptances"."owner_type" in ('store', 'user')),
	CONSTRAINT "fee_schedule_acceptances_version_check" CHECK ("fee_schedule_acceptances"."schedule_version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "fee_schedules" (
	"id" text PRIMARY KEY NOT NULL,
	"schedule_key" text NOT NULL,
	"version" integer NOT NULL,
	"name" text NOT NULL,
	"merchant_summary" text NOT NULL,
	"effective_start" timestamp with time zone NOT NULL,
	"effective_end" timestamp with time zone,
	"eligible_seller_type" text,
	"eligible_currency" text,
	"percentage_bps" integer NOT NULL,
	"fixed_fee_amount" bigint,
	"fixed_fee_currency" text,
	"min_fee_minor" bigint,
	"max_fee_minor" bigint,
	"tax_treatment" text DEFAULT 'unknown' NOT NULL,
	"refund_policy" text DEFAULT 'proportional' NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"terms_version" text NOT NULL,
	"created_by_oxy_user_id" text NOT NULL,
	"approved_by_oxy_user_id" text,
	"activated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "fee_schedules_status_check" CHECK ("fee_schedules"."status" in ('draft', 'active', 'superseded', 'retired')),
	CONSTRAINT "fee_schedules_tax_treatment_check" CHECK ("fee_schedules"."tax_treatment" in ('unknown', 'exclusive', 'inclusive')),
	CONSTRAINT "fee_schedules_refund_policy_check" CHECK ("fee_schedules"."refund_policy" in ('proportional')),
	CONSTRAINT "fee_schedules_eligible_seller_type_check" CHECK ("fee_schedules"."eligible_seller_type" in ('user', 'store')),
	CONSTRAINT "fee_schedules_eligible_currency_check" CHECK ("fee_schedules"."eligible_currency" in ('FAIR', 'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF', 'CNY', 'SEK', 'NOK', 'DKK', 'PLN', 'MXN', 'BRL', 'INR', 'NZD', 'ZAR', 'SGD', 'HKD', 'AED')),
	CONSTRAINT "fee_schedules_fixed_fee_currency_check" CHECK ("fee_schedules"."fixed_fee_currency" in ('FAIR', 'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF', 'CNY', 'SEK', 'NOK', 'DKK', 'PLN', 'MXN', 'BRL', 'INR', 'NZD', 'ZAR', 'SGD', 'HKD', 'AED')),
	CONSTRAINT "fee_schedules_version_check" CHECK ("fee_schedules"."version" >= 1),
	CONSTRAINT "fee_schedules_percentage_bps_check" CHECK ("fee_schedules"."percentage_bps" between 0 and 10000),
	CONSTRAINT "fee_schedules_fixed_fee_amount_check" CHECK ("fee_schedules"."fixed_fee_amount" is null or "fee_schedules"."fixed_fee_amount" >= 0),
	CONSTRAINT "fee_schedules_min_fee_check" CHECK ("fee_schedules"."min_fee_minor" is null or "fee_schedules"."min_fee_minor" >= 0),
	CONSTRAINT "fee_schedules_max_fee_check" CHECK ("fee_schedules"."max_fee_minor" is null or "fee_schedules"."max_fee_minor" >= 0),
	CONSTRAINT "fee_schedules_min_max_order_check" CHECK ("fee_schedules"."min_fee_minor" is null or "fee_schedules"."max_fee_minor" is null or "fee_schedules"."min_fee_minor" <= "fee_schedules"."max_fee_minor"),
	CONSTRAINT "fee_schedules_fixed_fee_complete_check" CHECK (num_nonnulls("fee_schedules"."fixed_fee_amount", "fee_schedules"."fixed_fee_currency") in (0, 2)),
	CONSTRAINT "fee_schedules_fixed_fee_scope_check" CHECK ("fee_schedules"."fixed_fee_amount" is null
          or ("fee_schedules"."eligible_currency" is not null and "fee_schedules"."fixed_fee_currency" = "fee_schedules"."eligible_currency")),
	CONSTRAINT "fee_schedules_clamp_scope_check" CHECK (("fee_schedules"."min_fee_minor" is null and "fee_schedules"."max_fee_minor" is null)
          or "fee_schedules"."eligible_currency" is not null),
	CONSTRAINT "fee_schedules_effective_window_check" CHECK ("fee_schedules"."effective_end" is null or "fee_schedules"."effective_end" > "fee_schedules"."effective_start"),
	CONSTRAINT "fee_schedules_activation_audit_check" CHECK ("fee_schedules"."status" not in ('active', 'superseded')
          or ("fee_schedules"."approved_by_oxy_user_id" is not null and "fee_schedules"."activated_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "order_fee_snapshot_lines" (
	"id" text PRIMARY KEY NOT NULL,
	"snapshot_id" text NOT NULL,
	"order_item_id" text NOT NULL,
	"amount_minor" bigint NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "order_fee_snapshot_lines_amount_check" CHECK ("order_fee_snapshot_lines"."amount_minor" >= 0)
);
--> statement-breakpoint
CREATE TABLE "order_fee_snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"order_id" text NOT NULL,
	"commercial_mode" text NOT NULL,
	"result" text NOT NULL,
	"schedule_key" text,
	"schedule_version" integer,
	"basis" text,
	"basis_amount_amount" bigint,
	"basis_amount_currency" text,
	"percentage_bps" integer,
	"fixed_fee_minor" bigint,
	"clamp_applied" text,
	"fee_amount" bigint,
	"fee_currency" text,
	"rounding_adjustment_minor" bigint,
	"terms_version_accepted" text,
	"scope_seller_type" text,
	"scope_currency" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "order_fee_snapshots_commercial_mode_check" CHECK ("order_fee_snapshots"."commercial_mode" in ('connected_marketplace', 'external_referral', 'mercaria_retail', 'informational')),
	CONSTRAINT "order_fee_snapshots_result_check" CHECK ("order_fee_snapshots"."result" in ('calculated', 'no_active_schedule', 'not_applicable')),
	CONSTRAINT "order_fee_snapshots_basis_check" CHECK ("order_fee_snapshots"."basis" in ('discounted_item_subtotal')),
	CONSTRAINT "order_fee_snapshots_clamp_applied_check" CHECK ("order_fee_snapshots"."clamp_applied" in ('min', 'max')),
	CONSTRAINT "order_fee_snapshots_scope_seller_type_check" CHECK ("order_fee_snapshots"."scope_seller_type" in ('user', 'store')),
	CONSTRAINT "order_fee_snapshots_basis_amount_currency_check" CHECK ("order_fee_snapshots"."basis_amount_currency" in ('FAIR', 'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF', 'CNY', 'SEK', 'NOK', 'DKK', 'PLN', 'MXN', 'BRL', 'INR', 'NZD', 'ZAR', 'SGD', 'HKD', 'AED')),
	CONSTRAINT "order_fee_snapshots_fee_currency_check" CHECK ("order_fee_snapshots"."fee_currency" in ('FAIR', 'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF', 'CNY', 'SEK', 'NOK', 'DKK', 'PLN', 'MXN', 'BRL', 'INR', 'NZD', 'ZAR', 'SGD', 'HKD', 'AED')),
	CONSTRAINT "order_fee_snapshots_scope_currency_check" CHECK ("order_fee_snapshots"."scope_currency" in ('FAIR', 'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF', 'CNY', 'SEK', 'NOK', 'DKK', 'PLN', 'MXN', 'BRL', 'INR', 'NZD', 'ZAR', 'SGD', 'HKD', 'AED')),
	CONSTRAINT "order_fee_snapshots_mode_result_check" CHECK (("order_fee_snapshots"."commercial_mode" = 'connected_marketplace') = ("order_fee_snapshots"."result" <> 'not_applicable')),
	CONSTRAINT "order_fee_snapshots_schedule_named_check" CHECK (("order_fee_snapshots"."result" = 'calculated')
          = ("order_fee_snapshots"."schedule_key" is not null and "order_fee_snapshots"."schedule_version" is not null)),
	CONSTRAINT "order_fee_snapshots_fee_presence_check" CHECK (num_nonnulls("order_fee_snapshots"."fee_amount", "order_fee_snapshots"."basis_amount_amount", "order_fee_snapshots"."basis", "order_fee_snapshots"."scope_seller_type", "order_fee_snapshots"."scope_currency", "order_fee_snapshots"."rounding_adjustment_minor") in (0, 6)
          and ("order_fee_snapshots"."result" = 'not_applicable')
            = (num_nonnulls("order_fee_snapshots"."fee_amount", "order_fee_snapshots"."basis_amount_amount", "order_fee_snapshots"."basis", "order_fee_snapshots"."scope_seller_type", "order_fee_snapshots"."scope_currency", "order_fee_snapshots"."rounding_adjustment_minor") = 0)),
	CONSTRAINT "order_fee_snapshots_basis_amount_complete_check" CHECK (num_nonnulls("order_fee_snapshots"."basis_amount_amount", "order_fee_snapshots"."basis_amount_currency") in (0, 2)),
	CONSTRAINT "order_fee_snapshots_fee_complete_check" CHECK (num_nonnulls("order_fee_snapshots"."fee_amount", "order_fee_snapshots"."fee_currency") in (0, 2)),
	CONSTRAINT "order_fee_snapshots_components_check" CHECK ("order_fee_snapshots"."result" = 'calculated'
          or ("order_fee_snapshots"."percentage_bps" is null and "order_fee_snapshots"."fixed_fee_minor" is null and "order_fee_snapshots"."clamp_applied" is null)),
	CONSTRAINT "order_fee_snapshots_fee_amount_check" CHECK ("order_fee_snapshots"."fee_amount" is null or "order_fee_snapshots"."fee_amount" >= 0),
	CONSTRAINT "order_fee_snapshots_fee_within_basis_check" CHECK ("order_fee_snapshots"."fee_amount" is null or "order_fee_snapshots"."fee_amount" <= "order_fee_snapshots"."basis_amount_amount"),
	CONSTRAINT "order_fee_snapshots_rounding_adjustment_check" CHECK ("order_fee_snapshots"."rounding_adjustment_minor" is null or "order_fee_snapshots"."rounding_adjustment_minor" in (0, 1))
);
--> statement-breakpoint
ALTER TABLE "order_fee_snapshot_lines" ADD CONSTRAINT "order_fee_snapshot_lines_snapshot_id_order_fee_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."order_fee_snapshots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_fee_snapshot_lines" ADD CONSTRAINT "order_fee_snapshot_lines_order_item_id_order_items_id_fk" FOREIGN KEY ("order_item_id") REFERENCES "public"."order_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_fee_snapshots" ADD CONSTRAINT "order_fee_snapshots_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "fee_schedule_acceptances_owner_version_key" ON "fee_schedule_acceptances" USING btree ("owner_type","owner_id","schedule_key","schedule_version");--> statement-breakpoint
CREATE UNIQUE INDEX "fee_schedules_key_version_key" ON "fee_schedules" USING btree ("schedule_key","version");--> statement-breakpoint
CREATE UNIQUE INDEX "fee_schedules_one_active_per_key" ON "fee_schedules" USING btree ("schedule_key") WHERE "fee_schedules"."status" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "order_fee_snapshot_lines_snapshot_item_key" ON "order_fee_snapshot_lines" USING btree ("snapshot_id","order_item_id");--> statement-breakpoint
CREATE INDEX "order_fee_snapshot_lines_snapshot_id_position_idx" ON "order_fee_snapshot_lines" USING btree ("snapshot_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "order_fee_snapshots_order_id_key" ON "order_fee_snapshots" USING btree ("order_id");
--> statement-breakpoint
-- drizzle-kit does not model triggers. Ship the immutability contract with the
-- tables so no interval exists in which snapshots or published policies mutate.
CREATE FUNCTION mercaria_fee_schedule_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN
      RAISE EXCEPTION
        'fee schedule %.% is %, not draft: published schedule versions are never deleted. Retire it, or publish a new version.',
        OLD.schedule_key, OLD.version, OLD.status
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.status <> 'draft' AND (
    NEW.schedule_key IS DISTINCT FROM OLD.schedule_key OR
    NEW.version IS DISTINCT FROM OLD.version OR
    NEW.name IS DISTINCT FROM OLD.name OR
    NEW.merchant_summary IS DISTINCT FROM OLD.merchant_summary OR
    NEW.effective_start IS DISTINCT FROM OLD.effective_start OR
    NEW.effective_end IS DISTINCT FROM OLD.effective_end OR
    NEW.eligible_seller_type IS DISTINCT FROM OLD.eligible_seller_type OR
    NEW.eligible_currency IS DISTINCT FROM OLD.eligible_currency OR
    NEW.percentage_bps IS DISTINCT FROM OLD.percentage_bps OR
    NEW.fixed_fee_amount IS DISTINCT FROM OLD.fixed_fee_amount OR
    NEW.fixed_fee_currency IS DISTINCT FROM OLD.fixed_fee_currency OR
    NEW.min_fee_minor IS DISTINCT FROM OLD.min_fee_minor OR
    NEW.max_fee_minor IS DISTINCT FROM OLD.max_fee_minor OR
    NEW.tax_treatment IS DISTINCT FROM OLD.tax_treatment OR
    NEW.refund_policy IS DISTINCT FROM OLD.refund_policy OR
    NEW.terms_version IS DISTINCT FROM OLD.terms_version OR
    NEW.created_by_oxy_user_id IS DISTINCT FROM OLD.created_by_oxy_user_id OR
    NEW.created_at IS DISTINCT FROM OLD.created_at
  ) THEN
    RAISE EXCEPTION
      'fee schedule %.% is %, not draft: its policy is immutable. Publish a new version instead of editing this one.',
      OLD.schedule_key, OLD.version, OLD.status
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER fee_schedules_immutable_once_active
  BEFORE UPDATE OR DELETE ON "fee_schedules"
  FOR EACH ROW EXECUTE FUNCTION mercaria_fee_schedule_immutable();--> statement-breakpoint
CREATE FUNCTION mercaria_fee_record_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'fee records are append-only: % on %.% is refused. An order''s fee snapshot and a merchant''s acceptance are immutable once written.',
    TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME
    USING ERRCODE = 'check_violation';
END;
$$;--> statement-breakpoint
CREATE TRIGGER order_fee_snapshots_append_only
  BEFORE UPDATE OR DELETE ON "order_fee_snapshots"
  FOR EACH ROW EXECUTE FUNCTION mercaria_fee_record_append_only();--> statement-breakpoint
CREATE TRIGGER order_fee_snapshot_lines_append_only
  BEFORE UPDATE OR DELETE ON "order_fee_snapshot_lines"
  FOR EACH ROW EXECUTE FUNCTION mercaria_fee_record_append_only();--> statement-breakpoint
CREATE TRIGGER fee_schedule_acceptances_append_only
  BEFORE UPDATE OR DELETE ON "fee_schedule_acceptances"
  FOR EACH ROW EXECUTE FUNCTION mercaria_fee_record_append_only();