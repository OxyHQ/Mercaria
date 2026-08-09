/**
 * Stage 3 — every native variant in the cohort is handed to #58's matcher
 * (ADR 0002 D23 phase 1, "match store products using valid barcodes, brand and
 * model data first").
 *
 * ## The backfill ENQUEUES and never matches
 *
 * `match-sweep.service`'s rule, and this stage is deliberately its cohort-aware
 * sibling rather than a second implementation: the queue's dispatcher is the
 * only thing that runs the pipeline, so a bulk backfill and a single catalogue
 * write take exactly the same code path, and there is no second matcher to keep
 * in step with the first. It also inherits the queue's coalescing for free —
 * enqueueing a variant that is already pending bumps a revision instead of
 * adding work.
 *
 * Why this stage exists at all, given `match-sweep` already sweeps: the sweep is
 * whole-catalogue and answers to #58's operator surface. A staged migration
 * needs the SAME enqueue restricted to a cohort and reported per record, because
 * "which of this store's variants did the migration hand to the matcher" is the
 * question a canary rollout asks and a global sweep cannot answer.
 *
 * ## Every scanned variant is `enqueued`, including on a re-run
 *
 * There is deliberately no `unchanged` branch. Asking the queue whether a
 * subject is already pending, and skipping it if so, would make the stage's
 * report depend on how recently the dispatcher ran — two runs over an untouched
 * catalogue would disagree for reasons that have nothing to do with the
 * catalogue. Enqueueing unconditionally is idempotent at the queue (that is what
 * `ON CONFLICT DO UPDATE` on `match_queue.subject_key` is for), so the honest
 * report is that the request was made.
 */

import { and, asc, eq, gt, type SQL } from 'drizzle-orm';
import { getDb } from '../../../db/postgres.js';
import { listings, productVariants } from '../../../db/schema/catalog.js';
import { cohortListingPredicate } from '../cohort.js';
import {
  examineAll,
  nextKeysetCursor,
  type StageContext,
  type StagePageResult,
} from '../stage-context.js';

/** One native variant, with the listing facts the cohort filter needs. */
interface VariantRow {
  readonly id: string;
  readonly listingId: string;
}

export async function runVariantMatchingPage(context: StageContext): Promise<StagePageResult> {
  const db = getDb();
  const cohort = cohortListingPredicate(context.cohort);
  const keyset: SQL | undefined =
    context.cursor === null ? undefined : gt(productVariants.id, context.cursor);
  const predicate =
    cohort === undefined ? keyset : keyset === undefined ? cohort : and(cohort, keyset);

  /**
   * The join to `listings` is what applies the cohort, and it is an INNER join
   * on purpose: a variant whose listing has gone is a row the catalogue's own
   * cascade is about to remove, and enqueueing it would produce a job that can
   * only ever answer `subject_gone`.
   */
  const rows: VariantRow[] = await db
    .select({ id: productVariants.id, listingId: productVariants.listingId })
    .from(productVariants)
    .innerJoin(listings, eq(listings.id, productVariants.listingId))
    .where(predicate)
    .orderBy(asc(productVariants.id))
    .limit(context.limit);

  const counters = await examineAll(
    context,
    rows,
    (row) => ({ kind: 'product_variant', productVariantId: row.id }),
    async (row) => {
      await context.writer.requestVariantMatch(row.id);
      return { reasonCode: 'match_enqueued', detail: `listing ${row.listingId}` };
    },
  );

  return { counters, nextCursor: nextKeysetCursor(rows, context.limit) };
}
