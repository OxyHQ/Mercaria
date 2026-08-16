/**
 * Versioned product types against a REAL Postgres server (#367 step 3,
 * ADR 0007 D5/D6/D8/D14).
 *
 * Everything here is a property the DATABASE holds and a mocked repository
 * cannot: three triggers, a partial unique index, a composite foreign key's
 * MATCH SIMPLE behaviour on a NULL member, and four CHECK constraints. A mocked
 * `insert` accepts any statement, including one the server rejects outright —
 * which is exactly the class of bug this file exists to catch, and the reason
 * `product-type-publication.test.ts` (which mocks the repositories to test the
 * service's CHOICES) is not a substitute for it and vice versa.
 *
 * ## The two walls that look redundant and are not
 *
 * `product_type_fields_variant_axis_check` refuses a compatibility target as a
 * variant axis. #94's `attribute_definitions_reserved_key_check` refuses a
 * price, a stock level or a condition as an attribute AT ALL. The second is why
 * the first is only testable on the compatibility half: `price` cannot be
 * defined, so it can never reach a product-type field to be refused as an axis.
 * A `vehicle_model` CAN be defined — it is a perfectly good attribute — and is
 * refused only when somebody tries to make it an option row. Both directions are
 * asserted below, because "these two constraints overlap" and "these two
 * constraints cover different halves" look identical until you try it.
 *
 * ## Scoping, because this database is SHARED
 *
 * One throwaway database serves the whole suite and vitest runs files in
 * parallel workers, so every identifier this file writes carries a per-run
 * suffix and teardown deletes exactly what it created. The attribute
 * definitions this file needs are created at a run-derived VERSION rather than
 * `1`, because `vehicle_model` is a plausible key for a sibling to create and
 * `(key, version)` is the unique — and they are left `draft`, so #94's own
 * immutability trigger permits deleting them at teardown.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import { isCheckViolation, isUniqueViolation, uuidv7 } from '@oxyhq/db';
import { closePostgres, connectPostgres, type Database } from '../postgres.js';
import { categories } from '../schema/catalog.js';
import { attributeDefinitions } from '../schema/attributeRegistry.js';
import {
  productTypeCategoryScopes,
  productTypeDefinitions,
  productTypeFieldGroups,
  productTypeFields,
} from '../schema/productTypes.js';

let db: Database;

/** Unique to this run, so parallel files cannot collide on a shared database. */
const RUN = uuidv7().slice(-12).replace(/\W/gu, '');

/**
 * A version number this file owns. `vehicle_model` is a key a sibling could
 * plausibly define at version 1; nothing else defines one up here.
 */
const ATTR_VERSION = 900_000 + (Number.parseInt(RUN.slice(-4), 36) % 90_000);

const createdDefinitionIds: string[] = [];
const createdCategoryIds: string[] = [];
const createdAttributeIds: string[] = [];

/** A key this file owns, in the lowercase dotted shape the CHECK requires. */
function typeKey(name: string): string {
  return `pt_${name}_${RUN}`.toLowerCase();
}

/**
 * Assert a raise, and MATCH ITS MESSAGE.
 *
 * The SQLSTATE lives on `cause`, never on `error.code` — a drizzle error wraps
 * the driver's. Matching the message rather than only the fact of a throw is
 * what tells a trigger refusing the right thing from a trigger refusing
 * everything, and a typo in a fixture from the constraint under test.
 */
async function expectRaise(pattern: RegExp, run: () => Promise<unknown>): Promise<void> {
  let thrown: unknown;
  try {
    await run();
  } catch (error: unknown) {
    thrown = error;
  }
  expect(thrown, 'expected the server to refuse, but the write succeeded').toBeDefined();
  const cause = (thrown as { cause?: { message?: string } }).cause;
  expect(String(cause?.message ?? thrown)).toMatch(pattern);
}

/** Assert the refusal came from a CHECK specifically, not from anything else. */
async function expectCheckViolation(run: () => Promise<unknown>): Promise<void> {
  let thrown: unknown;
  try {
    await run();
  } catch (error: unknown) {
    thrown = error;
  }
  expect(thrown, 'expected a CHECK violation, but the write succeeded').toBeDefined();
  expect(
    isCheckViolation((thrown as { cause?: unknown }).cause ?? thrown),
    `expected a CHECK violation, got: ${String((thrown as { cause?: { message?: string } }).cause?.message ?? thrown)}`,
  ).toBe(true);
}

