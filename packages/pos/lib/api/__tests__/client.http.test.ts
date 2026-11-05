import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { OxyServices } from '@oxy.so/core';
import { isAxiosError } from 'axios';
import { test, vi } from 'vitest';

const config = vi.hoisted(() => ({ apiUrl: '' }));
vi.mock('../../config', () => ({ default: config }));

test('shared HTTP refresh replays JSON, preserves multipart and fences account switches', async () => {
  const token = (id: string, exp = 2_000_000_000) =>
    `e30.${Buffer.from(JSON.stringify({ userId: id, sessionId: id, exp })).toString('base64url')}.fixture`;
  let posts = 0;
  let release: (() => void) | undefined;
  let arrived: (() => void) | undefined;
  const bodies: Array<{ path?: string; body: string; type?: string }> = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    bodies.push({ path: req.url, body, type: req.headers['content-type'] });
    if (req.url === '/refresh-post' && ++posts === 1) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end('{}');
      return;
    }
    if (req.url === '/redirect') {
      res.writeHead(302, { location: 'http://127.0.0.1:1/private' });
      res.end();
      return;
    }
    if (req.url === '/held') {
      const ready = new Promise<void>((resolve) => {
        release = resolve;
      });
      arrived?.();
      await ready;
    }
    res.writeHead(req.url === '/private' && !req.headers.authorization ? 401 : 200, {
      'content-type': 'application/json',
    });
    res.end(
      JSON.stringify({
        bearer: req.headers.authorization ?? null,
        cookie: req.headers.cookie ?? null,
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  config.apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const api = await import('../client');
  const oxy = new OxyServices({ baseURL: config.apiUrl });
  api.bindApiClient(oxy);
  try {
    assert.deepEqual(
      (
        await api.default.get('/public', {
          headers: { Authorization: 'Bearer forged', Cookie: 'ambient=1' },
        })
      ).data,
      { bearer: null, cookie: null },
    );
    await assert.rejects(
      api.default.get('/private'),
      (error: unknown) => isAxiosError(error) && error.response?.status === 401,
    );
    oxy.session.setAccessToken(token('A'));
    let refreshes = 0;
    oxy.http.setAuthRefreshHandler(async () => {
      refreshes++;
      return token('A', 2_000_000_001);
    });
    await api.default.post('/refresh-post', { title: 'Original JSON' });
    assert.equal(posts, 2);
    assert.equal(refreshes, 1);
    assert.deepEqual(
      bodies
        .filter((item) => item.path === '/refresh-post')
        .map(({ body, type }) => ({ body, type })),
      [
        { body: '{"title":"Original JSON"}', type: 'application/json' },
        { body: '{"title":"Original JSON"}', type: 'application/json' },
      ],
    );
    const form = new FormData();
    form.append('file', new Blob(['upload']), 'example.txt');
    await api.default.post('/upload', form, { headers: { 'Content-Type': 'multipart/form-data' } });
    assert.match(bodies.at(-1)?.type ?? '', /^multipart\/form-data; boundary=/);
    assert.match(bodies.at(-1)?.body ?? '', /example.txt/);
    await assert.rejects(api.default.get('/redirect'));
    await assert.rejects(api.default.get('http://127.0.0.1:1/private'));
    const ready = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    const pending = api.default.get('/held');
    await ready;
    oxy.session.setAccessToken(token('B'));
    release?.();
    await assert.rejects(pending, { code: 'AUTH_SESSION_CHANGED' });
    assert.equal((await api.default.get('/private')).data.bearer, `Bearer ${token('B')}`);
    oxy.session.clear();
    assert.equal((await api.default.get('/public')).data.bearer, null);
    api.releaseApiClient(oxy);
    await assert.rejects(api.default.get('/public'), /provider has not bound/);
    // React's repeated effect setup restores the same provider after cleanup.
    api.bindApiClient(oxy);
    assert.equal((await api.default.get('/public')).data.bearer, null);
    const replacement = new OxyServices({ baseURL: config.apiUrl });
    replacement.session.setAccessToken(token('C'));
    try {
      api.bindApiClient(replacement);
      api.releaseApiClient(oxy);
      assert.equal((await api.default.get('/private')).data.bearer, `Bearer ${token('C')}`);
    } finally {
      api.releaseApiClient(replacement);
      replacement.dispose();
    }
  } finally {
    release?.();
    api.releaseApiClient(oxy);
    oxy.dispose();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
