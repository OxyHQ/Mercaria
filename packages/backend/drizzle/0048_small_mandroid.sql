-- oxy:deploy-phase=pre
--
-- #66 — the Awin retailer-network source. ADDITIVE, entirely.
--
-- Six new tables and no change to any existing one, which is what makes turning
-- this source off a flag flip and never a data change. The hand-written
-- statements at the END of this file are the three triggers drizzle-kit cannot
-- model; a REGENERATION drops them, so re-apply them there and verify by
-- grepping this file for each function/trigger pair and for exactly one deploy
-- phase marker on the first line.
--

CREATE TABLE "awin_accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"publisher_id" text NOT NULL,
	"label" text NOT NULL,
	"feed_credential_ref" text,
	"publisher_api_credential_ref" text,
	"state" text DEFAULT 'active' NOT NULL,
	"state_reason" text,
	"state_changed_at" timestamp with time zone,
	"state_changed_by_oxy_user_id" text,
	"state_note" text,
	"max_concurrency" integer DEFAULT 2 NOT NULL,
	"max_calls_per_minute" integer DEFAULT 20 NOT NULL,
	"last_list_polled_at" timestamp with time zone,
	"last_list_digest" text,
	"last_list_feed_count" integer,
	"last_list_error" text,
	"last_list_error_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "awin_accounts_state_check" CHECK ("awin_accounts"."state" in ('active', 'paused', 'deauthorized')),
	CONSTRAINT "awin_accounts_state_reason_check" CHECK ("awin_accounts"."state_reason" in ('operator', 'credential_rejected', 'account_closed', 'network_unreachable')),
	CONSTRAINT "awin_accounts_publisher_id_shape_check" CHECK ("awin_accounts"."publisher_id" ~ '^[0-9]{1,20}$'),
	CONSTRAINT "awin_accounts_label_check" CHECK (btrim("awin_accounts"."label") <> '' and length("awin_accounts"."label") <= 200),
	CONSTRAINT "awin_accounts_feed_credential_shape_check" CHECK ("awin_accounts"."feed_credential_ref" is null
          or "awin_accounts"."feed_credential_ref" ~ '^(connection|env|ssm):[A-Za-z0-9_./-]{1,120}$'),
	CONSTRAINT "awin_accounts_publisher_api_credential_shape_check" CHECK ("awin_accounts"."publisher_api_credential_ref" is null
          or "awin_accounts"."publisher_api_credential_ref" ~ '^(connection|env|ssm):[A-Za-z0-9_./-]{1,120}$'),
	CONSTRAINT "awin_accounts_budget_check" CHECK ("awin_accounts"."max_concurrency" >= 1 and "awin_accounts"."max_calls_per_minute" >= 1),
	CONSTRAINT "awin_accounts_state_shape_check" CHECK (("awin_accounts"."state" = 'active')
          or ("awin_accounts"."state_reason" is not null and "awin_accounts"."state_changed_at" is not null)),
	CONSTRAINT "awin_accounts_note_length_check" CHECK (("awin_accounts"."state_note" is null or length("awin_accounts"."state_note") <= 2000)
          and ("awin_accounts"."last_list_error" is null or length("awin_accounts"."last_list_error") <= 2000)),
	CONSTRAINT "awin_accounts_list_digest_shape_check" CHECK ("awin_accounts"."last_list_digest" is null or "awin_accounts"."last_list_digest" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "awin_advertiser_quality" (
	"id" text PRIMARY KEY NOT NULL,
	"advertiser_row_id" text NOT NULL,
	"feed_row_id" text NOT NULL,
	"run_id" text,
	"measured_at" timestamp with time zone NOT NULL,
	"mapping_version" integer NOT NULL,
	"scanned" integer NOT NULL,
	"mapped" integer NOT NULL,
	"rejected" integer NOT NULL,
	"with_gtin" integer DEFAULT 0 NOT NULL,
	"with_mpn" integer DEFAULT 0 NOT NULL,
	"with_brand" integer DEFAULT 0 NOT NULL,
	"with_image" integer DEFAULT 0 NOT NULL,
	"with_price" integer DEFAULT 0 NOT NULL,
	"duplicate_external_ids" integer DEFAULT 0 NOT NULL,
	"duplicate_gtins" integer DEFAULT 0 NOT NULL,
	"rejected_currency" integer DEFAULT 0 NOT NULL,
	"rejected_price" integer DEFAULT 0 NOT NULL,
	"contradictory_availability" integer DEFAULT 0 NOT NULL,
	"tracking_approved" integer DEFAULT 0 NOT NULL,
	"tracking_rejected" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "awin_advertiser_quality_totals_check" CHECK ("awin_advertiser_quality"."scanned" = "awin_advertiser_quality"."mapped" + "awin_advertiser_quality"."rejected"),
	CONSTRAINT "awin_advertiser_quality_nonnegative_check" CHECK ("awin_advertiser_quality"."scanned" >= 0 and "awin_advertiser_quality"."mapped" >= 0 and "awin_advertiser_quality"."rejected" >= 0
          and "awin_advertiser_quality"."with_gtin" >= 0 and "awin_advertiser_quality"."with_mpn" >= 0 and "awin_advertiser_quality"."with_brand" >= 0
          and "awin_advertiser_quality"."with_image" >= 0 and "awin_advertiser_quality"."with_price" >= 0
          and "awin_advertiser_quality"."duplicate_external_ids" >= 0 and "awin_advertiser_quality"."duplicate_gtins" >= 0
          and "awin_advertiser_quality"."rejected_currency" >= 0 and "awin_advertiser_quality"."rejected_price" >= 0
          and "awin_advertiser_quality"."contradictory_availability" >= 0
          and "awin_advertiser_quality"."tracking_approved" >= 0 and "awin_advertiser_quality"."tracking_rejected" >= 0),
	CONSTRAINT "awin_advertiser_quality_coverage_check" CHECK ("awin_advertiser_quality"."with_gtin" <= "awin_advertiser_quality"."mapped" and "awin_advertiser_quality"."with_mpn" <= "awin_advertiser_quality"."mapped"
          and "awin_advertiser_quality"."with_brand" <= "awin_advertiser_quality"."mapped" and "awin_advertiser_quality"."with_image" <= "awin_advertiser_quality"."mapped"
          and "awin_advertiser_quality"."with_price" <= "awin_advertiser_quality"."mapped"
          and "awin_advertiser_quality"."tracking_approved" + "awin_advertiser_quality"."tracking_rejected" <= "awin_advertiser_quality"."mapped"),
	CONSTRAINT "awin_advertiser_quality_mapping_version_check" CHECK ("awin_advertiser_quality"."mapping_version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "awin_advertisers" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"advertiser_id" text NOT NULL,
	"display_name" text NOT NULL,
	"catalog_source_id" text,
	"membership_status" text DEFAULT 'not_joined' NOT NULL,
	"membership_changed_at" timestamp with time zone,
	"activation" text DEFAULT 'candidate' NOT NULL,
	"activation_changed_at" timestamp with time zone,
	"activation_changed_by_oxy_user_id" text,
	"activation_note" text,
	"activating_sample_id" text,
	"primary_region" text,
	"vertical" text,
	"declared_host" text,
	"last_seen_in_list_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "awin_advertisers_membership_check" CHECK ("awin_advertisers"."membership_status" in ('not_joined', 'pending', 'joined', 'declined', 'suspended', 'left')),
	CONSTRAINT "awin_advertisers_activation_check" CHECK ("awin_advertisers"."activation" in ('candidate', 'sampling', 'active', 'paused', 'closed')),
	CONSTRAINT "awin_advertisers_advertiser_id_shape_check" CHECK ("awin_advertisers"."advertiser_id" ~ '^[0-9]{1,20}$'),
	CONSTRAINT "awin_advertisers_display_name_check" CHECK (btrim("awin_advertisers"."display_name") <> ''
          and length("awin_advertisers"."display_name") <= 200),
	CONSTRAINT "awin_advertisers_declared_host_shape_check" CHECK ("awin_advertisers"."declared_host" is null
          or "awin_advertisers"."declared_host" ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$'),
	CONSTRAINT "awin_advertisers_note_length_check" CHECK ("awin_advertisers"."activation_note" is null
          or length("awin_advertisers"."activation_note") <= 2000),
	CONSTRAINT "awin_advertisers_activation_sample_check" CHECK ("awin_advertisers"."activation" <> 'active' or "awin_advertisers"."activating_sample_id" is not null),
	CONSTRAINT "awin_advertisers_activation_attribution_check" CHECK ("awin_advertisers"."activation" = 'candidate'
          or ("awin_advertisers"."activation_changed_at" is not null and "awin_advertisers"."activation_changed_by_oxy_user_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "awin_feeds" (
	"id" text PRIMARY KEY NOT NULL,
	"advertiser_row_id" text NOT NULL,
	"feed_id" text NOT NULL,
	"feed_name" text NOT NULL,
	"language" text,
	"currency" text,
	"product_count" integer,
	"listed_last_imported_at" timestamp with time zone,
	"last_seen_in_list_at" timestamp with time zone,
	"declared_columns" text[] DEFAULT '{}'::text[] NOT NULL,
	"imported_last_imported_at" timestamp with time zone,
	"last_import_at" timestamp with time zone,
	"last_import_digest" text,
	"http_etag" text,
	"http_last_modified" text,
	"mapping_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "awin_feeds_feed_id_shape_check" CHECK ("awin_feeds"."feed_id" ~ '^[0-9]{1,20}$'),
	CONSTRAINT "awin_feeds_feed_name_check" CHECK (btrim("awin_feeds"."feed_name") <> ''
          and length("awin_feeds"."feed_name") <= 200),
	CONSTRAINT "awin_feeds_product_count_check" CHECK ("awin_feeds"."product_count" is null or "awin_feeds"."product_count" >= 0),
	CONSTRAINT "awin_feeds_mapping_version_check" CHECK ("awin_feeds"."mapping_version" >= 1),
	CONSTRAINT "awin_feeds_import_digest_shape_check" CHECK ("awin_feeds"."last_import_digest" is null or "awin_feeds"."last_import_digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "awin_feeds_declared_columns_check" CHECK ("awin_feeds"."declared_columns" <@ array['aw_deep_link', 'merchant_deep_link', 'aw_product_id', 'merchant_product_id', 'merchant_id', 'merchant_name', 'product_name', 'description', 'brand_name', 'model_number', 'ean', 'upc', 'isbn', 'mpn', 'product_type', 'merchant_category', 'category_name', 'search_price', 'store_price', 'rrp_price', 'currency', 'in_stock', 'stock_quantity', 'is_for_sale', 'condition', 'merchant_image_url', 'aw_image_url', 'alternate_image', 'delivery_cost', 'delivery_time', 'warranty', 'language', 'last_updated', 'colour', 'size', 'material']::text[])
);
--> statement-breakpoint
CREATE TABLE "awin_link_samples" (
	"id" text PRIMARY KEY NOT NULL,
	"advertiser_row_id" text NOT NULL,
	"feed_row_id" text NOT NULL,
	"verdict" text DEFAULT 'pending' NOT NULL,
	"sampled" integer NOT NULL,
	"passed_rows" integer DEFAULT 0 NOT NULL,
	"findings" text[] DEFAULT '{}'::text[] NOT NULL,
	"taken_by_oxy_user_id" text NOT NULL,
	"taken_at" timestamp with time zone NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "awin_link_samples_verdict_check" CHECK ("awin_link_samples"."verdict" in ('pending', 'passed', 'failed')),
	CONSTRAINT "awin_link_samples_findings_check" CHECK ("awin_link_samples"."findings" <@ array['tracking_missing', 'tracking_host_not_approved', 'destination_insecure_scheme', 'destination_unresolvable', 'destination_host_mismatch', 'destination_missing']::text[]),
	CONSTRAINT "awin_link_samples_counts_check" CHECK ("awin_link_samples"."sampled" >= 1 and "awin_link_samples"."passed_rows" >= 0 and "awin_link_samples"."passed_rows" <= "awin_link_samples"."sampled"),
	CONSTRAINT "awin_link_samples_verdict_shape_check" CHECK (("awin_link_samples"."verdict" <> 'passed' or coalesce(array_length("awin_link_samples"."findings", 1), 0) = 0)
          and ("awin_link_samples"."verdict" <> 'failed' or coalesce(array_length("awin_link_samples"."findings", 1), 0) >= 1)),
	CONSTRAINT "awin_link_samples_note_length_check" CHECK ("awin_link_samples"."note" is null or length("awin_link_samples"."note") <= 2000)
);
--> statement-breakpoint
CREATE TABLE "awin_network_leases" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"slot" integer NOT NULL,
	"lease_owner" text,
	"lease_until" timestamp with time zone,
	"window_start" timestamp with time zone NOT NULL,
	"calls_in_window" integer DEFAULT 0 NOT NULL,
	"window_allowance" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "awin_network_leases_slot_check" CHECK ("awin_network_leases"."slot" >= 0),
	CONSTRAINT "awin_network_leases_lease_shape_check" CHECK (num_nonnulls("awin_network_leases"."lease_owner", "awin_network_leases"."lease_until") in (0, 2)),
	CONSTRAINT "awin_network_leases_window_check" CHECK ("awin_network_leases"."calls_in_window" >= 0 and "awin_network_leases"."window_allowance" >= 1
          and "awin_network_leases"."calls_in_window" <= "awin_network_leases"."window_allowance")
);
--> statement-breakpoint
ALTER TABLE "awin_advertiser_quality" ADD CONSTRAINT "awin_advertiser_quality_advertiser_row_id_awin_advertisers_id_fk" FOREIGN KEY ("advertiser_row_id") REFERENCES "public"."awin_advertisers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "awin_advertiser_quality" ADD CONSTRAINT "awin_advertiser_quality_feed_row_id_awin_feeds_id_fk" FOREIGN KEY ("feed_row_id") REFERENCES "public"."awin_feeds"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "awin_advertiser_quality" ADD CONSTRAINT "awin_advertiser_quality_run_id_catalog_source_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."catalog_source_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "awin_advertisers" ADD CONSTRAINT "awin_advertisers_account_id_awin_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."awin_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "awin_advertisers" ADD CONSTRAINT "awin_advertisers_catalog_source_id_catalog_sources_id_fk" FOREIGN KEY ("catalog_source_id") REFERENCES "public"."catalog_sources"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "awin_feeds" ADD CONSTRAINT "awin_feeds_advertiser_row_id_awin_advertisers_id_fk" FOREIGN KEY ("advertiser_row_id") REFERENCES "public"."awin_advertisers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "awin_link_samples" ADD CONSTRAINT "awin_link_samples_advertiser_row_id_awin_advertisers_id_fk" FOREIGN KEY ("advertiser_row_id") REFERENCES "public"."awin_advertisers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "awin_link_samples" ADD CONSTRAINT "awin_link_samples_feed_row_id_awin_feeds_id_fk" FOREIGN KEY ("feed_row_id") REFERENCES "public"."awin_feeds"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "awin_network_leases" ADD CONSTRAINT "awin_network_leases_account_id_awin_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."awin_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "awin_accounts_publisher_key" ON "awin_accounts" USING btree ("publisher_id");--> statement-breakpoint
CREATE INDEX "awin_advertiser_quality_advertiser_measured_idx" ON "awin_advertiser_quality" USING btree ("advertiser_row_id","measured_at");--> statement-breakpoint
CREATE UNIQUE INDEX "awin_advertisers_account_advertiser_key" ON "awin_advertisers" USING btree ("account_id","advertiser_id");--> statement-breakpoint
CREATE UNIQUE INDEX "awin_advertisers_catalog_source_key" ON "awin_advertisers" USING btree ("catalog_source_id");--> statement-breakpoint
CREATE INDEX "awin_advertisers_account_activation_idx" ON "awin_advertisers" USING btree ("account_id","activation");--> statement-breakpoint
CREATE UNIQUE INDEX "awin_feeds_advertiser_feed_key" ON "awin_feeds" USING btree ("advertiser_row_id","feed_id");--> statement-breakpoint
CREATE INDEX "awin_link_samples_advertiser_taken_idx" ON "awin_link_samples" USING btree ("advertiser_row_id","taken_at");--> statement-breakpoint
CREATE UNIQUE INDEX "awin_network_leases_account_slot_key" ON "awin_network_leases" USING btree ("account_id","slot");--> statement-breakpoint
CREATE INDEX "awin_network_leases_account_free_idx" ON "awin_network_leases" USING btree ("account_id","lease_until");

--
-- 1. `awin_advertisers`' NETWORK IDENTITY is frozen.
--
-- #124's `supplier_accounts` decision, for its reason: every feed, quality
-- snapshot, sample and `catalog_sources` row NAMES this advertiser rather than
-- snapshotting which one it was, so re-pointing `account_id` or `advertiser_id`
-- silently reinterprets every historical row — a whole retailer's observations,
-- runs and offers becoming somebody else's, with no error anywhere.
--
-- `catalog_source_id` is deliberately NOT frozen: binding a source is a later
-- operator act and the unique index already stops one source serving two
-- advertisers.
--
CREATE OR REPLACE FUNCTION mercaria_awin_advertiser_identity_frozen()
RETURNS trigger AS $$
BEGIN
  IF NEW.account_id IS DISTINCT FROM OLD.account_id
     OR NEW.advertiser_id IS DISTINCT FROM OLD.advertiser_id THEN
    RAISE EXCEPTION
      'awin_advertisers identity (account_id, advertiser_id) is frozen: every feed, quality '
      'snapshot, sample and catalogue source names this advertiser rather than snapshotting '
      'which one it was, so re-pointing it reinterprets every historical row.';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER awin_advertisers_identity_frozen
BEFORE UPDATE ON awin_advertisers
FOR EACH ROW EXECUTE FUNCTION mercaria_awin_advertiser_identity_frozen();--> statement-breakpoint

--
-- 2. `awin_advertiser_quality` is APPEND-ONLY.
--
-- Against UPDATE and DELETE alike. A quality history whose rows can be edited
-- answers "was this feed always like this" with whatever somebody most recently
-- believed, and the question is usually asked during an argument about whether a
-- regression is new.
--
CREATE OR REPLACE FUNCTION mercaria_awin_quality_append_only()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION
    'awin_advertiser_quality is append-only: a measurement is evidence about one import, and a '
    'history that can be rewritten cannot answer whether a regression is new. Record a new '
    'measurement instead.';
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER awin_advertiser_quality_append_only
BEFORE UPDATE OR DELETE ON awin_advertiser_quality
FOR EACH ROW EXECUTE FUNCTION mercaria_awin_quality_append_only();--> statement-breakpoint

--
-- 3. `awin_link_samples` is APPEND-ONLY.
--
-- The same rule for a stronger reason: a sample AUTHORISES an activation
-- (`awin_advertisers_activation_sample_check`), so one that can be edited after
-- the fact is not evidence — and the edit would be invisible beside an
-- advertiser that has been live for a month. A re-sample is a NEW row. It is
-- also what makes `awin_advertisers.activating_sample_id` safe without a
-- foreign key drizzle-kit would silently omit: nothing deletes the row it cites.
--
CREATE OR REPLACE FUNCTION mercaria_awin_link_sample_append_only()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION
    'awin_link_samples is append-only: a sample authorises an activation, so one that can be '
    'edited afterwards is not evidence. Record a new sample instead.';
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER awin_link_samples_append_only
BEFORE UPDATE OR DELETE ON awin_link_samples
FOR EACH ROW EXECUTE FUNCTION mercaria_awin_link_sample_append_only();
