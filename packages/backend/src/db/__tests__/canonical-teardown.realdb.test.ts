/**
 * A sibling's match decision pins a canonical id, and the teardown declines it —
 * against a REAL Postgres, deterministically.
 *
 * ## What it reproduces, and why it is not a race
 *
 * `canonical-catalog.realdb.test.ts` failed once in four full baseline runs on
 * `85d6697` with `23503` on
 * `match_decisions_matched_canonical_variant_id_canonical_variants`: the matcher's
 * candidate retrieval is a trigram search over every canonical product (correctly
 * global for production), so a sibling driving `runMatch` recorded a decision
 * citing that file's fixture, and the fixture's own correctly-scoped delete could
 * not proceed. The intermittency is in WHICH sibling matches WHAT and WHEN; the
 * mechanism is not timing-dependent at all, so this file constructs the cited row
 * directly and the red is reliable.
 *
 * ## It constructs the row through the matcher's OWN writer
 *
 * `upsertMatchDecision` is the function `match.service` calls, so the row's shape,
 * its CHECKs and both foreign keys are the real ones. What is NOT re-run is
 * retrieval — the trigram search that decides WHICH product a sibling matches.
 * Re-running it would need the global active-matching-policy slot
 * (`match_policy_versions_active_key` admits one active policy per DATABASE), so
 * this file would have to queue behind every matcher file to assert something
 * about a foreign key. The policy version here is therefore `draft`: the FK needs
 * a ROW, not an active one, so nothing contends and nothing another file relies on
 * is touched.
 *
 * That division is worth stating plainly. This gate proves the TEARDOWN's
 * behaviour in the presence of a citing row. It does not prove a sibling will
 * produce one — the baseline red did that, and `postgres-candidate-source.ts`'s
 * unscoped retrieval is why it can happen again.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { constraintNameOf, uuidv7 } from '@oxyhq/db';
import { closePostgres, connectPostgres, type Database } from '../postgres.js';
import { canonicalProducts, canonicalVariants } from '../schema/canonicalCatalog.js';
import { listings } from '../schema/catalog.js';
import { matchDecisions } from '../schema/matching.js';
import { normalizeEntityName } from '../../services/canonical/normalization.js';
import { deleteTestCanonicalRows, planCanonicalTeardown } from './canonical-teardown.js';

/** Unique per run, so parallel files and repeated runs never collide on an id. */
const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;

let db: Database;
/** Every id this file created, deleted in dependency order at the end. */
const createdProductIds: string[] = [];
let policyVersionId: string | null = null;
const createdDecisionIds: string[] = [];
/** A real native variant, because the decision's subject shape demands one. */
const createdListingIds: string[] = [];
const nativeVariantIds: string[] = [];

beforeAll(async () => {
  db = await connectPostgres();

  // A DRAFT policy version: the decision's foreign key needs a row to point at,
  // and `match_policy_versions_active_key` is a partial unique over `active`
  // only — so a draft contends with nobody. See the header.
  const { insertMatchPolicyVersion } = await import('../matching/matchPolicyRepository.js');
  const policy = await insertMatchPolicyVersion(db, {
    versionKey: `teardown-gate-${RUN}`,
    status: 'draft',
    description: 'realdb fixture for the canonical teardown gate',
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
  });
  policyVersionId = policy.id;

  // `match_decisions_subject_shape_check` admits exactly two subject shapes and
  // both need a real foreign key. A NATIVE VARIANT is the cheaper of the two — a
  // source record would need a catalog source and an observation as well — so one
  // listing with three variants backs the three decisions below.
  const [listing] = await db
    .insert(listings)
    .values({
      ownerType: 'user',
      oxyUserId: `teardown-gate-seller-${RUN}`,
      title: `Teardown gate listing ${RUN}`,
      description: '',
      condition: 'new',
      conditionAssertion: 'seller_declared',
    })
    .returning({ id: listings.id });
  if (!listing) throw new Error('the fixture listing was not created');
  createdListingIds.push(listing.id);

  const { insertVariants } = await import('../catalog/variantRepository.js');
  const variants = await insertVariants(
    listing.id,
    [0, 1, 2, 3, 4].map((index) => ({
      title: `Subject ${String(index)}`,
      priceAmount: 1_000,
      priceCurrency: 'EUR' as const,
      inventoryTracked: false,
      inventoryAvailable: 0,
      position: index,
      optionValues: [],
    })),
  );
  for (const variant of variants) nativeVariantIds.push(variant.id);
}, 120_000);

