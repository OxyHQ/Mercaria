-- oxy:deploy-phase=pre
-- oxy:rollback=derived
--
-- #367 step 7: navigation trees and the merchandising split (ADR 0007 D3,
-- following D11's migration protocol).
--
-- ADDITIVE THROUGHOUT, which is why the phase is `pre`. Five new tables nothing
-- yet writes, nine functions and eight triggers that fire only on those tables,
-- and NOT ONE statement that narrows, drops or renames anything the serving
-- image touches — verified by reading the generated half for DROP CONSTRAINT,
-- DROP COLUMN, DROP INDEX and DROP TABLE (zero of each) and by checking that
-- every ALTER TABLE targets a navigation table.
--
-- ## The hand-written half
--
-- NINE blocks, each anchored between a begin marker and its matching end marker.
-- `drizzle-kit` can model none of them, so a regeneration DROPS all nine:
-- re-apply them from this file, and verify the counts with
--
--   grep -cE '^-- oxy:handwritten-(begin|end)=' drizzle/0090_sad_black_panther.sql   -> 18
--
-- ## No comment here reproduces a marker or a separator AT LINE START
--
-- Two failures of exactly that shape were measured while writing this file, and
-- both are silent in the direction that matters:
--
--   * Drizzle's breakpoint separator quoted in prose SPLITS the file — the
--     migrator cuts on that literal string before anything parses a comment, so
--     the tail of the sentence applies as bare text. Cost: chunk count 18 -> 19,
--     a 42601 pointing at a line that reads as a comment, and a CASCADING 42883
--     naming a function that is perfectly correct.
--   * A begin marker quoted at the start of a comment line IS a begin marker to
--     any line-anchored reader, so the file had ten begins and nine ends.
--
-- Both invariants — `chunks == separators + 1`, and marker pairing walked as a
-- stack — are asserted against THIS file by `navigation-isolation.test.ts` on
-- every run.
--
-- Separators sit after each statement's terminating semicolon and never inside a
-- dollar-quoted body: the split precedes parsing, so one inside a body cuts the
-- function in two and every trigger depending on it fails as well.
CREATE TABLE "navigation_node_localizations" (
	"id" text PRIMARY KEY NOT NULL,
	"node_id" text NOT NULL,
	"locale" text NOT NULL,
	"label" text NOT NULL,
	"description" text,
	"accessibility_label" text,
	"status" text NOT NULL,
	"provenance" text NOT NULL,
	"source_locale" text,
	"source_revision" bigint,
	"reviewed_by_oxy_user_id" text,
	"reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "navigation_node_localizations_status_check" CHECK ("navigation_node_localizations"."status" in ('missing', 'machine_translated', 'reviewed', 'approved', 'stale', 'deprecated')),
	CONSTRAINT "navigation_node_localizations_provenance_check" CHECK ("navigation_node_localizations"."provenance" in ('mercaria', 'official_brand', 'professional', 'community_reviewed', 'machine', 'imported_source')),
	CONSTRAINT "navigation_node_localizations_locale_shape_check" CHECK ("navigation_node_localizations"."locale" = lower(btrim("navigation_node_localizations"."locale")) and "navigation_node_localizations"."locale" ~ '^[a-z]{2,3}(-[a-z0-9]{2,8})*$'),
	CONSTRAINT "navigation_node_localizations_source_locale_shape_check" CHECK ("navigation_node_localizations"."source_locale" is null or ("navigation_node_localizations"."source_locale" = lower(btrim("navigation_node_localizations"."source_locale")) and "navigation_node_localizations"."source_locale" ~ '^[a-z]{2,3}(-[a-z0-9]{2,8})*$')),
	CONSTRAINT "navigation_node_localizations_review_shape_check" CHECK (("navigation_node_localizations"."reviewed_at" is null) = ("navigation_node_localizations"."reviewed_by_oxy_user_id" is null)),
	CONSTRAINT "navigation_node_localizations_reviewed_status_check" CHECK ("navigation_node_localizations"."status" not in ('reviewed', 'approved') or "navigation_node_localizations"."reviewed_at" is not null),
	CONSTRAINT "navigation_node_localizations_label_check" CHECK (btrim("navigation_node_localizations"."label") <> '')
);
--> statement-breakpoint
CREATE TABLE "navigation_nodes" (
	"id" text PRIMARY KEY NOT NULL,
	"tree_id" text NOT NULL,
	"parent_id" text,
	"key" text NOT NULL,
	"position" integer NOT NULL,
	"target_kind" text NOT NULL,
	"category_id" text,
	"saved_query_id" text,
	"product_type_key" text,
	"brand_id" text,
	"product_family_id" text,
	"collection_id" text,
	"campaign_url" text,
	"visibility" text DEFAULT 'visible' NOT NULL,
	"visible_from" timestamp with time zone,
	"visible_to" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "navigation_nodes_target_kind_check" CHECK ("navigation_nodes"."target_kind" in ('category', 'saved_query', 'product_type', 'brand', 'product_family', 'collection', 'campaign')),
	CONSTRAINT "navigation_nodes_visibility_check" CHECK ("navigation_nodes"."visibility" in ('visible', 'hidden')),
	CONSTRAINT "navigation_nodes_target_shape_check" CHECK (("navigation_nodes"."target_kind" = 'category') = ("navigation_nodes"."category_id" is not null)
        and ("navigation_nodes"."target_kind" = 'saved_query') = ("navigation_nodes"."saved_query_id" is not null)
        and ("navigation_nodes"."target_kind" = 'product_type') = ("navigation_nodes"."product_type_key" is not null)
        and ("navigation_nodes"."target_kind" = 'brand') = ("navigation_nodes"."brand_id" is not null)
        and ("navigation_nodes"."target_kind" = 'product_family') = ("navigation_nodes"."product_family_id" is not null)
        and ("navigation_nodes"."target_kind" = 'collection') = ("navigation_nodes"."collection_id" is not null)
        and ("navigation_nodes"."target_kind" = 'campaign') = ("navigation_nodes"."campaign_url" is not null)
        and num_nonnulls("navigation_nodes"."category_id", "navigation_nodes"."saved_query_id", "navigation_nodes"."product_type_key", "navigation_nodes"."brand_id", "navigation_nodes"."product_family_id", "navigation_nodes"."collection_id", "navigation_nodes"."campaign_url") = 1),
	CONSTRAINT "navigation_nodes_campaign_url_check" CHECK ("navigation_nodes"."campaign_url" is null or "navigation_nodes"."campaign_url" like 'https://%'),
	CONSTRAINT "navigation_nodes_key_shape_check" CHECK (btrim("navigation_nodes"."key") <> ''),
	CONSTRAINT "navigation_nodes_position_check" CHECK ("navigation_nodes"."position" >= 0),
	CONSTRAINT "navigation_nodes_self_parent_check" CHECK ("navigation_nodes"."parent_id" <> "navigation_nodes"."id"),
	CONSTRAINT "navigation_nodes_visibility_window_check" CHECK ("navigation_nodes"."visible_to" is null or "navigation_nodes"."visible_from" is null or "navigation_nodes"."visible_to" > "navigation_nodes"."visible_from")
);
--> statement-breakpoint
CREATE TABLE "navigation_saved_queries" (
	"id" text PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"internal_label" text NOT NULL,
	"query_text" text,
	"category_id" text,
	"brand_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"merchant_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"condition_groups" text[] DEFAULT '{}'::text[] NOT NULL,
	"availability" text[] DEFAULT '{}'::text[] NOT NULL,
	"offer_kinds" text[] DEFAULT '{}'::text[] NOT NULL,
	"official_channel_only" boolean DEFAULT false NOT NULL,
	"market" text,
	"price_min_amount" bigint,
	"price_min_currency" text,
	"price_max_amount" bigint,
	"price_max_currency" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "navigation_saved_queries_price_min_currency_check" CHECK ("navigation_saved_queries"."price_min_currency" in ('FAIR', 'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF', 'CNY', 'SEK', 'NOK', 'DKK', 'PLN', 'MXN', 'BRL', 'INR', 'NZD', 'ZAR', 'SGD', 'HKD', 'AED')),
	CONSTRAINT "navigation_saved_queries_price_max_currency_check" CHECK ("navigation_saved_queries"."price_max_currency" in ('FAIR', 'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF', 'CNY', 'SEK', 'NOK', 'DKK', 'PLN', 'MXN', 'BRL', 'INR', 'NZD', 'ZAR', 'SGD', 'HKD', 'AED')),
	CONSTRAINT "navigation_saved_queries_condition_groups_check" CHECK ("navigation_saved_queries"."condition_groups" <@ array['new', 'open_box', 'refurbished', 'used', 'for_parts']::text[]),
	CONSTRAINT "navigation_saved_queries_availability_check" CHECK ("navigation_saved_queries"."availability" <@ array['in_stock', 'out_of_stock', 'preorder', 'unavailable', 'unknown']::text[]),
	CONSTRAINT "navigation_saved_queries_offer_kinds_check" CHECK ("navigation_saved_queries"."offer_kinds" <@ array['native', 'external', 'affiliate', 'informational']::text[]),
	CONSTRAINT "navigation_saved_queries_market_shape_check" CHECK ("navigation_saved_queries"."market" is null or ("navigation_saved_queries"."market" = upper(btrim("navigation_saved_queries"."market")) and "navigation_saved_queries"."market" ~ '^[A-Z]{2}$')),
	CONSTRAINT "navigation_saved_queries_key_shape_check" CHECK (btrim("navigation_saved_queries"."key") <> ''),
	CONSTRAINT "navigation_saved_queries_price_min_shape_check" CHECK (("navigation_saved_queries"."price_min_amount" is null) = ("navigation_saved_queries"."price_min_currency" is null)),
	CONSTRAINT "navigation_saved_queries_price_max_shape_check" CHECK (("navigation_saved_queries"."price_max_amount" is null) = ("navigation_saved_queries"."price_max_currency" is null)),
	CONSTRAINT "navigation_saved_queries_price_currency_agreement_check" CHECK ("navigation_saved_queries"."price_min_currency" is null or "navigation_saved_queries"."price_max_currency" is null or "navigation_saved_queries"."price_min_currency" = "navigation_saved_queries"."price_max_currency"),
	CONSTRAINT "navigation_saved_queries_price_range_check" CHECK ("navigation_saved_queries"."price_min_amount" is null or "navigation_saved_queries"."price_max_amount" is null or "navigation_saved_queries"."price_max_amount" >= "navigation_saved_queries"."price_min_amount"),
	CONSTRAINT "navigation_saved_queries_price_non_negative_check" CHECK (("navigation_saved_queries"."price_min_amount" is null or "navigation_saved_queries"."price_min_amount" >= 0) and ("navigation_saved_queries"."price_max_amount" is null or "navigation_saved_queries"."price_max_amount" >= 0))
);
--> statement-breakpoint
CREATE TABLE "navigation_saved_query_attribute_filters" (
	"id" text PRIMARY KEY NOT NULL,
	"saved_query_id" text NOT NULL,
	"attribute_key" text NOT NULL,
	"values" text[] DEFAULT '{}'::text[] NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "navigation_saved_query_attribute_filters_values_check" CHECK (cardinality("navigation_saved_query_attribute_filters"."values") >= 1),
	CONSTRAINT "navigation_saved_query_attribute_filters_key_check" CHECK (btrim("navigation_saved_query_attribute_filters"."attribute_key") <> ''),
	CONSTRAINT "navigation_saved_query_attribute_filters_position_check" CHECK ("navigation_saved_query_attribute_filters"."position" >= 0)
);
--> statement-breakpoint
CREATE TABLE "navigation_trees" (
	"id" text PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"version" integer NOT NULL,
	"market" text NOT NULL,
	"locale" text NOT NULL,
	"surface" text NOT NULL,
	"lifecycle" text DEFAULT 'draft' NOT NULL,
	"internal_label" text NOT NULL,
	"effective_from" timestamp with time zone,
	"effective_to" timestamp with time zone,
	"published_at" timestamp with time zone,
	"published_by_oxy_user_id" text,
	"supersedes_tree_id" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "navigation_trees_surface_check" CHECK ("navigation_trees"."surface" in ('header_menu', 'footer_menu', 'homepage_sections', 'category_rail', 'campaign_banner')),
	CONSTRAINT "navigation_trees_lifecycle_check" CHECK ("navigation_trees"."lifecycle" in ('draft', 'published', 'archived')),
	CONSTRAINT "navigation_trees_locale_shape_check" CHECK ("navigation_trees"."locale" = lower(btrim("navigation_trees"."locale")) and "navigation_trees"."locale" ~ '^[a-z]{2,3}(-[a-z0-9]{2,8})*$'),
	CONSTRAINT "navigation_trees_market_shape_check" CHECK ("navigation_trees"."market" = upper(btrim("navigation_trees"."market")) and "navigation_trees"."market" ~ '^[A-Z]{2}$'),
	CONSTRAINT "navigation_trees_key_shape_check" CHECK (btrim("navigation_trees"."key") <> ''),
	CONSTRAINT "navigation_trees_version_check" CHECK ("navigation_trees"."version" >= 1),
	CONSTRAINT "navigation_trees_window_check" CHECK ("navigation_trees"."effective_to" is null or "navigation_trees"."effective_from" is null or "navigation_trees"."effective_to" > "navigation_trees"."effective_from"),
	CONSTRAINT "navigation_trees_publication_shape_check" CHECK (("navigation_trees"."published_at" is null) = ("navigation_trees"."published_by_oxy_user_id" is null)),
	CONSTRAINT "navigation_trees_lifecycle_publication_check" CHECK (("navigation_trees"."lifecycle" = 'draft') = ("navigation_trees"."published_at" is null)),
	CONSTRAINT "navigation_trees_supersedes_self_check" CHECK ("navigation_trees"."supersedes_tree_id" <> "navigation_trees"."id")
);
--> statement-breakpoint
ALTER TABLE "navigation_node_localizations" ADD CONSTRAINT "navigation_node_localizations_node_id_navigation_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."navigation_nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "navigation_nodes" ADD CONSTRAINT "navigation_nodes_tree_id_navigation_trees_id_fk" FOREIGN KEY ("tree_id") REFERENCES "public"."navigation_trees"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "navigation_nodes" ADD CONSTRAINT "navigation_nodes_parent_id_navigation_nodes_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."navigation_nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "navigation_nodes" ADD CONSTRAINT "navigation_nodes_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "navigation_nodes" ADD CONSTRAINT "navigation_nodes_saved_query_id_navigation_saved_queries_id_fk" FOREIGN KEY ("saved_query_id") REFERENCES "public"."navigation_saved_queries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "navigation_nodes" ADD CONSTRAINT "navigation_nodes_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "navigation_nodes" ADD CONSTRAINT "navigation_nodes_product_family_id_canonical_product_families_id_fk" FOREIGN KEY ("product_family_id") REFERENCES "public"."canonical_product_families"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "navigation_nodes" ADD CONSTRAINT "navigation_nodes_collection_id_collections_id_fk" FOREIGN KEY ("collection_id") REFERENCES "public"."collections"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "navigation_saved_queries" ADD CONSTRAINT "navigation_saved_queries_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "navigation_saved_query_attribute_filters" ADD CONSTRAINT "navigation_saved_query_attribute_filters_saved_query_id_navigation_saved_queries_id_fk" FOREIGN KEY ("saved_query_id") REFERENCES "public"."navigation_saved_queries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "navigation_trees" ADD CONSTRAINT "navigation_trees_supersedes_tree_id_navigation_trees_id_fk" FOREIGN KEY ("supersedes_tree_id") REFERENCES "public"."navigation_trees"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "navigation_node_localizations_node_locale_key" ON "navigation_node_localizations" USING btree ("node_id","locale");--> statement-breakpoint
CREATE UNIQUE INDEX "navigation_nodes_tree_key_key" ON "navigation_nodes" USING btree ("tree_id","key");--> statement-breakpoint
CREATE UNIQUE INDEX "navigation_nodes_child_position_key" ON "navigation_nodes" USING btree ("tree_id","parent_id","position") WHERE "navigation_nodes"."parent_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "navigation_nodes_root_position_key" ON "navigation_nodes" USING btree ("tree_id","position") WHERE "navigation_nodes"."parent_id" is null;--> statement-breakpoint
CREATE INDEX "navigation_nodes_tree_parent_idx" ON "navigation_nodes" USING btree ("tree_id","parent_id","position");--> statement-breakpoint
CREATE INDEX "navigation_nodes_category_idx" ON "navigation_nodes" USING btree ("category_id");--> statement-breakpoint
CREATE INDEX "navigation_nodes_collection_idx" ON "navigation_nodes" USING btree ("collection_id");--> statement-breakpoint
CREATE UNIQUE INDEX "navigation_saved_queries_key_key" ON "navigation_saved_queries" USING btree ("key");--> statement-breakpoint
CREATE UNIQUE INDEX "navigation_saved_query_attribute_filters_key_key" ON "navigation_saved_query_attribute_filters" USING btree ("saved_query_id","attribute_key");--> statement-breakpoint
CREATE UNIQUE INDEX "navigation_trees_key_version_key" ON "navigation_trees" USING btree ("key","market","locale","version");--> statement-breakpoint
CREATE INDEX "navigation_trees_live_idx" ON "navigation_trees" USING btree ("market","locale","surface","lifecycle");--> statement-breakpoint
-- oxy:handwritten-begin=mercaria_navigation_freeze_tree_identity
CREATE OR REPLACE FUNCTION mercaria_navigation_freeze_tree_identity()
RETURNS trigger AS $$
BEGIN
  IF NEW.key IS DISTINCT FROM OLD.key
     OR NEW.market IS DISTINCT FROM OLD.market
     OR NEW.locale IS DISTINCT FROM OLD.locale
     OR NEW.surface IS DISTINCT FROM OLD.surface
     OR NEW.version IS DISTINCT FROM OLD.version THEN
    RAISE EXCEPTION
      'a navigation tree''s key, scope and version are frozen; publish a new version instead'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER mercaria_navigation_freeze_tree_identity
