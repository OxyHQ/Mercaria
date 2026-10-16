/**
 * `oxy-files.ts` — the ONE adapter to Oxy Files. What it promises its callers:
 * the owner is decided by the call (never a body field), every answer is
 * validated before an id leaves it, and no error carries a source URL.
 */

import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sdk = vi.hoisted(() => ({
  importAppFile: vi.fn(),
  importUserMedia: vi.fn(),
  uploadAppFile: vi.fn(),
  uploadUserMedia: vi.fn(),
  uploadAppFileLarge: vi.fn(),
  adoptAppFile: vi.fn(),
  add: vi.fn(),
  remove: vi.fn(),
  reconcile: vi.fn(),
  configured: true,
}));
const ledger = vi.hoisted(() => ({ record: vi.fn() }));
vi.mock('../../../db/oxyFiles/applicationFileRepository.js', () => ({
  recordApplicationFiles: ledger.record,
}));
vi.mock('../../../capabilities/oxy-service-client.js', () => ({
  oxyServiceClient: () =>
    sdk.configured
      ? {
          assets: {
            importAppFile: sdk.importAppFile,
            importUserMedia: sdk.importUserMedia,
            uploadAppFile: sdk.uploadAppFile,
            uploadUserMedia: sdk.uploadUserMedia,
            uploadAppFileLarge: sdk.uploadAppFileLarge,
            adoptAppFile: sdk.adoptAppFile,
            references: { add: sdk.add, remove: sdk.remove, reconcile: sdk.reconcile },
          },
        }
      : null,
}));
import { LargeUploadFailedError } from '@oxy.so/core/server';
import {
  addOxyFileReferences,
  adoptAsPrivateApplicationFile,
  BACKGROUND_RATE_LIMIT,
  importOxyFileFromUrl,
  isOxyRateLimited,
  OxyFilesError,
  parseRetryAfterMs,
  rateLimitDelayMs,
  reconcileOxyFileReferences,
  removeOxyFileReferences,
  retryAfterMsOf,
  uploadOxyFile,
  uploadPrivateApplicationFile,
  verifyOxyFileDelivery,
} from '../oxy-files.js';

const FILE = { id: 'oxy-file-1', mime: 'image/png', size: 10, visibility: 'public' };

beforeEach(() => {
  vi.resetAllMocks();
  ledger.record.mockResolvedValue(undefined);
  sdk.configured = true;
  sdk.importAppFile.mockResolvedValue({ file: FILE, outcome: 'existing', deduplicated: true });
  sdk.importUserMedia.mockResolvedValue({ file: FILE, outcome: 'downloaded', deduplicated: false });
});

describe('import by URL', () => {
  it('imports for the APPLICATION through its own route, and for an ACCOUNT naming it', async () => {
    expect(await importOxyFileFromUrl({ kind: 'application' }, 'https://s.example/a.png')).toEqual({
      fileId: 'oxy-file-1',
      mime: 'image/png',
      size: 10,
      visibility: 'public',
    });
    expect(sdk.importAppFile).toHaveBeenCalledExactlyOnceWith('https://s.example/a.png', {
      visibility: 'public',
    });
    await importOxyFileFromUrl(
      { kind: 'account', oxyUserId: 'store-owner' },
      'https://s.example/b.png',
      {
        revalidate: true,
      },
    );
    expect(sdk.importUserMedia).toHaveBeenCalledExactlyOnceWith(
      'store-owner',
      'https://s.example/b.png',
      { visibility: 'public', revalidate: true },
    );
  });

  it('never imports for an account it was not given', async () => {
    await expect(
      importOxyFileFromUrl({ kind: 'account', oxyUserId: '' }, 'https://s.example/a.png'),
    ).rejects.toThrow(/owner/);
    expect(sdk.importUserMedia).not.toHaveBeenCalled();
  });

  it.each([
    [{ ...FILE, id: 'https://s.example/not-an-id' }],
    [{ ...FILE, size: 0 }],
    [{ ...FILE, mime: undefined }],
    [{}],
  ])('refuses an answer that does not describe a file: %j', async (file) => {
    sdk.importAppFile.mockResolvedValue({ file });
    await expect(
      importOxyFileFromUrl({ kind: 'application' }, 'https://s.example/a.png'),
    ).rejects.toThrow(/did not describe/);
  });

  it('names the refusal by status and never echoes the source', async () => {
    sdk.importAppFile.mockRejectedValue(
      Object.assign(new Error('https://s.example/a.png?token=secret refused'), { status: 403 }),
    );
    const error = await importOxyFileFromUrl(
      { kind: 'application' },
      'https://s.example/a.png?token=secret',
    ).catch((caught: Error) => caught);
    expect((error as Error).message).toBe(
      'Oxy has not authorized Mercaria to import the media source.',
    );
  });

  it('refuses without Mercaria credentials', async () => {
    sdk.configured = false;
    await expect(
      importOxyFileFromUrl({ kind: 'application' }, 'https://s.example/a.png'),
    ).rejects.toThrow(/credentials/);
  });
});

