import { beforeEach, describe, expect, it, vi } from 'vitest';

const { findStoreById, oxyServiceClient, importUserMedia, importAppFile } = vi.hoisted(() => ({
  findStoreById: vi.fn(),
  oxyServiceClient: vi.fn(),
  importUserMedia: vi.fn(),
  importAppFile: vi.fn(),
}));
vi.mock('../../db/stores/storeRepository.js', () => ({ findStoreById }));
vi.mock('../../capabilities/oxy-service-client.js', () => ({ oxyServiceClient }));
import {
  synchronizeAccountImages,
  synchronizeApplicationImages,
  synchronizeStoreImages,
} from '../catalog-media/sync.js';

/** What Oxy answers for an import by URL (ADR 0041 D7). */
function imported(id = 'oxy-file-1', overrides: Record<string, unknown> = {}) {
  return {
    file: { id, mime: 'image/png', size: 10, visibility: 'public', status: 'active', ...overrides },
    outcome: 'downloaded',
    deduplicated: false,
  };
}
function refused(status: number, message = `HTTP ${status}`) {
  return Object.assign(new Error(message), { status });
}

beforeEach(() => {
  vi.resetAllMocks();
  findStoreById.mockResolvedValue({ oxyAccountId: 'persisted-owner' });
  oxyServiceClient.mockReturnValue({ assets: { importUserMedia, importAppFile } });
  importUserMedia.mockImplementation(async () => imported());
  importAppFile.mockImplementation(async () => imported('oxy-app-file'));
});

describe('catalog image synchronization', () => {
  it('imports under the authenticated account without inventing a store owner', async () => {
    expect(
      await synchronizeAccountImages('authenticated-seller', [
        'https://supplier.example/photo.png',
      ]),
    ).toEqual(['oxy-file-1']);
    expect(findStoreById).not.toHaveBeenCalled();
    expect(importUserMedia).toHaveBeenCalledExactlyOnceWith(
      'authenticated-seller',
      'https://supplier.example/photo.png',
      { visibility: 'public' },
    );
    expect(importAppFile).not.toHaveBeenCalled();
  });

  it('imports content no account owns as the Mercaria application, never an operator', async () => {
    expect(await synchronizeApplicationImages(['https://supplier.example/photo.png'])).toEqual([
      'oxy-app-file',
    ]);
    expect(importAppFile).toHaveBeenCalledExactlyOnceWith('https://supplier.example/photo.png', {
      visibility: 'public',
    });
    expect(importUserMedia).not.toHaveBeenCalled();
  });

  it('requires an authenticated account before importing account media', async () => {
    await expect(
      synchronizeAccountImages(undefined, ['https://supplier.example/photo.png']),
    ).rejects.toThrow(/authenticated owner/);
    expect(importUserMedia).not.toHaveBeenCalled();
  });

  it('passes internal IDs without requesting credentials or touching a network', async () => {
    expect(await synchronizeStoreImages('store', ['file-1', 'file_2'])).toEqual([
      'file-1',
      'file_2',
    ]);
    expect(findStoreById).not.toHaveBeenCalled();
    expect(oxyServiceClient).not.toHaveBeenCalled();
  });

  it('imports under the persisted store owner, preserves gallery order and asks once per source', async () => {
    const source = 'https://supplier.example/photo.png?signature=private';
    expect(await synchronizeStoreImages('store', [source, 'file-existing', source])).toEqual([
      'oxy-file-1',
      'file-existing',
      'oxy-file-1',
    ]);
    expect(findStoreById).toHaveBeenCalledWith('store');
    expect(importUserMedia).toHaveBeenCalledExactlyOnceWith('persisted-owner', source, {
      visibility: 'public',
    });
  });

  it.each([
    'http://supplier.example/a.png',
    'https://user:secret@supplier.example/a.png',
    'data:image/png;base64,abcd',
    '/relative.png',
    '',
  ])('rejects invalid reference %s before importing any gallery member', async (bad) => {
    await expect(
      synchronizeStoreImages('store', ['https://supplier.example/ok.png', bad]),
    ).rejects.toThrow(/HTTPS|file ID/);
    expect(importUserMedia).not.toHaveBeenCalled();
  });

  it('fails closed without a configured Oxy application', async () => {
    oxyServiceClient.mockReturnValue(null);
    await expect(
      synchronizeStoreImages('store', ['https://supplier.example/a.png']),
    ).rejects.toThrow(/credentials/);
  });

  it.each([401, 403, 500])(
    'never falls back to the source when Oxy refuses (%s)',
    async (status) => {
      importUserMedia.mockRejectedValue(refused(status));
      await expect(
        synchronizeStoreImages('store', ['https://supplier.example/a.png']),
      ).rejects.toThrow(/Oxy/);
    },
  );

  it.each([
    ['https://supplier.example/not-an-id', {}],
    ['oxy-file-1', { visibility: 'private' }],
    ['oxy-file-1', { mime: 'video/mp4' }],
    ['oxy-file-1', { mime: 'text/html' }],
    ['oxy-file-1', { size: 0 }],
  ])('refuses an invalid, nonpublic or wrong-kind Oxy result (%s %j)', async (id, overrides) => {
    importUserMedia.mockResolvedValue(imported(id, overrides));
    await expect(
      synchronizeStoreImages('store', ['https://supplier.example/a.png']),
    ).rejects.toThrow(/Oxy|image/);
  });

  it('does not expose a signed source URL from an Oxy error', async () => {
    importUserMedia.mockRejectedValue(
      refused(502, 'failed https://supplier.example/a.png?secret=token'),
    );
    const failure = await synchronizeStoreImages('store', [
      'https://supplier.example/a.png?secret=token',
    ]).catch((error: Error) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe('Oxy could not import the media source (HTTP 502).');
    expect((failure as Error).message).not.toMatch(/supplier|secret/);
  });
});
