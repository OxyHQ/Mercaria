import type { ApplicationMediaTarget } from '../db/oxyFiles/applicationMediaRepository.js';
import { closePostgres, connectPostgres } from '../db/postgres.js';
import {
  APPLICATION_MEDIA_TARGETS,
  backfillApplicationMedia,
  type ApplicationMediaBackfillOptions,
} from '../services/catalog-media/application-media-backfill.js';

/**
 * Canonical images, category art and brand logos into files owned by the
 * Mercaria application (Oxy ADR 0041). Read-only preview by default; `--apply`
 * imports. Run per target, from the repo root with Bun:
 *
 *   bun run packages/backend/src/scripts/backfill-application-media.ts --target=category_image
 */
async function main() {
  const options: ApplicationMediaBackfillOptions = {
    target: 'canonical_image',
    mode: 'preview',
    limit: 100,
  };
  let target: string | undefined;
  for (const arg of process.argv.slice(2)) {
    if (arg === '--apply') options.mode = 'apply';
    else if (arg === '--preview') options.mode = 'preview';
    else if (/^--target=[a-z_]+$/.test(arg)) target = arg.slice(9);
    else if (/^--limit=\d+$/.test(arg)) options.limit = Number(arg.slice(8));
    else if (/^--after=[A-Za-z0-9_-]+$/.test(arg)) options.after = arg.slice(8);
    else if (/^--id=[A-Za-z0-9_-]+$/.test(arg)) options.id = arg.slice(5);
    else throw new Error('Unknown or invalid application-media backfill argument.');
  }
  if (!target || !(APPLICATION_MEDIA_TARGETS as readonly string[]).includes(target))
    throw new Error('Name a --target.');
  options.target = target as ApplicationMediaTarget;
  const db = await connectPostgres();
  const report = await backfillApplicationMedia(options, db);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.retryIds.length) process.exitCode = 1;
}

main()
  .catch(() => {
    // Do not print errors that could contain a source URL or a credential.
    process.stderr.write(
      'Application media backfill failed. Check arguments and database availability.\n',
    );
    process.exitCode = 1;
  })
  .finally(closePostgres);