describe('upload', () => {
  it('stores bytes as the account or as the application', async () => {
    sdk.uploadUserMedia.mockResolvedValue(FILE);
    sdk.uploadAppFile.mockResolvedValue({ file: FILE, deduplicated: false });
    await uploadOxyFile(
      { kind: 'account', oxyUserId: 'owner' },
      Buffer.from('x'),
      'image/png',
      'product-image',
    );
    expect(sdk.uploadUserMedia.mock.calls[0]?.[0]).toBe('owner');
    await uploadOxyFile({ kind: 'application' }, Buffer.from('x'), 'image/png', 'category-art');
    expect(sdk.uploadAppFile.mock.calls[0]?.[2]).toMatchObject({ visibility: 'public' });
  });
});

describe('application-owned private files (stage 4b)', () => {
  const PRIVATE = { ...FILE, id: 'oxy-file-2', mime: 'model/stl', visibility: 'private' };

  it('uploads any type privately by the large upload, passing the Blob through', async () => {
    sdk.uploadAppFileLarge.mockResolvedValue({ file: PRIVATE, deduplicated: false, uploadId: 'u' });
    const blob = new Blob(['mesh'], { type: 'model/stl' });
    expect(
      await uploadPrivateApplicationFile(blob, 'model/stl', {
        filename: 'digital-asset',
        metadata: { assetVersionId: 'v' },
      }),
    ).toEqual({ fileId: 'oxy-file-2', mime: 'model/stl', size: 10, visibility: 'private' });
    expect(sdk.uploadAppFileLarge).toHaveBeenCalledExactlyOnceWith(blob, {
      mime: 'model/stl',
      visibility: 'private',
      filename: 'digital-asset',
      metadata: { assetVersionId: 'v' },
    });
  });

  it('names a large upload that ended without a file by its code', async () => {
    sdk.uploadAppFileLarge.mockRejectedValue(
      new LargeUploadFailedError('CONTENT_BLOCKED', 'blocked', 'u'),
    );
    const error = await uploadPrivateApplicationFile(new Blob(['x']), 'model/stl', {
      filename: 'digital-asset',
    }).catch((caught) => caught);
    expect(error).toBeInstanceOf(OxyFilesError);
    expect(error.message).toContain('CONTENT_BLOCKED');
  });

  it('adopts privately and returns the measured hash', async () => {
    sdk.adoptAppFile.mockResolvedValue({
      file: { ...PRIVATE, sha256: 'A'.repeat(64) },
      outcome: 'adopted',
      deduplicated: true,
    });
    expect(await adoptAsPrivateApplicationFile('source')).toEqual({
      fileId: 'oxy-file-2',
      mime: 'model/stl',
      size: 10,
      visibility: 'private',
      sha256: 'a'.repeat(64),
    });
    expect(sdk.adoptAppFile).toHaveBeenCalledExactlyOnceWith('source', { visibility: 'private' });
  });

  it('refuses an adoption answer without a digest, and carries a refusal status', async () => {
    sdk.adoptAppFile.mockResolvedValue({ file: PRIVATE, outcome: 'adopted', deduplicated: true });
    await expect(adoptAsPrivateApplicationFile('source')).rejects.toThrow(/did not describe/);
    sdk.adoptAppFile.mockRejectedValue(Object.assign(new Error('x'), { status: 451 }));
    const error = await adoptAsPrivateApplicationFile('source').catch((caught) => caught);
    expect(error).toBeInstanceOf(OxyFilesError);
    expect(error.status).toBe(451);
  });
});

