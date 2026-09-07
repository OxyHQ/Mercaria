/**
 * The counting passes, against a real server.
 *
 * The arithmetic is the whole point: excluding a status and forgetting one
 * look identical inside a `WHERE`, so each is asserted by a fixture that would
 * move the number if it were wrong.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { inArray } from 'drizzle-orm';
import { uuidv7 } from '@oxyhq/db';
import { ANALYTICS_ENVELOPE_VERSION, ORDER_STATUSES, type OrderStatus } from '@mercaria/shared-types';
import { closePostgres, connectPostgres, type Database } from '../../db/postgres.js';
import { listings } from '../../db/schema/catalog.js';
import { orderItems, orders } from '../../db/schema/orders.js';
import { analyticsEvents } from '../../db/schema/analytics.js';
import {
  countListingSales,
  countListingViews,
} from '../../db/discovery/discoveryCountRepository.js';

let db: Database;
const ownedListingIds: string[] = [];
const ownedOrderIds: string[] = [];
const ownedEventIds: string[] = [];

/** Yesterday — inside any window this suite asks for. */
function recently(): Date {
  return new Date(Date.now() - 24 * 60 * 60 * 1000);
}

/** Ninety days ago — outside a `windowDays: 30` window. */
function longAgo(): Date {
  return new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
}

async function makeListing(): Promise<string> {
  const [listing] = await db
    .insert(listings)
    .values({
      ownerType: 'user',
      oxyUserId: `realdb-discovery-seller-${uuidv7()}`,
      title: 'Realdb counted thing',
      description: '',
      condition: 'new',
      conditionAssertion: 'seller_declared',
    })
    .returning({ id: listings.id });
  ownedListingIds.push(listing.id);
  return listing.id;
}

/** A one-line order for `listingId`, in `status`, at `createdAt`. */
async function makeOrder(input: {
  listingId: string;
  quantity: number;
  status: OrderStatus;
  createdAt?: Date;
}): Promise<string> {
  const orderId = uuidv7();
  await db.insert(orders).values({
    id: orderId,
    orderNumber: `DISC-${orderId.slice(-10)}`,
    buyerOxyUserId: `realdb-discovery-buyer-${uuidv7()}`,
    sellerType: 'user',
    sellerOxyUserId: `realdb-discovery-order-seller-${uuidv7()}`,
    shippingAddressLine1: '1 Test St',
    shippingAddressCity: 'Barcelona',
    shippingAddressPostalCode: '08001',
    shippingAddressCountry: 'ES',
    shippingAddressRecipientName: 'Test Buyer',
    shippingMethod: 'standard',
    shippingLabel: 'Standard',
    shippingCostShopAmount: 0,
    shippingCostShopCurrency: 'EUR',
    shippingCostPresentmentAmount: 0,
    shippingCostPresentmentCurrency: 'EUR',
    totalsSubtotalShopAmount: 1000,
    totalsSubtotalShopCurrency: 'EUR',
    totalsSubtotalPresentmentAmount: 1000,
    totalsSubtotalPresentmentCurrency: 'EUR',
    totalsDiscountTotalShopAmount: 0,
    totalsDiscountTotalShopCurrency: 'EUR',
    totalsDiscountTotalPresentmentAmount: 0,
    totalsDiscountTotalPresentmentCurrency: 'EUR',
    totalsShippingShopAmount: 0,
    totalsShippingShopCurrency: 'EUR',
    totalsShippingPresentmentAmount: 0,
    totalsShippingPresentmentCurrency: 'EUR',
    totalsTaxShopAmount: 0,
    totalsTaxShopCurrency: 'EUR',
    totalsTaxPresentmentAmount: 0,
    totalsTaxPresentmentCurrency: 'EUR',
    totalsGrandTotalShopAmount: 1000,
    totalsGrandTotalShopCurrency: 'EUR',
    totalsGrandTotalPresentmentAmount: 1000,
    totalsGrandTotalPresentmentCurrency: 'EUR',
    status: input.status,
    createdAt: input.createdAt ?? new Date(),
  });
  ownedOrderIds.push(orderId);
  await db.insert(orderItems).values({
    id: uuidv7(),
    orderId,
    listingId: input.listingId,
    variantId: uuidv7(),
    title: 'A thing',
    variantTitle: 'Default',
    quantity: input.quantity,
    unitPriceShopAmount: 1000,
    unitPriceShopCurrency: 'EUR',
    unitPricePresentmentAmount: 1000,
    unitPricePresentmentCurrency: 'EUR',
    lineTotalShopAmount: 1000 * input.quantity,
    lineTotalShopCurrency: 'EUR',
    lineTotalPresentmentAmount: 1000 * input.quantity,
    lineTotalPresentmentCurrency: 'EUR',
  });
  return orderId;
}