afterAll(async () => {
  if (createdDecisionIds.length > 0) {
    await db.delete(matchDecisions).where(inArray(matchDecisions.id, createdDecisionIds));
  }
  if (createdProductIds.length > 0) {
    await db
      .delete(canonicalVariants)
      .where(inArray(canonicalVariants.productId, createdProductIds));
    await db.delete(canonicalProducts).where(inArray(canonicalProducts.id, createdProductIds));
  }
  if (createdListingIds.length > 0) {
    await db.delete(listings).where(inArray(listings.id, createdListingIds));
  }
  // The policy version is deliberately LEFT BEHIND. `mercaria_match_policy_immutable`
  // refuses a DELETE outright ("Supersede it instead"), which is right: a stored
  // confidence whose policy is gone is a number nobody can reproduce. A `draft`
  // row contends with nothing — `match_policy_versions_active_key` is a partial
  // unique over `active` — so leaving it costs one row in a database that is
  // dropped at the end of the run. Retaining rather than forcing is the same
  // posture as the plan this file gates.
  await closePostgres();
});

/** One canonical product with one variant, both owned by this file. */
async function seedProductWithVariant(label: string): Promise<{
  productId: string;
  variantId: string;
}> {
  const name = `Teardown gate ${label} ${RUN}`;
  const [product] = await db
    .insert(canonicalProducts)
    .values({
      name,
      slug: `teardown-gate-${label}-${RUN}`,
      normalizedName: normalizeEntityName(name),
      status: 'active',
    })
    .returning({ id: canonicalProducts.id });
  if (!product) throw new Error('the fixture product was not created');
  createdProductIds.push(product.id);

  const [variant] = await db
    .insert(canonicalVariants)
    .values({
      productId: product.id,
      name: label,
      // `canonical_variants_signature_shape_check` demands a sha-256 hex digest:
      // a signature this codebase did not produce would silently weaken the
      // uniqueness built over it.
      signature: createHash('sha256').update(`teardown-gate-${label}-${RUN}`).digest('hex'),
      status: 'active',
    })
    .returning({ id: canonicalVariants.id });
  if (!variant) throw new Error('the fixture variant was not created');
  return { productId: product.id, variantId: variant.id };
}

/**
 * Record a decision CITING a variant, exactly as an automatic match does, through
 * the matcher's own repository.
 */
async function citeVariant(
  input: { productId: string; variantId: string | null },
  subjectIndex: number,
): Promise<void> {
  if (policyVersionId === null) throw new Error('the fixture policy version is missing');
  const productVariantId = nativeVariantIds[subjectIndex];
  if (productVariantId === undefined) throw new Error('the fixture native variant is missing');
  const { upsertMatchDecision } = await import('../matching/matchDecisionRepository.js');
  const decision = await upsertMatchDecision(db, {
    subjectKind: 'native_variant',
    subjectKey: `teardown-gate-subject-${RUN}-${uuidv7()}`,
    sourceRecordId: null,
    productVariantId,
    policyVersionId,
    outcome: 'automatic_match',
    decidedStage: 'global_identifier',
    confidence: null,
    matchedCanonicalProductId: input.productId,
    matchedCanonicalVariantId: input.variantId,
    reasonCodes: [],
    blockers: [],
    positiveIdentifiers: [],
    conflictingIdentifiers: [],
    normalizedBrand: null,
    normalizedModel: null,
    normalizedTitle: `teardown gate ${RUN}`,
    categoryKey: null,
    candidates: [],
    now: new Date(),
  });
  createdDecisionIds.push(decision.id);
}

