/**
 * The STATUS filters on the canonical picker (#367 step 5, #758).
 *
 * The companion to
 * `services/catalog-authoring/__tests__/schema-version-lifecycle-exposure.realdb.test.ts`,
 * which owns the product-type and category half of the same question — *which
 * lifecycle or status may an unprivileged caller see*. Split by FIXTURE rather
 * than by question: those readers need product-type versions and categories,
 * these need canonical products, variants, brands and identifiers, and one file
 * carrying both fixture stacks would make every case pay for the other's setup.
 *
 * `docs/reviews/2026-08-17-catalog-authoring-security-review.md` §6 counts SEVEN
 * readers of that question on `/catalog-authoring/*`, which is authenticated and
 * nothing more — no store permission, no operator allow-list
 * (`routes/catalog-authoring.ts:35,41`). Four of the seven are here.
 *
 * ## What was wrong: `searchBrandsByName` (#758)
 *
 * It filtered `isNull(brands.mergedIntoId)` and nothing else. `brands_status_check`
 * carries `active | inactive | merged | suppressed` and a biconditional ties
 * `merged` to the pointer, so that test was exactly `status <> 'merged'` — it
 * admitted `inactive` and `suppressed`. `suppressed` is the operator decision to
 * stop showing a brand, so the picker disclosed the withheld set to any
 * authenticated account, while the product and variant halves of the SAME
 * endpoint already admitted only `active`.
 *
 * ## What was right and measured NOTHING
 *
 * `searchCanonicalProductsByName` and `listSelectableCanonicalVariants` were
 * correct and referenced by no test at all, and
 * `findCanonicalProductsByIdentifier` had ONE of its two status clauses pinned
 * (`authoring-identifier-collision.realdb.test.ts:280` retires an identifier and
 * drives the collision path) and the other pinned by nothing.
 *
 * Worth stating because it is the trap: a name-based coverage census reports
 * more coverage than exists. `draft-upgrade.test.ts` REFERENCES two sibling
 * readers and then `vi.mock`s them with `vi.fn()`, and a mock REPLACES the
 * function — it cannot pin a predicate the server evaluates. So the population
 * of "filters defended by a test" is smaller than any grep will say, and it is
 * smaller in the direction that reads as safe.
 *
 * ## Why a REAL database
 *
 * Every property here is a `where` clause the server evaluates. A mocked
 * repository accepts any statement, including one Postgres would reject, so a
 * mocked version of this file would assert that the code calls a filter the test
 * itself wrote — the re-implementation measuring the re-implementation.
 *
 * ## The fixtures are ADVERSARIAL, which is the whole design
 *
 * `searchCanonicalProductsByName` and `searchBrandsByName` carry NO name
 * predicate: they order the whole table by trigram distance and take `limit`. So
 * a suppressed row could be absent from a result because it fell outside the
 * window rather than because a filter excluded it, and the test would pass
 * against the filter's absence — on a SHARED database, where siblings' rows
 * compete for that window.
 *
 * Each query therefore asks for the EXACT normalized name of the row that must
 * be excluded. Distance 0 puts it first if the filter is gone, so its absence
 * can only be the filter. The active row is named in every assertion as the
 * positive control, because "excluded" and "the query matched nothing" are the
 * same empty result.
 *
 * ## Scoping, because this database is SHARED
 *
 * Every name, slug and identifier carries a per-run suffix; the variant and
 * identifier reads are scoped by an id this file owns, so those assert exact
 * equality. The two unscoped searches assert presence and absence of ids this
 * file created and never count a table.
 *
 * Teardown goes through `deleteTestCanonicalRows`, which declines to delete
 * exactly the ids a sibling's matcher has since cited (both citing columns are
 * `ON DELETE restrict`) rather than deleting another file's rows. Identifiers
 * CASCADE from their product; brands are deleted last, because
 * `canonical_products.brand_id` is `restrict`.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inArray } from 'drizzle-orm';
import { uuidv7 } from '@oxyhq/db';
import { closePostgres, connectPostgres, type Database } from '../../postgres.js';
import { brands } from '../../schema/organizations.js';
import {
  canonicalProducts,
  canonicalVariants,
  productIdentifiers,
} from '../../schema/canonicalCatalog.js';
import {
  findCanonicalProductsByIdentifier,
  listSelectableCanonicalVariants,
  searchBrandsByName,
  searchCanonicalProductsByName,
} from '../canonicalSearchRepository.js';
import { deleteTestCanonicalRows } from '../../__tests__/canonical-teardown.js';

let db: Database;

/** Unique to this run, so parallel files cannot collide on a shared database. */
const RUN = uuidv7().slice(-12).replace(/\W/gu, '');

