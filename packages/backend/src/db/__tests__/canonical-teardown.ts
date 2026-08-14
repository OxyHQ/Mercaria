/**
 * Which of a file's own canonical ids a SIBLING has since made undeletable.
 *
 * ## The failure this exists for
 *
 * `canonical-catalog.realdb.test.ts`'s teardown is correctly scoped — it deletes
 * by the variant ids it created. What breaks it is not its scope: the matcher's
 * candidate retrieval (`services/matching/postgres-candidate-source.ts`) is a
 * trigram search over EVERY `canonical_products` row, correctly global for
 * production, so a sibling file driving `runMatch` finds this file's fixture as a
 * candidate and records a `match_decisions` row citing it. Both
 * `matched_canonical_product_id` and `matched_canonical_variant_id` are
 * `ON DELETE restrict`, so the owner's own delete then fails with `23503` and the
 * whole FILE fails at teardown — measured once in four full baseline runs on
 * `85d6697`.
 *
 * ## Why it RETAINS rather than deleting the sibling's row
 *
 * Deleting the citing `match_decisions` row is the obvious fix and it is the
 * dangerous one. Those rows belong to a file whose assertions may not have run
 * yet, so it converts a loud teardown failure into a silent wrong answer
 * somewhere else — and it does not even stay in one domain: deleting a decision
 * can itself be refused by `catalog_source_objects.last_match_decision_id`, also
 * RESTRICT, so the fix would reach into a third domain's rows to clear a pointer.
 *
 * So nothing another file owns is touched. The owner instead declines to delete
 * exactly the ids a sibling cites, deletes everything else, and says which it
 * kept. That is `merge-plan.ts`'s posture — `untouched` WITH A REASON is a
 * decision the census accepts; silence is not — and it keeps every OTHER
 * constraint violation loud, because only the two RESTRICT-blocked statements are
 * narrowed and any other broken ordering still raises.
 *
 * ## The consequence, stated rather than hidden
 *
 * A retained product or variant OUTLIVES the file and stays visible to every
 * later sibling's matcher retrieval. That is acceptable and it is not nothing:
 * those rows were already visible for the whole time the file ran, a row is
 * retained precisely BECAUSE a sibling already matched it, and the throwaway
 * database is dropped at the end of the run. What it costs is that the catalogue
 * a later file searches is not empty of this file's fixtures — which was true
 * before this helper existed too.
 *
 * It is deliberately NOT a `catch` around the delete. A swallowed `23503` would
 * also hide a genuine children-first ordering mistake, which is the thing the
 * RESTRICT constraints are there to make loud.
 */

import { inArray } from 'drizzle-orm';
import { canonicalProducts, canonicalVariants } from '../schema/canonicalCatalog.js';
import { matchDecisions } from '../schema/matching.js';
import type { Database } from '../postgres.js';

/**
 * What a teardown may delete, and what a sibling has pinned.
 *
 * The retained sets are returned rather than merely subtracted so a caller can
 * report them — and so the gate can assert the UNCITED ids are in the deletable
 * half, which is what stops a degenerate "retain everything" rule reading as a
 * correct one.
 */
export interface CanonicalTeardownPlan {
  readonly deletableVariantIds: readonly string[];
  readonly deletableProductIds: readonly string[];
  readonly retainedVariantIds: readonly string[];
  readonly retainedProductIds: readonly string[];
}

/**
 * Partition a file's OWN canonical ids into what it may delete and what a
 * sibling's `match_decisions` row now pins.
 *
 * A product is retained when a decision cites it directly OR when it owns a
 * retained variant — `canonical_variants.product_id` would refuse the parent
 * delete either way, and discovering that as a second `23503` would leave the
 * teardown half done.
 */
