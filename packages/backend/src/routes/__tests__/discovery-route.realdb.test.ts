/**
 * `GET /discovery/feed` over real HTTP against a real database (Task 8).
 *
 * `services/discovery/feed.service.ts` and its own `discovery-feed.realdb.test.ts`
 * already prove the section machine; nothing here re-drives it. What was
 * unproven is the HTTP layer in front of it: the route is MOUNTED at the path a
 * client calls, the `scope` query is parsed by a real Zod schema rather than a
 * hand-rolled `split(':')`, and an unrecognised or missing scope is a 400
 * rather than a silent default to `root` served with a 200.
 *
 * A real ephemeral listener and `fetch`, matching
 * `compatibility-routes.realdb.test.ts` — this repository does not depend on
 * supertest. `optionalAuth` and the `'discovery'` rate limiter are left
 * UN-MOCKED: with no `Authorization` header, `oxy.auth({ optional: true })`
 * never calls out to Oxy at all — it short-circuits to anonymous before any
 * network access.
 *
 * No fixture is seeded: `root` and `deals` build a feed from whatever the
 * shared throwaway database holds (possibly nothing), which is a legitimate
 * `{ sections: [] }`, and a `category:` scope naming a handle nobody created
 * is exactly the case that proves the 404 mapping without this file writing a
 * category row of its own.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { connectPostgres } from '../../db/postgres.js';

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  // The route reads `getDb()` synchronously — the pool must be open before any
  // request reaches the service layer, matching every sibling `*.realdb.test.ts`.
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
  const response = await fetch(`${baseUrl}/discovery/feed${query}`);
  const text = await response.text();
  return {
    status: response.status,
    body: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>),
  };
}

describe('GET /discovery/feed', () => {
  it('serves the root feed to an anonymous caller', async () => {
    const { status, body } = await get('?scope=root');
    expect(status).toBe(200);
    const data = body['data'] as { sections: unknown[] };
    expect(data.sections).toBeInstanceOf(Array);
  });

  it('serves the deals feed too — the same route, a different scope', async () => {
    const { status, body } = await get('?scope=deals');
    expect(status).toBe(200);
    const data = body['data'] as { sections: unknown[] };
    expect(data.sections).toBeInstanceOf(Array);
  });

  it('rejects a scope outside the vocabulary rather than defaulting to root', async () => {
    // A silent default would serve the wrong page for a typo, with a 200.
    const { status } = await get('?scope=everything');
    expect(status).toBe(400);
  });

  it('rejects a missing scope', async () => {
    const { status } = await get('');
    expect(status).toBe(400);
  });

  it('rejects a category scope with an empty handle', async () => {
    const { status } = await get('?scope=category:');
    expect(status).toBe(400);
  });

  it('rejects a query parameter nobody declared', async () => {
    // `.strict()` on the schema, reached through the real route.
    const { status } = await get('?scope=root&sort=trending');
    expect(status).toBe(400);
  });

  it('404s a category scope naming a handle nobody created', async () => {
    // Proves the service's `notFound` reaches the wire as 404 without this
    // file having to seed a real category — the schema already accepted the
    // handle shape, so this is the READ failing, not the parse.
    const { status } = await get('?scope=category:no-such-mercaria-discovery-category');
    expect(status).toBe(404);
  });
});
