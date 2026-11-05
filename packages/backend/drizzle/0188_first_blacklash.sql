-- oxy:deploy-phase=pre
-- oxy:rollback=derived
-- Automation rules (#89, `automation_rules`): three new tables, additive only.
CREATE TABLE "automation_rule_listing_states" (
	"id" text PRIMARY KEY NOT NULL,
	"rule_id" text NOT NULL,
	"listing_id" text NOT NULL,
	"paused_by_rule" boolean DEFAULT false NOT NULL,
	"opened_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "automation_rule_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"rule_id" text NOT NULL,
	"store_id" text NOT NULL,
	"subject_kind" text NOT NULL,
	"subject_id" text NOT NULL,
	"occurrence" text NOT NULL,
	"step" text NOT NULL,
	"outcome" text NOT NULL,
	"detail" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "automation_rule_runs_subject_kind_check" CHECK ("automation_rule_runs"."subject_kind" in ('listing', 'order')),
	CONSTRAINT "automation_rule_runs_step_check" CHECK ("automation_rule_runs"."step" in ('notify_owner', 'pause_listing', 'republish_listing', 'mark_order_processing')),
	CONSTRAINT "automation_rule_runs_outcome_check" CHECK ("automation_rule_runs"."outcome" in ('succeeded', 'skipped', 'failed')),
	CONSTRAINT "automation_rule_runs_detail_check" CHECK ("automation_rule_runs"."detail" is null or char_length("automation_rule_runs"."detail") <= 500)
);
--> statement-breakpoint
CREATE TABLE "automation_rules" (
	"id" text PRIMARY KEY NOT NULL,
	"store_id" text NOT NULL,
	"name" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"trigger" text NOT NULL,
	"action" text NOT NULL,
	"stock_threshold" integer,
	"tag" text,
	"min_order_total_amount" bigint,
	"min_order_total_currency" text,
	"republish_when_restocked" boolean DEFAULT false NOT NULL,
	"armed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_oxy_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "automation_rules_trigger_check" CHECK ("automation_rules"."trigger" in ('listing_stock_at_or_below', 'order_paid')),
	CONSTRAINT "automation_rules_action_check" CHECK ("automation_rules"."action" in ('notify_owner', 'pause_listing', 'mark_order_processing')),
	CONSTRAINT "automation_rules_pairing_check" CHECK (("automation_rules"."trigger" = 'listing_stock_at_or_below' and "automation_rules"."action" in ('notify_owner', 'pause_listing')) or ("automation_rules"."trigger" = 'order_paid' and "automation_rules"."action" in ('notify_owner', 'mark_order_processing'))),
	CONSTRAINT "automation_rules_min_order_total_currency_check" CHECK ("automation_rules"."min_order_total_currency" in ('FAIR', 'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF', 'CNY', 'SEK', 'NOK', 'DKK', 'PLN', 'MXN', 'BRL', 'INR', 'NZD', 'ZAR', 'SGD', 'HKD', 'AED')),
	CONSTRAINT "automation_rules_name_check" CHECK (char_length(btrim("automation_rules"."name")) between 1 and 120),
	CONSTRAINT "automation_rules_tag_check" CHECK ("automation_rules"."tag" is null or char_length(btrim("automation_rules"."tag")) between 1 and 64),
	CONSTRAINT "automation_rules_stock_threshold_present_check" CHECK ("automation_rules"."trigger" <> 'listing_stock_at_or_below' or "automation_rules"."stock_threshold" is not null),
	CONSTRAINT "automation_rules_stock_threshold_absent_check" CHECK ("automation_rules"."trigger" = 'listing_stock_at_or_below' or "automation_rules"."stock_threshold" is null),
	CONSTRAINT "automation_rules_stock_threshold_range_check" CHECK ("automation_rules"."stock_threshold" is null or "automation_rules"."stock_threshold" between 0 and 1000000),
	CONSTRAINT "automation_rules_min_order_total_shape_check" CHECK (("automation_rules"."min_order_total_amount" is null) = ("automation_rules"."min_order_total_currency" is null)),
	CONSTRAINT "automation_rules_min_order_total_trigger_check" CHECK ("automation_rules"."trigger" = 'order_paid' or "automation_rules"."min_order_total_amount" is null),
	CONSTRAINT "automation_rules_min_order_total_amount_check" CHECK ("automation_rules"."min_order_total_amount" is null or "automation_rules"."min_order_total_amount" >= 0),
	CONSTRAINT "automation_rules_republish_check" CHECK ("automation_rules"."action" = 'pause_listing' or not "automation_rules"."republish_when_restocked")
);
--> statement-breakpoint
ALTER TABLE "automation_rule_listing_states" ADD CONSTRAINT "automation_rule_listing_states_rule_id_automation_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."automation_rules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_rule_listing_states" ADD CONSTRAINT "automation_rule_listing_states_listing_id_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."listings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_rule_runs" ADD CONSTRAINT "automation_rule_runs_rule_id_automation_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."automation_rules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_rule_runs" ADD CONSTRAINT "automation_rule_runs_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_rules" ADD CONSTRAINT "automation_rules_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "automation_rule_listing_states_rule_listing_key" ON "automation_rule_listing_states" USING btree ("rule_id","listing_id");--> statement-breakpoint
CREATE INDEX "automation_rule_listing_states_listing_id_idx" ON "automation_rule_listing_states" USING btree ("listing_id");--> statement-breakpoint
CREATE UNIQUE INDEX "automation_rule_runs_occurrence_key" ON "automation_rule_runs" USING btree ("rule_id","subject_id","occurrence");--> statement-breakpoint
CREATE INDEX "automation_rule_runs_store_id_created_at_idx" ON "automation_rule_runs" USING btree ("store_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "automation_rule_runs_created_at_idx" ON "automation_rule_runs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "automation_rules_store_id_created_at_idx" ON "automation_rules" USING btree ("store_id","created_at");