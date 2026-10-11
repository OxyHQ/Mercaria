/**
 * The ONE transport every open-data provider speaks through.
 *
 * Three obligations every keyless provider imposes and none should have to
 * restate: identify yourself (a contact User-Agent), do not hammer the host (a
 * per-host minimum interval, honoured across every source of the provider in
 * this process), and answer a rate limit by waiting as long as the host said.
 * A provider that wrote its own `fetch` would forget one of the three, and the
 * cost of forgetting is an IP ban that takes every provider on the same egress
 * down with it.
 *
 * Failures leave here already classified as #62's closed
 * `CatalogSourceFetchFailureKind`, so the framework's retry and health logic
 * reads them without a provider translating anything.
 *
 * Dumps are DOWNLOADED to a local cache keyed by URL and revalidated
 * conditionally, because several sources commonly read one dump — one Open
 * Prices source per retail chain all read the same `prices.jsonl.gz` — and a
 * dump fetched once per source per pass is the provider's bandwidth spent N
 * times for one answer.
 */

import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { CatalogSourceFetchError } from '../ingestion/adapter.js';

/** What a provider may ask of the transport. */
export interface OpenDataHttp {
  /**
   * GET a JSON document. `null` only when `allowNotFound` is set and the host
   * answered 404 — a POSITIVE statement that the object is gone, which a
   * targeted re-read reports as a removal.
   */
  getJson(url: string, options?: OpenDataRequestOptions): Promise<OpenDataJsonResponse | null>;
  /**
   * GET a text document (a `robots.txt`). `null` only when `allowNotFound` is
   * set and the host answered 404.
   */
  getText(url: string, options?: OpenDataRequestOptions): Promise<string | null>;
  /**
   * Make a dump available locally, downloading it only when the cached copy is
   * older than `maxAgeMs` and the host says it changed.
   */
  download(url: string, options: OpenDataDownloadOptions): Promise<OpenDataDownload>;
}

export interface OpenDataRequestOptions {
  readonly headers?: Readonly<Record<string, string>>;
  /** The host's own minimum gap between requests. Default: none. */
  readonly minIntervalMs?: number;
  readonly allowNotFound?: boolean;
  readonly signal?: AbortSignal;
}

export interface OpenDataJsonResponse {
  readonly body: unknown;
  readonly headers: Headers;
}

export interface OpenDataDownloadOptions {
  /** Serve the cached copy without asking while it is younger than this. */
  readonly maxAgeMs: number;
  /** Extra request headers — a content type the host negotiates on. */
  readonly headers?: Readonly<Record<string, string>>;
  readonly minIntervalMs?: number;
  readonly signal?: AbortSignal;
}

export interface OpenDataDownload {
  /** Absolute path of the cached bytes, exactly as the host served them. */
  readonly path: string;
  /** When Mercaria last confirmed these bytes against the host. */
  readonly confirmedAt: Date;
  /** The host's `Last-Modified`, when it sent one. */
  readonly lastModified: Date | null;
  /** sha-256 of the cached bytes — what makes two reads of one dump comparable. */
  readonly digest: string;
}

/**
 * How Mercaria identifies itself to every provider: product, version and a
 * contact, the form Open Food Facts, Scryfall and MusicBrainz ask for. A
 * constant rather than configuration, because an anonymous client is the one
 * thing those providers ban by IP, and a deployment must not be able to forget it.
 */
export const OPEN_DATA_USER_AGENT = 'Mercaria/1.0 (contact@mercaria.co; +https://mercaria.co)';

export interface OpenDataHttpOptions {
  readonly userAgent: string;
  readonly timeoutMs: number;
  readonly cacheDir: string;
  readonly maxDownloadBytes: number;
  /** Injected for tests. */
  readonly fetch?: typeof fetch;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly clock?: () => number;
}

interface CachedDumpMeta {
  readonly url: string;
  readonly etag: string | null;
  readonly lastModified: string | null;
  readonly confirmedAt: string;
  readonly digest: string;
}

/** How long a `Retry-After`-less 429 waits. Long enough not to be the next hit. */
const DEFAULT_RATE_LIMIT_BACKOFF_MS = 60_000;

