/**
 * The inspection byte source: which failures are VALUES and which THROW.
 *
 * That split is the whole contract `inspection/bytes.ts` declares, and getting it
 * wrong is not a crash — it is a quiet lie in the opposite direction each way. A
 * transient outage flattened into `not_found` writes a census of files that "do
 * not exist", which is what a creator reads as their upload having vanished. A
 * permanent absence thrown instead writes a job that retries forever against an
 * object nobody will ever serve.
 *
 * So every case below asserts which of the two happened, and the value cases are
 * paired with a throwing one so "it returned a value" cannot be satisfied by a
 * function that never throws at all.
 */

import { describe, expect, it, beforeEach, vi } from 'vitest';

const findAssetFileStorageKey = vi.fn();
const resolveAuthorizedUrl = vi.fn();
const logWarn = vi.fn();

vi.mock('../../../db/digital/assetRepository.js', () => ({
  findAssetFileStorageKey: (...args: unknown[]) => findAssetFileStorageKey(...args),
}));
vi.mock('../../../lib/logger.js', () => ({
  log: {
    general: { info: vi.fn(), debug: vi.fn(), error: vi.fn(), warn: (...a: unknown[]) => logWarn(...a) },
  },
}));

/**
 * The storage port is doubled, NOT the HTTP client underneath it.
 *
 * `DigitalStorageError` comes from the real module so `isDigitalStorageError` is
 * an `instanceof` against the same class the implementation reads. A locally
 * redeclared error class would make every `reason` branch below fall through to
 * the throwing path, and the tests would pass for the three cases that throw.
 */
vi.mock('../storage.js', async () => {
  const actual = await import('../storage.js');
  return {
    ...actual,
    assetStorage: { resolveAuthorizedUrl: (...args: unknown[]) => resolveAuthorizedUrl(...args) },
  };
});

const FILE_ID = 'file_not_a_real_id';
const STORAGE_KEY = 'oxyfile_not_a_real_asset_id';
const URL_ = `https://s3.oxy.test/private/${STORAGE_KEY}?X-Amz-Signature=not-real`;
const CEILING = 1024;

/** A row as `findAssetFileStorageKey` returns it. */
const row = (byteSize: number) => ({
  storageKey: STORAGE_KEY,
  fileName: 'model.stl',
  mediaType: 'model/stl',
  byteSize,
});

/** A `fetch` double answering one response. */
function answerWith(init: {
  status?: number;
  body?: Uint8Array | null;
  chunks?: Uint8Array[];
}): void {
  const chunks = init.chunks ?? (init.body ? [init.body] : []);
  const body =
    init.body === null && !init.chunks
      ? null
      : new ReadableStream<Uint8Array>({
          start(controller) {
            for (const chunk of chunks) controller.enqueue(chunk);
            controller.close();
          },
        });
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ status: init.status ?? 200, ok: (init.status ?? 200) < 400, body })),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  findAssetFileStorageKey.mockResolvedValue(row(64));
  resolveAuthorizedUrl.mockResolvedValue(URL_);
});

describe('the happy path, which is the control for every absence below', () => {
  it('reads the object and returns its bytes', async () => {
    const { storageAssetByteSource } = await import('../byte-source.js');
    answerWith({ body: new Uint8Array([1, 2, 3, 4]) });

    const read = await storageAssetByteSource.read(FILE_ID, CEILING);

    expect(read.outcome).toBe('ok');
    expect(read.outcome === 'ok' && Array.from(read.bytes)).toEqual([1, 2, 3, 4]);
    expect(resolveAuthorizedUrl).toHaveBeenCalledWith(STORAGE_KEY);
  });

  it('reassembles a CHUNKED body in order', async () => {
    // The cap is applied chunk by chunk, so the reassembly is real code rather
        // than a single-buffer passthrough, and a wrong offset would be invisible
    // against a one-chunk body.
    const { storageAssetByteSource } = await import('../byte-source.js');
    answerWith({
      chunks: [new Uint8Array([1, 2]), new Uint8Array([3]), new Uint8Array([4, 5])],
    });

    const read = await storageAssetByteSource.read(FILE_ID, CEILING);

    expect(read.outcome === 'ok' && Array.from(read.bytes)).toEqual([1, 2, 3, 4, 5]);
  });
});

