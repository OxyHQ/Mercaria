import { createHash } from 'node:crypto';
import { isOxyFileId } from '@mercaria/shared-types';
import {
  applyApplicationMediaFile,
  findApplicationMediaPage,
  type ApplicationMediaRow,
  type ApplicationMediaTarget,
} from '../../db/oxyFiles/applicationMediaRepository.js';
import { getDb, type Database } from '../../db/postgres.js';
import {
  collapseCanonicalImageDuplicates,
  findDuplicateCanonicalImageGroups,
} from '../../db/canonical/attributeRepository.js';
import {
  findCanonicalDescriptionImagePage,
  replaceCanonicalProductDescription,
} from '../../db/canonical/canonicalProductRepository.js';
import {
  findSourceLinksWithMediaPage,
  requestCanonicalSourceMediaImport,
} from '../../db/canonical/sourceMediaImportRepository.js';
import { descriptionImageFileIds, withDescriptionImagesReplaced } from './description.js';
import { importOxyFileFromUrl, OxyFilesError } from './oxy-files.js';
import { catalogMediaKind } from './policy.js';
import { resolveMedia, storedMediaFileId } from './urls.js';

export const APPLICATION_MEDIA_TARGETS = [
  'canonical_image',
  'category_image',
  'brand_logo',
] as const satisfies readonly ApplicationMediaTarget[];

export interface ApplicationMediaBackfillOptions {
  target: ApplicationMediaTarget;
  mode: 'preview' | 'apply';
  limit: number;
  after?: string;
  id?: string;
}

/**
 * - `import` — the row holds a supplier or legacy URL and no file: Oxy imports it.
 * - `adopt` — the row holds a file some ACCOUNT owns (an operator's, before
 *   ADR 0043): Oxy imports the file's own public URL as the application's.
 *   Bytes are shared by content address; the account keeps its file, now
 *   "not in use", for its owner to decide about (D5). Adopting a file the
 *   application already owns returns the same id and changes nothing.
 * - `skip` — nothing to import (a legacy URL that is neither HTTPS nor Oxy's).
 */
export type ApplicationMediaPlan = 'import' | 'adopt' | 'skip';

function planFor(row: ApplicationMediaRow): { plan: ApplicationMediaPlan; source?: string } {
  if (row.fileId !== null && isOxyFileId(row.fileId)) {
    const url = resolveMedia(row.fileId);
    return url ? { plan: 'adopt', source: url } : { plan: 'skip' };
  }
  if (row.sourceUrl !== null) {
    // Category art may already name an Oxy URL: adopt that file.
    const named = storedMediaFileId(row.sourceUrl);
    if (named) {
      const url = resolveMedia(named);
      return url ? { plan: 'adopt', source: url } : { plan: 'skip' };
    }
    try {
      const url = new URL(row.sourceUrl);
      if (url.protocol === 'https:' && !url.username && !url.password)
        return { plan: 'import', source: row.sourceUrl };
    } catch {
      // Not a URL at all: reported, never imported.
    }
  }
  return { plan: 'skip' };
}

/**
 * Bring the application's media under the application's ownership (Oxy ADR 0043
 * D1/D2): canonical images, category art and brand logos.
 *
 * A preview never imports. Reports carry a SHA-256 of the source, never the URL
 * (a supplier URL is routinely a signed capability). An apply writes a row only
 * when it still holds what the preview read; the reference triggers then
 * register the new file and withdraw the old, through the outbox.
 */
