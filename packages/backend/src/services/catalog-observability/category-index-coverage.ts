/**
 * Index coverage for the four category reads epic #367 line 138 names.
 *
 * The line asks to *"add indexes for ancestry, descendants, breadcrumb reads and
 * category-scoped schema resolution"*. This module is the measurement that asks
 * whether any is missing, and the answer it records is **no**. Every category
 * predicate the four reads issue already has an index that can serve it —
 * `categories_pkey` for ancestry and the breadcrumb,
 * `categories_ancestor_ids_idx` for both descendants shapes,
 * `product_type_category_scopes_category_idx` for scope resolution — and the
 * sequential scans that remain are over the REGISTRY tables, returning a quarter
 * of `attribute_definitions` and more, where a sequential scan is the correct
 * plan and an index would be the wrong tool.
 *
 * Whether the planner USES the ones it could is a separate question, it is
 * measured here, and the answer is *not reliably*: the descendants shapes were
 * observed taking `categories_ancestor_ids_idx` on one run and sequentially
 * scanning all 5,010 categories on the next. That is a cost-model decision on a
 * small table, not a schema defect, and it is reported rather than asserted.
 *
 * What was missing was not an index but the gate: an index is the one thing a
 * functional test can never detect the absence of, because every read still
 * returns the right rows without it.
 *
 * So what is built here is the regression half. Each shape CALLS the repository
 * function the HTTP surface calls — never a pasted copy of its SQL, which drifts
 * silently and always in the direction that flatters whoever pasted it, and which
 * would go on passing after the reader it claims to measure had been rewritten.
 * A shape therefore cannot outlive its reader: delete the function and this file
 * stops compiling.
 *
 * ## What is asserted, and what is deliberately NOT
 *
 * Two properties, and neither can flip on table statistics:
 *
 *   1. **The index CAN serve the predicate**, shown by taking the sequential scan
 *      away from the planner and finding the index in the plan. That separates an
 *      UNUSABLE index — the wrong operator class, a dropped index, a predicate
 *      respelt so nothing can serve it — from a planner PREFERENCE on a small
 *      table, which is correct and is a fact about size and selectivity rather
 *      than about the schema.
 *   2. **The ROUND TRIP COUNT**, which is what these reads actually cost. The
 *      measured finding is that ancestry and the breadcrumb are not index-bound
 *      at all: every statement they send comes back through `categories_pkey`,
 *      scanning six and thirteen rows respectively, and what remains is that they
 *      send TWO and SIX statements — with the subject row read twice in each. No
 *      index can improve that, and a gate on the plan alone would report both
 *      shapes as perfectly healthy while a further round trip was added.
 *
 *      The breadcrumb pin is the case for pinning it at all: it was first written
 *      at four from reading the call graph, and the gate failed on it. Six is
 *      measured.
 *
 * Which plan the planner actually PICKS is asserted nowhere, for the reason
 * `ancestry-benchmark.ts` records at length: at ADR 0007 D2's own stated scale
 * the choice is selectivity-driven, sits near the planner's cost boundary, and
 * has been observed both ways on one schema and one seed. A gate that fails on a
 * healthy change is a gate whoever hits it next deletes.
 *
 * ## Why the registry is seeded, and seeded to a SIZE
 *
 * The category-scoped schema-resolution readers resolve a category against
 * `product_type_category_scopes` and `attribute_definition_categories`. On an
 * empty registry every one of them returns nothing through a plan that is tidy
 * and instant, which is the measurement of nothing every floor in this domain
 * exists to refuse. And the size is load-bearing rather than incidental: at 60
 * product types the planner sequentially scans the scope table and at 1,500 it
 * switches to `product_type_category_scopes_category_idx`. Both plans are
 * correct; a fixture small enough to only ever produce the first would gate a
 * decision the planner never makes.
 */

