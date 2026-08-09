/**
 * The attribute registry against a REAL Postgres server (#94).
 *
 * Everything here is a property the database holds and a mocked repository
 * cannot: the immutability triggers, the one-active-version partial unique, the
 * generated `value_slot` and the uniques taken over it, the review queue's
 * one-open-per-entity index, the reindex log's deterministic-id convergence,
 * and the CHECKs that make a half-declared definition unrepresentable.
 *
 * A mocked `insert` accepts any statement, including one the server rejects
 * outright — which is exactly the class of bug this file exists to catch.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import { isCheckViolation, isUniqueViolation, uuidv7 } from '@oxyhq/db';
import { closePostgres, connectPostgres, type Database } from '../postgres.js';
import { categories } from '../schema/catalog.js';
import { catalogSources, sourceRecords } from '../schema/provenance.js';
import {
  attributeDefinitions,
  attributeDefinitionCategories,
  attributeEnumValues,
  attributeReindexRequests,
  attributeValueAliases,
  attributeValueReviews,
} from '../schema/attributeRegistry.js';
import {
  canonicalAttributeValues,
  canonicalProducts,
  canonicalVariants,
} from '../schema/canonicalCatalog.js';
import {
  draftAttributeDefinition,
  publishAttributeDefinition,
  resolveActiveDefinition,
  resolveDefinitionsForCategory,
} from '../../services/attributes/definition-registry.service.js';
import { applyAttributeObservation } from '../../services/attributes/attribute-observation.service.js';
import { enqueueAttributeReindex } from '../attributes/attributeOpsRepository.js';
import { createCanonicalProduct } from '../../services/canonical/canonical-product.service.js';

let db: Database;

/** Unique to this run, so parallel files cannot collide on a shared database. */
const RUN = uuidv7().slice(-12).replace(/\W/gu, '');
const OPERATOR = `operator-${RUN}`;

const createdKeys: string[] = [];
const createdCategoryIds: string[] = [];
const createdSourceIds: string[] = [];
const createdProductIds: string[] = [];

function key(name: string): string {
  const composed = `${name}_${RUN}`.toLowerCase();
  createdKeys.push(composed);
  return composed;
}

beforeAll(async () => {
  db = await connectPostgres();
});

