/**
 * Navigation trees and the merchandising separation (#367 step 7, ADR 0007 D3).
 *
 * Five tables: `navigation_saved_queries`,
 * `navigation_saved_query_attribute_filters`, `navigation_trees`,
 * `navigation_nodes` and `navigation_node_localizations`.
 *
 * ## What this domain is NOT
 *
 * It is not taxonomy. `categories` is the universal classification tree (D2) and
 * this domain only ever READS it — a menu is an arrangement of the catalogue,
 * never a second authority over what the catalogue means. There is no column
 * here that could hold a category's name, parent, lifecycle or ancestry, so a
 * homepage section cannot restate one, and `navigation-isolation.test.ts` fails
 * the build if a module here so much as imports a category write path.
 *
 * It is not merchandising either. `collections`, `collection_rules` and
 * `listing_collections` stay exactly as they are (D3). A node may POINT at a
 * collection; the pointer is a foreign key onto a row this domain never writes,
 * so a collection membership becomes no product fact by being linked from a
 * menu, and an UNPUBLISHED collection is withheld by the read-time projection
 * rather than published by association.
 *
 * ## The one shape to read: a node that means two things has no row
 *
 * `navigation_nodes` carries a `target_kind` and seven pointer columns, and
 * `navigation_nodes_target_shape_check` is SEVEN biconditionals plus an exact
 * `num_nonnulls` count. Seven separate biconditionals rather than one condition
 * over their conjunction, because the obvious single-expression spelling is
 * satisfied by rows it exists to refuse — the finding
 * `retail_delivery_promises_observed_shape_check` records, met again here. The
 * `num_nonnulls` term is not redundant with them: it is what fails on the first
 * real insert if an EIGHTH pointer column is ever added without extending the
 * biconditionals.
 *
 * ## What is a trigger and why
 *
 * A CHECK cannot read another row, so four things are triggers and their bodies
 * live in `navigation.pending.sql` until the migration slot is handed over:
 *
 *  - **cycle, cross-tree parenting and depth refusal** on `navigation_nodes` —
 *    all three need the parent chain, and the depth bound needs its length.
 *    There is deliberately no stored `depth` column: the walk that refuses a
 *    cycle counts the hops in the same pass, and a stored depth would be a
 *    second representation of the parent chain that goes stale the moment a
 *    subtree moves.
 *  - **live-window exclusion** on `navigation_trees` — at most one published
 *    tree may be live for one `(market, locale, surface)` at any instant. A
 *    partial unique index cannot express it, because scheduling requires a
 *    successor to EXIST, published, while the incumbent is still live.
 *  - **freeze once published**, on trees and on everything hanging off them —
 *    preview-then-publish only means something if the published thing cannot
 *    change underneath the preview.
 *  - **machine translation may never overwrite reviewed or approved text**
 *    (D4), on `navigation_node_localizations`.
 */

import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  pgTable,
  text,
  uniqueIndex,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { createdAt, generatedId, timestamptz, updatedAt } from '@oxyhq/db';
import {
  CONDITION_GROUPS,
  NAVIGATION_LOCALIZATION_PROVENANCES,
  NAVIGATION_LOCALIZATION_STATUSES,
  NAVIGATION_NODE_TARGET_KINDS,
  NAVIGATION_NODE_VISIBILITIES,
  NAVIGATION_SURFACES,
  NAVIGATION_TREE_LIFECYCLES,
  OFFER_AVAILABILITY_STATES,
  OFFER_KINDS,
} from '@mercaria/shared-types';
import {
  asEnumValues,
  checkEveryElementOf,
  checkOneOf,
  currencyChecks,
  optionalMoney,
} from './columns';
import { brands } from './organizations';
import { canonicalProductFamilies } from './canonicalCatalog';
import { categories } from './catalog';
import { collections } from './merchandising';

/**
 * The BCP-47 shape every locale column in this domain carries.
 *
 * The `attribute_labels` predicate verbatim (#94), including its deliberate
 * absence of any backslash: a regex written in a JS template literal loses its
 * escapes on the way into the generated SQL, and the damage is silent — a `\.`
 * that became `.` produces a CHECK that admits what it was written to refuse.
 * Written with character classes only, it cannot rot that way.
 *
 * A SHAPE check, not a membership one. D4 validates a locale against a tuple of
 * supported locales, and that tuple belongs to the localization family
 * (merge-order step 2). When it lands, this predicate is replaced by a
 * `checkOneOf` against it in one edit; until then a shape refusal is what stops
 * `Español` or `ES_es` reaching a column.
 */