import { sql } from 'drizzle-orm';
import type { Database } from '../../db/postgres.js';
import type { SeededTaxonomy } from './ancestry-benchmark.js';
import {
  findCategoryAncestors,
  findCategoryDescendants,
} from '../../db/taxonomy/taxonomyRepository.js';
import { findProductTypeForCategory } from '../../db/facets/facetMetadataRepository.js';
import {
  addAttributeDefinitionCategory,
  insertAttributeDefinition,
  listActiveDefinitionsForCategory,
  transitionAttributeDefinition,
} from '../../db/attributes/definitionRepository.js';
import {
  insertProductTypeDefinition,
  setProductTypeLifecycleIfIn,
} from '../../db/productTypes/productTypeRepository.js';
import { insertProductTypeCategoryScope } from '../../db/productTypes/productTypeFieldRepository.js';
import {
  listPublishedProductTypesForCategory,
  productTypeIsScopedToCategory,
} from '../../db/catalogAuthoring/schemaSourceRepository.js';
import {
  countCategoryBuckets,
  findFacetCategoryScope,
  NO_FACET_REQUIREMENTS,
} from '../../db/facets/facetRepository.js';
import { readTaxonomyBreadcrumb } from '../taxonomy/read.service.js';

// ─── The registry the scoped reads resolve against ─────────────────────────

/**
 * How much schema registry to seed.
 *
 * 1,500 published product types and 4,000 active attribute definitions: above
 * the size at which the planner switches to the scope indexes (measured between
 * 60 and 1,500 product types), and within the order of magnitude a marketplace
 * catalogue registry actually reaches. Three quarters of the definitions are
 * category-scoped and a quarter carry no scope row at all, because the unscoped
 * quarter is `listActiveDefinitionsForCategory`'s third disjunct — the one whose
 * omission is the mistake that looks correct, and whose symptom is a category
 * page with no filters rather than an error.
 */
export const REGISTRY_SIZE = {
  productTypes: 1_500,
  attributeDefinitions: 4_000,
  /** One definition in every `unscopedEvery` carries no scope row. */
  unscopedEvery: 4,
} as const;

/**
 * The locale the breadcrumb shape reads in.
 *
 * `'en'` because that is what `taxonomy.controller.ts`'s own `requestedLocale`
 * falls back to when a caller names none, so the shape resolves the same
 * localization chain an unqualified request does. A locale nothing is seeded in
 * would still exercise the fallback and would still send the same statements —
 * but it would measure the MISS path on every run, which is not the path the
 * route usually takes.
 */
const BENCHMARK_LOCALE = 'en';

/**
 * How many registry rows are in flight at once while seeding.
 *
 * Twelve, the figure `seedAncestryTaxonomy` already uses: the rows are
 * independent and the ORDER within a batch is not a property anything here
 * measures. Concurrency rather than one set-based statement because every row
 * goes through its own repository — see {@link seedCategorySchemaRegistry}.
 */
const SEED_CONCURRENCY = 12;

/** Run `work` for every ordinal below `count`, {@link SEED_CONCURRENCY} at a time. */
async function inBatches(count: number, work: (ordinal: number) => Promise<void>): Promise<void> {
  for (let start = 0; start < count; start += SEED_CONCURRENCY) {
    const batch: Promise<void>[] = [];
    for (let offset = 0; offset < SEED_CONCURRENCY && start + offset < count; offset += 1) {
      batch.push(work(start + offset));
    }
    await Promise.all(batch);
  }
}

/** The handles the shapes read from, all minted by {@link seedCategorySchemaRegistry}. */
export interface CategorySchemaFixture {
  /** The whole subtree of the root — what `resolveScope` hands a facet run. */
  readonly scopeIds: readonly string[];
  /** The root's immediate children — the taxonomy facet's buckets. */
  readonly bucketIds: readonly string[];
  /** A published product type scoped somewhere on the leaf's own ancestry. */
  readonly scopedProductTypeId: string;
}

/**
 * Build a registry over the seeded tree, and the fixture the shapes read from.
 *
 * Scopes are spread across depths 0..4 so a leaf resolves through a real ancestry
 * walk rather than through a scope row sitting on the leaf itself — which every
 * one of these readers would answer at `depth = 0` without ever exercising the
 * inheritance the shape exists to measure.
 */
