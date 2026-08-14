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
 *
 * ## Deciding and deleting are ONE transaction, and the rows are LOCKED first
 *
 * Narrowing the delete is necessary and was not sufficient. Reading
 * `match_decisions`, deleting the variants and deleting the products used to be
 * three autocommitted statements, so a sibling's matcher could commit a citing
 * decision in the gap between the read and either delete and the delete met the
 * same `23503` the plan exists to avoid — a smaller window, not a closed one,
 * and three green runs say nothing about a race whose measured frequency was
 * one in four full runs.
 *
 * So the whole sequence runs inside `db.transaction(...)` and every canonical
 * row it might delete is locked `FOR UPDATE` BEFORE `match_decisions` is read.
 * That closes it in both directions, and neither direction is a convention:
 *
 * - A decision COMMITTED before the lock is acquired is visible to the plan
 *   that follows it (READ COMMITTED reads the latest committed row), so it is
 *   seen and its ids are retained.
 * - A decision ATTEMPTED after the lock is held cannot commit first. Inserting a
 *   `match_decisions` row takes `FOR KEY SHARE` on the canonical rows it cites,
 *   which CONFLICTS with `FOR UPDATE` — so the sibling's insert waits, and when
 *   this transaction commits having deleted the row the sibling's own insert is
 *   the statement that fails, on its own foreign key. Nothing another file owns
 *   is touched, which is the same posture as the retention rule above.
 *
 * ## The lock ORDER, and why a caller cannot influence it
 *
 * PRODUCTS first, then VARIANTS, each in ONE statement per table ordered by
 * ascending `id`. Two concurrent teardowns therefore queue in the same order and
 * cannot deadlock, and — because the order comes from an `ORDER BY` inside one
 * statement rather than from iterating the caller's array — two callers naming
 * the same ids in opposite orders still lock them in the same order. Locking the
 * products FIRST also means the child discovery below cannot race: `FOR UPDATE`
 * on a product conflicts with the `FOR KEY SHARE` an INSERT of a variant under
 * it would take, so no variant can appear under one of these products between
 * the discovery and the delete.
 *
 * `planCanonicalTeardown` is deliberately NOT exported. It is the decision half
 * of one atomic operation, and a caller able to obtain a plan on the root
 * connection can rebuild the exact check-then-delete sequence this transaction
 * exists to remove.
 */

import { asc, inArray } from 'drizzle-orm';
import { canonicalProducts, canonicalVariants } from '../schema/canonicalCatalog.js';
import { matchDecisions } from '../schema/matching.js';
import type { Database, Transaction } from '../postgres.js';

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
 * Grow `retained` to cover the merge WINNER of every row already in it.
 *
 * Both canonical tables carry a self-referencing `merged_into_id` with
 * `ON DELETE RESTRICT`, so a retained tombstone refuses its winner's delete.
 * The caller's own id set bounds this: a winner nobody was going to delete
 * needs no pinning.
 *
 * Written once and used for both tables — the two differ only in which table
 * object they name, and a second copy is a second place for the fixpoint to be
 * wrong.
 */
async function pinMergeTargets(
  db: Transaction,
  table: typeof canonicalVariants | typeof canonicalProducts,
  retained: Set<string>,
  universe: ReadonlySet<string>,
): Promise<void> {
  for (let guard = 0; guard <= universe.size; guard += 1) {
    if (retained.size === 0) return;
    const rows = await db
      .select({ mergedIntoId: table.mergedIntoId })
      .from(table)
      .where(inArray(table.id, [...retained]));
    let grew = false;
    for (const row of rows) {
      const winner = row.mergedIntoId;
      if (winner === null) continue;
      if (!universe.has(winner) || retained.has(winner)) continue;
      retained.add(winner);
      grew = true;
    }
    if (!grew) return;
  }
}

/**
 * Take `FOR UPDATE` on every one of these rows that exists, in ascending id
 * order, in ONE statement.
 *
 * One statement rather than a loop over the caller's array is what makes the
 * order a property of this function instead of a property of whoever called it:
 * two teardowns naming the same ids in opposite orders still acquire them
 * ascending, so neither can be holding what the other is waiting for.
 *
 * A missing row is simply not locked. That is correct here — a row that is
 * already gone cannot be deleted by this call and cannot be cited by anybody
 * either.
 */
