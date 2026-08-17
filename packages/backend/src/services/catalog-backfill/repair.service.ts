/**
 * The ONE write #367 workstream 13 performs: re-deriving
 * `listings.category_slugs` — ADR 0007 D13.
 *
 * ## Why this backfill and no other
 *
 * The workstream classifies four legacy fields and writes exactly one of them,
 * and the line between them is not effort, it is REVERSIBILITY.
 *
 * `category_slugs` is a pure projection of `category_id` through the taxonomy.
 * Re-deriving it destroys nothing: the correct value is a function of two rows
 * that are still there, so a second pass produces the same answer and "roll it
 * back" means "run it again". `LEGACY_CATALOG_BACKFILL_POLICY` calls this
 * subject `deterministic_only` and `LEGACY_CATALOG_WRITE_OWNERS` names this
 * module, and both are satisfiable because the write is idempotent by
 * construction rather than by care.
 *
 * The tempting second one — repointing a listing whose category was MERGED —
 * is equally deterministic and is deliberately NOT performed here. It overwrites
 * `category_id`, and the value it overwrites exists nowhere else afterwards, so
 * an undo needs a durable record of what the row said before. `docs/catalog-backfill.md`
 * §"The repair this domain does not perform" states exactly what that record
 * would have to be. Shipping the write without it would be a migration whose
 * rollback strategy is "we hope it was right".
 *
 * ## Why the write goes through `updateListingColumns`
 *
 * `listings.published_at` and its archive provenance are DERIVED inside the
 * three statements that may write the table, and
 * `listing-publication-chokepoint.test.ts` counts those statements. A direct
 * drizzle update against that table here would be a fourth writer — it would
 * fail that census, correctly, and the failure it is protecting against is
 * precisely a migration writing a listing row without the derivations.
 *
 * The shape is described rather than SPELLED: that census scans raw source
 * without stripping comments, on purpose, so a docblock quoting the call names
 * its own file as a writer. It did, on the first full run.
 *
 * The visible consequence, stated rather than hidden: `updateListingColumns`
 * stamps `updated_at`, so a listing whose path this pass re-derives gets a fresh
 * modification time and, through it, a fresh sitemap `lastmod`. That is
 * defensible — the listing's browse path genuinely changed — and it is the kind
 * of side effect a migration should declare before it runs, not after somebody
 * notices a sitemap churn.
 *
 * ## A dry run is not a prediction
 *
 * Both modes run the identical body inside a transaction; a dry run rolls it
 * back. So a dry run exercises every trigger, CHECK and index the apply would,
 * and a listing that would fail is reported as failing rather than as fine. A
 * parallel "predict" path is a second implementation, and the two disagree
 * exactly where a migration is dangerous (#367 step 4's ruling, one domain
 * over).
 */

import { TransactionRollbackError } from 'drizzle-orm';
import type { LegacyCatalogRepairReport } from '@mercaria/shared-types';
import type { Database } from '../../db/postgres.js';
import { updateListingColumns } from '../../db/catalog/listingRepository.js';
import {
  listLegacyListingPage,
  loadCategoryFactsFor,
  readLegacyCatalogCoverage,
} from '../../db/catalogBackfill/legacyCatalogRepository.js';
import {
  classifyCategoryPath,
  derivedCategoryPath,
  LEGACY_CATALOG_CLASSIFIER_VERSION,
} from './classification.js';
import { ALL_COHORT, type BackfillCohort } from '../backfill/cohort.js';

/** How a caller drives one repair pass. */
export interface LegacyCatalogRepairOptions {
  /** `dry_run` runs the identical code and rolls it back. Defaults to `dry_run`. */
  readonly mode?: 'dry_run' | 'apply';
  /** Which slice of the catalogue to repair. Defaults to the whole of it. */
  readonly cohort?: BackfillCohort;
  readonly afterListingId?: string | null;
  readonly listingLimit?: number;
}

/**
 * Refuse to return a report whose outcomes do not account for every row read.
 *
 * The same EQUALITY the classification pass asserts, and the same positive
 * control: a first page that read nothing while the catalogue is not empty is a
 * broken pager reporting a finished migration.
 */
function assertRepairSums(report: {
  readonly firstPage: boolean;
  readonly listingsTotal: number;
  readonly scannedListings: number;
  readonly pathsAgreed: number;
  readonly pathsRewritten: number;
  readonly pathsCleared: number;
  readonly withoutCategoryOnPage: number;
}): void {
  if (report.firstPage && report.listingsTotal > 0 && report.scannedListings === 0) {
    throw new Error(
      `catalog path repair: the catalogue holds ${String(report.listingsTotal)} listing(s) and ` +
        'the first page returned none. The pager is broken; the report would say there was ' +
        'nothing to repair.',
    );
  }
  const accounted =
    report.pathsAgreed + report.pathsRewritten + report.pathsCleared + report.withoutCategoryOnPage;
  if (accounted !== report.scannedListings) {
    throw new Error(
      `catalog path repair: ${String(report.scannedListings)} listing(s) were read and ` +
        `${String(accounted)} outcome(s) recorded. A row was swallowed; the report is not ` +
        'trustworthy.',
    );
  }
}

