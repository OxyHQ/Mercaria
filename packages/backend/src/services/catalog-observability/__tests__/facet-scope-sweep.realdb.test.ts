/**
 * The facet-scope empty-generation sweep against a REAL PostgreSQL server
 * (#367 Workstream 17).
 *
 * ## Why a real server is not optional here
 *
 * The sweep's whole answer comes from `resolveFacets`, which is a dozen
 * aggregates over correlated `exists` predicates, a materialized ancestry array
 * and several CHECK-constrained tables. A mocked repository would accept every
 * one of those statements without evaluating any of them, so the counts under
 * test would be counts of whatever the mock was told to return. The eligibility
 * predicate (`lifecycle = 'published' and selectable`) and the deterministic
 * `order by md5(seed || id)` draw likewise exist only on a server.
 *
 * ## THE POSITIVE CONTROL IS THE FILE
 *
 * A sweep asserted against an empty catalogue cannot fail: `empty: 0` is what a
 * clean catalogue reports and it is also what a sweep that examined nothing
 * reports, what a sweep whose predicate matched no rows reports, and what a
 * sweep whose verdict is inverted reports. So the fixture is built so that every
 * counter has a NON-ZERO expected value and each one would move if the sweep
 * were wrong in the way that counter guards:
 *
 * ```
 *   root      published, NOT selectable   ← excluded: proves `selectable`
 *   ├── bare-a  published, selectable     ⇒ EMPTY      (no products, no children)
 *   ├── bare-b  published, selectable     ⇒ EMPTY
 *   ├── bare-c  published, selectable     ⇒ EMPTY
 *   ├── stocked published, selectable     ⇒ POPULATED  (price + availability facets)
 *   ├── broken  published, selectable     ⇒ FAILED     (generation raises)
 *   └── draft   DRAFT,     selectable     ← excluded: proves `lifecycle`
 * ```
 *
 * Both excluded categories would be swept as EMPTY if the predicate lost the
 * half they control, so the eligibility rule has a signature in the numbers
 * rather than being asserted about itself.
 *
 * `stocked` is also the control on the READER CHOICE. It carries no faceted
 * attribute and no product type, so a sweep built on `planFacets` alone — the
 * cheaper reading this module's docblock rejects — would report it EMPTY and
 * `populated` would be zero. The `/facets` route offers two facets for it, which
 * is what a shopper standing there sees.
 *
 * ## Nothing is committed, so there is no teardown
 *
 * Every fixture is created inside a `repeatable read` transaction that is ROLLED
 * BACK, and the sweep is driven on that same handle. Three things follow at
 * once: no row this file writes is visible to a parallel file; the deliberately
 * broken offer cannot outlive the assertion that wants it; and the
 * teardown-ordering hazard around `categories`, `catalog_sources` and
 * `canonical_products` — all `restrict` from several directions — does not arise,
 * because nothing has to be deleted. `integrity.realdb.test.ts` established the
 * pattern in this directory and states the isolation-level reasoning; the
 * callback is named `tx` because `advisory-lock-census.ts` classifies a handle as
 * transactional by name.
 *
 * ## Scoping, on a database shared with parallel files
 *
 * Every count assertion runs a sweep narrowed to this file's own root, so the
 * population is exactly the six categories above whatever else the run is
 * holding. The ONE unscoped sweep asserts identities and bounds only — never an
 * absolute count — because the whole-catalogue population is a fact about what
 * every other file happened to be doing.
 *
 * ## The prices are all FAIR, deliberately
 *
 * The display currency is FAIR, so a same-currency span needs no rate and the
 * whole run makes zero FX calls: `fx.service` reaches an HTTP provider, and a
 * facet count is not the place to find out whether it is up. FX conversion is
 * `price.ts`'s subject and is covered by the facets domain's own suite.
 */

import { afterAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { MAX_MONEY_MINOR_UNITS, FACET_SUPPRESSION_REASONS } from '@mercaria/shared-types';
import {
  closePostgres,
  connectPostgres,
  type Database,
  type Transaction,
} from '../../../db/postgres.js';
import { categories } from '../../../db/schema/catalog.js';
import { catalogSources, sourceRecords } from '../../../db/schema/provenance.js';
import { merchants } from '../../../db/schema/merchants.js';
import { canonicalProducts, canonicalVariants } from '../../../db/schema/canonicalCatalog.js';
import { offers } from '../../../db/schema/offers.js';
import {
  examineFacetScope,
  sweepFacetScopes,
  FACET_SCOPE_SWEEP_CURRENCY,
  FACET_SCOPE_SWEEP_DEFAULT_SEED,
  FACET_SCOPE_SWEEP_INCLUDE_DESCENDANTS,
  FACET_SCOPE_SWEEP_MAX_SAMPLE_SIZE,
  type FacetScopeSweepFrame,
  type FacetScopeSweepResult,
} from '../facet-scope-sweep.js';

const db: Database = await connectPostgres();

afterAll(async () => {
  await closePostgres();
});

/* -------------------------------------------------------------------------- */
/* Fixture identity                                                            */
/* -------------------------------------------------------------------------- */

/**
 * The prefix every id here carries.
 *
 * `zz-` first for the reason `integrity.realdb.test.ts` records: it sorts above
 * every uuid v7 hex id, so a row of this file's is inside any bounded
 * newest-first page. It is also unique to this file, so nothing another file
 * mints can enter a scoped sweep.
 *
 * The ids are STABLE rather than per-run, which is safe because the transaction
 * is rolled back — and it is what makes the draw assertions below meaningful: a
 * deterministic hash order over ids that changed every run could only be
 * asserted to be self-consistent, never to depend on the seed.
 */
const P = 'zz-obs-facet';

const ROOT = `${P}-root`;
const BARE = [`${P}-bare-a`, `${P}-bare-b`, `${P}-bare-c`];
const STOCKED = `${P}-stocked`;
const BROKEN = `${P}-broken`;
const DRAFT = `${P}-draft`;

/** Every category eligible for a sweep of this subtree. */
const ELIGIBLE = [...BARE, STOCKED, BROKEN];

const SOURCE = `${P}-src`;
const RECORD = `${P}-rec`;
const MERCHANT = `${P}-merch`;

/**
 * The fixture clock, safely in the PAST.
 *
 * `#253`: a fixture pinned to a future date passes today and breaks CI on the
 * day it arrives, in a file whoever pushed did not touch. Every offer predicate
 * in the facets domain is `stale_at > now` against the CALLER's clock, and the
 * sweep is handed `NOW` as that caller — so the deadline is DERIVED from it as an
 * offset rather than written as a second literal that could drift past it.
 */
const OBSERVED = new Date('2025-12-01T00:00:00.000Z');
const NOW = new Date('2026-01-01T00:00:00.000Z');
const ONE_DAY_MS = 86_400_000;
const STALE_AT = new Date(NOW.getTime() + ONE_DAY_MS);

/** Two different prices, so `stocked`'s span is not degenerate. */
const LOW_PRICE_MINOR = 10_000;
const HIGH_PRICE_MINOR = 25_000;

/**
 * A price `offers_non_negative_money_check` accepts and `assertSafeMoneyAmount`
 * refuses.
 *
 * Derived from the shared ceiling rather than written as a literal, so it stays
 * one past the bound whatever the bound becomes. `offers.price_amount` is a
 * `bigint` with only a `>= 0` CHECK on it, so this row is genuinely storable —
 * which is the whole point of the control: the failure it produces is one a real
 * catalogue can reach through an ingested price nobody bounded, not a fault
 * injected through a mock.
 */
const OUT_OF_RANGE_PRICE_MINOR = MAX_MONEY_MINOR_UNITS + 1;

/** The frame every direct `examineFacetScope` call runs in. */
const FRAME: FacetScopeSweepFrame = {
  locale: 'en',
  displayCurrency: FACET_SCOPE_SWEEP_CURRENCY,
  includeDescendants: FACET_SCOPE_SWEEP_INCLUDE_DESCENDANTS,
};

/* -------------------------------------------------------------------------- */
/* The rolled-back fixture                                                     */
/* -------------------------------------------------------------------------- */

/** Thrown to roll a fixture transaction back. Never escapes the helper. */
class RolledBack extends Error {}

/**
 * Build the fixture, run `work` against it, and roll everything back.
 *
 * `repeatable read` so every statement in one case reads the snapshot the first
 * one took: the unscoped sweep below counts a population that parallel files are
 * actively adding to, and at `read committed` its own `count(*)` and its own
 * draw would read two different catalogues.
 */
async function withFixture<T>(work: (tx: Transaction) => Promise<T>): Promise<T> {
  let captured: T;
  try {
    await db.transaction(
      async (tx) => {
        await seed(tx);
        captured = await work(tx);
        throw new RolledBack('fixture transaction rolled back deliberately');
      },
      { isolationLevel: 'repeatable read' },
    );
  } catch (error) {
    if (!(error instanceof RolledBack)) throw error;
  }
  return captured;
}

/** One canonical variant. `canonical_variants_signature_shape_check` wants 64 hex. */
async function addVariant(tx: Transaction, productId: string, index: number): Promise<string> {
  const id = `${P}-v-${String(index)}`;
  await tx.insert(canonicalVariants).values({
    id,
    productId,
    signature: String(index).padStart(64, 'b'),
    name: `variant ${String(index)}`,
    isDefault: true,
    status: 'active',
    firstSeenAt: OBSERVED,
  });
  return id;
}

/** An EXTERNAL offer, which `offers_kind_shape_check` shapes completely. */
async function addOffer(
  tx: Transaction,
  canonicalVariantId: string,
  options: { availability: 'in_stock' | 'out_of_stock'; priceMinor: number },
): Promise<void> {
  await tx.insert(offers).values({
    id: `${P}-o-${canonicalVariantId}-${options.availability}`,
    kind: 'external',
    status: 'active',
    canonicalVariantId,
    merchantId: MERCHANT,
    sourceRecordId: RECORD,
    destinationUrl: `https://example.invalid/${canonicalVariantId}`,
    priceAmount: options.priceMinor,
    priceCurrency: FACET_SCOPE_SWEEP_CURRENCY,
    availability: options.availability,
    condition: 'new',
    conditionMappingState: 'declared',
    country: 'ES',
    observedAt: OBSERVED,
    firstSeenAt: OBSERVED,
    lastSeenAt: OBSERVED,
    staleAt: STALE_AT,
  });
}

async function seed(tx: Transaction): Promise<void> {
  await tx.insert(categories).values([
    {
      // A grouping root: published so its subtree resolves, NOT selectable so no
      // product may be filed under it — and so a correct sweep leaves it out.
      id: ROOT,
      key: `${P}.root`,
      name: 'Sweep root',
      slug: ROOT,
      ancestorIds: [],
      lifecycle: 'published',
      selectable: false,
      position: 0,
    },
    ...BARE.map((id, index) => ({
      id,
      key: `${P}.bare-${String(index)}`,
      name: `Bare ${String(index)}`,
      slug: id,
      parentId: ROOT,
      ancestorIds: [ROOT],
      lifecycle: 'published' as const,
      selectable: true,
      position: index,
    })),
    {
      id: STOCKED,
      key: `${P}.stocked`,
      name: 'Stocked',
      slug: STOCKED,
      parentId: ROOT,
      ancestorIds: [ROOT],
      lifecycle: 'published',
      selectable: true,
      position: BARE.length,
    },
    {
      id: BROKEN,
      key: `${P}.broken`,
      name: 'Broken',
      slug: BROKEN,
      parentId: ROOT,
      ancestorIds: [ROOT],
      lifecycle: 'published',
      selectable: true,
      position: BARE.length + 1,
    },
    {
      // Selectable, and NOT published. It holds no product either, so it would
      // be counted EMPTY the moment the lifecycle half of the predicate went.
      id: DRAFT,
      key: `${P}.draft`,
      name: 'Draft',
      slug: DRAFT,
      parentId: ROOT,
      ancestorIds: [ROOT],
      lifecycle: 'draft',
      selectable: true,
      position: BARE.length + 2,
    },
  ]);

  await tx.insert(catalogSources).values({
    id: SOURCE,
    kind: 'operator',
    name: 'facet scope sweep fixture',
    mayDisplay: true,
    mayStore: true,
    attributionRequired: false,
  });
  await tx.insert(sourceRecords).values({
    id: RECORD,
    sourceId: SOURCE,
    externalId: `${P}-ext`,
    externalType: 'offer',
    observedAt: OBSERVED,
    // `source_records_content_hash_shape_check` wants a sha-256 hex digest.
    contentHash: createHash('sha256').update(P).digest('hex'),
  });
  await tx.insert(merchants).values({
    id: MERCHANT,
    name: 'Sweep merchant',
    slug: `${P}-merchant`,
  });

  // `normalizedName` carries a per-run token because `canonical-fixture-census`
  // requires it: a stable normalized name is findable by every later sibling's
  // matcher retrieval, which is global. Nothing here reads the name.
  const stamp = createHash('sha256').update(String(Date.now())).digest('hex').slice(0, 12);
  await tx.insert(canonicalProducts).values([
    {
      id: `${P}-p-stocked-1`,
      slug: `${P}-p-stocked-1`,
      name: 'Sweep stocked one',
      normalizedName: `sweep stocked one ${stamp}`,
      categoryId: STOCKED,
      status: 'active',
      firstSeenAt: OBSERVED,
    },
    {
      id: `${P}-p-stocked-2`,
      slug: `${P}-p-stocked-2`,
      name: 'Sweep stocked two',
      normalizedName: `sweep stocked two ${stamp}`,
      categoryId: STOCKED,
      status: 'active',
      firstSeenAt: OBSERVED,
    },
    {
      id: `${P}-p-broken`,
      slug: `${P}-p-broken`,
      name: 'Sweep broken',
      normalizedName: `sweep broken ${stamp}`,
      categoryId: BROKEN,
      status: 'active',
      firstSeenAt: OBSERVED,
    },
  ]);

  // Two products, two availabilities and two prices: the availability facet has
  // two live buckets and the price span is not degenerate, so `stocked` offers
  // exactly two facets. Condition, market and channel are identical across both
  // offers and are therefore suppressed `single_value` — which is the domain
  // working, and it is why `stocked` is not trivially populated.
  const stockedOne = await addVariant(tx, `${P}-p-stocked-1`, 1);
  const stockedTwo = await addVariant(tx, `${P}-p-stocked-2`, 2);
  await addOffer(tx, stockedOne, { availability: 'in_stock', priceMinor: LOW_PRICE_MINOR });
  await addOffer(tx, stockedTwo, { availability: 'out_of_stock', priceMinor: HIGH_PRICE_MINOR });

  // The failure control: a stored price past the money ceiling, which
  // `composePriceSpan` refuses with a `RangeError` rather than suppressing.
  const brokenVariant = await addVariant(tx, `${P}-p-broken`, 3);
  await addOffer(tx, brokenVariant, {
    availability: 'in_stock',
    priceMinor: OUT_OF_RANGE_PRICE_MINOR,
  });
}

/** A sweep narrowed to this file's own subtree. */
function sweepSubtree(
  tx: Transaction,
  options: { sampleSize?: number; seed?: string } = {},
): Promise<FacetScopeSweepResult> {
  return sweepFacetScopes({
    db: tx,
    rootCategoryId: ROOT,
    now: NOW,
    ...(options.sampleSize === undefined ? {} : { sampleSize: options.sampleSize }),
    ...(options.seed === undefined ? {} : { seed: options.seed }),
  });
}

/**
 * What a sweep OBSERVED, reduced to something two draws can be compared on.
 *
 * The result does not carry the drawn ids — a health reading has no business
 * listing two hundred category ids — so the observable signature of a draw is
 * how many of each verdict it produced and which empties it named.
 */
function signature(result: FacetScopeSweepResult): string {
  return JSON.stringify({
    empty: result.empty,
    populated: result.populated,
    failed: result.failed,
    emptySample: [...result.emptySample].sort(),
  });
}

/* -------------------------------------------------------------------------- */
/* One scope at a time                                                         */
/* -------------------------------------------------------------------------- */

describe('examineFacetScope', () => {
  it('reports a category with no products and no children as bare, with the domain reasons', async () => {
    await withFixture(async (tx) => {
      const verdict = await examineFacetScope({
        db: tx,
        categoryId: BARE[0],
        frame: FRAME,
        now: NOW,
      });

      expect(verdict.outcome).toBe('no_facets');
      if (verdict.outcome !== 'no_facets') return;
      // The reasons are the facets domain's own vocabulary, passed through. A
      // bare rail with NO reasons at all would mean the domain generated nothing
      // and said nothing, which is a different (and worse) state.
      expect(verdict.suppressed.length, 'a bare rail reported no reason').toBeGreaterThan(0);
      for (const reason of verdict.suppressed) {
        expect(FACET_SUPPRESSION_REASONS).toContain(reason);
      }
      expect(verdict.suppressed).toContain('no_values');
    });
  });

  it('reports a category whose commerce dimensions vary as populated', async () => {
    await withFixture(async (tx) => {
      const verdict = await examineFacetScope({
        db: tx,
        categoryId: STOCKED,
        frame: FRAME,
        now: NOW,
      });

      expect(verdict.outcome).toBe('facets_generated');
      if (verdict.outcome !== 'facets_generated') return;
      // Two: the price span and the availability buckets. Asserted as a floor
      // rather than an equality so a facet the domain legitimately adds later
      // does not fail an observability test — but a floor of ONE would pass on a
      // plan-only reading, and this fixture has no faceted attribute at all.
      expect(verdict.facetCount).toBeGreaterThanOrEqual(2);
    });
  });

  it('THROWS for one category rather than reporting a verdict it does not have', async () => {
    await withFixture(async (tx) => {
      // The positive control for the sweep's isolation below: without this, a
      // `failed: 1` could come from anything, including a fixture that never
      // produced a failure at all.
      await expect(
        examineFacetScope({ db: tx, categoryId: BROKEN, frame: FRAME, now: NOW }),
      ).rejects.toThrow(RangeError);
    });
  });
});

/* -------------------------------------------------------------------------- */
/* The sweep                                                                   */
/* -------------------------------------------------------------------------- */

describe('sweepFacetScopes', () => {
  it('separates bare scopes from populated ones and isolates the failure', async () => {
    const result = await withFixture((tx) => sweepSubtree(tx));

    // The vacuity floor first. `empty: 0` is what a clean catalogue reports and
    // also what a sweep that examined nothing reports; these two numbers are the
    // only thing that tells them apart, so they are asserted before the verdicts.
    expect(result.population, 'the sweep examined an empty population').toBeGreaterThan(0);
    expect(result.sampled, 'the sweep produced no verdicts at all').toBeGreaterThan(0);

    // Exactly the five eligible categories: the non-selectable root and the
    // draft child are both excluded, and both would appear as EMPTY if the
    // eligibility predicate lost the half each of them controls.
    expect(result.population).toBe(ELIGIBLE.length);
    expect(result.drawn).toBe(ELIGIBLE.length);
    expect(result.truncated).toBe(false);

    expect(result.empty).toBe(BARE.length);
    expect(result.populated).toBe(1);
    expect(result.failed).toBe(1);
    // The denominator excludes the failure: a scope with no verdict is in
    // neither bucket. Folding it into `populated` would report 3/5 here.
    expect(result.sampled).toBe(BARE.length + 1);
    expect(result.emptyRatio).toBeCloseTo(BARE.length / (BARE.length + 1), 10);

    expect([...result.emptySample].sort()).toEqual([...BARE].sort());
    expect(result.failedSample).toEqual([BROKEN]);

    // The identities, stated so a later change cannot quietly break one.
    expect(result.sampled).toBe(result.empty + result.populated);
    expect(result.drawn).toBe(result.sampled + result.failed);
  });

  it('reports the domain reasons behind the bare scopes, as counts', async () => {
    const result = await withFixture((tx) => sweepSubtree(tx));

    expect(result.emptyReasons.length, 'no reason was reported for three bare rails')
      .toBeGreaterThan(0);
    for (const bucket of result.emptyReasons) {
      expect(FACET_SUPPRESSION_REASONS).toContain(bucket.reason);
      // Per SCOPE, so no reason can exceed the number of bare scopes. A count
      // over suppressed FACETS would run past this bound.
      expect(bucket.scopes).toBeGreaterThan(0);
      expect(bucket.scopes).toBeLessThanOrEqual(result.empty);
    }
    const noValues = result.emptyReasons.find((bucket) => bucket.reason === 'no_values');
    expect(noValues?.scopes).toBe(BARE.length);
  });

  it('reports `invalid` as unmeasured with no quantity on it', async () => {
    const result = await withFixture((tx) => sweepSubtree(tx));

    expect(result.invalid.state).toBe('unmeasured');
    expect(result.invalid.reason).toBe('dimension_absent_from_source');
    expect(result.invalid.seam.length).toBeGreaterThan(0);
    // The enforcement is the ABSENCE of a number, not the reason string: there
    // must be nothing on this object a consumer could render as a count.
    expect(Object.keys(result.invalid).sort()).toEqual(['reason', 'seam', 'state']);
  });

  it('reports NO ratio when nothing was examined, and never zero percent', async () => {
    const result = await withFixture((tx) => sweepSubtree(tx, { sampleSize: 0 }));

    expect(result.drawn).toBe(0);
    expect(result.sampled).toBe(0);
    expect(result.empty).toBe(0);
    // `0 / 0` is a MEASURED reading with an empty denominator, not 0% and not
    // 100%. The property is the missing KEY, so `undefined` alone would also
    // pass on a result carrying `emptyRatio: undefined` — which serializes to
    // nothing and reads as a zero on the other side of the wire.
    expect('emptyRatio' in result, 'an empty denominator produced a ratio').toBe(false);
    expect(result.emptyRatio).toBeUndefined();

    // And the population is NOT the denominator: it is still five. A sweep
    // dividing by `population` would report 0% empty for a catalogue it never
    // looked at.
    expect(result.population).toBe(ELIGIBLE.length);
    expect(result.truncated).toBe(true);
  });

  it('draws the same scopes for one seed and different scopes for another', async () => {
    const drawn = await withFixture(async (tx) => {
      const twice = [
        await sweepSubtree(tx, { sampleSize: 2, seed: 'sweep-seed-a' }),
        await sweepSubtree(tx, { sampleSize: 2, seed: 'sweep-seed-a' }),
      ];
      const seeds = ['sweep-seed-a', 'sweep-seed-b', 'sweep-seed-c', 'sweep-seed-d'];
      const across: FacetScopeSweepResult[] = [];
      for (const seed of seeds) across.push(await sweepSubtree(tx, { sampleSize: 2, seed }));
      return { twice, across };
    });

    // Deterministic: an unchanged catalogue and one seed draw the same scopes,
    // so a moved number is a moved catalogue rather than a moved sample.
    expect(signature(drawn.twice[0])).toBe(signature(drawn.twice[1]));
    for (const result of [...drawn.twice, ...drawn.across]) {
      expect(result.drawn).toBe(2);
      expect(result.truncated).toBe(true);
      expect(result.sampled + result.failed).toBe(2);
    }

    // …and seed-dependent, which is what makes it a SAMPLE rather than the
    // oldest corner of the taxonomy: `order by id limit n` is deterministic too
    // and would return one signature for every seed.
    const signatures = new Set(drawn.across.map(signature));
    expect(signatures.size, 'every seed drew the same scopes — is the draw hash-ordered?')
      .toBeGreaterThan(1);
  });

  it('holds its identities on an unscoped sweep of the whole catalogue', async () => {
    const result = await withFixture((tx) =>
      sweepFacetScopes({ db: tx, now: NOW, sampleSize: 2, seed: FACET_SCOPE_SWEEP_DEFAULT_SEED }),
    );

    // The unscoped predicate is a DIFFERENT statement from the subtree one, so
    // it is exercised here. Only identities and bounds are asserted: the
    // whole-catalogue population is a fact about what every parallel file is
    // doing, and an absolute count would be a test of them.
    expect(result.population, 'this file alone contributes five eligible categories')
      .toBeGreaterThanOrEqual(ELIGIBLE.length);
    expect(result.drawn).toBe(2);
    expect(result.drawn).toBeLessThanOrEqual(result.population);
    expect(result.sampled).toBe(result.empty + result.populated);
    expect(result.drawn).toBe(result.sampled + result.failed);
    expect('emptyRatio' in result).toBe(result.sampled > 0);
    expect(result.draw.rootCategoryId).toBeUndefined();
  });

  it('echoes the frame and the draw it actually ran, and clamps an unbounded request', async () => {
    const result = await withFixture((tx) =>
      sweepFacetScopes({
        db: tx,
        rootCategoryId: ROOT,
        now: NOW,
        sampleSize: Number.MAX_SAFE_INTEGER,
        seed: 'sweep-seed-echo',
      }),
    );

    // A number that names neither its locale nor its currency cannot be compared
    // with another one: the currency decides whether the price facet composes at
    // all, which is one of the two facets `stocked` has.
    expect(result.frame).toEqual({
      locale: 'en',
      displayCurrency: FACET_SCOPE_SWEEP_CURRENCY,
      includeDescendants: true,
    });
    expect(result.draw).toEqual({
      seed: 'sweep-seed-echo',
      sampleSize: FACET_SCOPE_SWEEP_MAX_SAMPLE_SIZE,
      rootCategoryId: ROOT,
    });
    expect(result.sweptAt).toBe(NOW.toISOString());
  });
});
