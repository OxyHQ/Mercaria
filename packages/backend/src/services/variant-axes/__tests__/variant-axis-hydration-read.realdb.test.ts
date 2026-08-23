/**
 * The batched typed-axis read a hydration page issues, against a REAL Postgres
 * server (#367 line 324).
 *
 * `catalog-hydration-variant-axes.test.ts` drives the three modes with the
 * repository mocked, which is right for the mode DECISION and cannot say
 * anything about the statement. Three claims here exist only against a server:
 *
 *  1. **The label comes from `attribute_definitions`.** `listVariantAxesForListings`
 *     resolves the display name through an `innerJoin`, and a mocked repository
 *     returns whatever the test typed. Only a real registry row can show that
 *     the name a shopper reads is the definition's, and that renaming the
 *     definition renames the axis with no listing row rewritten — which is the
 *     property #94's "labels are not frozen" buys and the reason the projection
 *     does not read `legacy_option_name`.
 *  2. **The page is SCOPED.** Hydration batches across a page of listings, so a
 *     sibling's axes are one missing predicate away from appearing on another
 *     listing's options. Two fixture listings are built and each is asserted to
 *     see only its own.
 *  3. **The typed rows can be written at all.** `mercaria_native_variant_axis_citation`,
 *     the scope triggers and the deferred
 *     `mercaria_native_variant_signature_agrees` have no mocked counterpart, so
 *     a fixture that satisfies a mock can be one the server refuses outright.
 *     Everything here goes through the sanctioned writers.
 *
 * ## Scoping, and why this file needs no cursor trick
 *
 * Every read under test takes an explicit list of listing or variant ids, so
 * this file's assertions are confined to rows it created by the SHAPE of the
 * functions rather than by a page bound. It writes only under its own listing
 * ids and deletes them in teardown.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { uuidv7 } from '@oxyhq/db';
import { closePostgres, connectPostgres, type Database } from '../../../db/postgres.js';
import { listings, productVariants } from '../../../db/schema/catalog.js';
import {
  attributeDefinitionCategories,
  attributeDefinitions,
  attributeEnumValues,
  attributeReindexRequests,
  attributeValueAliases,
} from '../../../db/schema/attributeRegistry.js';
import {
  listVariantAxesForListings,
  listVariantAxisAssignments,
} from '../../../db/variantAxes/variantAxisRepository.js';
import {
  draftAttributeDefinition,
  publishAttributeDefinition,
} from '../../attributes/definition-registry.service.js';
import {
  declareListingVariantAxes,
  writeVariantAxisValues,
} from '../variant-axes.service.js';
import { projectTypedListingAxes } from '../projection.js';

let db: Database;

/** Unique to this run, so parallel files cannot collide on a shared database. */
const RUN = uuidv7().slice(-12).replace(/\W/gu, '');
const OPERATOR = `axis-read-operator-${RUN}`;

const LISTING_A = uuidv7();
const LISTING_B = uuidv7();
let variantsA: string[] = [];
let variantsB: string[] = [];

const COLOR_KEY = `read_color_${RUN}`.toLowerCase();
const SIZE_KEY = `read_size_${RUN}`.toLowerCase();
const CREATED_KEYS = [COLOR_KEY, SIZE_KEY];

/** The seller's own word, kept DIFFERENT from the registry label throughout. */
const LEGACY_COLOR_NAME = 'Colour';
const COLOR_LABEL = 'Color';
const SIZE_LABEL = 'Size';

