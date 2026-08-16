-- oxy:deploy-phase=pre
--
-- #367 step 1: taxonomy identity, lifecycle, aliases and redirects
-- (ADR 0007 D1/D2/D11/D13).
--
-- ADDITIVE THROUGHOUT, which is why the phase is `pre`. Three new tables that
-- nothing yet writes, seven new columns on `categories`, and no statement here
-- narrows or drops anything the previously serving image reads or writes.
--
-- ## The one statement that deserves the phase argument spelled out
--
-- `categories.key` arrives NOT NULL. Applied against a serving image that does
-- not know the column, that would break any INSERT into `categories` — and the
-- previously serving image performs exactly two, both from OPERATOR SCRIPTS
-- (`src/scripts/provision-taxonomy.ts` and `src/scripts/seed.ts`) and neither
-- from a request path. `categories` is read-mostly and no route writes it.
--
-- So the failure this admits is an operator running the OLD image's
-- `provision-taxonomy.ts` during the rollout window: it fails loudly on the
-- first insert, is idempotent, and leaves nothing half-done. That is the trade
-- being made, and it is made deliberately — the alternative is two migrations
-- and a release in between for a column no request path can write.
--
-- ## `is_active` keeps its own value, and is NOT yet constrained to `lifecycle`
--
-- ADR 0007 D2 makes `is_active` a derived read of `lifecycle`, applied by
-- `db/taxonomy/taxonomyRepository.ts`. A `categories_is_active_derived_check`
-- stating that at the row, or a GENERATED column, would break the serving
-- image's own `is_active` writes — so both are `post`-phase and are NOT here.
-- The follow-up, for whoever writes the `post` migration:
--
--   ALTER TABLE categories ADD CONSTRAINT categories_is_active_derived_check
--     CHECK (is_active = (lifecycle = 'published'));
--
-- Until then `db/__tests__/taxonomy-write-chokepoint.test.ts` is what holds it:
-- one writer, deriving it in one place.
--
-- ## Hand-written blocks
--
-- SEVEN, each anchored between `-- oxy:handwritten-begin=<name>` and its
-- matching `-- oxy:handwritten-end=<name>`. A regeneration DROPS all seven and
-- also rewrites `ADD COLUMN "key" text` back to `... NOT NULL`; re-apply them,
-- re-split that statement, and then READ the regenerated file for statements
-- you did not intend rather than only checking that yours came back.
--
--   1. categories_backfill                     (key, ancestor_ids, lifecycle)
--   2. categories_key_not_null                 (after the backfill, never before)
--   3. mercaria_category_key_frozen
--   4. mercaria_category_hierarchy_guard       (cycles, merge-into-descendant)
--   5. mercaria_category_redirects_append_only
--   6. mercaria_category_redirect_cycle_guard
--   7. mercaria_category_assignment_selectable (listings, canonical_products)
--
-- Self-check after any regeneration, from the repo root:
--   grep -c '^-- oxy:deploy-phase' packages/backend/drizzle/0088_redundant_korvac.sql   -> 1
--   grep -c '^-- oxy:handwritten-begin=' packages/backend/drizzle/0088_redundant_korvac.sql -> 7
--   grep -c '^-- oxy:handwritten-end=' packages/backend/drizzle/0088_redundant_korvac.sql   -> 7
-- (line-anchored, or the two prose mentions above count as anchors themselves)
--
CREATE TABLE "category_aliases" (
	"id" text PRIMARY KEY NOT NULL,
	"category_id" text NOT NULL,
	"locale" text NOT NULL,
	"alias" text NOT NULL,
	"normalized_alias" text NOT NULL,
	"kind" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "category_aliases_kind_check" CHECK ("category_aliases"."kind" in ('synonym', 'search_term', 'legacy_name', 'external_label', 'misspelling')),
	CONSTRAINT "category_aliases_alias_present_check" CHECK (length(btrim("category_aliases"."alias")) > 0),
	CONSTRAINT "category_aliases_normalized_present_check" CHECK (length(btrim("category_aliases"."normalized_alias")) > 0),
	CONSTRAINT "category_aliases_locale_present_check" CHECK (length(btrim("category_aliases"."locale")) > 0)
);
--> statement-breakpoint
CREATE TABLE "category_external_mappings" (
	"id" text PRIMARY KEY NOT NULL,
	"source_id" text NOT NULL,
	"external_key" text NOT NULL,
	"category_id" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"confidence" double precision,
	"review_state" text DEFAULT 'unreviewed' NOT NULL,
	"reviewed_by_oxy_user_id" text,
	"reviewed_at" timestamp with time zone,
	"valid_from" timestamp with time zone DEFAULT now() NOT NULL,
	"valid_to" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "category_external_mappings_review_state_check" CHECK ("category_external_mappings"."review_state" in ('unreviewed', 'approved', 'rejected', 'superseded')),
	CONSTRAINT "category_external_mappings_confidence_range_check" CHECK ("category_external_mappings"."confidence" is null or ("category_external_mappings"."confidence" >= 0 and "category_external_mappings"."confidence" <= 1)),
	CONSTRAINT "category_external_mappings_version_check" CHECK ("category_external_mappings"."version" >= 1),
	CONSTRAINT "category_external_mappings_validity_check" CHECK ("category_external_mappings"."valid_to" is null or "category_external_mappings"."valid_to" > "category_external_mappings"."valid_from"),
	CONSTRAINT "category_external_mappings_reviewed_at_check" CHECK (("category_external_mappings"."review_state" in ('approved', 'rejected')) = ("category_external_mappings"."reviewed_at" is not null)),
	CONSTRAINT "category_external_mappings_reviewer_check" CHECK (("category_external_mappings"."review_state" in ('approved', 'rejected')) = ("category_external_mappings"."reviewed_by_oxy_user_id" is not null)),
	CONSTRAINT "category_external_mappings_external_key_present_check" CHECK (length(btrim("category_external_mappings"."external_key")) > 0)
);
--> statement-breakpoint
CREATE TABLE "category_redirects" (
	"id" text PRIMARY KEY NOT NULL,
	"subject_kind" text NOT NULL,
	"subject_category_id" text,
	"subject_locale" text,
	"subject_slug" text,
	"target_category_id" text NOT NULL,
	"reason" text NOT NULL,
	"effective_from" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "category_redirects_subject_kind_check" CHECK ("category_redirects"."subject_kind" in ('category_id', 'localized_slug')),
	CONSTRAINT "category_redirects_reason_check" CHECK ("category_redirects"."reason" in ('merged', 'deprecated', 'renamed', 'reparented', 'operator')),
	CONSTRAINT "category_redirects_subject_category_shape_check" CHECK (("category_redirects"."subject_kind" = 'category_id') = ("category_redirects"."subject_category_id" is not null)),
	CONSTRAINT "category_redirects_subject_slug_shape_check" CHECK (("category_redirects"."subject_kind" = 'localized_slug') = ("category_redirects"."subject_slug" is not null)),
	CONSTRAINT "category_redirects_subject_locale_shape_check" CHECK (("category_redirects"."subject_kind" = 'localized_slug') = ("category_redirects"."subject_locale" is not null)),
	CONSTRAINT "category_redirects_not_self_check" CHECK ("category_redirects"."subject_category_id" is distinct from "category_redirects"."target_category_id")
);
--> statement-breakpoint
ALTER TABLE "categories" ADD COLUMN "key" text;--> statement-breakpoint
ALTER TABLE "categories" ADD COLUMN "ancestor_ids" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "categories" ADD COLUMN "lifecycle" text DEFAULT 'published' NOT NULL;--> statement-breakpoint
ALTER TABLE "categories" ADD COLUMN "selectable" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "categories" ADD COLUMN "merged_into_category_id" text;--> statement-breakpoint
ALTER TABLE "categories" ADD COLUMN "effective_from" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "categories" ADD COLUMN "effective_to" timestamp with time zone;--> statement-breakpoint
-- oxy:handwritten-begin=categories_backfill
-- Every pre-#367 row gets its three new facts, BEFORE the CHECKs and the unique
-- index below can see them. The order within this block is load-bearing in the
-- other direction too: `ancestor_ids` is derived from `ancestor_slugs`, which is
-- the only ancestry these rows have.
--
-- `key` is the row's own slug PATH, lower-cased and joined by dots, with no
-- other transformation. That derivation is repeated verbatim in
-- `src/scripts/taxonomy.ts`, which carries the same 36 keys as literals — so a
-- restored production database and a freshly seeded developer one hold the same
-- key for the same shelf. It is also the ONLY handle these rows have that is
-- stable enough to derive an identity from; every category created after this
-- migration gets a key somebody chose.
UPDATE "categories"
SET "key" = lower(array_to_string("ancestor_slugs" || "slug", '.'))
WHERE "key" IS NULL;--> statement-breakpoint

