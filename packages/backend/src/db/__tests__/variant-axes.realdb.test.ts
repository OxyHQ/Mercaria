/**
 * Typed variant axes and retained claims against a REAL Postgres server
 * (#367 step 4, ADR 0007 D6/D7).
 *
 * Everything here is a property the DATABASE holds and a mocked repository
 * cannot: eight triggers (one of them DEFERRED to COMMIT), three unique indexes,
 * a generated column pair and eighteen CHECK constraints. A mocked `insert`
 * accepts any statement, including one the server rejects outright — which is
 * exactly the class of bug this file exists to catch, and the reason the static
 * suite (`services/variant-axes/__tests__/variant-axis-schema.test.ts`, which
 * asserts each constraint EXISTS) is not a substitute for it and vice versa.
 *
 * ## The four properties under test, and why each needs a server
 *
 * 1. **Order independence.** `native_variant_signatures_listing_signature_key`
 *    refuses a second variant whose axes fold to one digest. The digest is
 *    computed in TypeScript and the collision is refused in Postgres, so only a
 *    real server can show the two agreeing.
 * 2. **The signature covers the assignments that exist.**
 *    `mercaria_native_variant_signature_agrees` is DEFERRABLE INITIALLY DEFERRED,
 *    so it fires at COMMIT. A test that never commits cannot see it at all.
 * 3. **A claim is frozen and undeletable while its subject lives, and its
 *    subject's deletion still cascades.** Two halves of one trigger that pull in
 *    opposite directions; the #90 revision-trail device.
 * 4. **An unsettled claim cannot carry a value.** Eleven biconditional CHECKs,
 *    and a CHECK's SQL is only correct if a server says so — this schema has
 *    twice shipped a "present exactly when" rule that admitted the row it
 *    existed to refuse (`retail_delivery_promises`, `watchlist_snapshot_items`),
 *    both found here rather than in review.
 *
 * ## Scoping, because this database is SHARED
 *
 * One throwaway database serves the whole suite and vitest runs files in
 * parallel workers, so every identifier this file writes carries a per-run
 * suffix and teardown deletes exactly what it created. The attribute definitions
 * are created at a run-derived VERSION rather than `1`, because `color` is a
 * plausible key for a sibling to create and `(key, version)` is the unique — and
 * they are left `draft`, so #94's own immutability trigger permits deleting them
 * at teardown.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import { isCheckViolation, isUniqueViolation, uuidv7 } from '@oxyhq/db';
import { closePostgres, connectPostgres, type Database } from '../postgres.js';
import { listings, productVariants } from '../schema/catalog.js';
import { attributeDefinitions, attributeEnumValues } from '../schema/attributeRegistry.js';
import {
  nativeListingAttributeClaims,
  nativeListingVariantAxes,
  nativeVariantAttributeClaims,
  nativeVariantAxisAssignments,
  nativeVariantSignatures,
} from '../schema/variantAxes.js';
import {
  defaultTypedVariantSignature,
  typedVariantSignature,
} from '../../services/variant-axes/signature.js';

let db: Database;

/** Unique to this run, so parallel files cannot collide on a shared database. */
const RUN = uuidv7().slice(-12).replace(/\W/gu, '');

/**
 * A version this file owns.
 *
 * `color` and `vehicle_model` are keys a sibling could plausibly define, and
 * `(key, version)` is the unique — so the version has to be per-run. The 800_000
 * band is DISJOINT from `product-type.realdb.test.ts`'s 900_000 one, which also
 * defines `vehicle_model`: two runs deriving the same offset inside one band is
 * a one-in-ninety-thousand flake, and separating the bands removes it entirely
 * rather than leaving it to be diagnosed later as a mystery.
 */
const ATTR_VERSION = 800_000 + (Number.parseInt(RUN.slice(-4), 36) % 90_000);

const createdListingIds: string[] = [];
const createdAttributeIds: string[] = [];

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

