import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { OxyServices } from '@oxy.so/core';
import axios from 'axios';
import { test } from 'vitest';
import { createCommerceTransport } from '../commerce-transport';
import { createCommerceCredentials } from '../commerce-credentials';
import { createCommerceCredential } from '../../stores/commerce-credential';

test('commerce headers survive shared Oxy refresh without cookies, redirects or stale account responses', async () => {
  const token = (id: string, exp = 2_000_000_000) =>
    `e30.${Buffer.from(JSON.stringify({ userId: id, sessionId: id, exp })).toString('base64url')}.fixture`;
  const calls: Array<{
    body: string;
    guest?: string;
    bearer?: string;
    cookie?: string;
    contentType?: string;
  }> = [];
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
      contentType: req.headers['content-type'],
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
    const anonymousReady = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    const anonymousPending = api.get('/held');
    await anonymousReady;
    oxy.session.setAccessToken(token('A'));
    release?.();
    await assert.rejects(anonymousPending);
    const beforeRefresh = calls.length;
    let refreshes = 0;
    oxy.http.setAuthRefreshHandler(async () => {
      refreshes++;
      return token('A', 2_000_000_001);
    });
    await api.post('/refresh', { quantity: 2 });
    assert.equal(refreshes, 1);
    assert.deepEqual(
      calls.slice(beforeRefresh).map((call) => [call.body, call.guest]),
      [
        ['{"quantity":2}', 'guest-original'],
        ['{"quantity":2}', 'guest-original'],
      ],
    );
    const multipart = new FormData();
    multipart.append('upload', new Blob(['body-data'], { type: 'text/plain' }), 'note.txt');
    await api.post('/upload', multipart, { headers: { 'Content-Type': 'multipart/form-data' } });
    assert.match(calls.at(-1)?.contentType ?? '', /^multipart\/form-data; boundary=/);
    assert.match(calls.at(-1)?.body ?? '', /filename="note.txt"/);
    assert.match(calls.at(-1)?.body ?? '', /body-data/);
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

test('unavailable durable storage blocks issuance, but public browsing and Oxy carts still use the real shared transport', async () => {
  const requests: string[] = [];
  const server = createServer((req, res) => {
    requests.push(`${req.method} ${req.url} ${req.headers.authorization ? 'oxy' : 'anonymous'}`);
    res.writeHead(200, { 'Content-Type': 'application/json' }).end('{}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const oxy = new OxyServices({ baseURL });
  const unavailable = () =>
    createCommerceCredential({
      read: async () => {
        throw new Error('Storage disabled');
      },
      write: async () => {
        throw new Error('Storage disabled');
      },
      remove: async () => {
        throw new Error('Storage disabled');
      },
    });
  const credentials = {
    guestCredential: unavailable(),
    portalCredential: unavailable(),
    referralCredential: unavailable(),
  };
  const transport = createCommerceTransport(
    oxy,
    baseURL,
    createCommerceCredentials(oxy, credentials, 'web'),
  );
  try {
    await (await transport.fetch(`${baseURL}/products`)).text();
    await assert.rejects(
      transport.fetch(`${baseURL}/cart/items`, { method: 'POST', body: '{}' }),
      /storage/i,
    );
    await assert.rejects(
      transport.fetch(`${baseURL}/guest/orders/exchange`, { method: 'POST', body: '{}' }),
      /storage/i,
    );
    oxy.session.setAccessToken(
      `e30.${Buffer.from(JSON.stringify({ userId: 'A', sessionId: 'A', exp: 2_000_000_000 })).toString('base64url')}.fixture`,
    );
    await (await transport.fetch(`${baseURL}/cart/items`, { method: 'POST', body: '{}' })).text();
    assert.deepEqual(requests, ['GET /products anonymous', 'POST /cart/items oxy']);
  } finally {
    transport.dispose();
    oxy.dispose();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('failed response credential persistence cancels the real response stream and preserves the error', async () => {
  let closed!: () => void;
  const connectionClosed = new Promise<void>((resolve) => {
    closed = resolve;
  });
  const server = createServer((_req, res) => {
    res.on('close', closed);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.write('{"pending":');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const oxy = new OxyServices({ baseURL });
  const failure = new Error('Durable credential write failed');
  const transport = createCommerceTransport(oxy, baseURL, {
    prepare: async () => ({
      headers: new Headers(),
      accept: async () => {
        throw failure;
      },
    }),
  });
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    await assert.rejects(transport.fetch(baseURL), (error) => error === failure);
    await Promise.race([
      connectionClosed,
      new Promise<never>((_, reject) => {
        deadline = setTimeout(() => reject(new Error('Response stream remained open')), 5_000);
      }),
    ]);
  } finally {
    clearTimeout(deadline);
    transport.dispose();
    oxy.dispose();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test.each(['Guest', 'Portal'] as const)(
  'real %s persistence failure rejects issuance and closes the response stream',
  async (kind) => {
    let closed!: () => void;
    const connectionClosed = new Promise<void>((resolve) => {
      closed = resolve;
    });
    const server = createServer((_req, res) => {
      res.on('close', closed);
      res.writeHead(200, {
        'Content-Type': 'application/json',
        [`X-Mercaria-${kind}-Token`]: kind === 'Guest' ? 'mgs_new' : 'mgp_new',
        [`X-Mercaria-${kind}-Expires-At`]: new Date(Date.now() + 86400000).toISOString(),
        [`X-Mercaria-${kind}-Generation`]: '1',
      });
      res.write('{"pending":');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const oxy = new OxyServices({ baseURL });
    const empty = () =>
      createCommerceCredential({
        read: async () => null,
        write: async () => {},
        remove: async () => {},
      });
    const failed = createCommerceCredential({
      read: async () => null,
      write: async () => {
        throw new Error('Disk full');
      },
      remove: async () => {},
    });
    const credentials = {
      guestCredential: kind === 'Guest' ? failed : empty(),
      portalCredential: kind === 'Portal' ? failed : empty(),
      referralCredential: empty(),
    };
    const transport = createCommerceTransport(
      oxy,
      baseURL,
      createCommerceCredentials(oxy, credentials, 'ios'),
    );
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      const path = kind === 'Guest' ? '/cart/items' : '/guest/orders/exchange';
      await assert.rejects(
        transport.fetch(`${baseURL}${path}`, { method: 'POST', body: '{}' }),
        /could not be saved/,
      );
      assert.equal(failed.current().storageAvailable, false);
      assert.equal(await failed.persisted(), false);
      await Promise.race([
        connectionClosed,
        new Promise<never>((_, reject) => {
          deadline = setTimeout(() => reject(new Error('Response stream remained open')), 5000);
        }),
      ]);
    } finally {
      clearTimeout(deadline);
      transport.dispose();
      oxy.dispose();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);

test('known storage failure is negotiated before guest rotation while catalog and Oxy actors remain usable', async () => {
  let guestReads = 0;
  const markers: Array<string | undefined> = [];
  const server = createServer((req, res) => {
    markers.push(req.headers['x-mercaria-guest-persistence'] as string | undefined);
    if (req.url === '/cart' && !req.headers.authorization) {
      if (req.headers['x-mercaria-guest-persistence'] === 'unavailable') {
        res.writeHead(503).end('{}');
        return;
      }
      guestReads++;
    }
    res.writeHead(200).end('{}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const oxy = new OxyServices({ baseURL });
  const guestCredential = createCommerceCredential(
    {
      read: async () => 'mgs_existing',
      write: async () => {
        throw new Error('Disk full');
      },
      remove: async () => {},
    },
    Date.now,
    false,
    { rotationPreservesAuthority: true },
  );
  await guestCredential.ready;
  guestCredential
    .snapshot()
    .accept('mgs_existing', new Date(Date.now() + 86400000).toISOString(), '1');
  await guestCredential.settled();
  const empty = () =>
    createCommerceCredential({
      read: async () => null,
      write: async () => {},
      remove: async () => {},
    });
  const transport = createCommerceTransport(
    oxy,
    baseURL,
    createCommerceCredentials(
      oxy,
      { guestCredential, portalCredential: empty(), referralCredential: empty() },
      'web',
    ),
  );
  try {
    const refused = await transport.fetch(`${baseURL}/cart`);
    assert.equal(refused.status, 503);
    await refused.text();
    assert.equal(guestReads, 0);
    assert.equal(guestCredential.current().token, 'mgs_existing');
    const catalog = await transport.fetch(`${baseURL}/products`);
    assert.equal(catalog.status, 200);
    await catalog.text();
    oxy.session.setAccessToken(
      `e30.${Buffer.from(JSON.stringify({ userId: 'A', sessionId: 'A', exp: 2_000_000_000 })).toString('base64url')}.fixture`,
    );
    const own = await transport.fetch(`${baseURL}/cart`);
    assert.equal(own.status, 200);
    await own.text();
    assert.deepEqual(markers, ['unavailable', 'unavailable', 'unavailable']);
    assert.equal(guestReads, 0);
    assert.equal(guestCredential.current().token, 'mgs_existing');
  } finally {
    transport.dispose();
    oxy.dispose();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test.each([
  ['guest', 'headers'],
  ['guest', 'body'],
  ['portal', 'headers'],
  ['portal', 'body'],
] as const)(
  '%s authority change aborts a pending %s response from the old owner',
  async (kind, phase) => {
    let arrived!: () => void;
    let finish!: () => void;
    const reached = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const server = createServer(async (_req, res) => {
      if (phase === 'body') {
        res.writeHead(200, { 'Content-Type': 'application/json', 'X-Test': 'original' });
        res.write('{"owner":');
      }
      arrived();
      await gate;
      if (phase === 'headers')
        res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"owner":"A"}');
      else res.end('"A"}');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const oxy = new OxyServices({ baseURL });
    const memory = (token: string | null) =>
      createCommerceCredential(
        { read: async () => token, write: async () => {}, remove: async () => {} },
        Date.now,
        false,
        { rotationPreservesAuthority: kind === 'guest' },
      );
    const guestCredential = memory(kind === 'guest' ? 'mgs_A' : null);
    const portalCredential = memory(kind === 'portal' ? 'mgp_A' : null);
    const credentials = createCommerceCredentials(
      oxy,
      { guestCredential, portalCredential, referralCredential: memory(null) },
      'ios',
    );
    const transport = createCommerceTransport(oxy, baseURL, credentials);
    try {
      const pending = transport.fetch(`${baseURL}/held`);
      await reached;
      let reading: Promise<unknown> = pending;
      if (phase === 'body') {
        const response = await pending;
        assert.equal(response.status, 200);
        assert.equal(response.headers.get('X-Test'), 'original');
        assert.equal(response.url, `${baseURL}/held`);
        reading = response.json();
      }
      const rejected = assert.rejects(reading);
      if (kind === 'guest') guestCredential.clear();
      else
        portalCredential
          .snapshot()
          .accept('mgp_B', new Date(Date.now() + 86400000).toISOString(), '2');
      await rejected;
      finish();
    } finally {
      finish();
      transport.dispose();
      oxy.dispose();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);

test('domain listeners release on EOF, body cancel, failed headers and disposal; native buffered text stays intact', async () => {
  const server = createServer((req, res) => {
    if (req.url === '/broken') {
      res.destroy();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    if (req.url === '/held') {
      res.write('pending');
      return;
    }
    res.end('native-and-web-payload');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const oxy = new OxyServices({ baseURL });
  const empty = () =>
    createCommerceCredential({
      read: async () => null,
      write: async () => {},
      remove: async () => {},
    });
  const guestCredential = empty();
  const actual = createCommerceCredentials(
    oxy,
    { guestCredential, portalCredential: empty(), referralCredential: empty() },
    'ios',
  );
  let listeners = 0;
  const transport = createCommerceTransport(oxy, baseURL, {
    ...actual,
    prepare: async (request) => {
      const snapshot = await actual.prepare(request);
      return {
        ...snapshot,
        onAuthorityChange(listener) {
          listeners++;
          const unsubscribe = snapshot.onAuthorityChange?.(listener);
          return () => {
            listeners--;
            unsubscribe?.();
          };
        },
      };
    },
  });
  const originalFetch = globalThis.fetch;
  try {
    assert.equal(
      await (await transport.fetch(`${baseURL}/complete`)).text(),
      'native-and-web-payload',
    );
    assert.equal(listeners, 0);
    const cancelled = await transport.fetch(`${baseURL}/held`);
    await cancelled.body?.cancel();
    assert.equal(listeners, 0);
    await assert.rejects(transport.fetch(`${baseURL}/broken`));
    assert.equal(listeners, 0);
    // Real HTTP payload, with the RN shape: the internal body remains buffered,
    // but no ReadableStream is exposed through Response.body.
    globalThis.fetch = (async (input, init) => {
      const response = await originalFetch(input, init);
      Object.defineProperty(response, 'body', { value: null });
      return response;
    }) as typeof fetch;
    const native = await transport.fetch(`${baseURL}/native`);
    assert.equal(native.body, null);
    assert.equal(await native.text(), 'native-and-web-payload');
    assert.equal(listeners, 0);
    const nativeWithClone = await transport.fetch(`${baseURL}/native`);
    const cloned = nativeWithClone.clone();
    assert.equal(await nativeWithClone.text(), 'native-and-web-payload');
    guestCredential.clear();
    await assert.rejects(cloned.text());
    assert.equal(listeners, 0);
    globalThis.fetch = originalFetch;
    await transport.fetch(`${baseURL}/held`);
    assert.equal(listeners, 1);
    guestCredential.clear();
    assert.equal(listeners, 0);
    await transport.fetch(`${baseURL}/held`);
    assert.equal(listeners, 1);
    transport.dispose();
    assert.equal(listeners, 0);
  } finally {
    globalThis.fetch = originalFetch;
    transport.dispose();
    oxy.dispose();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
