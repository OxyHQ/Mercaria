/**
 * The matching writes, against a REAL PostgreSQL database.
 *
 * The pure tests beside this one cover the RULES. Everything here is a property
 * a mocked repository cannot have, because a mocked `insert` accepts any
 * statement the server would refuse:
 *
 * - **A conflicting identifier can never auto-merge** — the CHECK, not the
 *   service. Asserted by writing the forbidden row directly, so the guarantee
 *   holds against a writer that never went through the pipeline.
 * - **A category gate cannot cite a benchmark of another policy** — a composite
 *   NOT NULL foreign key, which is the whole of acceptance 5's "cannot be
 *   enabled without a recorded qualifying run".
 * - **A published policy and a recorded benchmark are immutable** — triggers.
 * - **`FOR UPDATE SKIP LOCKED` really skips**, and the revision pair really
 *   stops a mid-run request being swallowed.
 * - **#57's seam is closed end to end**: a native listing with a matching
 *   canonical variant becomes a native OFFER, through the real
 *   `native_listing_links` write and the real offer converger.
 *
 * ## Scoping, because this database is SHARED
 *
 * One throwaway Postgres serves the whole suite and vitest runs files in
 * parallel workers, so every row this file writes carries a per-run suffix and
 * teardown deletes exactly what it created. A bare `delete from match_queue`
 * here would silently empty a sibling file's fixtures mid-run.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { uuidv7 } from '@oxyhq/db';
import { closePostgres, connectPostgres, type Database } from '../../../db/postgres.js';
import {
  matchBenchmarkCategories,
  matchBenchmarkRuns,
  matchBlockedPairs,
  matchCategoryGates,
  matchDecisionCandidates,
  matchDecisions,
  matchPolicyVersions,
} from '../../../db/schema/matching.js';
import { categories, listings, productVariants } from '../../../db/schema/catalog.js';
import {
  canonicalProducts,
  canonicalVariants,
  canonicalVariantAttributes,
} from '../../../db/schema/canonicalCatalog.js';
import { brands } from '../../../db/schema/organizations.js';
import { productIdentifiers } from '../../../db/schema/canonicalCatalog.js';
import { nativeListingLinks, offers } from '../../../db/schema/offers.js';
import { insertMatchPolicyVersion } from '../../../db/matching/matchPolicyRepository.js';
import { recordBenchmarkRun } from '../../../db/matching/matchBenchmarkRepository.js';
import {
  claimMatchQueue,
  completeMatchQueue,
  enqueueMatch,
  findMatchQueueRow,
  summarizeMatchQueue,
} from '../../../db/matching/matchQueueRepository.js';
import { blockPair } from '../../../db/matching/matchBlockedPairRepository.js';
import { openCategoryGate } from '../match-policy.service.js';
import { runMatch } from '../match.service.js';
import { convergeNativeOffersForListing } from '../../offers/native-offer.service.js';
import { normalizeEntityName } from '../../canonical/normalization.js';
import { variantSignature } from '../../canonical/variant-signature.js';
import { gs1CheckDigit } from '../../canonical/identifiers.js';

let db: Database;

/** Unique to this run, so parallel files cannot collide on a shared database. */
const RUN = uuidv7().slice(-12);

const createdPolicyIds: string[] = [];
const createdListingIds: string[] = [];
const createdProductIds: string[] = [];
const createdBrandIds: string[] = [];
const createdCategoryIds: string[] = [];

beforeAll(async () => {
  db = await connectPostgres();
}, 120_000);

afterAll(async () => {
  await closePostgres();
});

afterEach(async () => {
  const listingIds = createdListingIds.splice(0);
  const productIds = createdProductIds.splice(0);
  const policyIds = createdPolicyIds.splice(0);
  const brandIds = createdBrandIds.splice(0);

  if (listingIds.length > 0) {
    // `offers`, `native_listing_links`, `match_queue` and `match_decisions` all
    // CASCADE from the native side (ADR 0002 D20), so deleting the listing is
    // the whole teardown for everything the seam produced.
    await db.delete(offers).where(inArray(offers.listingId, listingIds));
    await db.delete(listings).where(inArray(listings.id, listingIds));
  }
  if (productIds.length > 0) {
    const variantIds = (
      await db
        .select({ id: canonicalVariants.id })
        .from(canonicalVariants)
        .where(inArray(canonicalVariants.productId, productIds))
    ).map((row) => row.id);
    if (variantIds.length > 0) {
      await db
        .delete(matchBlockedPairs)
        .where(inArray(matchBlockedPairs.targetCanonicalVariantId, variantIds));
      await db
        .delete(matchDecisionCandidates)
        .where(inArray(matchDecisionCandidates.canonicalVariantId, variantIds));
      await db
        .delete(matchDecisions)
        .where(inArray(matchDecisions.matchedCanonicalVariantId, variantIds));
      await db
        .delete(canonicalVariantAttributes)
        .where(inArray(canonicalVariantAttributes.variantId, variantIds));
      await db.delete(canonicalVariants).where(inArray(canonicalVariants.id, variantIds));
    }
    await db.delete(canonicalProducts).where(inArray(canonicalProducts.id, productIds));
  }
  if (policyIds.length > 0) {
    await db.delete(matchCategoryGates).where(inArray(matchCategoryGates.policyVersionId, policyIds));
    await db.delete(matchDecisions).where(inArray(matchDecisions.policyVersionId, policyIds));
    const runIds = (
      await db
        .select({ id: matchBenchmarkRuns.id })
        .from(matchBenchmarkRuns)
        .where(inArray(matchBenchmarkRuns.policyVersionId, policyIds))
    ).map((row) => row.id);
    if (runIds.length > 0) {
      // The append-only trigger refuses UPDATE and DELETE from ordinary paths;
      // teardown drops the session-level guard so the shared database does not
      // accumulate a run per test run forever.
      await db.execute(sql`alter table match_benchmark_categories disable trigger match_benchmark_categories_append_only`);
      await db.execute(sql`alter table match_benchmark_runs disable trigger match_benchmark_runs_append_only`);
      await db.delete(matchBenchmarkCategories).where(inArray(matchBenchmarkCategories.runId, runIds));
      await db.delete(matchBenchmarkRuns).where(inArray(matchBenchmarkRuns.id, runIds));
      await db.execute(sql`alter table match_benchmark_runs enable trigger match_benchmark_runs_append_only`);
      await db.execute(sql`alter table match_benchmark_categories enable trigger match_benchmark_categories_append_only`);
    }
    await db.execute(sql`alter table match_policy_versions disable trigger match_policy_versions_immutable`);
    await db.delete(matchPolicyVersions).where(inArray(matchPolicyVersions.id, policyIds));
    await db.execute(sql`alter table match_policy_versions enable trigger match_policy_versions_immutable`);
  }
  if (brandIds.length > 0) {
    await db.delete(brands).where(inArray(brands.id, brandIds));
  }
  const categoryIds = createdCategoryIds.splice(0);
  if (categoryIds.length > 0) {
    await db.delete(categories).where(inArray(categories.id, categoryIds));
  }
});

