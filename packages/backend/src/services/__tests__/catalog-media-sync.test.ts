import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { safeFetch, findStoreById, oxyServiceClient, serviceToken, upload } = vi.hoisted(() => ({
  safeFetch: vi.fn(),
  findStoreById: vi.fn(),
  oxyServiceClient: vi.fn(),
  serviceToken: vi.fn(),
  upload: vi.fn(),
}));
vi.mock('@oxy.so/core/server', () => ({ safeFetch }));
vi.mock('../../db/stores/storeRepository.js', () => ({ findStoreById }));
vi.mock('../../capabilities/oxy-service-client.js', () => ({ oxyServiceClient }));
import { synchronizeAccountImages, synchronizeStoreImages } from '../catalog-media/sync.js';

function download(
  chunks: Buffer[] = [Buffer.from('image bytes')],
  headers = { 'content-type': 'image/png' },
  status = 200,
) {
  return { status, headers, response: Readable.from(chunks) };
}
function uploaded(id = 'oxy-file-1', visibility = 'public') {
  return Response.json({ data: { file: { id, visibility } } });
}
beforeEach(() => {
  vi.resetAllMocks();
  findStoreById.mockResolvedValue({ oxyAccountId: 'persisted-owner' });
  serviceToken.mockResolvedValue('internal-service-token');
  oxyServiceClient.mockReturnValue({ baseURL: 'https://api.oxy.so/', serviceToken });
  safeFetch.mockImplementation(async () => download());
  upload.mockImplementation(async () => uploaded());
  vi.stubGlobal('fetch', upload);
});
afterEach(() => vi.unstubAllGlobals());

describe('catalog image synchronization', () => {
  it('imports canonical media under the authenticated account without inventing a store owner', async () => {
    expect(
      await synchronizeAccountImages('authenticated-operator', [
        'https://supplier.example/photo.png',
      ]),
    ).toEqual(['oxy-file-1']);
    expect(findStoreById).not.toHaveBeenCalled();
    expect(upload.mock.calls[0][1].headers['x-owner-user-id']).toBe('authenticated-operator');
  });

  it('requires an authenticated account before downloading canonical media', async () => {
    await expect(
      synchronizeAccountImages(undefined, ['https://supplier.example/photo.png']),
    ).rejects.toThrow(/authenticated owner/);
    expect(safeFetch).not.toHaveBeenCalled();
    expect(upload).not.toHaveBeenCalled();
  });

  it('passes internal IDs without requesting credentials or touching a network', async () => {
    expect(await synchronizeStoreImages('store', ['file-1', 'file_2'])).toEqual([
      'file-1',
      'file_2',
    ]);
    expect(findStoreById).not.toHaveBeenCalled();
    expect(oxyServiceClient).not.toHaveBeenCalled();
    expect(safeFetch).not.toHaveBeenCalled();
    expect(upload).not.toHaveBeenCalled();
  });

  it('stores downloaded bytes under the persisted owner, preserves gallery order and deduplicates sources', async () => {
    const source = 'https://supplier.example/photo.png?signature=private';
    expect(await synchronizeStoreImages('store', [source, 'file-existing', source])).toEqual([
      'oxy-file-1',
      'file-existing',
      'oxy-file-1',
    ]);
    expect(findStoreById).toHaveBeenCalledWith('store');
    expect(safeFetch).toHaveBeenCalledTimes(1);
    expect(safeFetch.mock.calls[0][1]).not.toHaveProperty('headers');
    expect(upload).toHaveBeenCalledTimes(1);
    const [url, request] = upload.mock.calls[0];
    expect(url).toBe('https://api.oxy.so/assets/service/user-media');
    expect(request.headers).toMatchObject({
      'x-owner-user-id': 'persisted-owner',
      Authorization: 'Bearer internal-service-token',
      'Content-Type': 'image/png',
    });
    expect(Buffer.from(request.body).toString()).toBe('image bytes');
    expect(request.redirect).toBe('error');
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
    expect(safeFetch).not.toHaveBeenCalled();
    expect(upload).not.toHaveBeenCalled();
  });

  it('fails closed without a configured Oxy application', async () => {
    oxyServiceClient.mockReturnValue(null);
    await expect(
      synchronizeStoreImages('store', ['https://supplier.example/a.png']),
    ).rejects.toThrow(/credentials/);
    expect(safeFetch).not.toHaveBeenCalled();
  });

  it.each([401, 403, 500])(
    'never falls back to the source when Oxy refuses the upload (%s)',
    async (status) => {
      upload.mockResolvedValue(new Response('failure', { status }));
      await expect(
        synchronizeStoreImages('store', ['https://supplier.example/a.png']),
      ).rejects.toThrow(/Oxy/);
    },
  );

  it.each([
    ['https://supplier.example/not-an-id', 'public'],
    ['oxy-file-1', 'private'],
  ])('refuses an invalid or nonpublic Oxy result', async (id, visibility) => {
    upload.mockResolvedValue(uploaded(id, visibility));
    await expect(
      synchronizeStoreImages('store', ['https://supplier.example/a.png']),
    ).rejects.toThrow(/public.*file ID/);
  });

  it('does not expose a signed source URL from network errors', async () => {
    safeFetch.mockRejectedValue(new Error('failed https://supplier.example/a.png?secret=token'));
    await expect(
      synchronizeStoreImages('store', ['https://supplier.example/a.png?secret=token']),
    ).rejects.toThrow(/^Catalog image synchronization failed\.$/);
    expect(upload).not.toHaveBeenCalled();
  });

  it.each(['status', 'mime', 'empty', 'declared-size', 'streamed-size'])(
    'refuses %s failures and closes the download',
    async (failure) => {
      const response = download(
        failure === 'empty'
          ? []
          : [Buffer.alloc(failure === 'streamed-size' ? 20 * 1024 * 1024 + 1 : 8)],
        failure === 'mime' ? { 'content-type': 'text/html' } : { 'content-type': 'image/png' },
        failure === 'status' ? 404 : 200,
      );
      if (failure === 'declared-size')
        Object.assign(response.headers, { 'content-length': String(20 * 1024 * 1024 + 1) });
      safeFetch.mockResolvedValue(response);
      await expect(
        synchronizeStoreImages('store', ['https://supplier.example/a.png']),
      ).rejects.toThrow();
      expect(upload).not.toHaveBeenCalled();
      expect(response.response.destroyed).toBe(true);
    },
  );
});