BEFORE UPDATE ON navigation_trees
FOR EACH ROW EXECUTE FUNCTION mercaria_navigation_freeze_tree_identity();
-- oxy:handwritten-end=mercaria_navigation_freeze_tree_identity
--> statement-breakpoint

-- oxy:handwritten-begin=mercaria_navigation_freeze_saved_query_key
CREATE OR REPLACE FUNCTION mercaria_navigation_freeze_saved_query_key()
RETURNS trigger AS $$
BEGIN
  IF NEW.key IS DISTINCT FROM OLD.key THEN
    RAISE EXCEPTION 'a saved query''s key is frozen after insert (ADR 0007 D1)'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER mercaria_navigation_freeze_saved_query_key
BEFORE UPDATE ON navigation_saved_queries
FOR EACH ROW EXECUTE FUNCTION mercaria_navigation_freeze_saved_query_key();
-- oxy:handwritten-end=mercaria_navigation_freeze_saved_query_key
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2. A published tree is immutable except for ENDING it.
--
-- Preview-then-publish only means something if the thing that was published
-- cannot change underneath the preview. What stays writable is `effective_to`
-- (a scheduled end is a decision taken after publication, and refusing it would
-- make "stop showing this on Sunday" impossible without deleting history) and
-- the lifecycle transition to `archived`.
--
-- Un-publishing is refused outright: a tree that shoppers saw is a fact, and a
-- draft it could be edited back into is a way to rewrite what they saw.
-- DELETE of anything but a draft is refused for the same reason.
-- ---------------------------------------------------------------------------
-- oxy:handwritten-begin=mercaria_navigation_published_tree_immutable
CREATE OR REPLACE FUNCTION mercaria_navigation_published_tree_immutable()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.lifecycle <> 'draft' THEN
      RAISE EXCEPTION 'a published or archived navigation tree is history and is not deletable'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.lifecycle = 'draft' THEN
    RETURN NEW;
  END IF;

  IF NEW.lifecycle = 'draft' THEN
    RAISE EXCEPTION 'a navigation tree cannot return to draft; publish a new version instead'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.internal_label IS DISTINCT FROM OLD.internal_label
     OR NEW.effective_from IS DISTINCT FROM OLD.effective_from
     OR NEW.published_at IS DISTINCT FROM OLD.published_at
     OR NEW.published_by_oxy_user_id IS DISTINCT FROM OLD.published_by_oxy_user_id
     OR NEW.supersedes_tree_id IS DISTINCT FROM OLD.supersedes_tree_id THEN
    RAISE EXCEPTION
      'only the end of a published navigation tree''s window may change; publish a new version'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER mercaria_navigation_published_tree_immutable
