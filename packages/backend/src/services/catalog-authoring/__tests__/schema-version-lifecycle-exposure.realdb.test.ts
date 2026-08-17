/**
 * The lifecycle and status FILTERS on the unprivileged authoring surface
 * (#367 step 5).
 *
 * Two of them, and they are here together because they are one question —
 * *which lifecycle or status may an unprivileged caller see* — asked in two
 * places on one router. `docs/reviews/2026-08-17-catalog-authoring-security-review.md`
 * counts seven readers of it on this surface; the `?version=` composition was one
 * of the two that got it wrong, and `listSelectableCategories` was one of the five
 * that got it right and was pinned by nothing at all. A filter is not an import a
 * scan can walk or a row a CHECK can refuse, so nothing in this repository was
 * looking at either.
 *
 * ## 1. `?version=` may not serve an UNLAUNCHED product-type schema
 *
 * `GET /catalog-authoring/schemas/:productTypeKey?version=N` is authenticated
 * and nothing more — no store permission, no operator allow-list — which is
 * correct for a PUBLISHED schema (the router says so, and the answer is identical
 * for every member of every store). It was not correct for an editable one:
 * `findProductTypeVersion` filters on `(key, version)` and not on lifecycle,
 * `composeForDefinition` re-checked nothing, and so any authenticated Oxy
 * account could read the whole field, attribute and grouping structure of an
 * unannounced vertical by naming a guessable key and a small integer.
 *
 * ## Why this is a REAL-database file
 *
 * The property under test is a lifecycle value in `product_type_definitions`
 * deciding what a composition serves, and the composition reads eleven tables in
 * three domains. A mocked repository would let the test assert that the service
 * calls a filter it wrote itself — the re-implementation measuring the
 * re-implementation. Everything here is the real service over real rows.
 *
 * ## Both directions, because "refuse everything" also passes half a test
 *
 * A published version at `?version=` must still compose. Without that assertion
 * the fix could be a blanket refusal of every explicitly-named version and this
 * file would be green.
 *
 * ## 2. The categories picker must actually exclude what it says it excludes
 *
 * `listSelectableCategories` requires `selectable = true AND lifecycle =
 * 'published'` and its own comment says the two are DIFFERENT facts — a
 * connector holding pen is suppressed and selectable, a grouping root is
 * published and not selectable. It was referenced by no test in the repository,
 * so deleting either clause left every suite green while the authoring picker
 * offered categories ADR 0007 D2 says a product may not be filed under.
 *
 * The two cases are separate, and that is the point rather than tidiness: ONE
 * case is satisfied by either clause on its own, so a single mutation going red
 * proves one clause exists and says nothing about the other. Each is
 * mutation-tested independently.
 *
 * Asserting a filter needs ROWS IN THE STATES IT EXCLUDES, which is the whole
 * reason this class of bug survives — a test written without them passes against
 * the filter's absence.
 *
 * ## Scoping, because this database is SHARED
 *
 * One throwaway database serves the whole suite and vitest runs files in
 * parallel workers, so every identifier here carries a per-run suffix and
 * teardown deletes exactly what it created — unpublishing FIRST, because
 * `product_type_fields_frozen` refuses to delete a published version's children.
 *
 * The categories cases add rows to a table siblings also read, so the picker is
 * queried under a PARENT this file owns and every assertion names the ids it
 * inserted. It never counts the table. **MEASURED:** the only two files that
 * count `categories` whole — `ancestry-benchmark.realdb.test.ts` and
 * `provision-taxonomy.realdb.test.ts` — each create their OWN throwaway
 * database, so neither can see these fixtures and neither can truncate them.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { inArray } from 'drizzle-orm';
import { uuidv7 } from '@oxyhq/db';
import {
  PRODUCT_TYPE_EDITABLE_LIFECYCLES,
  PRODUCT_TYPE_LIFECYCLES,
  type AuthoringPermissionContext,
  type ProductTypeLifecycle,
} from '@mercaria/shared-types';
import { closePostgres, connectPostgres, type Database } from '../../../db/postgres.js';
import { categories } from '../../../db/schema/catalog.js';
import { attributeDefinitions } from '../../../db/schema/attributeRegistry.js';
import {
  productTypeCategoryScopes,
  productTypeDefinitions,
  productTypeFields,
} from '../../../db/schema/productTypes.js';
import {
  RETRIEVABLE_AUTHORING_LIFECYCLES,
  clearAuthoringSchemaMemo,
  composeAuthoringSchema,
} from '../schema.service.js';
import { listSelectableCategories } from '../../../db/catalogAuthoring/schemaSourceRepository.js';

let db: Database;

/** Unique to this run, so parallel files cannot collide on a shared database. */
const RUN = uuidv7().slice(-12).replace(/\W/gu, '');

