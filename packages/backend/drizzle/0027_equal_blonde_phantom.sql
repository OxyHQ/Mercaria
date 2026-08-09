-- oxy:deploy-phase=pre
--
-- #76: the review domain gains scopes, eligibility, aggregates and a migration
-- log. ADDITIVE throughout, and every piece is correct against BOTH the image
-- still serving and the one arriving:
--
--   * the five new tables are new;
--   * every new `reviews` column is nullable or carries a default, so the
--     previous image's INSERTs (which name none of them) still satisfy every
--     constraint — an unscoped row is `unclassified`, `unverified`, with no
--     eligibility, which is exactly what those CHECKs permit;
--   * `reviews_target_type_check` and `reviews_target_exclusivity_check` are
--     DROPPED and re-added WIDER. Dropping a CHECK is safe in `pre` because the
--     replacement accepts a SUPERSET: every row the old image can write still
--     satisfies the new one — its `scope is null` branch IS the old constraint,
--     verbatim. The reverse (narrowing) would need `post`.
--
-- There is deliberately no data backfill here. `classification_state` defaults
-- to `unclassified`, which is the honest description of every pre-#76 row, and
-- the classification JOB is what decides each one — a migration that guessed
-- scopes in bulk is precisely what #76 migration rule 1 forbids.

