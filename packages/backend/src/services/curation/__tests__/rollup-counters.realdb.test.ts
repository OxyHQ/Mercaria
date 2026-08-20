/**
 * The three STORED rollup counters, against a real server (#749).
 *
 * #737 fixed three PREDICATES: the query said `status <> 'merged'`, so narrowing
 * it corrected every subsequent read at once. These three are different in the
 * way that decides the work — **a predicate is fixed where it is READ, a stored
 * counter is fixed where it is WRITTEN**, and every row already stored keeps the
 * old figure until something re-derives it.
 *
 * ## Why this file exists rather than an assertion beside the fix
 *
 * `rollups.ts` is **not the only writer** of two of the three, which is what the
 * issue's scope missed:
 *
 * | counter | writer A | writer B |
 * |---|---|---|
 * | `canonical_products.variant_count` | `rollups.ts refreshVariantCount` | `canonical-variant.service` → `countVariantsForProduct` |
 * | `canonical_product_families.product_count` | `rollups.ts refreshFamilyCount` | `backfill/stages/projections.ts` → `refreshFamilyProductCount` |
 *
 * Narrowing writer A alone does not half-fix it — it makes the stored value
 * depend on **which writer ran last**. Today the number is consistently too
 * high, which is at least reproducible; a number that changes according to
 * whether a merge or an ordinary variant write touched the row most recently
 * cannot be reported and reads as a caching bug forever.
 *
 * ## The delta case is the one that catches that, and it prejudges nothing
 *
 * `stays consistent across BOTH writers` adds exactly one shopper-visible
 * variant and asserts the stored count moves by exactly one. Both *consistent*
 * states pass it — all-narrow (1 → 2) and all-loose (2 → 3) — and only the
 * split state fails, where writer A stores the narrow 1 and writer B then
 * stores the loose 3 and one added variant appears to have added two. So it
 * pins the property under repair without deciding what `variant_count` should
 * MEAN, which is a separate question this file does not answer.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { eq } from 'drizzle-orm';
import { uuidv7 } from '@oxyhq/db';
import { closePostgres, connectPostgres, type Database } from '../../../db/postgres.js';
import { deleteTestCanonicalRows } from '../../../db/__tests__/canonical-teardown.js';
import { brands } from '../../../db/schema/organizations.js';
import {
  canonicalProductFamilies,
  canonicalProducts,
} from '../../../db/schema/canonicalCatalog.js';
import { createBrand } from '../../canonical/brand.service.js';
import { createProductFamily } from '../../canonical/product-family.service.js';
import { createCanonicalProduct } from '../../canonical/canonical-product.service.js';
import { createVariant } from '../../canonical/canonical-variant.service.js';
import {
  draftAttributeDefinition,
  publishAttributeDefinition,
} from '../../attributes/definition-registry.service.js';
import {
  countProductsForBrand,
  countProductsForFamily,
} from '../../../db/canonical/canonicalProductRepository.js';
import { countVariantsForProduct } from '../../../db/canonical/canonicalVariantRepository.js';
import { rebuildEntityRollups } from '../rollups.js';
import { refreshBrandProductCount } from '../../../db/canonical/brandRepository.js';

let db: Database;

/** Unique to this run — the database is shared with every parallel file. */
const RUN = uuidv7().slice(-12);

const createdProductIds: string[] = [];
const createdVariantIds: string[] = [];
let brandId = '';
let familyId = '';
/**
 * A published attribute, so variants can carry DISTINCT option sets.
 *
 * Without it every `createVariant` here would pass `options: []` — and an
 * axis-less product already carries one default variant with exactly that empty
 * option set, so the second call collides on `UNIQUE(product_id, signature)`,
 * returns the EXISTING row with `created: false`, and stores nothing. The delta
 * case then compares a number against itself and passes for the wrong reason.
 */
let axisKey = '';
/** The product carrying the variants: 1 active, 1 suppressed. */
let productId = '';

