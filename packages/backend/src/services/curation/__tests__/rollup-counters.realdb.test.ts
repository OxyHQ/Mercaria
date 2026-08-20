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
import { eq } from 'drizzle-orm';
import { uuidv7 } from '@oxyhq/db';
import { closePostgres, connectPostgres, type Database } from '../../../db/postgres.js';
import { deleteTestCanonicalRows } from '../../../db/__tests__/canonical-teardown.js';
import { brands } from '../../../db/schema/organizations.js';
import {
  canonicalProductFamilies,
  canonicalProducts,
  canonicalVariants,
} from '../../../db/schema/canonicalCatalog.js';
import { createBrand } from '../../canonical/brand.service.js';
import { createProductFamily } from '../../canonical/product-family.service.js';
import { createCanonicalProduct } from '../../canonical/canonical-product.service.js';
import { createVariant } from '../../canonical/canonical-variant.service.js';
import { rebuildEntityRollups } from '../rollups.js';

let db: Database;

/** Unique to this run — the database is shared with every parallel file. */
const RUN = uuidv7().slice(-12);

const createdProductIds: string[] = [];
const createdVariantIds: string[] = [];
let brandId = '';
let familyId = '';
/** The product carrying the variants: 1 active, 1 suppressed. */
let productId = '';

beforeAll(async () => {
  db = await connectPostgres();

  brandId = (await createBrand({ name: `Rollup brand ${RUN}`, slug: `rollup-brand-${RUN}` })).id;
  familyId = (
    await createProductFamily({ brandId, name: `Rollup family ${RUN}`, slug: `rollup-fam-${RUN}` })
  ).id;

  // THREE products under one family and one brand: two shopper-visible, one
  // suppressed. `suppressed` is an operator's "do not show it", which is
  // exactly the row a shopper-facing count must not include and a curation
  // read must still be able to see.
  for (const [index, status] of (['active', 'active', 'suppressed'] as const).entries()) {
    const product = await createCanonicalProduct({
      name: `Rollup product ${index} ${RUN}`,
      brandId,
      familyId,
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

  // `createCanonicalProduct` with no option axes already minted ONE default
  // variant, which is `active`. Adding one suppressed variant beside it gives
  // the product two variants, one of them a row a shopper may not see.
  const suppressed = await createVariant({
    productId,
    options: [],
    name: `Rollup variant suppressed ${RUN}`,
    status: 'suppressed',
  });
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
      options: [],
      name: `Rollup variant added ${RUN}`,
    });
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
