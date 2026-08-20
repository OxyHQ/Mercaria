/**
 * A deprecated definition does not delete what was already derived (#612 A).
 *
 * ## The inconsistency this pins
 *
 * Measured on `origin/main` before the fix, with ONE deprecation, ONE listing
 * and ONE pass:
 *
 * ```
 * v0 (COLOR only    -> now resolves nothing) = ["color"]    assignment SURVIVED
 * v1 (COLOR+STORAGE -> still resolves)       = ["storage"]  COLOR row DELETED
 * ```
 *
 * Two opposite outcomes for one deprecation, decided only by whether the variant
 * happened to carry a second axis that still resolved. `replaceVariantAxisAssignments`
 * deletes a variant's whole set and re-inserts the derived part, so v1 lost its
 * row; v0 was absent from `desiredByVariant` entirely, so nothing touched it.
 * Nobody designed that.
 *
 * ## Which way it was resolved, and why that is applying policy rather than
 * inventing it
 *
 * Toward the documented contract, in two files:
 *
 *  - `definition-registry.service.ts` — `deprecateAttributeDefinition` takes a
 *    version "out of service for NEW assignments", and "stored values still
 *    resolve".
 *  - `definitionRepository.ts` — `findAttributeDefinitionVersion` reads "one
 *    exact version — what a stored value cites, whatever its lifecycle state".
 *
 * A stored assignment cites its exact version, so deprecating one does not
 * invalidate what was already derived from it. Both paths now RETAIN.
 *
 * Whether a deprecation should ever remove a derived row, and on what signal, is
 * a separate question and deliberately not decided here: "the registry stopped
 * resolving this" and "a registry-wide outage resolved nothing" are
 * indistinguishable from inside this pass, and only one of them may delete.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { uuidv7 } from '@oxyhq/db';
import { closePostgres, connectPostgres, type Database } from '../../../db/postgres.js';
import {
  listingOptions,
  listings,
  productVariantOptionValues,
  productVariants,
} from '../../../db/schema/catalog.js';
import {
  attributeDefinitionCategories,
  attributeDefinitions,
  attributeEnumValues,
  attributeReindexRequests,
  attributeValueAliases,
} from '../../../db/schema/attributeRegistry.js';
import {
  nativeVariantAxisAssignments,
  nativeVariantSignatures,
} from '../../../db/schema/variantAxes.js';
import { listListingIdsWithLegacyOptions } from '../../../db/variantAxes/legacyOptionRepository.js';
import {
  deprecateAttributeDefinition,
  draftAttributeDefinition,
  publishAttributeDefinition,
} from '../../attributes/definition-registry.service.js';
import { runVariantAxisBackfill } from '../backfill.service.js';
import { reportPopulation } from '../../../__tests__/report-population.js';

let db: Database;

const RUN = uuidv7().slice(-12).replace(/\W/gu, '');
const OPERATOR = `axis-retain-operator-${RUN}`;

/** Sorts after every id a sibling can mint — the apply test's aiming device. */
const TAIL_PREFIX = 'ffffffff-ffff-7fff-8fff-';
const PAGE_CURSOR = `${TAIL_PREFIX}${RUN.slice(0, 11)}0`;
const LISTING_ID = `${TAIL_PREFIX}${RUN.slice(0, 11)}1`;

const COLOR_KEY = `axis_retain_colour_${RUN}`.toLowerCase();
const COLOR_NAME = `Axis Retain Colour ${RUN}`;
const STORAGE_KEY = `axis_retain_storage_${RUN}`.toLowerCase();
const STORAGE_NAME = `Axis Retain Storage ${RUN}`;
const CREATED_KEYS = [COLOR_KEY, STORAGE_KEY];

/** [0] carries COLOR only — it drops out ENTIRELY. [1] keeps resolving STORAGE. */
let variantIds: string[] = [];

beforeAll(async () => {
  db = await connectPostgres();
});

