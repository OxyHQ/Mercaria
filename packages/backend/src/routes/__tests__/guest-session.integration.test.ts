/**
 * The guest-session surface against the REAL app (#103, ADR 0003).
 *
 * `createApp()` builds the actual middleware chain production runs — CORS,
 * the raw-body webhook mounts, `express.json()`, the resolver — so what is
 * asserted here is the wire behaviour a browser or the Expo app actually
 * gets: explicit credential headers, refusal before unsupported issuance,
 * and tokens never appearing in response bodies or newly issued cookies.
 *
 * ## Env is set BEFORE any import, like the Stripe webhook file beside this
 *
 * `config/index.ts` freezes at module load and `app.ts` gates the
 * `/guest/session` MOUNT on the frozen value, so everything is imported
 * dynamically after `beforeAll` sets `GUEST_COMMERCE_ENABLED` and the two M8
 * keys. The kill-switch and disabled-mount deployments are each their own
 * file for the same reason — one process, one frozen config.
 *
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

const ALLOWED_ORIGIN = 'https://mercaria.co';
const DEV_COOKIE = 'mercaria_guest_dev';
const TOKEN_HEADER = 'x-mercaria-guest-token';

let baseUrl: string;
const servers: Server[] = [];
let closePostgres: typeof import('../../db/postgres.js').closePostgres;

beforeAll(async () => {
  process.env.GUEST_COMMERCE_ENABLED = 'true';
  process.env.GUEST_PII_ENCRYPTION_KEY = 'integration-test-pii-key';
  process.env.GUEST_EMAIL_HASH_KEY = 'integration-test-email-hash-key';
  // Explicit, not assumed: vitest may run several files in one worker thread,
  // and the kill-switch file sets this to 'false' — env leaks, configs do not.
  process.env.GUEST_SESSION_ISSUANCE_ENABLED = 'true';

  const { createApp } = await import('../../app.js');
  const postgres = await import('../../db/postgres.js');
  closePostgres = postgres.closePostgres;
  await postgres.connectPostgres();

  const server = createApp().listen(0);
  servers.push(server);
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 120_000);

afterAll(async () => {
  await Promise.all(
    servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
  await closePostgres();
});

async function issue(): Promise<{ token: string; id: string; expiresAt: string }> {
  const res = await fetch(`${baseUrl}/guest/session`, {
    method: 'POST',
    headers: {
      'x-mercaria-guest-transport': 'header',
      'x-mercaria-guest-client': 'web',
      origin: ALLOWED_ORIGIN,
    },
  });
  expect(res.status).toBe(201);
  expect(res.headers.getSetCookie()).toEqual([]);
  expect(res.headers.get('cache-control')).toBe('no-store');
  const token = res.headers.get(TOKEN_HEADER);
  expect(token).toMatch(/^mgs_[A-Za-z0-9_-]{43}$/);
  const body = (await res.json()) as { data: { id: string } };
  expect(JSON.stringify(body)).not.toContain('mgs_');
  return {
    token: token ?? '',
    id: body.data.id,
    expiresAt: res.headers.get('x-mercaria-guest-expires-at') ?? '',
  };
}

describe('header-only guest commerce through the real app', () => {
  it('issues once and reuses the same owner and absolute expiry', async () => {
    const issued = await issue();
    const inspect = await fetch(`${baseUrl}/guest/session`, {
      headers: { [TOKEN_HEADER]: issued.token },
    });
    expect(inspect.status).toBe(200);
    expect(inspect.headers.get('cache-control')).toBe('no-store');
    expect(((await inspect.json()) as { data: { id: string } }).data.id).toBe(issued.id);
    const again = await fetch(`${baseUrl}/guest/session`, {
      method: 'POST',
      headers: { [TOKEN_HEADER]: issued.token, 'x-mercaria-guest-transport': 'header' },
    });
    expect(again.status).toBe(200);
    const reused = (await again.json()) as { data: { id: string; expiresAt: string } };
    expect(reused.data.id).toBe(issued.id);
    expect(reused.data.expiresAt).toBe(issued.expiresAt);
    expect(again.headers.getSetCookie()).toEqual([]);
    expect(Number.isFinite(Date.parse(issued.expiresAt))).toBe(true);
  });

  it('does not rotate or touch a guest read when the client cannot persist its successor', async () => {
    const issued = await issue();
    const { getDb } = await import('../../db/postgres.js');
    const { guestSessions } = await import('../../db/schema/guests.js');
    const { eq } = await import('drizzle-orm');
    const [before] = await getDb()
      .update(guestSessions)
      .set({ createdAt: new Date(Date.now() - 8 * 86400000) })
      .where(eq(guestSessions.id, issued.id))
      .returning();
    const refused = await fetch(`${baseUrl}/guest/session`, {
      headers: {
        [TOKEN_HEADER]: issued.token,
        'x-mercaria-guest-persistence': 'unavailable',
      },
    });
    expect(refused.status).toBe(503);
    const refusedBody = (await refused.json()) as { error: string };
    expect(refusedBody.error).toBe('COMMERCE_STORAGE_UNAVAILABLE');
    expect(refused.headers.get(TOKEN_HEADER)).toBeNull();
    expect(refused.headers.get('cache-control')).toBe('no-store');
    const [after] = await getDb()
      .select()
      .from(guestSessions)
      .where(eq(guestSessions.id, issued.id));
    expect(after).toEqual(before);
    const usable = await fetch(`${baseUrl}/guest/session`, {
      headers: { [TOKEN_HEADER]: issued.token },
    });
    expect(usable.status).toBe(200);
    expect(usable.headers.get(TOKEN_HEADER)).toMatch(/^mgs_/);
    expect(usable.headers.get(TOKEN_HEADER)).not.toBe(issued.token);
    const usableBody = (await usable.json()) as { data: { id: string } };
    expect(usableBody.data.id).toBe(issued.id);
  });

  it('requires an explicit header client before first issuance, regardless of valid Origin', async () => {
    for (const headers of [{}, { origin: ALLOWED_ORIGIN }]) {
      const res = await fetch(`${baseUrl}/guest/session`, { method: 'POST', headers });
      expect(res.status).toBe(426);
      expect(res.headers.get(TOKEN_HEADER)).toBeNull();
      expect(res.headers.getSetCookie()).toEqual([]);
    }
  });

  it('an old cookie cannot silently become an empty or replacement owner; headers preserve the original owner', async () => {
    const issued = await issue();
    for (const method of ['GET', 'POST']) {
      const old = await fetch(`${baseUrl}/guest/session`, {
        method,
        headers: { cookie: `${DEV_COOKIE}=${issued.token}`, origin: ALLOWED_ORIGIN },
      });
      expect(old.status).toBe(426);
      expect(old.headers.get(TOKEN_HEADER)).toBeNull();
    }
    const current = await fetch(`${baseUrl}/guest/session`, {
      headers: { [TOKEN_HEADER]: issued.token, cookie: `${DEV_COOKIE}=another-owner` },
    });
    expect(current.status).toBe(200);
    expect(((await current.json()) as { data: { id: string } }).data.id).toBe(issued.id);
  });

  it('anonymous reads issue nothing and invalid headers never consult a cookie', async () => {
    const bare = await fetch(`${baseUrl}/guest/session`);
    expect(bare.status).toBe(404);
    expect(bare.headers.get('cache-control')).toBe('no-store');
    expect(bare.headers.getSetCookie()).toEqual([]);
    const issued = await issue();
    const invalid = await fetch(`${baseUrl}/guest/session`, {
      headers: { [TOKEN_HEADER]: 'invalid', cookie: `${DEV_COOKIE}=${issued.token}` },
    });
    expect(invalid.status).toBe(401);
    expect(invalid.headers.get('cache-control')).toBe('no-store');
  });

  it('revokes the explicit credential, with uniform invalid-token responses and no cookie', async () => {
    const issued = await issue();
    const revoked = await fetch(`${baseUrl}/guest/session`, {
      method: 'DELETE',
      headers: { [TOKEN_HEADER]: issued.token },
    });
    expect(revoked.status).toBe(204);
    expect(revoked.headers.get(TOKEN_HEADER)).toBe('');
    expect(revoked.headers.getSetCookie()).toEqual([]);
    const bodies = [];
    for (const token of [issued.token, 'malformed', `mgs_${'Z'.repeat(43)}`]) {
      const res = await fetch(`${baseUrl}/guest/session`, { headers: { [TOKEN_HEADER]: token } });
      expect(res.status).toBe(401);
      expect(res.headers.get('cache-control')).toBe('no-store');
      bodies.push(await res.json());
    }
    expect(bodies[1]).toEqual(bodies[0]);
    expect(bodies[2]).toEqual(bodies[0]);
    for (const token of [undefined, 'malformed', issued.token]) {
      const repeated = await fetch(`${baseUrl}/guest/session`, {
        method: 'DELETE',
        headers: token ? { [TOKEN_HEADER]: token } : {},
      });
      expect(repeated.status).toBe(204);
      expect(repeated.headers.getSetCookie()).toEqual([]);
    }
  });

  it('rotation retains owner and absolute expiry, with the previous token usable only during grace', async () => {
    const issued = await issue();
    const rotated = await fetch(`${baseUrl}/guest/session/rotate`, {
      method: 'POST',
      headers: { [TOKEN_HEADER]: issued.token },
    });
    expect(rotated.status).toBe(200);
    const current = rotated.headers.get(TOKEN_HEADER) ?? '';
    expect(current).not.toBe(issued.token);
    expect(current).toMatch(/^mgs_[A-Za-z0-9_-]{43}$/);
    expect(rotated.headers.get('x-mercaria-guest-expires-at')).toBe(issued.expiresAt);
    const state = (await rotated.json()) as { data: { id: string; expiresAt: string } };
    expect(state.data.id).toBe(issued.id);
    expect(state.data.expiresAt).toBe(issued.expiresAt);
    expect(
      (await fetch(`${baseUrl}/guest/session`, { headers: { [TOKEN_HEADER]: issued.token } }))
        .status,
    ).toBe(200);
    const { getDb } = await import('../../db/postgres.js');
    const { guestSessions } = await import('../../db/schema/guests.js');
    const { eq } = await import('drizzle-orm');
    // Advance only this fixture's grace boundary, never global clocks or rows.
    await getDb()
      .update(guestSessions)
      .set({ previousTokenExpiresAt: new Date(Date.now() - 1) })
      .where(eq(guestSessions.id, issued.id));
    expect(
      (await fetch(`${baseUrl}/guest/session`, { headers: { [TOKEN_HEADER]: issued.token } }))
        .status,
    ).toBe(401);
    expect(
      (await fetch(`${baseUrl}/guest/session`, { headers: { [TOKEN_HEADER]: current } })).status,
    ).toBe(200);
  });

  it.each(['', 'Basic invalid', 'Bearer', 'Bearer invalid'])(
    'refuses invalid Authorization %j beside a valid guest token',
    async (authorization) => {
      const issued = await issue();
      const res = await fetch(`${baseUrl}/guest/session`, {
        headers: { authorization, [TOKEN_HEADER]: issued.token },
      });
      expect(res.status).toBe(401);
      expect(res.headers.get('cache-control')).toBe('no-store');
    },
  );

  it('exposes only explicit commerce headers to allowed browsers, without credentialed CORS', async () => {
    const res = await fetch(`${baseUrl}/guest/session`, {
      method: 'OPTIONS',
      headers: {
        origin: ALLOWED_ORIGIN,
        'access-control-request-method': 'POST',
        'access-control-request-headers':
          'x-mercaria-guest-transport,x-mercaria-guest-persistence,x-mercaria-portal-token,x-mercaria-referral-state',
      },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-credentials')).toBeNull();
    expect(res.headers.get('access-control-allow-headers')).toContain('X-Mercaria-Portal-Token');
    expect(res.headers.get('access-control-allow-headers')).toContain(
      'X-Mercaria-Guest-Persistence',
    );
    const issued = await fetch(`${baseUrl}/guest/session`, {
      method: 'POST',
      headers: { origin: ALLOWED_ORIGIN, 'x-mercaria-guest-transport': 'header' },
    });
    expect(issued.headers.get('access-control-expose-headers')).toContain(
      'X-Mercaria-Guest-Expires-At',
    );
  });
});