/**
 * The message Postgres actually raised.
 *
 * postgres.js surfaces a driver error whose own `message` is
 * `Failed query: …` — the STATEMENT, not the server's complaint — and the
 * server's text is on `cause`. Asserting on the outer message would pass against
 * any failure at all, including a typo in the fixture, which is precisely the
 * "a check that cannot distinguish success from failure" shape.
 */
async function rejectionMessage(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error: unknown) {
    const parts: string[] = [];
    let current: unknown = error;
    for (let depth = 0; depth < 5 && current instanceof Error; depth += 1) {
      parts.push(current.message);
      current = (current as { cause?: unknown }).cause;
    }
    return parts.join(' | ');
  }
  throw new Error('expected the statement to be refused, and it was accepted');
}

interface PolicyOptions {
  readonly status?: 'draft' | 'active';
}

async function makePolicy(name: string, options: PolicyOptions = {}): Promise<string> {
  const row = await insertMatchPolicyVersion(db, {
    versionKey: `${name}-${RUN}`,
    status: options.status ?? 'draft',
    description: 'realdb fixture',
    autoMinConfidence: 0.9,
    reviewMinConfidence: 0.55,
    minCandidateSeparation: 0.05,
    maxCandidates: 25,
    minTitleSimilarity: 0.2,
    weightIdentifier: 6,
    weightBrand: 3,
    weightModel: 2,
    weightAttribute: 4,
    weightTitle: 1,
    weightCategory: 2,
    weightSemantic: 0,
    semanticEnabled: false,
    minBenchmarkPrecision: 0.98,
    minBenchmarkSamples: 20,
    createdByOxyUserId: `operator-${RUN}`,
    ...(options.status === 'active' ? { activatedAt: new Date() } : {}),
  });
  createdPolicyIds.push(row.id);
  return row.id;
}

/** An EAN-13 whose check digit is COMPUTED, so the validator really accepts it. */
function ean(payload: string): string {
  const payload12 = payload.padStart(12, '0');
  return `${payload12}${String(gs1CheckDigit(payload12))}`;
}

/**
 * A canonical product with one category, one axis, one variant — and, when
 * asked, a real active GTIN on that variant.
 *
 * The GTIN is what lets a seam test take the DETERMINISTIC path (stage 2),
 * which no category gate governs; the category is what lets the other seam test
 * take the heuristic path and be governed by one.
 */
async function makeCanonicalProduct(
  name: string,
  options: { readonly gtinPayload?: string } = {},
): Promise<{
  productId: string;
  variantId: string;
  brandId: string;
  categoryId: string;
  categorySlug: string;
}> {
  const [brand] = await db
    .insert(brands)
    .values({
      slug: `brand-${name}-${RUN}`,
      name: 'Fixture Brand',
      normalizedName: normalizeEntityName('Fixture Brand'),
      status: 'active',
    })
    .returning();
  if (!brand) throw new Error('brand insert returned no row');
  createdBrandIds.push(brand.id);

  const categorySlug = `cat-${name}-${RUN}`;
  const [category] = await db
    .insert(categories)
    .values({ name: `Fixture ${name}`, slug: categorySlug })
    .returning();
  if (!category) throw new Error('category insert returned no row');
  createdCategoryIds.push(category.id);

  const [product] = await db
    .insert(canonicalProducts)
    .values({
      slug: `prd-${name}-${RUN}`,
      name: `Fixture Widget ${name}`,
      normalizedName: normalizeEntityName(`Fixture Widget ${name}`),
      brandId: brand.id,
      categoryId: category.id,
      status: 'active',
      variantDefiningAttributeKeys: ['color'],
      searchTokens: ['fixture', 'widget', name],
    })
    .returning();
  if (!product) throw new Error('product insert returned no row');
  createdProductIds.push(product.id);

  const signature = variantSignature([{ key: 'color', normalizedValue: 'negro' }]);
  const [variant] = await db
    .insert(canonicalVariants)
    .values({
      productId: product.id,
      name: 'Negro',
      signature,
      status: 'active',
    })
    .returning();
  if (!variant) throw new Error('variant insert returned no row');
  await db.insert(canonicalVariantAttributes).values({
    variantId: variant.id,
    attributeKey: 'color',
    displayValue: 'Negro',
    normalizedValue: 'negro',
  });

  if (options.gtinPayload !== undefined) {
    const value = ean(options.gtinPayload);
    await db.insert(productIdentifiers).values({
      variantId: variant.id,
      scheme: 'ean',
      rawValue: value,
      normalizedValue: value,
      canonicalScheme: 'gtin',
      canonicalValue: value.padStart(14, '0'),
      status: 'active',
    });
  }

  return {
    productId: product.id,
    variantId: variant.id,
    brandId: brand.id,
    categoryId: category.id,
    categorySlug,
  };
}

