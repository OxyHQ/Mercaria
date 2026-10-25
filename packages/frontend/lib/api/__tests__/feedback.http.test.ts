import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { OxyServices } from '@oxy.so/core';
import { test, vi } from 'vitest';
import { submitFeedback } from '../feedback';

test('feedback retains its linked client until a delayed error body is consumed', async () => {
  let release: (() => void) | undefined;
  let arrived: (() => void) | undefined;
  let bearer: string | undefined;
  const server = createServer(async (req, res) => {
    bearer = req.headers.authorization;
    for await (const _chunk of req) {
      /* drain the request before sending the response */
    }
    res.writeHead(422, { 'content-type': 'application/json' });
    res.write('{"error":');
    const ready = new Promise<void>((resolve) => {
      release = resolve;
    });
    arrived?.();
    await ready;
    res.end('"feedback_disabled"}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const oxy = new OxyServices({ baseURL: origin });
  const token = `e30.${Buffer.from(JSON.stringify({ userId: 'A', sessionId: 'A', exp: 2_000_000_000 })).toString('base64url')}.fixture`;
  oxy.session.setAccessToken(token);
  const createLinkedClient = oxy.createLinkedClient.bind(oxy);
  let disposals = 0;
  const spy = vi.spyOn(oxy, 'createLinkedClient').mockImplementation((config) => {
    const linked = createLinkedClient(config);
    const dispose = linked.dispose.bind(linked);
    linked.dispose = () => {
      disposals++;
      dispose();
    };
    return linked;
  });
  try {
    const ready = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    const pending = submitFeedback(oxy, origin, {
      type: 'bug',
      message: 'Delayed response body',
      rating: null,
      metadata: { platform: 'web', appVersion: '1.0.0' },
    });
    await ready;
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(disposals, 0);
    release?.();
    assert.deepEqual(await pending, { ok: false, error: 'feedback_disabled' });
    assert.equal(bearer, `Bearer ${token}`);
    assert.equal(disposals, 1);
  } finally {
    release?.();
    spy.mockRestore();
    oxy.dispose();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