export async function seedCategorySchemaRegistry(
  db: Database,
  seed: SeededTaxonomy,
): Promise<CategorySchemaFixture> {
  const scopeTargets: string[] = [];
  for (let depth = 0; depth <= 4; depth += 1) {
    for (const id of seed.idsByDepth[depth] ?? []) scopeTargets.push(id);
  }
  if (scopeTargets.length === 0) throw new Error('seeded tree exposed no scope targets.');

  // The leaf's own ancestry FIRST in the target list, so the row at ordinal 0 —
  // the one `scopedProductTypeId` names — is REACHED by the inheritance walk
  // rather than by an exact hit on the subject, which is the only version of
  // this fixture that exercises what the shapes exist to measure.
  const leafAncestry = (await findCategoryAncestors(seed.leafId, db)).map((row) => row.id);
  const anchor = leafAncestry[Math.floor(leafAncestry.length / 2)] ?? seed.rootId;
  const targets = [anchor, ...scopeTargets];

  // Every row goes through the REAL writer, which is `ancestry-benchmark.ts`'s
  // own rule one table over and is not merely tidiness here. A `db.execute`
  // INSERT would make `services/catalog-observability` a second writing
  // directory for four tables `db/productTypes` and `db/attributes` own, which
  // `catalog-table-ownership.md` is about and which the generated architecture
  // census counts — it failed the build on exactly that when this seed was
  // written as raw SQL. Going through the repositories also means the fixture is
  // subject to the same triggers and CHECKs production writes are, so a registry
  // that could not exist cannot be measured.
  const scopedProductTypeIds: string[] = [];
  await inBatches(REGISTRY_SIZE.productTypes, async (ordinal) => {
    const definition = await insertProductTypeDefinition(db, {
      key: `pt.${seed.token}.s${String(ordinal)}`,
      version: 1,
      name: `PT ${String(ordinal)}`,
    });
    // The scope lands while the parent is still a DRAFT:
    // `mercaria_product_type_child_frozen` refuses a scope row on a published
    // one, and `insertProductTypeDefinition` inserts every version as a draft.
    await insertProductTypeCategoryScope(db, {
      productTypeDefinitionId: definition.id,
      categoryId: targets[(ordinal * 7_919) % targets.length] ?? anchor,
      includeDescendants: true,
    });
    await setProductTypeLifecycleIfIn(db, definition.id, ['draft'], 'published', {
      publishedByOxyUserId: 'benchmark',
      publishedAt: new Date(),
    });
    if (ordinal === 0) scopedProductTypeIds.push(definition.id);
  });

  await inBatches(REGISTRY_SIZE.attributeDefinitions, async (ordinal) => {
    const definition = await insertAttributeDefinition(db, {
      key: `ad_${seed.token}_s${String(ordinal)}`,
      version: 1,
      lifecycleState: 'draft',
      label: `AD ${String(ordinal)}`,
      valueType: 'string',
      cardinality: 'single',
    });
    if (ordinal % REGISTRY_SIZE.unscopedEvery !== 0) {
      await addAttributeDefinitionCategory(
        db,
        definition.id,
        targets[(ordinal * 104_729) % targets.length] ?? anchor,
        true,
      );
    }
    await transitionAttributeDefinition(db, definition.id, 'draft', 'active', {
      publishedByOxyUserId: 'benchmark',
      publishedAt: new Date(),
    });
  });

  const scopedProductTypeId = scopedProductTypeIds[0];
  if (scopedProductTypeId === undefined) {
    throw new Error('the registry seeded no product type to resolve against.');
  }

  const scopeIds = await findFacetCategoryScope(db, seed.rootId, true);
  const buckets = await db.execute<{ id: string }>(
    sql`select id from categories where parent_id = ${seed.rootId} order by position`,
  );
  return { scopeIds, bucketIds: [...buckets].map((row) => row.id), scopedProductTypeId };
}

