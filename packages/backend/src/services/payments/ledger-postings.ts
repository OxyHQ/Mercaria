/**
 * ADR 0001's "Ledger representability" table, as code.
 *
 * Every builder here is PURE: money in, entries out, no database, no clock, no
 * configuration. That is what lets the whole chart of accounts be table-tested
 * against worked examples — the same shape `enforcement-plan.ts` uses for
 * moderation, and for the same reason. The accounting is the part that has to be
 * right the first time, because a wrong posting is discovered by an accountant
 * months later rather than by a failing request.
 *
 * ## The sign convention, once more, because this is where it is applied
 *
 * `amountMinor` is SIGNED: **positive is a debit, negative is a credit**, and
 * every builder returns a set that sums to zero per currency. The commented
 * `debit`/`credit` labels below match ADR 0001's table column for column, so the
 * ADR can be read beside this file line by line.
 *
 * ## Where the numbers come from, and what this file refuses to invent
 *
 * Every amount is passed IN. Nothing here computes a commission rate, a fee or a
 * proration — those are decisions with their own owners (#88 owns the fee
 * schedule; the refund domain owns what is refundable) and a builder that
 * derived them would become a second place they are defined.
 *
 * The one arithmetic this file does is the residual: the buyer paid a gross, the
 * sellers are owed their nets, and Mercaria's commission is the difference. ADR
 * 0001 D3 makes that residual the SOLE source of commission truth — giving up
 * `application_fee_amount` reporting is precisely what the internal ledger
 * exists to replace — so it is computed here, from the figures above it, and
 * asserted to balance. The provider's fee is a separate EXPENSE, not a
 * deduction from it; see `chargeSucceeded`.
 */

import type { CurrencyCode, LedgerOwnerType, Money } from '@mercaria/shared-types';
import type {
  LedgerEntryInput,
  LedgerTransactionInput,
} from '../../db/payments/ledgerRepository.js';

/** A transaction header and the entries that balance it. */
export interface LedgerPosting {
  transaction: LedgerTransactionInput;
  entries: readonly LedgerEntryInput[];
}

/** What one seller order is owed out of a charge, and who is owed it. */
export interface SellerShare {
  orderId: string;
  ownerType: LedgerOwnerType;
  /** The store id or the P2P seller's Oxy user id. */
  ownerId: string;
  /** The seller's NET for this order, in the platform settlement currency. */
  netMinor: bigint;
}

/**
 * What one `mercaria_retail` order recovered out of a charge — ADR 0004 D7.
 *
 * It has NO owner, and the absence is the type doing its job. A `SellerShare`
 * names who is owed the money, and every reader that holds one goes on to
 * credit them a payable and then transfer it. A retail order's seller is
 * Mercaria: there is nobody to owe and nobody to pay, so a share of that shape
 * would be a receivable against ourselves that the settlement step would
 * happily try to send somewhere.
 */
export interface RetailRecoveryShare {
  orderId: string;
  /** This order's share of the charge, in the platform settlement currency. */
  recoveryMinor: bigint;
}

/** `Money.amount` as the `bigint` the ledger stores. */
export function toLedgerAmount(money: Money): bigint {
  return BigInt(money.amount);
}

