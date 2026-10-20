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
  findImagelessProductSourceLinksPage,
  requestCanonicalSourceMediaImport,
} from '../../db/canonical/sourceMediaImportRepository.js';
import { findApplicationFileIds } from '../../db/oxyFiles/applicationFileRepository.js';
import { descriptionImageFileIds, withDescriptionImagesReplaced } from './description.js';
import { importApplicationFilesFromUrls, OxyFilesError } from './oxy-files.js';
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
  const work: Array<{ row: ApplicationMediaRow; source: string; entry: (typeof entries)[number] }> =
    [];
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
    work.push({ row, source, entry });
  }
  // One Oxy request per 50 rows — one unit of its 30-a-minute budget each —
  // instead of one per row. Each row still gets its own answer and its own
  // compare-and-swap.
  const results = work.length
    ? await importApplicationFilesFromUrls(work.map((item) => item.source))
    : [];
  for (const [index, { row, entry }] of work.entries()) {
    const result = results[index];
    try {
      if (!result) throw new OxyFilesError('Oxy did not answer for the media source.');
      if (result.ok === false) throw result.error;
      const stored = result.file;
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
 *
 * Only images Oxy has not answered as the application's are asked about
 * (`oxy_application_files`), and a description with none left is not reported:
 * asking again would answer the same file and spend a unit of Oxy's
 * 30-a-minute budget for nothing. The file ids are inside HTML, so the page is
 * filtered here rather than in SQL; the cursor still advances over it.
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
  const page = rows.slice(0, options.limit);
  const owned = await findApplicationFileIds(
    page.flatMap((row) => descriptionImageFileIds(row.description)),
    db,
  );
  const work: Array<{
    row: (typeof page)[number];
    fileIds: string[];
    entry: (typeof entries)[number];
  }> = [];
  for (const row of page) {
    const all = descriptionImageFileIds(row.description);
    const fileIds = all.filter((fileId) => !owned.has(fileId));
    // Every image is already the application's: nothing to do, nothing to report.
    if (all.length > 0 && fileIds.length === 0) continue;
    const entry: (typeof entries)[number] = {
      id: row.id,
      images: fileIds.map((fileId) => createHash('sha256').update(fileId).digest('hex')),
      outcome: fileIds.length === 0 ? 'skipped' : 'pending',
    };
    entries.push(entry);
    if (fileIds.length === 0 || options.mode === 'preview') continue;
    work.push({ row, fileIds, entry });
  }
  // Every description's images in one batch (one Oxy budget unit per 50).
  const urlOf = new Map<string, string>();
  for (const { fileIds } of work)
    for (const fileId of fileIds) {
      const url = resolveMedia(fileId);
      if (url) urlOf.set(fileId, url);
    }
  const sources = [...new Set(urlOf.values())];
  const results = sources.length ? await importApplicationFilesFromUrls(sources) : [];
  const resultOf = new Map(sources.map((url, index) => [url, results[index]]));
  for (const { row, fileIds, entry } of work) {
    try {
      const replacements = new Map<string, string>();
      for (const fileId of fileIds) {
        const url = urlOf.get(fileId);
        if (!url) continue;
        const result = resultOf.get(url);
        if (!result) throw new OxyFilesError('Oxy did not answer for the media source.');
        if (result.ok === false) throw result.error;
        const stored = result.file;
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
 * Queue the imagery of every ACTIVE source link made before migration `0173`'s
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
    /** `not_queued`: already queued, or the product came to hold its images since the page was read. */
    outcome: 'pending' | 'queued' | 'not_queued';
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
        : 'not_queued';
  }
  return {
    target: 'source_media' as const,
    mode: options.mode,
    entries,
    resumeAfterId: links.length > options.limit ? links[options.limit - 1]?.linkId : null,
    retryIds: [] as string[],
  };
}

/**
 * Queue ONE observation — the newest that names media — for each product that
 * shows no image, by product id (`--after` is a product id). The product cards
 * that are blank today, at the head of the queue (priority 0), without the ~7
 * jobs per product `source_media` would queue for all their links.
 */
export async function backfillImagelessProductSourceMedia(
  options: { mode: 'preview' | 'apply'; limit: number; after?: string },
  db: Database = getDb(),
) {
  assertBounds(options);
  const links = await findImagelessProductSourceLinksPage(
    { ...options, limit: options.limit + 1 },
    db,
  );
  const entries: Array<{
    linkId: string;
    productId: string;
    sourceRecordId: string;
    /** `not_queued`: already queued, or the product came to hold the images since. */
    outcome: 'pending' | 'queued' | 'not_queued';
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
        : 'not_queued';
  }
  return {
    target: 'source_media_imageless' as const,
    mode: options.mode,
    entries,
    resumeAfterId: links.length > options.limit ? links[options.limit - 1]?.productId : null,
    retryIds: [] as string[],
  };
}