export function createOpenDataHttp(options: OpenDataHttpOptions): OpenDataHttp {
  const doFetch = options.fetch ?? fetch;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const clock = options.clock ?? Date.now;
  /** host → the earliest instant the next request may leave. */
  const nextAllowed = new Map<string, number>();

  if (options.userAgent.trim().length === 0) {
    // Refused at construction rather than per request: an anonymous client is
    // the one thing every provider here bans. Reaching this is a wiring defect.
    throw new Error(
      'An open-data transport needs a User-Agent that identifies Mercaria and a contact.',
    );
  }

  async function throttle(url: string, minIntervalMs: number | undefined): Promise<void> {
    if (minIntervalMs === undefined || minIntervalMs <= 0) return;
    const host = new URL(url).host;
    const now = clock();
    const earliest = nextAllowed.get(host) ?? now;
    const leaveAt = Math.max(now, earliest);
    nextAllowed.set(host, leaveAt + minIntervalMs);
    if (leaveAt > now) await sleep(leaveAt - now);
  }

  async function send(
    url: string,
    init: { headers: Record<string, string>; signal?: AbortSignal },
  ): Promise<Response> {
    const timeout = AbortSignal.timeout(options.timeoutMs);
    const signal = init.signal === undefined ? timeout : AbortSignal.any([init.signal, timeout]);
    try {
      return await doFetch(url, {
        headers: { 'user-agent': options.userAgent, ...init.headers },
        redirect: 'follow',
        signal,
      });
    } catch (error: unknown) {
      throw new CatalogSourceFetchError(
        'source_outage',
        `The request to ${new URL(url).host} failed.`,
        {
          retryable: true,
          cause: error,
        },
      );
    }
  }

  function refuseStatus(url: string, response: Response): never {
    const host = new URL(url).host;
    if (response.status === 429) {
      throw new CatalogSourceFetchError('rate_limit', `${host} answered 429.`, {
        retryable: true,
        retryAfterMs:
          readRetryAfterMs(response.headers.get('retry-after'), clock()) ??
          DEFAULT_RATE_LIMIT_BACKOFF_MS,
      });
    }
    if (response.status === 401 || response.status === 403) {
      // A keyless endpoint that refuses is refusing THIS CLIENT — a missing or
      // banned User-Agent — and retrying it unchanged is how a soft block
      // becomes a hard one.
      throw new CatalogSourceFetchError(
        'auth_failure',
        `${host} refused the request (${String(response.status)}).`,
        {
          retryable: false,
        },
      );
    }
    throw new CatalogSourceFetchError(
      'source_outage',
      `${host} answered ${String(response.status)}.`,
      {
        retryable: response.status >= 500 || response.status === 408,
      },
    );
  }

  return {
    async getJson(url, requestOptions = {}) {
      await throttle(url, requestOptions.minIntervalMs);
      const response = await send(url, {
        headers: { accept: 'application/json', ...requestOptions.headers },
        ...(requestOptions.signal === undefined ? {} : { signal: requestOptions.signal }),
      });
      if (response.status === 404 && requestOptions.allowNotFound === true) {
        await response.body?.cancel();
        return null;
      }
      if (!response.ok) {
        await response.body?.cancel();
        refuseStatus(url, response);
      }
      const text = await response.text();
      try {
        return { body: JSON.parse(text) as unknown, headers: response.headers };
      } catch (error: unknown) {
        // A 200 that is not JSON is the host's maintenance page or a CDN error
        // served as success — a fact about the RESPONSE, not the schema.
        throw new CatalogSourceFetchError(
          'parse_failure',
          `${new URL(url).host} answered 200 with a body that is not JSON.`,
          {
            retryable: true,
            cause: error,
          },
        );
      }
    },

    async getText(url, requestOptions = {}) {
      await throttle(url, requestOptions.minIntervalMs);
      const response = await send(url, {
        headers: { accept: 'text/plain', ...requestOptions.headers },
        ...(requestOptions.signal === undefined ? {} : { signal: requestOptions.signal }),
      });
      if (response.status === 404 && requestOptions.allowNotFound === true) {
        await response.body?.cancel();
        return null;
      }
      if (!response.ok) {
        await response.body?.cancel();
        refuseStatus(url, response);
      }
      return response.text();
    },

    async download(url, downloadOptions) {
      await mkdir(options.cacheDir, { recursive: true });
      const key = createHash('sha256').update(url).digest('hex');
      const bytesPath = join(options.cacheDir, `${key}.bin`);
      const metaPath = join(options.cacheDir, `${key}.meta.json`);
      const cached = await readMeta(metaPath);

      if (cached !== null && clock() - Date.parse(cached.confirmedAt) < downloadOptions.maxAgeMs) {
        return toDownload(bytesPath, cached);
      }

      await throttle(url, downloadOptions.minIntervalMs);
      const conditional: Record<string, string> = {};
      if (cached?.etag) conditional['if-none-match'] = cached.etag;
      if (cached?.lastModified) conditional['if-modified-since'] = cached.lastModified;
      const response = await send(url, {
        headers: { 'accept-encoding': 'identity', ...downloadOptions.headers, ...conditional },
        ...(downloadOptions.signal === undefined ? {} : { signal: downloadOptions.signal }),
      });

      if (response.status === 304 && cached !== null) {
        await response.body?.cancel();
        const confirmed: CachedDumpMeta = {
          ...cached,
          confirmedAt: new Date(clock()).toISOString(),
        };
        await writeFile(metaPath, JSON.stringify(confirmed), 'utf8');
        return toDownload(bytesPath, confirmed);
      }
      if (!response.ok || response.body === null) {
        await response.body?.cancel();
        refuseStatus(url, response);
      }

      const declared = Number(response.headers.get('content-length') ?? '0');
      if (declared > options.maxDownloadBytes) {
        await response.body.cancel();
        throw new CatalogSourceFetchError(
          'source_outage',
          `${new URL(url).host} serves ${String(declared)} bytes, over OPEN_DATA_MAX_DOWNLOAD_BYTES.`,
          { retryable: false },
        );
      }

      const temporary = `${bytesPath}.${String(process.pid)}.${String(clock())}.partial`;
      const hash = createHash('sha256');
      let received = 0;
      const limit = options.maxDownloadBytes;
      async function* bounded(source: AsyncIterable<Uint8Array>): AsyncGenerator<Uint8Array> {
        for await (const chunk of source) {
          received += chunk.byteLength;
          if (received > limit) {
            // Refused, never truncated: a truncated dump parses as a smaller
            // catalogue and a complete pass over it would retire the rest.
            throw new CatalogSourceFetchError(
              'source_outage',
              'The dump exceeded OPEN_DATA_MAX_DOWNLOAD_BYTES mid-stream.',
              {
                retryable: false,
              },
            );
          }
          hash.update(chunk);
          yield chunk;
        }
      }
      try {
        await pipeline(
          Readable.from(
            bounded(
              Readable.fromWeb(
                response.body as import('node:stream/web').ReadableStream<Uint8Array>,
              ),
            ),
          ),
          createWriteStream(temporary),
        );
      } catch (error: unknown) {
        await rm(temporary, { force: true });
        if (error instanceof CatalogSourceFetchError) throw error;
        throw new CatalogSourceFetchError(
          'source_outage',
          `The download from ${new URL(url).host} was interrupted.`,
          {
            retryable: true,
            cause: error,
          },
        );
      }
      await rename(temporary, bytesPath);
      const meta: CachedDumpMeta = {
        url,
        etag: response.headers.get('etag'),
        lastModified: response.headers.get('last-modified'),
        confirmedAt: new Date(clock()).toISOString(),
        digest: hash.digest('hex'),
      };
      await writeFile(metaPath, JSON.stringify(meta), 'utf8');
      return toDownload(bytesPath, meta);
    },
  };
}

function toDownload(path: string, meta: CachedDumpMeta): OpenDataDownload {
  const lastModified = meta.lastModified === null ? null : new Date(meta.lastModified);
  return {
    path,
    confirmedAt: new Date(meta.confirmedAt),
    lastModified:
      lastModified !== null && !Number.isNaN(lastModified.getTime()) ? lastModified : null,
    digest: meta.digest,
  };
}

async function readMeta(path: string): Promise<CachedDumpMeta | null> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as Partial<CachedDumpMeta>;
    if (typeof parsed.confirmedAt !== 'string' || typeof parsed.digest !== 'string') return null;
    return {
      url: parsed.url ?? '',
      etag: parsed.etag ?? null,
      lastModified: parsed.lastModified ?? null,
      confirmedAt: parsed.confirmedAt,
      digest: parsed.digest,
    };
  } catch {
    return null;
  }
}

/** `Retry-After` as seconds or an HTTP date, in milliseconds from now. */
export function readRetryAfterMs(header: string | null, now: number): number | undefined {
  if (header === null || header.trim() === '') return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1_000);
  const at = Date.parse(header);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, at - now);
}