-- A malformed derived key would otherwise surface as an opaque
-- `categories_key_format_check` violation naming no row. This names the slugs,
-- and refuses rather than sanitising: a silently rewritten identity is the one
-- outcome worse than a migration that stops.
DO $$
DECLARE
  offenders text;
BEGIN
  SELECT string_agg("slug", ', ' ORDER BY "slug") INTO offenders
  FROM "categories"
  WHERE "key" !~ '^[a-z0-9][a-z0-9_-]*([.][a-z0-9][a-z0-9_-]*)*$';
  IF offenders IS NOT NULL THEN
    RAISE EXCEPTION
      'These categories have slug paths that are not valid machine keys: %. Give them a `key` by hand before applying this migration (ADR 0007 D1).',
      offenders;
  END IF;
END;
$$;--> statement-breakpoint

-- `ancestor_ids`, resolved from `ancestor_slugs` position by position. `WITH
-- ORDINALITY` is what keeps the two paths in the same order, which is what lets
-- the repository treat one position in either array as one ancestor.
UPDATE "categories" AS c
SET "ancestor_ids" = coalesce((
  SELECT array_agg(a."id" ORDER BY u.ord)
  FROM unnest(c."ancestor_slugs") WITH ORDINALITY AS u(slug, ord)
  JOIN "categories" AS a ON a."slug" = u.slug
), '{}'::text[])
WHERE cardinality(c."ancestor_slugs") > 0;--> statement-breakpoint

