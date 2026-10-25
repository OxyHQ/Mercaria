/**
 * The guest order portal against the REAL app (#108, ADR 0003).
 *
 * `createApp()` builds the middleware chain production runs, so what is
 * asserted here is the wire behaviour a browser or the Expo app actually gets:
 * explicit credential headers, refusal before unsupported issuance,
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
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

const ALLOWED_ORIGIN = 'https://mercaria.co';
const TOKEN_HEADER = 'x-mercaria-portal-token';

let baseUrl: string;
const servers: Server[] = [];
let closePostgres: typeof import('../../db/postgres.js').closePostgres;
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
    headers: {
      'content-type': 'application/json',
      origin: ALLOWED_ORIGIN,
      'x-mercaria-portal-transport': 'header',
      ...headers,
    },
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

describe('legacy portal clients fail before consuming access links', () => {
  it('preserves a real single-use link for a header-capable client and keeps portal scope/revocation', async () => {
    const { getDb } = await import('../../db/postgres.js');
    const { guestCheckouts } = await import('../../db/schema/guests.js');
    const { guestOrderAccessGrants } = await import('../../db/schema/guestPortal.js');
    const { eq } = await import('drizzle-orm');
    const { mintExchangeGrant } = await import('../../services/guest-portal/grant.service.js');
    const db = getDb();
    const group = `http-portal-${crypto.randomUUID()}`;
    const [contact] = await db
      .insert(guestCheckouts)
      .values({
        checkoutGroupId: group,
        guestSessionId: `fixture-${crypto.randomUUID()}`,
        emailCiphertext: 'v1:aaa:bbb:ccc',
        emailHash: crypto.randomUUID(),
        emailRedacted: 't***@example.com',
        marketingOptIn: false,
      })
      .returning();
    try {
      const minted = await mintExchangeGrant(db, {
        checkoutGroupId: group,
        guestCheckoutId: contact.id,
        reason: 'recovery',
        now: new Date(),
      });
      const old = await fetch(`${baseUrl}/guest/orders/exchange`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: ALLOWED_ORIGIN },
        body: JSON.stringify({ token: minted.token }),
      });
      expect(old.status).toBe(426);
      const [unconsumed] = await db
        .select()
        .from(guestOrderAccessGrants)
        .where(eq(guestOrderAccessGrants.id, minted.grant.id));
      expect(unconsumed.consumedAt).toBeNull();
      const exchanged = await post('/guest/orders/exchange', { token: minted.token });
      expect(exchanged.status).toBe(201);
      const portal = exchanged.headers.get(TOKEN_HEADER) ?? '';
      expect(portal).toMatch(/^mgp_/);
      expect(exchanged.headers.getSetCookie()).toEqual([]);
      const created = (await exchanged.json()) as {
        data: { checkoutGroupId: string; expiresAt: string };
      };
      expect(created.data.checkoutGroupId).toBe(group);
      expect(exchanged.headers.get('x-mercaria-portal-expires-at')).toBe(created.data.expiresAt);
      // Portal possession is its own credential, not a downgrade from Oxy auth.
      const inspect = await fetch(`${baseUrl}/guest/orders/session`, {
        headers: { [TOKEN_HEADER]: portal, authorization: 'Basic irrelevant-to-portal' },
      });
      expect(inspect.status).toBe(200);
      expect(
        (
          await fetch(`${baseUrl}/guest/orders/another-group`, {
            headers: { [TOKEN_HEADER]: portal },
          })
        ).status,
      ).toBe(404);
      expect((await post('/guest/orders/exchange', { token: minted.token })).status).toBe(401);
      const revoked = await fetch(`${baseUrl}/guest/orders/session`, {
        method: 'DELETE',
        headers: { [TOKEN_HEADER]: portal },
      });
      expect(revoked.status).toBe(204);
      expect(revoked.headers.get(TOKEN_HEADER)).toBe('');
      expect(
        (await fetch(`${baseUrl}/guest/orders/session`, { headers: { [TOKEN_HEADER]: portal } }))
          .status,
      ).toBe(401);
    } finally {
      await db
        .delete(guestOrderAccessGrants)
        .where(eq(guestOrderAccessGrants.guestCheckoutId, contact.id));
      await db.delete(guestCheckouts).where(eq(guestCheckouts.id, contact.id));
    }
  });
  it('refuses an undeclared client even with a trusted Origin', async () => {
    const res = await fetch(`${baseUrl}/guest/orders/exchange`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ALLOWED_ORIGIN },
      body: JSON.stringify({ token: `mgx_${'A'.repeat(43)}` }),
    });
    expect(res.status).toBe(426);
    expect(res.headers.getSetCookie()).toEqual([]);
    expect(res.headers.get(TOKEN_HEADER)).toBeNull();
  });

  it('does not authenticate a portal cookie or treat it as absent access', async () => {
    const res = await fetch(`${baseUrl}/guest/orders/session`, {
      headers: { cookie: `mercaria_portal_dev=mgp_${'A'.repeat(43)}` },
    });
    expect(res.status).toBe(426);
  });

  it('an explicit invalid header never falls back to a cookie', async () => {
    const res = await fetch(`${baseUrl}/guest/orders/session`, {
      headers: { [TOKEN_HEADER]: 'invalid', cookie: `mercaria_portal_dev=mgp_${'A'.repeat(43)}` },
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