async function expectUniqueViolation(run: () => Promise<unknown>): Promise<void> {
  let thrown: unknown;
  try {
    await run();
  } catch (error: unknown) {
    thrown = error;
  }
  expect(thrown, 'expected a unique violation, but the write succeeded').toBeDefined();
  expect(
    isUniqueViolation((thrown as { cause?: unknown }).cause ?? thrown),
    `expected a unique violation, got: ${String((thrown as { cause?: { message?: string } }).cause?.message ?? thrown)}`,
  ).toBe(true);
}

/** A P2P listing this file owns. Its variants cascade with it. */
async function makeListing(label: string): Promise<string> {
  const [row] = await db
    .insert(listings)
    .values({
      ownerType: 'user',
      oxyUserId: `axes-seller-${RUN}`,
      storeId: null,
      title: `Variant axes ${label} ${RUN}`,
      description: 'A fixture listing.',
      condition: 'new',
      conditionAssertion: 'seller_declared',
      status: 'active',
      categorySlugs: [],
      tags: [],
    })
    .returning({ id: listings.id });
  createdListingIds.push(row.id);
  return row.id;
}

async function makeVariant(listingId: string, title: string): Promise<string> {
  const [row] = await db
    .insert(productVariants)
    .values({ listingId, title })
    .returning({ id: productVariants.id });
  return row.id;
}

interface Attribute {
  id: string;
  key: string;
  version: number;
}

/** A draft attribute definition this file owns, remembered for teardown. */
async function makeAttribute(
  key: string,
  overrides: Partial<typeof attributeDefinitions.$inferInsert> = {},
): Promise<Attribute> {
  const [row] = await db
    .insert(attributeDefinitions)
    .values({
      key,
      version: ATTR_VERSION,
      lifecycleState: 'draft',
      label: `Attribute ${key}`,
      valueType: 'string',
      variantDefining: true,
      ...overrides,
    })
    .returning();
  createdAttributeIds.push(row.id);
  return { id: row.id, key: row.key, version: row.version };
}

function axisValues(
  listingId: string,
  attribute: Attribute,
  overrides: Partial<typeof nativeListingVariantAxes.$inferInsert> = {},
): typeof nativeListingVariantAxes.$inferInsert {
  return {
    listingId,
    attributeDefinitionId: attribute.id,
    attributeKey: attribute.key,
    attributeDefinitionVersion: attribute.version,
    ...overrides,
  };
}

