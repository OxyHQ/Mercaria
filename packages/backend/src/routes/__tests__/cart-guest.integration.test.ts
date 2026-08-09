/**
 * The cart surface against the REAL app, for a GUEST actor (#104, ADR 0003 M7).
 *
 * `createApp()` builds the actual middleware chain production runs — CORS, the
 * raw-body webhook mounts, `express.json()`, the actor resolver, the actor-aware
 * limiter — so what is asserted here is the wire behaviour a browser or the Expo
 * app actually gets: that a signed-out person can hold a cart at all, which
 * transport carries their credential, which requests the CSRF gate refuses, that
 * a page view creates no row, and that the credential never appears in a body.
 *
 * The Oxy half of "both actor kinds" is covered where it can be covered
 * honestly: `services/__tests__/cart.service.test.ts` drives the same service
 * through an `oxy_user` owner, `cart-merge.realdb.test.ts` drives both owners
 * through the real database, and `checkout.service.test.ts` pins that checkout
 * still hands the service an Oxy owner. Faking a VERIFIED Oxy bearer at this
 * level would mean stubbing the SDK verifier, which would assert about the stub
 * and not about the chain.
 *
 * ## Env is set BEFORE any import, like the guest-session file beside this
 *
 * `config/index.ts` freezes at module load and `app.ts` gates mounts on the
 * frozen value, so everything is imported dynamically after `beforeAll`.
 *
 * ## Under NODE_ENV=test the DEV cookie profile is active
 *
 * `mercaria_guest_dev`, HttpOnly, SameSite=Lax, Path=/, WITHOUT `Secure` — the
 * explicit dev downgrade. The production profile is pinned under a stubbed
 * NODE_ENV in `middleware/__tests__/commerce-actor.test.ts`.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { eq, inArray } from 'drizzle-orm';

const ALLOWED_ORIGIN = 'https://mercaria.co';
const FOREIGN_ORIGIN = 'https://evil.example';
const DEV_COOKIE = 'mercaria_guest_dev';
const TOKEN_HEADER = 'x-mercaria-guest-token';
const TRANSPORT_HEADER = 'x-mercaria-guest-transport';

let baseUrl: string;
const servers: Server[] = [];
let db: import('../../db/postgres.js').Database;
let closePostgres: typeof import('../../db/postgres.js').closePostgres;
let schema: typeof import('../../db/schema/index.js');

const listingIds: string[] = [];
const sessionIdsBefore: Set<string> = new Set();

/** A unique-per-run suffix so parallel workers never collide on an id. */
const RUN = Math.random().toString(36).slice(2, 10);

let listingId: string;
let variantId: string;