/**
 * Charge succeeded — the posting that turns a captured payment into money owed.
 *
 * | Debit | Credit |
 * |---|---|
 * | provider clearing (G − F), processor expense (F) | merchant payable (ΣNᵢ, per order), commission revenue (C) |
 *
 * `C` is not a parameter. It is `G − ΣNᵢ` — the charge minus what the sellers
 * are owed — and computing it here rather than accepting it is the point: ADR
 * 0001 D3 DEFINES the commission as that residual, so a caller passing one could
 * disagree with the arithmetic and the ledger would balance anyway with the
 * wrong split.
 *
 * The fee is NOT subtracted from it. `F` is Mercaria's own cost (D5:
 * `fees.payer=application`), expensed on its own account, and the two legs
 * together say what the margin actually is: commission revenue `C` credited,
 * processor expense `F` debited, net `C − F`. Netting the fee into the
 * commission instead would balance just as well and would report a smaller
 * revenue against a cost that had vanished — which is precisely the kind of
 * wrong-but-balanced answer the per-leg assertions in the posting tests exist to
 * catch.
 *
 * A zero fee or a zero commission OMITS its leg rather than booking a zero one —
 * `ledger_entries` refuses a zero amount, and a fee-free rail (the `mock`
 * provider, a future direct-settlement one) is an ordinary case rather than an
 * exception.
 *
 * ## The retail legs, and why they change what the residual MEANS
 *
 * ADR 0004 D4 concern 8: a mixed group's split runs over ALL its orders so the
 * allocation stays exact, but a `mercaria_retail` order's share never enters
 * transfer creation or commission arithmetic. Here that is one credit to
 * `retail_cost_recovery` per retail order and one subtraction from the
 * residual.
 *
 * The subtraction is the load-bearing half. Without it the retail share would
 * still be booked — as `commission_revenue`, because the residual is DEFINED as
 * everything the sellers were not owed — and the ledger would balance perfectly
 * while reporting Mercaria margin on a sale whose planned margin is zero (D7
 * proof 1). So the commission is now "the charge minus what the sellers are
 * owed minus what retail recovered", which is ADR 0001 D3's residual restricted
 * to marketplace orders, exactly as D4 concern 8 words it.
 *
 * @param grossMinor What the platform received, in `currency`.
 * @param feeMinor The provider's processing fee, borne by Mercaria (ADR D5).
 * @param shares One entry per CONNECTED-MARKETPLACE seller order in the group.
 * @param retailShares One entry per `mercaria_retail` order in the group.
 *   Empty for every marketplace-only checkout, which is every checkout today.
 */
export function chargeSucceeded(input: {
  paymentId: string;
  currency: CurrencyCode;
  grossMinor: bigint;
  feeMinor: bigint;
  shares: readonly SellerShare[];
  retailShares?: readonly RetailRecoveryShare[];
}): LedgerPosting {
  const retailShares = input.retailShares ?? [];
  const payableTotal = input.shares.reduce((total, share) => total + share.netMinor, 0n);
  const retailTotal = retailShares.reduce((total, share) => total + share.recoveryMinor, 0n);
  const commissionMinor = input.grossMinor - payableTotal - retailTotal;

  const entries: LedgerEntryInput[] = [
    // Funds landed on the platform balance, net of what the provider kept.
    {
      account: 'provider_clearing',
      currency: input.currency,
      amountMinor: input.grossMinor - input.feeMinor,
    },
  ];
  if (input.feeMinor !== 0n) {
    entries.push({
      account: 'processor_expense',
      currency: input.currency,
      amountMinor: input.feeMinor,
    });
  }
  for (const share of input.shares) {
    if (share.netMinor === 0n) continue;
    entries.push({
      account: 'merchant_payable',
      currency: input.currency,
      amountMinor: -share.netMinor,
      ownerType: share.ownerType,
      ownerId: share.ownerId,
      orderId: share.orderId,
    });
  }
  // The retail legs. `orderId` and no owner: the entry names WHICH retail order
  // recovered the money — which is what makes D7 proof 2 (recovery bounded by
  // cost, per order) a query rather than an intention — while carrying nobody
  // to owe it to.
  for (const share of retailShares) {
    if (share.recoveryMinor === 0n) continue;
    entries.push({
      account: 'retail_cost_recovery',
      currency: input.currency,
      amountMinor: -share.recoveryMinor,
      orderId: share.orderId,
    });
  }
  if (commissionMinor !== 0n) {
    entries.push({
      account: 'commission_revenue',
      currency: input.currency,
      amountMinor: -commissionMinor,
    });
  }

  return {
    transaction: {
      kind: 'charge_succeeded',
      description: `Charge succeeded for payment ${input.paymentId}`,
      paymentId: input.paymentId,
    },
    entries,
  };
}