export async function backfillApplicationMedia(
  options: ApplicationMediaBackfillOptions,
  db: Database = getDb(),
) {
  if (
    !(APPLICATION_MEDIA_TARGETS as readonly string[]).includes(options.target) ||
    !['preview', 'apply'].includes(options.mode) ||
    !Number.isSafeInteger(options.limit) ||
    options.limit < 1 ||
    options.limit > 500
  ) {
    throw new Error(
      'Use a target of canonical_image, category_image or brand_logo, preview or apply, and a limit between 1 and 500.',
    );
  }
  const rows = await findApplicationMediaPage(
    options.target,
    { ...options, limit: options.limit + 1 },
    db,
  );
  const entries: Array<{
    id: string;
    plan: ApplicationMediaPlan;
    sourceSha256?: string;
    outcome: 'pending' | 'applied' | 'unchanged' | 'changed' | 'failed' | 'skipped';
    reason?: string;
  }> = [];
  for (const row of rows.slice(0, options.limit)) {
    const { plan, source } = planFor(row);
    const entry: (typeof entries)[number] = {
      id: row.id,
      plan,
      ...(source === undefined
        ? {}
        : { sourceSha256: createHash('sha256').update(source).digest('hex') }),
      outcome: plan === 'skip' ? 'skipped' : 'pending',
    };
    entries.push(entry);
    if (plan === 'skip' || options.mode === 'preview' || source === undefined) continue;
    try {
      const stored = await importOxyFileFromUrl({ kind: 'application' }, source);
      if (stored.visibility !== 'public' || catalogMediaKind(stored.mime, stored.size) !== row.kind)
        throw new OxyFilesError('Oxy did not store a public file of the expected kind.');
      if (stored.fileId === row.fileId) {
        entry.outcome = 'unchanged';
        continue;
      }
      entry.outcome = await applyApplicationMediaFile(options.target, row, stored.fileId, db);
    } catch (error) {
      entry.outcome = 'failed';
      entry.reason =
        error instanceof OxyFilesError ? error.message : 'The media import could not be committed.';
    }
  }
  return {
    target: options.target,
    mode: options.mode,
    entries,
    resumeAfterId: rows.length > options.limit ? rows[options.limit - 1]?.id : null,
    // Cursor progress is not success: changed/failed rows need an explicit retry.
    retryIds: entries
      .filter((entry) => entry.outcome === 'changed' || entry.outcome === 'failed')
      .map((entry) => entry.id),
  };
}

function assertBounds(options: { mode: string; limit: number }): void {
  if (
    !['preview', 'apply'].includes(options.mode) ||
    !Number.isSafeInteger(options.limit) ||
    options.limit < 1 ||
    options.limit > 500
  )
    throw new Error('Use preview or apply with a limit between 1 and 500.');
}

/**
 * Re-own the images of canonical DESCRIPTIONS: every `<img>` naming an Oxy file
 * is adopted by the Mercaria application (its own public URL imported as the
 * application's file; Oxy deduplicates by bytes, so a file the application
 * already owns answers itself) and the description is rewritten to the
 * application's copies — a compare-and-swap on the whole description, so an
 * edit made meanwhile wins. Localized descriptions are not walked: nothing
 * writes `canonical_product_localizations` yet (#367 L2).
 */
export async function backfillCanonicalDescriptionImages(
  options: { mode: 'preview' | 'apply'; limit: number; after?: string; id?: string },
  db: Database = getDb(),
) {
  assertBounds(options);
  const rows = await findCanonicalDescriptionImagePage(db, {
    ...options,
    limit: options.limit + 1,
  });
  const entries: Array<{
    id: string;
    images: string[];
    outcome: 'pending' | 'applied' | 'unchanged' | 'changed' | 'failed' | 'skipped';
    reason?: string;
  }> = [];
  for (const row of rows.slice(0, options.limit)) {
    const fileIds = descriptionImageFileIds(row.description);
    const entry: (typeof entries)[number] = {
      id: row.id,
      images: fileIds.map((fileId) => createHash('sha256').update(fileId).digest('hex')),
      outcome: fileIds.length === 0 ? 'skipped' : 'pending',
    };
    entries.push(entry);
    if (fileIds.length === 0 || options.mode === 'preview') continue;
    try {
      const replacements = new Map<string, string>();
      for (const fileId of fileIds) {
        const url = resolveMedia(fileId);
        if (!url) continue;
        const stored = await importOxyFileFromUrl({ kind: 'application' }, url);
        if (
          stored.visibility !== 'public' ||
          catalogMediaKind(stored.mime, stored.size) !== 'image'
        )
          throw new OxyFilesError('Oxy did not store a public image.');
        replacements.set(fileId, stored.fileId);
      }
      const next = withDescriptionImagesReplaced(row.description, replacements);
      if (next === undefined) {
        entry.outcome = 'unchanged';
        continue;
      }
      entry.outcome = (await replaceCanonicalProductDescription(db, row.id, row.description, next))
        ? 'applied'
        : 'changed';
    } catch (error) {
      entry.outcome = 'failed';
      entry.reason =
        error instanceof OxyFilesError ? error.message : 'The description could not be re-owned.';
    }
  }
  return {
    target: 'canonical_description_image' as const,
    mode: options.mode,
    entries,
    resumeAfterId: rows.length > options.limit ? rows[options.limit - 1]?.id : null,
    retryIds: entries
      .filter((entry) => entry.outcome === 'changed' || entry.outcome === 'failed')
      .map((entry) => entry.id),
  };
}