/** A native listing with one variant, matching the canonical fixture above. */
async function makeNativeListing(
  name: string,
  options: { readonly categoryId?: string; readonly barcode?: string } = {},
): Promise<{
  listingId: string;
  variantId: string;
}> {
  const [listing] = await db
    .insert(listings)
    .values({
      ownerType: 'user',
      oxyUserId: `seller-${RUN}`,
      title: `Fixture Widget ${name}`,
      description: 'realdb fixture listing',
      vendor: 'Fixture Brand',
      condition: 'new',
      status: 'active',
      ...(options.categoryId === undefined ? {} : { categoryId: options.categoryId }),
    })
    .returning();
  if (!listing) throw new Error('listing insert returned no row');
  createdListingIds.push(listing.id);

  const [variant] = await db
    .insert(productVariants)
    .values({
      listingId: listing.id,
      title: 'Negro',
      priceAmount: 1_000,
      priceCurrency: 'EUR',
      inventoryTracked: true,
      inventoryAvailable: 5,
      ...(options.barcode === undefined ? {} : { barcode: options.barcode }),
    })
    .returning();
  if (!variant) throw new Error('product variant insert returned no row');
  await db.execute(
    sql`insert into product_variant_option_values (id, variant_id, name, value, position)
        values (${uuidv7()}, ${variant.id}, 'color', 'Negro', 0)`,
  );

  return { listingId: listing.id, variantId: variant.id };
}

