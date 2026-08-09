/**
 * The checkout contact/destination contract against the REAL app (#105).
 *
 * `createApp()` builds the actual middleware chain production runs — CORS, the
 * raw-body webhook mounts, `express.json()`, the actor resolver, the actor-aware
 * limiter, the `.strict()` body schema — so what is asserted here is the wire
 * behaviour a browser or the Expo app actually gets: that a signed-out person
 * can place an order at all, that an OLD client sending `addressId` still
 * works, which bodies are refused and what a refusal is allowed to say.
 *
 * ## Which halves are covered here, and which are covered honestly elsewhere
 *
 * The GUEST half runs end to end, because a guest credential is Mercaria's own
 * and can be obtained from the real endpoint. The authenticated half is driven
 * at the SERVICE level (`services/checkout/__tests__/destination.test.ts` for
 * the contract versions and the actor rules, `checkout.service.test.ts` for the
 * whole placement path): faking a VERIFIED Oxy bearer at this level would mean
 * stubbing the SDK verifier, which asserts about the stub and not the chain.
 * What IS asserted here for old clients is the wire-level shape — the schema
 * accepts `addressId`, refuses it beside `destination`, and the refusal is a
 * 400 rather than a crash.
 *
 * ## Env is set BEFORE any import, like every guest file beside this
 *
 * `config/index.ts` freezes at module load and `app.ts` gates mounts on the
 * frozen value, so everything is imported dynamically after `beforeAll`.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { eq } from 'drizzle-orm';

const ALLOWED_ORIGIN = 'https://mercaria.co';
const DEV_COOKIE = 'mercaria_guest_dev';

/** A unique-per-run suffix so parallel workers never collide on an id. */
const RUN = Math.random().toString(36).slice(2, 10);

let baseUrl: string;
const servers: Server[] = [];
let db: import('../../db/postgres.js').Database;
let closePostgres: typeof import('../../db/postgres.js').closePostgres;
let schema: typeof import('../../db/schema/index.js');

let listingId: string;
let variantId: string;
let storeId: string;
const listingIds: string[] = [];
const sessionIds: string[] = [];

const INLINE_ADDRESS = {
  recipientName: 'Jane Doe',
  line1: 'Carrer de Colon 1',
  city: 'Valencia',
  postalCode: '46004',
  country: 'ES',
};

beforeAll(async () => {
  process.env.GUEST_COMMERCE_ENABLED = 'true';
  process.env.GUEST_PII_ENCRYPTION_KEY = 'a'.repeat(64);
  process.env.GUEST_EMAIL_HASH_KEY = 'b'.repeat(64);
  // Explicit, not assumed: vitest may run several files in one worker thread
  // and a sibling file sets these — env leaks, configs do not.
  process.env.GUEST_SESSION_ISSUANCE_ENABLED = 'true';
  process.env.GUEST_CART_ENABLED = 'true';
  process.env.GUEST_INLINE_DESTINATION_ENABLED = 'true';

  const { createApp } = await import('../../app.js');
  const postgres = await import('../../db/postgres.js');
  closePostgres = postgres.closePostgres;
  db = await postgres.connectPostgres();
  schema = await import('../../db/schema/index.js');

  // A STORE seller, deliberately: ADR 0003 D18 refuses a P2P group for a guest,
  // and that refusal has its own case below with its own P2P fixture.
  const [store] = await db
    .insert(schema.stores)
    .values({
      handle: `checkout-int-${RUN}`,
      name: `Checkout integration store ${RUN}`,
      description: '',
      brandColor: '#000000',
      defaultCurrency: 'FAIR',
    })
    .returning();
  storeId = store.id;

  // A store variant's stock lives on `inventory_levels` at a LOCATION, and the
  // reservation resolves the store's default one — a store with no location
  // fails the checkout with NOT_FOUND long before any of #105's rules run.
  const [location] = await db
    .insert(schema.locations)
    .values({
      storeId: store.id,
      name: 'Main warehouse',
      type: 'warehouse',
      isDefault: true,
      isActive: true,
      fulfillsOnlineOrders: true,
    })
    .returning();

  const [listing] = await db
    .insert(schema.listings)
    .values({
      ownerType: 'store',
      storeId: store.id,
      title: `Checkout integration fixture ${RUN}`,
      description: '',
      condition: 'new',
      conditionAssertion: 'seller_declared',
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
      inventoryAvailable: 100,
      position: 0,
    })
    .returning();
  variantId = variant.id;

  await db.insert(schema.inventoryLevels).values({
    variantId: variant.id,
    listingId: listing.id,
    locationId: location.id,
    available: 100,
    committed: 0,
  });

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

/**
 * Nothing is deleted here, deliberately, and the reason is worth stating: a
 * PLACED order cannot be deleted at all. `order_fee_snapshots` is append-only
 * by trigger (#88) and references the order, so the cascade a cleanup would
 * need does not exist — and `orders` → `guest_checkouts` is `ON DELETE
 * restrict` on top of that, which is the property `guest-checkout.realdb.test.ts`
 * asserts on purpose. Sibling files are protected by the per-run id suffix on
 * every fixture instead, and the database itself is a throwaway the harness
 * drops when the suite ends.
 */

/** The bare `name=value` pair out of a `Set-Cookie` line, for replay. */
function cookiePair(setCookie: string): string {
  return setCookie.split(';')[0];
}

/** Add a line to a fresh guest cart and return the credential to replay. */
async function guestCartWithOneItem(): Promise<string> {
  const res = await fetch(`${baseUrl}/cart/items`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ALLOWED_ORIGIN },
    body: JSON.stringify({ listingId, variantId, quantity: 1 }),
  });
  expect(res.status).toBe(201);
  const setCookie = res.headers.getSetCookie().find((c) => c.startsWith(`${DEV_COOKIE}=`));
  expect(setCookie, 'the cart write should have minted a guest credential').toBeDefined();
  return cookiePair(setCookie as string);
}