-- The backfill's positive control. An ancestor slug naming no row is dropped
-- SILENTLY by `array_agg`, which produces a shorter `ancestor_ids` than
-- `ancestor_slugs` — a subtree whose descendant reads would quietly miss a
-- level, with nothing failing. Length equality is the cheapest statement that
-- distinguishes "resolved every ancestor" from "resolved some of them".
DO $$
DECLARE
  broken text;
BEGIN
  SELECT string_agg("slug", ', ' ORDER BY "slug") INTO broken
  FROM "categories"
  WHERE cardinality("ancestor_ids") <> cardinality("ancestor_slugs");
  IF broken IS NOT NULL THEN
    RAISE EXCEPTION
      'These categories have an `ancestor_slugs` entry naming no row, so their `ancestor_ids` could not be derived: %.',
      broken;
  END IF;
END;
$$;--> statement-breakpoint

-- `lifecycle`, from the only fact the old schema recorded. `suppressed` rather
-- than `deprecated` or `draft`: `is_active = false` means an operator withheld
-- the category from the shopper-visible tree while it stayed resolvable and
-- assignable — which is exactly `suppressed`, and is what the connector's
-- `imported` holding pen is. `deprecated` would imply a successor and `draft`
-- would imply it had never been published; the column cannot tell us either.
UPDATE "categories"
SET "lifecycle" = CASE WHEN "is_active" THEN 'published' ELSE 'suppressed' END;
-- oxy:handwritten-end=categories_backfill
--> statement-breakpoint
-- oxy:handwritten-begin=categories_key_not_null
ALTER TABLE "categories" ALTER COLUMN "key" SET NOT NULL;
-- oxy:handwritten-end=categories_key_not_null
--> statement-breakpoint
ALTER TABLE "category_aliases" ADD CONSTRAINT "category_aliases_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "category_external_mappings" ADD CONSTRAINT "category_external_mappings_source_id_catalog_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."catalog_sources"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "category_external_mappings" ADD CONSTRAINT "category_external_mappings_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "category_redirects" ADD CONSTRAINT "category_redirects_subject_category_id_categories_id_fk" FOREIGN KEY ("subject_category_id") REFERENCES "public"."categories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "category_redirects" ADD CONSTRAINT "category_redirects_target_category_id_categories_id_fk" FOREIGN KEY ("target_category_id") REFERENCES "public"."categories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "category_aliases_category_locale_normalized_key" ON "category_aliases" USING btree ("category_id","locale","normalized_alias");--> statement-breakpoint
CREATE INDEX "category_aliases_lookup_idx" ON "category_aliases" USING btree ("locale","normalized_alias");--> statement-breakpoint
CREATE UNIQUE INDEX "category_external_mappings_version_key" ON "category_external_mappings" USING btree ("source_id","external_key","version");--> statement-breakpoint
CREATE UNIQUE INDEX "category_external_mappings_current_key" ON "category_external_mappings" USING btree ("source_id","external_key") WHERE "category_external_mappings"."valid_to" is null;--> statement-breakpoint
CREATE INDEX "category_external_mappings_category_idx" ON "category_external_mappings" USING btree ("category_id");--> statement-breakpoint
CREATE UNIQUE INDEX "category_redirects_subject_category_key" ON "category_redirects" USING btree ("subject_category_id") WHERE "category_redirects"."subject_kind" = 'category_id';--> statement-breakpoint
CREATE UNIQUE INDEX "category_redirects_subject_slug_key" ON "category_redirects" USING btree ("subject_locale","subject_slug") WHERE "category_redirects"."subject_kind" = 'localized_slug';--> statement-breakpoint
CREATE INDEX "category_redirects_target_idx" ON "category_redirects" USING btree ("target_category_id");--> statement-breakpoint
ALTER TABLE "categories" ADD CONSTRAINT "categories_merged_into_category_id_categories_id_fk" FOREIGN KEY ("merged_into_category_id") REFERENCES "public"."categories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "categories_key_key" ON "categories" USING btree ("key");--> statement-breakpoint
CREATE INDEX "categories_ancestor_ids_idx" ON "categories" USING gin ("ancestor_ids");--> statement-breakpoint
ALTER TABLE "categories" ADD CONSTRAINT "categories_lifecycle_check" CHECK ("categories"."lifecycle" in ('draft', 'published', 'deprecated', 'merged', 'suppressed'));--> statement-breakpoint
ALTER TABLE "categories" ADD CONSTRAINT "categories_key_format_check" CHECK ("categories"."key" ~ '^[a-z0-9][a-z0-9_-]*([.][a-z0-9][a-z0-9_-]*)*$');--> statement-breakpoint
ALTER TABLE "categories" ADD CONSTRAINT "categories_merged_into_check" CHECK (("categories"."merged_into_category_id" is not null) = ("categories"."lifecycle" = 'merged'));--> statement-breakpoint
ALTER TABLE "categories" ADD CONSTRAINT "categories_parent_not_self_check" CHECK ("categories"."parent_id" is distinct from "categories"."id");--> statement-breakpoint
ALTER TABLE "categories" ADD CONSTRAINT "categories_merged_into_not_self_check" CHECK ("categories"."merged_into_category_id" is distinct from "categories"."id");--> statement-breakpoint
ALTER TABLE "categories" ADD CONSTRAINT "categories_effective_window_check" CHECK ("categories"."effective_to" is null or "categories"."effective_from" is null or "categories"."effective_to" > "categories"."effective_from");

