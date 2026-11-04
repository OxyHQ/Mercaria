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
 *
 * ## Paced under Oxy's budget, and deferred — never failed — past it
 *
 * Oxy allows the application 30 import, upload and adoption REQUESTS a minute
 * across every Mercaria process, and a batch request (`importAppFiles`) carries
 * up to 50 sources for one unit. So a drain asks for ALL its claimed jobs'
 * sources together: at the defaults (5 jobs × 6 images per 10 s poll) one
 * request per drain — 6 a minute, up to 180 images — where one import per image
 * would have been 180 requests. Each task also starts at most
 * `sourceMediaMaxImportCallsPerMinute` (10) requests in any minute
 * ({@link SourceMediaImportPacer}), the bound for a faster poll or a bigger
 * batch. A job whose sources the pace or Oxy's 429 (after the adapter's own
 * bounded retries) left unasked is DEFERRED: what was stored is attached, and
 * the job goes back to `pending` for when the budget returns with its attempt
 * REFUNDED, so a busy Oxy never dead-letters it.
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
import {
  type ApplicationImportResult,
  importApplicationFilesFromUrls,
  isOxyRateLimited,
  OXY_IMPORT_BATCH_SIZE,
  OxyFilesError,
} from './oxy-files.js';
import { catalogMediaKind } from './policy.js';
import { importableMediaUrl } from './source-media-urls.js';

export interface SourceMediaLimits {
  readonly maxPerRecord: number;
  readonly maxPerProduct: number;
}

/** A minute: Oxy's rate-limit window, and the wait when Oxy names none. */
const RATE_WINDOW_MS = 60_000;

/**
 * At most `maxPerMinute` Oxy import REQUESTS started in any rolling minute, per
 * process — Oxy charges its budget per request, and one batch request carries
 * up to 50 sources. `take` claims one now or answers how long until one is free.
 */
export class SourceMediaImportPacer {
  private readonly started: number[] = [];
  constructor(
    private readonly maxPerMinute: number,
    private readonly now: () => number = Date.now,
  ) {}

