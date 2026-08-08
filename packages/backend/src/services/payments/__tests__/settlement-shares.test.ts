/**
 * The charge split, table-tested — the same shape as `ledger-postings.test.ts`,
 * because it is the same kind of code: pure arithmetic that nobody re-derives at
 * runtime and that an accountant discovers months later if it is wrong.
 *
 * ## What each case is chosen to DISTINGUISH
 *
 * Every fixture below exists to make two plausible implementations disagree. A
 * suite of round numbers cannot tell largest-remainder from naive flooring,
 * cannot tell a stable tie-break from an arbitrary one, and cannot tell "the
 * shares sum to the gross" from "the shares are each converted independently" —
 * and those are exactly the three ways this function can be wrong while looking
 * right. So the amounts here are deliberately awkward.
 */

import { describe, it, expect } from 'vitest';
import { allocateSellerShares, type ShareInput } from '../settlement-shares.js';

/** One seller order entering a split. */
function order(orderId: string, weightMinor: number): ShareInput {
  return { orderId, ownerType: 'user', ownerId: `seller-${orderId}`, weightMinor };
}

describe('allocateSellerShares', () => {
  it('gives a single order the whole gross', () => {
    const result = allocateSellerShares({
      grossMinor: 4_500n,
      currency: 'EUR',
      orders: [order('a', 4_500)],
    });

    expect(result.shares).toEqual([
      { orderId: 'a', ownerType: 'user', ownerId: 'seller-a', netMinor: 4_500n },
    ]);
    // Zero residual is what makes the commission zero: ADR 0001 D3 defines the
    // commission as gross minus the sum of the nets, so any leak here would be
    // reported as revenue Mercaria did not earn.
    expect(result.residualMinor).toBe(0n);
  });

  it('splits a converted charge so the shares sum to it EXACTLY', () => {
    // 100.00 USD presented, converted by the rail to 91.37 EUR. Two orders whose
    // presentment totals are 33.33 and 66.67 — proportions that do not divide
    // the converted figure evenly, which is the whole point: flooring both
    // leaves a cent, and that cent has to go to a seller rather than becoming
    // phantom commission.
    const result = allocateSellerShares({
      grossMinor: 9_137n,
      currency: 'EUR',
      orders: [order('a', 3_333), order('b', 6_667)],
    });

    const total = result.shares.reduce((sum, share) => sum + share.netMinor, 0n);
    expect(total).toBe(9_137n);
    expect(result.residualMinor).toBe(0n);
    // Largest remainder: `a` floors to 3045.16… and `b` to 6091.83…, so the
    // spare unit belongs to `b`. A naive floor would leave 3045 + 6091 = 9136.
    expect(result.shares.map((share) => share.netMinor)).toEqual([3_045n, 6_092n]);
  });

  it('breaks a tie by input order, so the same charge always splits the same way', () => {
    // Three equal orders and a gross that is not divisible by three: the two
    // spare units go to the first two, every time. An implementation that broke
    // the tie by object iteration or by sorting on the id would pass a single
    // run and disagree with itself across environments.
    const result = allocateSellerShares({
      grossMinor: 1_000n,
      currency: 'EUR',
      orders: [order('c', 100), order('a', 100), order('b', 100)],
    });

    expect(result.shares.map((share) => [share.orderId, share.netMinor])).toEqual([
      ['c', 334n],
      ['a', 333n],
      ['b', 333n],
    ]);
    expect(result.residualMinor).toBe(0n);
  });

  it('keeps the input order of the shares, whatever the remainders are', () => {
    // The returned array is consumed positionally by nothing — but it IS zipped
    // against the orders by the settlement service, so a function that returned
    // the remainder-sorted order would pay the wrong sellers.
    const result = allocateSellerShares({
      grossMinor: 999n,
      currency: 'EUR',
      orders: [order('first', 10), order('second', 989)],
    });

    expect(result.shares.map((share) => share.orderId)).toEqual(['first', 'second']);
  });

  it('carries the owner through unchanged', () => {
    const result = allocateSellerShares({
      grossMinor: 500n,
      currency: 'USD',
      orders: [
        { orderId: 'a', ownerType: 'store', ownerId: 'store-1', weightMinor: 250 },
        { orderId: 'b', ownerType: 'user', ownerId: 'user-9', weightMinor: 250 },
      ],
    });

    expect(result.shares).toEqual([
      { orderId: 'a', ownerType: 'store', ownerId: 'store-1', netMinor: 250n },
      { orderId: 'b', ownerType: 'user', ownerId: 'user-9', netMinor: 250n },
    ]);
    expect(result.currency).toBe('USD');
  });

  it('gives the whole gross to the first order when every weight is zero', () => {
    // A zero-total order group is a pricing bug upstream. Dividing by zero is
    // not an option and stranding the money as commission would hide it, so it
    // lands somewhere a reconciliation will notice.
    const result = allocateSellerShares({
      grossMinor: 700n,
      currency: 'EUR',
      orders: [order('a', 0), order('b', 0)],
    });

    expect(result.shares.map((share) => share.netMinor)).toEqual([700n, 0n]);
    expect(result.residualMinor).toBe(0n);
  });

  it('reports the whole gross as residual when there are no orders at all', () => {
    // A payment with no orders is a correlation failure, and the caller treats
    // it as one. Returning shares that summed to the gross would be inventing a
    // seller to pay.
    const result = allocateSellerShares({ grossMinor: 4_500n, currency: 'EUR', orders: [] });

    expect(result.shares).toEqual([]);
    expect(result.residualMinor).toBe(4_500n);
  });

  it('handles an amount larger than a 32-bit integer', () => {
    // `bigint` throughout, for the reason every minor-units column in the schema
    // is one: a signed integer tops out well below what a marketplace charge can
    // reach in a low-denomination currency.
    const result = allocateSellerShares({
      grossMinor: 9_007_199_254_740_993n,
      currency: 'EUR',
      orders: [order('a', 1), order('b', 1)],
    });

    const total = result.shares.reduce((sum, share) => sum + share.netMinor, 0n);
    expect(total).toBe(9_007_199_254_740_993n);
  });
});
