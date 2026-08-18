/**
 * `composeDefinitionDiff` — the HYDRATION behind `GET /diff/product-types/:key`
 * and `GET /diff/attributes/:key` — against a REAL PostgreSQL server
 * (#367 Workstream 12, issue #587).
 *
 * ## Why this file exists
 *
 * `diff.test.ts` covers the pure differ well: twenty-one table cases over plain
 * data. What it did NOT cover is the only thing the two routes actually call.
 * `composeDefinitionDiff` had no behavioural test of any kind — its sole
 * appearance in the suite was two route-name strings in a census — while
 * `diff.test.ts`'s own header claimed "definition-diff.service.ts's hydration is
 * what the realdb suite covers", which `catalog-governance.realdb.test.ts` never
 * did. A false coverage claim is worse than none: it is the sentence that stops
 * the next reader looking.
 *
 * ## What only a real server can measure here
 *
 * Every property below is a property of the READS, not of the diff rule:
 *
 * - Fields are read PER FLOW and concatenated. A hydration that read only
 *   `merchant` would report every P2P-only field as absent from both sides,
 *   which produces no entry at all — a diff that is silently short rather than
 *   wrong, and therefore invisible in its output.
 * - A field's group is compared by group KEY, and group rows are minted per
 *   version. Two versions carrying the same group key are two different
 *   `product_type_field_groups.id`s, so a hydration that carried the id would
 *   report every field as regrouped.
 * - Category scopes come from `product_type_category_scopes`, sorted.
 * - The attribute half reads through `resolveDefinitionVersion`, so its enum
 *   values and category scopes are rows rather than a shape a fixture invented.
 *
 * A hand-built fixture can state none of those: it would be the test asserting
 * its own idea of what the database holds.
 *
 * ## Scoping, because this database is SHARED
 *
 * Every row lives under this run's own vertical namespace token, and every
 * version this file mints stays a DRAFT so teardown can delete it —
 * `product_type_definitions_immutable_once_published` refuses the delete
 * otherwise. `composeDefinitionDiff` reads by `(key, version)` and filters on no
 * lifecycle, deliberately (ADR 0007 D5: a deprecated version still resolves the
 * records that pin it), so a draft pair exercises the identical read path.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';

import { connectPostgres, type Database } from '../../../db/postgres.js';
import {
  insertProductTypeDefinition,
  type ProductTypeDefinitionRow,
} from '../../../db/productTypes/productTypeRepository.js';
import {
  insertProductTypeCategoryScope,
  insertProductTypeField,
  insertProductTypeFieldGroup,
} from '../../../db/productTypes/productTypeFieldRepository.js';
import {
  findActiveAttributeDefinition,
  insertAttributeDefinition,
  insertAttributeEnumValue,
  type AttributeDefinitionRow,
} from '../../../db/attributes/definitionRepository.js';
import { composeDefinitionDiff } from '../definition-diff.service.js';
import { nsKey, type VerticalNamespace } from '../../../scripts/seed-verticals/apply.js';
import { SMARTPHONE_PACKAGE } from '../../../scripts/seed-verticals/smartphone.js';
import {
  seedVerticalForTest,
  teardownVertical,
  verticalRunToken,
  type SeededVertical,
} from '../../../scripts/seed-verticals/__tests__/vertical-fixture.js';

const TOKEN = verticalRunToken('gdiff');

let db: Database;
let phones: SeededVertical;
let ns: VerticalNamespace;
let typeKey: string;
let v1: ProductTypeDefinitionRow;
let v2: ProductTypeDefinitionRow;
let attributeKey: string;
let attrV1: AttributeDefinitionRow;
let attrV2: AttributeDefinitionRow;
let categoryA: string;
let categoryB: string;

/** One attribute the seeded vertical published, with the triple a field must cite. */
function citation(key: string): { id: string; key: string; version: number } {
  const id = phones.handles.attributeIds.get(key);
  const version = phones.handles.attributeVersions.get(key);
  if (id === undefined || version === undefined) {
    throw new Error(`the smartphone package did not seed the attribute "${key}"`);
  }
  return { id, key: nsKey(ns, key), version };
}

function categoryOf(key: string): string {
  const id = phones.handles.categoryIds.get(key);
  if (id === undefined) throw new Error(`the smartphone package did not seed the category "${key}"`);
  return id;
}