--> statement-breakpoint
-- oxy:handwritten-begin=mercaria_category_key_frozen
-- `categories.key` is frozen after insert (ADR 0007 D1).
--
-- A renamed key is indistinguishable from a different concept to every seed,
-- fixture, external mapping and export that cited it — so a category whose key
-- was wrong is deprecated and superseded, never renamed. `is distinct from`
-- rather than `<>`: a plain comparison against a NULL yields NULL and the check
-- would silently pass.
CREATE OR REPLACE FUNCTION mercaria_category_key_frozen()
RETURNS trigger AS $$
BEGIN
  IF NEW.key IS DISTINCT FROM OLD.key THEN
    RAISE EXCEPTION
      'categories.key is frozen after insert (ADR 0007 D1): % -> %. Deprecate this category and supersede it rather than renaming its key.',
      OLD.key, NEW.key
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER mercaria_category_key_frozen
BEFORE UPDATE ON "categories"
FOR EACH ROW EXECUTE FUNCTION mercaria_category_key_frozen();
-- oxy:handwritten-end=mercaria_category_key_frozen
--> statement-breakpoint
-- oxy:handwritten-begin=mercaria_category_hierarchy_guard
-- What the TREE says, which a CHECK cannot: a cycle through `parent_id`, and a
-- merge whose target is one of the merging category's own descendants.
--
-- What ONE ROW says about itself is already two CHECKs —
-- `categories_parent_not_self_check` and `categories_merged_into_not_self_check`
-- — so this walks chains of length two and up, and never repeats them.
--
-- The depth bound is what keeps a database somebody restored badly from hanging
-- the statement rather than failing it. It is unreachable on data this code
-- wrote, because the walk below is what prevents the loop that would reach it.
CREATE OR REPLACE FUNCTION mercaria_category_hierarchy_guard()
RETURNS trigger AS $$
DECLARE
  walker text;
  depth integer;
