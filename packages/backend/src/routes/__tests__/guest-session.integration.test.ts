/**
 * The guest-session surface against the REAL app (#103, ADR 0003).
 *
 * `createApp()` builds the actual middleware chain production runs — CORS,
 * the raw-body webhook mounts, `express.json()`, the resolver — so what is
 * asserted here is the wire behaviour a browser or the Expo app actually
 * gets: which transport carries the token, which requests the CSRF gate
 * refuses, and that the token never appears in a response body.
 *
 * ## Env is set BEFORE any import, like the Stripe webhook file beside this
 *
 * `config/index.ts` freezes at module load and `app.ts` gates the
 * `/guest/session` MOUNT on the frozen value, so everything is imported
 * dynamically after `beforeAll` sets `GUEST_COMMERCE_ENABLED` and the two M8
 * keys. The kill-switch and disabled-mount deployments are each their own
 * file for the same reason — one process, one frozen config.
 *
 * ## Under NODE_ENV=test the DEV cookie profile is active
 *
 * `mercaria_guest_dev`, HttpOnly, SameSite=Lax, Path=/, WITHOUT `Secure` —
 * the explicit dev downgrade. The production profile (`__Host-mercaria_guest`
 * + `Secure`) is pinned in `middleware/__tests__/commerce-actor.test.ts`
 * under a stubbed NODE_ENV; a browser refuses Secure cookies over plain HTTP,
 * so asserting it here against a loopback listener would test nothing real.
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

/** The `Set-Cookie` for the guest cookie, or undefined. */
function guestSetCookie(res: Response): string | undefined {
  return res.headers.getSetCookie().find((cookie) => cookie.startsWith(`${DEV_COOKIE}=`));
}

/** The bare `name=value` pair out of a `Set-Cookie` line, for replay. */
function cookiePair(setCookie: string): string {
  const [pair] = setCookie.split(';');
  return pair;
}

/** The token value inside a guest `Set-Cookie` line. */
function cookieToken(setCookie: string): string {
  const [pair] = setCookie.split(';');
  return pair.slice(pair.indexOf('=') + 1);
}

describe('cookie transport (web) — issuance, reuse, resolution', () => {
  it('issues once on the ensure WRITE, sets an HttpOnly Lax cookie, and never bodies the token', async () => {
    const res = await fetch(`${baseUrl}/guest/session`, {
      method: 'POST',
      headers: { origin: ALLOWED_ORIGIN },
    });
    expect(res.status).toBe(201);

    const setCookie = guestSetCookie(res);
    expect(setCookie).toBeDefined();
    if (!setCookie) return;
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');
    expect(setCookie).toContain('Path=/');
    expect(cookieToken(setCookie)).toMatch(/^mgs_[A-Za-z0-9_-]{43}$/);

    // Acceptance 8's response half: the token exists ONLY in Set-Cookie.
    const body = (await res.json()) as { success: boolean; data: { id: string; status: string } };
    expect(body.success).toBe(true);
    expect(body.data.status).toBe('active');
    expect(JSON.stringify(body)).not.toContain('mgs_');
    expect(res.headers.get(TOKEN_HEADER)).toBeNull();
  });

  it('resolves the same actor on every subsequent request, and REUSES on a repeated ensure', async () => {
    const first = await fetch(`${baseUrl}/guest/session`, {
      method: 'POST',
      headers: { origin: ALLOWED_ORIGIN },
    });
    const setCookie = guestSetCookie(first);
    expect(setCookie).toBeDefined();
    if (!setCookie) return;
    const cookie = cookiePair(setCookie);
    const issued = ((await first.json()) as { data: { id: string } }).data.id;

    const inspect = await fetch(`${baseUrl}/guest/session`, { headers: { cookie } });
    expect(inspect.status).toBe(200);
    expect(((await inspect.json()) as { data: { id: string } }).data.id).toBe(issued);

    // A retried first write CONVERGES: same session, 200 not 201, no new cookie.
    const again = await fetch(`${baseUrl}/guest/session`, {
      method: 'POST',
      headers: { origin: ALLOWED_ORIGIN, cookie },
    });
    expect(again.status).toBe(200);
    expect(((await again.json()) as { data: { id: string } }).data.id).toBe(issued);
  });

  it('creates NOTHING for a credential-less read — no cookie, no row handle (acceptance 7)', async () => {
    const res = await fetch(`${baseUrl}/guest/session`);
    expect(res.status).toBe(404);
    expect(res.headers.getSetCookie()).toHaveLength(0);
    expect(res.headers.get(TOKEN_HEADER)).toBeNull();
  });
});