beforeAll(async () => {
  process.env.GUEST_COMMERCE_ENABLED = 'true';
  process.env.GUEST_PII_ENCRYPTION_KEY = 'cart-integration-pii-key';
  process.env.GUEST_EMAIL_HASH_KEY = 'cart-integration-email-hash-key';
  // Explicit, not assumed: vitest may run several files in one worker thread,
  // and a sibling file sets these — env leaks, configs do not.
  process.env.GUEST_SESSION_ISSUANCE_ENABLED = 'true';
  process.env.GUEST_CART_ENABLED = 'true';

  const { createApp } = await import('../../app.js');
  const postgres = await import('../../db/postgres.js');
  closePostgres = postgres.closePostgres;
  db = await postgres.connectPostgres();
  schema = await import('../../db/schema/index.js');

  const [listing] = await db
    .insert(schema.listings)
    .values({
      ownerType: 'user',
      oxyUserId: `cart-int-seller-${RUN}`,
      title: `Cart integration fixture ${RUN}`,
      description: '',
      condition: 'used',
      status: 'active',
    })
    .returning();
  listingIds.push(listing.id);
  listingId = listing.id;

  const [variant] = await db
    .insert(schema.productVariants)
    .values({
      listingId: listing.id,
      title: 'Default',
      priceAmount: 2_500,
      priceCurrency: 'FAIR',
      inventoryTracked: true,
      inventoryAvailable: 20,
      position: 0,
    })
    .returning();
  variantId = variant.id;

  const server = createApp().listen(0);
  servers.push(server);
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 120_000);

afterEach(async () => {
  // Sessions this file minted go, and their carts cascade with them. Scoped by
  // id so a sibling file's guests are never touched.
  const ids = [...sessionIdsBefore];
  sessionIdsBefore.clear();
  if (ids.length > 0) {
    await db.delete(schema.guestSessions).where(inArray(schema.guestSessions.id, ids));
  }
});

afterAll(async () => {
  await Promise.all(
    servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
  if (listingIds.length > 0) {
    await db.delete(schema.listings).where(inArray(schema.listings.id, listingIds));
  }
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

/** Track the session behind a cookie so `afterEach` can clean it up. */
async function trackSessionByCookie(setCookie: string): Promise<void> {
  const token = cookiePair(setCookie).split('=')[1];
  const { hashGuestToken } = await import('../../services/guest-session.service.js');
  const [row] = await db
    .select({ id: schema.guestSessions.id })
    .from(schema.guestSessions)
    .where(eq(schema.guestSessions.tokenHash, hashGuestToken(token)));
  if (row) sessionIdsBefore.add(row.id);
}

/**
 * Assert that a response minted NO guest session.
 *
 * A COUNT over `guest_sessions` would be wrong here, and was: one throwaway
 * database serves the whole suite and vitest runs files in parallel, so a
 * sibling file's issuance lands between the two counts and this file fails for
 * something it did not do (`ledger.realdb.test.ts` documents the same trap).
 *
 * The scoped form is also the stronger one. A session is only ever reachable
 * through the credential the server hands back, in one of exactly two
 * carriages (ADR 0003 D9) — so "no credential came back" IS "no session was
 * minted for this request", with no cross-file surface at all.
 */
function expectNoCredentialIssued(res: Response): void {
  expect(guestSetCookie(res)).toBeUndefined();
  expect(res.headers.get(TOKEN_HEADER)).toBeNull();
}

/** A cart response body. */
interface CartBody {
  success: boolean;
  data: {
    id: string;
    items: { variantId: string; quantity: number; reviewReason?: string }[];
    currency: string;
    subtotal: { amount: number; currency: string };
  };
}

describe('a signed-out buyer can hold a cart (acceptance 1)', () => {
  it('creates NO session for a read, and answers an empty cart', async () => {
    const res = await fetch(`${baseUrl}/cart`, { headers: { origin: ALLOWED_ORIGIN } });
    expect(res.status).toBe(200);

    const body = (await res.json()) as CartBody;
    expect(body.data.items).toEqual([]);
    expect(body.data.id).toBe('');
    // ADR 0003 T10: browsing creates no row, so a crawler generates none either.
    expectNoCredentialIssued(res);
  });

  it('mints a session on the first ADD, and the cart survives the next request', async () => {
    const added = await fetch(`${baseUrl}/cart/items`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ALLOWED_ORIGIN },
      body: JSON.stringify({ listingId, variantId, quantity: 2 }),
    });
    expect(added.status).toBe(201);

    const setCookie = guestSetCookie(added);
    expect(setCookie).toBeDefined();
    if (!setCookie) return;
    await trackSessionByCookie(setCookie);
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');

    const addedBody = (await added.json()) as CartBody;
    expect(addedBody.data.items).toHaveLength(1);
    expect(addedBody.data.items[0].quantity).toBe(2);
    // The credential exists ONLY in `Set-Cookie` — never in a body (D9).
    expect(JSON.stringify(addedBody)).not.toContain('mgs_');

    // …and it is still there on the next request, which is what "survives a
    // refresh" means on the wire.
    const reread = await fetch(`${baseUrl}/cart`, {
      headers: { origin: ALLOWED_ORIGIN, cookie: cookiePair(setCookie) },
    });
    const rereadBody = (await reread.json()) as CartBody;
    expect(rereadBody.data.items).toHaveLength(1);
    expect(rereadBody.data.id).toBe(addedBody.data.id);
  });

  it('carries the credential by HEADER when the client declares that transport', async () => {
    const added = await fetch(`${baseUrl}/cart/items`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [TRANSPORT_HEADER]: 'header',
      },
      body: JSON.stringify({ listingId, variantId, quantity: 1 }),
    });
    expect(added.status).toBe(201);

    const token = added.headers.get(TOKEN_HEADER);
    expect(token).toMatch(/^mgs_[A-Za-z0-9_-]{43}$/);
    if (!token) return;
    const { hashGuestToken } = await import('../../services/guest-session.service.js');
    const [row] = await db
      .select({ id: schema.guestSessions.id })
      .from(schema.guestSessions)
      .where(eq(schema.guestSessions.tokenHash, hashGuestToken(token)));
    if (row) sessionIdsBefore.add(row.id);

    // Header transport sets NO cookie — the two carriages never mix (D9).
    expect(guestSetCookie(added)).toBeUndefined();
    expect(JSON.stringify(await added.json())).not.toContain('mgs_');

    const reread = await fetch(`${baseUrl}/cart`, { headers: { [TOKEN_HEADER]: token } });
    expect(((await reread.json()) as CartBody).data.items).toHaveLength(1);
  });
});