beforeAll(async () => {
  db = await connectPostgres();
  phones = await seedVerticalForTest(db, SMARTPHONE_PACKAGE, TOKEN);
  ns = phones.ns;

  categoryA = categoryOf('phones.smartphones');
  categoryB = categoryOf('phones');
  const chipset = citation('chipset');
  const ram = citation('ram_capacity');
  const colour = citation('phone_color');

  // A key of this file's own, so the vertical's published `smartphone` type is
  // untouched and both versions here stay deletable.
  typeKey = `${ns.snake}_diffable`;

  v1 = await insertProductTypeDefinition(db, {
    key: typeKey,
    version: 1,
    name: `Diffable v1 (${TOKEN})`,
    createdByOxyUserId: phones.actorOxyUserId,
  });
  const v1Group = await insertProductTypeFieldGroup(db, {
    productTypeDefinitionId: v1.id,
    key: 'configuration',
    label: 'Configuration',
    position: 0,
  });
  await insertProductTypeField(db, {
    productTypeDefinitionId: v1.id,
    groupId: v1Group.id,
    attributeDefinitionId: chipset.id,
    attributeKey: chipset.key,
    attributeDefinitionVersion: chipset.version,
    scope: 'product',
    flow: 'merchant',
    requirement: 'optional',
    valuePolicy: 'controlled_value',
  });
  // The P2P-only field. Its presence in v1 and absence from v2 is what proves
  // both flows were read — a merchant-only hydration emits NO entry for it.
  await insertProductTypeField(db, {
    productTypeDefinitionId: v1.id,
    attributeDefinitionId: ram.id,
    attributeKey: ram.key,
    attributeDefinitionVersion: ram.version,
    scope: 'product',
    flow: 'p2p',
    requirement: 'optional',
    valuePolicy: 'typed_scalar',
  });
  await insertProductTypeCategoryScope(db, {
    productTypeDefinitionId: v1.id,
    categoryId: categoryA,
  });

  v2 = await insertProductTypeDefinition(db, {
    key: typeKey,
    version: 2,
    name: `Diffable v2 (${TOKEN})`,
    createdByOxyUserId: phones.actorOxyUserId,
  });
  // The SAME group key, a DIFFERENT group row. A hydration carrying group ids
  // would report the chipset field as regrouped.
  const v2Group = await insertProductTypeFieldGroup(db, {
    productTypeDefinitionId: v2.id,
    key: 'configuration',
    label: 'Configuration',
    position: 0,
  });
  await insertProductTypeField(db, {
    productTypeDefinitionId: v2.id,
    groupId: v2Group.id,
    attributeDefinitionId: chipset.id,
    attributeKey: chipset.key,
    attributeDefinitionVersion: chipset.version,
    scope: 'product',
    flow: 'merchant',
    // The one deliberate change on the surviving field.
    requirement: 'required',
    valuePolicy: 'controlled_value',
  });
  await insertProductTypeField(db, {
    productTypeDefinitionId: v2.id,
    groupId: v2Group.id,
    attributeDefinitionId: colour.id,
    attributeKey: colour.key,
    attributeDefinitionVersion: colour.version,
    scope: 'variant',
    flow: 'merchant',
    requirement: 'optional',
    valuePolicy: 'controlled_value',
    variantCapable: true,
  });
  await insertProductTypeCategoryScope(db, {
    productTypeDefinitionId: v2.id,
    categoryId: categoryA,
  });
  await insertProductTypeCategoryScope(db, {
    productTypeDefinitionId: v2.id,
    categoryId: categoryB,
  });

  // The attribute half. A second version of a key the vertical published,
  // derived FROM the stored row so this file does not have to restate every
  // NOT NULL column the registry demands — and so the only differences are the
  // ones it sets on purpose.
  const active = await findActiveAttributeDefinition(db, nsKey(ns, 'phone_color'));
  if (active === undefined) throw new Error('the seeded phone_color attribute is not active');
  attrV1 = active;
  attributeKey = active.key;
  const { id: _id, createdAt: _createdAt, updatedAt: _updatedAt, ...carried } = active;
  attrV2 = await insertAttributeDefinition(db, {
    ...carried,
    version: active.version + 1,
    lifecycleState: 'draft',
    publishedAt: null,
    publishedByOxyUserId: null,
    deprecatedAt: null,
    // The properties this file changes, so the diff has something to find that
    // is a column rather than a child row. BOTH move together because
    // `attribute_definitions_hard_constraint_check` is
    // `hard_constraint_capable is false or (objective and filterable)` — a rule
    // nobody can see as a filter may not exclude a product — so withdrawing
    // `filterable` alone is a row the server refuses.
    filterable: false,
    hardConstraintCapable: false,
  });
  await insertAttributeEnumValue(db, attrV2.id, 'diff_only_value', 'Diff only value', 99);
}, 240_000);

afterAll(async () => {
  await db.execute(sql`
    delete from attribute_enum_values where attribute_definition_id = ${attrV2.id}
  `);
  await db.execute(sql`delete from attribute_definitions where id = ${attrV2.id}`);
  await db.execute(sql`
    delete from product_type_fields where product_type_definition_id in (${v1.id}, ${v2.id})
  `);
  await db.execute(sql`
    delete from product_type_category_scopes where product_type_definition_id in (${v1.id}, ${v2.id})
  `);
  await db.execute(sql`
    delete from product_type_field_groups where product_type_definition_id in (${v1.id}, ${v2.id})
  `);
  await db.execute(sql`delete from product_type_definitions where id in (${v1.id}, ${v2.id})`);
  await teardownVertical(db, TOKEN);
}, 240_000);