/** A generous window, so absence is never merely "outside the limit". */
const LIMIT = 50;

/**
 * The exact normalized names each search asks for.
 *
 * The EXCLUDED row owns the query string in both searches — see the header. The
 * active row's name shares the prefix so it still ranks well inside `LIMIT`.
 */
const SUPPRESSED_PRODUCT_NAME = `zqx picker suppressed ${RUN}`;
const ACTIVE_PRODUCT_NAME = `zqx picker active ${RUN}`;
const DRAFT_PRODUCT_NAME = `zqx picker draft ${RUN}`;
const SUPPRESSED_BRAND_NAME = `zqx brand suppressed ${RUN}`;
const INACTIVE_BRAND_NAME = `zqx brand inactive ${RUN}`;
const ACTIVE_BRAND_NAME = `zqx brand active ${RUN}`;

/** One MPN two products claim, and one this file retires. */
const SHARED_MPN = `zqx-mpn-${RUN}`.toLowerCase();
const RETIRED_MPN = `zqx-retired-${RUN}`.toLowerCase();

let activeBrandId: string;
let inactiveBrandId: string;
let suppressedBrandId: string;

let activeProductId: string;
let suppressedProductId: string;
let draftProductId: string;

let activeVariantId: string;
let suppressedVariantId: string;

const createdProductIds: string[] = [];
const createdVariantIds: string[] = [];
const createdBrandIds: string[] = [];

/** `canonical_variants_signature_shape_check` requires 64 hex characters. */
function signature(seed: string): string {
  const hex = [...seed].map((ch) => ch.codePointAt(0)?.toString(16) ?? '0').join('');
  return hex.repeat(64).slice(0, 64);
}

async function makeBrand(name: string, status: 'active' | 'inactive' | 'suppressed') {
  const [row] = await db
    .insert(brands)
    .values({
      slug: `${name.replace(/\s+/gu, '-')}`.toLowerCase(),
      name,
      normalizedName: name,
      status,
    })
    .returning();
  createdBrandIds.push(row.id);
  return row.id;
}

async function makeProduct(name: string, status: 'active' | 'draft' | 'suppressed', brandId: string) {
  const [row] = await db
    .insert(canonicalProducts)
    .values({
      slug: `${name.replace(/\s+/gu, '-')}`.toLowerCase(),
      name,
      normalizedName: name,
      status,
      brandId,
    })
    .returning();
  createdProductIds.push(row.id);
  return row.id;
}

