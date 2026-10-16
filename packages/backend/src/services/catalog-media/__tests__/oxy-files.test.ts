/**
 * `oxy-files.ts` — the ONE adapter to Oxy Files. What it promises its callers:
 * the owner is decided by the call (never a body field), every answer is
 * validated before an id leaves it, and no error carries a source URL.
 */

import { createHmac } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const sdk = vi.hoisted(() => ({
  importAppFile: vi.fn(),
  importUserMedia: vi.fn(),
  uploadAppFile: vi.fn(),
  uploadUserMedia: vi.fn(),
  add: vi.fn(),
  remove: vi.fn(),
  reconcile: vi.fn(),
  configured: true,
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
            references: { add: sdk.add, remove: sdk.remove, reconcile: sdk.reconcile },
          },
        }
      : null,
}));
import {
  addOxyFileReferences,
  importOxyFileFromUrl,
  removeOxyFileReferences,
  uploadOxyFile,
  verifyOxyFileDelivery,
} from '../oxy-files.js';

const FILE = { id: 'oxy-file-1', mime: 'image/png', size: 10, visibility: 'public' };

beforeEach(() => {
  vi.resetAllMocks();
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
