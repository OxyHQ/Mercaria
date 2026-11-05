-- oxy:deploy-phase=pre
-- oxy:rollback=derived
CREATE TABLE "merchandising_rule_pins" (
	"rule_id" text NOT NULL,
	"listing_id" text NOT NULL,
	"position" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "merchandising_rule_pins_pkey" PRIMARY KEY("rule_id","listing_id"),
	CONSTRAINT "merchandising_rule_pins_rule_id_position_key" UNIQUE("rule_id","position"),
	CONSTRAINT "merchandising_rule_pins_position_check" CHECK ("merchandising_rule_pins"."position" >= 0 and "merchandising_rule_pins"."position" < 24)
);
--> statement-breakpoint
CREATE TABLE "merchandising_rules" (
	"id" text PRIMARY KEY NOT NULL,
	"store_id" text NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"target" text NOT NULL,
	"collection_id" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"starts_at" timestamp with time zone,
	"ends_at" timestamp with time zone,
	"sort_strategy" text,
	"best_selling_window_days" integer,
	"in_stock_first" boolean DEFAULT false NOT NULL,
	"spotlight_item_limit" integer,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "merchandising_rules_kind_check" CHECK ("merchandising_rules"."kind" in ('sort', 'spotlight')),
	CONSTRAINT "merchandising_rules_target_check" CHECK ("merchandising_rules"."target" in ('store', 'collection')),
	CONSTRAINT "merchandising_rules_sort_strategy_check" CHECK ("merchandising_rules"."sort_strategy" in ('best_selling', 'newest', 'price_asc', 'price_desc')),
	CONSTRAINT "merchandising_rules_title_check" CHECK (char_length(btrim("merchandising_rules"."title")) between 1 and 120),
	CONSTRAINT "merchandising_rules_store_target_check" CHECK ("merchandising_rules"."target" <> 'store' or "merchandising_rules"."collection_id" is null),
	CONSTRAINT "merchandising_rules_spotlight_target_check" CHECK ("merchandising_rules"."kind" <> 'spotlight' or "merchandising_rules"."target" = 'collection'),
	CONSTRAINT "merchandising_rules_sort_strategy_presence_check" CHECK (("merchandising_rules"."kind" = 'sort') = ("merchandising_rules"."sort_strategy" is not null)),
	CONSTRAINT "merchandising_rules_window_days_presence_check" CHECK (("merchandising_rules"."sort_strategy" is not distinct from 'best_selling') = ("merchandising_rules"."best_selling_window_days" is not null)),
	CONSTRAINT "merchandising_rules_window_days_range_check" CHECK ("merchandising_rules"."best_selling_window_days" is null or "merchandising_rules"."best_selling_window_days" between 1 and 365),
	CONSTRAINT "merchandising_rules_in_stock_first_check" CHECK ("merchandising_rules"."kind" = 'sort' or not "merchandising_rules"."in_stock_first"),
	CONSTRAINT "merchandising_rules_spotlight_limit_presence_check" CHECK (("merchandising_rules"."kind" = 'spotlight') = ("merchandising_rules"."spotlight_item_limit" is not null)),
	CONSTRAINT "merchandising_rules_spotlight_limit_range_check" CHECK ("merchandising_rules"."spotlight_item_limit" is null or "merchandising_rules"."spotlight_item_limit" between 1 and 24),
	CONSTRAINT "merchandising_rules_window_check" CHECK ("merchandising_rules"."starts_at" is null or "merchandising_rules"."ends_at" is null or "merchandising_rules"."ends_at" > "merchandising_rules"."starts_at")
);
--> statement-breakpoint
ALTER TABLE "merchandising_rule_pins" ADD CONSTRAINT "merchandising_rule_pins_rule_id_merchandising_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."merchandising_rules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchandising_rule_pins" ADD CONSTRAINT "merchandising_rule_pins_listing_id_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."listings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchandising_rules" ADD CONSTRAINT "merchandising_rules_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchandising_rules" ADD CONSTRAINT "merchandising_rules_collection_id_collections_id_fk" FOREIGN KEY ("collection_id") REFERENCES "public"."collections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "merchandising_rule_pins_listing_id_idx" ON "merchandising_rule_pins" USING btree ("listing_id");--> statement-breakpoint
CREATE INDEX "merchandising_rules_store_id_kind_idx" ON "merchandising_rules" USING btree ("store_id","kind");--> statement-breakpoint
CREATE INDEX "merchandising_rules_collection_id_idx" ON "merchandising_rules" USING btree ("collection_id");