beforeAll(async () => {
  db = await connectPostgres();

  brandId = (await createBrand({ name: `Rollup brand ${RUN}`, slug: `rollup-brand-${RUN}` })).id;
  familyId = (
    await createProductFamily({ brandId, name: `Rollup family ${RUN}`, slug: `rollup-fam-${RUN}` })
  ).id;

  // The axis is published FIRST: a variant's option set must match its
  // product's DECLARED axes exactly, so the product cannot be created until the
  // attribute it varies along exists.
  axisKey = `rollupsize${RUN}`.replace(/\W/gu, '').slice(0, 30);
  const draft = await draftAttributeDefinition({
    key: axisKey,
    label: 'Rollup size',
    valueType: 'string',
    actorOxyUserId: `operator-${RUN}`,
  });
  await publishAttributeDefinition(draft.key, draft.version, `operator-${RUN}`);

  // THREE products under one family and one brand: two shopper-visible, one
  // suppressed. `suppressed` is an operator's "do not show it", which is
  // exactly the row a shopper-facing count must not include and a curation
  // read must still be able to see.
  //
  // Only the FIRST declares an axis, because it is the one carrying the
  // variants. A product with no declared axes is minted with exactly one
  // default variant; a product WITH one is minted with none, so every variant
  // below is created explicitly and its option set is distinct by construction.
  for (const [index, status] of (['active', 'active', 'suppressed'] as const).entries()) {
    const product = await createCanonicalProduct({
      name: `Rollup product ${index} ${RUN}`,
      brandId,
      familyId,
      ...(index === 0 ? { variantDefiningAttributeKeys: [axisKey] } : {}),
    });
    createdProductIds.push(product.id);
    if (status !== 'active') {
      await db
        .update(canonicalProducts)
        .set({ status })
        .where(eq(canonicalProducts.id, product.id));
    }
  }
  productId = createdProductIds[0];

  // Two variants on that product: one a shopper may see, one they may not.
  // `created` is ASSERTED on both — a colliding option set returns the existing
  // row with `created: false` and adds nothing, and the delta case would then
  // compare a number against itself and pass for the wrong reason.
  const visible = await createVariant({
    productId,
    options: [{ key: axisKey, value: 'visible-one' }],
    name: `Rollup variant visible ${RUN}`,
  });
  expect(visible.created, 'the visible variant collided and was never created').toBe(true);
  createdVariantIds.push(visible.variant.id);

  const suppressed = await createVariant({
    productId,
    options: [{ key: axisKey, value: 'suppressed-one' }],
    name: `Rollup variant suppressed ${RUN}`,
    status: 'suppressed',
  });
  expect(suppressed.created, 'the suppressed variant collided and was never created').toBe(true);
  createdVariantIds.push(suppressed.variant.id);
});

afterAll(async () => {
  await deleteTestCanonicalRows(db, {
    productIds: createdProductIds,
    variantIds: createdVariantIds,
  });
  await db.delete(canonicalProductFamilies).where(eq(canonicalProductFamilies.id, familyId));
  await db.delete(brands).where(eq(brands.id, brandId));
  await closePostgres();
});

async function storedFamilyCount(): Promise<number> {
  const [row] = await db
    .select({ n: canonicalProductFamilies.productCount })
    .from(canonicalProductFamilies)
    .where(eq(canonicalProductFamilies.id, familyId));
  return row?.n ?? -1;
}

async function storedBrandCount(): Promise<number> {
  const [row] = await db
    .select({ n: brands.productCount })
    .from(brands)
    .where(eq(brands.id, brandId));
  return row?.n ?? -1;
}

async function storedVariantCount(): Promise<number> {
  const [row] = await db
    .select({ n: canonicalProducts.variantCount })
    .from(canonicalProducts)
    .where(eq(canonicalProducts.id, productId));
  return row?.n ?? -1;
}