afterAll(async () => {
  await db.delete(listings).where(eq(listings.id, LISTING_ID));
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

/** One variant's stored axis keys, read from Postgres rather than from a report. */
async function storedKeys(variantId: string): Promise<string[]> {
  const rows = await db
    .select({ key: nativeVariantAxisAssignments.attributeKey })
    .from(nativeVariantAxisAssignments)
    .where(eq(nativeVariantAxisAssignments.variantId, variantId));
  return rows.map((row) => row.key).sort();
}

async function signatureCount(variantId: string): Promise<number> {
  const rows = await db
    .select({ variantId: nativeVariantSignatures.variantId })
    .from(nativeVariantSignatures)
    .where(eq(nativeVariantSignatures.variantId, variantId));
  return rows.length;
}

describe('a deprecated definition and the rows already derived from it', () => {
  it('retains BOTH variants’ rows and counts them per axis', async () => {
    await draftAttributeDefinition({
      key: COLOR_KEY,
      label: 'Axis retain colour',
      valueType: 'enum',
      variantDefining: true,
      enumValues: [
        { value: 'red', label: 'Red', aliases: ['Rojo'] },
        { value: 'blue', label: 'Blue', aliases: ['Azul'] },
      ],
      actorOxyUserId: OPERATOR,
    });
    await publishAttributeDefinition(COLOR_KEY, 1, OPERATOR);
    await draftAttributeDefinition({
      key: STORAGE_KEY,
      label: 'Axis retain storage',
      valueType: 'measurement',
      unitFamily: 'digital_storage',
      variantDefining: true,
      actorOxyUserId: OPERATOR,
    });
    await publishAttributeDefinition(STORAGE_KEY, 1, OPERATOR);

    await db.insert(listings).values({
      id: LISTING_ID,
      ownerType: 'user',
      oxyUserId: `axis-retain-seller-${RUN}`,
      storeId: null,
      title: `Axis retain ${RUN}`,
      description: 'Two variants, one of which loses every axis when COLOR is deprecated.',
      condition: 'new',
      conditionAssertion: 'seller_declared',
      status: 'active',
      categorySlugs: [],
      tags: [],
    });
    await db.insert(listingOptions).values([
      { listingId: LISTING_ID, name: COLOR_NAME, values: ['Rojo', 'Azul'], position: 0 },
      { listingId: LISTING_ID, name: STORAGE_NAME, values: ['256 GB'], position: 1 },
    ]);
    const inserted = await db
      .insert(productVariants)
      .values([
        { listingId: LISTING_ID, title: 'Rojo', position: 0 },
        { listingId: LISTING_ID, title: 'Azul', position: 1 },
      ])
      .returning({ id: productVariants.id });
    variantIds = inserted.map((row) => row.id);

    await db.insert(productVariantOptionValues).values([
      // COLOR only — after the deprecation this variant derives NOTHING.
      { variantId: variantIds[0], name: COLOR_NAME, value: 'Rojo', position: 0 },
      // COLOR + STORAGE — after the deprecation this one still derives STORAGE.
      { variantId: variantIds[1], name: COLOR_NAME, value: 'Azul', position: 0 },
      { variantId: variantIds[1], name: STORAGE_NAME, value: '256 GB', position: 1 },
    ]);

    const page = await listListingIdsWithLegacyOptions(db, {
      afterListingId: PAGE_CURSOR,
      limit: 1,
    });
    expect(page.listingIds, 'the test is not aimed at its own listing').toEqual([LISTING_ID]);

    const first = await runVariantAxisBackfill(db, {
      mode: 'apply',
      afterListingId: PAGE_CURSOR,
      listingLimit: 1,
    });
    // The premise. Without it every assertion below is vacuously true against a
    // pass that wrote nothing.
    expect(first.assignments.written, 'the first pass derived nothing to retain').toBe(3);
    expect(await storedKeys(variantIds[0])).toEqual([COLOR_KEY]);
    expect(await storedKeys(variantIds[1])).toEqual([COLOR_KEY, STORAGE_KEY].sort());

    await deprecateAttributeDefinition(COLOR_KEY, 1);

    const second = await runVariantAxisBackfill(db, {
      mode: 'apply',
      afterListingId: PAGE_CURSOR,
      listingLimit: 1,
    });
    const v0 = await storedKeys(variantIds[0]);
    const v1 = await storedKeys(variantIds[1]);
    reportPopulation(
      `[retention] retained=${second.diagnostics.assignmentsRetainedUnresolved} ` +
        `v0=${JSON.stringify(v0)} v1=${JSON.stringify(v1)}`,
    );

    // BOTH keep the deprecated axis. Before #612 this was `[COLOR]` and
    // `[STORAGE]` — the same deprecation deleting one and sparing the other.
    expect(v0, 'the fully-dropped variant lost its retained row').toEqual([COLOR_KEY]);
    expect(v1, 'the partially-dropped variant lost its retained row').toEqual(
      [COLOR_KEY, STORAGE_KEY].sort(),
    );

    // Counted per AXIS: v0's one and v1's one. A per-LISTING net reported 1 here
    // before #612, and would report 0 whenever one variant lost a row while
    // another gained one.
    expect(second.diagnostics.assignmentsRetainedUnresolved).toBe(2);

    // Both signatures survive — a retained row is part of the variant's SET, so
    // the digest is computed over all of it rather than over the derived part.
    expect(await signatureCount(variantIds[0])).toBe(1);
    expect(await signatureCount(variantIds[1])).toBe(1);

    // And the vacuity floor still holds: a retained row has no legacy value
    // behind it, so it must stay OUT of the outcome buckets. `assertReportSums`
    // runs inside the call above and would have thrown; this states the shape it
    // was protecting.
    expect(
      second.assignments.written +
        second.assignments.alreadyWritten +
        second.assignments.unresolved +
        second.assignments.withheld,
    ).toBe(second.scanned.variantOptionValues);
  }, 180_000);
});