beforeAll(async () => {
  db = await connectPostgres();

  await draftAttributeDefinition({
    key: COLOR_KEY,
    label: COLOR_LABEL,
    valueType: 'enum',
    variantDefining: true,
    enumValues: [
      { value: 'ice', label: 'Ice' },
      { value: 'dawn', label: 'Dawn' },
    ],
    actorOxyUserId: OPERATOR,
  });
  await publishAttributeDefinition(COLOR_KEY, 1, OPERATOR);

  await draftAttributeDefinition({
    key: SIZE_KEY,
    label: SIZE_LABEL,
    valueType: 'enum',
    variantDefining: true,
    enumValues: [{ value: 'm', label: 'M' }],
    actorOxyUserId: OPERATOR,
  });
  await publishAttributeDefinition(SIZE_KEY, 1, OPERATOR);

  variantsA = await makeListing(LISTING_A, ['Ice', 'Dawn']);
  variantsB = await makeListing(LISTING_B, ['Ice']);

  const colorDefinition = await definitionId(COLOR_KEY);
  const sizeDefinition = await definitionId(SIZE_KEY);

  await db.transaction(async (tx) => {
    // LISTING_A declares BOTH axes, deliberately out of key order, so the read's
    // `position` ordering is observed rather than an accidental alphabetical one.
    await declareListingVariantAxes(tx, [
      {
        listingId: LISTING_A,
        attributeDefinitionId: sizeDefinition,
        attributeKey: SIZE_KEY,
        attributeDefinitionVersion: 1,
        position: 0,
      },
      {
        listingId: LISTING_A,
        attributeDefinitionId: colorDefinition,
        attributeKey: COLOR_KEY,
        attributeDefinitionVersion: 1,
        // The seller's own word, recorded as PROVENANCE. It must never be what
        // a shopper reads, and the projection case below asserts its absence.
        legacyOptionName: LEGACY_COLOR_NAME,
        position: 1,
      },
    ]);
    await writeVariantAxisValues(tx, {
      listingId: LISTING_A,
      variantId: variantsA[0],
      values: [
        { attributeKey: SIZE_KEY, displayValue: 'M', normalizedValue: 'm' },
        { attributeKey: COLOR_KEY, displayValue: 'Ice', normalizedValue: 'ice' },
      ],
    });
    await writeVariantAxisValues(tx, {
      listingId: LISTING_A,
      variantId: variantsA[1],
      values: [
        { attributeKey: SIZE_KEY, displayValue: 'M', normalizedValue: 'm' },
        { attributeKey: COLOR_KEY, displayValue: 'Dawn', normalizedValue: 'dawn' },
      ],
    });
  });

  await db.transaction(async (tx) => {
    await declareListingVariantAxes(tx, [
      {
        listingId: LISTING_B,
        attributeDefinitionId: colorDefinition,
        attributeKey: COLOR_KEY,
        attributeDefinitionVersion: 1,
        position: 0,
      },
    ]);
    await writeVariantAxisValues(tx, {
      listingId: LISTING_B,
      variantId: variantsB[0],
      values: [{ attributeKey: COLOR_KEY, displayValue: 'Ice', normalizedValue: 'ice' }],
    });
  });
});

afterAll(async () => {
  // Options, variants, axes, assignments and signatures all cascade from
  // `listings`, so the listings go FIRST — an axis references its definition
  // `on delete restrict` and would refuse the definition delete otherwise.
  await db.delete(listings).where(inArray(listings.id, [LISTING_A, LISTING_B]));

  const definitionIds = (
    await db
      .select({ id: attributeDefinitions.id })
      .from(attributeDefinitions)
      .where(inArray(attributeDefinitions.key, CREATED_KEYS))
  ).map((row) => row.id);
  if (definitionIds.length > 0) {
    await db
      .delete(attributeReindexRequests)
      .where(inArray(attributeReindexRequests.attributeKey, CREATED_KEYS));
    // Demote first: a published version refuses DELETE, which IS the trigger
    // working. `attribute-registry.realdb.test.ts`'s teardown, verbatim.
    await db
      .update(attributeDefinitions)
      .set({ lifecycleState: 'draft', publishedAt: null, deprecatedAt: null })
      .where(inArray(attributeDefinitions.id, definitionIds));
    await db
      .delete(attributeValueAliases)
      .where(inArray(attributeValueAliases.attributeDefinitionId, definitionIds));
    await db
      .delete(attributeEnumValues)
      .where(inArray(attributeEnumValues.attributeDefinitionId, definitionIds));
    await db
      .delete(attributeDefinitionCategories)
      .where(inArray(attributeDefinitionCategories.attributeDefinitionId, definitionIds));
    await db.delete(attributeDefinitions).where(inArray(attributeDefinitions.id, definitionIds));
  }
  await closePostgres();
});

async function definitionId(key: string): Promise<string> {
  const [row] = await db
    .select({ id: attributeDefinitions.id })
    .from(attributeDefinitions)
    .where(eq(attributeDefinitions.key, key));
  expect(row, `the fixture did not publish ${key}`).toBeDefined();
  return row.id;
}

async function makeListing(id: string, variantTitles: string[]): Promise<string[]> {
  await db.insert(listings).values({
    id,
    ownerType: 'user',
    oxyUserId: `axis-read-seller-${RUN}`,
    storeId: null,
    title: `Axis read ${RUN}`,
    description: 'A fixture listing with typed axes.',
    condition: 'new',
    conditionAssertion: 'seller_declared',
    status: 'active',
    categorySlugs: [],
    tags: [],
  });
  const inserted = await db
    .insert(productVariants)
    .values(variantTitles.map((title, position) => ({ listingId: id, title, position })))
    .returning({ id: productVariants.id });
  expect(inserted.length, 'the fixture did not create its variants').toBe(variantTitles.length);
  return inserted.map((row) => row.id);
}

