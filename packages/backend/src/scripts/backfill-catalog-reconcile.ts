/**
 * Compare the legacy catalogue reads against the new ones (#367 workstream 13).
 *
 * Run from `packages/backend`:
 *
 *   DATABASE_URL=… bun src/scripts/backfill-catalog-reconcile.ts
 *   DATABASE_URL=… bun src/scripts/backfill-catalog-reconcile.ts --limit=500 --categories=250
 *   DATABASE_URL=… bun src/scripts/backfill-catalog-reconcile.ts --after=<listingId>
 *   DATABASE_URL=… bun src/scripts/backfill-catalog-reconcile.ts --cohort=category:<categoryId>
 *
 * ## This is the gate a cutover is decided on, so it may not report zero cheaply
 *
 * Three probes, each comparing a v1 read contract ADR 0007 D13 retains against
 * the authority it projects. Each carries its own vacuity floor: a probe that
 * examined nothing reports perfect agreement, and `diverged: 0` off an empty
 * scan is exactly the number that gets quoted in a rollout decision.
 *
 * Reads only, in every probe. A reconciliation that repaired what it found would
 * be a second writer racing the first and would destroy the evidence of how far
 * the two reads had drifted — #60's consistency sweep makes the same choice for
 * the same reason. The repair for the one drift that IS repairable is
 * `backfill-catalog-paths.ts`.
 *
 * A non-zero `diverged` is not a failing exit code. It is a finding, and what to
 * do about it depends on which probe found it: `listing_category_path_projection`
 * and `category_browse_count_agreement` are the same drift seen from two sides
 * and are repaired by the path pass; `category_is_active_projection` is a second
 * writer of `categories` and is a code fix, not a data fix.
 */

import { closePostgres, connectPostgres } from '../db/postgres.js';
import { log } from '../lib/logger.js';
import { parseCohortArgument } from '../services/catalog-backfill/cohort-argument.js';
import { ALL_COHORT, cohortLabel, type BackfillCohort } from '../services/backfill/cohort.js';
import { runLegacyCatalogReconciliation } from '../services/catalog-backfill/reconciliation.service.js';

/** The parsed command line. */
interface Args {
  readonly cohort: BackfillCohort;
  readonly afterListingId: string | null;
  readonly listingLimit: number;
  readonly categoryLimit: number;
}

function parseArgs(argv: readonly string[]): Args {
  let cohort: BackfillCohort = ALL_COHORT;
  let afterListingId: string | null = null;
  let listingLimit = 200;
  let categoryLimit = 100;

  const positiveInteger = (arg: string, prefix: string): number => {
    const value = Number.parseInt(arg.slice(prefix.length), 10);
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error(`${prefix.replace(/=$/u, '')} must be a positive integer; got "${arg}".`);
    }
    return value;
  };

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
      listingLimit = positiveInteger(arg, '--limit=');
      continue;
    }
    if (arg.startsWith('--categories=')) {
      categoryLimit = positiveInteger(arg, '--categories=');
      continue;
    }
    throw new Error(`Unrecognized argument "${arg}".`);
  }

  return { cohort, afterListingId, listingLimit, categoryLimit };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const db = await connectPostgres();

  const report = await runLegacyCatalogReconciliation(db, {
    cohort: args.cohort,
    afterListingId: args.afterListingId,
    listingLimit: args.listingLimit,
    categoryLimit: args.categoryLimit,
  });

  process.stdout.write(
    `${JSON.stringify({ ...report, hasMore: report.resumeAfterListingId !== null }, null, 2)}\n`,
  );

  for (const probe of report.probes) {
    if (probe.diverged === 0) continue;
    log.general.warn(
      { probe: probe.probe, examined: probe.examined, diverged: probe.diverged, sample: probe.sample },
      'Legacy and new reads disagree',
    );
  }

  log.general.info(
    {
      cohort: cohortLabel(args.cohort),
      classifierVersion: report.classifierVersion,
      // The examined counts, always — a report of three probes that all found
      // nothing wrong is only meaningful beside how much each of them looked at.
      examined: Object.fromEntries(report.probes.map((probe) => [probe.probe, probe.examined])),
      resumeAfterListingId: report.resumeAfterListingId,
    },
    'Legacy catalogue reconciliation pass complete',
  );
}

main()
  .then(async () => {
    await closePostgres();
    process.exit(0);
  })
  .catch(async (err) => {
    log.general.error({ err }, 'Legacy catalogue reconciliation failed');
    try {
      await closePostgres();
    } catch (closeErr) {
      log.general.error(
        { err: closeErr },
        'Failed to close the Postgres pool after a reconciliation error',
      );
    }
    process.exit(1);
  });