describe('a sibling match decision pinning a canonical fixture', () => {
  it('refuses the owner’s own delete, and the plan declines exactly that id', async () => {
    const cited = await seedProductWithVariant('cited');
    const free = await seedProductWithVariant('free');
    await citeVariant(cited, 0);

    // The vacuity guard: with no citing decision the bare delete SUCCEEDS and
    // every assertion below would be measuring nothing.
    let refused: unknown = null;
    try {
      await db.delete(canonicalVariants).where(eq(canonicalVariants.id, cited.variantId));
    } catch (error: unknown) {
      refused = error;
    }
    expect(refused, 'an uncited variant would make this whole case vacuous').not.toBeNull();
    // The NAME, not merely "it threw" — any other rule this row happens to
    // violate would satisfy a bare truthiness check and prove something else.
    expect(constraintNameOf(refused)).toBe(
      'match_decisions_matched_canonical_variant_id_canonical_variants',
    );

    const plan = await planCanonicalTeardown(db, {
      variantIds: [cited.variantId, free.variantId],
      productIds: [cited.productId, free.productId],
    });

    // The retention half.
    expect(plan.retainedVariantIds).toEqual([cited.variantId]);
    // A retained VARIANT pins its parent too — `canonical_variants.product_id`
    // would refuse the parent delete, and finding that out as a second 23503
    // leaves the teardown half done.
    expect(plan.retainedProductIds).toEqual([cited.productId]);

    // The FLOOR, and it is the assertion that matters: a rule that degenerated
    // to "retain everything" — a teardown that silently stopped cleaning up —
    // reads exactly like a correct one unless the UNCITED id is asserted
    // deletable.
    expect(plan.deletableVariantIds).toEqual([free.variantId]);
    expect(plan.deletableProductIds).toEqual([free.productId]);

    // …and the narrowed delete really proceeds for the free one.
    await db
      .delete(canonicalVariants)
      .where(inArray(canonicalVariants.id, [...plan.deletableVariantIds]));
    const survivors = await db
      .select({ id: canonicalVariants.id })
      .from(canonicalVariants)
      .where(inArray(canonicalVariants.id, [cited.variantId, free.variantId]));
    expect(survivors.map((row) => row.id)).toEqual([cited.variantId]);
  });

  it('declines nothing when no decision cites the fixture', async () => {
    const untouched = await seedProductWithVariant('untouched');

    const plan = await planCanonicalTeardown(db, {
      variantIds: [untouched.variantId],
      productIds: [untouched.productId],
    });

    expect(plan.retainedVariantIds).toEqual([]);
    expect(plan.retainedProductIds).toEqual([]);
    expect(plan.deletableVariantIds).toEqual([untouched.variantId]);
    expect(plan.deletableProductIds).toEqual([untouched.productId]);
  });

  it('reads a decision citing only the PRODUCT as pinning the product alone', async () => {
    // `matched_canonical_product_id` is its own RESTRICT column, and an
    // `automatic_match` may name a product without a variant — so the product
    // half is not merely a consequence of the variant half.
    const product = await seedProductWithVariant('product-only');
    await citeVariant({ productId: product.productId, variantId: null }, 1);

    const plan = await planCanonicalTeardown(db, {
      variantIds: [product.variantId],
      productIds: [product.productId],
    });

    expect(plan.retainedProductIds).toEqual([product.productId]);
    // The VARIANT is not cited, so it stays deletable — the plan declines the
    // narrowest thing that is actually pinned.
    expect(plan.deletableVariantIds).toEqual([product.variantId]);
  });
});

/**
 * The function every fixture now calls — the plan PLUS the two statements.
 *
 * `planCanonicalTeardown` above is decided by the cases already in this file.
 * What is left, and what twenty-four teardowns depend on, is that the deletes it
 * issues really happen, really stop at the pinned rows, and really run in the
 * one order `canonical_variants.product_id` (RESTRICT) permits.
 */