/**
 * A version number this file owns.
 *
 * `attribute_definitions` is keyed `(key, version)` and a sibling file could
 * plausibly define the same key at version 1, so this file writes high and
 * derives the number from its own run suffix.
 */
const ATTR_VERSION = 810_000 + (Number.parseInt(RUN.slice(-4), 36) % 80_000);

/** One key, four versions — one per lifecycle. `?version=` addresses each. */
const TYPE_KEY = `pt_expo_${RUN}`.toLowerCase();

/** Every version this file created, by lifecycle, so each case names its own. */
const versionByLifecycle = new Map<ProductTypeLifecycle, number>();

const createdDefinitionIds: string[] = [];
const createdCategoryIds: string[] = [];
/** Children, deleted BEFORE their parent — `categories.parent_id` is `restrict`. */
const createdChildCategoryIds: string[] = [];
const createdAttributeIds: string[] = [];

let categoryId: string;
/** The parent the picker cases query under, so a sibling's rows cannot appear. */
let pickerParentId: string;
let pickerVisibleId: string;
let pickerSuppressedId: string;
let pickerNotSelectableId: string;

/** Every permission on, so a refusal below can only be about the lifecycle. */
const PERMISSIONS: AuthoringPermissionContext = {
  canEditDraft: true,
  canPublish: true,
  canProposeValues: true,
  canSelectCanonicalEntity: true,
};

/**
 * Compose exactly the way the HTTP handler does, at one named version.
 *
 * Through `composeAuthoringSchema` and not through a repository, because the
 * question is what the SURFACE answers a caller who named a version.
 */
async function composeAt(version: number | undefined) {
  return composeAuthoringSchema(db, {
    productTypeKey: TYPE_KEY,
    ...(version === undefined ? {} : { version }),
    categoryId,
    flow: 'merchant',
    requestedLocale: 'en',
    market: 'ES',
    permissions: PERMISSIONS,
  });
}

/**
 * A complete, composable version at one lifecycle: scoped to the category and
 * carrying a field in the `merchant` flow.
 *
 * Completeness is the load-bearing part. A draft version with no scope row or no
 * field would be refused by `category_not_in_product_type_scope` or
 * `flow_declares_no_field` whether or not the lifecycle gate exists — so the
 * exposure test would pass against code that never had the gate, which is the
 * vacuous version of this whole file.
 */
async function makeVersion(
  lifecycle: ProductTypeLifecycle,
  version: number,
  attribute: { id: string; key: string; version: number },
): Promise<void> {
  const [row] = await db
    .insert(productTypeDefinitions)
    .values({
      key: TYPE_KEY,
      version,
      name: `Unlaunched vertical ${RUN} v${version}`,
      // Inserted `draft` and moved afterwards: `product_type_definitions`'
      // publication trigger owns the stamped columns, and a fixture that wrote
      // `published` directly would be asserting against a row shape the service
      // never produces.
      lifecycle: 'draft',
    })
    .returning();
  createdDefinitionIds.push(row.id);
  versionByLifecycle.set(lifecycle, version);

  await db
    .insert(productTypeCategoryScopes)
    .values({ productTypeDefinitionId: row.id, categoryId, includeDescendants: false });
  await db.insert(productTypeFields).values({
    productTypeDefinitionId: row.id,
    attributeDefinitionId: attribute.id,
    attributeKey: attribute.key,
    attributeDefinitionVersion: attribute.version,
    scope: 'product',
    flow: 'merchant',
    requirement: 'optional',
    valuePolicy: 'typed_scalar',
  });

  if (lifecycle !== 'draft') {
    await db
      .update(productTypeDefinitions)
      .set({
        lifecycle,
        ...(lifecycle === 'published' || lifecycle === 'deprecated'
          ? { publishedAt: new Date(), publishedByOxyUserId: `oxy_${RUN}` }
          : {}),
        ...(lifecycle === 'deprecated' ? { deprecatedAt: new Date() } : {}),
      })
      .where(inArray(productTypeDefinitions.id, [row.id]));
  }
}