/**
 * Transfer created — the seller's receivable is settled and leaves the platform
 * balance.
 *
 * | Debit | Credit |
 * |---|---|
 * | merchant payable (Nᵢ) | provider clearing (Nᵢ) |
 *
 * ADR 0001 D6: from here the money is on the seller's own provider balance and
 * payout timing is between them and the provider. A failed PAYOUT does not
 * reopen this — which is why `payouts` books nothing at all.
 */
export function transferCreated(input: {
  paymentId: string;
  transferId: string;
  orderId: string;
  ownerType: LedgerOwnerType;
  ownerId: string;
  currency: CurrencyCode;
  amountMinor: bigint;
}): LedgerPosting {
  return {
    transaction: {
      kind: 'transfer_created',
      description: `Transfer ${input.transferId} for order ${input.orderId}`,
      paymentId: input.paymentId,
      orderId: input.orderId,
    },
    entries: [
      {
        account: 'merchant_payable',
        currency: input.currency,
        amountMinor: input.amountMinor,
        ownerType: input.ownerType,
        ownerId: input.ownerId,
        orderId: input.orderId,
      },
      {
        account: 'provider_clearing',
        currency: input.currency,
        amountMinor: -input.amountMinor,
      },
    ],
  };
}

/**
 * Refund — money returned to the buyer, and who bears it.
 *
 * | Debit | Credit |
 * |---|---|
 * | merchant payable (R − c), commission revenue (c) | provider clearing (R) |
 *
 * The seller bears the refunded principal and Mercaria returns its commission
 * share on it (ADR 0001 D5). Debiting `commission_revenue` is what "returned"
 * means under the sign convention: the account's normal balance is a credit, so
 * a debit reduces it.
 *
 * ## Cross-currency asymmetry is expected and is NOT corrected here
 *
 * A provider refunds at the refund-time rate and does not return its original
 * conversion fee. ADR 0001 D7 is explicit that the refund legs are recorded at
 * their OWN captured amounts and never derived from the charge legs — so
 * `amountMinor` is what the provider actually moved, and the residual against
 * the original charge stays visible in the accounts rather than being smoothed
 * away.
 */
export function refundPosting(input: {
  paymentId: string;
  refundId: string;
  orderId: string;
  ownerType: LedgerOwnerType;
  ownerId: string;
  currency: CurrencyCode;
  /** The total returned to the buyer. */
  amountMinor: bigint;
  /** Mercaria's commission share of it, returned with it. */
  commissionShareMinor: bigint;
}): LedgerPosting {
  const sellerShare = input.amountMinor - input.commissionShareMinor;
  const entries: LedgerEntryInput[] = [];
  if (sellerShare !== 0n) {
    entries.push({
      account: 'merchant_payable',
      currency: input.currency,
      amountMinor: sellerShare,
      ownerType: input.ownerType,
      ownerId: input.ownerId,
      orderId: input.orderId,
    });
  }
  if (input.commissionShareMinor !== 0n) {
    entries.push({
      account: 'commission_revenue',
      currency: input.currency,
      amountMinor: input.commissionShareMinor,
    });
  }
  entries.push({
    account: 'provider_clearing',
    currency: input.currency,
    amountMinor: -input.amountMinor,
  });

  return {
    transaction: {
      kind: 'refund',
      description: `Refund ${input.refundId} for order ${input.orderId}`,
      paymentId: input.paymentId,
      orderId: input.orderId,
      refundId: input.refundId,
    },
    entries,
  };
}

/**
 * Transfer reversal received — the seller's balance funded the refund, and the
 * money is back on the platform.
 *
 * | Debit | Credit |
 * |---|---|
 * | provider clearing | merchant payable |
 *
 * Separate from the refund itself, deliberately. A reversal can FAIL where the
 * refund did not (an insufficient seller balance with no reserve to cover it),
 * and ADR 0001 D7 says the buyer's refund is not blocked on it. Two
 * transactions is what lets the ledger show a refund that happened and a
 * recovery that did not, which is exactly the state the operator exception path
 * exists to surface.
 */