describe('the CHECKs a service bug cannot walk around', () => {
  /**
   * A row that is VALID in every respect except the one under test.
   *
   * This is the whole reason these tests are worth having. The first draft
   * passed with `matched_canonical_product_id` NULL — which
   * `match_decisions_outcome_shape_check` refuses on its own, so removing the
   * blocker CHECK from the migration left the suite green. A test that cannot
   * tell which constraint refused a row is a test that measures nothing, so
   * every case below mutates exactly ONE field away from a row the database
   * would otherwise accept.
   */
  async function validDecision(
    policyId: string,
    ids: { productId: string; variantId: string },
    suffix: string,
  ) {
    return {
      subjectKind: 'source_record' as const,
      subjectKey: `source_object:s:${RUN}:${suffix}`,
      sourceRecordId: null,
      productVariantId: null,
      policyVersionId: policyId,
      outcome: 'manual_review' as const,
      decidedStage: 'candidate_retrieval' as const,
      confidence: 0.99,
      matchedCanonicalProductId: ids.productId,
      matchedCanonicalVariantId: ids.variantId,
      reasonCodes: ['title_candidate_retrieved'],
      blockers: [] as string[],
      conflictingIdentifiers: [] as string[],
      normalizedTitle: 'x',
      lastEvaluatedAt: new Date(),
    };
  }

  it('accepts the BASELINE row every case below mutates one field of', async () => {
    // Without this, a case that "passes" proves only that SOMETHING refused a
    // row — possibly the fixture itself, in which case removing the constraint
    // under test would leave the suite green. Measured: the first draft of this
    // file did exactly that.
    const policyId = await makePolicy('baseline');
    const canonical = await makeCanonicalProduct('baseline');
    const native = await makeNativeListing('baseline');
    const inserted = await db
      .insert(matchDecisions)
      .values({
        ...(await validDecision(policyId, canonical, 'baseline')),
        subjectKind: 'native_variant',
        subjectKey: `native_variant:${native.variantId}`,
        productVariantId: native.variantId,
      })
      .returning();
    expect(inserted).toHaveLength(1);
  });

  it('refuses an automatic_match that carries ANY blocker', async () => {
    const policyId = await makePolicy('blocked-auto');
    const canonical = await makeCanonicalProduct('blocked-auto');
    const native = await makeNativeListing('blocked-auto');
    const base = await validDecision(policyId, canonical, 'auto');

    // The row is otherwise perfectly valid: a real subject, a real matched
    // product and variant, an explanation that names its blocker. ONLY the
    // outcome/blocker combination is forbidden, so only
    // `match_decisions_blockers_auto_check` can refuse it.
    expect(
      await rejectionMessage(() =>
        db.insert(matchDecisions).values({
          ...base,
          subjectKind: 'native_variant',
          subjectKey: `native_variant:${native.variantId}`,
          productVariantId: native.variantId,
          outcome: 'automatic_match',
          reasonCodes: ['title_candidate_retrieved', 'brand_mismatch'],
          blockers: ['brand_mismatch'],
        }),
      ),
    ).toMatch(/match_decisions_blockers_auto_check/u);
  });

  it('refuses a recorded conflicting identifier with NO matching blocker', async () => {
    const policyId = await makePolicy('unexplained-conflict');
    const canonical = await makeCanonicalProduct('unexplained-conflict');
    const native = await makeNativeListing('unexplained-conflict');
    const base = await validDecision(policyId, canonical, 'conflict');
    expect(
      await rejectionMessage(() =>
        db.insert(matchDecisions).values({
          ...base,
          subjectKind: 'native_variant',
          subjectKey: `native_variant:${native.variantId}`,
          productVariantId: native.variantId,
          // The audit array says something conflicts and the blocker list does
          // not, which is a row whose explanation contradicts its outcome.
          conflictingIdentifiers: ['gtin:00000000000000'],
        }),
      ),
    ).toMatch(/match_decisions_conflicting_identifier_check/u);
  });

  it('refuses a blocker that is not also in the explanation', async () => {
    const policyId = await makePolicy('unexplained-blocker');
    const canonical = await makeCanonicalProduct('unexplained-blocker');
    const native = await makeNativeListing('unexplained-blocker');
    const base = await validDecision(policyId, canonical, 'blocker');
    expect(
      await rejectionMessage(() =>
        db.insert(matchDecisions).values({
          ...base,
          subjectKind: 'native_variant',
          subjectKey: `native_variant:${native.variantId}`,
          productVariantId: native.variantId,
          reasonCodes: ['brand_agreed'],
          blockers: ['brand_mismatch'],
        }),
      ),
    ).toMatch(/match_decisions_blockers_explained_check/u);
  });

  it('refuses a variant match with no resolved product (rule 1, in the row)', async () => {
    const policyId = await makePolicy('grain-order');
    const canonical = await makeCanonicalProduct('grain');
    const native = await makeNativeListing('grain');
    const base = await validDecision(policyId, canonical, 'grain');
    expect(
      await rejectionMessage(() =>
        db.insert(matchDecisions).values({
          ...base,
          subjectKind: 'native_variant',
          subjectKey: `native_variant:${native.variantId}`,
          productVariantId: native.variantId,
          matchedCanonicalProductId: null,
        }),
      ),
    ).toMatch(/match_decisions_grain_order_check/u);
  });

  it('refuses a subject that names neither a variant nor a source record', async () => {
    const policyId = await makePolicy('subject-shape');
    const canonical = await makeCanonicalProduct('subject-shape');
    const base = await validDecision(policyId, canonical, 'shape');
    expect(
      await rejectionMessage(() =>
        // Both subject columns NULL, and everything else valid.
        db.insert(matchDecisions).values({ ...base }),
      ),
    ).toMatch(/match_decisions_subject_shape_check/u);
  });

  it('refuses a NUMBER on a deterministic stage', async () => {
    const policyId = await makePolicy('confidence-stage');
    const canonical = await makeCanonicalProduct('confidence-stage');
    const native = await makeNativeListing('confidence');
    const base = await validDecision(policyId, canonical, 'confidence');
    expect(
      await rejectionMessage(() =>
        db.insert(matchDecisions).values({
          ...base,
          subjectKind: 'native_variant',
          subjectKey: `native_variant:${native.variantId}`,
          productVariantId: native.variantId,
          decidedStage: 'global_identifier',
        }),
      ),
    ).toMatch(/match_decisions_confidence_stage_check/u);
  });
});

