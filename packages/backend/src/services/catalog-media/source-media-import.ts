/**
 * Copy an attached observation's imagery into the canonical catalogue.
 *
 * The owner's decision: Mercaria shows external imagery — eBay, Awin, the
 * open-data and Shopify-storefront readers, every feed — by COPYING it into
 * files the Mercaria application owns (Oxy ADR 0043), never by hotlinking. When
 * an observation is attached to a canonical product (the source-link trigger of
 * migration `0173` queues it), this drains the queue: each HTTPS reference in
 * the observation's stored `payload.media` is imported through the one adapter
 * and attached as a `canonical_images` row with `source_url` and
 * `source_record_id` as provenance. Search, merchant pages, product and offer
 * cards already show a product's canonical images, so nothing else changes.
 *
 * The source's rights (`may_display_media`, `may_store`) are not consulted:
 * the owner chose to copy regardless, and the observation the rows cite IS the
 * provenance an operator reads. `docs/catalog-sources/` records which sources'
 * terms restrict caching.
 *
 * ## Bounded, so a million-offer feed cannot stampede Oxy
 *
 * - per task, `sourceMediaBatchSize` jobs per `sourceMediaPollIntervalMs`;
 * - across ALL tasks, at most `sourceMediaMaxInFlight` jobs held at once;
 * - per observation, at most `sourceMediaMaxPerRecord` images;
 * - per product, nothing once it shows `sourceMediaMaxPerProduct` images — the
 *   cap that makes a popular product's thousandth offer cost one read;
 * - a URL the product already holds is never imported again (identity is the
 *   source URL), and Oxy itself answers a repeated (owner, URL) without a fetch.
 */

import { randomUUID } from 'node:crypto';
import { isOxyFileId } from '@mercaria/shared-types';
import { config } from '../../config/index.js';
import { log } from '../../lib/logger.js';
import { getDb } from '../../db/postgres.js';
import {
  attachCanonicalMediaBySource,
  findCanonicalProductMediaFileIdsBySource,
} from '../../db/canonical/attributeRepository.js';
import { findCanonicalProductById } from '../../db/canonical/canonicalProductRepository.js';
import {
  claimCanonicalSourceMediaImports,
  completeCanonicalSourceMediaImport,
  countDisplayableProductImages,
  findSourceRecordMedia,
  lockCanonicalProductForMedia,
  nextProductImagePosition,
  releaseCanonicalSourceMediaImport,
  type CanonicalSourceMediaImportRow,
} from '../../db/canonical/sourceMediaImportRepository.js';
import { resolveCanonicalProductRow } from '../canonical/canonical-product.service.js';
import { importOxyFileFromUrl, OxyFilesError } from './oxy-files.js';
import { catalogMediaKind } from './policy.js';

export interface SourceMediaLimits {
  readonly maxPerRecord: number;
  readonly maxPerProduct: number;
}

export interface SourceMediaImportOutcome {
  readonly productId: string | null;
  /** Images attached by this job. */
  readonly attached: number;
  /** References skipped because the product already holds them. */
  readonly alreadyHeld: number;
  /** References Oxy refused for good (not an image, not reachable, refused URL). */
  readonly refused: number;
  /** Whether the product's cap stopped the import. */
  readonly capped: boolean;
}