  take(): { ok: true } | { ok: false; waitMs: number } {
    const at = this.now();
    while (this.started.length > 0 && (this.started[0] ?? 0) <= at - RATE_WINDOW_MS)
      this.started.shift();
    if (this.started.length < this.maxPerMinute) {
      this.started.push(at);
      return { ok: true };
    }
    return { ok: false, waitMs: (this.started[0] ?? at) + RATE_WINDOW_MS - at };
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

/** What one job will ask Oxy for, read before any request. */
interface SourceMediaPlan {
  /** The (merge-resolved) product, or `null` when it no longer exists. */
  readonly productId: string | null;
  readonly sourceRecordId: string;
  /** The HTTPS sources the product does not hold yet, within its room. */
  readonly toImport: readonly string[];
}

async function planSourceMediaJob(
  job: Pick<CanonicalSourceMediaImportRow, 'canonicalProductId' | 'sourceRecordId'>,
  limits: SourceMediaLimits,
): Promise<SourceMediaPlan> {
  const db = getDb();
  const loaded = await findCanonicalProductById(db, job.canonicalProductId);
  if (!loaded) return { productId: null, sourceRecordId: job.sourceRecordId, toImport: [] };
  // A merge moved the observation's product: its imagery belongs to the winner.
  const product = await resolveCanonicalProductRow(db, loaded);
  const sources = [
    ...new Set(
      (await findSourceRecordMedia(job.sourceRecordId, db))
        .map(importableMediaUrl)
        .filter((url): url is string => url !== undefined),
    ),
  ].slice(0, limits.maxPerRecord);
  const held = await findCanonicalProductMediaFileIdsBySource(db, product.id);
  const pending = sources.filter((url) => !held.has(url));
  const shown = await countDisplayableProductImages(product.id, db);
  const room = Math.max(0, limits.maxPerProduct - shown);
  return {
    productId: product.id,
    sourceRecordId: job.sourceRecordId,
    toImport: pending.slice(0, room),
  };
}

/**
 * Ask Oxy for every source of a drain in batch requests of
 * {@link OXY_IMPORT_BATCH_SIZE} — one unit of its budget per request, where one
 * import per image spent one per image — each request under the task's pace.
 * Stops at the pace, or at a request Oxy still refuses for its rate limit after
 * the adapter's own bounded retries, answering how long until asking again;
 * sources not answered by then are simply absent from the map.
 */
async function importSources(
  sources: readonly string[],
  pacer: SourceMediaImportPacer | undefined,
): Promise<{ answers: Map<string, ApplicationImportResult>; deferredMs?: number }> {
  const answers = new Map<string, ApplicationImportResult>();
  for (let start = 0; start < sources.length; start += OXY_IMPORT_BATCH_SIZE) {
    const turn = pacer?.take();
    if (turn?.ok === false) return { answers, deferredMs: turn.waitMs };
    const chunk = sources.slice(start, start + OXY_IMPORT_BATCH_SIZE);
    const results = await importApplicationFilesFromUrls(chunk);
    let limited: OxyFilesError | undefined;
    chunk.forEach((url, index) => {
      const result = results[index];
      if (!result) return;
      if (result.ok === false && isOxyRateLimited(result.error)) limited = result.error;
      else answers.set(url, result);
    });
    if (limited) return { answers, deferredMs: limited.retryAfterMs ?? RATE_WINDOW_MS };
  }
  return { answers };
}

/** What became of one job's sources once Oxy answered (or did not). */
interface SourceMediaSettlement {
  readonly imported: { sourceUrl: string; fileId: string }[];
  readonly refused: number;
  /** A source Oxy could not answer for a reason worth a retry with backoff. */
  readonly transient?: OxyFilesError;
  /** A source not asked (or rate-limited): the job is deferred, not failed. */
  readonly unanswered: boolean;
}

function settle(
  plan: SourceMediaPlan,
  answers: ReadonlyMap<string, ApplicationImportResult>,
): SourceMediaSettlement {
  const imported: { sourceUrl: string; fileId: string }[] = [];
  let refused = 0;
  let transient: OxyFilesError | undefined;
  let unanswered = false;
  for (const sourceUrl of plan.toImport) {
    const answer = answers.get(sourceUrl);
    if (!answer) {
      unanswered = true;
    } else if (answer.ok === false) {
      if (refusedForGood(answer.error)) refused += 1;
      else transient ??= answer.error;
    } else if (
      answer.file.visibility !== 'public' ||
      !isOxyFileId(answer.file.fileId) ||
      catalogMediaKind(answer.file.mime, answer.file.size) !== 'image'
    ) {
      refused += 1;
    } else {
      imported.push({ sourceUrl, fileId: answer.file.fileId });
    }
  }
  return { imported, refused, unanswered, ...(transient ? { transient } : {}) };
}

/** Attach what Oxy stored to the product, under its lock and within its cap. */
async function attachSourceMedia(
  plan: SourceMediaPlan,
  imported: readonly { sourceUrl: string; fileId: string }[],
  limits: SourceMediaLimits,
): Promise<number> {
  const productId = plan.productId;
  if (productId === null || imported.length === 0) return 0;
  let attached = 0;
  await getDb().transaction(async (tx) => {
    if (!(await lockCanonicalProductForMedia(productId, tx))) return;
    // Re-read inside the lock: another job or an observation may have filled
    // the product meanwhile. The cap holds at write time, not just at read.
    const showing = await countDisplayableProductImages(productId, tx);
    let capacity = Math.max(0, limits.maxPerProduct - showing);
    let position = await nextProductImagePosition(productId, tx);
    for (const image of imported) {
      if (capacity < 1) break;
      const row = await attachCanonicalMediaBySource(tx, {
        kind: 'image',
        grain: { kind: 'product', id: productId },
        sourceRecordId: plan.sourceRecordId,
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
  return attached;
}

/** Capped exponential backoff: 1m, 2m, 4m … at most six hours. */
export function sourceMediaBackoffMs(attempts: number): number {
  return Math.min(6 * 60 * 60_000, 60_000 * 2 ** Math.max(0, attempts - 1));
}

/** The least a deferred job waits: Oxy's window turns over, a pace frees up. */
const MIN_DEFER_MS = 5_000;

/**
 * One drain: claim within the global cap, plan every job, ask Oxy for ALL their
 * sources together in batch requests (`importSources`), then per job attach
 * what was stored and complete, defer or release it.
 *
 * - every source answered → completed (refusals for good are skipped);
 * - a source Oxy could not answer (5xx, still fetching, unauthorized) →
 *   released with backoff, the attempt counted, after attaching the rest — the
 *   next try skips what the product now holds;
 * - a source not asked because of the pace or Oxy's rate limit → DEFERRED with
 *   the attempt refunded, after attaching what was stored.
 */
export async function drainCanonicalSourceMediaImports(options: {
  leaseOwner: string;
  batchSize: number;
  maxInFlight: number;
  maxAttempts: number;
  limits: SourceMediaLimits;
  pacer?: SourceMediaImportPacer;
  now?: () => Date;
  onlyProductIds?: readonly string[];
}): Promise<{ completed: number; failed: number; deferred: number; attached: number }> {
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
  let deferred = 0;
  let attached = 0;
  const fail = async (job: CanonicalSourceMediaImportRow, error: unknown) => {
    failed += 1;
    await releaseCanonicalSourceMediaImport({
      id: job.id,
      leaseOwner: options.leaseOwner,
      deadLettered: job.attempts >= options.maxAttempts,
      availableAt: new Date(now().getTime() + sourceMediaBackoffMs(job.attempts)),
      error: error instanceof Error ? error.message : 'Source media import failed.',
      now: now(),
    });
  };

  const planned: { job: CanonicalSourceMediaImportRow; plan: SourceMediaPlan }[] = [];
  for (const job of jobs) {
    try {
      planned.push({ job, plan: await planSourceMediaJob(job, options.limits) });
    } catch (error) {
      await fail(job, error);
    }
  }
  // Oldest job first (the claim's order), so a stop part-way defers the newest.
  const sources = [...new Set(planned.flatMap(({ plan }) => plan.toImport))];
  let answers = new Map<string, ApplicationImportResult>();
  let deferUntil = now();
  try {
    const asked = await importSources(sources, options.pacer);
    answers = asked.answers;
    if (asked.deferredMs !== undefined)
      deferUntil = new Date(now().getTime() + Math.max(MIN_DEFER_MS, asked.deferredMs));
  } catch (error) {
    // Only missing credentials reach here: every job fails with backoff.
    for (const { job } of planned) await fail(job, error);
    return { completed, failed, deferred, attached };
  }

  for (const { job, plan } of planned) {
    try {
      const settled = settle(plan, answers);
      attached += await attachSourceMedia(plan, settled.imported, options.limits);
      if (settled.transient) {
        await fail(job, settled.transient);
      } else if (settled.unanswered) {
        deferred += 1;
        await releaseCanonicalSourceMediaImport({
          id: job.id,
          leaseOwner: options.leaseOwner,
          deadLettered: false,
          refundAttempt: true,
          availableAt: deferUntil,
          error: "Deferred: Oxy's upload budget for Mercaria is spent; retried when it returns.",
          now: now(),
        });
      } else if (await completeCanonicalSourceMediaImport(job.id, options.leaseOwner, now())) {
        completed += 1;
      }
    } catch (error) {
      await fail(job, error);
    }
  }
  return { completed, failed, deferred, attached };
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
  // One pace per task: Oxy's budget is the application's, so the pace is what
  // this task may take of it.
  const taskPacer = new SourceMediaImportPacer(
    Math.max(1, settings.sourceMediaMaxImportCallsPerMinute),
  );
  timer = setInterval(() => {
    if (running) return;
    running = true;
    void drainCanonicalSourceMediaImports({
      leaseOwner,
      batchSize: settings.sourceMediaBatchSize,
      maxInFlight: settings.sourceMediaMaxInFlight,
      maxAttempts: settings.sourceMediaMaxAttempts,
      pacer: taskPacer,
      limits: {
        maxPerRecord: settings.sourceMediaMaxPerRecord,
        maxPerProduct: settings.sourceMediaMaxPerProduct,
      },
    })
      .then((result) => {
        if (result.completed > 0 || result.failed > 0 || result.deferred > 0)
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
    {
      batchSize: settings.sourceMediaBatchSize,
      maxInFlight: settings.sourceMediaMaxInFlight,
      maxImportCallsPerMinute: settings.sourceMediaMaxImportCallsPerMinute,
    },
    '[OxyFiles] source media import started',
  );
}

export function stopCanonicalSourceMediaImports(): void {
  if (timer !== undefined) {
    clearInterval(timer);
    timer = undefined;
  }
}