beforeAll(async () => {
  db = await connectPostgres();

  activeBrandId = await makeBrand(ACTIVE_BRAND_NAME, 'active');
  inactiveBrandId = await makeBrand(INACTIVE_BRAND_NAME, 'inactive');
  suppressedBrandId = await makeBrand(SUPPRESSED_BRAND_NAME, 'suppressed');

  activeProductId = await makeProduct(ACTIVE_PRODUCT_NAME, 'active', activeBrandId);
  suppressedProductId = await makeProduct(SUPPRESSED_PRODUCT_NAME, 'suppressed', activeBrandId);
  draftProductId = await makeProduct(DRAFT_PRODUCT_NAME, 'draft', activeBrandId);

  // Two configurations under the ACTIVE product, so the variant case is about
  // the variant's own status and never about its product's.
  const variants = await db
    .insert(canonicalVariants)
    .values([
      {
        productId: activeProductId,
        name: `Active configuration ${RUN}`,
        signature: signature(`a${RUN}`),
        status: 'active',
      },
      {
        productId: activeProductId,
        name: `Suppressed configuration ${RUN}`,
        signature: signature(`s${RUN}`),
        status: 'suppressed',
      },
    ])
    .returning();
  for (const variant of variants) createdVariantIds.push(variant.id);
  activeVariantId = variants[0].id;
  suppressedVariantId = variants[1].id;

  // `mpn`, so no GTIN check-digit or canonical-pair CHECK is in play and the
  // `canonical === null` branch of the finder is the one exercised.
  //
  // The SAME mpn on an active and a suppressed product: permitted, because
  // `product_identifiers_product_active_key` is unique per (product, scheme,
  // value). That is what makes the SELECTABLE_STATUS case adversarial — both
  // rows are `status = 'active'` identifiers, so only the product's status can
  // tell them apart.
  await db.insert(productIdentifiers).values([
    {
      productId: activeProductId,
      scheme: 'mpn',
      rawValue: SHARED_MPN,
      normalizedValue: SHARED_MPN,
      status: 'active',
    },
    {
      productId: suppressedProductId,
      scheme: 'mpn',
      rawValue: SHARED_MPN,
      normalizedValue: SHARED_MPN,
      status: 'active',
    },
    // A RETIRED identifier on the ACTIVE product — the other clause, so this
    // file measures both halves of that finder rather than one twice.
    {
      productId: activeProductId,
      scheme: 'mpn',
      rawValue: RETIRED_MPN,
      normalizedValue: RETIRED_MPN,
      status: 'retired',
    },
  ]);
}, 120_000);

afterAll(async () => {
  if (!db) return;
  if (createdProductIds.length > 0 || createdVariantIds.length > 0) {
    await deleteTestCanonicalRows(db, {
      productIds: createdProductIds,
      variantIds: createdVariantIds,
    });
  }
  if (createdBrandIds.length > 0) {
    // Last: `canonical_products.brand_id` is `restrict`, so a brand cannot go
    // before the products naming it. A brand retained above (because a sibling
    // cited its product) leaves this delete refused, which is correct and loud.
    await db.delete(brands).where(inArray(brands.id, createdBrandIds));
  }
  await closePostgres();
});

describe('VACUITY CONTROL — the fixtures are the states they claim', () => {
  it('created six distinct rows in six distinct states', async () => {
    // Without this, a fixture that silently lost a status override would make
    // an exclusion case pass by measuring an already-excluded row twice.
    const brandRows = await db
      .select()
      .from(brands)
      .where(inArray(brands.id, [activeBrandId, inactiveBrandId, suppressedBrandId]));
    const brandStatus = new Map(brandRows.map((row) => [row.id, row.status]));
    expect(brandStatus.get(activeBrandId)).toBe('active');
    expect(brandStatus.get(inactiveBrandId)).toBe('inactive');
    expect(brandStatus.get(suppressedBrandId)).toBe('suppressed');

    const productRows = await db
      .select()
      .from(canonicalProducts)
      .where(inArray(canonicalProducts.id, [activeProductId, suppressedProductId, draftProductId]));
    const productStatus = new Map(productRows.map((row) => [row.id, row.status]));
    expect(productStatus.get(activeProductId)).toBe('active');
    expect(productStatus.get(suppressedProductId)).toBe('suppressed');
    expect(productStatus.get(draftProductId)).toBe('draft');

    // The excluded brand and product are NOT merged, which is the point of
    // #758: the old pointer filter admitted them precisely because they are not.
    const notMerged = brandRows.filter((row) => row.mergedIntoId === null).map((row) => row.id);
    expect(notMerged).toContain(suppressedBrandId);
    expect(notMerged).toContain(inactiveBrandId);
  });
});