export async function planCanonicalTeardown(
  db: Database,
  input: { variantIds: readonly string[]; productIds: readonly string[] },
): Promise<CanonicalTeardownPlan> {
  const variantIds = [...input.variantIds];
  const productIds = [...input.productIds];
  if (variantIds.length === 0 && productIds.length === 0) {
    return {
      deletableVariantIds: [],
      deletableProductIds: [],
      retainedVariantIds: [],
      retainedProductIds: [],
    };
  }

  const citedVariants = new Set<string>();
  const citedProducts = new Set<string>();

  if (variantIds.length > 0) {
    const rows = await db
      .select({ id: matchDecisions.matchedCanonicalVariantId })
      .from(matchDecisions)
      .where(inArray(matchDecisions.matchedCanonicalVariantId, variantIds));
    for (const row of rows) if (row.id !== null) citedVariants.add(row.id);
  }
  if (productIds.length > 0) {
    const rows = await db
      .select({ id: matchDecisions.matchedCanonicalProductId })
      .from(matchDecisions)
      .where(inArray(matchDecisions.matchedCanonicalProductId, productIds));
    for (const row of rows) if (row.id !== null) citedProducts.add(row.id);
  }

  // A retained VARIANT pins its parent too. Read the parentage rather than
  // assuming the caller knows it: the variants were discovered by product id, so
  // the mapping exists in the database and nowhere in the caller.
  if (citedVariants.size > 0) {
    const parents = await db
      .select({ productId: canonicalVariants.productId })
      .from(canonicalVariants)
      .where(inArray(canonicalVariants.id, [...citedVariants]));
    for (const parent of parents) citedProducts.add(parent.productId);
  }

  return {
    deletableVariantIds: variantIds.filter((id) => !citedVariants.has(id)),
    deletableProductIds: productIds.filter((id) => !citedProducts.has(id)),
    retainedVariantIds: variantIds.filter((id) => citedVariants.has(id)),
    retainedProductIds: productIds.filter((id) => citedProducts.has(id)),
  };
}

/**
 * Delete a file's OWN canonical rows, skipping exactly what a sibling pins.
 *
 * This is what a teardown calls. `planCanonicalTeardown` above is the decision;
 * this is the decision plus the two statements, in the one order that works —
 * `canonical_variants.product_id` is `ON DELETE RESTRICT`, so a product whose
 * variants are still present cannot go, and the parent-pinning rule above is
 * what keeps a retained variant from turning into a second `23503` on the
 * product.
 *
 * ## Why the variants are DISCOVERED and not only accepted
 *
 * Callers pass what they recorded, and what they recorded is not always
 * complete: several fixtures mint a product through a repository that creates
 * its default variant, so the file knows the product id and never sees the
 * variant's. `backfill.realdb.test.ts` deletes by `product_id` for exactly that
 * reason. Reading the children back closes the gap for every caller instead of
 * for the ones who remembered, and it costs one indexed statement in a hook.
 *
 * ## What a caller still owes
 *
 * Its own children first — offers, links, identifiers, attributes, source
 * links, its OWN match decisions. Only the two RESTRICT-blocked statements are
 * narrowed here, so any other broken ordering still raises, which is the point:
 * a swallowed `23503` would hide a genuine children-first mistake.
 *
 * The returned plan names what was kept. Most callers ignore it — a retained
 * row is inert in a database that is dropped at the end of the run — but it is
 * returned rather than swallowed so a caller that wants to report or assert on
 * it can, and so the gate can check the uncited ids really were deleted.
 */
export async function deleteTestCanonicalRows(
  db: Database,
  input: { readonly productIds?: readonly string[]; readonly variantIds?: readonly string[] },
): Promise<CanonicalTeardownPlan> {
  const productIds = [...new Set(input.productIds ?? [])];
  const requested = [...new Set(input.variantIds ?? [])];
  if (productIds.length === 0 && requested.length === 0) {
    return {
      deletableVariantIds: [],
      deletableProductIds: [],
      retainedVariantIds: [],
      retainedProductIds: [],
    };
  }

  const discovered =
    productIds.length === 0
      ? []
      : (
          await db
            .select({ id: canonicalVariants.id })
            .from(canonicalVariants)
            .where(inArray(canonicalVariants.productId, productIds))
        ).map((row) => row.id);

  const plan = await planCanonicalTeardown(db, {
    variantIds: [...new Set([...requested, ...discovered])],
    productIds,
  });

  if (plan.deletableVariantIds.length > 0) {
    await db
      .delete(canonicalVariants)
      .where(inArray(canonicalVariants.id, [...plan.deletableVariantIds]));
  }
  if (plan.deletableProductIds.length > 0) {
    await db
      .delete(canonicalProducts)
      .where(inArray(canonicalProducts.id, [...plan.deletableProductIds]));
  }
  return plan;
}