/**
 * Collapse the canonical image rows the old identity bug duplicated: per
 * (product or variant, source URL), keep one — active before suppressed, a held
 * file before none, then the oldest — carry a missing alt text over, delete the
 * rest. Reports carry the source URL's hash, never the URL.
 */
export async function backfillCanonicalImageDuplicates(
  options: { mode: 'preview' | 'apply'; limit: number; after?: string },
  db: Database = getDb(),
) {
  assertBounds(options);
  const groups = await findDuplicateCanonicalImageGroups(db, {
    ...options,
    limit: options.limit + 1,
  });
  const entries: Array<{
    survivorId: string;
    duplicateIds: string[];
    sourceSha256: string;
    outcome: 'pending' | 'applied' | 'changed';
  }> = [];
  for (const group of groups.slice(0, options.limit)) {
    const entry: (typeof entries)[number] = {
      survivorId: group.survivorId,
      duplicateIds: group.rowIds.filter((id) => id !== group.survivorId),
      sourceSha256: createHash('sha256').update(group.sourceUrl).digest('hex'),
      outcome: 'pending',
    };
    entries.push(entry);
    if (options.mode === 'apply') entry.outcome = await collapseCanonicalImageDuplicates(db, group);
  }
  return {
    target: 'canonical_image_duplicates' as const,
    mode: options.mode,
    entries,
    resumeAfterId: groups.length > options.limit ? groups[options.limit - 1]?.survivorId : null,
    retryIds: entries
      .filter((entry) => entry.outcome === 'changed')
      .map((entry) => entry.survivorId),
  };
}

/**
 * Queue the imagery of every ACTIVE source link made before migration `0171`'s
 * trigger existed (`canonical_source_media_imports`). Queuing is all it does:
 * the bounded dispatcher imports (`source-media-import.ts`), so a large catalogue
 * is drained at the dispatcher's rate, never by this command.
 */
export async function backfillCanonicalSourceMediaQueue(
  options: { mode: 'preview' | 'apply'; limit: number; after?: string },
  db: Database = getDb(),
) {
  assertBounds(options);
  const links = await findSourceLinksWithMediaPage({ ...options, limit: options.limit + 1 }, db);
  const entries: Array<{
    linkId: string;
    productId: string;
    sourceRecordId: string;
    outcome: 'pending' | 'queued' | 'already_queued';
  }> = [];
  for (const link of links.slice(0, options.limit)) {
    const entry: (typeof entries)[number] = { ...link, outcome: 'pending' };
    entries.push(entry);
    if (options.mode === 'apply')
      entry.outcome = (await requestCanonicalSourceMediaImport(
        link.productId,
        link.sourceRecordId,
        db,
      ))
        ? 'queued'
        : 'already_queued';
  }
  return {
    target: 'source_media' as const,
    mode: options.mode,
    entries,
    resumeAfterId: links.length > options.limit ? links[options.limit - 1]?.linkId : null,
    retryIds: [] as string[],
  };
}