beforeAll(async () => {
  db = await connectPostgres();

  const [category] = await db
    .insert(categories)
    .values({
      key: `pt_expo_cat_${RUN}`.toLowerCase(),
      name: `Unlaunched vertical ${RUN}`,
      slug: `pt-expo-cat-${RUN}`,
      // `composeForDefinition` refuses a structural node, so a fixture that left
      // this false would refuse for the wrong reason in every case below.
      selectable: true,
    })
    .returning();
  createdCategoryIds.push(category.id);
  categoryId = category.id;

  // The picker fixtures: a grouping ROOT this file owns, and three children in
  // the three states that matter. The parent is itself a published,
  // non-selectable grouping node — realistic, and it means the parent can never
  // appear in a query for its own children.
  const [parent] = await db
    .insert(categories)
    .values({
      key: `pt_expo_root_${RUN}`.toLowerCase(),
      name: `Picker root ${RUN}`,
      slug: `pt-expo-root-${RUN}`,
      selectable: false,
    })
    .returning();
  createdCategoryIds.push(parent.id);
  pickerParentId = parent.id;

  const children = await db
    .insert(categories)
    .values([
      // Published AND selectable — the one the picker must offer. Its presence in
      // every assertion below is what stops a case passing on an empty result.
      {
        key: `pt_expo_kid_ok_${RUN}`.toLowerCase(),
        name: `Picker offers ${RUN}`,
        slug: `pt-expo-kid-ok-${RUN}`,
        parentId: parent.id,
      },
      // The connector holding pen: SUPPRESSED and selectable. Excluded by the
      // lifecycle clause and by nothing else — `selectable` is true here on
      // purpose, so this case cannot be satisfied by the selectable clause.
      {
        key: `pt_expo_kid_sup_${RUN}`.toLowerCase(),
        name: `Picker suppressed ${RUN}`,
        slug: `pt-expo-kid-sup-${RUN}`,
        parentId: parent.id,
        lifecycle: 'suppressed',
      },
      // A grouping root: PUBLISHED and not selectable. Excluded by the selectable
      // clause and by nothing else, for the mirror-image reason.
      {
        key: `pt_expo_kid_group_${RUN}`.toLowerCase(),
        name: `Picker grouping ${RUN}`,
        slug: `pt-expo-kid-group-${RUN}`,
        parentId: parent.id,
        selectable: false,
      },
    ])
    .returning();
  for (const child of children) createdChildCategoryIds.push(child.id);
  pickerVisibleId = children[0].id;
  pickerSuppressedId = children[1].id;
  pickerNotSelectableId = children[2].id;

  const [attribute] = await db
    .insert(attributeDefinitions)
    .values({
      key: `pt_expo_attr_${RUN}`.toLowerCase(),
      version: ATTR_VERSION,
      lifecycleState: 'draft',
      label: `Unlaunched attribute ${RUN}`,
      valueType: 'string',
    })
    .returning();
  createdAttributeIds.push(attribute.id);
  const cited = { id: attribute.id, key: attribute.key, version: attribute.version };

  // One version per lifecycle under one key. At most one may be `published`
  // (a partial unique index), which is why the other three are separate rows.
  await makeVersion('published', 1, cited);
  await makeVersion('draft', 2, cited);
  await makeVersion('review', 3, cited);
  await makeVersion('deprecated', 4, cited);
}, 120_000);