async function lockCanonicalRows(
  tx: Transaction,
  table: typeof canonicalVariants | typeof canonicalProducts,
  ids: readonly string[],
): Promise<void> {
  if (ids.length === 0) return;
  await tx
    .select({ id: table.id })
    .from(table)
    .where(inArray(table.id, [...ids]))
    .orderBy(asc(table.id))
    .for('update');
}

/**
 * Partition a file's OWN canonical ids into what it may delete and what a
 * sibling's `match_decisions` row now pins.
 *
 * A product is retained when a decision cites it directly OR when it owns a
 * retained variant — `canonical_variants.product_id` would refuse the parent
 * delete either way, and discovering that as a second `23503` would leave the
 * teardown half done.
 *
 * Takes a TRANSACTION, and is private to this module: the answer is only true
 * for as long as the locks taken before it are held, so a caller able to obtain
 * one on the root connection would be holding a fact with no lifetime — which is
 * exactly the check-then-delete sequence `deleteTestCanonicalRows` replaced.
 */
async function planCanonicalTeardown(
  db: Transaction,
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

  // A retained TOMBSTONE pins whatever it was merged INTO.
  //
  // `canonical_variants.merged_into_id` and `canonical_products.merged_into_id`
  // are self-referencing `ON DELETE RESTRICT`, so a loser still present refuses
  // its winner's delete. Measured against a real server: deleting winner and
  // loser in ONE statement succeeds — for a single DELETE the check settles at
  // end-of-statement, at 2 rows and at 101, in either list order — while
  // deleting the winner ALONE with the loser present raises `23503` on
  // `..._merged_into_id_fkey`. The reverse is fine: a loser alone deletes
  // cleanly.
  //
  // That is precisely what a partition can produce. A sibling cites the LOSER —
  // which is an ordinary active row right up until the file's own merge runs —
  // so the loser is retained, the uncited winner is not, and the winner's delete
  // is refused. Before this helper existed the ids went out in one statement and
  // the question never arose, which is why nothing in the estate reset these
  // columns.
  //
  // A fixpoint rather than one hop, because a merge chain is representable; the
  // set only grows and is bounded by the caller's own ids, so it terminates.
  await pinMergeTargets(db, canonicalVariants, citedVariants, new Set(variantIds));

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

  // AFTER the parents, because a product pinned by a retained variant may itself
  // be a tombstone whose winner is still in the deletable half.
  await pinMergeTargets(db, canonicalProducts, citedProducts, new Set(productIds));

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
 * This is the WHOLE operation and the only entry point: the lock, the decision
 * and the two statements, in ONE transaction and in the one delete order that
 * works — `canonical_variants.product_id` is `ON DELETE RESTRICT`, so a product
 * whose variants are still present cannot go, and the parent-pinning rule above
 * is what keeps a retained variant from turning into a second `23503` on the
 * product. See the header for the lock order and for why the plan is not
 * separately obtainable.
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

  return db.transaction(async (tx) => {
    // PRODUCTS first. See the header: this order is fixed for every call, so two
    // concurrent teardowns cannot hold what the other is waiting for.
    await lockCanonicalRows(tx, canonicalProducts, productIds);

    // Discovered AFTER that lock, deliberately. `FOR UPDATE` on a product
    // conflicts with the `FOR KEY SHARE` an insert of a variant beneath it would
    // take, so this read cannot miss a child that appears a moment later and
    // then refuses the parent's delete.
    const discovered =
      productIds.length === 0
        ? []
        : (
            await tx
              .select({ id: canonicalVariants.id })
              .from(canonicalVariants)
              .where(inArray(canonicalVariants.productId, productIds))
          ).map((row) => row.id);

    const variantIds = [...new Set([...requested, ...discovered])];
    await lockCanonicalRows(tx, canonicalVariants, variantIds);

    // Only now is `match_decisions` read: every id it could name is already
    // locked, so a citation that is not visible here cannot become visible
    // before the deletes below commit.
    const plan = await planCanonicalTeardown(tx, { variantIds, productIds });

    if (plan.deletableVariantIds.length > 0) {
      await tx
        .delete(canonicalVariants)
        .where(inArray(canonicalVariants.id, [...plan.deletableVariantIds]));
    }
    if (plan.deletableProductIds.length > 0) {
      await tx
        .delete(canonicalProducts)
        .where(inArray(canonicalProducts.id, [...plan.deletableProductIds]));
    }
    return plan;
  });
}
