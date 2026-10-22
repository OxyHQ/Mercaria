/**
 * THE adapter between Mercaria and Oxy Files (Oxy ADR 0043). Every call Mercaria
 * makes about a file's bytes, owner or usage goes through this module and only
 * this module, so a name that changes upstream is a change to one file.
 *
 * - **Import by URL** (D7): Oxy downloads a source with its own SSRF-safe
 *   fetcher and remembers it per (owner, URL), so importing an unchanged source
 *   again returns the same file without a download. Mercaria no longer fetches
 *   supplier bytes at all.
 * - **Upload** of bytes Mercaria already holds (a merchant's upload), and the
 *   resumable multipart upload of a private deliverable of any type up to 8 GiB.
 * - **Client-driven upload**: the same multipart protocol with the bytes on the
 *   CLIENT, which PUTs presigned parts to storage itself (a feed file).
 * - **Adoption** (stage 4b): the application's OWN file of a file it can read,
 *   sharing the stored bytes — a creator's deliverable, without a download.
 * - **References** (D4/D6): the application's own record of which entity uses
 *   which file. The application is always the service token's; nothing here
 *   names it.
 * - **Event signatures** (D9).
 *
 * Two owners exist (`OxyFileOwner`): an ACCOUNT — a store's media belongs to
 * `stores.oxy_account_id`, a P2P listing's to its seller — imported acting as
 * that account; and the Mercaria APPLICATION, for content no account owns
 * (canonical catalogue media, category art, brand logos, digital deliverables —
 * the last PRIVATE: readable by no person, only by Mercaria's service token
 * through `linkedDownloadUrls`, ADR 0043 D3).
 *
 * Errors never carry a source URL, a signed query or a token: a supplier URL is
 * routinely a capability, and these messages reach sync-run rows and logs.
 *
 * ## Oxy's per-application rate limit (429)
 *
 * Oxy budgets an application's writes per minute: imports, uploads and
 * adoptions of APPLICATION files share one bucket of 30 a minute
 * (`appFileUploadLimiter`); an account's imports and uploads share another of
 * 30 (`cacheUploadLimiter`); references ride the 240-a-minute manage bucket.
 * Every Mercaria process shares those buckets. A refusal is HTTP 429 naming the
 * wait — the `Retry-After` header, repeated in the body as
 * `details.retryAfterSeconds` because the SDK hands the body, not the headers,
 * to its error. {@link withOxyRateLimitRetry} honours it (or backs off with
 * jitter when Oxy names none) and retries the SAME call a bounded number of
 * times within a bounded total wait, then surfaces the refusal as before.
 *
 * Retrying a refused call is safe for a reason stronger than idempotency: Oxy
 * answers 429 from the limiter, BEFORE the route runs, so the refused request
 * did nothing (a SOURCE's own 429 reaches Mercaria as Oxy's 502, never as 429).
 * Each retried call is also idempotent should a later attempt race an earlier
 * one: an import answers the same file per (owner, URL), an upload and an
 * adoption the same file per (owner, bytes), a large upload resumes, and a
 * reference add answers `exists` / a remove `not_found`. Not retried: the
 * reconciliation (its inventory is a single-use stream; its loop retries in 30
 * minutes), and the download mint and the delete (a buyer's request, an
 * operator's action — neither should wait out a minute).
 *
 * ## The application's own files are remembered
 *
 * Every file Oxy answers as the APPLICATION's is recorded in
 * `oxy_application_files` (best effort: a lost record costs one idempotent call
 * later). Here, because this is the one place every such answer passes, so no
 * writer can forget it. The maintenance backfills read it to skip a row whose
 * file is already the application's — asking Oxy again would answer the same
 * file and still spend a unit of the 30-a-minute budget.
 */

import {
  OxyApiError,
  type ServiceFileReference,
  type ServiceFileReferenceResult,
  type ServiceReferenceInventoryItem,
  type ServiceReferenceReconcileResult,
} from '@oxy.so/core';
import {
  FileEventVerificationError,
  LargeUploadFailedError,
  verifyFileEventSignature,
  type FileEvent,
  type OxyServer,
} from '@oxy.so/core/server';
import { isOxyFileId } from '@mercaria/shared-types';
import { oxyServiceClient } from '../../capabilities/oxy-service-client.js';
import { recordApplicationFiles } from '../../db/oxyFiles/applicationFileRepository.js';
import { log } from '../../lib/logger.js';

/** One minted private download (the SDK does not export the type by name). */
export type ServiceLinkedDownloadUrl = Awaited<
  ReturnType<OxyServer['assets']['linkedDownloadUrls']>
>[number];

/** Who a stored file belongs to (ADR 0043 D1). */
export type OxyFileOwner =
  | { readonly kind: 'account'; readonly oxyUserId: string }
  | { readonly kind: 'application' };