/** A draft product-type version, remembered for teardown. */
async function makeDefinition(
  name: string,
  overrides: Partial<typeof productTypeDefinitions.$inferInsert> = {},
): Promise<string> {
  const [row] = await db
    .insert(productTypeDefinitions)
    .values({
      key: typeKey(name),
      version: 1,
      name: `Product type ${name}`,
      lifecycle: 'draft',
      ...overrides,
    })
    .returning();
  createdDefinitionIds.push(row.id);
  return row.id;
}

/** A draft attribute definition this file owns, remembered for teardown. */
async function makeAttribute(key: string): Promise<{ id: string; key: string; version: number }> {
  const [row] = await db
    .insert(attributeDefinitions)
    .values({
      key,
      version: ATTR_VERSION,
      lifecycleState: 'draft',
      label: `Attribute ${key}`,
      valueType: 'string',
    })
    .returning();
  createdAttributeIds.push(row.id);
  return { id: row.id, key: row.key, version: row.version };
}

/** The field insert, with the citation passed WHOLE the way the repository does. */
function fieldValues(
  definitionId: string,
  attribute: { id: string; key: string; version: number },
  overrides: Partial<typeof productTypeFields.$inferInsert> = {},
): typeof productTypeFields.$inferInsert {
  return {
    productTypeDefinitionId: definitionId,
    attributeDefinitionId: attribute.id,
    attributeKey: attribute.key,
    attributeDefinitionVersion: attribute.version,
    scope: 'product',
    flow: 'merchant',
    requirement: 'optional',
    valuePolicy: 'typed_scalar',
    ...overrides,
  };
}

let category: string;
/**
 * A SECOND category, used only by the freeze assertion.
 *
 * Reusing the first one made that assertion ambiguous: the scope row already
 * existed from the draft phase, so with the trigger removed the insert was
 * refused by `product_type_category_scopes_key` instead — a red for the wrong
 * reason, which is a test that cannot tell you which constraint broke.
 */
let otherCategory: string;
let colorAttribute: { id: string; key: string; version: number };
let vehicleAttribute: { id: string; key: string; version: number };

beforeAll(async () => {
  db = await connectPostgres();

  const [row] = await db
    .insert(categories)
    .values({
      // `categories.key` arrived NOT NULL with #367 step 1 (ADR 0007 D1) and is
      // frozen after insert by taxonomy's own trigger — a fixture written
      // against the pre-#401 shape fails here rather than anywhere subtle.
      key: `pt_cat_${RUN}`.toLowerCase(),
      name: `Product types ${RUN}`,
      slug: `pt-cat-${RUN}`,
    })
    .returning();
  createdCategoryIds.push(row.id);
  category = row.id;

  const [second] = await db
    .insert(categories)
    .values({
      key: `pt_cat2_${RUN}`.toLowerCase(),
      name: `Product types alt ${RUN}`,
      slug: `pt-cat2-${RUN}`,
    })
    .returning();
  createdCategoryIds.push(second.id);
  otherCategory = second.id;

  colorAttribute = await makeAttribute(`pt_color_${RUN}`.toLowerCase());
  // A COMPATIBILITY target. #94 defines it happily — it is a real attribute —
  // and this domain refuses it as an axis. That asymmetry is the point.
  vehicleAttribute = await makeAttribute('vehicle_model');
}, 120_000);