const localeShape = (column: AnyPgColumn) =>
  sql`${column} = lower(btrim(${column})) and ${column} ~ '^[a-z]{2,3}(-[a-z0-9]{2,8})*$'`;

/**
 * `navigation_saved_queries` — a named, reusable, curated search.
 *
 * Every filter is a real column (ADR 0007 D14 — a filter set is not a
 * source-shaped payload, an immutable schema snapshot or a bounded rule AST, so
 * it gets no JSONB), and the columns mirror #70's `SearchFilters` so a node's
 * destination is a search this deployment can actually run.
 *
 * There is deliberately NO sort, intent, weight or policy column. A saved query
 * says WHAT to search; #74 says how to order what comes back, behind its
 * versioned policy. A curated search carrying its own ordering would be a second
 * ranking authority reachable from a menu, which is exactly what
 * `navigation-isolation.test.ts` exists to keep out.
 */
export const navigationSavedQueries = pgTable(
  'navigation_saved_queries',
  {
    id: generatedId(),
    /** The stable machine key (ADR 0007 D1), frozen by trigger after insert. */
    key: text().notNull(),
    /**
     * What operators call this query in the authoring surface.
     *
     * NOT presentation — no public read serves it, and the DTO has no field for
     * it — and not identity either; `key` is. It exists so a person choosing
     * between two saved queries has something to read.
     */
    internalLabel: text().notNull(),
    /** The free-text half of the query, when it has one. */
    queryText: text(),
    categoryId: text().references(() => categories.id, { onDelete: 'restrict' }),
    brandIds: text()
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    merchantIds: text()
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    conditionGroups: text()
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    availability: text()
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    offerKinds: text()
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    /** #70 filter 7 — only official or authorized channels for the brand. */
    officialChannelOnly: boolean().notNull().default(false),
    /** ISO 3166-1 alpha-2, when the query is pinned to one market. */
    market: text(),
    // ONE currency for both ends: two bounds in different currencies are not
    // comparable, and converting them here would be an FX decision this domain
    // has no business making.
    ...optionalMoney('priceMin'),
    ...optionalMoney('priceMax'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    ...currencyChecks('navigation_saved_queries', [t.priceMinCurrency, t.priceMaxCurrency]),
    checkEveryElementOf(
      'navigation_saved_queries_condition_groups_check',
      t.conditionGroups,
      CONDITION_GROUPS,
    ),
    checkEveryElementOf(
      'navigation_saved_queries_availability_check',
      t.availability,
      OFFER_AVAILABILITY_STATES,
    ),
    checkEveryElementOf('navigation_saved_queries_offer_kinds_check', t.offerKinds, OFFER_KINDS),
    check(
      'navigation_saved_queries_market_shape_check',
      sql`${t.market} is null or (${t.market} = upper(btrim(${t.market})) and ${t.market} ~ '^[A-Z]{2}$')`,
    ),
    check('navigation_saved_queries_key_shape_check', sql`btrim(${t.key}) <> ''`),
    // An amount and its currency are present together — `optionalMoney` makes
    // both nullable, and half a price bound is a bound nobody can apply.
    check(
      'navigation_saved_queries_price_min_shape_check',
      sql`(${t.priceMinAmount} is null) = (${t.priceMinCurrency} is null)`,
    ),
    check(
      'navigation_saved_queries_price_max_shape_check',
      sql`(${t.priceMaxAmount} is null) = (${t.priceMaxCurrency} is null)`,
    ),
    // Both ends in ONE currency, and the range the right way round.
    check(
      'navigation_saved_queries_price_currency_agreement_check',
      sql`${t.priceMinCurrency} is null or ${t.priceMaxCurrency} is null or ${t.priceMinCurrency} = ${t.priceMaxCurrency}`,
    ),
    check(
      'navigation_saved_queries_price_range_check',
      sql`${t.priceMinAmount} is null or ${t.priceMaxAmount} is null or ${t.priceMaxAmount} >= ${t.priceMinAmount}`,
    ),
    check(
      'navigation_saved_queries_price_non_negative_check',
      sql`(${t.priceMinAmount} is null or ${t.priceMinAmount} >= 0) and (${t.priceMaxAmount} is null or ${t.priceMaxAmount} >= 0)`,
    ),
    uniqueIndex('navigation_saved_queries_key_key').on(t.key),
  ],
);

/**
 * `navigation_saved_query_attribute_filters` — one #94 attribute constraint of a
 * saved query.
 *
 * A child table rather than a column of arrays, because the shape is
 * `(attribute, values)` pairs and an array of pairs is a JSONB bag by another
 * name. `attribute_key` is the definition's stable machine key (D1) and carries
 * no foreign key: `attribute_definitions` is keyed `(key, version)`, and a saved
 * query means "colour", not "version 3 of colour" — pinning a version here would
 * silently stop matching the day the registry published a new one.
 */
export const navigationSavedQueryAttributeFilters = pgTable(
  'navigation_saved_query_attribute_filters',
  {
    id: generatedId(),
    savedQueryId: text()
      .notNull()
      .references(() => navigationSavedQueries.id, { onDelete: 'cascade' }),
    /** #94's stable attribute key, never a label. */
    attributeKey: text().notNull(),
    values: text()
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    position: integer().notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // `cardinality`, NEVER `array_length`: `array_length('{}', 1)` is NULL, a
    // CHECK rejects only FALSE, so the obvious `array_length(values, 1) >= 1`
    // ADMITS exactly the empty array it was written to refuse. Measured twice
    // already in this schema.
    check(
      'navigation_saved_query_attribute_filters_values_check',
      sql`cardinality(${t.values}) >= 1`,
    ),
    check('navigation_saved_query_attribute_filters_key_check', sql`btrim(${t.attributeKey}) <> ''`),
    check('navigation_saved_query_attribute_filters_position_check', sql`${t.position} >= 0`),
    uniqueIndex('navigation_saved_query_attribute_filters_key_key').on(
      t.savedQueryId,
      t.attributeKey,
    ),
  ],
);

/**
 * `navigation_trees` — one arrangement of the catalogue, for one
 * `(market, locale, surface)`, as one version.
 *
 * ## Why `(key, version)` rather than a mutable row
 *
 * The `fee_schedules` / `attribute_definitions` / policy-version mechanism this
 * repository already uses everywhere. It is what makes PREVIEW meaningful: a
 * draft version is a real row with real nodes an operator can read whole before
 * anybody else can, and publishing it is a state transition rather than a
 * sequence of edits to something shoppers are currently looking at. A mutable
 * tree would be a menu that is briefly half-changed for everybody, with nothing
 * to roll back TO.
 *
 * ## Scheduling, and why the exclusion is a trigger
 *
 * `effective_from`/`effective_to` are the schedule and `lifecycle = 'published'`
 * is the intent; a tree is LIVE when both hold at the current instant. There is
 * deliberately no `scheduled` lifecycle — it would be a second answer to a
 * question the window already answers, and the two would disagree the first time
 * a job was late.
 *
 * "At most one live tree per `(market, locale, surface)`" is therefore an
 * OVERLAP refusal, not a uniqueness one: the successor has to be allowed to
 * exist, published and scheduled, while the incumbent is still live. A partial
 * unique index cannot say that, so it is a trigger.
 */
export const navigationTrees = pgTable(
  'navigation_trees',
  {
    id: generatedId(),
    /**
     * The stable machine key (ADR 0007 D1), frozen by trigger after insert.
     *
     * A tree whose key was wrong is archived and superseded, never renamed — a
     * renamed key is indistinguishable from a different tree to every seed,
     * fixture and export that cited it.
     */
    key: text().notNull(),
    /** Monotonic within `(key, market, locale)`; the chain a publish extends. */
    version: integer().notNull(),
    /** ISO 3166-1 alpha-2, upper-case so a lookup cannot miss on case. */
    market: text().notNull(),
    /** BCP-47, lower-case. */
    locale: text().notNull(),
    surface: text({ enum: asEnumValues(NAVIGATION_SURFACES) }).notNull(),
    lifecycle: text({ enum: asEnumValues(NAVIGATION_TREE_LIFECYCLES) }).notNull().default('draft'),
    /** Operator-facing; never served by a public read. See `internalLabel` above. */
    internalLabel: text().notNull(),
    /** Live from this instant; NULL means "from the moment it was published". */
    effectiveFrom: timestamptz(),
    /** Live until this instant; NULL means "until something supersedes it". */
    effectiveTo: timestamptz(),
    publishedAt: timestamptz(),
    /** An Oxy account id — Oxy owns identity, so no foreign key. */
    publishedByOxyUserId: text(),
    /** The version this one replaced, for the audit trail. */
    supersedesTreeId: text().references((): AnyPgColumn => navigationTrees.id, {
      onDelete: 'restrict',
    }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf('navigation_trees_surface_check', t.surface, NAVIGATION_SURFACES),
    checkOneOf('navigation_trees_lifecycle_check', t.lifecycle, NAVIGATION_TREE_LIFECYCLES),
    check('navigation_trees_locale_shape_check', localeShape(t.locale)),
    check(
      'navigation_trees_market_shape_check',
      sql`${t.market} = upper(btrim(${t.market})) and ${t.market} ~ '^[A-Z]{2}$'`,
    ),
    check('navigation_trees_key_shape_check', sql`btrim(${t.key}) <> ''`),
    check('navigation_trees_version_check', sql`${t.version} >= 1`),
    // A window that ends before it starts is never live, and is far more likely
    // a swapped pair of inputs than an intent (`discounts_window_check`).
    check(
      'navigation_trees_window_check',
      sql`${t.effectiveTo} is null or ${t.effectiveFrom} is null or ${t.effectiveTo} > ${t.effectiveFrom}`,
    ),
    // A publication instant and a publisher arrive together: half of an audit
    // record is worse than none, because it reads as a complete one.
    check(
      'navigation_trees_publication_shape_check',
      sql`(${t.publishedAt} is null) = (${t.publishedByOxyUserId} is null)`,
    ),
    // …and a tree that has left `draft` HAS been published. This is what makes
    // "a draft is never publicly readable" a property of the row rather than of
    // whoever wrote the query: `published_at is null` and `lifecycle = 'draft'`
    // cannot disagree.
    check(
      'navigation_trees_lifecycle_publication_check',
      sql`(${t.lifecycle} = 'draft') = (${t.publishedAt} is null)`,
    ),
    check('navigation_trees_supersedes_self_check', sql`${t.supersedesTreeId} <> ${t.id}`),
    uniqueIndex('navigation_trees_key_version_key').on(t.key, t.market, t.locale, t.version),
    // The public read's own predicate: one surface of one context, live now.
    index('navigation_trees_live_idx').on(t.market, t.locale, t.surface, t.lifecycle),
  ],
);

/**
 * `navigation_nodes` — one entry of a tree, pointing at exactly one thing.
 *
 * ## Ordering is deterministic at the ROW, not in the reader
 *
 * `position` is unique among siblings, and the uniqueness is TWO partial indexes
 * rather than one — Postgres treats NULLs as distinct, so a single
 * `unique(tree_id, parent_id, position)` would let two ROOT nodes share position
 * 0 and leave their order to whatever the planner returned that day. The read
 * additionally tie-breaks on `key`, so a total order exists whatever is stored.
 *
 * ## `parent_id` cascades, and that is safe here
 *
 * A node is meaningless outside its tree and a subtree is meaningless without
 * its root; nothing outside this domain references a node, and a published
 * tree's nodes cannot be deleted at all (the freeze trigger). Cross-tree
 * parenting is refused by the same trigger that refuses a cycle: a foreign key
 * can say the parent EXISTS and cannot say it belongs to this tree.
 */
export const navigationNodes = pgTable(
  'navigation_nodes',
  {
    id: generatedId(),
    treeId: text()
      .notNull()
      .references(() => navigationTrees.id, { onDelete: 'cascade' }),
    parentId: text().references((): AnyPgColumn => navigationNodes.id, { onDelete: 'cascade' }),
    /** Stable within the tree (D1) — what a client keys behaviour on. */
    key: text().notNull(),
    /** Deterministic order among siblings. Unique, see the table docblock. */
    position: integer().notNull(),
    targetKind: text({ enum: asEnumValues(NAVIGATION_NODE_TARGET_KINDS) }).notNull(),

    // The seven pointers. Exactly one is non-null, and WHICH one is forced by
    // `target_kind` — see `navigation_nodes_target_shape_check`.
    categoryId: text().references(() => categories.id, { onDelete: 'restrict' }),
    savedQueryId: text().references(() => navigationSavedQueries.id, { onDelete: 'restrict' }),
    /**
     * A product type's stable machine KEY (D1), and it carries no foreign key.
     *
     * Not a deferral: `product_type_definitions` LANDED (#408) and still has no
     * single-column unique on `key` — its uniques are `(key, version)` and a
     * PARTIAL unique on `key WHERE lifecycle = 'published'`, and a foreign key
     * may target neither a partial index nor one column of a composite key. So
     * the reference is unrepresentable as an FK. A `product_type_id` uuid
     * instead would pin ONE VERSION, and a node means "the smartphone product
     * type", not "version 4 of it" — pinning would make a menu entry go stale
     * the day somebody published a new version.
     */
    productTypeKey: text(),
    brandId: text().references(() => brands.id, { onDelete: 'restrict' }),
    productFamilyId: text().references(() => canonicalProductFamilies.id, {
      onDelete: 'restrict',
    }),
    collectionId: text().references(() => collections.id, { onDelete: 'restrict' }),
    /**
     * An external campaign destination, exactly as an operator entered it.
     *
     * HTTPS-only by CHECK, and nothing in this domain COMPOSES one: no tracking
     * parameter is appended, no host is rewritten and no Mercaria redirect is
     * built around it. #37 owns the outbound redirect, and #65/#66 record what
     * happens to attribution when somebody rebuilds a link.
     */
    campaignUrl: text(),

    /**
     * Whether the node is shown at all, independent of its window.
     *
     * The ONE column of a published tree's node the freeze trigger still lets
     * through. A change to what shoppers see is normally a new tree version, but
     * an incident lever that requires republishing a whole menu is one nobody
     * can pull at 3am.
     */
    visibility: text({ enum: asEnumValues(NAVIGATION_NODE_VISIBILITIES) })
      .notNull()
      .default('visible'),
    /** Scheduling, independent of the tree's own window. */
    visibleFrom: timestamptz(),
    visibleTo: timestamptz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf('navigation_nodes_target_kind_check', t.targetKind, NAVIGATION_NODE_TARGET_KINDS),
    checkOneOf('navigation_nodes_visibility_check', t.visibility, NAVIGATION_NODE_VISIBILITIES),
    /**
     * THE shape constraint. Seven biconditionals, ANDed — one per target kind —
     * plus an exact count.
     *
     * The tempting single-expression spelling ("the selected pointer is set and
     * `num_nonnulls` is 1") ADMITS a row whose kind is `brand` and whose only
     * pointer is a `collection_id`, because both halves are satisfied. Each
     * biconditional is exact on its own, which is what makes the conjunction
     * exact; the count is what fails if an eighth pointer is ever added without
     * extending them.
     */
    check(
      'navigation_nodes_target_shape_check',
      sql`(${t.targetKind} = 'category') = (${t.categoryId} is not null)
        and (${t.targetKind} = 'saved_query') = (${t.savedQueryId} is not null)
        and (${t.targetKind} = 'product_type') = (${t.productTypeKey} is not null)
        and (${t.targetKind} = 'brand') = (${t.brandId} is not null)
        and (${t.targetKind} = 'product_family') = (${t.productFamilyId} is not null)
        and (${t.targetKind} = 'collection') = (${t.collectionId} is not null)
        and (${t.targetKind} = 'campaign') = (${t.campaignUrl} is not null)
        and num_nonnulls(${t.categoryId}, ${t.savedQueryId}, ${t.productTypeKey}, ${t.brandId}, ${t.productFamilyId}, ${t.collectionId}, ${t.campaignUrl}) = 1`,
    ),
    // HTTPS only, written as a prefix test rather than a regex: a URL pattern is
    // exactly where a lost backslash does its damage, and `like` needs none.
    check(
      'navigation_nodes_campaign_url_check',
      sql`${t.campaignUrl} is null or ${t.campaignUrl} like 'https://%'`,
    ),
    check('navigation_nodes_key_shape_check', sql`btrim(${t.key}) <> ''`),
    check('navigation_nodes_position_check', sql`${t.position} >= 0`),
    // Self-parenting is the ONE cycle a CHECK can see, so it is refused here as
    // well as in the trigger: the cheapest refusal should not need a walk.
    check('navigation_nodes_self_parent_check', sql`${t.parentId} <> ${t.id}`),
    check(
      'navigation_nodes_visibility_window_check',
      sql`${t.visibleTo} is null or ${t.visibleFrom} is null or ${t.visibleTo} > ${t.visibleFrom}`,
    ),
    uniqueIndex('navigation_nodes_tree_key_key').on(t.treeId, t.key),
    // Deterministic sibling order, in TWO partial indexes — see the docblock.
    uniqueIndex('navigation_nodes_child_position_key')
      .on(t.treeId, t.parentId, t.position)
      .where(sql`${t.parentId} is not null`),
    uniqueIndex('navigation_nodes_root_position_key')
      .on(t.treeId, t.position)
      .where(sql`${t.parentId} is null`),
    index('navigation_nodes_tree_parent_idx').on(t.treeId, t.parentId, t.position),
    index('navigation_nodes_category_idx').on(t.categoryId),
    index('navigation_nodes_collection_idx').on(t.collectionId),
  ],
);

/**
 * `navigation_node_localizations` — ADR 0007 D4's localization member for a
 * navigation node.
 *
 * Per-entity, never one polymorphic table: `entity_id` could carry no foreign
 * key there, so every orphan would be invisible and every read would need a
 * discriminator the planner cannot use.
 *
 * The node row carries NO label of its own, and that is the point. "Return
 * stable ids and keys PLUS localized presentation, never presentation alone" is
 * then a property of the schema — presentation is a join — and a node with no
 * localization in any locale of the fallback chain is WITHHELD from the public
 * read rather than rendered as its key.
 */
export const navigationNodeLocalizations = pgTable(
  'navigation_node_localizations',
  {
    id: generatedId(),
    nodeId: text()
      .notNull()
      .references(() => navigationNodes.id, { onDelete: 'cascade' }),
    /** BCP-47, lower-case. */
    locale: text().notNull(),
    label: text().notNull(),
    description: text(),
    accessibilityLabel: text(),
    status: text({ enum: asEnumValues(NAVIGATION_LOCALIZATION_STATUSES) }).notNull(),
    provenance: text({ enum: asEnumValues(NAVIGATION_LOCALIZATION_PROVENANCES) }).notNull(),
    /** The locale this text was translated FROM, when it was translated. */
    sourceLocale: text(),
    /**
     * The source row's revision when this translation was made.
     *
     * `bigint` rather than `integer` for the reason every counter here is: a
     * revision that overflows silently is a staleness check that stopped
     * working without saying so.
     */
    sourceRevision: bigint({ mode: 'number' }),
    /** An Oxy account id — no foreign key. */
    reviewedByOxyUserId: text(),
    reviewedAt: timestamptz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf(
      'navigation_node_localizations_status_check',
      t.status,
      NAVIGATION_LOCALIZATION_STATUSES,
    ),
    checkOneOf(
      'navigation_node_localizations_provenance_check',
      t.provenance,
      NAVIGATION_LOCALIZATION_PROVENANCES,
    ),
    check('navigation_node_localizations_locale_shape_check', localeShape(t.locale)),
    check(
      'navigation_node_localizations_source_locale_shape_check',
      sql`${t.sourceLocale} is null or (${t.sourceLocale} = lower(btrim(${t.sourceLocale})) and ${t.sourceLocale} ~ '^[a-z]{2,3}(-[a-z0-9]{2,8})*$')`,
    ),
    // A review instant and a reviewer arrive together — half an audit record
    // reads as a whole one.
    check(
      'navigation_node_localizations_review_shape_check',
      sql`(${t.reviewedAt} is null) = (${t.reviewedByOxyUserId} is null)`,
    ),
    // …and the two statuses that MEAN a person looked cannot be claimed without
    // one. The implication is one-directional on purpose: a `stale` row keeps
    // the attribution of the human review it has outlived.
    check(
      'navigation_node_localizations_reviewed_status_check',
      sql`${t.status} not in ('reviewed', 'approved') or ${t.reviewedAt} is not null`,
    ),
    // A label is what this table exists to hold; an empty one is an absent
    // translation wearing a present one's clothes, and the public read would
    // serve it as a menu entry with no words on it.
    check('navigation_node_localizations_label_check', sql`btrim(${t.label}) <> ''`),
    uniqueIndex('navigation_node_localizations_node_locale_key').on(t.nodeId, t.locale),
  ],
);