describe('acceptance 5: a category gate cannot be opened without a qualifying measurement', () => {
  async function makeBenchmark(
    policyId: string,
    input: { categoryKey: string; truePositives: number; falsePositives: number },
  ): Promise<string> {
    const total = input.truePositives + input.falsePositives;
    const run = await recordBenchmarkRun(db, {
      policyVersionId: policyId,
      datasetVersion: 'realdb-fixture',
      datasetChecksum: 'a'.repeat(64),
      totalCases: total,
      startedAt: new Date(),
      completedAt: new Date(),
      startedByOxyUserId: null,
      note: null,
      slices: [
        {
          categoryKey: input.categoryKey,
          sourceKey: '*',
          totalCases: total,
          truePositives: input.truePositives,
          falsePositives: input.falsePositives,
          falseNegatives: 0,
          trueNegatives: 0,
          automaticMatches: total,
          manualReviews: 0,
          createNews: 0,
        },
      ],
    });
    const [slice] = await db
      .select({ id: matchBenchmarkCategories.id })
      .from(matchBenchmarkCategories)
      .where(eq(matchBenchmarkCategories.runId, run.id));
    if (!slice) throw new Error('no benchmark slice was written');
    return slice.id;
  }

  it('opens the gate when the cited slice clears the bar on enough samples', async () => {
    const policyId = await makePolicy('gate-ok');
    const sliceId = await makeBenchmark(policyId, {
      categoryKey: `cat-ok-${RUN}`,
      truePositives: 50,
      falsePositives: 0,
    });
    const gate = await openCategoryGate({
      policyVersionId: policyId,
      categoryKey: `cat-ok-${RUN}`,
      benchmarkCategoryId: sliceId,
      enabledByOxyUserId: `operator-${RUN}`,
      reason: 'benchmark cleared',
    });
    expect(gate.observedPrecision).toBe(1);
    expect(gate.observedSamples).toBe(50);
  });

  it('refuses a slice BELOW the policy precision, naming the number it saw', async () => {
    const policyId = await makePolicy('gate-low-precision');
    const sliceId = await makeBenchmark(policyId, {
      categoryKey: `cat-low-${RUN}`,
      truePositives: 90,
      falsePositives: 10,
    });
    expect(
      await rejectionMessage(() =>
        openCategoryGate({
          policyVersionId: policyId,
          categoryKey: `cat-low-${RUN}`,
          benchmarkCategoryId: sliceId,
          enabledByOxyUserId: `operator-${RUN}`,
          reason: 'trying it on',
        }),
      ),
    ).toMatch(/0\.9000/u);
  });

  it('refuses a slice measured on TOO FEW samples, however perfect it looks', async () => {
    const policyId = await makePolicy('gate-small-sample');
    const sliceId = await makeBenchmark(policyId, {
      categoryKey: `cat-small-${RUN}`,
      truePositives: 2,
      falsePositives: 0,
    });
    // Precision 1.0 on two cases is not a measurement, and a gate that accepted
    // it would make the benchmark theatre.
    expect(
      await rejectionMessage(() =>
        openCategoryGate({
          policyVersionId: policyId,
          categoryKey: `cat-small-${RUN}`,
          benchmarkCategoryId: sliceId,
          enabledByOxyUserId: `operator-${RUN}`,
          reason: 'trying it on',
        }),
      ),
    ).toMatch(/at least 20/u);
  });

  it('the DATABASE refuses a gate citing a benchmark of a different policy', async () => {
    const measuredPolicyId = await makePolicy('gate-cross-a');
    const otherPolicyId = await makePolicy('gate-cross-b');
    const sliceId = await makeBenchmark(measuredPolicyId, {
      categoryKey: `cat-cross-${RUN}`,
      truePositives: 50,
      falsePositives: 0,
    });
    // Straight at the table, bypassing the service entirely: the composite NOT
    // NULL foreign key is what makes acceptance 5 structural rather than a
    // comparison somebody has to remember.
    await expect(
      db.insert(matchCategoryGates).values({
        policyVersionId: otherPolicyId,
        categoryKey: `cat-cross-${RUN}`,
        benchmarkCategoryId: sliceId,
        observedPrecision: 1,
        observedSamples: 50,
        enabledByOxyUserId: `operator-${RUN}`,
        enabledAt: new Date(),
        reason: 'forged',
      }),
    ).rejects.toThrow();
  });

  it('refuses a benchmark slice whose counts do not partition its total', async () => {
    const policyId = await makePolicy('benchmark-partition');
    await expect(
      recordBenchmarkRun(db, {
        policyVersionId: policyId,
        datasetVersion: 'realdb-fixture',
        datasetChecksum: 'b'.repeat(64),
        totalCases: 10,
        startedAt: new Date(),
        completedAt: new Date(),
        startedByOxyUserId: null,
        note: null,
        slices: [
          {
            categoryKey: `cat-part-${RUN}`,
            sourceKey: '*',
            totalCases: 10,
            truePositives: 5,
            falsePositives: 0,
            falseNegatives: 0,
            trueNegatives: 0, // 5 ≠ 10: five cases went missing.
            automaticMatches: 10,
            manualReviews: 0,
            createNews: 0,
          },
        ],
      }),
    ).rejects.toThrow();
  });

  it('DERIVES every rate, and refuses one supplied by a caller', async () => {
    const policyId = await makePolicy('benchmark-derived');
    const sliceId = await makeBenchmark(policyId, {
      categoryKey: `cat-derived-${RUN}`,
      truePositives: 3,
      falsePositives: 1,
    });
    const [slice] = await db
      .select()
      .from(matchBenchmarkCategories)
      .where(eq(matchBenchmarkCategories.id, sliceId));
    expect(slice?.precision).toBeCloseTo(0.75, 6);

    // A GENERATED column refuses a supplied value outright (SQLSTATE 428C9), so
    // a precision nobody measured is not a value these tables can hold.
    await expect(
      db.execute(
        sql`update match_benchmark_categories set precision = 1 where id = ${sliceId}`,
      ),
    ).rejects.toThrow();
  });
});