afterAll(async () => {
  if (!db) return;
  // The ORDER here is load-bearing and the first version of it was wrong, which
  // is worth leaving written down: children were deleted first, and
  // `product_type_fields_frozen` refused every one belonging to a version this
  // file had published — the trigger doing exactly its job, in a teardown.
  //
  // So: unpublish FIRST, then delete children, then the versions themselves.
  // Within the children, fields precede groups because the composite FK is
  // `no action` (checked at end of statement) rather than `cascade`.
  if (createdDefinitionIds.length > 0) {
    await db
      .update(productTypeDefinitions)
      .set({ lifecycle: 'draft', publishedAt: null, publishedByOxyUserId: null, deprecatedAt: null })
      .where(inArray(productTypeDefinitions.id, createdDefinitionIds));
    await db
      .delete(productTypeFields)
      .where(inArray(productTypeFields.productTypeDefinitionId, createdDefinitionIds));
    await db
      .delete(productTypeFieldGroups)
      .where(inArray(productTypeFieldGroups.productTypeDefinitionId, createdDefinitionIds));
    await db
      .delete(productTypeCategoryScopes)
      .where(inArray(productTypeCategoryScopes.productTypeDefinitionId, createdDefinitionIds));
    await db
      .delete(productTypeDefinitions)
      .where(inArray(productTypeDefinitions.id, createdDefinitionIds));
  }
  if (createdAttributeIds.length > 0) {
    await db.delete(attributeDefinitions).where(inArray(attributeDefinitions.id, createdAttributeIds));
  }
  if (createdCategoryIds.length > 0) {
    await db.delete(categories).where(inArray(categories.id, createdCategoryIds));
  }
  await closePostgres();
});

describe('a published version is frozen, and its identity is frozen from INSERT', () => {
  it('refuses a re-keyed version even while it is still a DRAFT (D1 rule 2)', async () => {
    const id = await makeDefinition('rekey');
    await expectRaise(/identity .* is frozen/iu, () =>
      db.update(productTypeDefinitions).set({ key: typeKey('rekey-renamed') }).where(eq(productTypeDefinitions.id, id)),
    );
    await expectRaise(/identity .* is frozen/iu, () =>
      db.update(productTypeDefinitions).set({ version: 7 }).where(eq(productTypeDefinitions.id, id)),
    );

    // The positive control for the trigger's PRECISION. A `BEFORE UPDATE`
    // trigger that raised on every update would satisfy both assertions above
    // while making the row uneditable, and neither can tell the two apart.
    const [renamed] = await db
      .update(productTypeDefinitions)
      .set({ name: 'Renamed but not re-keyed' })
      .where(eq(productTypeDefinitions.id, id))
      .returning();
    expect(renamed.name).toBe('Renamed but not re-keyed');
  });

  it('freezes the policy once published and leaves the NAME editable', async () => {
    const id = await makeDefinition('frozen');
    await db
      .update(productTypeDefinitions)
      .set({ lifecycle: 'published', publishedAt: new Date(), publishedByOxyUserId: 'oxy_op' })
      .where(eq(productTypeDefinitions.id, id));

    await expectRaise(/policy is frozen/iu, () =>
      db
        .update(productTypeDefinitions)
        .set({ pendingProposalPolicy: 'allow_local_claim' })
        .where(eq(productTypeDefinitions.id, id)),
    );

    // Deliberately NOT frozen: the stored KEY is what has to stay stable, and a
    // promise that a label can never be corrected is worth nothing to anybody.
    const [relabelled] = await db
      .update(productTypeDefinitions)
      .set({ name: 'Corrected label' })
      .where(eq(productTypeDefinitions.id, id))
      .returning();
    expect(relabelled.name).toBe('Corrected label');
  });

  it('refuses to DELETE a published version and permits deleting a draft', async () => {
    const published = await makeDefinition('undeletable');
    await db
      .update(productTypeDefinitions)
      .set({ lifecycle: 'published', publishedAt: new Date(), publishedByOxyUserId: 'oxy_op' })
      .where(eq(productTypeDefinitions.id, published));
    await expectRaise(/cannot be deleted/iu, () =>
      db.delete(productTypeDefinitions).where(eq(productTypeDefinitions.id, published)),
    );

    const draft = await makeDefinition('deletable');
    await db.delete(productTypeDefinitions).where(eq(productTypeDefinitions.id, draft));
    const rows = await db
      .select()
      .from(productTypeDefinitions)
      .where(eq(productTypeDefinitions.id, draft));
    expect(rows).toHaveLength(0);
  });

  it('permits at most ONE published version per key', async () => {
    const key = typeKey('one-published');
    const first = await makeDefinition('one-published', { key, version: 1 });
    const second = await makeDefinition('one-published-v2', { key, version: 2 });

    await db
      .update(productTypeDefinitions)
      .set({ lifecycle: 'published', publishedAt: new Date(), publishedByOxyUserId: 'oxy_op' })
      .where(eq(productTypeDefinitions.id, first));

    let thrown: unknown;
    try {
      await db
        .update(productTypeDefinitions)
        .set({ lifecycle: 'published', publishedAt: new Date(), publishedByOxyUserId: 'oxy_op' })
        .where(eq(productTypeDefinitions.id, second));
    } catch (error: unknown) {
      thrown = error;
    }
    expect(thrown, 'two published versions of one key were accepted').toBeDefined();
    expect(isUniqueViolation((thrown as { cause?: unknown }).cause ?? thrown)).toBe(true);

    // And the ordering publication actually uses succeeds: deprecate, then flip.
    await db
      .update(productTypeDefinitions)
      .set({ lifecycle: 'deprecated', deprecatedAt: new Date() })
      .where(eq(productTypeDefinitions.id, first));
    const [promoted] = await db
      .update(productTypeDefinitions)
      .set({ lifecycle: 'published', publishedAt: new Date(), publishedByOxyUserId: 'oxy_op' })
      .where(eq(productTypeDefinitions.id, second))
      .returning();
    expect(promoted.lifecycle).toBe('published');
  });
});

