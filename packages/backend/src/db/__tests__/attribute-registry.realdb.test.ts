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
import { and, eq, inArray, is, sql } from 'drizzle-orm';
import { PgTable, getTableConfig } from 'drizzle-orm/pg-core';
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
} from '../schema/canonicalCatalog.js';
import { NORMALIZATION_RULE_VERSION } from '@mercaria/shared-types';
import {
  draftAttributeDefinition,
  publishAttributeDefinition,
  resolveActiveDefinition,
  resolveDefinitionsForCategory,
} from '../../services/attributes/definition-registry.service.js';
import { applyAttributeObservation } from '../../services/attributes/attribute-observation.service.js';
import { enqueueAttributeReindex } from '../attributes/attributeOpsRepository.js';
import { createCanonicalProduct } from '../../services/canonical/canonical-product.service.js';
import { deleteTestCanonicalRows } from './canonical-teardown.js';

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
  // The variants are discovered from the product ids, and a sibling's match
  // decision can pin either — see `canonical-teardown.ts`.
  await deleteTestCanonicalRows(db, { productIds: createdProductIds });
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
      key: `${slug}-${RUN}`,
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

describe('an alias resolves to exactly ONE canonical value (#367 Workstream 18)', () => {
  /**
   * `attribute_value_aliases_alias_key` is the whole of this guarantee, and
   * until now nothing exercised it.
   *
   * The reason is worth writing down, because it is a failure mode a mutation
   * test cannot find: the suites that DO resolve aliases build the alias table
   * as an in-memory `Map`, where a second entry under one key silently
   * last-write-wins. The fixture is structurally INCAPABLE of expressing the
   * violation — the input space has no member that breaks the rule — so it
   * reads as coverage and passes forever. No assertion could have been mutated
   * into catching it.
   *
   * Which is why this lives against a real server: the constraint IS the
   * mechanism, and only a server can refuse.
   */
  async function draftWithAlias(name: string, alias: string) {
    const attributeKey = key(name);
    const draft = await draftAttributeDefinition({
      key: attributeKey,
      label: 'Connector',
      valueType: 'enum',
      enumValues: [
        { value: 'usb_c', label: 'USB-C', aliases: [alias] },
        { value: 'usb_c_thunderbolt', label: 'USB-C (Thunderbolt)', aliases: [] },
      ],
      actorOxyUserId: OPERATOR,
    });
    const values = await db
      .select()
      .from(attributeEnumValues)
      .where(eq(attributeEnumValues.attributeDefinitionId, draft.id));
    const plain = values.find((row) => row.value === 'usb_c');
    const thunderbolt = values.find((row) => row.value === 'usb_c_thunderbolt');
    if (!plain || !thunderbolt) throw new Error('the enum values are missing');
    return { draft, plain, thunderbolt };
  }

  it('refuses a second alias with the same spelling, under a DIFFERENT value', async () => {
    const { draft, plain, thunderbolt } = await draftWithAlias('connector_exact', 'USB C');

    // The positive control FIRST: a different spelling under the second value
    // is legitimate and must still be admitted, or the refusal below would be
    // satisfied by a table that refused every alias.
    await db.insert(attributeValueAliases).values({
      attributeDefinitionId: draft.id,
      enumValueId: thunderbolt.id,
      alias: 'Thunderbolt 4',
    });

    // Without the index, "USB C" resolves to `usb_c` or `usb_c_thunderbolt`
    // depending on row order — a stored value's meaning decided by a physical
    // detail nobody controls.
    await expectRefused('unique', () =>
      db.insert(attributeValueAliases).values({
        attributeDefinitionId: draft.id,
        enumValueId: thunderbolt.id,
        alias: 'USB C',
      }),
    );
    // And under the SAME value it is still one row, not two: the constraint is
    // on the spelling, not on the pair.
    await expectRefused('unique', () =>
      db.insert(attributeValueAliases).values({
        attributeDefinitionId: draft.id,
        enumValueId: plain.id,
        alias: 'USB C',
      }),
    );
  });

  it('folds case and surrounding space before comparing, so neither dodges the index', async () => {
    const { draft, thunderbolt } = await draftWithAlias('connector_folded', 'USB C');

    // `normalized_alias` is GENERATED as `lower(btrim(alias))`. This is the half
    // an in-memory `Map` keyed on the raw spelling could never have caught: it
    // holds `USB C` and `  usb c  ` as two different keys and admits both, which
    // is exactly the collision that puts one source's spelling on the wrong
    // canonical value.
    //
    // CASE and leading/trailing SPACES are all this asserts, and the omission is
    // deliberate. Postgres `btrim(x)` trims SPACES only and collapses no
    // interior run, while the READ side folds with `normalizeOptionValue`
    // (`trim()` + `\s+` → one space + lowercase) — so `USB C\t` and `USB  C`
    // are one key to a lookup and two rows to this index. That is issue #632,
    // found here. Asserting either direction for those two spellings would pin
    // the defect, so this asserts neither.
    for (const spelling of ['usb c', '  USB C  ', 'Usb C']) {
      await expectRefused('unique', () =>
        db.insert(attributeValueAliases).values({
          attributeDefinitionId: draft.id,
          enumValueId: thunderbolt.id,
          alias: spelling,
        }),
      );
    }

    // The control on the FOLDING rather than on the index: folding is not
    // collapsing everything. An interior space is part of the spelling, so
    // `USBC` is a different alias and is admitted.
    await db.insert(attributeValueAliases).values({
      attributeDefinitionId: draft.id,
      enumValueId: thunderbolt.id,
      alias: 'USBC',
    });
    const stored = await db
      .select()
      .from(attributeValueAliases)
      .where(eq(attributeValueAliases.attributeDefinitionId, draft.id));
    expect(stored.map((row) => row.normalizedAlias).sort()).toEqual(['usb c', 'usbc']);
  });

  it('scopes the uniqueness to the DEFINITION, so two attributes may share a spelling', async () => {
    // "Black" means one thing under `colour` and another under `keyboard_backlight`.
    // A globally unique alias would make the second definition unable to name it.
    const first = await draftWithAlias('connector_scope_a', 'Shared Spelling');
    const second = await draftWithAlias('connector_scope_b', 'Shared Spelling');
    const rows = await db
      .select()
      .from(attributeValueAliases)
      .where(
        inArray(attributeValueAliases.attributeDefinitionId, [first.draft.id, second.draft.id]),
      );
    expect(rows.filter((row) => row.normalizedAlias === 'shared spelling')).toHaveLength(2);
  });
});