describe('the triggers: a published policy and a recorded measurement are frozen', () => {
  it('refuses to edit an ACTIVE policy version, and permits superseding it', async () => {
    const policyId = await makePolicy('immutable', { status: 'active' });
    expect(
      await rejectionMessage(() =>
        db
          .update(matchPolicyVersions)
          .set({ autoMinConfidence: 0.5 })
          .where(eq(matchPolicyVersions.id, policyId)),
      ),
    ).toMatch(/immutable/u);

    const superseded = await db
      .update(matchPolicyVersions)
      .set({ status: 'superseded', supersededAt: new Date() })
      .where(eq(matchPolicyVersions.id, policyId))
      .returning();
    expect(superseded).toHaveLength(1);
  });

  it('refuses to DELETE a policy version at all', async () => {
    const policyId = await makePolicy('undeletable', { status: 'active' });
    expect(
      await rejectionMessage(() =>
        db.delete(matchPolicyVersions).where(eq(matchPolicyVersions.id, policyId)),
      ),
    ).toMatch(/cannot be deleted/u);
  });

  it('refuses to edit or delete a recorded benchmark run', async () => {
    const policyId = await makePolicy('benchmark-frozen');
    const run = await recordBenchmarkRun(db, {
      policyVersionId: policyId,
      datasetVersion: 'realdb-fixture',
      datasetChecksum: 'c'.repeat(64),
      totalCases: 0,
      startedAt: new Date(),
      completedAt: new Date(),
      startedByOxyUserId: null,
      note: null,
      slices: [],
    });
    expect(
      await rejectionMessage(() =>
        db
          .update(matchBenchmarkRuns)
          .set({ datasetVersion: 'rewritten' })
          .where(eq(matchBenchmarkRuns.id, run.id)),
      ),
    ).toMatch(/append-only/u);
    expect(
      await rejectionMessage(() =>
        db.delete(matchBenchmarkRuns).where(eq(matchBenchmarkRuns.id, run.id)),
      ),
    ).toMatch(/append-only/u);
  });

  it('the triggers EXIST in the catalogue — the vacuity guard', async () => {
    const rows = await db.execute<{ tgname: string }>(
      sql`select tgname from pg_trigger
          where not tgisinternal
            and tgname in (
              'match_policy_versions_immutable',
              'match_benchmark_runs_append_only',
              'match_benchmark_categories_append_only'
            )
          order by tgname`,
    );
    expect(rows.map((row) => row.tgname)).toEqual([
      'match_benchmark_categories_append_only',
      'match_benchmark_runs_append_only',
      'match_policy_versions_immutable',
    ]);
  });
});

describe('the queue: leases, revisions and coalescing', () => {
  it('coalesces repeats into ONE row and bumps the requested revision', async () => {
    const { variantId } = await makeNativeListing('coalesce');
    const subjectKey = `native_variant:${variantId}`;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await enqueueMatch({
        subjectKind: 'native_variant',
        subjectKey,
        sourceRecordId: null,
        productVariantId: variantId,
        trigger: 'catalog_write',
      });
    }
    const row = await findMatchQueueRow(db, subjectKey);
    expect(row?.requestedRevision).toBe(3);
    expect(row?.status).toBe('pending');
  });

  it('an enqueue during a run leaves the row PENDING after completion', async () => {
    const { variantId } = await makeNativeListing('revision');
    const subjectKey = `native_variant:${variantId}`;
    await enqueueMatch({
      subjectKind: 'native_variant',
      subjectKey,
      sourceRecordId: null,
      productVariantId: variantId,
      trigger: 'catalog_write',
    });

    const claimed = await claimMatchQueue({ leaseOwner: `owner-${RUN}`, batchSize: 50 });
    const mine = claimed.find((job) => job.subjectKey === subjectKey);
    expect(mine).toBeDefined();
    if (!mine) throw new Error('unreachable');

    // A request lands MID-RUN. Without the revision pair the completion below
    // would mark it `done` and the request would be lost.
    await enqueueMatch({
      subjectKind: 'native_variant',
      subjectKey,
      sourceRecordId: null,
      productVariantId: variantId,
      trigger: 'operator',
    });
    // …and it must NOT have released the live lease.
    const midRun = await findMatchQueueRow(db, subjectKey);
    expect(midRun?.status).toBe('processing');
    expect(midRun?.leaseOwner).toBe(`owner-${RUN}`);

    expect(await completeMatchQueue(mine.id, `owner-${RUN}`)).toBe(true);
    const after = await findMatchQueueRow(db, subjectKey);
    expect(after?.status).toBe('pending');
  });

  it('SKIP LOCKED really skips: two concurrent claims take different rows', async () => {
    const first = await makeNativeListing('skip-a');
    const second = await makeNativeListing('skip-b');
    for (const variantId of [first.variantId, second.variantId]) {
      await enqueueMatch({
        subjectKind: 'native_variant',
        subjectKey: `native_variant:${variantId}`,
        sourceRecordId: null,
        productVariantId: variantId,
        trigger: 'catalog_write',
      });
    }

    const [left, right] = await Promise.all([
      claimMatchQueue({ leaseOwner: `left-${RUN}`, batchSize: 1 }),
      claimMatchQueue({ leaseOwner: `right-${RUN}`, batchSize: 1 }),
    ]);
    const claimedIds = [...left, ...right].map((job) => job.id);
    // Neither blocked on the other, and neither took the same row.
    expect(new Set(claimedIds).size).toBe(claimedIds.length);
  });

  it('refuses a completion from a task that does not hold the lease', async () => {
    const { variantId } = await makeNativeListing('owner-check');
    const subjectKey = `native_variant:${variantId}`;
    await enqueueMatch({
      subjectKind: 'native_variant',
      subjectKey,
      sourceRecordId: null,
      productVariantId: variantId,
      trigger: 'catalog_write',
    });
    const claimed = await claimMatchQueue({ leaseOwner: `holder-${RUN}`, batchSize: 50 });
    const mine = claimed.find((job) => job.subjectKey === subjectKey);
    if (!mine) throw new Error('claim did not include the fixture row');
    expect(await completeMatchQueue(mine.id, `impostor-${RUN}`)).toBe(false);
    expect(await completeMatchQueue(mine.id, `holder-${RUN}`)).toBe(true);
  });

  it('reports queue AGE, which is what distinguishes a sweep from a stopped worker', async () => {
    const { variantId } = await makeNativeListing('age');
    await enqueueMatch({
      subjectKind: 'native_variant',
      subjectKey: `native_variant:${variantId}`,
      sourceRecordId: null,
      productVariantId: variantId,
      trigger: 'bulk_sweep',
    });
    const summary = await summarizeMatchQueue(db);
    expect(summary.pending).toBeGreaterThanOrEqual(1);
    expect(summary.oldestPendingAgeSeconds).not.toBeNull();
    expect(summary.oldestPendingAgeSeconds ?? -1).toBeGreaterThanOrEqual(0);
  });
});