describe('the children of a published version are frozen with it', () => {
  it('refuses a field, a group and a scope once the version is published', async () => {
    const id = await makeDefinition('children');
    // While it is a draft, all three are accepted — the positive control.
    await db.insert(productTypeCategoryScopes).values({ productTypeDefinitionId: id, categoryId: category });
    const [group] = await db
      .insert(productTypeFieldGroups)
      .values({ productTypeDefinitionId: id, key: 'specs', label: 'Specs' })
      .returning();
    await db.insert(productTypeFields).values(fieldValues(id, colorAttribute, { groupId: group.id }));

    await db
      .update(productTypeDefinitions)
      .set({ lifecycle: 'published', publishedAt: new Date(), publishedByOxyUserId: 'oxy_op' })
      .where(eq(productTypeDefinitions.id, id));

    await expectRaise(/authoring contract is frozen/iu, () =>
      db.insert(productTypeFields).values(fieldValues(id, vehicleAttribute, { scope: 'compatibility' })),
    );
    await expectRaise(/authoring contract is frozen/iu, () =>
      db.insert(productTypeFieldGroups).values({ productTypeDefinitionId: id, key: 'more', label: 'More' }),
    );
    // The category scope too. This assertion was ABSENT in the first version of
    // this file, and mutation-testing found it: removing
    // `product_type_category_scopes_frozen` from the migration left the whole
    // suite green, so that trigger was shipped with no coverage at all. It is
    // the one that matters most for the freeze, because widening a published
    // version's eligibility is precisely the edit the immutability guarantee
    // exists to refuse (ADR 0007 D2, as amended).
    await expectRaise(/authoring contract is frozen/iu, () =>
      db
        .insert(productTypeCategoryScopes)
        .values({ productTypeDefinitionId: id, categoryId: otherCategory }),
    );
    await expectRaise(/authoring contract is frozen/iu, () =>
      db
        .update(productTypeFields)
        .set({ requirement: 'required' })
        .where(eq(productTypeFields.productTypeDefinitionId, id)),
    );
    await expectRaise(/authoring contract is frozen/iu, () =>
      db.delete(productTypeFields).where(eq(productTypeFields.productTypeDefinitionId, id)),
    );
  });
});