export function transferReversal(input: {
  paymentId: string;
  transferId: string;
  orderId: string;
  ownerType: LedgerOwnerType;
  ownerId: string;
  currency: CurrencyCode;
  amountMinor: bigint;
  refundId?: string;
}): LedgerPosting {
  return {
    transaction: {
      kind: 'transfer_reversal',
      description: `Reversal of transfer ${input.transferId} for order ${input.orderId}`,
      paymentId: input.paymentId,
      orderId: input.orderId,
      ...(input.refundId ? { refundId: input.refundId } : {}),
    },
    entries: [
      {
        account: 'provider_clearing',
        currency: input.currency,
        amountMinor: input.amountMinor,
      },
      {
        account: 'merchant_payable',
        currency: input.currency,
        amountMinor: -input.amountMinor,
        ownerType: input.ownerType,
        ownerId: input.ownerId,
        orderId: input.orderId,
      },
    ],
  };
}

/**
 * Dispute created — the platform balance is debited for the amount AND the fee.
 *
 * | Debit | Credit |
 * |---|---|
 * | disputes (D), processor expense (f) | provider clearing (D + f) |
 *
 * The principal sits in `disputes` until the outcome is known, rather than being
 * charged straight to the seller: a dispute is not yet a loss, and booking it as
 * one would make a won dispute look like a windfall. Recovering the principal
 * from the seller is a separate `transfer_reversal` (ADR 0001 D7).
 */
export function disputeCreated(input: {
  paymentId: string;
  disputeRef: string;
  orderId?: string;
  currency: CurrencyCode;
  amountMinor: bigint;
  feeMinor: bigint;
}): LedgerPosting {
  const entries: LedgerEntryInput[] = [
    {
      account: 'disputes',
      currency: input.currency,
      amountMinor: input.amountMinor,
      ...(input.orderId ? { orderId: input.orderId } : {}),
    },
  ];
  if (input.feeMinor !== 0n) {
    entries.push({
      account: 'processor_expense',
      currency: input.currency,
      amountMinor: input.feeMinor,
    });
  }
  entries.push({
    account: 'provider_clearing',
    currency: input.currency,
    amountMinor: -(input.amountMinor + input.feeMinor),
  });

  return {
    transaction: {
      kind: 'dispute_created',
      description: `Dispute ${input.disputeRef} opened`,
      paymentId: input.paymentId,
      disputeRef: input.disputeRef,
      ...(input.orderId ? { orderId: input.orderId } : {}),
    },
    entries,
  };
}

/**
 * Dispute won — the provider returns the principal.
 *
 * | Debit | Credit |
 * |---|---|
 * | provider clearing | disputes |
 *
 * The FEE is not returned and no leg reverses it: a lost fee on a won dispute is
 * a real cost Mercaria bore (ADR 0001 D5), and booking it back would overstate
 * revenue by the amount of every dispute ever raised.
 */
export function disputeWon(input: {
  paymentId: string;
  disputeRef: string;
  orderId?: string;
  currency: CurrencyCode;
  amountMinor: bigint;
}): LedgerPosting {
  return {
    transaction: {
      kind: 'dispute_won',
      description: `Dispute ${input.disputeRef} won`,
      paymentId: input.paymentId,
      disputeRef: input.disputeRef,
      ...(input.orderId ? { orderId: input.orderId } : {}),
    },
    entries: [
      {
        account: 'provider_clearing',
        currency: input.currency,
        amountMinor: input.amountMinor,
      },
      {
        account: 'disputes',
        currency: input.currency,
        amountMinor: -input.amountMinor,
        ...(input.orderId ? { orderId: input.orderId } : {}),
      },
    ],
  };
}