BEGIN
  -- Self-parenting and self-merging are the two SAME-ROW facts, and they are
  -- `categories_parent_not_self_check` and `categories_merged_into_not_self_check`.
  -- A CHECK is cheaper, and — unlike a trigger — cannot be stood down by an
  -- `alter table … disable trigger` window. Reporting them here as cycles would
  -- pre-empt both CHECKs, leaving them unreachable and therefore untestable:
  -- a constraint nothing can ever violate is indistinguishable from one that
  -- does not work. So this returns and lets the CHECK do it.
  IF NEW.parent_id = NEW.id OR NEW.merged_into_category_id = NEW.id THEN
    RETURN NEW;
  END IF;

  IF NEW.parent_id IS NOT NULL THEN
    walker := NEW.parent_id;
    depth := 0;
    WHILE walker IS NOT NULL LOOP
      IF walker = NEW.id THEN
        RAISE EXCEPTION
          'category % cannot be parented under % — that closes a cycle (ADR 0007 D2).',
          NEW.id, NEW.parent_id
          USING ERRCODE = 'restrict_violation';
      END IF;
      depth := depth + 1;
      IF depth > 64 THEN
        RAISE EXCEPTION
          'the parent chain above category % is more than 64 levels deep; refusing to walk further.',
          NEW.id
          USING ERRCODE = 'restrict_violation';
      END IF;
      SELECT parent_id INTO walker FROM categories WHERE id = walker;
    END LOOP;
  END IF;

  IF NEW.merged_into_category_id IS NOT NULL THEN
    walker := NEW.merged_into_category_id;
    depth := 0;
    WHILE walker IS NOT NULL LOOP
      IF walker = NEW.id THEN
        RAISE EXCEPTION
          'category % cannot be merged into % — the target is one of its own descendants, so the merge would point the subtree at itself (ADR 0007 D2).',
          NEW.id, NEW.merged_into_category_id
          USING ERRCODE = 'restrict_violation';
      END IF;
      depth := depth + 1;
      IF depth > 64 THEN
        RAISE EXCEPTION
          'the parent chain above category % is more than 64 levels deep; refusing to walk further.',
          NEW.merged_into_category_id
          USING ERRCODE = 'restrict_violation';
      END IF;
      SELECT parent_id INTO walker FROM categories WHERE id = walker;
    END LOOP;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER mercaria_category_hierarchy_guard_insert
