/**
 * Migrate legacy free-text options into typed variant axes (#367 step 4,
 * ADR 0007 D6).
 *
 * Run from `packages/backend`:
 *
 *   DATABASE_URL=… bun src/scripts/backfill-variant-axes.ts
 *   DATABASE_URL=… bun src/scripts/backfill-variant-axes.ts --apply --limit=500
 *   DATABASE_URL=… bun src/scripts/backfill-variant-axes.ts --apply --after=<listingId>
 *
 * ## The default is a DRY RUN, and that is the safety property
 *
 * `--apply` is required to write anything. The mode is not a config value and
 * there is no environment variable for it: a migration that wrote because
 * somebody forgot a flag is the one failure neither a report nor a rollback can
 * undo, and `PRODUCT_SAVE_MIGRATION_ENABLED` records the same decision one
 * domain over.
 *
 * A dry run is NOT a parallel prediction. It runs the identical code inside a
 * transaction and rolls it back, so it exercises every trigger, every CHECK and
 * every unique index the apply would — including the collision gate that decides
 * whether a listing can be typed at all. A prediction is a second implementation
 * of the migration, and the two disagree precisely where a migration is
 * dangerous.
 *
 * ## What the report is for
 *
 * ADR 0007's own consequences section: "Ambiguous legacy values are not
 * resolved. They stay text, in a queue, visible. This is deliberate and it means
 * the migration's output includes a backlog rather than a clean number." So the
 * report prints the backlog BY CAUSE, and `assertReportSums` inside the service
 * refuses to produce a report whose outcomes do not account for every legacy row
 * read. A pass that swallowed a row exits non-zero rather than printing a tidy
 * summary.
 *
 * The exit code says whether the pass completed, never whether the backlog is
 * empty — an unresolved option is the correct outcome for `Tono`, not a failure.
 * `hasMore` in the output is what a caller loops on.
 */

import { closePostgres, connectPostgres } from '../db/postgres.js';
import { log } from '../lib/logger.js';
import { runVariantAxisBackfill } from '../services/variant-axes/backfill.service.js';

/** The parsed command line. No dependencies — five flags do not need one. */
interface Args {
  readonly apply: boolean;
  readonly afterListingId: string | null;
  readonly listingLimit: number;
}

function parseArgs(argv: readonly string[]): Args {
  let apply = false;
  let afterListingId: string | null = null;
  let listingLimit = 100;

  for (const arg of argv) {
    if (arg === '--apply') {
      apply = true;
      continue;
    }
    if (arg.startsWith('--after=')) {
      const value = arg.slice('--after='.length).trim();
      afterListingId = value.length === 0 ? null : value;
      continue;
    }
    if (arg.startsWith('--limit=')) {
      const value = Number.parseInt(arg.slice('--limit='.length), 10);
      // A silently-defaulted limit is how a pass meant to touch ten listings
      // touches the catalogue. Refuse rather than fall back.
      if (!Number.isInteger(value) || value <= 0) {
        throw new Error(`--limit must be a positive integer; got "${arg}".`);
      }
      listingLimit = value;
      continue;
    }
    if (arg === '--dry-run') {
      // Accepted and redundant, because a reader who types it should not be
      // told it is an unknown flag — the default IS a dry run.
      continue;
    }
    throw new Error(`Unrecognized argument "${arg}".`);
  }

  return { apply, afterListingId, listingLimit };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const db = await connectPostgres();

  const report = await runVariantAxisBackfill(db, {
    mode: args.apply ? 'apply' : 'dry_run',
    afterListingId: args.afterListingId,
    listingLimit: args.listingLimit,
  });

  // Printed as one JSON object rather than prose, so a caller can loop on
  // `resumeAfterListingId` and an operator can diff two passes.
  process.stdout.write(`${JSON.stringify({ ...report, hasMore: report.resumeAfterListingId !== null }, null, 2)}\n`);

  log.general.info(
    {
      mode: report.mode,
      listings: report.scanned.listings,
      unresolved: report.unresolved.total,
      withheld: report.assignments.withheld,
      resumeAfterListingId: report.resumeAfterListingId,
    },
    'Variant-axis backfill pass complete',
  );

  if (report.diagnostics.listingsWithIndistinguishableVariants > 0) {
    log.general.warn(
      { listings: report.diagnostics.listingsWithIndistinguishableVariants },
      'Listings left untyped because two of their variants resolved to one signature. ' +
        'Their claims are recorded; the duplicate is in the merchant data.',
    );
  }
}

main()
  .then(async () => {
    await closePostgres();
    process.exit(0);
  })
  .catch(async (err) => {
    log.general.error({ err }, 'Variant-axis backfill failed');
    try {
      await closePostgres();
    } catch (closeErr) {
      log.general.error(
        { err: closeErr },
        'Failed to close the Postgres pool after a backfill error',
      );
    }
    process.exit(1);
  });
