import { closePostgres, connectPostgres } from '../db/postgres.js';
import {
  backfillDigitalAssetStorage,
  type AssetStorageBackfillOptions,
} from '../services/digital/asset-storage-backfill.js';

/**
 * Move digital deliverables onto application-owned PRIVATE Oxy files (Oxy ADR
 * 0041). Read-only preview by default; `--apply` copies and moves. Reports carry
 * hashes of storage keys, never the keys. From the repo root with Bun:
 *
 *   bun run packages/backend/src/scripts/backfill-digital-asset-storage.ts --limit=50
 */
async function main() {
  const options: AssetStorageBackfillOptions = { mode: 'preview', limit: 100 };
  for (const arg of process.argv.slice(2)) {
    if (arg === '--apply') options.mode = 'apply';
    else if (arg === '--preview') options.mode = 'preview';
    else if (/^--limit=\d+$/.test(arg)) options.limit = Number(arg.slice(8));
    else if (/^--after=[A-Za-z0-9_-]+$/.test(arg)) options.after = arg.slice(8);
    else if (/^--file=[A-Za-z0-9_-]+$/.test(arg)) options.fileId = arg.slice(7);
    else throw new Error('Unknown or invalid digital-asset storage backfill argument.');
  }
  const db = await connectPostgres();
  const report = await backfillDigitalAssetStorage(options, db);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.retryFileIds.length) process.exitCode = 1;
}

main()
  .catch(() => {
    // Never print an error that could carry a storage key or a minted URL.
    process.stderr.write(
      'Digital asset storage backfill failed. Check arguments and database availability.\n',
    );
    process.exitCode = 1;
  })
  .finally(closePostgres);
