-- oxy:deploy-phase=pre
-- oxy:rollback=derived
CREATE TABLE "replenishment_settings" (
	"id" text PRIMARY KEY NOT NULL,
	"store_id" text NOT NULL,
	"lead_time_days" integer NOT NULL,
	"target_cover_days" integer NOT NULL,
	"safety_stock_days" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "replenishment_settings_lead_time_days_check" CHECK ("replenishment_settings"."lead_time_days" between 0 and 365),
	CONSTRAINT "replenishment_settings_target_cover_days_check" CHECK ("replenishment_settings"."target_cover_days" between 0 and 365),
	CONSTRAINT "replenishment_settings_safety_stock_days_check" CHECK ("replenishment_settings"."safety_stock_days" between 0 and 180)
);
--> statement-breakpoint
CREATE TABLE "replenishment_variant_overrides" (
	"id" text PRIMARY KEY NOT NULL,
	"store_id" text NOT NULL,
	"variant_id" text NOT NULL,
	"lead_time_days" integer,
	"target_cover_days" integer,
	"safety_stock_days" integer,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "replenishment_variant_overrides_not_empty_check" CHECK (num_nonnulls("replenishment_variant_overrides"."lead_time_days", "replenishment_variant_overrides"."target_cover_days", "replenishment_variant_overrides"."safety_stock_days") > 0),
	CONSTRAINT "replenishment_variant_overrides_lead_time_days_check" CHECK ("replenishment_variant_overrides"."lead_time_days" is null or ("replenishment_variant_overrides"."lead_time_days" between 0 and 365)),
	CONSTRAINT "replenishment_variant_overrides_target_cover_days_check" CHECK ("replenishment_variant_overrides"."target_cover_days" is null or ("replenishment_variant_overrides"."target_cover_days" between 0 and 365)),
	CONSTRAINT "replenishment_variant_overrides_safety_stock_days_check" CHECK ("replenishment_variant_overrides"."safety_stock_days" is null or ("replenishment_variant_overrides"."safety_stock_days" between 0 and 180))
);
--> statement-breakpoint
ALTER TABLE "replenishment_settings" ADD CONSTRAINT "replenishment_settings_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "replenishment_variant_overrides" ADD CONSTRAINT "replenishment_variant_overrides_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "replenishment_variant_overrides" ADD CONSTRAINT "replenishment_variant_overrides_variant_id_product_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."product_variants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "replenishment_settings_store_id_key" ON "replenishment_settings" USING btree ("store_id");--> statement-breakpoint
CREATE UNIQUE INDEX "replenishment_variant_overrides_variant_id_key" ON "replenishment_variant_overrides" USING btree ("variant_id");--> statement-breakpoint
CREATE INDEX "replenishment_variant_overrides_store_id_idx" ON "replenishment_variant_overrides" USING btree ("store_id");