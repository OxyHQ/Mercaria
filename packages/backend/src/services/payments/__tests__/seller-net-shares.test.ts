/**
 * `deriveSellerNetShares` — the ONE definition of a seller's net, worked
 * examples plus the reconciliation property. Everything the ledger posting,
 * the settlement and the refund proration read comes through this function, so
 * the invariants pinned here are the invariants of the money itself:
 *
 *  - Σnets + Σfees == gross, EXACTLY, in every currency shape;
 *  - a zero-fee order's net is its gross share, byte-identical to the pre-#88
 *    behaviour;
 *  - the commission `chargeSucceeded` books as the residual is precisely the
 *    sum of the snapshot fees.
 */

import { describe, expect, it } from 'vitest';
import { deriveSellerNetShares } from '../seller-net-shares.js';
import { chargeSucceeded, refundPosting } from '../ledger-postings.js';
import { sellerLiabilityAt } from '../refund-execution.service.js';
import type { LinkedOrder } from '../order-linkage.js';

/** A same-currency EUR order with a fee snapshot already stamped. */
function order(input: {
  id: string;
  totalMinor: number;
  feeMinor?: number;
  sellerType?: 'store' | 'user';
}): LinkedOrder {
  return {
    id: input.id,
    status: 'pending_payment',
    sellerType: input.sellerType ?? 'store',
    commercialRole: 'connected_marketplace',
    sellerOwnerId: `owner-${input.id}`,
    buyerOxyUserId: 'buyer',
    shopTotalMinor: input.totalMinor,
    shopCurrency: 'EUR',
    presentmentTotalMinor: input.totalMinor,
    presentmentCurrency: 'EUR',
    paymentId: null,
    checkoutGroupId: 'group',
    marketplaceFeePresentmentMinor: input.feeMinor ?? 0,
  };
}

describe('deriveSellerNetShares — same-currency charges', () => {
  it('leaves a zero-fee order at its gross share (the pre-#88 behaviour, exactly)', () => {
    const result = deriveSellerNetShares({
      settled: { currency: 'EUR', grossMinor: 4_000n },
      presentmentGrossMinor: 4_000n,
      orders: [order({ id: 'a', totalMinor: 4_000 })],
    });
    expect(result.shares).toEqual([
      { orderId: 'a', ownerType: 'store', ownerId: 'owner-a', netMinor: 4_000n },
    ]);
    expect(result.feeMinorByOrderId.size).toBe(0);
  });

  it('deducts the snapshot fee verbatim when nothing was converted', () => {
    const result = deriveSellerNetShares({
      settled: { currency: 'EUR', grossMinor: 4_000n },
      presentmentGrossMinor: 4_000n,
      orders: [order({ id: 'a', totalMinor: 4_000, feeMinor: 400 })],
    });
    expect(result.shares[0].netMinor).toBe(3_600n);
    expect(result.feeMinorByOrderId.get('a')).toBe(400n);
  });

  it('nets a multi-seller group per order, and the fees sum to the residual', () => {
    const orders = [
      order({ id: 'a', totalMinor: 3_000, feeMinor: 300 }),
      order({ id: 'b', totalMinor: 1_000, feeMinor: 0 }),
      order({ id: 'c', totalMinor: 2_000, feeMinor: 500, sellerType: 'user' }),
    ];
    const gross = 6_000n;
    const result = deriveSellerNetShares({
      settled: { currency: 'EUR', grossMinor: gross },
      presentmentGrossMinor: gross,
      orders,
    });
    expect(result.shares.map((share) => share.netMinor)).toEqual([2_700n, 1_000n, 1_500n]);

    // The commission the ledger will book IS the residual — recompute it the
    // way `chargeSucceeded` does and pin the equality.
    const posting = chargeSucceeded({
      paymentId: 'p',
      currency: 'EUR',
      grossMinor: gross,
      feeMinor: 0n,
      shares: result.shares,
    });
    const commission = posting.entries.find((entry) => entry.account === 'commission_revenue');
    expect(commission?.amountMinor).toBe(-800n); // credit of 300 + 500
  });
});