describe('the stored rollup counters (#749)', () => {
  it('the merge path stores a count that excludes suppressed products', async () => {
    await rebuildEntityRollups('canonical_product', createdProductIds[2], productId, db);

    const family = await storedFamilyCount();
    const brand = await storedBrandCount();

    // THE FLOOR, asserted before the equalities. A rebuild that wrote nothing
    // and a rebuild that wrote the right number are the same assertion away
    // from each other, and only this tells them apart: `0 === 0` would pass
    // every check below over a fixture that never landed.
    expect(family, 'the rebuild wrote nothing for the family').toBeGreaterThan(0);
    expect(brand, 'the rebuild wrote nothing for the brand').toBeGreaterThan(0);

    // Two active of three. The suppressed product is a row a shopper may not
    // see, and these counters are rendered beside counts #628/#747 already
    // narrowed — the family entries could otherwise claim more products than
    // the brand admits to having.
    expect(family, 'family.product_count counts the suppressed product').toBe(2);
    expect(brand, 'brands.product_count counts the suppressed product').toBe(2);
  });

  it('every writer of a counter agrees, because each reads ONE derivation', async () => {
    // The property the wider diff exists for, asserted directly rather than
    // inferred from the two cases around it. `rollups.ts` used to spell each
    // derivation inline; if it drifts from the shared function again, the
    // stored value and the function disagree here.
    await rebuildEntityRollups('canonical_product', createdProductIds[2], productId, db);

    const [storedFamily, derivedFamily] = [
      await storedFamilyCount(),
      await countProductsForFamily(db, familyId),
    ];
    const [storedBrand, derivedBrand] = [
      await storedBrandCount(),
      await countProductsForBrand(db, brandId),
    ];
    const [storedVariant, derivedVariant] = [
      await storedVariantCount(),
      await countVariantsForProduct(db, productId),
    ];

    // Floors first: every one of these is an equality between two numbers, and
    // `0 === 0` would satisfy all three over a fixture that never landed.
    expect(derivedFamily, 'the family derivation counted nothing').toBeGreaterThan(0);
    expect(derivedBrand, 'the brand derivation counted nothing').toBeGreaterThan(0);
    expect(derivedVariant, 'the variant derivation counted nothing').toBeGreaterThan(0);

    expect(storedFamily, 'the merge rollup and countProductsForFamily disagree').toBe(derivedFamily);
    expect(storedBrand, 'the merge rollup and countProductsForBrand disagree').toBe(derivedBrand);
    expect(storedVariant, 'the merge rollup and countVariantsForProduct disagree').toBe(
      derivedVariant,
    );
  });

  it('variant_count keeps its OWN population, which #749 left undecided', async () => {
    // Deliberately pinned, so the two neighbours moving to the shopper-visible
    // set cannot quietly drag this one along for symmetry. The product carries
    // one visible variant and one suppressed; `variant_count` counts BOTH,
    // because "configurations a shopper may see" and "configurations this
    // product has" are different questions and nothing here settles which one
    // this column answers. See the derivation's docblock and #749.
    await rebuildEntityRollups('canonical_product', createdProductIds[2], productId, db);

    const stored = await storedVariantCount();
    expect(stored, 'the rebuild wrote nothing for the product').toBeGreaterThan(0);
    expect(
      stored,
      'variant_count changed population — that is a decision #749 did not take',
    ).toBe(2);
  });

  it('the brand repair path exists and writes what the derivation says', async () => {
    // `brands.product_count` had NO repair path before #749: the merge rollup
    // was its only writer, so a brand nobody merged kept whatever a past merge
    // left, and correcting the derivation could never reach it.
    // `refreshBrandProductCount` is that path, and `rebuild_projections` now
    // calls it.
    //
    // Driven at the FUNCTION rather than through the stage, deliberately.
    // `rebuild_projections` is in `WHOLE_CATALOGUE_STAGES` — it refuses a
    // cohort, pages over every product, and resolves its handle through
    // `getDb()`, so it cannot be pointed at a private database. Driving it here
    // examined every sibling's products and wrote a
    // `catalog_backfill_records` row against each; those rows are
    // `ON DELETE restrict`, so two innocent files failed in TEARDOWN
    // (`condition.realdb`, `facet-axis-bucket.realdb`) while every assertion in
    // this file passed. A test that breaks the file after it is not a test.
    await db.update(brands).set({ productCount: 99 }).where(eq(brands.id, brandId));
    expect(await storedBrandCount(), 'the poison did not land').toBe(99);

    await refreshBrandProductCount(db, brandId, await countProductsForBrand(db, brandId));

    const derived = await countProductsForBrand(db, brandId);
    expect(derived, 'the brand derivation counted nothing').toBeGreaterThan(0);
    expect(await storedBrandCount(), 'the brand repair path did not write').toBe(derived);
  });

  it('the rebuild STAGE calls that path, so it is not green and inert', async () => {
    // The behavioural drive is unavailable for the reason above, so the wiring
    // is asserted from the stage's own source: a repair path nothing calls
    // repairs nothing, and `countProductsForBrand` alone cannot tell the two
    // apart. Read from disk rather than imported, because an import would prove
    // only that the module loads.
    const source = await readFile(
      new URL('../../backfill/stages/projections.ts', import.meta.url),
      'utf8',
    );
    // A floor first: if the file moved, an absent string would read as absent
    // wiring rather than as a broken path.
    expect(source.length, 'the stage source was not read').toBeGreaterThan(1_000);
    expect(source, 'the rebuild stage does not import the brand repair').toContain(
      'refreshBrandProductCount',
    );
    expect(source, 'the rebuild stage does not read the brand derivation').toContain(
      'countProductsForBrand',
    );
    // …and that the family path it is modelled on is still there, so a scan
    // that matched nothing at all cannot pass the two above by coincidence.
    expect(source).toContain('refreshFamilyProductCount');
  });

  it('stays consistent across BOTH writers when one visible variant is added', async () => {
    await rebuildEntityRollups('canonical_product', createdProductIds[2], productId, db);
    const afterWriterA = await storedVariantCount();

    // The floor again: a zero here would make the delta below pass over a
    // product whose variants never landed.
    expect(afterWriterA, 'the rebuild wrote nothing for the product').toBeGreaterThan(0);

    // `createVariant` is writer B — it recomputes `variant_count` from scratch
    // through `countVariantsForProduct`, not by incrementing.
    const added = await createVariant({
      productId,
      options: [{ key: axisKey, value: 'added-one' }],
      name: `Rollup variant added ${RUN}`,
    });
    // The delta below is meaningless if this collided: it would compare the
    // stored count against itself and read as a stable, correct 0 change.
    expect(added.created, 'the added variant collided — no variant was added').toBe(true);
    createdVariantIds.push(added.variant.id);

    const afterWriterB = await storedVariantCount();

    // ONE shopper-visible variant was added, so the stored count moves by ONE
    // under either meaning. It moves by TWO only when the two writers disagree
    // — writer A storing the narrow figure and writer B replacing it with the
    // loose one — which is the state a fix scoped to `rollups.ts` alone
    // produces, and which no single rule can produce.
    expect(
      afterWriterB - afterWriterA,
      `one variant added, stored count moved by ${String(afterWriterB - afterWriterA)}: ` +
        'the two writers of variant_count disagree',
    ).toBe(1);
  });
});