/**
 * The floors the registry must clear before any plan taken over it may be quoted.
 *
 * `findRowCountViolations`' contract, and the reason is the one #60's backfill
 * counters state: a registry that wrote a tenth of what it announced produces
 * plans that are correct and conclusions that are meaningless, and nothing
 * downstream can tell that apart from a fast database.
 */
export function categoryRegistryFloors(): ReadonlyMap<string, number> {
  const scoped =
    REGISTRY_SIZE.attributeDefinitions -
    Math.ceil(REGISTRY_SIZE.attributeDefinitions / REGISTRY_SIZE.unscopedEvery);
  return new Map<string, number>([
    ['product_type_definitions', REGISTRY_SIZE.productTypes],
    ['product_type_category_scopes', REGISTRY_SIZE.productTypes],
    ['attribute_definitions', REGISTRY_SIZE.attributeDefinitions],
    ['attribute_definition_categories', scoped],
  ]);
}

/** Count what the registry actually wrote — the evidence beside the promise. */
export async function countSeededRegistry(db: Database): Promise<ReadonlyMap<string, number>> {
  const rows = await db.execute<{ relation: string; rows: string | number }>(sql`
    select 'product_type_definitions' as relation, count(*)::bigint as rows
      from product_type_definitions
    union all select 'product_type_category_scopes', count(*)::bigint
      from product_type_category_scopes
    union all select 'attribute_definitions', count(*)::bigint from attribute_definitions
    union all select 'attribute_definition_categories', count(*)::bigint
      from attribute_definition_categories`);
  // `postgres.js` decodes `bigint` as a STRING while drizzle types it `number`,
  // so a bare value here would compare lexicographically against its floor.
  return new Map([...rows].map((row) => [row.relation, Number(row.rows)]));
}

// ─── The shapes ────────────────────────────────────────────────────────────

/** Which of line 138's four reads a shape belongs to. */
export type CategoryReadKind =
  | 'ancestry'
  | 'descendants'
  | 'breadcrumb'
  | 'category_scoped_schema_resolution';

/**
 * An index this shape's predicate must be SERVABLE by.
 *
 * Named separately from "the plan uses it", which is not asserted anywhere here.
 */
export interface ServableBy {
  /** The index the predicate must be servable by when the seq scan is removed. */
  readonly index: string;
  /** Why this shape is the one that proves it, for the report. */
  readonly because: string;
  /**
   * Whether the forced plan must additionally be NARROW over `categories`.
   *
   * `'required'` only where the shape answers about a small slice of the tree,
   * so "the index is in the plan" and "the index bought something" are different
   * facts and both are checkable. `'not_asserted'` where the shape legitimately
   * reads a large part of the table — asserting narrowness there would be a
   * bound that fails on a healthy plan, which is the gate whoever hits it next
   * deletes.
   *
   * A STRING and not a boolean: the backend compiles with `strict: false`, so a
   * boolean-literal discriminant does not narrow a union and reads as the whole
   * of it at every call site.
   */
  readonly narrowOverCategories: 'required' | 'not_asserted';
}

export interface CategoryReadShape {
  readonly id: string;
  readonly kind: CategoryReadKind;
  readonly title: string;
  /** The production reader — module and exported function. */
  readonly reader: string;
  /** The HTTP surface that reaches it, or why none does. */
  readonly route: string;
  /** Rows the read must produce, from the seeded tree's own arithmetic. */
  readonly minRowsProduced: (seed: SeededTaxonomy, fixture: CategorySchemaFixture) => number;
  /**
   * How many statements the reader sends.
   *
   * EXACT rather than a ceiling: the measured cost of ancestry and the breadcrumb
   * IS this number, so a range would let the thing under measurement move without
   * the gate noticing. An improvement fails it too, which is intended — the fix
   * for these two shapes is to send fewer statements, and that is a change whose
   * effect belongs in the diff that makes it.
   */
  readonly statements: number;
  readonly servableBy?: ServableBy;
  readonly read: (
    db: Database,
    seed: SeededTaxonomy,
    fixture: CategorySchemaFixture,
  ) => Promise<number>;
}

