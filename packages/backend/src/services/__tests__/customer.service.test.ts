/**
 * Unit tests for `customer.service`.
 *
 * The customer repository is mocked, so these assert what the SERVICE decides
 * rather than what the SQL does: `upsertOnPaid` delegates the whole
 * increment-or-seed to one repository call (the atomicity that used to be worth
 * asserting here is now a property of `ON CONFLICT … DO UPDATE` and is pinned
 * against a real server in `commerce.realdb.test.ts`), and `resolveOrCreate`
 * picks the Oxy-backed upsert when given an `oxyUserId` and a WALK-IN insert
 * otherwise.
 *
 * The `totalSpent` currency is the one thing the service alone can get wrong: a
 * record created before its owner's first order still has to declare a currency,
 * and it must be the STORE's settlement currency rather than a FAIR default that
 * no order of a EUR shop is ever priced in.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const upsertCustomerOnPaid = vi.fn();
const upsertPosCustomer = vi.fn();
const insertCustomer = vi.fn();
const findCustomerByEmail = vi.fn();
const findStoreRow = vi.fn();

vi.mock('../../db/stores/customerRepository.js', () => ({
  upsertCustomerOnPaid: (...args: unknown[]) => upsertCustomerOnPaid(...args),
  upsertPosCustomer: (...args: unknown[]) => upsertPosCustomer(...args),
  insertCustomer: (...args: unknown[]) => insertCustomer(...args),
  findCustomerByEmail: (...args: unknown[]) => findCustomerByEmail(...args),
  findCustomer: vi.fn(),
  findCustomersPage: vi.fn(),
  updateCustomer: vi.fn(),
  decrementCustomerOnRefund: vi.fn(),
}));

vi.mock('../../db/stores/storeRepository.js', () => ({
  findStoreRow: (...args: unknown[]) => findStoreRow(...args),
}));

vi.mock('../../db/orders/orderRepository.js', () => ({
  findOrders: vi.fn().mockResolvedValue([]),
}));

vi.mock('../order-hydration.service.js', () => ({
  summarizeOrders: vi.fn().mockResolvedValue([]),
}));

import { upsertOnPaid, resolveOrCreate } from '../customer.service.js';

const STORE = 'store-A';
const OXY = 'buyer-1';

beforeEach(() => {
  upsertCustomerOnPaid.mockReset().mockResolvedValue(undefined);
  upsertPosCustomer.mockReset();
  insertCustomer.mockReset();
  findCustomerByEmail.mockReset();
  findStoreRow.mockReset().mockResolvedValue({ id: STORE, defaultCurrency: 'FAIR' });
});

describe('customer.service.upsertOnPaid', () => {
  it('delegates the increment-or-seed to ONE repository call', async () => {
    await upsertOnPaid(STORE, OXY, { amount: 12_500, currency: 'FAIR' });

    expect(upsertCustomerOnPaid).toHaveBeenCalledTimes(1);
    expect(upsertCustomerOnPaid).toHaveBeenCalledWith(STORE, OXY, {
      amount: 12_500,
      currency: 'FAIR',
    });
  });
});

describe('customer.service.resolveOrCreate', () => {
  it('upserts an Oxy-backed customer (isWalkIn false) when given an oxyUserId', async () => {
    upsertPosCustomer.mockResolvedValueOnce({
      id: 'c1',
      storeId: STORE,
      oxyUserId: OXY,
      isWalkIn: false,
    });

    const customer = await resolveOrCreate(STORE, { oxyUserId: OXY, displayName: 'Buyer One' });

    expect(upsertPosCustomer).toHaveBeenCalledTimes(1);
    const [storeId, oxyUserId, contact, currency] = upsertPosCustomer.mock.calls[0];
    expect(storeId).toBe(STORE);
    expect(oxyUserId).toBe(OXY);
    expect(contact).toEqual({ displayName: 'Buyer One' });
    expect(currency).toBe('FAIR');
    expect(customer.isWalkIn).toBe(false);
    expect(insertCustomer).not.toHaveBeenCalled();
  });

  it('creates a WALK-IN customer (isWalkIn true, no oxyUserId) when none is given', async () => {
    insertCustomer.mockResolvedValueOnce({
      id: 'c2',
      storeId: STORE,
      isWalkIn: true,
      displayName: 'Walk-in',
    });

    const customer = await resolveOrCreate(STORE, { displayName: 'Walk-in' });

    expect(upsertPosCustomer).not.toHaveBeenCalled();
    expect(findCustomerByEmail).not.toHaveBeenCalled();
    expect(insertCustomer).toHaveBeenCalledTimes(1);
    const [storeId, values] = insertCustomer.mock.calls[0] as [
      string,
      { isWalkIn: boolean; oxyUserId?: string },
    ];
    expect(storeId).toBe(STORE);
    expect(values.isWalkIn).toBe(true);
    expect(values.oxyUserId).toBeUndefined();
    expect(customer.isWalkIn).toBe(true);
  });

  it("denominates a new walk-in's lifetime spend in the STORE's currency, not FAIR", async () => {
    // The one thing the service alone decides. A EUR shop's walk-in must not be
    // seeded with a FAIR `totalSpent`, because every order they ever place will
    // be summed in EUR and the two would never meet.
    findStoreRow.mockResolvedValueOnce({ id: STORE, defaultCurrency: 'EUR' });
    insertCustomer.mockResolvedValueOnce({ id: 'c3', storeId: STORE, isWalkIn: true });

    await resolveOrCreate(STORE, { displayName: 'Walk-in' });

    const [, values] = insertCustomer.mock.calls[0] as [string, { totalSpentCurrency: string }];
    expect(values.totalSpentCurrency).toBe('EUR');
  });
});
