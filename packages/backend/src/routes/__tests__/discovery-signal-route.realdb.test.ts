/**
 * `GET /discovery/signal` over real HTTP against a real database.
 *
 * `services/discovery/signal.service.ts` and its own
 * `discovery-signal.realdb.test.ts` already prove pagination, `hasMore` and
 * the status/suppression escapes; nothing here re-drives them. What is new is
 * the HTTP layer: the route is MOUNTED, `signal`/`scope`/`limit`/`offset` are
 * parsed by a real Zod schema, an unrecognised `signal` is a 400 exactly like
 * `/discovery/feed`'s `scope`, `scope=deals` is refused with a 400 rather than
 * silently building an empty page, and `limit`/`offset` are bounded before
 * they ever reach a query.
 *
 * Same device as `discovery-route.realdb.test.ts`: a real ephemeral listener
 * and `fetch`, `optionalAuth` and the rate limiter left UN-MOCKED. No fixture
 * is seeded — `scope=root` builds from whatever the shared database holds,
 * and an unknown `category:` handle is exactly the case that proves the 404
 * mapping without this file writing a category of its own.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { connectPostgres } from '../../db/postgres.js';

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  await connectPostgres();
  const { createApp } = await import('../../app.js');
  const app = createApp();
  server = await new Promise<Server>((resolve) => {
    const started = app.listen(0, () => resolve(started));
  });
  baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
}, 60_000);

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
});

async function get(query: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${baseUrl}/discovery/signal${query}`);
  const text = await response.text();
  return {
    status: response.status,
    body: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>),
  };
}

describe('GET /discovery/signal', () => {
  it('serves a root page to an anonymous caller, with the paged-list shape', async () => {
    const { status, body } = await get('?signal=new&scope=root');
    expect(status).toBe(200);
    const data = body['data'] as {
      signal: string;
      scope: unknown;
      pageDepth: string;
      products: unknown[];
      hasMore: boolean;
    };
    expect(data.signal).toBe('new');
    expect(data.scope).toEqual({ kind: 'root' });
    expect(data.pageDepth).toBe('complete');
    expect(data.products).toBeInstanceOf(Array);
    expect(typeof data.hasMore).toBe('boolean');
  });

  it('defaults limit/offset when omitted', async () => {
    const { status } = await get('?signal=top-rated&scope=root');
    expect(status).toBe(200);
  });

  it('rejects a missing signal', async () => {
    const { status } = await get('?scope=root');
    expect(status).toBe(400);
  });

  it('rejects a signal outside the vocabulary rather than defaulting', async () => {
    const { status } = await get('?signal=trending&scope=root');
    expect(status).toBe(400);
  });

  it('rejects a missing scope', async () => {
    const { status } = await get('?signal=new');
    expect(status).toBe(400);
  });

  it('rejects scope=deals — deals has no per-signal shelf to page', async () => {
    const { status } = await get('?signal=on-sale&scope=deals');
    expect(status).toBe(400);
  });

  it('rejects a scope outside the vocabulary', async () => {
    const { status } = await get('?signal=new&scope=everything');
    expect(status).toBe(400);
  });

  it('rejects a category scope with an empty handle', async () => {
    const { status } = await get('?signal=new&scope=category:');
    expect(status).toBe(400);
  });

  it('rejects limit 0', async () => {
    const { status } = await get('?signal=new&scope=root&limit=0');
    expect(status).toBe(400);
  });

  it('rejects a limit past the server-side ceiling', async () => {
    const { status } = await get('?signal=new&scope=root&limit=101');
    expect(status).toBe(400);
  });

  it('rejects a negative offset', async () => {
    const { status } = await get('?signal=new&scope=root&offset=-1');
    expect(status).toBe(400);
  });

  it('rejects a non-integer offset', async () => {
    const { status } = await get('?signal=new&scope=root&offset=1.5');
    expect(status).toBe(400);
  });

  it('rejects a query parameter nobody declared', async () => {
    const { status } = await get('?signal=new&scope=root&sort=trending');
    expect(status).toBe(400);
  });

  it('404s a category scope naming a handle nobody created', async () => {
    const { status } = await get(
      '?signal=new&scope=category:no-such-mercaria-discovery-signal-category',
    );
    expect(status).toBe(404);
  });
});