BEFORE INSERT ON "categories"
FOR EACH ROW EXECUTE FUNCTION mercaria_category_hierarchy_guard();--> statement-breakpoint
-- TWO triggers over one function, and the UPDATE one carries a `WHEN`: a move
-- rewrites every descendant's ancestry arrays in one statement, and without the
-- guard each of those rows would walk its own parent chain for a column the
-- statement never touched.
CREATE TRIGGER mercaria_category_hierarchy_guard_update
BEFORE UPDATE ON "categories"
FOR EACH ROW
WHEN (NEW.parent_id IS DISTINCT FROM OLD.parent_id
      OR NEW.merged_into_category_id IS DISTINCT FROM OLD.merged_into_category_id)
EXECUTE FUNCTION mercaria_category_hierarchy_guard();
-- oxy:handwritten-end=mercaria_category_hierarchy_guard
--> statement-breakpoint
-- oxy:handwritten-begin=mercaria_category_redirects_append_only
-- `category_redirects` is APPEND-ONLY against UPDATE *and* DELETE (ADR 0007 D2).
--
-- A redirect is the record that a handle stopped naming what it used to. One
-- UPDATE makes that record say it always named the new thing, which is the one
-- edit that would make the history unreadable. A redirect pointing at the wrong
-- category is corrected by a redirect FROM that wrong target onward, which the
-- resolver follows.
--
-- DELETE is refused too, unlike the tables `db/expiryTargets.ts` sweeps: nothing
-- expires a redirect, and a URL that resolved last year should resolve today.
CREATE OR REPLACE FUNCTION mercaria_category_redirects_append_only()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'category_redirects is append-only (%)', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER mercaria_category_redirects_append_only
BEFORE UPDATE OR DELETE ON "category_redirects"
FOR EACH ROW EXECUTE FUNCTION mercaria_category_redirects_append_only();
-- oxy:handwritten-end=mercaria_category_redirects_append_only
--> statement-breakpoint
-- oxy:handwritten-begin=mercaria_category_redirect_cycle_guard
-- A redirect chain that closes on itself never terminates.
--
-- CYCLES are refused absolutely: closing a loop means the closing insert's own
-- forward walk traverses the whole loop and meets its subject, whatever the
-- loop's length.
--
-- The hop bound is a SECOND, WEAKER thing, and the difference is worth stating
-- because the obvious reading is wrong. It bounds only the chain this insert
-- can see AHEAD of its target. It does NOT bound the chain BEHIND the subject —
-- and the documented correction pattern extends a chain at the TAIL, where the
-- new target is a fresh category whose forward walk is one hop. So nine
-- redirects added one at a time, each individually legitimate and each passing
-- this trigger, build a chain of nine and the trigger never sees it.
--
-- Bounding the real depth would mean walking BACKWARD from the subject, and
-- backward is a fan-in: one category is the target of any number of redirects,
-- so it is a tree traversal on every insert rather than a linear walk. That
-- cost is not paid. `resolveCategoryRedirect` answers `chain_exhausted` instead
-- — carrying no category, because the alternative is reporting a
-- still-redirected one in a response shaped exactly like a resolution.
--
-- Only a `category_id` subject can participate: a localized slug is never a
-- redirect TARGET, so a slug row can begin a chain and can never continue one.
CREATE OR REPLACE FUNCTION mercaria_category_redirect_cycle_guard()
RETURNS trigger AS $$
DECLARE
  walker text;
  hops integer := 0;