/**
 * Dispute lost — the held amount becomes the seller's loss.
 *
 * | Debit | Credit |
 * |---|---|
 * | merchant payable | disputes |
 *
 * The seller's receivable absorbs it, which is what "a lost dispute stays a
 * seller-side loss" means in accounts (ADR 0001 D7). Where the receivable is
 * already settled, the recovery is the paired `transfer_reversal`; this posting
 * only closes the `disputes` holding account.
 */
export function disputeLost(input: {
  paymentId: string;
  disputeRef: string;
  orderId: string;
  ownerType: LedgerOwnerType;
  ownerId: string;
  currency: CurrencyCode;
  amountMinor: bigint;
}): LedgerPosting {
  return {
    transaction: {
      kind: 'dispute_lost',
      description: `Dispute ${input.disputeRef} lost`,
      paymentId: input.paymentId,
      orderId: input.orderId,
      disputeRef: input.disputeRef,
    },
    entries: [
      {
        account: 'merchant_payable',
        currency: input.currency,
        amountMinor: input.amountMinor,
        ownerType: input.ownerType,
        ownerId: input.ownerId,
        orderId: input.orderId,
      },
      {
        account: 'disputes',
        currency: input.currency,
        amountMinor: -input.amountMinor,
        orderId: input.orderId,
      },
    ],
  };
}

/**
 * An operator correction, expressed as ordinary entries.
 *
 * The escape hatch, and it is deliberately not a special one: it produces the
 * same append-only rows as everything else and is subject to the same balance
 * rule. Reversing a previous transaction means passing this the negatives of its
 * entries — which is why there is no `reverseTransaction(id)` helper here. That
 * helper would need to READ the ledger to build its entries, making a correction
 * a function of what is already stored rather than of what an operator decided,
 * and it would quietly become the mechanism by which history is rewritten one
 * approved reversal at a time.
 */
export function adjustment(input: {
  description: string;
  entries: readonly LedgerEntryInput[];
  paymentId?: string;
  orderId?: string;
  refundId?: string;
  disputeRef?: string;
}): LedgerPosting {
  return {
    transaction: {
      kind: 'adjustment',
      description: input.description,
      ...(input.paymentId ? { paymentId: input.paymentId } : {}),
      ...(input.orderId ? { orderId: input.orderId } : {}),
      ...(input.refundId ? { refundId: input.refundId } : {}),
      ...(input.disputeRef ? { disputeRef: input.disputeRef } : {}),
    },
    entries: input.entries,
  };
}

/* -------------------------------------------------------------------------- */
/*  ADR 0004 D7's procurement postings (#128)                                  */
/* -------------------------------------------------------------------------- */

/**
 * Prefund top-up — Mercaria put money on deposit with a supplier.
 *
 * | Debit | Credit |
 * |---|---|
 * | supplier_prepaid (T) | platform_funds (T) |
 *
 * `platform_funds` is Mercaria's own out-of-band cash entering the payment
 * domain. The movement itself happens on bank rails under dual control and
 * outside this application entirely (ADR 0004 D6.5) — the app RECORDS treasury
 * acts, it does not execute them — so this posting is derived from the durable
 * observations #125 already stores rather than from a transfer Mercaria made.
 *
 * `supplier_prepaid` is carried per owner, and its owner type is `supplier`: a
 * supplier is not a seller on this marketplace and has no connected account
 * (ADR 0004 D6.8), so filing its deposit under `store` or `user` would put a
 * wholesale balance into the key space every payable query reads.
 */
export function prefundTopUp(input: {
  supplierId: string;
  currency: CurrencyCode;
  amountMinor: bigint;
}): LedgerPosting {
  return {
    transaction: {
      kind: 'prefund_top_up',
      description: `Prefunded balance topped up with supplier ${input.supplierId}`,
    },
    entries: [
      {
        account: 'supplier_prepaid',
        currency: input.currency,
        amountMinor: input.amountMinor,
        ownerType: 'supplier',
        ownerId: input.supplierId,
      },
      {
        account: 'platform_funds',
        currency: input.currency,
        amountMinor: -input.amountMinor,
      },
    ],
  };
}