function claimValues(
  variantId: string,
  overrides: Partial<typeof nativeVariantAttributeClaims.$inferInsert> = {},
): typeof nativeVariantAttributeClaims.$inferInsert {
  return {
    variantId,
    rawName: 'Tono',
    rawValue: 'Negro',
    provenance: 'legacy_option_migration',
    assertedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

let colorAttribute: Attribute;
let sizeAttribute: Attribute;

beforeAll(async () => {
  db = await connectPostgres();
  colorAttribute = await makeAttribute(`axes_color_${RUN}`.toLowerCase());
  sizeAttribute = await makeAttribute(`axes_size_${RUN}`.toLowerCase());
});

afterAll(async () => {
  // Children first, then the parents that cascade. The axes, assignments,
  // signatures and claims all cascade from `listings` and `product_variants`, so
  // deleting the listings is enough for them — but the claim tables carry a
  // BEFORE DELETE trigger that refuses while the subject exists, which is
  // exactly the cascade path being relied on here.
  if (createdListingIds.length > 0) {
    await db.delete(listings).where(inArray(listings.id, createdListingIds));
  }
  if (createdAttributeIds.length > 0) {
    await db.delete(attributeDefinitions).where(inArray(attributeDefinitions.id, createdAttributeIds));
  }
  await closePostgres();
});

describe('an axis CITES the registry, and the citation has to be true', () => {
  it('accepts a citation that agrees with the definition', async () => {
    const listingId = await makeListing('citation-ok');
    const [row] = await db
      .insert(nativeListingVariantAxes)
      .values(axisValues(listingId, colorAttribute))
      .returning();
    expect(row.attributeKey).toBe(colorAttribute.key);
  });

  it('refuses a citation whose key disagrees with the definition', async () => {
    const listingId = await makeListing('citation-key');
    await expectRaise(/citation .* disagrees with definition/i, () =>
      db
        .insert(nativeListingVariantAxes)
        .values(axisValues(listingId, { ...colorAttribute, key: sizeAttribute.key })),
    );
  });

  it('refuses a citation whose VERSION disagrees', async () => {
    const listingId = await makeListing('citation-version');
    await expectRaise(/citation .* disagrees with definition/i, () =>
      db
        .insert(nativeListingVariantAxes)
        .values(axisValues(listingId, { ...colorAttribute, version: colorAttribute.version + 1 })),
    );
  });

  it('refuses an attribute the registry says does not define variants', async () => {
    const listingId = await makeListing('not-variant-defining');
    const plain = await makeAttribute(`axes_plain_${RUN}`.toLowerCase(), { variantDefining: false });
    await expectRaise(/not `variant_defining`/i, () =>
      db.insert(nativeListingVariantAxes).values(axisValues(listingId, plain)),
    );
  });

  it('refuses a forbidden axis key by CHECK, before the trigger looks', async () => {
    // A compatibility target. ADR 0007 D8's acceptance scenario: one brake-pad
    // SKU fits four hundred vehicles and stays ONE variant. #94 permits defining
    // `vehicle_model` — it is a perfectly good attribute — and this refuses
    // turning it into an option row.
    const listingId = await makeListing('forbidden-axis');
    const vehicle = await makeAttribute('vehicle_model');
    await expectCheckViolation(() =>
      db.insert(nativeListingVariantAxes).values(axisValues(listingId, vehicle)),
    );
  });

  it('refuses two axes on one listing sharing a key', async () => {
    const listingId = await makeListing('axis-dupe');
    await db.insert(nativeListingVariantAxes).values(axisValues(listingId, colorAttribute));
    await expectUniqueViolation(() =>
      db.insert(nativeListingVariantAxes).values(axisValues(listingId, colorAttribute)),
    );
  });

  it('freezes a declaration except for its display position', async () => {
    const listingId = await makeListing('axis-frozen');
    const [row] = await db
      .insert(nativeListingVariantAxes)
      .values(axisValues(listingId, colorAttribute, { legacyOptionName: 'Color' }))
      .returning();

    // The position moves — it is display order and is not an input to the
    // signature, so nothing anybody recorded changes.
    await db
      .update(nativeListingVariantAxes)
      .set({ position: 3 })
      .where(eq(nativeListingVariantAxes.id, row.id));

    await expectRaise(/a declared axis is immutable/i, () =>
      db
        .update(nativeListingVariantAxes)
        .set({ legacyOptionName: 'Colour' })
        .where(eq(nativeListingVariantAxes.id, row.id)),
    );
  });
});

describe('an assignment belongs to its own listing', () => {
  it('refuses a variant assigned another listing’s axis', async () => {
    const listingA = await makeListing('scope-a');
    const listingB = await makeListing('scope-b');
    const [axis] = await db
      .insert(nativeListingVariantAxes)
      .values(axisValues(listingA, colorAttribute))
      .returning();
    const variantB = await makeVariant(listingB, 'B');

    await expectRaise(/belongs to listing .* and variant .* to listing/i, () =>
      db.insert(nativeVariantAxisAssignments).values({
        variantId: variantB,
        axisId: axis.id,
        attributeDefinitionId: colorAttribute.id,
        attributeKey: colorAttribute.key,
        displayValue: 'Black',
        normalizedValue: 'black',
      }),
    );
  });

  it('refuses an assignment citing a claim about a DIFFERENT variant', async () => {
    const listingId = await makeListing('claim-scope');
    const [axis] = await db
      .insert(nativeListingVariantAxes)
      .values(axisValues(listingId, colorAttribute))
      .returning();
    const variantOne = await makeVariant(listingId, 'one');
    const variantTwo = await makeVariant(listingId, 'two');
    const [claim] = await db
      .insert(nativeVariantAttributeClaims)
      .values(claimValues(variantTwo))
      .returning();

    await expectRaise(/is not a claim about variant/i, () =>
      db.insert(nativeVariantAxisAssignments).values({
        variantId: variantOne,
        axisId: axis.id,
        attributeDefinitionId: colorAttribute.id,
        attributeKey: colorAttribute.key,
        displayValue: 'Black',
        normalizedValue: 'black',
        sourceClaimId: claim.id,
      }),
    );
  });
});

describe('the signature is the variant’s identity', () => {
  /** Write one variant's axes and identity, the way the service does. */
  async function writeVariant(
    listingId: string,
    variantId: string,
    assignments: readonly { axisId: string; attribute: Attribute; value: string }[],
  ): Promise<string> {
    const signature = typedVariantSignature(
      assignments.map((assignment) => ({
        attributeDefinitionId: assignment.attribute.id,
        normalizedValue: assignment.value,
      })),
    );
    await db.transaction(async (tx) => {
      if (assignments.length > 0) {
        await tx.insert(nativeVariantAxisAssignments).values(
          assignments.map((assignment) => ({
            variantId,
            axisId: assignment.axisId,
            attributeDefinitionId: assignment.attribute.id,
            attributeKey: assignment.attribute.key,
            displayValue: assignment.value,
            normalizedValue: assignment.value,
          })),
        );
      }
      await tx
        .insert(nativeVariantSignatures)
        .values({ variantId, listingId, signature, axisCount: assignments.length });
    });
    return signature;
  }

  it('two variants whose axes were entered in different orders COLLIDE', async () => {
    const listingId = await makeListing('collision');
    const [colorAxis] = await db
      .insert(nativeListingVariantAxes)
      .values(axisValues(listingId, colorAttribute))
      .returning();
    const [sizeAxis] = await db
      .insert(nativeListingVariantAxes)
      .values(axisValues(listingId, sizeAttribute, { position: 1 }))
      .returning();

    const first = await makeVariant(listingId, 'first');
    const second = await makeVariant(listingId, 'second');

    await writeVariant(listingId, first, [
      { axisId: colorAxis.id, attribute: colorAttribute, value: 'black' },
      { axisId: sizeAxis.id, attribute: sizeAttribute, value: 'm' },
    ]);

    // The SAME two values, entered the other way round. The digest is equal by
    // construction and the unique index is what turns that into a refusal.
    await expectUniqueViolation(() =>
      writeVariant(listingId, second, [
        { axisId: sizeAxis.id, attribute: sizeAttribute, value: 'm' },
        { axisId: colorAxis.id, attribute: colorAttribute, value: 'black' },
      ]),
    );
  });

  it('a variant with ZERO axes has a real identity, and a second one collides', async () => {
    const listingId = await makeListing('zero-axes');
    const first = await makeVariant(listingId, 'default');
    const second = await makeVariant(listingId, 'also default');

    const signature = await writeVariant(listingId, first, []);
    expect(signature).toBe(defaultTypedVariantSignature());

    await expectUniqueViolation(() => writeVariant(listingId, second, []));
  });

  it('refuses a signature whose listing is not the variant’s own', async () => {
    const listingA = await makeListing('sig-scope-a');
    const listingB = await makeListing('sig-scope-b');
    const variant = await makeVariant(listingA, 'v');
    await expectRaise(/belongs to listing .*, not to/i, () =>
      db.insert(nativeVariantSignatures).values({
        variantId: variant,
        listingId: listingB,
        signature: defaultTypedVariantSignature(),
        axisCount: 0,
      }),
    );
  });

  it('refuses a made-up signature by CHECK', async () => {
    const listingId = await makeListing('sig-shape');
    const variant = await makeVariant(listingId, 'v');
    await expectCheckViolation(() =>
      db.insert(nativeVariantSignatures).values({
        variantId: variant,
        listingId,
        signature: 'not-a-digest',
        axisCount: 0,
      }),
    );
  });

  it('refuses at COMMIT a signature that does not cover the assignments', async () => {
    // The DEFERRED constraint. It cannot fire mid-transaction — that is the
    // whole reason it is deferred — so this is only visible on the commit.
    const listingId = await makeListing('agrees');
    const [colorAxis] = await db
      .insert(nativeListingVariantAxes)
      .values(axisValues(listingId, colorAttribute))
      .returning();
    const variant = await makeVariant(listingId, 'v');

    await expectRaise(/its signature declares .* assignment row/i, async () =>
      db.transaction(async (tx) => {
        await tx.insert(nativeVariantAxisAssignments).values({
          variantId: variant,
          axisId: colorAxis.id,
          attributeDefinitionId: colorAttribute.id,
          attributeKey: colorAttribute.key,
          displayValue: 'Black',
          normalizedValue: 'black',
        });
        // One assignment, a signature claiming none.
        await tx.insert(nativeVariantSignatures).values({
          variantId: variant,
          listingId,
          signature: defaultTypedVariantSignature(),
          axisCount: 0,
        });
      }),
    );
  });

  it('refuses at COMMIT an assignment with no signature at all', async () => {
    const listingId = await makeListing('agrees-missing');
    const [colorAxis] = await db
      .insert(nativeListingVariantAxes)
      .values(axisValues(listingId, colorAttribute))
      .returning();
    const variant = await makeVariant(listingId, 'v');

    await expectRaise(/no signature row/i, async () =>
      db.transaction(async (tx) => {
        await tx.insert(nativeVariantAxisAssignments).values({
          variantId: variant,
          axisId: colorAxis.id,
          attributeDefinitionId: colorAttribute.id,
          attributeKey: colorAttribute.key,
          displayValue: 'Black',
          normalizedValue: 'black',
        });
      }),
    );
  });

  it('lets a variant be DELETED even though both tables carry the constraint', async () => {
    // The existence guard in the deferred trigger. A cascade removes the
    // assignments AND the signature, and at commit there is nothing to
    // reconcile — without the guard, deleting a variant would be impossible.
    const listingId = await makeListing('agrees-cascade');
    const [colorAxis] = await db
      .insert(nativeListingVariantAxes)
      .values(axisValues(listingId, colorAttribute))
      .returning();
    const variant = await makeVariant(listingId, 'v');
    await writeVariant(listingId, variant, [
      { axisId: colorAxis.id, attribute: colorAttribute, value: 'black' },
    ]);

    await db.delete(productVariants).where(eq(productVariants.id, variant));
    const left = await db
      .select()
      .from(nativeVariantSignatures)
      .where(eq(nativeVariantSignatures.variantId, variant));
    expect(left).toEqual([]);
  });
});

describe('a claim is what somebody SAID, and it stays that way', () => {
  it('accepts an unsettled claim carrying only its raw text', async () => {
    const listingId = await makeListing('claim-raw');
    const variant = await makeVariant(listingId, 'v');
    const [row] = await db.insert(nativeVariantAttributeClaims).values(claimValues(variant)).returning();
    expect(row.attributeResolution).toBe('unresolved');
    expect(row.normalizedValue).toBeNull();
    // The generated lookup keys, folded by the DATABASE rather than by a writer.
    expect(row.rawNameNormalized).toBe('tono');
    expect(row.rawValueKey).toBe('negro');
  });

  it('converges on the SAME assertion arriving twice', async () => {
    const listingId = await makeListing('claim-converge');
    const variant = await makeVariant(listingId, 'v');
    await db.insert(nativeVariantAttributeClaims).values(claimValues(variant));
    const again = await db
      .insert(nativeVariantAttributeClaims)
      .values(claimValues(variant, { rawName: '  TONO ', rawValue: 'negro' }))
      .onConflictDoNothing({
        target: [
          nativeVariantAttributeClaims.variantId,
          nativeVariantAttributeClaims.provenance,
          nativeVariantAttributeClaims.rawNameNormalized,
          nativeVariantAttributeClaims.rawValueKey,
        ],
      })
      .returning();
    // The empty RETURNING set IS the "already there" answer.
    expect(again).toEqual([]);
  });

  it('keeps a party’s CHANGED assertion as a second row', async () => {
    // ADR 0007 D7: both are retained, which is what makes a correction
    // auditable. Only the same sentence converges.
    const listingId = await makeListing('claim-changed');
    const variant = await makeVariant(listingId, 'v');
    await db.insert(nativeVariantAttributeClaims).values(claimValues(variant, { rawValue: 'Black' }));
    await db
      .insert(nativeVariantAttributeClaims)
      .values(claimValues(variant, { rawValue: 'Jet Black' }));
    const rows = await db
      .select()
      .from(nativeVariantAttributeClaims)
      .where(eq(nativeVariantAttributeClaims.variantId, variant));
    expect(rows).toHaveLength(2);
  });

  it('refuses a BLOCKED claim carrying a normalized value', async () => {
    // THE column that makes an ambiguous legacy option stay text. A one-way
    // `resolved ⇒ value present` would admit exactly this row.
    const listingId = await makeListing('claim-blocked-value');
    const variant = await makeVariant(listingId, 'v');
    await expectCheckViolation(() =>
      db.insert(nativeVariantAttributeClaims).values(
        claimValues(variant, {
          valueResolution: 'blocked',
          valueRefusal: 'unmapped',
          normalizedValue: 'black',
        }),
      ),
    );
  });

  it('refuses a resolved VALUE while its attribute is unresolved', async () => {
    const listingId = await makeListing('claim-value-orphan');
    const variant = await makeVariant(listingId, 'v');
    await expectCheckViolation(() =>
      db
        .insert(nativeVariantAttributeClaims)
        .values(claimValues(variant, { valueResolution: 'resolved', normalizedValue: 'black' })),
    );
  });

  it('refuses a blocked half with no refusal, and a refusal with no block', async () => {
    const listingId = await makeListing('claim-refusal-shape');
    const variant = await makeVariant(listingId, 'v');
    await expectCheckViolation(() =>
      db
        .insert(nativeVariantAttributeClaims)
        .values(claimValues(variant, { attributeResolution: 'blocked' })),
    );
    await expectCheckViolation(() =>
      db
        .insert(nativeVariantAttributeClaims)
        .values(claimValues(variant, { attributeRefusal: 'unmapped' })),
    );
  });

  it('refuses an ANONYMOUS operator refusal', async () => {
    const listingId = await makeListing('claim-anon-refusal');
    const variant = await makeVariant(listingId, 'v');
    await expectCheckViolation(() =>
      db.insert(nativeVariantAttributeClaims).values(
        claimValues(variant, {
          attributeResolution: 'refused',
          attributeRefusal: 'operator_refused',
        }),
      ),
    );
  });

  it('refuses a legacy-migration claim that names a claimant', async () => {
    // The backfill invents no provenance: the legacy rows record neither who
    // asserted the value nor when.
    const listingId = await makeListing('claim-legacy-provenance');
    const variant = await makeVariant(listingId, 'v');
    await expectCheckViolation(() =>
      db
        .insert(nativeVariantAttributeClaims)
        .values(claimValues(variant, { assertedByOxyUserId: `someone-${RUN}` })),
    );
  });

  it('freezes the assertion and lets the resolution move', async () => {
    const listingId = await makeListing('claim-frozen');
    const variant = await makeVariant(listingId, 'v');
    const [row] = await db.insert(nativeVariantAttributeClaims).values(claimValues(variant)).returning();

    await db
      .update(nativeVariantAttributeClaims)
      .set({ attributeResolution: 'blocked', attributeRefusal: 'unmapped' })
      .where(eq(nativeVariantAttributeClaims.id, row.id));

    await expectRaise(/what a party asserted is immutable/i, () =>
      db
        .update(nativeVariantAttributeClaims)
        .set({ rawValue: 'Black' })
        .where(eq(nativeVariantAttributeClaims.id, row.id)),
    );
  });

  it('refuses a DELETE while the subject exists, and permits the cascade', async () => {
    const listingId = await makeListing('claim-no-delete');
    const variant = await makeVariant(listingId, 'v');
    const [row] = await db.insert(nativeVariantAttributeClaims).values(claimValues(variant)).returning();

    await expectRaise(/may not be deleted while its subject exists/i, () =>
      db.delete(nativeVariantAttributeClaims).where(eq(nativeVariantAttributeClaims.id, row.id)),
    );

    // And the cascade still works, which is the half a blanket refusal breaks.
    await db.delete(productVariants).where(eq(productVariants.id, variant));
    const left = await db
      .select()
      .from(nativeVariantAttributeClaims)
      .where(eq(nativeVariantAttributeClaims.id, row.id));
    expect(left).toEqual([]);
  });

  it('an axis DECLARATION carries no value and settles none', async () => {
    const listingId = await makeListing('claim-declaration');
    const [row] = await db
      .insert(nativeListingAttributeClaims)
      .values({
        listingId,
        kind: 'axis_declaration',
        rawName: 'Tono',
        provenance: 'legacy_option_migration',
        assertedAt: new Date('2026-01-01T00:00:00.000Z'),
      })
      .returning();
    expect(row.rawValue).toBeNull();
    expect(row.valueResolution).toBe('unresolved');

    // An `attribute_value` with no value, and an `axis_declaration` with one,
    // are both refused by the same biconditional.
    await expectCheckViolation(() =>
      db.insert(nativeListingAttributeClaims).values({
        listingId,
        kind: 'attribute_value',
        rawName: 'Material',
        provenance: 'merchant_declared',
        assertedByOxyUserId: `merchant-${RUN}`,
        assertedAt: new Date('2026-01-01T00:00:00.000Z'),
      }),
    );
    await expectCheckViolation(() =>
      db.insert(nativeListingAttributeClaims).values({
        listingId,
        kind: 'axis_declaration',
        rawName: 'Talla',
        rawValue: 'M',
        provenance: 'legacy_option_migration',
        assertedAt: new Date('2026-01-01T00:00:00.000Z'),
      }),
    );
  });

  it('a connector claim names its connection and nothing else does', async () => {
    const listingId = await makeListing('claim-connector');
    const variant = await makeVariant(listingId, 'v');
    await expectCheckViolation(() =>
      db
        .insert(nativeVariantAttributeClaims)
        .values(claimValues(variant, { provenance: 'connector_import' })),
    );
  });

  it('a resolved claim can name a controlled value of its own definition', async () => {
    const listingId = await makeListing('claim-resolved');
    const variant = await makeVariant(listingId, 'v');
    const [enumValue] = await db
      .insert(attributeEnumValues)
      .values({ attributeDefinitionId: colorAttribute.id, value: 'black', label: 'Black' })
      .returning();

    const [row] = await db
      .insert(nativeVariantAttributeClaims)
      .values(
        claimValues(variant, {
          rawName: 'Color',
          rawValue: 'Negro',
          attributeResolution: 'resolved',
          attributeDefinitionId: colorAttribute.id,
          attributeDefinitionVersion: colorAttribute.version,
          valueResolution: 'resolved',
          normalizedValue: 'black',
          enumValueId: enumValue.id,
        }),
      )
      .returning();
    expect(row.normalizedValue).toBe('black');

    await db
      .delete(nativeVariantAttributeClaims)
      .where(eq(nativeVariantAttributeClaims.variantId, variant))
      .catch(() => undefined);
  });
});

describe('the queue is the claim rows themselves', () => {
  it('reads back exactly the claims that are still waiting', async () => {
    const listingId = await makeListing('queue');
    const variant = await makeVariant(listingId, 'v');
    await db.insert(nativeVariantAttributeClaims).values([
      claimValues(variant, { rawValue: 'Negro' }),
      claimValues(variant, {
        rawValue: 'Verde',
        attributeResolution: 'blocked',
        attributeRefusal: 'forbidden_as_axis',
      }),
    ]);

    const queued = await db
      .select()
      .from(nativeVariantAttributeClaims)
      .where(
        and(
          eq(nativeVariantAttributeClaims.variantId, variant),
          inArray(nativeVariantAttributeClaims.attributeResolution, ['unresolved', 'blocked']),
        ),
      );
    expect(queued).toHaveLength(2);
    expect(queued.filter((row) => row.attributeRefusal === 'forbidden_as_axis')).toHaveLength(1);
  });
});