BEGIN
  IF NEW.subject_kind <> 'category_id' THEN
    RETURN NEW;
  END IF;

  walker := NEW.target_category_id;
  WHILE walker IS NOT NULL LOOP
    IF walker = NEW.subject_category_id THEN
      RAISE EXCEPTION
        'redirecting category % to % closes a redirect cycle (ADR 0007 D2).',
        NEW.subject_category_id, NEW.target_category_id
        USING ERRCODE = 'restrict_violation';
    END IF;
    hops := hops + 1;
    IF hops > 8 THEN
      RAISE EXCEPTION
        'redirecting category % to % would make a chain longer than 8 hops, which the resolver will not follow. Point it at the chain''s end instead.',
        NEW.subject_category_id, NEW.target_category_id
        USING ERRCODE = 'restrict_violation';
    END IF;
    SELECT target_category_id INTO walker
    FROM category_redirects
    WHERE subject_kind = 'category_id' AND subject_category_id = walker;
  END LOOP;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER mercaria_category_redirect_cycle_guard
BEFORE INSERT ON "category_redirects"
FOR EACH ROW EXECUTE FUNCTION mercaria_category_redirect_cycle_guard();
-- oxy:handwritten-end=mercaria_category_redirect_cycle_guard
--> statement-breakpoint
-- oxy:handwritten-begin=mercaria_category_assignment_selectable
-- A product may not be filed under a structural node (ADR 0007 D2).
--
-- ADR 0007 D2 calls this "a CHECK on the assignment"; a CHECK may not read
-- another row, so it is a trigger — the same resolution the ADR itself reaches
-- one paragraph later for cycles. It reads `categories.selectable`, which is a
-- fact about a DIFFERENT row from the one being written.
--
-- TWO tables and one function: `listings.category_id` is a seller filing a
-- product, `canonical_products.category_id` is the catalogue filing one.
-- `canonical_product_families.category_id` is deliberately NOT covered — a
-- family is itself a grouping, and classifying one under a grouping level is
-- the legitimate case `selectable = false` exists to describe.
--
-- `UPDATE OF category_id` and a `WHEN`, so an ordinary listing write — a status
-- change, a price change, a facet resync — never reaches this at all.
CREATE OR REPLACE FUNCTION mercaria_category_assignment_selectable()
RETURNS trigger AS $$
DECLARE
  target_selectable boolean;
BEGIN
  SELECT selectable INTO target_selectable FROM categories WHERE id = NEW.category_id;

  -- A category that does not exist is the foreign key's refusal to make, not
  -- this trigger's; NULL here means "no row", and reporting it as unselectable
  -- would answer a missing-category error with a misleading message.
  IF target_selectable IS NOT NULL AND target_selectable = false THEN
    RAISE EXCEPTION
      '%.category_id cannot name category %: it is a structural node and is not selectable (ADR 0007 D2).',
      TG_TABLE_NAME, NEW.category_id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER mercaria_category_assignment_selectable
BEFORE INSERT OR UPDATE OF category_id ON "listings"
FOR EACH ROW WHEN (NEW.category_id IS NOT NULL)
EXECUTE FUNCTION mercaria_category_assignment_selectable();--> statement-breakpoint
CREATE TRIGGER mercaria_category_assignment_selectable
BEFORE INSERT OR UPDATE OF category_id ON "canonical_products"
FOR EACH ROW WHEN (NEW.category_id IS NOT NULL)
EXECUTE FUNCTION mercaria_category_assignment_selectable();
-- oxy:handwritten-end=mercaria_category_assignment_selectable