export const CATEGORY_READ_SHAPES: readonly CategoryReadShape[] = [
  {
    id: 'C1',
    kind: 'descendants',
    title: 'Descendants of a mid-depth node, lifecycle-filtered — the facet scope',
    reader: 'db/facets/facetRepository.ts findFacetCategoryScope',
    route: 'POST /facets (behind FACETS_ENABLED, default off)',
    // The subtree plus the subject: the `or c.id = $1` disjunct is what adds it.
    minRowsProduced: (seed) => seed.midDescendants + 1,
    statements: 1,
    servableBy: {
      index: 'categories_ancestor_ids_idx',
      because:
        'the `ancestor_ids @> array[$1]` half of the BitmapOr is the containment ' +
        'predicate the GIN exists for; the other half is the primary key',
      narrowOverCategories: 'required',
    },
    read: async (db, seed) => (await findFacetCategoryScope(db, seed.midId, true)).length,
  },
  {
    id: 'C2',
    kind: 'descendants',
    title: 'Descendants of a mid-depth node — the taxonomy read',
    reader: 'db/taxonomy/taxonomyRepository.ts findCategoryDescendants',
    route: 'GET /taxonomy/categories/:id/descendants (behind taxonomyV2Enabled, default off)',
    minRowsProduced: (seed) => seed.midDescendants,
    statements: 1,
    servableBy: {
      index: 'categories_ancestor_ids_idx',
      because: 'the whole predicate is one `ancestor_ids @> array[$1]` containment test',
      narrowOverCategories: 'required',
    },
    read: async (db, seed) => (await findCategoryDescendants(seed.midId, {}, db)).length,
  },
  {
    id: 'C3',
    kind: 'ancestry',
    title: 'Ancestors of a deep leaf',
    reader: 'db/taxonomy/taxonomyRepository.ts findCategoryAncestors',
    route: 'GET /taxonomy/categories/:id/ancestors (behind taxonomyV2Enabled, default off)',
    minRowsProduced: (seed) => seed.leafAncestors,
    // Two: read the subject row, then read its ancestors by id. Not an index
    // question — both are `categories_pkey` over single-digit row counts.
    //
    // And `categories_ancestor_ids_idx` could not help even if it were: a GIN
    // answers CONTAINMENT and serves no ordering or prefix work, while this read
    // issues no containment predicate at all. It takes the subject's
    // `ancestor_ids` as a VALUE, fetches those rows by primary key, and orders
    // them in JavaScript from the array's own root-first order. There is nothing
    // here for a GIN to serve, which is why no `servableBy` is declared.
    statements: 2,
    read: async (db, seed) => (await findCategoryAncestors(seed.leafId, db)).length,
  },
  {
    id: 'C4',
    kind: 'breadcrumb',
    title: 'The breadcrumb of a deep leaf — ancestors root-first, then itself',
    reader: 'services/taxonomy/read.service.ts readTaxonomyBreadcrumb',
    route: 'GET /taxonomy/categories/:id/breadcrumb (behind taxonomyV2Enabled, default off)',
    // Ancestors plus the subject, which is the trail the caller renders.
    minRowsProduced: (seed) => seed.leafAncestors + 1,
    // SIX, MEASURED — three category reads plus the three `trailOf` spends
    // resolving the trail's localized names. Two of the three category reads are
    // the SAME ROW: the service reads the subject to decide it is addressable,
    // and `findCategoryAncestors` reads it again before reading the ancestors.
    //
    // This pin was written at four from reading the call graph and the gate
    // failed on it, which is the argument for pinning it at all. These statements
    // ARE the shape's cost — all thirteen rows they scan come back through
    // `categories_pkey` — so there is no index left to add here and only the
    // round trips remain.
    statements: 6,
    read: async (db, seed) =>
      (await readTaxonomyBreadcrumb(db, seed.leafId, BENCHMARK_LOCALE))?.length ?? 0,
  },
  {
    id: 'C5',
    kind: 'category_scoped_schema_resolution',
    title: 'The most specific published product type governing a category',
    reader: 'db/facets/facetMetadataRepository.ts findProductTypeForCategory',
    route: 'POST /facets (behind FACETS_ENABLED, default off)',
    minRowsProduced: () => 1,
    statements: 1,
    servableBy: {
      index: 'product_type_category_scopes_category_idx',
      because:
        'both disjuncts of the scope predicate filter `s.category_id`, once by ' +
        'equality and once against the subject’s own `ancestor_ids`',
      // The narrowness this buys is over `product_type_category_scopes`, not
      // over `categories`, so the categories-scoped ceiling says nothing here.
      narrowOverCategories: 'not_asserted',
    },
    read: async (db, seed) => ((await findProductTypeForCategory(db, seed.leafId)) ? 1 : 0),
  },
  {
    id: 'C6',
    kind: 'category_scoped_schema_resolution',
    title: 'Active attribute definitions applying to a category, inheritance included',
    reader: 'db/attributes/definitionRepository.ts listActiveDefinitionsForCategory',
    route: 'GET /catalog-attributes/definitions and /catalog-attributes/facets (UNCONDITIONAL)',
    // Every definition scoped at or above the leaf, plus every unscoped one —
    // the third disjunct, which is the one whose omission looks correct.
    minRowsProduced: () =>
      Math.floor(REGISTRY_SIZE.attributeDefinitions / REGISTRY_SIZE.unscopedEvery),
    // Two: the CTE answers with ids, then the rows are read through drizzle so a
    // `timestamptz` arrives as a `Date` rather than a raw string.
    statements: 2,
    read: async (db, seed) => (await listActiveDefinitionsForCategory(db, seed.leafId)).length,
  },
  {
    id: 'C7',
    kind: 'category_scoped_schema_resolution',
    title: 'Published product types eligible under a category — the authoring list',
    reader: 'db/catalogAuthoring/schemaSourceRepository.ts listPublishedProductTypesForCategory',
    route: 'GET /catalog-authoring/product-types (behind CATALOG_AUTHORING_ENABLED, default off)',
    minRowsProduced: () => 1,
    statements: 2,
    read: async (db, seed) => (await listPublishedProductTypesForCategory(db, seed.leafId)).length,
  },
  {
    id: 'C8',
    kind: 'category_scoped_schema_resolution',
    title: 'Whether one product type VERSION is eligible under a category',
    reader: 'db/catalogAuthoring/schemaSourceRepository.ts productTypeIsScopedToCategory',
    route: 'draft validation, per request (behind CATALOG_AUTHORING_ENABLED, default off)',
    minRowsProduced: () => 1,
    statements: 1,
    read: async (db, seed, fixture) =>
      (await productTypeIsScopedToCategory(db, fixture.scopedProductTypeId, seed.leafId)) ? 1 : 0,
  },
  {
    id: 'C9',
    kind: 'descendants',
    title: 'Products refined into each child bucket — the taxonomy facet',
    reader: 'db/facets/facetRepository.ts countCategoryBuckets',
    route: 'POST /facets (behind FACETS_ENABLED, default off)',
    minRowsProduced: (_seed, fixture) => fixture.bucketIds.length,
    statements: 1,
    servableBy: {
      index: 'categories_ancestor_ids_idx',
      because:
        'each bucket resolves its own subtree through a correlated ' +
        '`ancestor_ids @> array[c.id]` subquery',
      // Measured at 286,276 rows scanned for four buckets: this shape reads a
      // large multiple of `categories` BY DESIGN, because the subquery is
      // re-resolved per bucket. Its cost is a query shape, not a missing index,
      // and a narrowness bound here would fail on the plan it actually gets.
      narrowOverCategories: 'not_asserted',
    },
    read: async (db, _seed, fixture) =>
      (
        await countCategoryBuckets(
          db,
          {
            scope: { kind: 'categories', categoryIds: fixture.scopeIds },
            requirements: NO_FACET_REQUIREMENTS,
            now: new Date(),
          },
          fixture.bucketIds,
        )
      ).length,
  },
];