describe('the D10 CSRF gate covers guest cart writes', () => {
  it('refuses a cookie-authenticated write with a foreign Origin AND one with none', async () => {
    const added = await fetch(`${baseUrl}/cart/items`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ALLOWED_ORIGIN },
      body: JSON.stringify({ listingId, variantId, quantity: 1 }),
    });
    const setCookie = guestSetCookie(added);
    expect(setCookie).toBeDefined();
    if (!setCookie) return;
    await trackSessionByCookie(setCookie);
    const cookie = cookiePair(setCookie);

    // In the REAL chain a foreign Origin dies at the CORS layer (whose
    // error-throwing callback lands in the 500 handler) before the CSRF gate
    // can see it — both read the SAME allowlist, which is D10's whole point.
    // The gate's own foreign-origin 403 is pinned in the middleware unit tests;
    // what matters at the wire is that the write is REFUSED.
    const foreign = await fetch(`${baseUrl}/cart/items`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: FOREIGN_ORIGIN, cookie },
      body: JSON.stringify({ listingId, variantId, quantity: 5 }),
    });
    expect(foreign.ok).toBe(false);

    // No Origin and no Referer passes CORS (curl-shaped) — THIS is the case
    // only the CSRF gate can catch, and it must answer 403.
    const originless = await fetch(`${baseUrl}/cart/items`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ listingId, variantId, quantity: 5 }),
    });
    expect(originless.status).toBe(403);

    // The cart is untouched by BOTH refusals — they happened before the write.
    const reread = await fetch(`${baseUrl}/cart`, { headers: { origin: ALLOWED_ORIGIN, cookie } });
    expect(((await reread.json()) as CartBody).data.items[0].quantity).toBe(1);
  });

  it('refuses the ISSUING write too when it carries no Origin — no cross-site minting', async () => {
    const refused = await fetch(`${baseUrl}/cart/items`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ listingId, variantId, quantity: 1 }),
    });
    expect(refused.status).toBe(403);
    // The write that SETS a cookie is as CSRF-relevant as one authenticated by
    // it, so no session may be minted for it either.
    expectNoCredentialIssued(refused);
  });
});