describe('the negative link', () => {
  it('refuses a SECOND open block on the same pair, and keeps the first reason', async () => {
    const policyId = await makePolicy('block');
    const { variantId } = await makeCanonicalProduct('block');
    const subjectKey = `source_object:s:${RUN}:block`;

    const first = await blockPair(db, {
      subjectKey,
      subjectKind: 'source_record',
      targetCanonicalProductId: null,
      targetCanonicalVariantId: variantId,
      decisionId: null,
      blockedUnderPolicyVersionId: policyId,
      blockedByOxyUserId: `operator-${RUN}`,
      reason: 'the first reason',
    });
    expect(first).toBeDefined();

    const second = await blockPair(db, {
      subjectKey,
      subjectKind: 'source_record',
      targetCanonicalProductId: null,
      targetCanonicalVariantId: variantId,
      decisionId: null,
      blockedUnderPolicyVersionId: policyId,
      blockedByOxyUserId: `other-${RUN}`,
      reason: 'a second reason',
    });
    // The partial unique absorbed it: a genuine no-op, not a second row.
    expect(second).toBeUndefined();

    const rows = await db
      .select()
      .from(matchBlockedPairs)
      .where(eq(matchBlockedPairs.subjectKey, subjectKey));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.reason).toBe('the first reason');
  });

  it('refuses an unattributable or unreasoned clearing', async () => {
    const policyId = await makePolicy('block-clear');
    const { variantId } = await makeCanonicalProduct('block-clear');
    const subjectKey = `source_object:s:${RUN}:clear`;
    const row = await blockPair(db, {
      subjectKey,
      subjectKind: 'source_record',
      targetCanonicalProductId: null,
      targetCanonicalVariantId: variantId,
      decisionId: null,
      blockedUnderPolicyVersionId: policyId,
      blockedByOxyUserId: `operator-${RUN}`,
      reason: 'wrong product',
    });
    if (!row) throw new Error('block was not created');
    await expect(
      db
        .update(matchBlockedPairs)
        .set({ clearedAt: new Date() })
        .where(eq(matchBlockedPairs.id, row.id)),
    ).rejects.toThrow();
  });
});