/** An HTTPS reference without credentials, or nothing. A bare provider id is not a source. */
function importableUrl(reference: string): string | undefined {
  try {
    const url = new URL(reference);
    return url.protocol === 'https:' && !url.username && !url.password ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Oxy refused THIS source for good (the URL is refused, unreachable, not an
 * image, too large). Authorization, rate limits and server errors are not
 * this, and fail the job so it is retried with backoff.
 */
function refusedForGood(error: unknown): boolean {
  return (
    error instanceof OxyFilesError &&
    error.status !== undefined &&
    error.status >= 400 &&
    error.status < 500 &&
    ![401, 403, 408, 429].includes(error.status)
  );
}

/** Run ONE job. Throws when Oxy could not answer, so the job is retried. */
export async function importSourceMediaForProduct(
  job: Pick<CanonicalSourceMediaImportRow, 'canonicalProductId' | 'sourceRecordId'>,
  limits: SourceMediaLimits,
): Promise<SourceMediaImportOutcome> {
  const db = getDb();
  const loaded = await findCanonicalProductById(db, job.canonicalProductId);
  if (!loaded) return { productId: null, attached: 0, alreadyHeld: 0, refused: 0, capped: false };
  // A merge moved the observation's product: its imagery belongs to the winner.
  const product = await resolveCanonicalProductRow(db, loaded);

  const sources = [
    ...new Set(
      (await findSourceRecordMedia(job.sourceRecordId, db))
        .map(importableUrl)
        .filter((url): url is string => url !== undefined),
    ),
  ].slice(0, limits.maxPerRecord);
  const held = await findCanonicalProductMediaFileIdsBySource(db, product.id);
  const pending = sources.filter((url) => !held.has(url));
  const shown = await countDisplayableProductImages(product.id, db);
  const room = Math.max(0, limits.maxPerProduct - shown);
  const toImport = pending.slice(0, room);

  const imported: { sourceUrl: string; fileId: string }[] = [];
  let refused = 0;
  for (const sourceUrl of toImport) {
    try {
      const stored = await importOxyFileFromUrl({ kind: 'application' }, sourceUrl);
      if (
        stored.visibility !== 'public' ||
        !isOxyFileId(stored.fileId) ||
        catalogMediaKind(stored.mime, stored.size) !== 'image'
      ) {
        refused += 1;
        continue;
      }
      imported.push({ sourceUrl, fileId: stored.fileId });
    } catch (error) {
      if (refusedForGood(error)) {
        refused += 1;
        continue;
      }
      throw error;
    }
  }

  let attached = 0;
  if (imported.length > 0) {
    await db.transaction(async (tx) => {
      if (!(await lockCanonicalProductForMedia(product.id, tx))) return;
      // Re-read inside the lock: another job or an observation may have filled
      // the product meanwhile. The cap holds at write time, not just at read.
      const showing = await countDisplayableProductImages(product.id, tx);
      let capacity = Math.max(0, limits.maxPerProduct - showing);
      let position = await nextProductImagePosition(product.id, tx);
      for (const image of imported) {
        if (capacity < 1) break;
        const row = await attachCanonicalMediaBySource(tx, {
          kind: 'image',
          grain: { kind: 'product', id: product.id },
          sourceRecordId: job.sourceRecordId,
          fileId: image.fileId,
          sourceUrl: image.sourceUrl,
          position,
        });
        if (row) {
          attached += 1;
          capacity -= 1;
          position += 1;
        }
      }
    });
  }
  return {
    productId: product.id,
    attached,
    alreadyHeld: sources.length - pending.length,
    refused,
    capped: pending.length > room,
  };
}

/** Capped exponential backoff: 1m, 2m, 4m … at most six hours. */
export function sourceMediaBackoffMs(attempts: number): number {
  return Math.min(6 * 60 * 60_000, 60_000 * 2 ** Math.max(0, attempts - 1));
}

/** One drain: claim within the global cap, run each job, complete or release. */
export async function drainCanonicalSourceMediaImports(options: {
  leaseOwner: string;
  batchSize: number;
  maxInFlight: number;
  maxAttempts: number;
  limits: SourceMediaLimits;
  now?: () => Date;
  onlyProductIds?: readonly string[];
}): Promise<{ completed: number; failed: number; attached: number }> {
  const now = options.now ?? (() => new Date());
  const jobs = await claimCanonicalSourceMediaImports({
    leaseOwner: options.leaseOwner,
    batchSize: options.batchSize,
    maxInFlight: options.maxInFlight,
    now: now(),
    ...(options.onlyProductIds === undefined ? {} : { onlyProductIds: options.onlyProductIds }),
  });
  let completed = 0;
  let failed = 0;
  let attached = 0;
  for (const job of jobs) {
    try {
      const outcome = await importSourceMediaForProduct(job, options.limits);
      attached += outcome.attached;
      if (await completeCanonicalSourceMediaImport(job.id, options.leaseOwner, now()))
        completed += 1;
    } catch (error) {
      failed += 1;
      const message = error instanceof Error ? error.message : 'Source media import failed.';
      await releaseCanonicalSourceMediaImport({
        id: job.id,
        leaseOwner: options.leaseOwner,
        deadLettered: job.attempts >= options.maxAttempts,
        availableAt: new Date(now().getTime() + sourceMediaBackoffMs(job.attempts)),
        error: message,
        now: now(),
      });
    }
  }
  return { completed, failed, attached };
}

let timer: NodeJS.Timeout | undefined;
let running = false;
const leaseOwner = `canonical-source-media:${randomUUID()}`;

/**
 * Begin draining on EVERY task (claims are leases; the in-flight cap is
 * global). The LOOP is gated by `CANONICAL_SOURCE_MEDIA_IMPORT_ENABLED`; the
 * trigger queues whatever it says. Idempotent.
 */
export function startCanonicalSourceMediaImports(): void {
  if (timer !== undefined) return;
  const settings = config.oxyFiles;
  if (!settings.sourceMediaImportEnabled) {
    log.general.info(
      '[OxyFiles] source media import disabled; attachments queue and drain once enabled',
    );
    return;
  }
  timer = setInterval(() => {
    if (running) return;
    running = true;
    void drainCanonicalSourceMediaImports({
      leaseOwner,
      batchSize: settings.sourceMediaBatchSize,
      maxInFlight: settings.sourceMediaMaxInFlight,
      maxAttempts: settings.sourceMediaMaxAttempts,
      limits: {
        maxPerRecord: settings.sourceMediaMaxPerRecord,
        maxPerProduct: settings.sourceMediaMaxPerProduct,
      },
    })
      .then((result) => {
        if (result.completed > 0 || result.failed > 0)
          log.general.debug(result, '[OxyFiles] source media imports drained');
      })
      .catch((error: unknown) =>
        log.general.error({ err: error }, '[OxyFiles] source media drain failed'),
      )
      .finally(() => {
        running = false;
      });
  }, settings.sourceMediaPollIntervalMs);
  timer.unref?.();
  log.general.info(
    { batchSize: settings.sourceMediaBatchSize, maxInFlight: settings.sourceMediaMaxInFlight },
    '[OxyFiles] source media import started',
  );
}

export function stopCanonicalSourceMediaImports(): void {
  if (timer !== undefined) {
    clearInterval(timer);
    timer = undefined;
  }
}
