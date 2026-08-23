/**
 * Allowed value SUBSETS per product-type field (#367 W7, epic line 235).
 *
 * *"Support allowed value subsets and category/product-type-specific
 * constraints without copying value records."* The audit split that line: the
 * category/product-type-specific constraints were already there
 * (`attribute_definition_categories`, plus `requirement`, `valuePolicy`,
 * `variantCapable` and `visibilityRule` per field); the SUBSET half was absent
 * at every grain, under every name.
 *
 * ## The absence was measured at the composition, which is why this file exists
 *
 * `schema.service.ts` composed `controlledValues:
 * valuesByDefinition.get(field.attributeDefinitionId) ?? []` — every field got
 * its cited definition's FULL set. There was no filter to widen; there was no
 * filter. So the property under test is what a COMPOSITION serves, and nothing
 * short of the real service over real rows can measure it: a mocked repository
 * would let this file assert that the service applies a filter this file wrote.
 *
 * ## Why a real database, specifically
 *
 * Two of the four properties here are enforced by the SCHEMA and have no mocked
 * counterpart at all:
 *
 *  - a subset naming a value from a DIFFERENT attribute than its field cites is
 *    refused by a composite foreign key, not by a service branch;
 *  - and both composite keys are asserted to EXIST in `pg_constraint`, because
 *    drizzle-kit has silently dropped a composite key it modelled and the
 *    declaration would still read correctly.
 *
 * ## The clause is "without copying value records", and it is not vacuous now
 *
 * Before this, nothing subsetted, so nothing copied — the clause held for the
 * absence of the capability. The way somebody satisfies its words and breaks its
 * intent is a `text[]` of permitted value spellings, which is #56's
 * `allowed_values text[]` again: that column was REMOVED rather than kept beside
 * `attribute_enum_values`, because two representations of the permitted set
 * disagree the moment one is edited. So one case asserts the stored subset holds
 * value IDS and that the composed values are the registry's own rows, identity
 * by identity.
 *
 * ## Scoping, because the database is SHARED
 *
 * Every identifier carries a per-run suffix, every assertion names ids this file
 * inserted, and teardown deletes exactly what it created — subsets before
 * fields, because the subset's key onto the field is `cascade` but its key onto
 * the enum value is `no action` and the values go last.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inArray, sql } from 'drizzle-orm';
import { uuidv7 } from '@oxyhq/db';
import type { AuthoringPermissionContext } from '@mercaria/shared-types';
import { closePostgres, connectPostgres, type Database } from '../../../db/postgres.js';
import { categories } from '../../../db/schema/catalog.js';
import {
  attributeDefinitions,
  attributeEnumValues,
} from '../../../db/schema/attributeRegistry.js';
import {
  productTypeCategoryScopes,
  productTypeDefinitions,
  productTypeFieldAllowedValues,
  productTypeFields,
} from '../../../db/schema/productTypes.js';
import { clearAuthoringSchemaMemo, composeAuthoringSchema } from '../schema.service.js';

let db: Database;

/** Unique to this run, so parallel files cannot collide on a shared database. */
const RUN = uuidv7().slice(-12).replace(/\W/gu, '');

/**
 * A version number this file owns.
 *
 * `attribute_definitions` is keyed `(key, version)` and a sibling could
 * plausibly define the same key at version 1, so this file writes high and
 * derives the number from its own run suffix — the neighbouring file's device.
 */
const ATTR_VERSION = 910_000 + (Number.parseInt(RUN.slice(-4), 36) % 80_000);

const TYPE_KEY = `pt_subset_${RUN}`.toLowerCase();

/** Every permission on, so nothing below can be refused for an unrelated reason. */
const PERMISSIONS: AuthoringPermissionContext = {
  canEditDraft: true,
  canPublish: true,
  canProposeValues: true,
  canSelectCanonicalEntity: true,
};