describe('header transport (native)', () => {
  it('returns the token in the response HEADER exactly once, with no cookie involved', async () => {
    const res = await fetch(`${baseUrl}/guest/session`, {
      method: 'POST',
      headers: { 'x-mercaria-guest-transport': 'header', 'x-mercaria-guest-client': 'ios' },
    });
    expect(res.status).toBe(201);

    const token = res.headers.get(TOKEN_HEADER);
    expect(token).toMatch(/^mgs_[A-Za-z0-9_-]{43}$/);
    expect(res.headers.getSetCookie()).toHaveLength(0);

    const body = (await res.json()) as { data: { id: string; clientClass: string } };
    expect(body.data.clientClass).toBe('ios');
    expect(JSON.stringify(body)).not.toContain('mgs_');

    // Identical semantics after the middleware boundary (issue #103, native 7).
    const inspect = await fetch(`${baseUrl}/guest/session`, {
      headers: { [TOKEN_HEADER]: token ?? '' },
    });
    expect(inspect.status).toBe(200);
    expect(((await inspect.json()) as { data: { id: string } }).data.id).toBe(body.data.id);
  });
});

describe('CSRF (D10, acceptance 3)', () => {
  async function issueCookie(): Promise<string> {
    const res = await fetch(`${baseUrl}/guest/session`, {
      method: 'POST',
      headers: { origin: ALLOWED_ORIGIN },
    });
    const setCookie = guestSetCookie(res);
    if (!setCookie) throw new Error('issuance did not set the guest cookie');
    return cookiePair(setCookie);
  }

  it('refuses a cookie-authenticated write from a foreign Origin, and one with no Origin at all', async () => {
    const cookie = await issueCookie();

    // In the REAL chain a foreign Origin dies at the CORS layer (whose
    // error-throwing callback lands in the 500 handler) before the CSRF gate
    // can see it — both read the SAME allowlist, which is D10's point. The
    // gate's own foreign-origin refusal (403, defence in depth should the
    // CORS handler ever soften) is pinned in the middleware unit tests; what
    // matters at the wire is that the write is REFUSED.
    const foreign = await fetch(`${baseUrl}/guest/session/rotate`, {
      method: 'POST',
      headers: { cookie, origin: 'https://evil.example' },
    });
    expect(foreign.ok).toBe(false);
    expect(foreign.headers.getSetCookie()).toHaveLength(0);

    // No Origin and no Referer passes CORS (curl-shaped) — THIS is the case
    // only the CSRF gate can catch, and it must answer 403.
    const originless = await fetch(`${baseUrl}/guest/session/rotate`, {
      method: 'POST',
      headers: { cookie },
    });
    expect(originless.status).toBe(403);
  });

  it('refuses cookie-transport ISSUANCE without an allow-listed Origin — no cross-site minting', async () => {
    const res = await fetch(`${baseUrl}/guest/session`, { method: 'POST' });
    expect(res.status).toBe(403);
    expect(res.headers.getSetCookie()).toHaveLength(0);
  });

  it('passes an allow-listed Origin, and never gates the header transport', async () => {
    const cookie = await issueCookie();
    const rotated = await fetch(`${baseUrl}/guest/session/rotate`, {
      method: 'POST',
      headers: { cookie, origin: ALLOWED_ORIGIN },
    });
    expect(rotated.status).toBe(200);
    const fresh = guestSetCookie(rotated);
    expect(fresh).toBeDefined();
    if (!fresh) return;
    expect(cookieToken(fresh)).not.toBe(cookie.slice(cookie.indexOf('=') + 1));

    // Native rotation: custom-header carriage, no Origin, answered in kind.
    const native = await fetch(`${baseUrl}/guest/session`, {
      method: 'POST',
      headers: { 'x-mercaria-guest-transport': 'header' },
    });
    const nativeToken = native.headers.get(TOKEN_HEADER);
    const nativeRotate = await fetch(`${baseUrl}/guest/session/rotate`, {
      method: 'POST',
      headers: { [TOKEN_HEADER]: nativeToken ?? '' },
    });
    expect(nativeRotate.status).toBe(200);
    expect(nativeRotate.headers.get(TOKEN_HEADER)).toMatch(/^mgs_/);
    expect(nativeRotate.headers.getSetCookie()).toHaveLength(0);
  });
});