describe('the PERMANENT outcomes are values', () => {
  it('answers not_found for a file row that does not exist, with no network call', async () => {
    const { storageAssetByteSource } = await import('../byte-source.js');
    findAssetFileStorageKey.mockResolvedValue(null);
    answerWith({ body: new Uint8Array([1]) });

    await expect(storageAssetByteSource.read(FILE_ID, CEILING)).resolves.toEqual({
      outcome: 'not_found',
    });
    expect(resolveAuthorizedUrl).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('answers not_found when Oxy will not serve the object', async () => {
    // The creator unlinked it, or it was deleted there. Permanent for this job,
    // and NOT authority over anybody's right (ADR 0010 D6).
    const { storageAssetByteSource } = await import('../byte-source.js');
    const { DigitalStorageError } = await import('../storage.js');
    resolveAuthorizedUrl.mockRejectedValue(new DigitalStorageError('absent', 'gone'));

    await expect(storageAssetByteSource.read(FILE_ID, CEILING)).resolves.toEqual({
      outcome: 'not_found',
    });
  });

  it('answers not_found on a 404 or 410 from the object store', async () => {
    const { storageAssetByteSource } = await import('../byte-source.js');
    for (const status of [404, 410]) {
      answerWith({ status, body: new Uint8Array([]) });
      await expect(storageAssetByteSource.read(FILE_ID, CEILING)).resolves.toEqual({
        outcome: 'not_found',
      });
    }
  });

  it('refuses an over-ceiling file from the ROW, with no network call at all', async () => {
    // The row's `byte_size` is Oxy's own measurement, so this is a trustworthy
    // refusal. `MAX_ASSET_FILE_BYTES` is 8 GiB against a 256 MiB inspection
    // ceiling, so pulling the object first to discover its size is the common
    // case, not an edge.
    const { storageAssetByteSource } = await import('../byte-source.js');
    findAssetFileStorageKey.mockResolvedValue(row(CEILING + 1));
    answerWith({ body: new Uint8Array([1]) });

    await expect(storageAssetByteSource.read(FILE_ID, CEILING)).resolves.toEqual({
      outcome: 'too_large',
      byteSize: CEILING + 1,
    });
    expect(resolveAuthorizedUrl).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('refuses an over-ceiling STREAM even when the row said it was under', async () => {
    // Not redundant with the row cap. The row says what Oxy measured at
    // registration; the response says what it is sending now, and a declared
    // length is a claim the body need not honour.
    const { storageAssetByteSource } = await import('../byte-source.js');
    findAssetFileStorageKey.mockResolvedValue(row(4));
    answerWith({ chunks: [new Uint8Array(3), new Uint8Array(3)] });

    await expect(storageAssetByteSource.read(FILE_ID, 4)).resolves.toEqual({
      outcome: 'too_large',
      byteSize: 4,
    });
    // Logged, because a stored object disagreeing with its row is worth somebody
    // knowing about, and the row's size is all this can honestly report.
    expect(logWarn).toHaveBeenCalled();
  });
});

describe('the RETRYABLE failures throw, so BullMQ can see them', () => {
  it('throws when resolution failed transiently rather than reporting absence', async () => {
    const { storageAssetByteSource } = await import('../byte-source.js');
    const { DigitalStorageError } = await import('../storage.js');
    resolveAuthorizedUrl.mockRejectedValue(new DigitalStorageError('unresolved', 'boom'));

    await expect(storageAssetByteSource.read(FILE_ID, CEILING)).rejects.toThrow();
  });

  it('throws when the deployment is unconfigured — an operator fixes that', async () => {
    const { storageAssetByteSource } = await import('../byte-source.js');
    const { DigitalStorageError } = await import('../storage.js');
    resolveAuthorizedUrl.mockRejectedValue(new DigitalStorageError('unconfigured', 'no creds'));

    await expect(storageAssetByteSource.read(FILE_ID, CEILING)).rejects.toThrow();
  });

  it('throws on a transport failure', async () => {
    const { storageAssetByteSource } = await import('../byte-source.js');
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNRESET'); }));

    await expect(storageAssetByteSource.read(FILE_ID, CEILING)).rejects.toThrow();
  });

  it('throws on a 403, because an EXPIRED url is fixed by minting another', async () => {
    // The one status most likely to be mistaken for a permanent denial. A URL that
    // expired between the mint and the fetch is exactly what a retry repairs, so
    // reporting the file unreadable would strand it.
    const { storageAssetByteSource } = await import('../byte-source.js');
    answerWith({ status: 403, body: new Uint8Array([]) });

    await expect(storageAssetByteSource.read(FILE_ID, CEILING)).rejects.toThrow();
  });

  it('throws on a 500', async () => {
    const { storageAssetByteSource } = await import('../byte-source.js');
    answerWith({ status: 500, body: new Uint8Array([]) });

    await expect(storageAssetByteSource.read(FILE_ID, CEILING)).rejects.toThrow();
  });

  it('throws when the response carries no body', async () => {
    const { storageAssetByteSource } = await import('../byte-source.js');
    answerWith({ body: null });

    await expect(storageAssetByteSource.read(FILE_ID, CEILING)).rejects.toThrow();
  });
});

describe('registration is a CALL, not an import side effect', () => {
  it('leaves the refusing default in force until asked', async () => {
    // `isAssetByteSourceConfigured()` is what makes "no storage is wired" produce
    // one honest `failed` row instead of a `not_found` that reads as a deleted
    // object. A module-scope registration would make that state unreachable — in
    // production and in the tests that assert it — the moment anything imported
    // this file transitively.
    const { isAssetByteSourceConfigured, resetAssetByteSource } = await import(
      '../inspection/bytes.js'
    );
    resetAssetByteSource();
    const { registerDigitalByteSource } = await import('../byte-source.js');

    expect(isAssetByteSourceConfigured()).toBe(false);
    registerDigitalByteSource();
    expect(isAssetByteSourceConfigured()).toBe(true);

    // Leave no source behind: a leaked registration changes what a sibling suite
    // measures.
    resetAssetByteSource();
  });
});