/** The five values the NARROWED attribute defines, in registry order. */
const CAPACITY_VALUES = ['64gb', '128gb', '256gb', '512gb', '1tb'] as const;
/** The three a phone form permits — deliberately NOT a prefix of the five. */
const PERMITTED = ['128gb', '512gb', '256gb'] as const;
/**
 * The un-narrowed attribute's values. THREE and not one, so "a field with no
 * subset serves every value" is a real set rather than a single row that a
 * broken filter could return by accident.
 */
const COLOUR_VALUES = ['graphite', 'silver', 'midnight'] as const;

const createdDefinitionIds: string[] = [];
const createdAttributeIds: string[] = [];
const createdCategoryIds: string[] = [];

let categoryId: string;
let capacityAttributeId: string;
/** A SECOND enum attribute, so "a value from another attribute" is testable. */
let colourAttributeId: string;
let colourValueId: string;
/** The field that IS narrowed, and the one that is not — the control. */
let narrowedFieldId: string;
let untouchedFieldId: string;
/**
 * A SECOND version of the same key, left in `draft` for the constraint cases.
 *
 * They cannot run against the published version: `product_type_field_allowed_
 * values_frozen` is a BEFORE ROW trigger and Postgres fires those before it
 * checks foreign keys, so on a published field the freeze would raise FIRST and
 * every constraint assertion below would be naming a constraint that never ran.
 */
let draftFieldId: string;
/** `attribute_enum_values.id` by value, for the attribute under test. */
const capacityValueIds = new Map<string, string>();

async function compose() {
  return composeAuthoringSchema(db, {
    productTypeKey: TYPE_KEY,
    categoryId,
    flow: 'merchant',
    requestedLocale: 'en',
    market: 'ES',
    permissions: PERMISSIONS,
  });
}

/**
 * The message of a driver error's CAUSE, which is where Postgres' own text
 * lives — the top-level one is always `Failed query: …`.
 */
function causeMessage(error: unknown): string {
  const parts: string[] = [];
  for (let cursor: unknown = error, depth = 0; cursor && depth < 5; depth += 1) {
    const record = cursor as { message?: string; cause?: unknown };
    if (record.message) parts.push(record.message);
    cursor = record.cause;
  }
  return parts.join(' | ');
}

/** The composed field for one attribute key, or `undefined`. */
function fieldFor(schema: Awaited<ReturnType<typeof compose>>, key: string) {
  if (schema.outcome !== 'composed') return undefined;
  return schema.schema.fields.find((field) => field.key === key);
}