BEFORE UPDATE OR DELETE ON navigation_trees
FOR EACH ROW EXECUTE FUNCTION mercaria_navigation_published_tree_immutable();
-- oxy:handwritten-end=mercaria_navigation_published_tree_immutable
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 3. At most ONE live tree per (market, locale, surface), at any instant.
--
-- Not a partial unique index, and the reason is scheduling: the successor has to
-- EXIST, published, while the incumbent is still live. What must not overlap is
-- the WINDOW, and a unique index cannot say that.
--
-- Half-open interval comparison with infinities for the open ends, so a tree
-- ending exactly when the next begins is legal and produces no gap.
--
-- This trigger is a REFUSAL and not a mutual exclusion: two concurrent
-- publications can both pass it under READ COMMITTED. The publish path
-- therefore locks the surface's published rows `FOR UPDATE` first
-- (`navigationRepository.lockPublishedTreesForSurface`), and this is the check
-- that catches everything reaching the table by any other route.
-- ---------------------------------------------------------------------------
-- oxy:handwritten-begin=mercaria_navigation_tree_window_exclusion
CREATE OR REPLACE FUNCTION mercaria_navigation_tree_window_exclusion()
RETURNS trigger AS $$
BEGIN
  IF NEW.lifecycle <> 'published' THEN
    RETURN NEW;
  END IF;
  IF EXISTS (
    SELECT 1
    FROM navigation_trees other
    WHERE other.id <> NEW.id
      AND other.lifecycle = 'published'
      AND other.market = NEW.market
      AND other.locale = NEW.locale
      AND other.surface = NEW.surface
      AND coalesce(other.effective_from, '-infinity'::timestamptz)
            < coalesce(NEW.effective_to, 'infinity'::timestamptz)
      AND coalesce(NEW.effective_from, '-infinity'::timestamptz)
            < coalesce(other.effective_to, 'infinity'::timestamptz)
  ) THEN
    RAISE EXCEPTION
      'another navigation tree is already published for %/%/% over an overlapping window',
      NEW.market, NEW.locale, NEW.surface
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER mercaria_navigation_tree_window_exclusion
BEFORE INSERT OR UPDATE ON navigation_trees
FOR EACH ROW EXECUTE FUNCTION mercaria_navigation_tree_window_exclusion();
-- oxy:handwritten-end=mercaria_navigation_tree_window_exclusion
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 4. A published tree's CONTENT is frozen with it.
--
-- Freezing the tree row alone would leave every node and every label editable,
-- which is the same mutable menu with an extra step.
--
-- The ONE exception is a node's `visibility`: an incident lever that requires
-- republishing a whole menu is one nobody can pull at 3am. Everything else about
-- a published node — its target, its key, its position, its schedule — is a new
-- version.
--
-- A NULL lifecycle means the tree row is already gone, i.e. this delete is the
-- FK cascade of a draft tree's deletion. Allowing it is what keeps
-- `ON DELETE CASCADE` working; a draft tree is the only tree that can be
-- deleted at all (trigger 2).
--
-- TWO functions rather than one shared body reading `TG_TABLE_NAME`, and this
-- is not tidiness: plpgsql resolves a record's fields when it prepares the
-- expression containing them, so a single function mentioning both `NEW.tree_id`
-- and `NEW.node_id` raises "record NEW has no field" on whichever table it is
-- attached to — at RUNTIME, on the first write, not at creation.
-- ---------------------------------------------------------------------------
-- oxy:handwritten-begin=mercaria_navigation_tree_is_editable
CREATE OR REPLACE FUNCTION mercaria_navigation_tree_is_editable(subject_tree_id text)
RETURNS boolean AS $$
DECLARE
  tree_lifecycle text;
