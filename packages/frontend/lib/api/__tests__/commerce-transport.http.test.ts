import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { OxyServices } from '@oxy.so/core';
import axios from 'axios';
import { test } from 'vitest';
import { createCommerceTransport } from '../commerce-transport';

test('commerce headers survive shared Oxy refresh without cookies, redirects or stale account responses', async () => {
  const token = (id: string, exp = 2_000_000_000) =>
    `e30.${Buffer.from(JSON.stringify({ userId: id, sessionId: id, exp })).toString('base64url')}.fixture`;
  const calls: Array<{ body: string; guest?: string; bearer?: string; cookie?: string }> = [];
  let posts = 0;
  let release: (() => void) | undefined;
  let arrived: (() => void) | undefined;
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    calls.push({
      body,
      guest: req.headers['x-mercaria-guest-token'] as string | undefined,
      bearer: req.headers.authorization,
      cookie: req.headers.cookie,
    });
    if (req.url === '/refresh' && ++posts === 1) {
      res.writeHead(401).end();
      return;
    }
    if (req.url === '/redirect') {
      res.writeHead(307, { location: '/must-not-run' }).end();
      return;
    }
    if (req.url === '/held') {
      const ready = new Promise<void>((resolve) => {
        release = resolve;
      });
      arrived?.();
      await ready;
    }
    res.writeHead(200, { 'content-type': 'application/json', 'x-mercaria-guest-token': 'rotated' });
    res.end('{}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const oxy = new OxyServices({ baseURL });
  let accepted = 0;
  const transport = createCommerceTransport(oxy, baseURL, {
    prepare: async () => ({
      headers: new Headers({ 'x-mercaria-guest-token': 'guest-original' }),
      accept: () => {
        accepted++;
      },
    }),
  });
  const api = axios.create({
    baseURL,
    adapter: 'fetch',
    withCredentials: false,
    xsrfCookieName: '',
    withXSRFToken: false,
    env: {
      // @ts-expect-error Axios supports null at runtime to preserve replayable bodies.
      Request: null,
      fetch: transport.fetch,
    },
  });
  try {
    await api.get('/public', { headers: { Cookie: 'ambient=1', Authorization: 'Bearer forged' } });
    assert.equal(calls[0]?.cookie, undefined);
    assert.equal(calls[0]?.bearer, undefined);
    assert.equal(calls[0]?.guest, 'guest-original');
    oxy.session.setAccessToken(token('A'));
    let refreshes = 0;
    oxy.http.setAuthRefreshHandler(async () => {
      refreshes++;
      return token('A', 2_000_000_001);
    });
    await api.post('/refresh', { quantity: 2 });
    assert.equal(refreshes, 1);
    assert.deepEqual(
      calls.slice(1).map((call) => [call.body, call.guest]),
      [
        ['{"quantity":2}', 'guest-original'],
        ['{"quantity":2}', 'guest-original'],
      ],
    );
    const beforeRedirect = calls.length;
    await assert.rejects(api.get('/redirect'));
    assert.equal(calls.length, beforeRedirect + 1);
    await assert.rejects(api.get('http://127.0.0.1:1/foreign'));
    const ready = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    const pending = api.get('/held');
    await ready;
    const beforeSwitch = accepted;
    oxy.session.setAccessToken(token('B'));
    release?.();
    await assert.rejects(pending);
    assert.equal(accepted, beforeSwitch);
    await api.get('/current');
    assert.equal(calls.at(-1)?.bearer, `Bearer ${token('B')}`);
    oxy.session.clear();
    await api.get('/public');
    assert.equal(calls.at(-1)?.bearer, undefined);
  } finally {
    release?.();
    transport.dispose();
    oxy.dispose();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