describe('a field cannot cite one attribute and name another', () => {
  it('refuses a citation whose key or version disagrees with the referenced row', async () => {
    const id = await makeDefinition('citation');

    await expectRaise(/citation must match/iu, () =>
      db.insert(productTypeFields).values(
        fieldValues(id, colorAttribute, { attributeKey: vehicleAttribute.key }),
      ),
    );
    await expectRaise(/citation must match/iu, () =>
      db.insert(productTypeFields).values(
        fieldValues(id, colorAttribute, { attributeDefinitionVersion: colorAttribute.version + 1 }),
      ),
    );

    // The positive control: the honest citation is accepted.
    const [row] = await db.insert(productTypeFields).values(fieldValues(id, colorAttribute)).returning();
    expect(row.attributeKey).toBe(colorAttribute.key);
    expect(row.attributeDefinitionVersion).toBe(colorAttribute.version);
  });

  it('refuses two flows that disagree about what the attribute IS', async () => {
    const id = await makeDefinition('flows');
    await db
      .insert(productTypeFields)
      .values(fieldValues(id, colorAttribute, { flow: 'merchant', scope: 'variant', variantCapable: true }));

    // WHO is asked and in what order may vary per flow. Whether colour defines
    // variants may not — that is a fact about the attribute.
    await expectRaise(/disagrees with flow/iu, () =>
      db
        .insert(productTypeFields)
        .values(fieldValues(id, colorAttribute, { flow: 'p2p', scope: 'variant', variantCapable: false })),
    );
    await expectRaise(/disagrees with flow/iu, () =>
      db
        .insert(productTypeFields)
        .values(fieldValues(id, colorAttribute, { flow: 'p2p', scope: 'product', variantCapable: true })),
    );

    // Agreeing on the attribute while differing on requirement and order is the
    // whole reason the row is per flow, and it is accepted.
    const [p2p] = await db
      .insert(productTypeFields)
      .values(
        fieldValues(id, colorAttribute, {
          flow: 'p2p',
          scope: 'variant',
          variantCapable: true,
          requirement: 'recommended',
          position: 9,
        }),
      )
      .returning();
    expect(p2p.requirement).toBe('recommended');
    expect(p2p.position).toBe(9);
  });
});

describe('a field sits in a group of its OWN version, or in none', () => {
  it('accepts a NULL group (MATCH SIMPLE) and refuses another version’s group', async () => {
    const mine = await makeDefinition('group-mine');
    const other = await makeDefinition('group-other');
    const [foreign] = await db
      .insert(productTypeFieldGroups)
      .values({ productTypeDefinitionId: other, key: 'specs', label: 'Specs' })
      .returning();

    // MATCH SIMPLE — PostgreSQL's default — satisfies the whole composite
    // constraint when `group_id` is NULL. That is what an ungrouped field is,
    // and if the FK were MATCH FULL this insert would fail.
    const [ungrouped] = await db
      .insert(productTypeFields)
      .values(fieldValues(mine, colorAttribute, { groupId: null }))
      .returning();
    expect(ungrouped.groupId).toBeNull();

    let thrown: unknown;
    try {
      await db
        .insert(productTypeFields)
        .values(fieldValues(mine, vehicleAttribute, { groupId: foreign.id, scope: 'compatibility' }));
    } catch (error: unknown) {
      thrown = error;
    }
    expect(thrown, 'a field was allowed into another version’s group').toBeDefined();
    expect(String((thrown as { cause?: { message?: string } }).cause?.message ?? thrown)).toMatch(
      /product_type_fields_group_fk|foreign key/iu,
    );
  });
});

describe('the variant-axis prohibition holds against a direct INSERT (D6/D8)', () => {
  it('refuses a compatibility target as an axis — both conjuncts', async () => {
    const id = await makeDefinition('axis');

    // Conjunct 1: an axis must be a `variant`-scope field.
    await expectCheckViolation(() =>
      db
        .insert(productTypeFields)
        .values(fieldValues(id, vehicleAttribute, { scope: 'compatibility', variantCapable: true })),
    );

    // Conjunct 2: and its key must be outside the forbidden set — so the
    // realistic mistake, mislabelling a fitment fact `variant`, is still caught.
    await expectCheckViolation(() =>
      db
        .insert(productTypeFields)
        .values(fieldValues(id, vehicleAttribute, { scope: 'variant', variantCapable: true })),
    );

    // The positive control, twice: the same compatibility attribute is fine as a
    // NON-axis, and a legitimate attribute is fine as an axis. Without these a
    // CHECK that refused every field would pass both assertions above.
    const [notAnAxis] = await db
      .insert(productTypeFields)
      .values(fieldValues(id, vehicleAttribute, { scope: 'compatibility', variantCapable: false }))
      .returning();
    expect(notAnAxis.variantCapable).toBe(false);

    const [realAxis] = await db
      .insert(productTypeFields)
      .values(fieldValues(id, colorAttribute, { scope: 'variant', variantCapable: true }))
      .returning();
    expect(realAxis.variantCapable).toBe(true);
  });

  it('#94 refuses an OFFER fact as an attribute at all — the complementary wall', async () => {
    // This is why the axis CHECK is only testable on the compatibility half:
    // `price` never reaches a product-type field, because it cannot be defined.
    // The two constraints cover different halves rather than overlapping.
    await expectCheckViolation(() =>
      db.insert(attributeDefinitions).values({
        key: 'price',
        version: ATTR_VERSION,
        lifecycleState: 'draft',
        label: 'Price',
        valueType: 'string',
      }),
    );
  });
});

