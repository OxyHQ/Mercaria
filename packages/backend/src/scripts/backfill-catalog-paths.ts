/**
 * Re-derive `listings.category_slugs` from the taxonomy (#367 workstream 13,
 * ADR 0007 D13).
 *
 * Run from `packages/backend`:
 *
 *   DATABASE_URL=… bun src/scripts/backfill-catalog-paths.ts
 *   DATABASE_URL=… bun src/scripts/backfill-catalog-paths.ts --apply --limit=500
 *   DATABASE_URL=… bun src/scripts/backfill-catalog-paths.ts --apply --after=<listingId>
 *   DATABASE_URL=… bun src/scripts/backfill-catalog-paths.ts --apply --cohort=store:<storeId>
 *
 * ## The default is a DRY RUN, and that is the safety property
 *
 * `--apply` is required to write anything, and there is no environment variable
 * for it: a migration that wrote because somebody forgot a flag is the one
 * failure neither a report nor a rollback can undo
 * (`PRODUCT_SAVE_MIGRATION_ENABLED`'s decision, and #367 step 4's).
 *
 * A dry run is not a prediction. It runs the identical statements inside a
 * transaction and rolls them back, so it exercises every trigger and CHECK the
 * apply would.
 *
 * ## What it repairs, and why this one and no other
 *
 * `taxonomyRepository.moveCategory` rewrites `categories.ancestor_slugs` for a
 * whole subtree and touches no listing, so every listing under a moved node
 * keeps the path it was written with — and five services filter on that path.
 * The value is a pure function of `listings.category_id` and the taxonomy, so
 * this pass destroys nothing, converges on a second run, and its ROLLBACK is
 * running it again.
 *
 * Repointing a listing whose category was MERGED is equally deterministic and
 * deliberately absent: it overwrites `category_id`, whose previous value then
 * exists nowhere, so it needs a durable record before it can be reversible.
 * `docs/catalog-backfill.md` §"The repair this domain does not perform" says
 * what that record would be.
 *
 * ## One declared side effect
 *
 * The write goes through `updateListingColumns`, which stamps `updated_at` — so
 * a repaired listing gets a fresh modification time and a fresh sitemap
 * `lastmod`. Declared here rather than discovered later: the listing's browse
 * path genuinely changed, and routing around the sanctioned writer to avoid the
 * stamp would make this a fourth writer of a table whose `published_at` is
 * derived inside exactly three statements.
 */

import { closePostgres, connectPostgres } from '../db/postgres.js';
import { log } from '../lib/logger.js';
import { parseCohortArgument } from '../services/catalog-backfill/cohort-argument.js';
import { ALL_COHORT, cohortLabel, type BackfillCohort } from '../services/backfill/cohort.js';
import { runLegacyCategoryPathRepair } from '../services/catalog-backfill/repair.service.js';

/** The parsed command line. */
interface Args {
  readonly cohort: BackfillCohort;
  readonly apply: boolean;
  readonly afterListingId: string | null;
  readonly listingLimit: number;
}

function parseArgs(argv: readonly string[]): Args {
  let cohort: BackfillCohort = ALL_COHORT;
  let apply = false;
  let afterListingId: string | null = null;
  let listingLimit = 200;

  for (const arg of argv) {
    if (arg === '--apply') {
      apply = true;
      continue;
    }
    if (arg === '--dry-run') {
      // Accepted and redundant: a reader who types it should not be told it is
      // unknown, because the default IS a dry run.
      continue;
    }
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
      if (!Number.isInteger(value) || value <= 0) {
        throw new Error(`--limit must be a positive integer; got "${arg}".`);
      }
      listingLimit = value;
      continue;
    }
    throw new Error(`Unrecognized argument "${arg}".`);
  }

  return { cohort, apply, afterListingId, listingLimit };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const db = await connectPostgres();

  const report = await runLegacyCategoryPathRepair(db, {
    mode: args.apply ? 'apply' : 'dry_run',
    cohort: args.cohort,
    afterListingId: args.afterListingId,
    listingLimit: args.listingLimit,
  });

  process.stdout.write(
    `${JSON.stringify({ ...report, hasMore: report.resumeAfterListingId !== null }, null, 2)}\n`,
  );

  log.general.info(
    {
      cohort: cohortLabel(args.cohort),
      mode: report.mode,
      scannedListings: report.scannedListings,
      pathsRewritten: report.pathsRewritten,
      pathsCleared: report.pathsCleared,
      resumeAfterListingId: report.resumeAfterListingId,
    },
    'Legacy category-path repair pass complete',
  );
}

main()
  .then(async () => {
    await closePostgres();
    process.exit(0);
  })
  .catch(async (err) => {
    log.general.error({ err }, 'Legacy category-path repair failed');
    try {
      await closePostgres();
    } catch (closeErr) {
      log.general.error(
        { err: closeErr },
        'Failed to close the Postgres pool after a repair error',
      );
    }
    process.exit(1);
  });