beforeAll(async () => {
  db = await connectPostgres();

  const [category] = await db
    .insert(categories)
    .values({
      key: `pt_subset_cat_${RUN}`.toLowerCase(),
      name: `Subset vertical ${RUN}`,
      slug: `pt-subset-cat-${RUN}`,
      // A structural node is refused by the composition, so a fixture leaving
      // this false would refuse for the wrong reason in every case below.
      selectable: true,
    })
    .returning();
  createdCategoryIds.push(category.id);
  categoryId = category.id;

  const [capacity] = await db
    .insert(attributeDefinitions)
    .values({
      key: `storage_capacity_${RUN}`.toLowerCase(),
      version: ATTR_VERSION,
      label: 'Storage capacity',
      valueType: 'enum',
      // Inserted `draft` and promoted BELOW, once the values exist: an ACTIVE
      // definition's value vocabulary is frozen by trigger ("publish a new
      // version instead"), so a fixture that wrote `active` here could add no
      // enum values at all and every case would pass against an empty set.
      lifecycleState: 'draft',
    })
    .returning();
  createdAttributeIds.push(capacity.id);
  capacityAttributeId = capacity.id;

  const [colour] = await db
    .insert(attributeDefinitions)
    .values({
      key: `colour_${RUN}`.toLowerCase(),
      version: ATTR_VERSION,
      label: 'Colour',
      valueType: 'enum',
      // Inserted `draft` and promoted BELOW, once the values exist: an ACTIVE
      // definition's value vocabulary is frozen by trigger ("publish a new
      // version instead"), so a fixture that wrote `active` here could add no
      // enum values at all and every case would pass against an empty set.
      lifecycleState: 'draft',
    })
    .returning();
  createdAttributeIds.push(colour.id);
  colourAttributeId = colour.id;

  // Positions ascend with the list, so "the registry's own order" is a real
  // order and not the insertion accident — the subset case below permits them
  // OUT of that order on purpose.
  const capacityRows = await db
    .insert(attributeEnumValues)
    .values(
      CAPACITY_VALUES.map((value, position) => ({
        attributeDefinitionId: capacity.id,
        value,
        label: value.toUpperCase(),
        position,
      })),
    )
    .returning();
  for (const row of capacityRows) capacityValueIds.set(row.value, row.id);

  const colourRows = await db
    .insert(attributeEnumValues)
    .values(
      COLOUR_VALUES.map((value, position) => ({
        attributeDefinitionId: colour.id,
        value,
        label: value,
        position,
      })),
    )
    .returning();
  colourValueId = colourRows[0].id;

  // NOW the values exist, so the definitions may be promoted.
  // `attribute_definitions_published_audit_check` is
  // `(lifecycle = 'draft') = (published_at is null)`, so `active` must carry the
  // instant — and an ACTIVE definition's value vocabulary is frozen by trigger,
  // which is why the values went in first.
  await db
    .update(attributeDefinitions)
    .set({ lifecycleState: 'active', publishedAt: new Date() })
    .where(inArray(attributeDefinitions.id, [capacityAttributeId, colourAttributeId]));

  /** One version of the type, at a given lifecycle, with both fields. */
  async function makeVersion(version: number): Promise<{ id: string; capacityFieldId: string; colourFieldId: string }> {
    const [row] = await db
      .insert(productTypeDefinitions)
      .values({ key: TYPE_KEY, version, name: `Subset vertical ${RUN} v${version}`, lifecycle: 'draft' })
      .returning();
    createdDefinitionIds.push(row.id);
    await db
      .insert(productTypeCategoryScopes)
      .values({ productTypeDefinitionId: row.id, categoryId, includeDescendants: false });
    const [capacityField] = await db
      .insert(productTypeFields)
      .values({
        productTypeDefinitionId: row.id,
        attributeDefinitionId: capacityAttributeId,
        attributeKey: `storage_capacity_${RUN}`.toLowerCase(),
        attributeDefinitionVersion: ATTR_VERSION,
        scope: 'product',
        flow: 'merchant',
        requirement: 'optional',
        valuePolicy: 'controlled_value',
        position: 0,
      })
      .returning();
    const [colourField] = await db
      .insert(productTypeFields)
      .values({
        productTypeDefinitionId: row.id,
        attributeDefinitionId: colourAttributeId,
        attributeKey: `colour_${RUN}`.toLowerCase(),
        attributeDefinitionVersion: ATTR_VERSION,
        scope: 'product',
        flow: 'merchant',
        requirement: 'optional',
        valuePolicy: 'controlled_value',
        position: 1,
      })
      .returning();
    return { id: row.id, capacityFieldId: capacityField.id, colourFieldId: colourField.id };
  }

  const published = await makeVersion(1);
  narrowedFieldId = published.capacityFieldId;
  untouchedFieldId = published.colourFieldId;

  // The subset goes in BEFORE publication, which is the contract this domain
  // enforces rather than a fixture convenience: after publication
  // `product_type_field_allowed_values_frozen` refuses the insert, and a case
  // below drives exactly that.
  await db.insert(productTypeFieldAllowedValues).values(
    PERMITTED.map((value) => ({
      productTypeFieldId: narrowedFieldId,
      attributeDefinitionId: capacityAttributeId,
      attributeEnumValueId: capacityValueIds.get(value) as string,
    })),
  );

  await db
    .update(productTypeDefinitions)
    .set({ lifecycle: 'published', publishedAt: new Date(), publishedByOxyUserId: `oxy_${RUN}` })
    .where(inArray(productTypeDefinitions.id, [published.id]));

  // A second version of the same key, left in `draft`. See `draftFieldId`.
  const draft = await makeVersion(2);
  draftFieldId = draft.capacityFieldId;
});