BEGIN
  SELECT lifecycle INTO tree_lifecycle FROM navigation_trees WHERE id = subject_tree_id;
  RETURN tree_lifecycle IS NULL OR tree_lifecycle = 'draft';
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
-- oxy:handwritten-end=mercaria_navigation_tree_is_editable
--> statement-breakpoint

-- oxy:handwritten-begin=mercaria_navigation_published_nodes_frozen
CREATE OR REPLACE FUNCTION mercaria_navigation_published_nodes_frozen()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF mercaria_navigation_tree_is_editable(OLD.tree_id) THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'a published navigation tree''s nodes cannot be deleted'
      USING ERRCODE = 'check_violation';
  END IF;

  IF mercaria_navigation_tree_is_editable(NEW.tree_id) THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE'
     AND NEW.tree_id IS NOT DISTINCT FROM OLD.tree_id
     AND NEW.parent_id IS NOT DISTINCT FROM OLD.parent_id
     AND NEW.key IS NOT DISTINCT FROM OLD.key
     AND NEW.position IS NOT DISTINCT FROM OLD.position
     AND NEW.target_kind IS NOT DISTINCT FROM OLD.target_kind
     AND NEW.category_id IS NOT DISTINCT FROM OLD.category_id
     AND NEW.saved_query_id IS NOT DISTINCT FROM OLD.saved_query_id
     AND NEW.product_type_key IS NOT DISTINCT FROM OLD.product_type_key
     AND NEW.brand_id IS NOT DISTINCT FROM OLD.brand_id
     AND NEW.product_family_id IS NOT DISTINCT FROM OLD.product_family_id
     AND NEW.collection_id IS NOT DISTINCT FROM OLD.collection_id
     AND NEW.campaign_url IS NOT DISTINCT FROM OLD.campaign_url
     AND NEW.visible_from IS NOT DISTINCT FROM OLD.visible_from
     AND NEW.visible_to IS NOT DISTINCT FROM OLD.visible_to THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION
    'a published navigation tree''s nodes are frozen; only a node''s visibility may change'
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER mercaria_navigation_published_nodes_frozen
BEFORE INSERT OR UPDATE OR DELETE ON navigation_nodes
FOR EACH ROW EXECUTE FUNCTION mercaria_navigation_published_nodes_frozen();
-- oxy:handwritten-end=mercaria_navigation_published_nodes_frozen
--> statement-breakpoint