describe("#57's seam, closed: a native listing becomes a native OFFER", () => {
  it('matches on a BARCODE, writes the attachment, and materializes the offer', async () => {
    await makePolicy('seam', { status: 'active' });
    const canonical = await makeCanonicalProduct('seam', { gtinPayload: '700000000101' });
    const native = await makeNativeListing('seam', {
      categoryId: canonical.categoryId,
      barcode: ean('700000000101'),
    });

    // Before matching, the converger has nothing to project: a variant with no
    // canonical attachment materializes NOTHING, which is #57's own rule and
    // exactly the seam this issue closes.
    await convergeNativeOffersForListing(native.listingId);
    const before = await db
      .select()
      .from(offers)
      .where(eq(offers.listingId, native.listingId));
    expect(before, 'an unmatched variant must have no offer').toHaveLength(0);

    const result = await runMatch({
      kind: 'native_variant',
      productVariantId: native.variantId,
    });
    expect(result.skipped).toBeNull();
    expect(result.decision?.outcome).toBe('automatic_match');
    expect(result.decision?.decidedStage).toBe('global_identifier');
    expect(result.decision?.matchedCanonicalVariantId).toBe(canonical.variantId);
    expect(result.attached).toBe(true);

    const links = await db
      .select()
      .from(nativeListingLinks)
      .where(
        and(
          eq(nativeListingLinks.productVariantId, native.variantId),
          eq(nativeListingLinks.status, 'active'),
        ),
      );
    expect(links).toHaveLength(1);
    expect(links[0]?.canonicalVariantId).toBe(canonical.variantId);
    // A deterministic attachment records `barcode_gtin` with NULL confidence —
    // `native_listing_links_confidence_check` restricts a number to `matcher`
    // rows, and a number here could only read as doubt about a check digit.
    expect(links[0]?.method).toBe('barcode_gtin');
    expect(links[0]?.confidence).toBeNull();
    expect(links[0]?.matchRule).toMatch(/^global_identifier:seam-/u);

    // The matcher enqueued the convergence in its own transaction; running it
    // now is what the dispatcher does.
    await convergeNativeOffersForListing(native.listingId);
    const after = await db
      .select()
      .from(offers)
      .where(eq(offers.listingId, native.listingId));
    expect(after, 'the matched variant must now have a native offer').toHaveLength(1);
    expect(after[0]?.canonicalVariantId).toBe(canonical.variantId);
    expect(after[0]?.kind).toBe('native');
    expect(after[0]?.status).toBe('active');
  });

  it('a HEURISTIC match waits for the category gate, and attaches once it opens', async () => {
    const policyId = await makePolicy('gated-seam', { status: 'active' });
    const canonical = await makeCanonicalProduct('gated');
    const native = await makeNativeListing('gated', { categoryId: canonical.categoryId });

    // No barcode, so the pipeline reaches a stage a category gate governs — and
    // no gate has been opened for this category, which is the state every
    // category starts in.
    const blocked = await runMatch({
      kind: 'native_variant',
      productVariantId: native.variantId,
    });
    expect(blocked.decision?.outcome).toBe('manual_review');
    expect(blocked.decision?.blockers).toContain('category_gate_closed');
    expect(blocked.attached).toBe(false);
    expect(
      await db
        .select()
        .from(nativeListingLinks)
        .where(eq(nativeListingLinks.productVariantId, native.variantId)),
    ).toHaveLength(0);

    // Record a qualifying benchmark and open the gate — acceptance 5, end to end.
    const run = await recordBenchmarkRun(db, {
      policyVersionId: policyId,
      datasetVersion: 'realdb-fixture',
      datasetChecksum: 'd'.repeat(64),
      totalCases: 40,
      startedAt: new Date(),
      completedAt: new Date(),
      startedByOxyUserId: null,
      note: null,
      slices: [
        {
          categoryKey: canonical.categorySlug,
          sourceKey: '*',
          totalCases: 40,
          truePositives: 40,
          falsePositives: 0,
          falseNegatives: 0,
          trueNegatives: 0,
          automaticMatches: 40,
          manualReviews: 0,
          createNews: 0,
        },
      ],
    });
    const [slice] = await db
      .select({ id: matchBenchmarkCategories.id })
      .from(matchBenchmarkCategories)
      .where(eq(matchBenchmarkCategories.runId, run.id));
    if (!slice) throw new Error('no benchmark slice was written');
    await openCategoryGate({
      policyVersionId: policyId,
      categoryKey: canonical.categorySlug,
      benchmarkCategoryId: slice.id,
      enabledByOxyUserId: `operator-${RUN}`,
      reason: 'benchmark cleared',
    });

    const allowed = await runMatch({
      kind: 'native_variant',
      productVariantId: native.variantId,
    });
    expect(allowed.decision?.outcome).toBe('automatic_match');
    expect(allowed.attached).toBe(true);

    const links = await db
      .select()
      .from(nativeListingLinks)
      .where(eq(nativeListingLinks.productVariantId, native.variantId));
    expect(links).toHaveLength(1);
    // A heuristic attachment records `matcher` WITH a confidence, which is the
    // other side of the same CHECK — and what #59 reviews.
    expect(links[0]?.method).toBe('matcher');
    expect(links[0]?.confidence).not.toBeNull();

    // One decision row per (subject, policy): the re-evaluation converged on
    // the row the blocked run created rather than adding a second.
    const decisions = await db
      .select()
      .from(matchDecisions)
      .where(eq(matchDecisions.productVariantId, native.variantId));
    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.evaluationCount).toBe(2);
    // The operator's earlier review is not re-opened by a later automatic run…
    expect(decisions[0]?.reviewState).toBe('not_required');
  });

  it('re-running the matcher is a genuine no-op — no second link, no superseded row', async () => {
    await makePolicy('idempotent', { status: 'active' });
    const canonical = await makeCanonicalProduct('idempotent', { gtinPayload: '700000000202' });
    const native = await makeNativeListing('idempotent', {
      categoryId: canonical.categoryId,
      barcode: ean('700000000202'),
    });

    const first = await runMatch({
      kind: 'native_variant',
      productVariantId: native.variantId,
    });
    expect(first.attached).toBe(true);

    const second = await runMatch({
      kind: 'native_variant',
      productVariantId: native.variantId,
    });
    // The second run reuses the EXISTING attachment (stage 1) and writes no new
    // link row: a re-evaluation must not manufacture history for a change that
    // did not happen (ADR 0002 D22).
    expect(second.attached).toBe(false);
    expect(second.evaluation?.decidedStage).toBe('existing_source_link');

    const links = await db
      .select()
      .from(nativeListingLinks)
      .where(eq(nativeListingLinks.productVariantId, native.variantId));
    expect(links).toHaveLength(1);
    expect(links[0]?.status).toBe('active');

    const decisions = await db
      .select()
      .from(matchDecisions)
      .where(eq(matchDecisions.productVariantId, native.variantId));
    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.evaluationCount).toBe(2);
  });

  it('records every candidate it considered, with UNKNOWN features stored as NULL', async () => {
    await makePolicy('candidates', { status: 'active' });
    const canonical = await makeCanonicalProduct('candidates', { gtinPayload: '700000000303' });
    const native = await makeNativeListing('candidates', {
      categoryId: canonical.categoryId,
      barcode: ean('700000000303'),
    });

    const result = await runMatch({
      kind: 'native_variant',
      productVariantId: native.variantId,
    });
    const decisionId = result.decision?.id;
    expect(decisionId).toBeDefined();
    if (decisionId === undefined) throw new Error('unreachable');

    const candidates = await db
      .select()
      .from(matchDecisionCandidates)
      .where(eq(matchDecisionCandidates.decisionId, decisionId));
    expect(candidates.length).toBeGreaterThanOrEqual(1);
    const selected = candidates.filter((row) => row.selected);
    expect(selected).toHaveLength(1);
    expect(selected[0]?.identifierAgreement).toBe(1);
    expect(selected[0]?.brandAgreement).toBe(1);
    // The subject declares no MODEL, so the feature is UNKNOWN and stored as
    // NULL — never as a zero, which an operator would read as a disagreement.
    expect(selected[0]?.modelAgreement).toBeNull();
  });
});
