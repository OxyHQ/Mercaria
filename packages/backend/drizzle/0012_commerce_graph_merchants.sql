-- oxy:deploy-phase=pre
--
-- The merchant/storefront layer of the canonical commerce graph (#54,
-- ADR 0002 Phase 0): `merchants`, `merchant_aliases`, `merchant_domains`,
-- `merchant_source_links`, `storefronts`, `storefront_aliases`,
-- `storefront_source_links`, `native_store_links`. Everything below CREATES
-- something new — no existing table, column, CHECK or index is touched, so
-- the image still serving is unaffected by all of it. Nothing reads or writes
-- these tables until the graph's own surfaces do (ADR 0002 D23 Phase 0:
-- tables land with zero rows).
--
-- Foreign keys into PRE-EXISTING tables, all RESTRICT and all additive:
-- `native_store_links.{merchant_id,store_id}` (ADR 0002 D4/D25(d) — nothing
-- deletes a `stores` row today, so the constraint changes no live behaviour)
-- and every `source_record_id` onto #53's `source_records` (D19: provenance
-- must be able to block a delete). On #54's development branch those five
-- were DEFERRED foreign keys; this migration is generated AFTER integration
-- with #53's 0011, so they land as real constraints from the start.
--
-- Regenerated at integration per ADR 0002 D25(c): the branch's provisional
-- 0011 was deleted (sql + journal entry + snapshot) and this file minted
-- against main's journal — never hand-renumbered.
--
-- The trigram GIN indexes on `normalized_alias` need `pg_trgm`, already in
-- `migrate.ts`'s REQUIRED_EXTENSIONS since #53's migration (an extension
-- precondition of the migrator, not a numbered migration — ADR 0002 D21).
CREATE TABLE "merchant_aliases" (
	"id" text PRIMARY KEY NOT NULL,
	"merchant_id" text NOT NULL,
	"alias" text NOT NULL,
	"normalized_alias" text GENERATED ALWAYS AS (lower(btrim("alias"))) STORED NOT NULL,
	"kind" text NOT NULL,
	"language" text,
	"source_record_id" text,
	"created_by_oxy_user_id" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "merchant_aliases_kind_check" CHECK ("merchant_aliases"."kind" in ('name_variant', 'former_name', 'localized_name', 'marketing_name', 'misspelling'))
);
--> statement-breakpoint
CREATE TABLE "merchant_domains" (
	"id" text PRIMARY KEY NOT NULL,
	"merchant_id" text NOT NULL,
	"domain" text NOT NULL,
	"status" text DEFAULT 'observed' NOT NULL,
	"first_observed_at" timestamp with time zone NOT NULL,
	"last_observed_at" timestamp with time zone NOT NULL,
	"verified_at" timestamp with time zone,
	"verified_by_oxy_user_id" text,
	"source_record_id" text,
	"note" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "merchant_domains_status_check" CHECK ("merchant_domains"."status" in ('observed', 'verified', 'rejected')),
	CONSTRAINT "merchant_domains_domain_normalized_check" CHECK ("merchant_domains"."domain" = lower(btrim("merchant_domains"."domain"))),
	CONSTRAINT "merchant_domains_verified_state_check" CHECK ("merchant_domains"."status" <> 'verified' or "merchant_domains"."verified_at" is not null)
);
--> statement-breakpoint
CREATE TABLE "merchant_source_links" (
	"id" text PRIMARY KEY NOT NULL,
	"merchant_id" text NOT NULL,
	"source_record_id" text NOT NULL,
	"method" text NOT NULL,
	"match_rule" text NOT NULL,
	"confidence" double precision,
	"status" text DEFAULT 'active' NOT NULL,
	"decided_by_oxy_user_id" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "merchant_source_links_method_check" CHECK ("merchant_source_links"."method" in ('deterministic_identifier', 'connector_declared', 'operator', 'heuristic')),
	CONSTRAINT "merchant_source_links_status_check" CHECK ("merchant_source_links"."status" in ('active', 'superseded', 'rejected')),
	CONSTRAINT "merchant_source_links_confidence_check" CHECK ("merchant_source_links"."confidence" >= 0 and "merchant_source_links"."confidence" <= 1)
);
--> statement-breakpoint
CREATE TABLE "merchants" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"merchant_type" text,
	"description" text,
	"claim_state" text DEFAULT 'unclaimed' NOT NULL,
	"claimed_by_oxy_user_id" text,
	"claimed_at" timestamp with time zone,
	"merged_into_id" text,
	"rating" double precision DEFAULT 0 NOT NULL,
	"rating_count" integer DEFAULT 0 NOT NULL,
	"offer_count" integer DEFAULT 0 NOT NULL,
	"search_vector" "tsvector" GENERATED ALWAYS AS (to_tsvector('simple', "merchants"."name")) STORED,
	"status" text DEFAULT 'active' NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"last_seen_at" timestamp with time zone,
	"last_reviewed_at" timestamp with time zone,
	"pinned_fields" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "merchants_merchant_type_check" CHECK ("merchants"."merchant_type" in ('retailer', 'marketplace_seller', 'manufacturer_direct', 'cooperative', 'individual_business')),
	CONSTRAINT "merchants_claim_state_check" CHECK ("merchants"."claim_state" in ('unclaimed', 'claim_pending', 'claimed')),
	CONSTRAINT "merchants_status_check" CHECK ("merchants"."status" in ('active', 'inactive', 'merged', 'suppressed')),
	CONSTRAINT "merchants_merged_state_check" CHECK (("merchants"."status" = 'merged') = ("merchants"."merged_into_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "native_store_links" (
	"id" text PRIMARY KEY NOT NULL,
	"merchant_id" text NOT NULL,
	"store_id" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"verification_method" text NOT NULL,
	"verification_note" text,
	"verified_by_oxy_user_id" text NOT NULL,
	"verified_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by_oxy_user_id" text,
	"revoke_reason" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "native_store_links_status_check" CHECK ("native_store_links"."status" in ('active', 'revoked')),
	CONSTRAINT "native_store_links_verification_method_check" CHECK ("native_store_links"."verification_method" in ('owner_authentication', 'domain_verification', 'operator')),
	CONSTRAINT "native_store_links_revoked_state_check" CHECK ("native_store_links"."status" <> 'revoked' or ("native_store_links"."revoked_at" is not null and "native_store_links"."revoked_by_oxy_user_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "storefront_aliases" (
	"id" text PRIMARY KEY NOT NULL,
	"storefront_id" text NOT NULL,
	"alias" text NOT NULL,
	"normalized_alias" text GENERATED ALWAYS AS (lower(btrim("alias"))) STORED NOT NULL,
	"kind" text NOT NULL,
	"language" text,
	"source_record_id" text,
	"created_by_oxy_user_id" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "storefront_aliases_kind_check" CHECK ("storefront_aliases"."kind" in ('name_variant', 'former_name', 'localized_name', 'marketing_name', 'misspelling'))
);
--> statement-breakpoint
CREATE TABLE "storefront_source_links" (
	"id" text PRIMARY KEY NOT NULL,
	"storefront_id" text NOT NULL,
	"source_record_id" text NOT NULL,
	"method" text NOT NULL,
	"match_rule" text NOT NULL,
	"confidence" double precision,
	"status" text DEFAULT 'active' NOT NULL,
	"decided_by_oxy_user_id" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "storefront_source_links_method_check" CHECK ("storefront_source_links"."method" in ('deterministic_identifier', 'connector_declared', 'operator', 'heuristic')),
	CONSTRAINT "storefront_source_links_status_check" CHECK ("storefront_source_links"."status" in ('active', 'superseded', 'rejected')),
	CONSTRAINT "storefront_source_links_confidence_check" CHECK ("storefront_source_links"."confidence" >= 0 and "storefront_source_links"."confidence" <= 1)
);
--> statement-breakpoint
CREATE TABLE "storefronts" (
	"id" text PRIMARY KEY NOT NULL,
	"merchant_id" text NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"channel_kind" text NOT NULL,
	"provider" text,
	"domain" text,
	"external_shop_id" text,
	"country" text,
	"languages" text[],
	"currency" text,
	"public_url" text,
	"affiliate_capable" boolean DEFAULT false NOT NULL,
	"merged_into_id" text,
	"last_refreshed_at" timestamp with time zone,
	"verification_state" text DEFAULT 'unverified' NOT NULL,
	"verified_at" timestamp with time zone,
	"search_vector" "tsvector" GENERATED ALWAYS AS (to_tsvector('simple', "storefronts"."name")) STORED,
	"status" text DEFAULT 'active' NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"last_seen_at" timestamp with time zone,
	"last_reviewed_at" timestamp with time zone,
	"pinned_fields" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "storefronts_channel_kind_check" CHECK ("storefronts"."channel_kind" in ('web', 'marketplace', 'app', 'physical')),
	CONSTRAINT "storefronts_status_check" CHECK ("storefronts"."status" in ('active', 'inactive', 'merged', 'suppressed')),
	CONSTRAINT "storefronts_verification_state_check" CHECK ("storefronts"."verification_state" in ('unverified', 'verified')),
	CONSTRAINT "storefronts_merged_state_check" CHECK (("storefronts"."status" = 'merged') = ("storefronts"."merged_into_id" is not null)),
	CONSTRAINT "storefronts_domain_normalized_check" CHECK ("storefronts"."domain" = lower(btrim("storefronts"."domain"))),
	CONSTRAINT "storefronts_country_check" CHECK ("storefronts"."country" ~ '^[A-Z]{2}$'),
	CONSTRAINT "storefronts_currency_check" CHECK ("storefronts"."currency" ~ '^[A-Z]{3,4}$'),
	CONSTRAINT "storefronts_verified_state_check" CHECK ("storefronts"."verification_state" <> 'verified' or "storefronts"."verified_at" is not null)
);
--> statement-breakpoint
ALTER TABLE "merchant_aliases" ADD CONSTRAINT "merchant_aliases_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchant_aliases" ADD CONSTRAINT "merchant_aliases_source_record_id_source_records_id_fk" FOREIGN KEY ("source_record_id") REFERENCES "public"."source_records"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchant_domains" ADD CONSTRAINT "merchant_domains_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchant_domains" ADD CONSTRAINT "merchant_domains_source_record_id_source_records_id_fk" FOREIGN KEY ("source_record_id") REFERENCES "public"."source_records"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchant_source_links" ADD CONSTRAINT "merchant_source_links_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchant_source_links" ADD CONSTRAINT "merchant_source_links_source_record_id_source_records_id_fk" FOREIGN KEY ("source_record_id") REFERENCES "public"."source_records"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchants" ADD CONSTRAINT "merchants_merged_into_id_merchants_id_fk" FOREIGN KEY ("merged_into_id") REFERENCES "public"."merchants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "native_store_links" ADD CONSTRAINT "native_store_links_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "native_store_links" ADD CONSTRAINT "native_store_links_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storefront_aliases" ADD CONSTRAINT "storefront_aliases_storefront_id_storefronts_id_fk" FOREIGN KEY ("storefront_id") REFERENCES "public"."storefronts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storefront_aliases" ADD CONSTRAINT "storefront_aliases_source_record_id_source_records_id_fk" FOREIGN KEY ("source_record_id") REFERENCES "public"."source_records"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storefront_source_links" ADD CONSTRAINT "storefront_source_links_storefront_id_storefronts_id_fk" FOREIGN KEY ("storefront_id") REFERENCES "public"."storefronts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storefront_source_links" ADD CONSTRAINT "storefront_source_links_source_record_id_source_records_id_fk" FOREIGN KEY ("source_record_id") REFERENCES "public"."source_records"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storefronts" ADD CONSTRAINT "storefronts_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storefronts" ADD CONSTRAINT "storefronts_merged_into_id_storefronts_id_fk" FOREIGN KEY ("merged_into_id") REFERENCES "public"."storefronts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "merchant_aliases_merchant_id_normalized_alias_key" ON "merchant_aliases" USING btree ("merchant_id","normalized_alias");--> statement-breakpoint
CREATE INDEX "merchant_aliases_normalized_alias_idx" ON "merchant_aliases" USING gin ("normalized_alias" gin_trgm_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "merchant_domains_merchant_id_domain_key" ON "merchant_domains" USING btree ("merchant_id","domain");--> statement-breakpoint
CREATE UNIQUE INDEX "merchant_domains_domain_verified_key" ON "merchant_domains" USING btree ("domain") WHERE "merchant_domains"."status" = 'verified';--> statement-breakpoint
CREATE INDEX "merchant_domains_domain_idx" ON "merchant_domains" USING btree ("domain");--> statement-breakpoint
CREATE UNIQUE INDEX "merchant_source_links_merchant_id_source_record_id_key" ON "merchant_source_links" USING btree ("merchant_id","source_record_id") WHERE "merchant_source_links"."status" = 'active';--> statement-breakpoint
CREATE INDEX "merchant_source_links_source_record_id_idx" ON "merchant_source_links" USING btree ("source_record_id");--> statement-breakpoint
CREATE UNIQUE INDEX "merchants_slug_key" ON "merchants" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "merchants_status_created_at_idx" ON "merchants" USING btree ("status","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "merchants_search_vector_idx" ON "merchants" USING gin ("search_vector");--> statement-breakpoint
CREATE UNIQUE INDEX "native_store_links_store_id_active_key" ON "native_store_links" USING btree ("store_id") WHERE "native_store_links"."status" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "native_store_links_merchant_id_active_key" ON "native_store_links" USING btree ("merchant_id") WHERE "native_store_links"."status" = 'active';--> statement-breakpoint
CREATE INDEX "native_store_links_store_id_idx" ON "native_store_links" USING btree ("store_id");--> statement-breakpoint
CREATE INDEX "native_store_links_merchant_id_idx" ON "native_store_links" USING btree ("merchant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "storefront_aliases_storefront_id_normalized_alias_key" ON "storefront_aliases" USING btree ("storefront_id","normalized_alias");--> statement-breakpoint
CREATE INDEX "storefront_aliases_normalized_alias_idx" ON "storefront_aliases" USING gin ("normalized_alias" gin_trgm_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "storefront_source_links_storefront_id_source_record_id_key" ON "storefront_source_links" USING btree ("storefront_id","source_record_id") WHERE "storefront_source_links"."status" = 'active';--> statement-breakpoint
CREATE INDEX "storefront_source_links_source_record_id_idx" ON "storefront_source_links" USING btree ("source_record_id");--> statement-breakpoint
CREATE UNIQUE INDEX "storefronts_slug_key" ON "storefronts" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "storefronts_provider_external_shop_id_key" ON "storefronts" USING btree ("provider","external_shop_id") WHERE "storefronts"."provider" is not null and "storefronts"."external_shop_id" is not null and "storefronts"."status" <> 'merged';--> statement-breakpoint
CREATE INDEX "storefronts_merchant_id_idx" ON "storefronts" USING btree ("merchant_id");--> statement-breakpoint
CREATE INDEX "storefronts_domain_idx" ON "storefronts" USING btree ("domain") WHERE "storefronts"."domain" is not null;--> statement-breakpoint
CREATE INDEX "storefronts_status_last_seen_at_idx" ON "storefronts" USING btree ("status","last_seen_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "storefronts_search_vector_idx" ON "storefronts" USING gin ("search_vector");