describe('listVariantAxesForListings', () => {
  it('resolves the display name from the REGISTRY, not from the axis row', async () => {
    const rows = await listVariantAxesForListings(db, [LISTING_A]);

    const color = rows.find((row) => row.attributeKey === COLOR_KEY);
    expect(color?.label).toBe(COLOR_LABEL);
    // Both facts on one row, and they must not be the same string: the label is
    // what a shopper reads and the legacy name is only what a claim said.
    expect(color?.legacyOptionName).toBe(LEGACY_COLOR_NAME);
  });

  it('renames every listing at once when the DEFINITION label changes, rewriting no listing row', async () => {
    // #94 freezes a definition's meaning and deliberately not its label. This is
    // the property that buys — and the reason the projection may not fall back
    // to `legacy_option_name`, which a rename could never reach.
    const id = await definitionId(COLOR_KEY);
    await db
      .update(attributeDefinitions)
      .set({ label: 'Colour (renamed)' })
      .where(eq(attributeDefinitions.id, id));

    const [a] = await listVariantAxesForListings(db, [LISTING_A]).then((rows) =>
      rows.filter((row) => row.attributeKey === COLOR_KEY),
    );
    const [b] = await listVariantAxesForListings(db, [LISTING_B]);
    expect(a.label).toBe('Colour (renamed)');
    expect(b.label).toBe('Colour (renamed)');

    await db
      .update(attributeDefinitions)
      .set({ label: COLOR_LABEL })
      .where(eq(attributeDefinitions.id, id));
  });

  it('orders by declared position, not by attribute key', async () => {
    // `SIZE_KEY` is declared at position 0 and sorts AFTER `COLOR_KEY`
    // alphabetically (`read_color_…` < `read_size_…`), so an implementation that
    // dropped the `position` ordering would return them the other way round.
    const rows = await listVariantAxesForListings(db, [LISTING_A]);

    expect(rows.map((row) => row.attributeKey)).toEqual([SIZE_KEY, COLOR_KEY]);
  });

  it('returns ONLY the requested listing axes, never a sibling that has some', async () => {
    // Hydration batches across a page, so a missing predicate would put one
    // listing's options on another's product page. Asked for ONE listing while
    // a sibling in the same database also declares axes on the SAME key, so a
    // dropped `where` returns rows this assertion refuses rather than rows it
    // happens to tolerate.
    const onlyA = await listVariantAxesForListings(db, [LISTING_A]);
    expect(onlyA.every((row) => row.listingId === LISTING_A)).toBe(true);
    expect(onlyA).toHaveLength(2);

    const onlyB = await listVariantAxesForListings(db, [LISTING_B]);
    expect(onlyB.every((row) => row.listingId === LISTING_B)).toBe(true);
    expect(onlyB).toHaveLength(1);

    // And a page carrying both returns both, so the case above is scoping
    // rather than the read being broken in a way that returns too little.
    const both = await listVariantAxesForListings(db, [LISTING_A, LISTING_B]);
    expect(both).toHaveLength(3);
  });

  it('answers an empty page with an empty array and no statement', async () => {
    expect(await listVariantAxesForListings(db, [])).toEqual([]);
  });
});

describe('the whole read, projected as a hydration page would', () => {
  it('renders one listing options and every variant values from the typed rows', async () => {
    const axes = await listVariantAxesForListings(db, [LISTING_A]);
    const assignments = await listVariantAxisAssignments(db, variantsA);

    const projected = projectTypedListingAxes(axes, assignments, variantsA);

    expect(projected?.options).toEqual([
      { name: SIZE_LABEL, values: ['M'] },
      { name: COLOR_LABEL, values: ['Ice', 'Dawn'] },
    ]);
    expect(projected?.valuesByVariant.get(variantsA[0])).toEqual([
      { name: SIZE_LABEL, value: 'M' },
      { name: COLOR_LABEL, value: 'Ice' },
    ]);
    // The seller's word was recorded and must not reach the projection.
    expect(JSON.stringify(projected)).not.toContain(LEGACY_COLOR_NAME);
  });

  it('does not leak a SIBLING listing assignments into a projection', async () => {
    // The page-scoping failure at the projection grain: `LISTING_B`'s variant
    // carries the same attribute key, so an unscoped assignment bucket would
    // silently add its value to `LISTING_A`'s colour option.
    const axes = await listVariantAxesForListings(db, [LISTING_A]);
    const assignments = await listVariantAxisAssignments(db, [...variantsA, ...variantsB]);

    const projected = projectTypedListingAxes(axes, assignments, variantsA);

    expect(projected?.valuesByVariant.has(variantsB[0])).toBe(false);
    expect(projected?.options).toEqual([
      { name: SIZE_LABEL, values: ['M'] },
      { name: COLOR_LABEL, values: ['Ice', 'Dawn'] },
    ]);
  });
});