describe('the visibility rule is bounded at the column, and a forbidden field carries none', () => {
  it('refuses an oversized rule and accepts one within the bound', async () => {
    const id = await makeDefinition('rule');

    const withinBound = {
      node: 'presence' as const,
      field: 'connectivity',
      op: 'is_present' as const,
    };
    const [ok] = await db
      .insert(productTypeFields)
      .values(fieldValues(id, colorAttribute, { visibilityRule: withinBound }))
      .returning();
    expect(ok.visibilityRule).toEqual(withinBound);

    // 32 values of 256 characters is about 8 KB — over the 4 096-byte column
    // bound, and the reason the interpreter's node/value bounds alone are not
    // enough. Cast through `unknown`: this shape is deliberately one the type
    // system would refuse, because the point is what the SERVER does with it.
    const oversized = {
      node: 'membership',
      field: 'connectivity',
      op: 'in',
      values: Array.from({ length: 32 }, () => 'x'.repeat(256)),
    } as unknown as typeof withinBound;
    await expectCheckViolation(() =>
      db
        .insert(productTypeFields)
        .values(fieldValues(id, vehicleAttribute, { scope: 'compatibility', visibilityRule: oversized })),
    );
  });

  it('refuses a rule or an axis on a field this flow may not supply', async () => {
    const id = await makeDefinition('forbidden');
    await expectCheckViolation(() =>
      db.insert(productTypeFields).values(
        fieldValues(id, colorAttribute, {
          requirement: 'forbidden',
          visibilityRule: { node: 'presence', field: 'connectivity', op: 'is_present' },
        }),
      ),
    );
    await expectCheckViolation(() =>
      db.insert(productTypeFields).values(
        fieldValues(id, colorAttribute, {
          requirement: 'forbidden',
          scope: 'variant',
          variantCapable: true,
        }),
      ),
    );

    // The positive control: `forbidden` with neither is a normal row.
    const [plain] = await db
      .insert(productTypeFields)
      .values(fieldValues(id, colorAttribute, { requirement: 'forbidden' }))
      .returning();
    expect(plain.requirement).toBe('forbidden');
  });
});

describe('the category scope is a real relation', () => {
  it('accepts a scope and refuses a duplicate for the same version', async () => {
    const id = await makeDefinition('scope');
    await db
      .insert(productTypeCategoryScopes)
      .values({ productTypeDefinitionId: id, categoryId: category });

    let thrown: unknown;
    try {
      await db
        .insert(productTypeCategoryScopes)
        .values({ productTypeDefinitionId: id, categoryId: category });
    } catch (error: unknown) {
      thrown = error;
    }
    expect(thrown, 'a duplicate category scope was accepted').toBeDefined();
    expect(isUniqueViolation((thrown as { cause?: unknown }).cause ?? thrown)).toBe(true);

    const rows = await db
      .select()
      .from(productTypeCategoryScopes)
      .where(
        and(
          eq(productTypeCategoryScopes.productTypeDefinitionId, id),
          eq(productTypeCategoryScopes.categoryId, category),
        ),
      );
    expect(rows).toHaveLength(1);
    expect(rows[0].includeDescendants).toBe(true);
  });
});