afterAll(async () => {
  if (!db) return;
  if (createdDefinitionIds.length > 0) {
    // Unpublish first: the freeze trigger refuses to delete a published
    // version's fields, and it is doing its job when it does.
    await db
      .update(productTypeDefinitions)
      .set({ lifecycle: 'draft', publishedAt: null, publishedByOxyUserId: null, deprecatedAt: null })
      .where(inArray(productTypeDefinitions.id, createdDefinitionIds));
    await db
      .delete(productTypeFields)
      .where(inArray(productTypeFields.productTypeDefinitionId, createdDefinitionIds));
    await db
      .delete(productTypeCategoryScopes)
      .where(inArray(productTypeCategoryScopes.productTypeDefinitionId, createdDefinitionIds));
    await db
      .delete(productTypeDefinitions)
      .where(inArray(productTypeDefinitions.id, createdDefinitionIds));
  }
  if (createdAttributeIds.length > 0) {
    await db
      .delete(attributeDefinitions)
      .where(inArray(attributeDefinitions.id, createdAttributeIds));
  }
  // Children first, in their OWN statement: `categories.parent_id` is `restrict`,
  // and a RESTRICT foreign key is checked immediately rather than at end of
  // statement, so a single delete naming both ends would be refused.
  if (createdChildCategoryIds.length > 0) {
    await db.delete(categories).where(inArray(categories.id, createdChildCategoryIds));
  }
  if (createdCategoryIds.length > 0) {
    await db.delete(categories).where(inArray(categories.id, createdCategoryIds));
  }
  await closePostgres();
});

beforeEach(() => {
  // The composition memo is process state. A published entry left in it would
  // let a later case pass on a cached answer rather than on a fresh read, which
  // is exactly the reading a mutation run must not be given.
  clearAuthoringSchemaMemo();
});

describe('the allow-list is the complement of the editable set', () => {
  it('partitions PRODUCT_TYPE_LIFECYCLES exactly', () => {
    // A gate on the VOCABULARY rather than on this file's fixtures. A fifth
    // lifecycle lands on the permissive side of a deny-list in silence; here it
    // fails the build until somebody says which side it belongs on.
    const union = [...RETRIEVABLE_AUTHORING_LIFECYCLES, ...PRODUCT_TYPE_EDITABLE_LIFECYCLES];
    expect([...union].sort()).toEqual([...PRODUCT_TYPE_LIFECYCLES].sort());
    const overlap = RETRIEVABLE_AUTHORING_LIFECYCLES.filter((lifecycle) =>
      PRODUCT_TYPE_EDITABLE_LIFECYCLES.includes(lifecycle),
    );
    expect(overlap).toEqual([]);
  });

  it('names the four lifecycles this file actually created', () => {
    // The vacuity floor. Every assertion below reads a version out of this map,
    // so a fixture that silently created three rows would make one case address
    // `undefined` and compose the PUBLISHED version by accident.
    expect([...versionByLifecycle.keys()].sort()).toEqual([...PRODUCT_TYPE_LIFECYCLES].sort());
  });
});

describe('an EDITABLE version is not readable through ?version=', () => {
  it.each(PRODUCT_TYPE_EDITABLE_LIFECYCLES)('refuses a %s version', async (lifecycle) => {
    const version = versionByLifecycle.get(lifecycle);
    expect(version, `no ${lifecycle} fixture`).toBeDefined();

    const composition = await composeAt(version);

    expect(composition.outcome).toBe('refused');
    if (composition.outcome !== 'refused') return;
    expect(composition.refusal).toBe('product_type_not_found');
    // Byte-identical to what a version that does not exist answers. A refusal
    // that said "that version is a draft" would be the enumeration oracle the
    // exposure was mostly worth — a caller could walk the integers and map every
    // unlaunched vertical without reading a single schema.
    expect(composition.detail).toBe(`No version ${version} of product type "${TYPE_KEY}".`);
  });

  it('answers a nonexistent version with the SAME code and the SAME sentence', async () => {
    // The indistinguishability control. Without it the two refusals could drift
    // apart in a later edit and nothing would notice.
    const absent = 999_999;
    const composition = await composeAt(absent);
    expect(composition.outcome).toBe('refused');
    if (composition.outcome !== 'refused') return;
    expect(composition.refusal).toBe('product_type_not_found');
    expect(composition.detail).toBe(`No version ${absent} of product type "${TYPE_KEY}".`);
  });
});

