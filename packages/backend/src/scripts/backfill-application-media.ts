import type { ApplicationMediaTarget } from '../db/oxyFiles/applicationMediaRepository.js';
import { closePostgres, connectPostgres } from '../db/postgres.js';
import {
  APPLICATION_MEDIA_TARGETS,
  backfillApplicationMedia,
  backfillCanonicalDescriptionImages,
  backfillCanonicalImageDuplicates,
  backfillCanonicalSourceMediaQueue,
  type ApplicationMediaBackfillOptions,
} from '../services/catalog-media/application-media-backfill.js';

/**
 * Mercaria-application media (Oxy ADR 0043). Read-only preview by default;
 * `--apply` acts. Run per target, from the repo root with Bun:
 *
 * - `canonical_image`, `category_image`, `brand_logo` — import a legacy URL or
 *   adopt an account-owned file as the application's;
 * - `canonical_description_image` — adopt the images of canonical descriptions;
 * - `canonical_image_duplicates` — collapse rows the old identity bug duplicated;
 * - `source_media` — queue the imagery of source links made before migration 0173.
 *
 *
 *   bun run packages/backend/src/scripts/backfill-application-media.ts --target=category_image
 */
const EXTRA_TARGETS = [
  'canonical_description_image',
  'canonical_image_duplicates',
  'source_media',
] as const;

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
  const db = await connectPostgres();
  let report: { retryIds: readonly string[] };
  if (target === 'canonical_description_image')
    report = await backfillCanonicalDescriptionImages(options, db);
  else if (target === 'canonical_image_duplicates')
    report = await backfillCanonicalImageDuplicates(options, db);
  else if (target === 'source_media') report = await backfillCanonicalSourceMediaQueue(options, db);
  else if (target && (APPLICATION_MEDIA_TARGETS as readonly string[]).includes(target)) {
    options.target = target as ApplicationMediaTarget;
    report = await backfillApplicationMedia(options, db);
  } else
    throw new Error(
      `Name a --target: ${[...APPLICATION_MEDIA_TARGETS, ...EXTRA_TARGETS].join(', ')}.`,
    );
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
