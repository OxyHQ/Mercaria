import { closePostgres, connectPostgres } from '../db/postgres.js';
import {
  backfillListingMedia,
  type MediaBackfillOptions,
} from '../services/catalog-media/backfill.js';

/** Read-only preview by default. Execute from the repo root with Bun. */
async function main() {
  const options: MediaBackfillOptions = { mode: 'preview', limit: 100 };
  for (const arg of process.argv.slice(2)) {
    if (arg === '--apply') options.mode = 'apply';
    else if (arg === '--preview') options.mode = 'preview';
    else if (/^--limit=\d+$/.test(arg)) options.limit = Number(arg.slice(8));
    else if (/^--after=[A-Za-z0-9_-]+$/.test(arg)) options.after = arg.slice(8);
    else if (/^--listing=[A-Za-z0-9_-]+$/.test(arg)) options.listingId = arg.slice(10);
    else throw new Error('Unknown or invalid media-backfill argument.');
  }
  const db = await connectPostgres();
  const report = await backfillListingMedia(options, db);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.retryListingIds.length) process.exitCode = 1;
}

main()
  .catch(() => {
    // Do not print database errors containing the source URL/credentials.
    process.stderr.write('Media backfill failed. Check arguments and database availability.\n');
    process.exitCode = 1;
  })
  .finally(closePostgres);