/**
 * A purchase order drew against the supplier's prefunded balance.
 *
 * | Debit | Credit |
 * |---|---|
 * | procurement_expense (S) | supplier_prepaid (S) |
 *
 * ADR 0004 D6.4: the draw happens at supplier ACCEPTANCE and never at
 * submission, because a rejected or expired purchase order must cost nothing.
 * The amount is the supplier's own, in the supplier's own currency — the
 * customer side of this order is a different number on a different rail, and
 * converting one into the other here would invent a rate nothing recorded.
 *
 * `order_id` is carried on the expense leg so ADR 0004 D7 proof 2 — recovery
 * bounded by cost, PER ORDER — is a query rather than an intention.
 */
export function procurementSettled(input: {
  orderId: string;
  supplierId: string;
  purchaseOrderId: string;
  currency: CurrencyCode;
  amountMinor: bigint;
}): LedgerPosting {
  return {
    transaction: {
      kind: 'procurement_settled',
      description: `Purchase order ${input.purchaseOrderId} drawn against prefunded balance`,
      orderId: input.orderId,
    },
    entries: [
      {
        account: 'procurement_expense',
        currency: input.currency,
        amountMinor: input.amountMinor,
        orderId: input.orderId,
      },
      {
        account: 'supplier_prepaid',
        currency: input.currency,
        amountMinor: -input.amountMinor,
        ownerType: 'supplier',
        ownerId: input.supplierId,
      },
    ],
  };
}

/**
 * An attributable fulfilment cost Mercaria paid directly, outside a supplier
 * invoice.
 *
 * | Debit | Credit |
 * |---|---|
 * | procurement_expense (L) | platform_funds (L) |
 *
 * Separate from {@link procurementSettled} because the money leaves a different
 * place: a supplier draw shrinks a deposit Mercaria has already funded, while a
 * carrier charge leaves the operating account. Booking both against
 * `supplier_prepaid` would make a supplier's deposit appear to pay for freight
 * it never handled, and the balance would stop reconciling against the
 * supplier's own statement — which is the one external check on it.
 */
export function directFulfilmentCost(input: {
  orderId: string;
  currency: CurrencyCode;
  amountMinor: bigint;
  description: string;
}): LedgerPosting {
  return {
    transaction: {
      kind: 'procurement_settled',
      description: input.description,
      orderId: input.orderId,
    },
    entries: [
      {
        account: 'procurement_expense',
        currency: input.currency,
        amountMinor: input.amountMinor,
        orderId: input.orderId,
      },
      {
        account: 'platform_funds',
        currency: input.currency,
        amountMinor: -input.amountMinor,
      },
    ],
  };
}

/**
 * A supplier credit or RMA reversal came back against a cost already booked.
 *
 * | Debit | Credit |
 * |---|---|
 * | supplier_prepaid (K) | procurement_expense (K) |
 *
 * The exact reverse of a draw, and that is the point: the cost of this order
 * genuinely went down, so `procurement_expense` goes down with it and the
 * deposit goes back up. There is no revenue leg and no account one could be
 * added to — ADR 0004 D8.5 and #128 supplier-credit rule 5 ("credits cannot be
 * silently classified as retail revenue") are held by the chart of accounts
 * rather than by this function.
 *
 * It does NOT touch the customer side. Whether a lower cost means a buyer is
 * owed something is the reconciliation equation's question, answered on the next
 * revision — and a credit that accompanies a customer RETURN answers it in the
 * negative, because the refund lowered the customer side by the same amount.
 */
