/**
 * `?version=` may not serve an UNLAUNCHED product-type schema (#367 step 5).
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
 * ## Scoping, because this database is SHARED
 *
 * One throwaway database serves the whole suite and vitest runs files in
 * parallel workers, so every identifier here carries a per-run suffix and
 * teardown deletes exactly what it created — unpublishing FIRST, because
 * `product_type_fields_frozen` refuses to delete a published version's children.
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
const createdAttributeIds: string[] = [];

let categoryId: string;

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