CREATE TABLE "review_aggregates" (
	"id" text PRIMARY KEY NOT NULL,
	"scope" text NOT NULL,
	"target_type" text NOT NULL,
	"listing_id" text,
	"store_id" text,
	"seller_oxy_user_id" text,
	"canonical_product_id" text,
	"merchant_id" text,
	"order_item_id" text,
	"rating" double precision DEFAULT 0 NOT NULL,
	"review_count" integer DEFAULT 0 NOT NULL,
	"unverified_rating" double precision DEFAULT 0 NOT NULL,
	"unverified_count" integer DEFAULT 0 NOT NULL,
	"last_rebuilt_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"target_key" text GENERATED ALWAYS AS (coalesce("listing_id", '') || '|' ||
             coalesce("store_id", '') || '|' ||
             coalesce("seller_oxy_user_id", '') || '|' ||
             coalesce("canonical_product_id", '') || '|' ||
             coalesce("merchant_id", '') || '|' ||
             coalesce("order_item_id", '')) STORED NOT NULL,
	CONSTRAINT "review_aggregates_scope_check" CHECK ("review_aggregates"."scope" in ('product', 'merchant', 'native_transaction', 'p2p_listing', 'p2p_seller')),
	CONSTRAINT "review_aggregates_target_type_check" CHECK ("review_aggregates"."target_type" in ('listing', 'store', 'seller', 'canonical_product', 'merchant', 'order_item')),
	CONSTRAINT "review_aggregates_scope_target_type_check" CHECK ("target_type" = case "scope"
            when 'product' then 'canonical_product'
            when 'merchant' then 'merchant'
            when 'native_transaction' then 'order_item'
            when 'p2p_listing' then 'listing'
            when 'p2p_seller' then 'seller'
          end),
	CONSTRAINT "review_aggregates_target_exclusivity_check" CHECK (case "scope"
        when 'product' then "canonical_product_id" is not null and "listing_id" is null and "store_id" is null and "seller_oxy_user_id" is null and "merchant_id" is null and "order_item_id" is null
        when 'merchant' then "merchant_id" is not null and "listing_id" is null and "store_id" is null and "seller_oxy_user_id" is null and "canonical_product_id" is null and "order_item_id" is null
        when 'native_transaction' then "order_item_id" is not null and "listing_id" is null and "store_id" is null and "seller_oxy_user_id" is null and "canonical_product_id" is null and "merchant_id" is null
        when 'p2p_listing' then "listing_id" is not null and "store_id" is null and "seller_oxy_user_id" is null and "canonical_product_id" is null and "merchant_id" is null and "order_item_id" is null
        when 'p2p_seller' then "seller_oxy_user_id" is not null and "listing_id" is null and "store_id" is null and "canonical_product_id" is null and "merchant_id" is null and "order_item_id" is null
          else false
      end),
	CONSTRAINT "review_aggregates_rating_check" CHECK ("review_aggregates"."rating" >= 0 and "review_aggregates"."rating" <= 5 and "review_aggregates"."review_count" >= 0
          and "review_aggregates"."unverified_rating" >= 0 and "review_aggregates"."unverified_rating" <= 5 and "review_aggregates"."unverified_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "review_dimension_aggregates" (
	"id" text PRIMARY KEY NOT NULL,
	"aggregate_id" text NOT NULL,
	"key" text NOT NULL,
	"rating" double precision NOT NULL,
	"count" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "review_dimension_aggregates_key_check" CHECK ("review_dimension_aggregates"."key" in ('quality', 'durability', 'value_for_money', 'delivery_speed', 'packaging', 'communication', 'order_accuracy', 'condition_accuracy', 'description_accuracy', 'photo_accuracy', 'shipping_speed', 'reliability')),
	CONSTRAINT "review_dimension_aggregates_rating_check" CHECK ("review_dimension_aggregates"."rating" >= 0 and "review_dimension_aggregates"."rating" <= 5 and "review_dimension_aggregates"."count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "review_dimensions" (
	"id" text PRIMARY KEY NOT NULL,
	"review_id" text NOT NULL,
	"key" text NOT NULL,
	"rating" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "review_dimensions_key_check" CHECK ("review_dimensions"."key" in ('quality', 'durability', 'value_for_money', 'delivery_speed', 'packaging', 'communication', 'order_accuracy', 'condition_accuracy', 'description_accuracy', 'photo_accuracy', 'shipping_speed', 'reliability')),
	CONSTRAINT "review_dimensions_rating_check" CHECK ("review_dimensions"."rating" between 1 and 5)
);
--> statement-breakpoint
CREATE TABLE "review_eligibilities" (
	"id" text PRIMARY KEY NOT NULL,
	"oxy_user_id" text NOT NULL,
	"order_id" text NOT NULL,
	"order_item_id" text NOT NULL,
	"scope" text NOT NULL,
	"target_type" text NOT NULL,
	"listing_id" text,
	"store_id" text,
	"seller_oxy_user_id" text,
	"canonical_product_id" text,
	"merchant_id" text,
	"target_order_item_id" text,
	"evidence_type" text NOT NULL,
	"claim_id" text,
	"state" text DEFAULT 'open' NOT NULL,
	"consumed_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_reason" text,
	"disputed_at" timestamp with time zone,
	"policy_version" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"target_key" text GENERATED ALWAYS AS (coalesce("listing_id", '') || '|' ||
            coalesce("store_id", '') || '|' ||
            coalesce("seller_oxy_user_id", '') || '|' ||
            coalesce("canonical_product_id", '') || '|' ||
            coalesce("merchant_id", '') || '|' ||
            coalesce("target_order_item_id", '')) STORED NOT NULL,
	CONSTRAINT "review_eligibilities_scope_check" CHECK ("review_eligibilities"."scope" in ('product', 'merchant', 'native_transaction', 'p2p_listing', 'p2p_seller')),
	CONSTRAINT "review_eligibilities_target_type_check" CHECK ("review_eligibilities"."target_type" in ('listing', 'store', 'seller', 'canonical_product', 'merchant', 'order_item')),
	CONSTRAINT "review_eligibilities_evidence_type_check" CHECK ("review_eligibilities"."evidence_type" in ('authenticated_purchase', 'claimed_guest_purchase')),
	CONSTRAINT "review_eligibilities_state_check" CHECK ("review_eligibilities"."state" in ('open', 'consumed', 'revoked', 'disputed')),
	CONSTRAINT "review_eligibilities_scope_target_type_check" CHECK ("target_type" = case "scope"
            when 'product' then 'canonical_product'
            when 'merchant' then 'merchant'
            when 'native_transaction' then 'order_item'
            when 'p2p_listing' then 'listing'
            when 'p2p_seller' then 'seller'
          end),
	CONSTRAINT "review_eligibilities_target_exclusivity_check" CHECK (case "scope"
        when 'product' then "canonical_product_id" is not null and "listing_id" is null and "store_id" is null and "seller_oxy_user_id" is null and "merchant_id" is null and "target_order_item_id" is null
        when 'merchant' then "merchant_id" is not null and "listing_id" is null and "store_id" is null and "seller_oxy_user_id" is null and "canonical_product_id" is null and "target_order_item_id" is null
        when 'native_transaction' then "target_order_item_id" is not null and "listing_id" is null and "store_id" is null and "seller_oxy_user_id" is null and "canonical_product_id" is null and "merchant_id" is null
        when 'p2p_listing' then "listing_id" is not null and "store_id" is null and "seller_oxy_user_id" is null and "canonical_product_id" is null and "merchant_id" is null and "target_order_item_id" is null
        when 'p2p_seller' then "seller_oxy_user_id" is not null and "listing_id" is null and "store_id" is null and "canonical_product_id" is null and "merchant_id" is null and "target_order_item_id" is null
          else false
      end),
	CONSTRAINT "review_eligibilities_claim_check" CHECK (("review_eligibilities"."evidence_type" = 'claimed_guest_purchase') = ("review_eligibilities"."claim_id" is not null)),
	CONSTRAINT "review_eligibilities_state_timestamps_check" CHECK (("review_eligibilities"."state" = 'consumed') = ("review_eligibilities"."consumed_at" is not null)
          and ("review_eligibilities"."state" = 'revoked') = ("review_eligibilities"."revoked_at" is not null)
          and ("review_eligibilities"."state" = 'disputed') = ("review_eligibilities"."disputed_at" is not null)),
	CONSTRAINT "review_eligibilities_revoked_reason_check" CHECK ("review_eligibilities"."revoked_at" is null or "review_eligibilities"."revoked_reason" is not null),
	CONSTRAINT "review_eligibilities_policy_version_check" CHECK (btrim("review_eligibilities"."policy_version") <> '')
);
--> statement-breakpoint
CREATE TABLE "review_target_migrations" (
	"id" text PRIMARY KEY NOT NULL,
	"review_id" text NOT NULL,
	"action" text NOT NULL,
	"from_scope" text,
	"from_target_type" text NOT NULL,
	"from_target_ref" text NOT NULL,
	"to_scope" text,
	"to_target_type" text,
	"to_target_ref" text,
	"reason" text NOT NULL,
	"actor_kind" text NOT NULL,
	"actor_oxy_user_id" text,
	"at" timestamp with time zone NOT NULL,
	CONSTRAINT "review_target_migrations_action_check" CHECK ("review_target_migrations"."action" in ('classify', 'refuse_ambiguous', 'rehome_merge', 'assign_split')),
	CONSTRAINT "review_target_migrations_from_scope_check" CHECK ("review_target_migrations"."from_scope" in ('product', 'merchant', 'native_transaction', 'p2p_listing', 'p2p_seller')),
	CONSTRAINT "review_target_migrations_from_target_type_check" CHECK ("review_target_migrations"."from_target_type" in ('listing', 'store', 'seller', 'canonical_product', 'merchant', 'order_item')),
	CONSTRAINT "review_target_migrations_to_scope_check" CHECK ("review_target_migrations"."to_scope" in ('product', 'merchant', 'native_transaction', 'p2p_listing', 'p2p_seller')),
	CONSTRAINT "review_target_migrations_to_target_type_check" CHECK ("review_target_migrations"."to_target_type" in ('listing', 'store', 'seller', 'canonical_product', 'merchant', 'order_item')),
	CONSTRAINT "review_target_migrations_actor_kind_check" CHECK ("review_target_migrations"."actor_kind" in ('migration', 'operator')),
	CONSTRAINT "review_target_migrations_destination_check" CHECK (case when "review_target_migrations"."action" = 'refuse_ambiguous'
            then num_nonnulls("review_target_migrations"."to_scope", "review_target_migrations"."to_target_type", "review_target_migrations"."to_target_ref") = 0
            else num_nonnulls("review_target_migrations"."to_scope", "review_target_migrations"."to_target_type", "review_target_migrations"."to_target_ref") = 3
          end),
	CONSTRAINT "review_target_migrations_actor_check" CHECK (("review_target_migrations"."actor_kind" = 'operator') = ("review_target_migrations"."actor_oxy_user_id" is not null)),
	CONSTRAINT "review_target_migrations_reason_check" CHECK (btrim("review_target_migrations"."reason") <> '')
);
--> statement-breakpoint
ALTER TABLE "reviews" DROP CONSTRAINT "reviews_target_type_check";--> statement-breakpoint
ALTER TABLE "reviews" DROP CONSTRAINT "reviews_target_exclusivity_check";--> statement-breakpoint
ALTER TABLE "reviews" ADD COLUMN "scope" text;--> statement-breakpoint
ALTER TABLE "reviews" ADD COLUMN "canonical_product_id" text;--> statement-breakpoint
ALTER TABLE "reviews" ADD COLUMN "merchant_id" text;--> statement-breakpoint
ALTER TABLE "reviews" ADD COLUMN "order_item_id" text;--> statement-breakpoint
ALTER TABLE "reviews" ADD COLUMN "eligibility_id" text;--> statement-breakpoint
ALTER TABLE "reviews" ADD COLUMN "verification" text DEFAULT 'unverified' NOT NULL;--> statement-breakpoint
ALTER TABLE "reviews" ADD COLUMN "locale" text;--> statement-breakpoint
ALTER TABLE "reviews" ADD COLUMN "incentive_disclosure" text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "reviews" ADD COLUMN "edited_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "reviews" ADD COLUMN "classification_state" text DEFAULT 'unclassified' NOT NULL;--> statement-breakpoint
ALTER TABLE "reviews" ADD COLUMN "ambiguity_reason" text;--> statement-breakpoint
ALTER TABLE "reviews" ADD COLUMN "target_key" text GENERATED ALWAYS AS (coalesce("listing_id", '') || '|' ||
             coalesce("store_id", '') || '|' ||
             coalesce("seller_oxy_user_id", '') || '|' ||
             coalesce("canonical_product_id", '') || '|' ||
             coalesce("merchant_id", '') || '|' ||
             coalesce("order_item_id", '')) STORED NOT NULL;--> statement-breakpoint
ALTER TABLE "review_aggregates" ADD CONSTRAINT "review_aggregates_listing_id_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."listings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_aggregates" ADD CONSTRAINT "review_aggregates_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_aggregates" ADD CONSTRAINT "review_aggregates_canonical_product_id_canonical_products_id_fk" FOREIGN KEY ("canonical_product_id") REFERENCES "public"."canonical_products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_aggregates" ADD CONSTRAINT "review_aggregates_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_aggregates" ADD CONSTRAINT "review_aggregates_order_item_id_order_items_id_fk" FOREIGN KEY ("order_item_id") REFERENCES "public"."order_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_dimension_aggregates" ADD CONSTRAINT "review_dimension_aggregates_aggregate_id_review_aggregates_id_fk" FOREIGN KEY ("aggregate_id") REFERENCES "public"."review_aggregates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_dimensions" ADD CONSTRAINT "review_dimensions_review_id_reviews_id_fk" FOREIGN KEY ("review_id") REFERENCES "public"."reviews"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_eligibilities" ADD CONSTRAINT "review_eligibilities_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_eligibilities" ADD CONSTRAINT "review_eligibilities_order_item_id_order_items_id_fk" FOREIGN KEY ("order_item_id") REFERENCES "public"."order_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_eligibilities" ADD CONSTRAINT "review_eligibilities_listing_id_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."listings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_eligibilities" ADD CONSTRAINT "review_eligibilities_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_eligibilities" ADD CONSTRAINT "review_eligibilities_canonical_product_id_canonical_products_id_fk" FOREIGN KEY ("canonical_product_id") REFERENCES "public"."canonical_products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_eligibilities" ADD CONSTRAINT "review_eligibilities_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_eligibilities" ADD CONSTRAINT "review_eligibilities_target_order_item_id_order_items_id_fk" FOREIGN KEY ("target_order_item_id") REFERENCES "public"."order_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_target_migrations" ADD CONSTRAINT "review_target_migrations_review_id_reviews_id_fk" FOREIGN KEY ("review_id") REFERENCES "public"."reviews"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "review_aggregates_scope_target_key" ON "review_aggregates" USING btree ("scope","target_key");--> statement-breakpoint
CREATE INDEX "review_aggregates_last_rebuilt_at_idx" ON "review_aggregates" USING btree ("last_rebuilt_at");--> statement-breakpoint
CREATE UNIQUE INDEX "review_dimension_aggregates_aggregate_id_key_key" ON "review_dimension_aggregates" USING btree ("aggregate_id","key");--> statement-breakpoint
CREATE UNIQUE INDEX "review_dimensions_review_id_key_key" ON "review_dimensions" USING btree ("review_id","key");--> statement-breakpoint
CREATE UNIQUE INDEX "review_eligibilities_line_author_scope_key" ON "review_eligibilities" USING btree ("order_item_id","oxy_user_id","scope");--> statement-breakpoint
CREATE INDEX "review_eligibilities_oxy_user_id_state_created_at_idx" ON "review_eligibilities" USING btree ("oxy_user_id","state","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "review_eligibilities_scope_target_key_idx" ON "review_eligibilities" USING btree ("scope","target_key");--> statement-breakpoint
CREATE INDEX "review_eligibilities_order_id_idx" ON "review_eligibilities" USING btree ("order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "review_target_migrations_review_action_target_key" ON "review_target_migrations" USING btree ("review_id","action",coalesce("to_target_ref", ''));--> statement-breakpoint
CREATE INDEX "review_target_migrations_review_id_at_idx" ON "review_target_migrations" USING btree ("review_id","at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "review_target_migrations_action_at_idx" ON "review_target_migrations" USING btree ("action","at" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_canonical_product_id_canonical_products_id_fk" FOREIGN KEY ("canonical_product_id") REFERENCES "public"."canonical_products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_order_item_id_order_items_id_fk" FOREIGN KEY ("order_item_id") REFERENCES "public"."order_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_eligibility_id_review_eligibilities_id_fk" FOREIGN KEY ("eligibility_id") REFERENCES "public"."review_eligibilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "reviews_author_scope_target_key" ON "reviews" USING btree ("author_oxy_user_id","scope","target_key") WHERE "reviews"."scope" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "reviews_eligibility_id_key" ON "reviews" USING btree ("eligibility_id") WHERE "reviews"."eligibility_id" is not null;--> statement-breakpoint
CREATE INDEX "reviews_canonical_product_id_status_created_at_idx" ON "reviews" USING btree ("canonical_product_id","status","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "reviews_merchant_id_status_created_at_idx" ON "reviews" USING btree ("merchant_id","status","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "reviews_order_item_id_idx" ON "reviews" USING btree ("order_item_id");--> statement-breakpoint
CREATE INDEX "reviews_scope_target_key_status_idx" ON "reviews" USING btree ("scope","target_key","status");--> statement-breakpoint
CREATE INDEX "reviews_classification_state_created_at_idx" ON "reviews" USING btree ("classification_state","created_at");--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_scope_check" CHECK ("reviews"."scope" in ('product', 'merchant', 'native_transaction', 'p2p_listing', 'p2p_seller'));--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_verification_check" CHECK ("reviews"."verification" in ('verified_purchase', 'unverified'));--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_incentive_disclosure_check" CHECK ("reviews"."incentive_disclosure" in ('none', 'free_or_discounted_product', 'sweepstakes_entry', 'compensated', 'other'));--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_classification_state_check" CHECK ("reviews"."classification_state" in ('native', 'classified', 'unclassified', 'ambiguous'));--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_ambiguity_reason_check" CHECK ("reviews"."ambiguity_reason" in ('store_has_no_linked_merchant', 'listing_has_no_canonical_product', 'listing_no_longer_exists', 'split_requires_explicit_assignment'));--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_locale_shape_check" CHECK ("reviews"."locale" is null or "reviews"."locale" ~ '^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$');--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_scope_target_type_check" CHECK (case when "scope" is null
          then "target_type" in ('listing', 'store', 'seller')
          else "target_type" = case "scope"
            when 'product' then 'canonical_product'
            when 'merchant' then 'merchant'
            when 'native_transaction' then 'order_item'
            when 'p2p_listing' then 'listing'
            when 'p2p_seller' then 'seller'
          end
        end);--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_classification_consistency_check" CHECK (("reviews"."scope" is not null) = ("reviews"."classification_state" in ('native', 'classified'))
          and ("reviews"."ambiguity_reason" is not null) = ("reviews"."classification_state" = 'ambiguous'));--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_verification_evidence_check" CHECK (("reviews"."verification" = 'verified_purchase') = ("reviews"."eligibility_id" is not null));--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_target_type_check" CHECK ("reviews"."target_type" in ('listing', 'store', 'seller', 'canonical_product', 'merchant', 'order_item'));--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_target_exclusivity_check" CHECK (case
        when "scope" is not null then case "scope"
        when 'product' then "canonical_product_id" is not null and "listing_id" is null and "store_id" is null and "seller_oxy_user_id" is null and "merchant_id" is null and "order_item_id" is null
        when 'merchant' then "merchant_id" is not null and "listing_id" is null and "store_id" is null and "seller_oxy_user_id" is null and "canonical_product_id" is null and "order_item_id" is null
        when 'native_transaction' then "order_item_id" is not null and "listing_id" is null and "store_id" is null and "seller_oxy_user_id" is null and "canonical_product_id" is null and "merchant_id" is null
        when 'p2p_listing' then "listing_id" is not null and "store_id" is null and "seller_oxy_user_id" is null and "canonical_product_id" is null and "merchant_id" is null and "order_item_id" is null
        when 'p2p_seller' then "seller_oxy_user_id" is not null and "listing_id" is null and "store_id" is null and "canonical_product_id" is null and "merchant_id" is null and "order_item_id" is null
          else false
        end
        when "target_type" = 'listing' then "listing_id" is not null and "store_id" is null and "seller_oxy_user_id" is null and "canonical_product_id" is null and "merchant_id" is null and "order_item_id" is null
        when "target_type" = 'store' then "store_id" is not null and "listing_id" is null and "seller_oxy_user_id" is null and "canonical_product_id" is null and "merchant_id" is null and "order_item_id" is null
        when "target_type" = 'seller' then "seller_oxy_user_id" is not null and "listing_id" is null and "store_id" is null and "canonical_product_id" is null and "merchant_id" is null and "order_item_id" is null
        else false
      end);--> statement-breakpoint
--
-- `review_target_migrations` is APPEND-ONLY — the `order_fee_snapshots` and
-- `ledger_entries` posture, for the same reason. A review's scope history is the
-- only record of where a rating came from before a classification or a merge
-- moved it, and `reviews.scope` cannot answer that question because a rehome
-- overwrites it. A trigger and not a convention: the repository offers no update
-- and no delete, and this refuses one written by hand.
CREATE OR REPLACE FUNCTION mercaria_review_target_migration_append_only()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'review_target_migrations is append-only: % is not permitted', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER mercaria_review_target_migration_append_only
BEFORE UPDATE OR DELETE ON "review_target_migrations"
FOR EACH ROW EXECUTE FUNCTION mercaria_review_target_migration_append_only();
