import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { OxyServices } from '@oxy.so/core';
import { test } from 'vitest';

test('checkout can read private addresses through the installed Oxy client without reusing another account cache', async () => {
  const token = (account: string) =>
    `e30.${Buffer.from(JSON.stringify({ userId: account, sessionId: account, exp: 2_000_000_000 })).toString('base64url')}.fixture`;
  const requests: Array<{ url?: string; authorization?: string }> = [];
  const server = createServer((req, res) => {
    requests.push({ url: req.url, authorization: req.headers.authorization });
    const account = req.headers.authorization === `Bearer ${token('B')}` ? 'B' : 'A';
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify([
        {
          id: `address-${account}`,
          recipientName: `Recipient ${account}`,
          line1: '10 Example Street',
          city: 'Wilmington',
          region: 'DE',
          postalCode: '19802',
          country: 'US',
          isDefault: true,
          createdAt: '2026-11-06T00:00:00.000Z',
          updatedAt: '2026-11-06T00:00:00.000Z',
        },
      ]),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const oxy = new OxyServices({
    baseURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
  });
  try {
    oxy.session.setAccessToken(token('A'));
    assert.equal((await oxy.addresses.list())[0]?.id, 'address-A');
    assert.equal((await oxy.addresses.list())[0]?.id, 'address-A');
    oxy.session.setAccessToken(token('B'));
    assert.equal((await oxy.addresses.list())[0]?.id, 'address-B');
    assert.deepEqual(requests, [
      { url: '/addresses', authorization: `Bearer ${token('A')}` },
      { url: '/addresses', authorization: `Bearer ${token('A')}` },
      { url: '/addresses', authorization: `Bearer ${token('B')}` },
    ]);
  } finally {
    oxy.dispose();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
