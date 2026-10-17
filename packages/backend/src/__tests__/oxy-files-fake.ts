/**
 * A fake of Oxy Files at the SDK boundary — what `oxyServiceClient()` returns —
 * so `services/catalog-media/oxy-files.ts`, the ONE adapter, runs for real in
 * every test that imports media.
 *
 * It models the two behaviours Mercaria now relies on (Oxy ADR 0043 D7):
 *
 * - **Import by URL deduplicates per (owner, URL).** The same source imported
 *   again by the same owner answers the SAME file id without a fetch — the
 *   property that ends the connector's re-upload of every gallery. A different
 *   owner gets a different id, which is what makes an owner mistake visible.
 * - **The owner is the method** (`importAppFile` is the application's,
 *   `importUserMedia` names the account), never a body field.
 *
 * File ids are derived (`oxy-file-<40 hex>`), so a test can compute what an
 * import must have produced. `.mp4` sources come back as `video/mp4`, anything
 * else `image/png`; `failNext` makes the next import answer an HTTP error.
 *
 * **A batch import is one request** (`importAppFiles`, up to 50 sources): each
 * source answers on its own, a `failNext` failure landing on the item it hits,
 * while `failNextRequest` refuses the next REQUEST whole — Oxy's 429, which is
 * charged per request. `requests` counts them: the unit of Oxy's rate limit.
 */

import { createHash } from 'node:crypto';

export interface FakeOxyImport {
  readonly owner: string;
  readonly sourceUrl: string;
  readonly fileId: string;
}

export interface FakeOxyFiles {
  /** What `oxyServiceClient()` should return. */
  readonly client: {
    serviceToken: () => Promise<string>;
    readonly baseURL: string;
    readonly assets: {
      importAppFile: (sourceUrl: string, options: { visibility: string }) => Promise<unknown>;
      importAppFiles: (
        items: Array<{ sourceUrl: string; visibility: string }>,
      ) => Promise<Array<Record<string, unknown> & { index: number; ok: boolean }>>;
      importUserMedia: (
        owner: string,
        sourceUrl: string,
        options?: { visibility?: string },
      ) => Promise<unknown>;
      uploadUserMedia: (
        owner: string,
        bytes: Uint8Array,
        mime: string,
      ) => Promise<{ id: string; mime: string; size: number; visibility: string; sha256: string }>;
      uploadAppFile: (
        bytes: Uint8Array,
        mime: string,
      ) => Promise<{
        file: { id: string; mime: string; size: number; visibility: string };
        deduplicated: boolean;
      }>;
    };
  };
  /** Every import that reached "Oxy", in order — including deduplicated ones. */
  readonly imports: FakeOxyImport[];
  /** Imports that would have DOWNLOADED (the first of each owner and URL). */
  readonly downloads: FakeOxyImport[];
  /** Import REQUESTS made — a batch is one — the unit Oxy's rate limit counts. */
  readonly requests: number;
  /** The id an import of `sourceUrl` by `owner` answers (`app` or `user:<id>`). */
  fileIdFor(owner: string, sourceUrl: string): string;
  failNext(status: number): void;
  /** Refuse the next import REQUEST whole, e.g. `429` with `{ retryAfterSeconds }`. */
  failNextRequest(status: number, details?: Record<string, unknown>): void;
  reset(): void;
}

export function fakeOxyFileId(owner: string, source: string): string {
  return `oxy-file-${createHash('sha256').update(`${owner}|${source}`).digest('hex').slice(0, 40)}`;
}

export function createFakeOxyFiles(): FakeOxyFiles {
  const imports: FakeOxyImport[] = [];
  const downloads: FakeOxyImport[] = [];
  const seen = new Set<string>();
  let failure: number | undefined;
  let requestFailure: { status: number; details?: Record<string, unknown> } | undefined;
  let requests = 0;

  /** One request reaches "Oxy": counted, and refused whole when asked to be. */
  function request(): void {
    requests += 1;
    if (requestFailure === undefined) return;
    const { status, details } = requestFailure;
    requestFailure = undefined;
    throw Object.assign(new Error(`HTTP ${status}`), {
      status,
      ...(details === undefined ? {} : { details }),
    });
  }

  function importFor(owner: string, sourceUrl: string) {
    if (failure !== undefined) {
      const status = failure;
      failure = undefined;
      throw Object.assign(new Error(`HTTP ${status}`), { status });
    }
    const fileId = fakeOxyFileId(owner, sourceUrl);
    const entry = { owner, sourceUrl, fileId };
    imports.push(entry);
    const key = `${owner}|${sourceUrl}`;
    const deduplicated = seen.has(key);
    if (!deduplicated) {
      seen.add(key);
      downloads.push(entry);
    }
    const video = /\.mp4(?:$|\?)/.test(sourceUrl);
    return {
      file: {
        id: fileId,
        mime: video ? 'video/mp4' : 'image/png',
        size: 1024,
        visibility: 'public',
        status: 'active',
      },
      outcome: deduplicated ? 'existing' : 'downloaded',
      deduplicated,
    };
  }

  return {
    client: {
      baseURL: 'https://api.oxy.test',
      serviceToken: async () => 'fake-oxy-service-token',
      assets: {
        importAppFile: async (sourceUrl) => {
          request();
          return importFor('app', sourceUrl);
        },
        importAppFiles: async (items) => {
          if (items.length > 50) throw Object.assign(new Error('fake Oxy: >50'), { status: 400 });
          request();
          return items.map(({ sourceUrl }, index) => {
            try {
              return { index, ok: true, ...importFor('app', sourceUrl) };
            } catch (error) {
              const status = (error as { status: number }).status;
              return { index, ok: false, error: { status, code: 'X', message: `HTTP ${status}` } };
            }
          });
        },
        importUserMedia: async (owner, sourceUrl) => {
          request();
          if (!owner) throw Object.assign(new Error('fake Oxy: no owner'), { status: 400 });
          return importFor(`user:${owner}`, sourceUrl);
        },
        uploadUserMedia: async (owner, bytes, mime) => {
          const sha256 = createHash('sha256').update(bytes).digest('hex');
          return {
            id: fakeOxyFileId(`user:${owner}`, sha256),
            mime,
            size: bytes.byteLength,
            visibility: 'public',
            sha256,
          };
        },
        uploadAppFile: async (bytes, mime) => {
          const sha256 = createHash('sha256').update(bytes).digest('hex');
          return {
            file: {
              id: fakeOxyFileId('app', sha256),
              mime,
              size: bytes.byteLength,
              visibility: 'public',
            },
            deduplicated: false,
          };
        },
      },
    },
    imports,
    downloads,
    get requests() {
      return requests;
    },
    fileIdFor: fakeOxyFileId,
    failNext(status) {
      failure = status;
    },
    failNextRequest(status, details) {
      requestFailure = { status, ...(details === undefined ? {} : { details }) };
    },
    reset() {
      imports.length = 0;
      downloads.length = 0;
      seen.clear();
      failure = undefined;
      requestFailure = undefined;
      requests = 0;
    },
  };
}