describe('mutation idempotency is explicit (route requirement 9)', () => {
  it('PATCH sets an ABSOLUTE quantity and converges on repetition; POST increments', async () => {
    const added = await fetch(`${baseUrl}/cart/items`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ALLOWED_ORIGIN },
      body: JSON.stringify({ listingId, variantId, quantity: 1 }),
    });
    const setCookie = guestSetCookie(added);
    expect(setCookie).toBeDefined();
    if (!setCookie) return;
    await trackSessionByCookie(setCookie);
    const cookie = cookiePair(setCookie);

    // POST increments — the one non-idempotent mutation, stated as such.
    await fetch(`${baseUrl}/cart/items`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ALLOWED_ORIGIN, cookie },
      body: JSON.stringify({ listingId, variantId, quantity: 1 }),
    });
    const afterTwoPosts = await fetch(`${baseUrl}/cart`, { headers: { origin: ALLOWED_ORIGIN, cookie } });
    expect(((await afterTwoPosts.json()) as CartBody).data.items[0].quantity).toBe(2);

    // PATCH is absolute, so twice is the same as once — the mutation a native
    // client should retry with.
    for (const attempt of [1, 2]) {
      const patched = await fetch(`${baseUrl}/cart/items/${variantId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', origin: ALLOWED_ORIGIN, cookie },
        body: JSON.stringify({ quantity: 5 }),
      });
      expect(patched.status, `PATCH attempt ${String(attempt)}`).toBe(200);
      expect(((await patched.json()) as CartBody).data.items[0].quantity).toBe(5);
    }

    // DELETE converges the same way: the second answers 200 with an empty cart
    // rather than a 404 that would make a retry look like a different outcome.
    for (const attempt of [1, 2]) {
      const deleted = await fetch(`${baseUrl}/cart/items/${variantId}`, {
        method: 'DELETE',
        headers: { origin: ALLOWED_ORIGIN, cookie },
      });
      expect(deleted.status, `DELETE attempt ${String(attempt)}`).toBe(200);
      expect(((await deleted.json()) as CartBody).data.items).toEqual([]);
    }
  });

  it('a DELETE from a caller with no cart mints no session', async () => {
    const res = await fetch(`${baseUrl}/cart/items/${variantId}`, {
      method: 'DELETE',
      headers: { origin: ALLOWED_ORIGIN },
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as CartBody).data.items).toEqual([]);
    // Removing a line from a cart that does not exist creates nothing, so it is
    // not an "eligible stateful write" — minting for it would be farming with
    // extra steps.
    expectNoCredentialIssued(res);
  });
});

describe('presentment currency and DTO hygiene', () => {
  it("honours a guest's requested display currency, and never leaks an owner id", async () => {
    const added = await fetch(`${baseUrl}/cart/items?currency=EUR`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ALLOWED_ORIGIN },
      body: JSON.stringify({ listingId, variantId, quantity: 1 }),
    });
    const setCookie = guestSetCookie(added);
    expect(setCookie).toBeDefined();
    if (!setCookie) return;
    await trackSessionByCookie(setCookie);

    const body = (await added.json()) as CartBody;
    // A guest has no preferences row to store one in (ADR 0003 D8), so the
    // display currency rides the request. It is DISPLAY only — the catalogue
    // still stores the native FAIR price and checkout still reprices.
    expect(body.data.currency).toBe('EUR');
    expect(body.data.subtotal.currency).toBe('EUR');

    // No internal owner id in the public DTO, in any form (route requirement 8).
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain('guestSessionId');
    expect(serialized).not.toContain('oxyUserId');
    expect(serialized).not.toContain('mgs_');
  });

  it('ignores an unrecognised currency rather than adopting it', async () => {
    const res = await fetch(`${baseUrl}/cart?currency=NOTACURRENCY`, {
      headers: { origin: ALLOWED_ORIGIN },
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as CartBody).data.currency).toBe('FAIR');
  });
});

describe('the merge endpoint refuses a caller who is not signed in', () => {
  it('answers 401 for a guest actor, and never merges into nothing', async () => {
    const added = await fetch(`${baseUrl}/cart/items`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ALLOWED_ORIGIN },
      body: JSON.stringify({ listingId, variantId, quantity: 1 }),
    });
    const setCookie = guestSetCookie(added);
    expect(setCookie).toBeDefined();
    if (!setCookie) return;
    await trackSessionByCookie(setCookie);

    const merged = await fetch(`${baseUrl}/cart/merge`, {
      method: 'POST',
      headers: { origin: ALLOWED_ORIGIN, cookie: cookiePair(setCookie) },
    });
    expect(merged.status).toBe(401);

    // The guest's cart is untouched by the refusal.
    const reread = await fetch(`${baseUrl}/cart`, {
      headers: { origin: ALLOWED_ORIGIN, cookie: cookiePair(setCookie) },
    });
    expect(((await reread.json()) as CartBody).data.items).toHaveLength(1);
  });
});