describe('hydrating two product-type versions', () => {
  it('reads every flow, so a P2P-only field is reported as removed', async () => {
    const diff = await composeDefinitionDiff(db, {
      subjectKind: 'product_type_definition',
      key: typeKey,
      fromVersion: 1,
      toVersion: 2,
    });

    expect(diff.fromVersion).toBe(1);
    expect(diff.toVersion).toBe(2);
    // The vacuity floor: a hydration that read nothing produces an empty diff,
    // which every `find` below would then report as `undefined` rather than as
    // a wrong value.
    expect(diff.entries.length, `${String(diff.entries.length)} diff entries`).toBeGreaterThan(0);

    const ramKey = `p2p:product:${nsKey(ns, 'ram_capacity')}`;
    const removed = diff.entries.find((entry) => entry.key === ramKey);
    expect(
      removed,
      'the P2P-only field produced no entry, so the hydration read only one flow',
    ).toBeDefined();
    expect(removed?.change).toBe('removed');
    expect(removed?.breaking).toBe(true);
  });

  it('compares groups by KEY, so a re-minted group is not a regrouping', async () => {
    const diff = await composeDefinitionDiff(db, {
      subjectKind: 'product_type_definition',
      key: typeKey,
      fromVersion: 1,
      toVersion: 2,
    });

    const chipsetKey = `merchant:product:${nsKey(ns, 'chipset')}`;
    const onChipset = diff.entries.filter((entry) => entry.key === chipsetKey);
    // The field really is in the diff — otherwise "no groupKey entry" would be
    // satisfied by the field never having been read.
    expect(onChipset.length, 'the surviving field produced no entry at all').toBeGreaterThan(0);
    expect(onChipset.map((entry) => entry.property)).not.toContain('groupKey');
    // And the change it SHOULD carry is there, which is what says the two rows
    // were genuinely compared rather than both read as absent.
    const requirement = onChipset.find((entry) => entry.property === 'requirement');
    expect(requirement?.before).toBe('optional');
    expect(requirement?.after).toBe('required');
    expect(requirement?.breaking).toBe(true);
  });

  it('reads the category scopes each version declares', async () => {
    const diff = await composeDefinitionDiff(db, {
      subjectKind: 'product_type_definition',
      key: typeKey,
      fromVersion: 1,
      toVersion: 2,
    });

    const added = diff.entries.find((entry) => entry.key === `category:${categoryB}`);
    expect(added, 'the widened category scope was not read').toBeDefined();
    expect(added?.change).toBe('added');
    // The scope both versions share produces NO entry, which is the other half
    // of "the scopes were compared" rather than "one side was empty".
    expect(diff.entries.find((entry) => entry.key === `category:${categoryA}`)).toBeUndefined();
  });

  it('reports the added variant field with its own key shape', async () => {
    const diff = await composeDefinitionDiff(db, {
      subjectKind: 'product_type_definition',
      key: typeKey,
      fromVersion: 1,
      toVersion: 2,
    });
    const colour = diff.entries.find(
      (entry) => entry.key === `merchant:variant:${nsKey(ns, 'phone_color')}`,
    );
    expect(colour?.change).toBe('added');
    // Optional, so not breaking — the direction `diff.test.ts` exists to pin,
    // measured here against rows rather than a literal.
    expect(colour?.breaking).toBe(false);
  });
});

describe('hydrating two attribute versions', () => {
  it('reads the version rows and their enum values', async () => {
    const diff = await composeDefinitionDiff(db, {
      subjectKind: 'attribute_definition',
      key: attributeKey,
      fromVersion: attrV1.version,
      toVersion: attrV2.version,
    });

    expect(diff.subjectKind).toBe('attribute_definition');
    expect(diff.entries.length, `${String(diff.entries.length)} diff entries`).toBeGreaterThan(0);

    const filterable = diff.entries.find((entry) => entry.property === 'filterable');
    expect(filterable, 'the changed column was not read off the version rows').toBeDefined();
    expect(filterable?.before).toBe(String(attrV1.filterable));
    expect(filterable?.after).toBe(String(attrV2.filterable));

    // The enum value exists only on v2, and only a read of
    // `attribute_enum_values` can see it.
    const added = diff.entries.find((entry) => entry.key === 'value:diff_only_value');
    expect(added, 'the controlled value added on v2 was not read').toBeDefined();
    expect(added?.change).toBe('added');
  });
});

describe('what the hydration refuses', () => {
  it('refuses a diff of one version against itself', async () => {
    await expect(
      composeDefinitionDiff(db, {
        subjectKind: 'product_type_definition',
        key: typeKey,
        fromVersion: 2,
        toVersion: 2,
      }),
    ).rejects.toThrow(/two different versions/iu);
  });

  it('refuses a version that does not exist, naming it', async () => {
    await expect(
      composeDefinitionDiff(db, {
        subjectKind: 'product_type_definition',
        key: typeKey,
        fromVersion: 1,
        toVersion: 4_242,
      }),
    ).rejects.toThrow(/4242/u);
  });

  it('refuses a subject kind that has no versioned schema', async () => {
    await expect(
      composeDefinitionDiff(db, {
        subjectKind: 'category',
        key: typeKey,
        fromVersion: 1,
        toVersion: 2,
      }),
    ).rejects.toThrow(/no versioned schema to diff/iu);
  });
});