-- oxy:handwritten-begin=mercaria_navigation_published_labels_frozen
CREATE OR REPLACE FUNCTION mercaria_navigation_published_labels_frozen()
RETURNS trigger AS $$
DECLARE
  subject_tree_id text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    SELECT tree_id INTO subject_tree_id FROM navigation_nodes WHERE id = OLD.node_id;
    IF subject_tree_id IS NULL OR mercaria_navigation_tree_is_editable(subject_tree_id) THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'a published navigation tree''s labels cannot be deleted'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT tree_id INTO subject_tree_id FROM navigation_nodes WHERE id = NEW.node_id;
  IF subject_tree_id IS NULL OR mercaria_navigation_tree_is_editable(subject_tree_id) THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'a published navigation tree''s labels are frozen; publish a new version'
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER mercaria_navigation_published_labels_frozen
BEFORE INSERT OR UPDATE OR DELETE ON navigation_node_localizations
FOR EACH ROW EXECUTE FUNCTION mercaria_navigation_published_labels_frozen();
-- oxy:handwritten-end=mercaria_navigation_published_labels_frozen
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 5. A tree is a TREE: no cycle, no cross-tree parent, and a bounded depth.
--
-- Self-parenting is already refused by `navigation_nodes_self_parent_check` —
-- the one cycle a CHECK can see, refused there so the cheapest case needs no
-- walk. Everything longer needs the parent chain, and a foreign key can say the
-- parent EXISTS while saying nothing about which tree it is in.
--
-- The depth bound is checked in BOTH directions, and the second is the one that
-- is easy to miss: re-parenting a node deeper moves its whole SUBTREE with it,
-- so the ancestors above the moved node and the height below it are added
-- together. Checking only the ancestors admits a five-deep subtree grafted onto
-- a five-deep branch.
--
-- 6 is `NAVIGATION_MAX_DEPTH` in `@mercaria/shared-types`. A hand-written
-- trigger cannot read a TypeScript constant, so `navigation-isolation.test.ts`
-- asserts this file contains the same number the constant does — the two agree
-- because a test says so, not because somebody remembered.
-- ---------------------------------------------------------------------------
-- oxy:handwritten-begin=mercaria_navigation_node_acyclic
CREATE OR REPLACE FUNCTION mercaria_navigation_node_acyclic()
RETURNS trigger AS $$
DECLARE
  parent_tree_id text;
  walker text;
  next_walker text;
  hops integer := 0;
  subtree_height integer := 0;
