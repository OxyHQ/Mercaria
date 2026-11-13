import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { OxyServices } from '@oxy.so/core';
import { test } from 'vitest';
import { createGoWaySessionClient } from '../session-client';

test('product SDK delegates refresh and fences account switches, redirects and disposal', async () => {
  const token = (id: string, exp = 2_000_000_000) =>
    `e30.${Buffer.from(JSON.stringify({ userId: id, sessionId: id, exp })).toString('base64url')}.fixture`;
  const requests: Array<{ auth?: string; cookie?: string }> = [];
  let release: (() => void) | undefined;
  let arrived: (() => void) | undefined;
  const server = createServer(async (req, res) => {
    requests.push({ auth: req.headers.authorization, cookie: req.headers.cookie });
    if (requests.length === 1) {
      res.writeHead(401);
      res.end('{}');
      return;
    }
    if (req.url?.includes('redirect')) {
      res.writeHead(302, { location: 'http://127.0.0.1:1/private' });
      res.end();
      return;
    }
    if (req.url?.includes('held')) {
      const ready = new Promise<void>((resolve) => {
        release = resolve;
      });
      arrived?.();
      await ready;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ items: [], nextCursor: null, providers: [] }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const oxy = new OxyServices({ baseURL: origin });
  const bound = createGoWaySessionClient(oxy, origin, 'en');
  const read = (query: string) => bound.client.search.query({ query });
  try {
    oxy.session.setAccessToken(token('A'));
    let refreshes = 0;
    oxy.http.setAuthRefreshHandler(async () => {
      refreshes++;
      return token('A', 2_000_000_001);
    });
    await read('ordinary');
    assert.equal(refreshes, 1);
    assert.deepEqual(
      requests.map((request) => request.auth),
      [`Bearer ${token('A')}`, `Bearer ${token('A', 2_000_000_001)}`],
    );
    assert.ok(requests.every((request) => request.cookie === undefined));
    const ready = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    const pending = read('held');
    await ready;
    oxy.session.setAccessToken(token('B'));
    release?.();
    await assert.rejects(pending);
    await read('ordinary');
    assert.equal(requests.at(-1)?.auth, `Bearer ${token('B')}`);
    await assert.rejects(read('redirect'));
    bound.dispose();
    await assert.rejects(read('ordinary'));
    bound.activate();
    await read('ordinary');
    assert.equal(requests.at(-1)?.auth, `Bearer ${token('B')}`);
    oxy.session.clear();
    await read('ordinary');
    assert.equal(requests.at(-1)?.auth, undefined);
  } finally {
    release?.();
    bound.dispose();
    oxy.dispose();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