afterAll(async () => {
  if (!db) return;
  if (createdDefinitionIds.length > 0) {
    // UNPUBLISH FIRST. `product_type_fields_frozen` refuses to delete a
    // published version's fields and `product_type_field_allowed_values_frozen`
    // refuses its subsets — both doing exactly their job, which is why the
    // teardown moves the lifecycle rather than going around the triggers.
    await db
      .update(productTypeDefinitions)
      .set({ lifecycle: 'draft', publishedAt: null, publishedByOxyUserId: null })
      .where(inArray(productTypeDefinitions.id, createdDefinitionIds));
    // Subsets before fields: the key onto the field cascades, but deleting them
    // explicitly keeps this teardown readable rather than resting on a cascade.
    await db
      .delete(productTypeFieldAllowedValues)
      .where(
        inArray(productTypeFieldAllowedValues.productTypeFieldId, [
          narrowedFieldId,
          untouchedFieldId,
          draftFieldId,
        ]),
      );
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
    // Back to `draft` first: an ACTIVE definition cannot be deleted while
    // stored values cite the version, which is #94's freeze doing its job.
    await db
      .update(attributeDefinitions)
      .set({ lifecycleState: 'draft', publishedAt: null })
      .where(inArray(attributeDefinitions.id, createdAttributeIds));
    await db
      .delete(attributeDefinitions)
      .where(inArray(attributeDefinitions.id, createdAttributeIds));
  }
  if (createdCategoryIds.length > 0) {
    await db.delete(categories).where(inArray(categories.id, createdCategoryIds));
  }
  await closePostgres();
});

describe('#367 line 235 — a subset narrows WHICH values, and nothing else', () => {
  it('a field with NO subset offers every value — today\'s behaviour, unchanged', async () => {
    clearAuthoringSchemaMemo();
    const schema = await compose();
    expect(schema.outcome, 'the fixture does not compose').toBe('composed');

    const colour = fieldFor(schema, `colour_${RUN}`.toLowerCase());
    expect(colour, 'the un-narrowed field is missing from the composition').toBeDefined();
    // ALL THREE. This is the state of every field that exists today, and the
    // migration adding the subset table must not change it — the other live
    // convention ("empty means nowhere") would make this the empty list on the
    // deploy that created the table.
    expect(colour?.controlledValues.map((value) => value.value)).toEqual([...COLOUR_VALUES]);
  });

  it('serves only the permitted values, in the REGISTRY order', async () => {
    clearAuthoringSchemaMemo();
    const schema = await compose();
    const field = fieldFor(schema, `storage_capacity_${RUN}`.toLowerCase());
    expect(field, 'the narrowed field is missing from the composition').toBeDefined();
    // `128gb, 256gb, 512gb` — the registry's positions, NOT the insert order
    // (`128gb, 512gb, 256gb`). A subset says which values, never their order;
    // a second ordering would be two answers to what a form renders.
    expect(field?.controlledValues.map((value) => value.value)).toEqual([
      '128gb',
      '256gb',
      '512gb',
    ]);
    // The positions are the registry's own, carried through untouched — so the
    // narrowing did not renumber anything.
    expect(field?.controlledValues.map((value) => value.position)).toEqual([1, 2, 3]);
    // And the two fields answered differently in ONE composition, which is what
    // rules out a filter applied to the whole form rather than per field.
    const colour = fieldFor(schema, `colour_${RUN}`.toLowerCase());
    expect(colour?.controlledValues).toHaveLength(COLOUR_VALUES.length);
  });

  it('serves the registry ROWS, not copies — the "without copying value records" half', async () => {
    clearAuthoringSchemaMemo();
    const schema = await compose();
    const field = fieldFor(schema, `storage_capacity_${RUN}`.toLowerCase());
    // Identity, not equality of spelling: every composed value IS an
    // `attribute_enum_values` row this fixture inserted. A `text[]` of permitted
    // spellings would satisfy the assertion above and fail this one, which is
    // the whole point of storing a join.
    const registryIds = new Set(capacityValueIds.values());
    for (const value of field?.controlledValues ?? []) {
      expect(registryIds.has(value.id), `${value.value} is not a registry row`).toBe(true);
    }
    expect(field?.controlledValues).toHaveLength(PERMITTED.length);

    // …and the stored subset holds IDS. A row whose column held `128gb` would be
    // the removed `allowed_values text[]` wearing a new table name.
    const stored = await db
      .select()
      .from(productTypeFieldAllowedValues)
      .where(inArray(productTypeFieldAllowedValues.productTypeFieldId, [narrowedFieldId]));
    expect(stored).toHaveLength(PERMITTED.length);
    for (const row of stored) {
      expect(registryIds.has(row.attributeEnumValueId)).toBe(true);
    }
    // The table has no column that could hold a spelling — asserted over a real
    // row rather than over the type, so a later `value text` addition is caught
    // here as well as by the schema conventions.
    expect(Object.keys(stored[0] ?? {}).sort()).toEqual([
      'attributeDefinitionId',
      'attributeEnumValueId',
      'createdAt',
      'id',
      'productTypeFieldId',
    ]);
  });
});