/** `POST /checkout` with a guest credential. */
async function guestCheckout(cookie: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}/checkout`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ALLOWED_ORIGIN, cookie },
    body: JSON.stringify(body),
  });
}

describe('a guest places an order with an inline destination and contact', () => {
  it('accepts the new contract, snapshots the destination, and creates the contact record', async () => {
    const cookie = await guestCartWithOneItem();
    const res = await guestCheckout(cookie, {
      destination: { type: 'inline_shipping_address', address: INLINE_ADDRESS },
      contact: { email: 'Jane.Doe@Example.COM', phone: '+34 600 123 456' },
    });
    const raw = await res.text();
    expect(res.status, raw).toBe(201);
    const body = JSON.parse(raw) as {
      data: { checkoutGroupId: string; orders: { id: string }[] };
    };
    const { checkoutGroupId } = body.data;
    expect(body.data.orders).toHaveLength(1);

    const [contact] = await db
      .select()
      .from(schema.guestCheckouts)
      .where(eq(schema.guestCheckouts.checkoutGroupId, checkoutGroupId));
    expect(contact).toBeDefined();
    sessionIds.push(contact.guestSessionId);

    // ONE contact identity per group, encrypted at rest, with the redacted form
    // beside it and the raw address NOWHERE.
    expect(contact.emailCiphertext?.startsWith('v1:')).toBe(true);
    expect(contact.emailCiphertext).not.toContain('Jane');
    expect(contact.emailRedacted).toBe('J***@Example.COM');
    expect(contact.emailHash).toMatch(/^[0-9a-f]{64}$/);
    expect(contact.phoneRedacted).toBe('***56');
    expect(contact.marketingOptIn).toBe(false);
    expect(contact.contactVerificationStage).toBe('pending');

    const [order] = await db
      .select()
      .from(schema.orders)
      .where(eq(schema.orders.checkoutGroupId, checkoutGroupId));
    // The buyer identity: guest origin, contact reference, and NO Oxy id.
    expect(order.buyerOrigin).toBe('guest');
    expect(order.buyerGuestCheckoutId).toBe(contact.id);
    expect(order.buyerOxyUserId).toBeNull();
    // The fulfilment snapshot is the typed address, normalized.
    expect(order.shippingAddressCity).toBe('Valencia');
    expect(order.shippingAddressCountry).toBe('ES');
    expect(order.shippingMethod).toBe('standard');

    // …and NO saved address was created for the guest: the address book is an
    // Oxy-account feature and a guest has no account to attach one to.
    const savedAddresses = await db
      .select({ id: schema.addresses.id })
      .from(schema.addresses)
      .where(eq(schema.addresses.recipientName, 'Jane Doe'));
    expect(savedAddresses).toHaveLength(0);
  });

  it('records marketing consent separately, and only when it was given', async () => {
    const cookie = await guestCartWithOneItem();
    const res = await guestCheckout(cookie, {
      destination: { type: 'inline_shipping_address', address: INLINE_ADDRESS },
      contact: { email: 'optin@example.com' },
      marketingOptIn: true,
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { checkoutGroupId: string } };
    const [contact] = await db
      .select()
      .from(schema.guestCheckouts)
      .where(eq(schema.guestCheckouts.checkoutGroupId, body.data.checkoutGroupId));
    sessionIds.push(contact.guestSessionId);
    expect(contact.marketingOptIn).toBe(true);
  });

  it('converges on the same group and the SAME contact for a repeated Idempotency-Key', async () => {
    const cookie = await guestCartWithOneItem();
    const key = `idem-${RUN}-${Math.random().toString(36).slice(2, 8)}`;
    const body = {
      destination: { type: 'inline_shipping_address', address: INLINE_ADDRESS },
      contact: { email: 'converge@example.com' },
    };
    const first = await fetch(`${baseUrl}/checkout`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: ALLOWED_ORIGIN,
        cookie,
        'idempotency-key': key,
      },
      body: JSON.stringify(body),
    });
    expect(first.status).toBe(201);
    const firstBody = (await first.json()) as { data: { checkoutGroupId: string } };

    // Re-stock the cart before retrying. The first checkout emptied it, and a
    // retry against an empty cart is refused as "Cart is empty" — documented
    // behaviour of the payment-failure recovery path and not what this case is
    // about. With no Redis configured here the FAST path is absent, so this
    // drives the DURABLE layer: the retry reprices, loses to
    // `orders_idempotency_key_key`, releases its own reservations and converges.
    await fetch(`${baseUrl}/cart/items`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ALLOWED_ORIGIN, cookie },
      body: JSON.stringify({ listingId, variantId, quantity: 1 }),
    });

    // The retry carries a DIFFERENT email. It must NOT replace the contact the
    // placed order was made with — that would rewrite an immutable record
    // through the back door of an idempotency path.
    const second = await fetch(`${baseUrl}/checkout`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: ALLOWED_ORIGIN,
        cookie,
        'idempotency-key': key,
      },
      body: JSON.stringify({ ...body, contact: { email: 'different@example.com' } }),
    });
    expect(second.status).toBe(201);
    const secondBody = (await second.json()) as { data: { checkoutGroupId: string } };
    expect(secondBody.data.checkoutGroupId).toBe(firstBody.data.checkoutGroupId);

    const contacts = await db
      .select()
      .from(schema.guestCheckouts)
      .where(eq(schema.guestCheckouts.checkoutGroupId, firstBody.data.checkoutGroupId));
    expect(contacts).toHaveLength(1);
    sessionIds.push(contacts[0].guestSessionId);
    expect(contacts[0].emailRedacted).toBe('c***@example.com');
  });
});

describe('what a guest checkout is refused', () => {
  it('refuses a guest with no contact, before anything is reserved', async () => {
    const cookie = await guestCartWithOneItem();
    const res = await guestCheckout(cookie, {
      destination: { type: 'inline_shipping_address', address: INLINE_ADDRESS },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { message: string };
    expect(body.message).toMatch(/email/i);
  });

  it('refuses a guest naming a SAVED address, with an account-shaped reason', async () => {
    const cookie = await guestCartWithOneItem();
    const res = await guestCheckout(cookie, {
      destination: { type: 'saved_address', addressId: 'someone-elses-address' },
      contact: { email: 'jane@example.com' },
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { message: string };
    expect(body.message).toMatch(/Oxy account/);
  });

  it('refuses pickup — the #93 seam fails CLOSED', async () => {
    const cookie = await guestCartWithOneItem();
    const res = await guestCheckout(cookie, {
      destination: {
        type: 'pickup',
        locationId: 'some-location',
        pickupContact: { email: 'jane@example.com' },
      },
      contact: { email: 'jane@example.com' },
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { message: string };
    expect(body.message).toMatch(/not available yet/);
    // Seller-SPECIFIC, so the buyer knows which seller to deselect.
    expect(body.message).toContain(`store:${storeId}`);
  });

  it('refuses an invalid country and an invalid postal code by FIELD, never by value', async () => {
    const cookie = await guestCartWithOneItem();
    const bad = await guestCheckout(cookie, {
      destination: {
        type: 'inline_shipping_address',
        address: { ...INLINE_ADDRESS, country: 'ZZ' },
      },
      contact: { email: 'jane@example.com' },
    });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { message: string }).message).toMatch(/ISO-3166/);

    const badPostal = await guestCheckout(cookie, {
      destination: {
        type: 'inline_shipping_address',
        address: { ...INLINE_ADDRESS, postalCode: '999' },
      },
      contact: { email: 'jane@example.com' },
    });
    expect(badPostal.status).toBe(400);
    expect(((await badPostal.json()) as { message: string }).message).toMatch(/Postal code/);
  });

  it('refuses a body carrying BOTH contract versions rather than guessing', async () => {
    const cookie = await guestCartWithOneItem();
    const res = await guestCheckout(cookie, {
      addressId: 'addr-1',
      destination: { type: 'inline_shipping_address', address: INLINE_ADDRESS },
      contact: { email: 'jane@example.com' },
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { message: string }).message).toMatch(/not both/);
  });

  it('refuses a card-shaped field outright — the schema is `.strict()`', async () => {
    const cookie = await guestCartWithOneItem();
    const res = await guestCheckout(cookie, {
      destination: { type: 'inline_shipping_address', address: INLINE_ADDRESS },
      contact: { email: 'jane@example.com' },
      cardNumber: '4242424242424242',
    });
    expect(res.status).toBe(400);
  });

  it('refuses an anonymous caller with no credential at all', async () => {
    const res = await fetch(`${baseUrl}/checkout`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ALLOWED_ORIGIN },
      body: JSON.stringify({
        destination: { type: 'inline_shipping_address', address: INLINE_ADDRESS },
        contact: { email: 'jane@example.com' },
      }),
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { message: string }).message).toMatch(/Sign in/);
  });
});

describe('the old `addressId` contract still reaches the server', () => {
  it('is ACCEPTED by the schema and refused only by the actor rule', async () => {
    const cookie = await guestCartWithOneItem();
    const res = await guestCheckout(cookie, {
      addressId: 'addr-legacy',
      contact: { email: 'jane@example.com' },
    });
    // A 403 with the account-shaped reason, NOT a 400 "unrecognized key": the
    // v1 field parses, maps to `saved_address`, and is then refused because
    // THIS caller has no address book. An old AUTHENTICATED client (the only
    // kind that can send `addressId`, since v1 had no guest path) reaches the
    // saved-address branch and is served — pinned at the service level in
    // `services/checkout/__tests__/destination.test.ts`.
    expect(res.status).toBe(403);
    expect(((await res.json()) as { message: string }).message).toMatch(/Oxy account/);
  });
});

describe('P2P stays blocked for guests until #112', () => {
  it('refuses a guest buying from an individual seller, naming that seller', async () => {
    const [p2pListing] = await db
      .insert(schema.listings)
      .values({
        ownerType: 'user',
        oxyUserId: `checkout-int-p2p-${RUN}`,
        title: `P2P fixture ${RUN}`,
        description: '',
        condition: 'used_good',
        conditionAssertion: 'seller_declared',
        status: 'active',
      })
      .returning();
    listingIds.push(p2pListing.id);
    const [p2pVariant] = await db
      .insert(schema.productVariants)
      .values({
        listingId: p2pListing.id,
        title: 'Default',
        priceAmount: 1_000,
        priceCurrency: 'FAIR',
        inventoryTracked: true,
        inventoryAvailable: 5,
        position: 0,
      })
      .returning();

    const first = await fetch(`${baseUrl}/cart/items`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ALLOWED_ORIGIN },
      body: JSON.stringify({
        listingId: p2pListing.id,
        variantId: p2pVariant.id,
        quantity: 1,
      }),
    });
    expect(first.status).toBe(201);
    const cookie = cookiePair(
      first.headers.getSetCookie().find((c) => c.startsWith(`${DEV_COOKIE}=`)) as string,
    );

    const res = await guestCheckout(cookie, {
      destination: { type: 'inline_shipping_address', address: INLINE_ADDRESS },
      contact: { email: 'jane@example.com' },
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { message: string };
    expect(body.message).toMatch(/Oxy account/);
    expect(body.message).toContain(`user:checkout-int-p2p-${RUN}`);
  });
});