BEGIN
  IF NEW.parent_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT tree_id INTO parent_tree_id FROM navigation_nodes WHERE id = NEW.parent_id;
  IF parent_tree_id IS DISTINCT FROM NEW.tree_id THEN
    RAISE EXCEPTION 'a navigation node''s parent must belong to the same tree'
      USING ERRCODE = 'check_violation';
  END IF;

  walker := NEW.parent_id;
  WHILE walker IS NOT NULL LOOP
    IF walker = NEW.id THEN
      RAISE EXCEPTION 'a navigation node cannot be its own ancestor'
        USING ERRCODE = 'check_violation';
    END IF;
    hops := hops + 1;
    IF hops >= 6 THEN
      RAISE EXCEPTION 'a navigation tree may not be deeper than 6 levels'
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT parent_id INTO next_walker FROM navigation_nodes WHERE id = walker;
    walker := next_walker;
  END LOOP;

  WITH RECURSIVE descendants(id, height) AS (
    SELECT NEW.id, 0
    UNION ALL
    SELECT child.id, descendants.height + 1
    FROM navigation_nodes child
    JOIN descendants ON child.parent_id = descendants.id
    WHERE descendants.height < 6
  )
  SELECT max(height) INTO subtree_height FROM descendants;

  IF hops + coalesce(subtree_height, 0) >= 6 THEN
    RAISE EXCEPTION 'moving this navigation subtree would take it past 6 levels'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER mercaria_navigation_node_acyclic
