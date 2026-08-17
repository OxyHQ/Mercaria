/**
 * Classify the legacy catalogue against the universal catalog system
 * (#367 workstream 13).
 *
 * Run from `packages/backend`:
 *
 *   DATABASE_URL=… bun src/scripts/backfill-catalog-classify.ts
 *   DATABASE_URL=… bun src/scripts/backfill-catalog-classify.ts --limit=500
 *   DATABASE_URL=… bun src/scripts/backfill-catalog-classify.ts --after=<listingId>
 *   DATABASE_URL=… bun src/scripts/backfill-catalog-classify.ts --cohort=store:<storeId>
 *
 * ## It cannot write, and there is no flag that would let it
 *
 * There is no `--apply` here, because there is nothing to apply: this pass reads
 * `listings`, `categories`, `product_type_definitions` and `brands` and produces
 * a report. The one write this workstream performs is
 * `backfill-catalog-paths.ts`, which is a different pass with a different report
 * — keeping them apart is what makes "classification changed nothing" a property
 * of the command rather than of a flag somebody remembered.
 *
 * ## What the report is for, and what a good one looks like
 *
 * "N deterministic, M ambiguous, K invalid" IS the deliverable. On a real legacy
 * catalogue the honest shape is a large `product_type_no_registered_key` count
 * and a large `vendor_brand_no_candidate` count, because free text entered
 * before a registry existed does not resolve into one — and resolving it anyway
 * is the false merge #58 is shaped around, arriving as a migration.
 *
 * `coverage` is printed on SUCCESS, not only on failure: the outcome counts
 * cannot be read without knowing how big the catalogue is, and a pass that
 * scanned nothing prints the same zeros as a clean pass over an empty one. The
 * service throws rather than returning such a report.
 *
 * The exit code says whether the pass completed, never whether the backlog is
 * empty.
 */

import { closePostgres, connectPostgres } from '../db/postgres.js';
import { log } from '../lib/logger.js';
import { parseCohortArgument } from '../services/catalog-backfill/cohort-argument.js';
import { ALL_COHORT, cohortLabel, type BackfillCohort } from '../services/backfill/cohort.js';
import { runLegacyCatalogClassification } from '../services/catalog-backfill/classify.service.js';

/** The parsed command line. Two flags do not need a dependency. */
interface Args {
  readonly cohort: BackfillCohort;
  readonly afterListingId: string | null;
  readonly listingLimit: number;
}

function parseArgs(argv: readonly string[]): Args {
  let cohort: BackfillCohort = ALL_COHORT;
  let afterListingId: string | null = null;
  let listingLimit = 200;

  for (const arg of argv) {
    if (arg.startsWith('--cohort=')) {
      cohort = parseCohortArgument(arg.slice('--cohort='.length));
      continue;
    }
    if (arg.startsWith('--after=')) {
      const value = arg.slice('--after='.length).trim();
      afterListingId = value.length === 0 ? null : value;
      continue;
    }
    if (arg.startsWith('--limit=')) {
      const value = Number.parseInt(arg.slice('--limit='.length), 10);
      // A silently-defaulted limit is how a pass meant to read ten listings reads
      // the catalogue. Refuse rather than fall back.
      if (!Number.isInteger(value) || value <= 0) {
        throw new Error(`--limit must be a positive integer; got "${arg}".`);
      }
      listingLimit = value;
      continue;
    }
    throw new Error(`Unrecognized argument "${arg}".`);
  }

  return { cohort, afterListingId, listingLimit };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const db = await connectPostgres();

  const report = await runLegacyCatalogClassification(db, {
    cohort: args.cohort,
    afterListingId: args.afterListingId,
    listingLimit: args.listingLimit,
  });

  // One JSON object rather than prose, so a caller can loop on
  // `resumeAfterListingId` and an operator can diff two passes.
  process.stdout.write(
    `${JSON.stringify({ ...report, hasMore: report.resumeAfterListingId !== null }, null, 2)}\n`,
  );

  log.general.info(
    {
      cohort: cohortLabel(args.cohort),
      classifierVersion: report.classifierVersion,
      listingsTotal: report.coverage.listingsTotal,
      scannedListings: report.scannedListings,
      resumeAfterListingId: report.resumeAfterListingId,
    },
    'Legacy catalogue classification pass complete',
  );
}

main()
  .then(async () => {
    await closePostgres();
    process.exit(0);
  })
  .catch(async (err) => {
    log.general.error({ err }, 'Legacy catalogue classification failed');
    try {
      await closePostgres();
    } catch (closeErr) {
      log.general.error(
        { err: closeErr },
        'Failed to close the Postgres pool after a classification error',
      );
    }
    process.exit(1);
  });