describe('a RETRIEVABLE version still composes', () => {
  it.each(RETRIEVABLE_AUTHORING_LIFECYCLES)('serves a %s version at ?version=', async (lifecycle) => {
    const version = versionByLifecycle.get(lifecycle);
    expect(version, `no ${lifecycle} fixture`).toBeDefined();

    const composition = await composeAt(version);

    // Without this half the fix could be "refuse every named version" and this
    // file would report the exposure closed while the surface answered nothing.
    expect(
      composition.outcome,
      composition.outcome === 'refused' ? composition.detail : '',
    ).toBe('composed');
    if (composition.outcome !== 'composed') return;
    expect(composition.schema.productType.key).toBe(TYPE_KEY);
    expect(composition.schema.productType.version).toBe(version);
    expect(composition.schema.productType.lifecycle).toBe(lifecycle);
    // The thing the exposure leaked: the field structure. Its presence here is
    // what makes the refusals above a refusal of something rather than of an
    // empty answer.
    expect(composition.schema.fields.length).toBeGreaterThan(0);
  });

  it('serves the published version when no version is named at all', async () => {
    // The `findPublishedVersionForKey` branch, which already filtered lifecycle
    // and is the reason this exposure was reachable only through `?version=`.
    const composition = await composeAt(undefined);
    expect(composition.outcome).toBe('composed');
    if (composition.outcome !== 'composed') return;
    expect(composition.schema.productType.version).toBe(versionByLifecycle.get('published'));
  });
});

describe('the categories picker offers only what a product may be filed under', () => {
  /** The picker's answer, scoped to the parent this file owns. */
  async function offeredIds(): Promise<string[]> {
    const rows = await listSelectableCategories(db, { parentId: pickerParentId, limit: 50 });
    return rows.map((row) => row.id);
  }

  it('excludes a SUPPRESSED category, which is selectable', async () => {
    // The connector holding pen. Only the `lifecycle` clause can refuse it, so
    // this case measures that clause and nothing else.
    const ids = await offeredIds();
    expect(ids).not.toContain(pickerSuppressedId);
    // The published, selectable sibling IS offered — without this the assertion
    // above is satisfied by a picker that returns nothing at all.
    expect(ids).toContain(pickerVisibleId);
  });

  it('excludes a NON-SELECTABLE category, which is published', async () => {
    // A grouping root. Only the `selectable` clause can refuse it — the mirror
    // image, and the reason these are two cases rather than one.
    const ids = await offeredIds();
    expect(ids).not.toContain(pickerNotSelectableId);
    expect(ids).toContain(pickerVisibleId);
  });

  it('offers EXACTLY the published, selectable child and nothing else', async () => {
    // Scoped to this file's own parent, so an exact equality is safe on a shared
    // database — no sibling's category can be a child of a row created here.
    expect(await offeredIds()).toEqual([pickerVisibleId]);
  });

  it('VACUITY CONTROL — the fixtures are the three distinct states they claim', async () => {
    // Without this, a fixture that silently created one row three times, or that
    // lost the `lifecycle`/`selectable` overrides, would make both exclusion
    // cases pass by measuring the same excluded row twice.
    const ids = [pickerVisibleId, pickerSuppressedId, pickerNotSelectableId];
    expect(new Set(ids).size).toBe(3);
    const rows = await db.select().from(categories).where(inArray(categories.id, ids));
    const byId = new Map(rows.map((row) => [row.id, row]));
    expect(byId.get(pickerVisibleId)?.lifecycle).toBe('published');
    expect(byId.get(pickerVisibleId)?.selectable).toBe(true);
    expect(byId.get(pickerSuppressedId)?.lifecycle).toBe('suppressed');
    // Selectable ON PURPOSE: the suppressed case must be refused by the lifecycle
    // clause alone, and this is what proves the other clause could not have done
    // it.
    expect(byId.get(pickerSuppressedId)?.selectable).toBe(true);
    expect(byId.get(pickerNotSelectableId)?.lifecycle).toBe('published');
    expect(byId.get(pickerNotSelectableId)?.selectable).toBe(false);
  });
});