BEFORE INSERT OR UPDATE ON navigation_nodes
FOR EACH ROW EXECUTE FUNCTION mercaria_navigation_node_acyclic();
-- oxy:handwritten-end=mercaria_navigation_node_acyclic
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 6. Machine translation may never overwrite reviewed or approved text
--    (ADR 0007 D4).
--
-- A trigger rather than a service check, and D4 says why: a service-level check
-- is one forgotten call site away from silently degrading a human's work, and
-- the degradation is invisible — the label still renders, in the right language,
-- slightly wrong.
--
-- The refusal is on the INCOMING provenance landing on a row already at those
-- statuses. Marking such a row `stale` is explicitly still allowed, because D4
-- requires a source change to mark dependents stale rather than blank them.
-- ---------------------------------------------------------------------------
-- oxy:handwritten-begin=mercaria_navigation_localization_review_protected
CREATE OR REPLACE FUNCTION mercaria_navigation_localization_review_protected()
RETURNS trigger AS $$
BEGIN
  IF OLD.status IN ('reviewed', 'approved')
     AND NEW.provenance = 'machine'
     AND (NEW.label IS DISTINCT FROM OLD.label
          OR NEW.description IS DISTINCT FROM OLD.description
          OR NEW.accessibility_label IS DISTINCT FROM OLD.accessibility_label) THEN
    RAISE EXCEPTION
      'machine translation cannot overwrite reviewed or approved navigation copy (ADR 0007 D4)'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER mercaria_navigation_localization_review_protected
BEFORE UPDATE ON navigation_node_localizations
FOR EACH ROW EXECUTE FUNCTION mercaria_navigation_localization_review_protected();
-- oxy:handwritten-end=mercaria_navigation_localization_review_protected
