/**
 * The guest order portal against the REAL app (#108, ADR 0003).
 *
 * `createApp()` builds the middleware chain production runs, so what is
 * asserted here is the wire behaviour a browser or the Expo app actually gets:
 * which transport carries the credential, which requests the CSRF gate refuses,
 * that the token never appears in a response body, and — the property the whole
 * recovery flow rests on — that a matching address and a non-matching one
 * produce byte-identical answers.
 *
 * ## Env is set BEFORE any import
 *
 * `config/index.ts` freezes at module load. Note what is NOT set here:
 * `GUEST_COMMERCE_ENABLED` is left at its default OFF, deliberately, because
 * the portal must be reachable on a deployment where guest commerce has been
 * switched off — #108 acceptance 10 and ADR 0003 M8. If this file ever needs to
 * turn it on to make the portal answer, that is the regression.
 *
 * ## Under NODE_ENV=test the DEV cookie profile is active
 *
 * `mercaria_portal_dev`, HttpOnly, SameSite=Lax, Path=/, WITHOUT `Secure` — the
 * explicit dev downgrade. The production profile (`__Host-mercaria_portal` +
 * `Secure`) is asserted separately below under a stubbed `NODE_ENV`, because a
 * browser refuses a Secure cookie over plain HTTP and pinning it against a
 * loopback listener would test nothing real.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

const ALLOWED_ORIGIN = 'https://mercaria.co';
const DEV_COOKIE = 'mercaria_portal_dev';
const TOKEN_HEADER = 'x-mercaria-portal-token';

let baseUrl: string;
const servers: Server[] = [];
let closePostgres: typeof import('../../db/postgres.js').closePostgres;
let portalCookieProfile: typeof import('../../middleware/guest-portal.js').portalCookieProfile;
let ACKNOWLEDGEMENT: string;

beforeAll(async () => {
  // The two keys the recovery path needs to hash an address at all. NOT
  // `GUEST_COMMERCE_ENABLED` — see the module docblock.
  process.env.GUEST_PII_ENCRYPTION_KEY = 'c'.repeat(64);
  process.env.GUEST_EMAIL_HASH_KEY = 'd'.repeat(64);
  process.env.GUEST_MAGIC_LINK_BASE_URL = 'https://mercaria.co/guest-orders/portal';

  const { createApp } = await import('../../app.js');
  const postgres = await import('../../db/postgres.js');
  closePostgres = postgres.closePostgres;
  await postgres.connectPostgres();
  ({ portalCookieProfile } = await import('../../middleware/guest-portal.js'));
  ({ GUEST_RECOVERY_ACKNOWLEDGEMENT: ACKNOWLEDGEMENT } = await import('../guest-orders.js'));

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

async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ALLOWED_ORIGIN, ...headers },
    body: JSON.stringify(body),
  });
}

describe('recovery answers identically whatever happened (ADR 0003 T5, acceptance 6)', () => {
  it('a plausible address and an address that placed nothing are the SAME response', async () => {
    const matched = await post('/guest/orders/recover', { email: 'someone@example.com' });
    const unmatched = await post('/guest/orders/recover', {
      email: 'definitely-nobody-9f3a@example.invalid',
    });

    expect(matched.status).toBe(202);
    expect(unmatched.status).toBe(202);
    // Byte-identical, not merely "both 202": a different message, a different
    // field or a different key order is an enumeration oracle just as much as a
    // different status code.
    expect(await matched.text()).toBe(await unmatched.text());
  });

  it('the body is the exact sentence #108 specifies, and names nothing', async () => {
    const res = await post('/guest/orders/recover', { email: 'a@example.com' });
    const payload = (await res.json()) as { data: { message: string } };
    expect(payload.data.message).toBe(ACKNOWLEDGEMENT);
    expect(payload.data.message).not.toContain('a@example.com');
    // No field could say whether anything matched — the response has exactly
    // one key under `data`.
    expect(Object.keys(payload.data)).toEqual(['message']);
  });

  it('an order-number HINT does not change the answer', async () => {
    // ADR 0003 T6: order numbers are printed, sequential and public, so
    // matching one must be worth nothing observable.
    const withHint = await post('/guest/orders/recover', {
      email: 'a@example.com',
      orderNumber: 'MRC-000001',
    });
    const without = await post('/guest/orders/recover', { email: 'a@example.com' });
    expect(withHint.status).toBe(202);
    expect(await withHint.text()).toBe(await without.text());
  });

  it('refuses a body carrying a destination, a scope or an expiry (.strict())', async () => {
    for (const body of [
      { email: 'a@example.com', to: 'attacker@example.com' },
      { email: 'a@example.com', scopes: ['orders:read'] },
      { email: 'a@example.com', expiresAt: '2099-01-01T00:00:00Z' },
    ]) {
      const res = await post('/guest/orders/recover', body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
  });

  it('a malformed body is a 400 and not a 202', async () => {
    // The one exception to the uniform answer, and it says nothing about
    // whether any address exists: answering 202 here would hide a client bug
    // behind a security property.
    expect((await post('/guest/orders/recover', {})).status).toBe(400);
    expect((await post('/guest/orders/recover', { email: '' })).status).toBe(400);
  });
});

describe('the exchange refuses everything uniformly (magic-link rule 8)', () => {
  it('malformed, unknown and wrong-prefix tokens all answer 401 with one message', async () => {
    const answers = await Promise.all(
      [
        'nonsense',
        `mgx_${'A'.repeat(43)}`,
        `mgp_${'A'.repeat(43)}`,
        `mgs_${'A'.repeat(43)}`,
        '',
      ].map(async (token) => {
        const res = await post('/guest/orders/exchange', { token });
        return { status: res.status, body: await res.text() };
      }),
    );
    for (const answer of answers) {
      expect(answer.status).toBe(401);
    }
    // One message for every rejection reason — a caller cannot tell an expired
    // link from a fabricated one.
    expect(new Set(answers.map((answer) => answer.body)).size).toBe(1);
  });

  it('sets no cookie and returns no token when it refuses', async () => {
    const res = await post('/guest/orders/exchange', { token: `mgx_${'A'.repeat(43)}` });
    expect(res.headers.getSetCookie()).toEqual([]);
    expect(res.headers.get(TOKEN_HEADER)).toBeNull();
    expect(await res.text()).not.toContain('mgp_');
  });
});

describe('CSRF: a cookie-carried write needs an allow-listed Origin (D10)', () => {
  it('refuses the exchange from a foreign Origin, and sets no cookie', async () => {
    // In the REAL chain a foreign Origin dies at the CORS layer (whose
    // error-throwing callback lands in the 500 handler) before the CSRF gate
    // can see it — both read the SAME allowlist, which is D10's point. What
    // matters at the wire is that the write is REFUSED and no credential
    // leaves; the gate's own 403 is the defence in depth should the CORS
    // handler ever soften, and it is what the originless case below pins.
    const res = await post(
      '/guest/orders/exchange',
      { token: `mgx_${'A'.repeat(43)}` },
      { origin: 'https://evil.example' },
    );
    expect(res.ok).toBe(false);
    expect(res.headers.getSetCookie()).toHaveLength(0);
    expect(res.headers.get(TOKEN_HEADER)).toBeNull();
  });

  it('refuses a cookie-transport exchange with NO Origin and no Referer', async () => {
    const res = await fetch(`${baseUrl}/guest/orders/exchange`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: `mgx_${'A'.repeat(43)}` }),
    });
    expect(res.status).toBe(403);
  });

  it('lets HEADER transport through without an Origin — a custom header forces a preflight', async () => {
    const res = await fetch(`${baseUrl}/guest/orders/exchange`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-mercaria-portal-transport': 'header',
      },
      body: JSON.stringify({ token: `mgx_${'A'.repeat(43)}` }),
    });
    // Past the CSRF gate and refused by the token instead, which is the
    // distinction: 401 means the credential was judged, 403 means it never was.
    expect(res.status).toBe(401);
  });

  it('accepts an allow-listed Referer when Origin is absent', async () => {
    const res = await fetch(`${baseUrl}/guest/orders/exchange`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        referer: `${ALLOWED_ORIGIN}/guest-orders/portal`,
      },
      body: JSON.stringify({ token: `mgx_${'A'.repeat(43)}` }),
    });
    expect(res.status).toBe(401);
  });
});

describe('the authenticated surface refuses an absent credential uniformly', () => {
  it('every portal route answers 401 with no credential', async () => {
    const reads = await Promise.all(
      ['/guest/orders/session', '/guest/orders/any-group', '/guest/orders/any-group/status'].map(
        async (path) => (await fetch(`${baseUrl}${path}`)).status,
      ),
    );
    expect(reads).toEqual([401, 401, 401]);

    const writes = await Promise.all(
      ['/guest/orders/any-group/step-up', '/guest/orders/any-group/secure-access'].map(
        async (path) => (await post(path, {})).status,
      ),
    );
    expect(writes).toEqual([401, 401]);
  });

  it('sign-out is always 204 — it is not a validity oracle', async () => {
    const res = await fetch(`${baseUrl}/guest/orders/session`, {
      method: 'DELETE',
      headers: { origin: ALLOWED_ORIGIN },
    });
    expect(res.status).toBe(204);
  });

  it('a confirmation mint with no guest session is a 404, not a 401', async () => {
    // Uniform with "not your group": an anonymous caller has proved nothing and
    // must not learn that a group id is real.
    const res = await post('/guest/orders/confirmation', { checkoutGroupId: 'grp-does-not-exist' });
    expect(res.status).toBe(404);
  });
});

describe('the portal is reachable with guest commerce OFF (acceptance 10)', () => {
  it('the router is mounted — refusals come from the credential, never from a 404 mount', async () => {
    const { config } = await import('../../config/index.js');
    // The premise, asserted rather than assumed: this whole file runs on a
    // deployment where guest commerce is off.
    expect(config.guest.enabled).toBe(false);

    // The guest SESSION surface is unmounted, which is what a gated mount looks
    // like...
    expect((await fetch(`${baseUrl}/guest/session`)).status).toBe(404);
    // ...and the PORTAL is not. 202 and 401 are answers from the handlers.
    expect((await post('/guest/orders/recover', { email: 'a@example.com' })).status).toBe(202);
    expect((await fetch(`${baseUrl}/guest/orders/session`)).status).toBe(401);
  });
});

describe('the cookie profile', () => {
  it('is the explicit dev downgrade under a non-production NODE_ENV', () => {
    const profile = portalCookieProfile();
    expect(profile.name).toBe(DEV_COOKIE);
    expect(profile.options.secure).toBe(false);
    expect(profile.options.httpOnly).toBe(true);
    expect(profile.options.sameSite).toBe('lax');
    expect(profile.options.path).toBe('/');
  });

  it('is `__Host-` prefixed and Secure in production', () => {
    // `__Host-` forbids a `Domain` attribute, so no sibling subdomain can plant
    // or shadow the cookie (ADR 0003 T1). `SameSite=Lax` rather than `Strict`
    // because the portal is reached by clicking a link in a mail client, and
    // `Strict` drops the cookie on exactly that navigation.
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const profile = portalCookieProfile();
      expect(profile.name).toBe('__Host-mercaria_portal');
      expect(profile.options.secure).toBe(true);
      expect(profile.options.httpOnly).toBe(true);
      expect(profile.options.sameSite).toBe('lax');
      expect(profile.options.path).toBe('/');
    } finally {
      process.env.NODE_ENV = previous;
    }
  });
});
