/**
 * What each seller is NET owed out of a charge — the gross split minus the
 * order's snapshotted marketplace fee (#88). ONE definition, THREE readers.
 *
 * `bookChargeSucceeded` credits each seller a payable from these shares,
 * `settlement.service` transfers each seller exactly that figure, and the
 * refund execution prorates a seller's liability off the same one. Before #88
 * all three called `allocateSellerShares` directly and the commission residual
 * was zero by construction; they now all call THIS module, which is the same
 * three-readers-one-definition rule moved one level up. Nothing else may
 * compute a seller's net — a fourth definition is how `merchant_payable` stops
 * returning to zero.
 *
 * ## How the fee enters, and why the commission is still a residual
 *
 * `allocateSellerShares` keeps owning the exact gross split (largest remainder,
 * ties by input order); this module only SUBTRACTS each order's immutable fee
 * snapshot from its gross share. ADR 0001 D3 defines Mercaria's commission as
 * `gross − Σnets`, computed by `chargeSucceeded` and never passed in — so
 * shrinking the shares here is precisely what makes `commission_revenue` start
 * receiving the schedule's fee, with no change to any posting builder
 * (`settlement-shares.ts` promised exactly this seam).
 *
 * ## The fee converts at the charge's OWN captured ratio, floored
 *
 * The snapshot's fee is presentment-currency (the currency the order was
 * priced in); the payable and the transfer are denominated in the currency the
 * money LANDED in (`settlementBasis`). When the rail converted, every gross
 * share is `settledGross × weight / presentmentGross` — so the fee converts by
 * the SAME ratio, `fee × settledGross / presentmentGross`, floored. Floor is
 * the conservative direction (never take more off a seller than the snapshot
 * states), it is exact (ratio 1) whenever no conversion happened, and it is
 * deterministic in the payment row's immutable columns — an outbox retry, the
 * settlement and a later refund all derive the identical figure (#88
 * calculation rule 8). No live FX is consulted, ever: a rate moving after the
 * charge cannot alter what a seller is owed.
 *
 * ## The clamp is a defence, not a policy
 *
 * The fee never exceeds its own basis (calculation cap + snapshot CHECK), and
 * the basis never exceeds the order total, so a converted fee share cannot
 * exceed the gross share except through corrupt data. The clamp to the share
 * keeps a net from ever going negative even then — a negative transfer is not
 * a thing a rail can make.
 */

import type { CurrencyCode } from '@mercaria/shared-types';
import { assertSafeLedgerAmount } from '@mercaria/shared-types';
import type { SellerShare } from './ledger-postings.js';
import { allocateSellerShares } from './settlement-shares.js';
import type { LinkedOrder } from './order-linkage.js';

/** The net shares, and the fee each order actually bore in the settled currency. */
export interface SellerNetAllocation {
  /** The currency the shares are denominated in — the settlement basis's. */
  currency: CurrencyCode;
  /** One NET share per order: gross share minus the converted marketplace fee. */
  shares: SellerShare[];
  /**
   * What was deducted per order, in the settled currency. `Σfees = gross −
   * Σnets` exactly — the commission `chargeSucceeded` will book as residual.
   */
  feeMinorByOrderId: Map<string, bigint>;
}

/**
 * Derive every seller order's NET share of a settled gross.
 *
 * @param settled What the platform received and in which currency —
 *   `settlementBasis(payment)`, always.
 * @param presentmentGrossMinor The charge's presentment-side total
 *   (`payment.presentmentAmount`) — the denominator of the captured conversion
 *   ratio. Equal to `settled.grossMinor` whenever the rail converted nothing.
 * @param orders The group's orders in repository order, carrying their
 *   snapshotted fees (`order-linkage`'s projection).
 */
export function deriveSellerNetShares(input: {
  settled: { currency: CurrencyCode; grossMinor: bigint };
  presentmentGrossMinor: bigint;
  orders: readonly LinkedOrder[];
}): SellerNetAllocation {
  const { settled, presentmentGrossMinor, orders } = input;

  const allocation = allocateSellerShares({
    grossMinor: settled.grossMinor,
    currency: settled.currency,
    orders: orders.map((order) => ({
      orderId: order.id,
      ownerType: order.sellerType === 'store' ? 'store' : 'user',
      ownerId: order.sellerOwnerId,
      weightMinor: order.presentmentTotalMinor,
    })),
  });

  const feeMinorByOrderId = new Map<string, bigint>();
  const shares: SellerShare[] = allocation.shares.map((share) => {
    const order = orders.find((candidate) => candidate.id === share.orderId);
    const feePresentment = BigInt(order?.marketplaceFeePresentmentMinor ?? 0);

    let feeSettled: bigint;
    if (feePresentment <= 0n) {
      feeSettled = 0n;
    } else if (settled.grossMinor === presentmentGrossMinor) {
      // No conversion — the snapshot's figure verbatim.
      feeSettled = feePresentment;
    } else if (presentmentGrossMinor > 0n) {
      // The charge's own captured ratio, floored — see the file docblock.
      feeSettled = (feePresentment * settled.grossMinor) / presentmentGrossMinor;
    } else {
      // A zero presentment gross with a positive fee is corrupt upstream data;
      // deducting anything would be inventing a rate. Take nothing.
      feeSettled = 0n;
    }
    if (feeSettled > share.netMinor) {
      feeSettled = share.netMinor;
    }
    assertSafeLedgerAmount(feeSettled, 'deriveSellerNetShares.fee');

    if (feeSettled > 0n) {
      feeMinorByOrderId.set(share.orderId, feeSettled);
    }
    return { ...share, netMinor: share.netMinor - feeSettled };
  });

  return { currency: allocation.currency, shares, feeMinorByOrderId };
}