/** What Oxy says it stored. Validated before it leaves this module. */
export interface StoredOxyFile {
  readonly fileId: string;
  readonly mime: string;
  readonly size: number;
  readonly visibility: string;
}

/** A refusal or failure of an Oxy Files call. The message is safe to store. */
export class OxyFilesError extends Error {
  readonly status: number | undefined;
  /** For a 429: the wait Oxy named when the last attempt was refused, in ms. */
  readonly retryAfterMs: number | undefined;
  constructor(message: string, status?: number, retryAfterMs?: number) {
    super(message);
    this.name = 'OxyFilesError';
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

const UPLOAD_TIMEOUT_MS = 25_000;

function client(): OxyServer {
  const configured = oxyServiceClient();
  if (!configured) throw new OxyFilesError('Oxy Files needs Mercaria application credentials.');
  return configured;
}

function statusOf(error: unknown): number | undefined {
  if (error instanceof OxyApiError) return error.status;
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === 'number' ? status : undefined;
}

/** Whether Oxy refused this call for its rate limit, here or behind a wrapping error's `cause`. */
export function isOxyRateLimited(error: unknown): boolean {
  for (let current = error, depth = 0; current && depth < 5; depth += 1) {
    if (statusOf(current) === 429) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/** How long and how often a call Oxy refused for its rate limit is tried again. */
export interface OxyRateLimitPolicy {
  /** Calls in all, the first included. */
  readonly maxAttempts: number;
  /** Total time spent waiting; a wait that would pass it is not started. */
  readonly maxTotalWaitMs: number;
  /** First backoff when Oxy names no wait; it doubles, capped by `maxDelayMs`. */
  readonly fallbackBaseMs: number;
  readonly maxDelayMs: number;
}

/**
 * Work no person waits on — imports, adoptions, large uploads, backfills, the
 * source-media and connector loops. Oxy's window is a minute, so two waits of
 * up to a minute each reach the next window even after a busy one.
 */
export const BACKGROUND_RATE_LIMIT: OxyRateLimitPolicy = {
  maxAttempts: 3,
  maxTotalWaitMs: 120_000,
  fallbackBaseMs: 15_000,
  maxDelayMs: 60_000,
};

/**
 * A merchant's upload request: worth a short wait (an editor dropping forty
 * photos at once crosses 30 a minute), never one an HTTP request cannot outlast.
 */
export const INTERACTIVE_RATE_LIMIT: OxyRateLimitPolicy = {
  maxAttempts: 3,
  maxTotalWaitMs: 20_000,
  fallbackBaseMs: 2_000,
  maxDelayMs: 10_000,
};

/**
 * Reference registration: inside the reference outbox's two-minute lease, so a
 * retried batch finishes before another task may reclaim it. The manage bucket
 * is 240 a minute; a refusal there is rare and short.
 */
export const REFERENCE_RATE_LIMIT: OxyRateLimitPolicy = {
  maxAttempts: 3,
  maxTotalWaitMs: 30_000,
  fallbackBaseMs: 5_000,
  maxDelayMs: 20_000,
};

/** Spread added to a wait Oxy named, so tasks refused together do not return together. */
const NAMED_WAIT_JITTER_MS = 1_000;

/**
 * A `Retry-After` value in milliseconds: delta-seconds (`"30"`, or a number) or
 * an HTTP-date (`"Wed, 21 Oct 2026 07:28:00 GMT"`, measured from `nowMs`; one
 * already past is 0). Anything else is `undefined` — no wait was named.
 */
export function parseRetryAfterMs(value: unknown, nowMs: number): number | undefined {
  if (typeof value === 'number')
    return Number.isFinite(value) && value >= 0 ? Math.ceil(value * 1000) : undefined;
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (text === '') return undefined;
  if (/^\d+(?:\.\d+)?$/.test(text)) return Math.ceil(Number(text) * 1000);
  // An HTTP-date names a weekday and a zone; a bare number never reaches here.
  if (!/[a-z]/i.test(text)) return undefined;
  const at = Date.parse(text);
  return Number.isNaN(at) ? undefined : Math.max(0, at - nowMs);
}

function headerOf(headers: unknown, name: string): unknown {
  if (!headers || typeof headers !== 'object') return undefined;
  const get = (headers as { get?: unknown }).get;
  if (typeof get === 'function') return get.call(headers, name) ?? undefined;
  const record = headers as Record<string, unknown>;
  const key = Object.keys(record).find((candidate) => candidate.toLowerCase() === name);
  return key === undefined ? undefined : record[key];
}

/**
 * The wait Oxy named for a 429, in milliseconds, wherever the error carries it:
 * a `Retry-After` header when the transport kept one, else the API envelope's
 * `details.retryAfterSeconds` (Oxy's `RateLimitedError`; the SDK keeps the body
 * as `details` and `response.data`, not the headers).
 */
export function retryAfterMsOf(error: unknown, nowMs: number): number | undefined {
  const failure = (error ?? {}) as {
    details?: { retryAfterSeconds?: unknown };
    response?: {
      headers?: unknown;
      data?: {
        details?: { retryAfterSeconds?: unknown };
        error?: { details?: { retryAfterSeconds?: unknown } };
      };
    };
  };
  const candidates = [
    headerOf(failure.response?.headers, 'retry-after'),
    failure.details?.retryAfterSeconds,
    failure.response?.data?.details?.retryAfterSeconds,
    failure.response?.data?.error?.details?.retryAfterSeconds,
  ];
  for (const candidate of candidates) {
    const ms = parseRetryAfterMs(candidate, nowMs);
    if (ms !== undefined) return ms;
  }
  return undefined;
}

/**
 * How long to wait after the `failures`-th refusal: what Oxy named plus up to a
 * second of jitter, or — when it named nothing — a backoff doubling from
 * `fallbackBaseMs`, capped at `maxDelayMs`, with half of it jittered.
 */
export function rateLimitDelayMs(
  error: unknown,
  failures: number,
  policy: OxyRateLimitPolicy,
  nowMs: number,
  random: () => number = Math.random,
): number {
  const named = retryAfterMsOf(error, nowMs);
  if (named !== undefined) return named + Math.floor(random() * NAMED_WAIT_JITTER_MS);
  const ceiling = Math.min(
    policy.maxDelayMs,
    policy.fallbackBaseMs * 2 ** Math.max(0, failures - 1),
  );
  return Math.floor(ceiling / 2 + (random() * ceiling) / 2);
}

/**
 * Run `call`, and when Oxy refuses it for its rate limit, wait and run it again
 * — at most `policy.maxAttempts` calls and `policy.maxTotalWaitMs` of waiting.
 * A wait that would pass the total is not started: the refusal is thrown at
 * once (a caller with a queue re-queues it sooner than a sleep would end).
 * Anything but a 429 is thrown untouched on the first attempt.
 */
export async function withOxyRateLimitRetry<T>(
  call: () => Promise<T>,
  policy: OxyRateLimitPolicy = BACKGROUND_RATE_LIMIT,
): Promise<T> {
  let waited = 0;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await call();
    } catch (error) {
      if (statusOf(error) !== 429 || attempt >= policy.maxAttempts) throw error;
      const delay = rateLimitDelayMs(error, attempt, policy, Date.now());
      if (waited + delay > policy.maxTotalWaitMs) throw error;
      waited += delay;
      log.general.warn(
        { attempt, delayMs: delay },
        '[OxyFiles] Oxy rate-limited the call; waiting before trying again',
      );
      await new Promise<void>((resolve) => setTimeout(resolve, delay));
    }
  }
}

/** Remember files Oxy answered as the application's (best effort; see module doc). */
async function rememberApplicationFile(...fileIds: string[]): Promise<void> {
  if (fileIds.length === 0) return;
  try {
    await recordApplicationFiles(fileIds);
  } catch (error) {
    log.general.debug({ err: error }, '[OxyFiles] could not record an application file');
  }
}

function refusal(action: string, error: unknown): OxyFilesError {
  const status = statusOf(error);
  if (status === 401 || status === 403)
    return new OxyFilesError(`Oxy has not authorized Mercaria to ${action}.`, status);
  if (status !== undefined)
    return new OxyFilesError(
      `Oxy could not ${action} (HTTP ${status}).`,
      status,
      status === 429 ? retryAfterMsOf(error, Date.now()) : undefined,
    );
  return new OxyFilesError(`Oxy could not ${action}.`);
}

/**
 * The stored file out of an Oxy answer, whatever envelope it came in (`{ file }`
 * or the file itself). Everything a caller relies on is checked here, so a
 * changed wire shape is a named refusal and never an `undefined` file id
 * written into a gallery.
 */
function storedFile(answer: unknown): StoredOxyFile {
  const envelope = (answer ?? {}) as { file?: unknown };
  const file = (envelope.file ?? answer) as {
    id?: unknown;
    mime?: unknown;
    size?: unknown;
    visibility?: unknown;
  };
  if (
    !isOxyFileId(file?.id) ||
    typeof file.mime !== 'string' ||
    typeof file.size !== 'number' ||
    !Number.isSafeInteger(file.size) ||
    file.size <= 0 ||
    typeof file.visibility !== 'string'
  ) {
    throw new OxyFilesError('Oxy did not describe the stored file.');
  }
  return { fileId: file.id, mime: file.mime, size: file.size, visibility: file.visibility };
}

/**
 * Import a public HTTPS source as a PUBLIC file of `owner` (ADR 0043 D7).
 *
 * Oxy fetches it (HTTPS on every hop, public addresses only, bounded bytes and
 * time) and keeps `(owner, URL) → file`, so a repeat of an unchanged URL answers
 * the same file without downloading — which is what ends the connector's
 * re-upload of every gallery on every product update. A changed source is
 * fetched again only when `revalidate` asks for it.
 *
 * No reference is registered here (the SDK's `reference` option is not used):
 * the row that will hold the file is not written yet, and registering before
 * it commits would keep the file alive for a write that may roll back. The
 * reference outbox registers it after commit; an application file whose write
 * failed is unreferenced and Oxy collects it — the outcome wanted.
 *
 * `importAppFile` / `importUserMedia` (`@oxy.so/core` 4.18.0, Oxy ADR 0043):
 * `POST /assets/service/app/import`, and `/assets/service/user-media/import`
 * owned by the `x-owner-user-id` header.
 */
export async function importOxyFileFromUrl(
  owner: OxyFileOwner,
  sourceUrl: string,
  options: { revalidate?: boolean } = {},
): Promise<StoredOxyFile> {
  if (owner.kind === 'account' && !owner.oxyUserId)
    throw new OxyFilesError('An account-owned import needs its owner.');
  const oxy = client();
  const revalidate = options.revalidate ? { revalidate: true } : {};
  let answer: unknown;
  try {
    // Retried on 429: Oxy answers the same file per (owner, URL).
    answer = await withOxyRateLimitRetry<unknown>(() =>
      owner.kind === 'application'
        ? oxy.assets.importAppFile(sourceUrl, { visibility: 'public', ...revalidate })
        : oxy.assets.importUserMedia(owner.oxyUserId, sourceUrl, {
            visibility: 'public',
            ...revalidate,
          }),
    );
  } catch (error) {
    throw refusal('import the media source', error);
  }
  const stored = storedFile(answer);
  if (owner.kind === 'application') await rememberApplicationFile(stored.fileId);
  return stored;
}

/** Oxy's bound on one batch import request — and one unit of its rate limit. */
export const OXY_IMPORT_BATCH_SIZE = 50;

/** One source's answer in a batch import, in the order the sources were given. */
export type ApplicationImportResult =
  | { readonly ok: true; readonly file: StoredOxyFile; readonly error?: undefined }
  | { readonly ok: false; readonly error: OxyFilesError; readonly file?: undefined };

/**
 * Import many public HTTPS sources as PUBLIC files of the Mercaria APPLICATION
 * (`importAppFiles`, `POST /assets/service/app/import/batch`): up to
 * {@link OXY_IMPORT_BATCH_SIZE} per request, and a request is ONE unit of Oxy's
 * 30-a-minute application budget however many sources it carries — where a
 * single import is one unit per source. Oxy runs the items four at a time and
 * answers each on its own, with the same (owner, URL) deduplication as
 * {@link importOxyFileFromUrl}.
 *
 * The answer has one result per source, in order (a repeated source shares its
 * result). Nothing is thrown for a source: an item Oxy refused is an
 * `OxyFilesError` carrying its status; an item still being fetched (a large
 * source answered `pending`) is a status-less failure, retried by the caller's
 * own retry. Each REQUEST is retried on 429 like every import (a refused batch
 * did nothing; a repeated item answers the same file). A request that still
 * fails marks its sources — and those of the requests not yet sent, which
 * would only be refused the same way — with that failure, so a caller can tell
 * Oxy's rate limit (`isOxyRateLimited`) from a refusal and keep what earlier
 * requests imported. Only missing credentials throw.
 *
 * There is no account-owned twin: Oxy has no batch route for
 * `/assets/service/user-media/import`, so a store's or seller's sources are
 * imported one call each.
 */
export async function importApplicationFilesFromUrls(
  sourceUrls: readonly string[],
): Promise<ApplicationImportResult[]> {
  const oxy = client();
  const distinct = [...new Set(sourceUrls)];
  const answers = new Map<string, ApplicationImportResult>();
  let failure: OxyFilesError | undefined;
  for (let start = 0; start < distinct.length; start += OXY_IMPORT_BATCH_SIZE) {
    const chunk = distinct.slice(start, start + OXY_IMPORT_BATCH_SIZE);
    if (failure) {
      for (const url of chunk) answers.set(url, { ok: false, error: failure });
      continue;
    }
    let results: Awaited<ReturnType<OxyServer['assets']['importAppFiles']>>;
    try {
      results = await withOxyRateLimitRetry(() =>
        oxy.assets.importAppFiles(
          chunk.map((sourceUrl) => ({ sourceUrl, visibility: 'public' as const })),
        ),
      );
    } catch (error) {
      failure = refusal('import the media source', error);
      for (const url of chunk) answers.set(url, { ok: false, error: failure });
      continue;
    }
    const byIndex = new Map(results.map((result) => [result.index, result]));
    chunk.forEach((url, index) => {
      const result = byIndex.get(index);
      if (!result) {
        answers.set(url, {
          ok: false,
          error: new OxyFilesError('Oxy did not answer for the media source.'),
        });
      } else if (result.ok === false) {
        answers.set(url, { ok: false, error: refusal('import the media source', result.error) });
      } else if ((result as { pending?: unknown }).pending === true) {
        answers.set(url, {
          ok: false,
          error: new OxyFilesError('Oxy is still fetching the media source.'),
        });
      } else {
        try {
          answers.set(url, { ok: true, file: storedFile(result) });
        } catch (error) {
          answers.set(url, {
            ok: false,
            error:
              error instanceof OxyFilesError
                ? error
                : new OxyFilesError('Oxy did not describe the stored file.'),
          });
        }
      }
    });
  }
  const stored = [...answers.values()].flatMap((answer) => (answer.ok ? [answer.file.fileId] : []));
  await rememberApplicationFile(...stored);
  return sourceUrls.map(
    (url) => answers.get(url) ?? { ok: false, error: new OxyFilesError('Oxy did not answer.') },
  );
}

/**
 * Store bytes Mercaria already holds as a PUBLIC file of `owner`: a merchant's
 * upload through `POST /admin/stores/:storeId/products/media` (account), or an
 * application asset. Oxy deduplicates per (owner, bytes).
 */
export async function uploadOxyFile(
  owner: OxyFileOwner,
  bytes: Buffer | Uint8Array,
  mime: string,
  originalName: string,
): Promise<StoredOxyFile> {
  if (owner.kind === 'account' && !owner.oxyUserId)
    throw new OxyFilesError('An account-owned upload needs its owner.');
  const oxy = client();
  const body = new Uint8Array(bytes);
  try {
    // Retried on 429, briefly (a merchant waits on this): Oxy answers the same
    // file per (owner, bytes), and the bytes are held here to send again.
    if (owner.kind === 'application') {
      const uploaded = storedFile(
        await withOxyRateLimitRetry(
          () =>
            oxy.assets.uploadAppFile(body, mime, {
              visibility: 'public',
              originalName,
              timeout: UPLOAD_TIMEOUT_MS,
            }),
          INTERACTIVE_RATE_LIMIT,
        ),
      );
      await rememberApplicationFile(uploaded.fileId);
      return uploaded;
    }
    return storedFile(
      await withOxyRateLimitRetry(
        () =>
          oxy.assets.uploadUserMedia(owner.oxyUserId, body, mime, {
            originalName,
            timeout: UPLOAD_TIMEOUT_MS,
          }),
        INTERACTIVE_RATE_LIMIT,
      ),
    );
  } catch (error) {
    if (error instanceof OxyFilesError) throw error;
    throw refusal('store the media', error);
  }
}

/**
 * Store bytes this process holds as a PRIVATE file of the Mercaria APPLICATION
 * (ADR 0043 stage 4b, `uploadAppFileLarge`): any type Oxy does not refuse as
 * executable or active content (HTML, SVG, XML, scripts — 415), up to 8 GiB, by
 * a resumable multipart upload whose parts go straight to storage. Oxy hashes
 * the assembled object before it becomes a file, and the SDK hashes the source
 * 8 MiB at a time, so neither side holds the whole file in memory. Calling again
 * for the same bytes resumes an interrupted upload (and an already-stored copy
 * answers at once, deduplicated).
 *
 * No reference is registered here: the caller registers the use under the id
 * this returns, which it does not know before.
 */
export async function uploadPrivateApplicationFile(
  source: Blob,
  mime: string,
  options: { filename: string; metadata?: Readonly<Record<string, string>> },
): Promise<StoredOxyFile> {
  const oxy = client();
  let answer: unknown;
  try {
    // Retried on 429: calling again for the same bytes RESUMES the upload (only
    // the parts storage lacks are sent), and stored bytes answer at once.
    answer = await withOxyRateLimitRetry(() =>
      oxy.assets.uploadAppFileLarge(source, {
        mime,
        visibility: 'private',
        filename: options.filename,
        ...(options.metadata ? { metadata: { ...options.metadata } } : {}),
      }),
    );
  } catch (error) {
    if (error instanceof LargeUploadFailedError)
      throw new OxyFilesError(`Oxy did not store the upload (${error.code}).`);
    throw refusal('store the file', error);
  }
  const stored = storedFile(answer);
  await rememberApplicationFile(stored.fileId);
  return stored;
}

/** One presigned part URL: the client PUTs exactly `size` bytes to `url`. */
export interface ClientUploadPart {
  readonly partNumber: number;
  readonly url: string;
  readonly size: number;
}

/** The file a client-driven upload became, as storage measured it. */
export interface ClientUploadedFile {
  readonly fileId: string;
  readonly size: number;
  readonly sha256: string;
}

/**
 * Where a client-driven upload stands (Oxy ADR 0043 stage 4b), parsed into a
 * closed shape before it leaves this module.
 *
 * - `uploading`: parts are owed; `parts` carries URLs for some of the missing
 *   ones (at most 100 a call), `uploadedParts` what storage already holds.
 * - `verifying`: storage is hashing the assembled object; ask again.
 * - `completed`: a file. `deduplicated` means NOTHING was uploaded — the
 *   application already held these bytes.
 * - `incomplete`: a completion found parts missing or mis-sized; the upload
 *   stays open and the client sends them.
 * - `failed`: terminal, with storage's own code (`CHECKSUM_MISMATCH`,
 *   `SIZE_MISMATCH`, `CONTENT_BLOCKED`, `EXPIRED`, …).
 */
export type ClientUploadState =
  | {
      readonly kind: 'uploading';
      readonly uploadId: string;
      readonly partSize: number;
      readonly partCount: number;
      readonly expiresAt: string | null;
      readonly parts: readonly ClientUploadPart[];
      readonly uploadedParts: readonly number[];
    }
  | { readonly kind: 'verifying'; readonly uploadId: string }
  | {
      readonly kind: 'completed';
      readonly uploadId: string | null;
      readonly file: ClientUploadedFile;
      readonly deduplicated: boolean;
    }
  | { readonly kind: 'incomplete'; readonly uploadId: string }
  | {
      readonly kind: 'failed';
      readonly uploadId: string | null;
      readonly code: string;
    };

const APP_UPLOADS = '/assets/service/app/uploads';

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function clientUploadState(answer: unknown): ClientUploadState {
  const view = (answer ?? {}) as {
    uploadId?: unknown;
    status?: unknown;
    partSize?: unknown;
    partCount?: unknown;
    expiresAt?: unknown;
    parts?: unknown;
    uploadedParts?: unknown;
    file?: { id?: unknown; size?: unknown; sha256?: unknown };
    deduplicated?: unknown;
    error?: { code?: unknown };
  };
  const uploadId = typeof view.uploadId === 'string' && view.uploadId !== '' ? view.uploadId : null;
  switch (view.status) {
    case 'uploading': {
      if (!uploadId || !positiveInteger(view.partSize) || !positiveInteger(view.partCount))
        throw new OxyFilesError('Oxy did not describe the upload.');
      return {
        kind: 'uploading',
        uploadId,
        partSize: view.partSize,
        partCount: view.partCount,
        expiresAt: typeof view.expiresAt === 'string' ? view.expiresAt : null,
        parts: uploadParts(view.parts),
        uploadedParts: Array.isArray(view.uploadedParts)
          ? view.uploadedParts.flatMap((part: { partNumber?: unknown }) =>
              positiveInteger(part?.partNumber) ? [part.partNumber] : [],
            )
          : [],
      };
    }
    case 'verifying':
      if (!uploadId) throw new OxyFilesError('Oxy did not describe the upload.');
      return { kind: 'verifying', uploadId };
    case 'completed': {
      const file = view.file;
      const sha256 = typeof file?.sha256 === 'string' ? file.sha256.toLowerCase() : '';
      if (!isOxyFileId(file?.id) || !positiveInteger(file?.size) || !/^[0-9a-f]{64}$/.test(sha256))
        throw new OxyFilesError('Oxy did not describe the stored file.');
      return {
        kind: 'completed',
        uploadId,
        file: { fileId: file.id, size: file.size, sha256 },
        deduplicated: view.deduplicated === true,
      };
    }
    case 'failed':
    case 'aborted':
      return {
        kind: 'failed',
        uploadId,
        code: typeof view.error?.code === 'string' ? view.error.code : 'UPLOAD_FAILED',
      };
    default:
      throw new OxyFilesError('Oxy did not describe the upload.');
  }
}

function uploadParts(value: unknown): ClientUploadPart[] {
  if (!Array.isArray(value)) return [];
  return value.map((part: { partNumber?: unknown; url?: unknown; size?: unknown }) => {
    if (
      !positiveInteger(part?.partNumber) ||
      !positiveInteger(part?.size) ||
      typeof part?.url !== 'string' ||
      !part.url.startsWith('https://')
    )
      throw new OxyFilesError('Oxy did not describe the upload parts.');
    return { partNumber: part.partNumber, url: part.url, size: part.size };
  });
}

/** `/assets/service/app/uploads/:uploadId`, with the id escaped. */
function appUploadPath(uploadId: string, suffix = ''): string {
  return `${APP_UPLOADS}/${encodeURIComponent(uploadId)}${suffix}`;
}

/**
 * Open (or resume) an upload whose bytes a CLIENT sends straight to storage, of
 * a PRIVATE file the Mercaria application will own (`POST
 * /assets/service/app/uploads`). The SDK's `uploadAppFileLarge` runs the whole
 * protocol with bytes this process holds; here the bytes are the client's, so
 * Mercaria drives only the API half and hands the presigned part URLs on. No
 * byte passes through Mercaria or Oxy's API on the way in.
 *
 * `mime` and `filename` are Mercaria's own labels, never the client's: storage
 * refuses active documents (XML among them) by type AND by extension, and a feed
 * is data to be parsed, never served. Storage answers bytes the application
 * already holds at once (`completed`, `deduplicated`) — see
 * `feed_upload_sessions` for why that answer is not trusted on its own.
 */
export async function openClientUpload(input: {
  sha256: string;
  size: number;
  mime: string;
  filename: string;
}): Promise<ClientUploadState> {
  const oxy = client();
  try {
    // Retried on 429: opening the same bytes again answers the same session.
    const answer = await withOxyRateLimitRetry(
      () =>
        oxy.serviceRequest<unknown>(
          'POST',
          APP_UPLOADS,
          {
            sha256: input.sha256,
            size: input.size,
            mime: input.mime,
            filename: input.filename,
            visibility: 'private',
          },
          { cache: false },
        ),
      INTERACTIVE_RATE_LIMIT,
    );
    const state = clientUploadState(answer);
    if (state.kind === 'completed') await rememberApplicationFile(state.file.fileId);
    return state;
  } catch (error) {
    if (error instanceof OxyFilesError) throw error;
    throw refusal('open the upload', error);
  }
}

/** Presigned URLs for these parts (1–100 of them), valid an hour. */
export async function clientUploadPartUrls(
  uploadId: string,
  partNumbers: readonly number[],
): Promise<readonly ClientUploadPart[]> {
  const oxy = client();
  try {
    const answer = await withOxyRateLimitRetry(
      () =>
        oxy.serviceRequest<{ parts?: unknown }>(
          'POST',
          appUploadPath(uploadId, '/parts'),
          { partNumbers: [...partNumbers] },
          { cache: false },
        ),
      INTERACTIVE_RATE_LIMIT,
    );
    return uploadParts(answer?.parts);
  } catch (error) {
    if (error instanceof OxyFilesError) throw error;
    throw refusal('sign the upload parts', error);
  }
}

/** Where a client-driven upload stands now. */
export async function describeClientUpload(uploadId: string): Promise<ClientUploadState> {
  const oxy = client();
  try {
    const answer = await withOxyRateLimitRetry(
      () =>
        oxy.serviceRequest<unknown>('GET', appUploadPath(uploadId), undefined, { cache: false }),
      INTERACTIVE_RATE_LIMIT,
    );
    const state = clientUploadState(answer);
    if (state.kind === 'completed') await rememberApplicationFile(state.file.fileId);
    return state;
  } catch (error) {
    if (error instanceof OxyFilesError) throw error;
    throw refusal('read the upload', error);
  }
}

/** Storage's own terminal codes for a completion, answered as values rather than thrown. */
const TERMINAL_COMPLETION_STATUSES = new Set([410, 413, 415, 422, 451]);

/**
 * Assemble the parts and VERIFY: only bytes that hash to the declared SHA-256
 * become a file. `verifying` when storage needs longer (ask again with
 * {@link describeClientUpload}); `incomplete` when parts are missing; `failed`
 * with storage's own code for a terminal refusal. Idempotent.
 */
export async function completeClientUpload(uploadId: string): Promise<ClientUploadState> {
  const oxy = client();
  try {
    const answer = await withOxyRateLimitRetry(
      () =>
        oxy.serviceRequest<unknown>('POST', appUploadPath(uploadId, '/complete'), undefined, {
          cache: false,
        }),
      INTERACTIVE_RATE_LIMIT,
    );
    const state = clientUploadState(answer);
    if (state.kind === 'completed') await rememberApplicationFile(state.file.fileId);
    return state;
  } catch (error) {
    if (error instanceof OxyFilesError) throw error;
    const status = statusOf(error);
    if (status === 409) return { kind: 'incomplete', uploadId };
    if (status !== undefined && TERMINAL_COMPLETION_STATUSES.has(status)) {
      const code = error instanceof OxyApiError && error.code ? error.code : 'UPLOAD_FAILED';
      return { kind: 'failed', uploadId, code };
    }
    throw refusal('complete the upload', error);
  }
}

/**
 * Give the Mercaria APPLICATION its own PRIVATE file of the bytes `fileId`
 * holds (ADR 0043 stage 4b, `adoptAppFile`): the stored object is SHARED, never
 * downloaded or uploaded again, and the copy outlives the source, whose owner
 * may delete theirs. Oxy answers for a file this application can read — a
 * person's private file its owner attached to Mercaria (ADR 0021), any public
 * or unlisted file, or Mercaria's own (answered as it is) — and 404 otherwise;
 * taken-down bytes are 451. Private is the narrowest visibility, so the
 * "wider than the source" refusal cannot apply. Idempotent per (application,
 * bytes).
 *
 * No reference is registered here, for the same reason as the upload.
 */
export async function adoptAsPrivateApplicationFile(
  fileId: string,
): Promise<StoredOxyFile & { sha256: string }> {
  const oxy = client();
  let answer: Awaited<ReturnType<OxyServer['assets']['adoptAppFile']>>;
  try {
    // Retried on 429: adoption is idempotent per (application, bytes).
    answer = await withOxyRateLimitRetry(() =>
      oxy.assets.adoptAppFile(fileId, { visibility: 'private' }),
    );
  } catch (error) {
    throw refusal('adopt the file', error);
  }
  const stored = storedFile(answer);
  const sha256 = typeof answer?.file?.sha256 === 'string' ? answer.file.sha256.toLowerCase() : '';
  if (!/^[0-9a-f]{64}$/.test(sha256))
    throw new OxyFilesError('Oxy did not describe the stored file.');
  await rememberApplicationFile(stored.fileId);
  return { ...stored, sha256 };
}

/** Register Mercaria's use of files (`files:references:write`). Per-item results. */
export async function addOxyFileReferences(
  references: readonly ServiceFileReference[],
): Promise<ServiceFileReferenceResult[]> {
  if (references.length === 0) return [];
  try {
    // Retried on 429: adding a held reference answers `exists`.
    const oxy = client();
    return await withOxyRateLimitRetry(
      () => oxy.assets.references.add([...references]),
      REFERENCE_RATE_LIMIT,
    );
  } catch (error) {
    if (error instanceof OxyFilesError) throw error;
    throw refusal('register file references', error);
  }
}

/** Withdraw Mercaria's use of files. Never trashes or deletes a file. */
export async function removeOxyFileReferences(
  references: readonly ServiceFileReference[],
): Promise<ServiceFileReferenceResult[]> {
  if (references.length === 0) return [];
  try {
    // Retried on 429: removing a withdrawn reference answers `not_found`.
    const oxy = client();
    return await withOxyRateLimitRetry(
      () => oxy.assets.references.remove([...references]),
      REFERENCE_RATE_LIMIT,
    );
  } catch (error) {
    if (error instanceof OxyFilesError) throw error;
    throw refusal('remove file references', error);
  }
}

/**
 * Send Oxy the whole inventory of one entity type (ADR 0043 D6): Oxy adds the
 * references it is missing and removes the ones created before the run began
 * that the inventory does not list. `dryRun` only counts.
 *
 * NOT retried on 429: `items` is a stream that may be read only once, and the
 * reconciliation loop already retries a failed run in 30 minutes.
 */
export async function reconcileOxyFileReferences(
  entityType: string,
  items: AsyncIterable<ServiceReferenceInventoryItem>,
  options: { dryRun: boolean },
): Promise<ServiceReferenceReconcileResult> {
  try {
    return await client().assets.references.reconcile(entityType, items, {
      dryRun: options.dryRun,
    });
  } catch (error) {
    if (error instanceof OxyFilesError) throw error;
    throw refusal('reconcile file references', error);
  }
}

/** The file event Mercaria reads, or the endpoint challenge to echo. */
export type VerifiedOxyFileDelivery =
  | { readonly kind: 'challenge'; readonly challenge: string }
  | { readonly kind: 'event'; readonly event: FileEvent }
  | { readonly kind: 'refused'; readonly reason: string };

/**
 * Verify one delivery to the file-events endpoint (ADR 0043 D9): HMAC-SHA256
 * over `<t>.<raw body>` in `oxy-signature`, `t` within five minutes, compared
 * in constant time — Oxy's own verifier, so there is one. A
 * `webhook.challenge` is returned WITHOUT a signature check: Oxy sends it when
 * the endpoint is set, before the secret has been shown to anybody.
 */
export function verifyOxyFileDelivery(
  rawBody: Buffer,
  headers: Record<string, string | string[] | undefined>,
  secret: string,
): VerifiedOxyFileDelivery {
  try {
    const verified = verifyFileEventSignature(rawBody, headers, secret);
    return verified.type === 'webhook.challenge'
      ? { kind: 'challenge', challenge: verified.challenge }
      : { kind: 'event', event: verified };
  } catch (error) {
    if (error instanceof FileEventVerificationError)
      return { kind: 'refused', reason: error.message };
    throw error;
  }
}

/**
 * Mint short-lived download URLs for files this application may read
 * privately: its OWN files (ADR 0043 D3 — an application-owned private
 * deliverable) and a person's file that person attached to it (ADR 0021).
 * Absence is a refusal, not a fact about the file. A failure THROWS; each URL is
 * a live credential and is never logged.
 */
export async function mintPrivateDownloadUrls(
  fileIds: readonly string[],
): Promise<ServiceLinkedDownloadUrl[]> {
  if (fileIds.length === 0) return [];
  try {
    return await client().assets.linkedDownloadUrls([...fileIds]);
  } catch (error) {
    if (error instanceof OxyFilesError) throw error;
    throw refusal('mint a download URL', error);
  }
}

/** Delete one of this application's own files (`files:app:delete`). */
export async function deleteApplicationFile(fileId: string): Promise<void> {
  try {
    await client().assets.deleteAppFile(fileId);
  } catch (error) {
    if (error instanceof OxyFilesError) throw error;
    throw refusal('delete the file', error);
  }
}