describe('references', () => {
  it('passes the batch through and sends nothing for an empty one', async () => {
    const reference = { fileId: 'f', entityType: 'listing_image', entityId: 'l' };
    sdk.add.mockResolvedValue([{ ...reference, result: 'created' }]);
    expect(await addOxyFileReferences([reference])).toEqual([{ ...reference, result: 'created' }]);
    expect(await removeOxyFileReferences([])).toEqual([]);
    expect(sdk.remove).not.toHaveBeenCalled();
  });
});

describe('event delivery verification', () => {
  const secret = 'whsec_unit';
  const body = JSON.stringify({
    id: 'evt-1',
    type: 'file.deleted',
    occurredAt: new Date().toISOString(),
    file: { id: 'f', ownerKind: 'application', visibility: 'public', status: 'deleted' },
    references: [],
  });
  const t = Math.floor(Date.now() / 1000);
  const signature = `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;

  it('accepts Oxy’s signature, refuses anything else, and passes a challenge through unsigned', () => {
    expect(
      verifyOxyFileDelivery(Buffer.from(body), { 'oxy-signature': signature }, secret),
    ).toMatchObject({ kind: 'event', event: { id: 'evt-1', type: 'file.deleted' } });
    expect(
      verifyOxyFileDelivery(Buffer.from(`${body} `), { 'oxy-signature': signature }, secret).kind,
    ).toBe('refused');
    expect(verifyOxyFileDelivery(Buffer.from(body), {}, secret).kind).toBe('refused');
    expect(
      verifyOxyFileDelivery(
        Buffer.from(JSON.stringify({ type: 'webhook.challenge', challenge: 'c' })),
        {},
        '',
      ),
    ).toEqual({ kind: 'challenge', challenge: 'c' });
  });
});

/** Oxy's limiter refusal as the SDK hands it over: the status and the body's `details`. */
function rateLimited(retryAfterSeconds?: number) {
  return Object.assign(new Error('Too many application file uploads. Please slow down.'), {
    status: 429,
    ...(retryAfterSeconds === undefined ? {} : { details: { retryAfterSeconds } }),
  });
}

describe('Retry-After', () => {
  const now = Date.parse('2020-01-01T12:00:00Z');

  it.each([
    ['30', 30_000],
    [' 7 ', 7_000],
    ['1.5', 1_500],
    [0, 0],
    [45, 45_000],
    ['Wed, 01 Jan 2020 12:00:40 GMT', 40_000],
    // A date already past means "now", never a negative wait.
    ['Wed, 01 Jan 2020 11:59:00 GMT', 0],
  ])('reads %j as %d ms', (value, expected) => {
    expect(parseRetryAfterMs(value, now)).toBe(expected);
  });

  it.each([[''], ['soon'], ['-5'], ['12abc'], [-1], [Number.NaN], [null], [undefined], [{}]])(
    'names no wait for %j',
    (value) => {
      expect(parseRetryAfterMs(value, now)).toBeUndefined();
    },
  );

  it('finds the wait in a header, Oxy’s details, or the response body', () => {
    expect(retryAfterMsOf(rateLimited(12), now)).toBe(12_000);
    expect(
      retryAfterMsOf(
        {
          status: 429,
          response: { status: 429, data: { error: { details: { retryAfterSeconds: 9 } } } },
        },
        now,
      ),
    ).toBe(9_000);
    expect(
      retryAfterMsOf({ response: { headers: new Headers({ 'Retry-After': '3' }) } }, now),
    ).toBe(3_000);
    // The header is the standard and wins over the body.
    expect(
      retryAfterMsOf(
        { details: { retryAfterSeconds: 50 }, response: { headers: { 'retry-after': '4' } } },
        now,
      ),
    ).toBe(4_000);
    expect(retryAfterMsOf(rateLimited(), now)).toBeUndefined();
  });

  it('waits what Oxy named plus under a second of jitter, else backs off exponentially, capped', () => {
    expect(rateLimitDelayMs(rateLimited(20), 1, BACKGROUND_RATE_LIMIT, now, () => 0)).toBe(20_000);
    expect(rateLimitDelayMs(rateLimited(20), 1, BACKGROUND_RATE_LIMIT, now, () => 0.999)).toBe(
      20_999,
    );
    // No named wait: 15 s doubling, capped at 60 s, the upper half jittered.
    const fallback = (failures: number, random: number) =>
      rateLimitDelayMs(rateLimited(), failures, BACKGROUND_RATE_LIMIT, now, () => random);
    expect([fallback(1, 0), fallback(1, 1)]).toEqual([7_500, 15_000]);
    expect([fallback(2, 0), fallback(2, 1)]).toEqual([15_000, 30_000]);
    expect([fallback(3, 0), fallback(3, 1)]).toEqual([30_000, 60_000]);
    expect([fallback(9, 0), fallback(9, 1)]).toEqual([30_000, 60_000]);
  });
});

describe('Oxy’s rate limit (429)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('waits out the named Retry-After and tries the SAME import again', async () => {
    sdk.importAppFile
      .mockRejectedValueOnce(rateLimited(30))
      .mockRejectedValueOnce(rateLimited(45))
      .mockResolvedValueOnce({ file: FILE, outcome: 'existing', deduplicated: true });
    const result = importOxyFileFromUrl({ kind: 'application' }, 'https://s.example/a.png');
    await vi.advanceTimersByTimeAsync(29_999);
    expect(sdk.importAppFile).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(sdk.importAppFile).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(45_000);
    expect((await result).fileId).toBe('oxy-file-1');
    expect(sdk.importAppFile).toHaveBeenCalledTimes(3);
    for (const call of sdk.importAppFile.mock.calls)
      expect(call).toEqual(['https://s.example/a.png', { visibility: 'public' }]);
  });

  it('gives up after three calls, surfacing the existing refusal with the named wait', async () => {
    sdk.importUserMedia.mockRejectedValue(rateLimited(10));
    const result = importOxyFileFromUrl(
      { kind: 'account', oxyUserId: 'owner' },
      'https://s.example/a.png',
    ).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(20_000);
    const error = (await result) as OxyFilesError;
    expect(error).toBeInstanceOf(OxyFilesError);
    expect(error.message).toBe('Oxy could not import the media source (HTTP 429).');
    expect(error.status).toBe(429);
    expect(error.retryAfterMs).toBe(10_000);
    expect(isOxyRateLimited(error)).toBe(true);
    expect(isOxyRateLimited(new Error('wrapped', { cause: error }))).toBe(true);
    expect(sdk.importUserMedia).toHaveBeenCalledTimes(3);
  });

  it('never starts a wait past the two-minute total: a long Retry-After is handed back at once', async () => {
    sdk.importAppFile.mockRejectedValue(rateLimited(3600));
    const error = await importOxyFileFromUrl(
      { kind: 'application' },
      'https://s.example/a.png',
    ).catch((caught: unknown) => caught);
    expect((error as OxyFilesError).status).toBe(429);
    expect(sdk.importAppFile).toHaveBeenCalledTimes(1);
  });

  it('stops when the next wait would pass the total, though attempts remain', async () => {
    sdk.importAppFile.mockRejectedValueOnce(rateLimited(60)).mockRejectedValue(rateLimited(61));
    const result = importOxyFileFromUrl({ kind: 'application' }, 'https://s.example/a.png').catch(
      (caught: unknown) => caught,
    );
    await vi.advanceTimersByTimeAsync(60_000);
    expect(((await result) as OxyFilesError).status).toBe(429);
    // 60 s waited; another 61 s would make 121 s, past the 120 s bound.
    expect(sdk.importAppFile).toHaveBeenCalledTimes(2);
  });

  it('backs off with jitter when Oxy names no wait', async () => {
    sdk.importAppFile
      .mockRejectedValueOnce(rateLimited())
      .mockResolvedValueOnce({ file: FILE, outcome: 'existing', deduplicated: true });
    const result = importOxyFileFromUrl({ kind: 'application' }, 'https://s.example/a.png');
    await vi.advanceTimersByTimeAsync(7_499);
    expect(sdk.importAppFile).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect((await result).fileId).toBe('oxy-file-1');
  });

  it('retries nothing but a 429', async () => {
    sdk.importAppFile.mockRejectedValue(Object.assign(new Error('x'), { status: 503 }));
    await expect(
      importOxyFileFromUrl({ kind: 'application' }, 'https://s.example/a.png'),
    ).rejects.toThrow('(HTTP 503)');
    expect(sdk.importAppFile).toHaveBeenCalledTimes(1);
  });

  it('retries uploads, adoptions, large uploads and references, each within its bound', async () => {
    sdk.uploadUserMedia.mockRejectedValueOnce(rateLimited(5)).mockResolvedValueOnce(FILE);
    const upload = uploadOxyFile(
      { kind: 'account', oxyUserId: 'owner' },
      Buffer.from('x'),
      'image/png',
      'product-image',
    );
    await vi.advanceTimersByTimeAsync(5_000);
    expect((await upload).fileId).toBe('oxy-file-1');
    // A merchant waits on an upload: a wait past 20 s is not started.
    sdk.uploadUserMedia.mockRejectedValueOnce(rateLimited(30));
    await expect(
      uploadOxyFile({ kind: 'account', oxyUserId: 'owner' }, Buffer.from('x'), 'image/png', 'p'),
    ).rejects.toThrow('(HTTP 429)');

    const PRIVATE = { ...FILE, visibility: 'private', sha256: 'a'.repeat(64) };
    sdk.adoptAppFile
      .mockRejectedValueOnce(rateLimited(5))
      .mockResolvedValueOnce({ file: PRIVATE, outcome: 'adopted', deduplicated: false });
    const adoption = adoptAsPrivateApplicationFile('source');
    await vi.advanceTimersByTimeAsync(5_000);
    expect((await adoption).fileId).toBe('oxy-file-1');

    sdk.uploadAppFileLarge
      .mockRejectedValueOnce(rateLimited(5))
      .mockResolvedValueOnce({ file: PRIVATE, deduplicated: false, uploadId: 'u' });
    const large = uploadPrivateApplicationFile(new Blob(['x']), 'model/stl', { filename: 'f' });
    await vi.advanceTimersByTimeAsync(5_000);
    expect((await large).fileId).toBe('oxy-file-1');
    expect(sdk.uploadAppFileLarge).toHaveBeenCalledTimes(2);

    const reference = { fileId: 'f', entityType: 'listing_image', entityId: 'l' };
    sdk.add
      .mockRejectedValueOnce(rateLimited(5))
      .mockResolvedValueOnce([{ ...reference, result: 'exists' }]);
    const added = addOxyFileReferences([reference]);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await added).toEqual([{ ...reference, result: 'exists' }]);
    // Inside the outbox's lease: a wait past 30 s is not started.
    sdk.remove.mockRejectedValueOnce(rateLimited(40));
    await expect(removeOxyFileReferences([reference])).rejects.toThrow('(HTTP 429)');
    expect(sdk.remove).toHaveBeenCalledTimes(1);
  });

  it('never retries a reconciliation: its inventory is a stream read once', async () => {
    sdk.reconcile.mockRejectedValue(rateLimited(1));
    await expect(
      reconcileOxyFileReferences('listing_image', (async function* () {})(), { dryRun: true }),
    ).rejects.toThrow('(HTTP 429)');
    expect(sdk.reconcile).toHaveBeenCalledTimes(1);
  });
});

describe('the application’s own files are remembered', () => {
  it('records every file Oxy answered as the application’s, and no account’s', async () => {
    await importOxyFileFromUrl({ kind: 'application' }, 'https://s.example/a.png');
    expect(ledger.record).toHaveBeenLastCalledWith(['oxy-file-1']);
    ledger.record.mockClear();
    await importOxyFileFromUrl({ kind: 'account', oxyUserId: 'owner' }, 'https://s.example/a.png');
    sdk.uploadUserMedia.mockResolvedValue(FILE);
    await uploadOxyFile(
      { kind: 'account', oxyUserId: 'owner' },
      Buffer.from('x'),
      'image/png',
      'p',
    );
    expect(ledger.record).not.toHaveBeenCalled();
    sdk.uploadAppFile.mockResolvedValue({ file: FILE, deduplicated: false });
    await uploadOxyFile({ kind: 'application' }, Buffer.from('x'), 'image/png', 'category-art');
    expect(ledger.record).toHaveBeenCalledExactlyOnceWith(['oxy-file-1']);
  });

  it('never fails a stored file because the record could not be written', async () => {
    ledger.record.mockRejectedValue(new Error('PostgreSQL is not connected.'));
    expect(
      (await importOxyFileFromUrl({ kind: 'application' }, 'https://s.example/a.png')).fileId,
    ).toBe('oxy-file-1');
  });
});