describe('deleteTestCanonicalRows', () => {
  it('deletes the uncited rows and leaves exactly the pinned ones', async () => {
    const pinned = await seedProductWithVariant('helper-pinned');
    const free = await seedProductWithVariant('helper-free');
    await citeVariant(pinned, 2);

    const plan = await deleteTestCanonicalRows(db, {
      variantIds: [pinned.variantId, free.variantId],
      productIds: [pinned.productId, free.productId],
    });

    expect(plan.retainedVariantIds).toEqual([pinned.variantId]);
    expect(plan.retainedProductIds).toEqual([pinned.productId]);

    const variants = await db
      .select({ id: canonicalVariants.id })
      .from(canonicalVariants)
      .where(inArray(canonicalVariants.id, [pinned.variantId, free.variantId]));
    const products = await db
      .select({ id: canonicalProducts.id })
      .from(canonicalProducts)
      .where(inArray(canonicalProducts.id, [pinned.productId, free.productId]));

    // Both halves, because "it deleted nothing" and "it deleted everything" are
    // the two ways this can be wrong and each satisfies one assertion alone.
    expect(variants.map((row) => row.id)).toEqual([pinned.variantId]);
    expect(products.map((row) => row.id)).toEqual([pinned.productId]);
  });

  it('discovers a variant the caller never recorded', async () => {
    // Several fixtures mint a product through a repository that creates its
    // default variant, so the file knows the product id and never sees the
    // variant's. Passing product ids alone must still clear the children —
    // `canonical_variants.product_id` is RESTRICT, so a missed child is a
    // `23503` on the parent rather than a leftover row.
    const orphaned = await seedProductWithVariant('helper-discovered');

    const plan = await deleteTestCanonicalRows(db, { productIds: [orphaned.productId] });

    expect(plan.deletableVariantIds).toEqual([orphaned.variantId]);
    expect(plan.deletableProductIds).toEqual([orphaned.productId]);

    const survivors = await db
      .select({ id: canonicalVariants.id })
      .from(canonicalVariants)
      .where(eq(canonicalVariants.productId, orphaned.productId));
    expect(survivors).toEqual([]);
  });

  it('retains a merge WINNER whose loser a sibling pinned', async () => {
    // `canonical_products.merged_into_id` is a self-referencing ON DELETE
    // RESTRICT. Measured against this server: deleting winner and loser in ONE
    // statement succeeds, and deleting the winner ALONE with the loser present
    // raises 23503 on `..._merged_into_id_fkey`. So a partition that retains the
    // loser and frees the winner produces exactly that refusal — which is what
    // this helper would do if it read `match_decisions` and nothing else.
    const winner = await seedProductWithVariant('merge-winner');
    const loser = await seedProductWithVariant('merge-loser');
    await db
      .update(canonicalProducts)
      .set({ status: 'merged', mergedIntoId: winner.productId })
      .where(eq(canonicalProducts.id, loser.productId));
    // A SIBLING cites the loser — an ordinary active row until the merge ran.
    await citeVariant(loser, 3);

    const plan = await deleteTestCanonicalRows(db, {
      variantIds: [winner.variantId, loser.variantId],
      productIds: [winner.productId, loser.productId],
    });

    // Both, and the winner only because the loser points at it.
    expect([...plan.retainedProductIds].sort()).toEqual(
      [winner.productId, loser.productId].sort(),
    );
    const survivors = await db
      .select({ id: canonicalProducts.id })
      .from(canonicalProducts)
      .where(inArray(canonicalProducts.id, [winner.productId, loser.productId]));
    expect(survivors).toHaveLength(2);
  });

  it('retains a merge winner one variant hop away', async () => {
    // The same rule on `canonical_variants.merged_into_id`, and it has to run
    // BEFORE the parent-pinning step: the winner variant's product is only
    // reachable once the winner variant itself is retained.
    const winner = await seedProductWithVariant('merge-variant-winner');
    const loser = await seedProductWithVariant('merge-variant-loser');
    await db
      .update(canonicalVariants)
      .set({ status: 'merged', mergedIntoId: winner.variantId })
      .where(eq(canonicalVariants.id, loser.variantId));
    await citeVariant(loser, 4);

    const plan = await deleteTestCanonicalRows(db, {
      variantIds: [winner.variantId, loser.variantId],
      productIds: [winner.productId, loser.productId],
    });

    expect([...plan.retainedVariantIds].sort()).toEqual(
      [winner.variantId, loser.variantId].sort(),
    );
    // …and the winner variant's PARENT with it, or the product delete meets a
    // child it cannot remove.
    expect([...plan.retainedProductIds].sort()).toEqual(
      [winner.productId, loser.productId].sort(),
    );
  });

  it('does nothing, and issues nothing, for an empty teardown', async () => {
    // Every caller is a hook that may run before its fixtures exist. An empty
    // input has to be a no-op rather than an `inArray(col, [])`, which drizzle
    // renders as the literal `false` — correct, and a round trip per hook.
    const plan = await deleteTestCanonicalRows(db, { productIds: [], variantIds: [] });
    expect(plan).toEqual({
      deletableVariantIds: [],
      deletableProductIds: [],
      retainedVariantIds: [],
      retainedProductIds: [],
    });
  });
});