describe('every stored claim cites the rule version it was read under (#367 Workstream 18)', () => {
  it('stamps the ACTIVE normalization rule version and the definition version it used', async () => {
    // The literals `'nr-2'` elsewhere in this file are INPUTS to inserts
    // expected to be refused for unrelated reasons — a literal appearing in a
    // test is not the same as a literal being asserted. This is the assertion:
    // one side is the row the production write path produced, the other is the
    // declared constant, so a service that hardcoded a version instead of
    // reading the constant goes red here and nowhere else.
    const attributeKey = key('rule_version_cited');
    await draftAttributeDefinition({
      key: attributeKey,
      label: 'Coating',
      valueType: 'string',
      actorOxyUserId: OPERATOR,
    });
    await publishAttributeDefinition(attributeKey, 1, OPERATOR);
    const definition = await resolveActiveDefinition(db, attributeKey);
    if (!definition) throw new Error('the definition is missing');

    const productId = await mintProduct('Coated');
    const recordId = await mintSourceRecord('rulv');
    await applyAttributeObservation({
      grain: { kind: 'product', id: productId },
      attributeKey,
      displayValue: 'Anodised',
      sourceRecordId: recordId,
    });

    const [stored] = await db
      .select()
      .from(canonicalAttributeValues)
      .where(
        and(
          eq(canonicalAttributeValues.productId, productId),
          eq(canonicalAttributeValues.attributeKey, attributeKey),
        ),
      );
    if (!stored) throw new Error('the observation wrote no value');

    // A vacuity floor on the constant itself: comparing a stored empty string
    // against a declared empty string would pass and mean nothing.
    expect(NORMALIZATION_RULE_VERSION.length).toBeGreaterThan(0);
    expect(stored.normalizationRuleVersion).toBe(NORMALIZATION_RULE_VERSION);

    // #94's other half of the same rule: the claim cites the definition it was
    // read under, by id AND version, so a later version cannot silently
    // reinterpret it.
    expect(stored.attributeDefinitionId).toBe(definition.row.id);
    expect(stored.definitionVersion).toBe(definition.row.version);
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
      displayValue: '1.1 in',
      sourceRecordId: await mintSourceRecord('agrA'),
      confidence: 0.7,
    });
    // A different SPELLING of the same fact, from a different source, whose
    // conversion lands on a DIFFERENT double (27.940000000000004832 vs
    // 27.940000000000001279 — measured). It must corroborate rather than
    // conflict, which is the whole point of comparing at the declared precision
    // instead of at IEEE-754 equality; a pair whose conversions happened to be
    // bit-identical would pass against either reading.
    const second = await applyAttributeObservation({
      grain: { kind: 'product', id: productId },
      attributeKey,
      displayValue: '2.794 cm',
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

describe('ONE authoritative attribute definition registry (#367)', () => {
  /**
   * #94 says it EXTENDS #56's registry — "one registry, not two"
   * (`db/schema/canonicalCatalog.ts:12`). That sentence is the whole of the
   * enforcement: `attribute_definitions` is declared once, the two tables
   * `canonicalCatalog.ts` used to own were MOVED here, and **nothing would fail
   * if somebody added a second definition table.** A sentence asserting an
   * invariant is evidence that somebody knew the invariant, not that it holds.
   *
   * ## Why this reads `information_schema` and not the drizzle barrel
   *
   * A walk of the barrel's `PgTable` exports measures what drizzle MODELS. This
   * repo creates real objects from hand-written SQL in migrations — every trigger
   * in the schema, for one — so a table created that way is invisible to a barrel
   * walk and visible here. The database is the authority on what exists in it.
   *
   * ## Two instruments, because each catches what the other cannot
   *
   * The NAME census catches `product_type_attribute_definitions` — a plausible,
   * well-intentioned second registry. The SHAPE census catches one called
   * anything at all: a table that defines attributes has to say which attribute
   * (`key`) and what type its values are (`value_type`), and today exactly one
   * table in 445 carries that pair. Neither is a superset of the other, so both
   * are asserted EXACTLY rather than as floors.
   */
  /**
   * Live base tables that no drizzle `pgTable` declares.
   *
   * Measured, not assumed — the gate named it on its first run. There is exactly
   * ONE: `spatial_ref_sys`, PostGIS's spatial-reference catalogue, created by
   * `CREATE EXTENSION postgis` and owned by a privileged role rather than by any
   * migration in this repo.
   *
   * Worth stating what it is NOT: the migration ledger. Drizzle keeps that in the
   * `drizzle` SCHEMA, so a census filtered to `public` never sees it — which is
   * why "the extra table is probably the ledger" would have been a plausible,
   * confident and wrong answer.
   *
   * Kept EXACT: a new entry means somebody created a table from hand-written
   * migration SQL, which is legitimate and is precisely the thing a barrel walk
   * cannot see.
   */
  const UNMODELLED_LIVE_TABLES: readonly string[] = ['spatial_ref_sys'];

  interface TableShape {
    readonly name: string;
    readonly columns: ReadonlySet<string>;
  }

  let shapes: TableShape[] = [];

  beforeAll(async () => {
    const rows = await db.execute<{ table_name: string; column_name: string }>(sql`
      select c.table_name, c.column_name
        from information_schema.columns c
        join information_schema.tables t
          on t.table_schema = c.table_schema and t.table_name = c.table_name
       where c.table_schema = 'public' and t.table_type = 'BASE TABLE'
    `);
    const byTable = new Map<string, Set<string>>();
    for (const row of rows) {
      const set = byTable.get(row.table_name) ?? new Set<string>();
      set.add(row.column_name);
      byTable.set(row.table_name, set);
    }
    shapes = [...byTable].map(([name, columns]) => ({ name, columns }));
  });

  it('walked the real database, not a fragment of it', () => {
    // The vacuity floor. Both censuses below are ABSENCE claims over this set, so
    // a query that returned three tables would report a clean registry for the
    // same reason a broken one would. A floor rather than an equality because
    // this number moves with every migration anybody lands.
    expect(
      shapes.length,
      `the information_schema census found ${String(shapes.length)} tables, which is far too few — ` +
        'it is measuring a fragment and every count below is meaningless',
    ).toBeGreaterThanOrEqual(300);
    process.stdout.write(
      `attribute registry census: ${String(shapes.length)} tables in the live schema\n`,
    );
  });

  it('accounts for every live table drizzle does not model', async () => {
    // 446 live base tables against 445 `pgTable` declarations in source. That gap
    // is the reason this census reads `information_schema` rather than the barrel
    // — and a base table nothing in source models is boring 99 times and a
    // finding the hundredth, so it is NAMED rather than left as an off-by-one.
    const barrel = await import('../schema/index.js');
    const modelled = new Set<string>();
    for (const value of Object.values(barrel)) {
      if (is(value, PgTable)) modelled.add(getTableConfig(value).name);
    }
    const unmodelled = shapes
      .map((table) => table.name)
      .filter((name) => !modelled.has(name))
      .sort();
    // The positive control: the barrel really was walked. An import that resolved
    // to an empty module would make every live table "unmodelled" and the
    // assertion below would fail loudly — but a floor says so in one line.
    expect(modelled.size, 'the barrel walk found no tables at all').toBeGreaterThan(300);
    expect(
      unmodelled,
      `live base tables that no \`pgTable\` in the barrel declares: ${unmodelled.join(', ')}`,
    ).toEqual(UNMODELLED_LIVE_TABLES);
  });

  it('has exactly one table whose NAME claims to define attributes', () => {
    const named = shapes
      .filter((table) => table.name.includes('attribute') && table.name.includes('definition'))
      .map((table) => table.name)
      .sort();
    // `attribute_definition_categories` is the SCOPE join — which categories a
    // definition applies to — and is named here rather than excluded by a
    // pattern, so a third table cannot arrive by resembling it.
    expect(named).toEqual(['attribute_definition_categories', 'attribute_definitions']);
  });

  it('has exactly one table SHAPED like an attribute definition registry', () => {
    // `key` says which attribute, `value_type` says what its values are. A second
    // registry cannot avoid carrying both and still be one, whatever it is
    // called — which is what makes this the instrument that survives a name
    // nobody predicted. `product_type_definitions` and `navigation_trees` carry
    // `key` and `version` and a lifecycle without carrying `value_type`, which is
    // why the pair and not the triple.
    const shaped = shapes
      .filter((table) => table.columns.has('key') && table.columns.has('value_type'))
      .map((table) => table.name)
      .sort();
    expect(shaped).toEqual(['attribute_definitions']);
  });

  it('goes RED on a second registry that does not exist yet — the mutation self-test', async () => {
    // A census that has only ever seen the healthy state is a census nobody has
    // watched fail. This creates the two tables it exists to catch — INSIDE a
    // transaction that is rolled back, so nothing is left behind for the parallel
    // files sharing this database — and re-runs the same two filters against the
    // transaction's own view of `information_schema`.
    //
    // Both shapes are the plausible mistake rather than a contrived one:
    // `product_type_attribute_definitions` is what somebody adds when product
    // types need their own attribute meanings, and `spec_fields` is the same
    // second registry under a name no pattern would predict.
    const census = async (tx: typeof db) => {
      const rows = await tx.execute<{ table_name: string; column_name: string }>(sql`
        select c.table_name, c.column_name
          from information_schema.columns c
          join information_schema.tables t
            on t.table_schema = c.table_schema and t.table_name = c.table_name
         where c.table_schema = 'public' and t.table_type = 'BASE TABLE'
      `);
      const byTable = new Map<string, Set<string>>();
      for (const row of rows) {
        const set = byTable.get(row.table_name) ?? new Set<string>();
        set.add(row.column_name);
        byTable.set(row.table_name, set);
      }
      const all = [...byTable].map(([name, columns]) => ({ name, columns }));
      return {
        named: all
          .filter((t) => t.name.includes('attribute') && t.name.includes('definition'))
          .map((t) => t.name)
          .sort(),
        shaped: all
          .filter((t) => t.columns.has('key') && t.columns.has('value_type'))
          .map((t) => t.name)
          .sort(),
      };
    };

    let observed: Awaited<ReturnType<typeof census>> | null = null;
    await db
      .transaction(async (tx) => {
        await tx.execute(sql`create table product_type_attribute_definitions (id text primary key)`);
        await tx.execute(sql`create table spec_fields (id text primary key, key text, value_type text)`);
        observed = await census(tx as unknown as typeof db);
        tx.rollback();
      })
      .catch((error: unknown) => {
        // `tx.rollback()` throws by design; anything else is a real failure.
        if (!(error instanceof Error) || !/rollback/iu.test(error.message)) throw error;
      });

    expect(observed, 'the mutation transaction never ran').not.toBeNull();
    // The NAME census sees the plausible second registry...
    expect(observed?.named).toContain('product_type_attribute_definitions');
    // ...and the SHAPE census sees the one whose name says nothing, which is the
    // half a name pattern could never catch.
    expect(observed?.shaped).toContain('spec_fields');
    expect(observed?.shaped).toHaveLength(2);

    // And the rollback really rolled back: neither table survives.
    const after = await census(db);
    expect(after.named).not.toContain('product_type_attribute_definitions');
    expect(after.shaped).toEqual(['attribute_definitions']);
  });

  it('both censuses are non-vacuous — the positive control', () => {
    // Each census above is an absence claim, and a filter that matched nothing
    // would satisfy both by finding nothing at all. These assert the filters
    // really do select on what they claim to: the name filter finds the table by
    // name, and the shape filter finds a column pair that genuinely exists.
    const registry = shapes.find((table) => table.name === 'attribute_definitions');
    expect(registry, 'attribute_definitions is not in the live schema at all').toBeDefined();
    expect(registry?.columns.has('key')).toBe(true);
    expect(registry?.columns.has('value_type')).toBe(true);
    // And a table that must NOT match either census, so neither is matching
    // everything: the product-type registry is a different registry on purpose.
    const productTypes = shapes.find((table) => table.name === 'product_type_definitions');
    expect(productTypes, 'product_type_definitions is missing; the control is broken').toBeDefined();
    expect(productTypes?.columns.has('value_type')).toBe(false);
  });
});