/** A `product_page_view` (or other discovery) event naming `listingId`. */
async function makeEvent(input: {
  listingId: string;
  eventType: 'product_page_view' | 'offer_impression';
}): Promise<void> {
  const at = new Date();
  const [event] = await db
    .insert(analyticsEvents)
    .values({
      envelopeVersion: ANALYTICS_ENVELOPE_VERSION,
      eventType: input.eventType,
      eventClass: 'discovery',
      occurredAt: at,
      receivedAt: at,
      actorKind: 'anonymous',
      clientSurface: 'storefront_web',
      trafficClass: 'human',
      consentState: 'not_required',
      collectionMode: 'full',
      listingId: input.listingId,
      expiresAt: new Date(at.getTime() + 90 * 24 * 60 * 60 * 1000),
    })
    .returning({ id: analyticsEvents.id });
  ownedEventIds.push(event.id);
}

beforeAll(async () => {
  db = await connectPostgres();
}, 120_000);

afterEach(async () => {
  if (ownedEventIds.length > 0) {
    await db.delete(analyticsEvents).where(inArray(analyticsEvents.id, ownedEventIds));
    ownedEventIds.length = 0;
  }
  if (ownedOrderIds.length > 0) {
    await db.delete(orders).where(inArray(orders.id, ownedOrderIds));
    ownedOrderIds.length = 0;
  }
  if (ownedListingIds.length > 0) {
    await db.delete(listings).where(inArray(listings.id, ownedListingIds));
    ownedListingIds.length = 0;
  }
});

afterAll(async () => {
  await closePostgres();
});

describe('countListingSales', () => {
  it('counts a paid order and ignores a pending one', async () => {
    const listingId = await makeListing();
    await makeOrder({ listingId, quantity: 1, status: 'paid' });
    await makeOrder({ listingId, quantity: 1, status: 'pending_payment' });

    const counted = await countListingSales(recently());
    const mine = counted.find((row) => row.listingId === listingId);
    expect(mine?.unitsSold).toBe(1);
  });

  it('moves the number for exactly the five counted statuses', async () => {
    // One order per status, all for one listing, each of quantity 1. Five of
    // the eight statuses are sales, so the sum is 5 — dropping one of the real
    // five OR admitting a sixth both break this, which a single-status test
    // would not.
    const listingId = await makeListing();
    for (const status of ORDER_STATUSES) {
      await makeOrder({ listingId, quantity: 1, status });
    }

    const counted = await countListingSales(recently());
    const mine = counted.find((row) => row.listingId === listingId);
    expect(mine?.unitsSold).toBe(5);
    expect(mine?.orderCount).toBe(5);
  });

  it('ignores an order older than the window', async () => {
    const listingId = await makeListing();
    await makeOrder({ listingId, quantity: 1, status: 'paid', createdAt: longAgo() });

    const counted = await countListingSales(recently());
    expect(counted.find((row) => row.listingId === listingId)).toBeUndefined();
  });
});

describe('countListingViews', () => {
  it('counts product_page_view events and nothing else', async () => {
    const listingId = await makeListing();
    await makeEvent({ listingId, eventType: 'product_page_view' });
    await makeEvent({ listingId, eventType: 'product_page_view' });
    await makeEvent({ listingId, eventType: 'offer_impression' });

    const counted = await countListingViews(recently());
    expect(counted.find((row) => row.listingId === listingId)?.viewCount).toBe(2);
  });
});
