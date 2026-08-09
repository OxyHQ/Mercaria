/**
 * How one charge is split across the seller orders it funds — ONE definition,
 * two readers.
 *
 * The ledger credits each seller a payable when the charge succeeds, and the
 * settlement step transfers each seller that same figure. If those two numbers
 * were computed in two places they would eventually disagree, and the symptom
 * would be a `merchant_payable` account that never returns to zero for an order
 * anybody actually looks at — months later, by an accountant. So the split lives
 * here, is pure, and is table-tested against worked examples, exactly like
 * `ledger-postings.ts` and for the same reason.
 *
 * ## Why an allocation and not "each order's own total"
 *
 * When the buyer's presentment currency IS the platform's settlement currency,
 * the two are the same thing and this function is arithmetic nobody notices.
 * They come apart the moment a charge is converted (ADR 0001 D8: the platform
 * settles in EUR, a USD charge is converted by the rail at charge time): the
 * gross the platform actually received is ONE converted figure, and dividing it
 * among the orders is a proration with a remainder.
 *
 * Converting each order independently instead would be the obvious alternative
 * and is wrong in a way that hides: the rounding residue lands in
 * `commission_revenue`, because ADR 0001 D3 DEFINES Mercaria's commission as
 * gross minus the sum of the seller nets. A marketplace whose commission is
 * nominally zero would start reporting a few cents of revenue per multi-seller
 * order, from nowhere, and the books would balance perfectly while saying
 * something false.
 *
 * ## Largest remainder, and why the tie-break is explicit
 *
 * Each order gets `floor(gross × weightᵢ / Σweight)`, and the units left over by
 * flooring go one each to the orders with the largest fractional parts. Ties are
 * broken by the order's position in the input, which is `created_at` order from
 * the repository — so the same charge always splits the same way, whoever runs
 * it and however many times. A tie broken by object iteration order would make
 * the settlement of a symmetric two-seller cart non-deterministic, which is the
 * kind of thing that reproduces once a quarter.
 *
 * ## Commission is NOT computed here
 *
 * `netMinor` is the seller's GROSS share of the charge, and nothing is deducted
 * from it: the fee schedule is #88's (`services/payments/seller-net-shares.ts`,
 * fed by each order's immutable fee snapshot), and encoding any rate here would
 * make this a second place that schedule lives. `deriveSellerNetShares` is what
 * subtracts the per-order fee from these shares — at which point
 * `chargeSucceeded`'s residual stops being zero and starts crediting
 * `commission_revenue`, with no change in this file. Every reader of "what is a
 * seller owed" goes through THAT module, never this one directly.
 *
 * `apportion` below is the largest-remainder primitive itself, exported so the
 * fee domain's line allocations split by the SAME documented rule (floor, then
 * one extra unit each to the largest fractional parts, ties by input position)
 * rather than growing a second rounding convention.
 */

import type { CurrencyCode, LedgerOwnerType } from '@mercaria/shared-types';
import type { SellerShare } from './ledger-postings.js';

/** One seller order entering the split. */
export interface ShareInput {
  orderId: string;
  ownerType: LedgerOwnerType;
  /** The store id or the P2P seller's Oxy user id. */
  ownerId: string;
  /**
   * This order's weight in the split — its own grand total, in the currency the
   * ORDERS are denominated in (presentment). The weights need not be in the same
   * currency as the gross being split; only their ratios are used.
   */
  weightMinor: number;
}

/** What each seller order is owed, in the currency the gross was given in. */
export interface AllocatedShares {
  currency: CurrencyCode;
  shares: SellerShare[];
  /**
   * Gross minus the sum of the shares. Zero by construction while the commission
   * rate is zero — asserted by the caller's tests rather than assumed, because
   * a non-zero value here is exactly the silent rounding leak described above.
   */
  residualMinor: bigint;
}

/**
 * Split `grossMinor` across `orders`, exactly.
 *
 * @param grossMinor What the platform received, in `currency`.
 * @param currency The currency the shares are denominated in — the platform's
 *   settlement currency once a rail has converted, the presentment currency
 *   otherwise.
 * @param orders One entry per seller order, in a stable order (the repository's
 *   `created_at`). An empty list yields no shares and the whole gross as
 *   residual, which the caller must treat as the correlation failure it is
 *   rather than as commission.
 */
export function allocateSellerShares(input: {
  grossMinor: bigint;
  currency: CurrencyCode;
  orders: readonly ShareInput[];
}): AllocatedShares {
  const { grossMinor, currency, orders } = input;
  if (orders.length === 0) {
    return { currency, shares: [], residualMinor: grossMinor };
  }

  const parts = apportion({
    totalMinor: grossMinor,
    weights: orders.map((order) => BigInt(order.weightMinor)),
  });
  const shares: SellerShare[] = orders.map((order, index) => ({
    orderId: order.orderId,
    ownerType: order.ownerType,
    ownerId: order.ownerId,
    netMinor: parts[index],
  }));
  const distributed = shares.reduce((sum, share) => sum + share.netMinor, 0n);

  return { currency, shares, residualMinor: grossMinor - distributed };
}

/**
 * Split `totalMinor` across `weights` by largest remainder, exactly.
 *
 * The primitive `allocateSellerShares` is built on, exported for the fee
 * domain's line allocations so both splits round by ONE documented rule:
 * each part gets `floor(total × weightᵢ / Σweight)`, and the units flooring
 * left over go one each to the largest fractional parts, ties broken by input
 * position. The parts always sum to `totalMinor` exactly.
 *
 * All weights zero (or an empty list) makes the proration meaningless: the
 * whole total goes to the FIRST part rather than dividing by zero — a zero-
 * weight split is a pricing bug upstream, and losing the total would hide it.
 */
export function apportion(input: {
  totalMinor: bigint;
  weights: readonly bigint[];
}): bigint[] {
  const { totalMinor, weights } = input;
  if (weights.length === 0) return [];

  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0n);
  if (totalWeight === 0n) {
    return weights.map((_, index) => (index === 0 ? totalMinor : 0n));
  }

  const floored = weights.map((weight, index) => {
    const scaled = totalMinor * weight;
    return { index, base: scaled / totalWeight, remainder: scaled % totalWeight };
  });

  // Flooring loses strictly less than one unit per part, so there are fewer
  // leftover units than parts and each one below gets at most a single extra.
  const leftover = Number(totalMinor - floored.reduce((sum, entry) => sum + entry.base, 0n));

  // Largest fractional part first; ties keep input order, which is what makes
  // the split reproducible.
  const byRemainder = [...floored].sort((a, b) => {
    if (a.remainder === b.remainder) return a.index - b.index;
    return a.remainder > b.remainder ? -1 : 1;
  });
  const extra = new Set<number>();
  for (let given = 0; given < leftover && given < byRemainder.length; given += 1) {
    extra.add(byRemainder[given].index);
  }

  return floored.map((entry) => entry.base + (extra.has(entry.index) ? 1n : 0n));
}
