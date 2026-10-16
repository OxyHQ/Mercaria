import { closePostgres, connectPostgres } from '../db/postgres.js';
import {
  backfillStoreArtwork,
  type StoreArtworkBackfillOptions,
} from '../services/catalog-media/store-artwork-backfill.js';

/** Store logo, cover and collection images. Read-only preview by default. */
async function main() {
  const options: StoreArtworkBackfillOptions = { mode: 'preview', limit: 100 };
  for (const arg of process.argv.slice(2)) {
    if (arg === '--apply') options.mode = 'apply';
    else if (arg === '--preview') options.mode = 'preview';
    else if (/^--limit=\d+$/.test(arg)) options.limit = Number(arg.slice(8));
    else if (/^--after=[A-Za-z0-9_-]+$/.test(arg)) options.after = arg.slice(8);
    else if (/^--store=[A-Za-z0-9_-]+$/.test(arg)) options.storeId = arg.slice(8);
    else throw new Error('Unknown or invalid store-artwork backfill argument.');
  }
  const db = await connectPostgres();
  const report = await backfillStoreArtwork(options, db);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.retryStoreIds.length) process.exitCode = 1;
}

main()
  .catch(() => {
    // Do not print database errors containing the source URL/credentials.
    process.stderr.write(
      'Store artwork backfill failed. Check arguments and database availability.\n',
    );
    process.exitCode = 1;
  })
  .finally(closePostgres);