describe('#367 line 235 — the invariant is a SHAPE, not a service check', () => {
  it('refuses a subset naming a value from a DIFFERENT attribute', async () => {
    // The composite keys share `attribute_definition_id`, so this row has no
    // shape rather than being rejected by a branch somebody could remove. Two
    // spellings, because each key alone admits one of them: claiming the field's
    // definition with a foreign value, and claiming the value's definition
    // against a field that cites another.
    //
    // Against the DRAFT version: the freeze trigger is BEFORE ROW and Postgres
    // fires those before checking foreign keys, so on the published field it
    // would raise first and these assertions would name a constraint that never
    // ran.
    let caught: unknown;
    try {
      await db.insert(productTypeFieldAllowedValues).values({
        productTypeFieldId: draftFieldId,
        attributeDefinitionId: capacityAttributeId,
        attributeEnumValueId: colourValueId,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught, 'a colour value was accepted onto a storage-capacity field').toBeDefined();
    expect(
      String((caught as { cause?: { constraint_name?: string } })?.cause?.constraint_name),
    ).toBe('product_type_field_allowed_values_value_fk');

    let second: unknown;
    try {
      await db.insert(productTypeFieldAllowedValues).values({
        productTypeFieldId: draftFieldId,
        attributeDefinitionId: colourAttributeId,
        attributeEnumValueId: colourValueId,
      });
    } catch (error) {
      second = error;
    }
    expect(second, "a field's subset claimed another attribute's definition").toBeDefined();
    expect(
      String((second as { cause?: { constraint_name?: string } })?.cause?.constraint_name),
    ).toBe('product_type_field_allowed_values_field_fk');
  });

  it('both composite keys REALLY EXIST in pg_constraint', async () => {
    // Asserted against the server and not the drizzle declaration: drizzle-kit
    // has silently dropped a composite foreign key it modelled, leaving a
    // declaration that reads correctly and a database that enforces nothing. The
    // case above would still pass if only ONE of the two were emitted, so this
    // names both and asserts each is composite.
    const rows = await db.execute<{ conname: string; definition: string }>(sql`
      select conname, pg_get_constraintdef(oid) as definition
      from pg_constraint
      where conrelid = 'product_type_field_allowed_values'::regclass and contype = 'f'
      order by conname
    `);
    expect(rows.map((row) => row.conname)).toEqual([
      'product_type_field_allowed_values_field_fk',
      'product_type_field_allowed_values_value_fk',
    ]);
    for (const row of rows) {
      expect(row.definition, `${row.conname} is not composite`).toContain('attribute_definition_id');
      expect(row.definition).toMatch(/FOREIGN KEY \([^)]+,[^)]+\)/u);
    }

    // And the two UNIQUE constraints they target, which had to be `unique()`
    // rather than `uniqueIndex()` because Postgres refuses an index as an FK
    // target. If either were an index the keys above could not exist at all —
    // and the migration ORDER matters as much as the shape: drizzle-kit emitted
    // the foreign keys BEFORE these, which applied cleanly nowhere.
    const uniques = await db.execute<{ conname: string }>(sql`
      select conname from pg_constraint
      where contype = 'u'
        and conname in ('attribute_enum_values_definition_id_key',
                        'product_type_fields_id_attribute_definition_key')
      order by conname
    `);
    expect(uniques.map((row) => row.conname)).toEqual([
      'attribute_enum_values_definition_id_key',
      'product_type_fields_id_attribute_definition_key',
    ]);
  });

  it('refuses the same value twice on one field', async () => {
    // A repeat is not a stronger permission; it is one value counted twice by
    // anything that counts them. On the DRAFT field, for the freeze-ordering
    // reason above.
    await db.insert(productTypeFieldAllowedValues).values({
      productTypeFieldId: draftFieldId,
      attributeDefinitionId: capacityAttributeId,
      attributeEnumValueId: capacityValueIds.get('128gb') as string,
    });
    let caught: unknown;
    try {
      await db.insert(productTypeFieldAllowedValues).values({
        productTypeFieldId: draftFieldId,
        attributeDefinitionId: capacityAttributeId,
        attributeEnumValueId: capacityValueIds.get('128gb') as string,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught, 'a duplicate permission was accepted').toBeDefined();
  });

  it('a PUBLISHED version\'s subset is frozen with the rest of its contract', async () => {
    // `mercaria_product_type_child_frozen`'s own reasoning, one hop further out:
    // "a schema whose field list, groups or category eligibility could change
    // after publication is not a version, it is a mutable document wearing a
    // version number." Which capacities a form offers is part of that contract,
    // and without this trigger the subset is the ONE piece of a published schema
    // that could still move under a merchant.
    let caught: unknown;
    try {
      await db.insert(productTypeFieldAllowedValues).values({
        productTypeFieldId: narrowedFieldId,
        attributeDefinitionId: capacityAttributeId,
        attributeEnumValueId: capacityValueIds.get('1tb') as string,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught, "a published version's permitted values were widened").toBeDefined();
    // Read from the CAUSE, never the top-level message: the driver's own is
    // `Failed query: …`, so matching that would pass on ANY failure of this
    // statement — including a fixture mistake — which is the check that cannot
    // tell success from failure.
    expect(causeMessage(caught), 'refused, but not by the freeze trigger').toContain('frozen');

    // BOTH directions: a DELETE is a narrowing and is refused for the same
    // reason. Without this the trigger could be INSERT-only and half of "frozen"
    // would be untrue while this file stayed green.
    let removal: unknown;
    try {
      await db
        .delete(productTypeFieldAllowedValues)
        .where(inArray(productTypeFieldAllowedValues.productTypeFieldId, [narrowedFieldId]));
    } catch (error) {
      removal = error;
    }
    expect(removal, "a published version's permitted values were narrowed").toBeDefined();

    // And the DRAFT version is not frozen — otherwise the trigger would be
    // refusing everything and every assertion above would pass for the wrong
    // reason.
    await db
      .delete(productTypeFieldAllowedValues)
      .where(inArray(productTypeFieldAllowedValues.productTypeFieldId, [draftFieldId]));
  });
});