export function supplierCreditReceived(input: {
  orderId?: string;
  supplierId: string;
  purchaseOrderId: string;
  currency: CurrencyCode;
  amountMinor: bigint;
}): LedgerPosting {
  return {
    transaction: {
      kind: 'supplier_credit',
      description: `Supplier credit against purchase order ${input.purchaseOrderId}`,
      ...(input.orderId ? { orderId: input.orderId } : {}),
    },
    entries: [
      {
        account: 'supplier_prepaid',
        currency: input.currency,
        amountMinor: input.amountMinor,
        ownerType: 'supplier',
        ownerId: input.supplierId,
      },
      {
        account: 'procurement_expense',
        currency: input.currency,
        amountMinor: -input.amountMinor,
        ...(input.orderId ? { orderId: input.orderId } : {}),
      },
    ],
  };
}

/**
 * A positive cost variance recognized: the surplus stops being recovery and
 * becomes a liability to the buyer.
 *
 * | Debit | Credit |
 * |---|---|
 * | retail_cost_recovery (V⁺) | customer_adjustment (V⁺) |
 *
 * ADR 0004 D7's proof 2 in one posting. Recovery is bounded by cost at finality
 * because every excess over cost is EXTRACTED here before finality, and the
 * extraction has exactly one destination: there is no `retail_margin_revenue` to
 * credit instead, so the money cannot go anywhere else.
 *
 * `customer_adjustment` carries the ORDER and no owner. The buyer's identity is
 * deliberately absent from the ledger — a guest credential is purged on its own
 * clock while these entries are retained, and a per-buyer handle in a permanent
 * financial record is a correlation key wearing an owner id.
 *
 * A NEGATIVE variance has no counterpart function, and the absence is the
 * decision: Mercaria absorbing a shortfall is not a movement. The costs were
 * booked as `procurement_expense` when they were incurred, and the absorption is
 * visible as D7 proof 2's strict inequality between recovery and cost. A posting
 * for it would be an entry against itself.
 */
export function retailVarianceRecognized(input: {
  orderId: string;
  currency: CurrencyCode;
  amountMinor: bigint;
}): LedgerPosting {
  return {
    transaction: {
      kind: 'retail_variance',
      description: `Positive cost variance owed back on retail order ${input.orderId}`,
      orderId: input.orderId,
    },
    entries: [
      {
        account: 'retail_cost_recovery',
        currency: input.currency,
        amountMinor: input.amountMinor,
        orderId: input.orderId,
      },
      {
        account: 'customer_adjustment',
        currency: input.currency,
        amountMinor: -input.amountMinor,
        orderId: input.orderId,
      },
    ],
  };
}

/**
 * The recognized adjustment was actually paid back to the buyer.
 *
 * | Debit | Credit |
 * |---|---|
 * | customer_adjustment (V⁺) | provider_clearing (V⁺) |
 *
 * The liability closes and the platform balance goes down by what left it. The
 * pair with {@link retailVarianceRecognized} is why both carry the kind
 * `retail_variance`: an order whose `customer_adjustment` nets to zero has been
 * made whole, and reading that off ONE kind is what makes it a query rather than
 * a join across two vocabularies.
 *
 * The rail movement itself is #49's, unchanged — this books what that movement
 * MEANS. Deliberately NOT the `refunds` account: `refunds` is money returned
 * because a buyer sent goods back or an order was cancelled, and an adjustment
 * is money returned because Mercaria over-charged. Merging them would make the
 * refund rate of a zero-margin channel unreadable.
 */
export function customerAdjustmentRefunded(input: {
  orderId: string;
  refundId: string;
  currency: CurrencyCode;
  amountMinor: bigint;
}): LedgerPosting {
  return {
    transaction: {
      kind: 'retail_variance',
      description: `Cost adjustment refunded on retail order ${input.orderId}`,
      orderId: input.orderId,
      refundId: input.refundId,
    },
    entries: [
      {
        account: 'customer_adjustment',
        currency: input.currency,
        amountMinor: input.amountMinor,
        orderId: input.orderId,
      },
      {
        account: 'provider_clearing',
        currency: input.currency,
        amountMinor: -input.amountMinor,
        orderId: input.orderId,
      },
    ],
  };
}