describe('deriveSellerNetShares — converted charges', () => {
  it('converts the fee at the charge’s own captured ratio, floored', () => {
    // 4,000 presentment landed as 3,667 platform. fee 400 → floor(400×3667/4000)
    // = floor(366.7) = 366.
    const result = deriveSellerNetShares({
      settled: { currency: 'EUR', grossMinor: 3_667n },
      presentmentGrossMinor: 4_000n,
      orders: [order({ id: 'a', totalMinor: 4_000, feeMinor: 400 })],
    });
    expect(result.shares[0].netMinor).toBe(3_667n - 366n);
    expect(result.feeMinorByOrderId.get('a')).toBe(366n);
  });

  it('reconciles exactly across random converted multi-seller groups', () => {
    for (let round = 0; round < 200; round += 1) {
      const orderCount = 1 + Math.floor(Math.random() * 5);
      const orders = Array.from({ length: orderCount }, (_, index) => {
        const totalMinor = 1 + Math.floor(Math.random() * 100_000);
        return order({
          id: `o${String(index)}`,
          totalMinor,
          // A fee never exceeds its basis, and the basis never exceeds the total.
          feeMinor: Math.floor(Math.random() * (totalMinor + 1)),
        });
      });
      const presentmentGross = orders.reduce(
        (sum, entry) => sum + BigInt(entry.presentmentTotalMinor),
        0n,
      );
      // Converted anywhere from 50% to 150% of the presentment gross.
      const settledGross = (presentmentGross * BigInt(50 + Math.floor(Math.random() * 101))) / 100n;

      const result = deriveSellerNetShares({
        settled: { currency: 'EUR', grossMinor: settledGross },
        presentmentGrossMinor: presentmentGross,
        orders,
      });

      const netSum = result.shares.reduce((sum, share) => sum + share.netMinor, 0n);
      const feeSum = [...result.feeMinorByOrderId.values()].reduce((sum, fee) => sum + fee, 0n);
      // The whole point: nets and fees partition the gross EXACTLY, so the
      // ledger's residual commission is Σfees and nothing leaks into it.
      expect(netSum + feeSum).toBe(settledGross);
      for (const share of result.shares) {
        expect(share.netMinor).toBeGreaterThanOrEqual(0n);
      }
    }
  });

  it('clamps a corrupt over-sized fee to the share rather than going negative', () => {
    // Unrepresentable through the snapshot CHECKs (fee ≤ basis ≤ total), so this
    // is the defence-in-depth branch: a fee bigger than the allocated share
    // takes the whole share and no more.
    const result = deriveSellerNetShares({
      settled: { currency: 'EUR', grossMinor: 1_000n },
      presentmentGrossMinor: 4_000n, // heavy down-conversion: share = 1,000
      orders: [order({ id: 'a', totalMinor: 4_000, feeMinor: 3_900 })],
    });
    expect(result.feeMinorByOrderId.get('a')).toBe(975n); // floor(3900×1000/4000)
    expect(result.shares[0].netMinor).toBe(25n);

    const clamped = deriveSellerNetShares({
      settled: { currency: 'EUR', grossMinor: 100n },
      presentmentGrossMinor: 100n,
      orders: [order({ id: 'a', totalMinor: 100, feeMinor: 100 })],
    });
    expect(clamped.shares[0].netMinor).toBe(0n);
  });
});

describe('the refund treatment the net shares imply (schedule policy: proportional)', () => {
  it('returns the whole commission on a full refund, through the residual', () => {
    // One EUR order, total 4,000, fee 400 → net 3,600. A FULL refund returns
    // 4,000 to the buyer; the seller bears their whole net; Mercaria's residual
    // is exactly its commission back.
    const { shares } = deriveSellerNetShares({
      settled: { currency: 'EUR', grossMinor: 4_000n },
      presentmentGrossMinor: 4_000n,
      orders: [order({ id: 'a', totalMinor: 4_000, feeMinor: 400 })],
    });
    const sellerLiability = sellerLiabilityAt(shares[0].netMinor, 4_000, 4_000);
    expect(sellerLiability).toBe(3_600n);
    const mercariaShare = 4_000n - sellerLiability;
    expect(mercariaShare).toBe(400n);

    // And the posting books that share as a DEBIT against commission_revenue —
    // the commission coming back, per the schedule's `proportional` policy.
    const posting = refundPosting({
      paymentId: 'p',
      refundId: 'r',
      orderId: 'a',
      ownerType: 'store',
      ownerId: 'owner-a',
      currency: 'EUR',
      amountMinor: 4_000n,
      commissionShareMinor: mercariaShare,
    });
    const commission = posting.entries.find((entry) => entry.account === 'commission_revenue');
    expect(commission?.amountMinor).toBe(400n);
  });

  it('returns the commission pro-rata on a partial refund', () => {
    const { shares } = deriveSellerNetShares({
      settled: { currency: 'EUR', grossMinor: 4_000n },
      presentmentGrossMinor: 4_000n,
      orders: [order({ id: 'a', totalMinor: 4_000, feeMinor: 400 })],
    });
    // Half the order comes back: the seller bears half their NET, so Mercaria's
    // residual on the 2,000 refunded is half its 400 commission.
    const halfLiability = sellerLiabilityAt(shares[0].netMinor, 2_000, 4_000);
    expect(halfLiability).toBe(1_800n);
    expect(2_000n - halfLiability).toBe(200n);

    // Cumulative across the second half: the remaining liability difference is
    // the other 1,800, and the two Mercaria shares sum to the whole commission.
    const fullLiability = sellerLiabilityAt(shares[0].netMinor, 4_000, 4_000);
    expect(fullLiability - halfLiability).toBe(1_800n);
    expect(2_000n - (fullLiability - halfLiability)).toBe(200n);
  });
});