afterAll(async () => {
  if (createdKeys.length > 0) {
    await db
      .delete(attributeReindexRequests)
      .where(inArray(attributeReindexRequests.attributeKey, createdKeys));
    await db
      .delete(attributeValueReviews)
      .where(inArray(attributeValueReviews.attributeKey, createdKeys));
    await db
      .delete(canonicalAttributeValues)
      .where(inArray(canonicalAttributeValues.attributeKey, createdKeys));
  }
  if (createdProductIds.length > 0) {
    await db
      .delete(canonicalVariants)
      .where(inArray(canonicalVariants.productId, createdProductIds));
    await db.delete(canonicalProducts).where(inArray(canonicalProducts.id, createdProductIds));
  }
  if (createdKeys.length > 0) {
    const definitionIds = (
      await db
        .select({ id: attributeDefinitions.id })
        .from(attributeDefinitions)
        .where(inArray(attributeDefinitions.key, createdKeys))
    ).map((row) => row.id);
    if (definitionIds.length > 0) {
      // Demote first: a published version refuses DELETE, which IS the trigger
      // working. See the same teardown in `canonical-catalog.realdb.test.ts`.
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
  }
  if (createdSourceIds.length > 0) {
    await db.delete(sourceRecords).where(inArray(sourceRecords.sourceId, createdSourceIds));
    await db.delete(catalogSources).where(inArray(catalogSources.id, createdSourceIds));
  }
  if (createdCategoryIds.length > 0) {
    await db.delete(categories).where(inArray(categories.id, createdCategoryIds));
  }
  await closePostgres();
});

/** Assert a write is refused by the named CONSTRAINT KIND, not merely by an error. */
async function expectRefused(
  kind: 'check' | 'unique' | 'trigger',
  write: () => Promise<unknown>,
): Promise<void> {
  let caught: unknown;
  try {
    await write();
  } catch (error) {
    caught = error;
  }
  expect(caught, 'the write SUCCEEDED; the constraint did not fire').toBeDefined();
  if (kind === 'trigger') {
    // A `RAISE … USING ERRCODE = 'restrict_violation'` is SQLSTATE 23001, which
    // neither `isCheckViolation` nor `isUniqueViolation` recognises — asserting
    // the code directly is what tells a trigger refusal from an unrelated crash.
    // drizzle wraps the driver error, so the code lives on the CAUSE.
    expect(sqlStateOf(caught), `expected a trigger refusal, got: ${String(caught)}`).toBe('23001');
    return;
  }
  const matched = kind === 'check' ? isCheckViolation(caught) : isUniqueViolation(caught);
  expect(matched, `expected a ${kind} violation, got: ${String(caught)}`).toBe(true);
}

/** The SQLSTATE of a driver error, through drizzle's wrapper. */
function sqlStateOf(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current !== null && current !== undefined; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string') return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

async function mintCategory(slug: string, parentId?: string): Promise<string> {
  const [row] = await db
    .insert(categories)
    .values({
      name: `${slug} ${RUN}`,
      slug: `${slug}-${RUN}`,
      ...(parentId === undefined ? {} : { parentId }),
    })
    .returning();
  if (!row) throw new Error('category insert returned no row');
  createdCategoryIds.push(row.id);
  return row.id;
}

async function mintSourceRecord(marker: string): Promise<string> {
  if (createdSourceIds.length === 0) {
    const [source] = await db
      .insert(catalogSources)
      .values({
        kind: 'feed',
        name: `attr-registry-${RUN}`,
        mayDisplay: true,
        mayStore: true,
        attributionRequired: false,
      })
      .returning();
    if (!source) throw new Error('catalog source insert returned no row');
    createdSourceIds.push(source.id);
  }
  const sourceId = createdSourceIds[0];
  if (sourceId === undefined) throw new Error('no catalog source');
  const [record] = await db
    .insert(sourceRecords)
    .values({
      sourceId,
      externalType: 'product',
      externalId: `${marker}-${RUN}`,
      observedAt: new Date(),
      contentHash: marker.padEnd(64, '0').slice(0, 64).replace(/[^0-9a-f]/gu, '0'),
    })
    .returning();
  if (!record) throw new Error('source record insert returned no row');
  return record.id;
}

async function mintProduct(label: string): Promise<string> {
  const product = await createCanonicalProduct({ name: `${label} ${RUN}`, actorOxyUserId: OPERATOR });
  createdProductIds.push(product.id);
  return product.id;
}

describe('a definition version is published, not edited', () => {
  it('publishes, deprecates its predecessor, and keeps exactly one active', async () => {
    const attributeKey = key('screen_size');
    const first = await draftAttributeDefinition({
      key: attributeKey,
      label: 'Screen size',
      valueType: 'measurement',
      unitFamily: 'length',
      actorOxyUserId: OPERATOR,
    });
    expect(first.version).toBe(1);
    expect(first.lifecycleState).toBe('draft');

    const published = await publishAttributeDefinition(attributeKey, 1, OPERATOR);
    expect(published.lifecycleState).toBe('active');
    expect(published.publishedAt).toBeDefined();

    // A second VERSION is the sanctioned way to change what an attribute means.
    const second = await draftAttributeDefinition({
      key: attributeKey,
      label: 'Display size',
      valueType: 'measurement',
      unitFamily: 'length',
      decimalPlaces: 1,
      actorOxyUserId: OPERATOR,
    });
    expect(second.version).toBe(2);

    await publishAttributeDefinition(attributeKey, 2, OPERATOR);
    const active = await resolveActiveDefinition(db, attributeKey);
    expect(active?.row.version).toBe(2);

    const states = await db
      .select({ version: attributeDefinitions.version, state: attributeDefinitions.lifecycleState })
      .from(attributeDefinitions)
      .where(eq(attributeDefinitions.key, attributeKey));
    expect(states.sort((a, b) => a.version - b.version)).toEqual([
      { version: 1, state: 'deprecated' },
      { version: 2, state: 'active' },
    ]);
  });

  it('refuses a second ACTIVE version from a writer that skipped the service', async () => {
    const attributeKey = key('one_active');
    await draftAttributeDefinition({
      key: attributeKey,
      label: 'One active',
      valueType: 'string',
      actorOxyUserId: OPERATOR,
    });
    await publishAttributeDefinition(attributeKey, 1, OPERATOR);

    await expectRefused('unique', () =>
      db.insert(attributeDefinitions).values({
        key: attributeKey,
        version: 42,
        lifecycleState: 'active',
        publishedAt: new Date(),
        label: 'Sneaked in',
        valueType: 'string',
      }),
    );
  });

  it('freezes every semantic column once published, and permits the label', async () => {
    const attributeKey = key('frozen');
    await draftAttributeDefinition({
      key: attributeKey,
      label: 'Frozen',
      valueType: 'measurement',
      unitFamily: 'mass',
      actorOxyUserId: OPERATOR,
    });
    // A DRAFT is editable — the negative half, without which "frozen once
    // published" could be satisfied by a trigger that froze everything always.
    await db
      .update(attributeDefinitions)
      .set({ decimalPlaces: 2 })
      .where(and(eq(attributeDefinitions.key, attributeKey), eq(attributeDefinitions.version, 1)));

    await publishAttributeDefinition(attributeKey, 1, OPERATOR);

    for (const patch of [
      { valueType: 'string' as const, unitFamily: null, baseUnit: null },
      { unitFamily: 'length' as const, baseUnit: 'mm' },
      { decimalPlaces: 4 },
      { hardConstraintCapable: true },
      { cardinality: 'set' as const },
    ]) {
      await expectRefused('trigger', () =>
        db
          .update(attributeDefinitions)
          .set(patch)
          .where(eq(attributeDefinitions.key, attributeKey)),
      );
    }

    // A label correction is explicitly allowed: "stored keys remain stable when
    // labels change" is only worth anything if a label can be corrected.
    const relabelled = await db
      .update(attributeDefinitions)
      .set({ label: 'Frozen, corrected', description: 'Now with a description' })
      .where(eq(attributeDefinitions.key, attributeKey))
      .returning();
    expect(relabelled[0]?.label).toBe('Frozen, corrected');
  });

  it('refuses to DELETE a published version', async () => {
    const attributeKey = key('undeletable');
    await draftAttributeDefinition({
      key: attributeKey,
      label: 'Undeletable',
      valueType: 'string',
      actorOxyUserId: OPERATOR,
    });
    await publishAttributeDefinition(attributeKey, 1, OPERATOR);
    await expectRefused('trigger', () =>
      db.delete(attributeDefinitions).where(eq(attributeDefinitions.key, attributeKey)),
    );
  });

  it('freezes the enum vocabulary of a published version', async () => {
    const attributeKey = key('ports');
    const draft = await draftAttributeDefinition({
      key: attributeKey,
      label: 'Ports',
      valueType: 'enum',
      enumValues: [{ value: 'usb_c', label: 'USB-C', aliases: ['USB C'] }],
      actorOxyUserId: OPERATOR,
    });
    await publishAttributeDefinition(attributeKey, 1, OPERATOR);

    // Adding a value or an alias after publication would let "USB C" resolve to
    // a different canonical value than it did when a stored value was
    // normalized.
    await expectRefused('trigger', () =>
      db
        .insert(attributeEnumValues)
        .values({ attributeDefinitionId: draft.id, value: 'hdmi', label: 'HDMI', position: 1 }),
    );
    const [existing] = await db
      .select()
      .from(attributeEnumValues)
      .where(eq(attributeEnumValues.attributeDefinitionId, draft.id));
    if (!existing) throw new Error('the enum value is missing');
    await expectRefused('trigger', () =>
      db.insert(attributeValueAliases).values({
        attributeDefinitionId: draft.id,
        enumValueId: existing.id,
        alias: 'Type-C',
      }),
    );
  });
});

describe('the definition CHECKs', () => {
  it('refuse a key that names a current OFFER fact', async () => {
    await expectRefused('check', () =>
      db.insert(attributeDefinitions).values({
        key: 'price',
        version: 1,
        label: 'Price',
        valueType: 'money',
        currency: 'EUR',
      }),
    );
    // And the service refuses it with a message that points somewhere useful.
    await expect(
      draftAttributeDefinition({
        key: 'availability',
        label: 'Availability',
        valueType: 'string',
        actorOxyUserId: OPERATOR,
      }),
    ).rejects.toThrow(/current OFFER/u);
  });

  it('refuse a half-declared measurement, money, rating and structured attribute', async () => {
    const base = { version: 1, label: 'Bad', key: `bad_${RUN}` };
    await expectRefused('check', () =>
      db.insert(attributeDefinitions).values({ ...base, valueType: 'measurement' }),
    );
    await expectRefused('check', () =>
      db.insert(attributeDefinitions).values({ ...base, valueType: 'money' }),
    );
    await expectRefused('check', () =>
      db
        .insert(attributeDefinitions)
        .values({ ...base, valueType: 'string', unitFamily: 'rating', baseUnit: 'rating_point' }),
    );
    await expectRefused('check', () =>
      db.insert(attributeDefinitions).values({
        ...base,
        valueType: 'structured',
        unitFamily: 'length',
        baseUnit: 'mm',
        componentAxes: [],
      }),
    );
    await expectRefused('check', () =>
      db.insert(attributeDefinitions).values({
        ...base,
        valueType: 'string',
        componentAxes: ['width'],
      }),
    );
  });

  it('refuse an opinion that could exclude a product', async () => {
    await expectRefused('check', () =>
      db.insert(attributeDefinitions).values({
        key: `opinion_${RUN}`,
        version: 1,
        label: 'Vibe',
        valueType: 'string',
        objectivity: 'subjective',
        hardConstraintCapable: true,
      }),
    );
    await expectRefused('check', () =>
      db.insert(attributeDefinitions).values({
        key: `invisible_${RUN}`,
        version: 1,
        label: 'Invisible',
        valueType: 'string',
        filterable: false,
        hardConstraintCapable: true,
      }),
    );
  });

  it('refuse a published version with no publication audit, and a draft with one', async () => {
    await expectRefused('check', () =>
      db.insert(attributeDefinitions).values({
        key: `audit_${RUN}`,
        version: 1,
        label: 'Audit',
        valueType: 'string',
        lifecycleState: 'active',
      }),
    );
    await expectRefused('check', () =>
      db.insert(attributeDefinitions).values({
        key: `audit2_${RUN}`,
        version: 1,
        label: 'Audit',
        valueType: 'string',
        lifecycleState: 'draft',
        publishedAt: new Date(),
      }),
    );
  });
});

describe('category scope and inheritance', () => {
  it('resolves a definition scoped to an ANCESTOR, and one scoped to none', async () => {
    const electronics = await mintCategory('electronics');
    const laptops = await mintCategory('laptops', electronics);
    const shoes = await mintCategory('shoes');

    const inherited = key('inherited');
    await draftAttributeDefinition({
      key: inherited,
      label: 'Inherited',
      valueType: 'string',
      categoryScopes: [{ categoryId: electronics, includeDescendants: true }],
      actorOxyUserId: OPERATOR,
    });
    await publishAttributeDefinition(inherited, 1, OPERATOR);

    const notInherited = key('not_inherited');
    await draftAttributeDefinition({
      key: notInherited,
      label: 'Not inherited',
      valueType: 'string',
      categoryScopes: [{ categoryId: electronics, includeDescendants: false }],
      actorOxyUserId: OPERATOR,
    });
    await publishAttributeDefinition(notInherited, 1, OPERATOR);

    const unscoped = key('unscoped');
    await draftAttributeDefinition({
      key: unscoped,
      label: 'Unscoped',
      valueType: 'string',
      actorOxyUserId: OPERATOR,
    });
    await publishAttributeDefinition(unscoped, 1, OPERATOR);

    const forLaptops = (await resolveDefinitionsForCategory(db, laptops)).map(
      (definition) => definition.row.key,
    );
    expect(forLaptops).toContain(inherited);
    // `include_descendants: false` genuinely stops at its own category — the
    // pair of assertions is what tells an inheritance rule from a global one.
    expect(forLaptops).not.toContain(notInherited);
    // An UNSCOPED definition applies anywhere; a query that only joined the
    // scope table would answer with every general attribute missing.
    expect(forLaptops).toContain(unscoped);

    const forElectronics = (await resolveDefinitionsForCategory(db, electronics)).map(
      (definition) => definition.row.key,
    );
    expect(forElectronics).toContain(notInherited);

    const forShoes = (await resolveDefinitionsForCategory(db, shoes)).map(
      (definition) => definition.row.key,
    );
    expect(forShoes).not.toContain(inherited);
    expect(forShoes).toContain(unscoped);
  });
});

describe('the value slot', () => {
  it('lets one structured observation write three rows and converge on a repeat', async () => {
    const attributeKey = key('dimensions');
    await draftAttributeDefinition({
      key: attributeKey,
      label: 'Dimensions',
      valueType: 'structured',
      unitFamily: 'length',
      componentAxes: ['height', 'width', 'depth'],
      cardinality: 'ordered_list',
      actorOxyUserId: OPERATOR,
    });
    await publishAttributeDefinition(attributeKey, 1, OPERATOR);

    const productId = await mintProduct('Dimensioned');
    const recordId = await mintSourceRecord('dims');

    const first = await applyAttributeObservation({
      grain: { kind: 'product', id: productId },
      attributeKey,
      displayValue: '155.6 x 71.5 x 8.25 mm',
      sourceRecordId: recordId,
    });
    expect(first.values).toHaveLength(3);
    expect(first.values.map((value) => value.componentAxis)).toEqual(['height', 'width', 'depth']);
    expect(first.values.every((value) => value.selectionState === 'selected')).toBe(true);

    // A re-delivery of the SAME observation writes nothing at all.
    const repeat = await applyAttributeObservation({
      grain: { kind: 'product', id: productId },
      attributeKey,
      displayValue: '155.6 x 71.5 x 8.25 mm',
      sourceRecordId: recordId,
    });
    expect(repeat.outcome).toBe('unchanged');

    const stored = await db
      .select()
      .from(canonicalAttributeValues)
      .where(
        and(
          eq(canonicalAttributeValues.productId, productId),
          eq(canonicalAttributeValues.attributeKey, attributeKey),
        ),
      );
    expect(stored).toHaveLength(3);
    expect(stored.map((row) => row.valueSlot).sort()).toEqual(['depth#2', 'height#0', 'width#1']);
  });

  it('refuses a second SELECTED value in one slot even from a raw writer', async () => {
    const attributeKey = key('finish');
    await draftAttributeDefinition({
      key: attributeKey,
      label: 'Finish',
      valueType: 'string',
      actorOxyUserId: OPERATOR,
    });
    await publishAttributeDefinition(attributeKey, 1, OPERATOR);
    const definition = await resolveActiveDefinition(db, attributeKey);
    if (!definition) throw new Error('the definition is missing');

    const productId = await mintProduct('Finished');
    const recordId = await mintSourceRecord('fina');
    await applyAttributeObservation({
      grain: { kind: 'product', id: productId },
      attributeKey,
      displayValue: 'Matte',
      sourceRecordId: recordId,
    });

    const otherRecordId = await mintSourceRecord('finb');
    await expectRefused('unique', () =>
      db.insert(canonicalAttributeValues).values({
        productId,
        attributeKey,
        attributeDefinitionId: definition.row.id,
        definitionVersion: definition.row.version,
        sourceDisplayValue: 'Gloss',
        normalizedText: 'gloss',
        normalizationState: 'normalized',
        selectionState: 'selected',
        normalizationRuleVersion: 'nr-2',
        method: 'operator',
        sourceRecordId: otherRecordId,
      }),
    );
  });

  it('refuses a selected value that is not normalized', async () => {
    const attributeKey = key('unshowable');
    await draftAttributeDefinition({
      key: attributeKey,
      label: 'Unshowable',
      valueType: 'string',
      actorOxyUserId: OPERATOR,
    });
    await publishAttributeDefinition(attributeKey, 1, OPERATOR);
    const productId = await mintProduct('Unshowable');
    const recordId = await mintSourceRecord('unsh');

    await expectRefused('check', () =>
      db.insert(canonicalAttributeValues).values({
        productId,
        attributeKey,
        sourceDisplayValue: 'whatever',
        normalizationState: 'unparsed',
        selectionState: 'selected',
        normalizationRuleVersion: 'nr-2',
        method: 'operator',
        sourceRecordId: recordId,
      }),
    );
  });
});

describe('conflicting sources', () => {
  it('select NEITHER, keep both parses, open ONE review and enqueue a reindex', async () => {
    const attributeKey = key('material');
    await draftAttributeDefinition({
      key: attributeKey,
      label: 'Material',
      valueType: 'string',
      hardConstraintCapable: false,
      actorOxyUserId: OPERATOR,
    });
    await publishAttributeDefinition(attributeKey, 1, OPERATOR);

    const productId = await mintProduct('Contested');
    const firstRecord = await mintSourceRecord('mata');
    const secondRecord = await mintSourceRecord('matb');

    const agreed = await applyAttributeObservation({
      grain: { kind: 'product', id: productId },
      attributeKey,
      displayValue: 'Titanium',
      sourceRecordId: firstRecord,
      confidence: 0.7,
    });
    expect(agreed.outcome).toBe('selected');

    const disagreed = await applyAttributeObservation({
      grain: { kind: 'product', id: productId },
      attributeKey,
      displayValue: 'Aluminium',
      sourceRecordId: secondRecord,
      confidence: 0.7,
    });
    expect(disagreed.outcome).toBe('conflicting');

    const rows = await db
      .select()
      .from(canonicalAttributeValues)
      .where(
        and(
          eq(canonicalAttributeValues.productId, productId),
          eq(canonicalAttributeValues.attributeKey, attributeKey),
        ),
      );
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.selectionState === 'conflicting')).toBe(true);
    // The PARSE survives — an operator resolving the conflict must be able to
    // see what they are choosing between.
    expect(rows.every((row) => row.normalizationState === 'normalized')).toBe(true);
    expect(rows.map((row) => row.sourceDisplayValue).sort()).toEqual(['Aluminium', 'Titanium']);

    const reviews = await db
      .select()
      .from(attributeValueReviews)
      .where(eq(attributeValueReviews.attributeKey, attributeKey));
    expect(reviews).toHaveLength(1);
    expect(reviews[0]?.reason).toBe('conflicting_sources');
    expect(reviews[0]?.state).toBe('open');

    // A THIRD disagreeing source converges on the one open review rather than
    // opening a second: `ON CONFLICT DO NOTHING` against the partial unique.
    const thirdRecord = await mintSourceRecord('matc');
    await applyAttributeObservation({
      grain: { kind: 'product', id: productId },
      attributeKey,
      displayValue: 'Carbon fibre',
      sourceRecordId: thirdRecord,
      confidence: 0.7,
    });
    const stillOne = await db
      .select()
      .from(attributeValueReviews)
      .where(eq(attributeValueReviews.attributeKey, attributeKey));
    expect(stillOne).toHaveLength(1);

    const reindex = await db
      .select()
      .from(attributeReindexRequests)
      .where(eq(attributeReindexRequests.attributeKey, attributeKey));
    expect(reindex.length).toBeGreaterThan(0);
  });

  it('lets a STRONGER source replace a weaker selection without a conflict', async () => {
    const attributeKey = key('stronger');
    await draftAttributeDefinition({
      key: attributeKey,
      label: 'Stronger',
      valueType: 'string',
      actorOxyUserId: OPERATOR,
    });
    await publishAttributeDefinition(attributeKey, 1, OPERATOR);
    const productId = await mintProduct('Improving');

    await applyAttributeObservation({
      grain: { kind: 'product', id: productId },
      attributeKey,
      displayValue: 'Guessed',
      sourceRecordId: await mintSourceRecord('strA'),
      confidence: 0.4,
    });
    const stronger = await applyAttributeObservation({
      grain: { kind: 'product', id: productId },
      attributeKey,
      displayValue: 'Measured',
      sourceRecordId: await mintSourceRecord('strB'),
      confidence: 0.9,
    });
    expect(stronger.outcome).toBe('selected');

    const selected = await db
      .select()
      .from(canonicalAttributeValues)
      .where(
        and(
          eq(canonicalAttributeValues.productId, productId),
          eq(canonicalAttributeValues.attributeKey, attributeKey),
          eq(canonicalAttributeValues.selectionState, 'selected'),
        ),
      );
    expect(selected).toHaveLength(1);
    expect(selected[0]?.sourceDisplayValue).toBe('Measured');
  });

  it('marks two AGREEING independent sources as corroborated', async () => {
    const attributeKey = key('agreeing');
    await draftAttributeDefinition({
      key: attributeKey,
      label: 'Agreeing',
      valueType: 'measurement',
      unitFamily: 'length',
      decimalPlaces: 1,
      actorOxyUserId: OPERATOR,
    });
    await publishAttributeDefinition(attributeKey, 1, OPERATOR);
    const productId = await mintProduct('Agreed');

    await applyAttributeObservation({
      grain: { kind: 'product', id: productId },
      attributeKey,
      displayValue: '6.1 in',
      sourceRecordId: await mintSourceRecord('agrA'),
      confidence: 0.7,
    });
    // A different SPELLING of the same fact, from a different source. It must
    // corroborate rather than conflict — the whole point of comparing at the
    // declared precision instead of at IEEE-754 equality.
    const second = await applyAttributeObservation({
      grain: { kind: 'product', id: productId },
      attributeKey,
      displayValue: '15.494 cm',
      sourceRecordId: await mintSourceRecord('agrB'),
      confidence: 0.7,
    });
    expect(second.outcome).toBe('agreed');

    const rows = await db
      .select()
      .from(canonicalAttributeValues)
      .where(
        and(
          eq(canonicalAttributeValues.productId, productId),
          eq(canonicalAttributeValues.attributeKey, attributeKey),
        ),
      );
    expect(rows.every((row) => row.verificationState === 'corroborated')).toBe(true);
  });
});

describe('the reindex log', () => {
  it('converges on its deterministic id', async () => {
    const attributeKey = key('reindexed');
    const input = {
      entityKind: 'product' as const,
      entityId: `product-${RUN}`,
      attributeKey,
      reason: 'definition_published' as const,
    };
    const first = await enqueueAttributeReindex(db, input);
    expect(first).toBeDefined();
    // A repeat writes NOTHING — no tuple version, no timestamp — which is what
    // makes a retried transaction and two concurrent observers one job.
    const repeat = await enqueueAttributeReindex(db, input);
    expect(repeat).toBeUndefined();

    const rows = await db
      .select()
      .from(attributeReindexRequests)
      .where(eq(attributeReindexRequests.attributeKey, attributeKey));
    expect(rows).toHaveLength(1);
  });

  it('refuses a half-claimed lease', async () => {
    await expectRefused('check', () =>
      db.insert(attributeReindexRequests).values({
        id: `half-claim-${RUN}`,
        entityKind: 'product',
        entityId: `product-${RUN}`,
        reason: 'operator_correction',
        enqueuedAt: new Date(),
        claimedAt: new Date(),
      }),
    );
  });
});