describe('the brand picker offers only ACTIVE brands (#758)', () => {
  async function offeredBrandIds(query: string): Promise<string[]> {
    const rows = await searchBrandsByName(db, query, LIMIT);
    return rows.map((row) => row.id);
  }

  it('excludes a SUPPRESSED brand, which is not merged', async () => {
    // Queried by the suppressed brand's own exact name, so without the filter it
    // sorts FIRST at distance 0 and cannot be missing for any other reason.
    const ids = await offeredBrandIds(SUPPRESSED_BRAND_NAME);
    expect(ids).not.toContain(suppressedBrandId);
    // The positive control: an active brand IS returned, so the assertion above
    // is not satisfied by a picker answering nothing.
    expect(ids).toContain(activeBrandId);
  });

  it('excludes an INACTIVE brand, which is not merged', async () => {
    // A separate case, not a second assertion: `inactive` and `suppressed` are
    // different decisions and a filter could plausibly exclude one and not the
    // other. One case per excluded value, so a mutation reddening one leaves
    // the other's evidence intact.
    const ids = await offeredBrandIds(INACTIVE_BRAND_NAME);
    expect(ids).not.toContain(inactiveBrandId);
    expect(ids).toContain(activeBrandId);
  });
});

describe('the canonical product picker offers only ACTIVE products', () => {
  async function offeredProductIds(query: string): Promise<string[]> {
    const rows = await searchCanonicalProductsByName(db, query, LIMIT);
    return rows.map((row) => row.id);
  }

  it('excludes a SUPPRESSED product', async () => {
    const ids = await offeredProductIds(SUPPRESSED_PRODUCT_NAME);
    expect(ids).not.toContain(suppressedProductId);
    expect(ids).toContain(activeProductId);
  });

  it('excludes a DRAFT product — one #60 minted and nobody agreed', async () => {
    const ids = await offeredProductIds(DRAFT_PRODUCT_NAME);
    expect(ids).not.toContain(draftProductId);
    expect(ids).toContain(activeProductId);
  });
});

describe('the variant picker offers only ACTIVE configurations', () => {
  it('excludes a SUPPRESSED variant of an ACTIVE product', async () => {
    // Scoped by product id, so exact equality is safe on a shared database.
    const rows = await listSelectableCanonicalVariants(db, activeProductId, LIMIT);
    const ids = rows.map((row) => row.id);
    expect(ids).toEqual([activeVariantId]);
    expect(ids).not.toContain(suppressedVariantId);
  });
});

describe('the identifier finder filters on BOTH statuses', () => {
  async function ownersOf(value: string): Promise<string[]> {
    const rows = await findCanonicalProductsByIdentifier(db, value, null, LIMIT);
    return rows.map((row) => row.id);
  }

  it('ignores an ACTIVE identifier owned by a SUPPRESSED product', async () => {
    // The `SELECTABLE_STATUS` clause, and the half that was pinned by nothing.
    // Both identifier rows are `status = 'active'` and carry the same value, so
    // only the PRODUCT's status distinguishes them — the identifier clause
    // cannot perform this exclusion.
    const owners = await ownersOf(SHARED_MPN);
    expect(owners).not.toContain(suppressedProductId);
    expect(owners).toEqual([activeProductId]);
  });

  it('ignores a RETIRED identifier of an ACTIVE product', async () => {
    // The `product_identifiers.status` clause, the mirror image: the product is
    // active, so only the identifier's status can exclude it. Two cases because
    // one is satisfied by either clause alone.
    //
    // Also covered end-to-end through the collision path by
    // `authoring-identifier-collision.realdb.test.ts:280`; here it is measured
    // at the reader, which is a different statement.
    expect(await ownersOf(RETIRED_MPN)).toEqual([]);
    // The instrument works — the same finder DOES return the active pairing.
    expect(await ownersOf(SHARED_MPN)).toEqual([activeProductId]);
  });
});
