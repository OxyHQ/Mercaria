import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { productMediaRouter } from '../product-media.js';
import { PRODUCT_IMAGE_MAX_BYTES } from '../../../services/catalog-media/upload.js';

vi.mock('../../../capabilities/oxy-service-client.js', () => ({ oxyServiceClient: () => ({ baseURL: 'https://oxy.test', serviceToken: async () => 'isolated-service-token' }) }));
const flags = vi.hoisted(() => ({ video: false }));
vi.mock('../../../config/index.js', () => ({ config: { catalog: { get videoWritesEnabled() { return flags.video; } } } }));
const originalFetch = globalThis.fetch;
const upstream = vi.fn();
let server: Server; let origin: string;
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aK1sAAAAASUVORK5CYII=', 'base64');
beforeAll(async () => {
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => {
    req.store = { oxyAccountId: 'persisted-store-account' } as typeof req.store;
    req.storeAccess = { permissions: req.get('x-test-permission') === 'write' ? ['products:write'] : ['products:read'] } as typeof req.storeAccess;
    next();
  });
  app.use('/products/media', productMediaRouter);
  server = app.listen(0); await new Promise<void>(resolve => server.once('listening', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
beforeEach(() => {
  flags.video = false;
  upstream.mockReset().mockResolvedValue(new Response(JSON.stringify({ data: { file: { id: 'oxy-imported-image', visibility: 'public' } } }), { status: 201 }));
  vi.stubGlobal('fetch', ((input, init) => String(input).startsWith('https://oxy.test') ? upstream(input, init) : originalFetch(input, init)) as typeof fetch);
});
afterAll(async () => { vi.unstubAllGlobals(); await new Promise<void>(resolve => server.close(() => resolve())); });
const send = (body: Buffer, mime = 'image/png', permission = 'write') => fetch(`${origin}/products/media`, {
  method: 'POST', headers: { 'Content-Type': mime, 'x-test-permission': permission, 'x-owner-user-id': 'attacker-account' }, body: new Uint8Array(body),
});
it('passes real image bytes through the JSON-mounted router and derives owner exclusively from the store', async () => {
  const response = await send(png); expect(response.status).toBe(201);
  expect(await response.json()).toEqual({ success: true, data: { fileId: 'oxy-imported-image', kind: 'image' } });
  expect(upstream).toHaveBeenCalledTimes(1);
  const [url, request] = upstream.mock.calls[0];
  expect(url).toBe('https://oxy.test/assets/service/user-media');
  expect(request.headers['x-owner-user-id']).toBe('persisted-store-account');
  expect(request.headers.Authorization).toBe('Bearer isolated-service-token');
  expect(Buffer.from(request.body)).toEqual(png);
});
it('refuses read-only operators before upload, while write permission does not require store:manage', async () => {
  expect((await send(png, 'image/png', 'read')).status).toBe(403); expect(upstream).not.toHaveBeenCalled();
});
it('rejects unsupported, empty, mislabeled and over-limit bytes without reaching Oxy', async () => {
  expect((await send(Buffer.from('<svg/>'), 'image/svg+xml')).status).toBe(415);
  expect((await send(Buffer.alloc(0))).status).toBe(400);
  expect((await send(Buffer.from('<script/>'))).status).toBe(400);
  expect((await send(Buffer.alloc(PRODUCT_IMAGE_MAX_BYTES + 1))).status).toBe(413);
  expect(upstream).not.toHaveBeenCalled();
});
it('returns an honest retryable error for Oxy failures, never an invented file ID or upstream secrets', async () => {
  upstream.mockResolvedValueOnce(new Response('secret service failure', { status: 403 }));
  const response = await send(png); expect(response.status).toBe(502); expect(await response.text()).not.toContain('secret');
});
it.each([{ id: 'https://external.test/photo.png', visibility: 'public' }, { id: 'oxy-id', visibility: 'private' }, {}])('refuses invalid Oxy response metadata %o', async file => {
  upstream.mockResolvedValueOnce(new Response(JSON.stringify({ data: { file } })));
  expect((await send(png)).status).toBe(502);
});

it('gates new MP4 uploads, derives the owner from store authority and verifies the Oxy kind', async () => {
  const mp4 = Buffer.from('00000018667479706d703432000000006d70343269736f6d', 'hex');
  expect((await send(mp4, 'video/mp4')).status).toBe(503); expect(upstream).not.toHaveBeenCalled();
  flags.video = true;
  expect((await send(mp4, 'video/mp4', 'read')).status).toBe(403); expect(upstream).not.toHaveBeenCalled();
  upstream.mockResolvedValueOnce(Response.json({ data: { file: { id: 'oxy-video', visibility: 'public', mime: 'video/mp4', size: mp4.length } } }));
  const response = await send(mp4, 'video/mp4'); expect(response.status).toBe(201);
  expect(await response.json()).toEqual({ success: true, data: { fileId: 'oxy-video', kind: 'video' } });
  expect(upstream.mock.calls[0][1].headers['x-owner-user-id']).toBe('persisted-store-account');
  expect((await send(png, 'video/mp4')).status).toBe(400);
  upstream.mockResolvedValueOnce(Response.json({ data: { file: { id: 'oxy-video', visibility: 'public', mime: 'image/png', size: mp4.length } } }));
  expect((await send(mp4, 'video/mp4')).status).toBe(502);
});
