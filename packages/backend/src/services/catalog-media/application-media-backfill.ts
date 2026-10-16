import { createHash } from 'node:crypto';
import { isOxyFileId } from '@mercaria/shared-types';
import {
  applyApplicationMediaFile,
  findApplicationMediaPage,
  type ApplicationMediaRow,
  type ApplicationMediaTarget,
} from '../../db/oxyFiles/applicationMediaRepository.js';
import { getDb, type Database } from '../../db/postgres.js';
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
 *   ADR 0041): Oxy imports the file's own public URL as the application's.
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
 * Bring the application's media under the application's ownership (Oxy ADR 0041
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