/**
 * Re-derive `listings.category_slugs` for one page.
 *
 * Idempotent: a listing whose stored path already equals the derivation is not
 * written at all, so a second pass over unchanged data issues no statements and
 * reports every row as `pathsAgreed`. Resumable through the keyset cursor, which
 * is a convenience rather than a correctness requirement precisely because of
 * that.
 */
export async function runLegacyCategoryPathRepair(
  db: Database,
  options: LegacyCatalogRepairOptions = {},
): Promise<LegacyCatalogRepairReport> {
  const mode = options.mode ?? 'dry_run';
  const cohort = options.cohort ?? ALL_COHORT;
  const afterListingId = options.afterListingId ?? null;
  const limit = options.listingLimit ?? 200;

  const coverage = await readLegacyCatalogCoverage(db, cohort);
  const page = await listLegacyListingPage(db, { cohort, afterListingId, limit });
  const categoryFacts = await loadCategoryFactsFor(
    db,
    page.listings.flatMap((listing) => (listing.categoryId === null ? [] : [listing.categoryId])),
  );

  let pathsAgreed = 0;
  let pathsRewritten = 0;
  let pathsCleared = 0;
  let withoutCategoryOnPage = 0;

  for (const listing of page.listings) {
    const verdict = classifyCategoryPath(listing, categoryFacts);

    // The classifier decides; this loop only acts on what it decided. A second
    // `if (stored !== derived)` here would be a second spelling of the rule, and
    // the two would disagree the first time one of them was corrected.
    switch (verdict.reason) {
      case 'category_path_agrees':
        pathsAgreed += 1;
        continue;
      case 'category_path_absent_without_category':
        withoutCategoryOnPage += 1;
        continue;
      case 'category_path_present_without_category': {
        await writeCategorySlugs(db, mode, listing.id, []);
        pathsCleared += 1;
        continue;
      }
      case 'category_path_drifted': {
        const category = listing.categoryId === null ? undefined : categoryFacts.get(listing.categoryId);
        if (category === undefined) {
          // Unreachable through the classifier, which answers
          // `present_without_category` when the map has no such node. Counted as
          // a clear rather than skipped, because a skipped row would break the
          // sum and the sum is what makes the report trustworthy.
          await writeCategorySlugs(db, mode, listing.id, []);
          pathsCleared += 1;
          continue;
        }
        await writeCategorySlugs(db, mode, listing.id, [...derivedCategoryPath(category)]);
        pathsRewritten += 1;
        continue;
      }
      default:
        // `classifyCategoryPath` is total over the four `category_path_*`
        // reasons; anything else means the classifier grew a fifth and this
        // switch was not updated. Throwing is what makes that a failed page
        // rather than a silently uncounted row.
        throw new Error(
          `catalog path repair: unexpected verdict '${verdict.reason}' for listing ${listing.id}.`,
        );
    }
  }

  assertRepairSums({
    firstPage: afterListingId === null,
    listingsTotal: coverage.listingsTotal,
    scannedListings: page.listings.length,
    pathsAgreed,
    pathsRewritten,
    pathsCleared,
    withoutCategoryOnPage,
  });

  return {
    mode,
    classifierVersion: LEGACY_CATALOG_CLASSIFIER_VERSION,
    scannedListings: page.listings.length,
    pathsAgreed,
    pathsRewritten,
    pathsCleared,
    resumeAfterListingId: page.resumeAfterListingId,
  };
}

/**
 * Write one listing's path, or run the identical statement and roll it back.
 *
 * The rollback is per LISTING rather than per page, so a dry run over a page
 * whose hundredth row would fail still reports the ninety-nine that would have
 * succeeded — and reports the hundredth as a thrown page, which is the same
 * thing the apply would do.
 */
async function writeCategorySlugs(
  db: Database,
  mode: 'dry_run' | 'apply',
  listingId: string,
  categorySlugs: string[],
): Promise<void> {
  try {
    await db.transaction(async (tx) => {
      await updateListingColumns(listingId, { categorySlugs }, tx);
      if (mode === 'dry_run') tx.rollback();
    });
  } catch (error) {
    if (!(error instanceof TransactionRollbackError)) throw error;
  }
}
