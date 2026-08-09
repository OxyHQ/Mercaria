/**
 * `GUEST_CART_ENABLED=false` — the guest CART lever, independent of the guest
 * SESSION levers (#104 acceptance 10).
 *
 * Its own file because `config/index.ts` reads the environment once at module
 * load and freezes it: one process, one frozen config, so a flag combination is
 * a file rather than a `beforeEach`. `guest-session.flags.integration.test.ts`
 * and `guest-session.disabled.integration.test.ts` exist for the same reason.
 *
 * What this pins is the INDEPENDENCE, which is the whole of the acceptance
 * criterion. Guest commerce is ON here and issuance is ON, so a guest session
 * still mints, resolves, rotates and revokes exactly as it does in production —
 * and yet no guest may own a cart. That is the shape a rollout needs: cart and
 * checkout are separate switches (#105–#107 adds the third), so an incident on
 * one surface does not take down the others.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { inArray } from 'drizzle-orm';

const ALLOWED_ORIGIN = 'https://mercaria.co';
const DEV_COOKIE = 'mercaria_guest_dev';

let baseUrl: string;
const servers: Server[] = [];
let db: import('../../db/postgres.js').Database;
let closePostgres: typeof import('../../db/postgres.js').closePostgres;
let schema: typeof import('../../db/schema/index.js');

const listingIds: string[] = [];
const RUN = Math.random().toString(36).slice(2, 10);
let listingId: string;
let variantId: string;

beforeAll(async () => {
  process.env.GUEST_COMMERCE_ENABLED = 'true';
  process.env.GUEST_PII_ENCRYPTION_KEY = 'cart-disabled-pii-key';
  process.env.GUEST_EMAIL_HASH_KEY = 'cart-disabled-email-hash-key';
  process.env.GUEST_SESSION_ISSUANCE_ENABLED = 'true';
  // The one thing that differs from the sibling file.
  process.env.GUEST_CART_ENABLED = 'false';

  const { createApp } = await import('../../app.js');
  const postgres = await import('../../db/postgres.js');
  closePostgres = postgres.closePostgres;
  db = await postgres.connectPostgres();
  schema = await import('../../db/schema/index.js');

  const [listing] = await db
    .insert(schema.listings)
    .values({
      ownerType: 'user',
      oxyUserId: `cart-disabled-seller-${RUN}`,
      title: `Cart disabled fixture ${RUN}`,
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
      priceAmount: 1_000,
      priceCurrency: 'FAIR',
      inventoryTracked: true,
      inventoryAvailable: 5,
      position: 0,
    })
    .returning();
  variantId = variant.id;

  const server = createApp().listen(0);
  servers.push(server);
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 120_000);

afterAll(async () => {
  await Promise.all(
    servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
  if (listingIds.length > 0) {
    await db.delete(schema.listings).where(inArray(schema.listings.id, listingIds));
  }
  await closePostgres();
});

describe('guest carts are gateable independently of guest sessions', () => {
  it('refuses a guest cart WRITE with GUEST_CART_DISABLED, and mints no session for it', async () => {
    const res = await fetch(`${baseUrl}/cart/items`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ALLOWED_ORIGIN },
      body: JSON.stringify({ listingId, variantId, quantity: 1 }),
    });

    expect(res.status).toBe(403);
    const body = (await res.json()) as { success: boolean; error: string };
    expect(body.error).toBe('GUEST_CART_DISABLED');
    // Distinct from UNAUTHORIZED on purpose: the client's correct response is to
    // offer sign-in, not to retry with a credential.
    //
    // "No session was minted" is asserted as "no credential came back", in
    // either carriage, rather than as a COUNT over `guest_sessions`: one
    // throwaway database serves the whole suite and vitest runs files in
    // parallel, so a count is a cross-file race — and a session is only ever
    // reachable through the credential anyway (ADR 0003 D9).
    expect(res.headers.getSetCookie().some((c) => c.startsWith(`${DEV_COOKIE}=`))).toBe(false);
    expect(res.headers.get('x-mercaria-guest-token')).toBeNull();
  });

  it('still answers an empty cart on a READ, rather than an error', async () => {
    const res = await fetch(`${baseUrl}/cart`, { headers: { origin: ALLOWED_ORIGIN } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { items: unknown[] } };
    expect(body.data.items).toEqual([]);
  });

  it('leaves the guest SESSION surface fully working — the levers are separate', async () => {
    // The independence, asserted rather than asserted-about: sessions still
    // mint and still resolve with guest carts off. A single collapsed flag would
    // fail here, which is what makes this file worth its own process.
    const issued = await fetch(`${baseUrl}/guest/session`, {
      method: 'POST',
      headers: { origin: ALLOWED_ORIGIN },
    });
    expect(issued.status).toBe(201);

    const setCookie = issued.headers
      .getSetCookie()
      .find((cookie) => cookie.startsWith(`${DEV_COOKIE}=`));
    expect(setCookie).toBeDefined();
    if (!setCookie) return;
    const cookie = setCookie.split(';')[0];

    const inspected = await fetch(`${baseUrl}/guest/session`, {
      headers: { origin: ALLOWED_ORIGIN, cookie },
    });
    expect(inspected.status).toBe(200);

    // …and that live session STILL may not write a cart, which is the other half:
    // the refusal is about the cart lever, not about the credential.
    const write = await fetch(`${baseUrl}/cart/items`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ALLOWED_ORIGIN, cookie },
      body: JSON.stringify({ listingId, variantId, quantity: 1 }),
    });
    expect(write.status).toBe(403);
    expect(((await write.json()) as { error: string }).error).toBe('GUEST_CART_DISABLED');

    await fetch(`${baseUrl}/guest/session`, {
      method: 'DELETE',
      headers: { origin: ALLOWED_ORIGIN, cookie },
    });
  });
});