describe('uniform rejection and revocation (acceptance 5)', () => {
  it('answers 401 with ONE indistinguishable body for malformed, unknown and revoked credentials', async () => {
    const malformed = await fetch(`${baseUrl}/guest/session`, {
      headers: { cookie: `${DEV_COOKIE}=not-even-close` },
    });
    const unknown = await fetch(`${baseUrl}/guest/session`, {
      headers: { [TOKEN_HEADER]: `mgs_${'A'.repeat(43)}` },
    });

    // A real session, revoked through the surface itself.
    const issued = await fetch(`${baseUrl}/guest/session`, {
      method: 'POST',
      headers: { origin: ALLOWED_ORIGIN },
    });
    const setCookie = guestSetCookie(issued);
    expect(setCookie).toBeDefined();
    if (!setCookie) return;
    const cookie = cookiePair(setCookie);
    const revoke = await fetch(`${baseUrl}/guest/session`, {
      method: 'DELETE',
      headers: { cookie, origin: ALLOWED_ORIGIN },
    });
    expect(revoke.status).toBe(204);
    // Revocation clears the cookie (web transport rule 6).
    const cleared = guestSetCookie(revoke);
    expect(cleared).toBeDefined();
    expect(cleared === undefined ? '' : cookieToken(cleared)).not.toMatch(/^mgs_/);

    const revoked = await fetch(`${baseUrl}/guest/session`, { headers: { cookie } });

    expect(malformed.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(revoked.status).toBe(401);
    const bodies = await Promise.all([malformed.json(), unknown.json(), revoked.json()]);
    expect(bodies[1]).toEqual(bodies[0]);
    expect(bodies[2]).toEqual(bodies[0]);
  });

  it('revocation is idempotent and non-enumerating: DELETE answers 204 whatever was presented', async () => {
    const bare = await fetch(`${baseUrl}/guest/session`, {
      method: 'DELETE',
      headers: { origin: ALLOWED_ORIGIN },
    });
    expect(bare.status).toBe(204);

    const garbage = await fetch(`${baseUrl}/guest/session`, {
      method: 'DELETE',
      headers: { origin: ALLOWED_ORIGIN, cookie: `${DEV_COOKIE}=garbage` },
    });
    expect(garbage.status).toBe(204);
  });
});

describe('Oxy precedence at the wire (D2)', () => {
  it('answers 401 for a Bearer that does not verify — never a downgrade to the guest cookie', async () => {
    // 'garbage' fails JWT decode locally, so no network is involved: the SDK's
    // optional auth passes through with no user, and the resolver's own D2
    // refusal — not the SDK — is what must produce this 401.
    const issued = await fetch(`${baseUrl}/guest/session`, {
      method: 'POST',
      headers: { origin: ALLOWED_ORIGIN },
    });
    const setCookie = guestSetCookie(issued);
    expect(setCookie).toBeDefined();
    if (!setCookie) return;

    const res = await fetch(`${baseUrl}/guest/session`, {
      headers: { cookie: cookiePair(setCookie), authorization: 'Bearer garbage' },
    });
    expect(res.status).toBe(401);
  });
});
